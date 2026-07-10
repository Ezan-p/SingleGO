// 网络状态监听 — 全局单例
// 封装 wx.onNetworkStatusChange，提供订阅式 API

let current = {
  connected: true,
  type: 'unknown' // wifi | 2g | 3g | 4g | 5g | unknown | none
};

let listeners = [];
let initialized = false;

function init() {
  if (initialized) return;
  initialized = true;
  // 初始状态
  try {
    wx.getNetworkType({
      success(res) {
        current.type = res.networkType;
        current.connected = res.networkType !== 'none';
        notify();
      }
    });
  } catch (e) { /* ignore */ }

  wx.onNetworkStatusChange(function (res) {
    current.type = res.networkType;
    current.connected = !!res.isConnected;
    notify();
  });
}

function notify() {
  for (let i = 0; i < listeners.length; i++) {
    try { listeners[i](current); } catch (e) { /* ignore */ }
  }
}

// 订阅网络变化，返回取消订阅函数
function onNetworkChange(cb) {
  if (!initialized) init();
  listeners.push(cb);
  // 立即推送一次当前状态
  try { cb(current); } catch (e) { /* ignore */ }
  return function unsubscribe() {
    const idx = listeners.indexOf(cb);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

function getNetworkStatus() {
  return current;
}

module.exports = {
  init,
  onNetworkChange,
  getNetworkStatus
};
