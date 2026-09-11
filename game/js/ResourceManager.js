// js/ResourceManager.js
// 小游戏资源管理：统一使用 wx.createImage() 预加载图片，wx.createInnerAudioContext() 播放音频。
// 加载失败不阻塞启动（棋盘与棋子均为矢量绘制，图片仅用于头像等装饰）。

const IMAGE_MANIFEST = {
  avatar: 'images/avatar.png',
  close: 'images/icons/close.png'
};

const images = {};
let loaded = false;
let progress = 0;

// 加载单张图片，失败时 resolve(null) 而不是 reject
function loadImage(key, src) {
  return new Promise(function (resolve) {
    if (typeof wx === 'undefined' || !wx.createImage) {
      resolve(null);
      return;
    }
    let settled = false;
    const img = wx.createImage();
    const done = function (value) {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    img.onload = function () {
      images[key] = img;
      done(img);
    };
    img.onerror = function () {
      console.warn('[dango] 图片加载失败:', src);
      done(null);
    };
    img.src = src;
    // 兜底：3 秒未回调视为失败，避免卡在加载页
    setTimeout(function () { done(null); }, 3000);
  });
}

// 预加载全部资源，返回 Promise（永远 resolve）
// onProgress(ratio) 可选，用于加载进度显示
function loadAll(onProgress) {
  const keys = Object.keys(IMAGE_MANIFEST);
  if (keys.length === 0) {
    loaded = true;
    progress = 1;
    return Promise.resolve();
  }
  let done = 0;
  const tasks = keys.map(function (key) {
    return loadImage(key, IMAGE_MANIFEST[key]).then(function () {
      done++;
      progress = done / keys.length;
      if (onProgress) onProgress(progress);
    });
  });
  return Promise.all(tasks).then(function () {
    loaded = true;
    progress = 1;
  });
}

function getImage(key) {
  return images[key] || null;
}

function isLoaded() {
  return loaded;
}

function getProgress() {
  return progress;
}

module.exports = {
  IMAGE_MANIFEST: IMAGE_MANIFEST,
  loadAll: loadAll,
  loadImage: loadImage,
  getImage: getImage,
  isLoaded: isLoaded,
  getProgress: getProgress
};
