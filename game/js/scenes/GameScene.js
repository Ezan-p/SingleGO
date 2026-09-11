// js/scenes/GameScene.js
// 对局场景（取代 pages/game、pages/game-ai、pages/challenge-game）
// 支持三种模式：local（本地双人）、ai（系统对战）、challenge（残局闯关）
// 交互与小程序版一致：点击预览 → 同点再次点击确认落子；悔棋撤销双方各一步；
// 围子胜利先高亮 1.8s 再弹结算。

const BaseScene = require('./BaseScene.js');
const ui = require('../render/ui.js');
const boardRenderer = require('../render/BoardRenderer.js');
const board_ = require('../board.js');
const Game = require('../game.js');
const storage = require('../storage.js');
const rank = require('../rank.js');
const undoManager = require('../undo-manager.js');
const challengeProgress = require('../challenge-progress.js');
const levels = require('../levels.js');

const TIER_ICONS = { beginner: '🌱', kyu: '🛡', dan: '💎', master: '👑' };
const MOCK_AD_SECONDS = 3;

function GameScene(manager) {
  BaseScene.call(this, manager);
  this.game = null;
  this.layout = null;
  this.phase = 0;

  this.showResult = false;
  this.result = null;
  this.showAdModal = false;
  this.showMockAd = false;
  this.mockAdCountdown = MOCK_AD_SECONDS;
  this._mockAdTimer = 0;
  this._pendingUndo = false;
  this.promotion = null;
  this._rankUpdated = false;
  this.toast = null;
  this._toastTimer = 0;
}
GameScene.prototype = Object.create(BaseScene.prototype);
GameScene.prototype.constructor = GameScene;

GameScene.prototype.onEnter = function (params) {
  const self = this;
  const p = params || {};
  this.params = p;
  this.mode = p.mode || 'local';

  const settings = storage.getSettings();
  const size = p.size || (p.initialBoard ? p.initialBoard.length : settings.boardSize);

  this.game = new Game({
    mode: this.mode,
    size: size,
    difficulty: p.difficulty || 'normal',
    humanPlayer: p.humanPlayer || board_.BLACK,
    firstPlayer: p.firstPlayer || board_.BLACK,
    initialBoard: p.initialBoard || null,
    levelId: p.levelId || 0,
    onGameOver: function (result, elapsed) { self.onGameOver(result, elapsed); }
  });

  this.showResult = false;
  this.showAdModal = false;
  this.showMockAd = false;
  this._pendingUndo = false;
  this._rankUpdated = false;
  this.promotion = null;

  this.buildLayout();
  this.buildButtons();
};

GameScene.prototype.onExit = function () {
  this.showResult = false;
  this.showAdModal = false;
  this.showMockAd = false;
};

GameScene.prototype.buildLayout = function () {
  const vp = this.manager.viewport;
  const pad = 12;
  let span = vp.width - pad * 2;
  const maxSpan = vp.height - vp.top - vp.bottom - 210;
  if (span > maxSpan) span = maxSpan;
  const x = (vp.width - span) / 2;
  const y = vp.top + 92;
  this.layout = board_.createLayout(x, y, span, this.game.size);
  this.boardBottom = y + span;
};

GameScene.prototype.buildButtons = function () {
  const vp = this.manager.viewport;
  const self = this;
  this.clearButtons();
  this.addBackButton(vp, function () { self.onBack(); });

  const pad = 20;
  const w = vp.width - pad * 2;
  const y = this.boardBottom + 20;
  const bw = (w - 20) / 3;

  this.undoBtn = this.addButton({
    x: pad, y: y, w: bw, h: 46, text: '悔棋',
    bg: ui.COLORS.primary, radius: 12,
    onTap: function () { self.onUndo(); }
  });
  this.addButton({
    x: pad + bw + 10, y: y, w: bw, h: 46, text: '新局',
    bg: ui.COLORS.primaryDeep, radius: 12,
    onTap: function () { self.onNewGame(); }
  });
  this.addButton({
    x: pad + (bw + 10) * 2, y: y, w: bw, h: 46, text: '返回',
    bg: '#FFFFFF', color: ui.COLORS.text, border: ui.COLORS.panelBorder, radius: 12,
    onTap: function () { self.onBack(); }
  });
};

// ===== 交互 =====

GameScene.prototype.onBack = function () {
  this.manager.pop();
};

GameScene.prototype.onNewGame = function () {
  this._rankUpdated = false;
  this.showResult = false;
  this.promotion = null;
  this.game.reset();
};

GameScene.prototype.onUndo = function () {
  const r = this.game.requestUndo();
  if (r === 'ok') {
    this.showResult = false;
    this.promotion = null;
    this._rankUpdated = false;
    return;
  }
  if (r === 'need-ad') {
    this._pendingUndo = true;
    this.showAdModal = true;
    return;
  }
  this.showToast('暂无可悔的棋步');
};

GameScene.prototype.showToast = function (text, duration) {
  this.toast = text;
  this._toastTimer = duration || 1.2;
};

GameScene.prototype.onGameOver = function (result, elapsedSec) {
  this.showResult = true;
  const humanWon = (this.mode === 'local')
    ? true
    : result.winner === this.game.humanPlayer;
  this.result = {
    won: humanWon,
    winner: result.winner,
    reason: result.reason,
    elapsed: elapsedSec + '秒',
    moves: this.game.moveCount
  };

  if (this.mode === 'ai' && !this._rankUpdated) this.updateRankAfterAIGame(humanWon);
  if (this.mode === 'challenge' && humanWon && this.params.levelId) {
    challengeProgress.markCleared(this.params.levelId);
  }
};

// AI 对战后更新段位积分（与小程序 updateRankAfterAIGame 行为一致）
GameScene.prototype.updateRankAfterAIGame = function (humanWon) {
  this._rankUpdated = true;
  const profile = storage.getPlayerProfile();
  if (!profile) return;

  const settings = storage.get('settings', {}) || {};
  const mode = settings.rankAffectsAI ? 'ai' : 'local';
  const res = humanWon ? 'win' : 'loss';

  const oldRankName = rank.getRankName(profile.rankPoints || 0);
  const rankResult = rank.applyPointsChange(profile.rankPoints || 0, mode, res);

  // 总是统计 AI 对战战绩
  if (profile.stats) rank.updateStats(profile.stats, 'ai', res);

  if (settings.rankAffectsAI) {
    profile.rankPoints = rankResult.newPoints;
    profile.rankName = rankResult.newRank.name;
  }
  storage.updatePlayerProfile(profile);

  if (rankResult.promoted && settings.rankAffectsAI) {
    this.promotion = {
      oldRank: oldRankName,
      newRank: rankResult.newRank.name,
      icon: TIER_ICONS[rankResult.newRank.tier] || '🌱'
    };
  }
};

// ===== 触摸 =====

GameScene.prototype.onTouchStart = function (x, y) {
  if (this.showMockAd) return;
  if (this.showAdModal || this.showResult || this.promotion) {
    this._modalHit(x, y, true);
    return;
  }
  BaseScene.prototype.onTouchStart.call(this, x, y);
};

GameScene.prototype.onTouchEnd = function (x, y) {
  if (this.showMockAd) return;
  if (this.promotion) { this.promotion = null; return; }
  if (this.showAdModal) { this._modalHit(x, y, false); return; }
  if (this.showResult) { this._modalHit(x, y, false); return; }

  const consumed = BaseScene.prototype.onTouchEnd.call(this, x, y);
  if (consumed) return;

  // 棋盘落子
  const cell = board_.pixelToCell(this.layout, x, y, 0.5);
  if (!cell) return;
  const r = this.game.tapCell(cell.r, cell.c);
  if (r === 'occupied') this.showToast('此处已有棋子');
  else if (r === 'over') this.showToast('对局已结束');
};

// 弹窗按钮命中（弹窗按钮在 render 中计算矩形，存于 this._modalButtons）
GameScene.prototype._modalHit = function (x, y, isDown) {
  if (isDown) return;
  const list = this._modalButtons || [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
      b.onTap();
      return;
    }
  }
};

// ===== 帧更新 =====

GameScene.prototype.update = function (dt) {
  this.phase = (this.phase + dt * 0.8) % 1;
  if (!this.showMockAd) this.game.update(dt);

  if (this._toastTimer > 0) {
    this._toastTimer -= dt;
    if (this._toastTimer <= 0) this.toast = null;
  }

  if (this.showMockAd) {
    this._mockAdTimer -= dt;
    if (this._mockAdTimer <= 0) {
      this.mockAdCountdown--;
      this._mockAdTimer = 1;
      if (this.mockAdCountdown <= 0) this.finishMockAd();
    }
  }
};

GameScene.prototype.startMockAd = function () {
  this.showAdModal = false;
  this.showMockAd = true;
  this.mockAdCountdown = MOCK_AD_SECONDS;
  this._mockAdTimer = 1;
};

GameScene.prototype.finishMockAd = function () {
  this.showMockAd = false;
  this.mockAdCountdown = MOCK_AD_SECONDS;

  if (this.game.gameOver) {
    // 对局已结束：看完广告自动悔一步，不增加次数
    if (this._pendingUndo && this.game.canUndo()) {
      this.game.executeUndo();
      this.showResult = false;
      this.promotion = null;
      this._rankUpdated = false;
    }
    this._pendingUndo = false;
  } else {
    undoManager.add(1);
    this.showToast('已获得 1 次悔棋机会', 1.5);
    if (this._pendingUndo) {
      this.game.executeUndo();
      undoManager.consume();
      this._pendingUndo = false;
    }
  }
};

// ===== 渲染 =====

GameScene.prototype.render = function (ctx, vp) {
  this.drawBackground(ctx, vp);
  this.drawStatusBar(ctx, vp);

  boardRenderer.render(ctx, this.layout, this.game.getRenderState(this.phase));

  this.undoBtn.disabled = !this.game.canUndo();
  this.undoBtn.text = this.undoBtnText();
  this.drawButtons(ctx);
  this.drawFooter(ctx, vp);

  if (this.toast) this.drawToast(ctx, vp);

  this._modalButtons = [];
  if (this.showResult) this.drawResultModal(ctx, vp);
  if (this.showAdModal) this.drawAdModal(ctx, vp);
  if (this.showMockAd) this.drawMockAd(ctx, vp);
  if (this.promotion) this.drawPromotion(ctx, vp);
};

GameScene.prototype.undoBtnText = function () {
  if (!this.game.canUndo()) return '悔棋';
  const n = undoManager.getCount();
  if (n > 0) return '悔棋（' + n + '）';
  if (this.game.gameOver) return '广告悔棋';
  return '广告获取';
};

GameScene.prototype.titleText = function () {
  if (this.mode === 'ai') return '系统对战 · ' + this.game.difficultyName;
  if (this.mode === 'challenge') return '残局闯关 · 第 ' + this.params.levelId + ' 关';
  return '本地双人';
};

GameScene.prototype.drawStatusBar = function (ctx, vp) {
  ui.drawText(ctx, this.titleText(), vp.width / 2, vp.top + 22, {
    size: 16, bold: true, align: 'center'
  });

  const y = vp.top + 50;
  ui.drawPanel(ctx, 16, y, vp.width - 32, 34, 17);

  const g = this.game;
  let statusText;
  let stoneColor;
  if (g.gameOver) {
    statusText = (g.winner === board_.BLACK ? '黑方' : '白方') + '胜 · ' + g.winReason;
    stoneColor = g.winner;
  } else if (g.aiThinking) {
    statusText = 'AI 思考中…';
    stoneColor = g.aiPlayer;
  } else {
    const who = (this.mode === 'local')
      ? (g.currentPlayer === board_.BLACK ? '黑方回合' : '白方回合')
      : (g.currentPlayer === g.humanPlayer ? '你的回合' : '对手回合');
    statusText = who;
    stoneColor = g.currentPlayer;
  }

  ui.fillCircle(ctx, 34, y + 17, 9, stoneColor === board_.BLACK ? '#1a1a1a' : '#f5f5f5');
  if (stoneColor !== board_.BLACK) {
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(34, y + 17, 9, 0, Math.PI * 2);
    ctx.stroke();
  }
  ui.drawText(ctx, statusText, 52, y + 17, { size: 14, bold: true });
  ui.drawText(ctx, '第 ' + g.moveCount + ' 手 · ' + g.elapsedSec + '秒',
    vp.width - 32, y + 17, { size: 12, color: ui.COLORS.textSub, align: 'right' });
};

GameScene.prototype.drawFooter = function (ctx, vp) {
  const y = this.undoBtn.y + 60;
  let hint;
  if (this.game.pendingMove) hint = '再次点击同一位置确认落子';
  else if (this.mode === 'local') hint = '轮流落子 · 点击棋盘预览，再点确认';
  else hint = '点击棋盘预览，再点同一位置确认';
  ui.drawText(ctx, hint, vp.width / 2, y + 10, {
    size: 12, color: ui.COLORS.textSub, align: 'center'
  });
};

GameScene.prototype.drawToast = function (ctx, vp) {
  const text = this.toast;
  ctx.save();
  ctx.font = '14px sans-serif';
  const w = ctx.measureText(text).width + 32;
  ctx.restore();
  const x = (vp.width - w) / 2;
  const y = vp.height * 0.62;
  ui.fillRoundRect(ctx, x, y, w, 36, 18, 'rgba(0,0,0,0.72)');
  ui.drawText(ctx, text, vp.width / 2, y + 18, { size: 14, color: '#FFFFFF', align: 'center' });
};

// 通用弹窗容器，返回内容区
GameScene.prototype._modalBox = function (ctx, vp, h) {
  ui.drawMask(ctx, vp.width, vp.height);
  const w = Math.min(300, vp.width - 48);
  const x = (vp.width - w) / 2;
  const y = (vp.height - h) / 2;
  ui.fillRoundRect(ctx, x, y, w, h, 16, '#FFFFFF');
  return { x: x, y: y, w: w, h: h };
};

GameScene.prototype._modalButton = function (ctx, x, y, w, h, text, bg, color, onTap) {
  ui.fillRoundRect(ctx, x, y, w, h, 10, bg);
  ui.drawText(ctx, text, x + w / 2, y + h / 2, {
    size: 15, color: color, align: 'center', bold: true
  });
  this._modalButtons.push({ x: x, y: y, w: w, h: h, onTap: onTap });
};

GameScene.prototype.drawResultModal = function (ctx, vp) {
  const self = this;
  const box = this._modalBox(ctx, vp, 250);
  const r = this.result;

  let title;
  if (this.mode === 'local') title = (r.winner === board_.BLACK ? '黑方' : '白方') + '获胜';
  else title = r.won ? '胜利！' : '惜败';

  // 残局闯关胜利且存在下一关 → 提供「下一关」入口
  let nextLevel = null;
  if (this.mode === 'challenge' && r.won && this.params.levelId) {
    const nid = this.params.levelId + 1;
    const lvl = levels.getLevel(nid);
    if (lvl && nid <= challengeProgress.getUnlockedMax()) {
      nextLevel = { id: nid, level: lvl };
    }
  }

  ui.drawText(ctx, title, vp.width / 2, box.y + 42, {
    size: 26, bold: true, align: 'center',
    color: (this.mode === 'local' || r.won) ? ui.COLORS.success : ui.COLORS.danger
  });
  ui.drawText(ctx, r.reason, vp.width / 2, box.y + 78, {
    size: 14, align: 'center', color: ui.COLORS.textSub
  });
  ui.drawText(ctx, '用时 ' + r.elapsed + ' · 共 ' + r.moves + ' 手',
    vp.width / 2, box.y + 104, { size: 13, align: 'center', color: ui.COLORS.textSub });

  const bw = (box.w - 48) / 2;
  const by = box.y + 132;

  if (nextLevel) {
    // 主操作：下一关（整行主色）
    this._modalButton(ctx, box.x + 16, by, box.w - 32, 42, '下一关',
      ui.COLORS.primary, '#FFFFFF', function () {
        self.showResult = false;
        self.manager._activate('game', {
          mode: 'challenge',
          levelId: nextLevel.id,
          size: nextLevel.level.boardSize,
          initialBoard: nextLevel.level.board,
          humanPlayer: nextLevel.level.humanColor,
          firstPlayer: nextLevel.level.firstPlayer,
          difficulty: nextLevel.level.aiLevel || nextLevel.level.difficulty || 'normal'
        });
      });
    // 次操作：重玩本关 / 返回选关
    this._modalButton(ctx, box.x + 16, by + 52, bw, 42, '重玩本关',
      ui.COLORS.success, '#FFFFFF', function () { self.onNewGame(); });
    this._modalButton(ctx, box.x + 32 + bw, by + 52, bw, 42, '返回选关',
      '#F0E4D0', ui.COLORS.text, function () {
        self.showResult = false;
        self.manager.pop();
      });
  } else {
    this._modalButton(ctx, box.x + 16, by, bw, 42, '悔棋', ui.COLORS.primary, '#FFFFFF', function () {
      self.showResult = false;
      self.onUndo();
    });
    this._modalButton(ctx, box.x + 32 + bw, by, bw, 42, '再来一局', ui.COLORS.success, '#FFFFFF', function () {
      self.onNewGame();
    });
    this._modalButton(ctx, box.x + 16, by + 52, box.w - 32, 42, '返回主菜单',
      '#F0E4D0', ui.COLORS.text, function () {
        self.showResult = false;
        self.manager.replace('home');
      });
  }
};

GameScene.prototype.drawAdModal = function (ctx, vp) {
  const self = this;
  const box = this._modalBox(ctx, vp, 190);
  const title = this.game.gameOver ? '看广告悔一步' : '看广告获取悔棋次数';
  const desc = this.game.gameOver
    ? '本局已结束，观看广告后可回退一步继续下'
    : '悔棋次数已用完，观看广告可获得 1 次悔棋机会';

  ui.drawText(ctx, title, vp.width / 2, box.y + 36, { size: 18, bold: true, align: 'center' });
  ui.drawWrappedText(ctx, desc, box.x + 20, box.y + 72, box.w - 40, 20, {
    size: 13, color: ui.COLORS.textSub
  });

  const bw = (box.w - 48) / 2;
  const by = box.y + box.h - 60;
  this._modalButton(ctx, box.x + 16, by, bw, 42, '取消', '#F0E4D0', ui.COLORS.text, function () {
    self._pendingUndo = false;
    self.showAdModal = false;
  });
  this._modalButton(ctx, box.x + 32 + bw, by, bw, 42, '观看广告', ui.COLORS.success, '#FFFFFF', function () {
    self.startMockAd();
  });
};

GameScene.prototype.drawMockAd = function (ctx, vp) {
  ui.drawMask(ctx, vp.width, vp.height);
  ui.drawText(ctx, '广告播放中', vp.width / 2, vp.height / 2 - 20, {
    size: 20, bold: true, align: 'center', color: '#FFFFFF'
  });
  ui.drawText(ctx, this.mockAdCountdown + ' 秒后可获得奖励', vp.width / 2, vp.height / 2 + 14, {
    size: 14, align: 'center', color: 'rgba(255,255,255,0.85)'
  });
};

GameScene.prototype.drawPromotion = function (ctx, vp) {
  const self = this;
  const box = this._modalBox(ctx, vp, 220);
  const p = this.promotion;
  ui.drawText(ctx, p.icon, vp.width / 2, box.y + 52, { size: 38, align: 'center' });
  ui.drawText(ctx, '恭喜升段！', vp.width / 2, box.y + 98, {
    size: 20, bold: true, align: 'center', color: ui.COLORS.primary
  });
  ui.drawText(ctx, p.oldRank + '  →  ' + p.newRank, vp.width / 2, box.y + 128, {
    size: 15, align: 'center'
  });
  this._modalButton(ctx, box.x + 16, box.y + box.h - 60, box.w - 32, 42, '知道了',
    ui.COLORS.primary, '#FFFFFF', function () { self.promotion = null; });
};

module.exports = function (manager) { return new GameScene(manager); };
