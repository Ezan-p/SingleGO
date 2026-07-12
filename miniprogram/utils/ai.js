// 单围棋 AI 决策模块
// 纯 JS，require dango，无 wx 依赖
// 导出 chooseMove(board, aiPlayer, difficulty, opts) → {r, c} | null
//
// 设计严格遵循《单围棋》规则与需求文档：
//   七、AI 决策优先级（强制）
//   八、四个难度等级（简单 / 普通 / 困难 / 大师）
//   九、局面评分（加分项 / 扣分项）
// 落子胜/负判定全部复用 dango.evaluateMove，保证与 UI 判定一致。

var dango = require('./dango.js');

var EMPTY = dango.EMPTY;
var BLACK = dango.BLACK;
var WHITE = dango.WHITE;
var ORTHO = dango.ORTHO;
var DIAG = dango.DIAG;
var ALL8 = dango.ALL8;

var DIFFICULTIES = ['easy', 'normal', 'hard', 'master'];

// 终局分（大师 / 困难搜索用）。立即获胜设为最高分，立即判负设为最低分。
var WIN_SCORE = 10000000;

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

// 落子后当前玩家是否判负（规则五，含自陷：落子后让对方立即获胜）
function wouldLose(board, r, c, player) {
  var nb = simulate(board, r, c, player);
  var res = dango.evaluateMove(nb, r, c, player);
  return res.gameOver && res.winner !== player;
}

// 落子后当前玩家是否获胜（规则四）
function wouldWin(board, r, c, player) {
  var nb = simulate(board, r, c, player);
  var res = dango.evaluateMove(nb, r, c, player);
  return res.gameOver && res.winner === player;
}

// 找当前玩家一步获胜位置
function findWinningMove(board, player, candidates) {
  var cands = candidates || candidateMoves(board, 1);
  for (var i = 0; i < cands.length; i++) {
    if (wouldWin(board, cands[i].r, cands[i].c, player)) return cands[i];
  }
  return null;
}

// 找阻止对手下一步获胜的位置：占据对手的赢位（对手在该点落子即获胜）
function findBlockingMove(board, player, candidates) {
  var opp = dango.opponent(player);
  var cands = candidates || candidateMoves(board, 1);
  for (var i = 0; i < cands.length; i++) {
    if (wouldWin(board, cands[i].r, cands[i].c, opp)) return cands[i];
  }
  return null;
}

// 落子后对手是否立即拥有一步获胜点（高风险落点检测，规则 7.1 第 4 条）
function givesOpponentWin(board, aiMove, aiPlayer) {
  var opp = dango.opponent(aiPlayer);
  var nb = simulate(board, aiMove.r, aiMove.c, aiPlayer);
  var res = dango.evaluateMove(nb, aiMove.r, aiMove.c, aiPlayer);
  if (res.gameOver) return false; // 自己赢了就不算高风险
  return !!findWinningMove(nb, opp, candidateMoves(nb, 1));
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ===== 局面评估（规则九） =====
// 站在 aiPlayer 视角，越大越好。立即获胜 / 立即判负由搜索层的最高 / 最低分处理，
// 这里只做非终局启发式。

// 统计 (r,c) 指定方向集合中满足条件的位置数（仅棋盘内）
function countExact(board, r, c, dirs, player) {
  var size = board.length;
  var n = 0;
  for (var i = 0; i < dirs.length; i++) {
    var nr = r + dirs[i][0], nc = c + dirs[i][1];
    if (dango.inBounds(nr, nc, size) && board[nr][nc] === player) n++;
  }
  return n;
}

// 围杀进度评分（加分项核心）
// 对目标棋子 (r,c)，统计其 dirs 方向上「被 attacker 占据 / 仍为空位 / 被目标方棋子占据」的数量。
// 越接近围住（仅差 1 步）奖励越高；边缘棋子因棋盘外侧视为天然封闭，需要占据的点更少 → 更易接近完成。
// 若任一棋盘内方向被目标方棋子占据（无法被 attacker 填满），则围杀被封死，不计分。
function surroundProgress(board, r, c, dirs, attacker) {
  var size = board.length;
  var filled = 0, emptyNeeded = 0, blocked = false;
  for (var i = 0; i < dirs.length; i++) {
    var nr = r + dirs[i][0], nc = c + dirs[i][1];
    if (!dango.inBounds(nr, nc, size)) continue; // 越界视为满足
    var v = board[nr][nc];
    if (v === attacker) filled++;
    else if (v === EMPTY) emptyNeeded++;
    else blocked = true; // 目标方棋子占据，无法完成围
  }
  if (blocked || filled === 0) return 0;
  if (emptyNeeded <= 0) return 0; // 已封死或终局（不应在非终局出现）
  if (emptyNeeded === 1) return 2000 + filled * 500; // 只差一步完成围杀
  if (emptyNeeded === 2) return 200 + filled * 60;   // 接近围杀
  return 20 * filled; // 初步施压
}

// 计算 (r,c) 处 player 棋子沿 (dr,dc) 方向的最大连续长度（含自身）
function runLengthAt(board, r, c, player, dr, dc) {
  var size = board.length;
  var len = 1;
  var nr = r + dr, nc = c + dc;
  while (dango.inBounds(nr, nc, size) && board[nr][nc] === player) { len++; nr += dr; nc += dc; }
  nr = r - dr; nc = c - dc;
  while (dango.inBounds(nr, nc, size) && board[nr][nc] === player) { len++; nr -= dr; nc -= dc; }
  return len;
}

// 长链（双排判负）风险扣分：横线 / 竖线 / 两条斜线连成 4 子及以上即接近判负
function runRisk(board, r, c, player, dr, dc) {
  var len = runLengthAt(board, r, c, player, dr, dc);
  if (len >= 4) return 400 + (len - 4) * 200; // 横向/竖向/斜向双排接近四颗
  if (len === 3) return 30;
  return 0;
}

function evaluateBoard(board, aiPlayer) {
  var size = board.length;
  var opp = dango.opponent(aiPlayer);
  var score = 0;

  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      var v = board[r][c];
      if (v === EMPTY) continue;

      if (v === opp) {
        // 我方正在围压对方 → 加分（十字围 / 斜角围 / 边缘围统一处理）
        score += surroundProgress(board, r, c, ORTHO, aiPlayer);
        score += surroundProgress(board, r, c, DIAG, aiPlayer);
      } else {
        // 己方棋子：被对方围压 → 扣分（己方棋子即将被普通围或边缘围）
        score -= surroundProgress(board, r, c, ORTHO, opp);
        score -= surroundProgress(board, r, c, DIAG, opp);

        // 接近八方全占判负（内部棋子 8 邻居多为己方）→ 扣分
        var n8 = countExact(board, r, c, ALL8, aiPlayer);
        if (n8 >= 6) score -= (n8 - 5) * 200;

        // 横向 / 竖向 / 斜向双排接近四颗 → 扣分
        score -= runRisk(board, r, c, aiPlayer, 0, 1);
        score -= runRisk(board, r, c, aiPlayer, 1, 0);
        score -= runRisk(board, r, c, aiPlayer, 1, 1);
        score -= runRisk(board, r, c, aiPlayer, 1, -1);

        // 无效孤立棋子 → 扣分
        if (countExact(board, r, c, ORTHO, aiPlayer) === 0 &&
            countExact(board, r, c, ORTHO, opp) === 0) {
          score -= 15;
        }

        // 控制棋盘边缘附近关键位置 → 加分（边缘利于进攻，天然封闭边界）
        if (r === 0 || r === size - 1 || c === 0 || c === size - 1) score += 5;
      }
    }
  }
  return score;
}

// ===== 候选排序（战术优先 + 启发式） =====
// 自损落点视为非法（最低分），一步获胜最高优先，阻止对手获胜次高，其余按局面评分。
function orderedCandidates(board, player, limit, aiPlayer) {
  var cands = candidateMoves(board, 1);
  if (cands.length === 0) cands = legalMoves(board);
  var opp = dango.opponent(player);
  var scored = [];
  for (var i = 0; i < cands.length; i++) {
    var m = cands[i];
    if (wouldLose(board, m.r, m.c, player)) {
      scored.push({ move: m, score: -WIN_SCORE }); // 自损，最低优先
      continue;
    }
    var s;
    if (wouldWin(board, m.r, m.c, player)) {
      s = WIN_SCORE / 2;            // 一步获胜，最高优先
    } else if (wouldWin(board, m.r, m.c, opp)) {
      s = WIN_SCORE / 3;            // 阻止对手获胜，次高优先
    } else {
      var nb = simulate(board, m.r, m.c, player);
      s = evaluateBoard(nb, aiPlayer);
    }
    scored.push({ move: m, score: s });
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  var result = [];
  for (var j = 0; j < scored.length && j < limit; j++) result.push(scored[j].move);
  return result;
}

// ===== 极小化极大 + Alpha-Beta 剪枝（困难 / 大师共用） =====
// 返回从当前 player 视角的最佳分值。aiPlayer 始终为评估基准。
function negamax(board, player, depth, alpha, beta, aiPlayer, deadline, candLimit) {
  if (Date.now() > deadline) {
    return evaluateBoard(board, aiPlayer) * (player === aiPlayer ? 1 : -1);
  }
  if (depth === 0) {
    return evaluateBoard(board, aiPlayer) * (player === aiPlayer ? 1 : -1);
  }
  var cands = orderedCandidates(board, player, candLimit, aiPlayer);
  if (cands.length === 0) {
    return evaluateBoard(board, aiPlayer) * (player === aiPlayer ? 1 : -1);
  }
  var opp = dango.opponent(player);
  var best = -Infinity;
  for (var i = 0; i < cands.length; i++) {
    var m = cands[i];
    var nb = simulate(board, m.r, m.c, player);
    var res = dango.evaluateMove(nb, m.r, m.c, player);
    var val;
    if (res.gameOver) {
      if (res.winner === player) val = WIN_SCORE - depth; // 越早赢越好
      else val = -WIN_SCORE + depth;                       // 越晚输越好
    } else {
      val = -negamax(nb, opp, depth - 1, -beta, -alpha, aiPlayer, deadline, candLimit);
    }
    if (val > best) best = val;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

// 带迭代加深的搜索主流程（困难 / 大师共用）
function searchMove(board, aiPlayer, opts) {
  // 1. 一步直接获胜（规则 7.1 第 1 条）
  var win = findWinningMove(board, aiPlayer, candidateMoves(board, 1));
  if (win) return win;

  // 2. 阻止对手一步获胜（规则 7.1 第 2 条），且不能自损
  var block = findBlockingMove(board, aiPlayer, candidateMoves(board, 1));
  if (block && !wouldLose(board, block.r, block.c, aiPlayer)) return block;

  var deadline = Date.now() + opts.budget;
  var cands = orderedCandidates(board, aiPlayer, opts.candLimit, aiPlayer);
  if (cands.length === 0) cands = legalMoves(board);
  if (cands.length === 0) return null;

  var opp = dango.opponent(aiPlayer);
  var best = cands[0];

  // 迭代加深：2 层起步，逐层加深，超时即采用已得结果（控制计算时间，避免卡顿）
  for (var ply = 2; ply <= opts.maxPly; ply++) {
    var alpha = -WIN_SCORE * 2, beta = WIN_SCORE * 2;
    var bestVal = -Infinity;
    var bestMove = best;

    // 上轮最优着法前置，提升剪枝效率
    var ordered = cands.slice();
    var bi = -1;
    for (var k = 0; k < ordered.length; k++) {
      if (ordered[k].r === best.r && ordered[k].c === best.c) { bi = k; break; }
    }
    if (bi > 0) { var tmp = ordered[0]; ordered[0] = ordered[bi]; ordered[bi] = tmp; }

    for (var i = 0; i < ordered.length; i++) {
      if (Date.now() > deadline) break;
      var m = ordered[i];
      var nb = simulate(board, m.r, m.c, aiPlayer);
      var res = dango.evaluateMove(nb, m.r, m.c, aiPlayer);
      var val;
      if (res.gameOver) {
        val = res.winner === aiPlayer ? WIN_SCORE : -WIN_SCORE;
      } else {
        val = -negamax(nb, opp, ply - 1, -beta, -alpha, aiPlayer, deadline, opts.candLimit);
      }
      if (val > bestVal) { bestVal = val; bestMove = m; }
      if (bestVal > alpha) alpha = bestVal;
    }
    best = bestMove;
    if (Date.now() > deadline) break; // 超时停止加深
  }
  return best;
}

// ===== 各难度实现 =====

// 简单：随机为主，偏向已有棋子附近；能识别一步获胜，偶尔阻挡；只做基础自损检查；保留失误概率
function chooseEasy(board, aiPlayer) {
  var cands = candidateMoves(board, 1);
  if (cands.length === 0) cands = candidateMoves(board, 2);
  if (cands.length === 0) cands = legalMoves(board);
  if (cands.length === 0) return null;

  // 能识别一步直接获胜
  var win = findWinningMove(board, aiPlayer, cands);
  if (win) return win;

  // 偶尔（约 40%）阻挡玩家一步获胜
  if (Math.random() < 0.4) {
    var block = findBlockingMove(board, aiPlayer, cands);
    if (block && !wouldLose(board, block.r, block.c, aiPlayer)) return block;
  }

  // 基础自损检查
  var safe = [];
  for (var i = 0; i < cands.length; i++) {
    if (!wouldLose(board, cands[i].r, cands[i].c, aiPlayer)) safe.push(cands[i]);
  }
  if (safe.length === 0) safe = cands;

  // 保留失误概率：约 30% 完全随机
  if (Math.random() < 0.3) return randomPick(safe);

  // 其余：在已有棋子附近随机落子，轻度偏向中心
  var size = board.length, center = (size - 1) / 2;
  var best = null, bestScore = -1;
  for (var j = 0; j < safe.length; j++) {
    var m = safe[j];
    var dist = Math.abs(m.r - center) + Math.abs(m.c - center);
    var s = (size - dist) + Math.random() * size;
    if (s > bestScore) { bestScore = s; best = m; }
  }
  return best;
}

// 普通：稳定一步胜/堵；排除立即判负与高风险落点；基础评分；深度 1~2
function chooseNormal(board, aiPlayer) {
  var cands = candidateMoves(board, 1);
  if (cands.length === 0) cands = legalMoves(board);
  if (cands.length === 0) return null;

  // 1. 一步获胜
  var win = findWinningMove(board, aiPlayer, cands);
  if (win) return win;
  // 2. 阻止对手获胜
  var block = findBlockingMove(board, aiPlayer, cands);
  if (block && !wouldLose(board, block.r, block.c, aiPlayer)) return block;

  // 3 & 4. 排除自损与高风险（落子后让对手立即获胜）落点
  var safe = [];
  for (var i = 0; i < cands.length; i++) {
    var m = cands[i];
    if (wouldLose(board, m.r, m.c, aiPlayer)) continue;
    if (givesOpponentWin(board, m, aiPlayer)) continue;
    safe.push(m);
  }
  if (safe.length === 0) safe = cands; // 退路：无安全点则接受任一合法点

  // 10% 失误
  if (Math.random() < 0.1) return randomPick(safe);

  // 5. 局面评分 + 轻微噪声
  var best = null, bestScore = -Infinity;
  for (var j = 0; j < safe.length; j++) {
    var nb = simulate(board, safe[j].r, safe[j].c, aiPlayer);
    var s = evaluateBoard(nb, aiPlayer) + (Math.random() - 0.5) * 50;
    if (s > bestScore) { bestScore = s; best = safe[j]; }
  }
  return best;
}

// 困难：预测 2~3 步；主动制造围子机会、识别双重威胁；规避所有判负；利用边缘；搜索深度 3 层
function chooseHard(board, aiPlayer) {
  return searchMove(board, aiPlayer, { maxPly: 3, candLimit: 10, budget: 350 });
}

// 大师：完整极小化极大 + Alpha-Beta + 候选剪枝 + 迭代加深（≥4 层）；不随机；控制计算时间
function chooseMaster(board, aiPlayer) {
  return searchMove(board, aiPlayer, { maxPly: 4, candLimit: 12, budget: 700 });
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
  findBlockingMove: findBlockingMove,
  surroundProgress: surroundProgress
};
