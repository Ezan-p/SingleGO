// 残局闯关 · 选关页
const progress = require('../../utils/challenge-progress.js');
const levels = require('../../utils/levels.js');

Page({
  data: {
    levels: [],          // [{id, name, state}] state: 'locked'|'unlocked'|'cleared'
    highestCleared: 0,   // 最高通关记录（关卡号，0 表示无）
    clearedCount: 0,    // 已通关数
    unlockedMax: 1,     // 已解锁至第 N 关
    total: levels.LEVEL_COUNT
  },

  onShow: function () {
    this.refresh();
  },

  refresh: function () {
    const p = progress.loadProgress();
    const list = [];
    let lastTier = null;
    for (let i = 1; i <= levels.LEVEL_COUNT; i++) {
      let state;
      if (p.cleared.indexOf(i) !== -1) state = 'cleared';
      else if (i <= p.unlockedMax) state = 'unlocked';
      else state = 'locked';
      const lv = levels.getLevel(i);
      const tierName = (lv && lv.tierName) || '';
      const difficulty = (lv && lv.difficulty) || 'easy';
      list.push({
        id: i,
        name: '第' + i + '关',
        state: state,
        tierName: tierName,
        difficulty: difficulty,
        showHeader: tierName && tierName !== lastTier
      });
      lastTier = tierName;
    }
    this.setData({
      levels: list,
      highestCleared: p.highestCleared,
      clearedCount: p.cleared.length,
      unlockedMax: p.unlockedMax
    });
  },

  onLevelTap: function (e) {
    const id = e.currentTarget.dataset.id;
    const state = e.currentTarget.dataset.state;
    if (state === 'locked') {
      wx.showToast({ title: '未解锁，先通关前面的关卡', icon: 'none', duration: 1200 });
      return;
    }
    wx.navigateTo({ url: '/pages/challenge-game/index?level=' + id });
  },

  onBackHome: function () {
    wx.navigateBack();
  },

  onUnlockAll: function () {
    const self = this;
    wx.showModal({
      title: '开放全部关卡',
      content: '将解锁全部 ' + levels.LEVEL_COUNT + ' 关（已通关记录保留），确定继续？',
      success: function (res) {
        if (res.confirm) {
          progress.unlockAll();
          self.refresh();
          wx.showToast({ title: '已开放全部关卡', icon: 'success', duration: 1200 });
        }
      }
    });
  },

  onResetProgress: function () {
    const self = this;
    wx.showModal({
      title: '重置进度',
      content: '将清空所有通关记录，并仅保留第 1 关，确定继续？',
      success: function (res) {
        if (res.confirm) {
          progress.resetProgress();
          self.refresh();
          wx.showToast({ title: '进度已重置', icon: 'success', duration: 1200 });
        }
      }
    });
  }
});
