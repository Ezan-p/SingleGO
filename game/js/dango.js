// 单围棋 - 核心逻辑聚合入口（小游戏版）
// board.js（棋盘数据）+ rule.js（胜负规则）合并导出，
// 与小程序版 utils/dango.js 保持完全相同的 API，供 ai.js 等模块直接复用。

const board_ = require('./board.js');
const rule = require('./rule.js');

module.exports = {
  EMPTY: board_.EMPTY,
  BLACK: board_.BLACK,
  WHITE: board_.WHITE,
  BOARD_SIZES: board_.BOARD_SIZES,
  DEFAULT_SIZE: board_.DEFAULT_SIZE,
  ORTHO: board_.ORTHO,
  DIAG: board_.DIAG,
  ALL8: board_.ALL8,
  createBoard: board_.createBoard,
  cloneBoard: board_.cloneBoard,
  opponent: board_.opponent,
  inBounds: board_.inBounds,
  canPlace: board_.canPlace,
  chooseRandomMove: board_.chooseRandomMove,
  placePiece: board_.placePiece,
  starPoints: board_.starPoints,
  isBoardFull: board_.isBoardFull,
  createLayout: board_.createLayout,
  cellToPixel: board_.cellToPixel,
  pixelToCell: board_.pixelToCell,
  evaluateMove: rule.evaluateMove,
  checkSelfSurroundLoss: rule.checkSelfSurroundLoss,
  checkConsecutiveRowsLoss: rule.checkConsecutiveRowsLoss,
  checkSurroundWin: rule.checkSurroundWin
};
