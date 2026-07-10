// 单围棋 (Dan-Go) 游戏逻辑模块 — 服务端正本
// KEEP IN SYNC with miniprogram/utils/dango.js
// 纯 JS 实现，无 wx.* 依赖，便于测试与复用

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

// 规则三：八方全占判负
// 当前玩家任意一颗内部棋子的 8 个邻居全部是自己棋子 → 判负
// 边缘棋子（任一方向越界）不参与判定
function checkSelfSurroundLoss(board, player) {
  const size = board.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] !== player) continue;
      if (r === 0 || r === size - 1 || c === 0 || c === size - 1) continue;
      let surrounded = true;
      for (let i = 0; i < ALL8.length; i++) {
        const dr = ALL8[i][0], dc = ALL8[i][1];
        if (board[r + dr][c + dc] !== player) { surrounded = false; break; }
      }
      if (surrounded) return true;
    }
  }
  return false;
}

// 检查 (r,c) 的指定方向集合是否满足围住条件
// 越界方向视为已满足（棋盘边界视为天然阻挡），棋盘内方向必须是 player 棋子
function allNeighborsAre(board, r, c, dirs, player) {
  const size = board.length;
  for (let i = 0; i < dirs.length; i++) {
    const dr = dirs[i][0], dc = dirs[i][1];
    const nr = r + dr, nc = c + dc;
    if (!inBounds(nr, nc, size)) continue; // 越界方向视为已满足
    if (board[nr][nc] !== player) return false;
  }
  return true;
}

// 规则一 + 规则二：围子胜
// 对方任一棋子的 4 个正交邻居或 4 个对角邻居全部为当前玩家棋子 → 胜
// 返回 { orthogonal, target:{r,c}, stones:[{r,c}...] }，stones 仅含棋盘内参与围子的己方棋子
function checkSurroundWin(board, player) {
  const size = board.length;
  const opp = opponent(player);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] !== opp) continue;
      var orthoStones = collectSurroundStones(board, r, c, ORTHO, player);
      if (orthoStones) return { orthogonal: true, target: { r: r, c: c }, stones: orthoStones };
      var diagStones = collectSurroundStones(board, r, c, DIAG, player);
      if (diagStones) return { orthogonal: false, target: { r: r, c: c }, stones: diagStones };
    }
  }
  return null;
}

// 收集 (r,c) 指定方向集合中参与围子的己方棋子坐标
// 越界方向视为已满足（无棋子），棋盘内方向必须是 player 棋子；任一不满足返回 null
function collectSurroundStones(board, r, c, dirs, player) {
  const size = board.length;
  var stones = [];
  for (let i = 0; i < dirs.length; i++) {
    var nr = r + dirs[i][0], nc = c + dirs[i][1];
    if (!inBounds(nr, nc, size)) continue; // 边界，视为已满足
    if (board[nr][nc] !== player) return null;
    stones.push({ r: nr, c: nc });
  }
  return stones;
}

// ===== 规则四辅助：提取行/列/对角线（返回 {r,c,v} 数组） =====

function getHorizontalLine(board, r) {
  const size = board.length;
  const line = [];
  for (let c = 0; c < size; c++) line.push({ r: r, c: c, v: board[r][c] });
  return line;
}

function getVerticalLine(board, c) {
  const size = board.length;
  const line = [];
  for (let r = 0; r < size; r++) line.push({ r: r, c: c, v: board[r][c] });
  return line;
}

// ↘ 对角线：r - c = k，按列递增（r 同步递增）
function getDiagonalDownRight(board, k) {
  const size = board.length;
  const line = [];
  for (let c = 0; c < size; c++) {
    const r = c + k;
    if (r >= 0 && r < size) line.push({ r: r, c: c, v: board[r][c] });
  }
  return line;
}

// ↙ 对角线：r + c = k，按列递增（r 递减）；与 ↗ 同线，方向相反
function getDiagonalUpRight(board, k) {
  const size = board.length;
  const line = [];
  for (let c = 0; c < size; c++) {
    const r = k - c;
    if (r >= 0 && r < size) line.push({ r: r, c: c, v: board[r][c] });
  }
  return line;
}

// 找出线上长度 ≥ 4 的连续 player 段
// 返回每段 {r1,c1,r2,c2, cells, cellSet}：
//   r1,c1,r2,c2 — 起点与终点坐标（横/竖向区间判定用）
//   cells       — 段内所有坐标 [{r,c},...]（按线方向递增）
//   cellSet     — 坐标查找表 { "r,c": true }（斜向平移判定用）
function findRuns(line, player) {
  const runs = [];
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i].v === player) {
      if (start === -1) start = i;
    } else {
      if (start !== -1) {
        if (i - start >= 4) runs.push(makeRun(line, start, i - 1));
        start = -1;
      }
    }
  }
  if (start !== -1) {
    if (line.length - start >= 4) runs.push(makeRun(line, start, line.length - 1));
  }
  return runs;
}

function makeRun(line, lo, hi) {
  const cells = [];
  const cellSet = {};
  for (let i = lo; i <= hi; i++) {
    const r = line[i].r, c = line[i].c;
    cells.push({ r: r, c: c });
    cellSet[r + ',' + c] = true;
  }
  return { r1: line[lo].r, c1: line[lo].c, r2: line[hi].r, c2: line[hi].c, cells: cells, cellSet: cellSet };
}

// 两条区间 [lo1,hi1] 与 [lo2,hi2] 是否重叠（任意重叠即 true）
function rangesOverlap(lo1, hi1, lo2, hi2) {
  return lo1 <= hi2 && lo2 <= hi1;
}

// 斜向双排判负核心：run a 的所有坐标按 (dr,dc) 平移后是否恰好等于 run b
// （长度相同且 a+(dr,dc) ⊆ b），即两条平行斜向链逐子一一对应、整体长度一致。
// 长度 ≥4 由 findRuns 保证；偏移 (dr,dc) 为对角方向（西南 (1,-1) 或东南 (1,1)），
// 对应棋子距离恰为 1 个对角步。
function chainDiagMatch(a, b, dr, dc) {
  if (a.cells.length !== b.cells.length) return false;
  const set = b.cellSet;
  for (let i = 0; i < a.cells.length; i++) {
    if (!set[(a.cells[i].r + dr) + ',' + (a.cells[i].c + dc)]) return false;
  }
  return true;
}

// 规则四：连续两排超过三颗判负
//   横向 — 相邻两行各自 >3 连续段，列区间任意重叠
//   竖向 — 相邻两列各自 >3 连续段，行区间任意重叠
//   ↘   — 两条平行 ↘ 对角线（r-c 相差 2）各自 >3 连续段，偏移 (1,-1) 西南方向逐子一一对应
//   ↙   — 两条平行 ↙ 对角线（r+c 相差 2）各自 >3 连续段，偏移 (1,1) 东南方向逐子一一对应
//   说明：斜向对应指每颗棋子在对角方向（东北/东南/西南/西北）上有对应棋子，距离 1 步；
//         两条链方向相同、平行且逐子对应，长度一致，无断点、错位或局部重叠。
function checkConsecutiveRowsLoss(board, player) {
  const size = board.length;
  let r, c, i, j;

  // 1. 横向：相邻行 r 与 r+1，列区间重叠
  const hRuns = [];
  for (r = 0; r < size; r++) hRuns.push(findRuns(getHorizontalLine(board, r), player));
  for (r = 0; r < size - 1; r++) {
    for (i = 0; i < hRuns[r].length; i++) {
      for (j = 0; j < hRuns[r + 1].length; j++) {
        if (rangesOverlap(hRuns[r][i].c1, hRuns[r][i].c2, hRuns[r + 1][j].c1, hRuns[r + 1][j].c2)) return { direction: 'h' };
      }
    }
  }

  // 2. 竖向：相邻列 c 与 c+1，行区间重叠
  const vRuns = [];
  for (c = 0; c < size; c++) vRuns.push(findRuns(getVerticalLine(board, c), player));
  for (c = 0; c < size - 1; c++) {
    for (i = 0; i < vRuns[c].length; i++) {
      for (j = 0; j < vRuns[c + 1].length; j++) {
        if (rangesOverlap(vRuns[c][i].r1, vRuns[c][i].r2, vRuns[c + 1][j].r1, vRuns[c + 1][j].r2)) return { direction: 'v' };
      }
    }
  }

  // 3. ↘ 斜向：平行 ↘ 对角线（k 与 k+2），偏移 (1,-1)，长度相同且逐子一一对应
  //    (r,c)+(1,-1) → (r+1,c-1)，r-c 增加 2，故连接到 k+2 号对角线；西南方向对角相邻
  const d1Runs = []; // 索引 0..2*(size-1)，对应 k = -(size-1)..(size-1)
  for (let k = -(size - 1); k <= size - 1; k++) d1Runs.push(findRuns(getDiagonalDownRight(board, k), player));
  for (let idx = 0; idx < d1Runs.length - 2; idx++) {
    for (i = 0; i < d1Runs[idx].length; i++) {
      for (j = 0; j < d1Runs[idx + 2].length; j++) {
        if (chainDiagMatch(d1Runs[idx][i], d1Runs[idx + 2][j], 1, -1)) return { direction: 'd1' };
      }
    }
  }

  // 4. ↙ 斜向：平行 ↙ 对角线（k 与 k+2），偏移 (1,1)，长度相同且逐子一一对应
  //    (r,c)+(1,1) → (r+1,c+1)，r+c 增加 2，故连接到 k+2 号对角线；东南方向对角相邻
  const d2Runs = []; // 索引 0..2*(size-1)，对应 k = 0..2*(size-1)
  for (let k = 0; k <= 2 * (size - 1); k++) d2Runs.push(findRuns(getDiagonalUpRight(board, k), player));
  for (let idx = 0; idx < d2Runs.length - 2; idx++) {
    for (i = 0; i < d2Runs[idx].length; i++) {
      for (j = 0; j < d2Runs[idx + 2].length; j++) {
        if (chainDiagMatch(d2Runs[idx][i], d2Runs[idx + 2][j], 1, 1)) return { direction: 'd2' };
      }
    }
  }

  return null;
}

// 主判定入口：按指定顺序检测
// 1. 规则三（自包围判负）
// 2. 规则四（连续两排判负）
// 3. 规则一/二（围子胜）
// 4. 继续
function evaluateMove(board, lastR, lastC, player) {
  if (checkSelfSurroundLoss(board, player)) {
    return { gameOver: true, winner: opponent(player), reason: '八方全占（自包围）', rule: 3 };
  }
  const rowResult = checkConsecutiveRowsLoss(board, player);
  if (rowResult) {
    var dirText;
    if (rowResult.direction === 'h') dirText = '相邻横行';
    else if (rowResult.direction === 'v') dirText = '相邻竖列';
    else dirText = '相邻斜行';
    return { gameOver: true, winner: opponent(player), reason: dirText + '连续超过三颗', rule: 4 };
  }
  const win = checkSurroundWin(board, player);
  if (win) {
    var size = board.length;
    var onEdge = (win.target.r === 0 || win.target.r === size - 1 ||
                  win.target.c === 0 || win.target.c === size - 1);
    var reason;
    if (win.orthogonal) reason = onEdge ? '边缘十字围' : '十字围';
    else reason = onEdge ? '边缘斜角围' : '斜角围';
    return {
      gameOver: true,
      winner: player,
      reason: reason,
      rule: win.orthogonal ? 1 : 2,
      winTarget: win.target,
      winStones: win.stones
    };
  }
  return { gameOver: false };
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
  placePiece: placePiece,
  starPoints: starPoints,
  evaluateMove: evaluateMove,
  checkSelfSurroundLoss: checkSelfSurroundLoss,
  checkConsecutiveRowsLoss: checkConsecutiveRowsLoss,
  checkSurroundWin: checkSurroundWin,
  allNeighborsAre: allNeighborsAre,
  collectSurroundStones: collectSurroundStones
};
