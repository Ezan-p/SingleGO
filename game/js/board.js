// 单围棋 - 棋盘数据模块（小游戏版）
// 从 miniprogram/utils/dango.js 迁移而来，仅保留棋盘数据结构与坐标运算。
// 胜负规则见 rule.js。纯 JS，无 wx.* 依赖。

// 棋子状态常量
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

const BOARD_SIZES = [13, 15, 19];
const DEFAULT_SIZE = 15;

// 方向向量 (dr, dc)
const ORTHO = [[-1, 0], [0, 1], [1, 0], [0, -1]];        // 北 东 南 西 —— 规则一
const DIAG  = [[-1, 1], [1, 1], [1, -1], [-1, -1]];      // 东北 东南 西南 西北 —— 规则二
const ALL8  = ORTHO.concat(DIAG);                         // 规则三

// 创建 size×size 空棋盘
function createBoard(size) {
  const board = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push(EMPTY);
    board.push(row);
  }
  return board;
}

function cloneBoard(board) {
  return board.map(function (row) { return row.slice(); });
}

function opponent(player) {
  return 3 - player;
}

function inBounds(r, c, size) {
  return r >= 0 && r < size && c >= 0 && c < size;
}

function canPlace(board, r, c) {
  const size = board.length;
  return inBounds(r, c, size) && board[r][c] === EMPTY;
}

// 随机选一个合法空点（用于超时系统的随机落子）。无可落子返回 null。
function chooseRandomMove(board, player) {
  const size = board.length;
  const candidates = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] === EMPTY) candidates.push({ r: r, c: c });
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function placePiece(board, r, c, player) {
  board[r][c] = player;
}

// 星位：3 条线的笛卡尔积，13/15/19 均得 9 点
// 13 -> [3,6,9]; 15 -> [3,7,11]; 19 -> [3,9,15]
function starPoints(size) {
  const mid = (size - 1) / 2;
  const lines = [3, mid, size - 4];
  const pts = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = 0; j < lines.length; j++) {
      pts.push([lines[i], lines[j]]);
    }
  }
  return pts;
}

// 棋盘是否已满
function isBoardFull(board) {
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board.length; c++) {
      if (board[r][c] === EMPTY) return false;
    }
  }
  return true;
}

// ===== Canvas 坐标换算（小游戏新增，不影响规则） =====

// 计算棋盘绘制布局
// x, y     — 棋盘外框左上角屏幕坐标
// span     — 棋盘外框边长（含 padding）
// size     — 路数（13/15/19）
// 返回 { x, y, span, size, padding, gap, originX, originY, cellRadius }
function createLayout(x, y, span, size) {
  const padding = span / (size + 1);
  const gap = (span - padding * 2) / (size - 1);
  return {
    x: x,
    y: y,
    span: span,
    size: size,
    padding: padding,
    gap: gap,
    originX: x + padding,
    originY: y + padding,
    cellRadius: gap * 0.44
  };
}

// 棋盘格 → 屏幕像素中心点
function cellToPixel(layout, r, c) {
  return {
    x: layout.originX + c * layout.gap,
    y: layout.originY + r * layout.gap
  };
}

// 屏幕像素 → 棋盘格；超出容差返回 null
// tolerance 为可点击半径系数（相对 gap）
function pixelToCell(layout, px, py, tolerance) {
  const tol = (tolerance === undefined ? 0.5 : tolerance) * layout.gap;
  const c = Math.round((px - layout.originX) / layout.gap);
  const r = Math.round((py - layout.originY) / layout.gap);
  if (!inBounds(r, c, layout.size)) return null;
  const p = cellToPixel(layout, r, c);
  if (Math.abs(p.x - px) > tol || Math.abs(p.y - py) > tol) return null;
  return { r: r, c: c };
}

module.exports = {
  EMPTY: EMPTY,
  BLACK: BLACK,
  WHITE: WHITE,
  BOARD_SIZES: BOARD_SIZES,
  DEFAULT_SIZE: DEFAULT_SIZE,
  ORTHO: ORTHO,
  DIAG: DIAG,
  ALL8: ALL8,
  createBoard: createBoard,
  cloneBoard: cloneBoard,
  opponent: opponent,
  inBounds: inBounds,
  canPlace: canPlace,
  chooseRandomMove: chooseRandomMove,
  placePiece: placePiece,
  starPoints: starPoints,
  isBoardFull: isBoardFull,
  createLayout: createLayout,
  cellToPixel: cellToPixel,
  pixelToCell: pixelToCell
};
