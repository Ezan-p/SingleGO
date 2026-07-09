// 单围棋 AI 决策模块
// 纯 JS，require dango，无 wx 依赖
// 导出 chooseMove(board, aiPlayer, difficulty, opts) → {r, c} | null

var dango = require('./dango.js');

var EMPTY = dango.EMPTY;
var BLACK = dango.BLACK;
var WHITE = dango.WHITE;
var ORTHO = dango.ORTHO;
var DIAG = dango.DIAG;
var ALL8 = dango.ALL8;

var DIFFICULTIES = ['easy', 'normal', 'hard', 'master'];

// 终局分（大师搜索用）
var WIN_SCORE = 1000000;

// ===== 通用辅助 =====

// 所有空位
function legalMoves(board) {
  var size = board.length;
  var moves = [];
  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      if (board[r][c] === EMPTY) moves.push({ r: r, c: c });
    }
  }
  return moves;
}

// 距任一已有棋子 ≤radius 的空位（搜索候选）；棋盘空时返回中心
function candidateMoves(board, radius) {
  var size = board.length;
  var hasStone = false;
  var r, c;
  for (r = 0; r < size && !hasStone; r++) {
    for (c = 0; c < size && !hasStone; c++) {
      if (board[r][c] !== EMPTY) hasStone = true;
    }
  }
  if (!hasStone) {
    var mid = Math.floor(size / 2);
    return [{ r: mid, c: mid }];
  }
  var seen = {};
  var list = [];
  for (r = 0; r < size; r++) {
    for (c = 0; c < size; c++) {
      if (board[r][c] === EMPTY) continue;
      // 对每颗已有棋子，加入其 radius 邻域内的空位
      for (var dr = -radius; dr <= radius; dr++) {
        for (var dc = -radius; dc <= radius; dc++) {
          var nr = r + dr, nc = c + dc;
          if (!dango.inBounds(nr, nc, size)) continue;
          if (board[nr][nc] !== EMPTY) continue;
          var key = nr + ',' + nc;
          if (seen[key]) continue;
          seen[key] = true;
          list.push({ r: nr, c: nc });
        }
      }
    }
  }
  return list;
}

// 模拟落子，返回新棋盘（不改原棋盘）
function simulate(board, r, c, player) {
  var nb = dango.cloneBoard(board);
  dango.placePiece(nb, r, c, player);
  return nb;
}

// 落子后当前玩家是否判负（规则3/4）
function wouldLose(board, r, c, player) {
  var nb = simulate(board, r, c, player);
  var res = dango.evaluateMove(nb, r, c, player);
  return res.gameOver && res.winner !== player;
}

// 落子后当前玩家是否获胜（规则1/2）
function wouldWin(board, r, c, player) {
  var nb = simulate(board, r, c, player);
  var res = dango.evaluateMove(nb, r, c, player);
  return res.gameOver && res.winner === player;
}

// 找当前玩家一步获胜位置
function findWinningMove(board, player, candidates) {
  var cands = candidates || candidateMoves(board, 2);
  for (var i = 0; i < cands.length; i++) {
    if (wouldWin(board, cands[i].r, cands[i].c, player)) return cands[i];
  }
  return null;
}

// 找阻止对手下一步获胜的位置：占据对手的赢位
function findBlockingMove(board, player, candidates) {
  var opp = dango.opponent(player);
  var cands = candidates || candidateMoves(board, 2);
  for (var i = 0; i < cands.length; i++) {
    if (wouldWin(board, cands[i].r, cands[i].c, opp)) return cands[i];
  }
  return null;
}

// ===== 评估函数 =====

// 统计 (r,c) 指定方向集合中满足条件的位置数（off-board 视为已阻挡，counts as satisfied）
function countSatisfiedOrPlayer(board, r, c, dirs, player) {
  var size = board.length;
  var n = 0;
  for (var i = 0; i < dirs.length; i++) {
    var nr = r + dirs[i][0], nc = c + dirs[i][1];
    if (!dango.inBounds(nr, nc, size)) { n++; continue; } // 越界视为满足
    if (board[nr][nc] === player) n++;
  }
  return n;
}

function countExactPlayer(board, r, c, dirs, player) {
  var size = board.length;
  var n = 0;
  for (var i = 0; i < dirs.length; i++) {
    var nr = r + dirs[i][0], nc = c + dirs[i][1];
    if (dango.inBounds(nr, nc, size) && board[nr][nc] === player) n++;
  }
  return n;
}

// 非终局启发式评分（站在 aiPlayer 视角，越大越好）
function evaluateBoard(board, aiPlayer) {
  var size = board.length;
  var opp = dango.opponent(aiPlayer);
  var score = 0;
  var center = (size - 1) / 2;

  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      var v = board[r][c];
      if (v === EMPTY) continue;

      if (v === opp) {
        // AI 对对手的围压压力（正交 + 对角），越接近围住越好
        var orthoPress = countSatisfiedOrPlayer(board, r, c, ORTHO, aiPlayer);
        var diagPress = countSatisfiedOrPlayer(board, r, c, DIAG, aiPlayer);
        // 平方加权：接近 4 时奖励陡增
        score += orthoPress * orthoPress * 10 + diagPress * diagPress * 8;
      } else {
        // 己方棋子：被对手围压 → 扣分
        var orthoThreat = countSatisfiedOrPlayer(board, r, c, ORTHO, opp);
        var diagThreat = countSatisfiedOrPlayer(board, r, c, DIAG, opp);
        score -= orthoThreat * orthoThreat * 10 + diagThreat * diagThreat * 8;

        // 接近八方全占判负（内部棋子8邻居全是己方）→ 扣分
        var aiN8 = countExactPlayer(board, r, c, ALL8, aiPlayer);
        if (aiN8 >= 6) score -= (aiN8 - 5) * 80;

        // 中心控制
        var dist = Math.abs(r - center) + Math.abs(c - center);
        score += (size - dist) * 1;
      }
    }
  }
  return score;
}

// ===== 各难度实现 =====

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 简单：随机为主，偏向已有棋子附近
function chooseEasy(board, aiPlayer) {
  var cands = candidateMoves(board, 1);
  if (cands.length === 0) cands = legalMoves(board);
  if (cands.length === 0) return null;
  // 30% 完全随机
  if (Math.random() < 0.3) return randomPick(cands);
  // 否则随机但轻度偏向中心
  var size = board.length;
  var center = (size - 1) / 2;
  var best = null, bestScore = -1;
  for (var i = 0; i < cands.length; i++) {
    var m = cands[i];
    var dist = Math.abs(m.r - center) + Math.abs(m.c - center);
    var s = (size - dist) + Math.random() * size; // 随机扰动
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

// 普通：一步胜/堵/避自损 + 启发式
function chooseNormal(board, aiPlayer) {
  var cands = candidateMoves(board, 2);
  if (cands.length === 0) cands = legalMoves(board);
  if (cands.length === 0) return null;

  // 1. 一步获胜
  var win = findWinningMove(board, aiPlayer, cands);
  if (win) return win;
  // 2. 阻止对手获胜
  var block = findBlockingMove(board, aiPlayer, cands);
  if (block) return block;

  // 3. 过滤自损位置
  var safe = [];
  for (var i = 0; i < cands.length; i++) {
    if (!wouldLose(board, cands[i].r, cands[i].c, aiPlayer)) safe.push(cands[i]);
  }
  if (safe.length === 0) safe = cands;

  // 10% 随机失误
  if (Math.random() < 0.1) return randomPick(safe);

  // 4. 启发式评分 + 噪声
  var best = null, bestScore = -Infinity;
  for (var j = 0; j < safe.length; j++) {
    var nb = simulate(board, safe[j].r, safe[j].c, aiPlayer);
    var s = evaluateBoard(nb, aiPlayer) + (Math.random() - 0.5) * 100;
    if (s > bestScore) { bestScore = s; best = safe[j]; }
  }
  return best;
}

// 困难：胜/堵/避损 + 1-ply 前瞻 + 纯启发式
function chooseHard(board, aiPlayer) {
  var cands = candidateMoves(board, 2);
  if (cands.length === 0) cands = legalMoves(board);
  if (cands.length === 0) return null;

  var win = findWinningMove(board, aiPlayer, cands);
  if (win) return win;
  var block = findBlockingMove(board, aiPlayer, cands);
  if (block) return block;

  var opp = dango.opponent(aiPlayer);
  var best = null, bestScore = -Infinity;

  for (var i = 0; i < cands.length; i++) {
    var m = cands[i];
    if (wouldLose(board, m.r, m.c, aiPlayer)) continue; // 避自损

    var nb = simulate(board, m.r, m.c, aiPlayer);
    // 1-ply 前瞻：对手是否有无法阻止的获胜？
    var oppWin = findWinningMove(nb, opp, candidateMoves(nb, 2));
    if (oppWin) continue; // 这步会让对手赢，跳过

    var s = evaluateBoard(nb, aiPlayer);
    if (s > bestScore) { bestScore = s; best = m; }
  }
  // 若所有候选都被前瞻排除，退回安全启发式
  if (!best) {
    for (var k = 0; k < cands.length; k++) {
      if (wouldLose(board, cands[k].r, cands[k].c, aiPlayer)) continue;
      var nb2 = simulate(board, cands[k].r, cands[k].c, aiPlayer);
      var s2 = evaluateBoard(nb2, aiPlayer);
      if (s2 > bestScore) { bestScore = s2; best = cands[k]; }
    }
  }
  return best || cands[0];
}

// ===== 大师：Alpha-Beta negamax 深度4 =====

// 候选预排序：战术优先（赢/堵），再按 evaluateBoard 降序，取前 N 个
function orderedCandidates(board, player, limit) {
  var cands = candidateMoves(board, 2);
  if (cands.length === 0) return legalMoves(board);
  var opp = dango.opponent(player);
  var scored = [];
  for (var i = 0; i < cands.length; i++) {
    var m = cands[i];
    if (wouldLose(board, m.r, m.c, player)) continue; // 自损视为非法
    var s;
    if (wouldWin(board, m.r, m.c, player)) {
      s = WIN_SCORE / 2; // 一步获胜，最高优先
    } else if (wouldWin(board, m.r, m.c, opp)) {
      s = WIN_SCORE / 3; // 阻止对手获胜，次高优先
    } else {
      var nb = simulate(board, m.r, m.c, player);
      s = evaluateBoard(nb, player);
    }
    scored.push({ move: m, score: s });
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  var result = [];
  for (var j = 0; j < scored.length && j < limit; j++) result.push(scored[j].move);
  return result;
}

// negamax：返回从当前玩家视角的最佳分值
function negamax(board, player, depth, alpha, beta, aiPlayer) {
  // 检查上一手是否终局：通过历史最后一步判断不在此处（调用方保证传入合法状态）
  // 这里用 evaluateBoard 作为非终局估值
  if (depth === 0) {
    return evaluateBoard(board, aiPlayer) * (player === aiPlayer ? 1 : -1);
  }
  var opp = dango.opponent(player);
  var cands = orderedCandidates(board, player, 12);
  if (cands.length === 0) {
    return evaluateBoard(board, aiPlayer) * (player === aiPlayer ? 1 : -1);
  }
  var best = -Infinity;
  for (var i = 0; i < cands.length; i++) {
    var m = cands[i];
    var nb = simulate(board, m.r, m.c, player);
    var res = dango.evaluateMove(nb, m.r, m.c, player);
    var val;
    if (res.gameOver) {
      if (res.winner === player) {
        val = WIN_SCORE - (4 - depth); // 越早赢越好
      } else {
        val = -WIN_SCORE + (4 - depth); // 越晚输越好
      }
    } else {
      val = -negamax(nb, opp, depth - 1, -beta, -alpha, aiPlayer);
    }
    if (val > best) best = val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

function chooseMaster(board, aiPlayer) {
  // 战术优先：一步获胜 / 阻止对手获胜
  var initCands = candidateMoves(board, 2);
  var win = findWinningMove(board, aiPlayer, initCands);
  if (win) return win;
  var block = findBlockingMove(board, aiPlayer, initCands);
  if (block) return block;

  var cands = orderedCandidates(board, aiPlayer, 16);
  if (cands.length === 0) {
    cands = candidateMoves(board, 2);
    if (cands.length === 0) cands = legalMoves(board);
  }
  if (cands.length === 0) return null;

  var opp = dango.opponent(aiPlayer);
  var best = null, bestScore = -Infinity;
  var alpha = -Infinity, beta = Infinity;

  for (var i = 0; i < cands.length; i++) {
    var m = cands[i];
    var nb = simulate(board, m.r, m.c, aiPlayer);
    var res = dango.evaluateMove(nb, m.r, m.c, aiPlayer);
    var val;
    if (res.gameOver) {
      if (res.winner === aiPlayer) val = WIN_SCORE;
      else val = -WIN_SCORE;
    } else {
      val = -negamax(nb, opp, 3, -beta, -alpha, aiPlayer);
    }
    if (val > bestScore) { bestScore = val; best = m; }
    if (bestScore > alpha) alpha = bestScore;
  }
  return best;
}

// ===== 主入口 =====

function chooseMove(board, aiPlayer, difficulty, opts) {
  opts = opts || {};
  var fn;
  if (difficulty === 'easy') fn = chooseEasy;
  else if (difficulty === 'normal') fn = chooseNormal;
  else if (difficulty === 'hard') fn = chooseHard;
  else if (difficulty === 'master') fn = chooseMaster;
  else fn = chooseNormal;

  var move = fn(board, aiPlayer);
  if (!move) return null;
  return { r: move.r, c: move.c };
}

module.exports = {
  DIFFICULTIES: DIFFICULTIES,
  chooseMove: chooseMove,
  evaluateBoard: evaluateBoard,
  legalMoves: legalMoves,
  candidateMoves: candidateMoves,
  wouldWin: wouldWin,
  wouldLose: wouldLose,
  findWinningMove: findWinningMove,
  findBlockingMove: findBlockingMove
};
