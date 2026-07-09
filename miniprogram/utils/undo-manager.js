// utils/undo-manager.js
// 悔棋次数全局管理模块

/**
 * 悔棋次数管理器
 * 提供全局统一的悔棋次数管理，避免不同游戏模式重复实现
 */
const UndoManager = {
  // 默认免费悔棋次数
  DEFAULT_UNDO_COUNT: 1,

  // 当前悔棋次数
  _undoCount: 1,

  /**
   * 初始化悔棋次数（每局游戏开始时调用）
   * @param {number} count - 初始悔棋次数，默认为 1
   */
  init: function(count) {
    this._undoCount = (typeof count === 'number' && count >= 0) ? count : this.DEFAULT_UNDO_COUNT;
  },

  /**
   * 获取当前悔棋次数
   * @returns {number} 当前悔棋次数
   */
  getCount: function() {
    return this._undoCount;
  },

  /**
   * 消耗一次悔棋机会
   * @returns {boolean} 是否成功消耗（次数不足返回 false）
   */
  consume: function() {
    if (this._undoCount > 0) {
      this._undoCount--;
      return true;
    }
    return false;
  },

  /**
   * 增加悔棋次数
   * @param {number} count - 增加的次数，默认为 1
   */
  add: function(count) {
    const addCount = (typeof count === 'number' && count > 0) ? count : 1;
    this._undoCount += addCount;
  },

  /**
   * 重置悔棋次数（重新开始游戏时调用）
   */
  reset: function() {
    this._undoCount = this.DEFAULT_UNDO_COUNT;
  },

  /**
   * 判断是否有悔棋机会
   * @returns {boolean} 是否有悔棋机会
   */
  hasUndo: function() {
    return this._undoCount > 0;
  }
};

module.exports = UndoManager;
