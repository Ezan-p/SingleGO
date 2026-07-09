// app.js
const { envId } = require('./envList.js');
const rank = require('./utils/rank.js');

App({
  onLaunch: function () {
    // 初始化云开发
    if (wx.cloud && envId) {
      wx.cloud.init({ env: envId, traceUser: true });
      this.cloudInited = true;
      this.initPlayerProfile();
      this.initUserInfo();
    } else {
      console.warn('[dango] wx.cloud 未初始化：envList.envId 为空，联网对战不可用');
      this.cloudInited = false;
      this.initPlayerProfile();
    }
  },

  // 初始化玩家档案（段位、战绩等）
  initPlayerProfile: function() {
    var profile = wx.getStorageSync('playerProfile');
    if (profile && profile.version === 1) {
      // 从本地缓存恢复
      this.globalData.rankPoints = profile.rankPoints || 0;
      this.globalData.rankName = profile.rankName || rank.getRankName(profile.rankPoints);
      this.globalData.uid = profile.uid || '';
      this.globalData.playerProfile = profile;
      // 同步昵称头像到 globalData
      if (profile.nickname) this.globalData.nickname = profile.nickname;
      if (profile.avatar) this.globalData.avatar = profile.avatar;
    } else {
      // 首次使用，创建默认档案
      var openid = wx.getStorageSync('openid') || '';
      profile = rank.createDefaultProfile(openid);
      wx.setStorageSync('playerProfile', profile);
      this.globalData.rankPoints = 0;
      this.globalData.rankName = '棋童';
      this.globalData.uid = profile.uid;
      this.globalData.playerProfile = profile;
    }
  },

  // 初始化用户信息
  initUserInfo: function() {
    const that = this;

    // 获取用户信息
    wx.getSetting({
      success: res => {
        if (res.authSetting['scope.userInfo']) {
          // 已经授权，可以直接调用 getUserInfo 获取头像昵称
          wx.getUserInfo({
            success: res => {
              const userInfo = res.userInfo;
              that.globalData.nickname = userInfo.nickName;
              that.globalData.avatar = userInfo.avatarUrl;
              that.updateProfileField('nickname', userInfo.nickName);
              that.updateProfileField('avatar', userInfo.avatarUrl);

              // 获取openid
              that.getOpenId();
            }
          });
        } else {
          // 未授权，先获取openid，用户信息在需要时再获取
          that.getOpenId();
        }
      }
    });
  },

  // 获取用户openid
  getOpenId: function() {
    const that = this;

    wx.cloud.callFunction({
      name: 'getOpenId',
      success: res => {
        that.globalData.openid = res.result.openid;
        that.updateProfileField('openid', res.result.openid);
        console.log('[dango] 用户openid:', res.result.openid);
      },
      fail: err => {
        console.error('[dango] 获取openid失败:', err);
        that.globalData.openid = 'test_openid_' + Date.now(); // 测试用
      }
    });
  },

  // 更新玩家信息（在联网对战中调用）
  updatePlayerInfo: function(userInfo) {
    if (userInfo) {
      this.globalData.nickname = userInfo.nickName || userInfo.nickname;
      this.globalData.avatar = userInfo.avatarUrl || userInfo.avatar;
      this.updateProfileField('nickname', this.globalData.nickname);
      this.updateProfileField('avatar', this.globalData.avatar);
    }
  },

  // 更新玩家档案单个字段并持久化
  updateProfileField: function(field, value) {
    var profile = this.globalData.playerProfile;
    if (!profile) return;
    if (field.indexOf('.') > -1) {
      // 支持 'stats.online.wins' 形式
      var parts = field.split('.');
      var obj = profile;
      for (var i = 0; i < parts.length - 1; i++) {
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
    } else {
      profile[field] = value;
    }
    wx.setStorageSync('playerProfile', profile);

    // 同步关键字段到 globalData
    if (field === 'rankPoints') this.globalData.rankPoints = value;
    if (field === 'rankName') this.globalData.rankName = value;
  },

  // 更新完整玩家档案
  updatePlayerProfile: function(profile) {
    this.globalData.playerProfile = profile;
    this.globalData.rankPoints = profile.rankPoints || 0;
    this.globalData.rankName = profile.rankName || rank.getRankName(profile.rankPoints);
    this.globalData.uid = profile.uid || '';
    if (profile.nickname) this.globalData.nickname = profile.nickname;
    if (profile.avatar) this.globalData.avatar = profile.avatar;
    wx.setStorageSync('playerProfile', profile);
  },

  // 获取当前玩家档案
  getPlayerProfile: function() {
    return this.globalData.playerProfile;
  },

  globalData: {
    openid: null,
    nickname: '',
    avatar: '',
    cloudInited: false,
    rankPoints: 0,
    rankName: '棋童',
    uid: '',
    playerProfile: null
  }
});
