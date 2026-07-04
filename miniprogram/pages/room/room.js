// 房间大厅页
const online = require('../../utils/online.js');
const dango = require('../../utils/dango.js');

Page({
  data: {
    mode: 'home',        // home | created | joining | joined | ready
    boardSize: dango.DEFAULT_SIZE,
    sizeOptions: ['13×13', '15×15', '19×19'],
    sizeIndex: 1,
    roomId: '',          // 6 位房号
    roomDocId: '',       // _id
    inputRoomId: '',     // 加入房号输入
    nickname: '',
    avatar: '',
    host: null,
    guest: null,
    busy: false,
    errMsg: ''
  },

  onLoad: function (options) {
    wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
    const cachedNick = wx.getStorageSync('nickname');
    const cachedAvatar = wx.getStorageSync('avatar');
    if (cachedNick) this.data.nickname = cachedNick;
    if (cachedAvatar) this.data.avatar = cachedAvatar;
    // 来自分享卡：自动加入
    if (options && options.roomId) {
      this.setData({ inputRoomId: options.roomId });
      this.onJoinConfirm();
    }
  },

  onUnload: function () {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  },

  onSizeChange: function (e) {
    this.setData({ sizeIndex: parseInt(e.detail.value, 10) });
  },

  onInputRoomId: function (e) {
    this.setData({ inputRoomId: (e.detail.value || '').toUpperCase().trim() });
  },

  // 请求昵称头像授权（拒绝则用兜底昵称）
  ensureProfile: function () {
    const self = this;
    return new Promise(function (resolve) {
      if (self.data.nickname) {
        resolve({ nickname: self.data.nickname, avatar: self.data.avatar });
        return;
      }
      wx.getUserProfile({
        desc: '用于好友对战展示',
        success: function (res) {
          const userInfo = res.userInfo || {};
          const nickname = userInfo.nickName || '棋手';
          const avatar = userInfo.avatarUrl || '';
          self.setData({ nickname: nickname, avatar: avatar });
          wx.setStorageSync('nickname', nickname);
          wx.setStorageSync('avatar', avatar);
          resolve({ nickname: nickname, avatar: avatar });
        },
        fail: function () {
          // 拒绝授权：使用兜底
          const nickname = '棋手' + Math.floor(Math.random() * 90 + 10);
          self.setData({ nickname: nickname, avatar: '' });
          resolve({ nickname: nickname, avatar: '' });
        }
      });
    });
  },

  // ====== 创建房间 ======
  onCreateRoom: function () {
    if (this.data.busy) return;
    const self = this;
    this.setData({ busy: true, errMsg: '' });
    const boardSize = dango.BOARD_SIZES[this.data.sizeIndex];
    this.ensureProfile().then(function (profile) {
      return online.createRoom({ boardSize: boardSize, nickname: profile.nickname, avatar: profile.avatar });
    }).then(function (room) {
      self.setData({
        mode: 'created',
        roomId: room.roomId,
        roomDocId: room._id,
        host: room.host,
        guest: null,
        busy: false
      });
      self.startWatch(room._id);
    }).catch(function (err) {
      self.setData({ busy: false, errMsg: err && err.message ? err.message : '创建房间失败' });
    });
  },

  // ====== 加入房间 ======
  onShowJoin: function () {
    this.setData({ mode: 'joining', inputRoomId: this.data.inputRoomId, errMsg: '' });
  },

  onCancelJoin: function () {
    this.setData({ mode: 'home', errMsg: '' });
  },

  onJoinConfirm: function () {
    if (this.data.busy) return;
    const roomId = this.data.inputRoomId;
    if (!roomId || roomId.length !== 6) {
      this.setData({ errMsg: '请输入 6 位房号' });
      return;
    }
    const self = this;
    this.setData({ busy: true, errMsg: '' });
    this.ensureProfile().then(function (profile) {
      return online.joinRoom({ roomId: roomId, nickname: profile.nickname, avatar: profile.avatar });
    }).then(function (roomDocId) {
      return online.getRoomByRoomId(roomId).then(function (room) {
        return { roomDocId: roomDocId, room: room };
      });
    }).then(function (res) {
      self.setData({
        mode: 'joined',
        roomId: res.room.roomId,
        roomDocId: res.room._id,
        host: res.room.host,
        guest: res.room.guest,
        busy: false
      });
      self.startWatch(res.room._id);
    }).catch(function (err) {
      self.setData({ busy: false, errMsg: err && err.message ? err.message : '加入房间失败' });
    });
  },

  // ====== 房主开始对局 ======
  onStartGame: function () {
    if (this.data.busy) return;
    if (!this.data.guest) {
      this.setData({ errMsg: '对手尚未加入' });
      return;
    }
    const self = this;
    this.setData({ busy: true, errMsg: '' });
    online.startGame(this.data.roomDocId).catch(function (err) {
      self.setData({ busy: false, errMsg: err && err.message ? err.message : '开始对局失败' });
    });
    // 成功后由 watch 推送 status='playing'，触发跳转
  },

  // ====== 离开 ======
  onLeave: function () {
    const self = this;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (!this.data.roomDocId) {
      wx.navigateBack();
      return;
    }
    const role = this.data.host && this.data.host.openid === getApp().globalData.openid ? 'host' : 'guest';
    online.leaveRoom(this.data.roomDocId, role).then(function () {
      wx.navigateBack();
    }).catch(function () {
      wx.navigateBack();
    });
  },

  // ====== 实时订阅 ======
  startWatch: function (roomDocId) {
    const self = this;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.watcher = online.subscribeRoom(roomDocId, function (room, err) {
      if (err) {
        // 房间被删除（房主解散）
        if (self.data.mode !== 'home') {
          wx.showModal({
            title: '提示',
            content: '房间已解散',
            showCancel: false,
            confirmText: '返回',
            success: function () {
              wx.navigateBack();
            }
          });
        }
        return;
      }
      self.applyRoom(room);
    });
  },

  applyRoom: function (room) {
    const isHost = room.host && room.host.openid === getApp().globalData.openid;
    this.setData({
      host: room.host,
      guest: room.guest,
      roomId: room.roomId
    });
    // 双方就绪：房主显示「开始对局」
    if (room.guest && this.data.mode === 'created') {
      this.setData({ mode: 'ready' });
    }
    // status=playing：双方跳转到对局页
    if (room.status === 'playing') {
      if (this.watcher) {
        this.watcher.close();
        this.watcher = null;
      }
      wx.redirectTo({ url: '/pages/online/online?docId=' + room._id });
    }
    // 已结束（对手离开等）
    if (room.status === 'ended' && this.data.mode !== 'home') {
      wx.showModal({
        title: '对局已结束',
        content: room.winReason || '已结束',
        showCancel: false,
        confirmText: '返回',
        success: function () {
          wx.navigateBack();
        }
      });
    }
  },

  onShareAppMessage: function () {
    return {
      title: '单围棋·好友对战 ' + this.data.roomId + ' 邀你对局',
      path: '/pages/room/room?roomId=' + this.data.roomId
    };
  },

  onShareTimeline: function () {
    return {
      title: '单围棋·好友对战 邀你对局',
      query: 'roomId=' + this.data.roomId
    };
  }
});
