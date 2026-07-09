Page({
  data: {
    sizeOptions: ['13×13', '15×15', '19×19'],
    sizeIndex: 1,
    soundOn: true,
    vibrateOn: true
  },

  onLoad: function () {
    const settings = wx.getStorageSync('settings') || {};
    const boardSize = settings.boardSize || 15;
    const sizeIndex = [13, 15, 19].indexOf(boardSize);
    this.setData({
      sizeIndex: sizeIndex === -1 ? 1 : sizeIndex,
      soundOn: settings.sound !== false,
      vibrateOn: settings.vibrate !== false
    });
  },

  onSizeChange: function (e) {
    const index = parseInt(e.detail.value, 10);
    this.setData({ sizeIndex: index });
    this.save();
  },

  onToggleSound: function (e) {
    this.setData({ soundOn: e.detail.value });
    this.save();
  },

  onToggleVibrate: function (e) {
    this.setData({ vibrateOn: e.detail.value });
    this.save();
    if (e.detail.value) {
      wx.vibrateShort({ type: 'light' });
    }
  },

  save: function () {
    const boardSize = [13, 15, 19][this.data.sizeIndex];
    wx.setStorageSync('settings', {
      boardSize: boardSize,
      sound: this.data.soundOn,
      vibrate: this.data.vibrateOn
    });
  },

  onBack: function () {
    wx.navigateBack();
  }
});
