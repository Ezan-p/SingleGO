// js/scenes/RoomGameScene.js
// 好友房间对局场景（取代 pages/online）
// 房间文档 rooms/{docId} 全量快照同步：watch 推送 → 重建棋盘。
// 落子仍走 network.placeMove（读-校验-写回，规则判定复用 rule.evaluateMove，逻辑不变）。

const BaseScene = require('./BaseScene.js');
const ui = require('../render/ui.js');
const boardRenderer = require('../render/BoardRenderer.js');
const board_ = require('../board.js');
const network = require('../network.js');
const storage = require('../storage.js');
const rank = require('../rank.js');
const sound = require('../sound.js');

// 每步思考时限(ms)：超时由本端随机落子（好友对战为纯客户端逻辑，仅当前行棋方客户端触发）
const TURN_TIMEOUT_MS = 30000;

function RoomGameScene(manager) {
  BaseScene.call(this, manager);
}
RoomGameScene.prototype = Object.create(BaseScene.prototype);
RoomGameScene.prototype.constructor = RoomGameScene;

// ===== 生命周期 =====

RoomGameScene.prototype.onEnter = function (params) {
  const p = params || {};
  const self = this;

  this.docId = p.docId || '';
  this.board = null;
  this.boardSize = board_.DEFAULT_SIZE;
  this.layout = null;
  this.currentPlayer = board_.BLACK;
  this.myColor = 0;              // 1=黑(房主) 2=白(客)
  this.isMyTurn = false;
  this.gameOver = false;
  this.winner = 0;
  this.winReason = '';
  this.moveCount = 0;
  this.lastMove = null;
  this.host = null;
  this.guest = null;
  this.pendingCell = null;
  this.phase = 0;
  this.toast = null;
  this._toastTimer = 0;
  this._placing = false;
  this._lastAppliedMove = null;
  this._endedShown = false;
  this._soundMoveCount = undefined;
  this.watcher = null;
  // 思考时限倒计时（好友对战，纯客户端）
  this.turnCountdown = 0;
  this.turnProgress = 100;
  this.turnDeadline = 0;
  this.turnTimeoutFired = false;
  this._lastMoveCount = undefined;
  this._secTick = 0;
  this.leaving = false;
  this.myRankName = rank.getRankName(storage.globalData.rankPoints || 0);
  this.myOpenid = storage.globalData.openid;

  this.buildLayout();
  this.buildButtons();

  if (!this.docId) {
    wx.showToast({ title: '缺少对局参数', icon: 'none' });
    setTimeout(function () { self.manager.pop(); }, 1000);
    return;
  }

  this.watcher = network.subscribeRoom(this.docId, function (room, err) {
    if (err) {
      wx.showToast({ title: '连接断开', icon: 'none' });
      return;
    }
    self.applyRoom(room);
  });

  // 首次全量拉取（watch 首帧之前先显示棋盘）
  network.db().collection('rooms').doc(this.docId).get().then(function (res) {
    if (res && res.data) self.applyRoom(res.data);
  }).catch(function () {});
};

RoomGameScene.prototype.onExit = function () {
  this.closeWatcher();
};

RoomGameScene.prototype.closeWatcher = function () {
  if (this.watcher) {
    try { this.watcher.close(); } catch (e) {}
    this.watcher = null;
  }
};

// ===== 布局 =====

RoomGameScene.prototype.buildLayout = function () {
  const vp = this.manager.viewport;
  const pad = 12;
  let span = vp.width - pad * 2;
  const maxSpan = vp.height - vp.top - vp.bottom - 240;
  if (span > maxSpan) span = maxSpan;
  const x = (vp.width - span) / 2;
  const y = vp.top + 108;
  this.layout = board_.createLayout(x, y, span, this.boardSize);
  this.boardBottom = y + span;
};

RoomGameScene.prototype.buildButtons = function () {
  const vp = this.manager.viewport;
  const self = this;
  this.clearButtons();
  this.addBackButton(vp, function () { self.onLeave(); });

  const pad = 40;
  const y = Math.min(this.boardBottom + 84, vp.height - vp.bottom - 60);
  this.leaveBtn = this.addButton({
    x: pad, y: y, w: vp.width - pad * 2, h: 46, text: '离开对局',
    bg: '#FFFFFF', color: ui.COLORS.danger, border: ui.COLORS.panelBorder, radius: 12,
    onTap: function () { self.onLeave(); }
  });
};

// ===== 房间同步 =====

RoomGameScene.prototype.applyRoom = function (room) {
  if (!room) return;
  // 远端棋盘变化会重建，清除本地预览避免错位
  this.pendingCell = null;
  this._placing = false; // 服务器已回写，解除落子锁

  const myOpenid = this.myOpenid || storage.globalData.openid;
  this.myOpenid = myOpenid;
  this.myColor = (room.host && room.host.openid === myOpenid) ? board_.BLACK
    : (room.guest && room.guest.openid === myOpenid) ? board_.WHITE : 0;

  const boardSize = room.board.length;
  if (this.boardSize !== boardSize) {
    this.boardSize = boardSize;
    this.buildLayout();
    this.buildButtons();
  }

  // 回声去重：自己写入的最近一步，UI 已反映则跳过棋盘重建
  const isEcho = room.lastMoveBy === myOpenid
    && this._lastAppliedMove
    && room.lastMove
    && this._lastAppliedMove.r === room.lastMove.r
    && this._lastAppliedMove.c === room.lastMove.c;

  if (!isEcho) {
    this.board = room.board;
    this._lastAppliedMove = room.lastMove;
    this.lastMove = room.lastMove;
  }

  // 落子音效：新棋子落到棋盘上时播放（载入对局不发声）
  const curMoves = (room.moves && room.moves.length) || 0;
  if (this._soundMoveCount === undefined) {
    this._soundMoveCount = curMoves;
  } else if (curMoves > this._soundMoveCount) {
    sound.playStone();
    this._soundMoveCount = curMoves;
  }

  const isEnded = room.status === 'ended' && room.winner !== 0;
  this.currentPlayer = room.currentPlayer;
  this.gameOver = isEnded;
  this.winner = room.winner;
  this.winReason = room.winReason || '';
  this.moveCount = curMoves;
  this.host = room.host;
  this.guest = room.guest;
  this.isMyTurn = room.status === 'playing' && room.currentPlayer === this.myColor;
  this.playing = room.status === 'playing';

  // 思考时限：每产生一步（moveCount 变化）重置倒计时；对局结束则清零
  if (room.status === 'playing' && (this._lastMoveCount === undefined || curMoves !== this._lastMoveCount)) {
    this._lastMoveCount = curMoves;
    this.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
    this.turnTimeoutFired = false;
  } else if (isEnded) {
    this._lastMoveCount = curMoves;
    this.turnDeadline = 0;
    this.turnTimeoutFired = true;
    this.turnCountdown = 0;
    this.turnProgress = 0;
  }

  if (isEnded && !this._endedShown) {
    this._endedShown = true;
    const self = this;
    setTimeout(function () {
      wx.showModal({
        title: (room.winner === board_.BLACK ? '黑棋' : '白棋') + '胜利',
        content: room.winReason || '',
        showCancel: false,
        confirmText: '返回',
        success: function () {
          self.leaving = true;
          self.manager.pop();
        }
      });
    }, 1300); // 先高亮/看清最后一手，再弹结算
  }
};

// ===== 落子 =====

RoomGameScene.prototype.onCellTap = function (r, c) {
  if (this.gameOver || !this.board) return;
  if (!this.isMyTurn) {
    this.showToast('等待对手落子');
    return;
  }
  if (this._placing) return; // 等待服务器回写，避免重复落子

  if (this.board[r][c] !== board_.EMPTY) {
    this.pendingCell = null;
    return;
  }
  if (this.pendingCell && this.pendingCell.r === r && this.pendingCell.c === c) {
    // 再次点击同一交叉点 → 确认落子（写库后 watch 回调统一刷新）
    this.pendingCell = null;
    this.confirmMove(r, c);
    return;
  }
  this.pendingCell = { r: r, c: c };
};

RoomGameScene.prototype.confirmMove = function (r, c) {
  const self = this;
  this._placing = true;
  network.placeMove(this.docId, { r: r, c: c, player: this.myColor })
    .catch(function (err) {
      self._placing = false; // 失败则解锁，允许重试
      self.showToast((err && err.message) || '落子失败');
    });
};

// ===== 离开 =====

RoomGameScene.prototype.onLeave = function () {
  const self = this;
  if (this.gameOver) {
    this.leaving = true;
    this.closeWatcher();
    this.manager.pop();
    return;
  }
  wx.showModal({
    title: '离开对局',
    content: '离开将判对手胜利，确认离开？',
    success: function (res) {
      if (!res.confirm) return;
      self.leaving = true;
      const role = self.myColor === board_.BLACK ? 'host' : 'guest';
      self.closeWatcher();
      network.leaveRoom(self.docId, role).then(function () {
        self.manager.pop();
      }).catch(function () {
        self.manager.pop();
      });
    }
  });
};

// ===== 触摸 =====

RoomGameScene.prototype.onTouchEnd = function (x, y) {
  const consumed = BaseScene.prototype.onTouchEnd.call(this, x, y);
  if (consumed) return;
  if (!this.board || !this.layout) return;
  const cell = board_.pixelToCell(this.layout, x, y, 0.5);
  if (!cell) return;
  this.onCellTap(cell.r, cell.c);
};

// ===== 帧更新 =====

RoomGameScene.prototype.update = function (dt) {
  this.phase = (this.phase + dt * 0.8) % 1;
  // 每秒 tick 一次思考时限倒计时（避免每帧调用）
  this._secTick += dt;
  if (this._secTick >= 1) {
    this._secTick -= 1;
    this.tickTurnCountdown();
  }
  if (this._toastTimer > 0) {
    this._toastTimer -= dt;
    if (this._toastTimer <= 0) this.toast = null;
  }
};

// 思考时限倒计时 tick（好友对战，纯客户端）
RoomGameScene.prototype.tickTurnCountdown = function () {
  if (!this.turnDeadline || this.gameOver) {
    if (this.turnCountdown !== 0) this.turnCountdown = 0;
    if (this.turnProgress !== 0) this.turnProgress = 0;
    return;
  }
  const remaining = this.turnDeadline - Date.now();
  if (remaining <= 0) {
    this.turnCountdown = 0;
    this.turnProgress = 0;
    // 仅当前行棋方且未在落子提交中时触发随机落子
    if (!this.turnTimeoutFired && this.isMyTurn && !this._placing) {
      this.turnTimeoutFired = true;
      this.doTimeoutRandomMove();
    }
  } else {
    const secs = Math.ceil(remaining / 1000);
    let pct = Math.round((remaining / TURN_TIMEOUT_MS) * 100);
    if (pct > 100) pct = 100;
    if (pct < 0) pct = 0;
    this.turnCountdown = secs;
    this.turnProgress = pct;
  }
};

// 超时由本端随机落子（系统随机落子），提交时标记 isTimeout
RoomGameScene.prototype.doTimeoutRandomMove = function () {
  const self = this;
  if (!this.board || this._placing) { this.turnTimeoutFired = false; return; }
  const move = board_.chooseRandomMove(this.board, this.myColor);
  if (!move) { this.turnTimeoutFired = false; return; } // 棋盘已满等极端情况：下一秒重试
  this._placing = true;
  network.placeMove(this.docId, {
    r: move.r, c: move.c, player: this.myColor, isTimeout: true
  }).then(function () {
    self.showToast('超时·系统随机落子');
  }).catch(function (err) {
    self._placing = false;
    self.turnTimeoutFired = false; // 允许下次重试
    self.showToast((err && err.message) || '超时落子失败');
  });
};

RoomGameScene.prototype.showToast = function (text, duration) {
  this.toast = text;
  this._toastTimer = duration || 1.2;
};

// ===== 渲染 =====

RoomGameScene.prototype.render = function (ctx, vp) {
  this.drawBackground(ctx, vp);
  ui.drawText(ctx, '好友对战', vp.width / 2, vp.top + 22, {
    size: 18, bold: true, align: 'center'
  });

  this.drawInfoBar(ctx, vp);

  if (this.board) {
    boardRenderer.render(ctx, this.layout, {
      board: this.board,
      lastMove: this.lastMove,
      pending: this.pendingCell,
      pendingPlayer: this.myColor || board_.BLACK,
      winStones: null,
      winTarget: null,
      phase: this.phase
    });
  } else {
    ui.drawText(ctx, '对局加载中…', vp.width / 2, vp.height / 2, {
      size: 15, align: 'center', color: ui.COLORS.textSub
    });
  }

  this.drawStatusLine(ctx, vp);
  this.drawTurnBar(ctx, vp);
  this.drawButtons(ctx);
  if (this.toast) this.drawToast(ctx, vp);
};

RoomGameScene.prototype.drawInfoBar = function (ctx, vp) {
  const y = vp.top + 48;
  ui.drawPanel(ctx, 14, y, vp.width - 28, 46, 12);

  const hostName = (this.host && this.host.nickname) || '房主';
  const guestName = (this.guest && this.guest.nickname) || '好友';

  ui.fillCircle(ctx, 34, y + 23, 10, '#1a1a1a');
  ui.drawText(ctx, hostName, 50, y + 23, {
    size: 13, bold: this.currentPlayer === board_.BLACK && !this.gameOver
  });

  ui.fillCircle(ctx, vp.width - 34, y + 23, 10, '#f5f5f5');
  ctx.strokeStyle = 'rgba(0,0,0,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(vp.width - 34, y + 23, 10, 0, Math.PI * 2);
  ctx.stroke();
  ui.drawText(ctx, guestName, vp.width - 50, y + 23, {
    size: 13, align: 'right', bold: this.currentPlayer === board_.WHITE && !this.gameOver
  });

  ui.drawText(ctx, '第 ' + this.moveCount + ' 手', vp.width / 2, y + 23, {
    size: 12, align: 'center', color: ui.COLORS.textSub
  });
};

RoomGameScene.prototype.drawStatusLine = function (ctx, vp) {
  const y = this.boardBottom + 26;
  let text;
  let color = ui.COLORS.textSub;
  if (this.gameOver) {
    text = (this.winner === board_.BLACK ? '黑棋' : '白棋') + '胜 · ' + (this.winReason || '');
    color = ui.COLORS.primary;
  } else if (this._placing) {
    text = '落子提交中…';
  } else if (this.pendingCell) {
    text = '再次点击同一位置确认落子';
  } else if (this.isMyTurn) {
    text = '你的回合（执' + (this.myColor === board_.BLACK ? '黑' : '白') + '）· 点击预览再确认';
  } else if (this.myColor === 0) {
    text = '观战中';
  } else {
    text = '等待对手落子…';
  }
  ui.drawText(ctx, text, vp.width / 2, y, { size: 13, align: 'center', color: color });
};

// 思考时限进度条（位于状态行下方）
RoomGameScene.prototype.drawTurnBar = function (ctx, vp) {
  if (!this.board || !this.playing) return; // 对局加载中或未开始不绘制
  const y = this.boardBottom + 46;
  let label;
  let barColor = ui.COLORS.success;
  if (this.gameOver) {
    label = '对局已结束';
    barColor = ui.COLORS.disabled;
  } else if (this.isMyTurn) {
    label = '你的回合 · ' + this.turnCountdown + 's';
    barColor = this.turnCountdown <= 10 ? ui.COLORS.danger : ui.COLORS.success;
  } else {
    label = '对手思考中 · ' + this.turnCountdown + 's';
    barColor = ui.COLORS.info;
  }

  ui.drawText(ctx, label, vp.width / 2, y, { size: 12, align: 'center', color: ui.COLORS.textSub });

  const x = 16;
  const w = vp.width - 32;
  const barY = y + 12;
  ui.fillRoundRect(ctx, x, barY, w, 5, 2.5, '#E4DACA');
  const pw = Math.max(0, Math.min(w, w * (this.gameOver ? 0 : this.turnProgress) / 100));
  if (pw > 0) ui.fillRoundRect(ctx, x, barY, pw, 5, 2.5, barColor);
};

RoomGameScene.prototype.drawToast = function (ctx, vp) {
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

module.exports = function (manager) { return new RoomGameScene(manager); };
