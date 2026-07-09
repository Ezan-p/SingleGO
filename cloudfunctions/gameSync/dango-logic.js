// 单围棋游戏逻辑模块
// 复制自 miniprogram/utils/dango.js

// 棋子状态常量
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

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

// 检查 (r,c) 的指定方向集合是否满足围住条件
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

// 规则三：八方全占判负
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

// 规则四：连续两排判负
function checkTwoRowsLoss(board, player) {
  const size = board.length;
  
  // 检查横向连续两排
  for (let r = 0; r < size - 1; r++) {
    let consecutive = 0;
    for (let c = 0; c < size; c++) {
      if (board[r][c] === player && board[r + 1][c] === player) {
        consecutive++;
        if (consecutive >= 3) return true;
      } else {
        consecutive = 0;
      }
    }
  }
  
  // 检查纵向连续两排
  for (let c = 0; c < size - 1; c++) {
    let consecutive = 0;
    for (let r = 0; r < size; r++) {
      if (board[r][c] === player && board[r][c + 1] === player) {
        consecutive++;
        if (consecutive >= 3) return true;
      } else {
        consecutive = 0;
      }
    }
  }
  
  return false;
}

// 规则一 + 规则二：围子胜
function checkSurroundWin(board, player) {
  const size = board.length;
  const opp = opponent(player);
  
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] !== opp) continue;
      
      // 检查正交围住
      if (allNeighborsAre(board, r, c, ORTHO, player)) {
        return {
          orthogonal: true,
          target: { r, c },
          stones: getSurroundingStones(board, r, c, ORTHO, player)
        };
      }
      
      // 检查对角围住
      if (allNeighborsAre(board, r, c, DIAG, player)) {
        return {
          orthogonal: false,
          target: { r, c },
          stones: getSurroundingStones(board, r, c, DIAG, player)
        };
      }
    }
  }
  
  return null;
}

// 获取参与围子的棋子
function getSurroundingStones(board, r, c, dirs, player) {
  const size = board.length;
  const stones = [];
  
  for (let i = 0; i < dirs.length; i++) {
    const dr = dirs[i][0], dc = dirs[i][1];
    const nr = r + dr, nc = c + dc;
    if (inBounds(nr, nc, size) && board[nr][nc] === player) {
      stones.push({ r: nr, c: nc });
    }
  }
  
  return stones;
}

// 导出所有函数
module.exports = {
  EMPTY,
  BLACK,
  WHITE,
  createBoard,
  cloneBoard,
  opponent,
  inBounds,
  canPlace,
  placePiece,
  checkSelfSurroundLoss,
  checkTwoRowsLoss,
  checkSurroundWin,
  allNeighborsAre,
  getSurroundingStones,
  ORTHO,
  DIAG,
  ALL8
};