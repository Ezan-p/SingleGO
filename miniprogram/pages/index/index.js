Page({
  data: {},
  onStartGame() {
    wx.navigateTo({ url: '/pages/game/game' })
  },
  onFriendBattle() {
    wx.navigateTo({ url: '/pages/room/room' })
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
