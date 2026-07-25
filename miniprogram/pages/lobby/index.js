// 联网对战大厅
const app = getApp();
const rank = require('../../utils/rank.js');
const onlineMatch = require('../../utils/online-match.js');
const network = require('../../utils/network.js');

Page({
  data: {
    avatar: '',
    nickname: '',
    rankName: '棋童',
    rankPoints: 0,
    uid: '',
    totalGames: 0,
    wins: 0,
    losses: 0,
    currentStreak: 0,
    matching: false,
    netConnected: true,
    netType: 'unknown'
  },

  unsubscribeNet: null,

  onLoad: function () {
    app.globalData.matchJustCanceled = false;
    this.unsubscribeNet = network.onNetworkChange((status) => {
      this.setData({
        netConnected: status.connected,
        netType: status.type
      });
    });
  },

  onShow: function () {
    this.loadLocalProfile();
    this.syncCloudProfile();
    // 回到大厅默认显示“开始匹配”：上一局/上一次匹配残留的“匹配中”状态不保留
    app.globalData.matchJustCanceled = false;
    this.setData({ matching: false });
    this.checkMatchingStatus();
  },

  onUnload: function () {
    if (this.unsubscribeNet) {
      this.unsubscribeNet();
      this.unsubscribeNet = null;
    }
  },

  // 本地缓存快速展示
  loadLocalProfile: function () {
    const profile = app.getPlayerProfile ? app.getPlayerProfile() : null;
    if (profile) {
      const onlineStats = (profile.stats && profile.stats.online) || {};
      this.setData({
        avatar: profile.avatar || '',
        nickname: profile.nickname || '未设置',
        rankName: rank.getRankName(profile.rankPoints),
        rankPoints: profile.rankPoints || 0,
        uid: profile.uid || '',
        totalGames: onlineStats.total || 0,
        wins: onlineStats.wins || 0,
        losses: onlineStats.losses || 0,
        currentStreak: onlineStats.currentStreak || 0
      });
    }
  },

  // 从云端同步段位/积分（以云端为准）
  syncCloudProfile: function () {
    const openid = app.globalData && app.globalData.openid;
    if (!openid) return;
    onlineMatch.getPlayerStats(openid).then((res) => {
      if (res && res.data && res.data.length > 0) {
        const p = res.data[0];
        this.setData({
          rankName: p.rankName || rank.getRankName(p.rankPoints || 0),
          rankPoints: p.rankPoints || 0,
          totalGames: p.total_games || 0,
          wins: p.wins || 0,
          losses: p.losses || 0,
          currentStreak: p.current_streak || 0
        });
        // 回写本地缓存
        if (app.updateProfileField) {
          app.updateProfileField('rankPoints', p.rankPoints || 0);
          app.updateProfileField('rankName', p.rankName || rank.getRankName(p.rankPoints || 0));
        }
      }
    }).catch((err) => {
      console.error('同步云端档案失败', err);
    });
  },

  // 检查是否已在匹配队列（仅用于恢复“进行中”的对局，不再显示“匹配中”）
  checkMatchingStatus: function () {
    onlineMatch.getMatchStatus().then((res) => {
      if (res.result && res.result.code === 200 && res.result.data && res.result.data.match) {
        const m = res.result.data.match;
        if (m.status === 'matched' && m.matched_game_id) {
          // 仅当对局仍在进行时才自动恢复进入；已结束的对局不重新进入，按钮保持“开始匹配”
          const game = res.result.data.game;
          if (game && game.status === 'playing') {
            this.setData({ matching: false });
            wx.navigateTo({
              url: '/pages/game-online/index?gameId=' + m.matched_game_id
            });
          }
        }
        // 'waiting' 或已结束的 'matched'：按钮保持“开始匹配”，不显示“匹配中”
      }
    }).catch(() => {});
  },

  onProfile: function () {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  onStartMatch: function () {
    if (this.data.matching) return;
    this.setData({ matching: true });
    wx.navigateTo({ url: '/pages/match/index' });
  },

  onViewRecords: function () {
    wx.navigateTo({ url: '/pages/records/index' });
  },

  onBackHome: function () {
    wx.navigateBack({
      fail: () => {
        wx.reLaunch({ url: '/pages/index/index' });
      }
    });
  },

  onCopyUid: function () {
    if (!this.data.uid) return;
    wx.setClipboardData({
      data: this.data.uid,
      success: () => {
        wx.showToast({ title: 'UID已复制', icon: 'success' });
      }
    });
  }
});
