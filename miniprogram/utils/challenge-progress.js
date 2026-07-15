// 单围棋 · 残局闯关 进度持久化
// 本地缓存（与 playerProfile 一致，无云依赖）。
// 存储结构：
// {
//   cleared: number[],     // 已通关关卡 id
//   highestCleared: number, // 最高通关记录（已通关最大 id，0 表示无）
//   unlockedMax: number     // 已解锁到的最大关卡 id，初始为 1
// }

const STORAGE_KEY = 'dango_challenge_progress';
const TOTAL_LEVELS = 100;

function defaultProgress() {
  return {
    cleared: [],
    highestCleared: 0,
    unlockedMax: 1
  };
}

function loadProgress() {
  try {
    const data = wx.getStorageSync(STORAGE_KEY);
    if (data && typeof data === 'object' && Array.isArray(data.cleared)) {
      // 容错补齐
      if (typeof data.unlockedMax !== 'number' || data.unlockedMax < 1) {
        data.unlockedMax = 1;
      }
      if (typeof data.highestCleared !== 'number') {
        data.highestCleared = data.cleared.length
          ? Math.max.apply(null, data.cleared)
          : 0;
      }
      return data;
    }
  } catch (e) {
    // 读取失败则回退默认
  }
  return defaultProgress();
}

function saveProgress(progress) {
  try {
    wx.setStorageSync(STORAGE_KEY, progress);
  } catch (e) {
    // 忽略写入失败
  }
}

function isUnlocked(id) {
  const p = loadProgress();
  return id <= p.unlockedMax;
}

function isCleared(id) {
  const p = loadProgress();
  return p.cleared.indexOf(id) !== -1;
}

function getHighestCleared() {
  return loadProgress().highestCleared;
}

function getUnlockedMax() {
  return loadProgress().unlockedMax;
}

function getClearedCount() {
  return loadProgress().cleared.length;
}

// 标记某关通关：写入 cleared、刷新最高记录、解锁下一关
function markCleared(id) {
  const p = loadProgress();
  if (p.cleared.indexOf(id) === -1) {
    p.cleared.push(id);
  }
  if (id > p.highestCleared) p.highestCleared = id;
  if (id < TOTAL_LEVELS && id + 1 > p.unlockedMax) {
    p.unlockedMax = id + 1;
  }
  saveProgress(p);
  return p;
}

// 重置全部进度（清空通关记录，仅保留第 1 关）
function resetProgress() {
  const p = defaultProgress();
  saveProgress(p);
  return p;
}

// 开放全部关卡（保留已通关记录，仅将已解锁上限拉满）
function unlockAll() {
  const p = loadProgress();
  p.unlockedMax = TOTAL_LEVELS;
  saveProgress(p);
  return p;
}

module.exports = {
  TOTAL_LEVELS: TOTAL_LEVELS,
  loadProgress: loadProgress,
  isUnlocked: isUnlocked,
  isCleared: isCleared,
  getHighestCleared: getHighestCleared,
  getUnlockedMax: getUnlockedMax,
  getClearedCount: getClearedCount,
  markCleared: markCleared,
  resetProgress: resetProgress,
  unlockAll: unlockAll
};
