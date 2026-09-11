// js/scenes/LoginScene.js
// 微信授权登录（首次启动强制）。
// 小游戏无 WXML：授权用 wx.createUserInfoButton（屏幕坐标覆盖层）。
// 重要：新版微信要求先同意「隐私协议」(wx.requirePrivacyAuthorize)，
// 否则 createUserInfoButton 的回调会失败（拿不到 userInfo），导致一直提示需要授权。

const BaseScene = require('./BaseScene.js');
const ui = require('../render/ui.js');
const storage = require('../storage.js');
const network = require('../network.js');
const avatar = require('../avatar.js');

function LoginScene(manager) {
  BaseScene.call(this, manager);
  this._userInfoBtn = null;
  this._authorizing = false;
  this._unsupported = false;
  this._needPrivacy = false;   // 等待用户同意隐私协议
  this._fallback = null;       // 画布兜底按钮热区（不支持 / 隐私重试）
}
LoginScene.prototype = Object.create(BaseScene.prototype);
LoginScene.prototype.constructor = LoginScene;

LoginScene.prototype.onEnter = function () {
  const self = this;
  this.clearButtons();
  this._authorizing = false;
  this._needPrivacy = false;
  this._fallback = null;

  network.initCloud();

  if (typeof wx.createUserInfoButton !== 'function') {
    // 基础库不支持：给出兜底进入按钮，避免黑屏（仍标记已授权，避免反复弹登录）
    this._unsupported = true;
    return;
  }
  this._startPrivacy();
};

// 先请求隐私协议同意；同意后创建授权按钮。隐私被拒则提示重试。
LoginScene.prototype._startPrivacy = function () {
  const self = this;
  if (typeof wx.requirePrivacyAuthorize === 'function') {
    wx.requirePrivacyAuthorize({
      success: function () { self._needPrivacy = false; self._createAuthButton(); },
      fail: function () { self._needPrivacy = true; },
      complete: function () {}
    });
  } else {
    // 旧基础库无隐私接口，直接创建授权按钮
    self._createAuthButton();
  }
};

LoginScene.prototype._createAuthButton = function () {
  const self = this;
  const info = (typeof wx.getWindowInfo === 'function')
    ? wx.getWindowInfo()
    : wx.getSystemInfoSync();
  const w = Math.min(280, info.windowWidth * 0.7);
  const h = 46;
  const left = (info.windowWidth - w) / 2;
  const top = info.windowHeight * 0.64;

  const btn = wx.createUserInfoButton({
    type: 'text',
    text: '微信授权登录',
    style: {
      left: left,
      top: top,
      width: w,
      height: h,
      backgroundColor: '#C8923C',
      color: '#FFFFFF',
      fontSize: 17,
      fontWeight: 'bold',
      lineHeight: h,
      borderRadius: 23,
      textAlign: 'center'
    }
  });

  btn.onTap(function (res) {
    if (self._authorizing) return;
    // 成功判定以 userInfo 是否存在为准（兼容不同基础库返回的 errMsg 字符串）
    if (res && res.userInfo && res.userInfo.nickName) {
      self._authorizing = true;
      wx.showLoading({ title: '登录中', mask: true });
      avatar.applyWechatUserInfo(res.userInfo).then(function () {
        wx.hideLoading();
        self._finish();
      }).catch(function () {
        wx.hideLoading();
        self._authorizing = false;
        wx.showToast({ title: '授权失败，请重试', icon: 'none' });
      });
      return;
    }
    // 失败：区分「用户拒绝」与「其他错误」，并打印真实 errMsg 便于排查
    const msg = (res && res.errMsg) || 'unknown';
    console.warn('[dango] 微信授权未成功:', msg);
    if (msg.indexOf('deny') >= 0 || msg.indexOf('cancel') >= 0 || msg.indexOf('auth') >= 0) {
      wx.showToast({ title: '请先允许微信授权', icon: 'none' });
    } else {
      wx.showToast({ title: '授权失败，请重试', icon: 'none' });
    }
  });

  this._userInfoBtn = btn;
};

LoginScene.prototype._finish = function () {
  storage.set('wx_authorized', true);
  if (this._userInfoBtn) {
    try { this._userInfoBtn.destroy(); } catch (e) {}
    this._userInfoBtn = null;
  }
  const opts = (typeof wx.getLaunchOptionsSync === 'function') ? wx.getLaunchOptionsSync() : {};
  const roomId = opts && opts.query && opts.query.roomId;
  this.manager.replace('home');
  if (roomId) this.manager.push('room', { roomId: String(roomId).toUpperCase() });
};

LoginScene.prototype.onExit = function () {
  if (this._userInfoBtn) {
    try { this._userInfoBtn.destroy(); } catch (e) {}
    this._userInfoBtn = null;
  }
};

LoginScene.prototype.render = function (ctx, vp) {
  this.drawBackground(ctx, vp);

  const cx = vp.width / 2;
  const cy = vp.height * 0.32;
  ui.fillCircle(ctx, cx, cy, 38, ui.COLORS.primary);
  ui.drawText(ctx, '棋', cx, cy, { size: 30, bold: true, color: '#FFFFFF', align: 'center' });
  ui.drawText(ctx, '单围棋', cx, cy + 70, { size: 26, bold: true, align: 'center' });
  ui.drawText(ctx, '双人原创棋类游戏', cx, cy + 102, { size: 14, align: 'center', color: ui.COLORS.textSub });

  ui.drawText(ctx, '授权后将以你的微信昵称与头像对弈',
    cx, vp.height * 0.56, { size: 13, align: 'center', color: ui.COLORS.textSub });

  if (this._unsupported) {
    const w = Math.min(280, vp.width * 0.7), h = 46;
    const x = (vp.width - w) / 2, y = vp.height * 0.64;
    this._fallback = { x: x, y: y, w: w, h: h };
    ui.fillRoundRect(ctx, x, y, w, h, 23, ui.COLORS.primary);
    ui.drawText(ctx, '进入', cx, y + h / 2, { size: 17, align: 'center', bold: true, color: '#FFFFFF' });
    return;
  }

  if (this._needPrivacy) {
    // 隐私协议被拒：画布按钮引导用户重新同意
    const w = Math.min(280, vp.width * 0.7), h = 46;
    const x = (vp.width - w) / 2, y = vp.height * 0.64;
    this._fallback = { x: x, y: y, w: w, h: h };
    ui.fillRoundRect(ctx, x, y, w, h, 23, ui.COLORS.primary);
    ui.drawText(ctx, '同意隐私协议并继续', cx, y + h / 2, { size: 16, align: 'center', bold: true, color: '#FFFFFF' });
    ui.drawText(ctx, '微信要求先同意隐私协议才能获取昵称头像',
      cx, y + h + 22, { size: 12, align: 'center', color: ui.COLORS.textSub });
  } else {
    this._fallback = null;
  }
};

LoginScene.prototype.onTouchEnd = function (x, y) {
  if (this._fallback &&
      x >= this._fallback.x && x <= this._fallback.x + this._fallback.w &&
      y >= this._fallback.y && y <= this._fallback.y + this._fallback.h) {
    if (this._unsupported) {
      this._finish();
    } else if (this._needPrivacy) {
      this._needPrivacy = false;
      this._startPrivacy();
    }
    return true;
  }
  return BaseScene.prototype.onTouchEnd.call(this, x, y);
};

module.exports = function (manager) { return new LoginScene(manager); };
