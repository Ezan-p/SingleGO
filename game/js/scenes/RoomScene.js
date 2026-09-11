// js/scenes/RoomScene.js
// 好友对战房间大厅（取代 pages/room）
// 流程与小程序版一致：创建房间（6 位房号，房主执黑）→ 好友输入房号加入（执白）
// → 房主点「开始对局」→ 双方由 watch 推送 status='playing' 进入对局场景。
// 房号输入使用小游戏键盘 API（wx.showKeyboard）替代 WXML 的 <input>。

const BaseScene = require('./BaseScene.js');
const ui = require('../render/ui.js');
const board_ = require('../board.js');
const network = require('../network.js');
const storage = require('../storage.js');

const SIZE_LABELS = ['13×13', '15×15', '19×19'];

function RoomScene(manager) {
  BaseScene.call(this, manager);
}
RoomScene.prototype = Object.create(BaseScene.prototype);
RoomScene.prototype.constructor = RoomScene;

// ===== 生命周期 =====

RoomScene.prototype.onEnter = function (params) {
  const p = params || {};

  this.mode = 'home';          // home | joining | created | joined | ready
  this.sizeIndex = board_.BOARD_SIZES.indexOf(board_.DEFAULT_SIZE);
  if (this.sizeIndex < 0) this.sizeIndex = 1;
  this.roomId = '';
  this.roomDocId = '';
  this.inputRoomId = (p.roomId || '').toUpperCase();
  this.host = null;
  this.guest = null;
  this.busy = false;
  this.errMsg = '';
  this.watcher = null;
  this.keyboardOpen = false;
  this.leaving = false;

  this.nickname = storage.get('nickname', '') || storage.globalData.nickname || '';
  this.avatar = storage.get('avatar', '') || storage.globalData.avatar || '';

  this.buildButtons();

  // 由分享卡片进入：自动加入
  if (p.roomId) this.onJoinConfirm();
};

RoomScene.prototype.onExit = function () {
  this.closeKeyboard();
  this.closeWatcher();
};

RoomScene.prototype.closeWatcher = function () {
  if (this.watcher) {
    try { this.watcher.close(); } catch (e) {}
    this.watcher = null;
  }
};

// ===== 按钮 =====

RoomScene.prototype.buildButtons = function () {
  const vp = this.manager.viewport;
  const self = this;
  this.clearButtons();
  this.addBackButton(vp, function () { self.onLeave(); });

  const pad = 32;
  const w = vp.width - pad * 2;
  const sizeY = vp.top + 176;
  const bw = (w - 20) / 3;

  // 棋盘尺寸（仅 home 模式可见）
  this.sizeBtns = [];
  for (let i = 0; i < 3; i++) {
    const idx = i;
    this.sizeBtns.push(this.addButton({
      x: pad + (bw + 10) * i, y: sizeY, w: bw, h: 42,
      text: SIZE_LABELS[i], radius: 10,
      onTap: function () { self.sizeIndex = idx; }
    }));
  }

  const baseY = sizeY + 70;
  this.createBtn = this.addButton({
    x: pad, y: baseY, w: w, h: 50, text: '创建房间',
    bg: ui.COLORS.primary, radius: 14,
    onTap: function () { self.onCreateRoom(); }
  });
  this.joinBtn = this.addButton({
    x: pad, y: baseY + 62, w: w, h: 50, text: '加入房间',
    bg: ui.COLORS.primaryDeep, radius: 14,
    onTap: function () { self.onShowJoin(); }
  });

  // joining 模式
  this.inputBtn = this.addButton({
    x: pad, y: sizeY + 8, w: w, h: 54, text: '',
    bg: '#FFFFFF', color: ui.COLORS.text, border: ui.COLORS.panelBorder, radius: 12,
    hidden: true,
    onTap: function () { self.openKeyboard(); }
  });
  this.joinConfirmBtn = this.addButton({
    x: pad, y: sizeY + 82, w: w, h: 50, text: '确认加入',
    bg: ui.COLORS.success, radius: 14, hidden: true,
    onTap: function () { self.onJoinConfirm(); }
  });
  this.joinCancelBtn = this.addButton({
    x: pad, y: sizeY + 144, w: w, h: 46, text: '取消',
    bg: '#FFFFFF', color: ui.COLORS.text, border: ui.COLORS.panelBorder, radius: 14,
    hidden: true,
    onTap: function () { self.onCancelJoin(); }
  });

  // 房间内
  const roomY = vp.height - vp.bottom - 180;
  this.startBtn = this.addButton({
    x: pad, y: roomY, w: w, h: 50, text: '开始对局',
    bg: ui.COLORS.success, radius: 14, hidden: true,
    onTap: function () { self.onStartGame(); }
  });
  this.inviteBtn = this.addButton({
    x: pad, y: roomY + 62, w: w, h: 46, text: '邀请好友',
    bg: ui.COLORS.info, radius: 14, hidden: true,
    onTap: function () { self.onInvite(); }
  });
  this.leaveBtn = this.addButton({
    x: pad, y: roomY + 118, w: w, h: 46, text: '离开房间',
    bg: '#FFFFFF', color: ui.COLORS.danger, border: ui.COLORS.panelBorder, radius: 14,
    hidden: true,
    onTap: function () { self.onLeave(); }
  });

  this.syncButtonVisibility();
};

RoomScene.prototype.syncButtonVisibility = function () {
  const home = this.mode === 'home';
  const joining = this.mode === 'joining';
  const inRoom = this.mode === 'created' || this.mode === 'joined' || this.mode === 'ready';

  for (let i = 0; i < this.sizeBtns.length; i++) {
    this.sizeBtns[i].hidden = !home;
    this.sizeBtns[i].bg = (i === this.sizeIndex) ? ui.COLORS.primary : '#FFFFFF';
    this.sizeBtns[i].color = (i === this.sizeIndex) ? '#FFFFFF' : ui.COLORS.text;
    this.sizeBtns[i].border = (i === this.sizeIndex) ? null : ui.COLORS.panelBorder;
  }
  this.createBtn.hidden = !home;
  this.joinBtn.hidden = !home;
  this.createBtn.disabled = this.busy;
  this.joinBtn.disabled = this.busy;

  this.inputBtn.hidden = !joining;
  this.inputBtn.text = this.inputRoomId || '点击输入 6 位房号';
  this.inputBtn.color = this.inputRoomId ? ui.COLORS.text : ui.COLORS.textSub;
  this.joinConfirmBtn.hidden = !joining;
  this.joinConfirmBtn.disabled = this.busy;
  this.joinCancelBtn.hidden = !joining;

  this.startBtn.hidden = !(this.mode === 'ready');
  this.startBtn.disabled = this.busy || !this.guest;
  this.inviteBtn.hidden = !(this.mode === 'created' || this.mode === 'ready');
  this.leaveBtn.hidden = !inRoom;
};

// ===== 昵称头像 =====
// 昵称头像由「我的资料」页通过 wx.createUserInfoButton 授权后写入本地存储，
// 此处不再调用已废弃的 wx.getUserProfile（只会返回匿名数据）。未授权则使用兜底昵称。
RoomScene.prototype.ensureProfile = function () {
  const self = this;
  return new Promise(function (resolve) {
    if (self.nickname) {
      resolve({ nickname: self.nickname, avatar: self.avatar });
      return;
    }
    const fallback = '棋手' + Math.floor(Math.random() * 90 + 10);
    self.nickname = fallback;
    self.avatar = '';
    resolve({ nickname: fallback, avatar: '' });
  });
};

// ===== 房号输入（小游戏键盘） =====

RoomScene.prototype.openKeyboard = function () {
  if (this.keyboardOpen || typeof wx.showKeyboard !== 'function') return;
  const self = this;
  this.keyboardOpen = true;

  this._kbInput = function (res) {
    self.inputRoomId = String(res.value || '').toUpperCase().trim().slice(0, 6);
  };
  this._kbConfirm = function (res) {
    self.inputRoomId = String(res.value || '').toUpperCase().trim().slice(0, 6);
    self.closeKeyboard();
    self.onJoinConfirm();
  };
  this._kbComplete = function () { self.closeKeyboard(); };

  wx.onKeyboardInput(this._kbInput);
  wx.onKeyboardConfirm(this._kbConfirm);
  wx.onKeyboardComplete(this._kbComplete);
  wx.showKeyboard({
    defaultValue: this.inputRoomId,
    maxLength: 6,
    multiple: false,
    confirmHold: false,
    confirmType: 'done'
  });
};

RoomScene.prototype.closeKeyboard = function () {
  if (!this.keyboardOpen) return;
  this.keyboardOpen = false;
  try { wx.hideKeyboard({}); } catch (e) {}
  try {
    if (this._kbInput) wx.offKeyboardInput(this._kbInput);
    if (this._kbConfirm) wx.offKeyboardConfirm(this._kbConfirm);
    if (this._kbComplete) wx.offKeyboardComplete(this._kbComplete);
  } catch (e) {}
  this._kbInput = null;
  this._kbConfirm = null;
  this._kbComplete = null;
};

// ===== 创建房间 =====

RoomScene.prototype.onCreateRoom = function () {
  if (this.busy) return;
  const self = this;
  this.busy = true;
  this.errMsg = '';
  const boardSize = board_.BOARD_SIZES[this.sizeIndex];

  this.ensureProfile().then(function (profile) {
    return network.createRoom({
      boardSize: boardSize,
      nickname: profile.nickname,
      avatar: profile.avatar
    });
  }).then(function (room) {
    self.mode = 'created';
    self.roomId = room.roomId;
    self.roomDocId = room._id;
    self.host = room.host;
    self.guest = null;
    self.busy = false;
    self.startWatch(room._id);
  }).catch(function (err) {
    self.busy = false;
    self.errMsg = (err && err.message) ? err.message : '创建房间失败';
  });
};

// ===== 加入房间 =====

RoomScene.prototype.onShowJoin = function () {
  this.mode = 'joining';
  this.errMsg = '';
};

RoomScene.prototype.onCancelJoin = function () {
  this.closeKeyboard();
  this.mode = 'home';
  this.errMsg = '';
};

RoomScene.prototype.onJoinConfirm = function () {
  if (this.busy) return;
  const roomId = this.inputRoomId;
  if (!roomId || roomId.length !== 6) {
    this.mode = 'joining';
    this.errMsg = '请输入 6 位房号';
    return;
  }
  const self = this;
  this.busy = true;
  this.errMsg = '';

  this.ensureProfile().then(function (profile) {
    return network.joinRoom({
      roomId: roomId,
      nickname: profile.nickname,
      avatar: profile.avatar
    });
  }).then(function () {
    return network.getRoomByRoomId(roomId);
  }).then(function (room) {
    if (!room) throw new Error('房间不存在');
    self.mode = 'joined';
    self.roomId = room.roomId;
    self.roomDocId = room._id;
    self.host = room.host;
    self.guest = room.guest;
    self.busy = false;
    self.startWatch(room._id);
  }).catch(function (err) {
    self.busy = false;
    self.mode = 'joining';
    self.errMsg = (err && err.message) ? err.message : '加入房间失败';
  });
};

// ===== 房主开局 =====

RoomScene.prototype.onStartGame = function () {
  if (this.busy) return;
  if (!this.guest) {
    this.errMsg = '对手尚未加入';
    return;
  }
  const self = this;
  this.busy = true;
  this.errMsg = '';
  // 成功后由 watch 推送 status='playing' 触发进入对局
  network.startGame(this.roomDocId).catch(function (err) {
    self.busy = false;
    self.errMsg = (err && err.message) ? err.message : '开始对局失败';
  });
};

// ===== 邀请 =====

RoomScene.prototype.onInvite = function () {
  if (typeof wx.shareAppMessage === 'function') {
    wx.shareAppMessage({
      title: '单围棋·好友对战 ' + this.roomId + ' 邀你对局',
      query: 'roomId=' + this.roomId
    });
    return;
  }
  wx.setClipboardData({ data: this.roomId });
};

// ===== 离开 =====

RoomScene.prototype.onLeave = function () {
  const self = this;
  this.closeKeyboard();
  this.closeWatcher();
  this.leaving = true;

  if (!this.roomDocId) {
    this.manager.pop();
    return;
  }
  const myOpenid = storage.globalData.openid;
  const role = (this.host && this.host.openid === myOpenid) ? 'host' : 'guest';
  network.leaveRoom(this.roomDocId, role).then(function () {
    self.manager.pop();
  }).catch(function () {
    self.manager.pop();
  });
};

// ===== 实时订阅 =====

RoomScene.prototype.startWatch = function (roomDocId) {
  const self = this;
  this.closeWatcher();
  this.watcher = network.subscribeRoom(roomDocId, function (room, err) {
    if (err) {
      // 房间被删除（房主解散）
      if (self.mode !== 'home' && !self.leaving) {
        wx.showModal({
          title: '提示',
          content: '房间已解散',
          showCancel: false,
          confirmText: '返回',
          success: function () { self.manager.pop(); }
        });
      }
      return;
    }
    self.applyRoom(room);
  });
};

RoomScene.prototype.applyRoom = function (room) {
  if (!room) return;
  this.host = room.host;
  this.guest = room.guest;
  this.roomId = room.roomId;

  // 双方就绪：房主显示「开始对局」
  if (room.guest && this.mode === 'created') this.mode = 'ready';

  // status=playing：双方进入对局场景
  if (room.status === 'playing') {
    this.closeWatcher();
    this.leaving = true;
    // replace 语义：房间页出栈，进入对局页
    this.manager.stack.pop();
    this.manager.push('room-game', { docId: room._id });
    return;
  }

  // 已结束（对手离开等）
  if (room.status === 'ended' && this.mode !== 'home') {
    const self = this;
    this.closeWatcher();
    wx.showModal({
      title: '对局已结束',
      content: room.winReason || '已结束',
      showCancel: false,
      confirmText: '返回',
      success: function () { self.manager.pop(); }
    });
  }
};

// ===== 渲染 =====

RoomScene.prototype.update = function () {
  this.syncButtonVisibility();
};

RoomScene.prototype.render = function (ctx, vp) {
  this.drawBackground(ctx, vp);
  ui.drawText(ctx, '好友对战', vp.width / 2, vp.top + 22, {
    size: 18, bold: true, align: 'center'
  });

  if (this.mode === 'home') this.renderHome(ctx, vp);
  else if (this.mode === 'joining') this.renderJoining(ctx, vp);
  else this.renderRoom(ctx, vp);

  this.drawButtons(ctx);

  if (this.errMsg) {
    ui.drawText(ctx, this.errMsg, vp.width / 2, vp.height - vp.bottom - 34, {
      size: 13, align: 'center', color: ui.COLORS.danger
    });
  }
  if (this.busy) {
    ui.drawText(ctx, '处理中…', vp.width / 2, vp.height - vp.bottom - 56, {
      size: 12, align: 'center', color: ui.COLORS.textSub
    });
  }
};

RoomScene.prototype.renderHome = function (ctx, vp) {
  ui.drawText(ctx, '创建房间后把 6 位房号发给好友', vp.width / 2, vp.top + 78, {
    size: 14, align: 'center', color: ui.COLORS.textSub
  });
  ui.drawText(ctx, '房主执黑先行，好友执白', vp.width / 2, vp.top + 102, {
    size: 12, align: 'center', color: ui.COLORS.textSub
  });
  ui.drawText(ctx, '棋盘尺寸', 32, vp.top + 152, { size: 13, bold: true });
};

RoomScene.prototype.renderJoining = function (ctx, vp) {
  ui.drawText(ctx, '输入好友的 6 位房号', vp.width / 2, vp.top + 110, {
    size: 15, align: 'center', bold: true
  });
  ui.drawText(ctx, '房号由字母与数字组成，不区分大小写', vp.width / 2, vp.top + 138, {
    size: 12, align: 'center', color: ui.COLORS.textSub
  });
};

RoomScene.prototype.renderRoom = function (ctx, vp) {
  const y = vp.top + 76;

  // 房号
  ui.drawPanel(ctx, 32, y, vp.width - 64, 92, 14);
  ui.drawText(ctx, '房间号', vp.width / 2, y + 26, {
    size: 12, align: 'center', color: ui.COLORS.textSub
  });
  ui.drawText(ctx, this.roomId || '------', vp.width / 2, y + 60, {
    size: 30, align: 'center', bold: true, color: ui.COLORS.primaryDeep
  });

  // 双方
  const py = y + 116;
  this.drawSeat(ctx, vp, py, '房主（黑）', this.host, true);
  this.drawSeat(ctx, vp, py + 74, '好友（白）', this.guest, false);

  let tip;
  if (this.mode === 'joined') tip = '已加入，等待房主开始对局…';
  else if (this.mode === 'ready') tip = '好友已就位，点击「开始对局」';
  else tip = '等待好友加入…';
  ui.drawText(ctx, tip, vp.width / 2, py + 170, {
    size: 13, align: 'center', color: ui.COLORS.textSub
  });
};

RoomScene.prototype.drawSeat = function (ctx, vp, y, label, seat, isBlack) {
  ui.drawPanel(ctx, 32, y, vp.width - 64, 62, 12);
  ui.fillCircle(ctx, 60, y + 31, 13, isBlack ? '#1a1a1a' : '#f5f5f5');
  if (!isBlack) {
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(60, y + 31, 13, 0, Math.PI * 2);
    ctx.stroke();
  }
  ui.drawText(ctx, label, 84, y + 22, { size: 12, color: ui.COLORS.textSub });
  ui.drawText(ctx, (seat && seat.nickname) || '等待中…', 84, y + 42, {
    size: 15, bold: true, color: seat ? ui.COLORS.text : ui.COLORS.textSub
  });
};

module.exports = function (manager) { return new RoomScene(manager); };
