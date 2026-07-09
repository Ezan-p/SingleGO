const app = getApp();
const rank = require('../../utils/rank.js');

Page({
  data: {
    avatar: '',
    nickname: '',
    rankName: '棋童'
  },

  onShow: function() {
    var profile = app.getPlayerProfile();
    if (profile) {
      this.setData({
        avatar: profile.avatar || '/images/avatar.png',
        nickname: profile.nickname || '未设置',
        rankName: rank.getRankName(profile.rankPoints)
      });
    }
  },

  onProfile: function() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  },

  onStartGame() {
    wx.navigateTo({ url: '/pages/game/game' })
  },
  onFriendBattle() {
    wx.navigateTo({ url: '/pages/room/room' })
  },
  onOnlineBattle() {
    wx.navigateTo({ url: '/pages/match/index' })
  },
  onAIBattle() {
    wx.navigateTo({ url: '/pages/ai-setup/ai-setup' })
  },
  onRules() {
    wx.navigateTo({ url: '/pages/rules/rules' })
  },
  onSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' })
  }
})
