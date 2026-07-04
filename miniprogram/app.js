// app.js
const { envId } = require('./envList.js');

App({
  onLaunch: function () {
    // 单围棋单机模式无需云开发；好友连线对局需要 wx.cloud 初始化
    if (wx.cloud && envId) {
      wx.cloud.init({ env: envId, traceUser: true });
      this.cloudInited = true;
    } else {
      console.warn('[dango] wx.cloud 未初始化：envList.envId 为空，好友对战不可用');
      this.cloudInited = false;
    }
  },

  globalData: {
    openid: null,
    nickname: '',
    avatar: ''
  }
});
