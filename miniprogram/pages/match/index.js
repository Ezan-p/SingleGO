// 匹配页面
const app = getApp();
const rank = require('../../utils/rank.js');

Page({
  data: {
    matched: false,           // 是否匹配成功
    waitingTime: 0,           // 等待时间（秒）
    opponentInfo: null,       // 对手信息
    myColor: 'black',         // 我的棋子颜色
    countdown: 3,             // 倒计时
    stats: null,              // 匹配统计
    matchId: null,            // 匹配记录ID
    gameId: null,             // 游戏ID
    matchTimer: null,         // 等待计时器
    countdownTimer: null,     // 倒计时计时器
    myRankName: ''            // 我的段位
  },

  onLoad: function(options) {
    this.setData({ myRankName: rank.getRankName(app.globalData.rankPoints) });
    this.startMatch();
  },

  onUnload: function() {
    // 清理计时器
    this.clearTimers();
    
    // 如果页面关闭时仍在匹配中，取消匹配
    if (!this.data.matched && this.data.matchId) {
      this.cancelMatch();
    }
  },

  // 开始匹配
  startMatch: function() {
    wx.showLoading({ title: '加入匹配队列...' });
    
    // 调用云函数加入匹配队列
    wx.cloud.callFunction({
      name: 'matchSystem',
      data: {}
    }).then(res => {
      wx.hideLoading();
      
      if (res.result.code === 200) {
        this.setData({
          matchId: res.result.data._id
        });
        
        // 开始等待计时器
        this.startMatchTimer();
        
        // 开始轮询匹配状态
        this.pollMatchStatus();
        
        wx.showToast({ title: '已加入匹配队列', icon: 'success' });
      } else {
        wx.showToast({ title: res.result.message || '加入匹配失败', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 1500);
      }
    }).catch(err => {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
      console.error('加入匹配失败:', err);
    });
  },

  // 开始匹配计时器
  startMatchTimer: function() {
    this.setData({ waitingTime: 0 });
    
    this.data.matchTimer = setInterval(() => {
      this.setData({
        waitingTime: this.data.waitingTime + 1
      });
      
      // 每10秒更新一次统计
      if (this.data.waitingTime % 10 === 0) {
        this.updateMatchStats();
      }
    }, 1000);
  },

  // 轮询匹配状态
  pollMatchStatus: function() {
    if (this.data.matched || !this.data.matchId) return;
    
    wx.cloud.callFunction({
      name: 'matchSystem',
      data: {
        $url: 'getMatchStatus'
      }
    }).then(res => {
      if (res.result.code === 200) {
        const data = res.result.data;
        
        if (data.game) {
          // 匹配成功
          this.onMatchSuccess(data.match, data.game);
        } else {
          // 仍在匹配中，1秒后继续轮询
          setTimeout(() => this.pollMatchStatus(), 1000);
        }
      } else {
        // 匹配失败或已取消
        if (res.result.code === 404) {
          wx.showToast({ title: '匹配已取消', icon: 'none' });
          setTimeout(() => wx.navigateBack(), 1500);
        } else {
          // 1秒后重试
          setTimeout(() => this.pollMatchStatus(), 1000);
        }
      }
    }).catch(err => {
      console.error('轮询匹配状态失败:', err);
      // 1秒后重试
      setTimeout(() => this.pollMatchStatus(), 1000);
    });
  },

  // 匹配成功
  onMatchSuccess: function(matchRecord, game) {
    this.clearTimers();
    
    // 确定我的棋子颜色
    const myOpenid = app.globalData.openid;
    const isBlack = game.black_openid === myOpenid;
    
    // 获取对手信息
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
      opponentInfo: opponentInfo,
      gameId: game._id
    });
    
    // 开始倒计时
    this.startCountdown();
  },

  // 开始倒计时
  startCountdown: function() {
    this.setData({ countdown: 3 });
    
    this.data.countdownTimer = setInterval(() => {
      const newCountdown = this.data.countdown - 1;
      
      if (newCountdown <= 0) {
        this.clearTimers();
        this.startGame();
      } else {
        this.setData({ countdown: newCountdown });
      }
    }, 1000);
  },

  // 取消匹配
  onCancelMatch: function() {
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

  // 取消匹配
  cancelMatch: function() {
    this.clearTimers();
    
    wx.showLoading({ title: '取消中...' });
    
    wx.cloud.callFunction({
      name: 'matchSystem',
      data: {
        $url: 'cancelMatch'
      }
    }).then(res => {
      wx.hideLoading();
      
      if (res.result.code === 200) {
        wx.showToast({ title: '已取消匹配', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 1000);
      } else {
        wx.showToast({ title: res.result.message || '取消匹配失败', icon: 'none' });
      }
    }).catch(err => {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
      console.error('取消匹配失败:', err);
    });
  },

  // 立即开始游戏
  onStartGame: function() {
    this.clearTimers();
    this.startGame();
  },

  // 开始游戏
  startGame: function() {
    if (!this.data.gameId) return;
    
    // 跳转到游戏页面
    wx.redirectTo({
      url: `/pages/game-online/index?gameId=${this.data.gameId}`
    });
  },

  // 更新匹配统计
  updateMatchStats: function() {
    // 这里可以调用云函数获取实时统计信息
    // 暂时使用模拟数据
    this.setData({
      stats: {
        totalWaiting: Math.floor(Math.random() * 10) + 1,
        avgWaitTime: Math.floor(Math.random() * 30) + 10,
        matchSuccessRate: 95
      }
    });
  },

  // 清理计时器
  clearTimers: function() {
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