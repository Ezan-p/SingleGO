// js/main.js
// 小游戏启动入口：创建 Canvas、初始化云开发与本地数据、预加载资源、
// 注册场景、启动 requestAnimationFrame 主循环，并接管生命周期与触摸事件。
// 取代小程序的 app.js（App 生命周期）+ 页面栈 + WXML 事件绑定。

const SceneManager = require('./scenes/SceneManager.js');
const res = require('./ResourceManager.js');
const network = require('./network.js');
const storage = require('./storage.js');
const ui = require('./render/ui.js');

// ===== 画布与视口 =====

const canvas = wx.createCanvas();
const ctx = canvas.getContext('2d');

function readWindowInfo() {
  if (typeof wx.getWindowInfo === 'function') return wx.getWindowInfo();
  return wx.getSystemInfoSync();
}

const info = readWindowInfo();
const dpr = info.pixelRatio || 1;
const safe = info.safeArea || { top: 0, bottom: info.windowHeight };

// 逻辑像素坐标系：画布物理尺寸 = 逻辑尺寸 × dpr，绘制前统一缩放，
// 触摸事件返回的 clientX/clientY 即为逻辑像素，无需再换算。
canvas.width = Math.round(info.windowWidth * dpr);
canvas.height = Math.round(info.windowHeight * dpr);
ctx.scale(dpr, dpr);

const viewport = {
  width: info.windowWidth,
  height: info.windowHeight,
  top: Math.max(safe.top || 0, 20),
  bottom: Math.max(info.windowHeight - (safe.bottom || info.windowHeight), 8),
  dpr: dpr
};

// ===== 场景注册 =====

const manager = new SceneManager(ctx, viewport);

manager
  .register('home', require('./scenes/HomeScene.js'))
  .register('ai-setup', require('./scenes/AISetupScene.js'))
  .register('game', require('./scenes/GameScene.js'))
  .register('challenge', require('./scenes/ChallengeScene.js'))
  .register('rules', require('./scenes/RulesScene.js'))
  .register('settings', require('./scenes/SettingsScene.js'))
  .register('profile', require('./scenes/ProfileScene.js'))
  .register('match', require('./scenes/MatchScene.js'))
  .register('online-game', require('./scenes/OnlineGameScene.js'))
  .register('room', require('./scenes/RoomScene.js'))
  .register('room-game', require('./scenes/RoomGameScene.js'))
  .register('login', require('./scenes/LoginScene.js'));

// ===== 启动流程 =====

let started = false;
let loadingProgress = 0;

function drawLoading() {
  const grad = ctx.createLinearGradient(0, 0, 0, viewport.height);
  grad.addColorStop(0, ui.COLORS.bg);
  grad.addColorStop(1, ui.COLORS.bgDeep);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, viewport.width, viewport.height);

  const cy = viewport.height * 0.42;
  ui.fillCircle(ctx, viewport.width / 2, cy, 34, ui.COLORS.primary);
  ui.drawText(ctx, '棋', viewport.width / 2, cy, {
    size: 26, bold: true, color: '#FFFFFF', align: 'center'
  });
  ui.drawText(ctx, '单围棋', viewport.width / 2, cy + 66, {
    size: 22, bold: true, align: 'center'
  });

  const bw = Math.min(200, viewport.width - 100);
  const bx = (viewport.width - bw) / 2;
  const by = cy + 106;
  ui.fillRoundRect(ctx, bx, by, bw, 6, 3, '#E4DACA');
  ui.fillRoundRect(ctx, bx, by, bw * loadingProgress, 6, 3, ui.COLORS.primary);
  ui.drawText(ctx, '加载中 ' + Math.round(loadingProgress * 100) + '%',
    viewport.width / 2, by + 26, { size: 12, align: 'center', color: ui.COLORS.textSub });
}

// 分享卡片 / 场景值携带的房号，进入首页后自动跳转好友房间
function pendingRoomId() {
  try {
    const opts = wx.getLaunchOptionsSync();
    return (opts && opts.query && opts.query.roomId) || '';
  } catch (e) {
    return '';
  }
}

// 完成加载后正式进入应用（首页 + 可能的房间深链）
function enterApp() {
  manager.replace('home');
  const roomId = pendingRoomId();
  if (roomId) manager.push('room', { roomId: String(roomId).toUpperCase() });
}

function boot() {
  // 本地档案（wx.setStorageSync 数据，键名与小程序版一致）
  storage.initPlayerProfile();

  // 云开发 + 网络状态
  network.initCloud();
  network.initNetworkStatus();
  // 提前拉取 openid（失败不阻塞，联网入口会再次触发）
  network.ensureAuth().catch(function () {});

  res.loadAll(function (p) { loadingProgress = p; }).then(function () {
    loadingProgress = 1;
    started = true;
    // 首次启动强制微信授权登录，已授权则直接进入
    const authorized = !!storage.get('wx_authorized', false);
    if (authorized) {
      enterApp();
    } else {
      manager.replace('login');
    }
  });
}

// ===== 主循环 =====

let lastTime = 0;

function frame(timestamp) {
  const now = timestamp || Date.now();
  let dt = lastTime ? (now - lastTime) / 1000 : 0;
  lastTime = now;
  // 切后台回来时 dt 可能极大，钳制避免逻辑跳变
  if (dt > 0.1) dt = 0.1;

  if (started) {
    manager.update(dt);
    ctx.clearRect(0, 0, viewport.width, viewport.height);
    manager.render();
  } else {
    drawLoading();
  }

  requestAnimationFrame(frame);
}

// ===== 事件系统 =====
// 小游戏无 WXML，bindtap 全部改为 Canvas 触摸命中判定。

function touchPoint(e) {
  const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
  if (!t) return null;
  return { x: t.clientX, y: t.clientY };
}

function bindTouch() {
  const onStart = function (e) {
    const p = touchPoint(e);
    if (p) manager.onTouchStart(p.x, p.y);
  };
  const onMove = function (e) {
    const p = touchPoint(e);
    if (p) manager.onTouchMove(p.x, p.y);
  };
  const onEnd = function (e) {
    const p = touchPoint(e);
    if (p) manager.onTouchEnd(p.x, p.y);
  };

  if (canvas && typeof canvas.addEventListener === 'function') {
    canvas.addEventListener('touchstart', onStart);
    canvas.addEventListener('touchmove', onMove);
    canvas.addEventListener('touchend', onEnd);
    canvas.addEventListener('touchcancel', onEnd);
  } else {
    wx.onTouchStart(onStart);
    wx.onTouchMove(onMove);
    wx.onTouchEnd(onEnd);
    wx.onTouchCancel(onEnd);
  }
}

// ===== 生命周期 =====

function bindLifecycle() {
  wx.onShow(function (options) {
    manager.onShow();
    const roomId = options && options.query && options.query.roomId;
    if (started && roomId && manager.currentName === 'home') {
      manager.push('room', { roomId: String(roomId).toUpperCase() });
    }
  });

  wx.onHide(function () {
    manager.onHide();
  });

  wx.onError(function (err) {
    console.error('[dango] 未捕获错误:', err && (err.message || err));
  });

  if (typeof wx.onUnhandledRejection === 'function') {
    wx.onUnhandledRejection(function (r) {
      console.error('[dango] 未处理的 Promise 异常:', r && r.reason);
    });
  }

  if (typeof wx.showShareMenu === 'function') {
    try { wx.showShareMenu({ withShareTicket: true }); } catch (e) {}
  }
  if (typeof wx.onShareAppMessage === 'function') {
    wx.onShareAppMessage(function () {
      return { title: '单围棋 · 一子定胜负', query: '', imageUrl: 'images/share-cover.jpg' };
    });
  }
}

bindTouch();
bindLifecycle();
boot();
requestAnimationFrame(frame);

module.exports = { manager: manager, canvas: canvas, ctx: ctx, viewport: viewport };
