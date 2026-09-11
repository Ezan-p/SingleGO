// js/scenes/MatchScene.js
// 联网匹配（取代 pages/match）：watch 匹配队列实时同步，
// 30 秒未匹配到真人 → 自动请求系统分配 AI 对手（createAIMatch），流程与小程序版一致。

const BaseScene = require('./BaseScene.js');
const ui = require('../render/ui.js');
const network = require('../network.js');
const storage = require('../storage.js');
const rank = require('../rank.js');

// 匹配范围档位（与 matchChecker 对齐）
function getMatchRangeText(waitingTime) {
  if (waitingTime < 20) return '同段位';
  if (waitingTime < 45) return '相邻段位';
  if (waitingTime < 90) return '±2 段位';
  return '全部段位';
}

// 超时匹配阈值（秒）：超过仍未匹配到真人 → 自动分配 AI 对手
const AI_MATCH_TIMEOUT_SEC = 30;

function MatchScene(manager) {
  BaseScene.call(this, manager);
}
MatchScene.prototype = Object.create(BaseScene.prototype);
MatchScene.prototype.constructor = MatchScene;

MatchScene.prototype.onEnter = function () {
  const vp = this.manager.viewport;
  const self = this;
  this.clearButtons();

  this.matched = false;
  this.canceled = false;
  this.joining = false;
  this.aiMatching = false;
  this.polling = false;
  this.waitingTime = 0;
  this._tick = 0;
  this.matchRange = '同段位';
  this.opponentInfo = null;
  this.myColor = 'black';
  this.gameId = null;
  this.countdown = 3;
  this._countdownTick = 0;
  this.watcher = null;
  this.statusText = '正在寻找对手…';
  this.myRankName = rank.getRankName(storage.globalData.rankPoints || 0);

  this.cancelBtn = this.addButton({
    x: 40, y: vp.height - vp.bottom - 100, w: vp.width - 80, h: 48,
    text: '取消匹配', bg: '#FFFFFF', color: ui.COLORS.danger,
    border: ui.COLORS.panelBorder, radius: 14,
    onTap: function () { self.onCancelMatch(); }
  });
  this.startBtn = this.addButton({
    x: 40, y: vp.height - vp.bottom - 160, w: vp.width - 80, h: 48,
    text: '立即开始', bg: ui.COLORS.success, radius: 14, hidden: true,
    onTap: function () { self.startGame(); }
  });

  this.startMatch();
};

MatchScene.prototype.onExit = function () {
  this.canceled = true;
  this.closeWatcher();
  if (!this.matched && !this.joining) {
    network.cancelMatch().catch(function () {});
  }
};

MatchScene.prototype.closeWatcher = function () {
  if (this.watcher) {
    try { this.watcher.close(); } catch (e) {}
    this.watcher = null;
  }
};

MatchScene.prototype.leave = function (msg, delay) {
  const self = this;
  if (msg) wx.showToast({ title: msg, icon: 'none' });
  setTimeout(function () {
    if (self.manager.currentName === 'match') self.manager.pop();
  }, delay || 1200);
};

MatchScene.prototype.startMatch = function () {
  if (this.joining) return;
  this.joining = true;
  const self = this;

  network.joinMatchQueue().then(function (res) {
    self.joining = false;
    const result = res.result || {};
    if (result.code === 200) {
      self.startWatchMatchQueue();
      return;
    }
    const msg = result.message || '加入匹配失败';
    // “已在匹配队列中” → 仅恢复监听
    if (result.code === 400 && /已在匹配队列/.test(msg)) {
      self.startWatchMatchQueue();
      return;
    }
    // 已存在进行中的对局 → 直接回到该对局
    if ((result.code === 400 || result.code === 409) && result.data && result.data.gameId) {
      wx.showToast({ title: '正在返回进行中的对局', icon: 'none' });
      self.matched = true;
      self.gameId = result.data.gameId;
      setTimeout(function () { self.startGame(); }, 800);
      return;
    }
    self.leave(msg, 1500);
  }).catch(function (err) {
    self.joining = false;
    console.error('[dango] 加入匹配失败:', err);
    const msg = (err && err.message) ? err.message : '网络错误';
    self.leave(msg.indexOf('云开发') >= 0 ? msg : '网络错误', 1500);
  });
};

MatchScene.prototype.startWatchMatchQueue = function () {
  const self = this;
  const openid = storage.globalData.openid;
  if (!openid) return;

  network.watchMatchQueue(openid, function (err, matchRecord) {
    if (err) {
      console.error('[dango] watch match_queue error', err);
      self.fallbackPoll();
      return;
    }
    if (!matchRecord) {
      // 队列记录消失（取消 / 超时清理 / 转 AI 匹配）
      if (!self.matched && !self.aiMatching && !self.canceled) self.leave('匹配已结束');
      return;
    }
    if (matchRecord.status === 'matched' && matchRecord.matched_game_id) {
      self.loadMatchedGame(matchRecord.matched_game_id);
    }
  }).then(function (watcher) {
    if (self.canceled) { try { watcher.close(); } catch (e) {} return; }
    self.watcher = watcher;
  }).catch(function (err) {
    console.error('[dango] startWatchMatchQueue failed', err);
    self.fallbackPoll();
  });
};

// watch 不可用时回退轮询
MatchScene.prototype.fallbackPoll = function () {
  if (this.matched || this.polling) return;
  this.polling = true;
  const self = this;
  const poll = function () {
    if (self.matched || self.canceled) return;
    network.getMatchStatus().then(function (res) {
      const d = res.result && res.result.data;
      if (res.result && res.result.code === 200 && d && d.match) {
        const m = d.match;
        if (m.status === 'matched' && m.matched_game_id) {
          self.loadMatchedGame(m.matched_game_id);
          return;
        }
      }
      setTimeout(poll, 1500);
    }).catch(function () { setTimeout(poll, 1500); });
  };
  poll();
};

MatchScene.prototype.loadMatchedGame = function (gameId) {
  const self = this;
  network.db().collection('games').doc(gameId).get().then(function (res) {
    if (res.data) self.onMatchSuccess(res.data);
  }).catch(function (err) {
    console.error('[dango] 加载游戏失败', err);
  });
};

MatchScene.prototype.onMatchSuccess = function (game) {
  this.closeWatcher();
  const myOpenid = storage.globalData.openid;
  const isBlack = game.black_openid === myOpenid;

  this.matched = true;
  this.myColor = isBlack ? 'black' : 'white';
  this.gameId = game._id;
  this.opponentInfo = isBlack ? {
    nickname: game.white_nickname,
    avatar: game.white_avatar,
    rankName: game.white_rank_name || ''
  } : {
    nickname: game.black_nickname,
    avatar: game.black_avatar,
    rankName: game.black_rank_name || ''
  };
  this.countdown = 3;
  this._countdownTick = 0;
  this.startBtn.hidden = false;
  this.cancelBtn.hidden = true;
};

// 超时匹配 AI
MatchScene.prototype.startAIMatch = function () {
  if (this.matched || this.aiMatching || this.canceled) return;
  const self = this;
  this.aiMatching = true;
  this.matchRange = 'AI 对手';
  this.statusText = '正在为你分配对手…';
  // createAIMatch 会把队列状态改为 ai_timeout，需先关闭 watch 避免误判"匹配结束"
  this.closeWatcher();

  network.createAIMatch().then(function (res) {
    if (self.canceled) return;
    const result = res.result || {};
    if (result.code === 200 && result.data && result.data.game) {
      const game = result.data.game;
      self.matched = true;
      self.gameId = game._id;
      self.aiColor = game.ai_color || '';
      self.aiLevel = game.ai_level || '';
      self.startGame();
    } else if (result.code === 409) {
      // 边界：恰好此时已匹配真人 → 真人优先
      self.aiMatching = false;
      const gid = result.data && result.data.gameId;
      if (gid) self.loadMatchedGame(gid);
      else self.leave('已匹配对手');
    } else {
      self.aiMatching = false;
      self.leave(result.message || '匹配失败', 1500);
    }
  }).catch(function (err) {
    self.aiMatching = false;
    console.error('[dango] AI 匹配失败:', err);
    const msg = (err && err.message) ? err.message : '网络错误';
    self.leave(msg.indexOf('云开发') >= 0 ? msg : '网络错误', 1500);
  });
};

MatchScene.prototype.onCancelMatch = function () {
  const self = this;
  wx.showModal({
    title: '提示',
    content: '确定要取消匹配吗？',
    success: function (r) { if (r.confirm) self.cancelMatch(); }
  });
};

MatchScene.prototype.cancelMatch = function () {
  const self = this;
  this.canceled = true;
  this.closeWatcher();
  network.cancelMatch().then(function (res) {
    if (res.result && res.result.code === 200) {
      wx.showToast({ title: '已取消匹配', icon: 'success' });
    }
    setTimeout(function () { self.manager.pop(); }, 800);
  }).catch(function () {
    self.canceled = false;
    wx.showToast({ title: '取消失败，请重试', icon: 'none' });
  });
};

MatchScene.prototype.startGame = function () {
  if (!this.gameId) return;
  this.closeWatcher();
  // 用 replace 语义：匹配页出栈，进入对局页
  this.manager.stack.pop();
  this.manager.push('online-game', { gameId: this.gameId });
};

MatchScene.prototype.update = function (dt) {
  if (this.canceled) return;

  if (!this.matched) {
    this._tick += dt;
    if (this._tick >= 1) {
      this._tick -= 1;
      this.waitingTime++;
      this.matchRange = this.aiMatching ? 'AI 对手' : getMatchRangeText(this.waitingTime);
      if (this.waitingTime >= AI_MATCH_TIMEOUT_SEC && !this.aiMatching) {
        this.startAIMatch();
      }
    }
  } else if (this.opponentInfo) {
    this._countdownTick += dt;
    if (this._countdownTick >= 1) {
      this._countdownTick -= 1;
      this.countdown--;
      if (this.countdown <= 0) this.startGame();
    }
  }
};

MatchScene.prototype.render = function (ctx, vp) {
  this.drawBackground(ctx, vp);
  ui.drawText(ctx, '联网对战', vp.width / 2, vp.top + 22, { size: 18, bold: true, align: 'center' });

  const cy = vp.height * 0.36;

  if (!this.matched) {
    // 搜索动画：呼吸圆环
    const t = (Date.now() % 1600) / 1600;
    for (let i = 0; i < 3; i++) {
      const p = (t + i / 3) % 1;
      ctx.save();
      ctx.globalAlpha = 1 - p;
      ctx.strokeStyle = ui.COLORS.primary;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(vp.width / 2, cy, 30 + p * 50, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    ui.fillCircle(ctx, vp.width / 2, cy, 28, ui.COLORS.primary);
    ui.drawText(ctx, '棋', vp.width / 2, cy, { size: 22, bold: true, color: '#FFFFFF', align: 'center' });

    ui.drawText(ctx, this.statusText, vp.width / 2, cy + 110, {
      size: 17, bold: true, align: 'center'
    });
    ui.drawText(ctx, '已等待 ' + this.waitingTime + ' 秒',
      vp.width / 2, cy + 138, { size: 13, align: 'center', color: ui.COLORS.textSub });
    ui.drawText(ctx, '我的段位：' + this.myRankName, vp.width / 2, cy + 162, {
      size: 13, align: 'center', color: ui.COLORS.textSub
    });
  } else {
    ui.drawText(ctx, '匹配成功！', vp.width / 2, cy - 40, {
      size: 24, bold: true, align: 'center', color: ui.COLORS.success
    });
    const opp = this.opponentInfo || {};
    ui.drawPanel(ctx, 40, cy, vp.width - 80, 96, 14);
    ui.drawText(ctx, opp.nickname || 'AI 对手', vp.width / 2, cy + 32, {
      size: 17, bold: true, align: 'center'
    });
    ui.drawText(ctx, opp.rankName || '',
      vp.width / 2, cy + 58, { size: 13, align: 'center', color: ui.COLORS.textSub });
    ui.drawText(ctx, '你执' + (this.myColor === 'black' ? '黑' : '白'),
      vp.width / 2, cy + 80, { size: 13, align: 'center', color: ui.COLORS.primary });
    ui.drawText(ctx, this.countdown + ' 秒后进入对局', vp.width / 2, cy + 130, {
      size: 14, align: 'center', color: ui.COLORS.textSub
    });
  }

  this.drawButtons(ctx);
};

module.exports = function (manager) { return new MatchScene(manager); };
