Page({
  data: {},
  onStartGame() {
    wx.navigateTo({ url: '/pages/game/game' })
  },
  onFriendBattle() {
    wx.navigateTo({ url: '/pages/room/room' })
  }
})
