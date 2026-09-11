const app = getApp();
const rank = require('../../utils/rank.js');
const onlineMatch = require('../../utils/online-match.js');

Page({
  data: {
    avatar: '',
    nickname: '',
    uid: '',
    rankName: '棋童',
    rankTier: 'beginner',
    rankColor: '#8B7355',
    rankPoints: 0,
    nextRankPoints: 100,
    progress: 0,
    registerTime: '',
    // 战绩 tab
    statsTab: 'online',
    // 战绩数据
    onlineStats: { total: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0 },
    aiStats: { total: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0 },
    localStats: { total: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0 },
    // 版本号
    version: 'v1.0.0',
    // 升段动画
    showPromotion: false,
    promotionOldRank: '',
    promotionNewRank: '',
    promotionTierIcon: ''
  },

  onLoad: function() {
    this.loadProfile();
  },

  onShow: function() {
    this.loadProfile();
  },

  loadProfile: function() {
    var profile = app.getPlayerProfile();
    if (!profile) return;

    var rankInfo = rank.getRankByPoints(profile.rankPoints);
    var registerDate = '';
    if (profile.registerTime) {
      var d = new Date(profile.registerTime);
      registerDate = d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
    }

    this.setData({
      avatar: profile.avatar || '/images/avatar.png',
      nickname: profile.nickname || '未设置',
      uid: profile.uid || '',
      rankName: rankInfo.name,
      rankTier: rankInfo.tier,
      rankColor: rank.getTierColor(rankInfo.tier),
      rankPoints: profile.rankPoints || 0,
      nextRankPoints: rankInfo.nextRankPoints || rankInfo.points,
      progress: rankInfo.progress,
      registerTime: registerDate,
      onlineStats: profile.stats.online,
      aiStats: profile.stats.ai,
      localStats: profile.stats.local
    });

    // 以云端联网战绩为准，首次进入或返回时刷新（避免本地缓存未计入）
    this.syncOnlineStats();
  },

  // 从云端 players 回填联网对战战绩（仅在云端累计更多局时回填，避免覆盖本地已记录的增量）
  syncOnlineStats: function () {
    const openid = app.globalData && app.globalData.openid;
    if (!openid) return;
    const profile = app.getPlayerProfile();
    const localTotal = (profile && profile.stats && profile.stats.online && profile.stats.online.total) || 0;
    onlineMatch.getPlayerStats(openid).then((res) => {
      if (res && res.data && res.data.length > 0) {
        const p = res.data[0];
        const cloudTotal = p.total_games || 0;
        // 仅当云端累计更多局时，用云端数据回填（历史对局恢复）；否则保留本地记账
        if (cloudTotal > localTotal) {
          const online = {
            total: cloudTotal,
            wins: p.wins || 0,
            losses: p.losses || 0,
            currentStreak: p.current_streak || 0,
            bestStreak: p.best_streak || 0
          };
          app.updateProfileField('stats.online', online);
          this.setData({ onlineStats: online });
        }
      }
    }).catch(() => {});
  },

  onStatsTabTap: function(e) {
    this.setData({ statsTab: e.currentTarget.dataset.tab });
  },

  onEditNickname: function() {
    var that = this;
    wx.showModal({
      title: '修改昵称',
      editable: true,
      placeholderText: '请输入新昵称',
      content: this.data.nickname === '未设置' ? '' : this.data.nickname,
      success: function(res) {
        if (res.confirm && res.content && res.content.trim()) {
          var newName = res.content.trim().substring(0, 12);
          that.setData({ nickname: newName });
          app.updateProfileField('nickname', newName);
          app.globalData.nickname = newName;
          wx.showToast({ title: '昵称已更新', icon: 'success' });
        }
      }
    });
  },

  onEditAvatar: function() {
    var that = this;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: function(res) {
        var tempUrl = res.tempFiles[0].tempFilePath;
        that.setData({ avatar: tempUrl });
        app.updateProfileField('avatar', tempUrl);
        app.globalData.avatar = tempUrl;
        wx.showToast({ title: '头像已更新', icon: 'success' });
      }
    });
  },

  onCopyUID: function() {
    wx.setClipboardData({
      data: this.data.uid,
      success: function() {
        wx.showToast({ title: 'UID已复制', icon: 'success' });
      }
    });
  },

  onClearData: function() {
    wx.showModal({
      title: '清除数据',
      content: '确定要清除所有本地数据吗？此操作不可恢复！',
      confirmColor: '#E74C3C',
      success: function(res) {
        if (res.confirm) {
          wx.showModal({
            title: '二次确认',
            content: '真的要清除所有数据吗？战绩、段位等将全部重置！',
            confirmColor: '#E74C3C',
            success: function(res2) {
              if (res2.confirm) {
                var openid = app.globalData.openid || '';
                var newProfile = rank.createDefaultProfile(openid);
                app.updatePlayerProfile(newProfile);
                wx.showToast({ title: '数据已清除', icon: 'success' });
                // 重新加载页面
                setTimeout(function() {
                  wx.reLaunch({ url: '/pages/index/index' });
                }, 1000);
              }
            }
          });
        }
      }
    });
  },

  onClosePromotion: function() {
    this.setData({ showPromotion: false });
  },

  // 显示升段动画（供外部调用）
  showPromotionAnim: function(oldRank, newRank) {
    var newRankInfo = rank.getRankByPoints(app.globalData.rankPoints);
    var tierIcons = { beginner: '🌱', kyu: '🛡', dan: '💎', master: '👑' };
    this.setData({
      showPromotion: true,
      promotionOldRank: oldRank,
      promotionNewRank: newRank,
      promotionTierIcon: tierIcons[newRankInfo.tier] || '🌱'
    });
  },

  onBack: function() {
    wx.navigateBack();
  }
});
