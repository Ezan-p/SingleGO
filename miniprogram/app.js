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
      this.globalData.hadLocalProfile = true;
      // 同步昵称头像到 globalData
      if (profile.nickname) this.globalData.nickname = profile.nickname;
      if (profile.avatar) this.globalData.avatar = profile.avatar;
    } else {
      // 首次使用（或本地缓存被清空，如删除小程序后重进），创建默认档案
      var openid = wx.getStorageSync('openid') || '';
      profile = rank.createDefaultProfile(openid);
      wx.setStorageSync('playerProfile', profile);
      this.globalData.rankPoints = 0;
      this.globalData.rankName = '棋童';
      this.globalData.uid = profile.uid;
      this.globalData.playerProfile = profile;
      this.globalData.hadLocalProfile = false;
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
        // 把 openid 写回档案并落本地；此处不触发云端备份，
        // 避免“本地被清空”场景下把全零档案覆盖到云端（恢复流程完成后再备份）
        if (that.globalData.playerProfile) {
          that.globalData.playerProfile.openid = res.result.openid;
          try { wx.setStorageSync('playerProfile', that.globalData.playerProfile); } catch (e) {}
        }
        console.log('[dango] 用户openid:', res.result.openid);
        // 拿到 openid 后，把本地昵称/头像同步到云端 players 集合，
        // 使联网对战（匹配/好友）显示的昵称与玩家微信名一致
        that.syncProfileToCloud();
        // 本地档案缺失（如删除小程序后重进）→ 从云端恢复战绩与闯关进度
        if (!that.globalData.hadLocalProfile) {
          that.restoreProfileFromCloud();
        } else {
          // 老用户：把 openid 等可能的变化备份到云端
          that.backupProfileToCloud();
        }
      },
      fail: err => {
        console.error('[dango] 获取openid失败:', err);
        that.globalData.openid = 'test_openid_' + Date.now(); // 测试用
      }
    });
  },

  // 将本地昵称/头像同步到云端 players 集合，使联网对战显示名称与微信名一致
  syncProfileToCloud: function () {
    const profile = this.globalData.playerProfile;
    const nickname = (profile && profile.nickname) || this.globalData.nickname;
    const avatar = (profile && profile.avatar) || this.globalData.avatar;
    if (!this.globalData.openid) return;
    if (!nickname && !avatar) return; // 尚未设置昵称/头像，避免过度覆盖
    const self = this;
    wx.cloud.callFunction({
      name: 'matchSystem',
      data: {
        $url: 'updatePlayer',
        openid: this.globalData.openid,
        nickname: nickname || '',
        avatar: avatar || ''
      },
      fail: function () { /* 忽略同步失败 */ }
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

    // 每次变更都（防抖）备份到云端，避免删除小程序后数据丢失
    this.backupProfileToCloud();
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

    // 每次变更都（防抖）备份到云端，避免删除小程序后数据丢失
    this.backupProfileToCloud();
  },

  // 将本地玩家档案 + 闯关进度防抖备份到云端 players 集合
  // 这样即使删除小程序导致 wx.setStorageSync 被清空，重进时也能从云端恢复
  backupProfileToCloud: function () {
    if (!this.globalData.openid) return;
    // 本地档案尚未从云端恢复完成前（hadLocalProfile=false），不要备份，
    // 否则可能把全零的默认档案覆盖到云端，导致真实数据丢失
    if (!this.globalData.hadLocalProfile) return;
    const self = this;
    if (this._backupTimer) {
      clearTimeout(this._backupTimer);
    }
    this._backupTimer = setTimeout(function () {
      self._backupTimer = null;
      const profile = self.globalData.playerProfile;
      if (!profile) return;
      let challengeProgress = null;
      try {
        challengeProgress = wx.getStorageSync('dango_challenge_progress') || null;
      } catch (e) {
        challengeProgress = null;
      }
      wx.cloud.callFunction({
        name: 'matchSystem',
        data: {
          $url: 'saveProfile',
          openid: self.globalData.openid,
          profile: profile,
          challengeProgress: challengeProgress
        },
        fail: function () { /* 忽略备份失败 */ }
      });
    }, 800);
  },

  // 从云端恢复玩家档案与闯关进度（仅当本地档案缺失时调用，例如删除小程序后重进）
  restoreProfileFromCloud: function () {
    const self = this;
    if (!this.globalData.openid) return;
    wx.cloud.callFunction({
      name: 'matchSystem',
      data: { $url: 'getProfile', openid: this.globalData.openid },
      success: function (res) {
        if (res.result && res.result.code === 200 && res.result.data && res.result.data.profile) {
          const cloudProfile = res.result.data.profile;
          // 用云端档案覆盖默认档案（保留当前 openid）
          cloudProfile.openid = self.globalData.openid;
          // 兜底补齐缺失字段，防止旧版本云端数据缺字段导致页面报错
          if (!cloudProfile.stats) {
            cloudProfile.stats = rank.createDefaultProfile().stats;
          }
          self.updatePlayerProfile(cloudProfile);
          // 恢复闯关进度到本地缓存
          if (res.result.data.challengeProgress) {
            try {
              wx.setStorageSync('dango_challenge_progress', res.result.data.challengeProgress);
            } catch (e) { /* 忽略写入失败 */ }
          }
          // 恢复完成后标记为已激活，使后续对局变更能正常备份到云端
          self.globalData.hadLocalProfile = true;
          console.log('[dango] 已从云端恢复战绩与闯关进度');
        } else {
          // 云端无档案（全新用户）：标记为已激活，允许后续对局触发首次备份
          self.globalData.hadLocalProfile = true;
        }
      },
      fail: function () {
        // 恢复失败（如网络问题）：标记为已激活，避免无限期阻塞备份；
        // 下次真正对局产生变更时会重新备份
        self.globalData.hadLocalProfile = true;
      }
    });
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
    playerProfile: null,
    hadLocalProfile: false
  }
});
