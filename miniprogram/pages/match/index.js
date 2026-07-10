// 匹配页面 — watch 实时同步
const app = getApp();
const rank = require('../../utils/rank.js');
const onlineMatch = require('../../utils/online-match.js');

// 匹配范围档位（与 matchChecker 对齐）
// 0-20s 同段位、20-45s ±1段、45-90s ±2段、90s+ ±4段
function getMatchRangeText(waitingTime) {
  if (waitingTime < 20) return '同段位';
  if (waitingTime < 45) return '相邻段位';
  if (waitingTime < 90) return '±2 段位';
  return '全部段位';
}

Page({
  data: {
    matched: false,
    waitingTime: 0,
    matchRange: '同段位',
    opponentInfo: null,
    myColor: 'black',
    countdown: 3,
    gameId: null,
    matchTimer: null,
    countdownTimer: null,
    myRankName: '',
    joining: false,
    matchQueueWatcher: null
  },

  onLoad: function () {
    this.setData({ myRankName: rank.getRankName(app.globalData.rankPoints || 0) });
    this.startMatch();
  },

  onUnload: function () {
    this.clearTimers();
    this.closeWatcher();
    // 页面关闭时若仍在匹配中，取消匹配
    if (!this.data.matched && !this.data.joining) {
      onlineMatch.cancelMatch().catch(() => {});
    }
  },

  // 开始匹配
  startMatch: function () {
    if (this.data.joining) return;
    this.setData({ joining: true });

    onlineMatch.joinMatchQueue().then((res) => {
      this.setData({ joining: false });
      if (res.result && res.result.code === 200) {
        this.startMatchTimer();
        this.startWatchMatchQueue();
      } else {
        const msg = (res.result && res.result.message) || '加入匹配失败';
        wx.showToast({ title: msg, icon: 'none' });
        // 若已在队列中，继续监听
        if (res.result && res.result.code === 400) {
          this.startMatchTimer();
          this.startWatchMatchQueue();
        } else {
          setTimeout(() => wx.navigateBack(), 1500);
        }
      }
    }).catch((err) => {
      this.setData({ joining: false });
      console.error('加入匹配失败:', err);
      wx.showToast({ title: '网络错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
    });
  },

  // 监听匹配队列文档（替代轮询）
  startWatchMatchQueue: function () {
    const openid = app.globalData.openid;
    if (!openid) return;
    onlineMatch.watchMatchQueue(openid, (err, matchRecord) => {
      if (err) {
        console.error('watch match_queue error', err);
        // 出错后回退到轮询
        this.fallbackPoll();
        return;
      }
      if (!matchRecord) {
        // 队列记录消失（被取消或超时清理）
        if (!this.data.matched) {
          wx.showToast({ title: '匹配已结束', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 1200);
        }
        return;
      }
      if (matchRecord.status === 'matched' && matchRecord.matched_game_id) {
        this.loadMatchedGame(matchRecord.matched_game_id);
      }
    }).then((watcher) => {
      this.data.matchQueueWatcher = watcher;
    }).catch((err) => {
      console.error('startWatchMatchQueue failed', err);
      this.fallbackPoll();
    });
  },

  // 回退轮询（watch 不可用时）
  fallbackPoll: function () {
    if (this.data.matched || this.data._polling) return;
    this.data._polling = true;
    const poll = () => {
      if (this.data.matched) return;
      onlineMatch.getMatchStatus().then((res) => {
        if (res.result && res.result.code === 200 && res.result.data && res.result.data.match) {
          const m = res.result.data.match;
          if (m.status === 'matched' && m.matched_game_id) {
            this.loadMatchedGame(m.matched_game_id);
            return;
          }
        }
        setTimeout(poll, 1500);
      }).catch(() => {
        setTimeout(poll, 1500);
      });
    };
    poll();
  },

  // 加载匹配成功的游戏
  loadMatchedGame: function (gameId) {
    const db = wx.cloud.database();
    db.collection('games').doc(gameId).get().then((res) => {
      if (res.data) {
        this.onMatchSuccess(res.data);
      }
    }).catch((err) => {
      console.error('加载游戏失败', err);
    });
  },

  // 匹配成功
  onMatchSuccess: function (game) {
    this.clearTimers();
    this.closeWatcher();

    const myOpenid = app.globalData.openid;
    const isBlack = game.black_openid === myOpenid;
    const opponentInfo = isBlack ? {
      nickname: game.white_nickname,
      avatar: game.white_avatar,
      rankName: game.white_rank_name || ''
    } : {
      nickname: game.black_nickname,
      avatar: game.black_avatar,
      rankName: game.black_rank_name || ''
    };

    this.setData({
      matched: true,
      myColor: isBlack ? 'black' : 'white',
      opponentInfo,
      gameId: game._id
    });

    this.startCountdown();
  },

  // 等待计时器
  startMatchTimer: function () {
    this.setData({ waitingTime: 0, matchRange: '同段位' });
    this.data.matchTimer = setInterval(() => {
      const t = this.data.waitingTime + 1;
      this.setData({
        waitingTime: t,
        matchRange: getMatchRangeText(t)
      });
    }, 1000);
  },

  // 倒计时
  startCountdown: function () {
    this.setData({ countdown: 3 });
    this.data.countdownTimer = setInterval(() => {
      const n = this.data.countdown - 1;
      if (n <= 0) {
        this.clearTimers();
        this.startGame();
      } else {
        this.setData({ countdown: n });
      }
    }, 1000);
  },

  // 取消匹配
  onCancelMatch: function () {
    wx.showModal({
      title: '提示',
      content: '确定要取消匹配吗？',
      success: (res) => {
        if (res.confirm) {
          this.cancelMatch();
        }
      }
    });
  },

  cancelMatch: function () {
    this.clearTimers();
    this.closeWatcher();
    onlineMatch.cancelMatch().then((res) => {
      if (res.result && res.result.code === 200) {
        wx.showToast({ title: '已取消匹配', icon: 'success' });
      }
      setTimeout(() => wx.navigateBack(), 800);
    }).catch(() => {
      wx.showToast({ title: '取消失败', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1000);
    });
  },

  // 立即开始
  onStartGame: function () {
    this.clearTimers();
    this.startGame();
  },

  startGame: function () {
    if (!this.data.gameId) return;
    wx.redirectTo({
      url: '/pages/game-online/index?gameId=' + this.data.gameId
    });
  },

  closeWatcher: function () {
    if (this.data.matchQueueWatcher) {
      try { this.data.matchQueueWatcher.close(); } catch (e) {}
      this.data.matchQueueWatcher = null;
    }
  },

  clearTimers: function () {
    if (this.data.matchTimer) {
      clearInterval(this.data.matchTimer);
      this.data.matchTimer = null;
    }
    if (this.data.countdownTimer) {
      clearInterval(this.data.countdownTimer);
      this.data.countdownTimer = null;
    }
  }
});
