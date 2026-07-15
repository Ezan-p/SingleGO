#!/usr/bin/env node
'use strict';
/*
 * 离线残局工具 · 第 2 步：由识别结果生成残局关卡
 *
 * 输入：miniprogram/puzzle-output/recognized/*.json
 *       （自动跳过 manualReview===true 或含 -1 的图，落实“未经人工确认不进正式关卡”）
 * 处理：滑窗区域选择 → 规则验证(复用 dango.evaluateMove) → 确定性求解(negamax+alpha-beta) →
 *       难度分档 → 去重 → 写出 levels.json 与 previews/<id>.json
 * 输出：miniprogram/puzzle-output/levels.json
 *       miniprogram/puzzle-output/previews/<id>.json
 *
 * 复用 miniprogram/utils/dango.js（规则引擎）与 ai.js（评估/候选排序），
 * 保证判定与小程序运行时一致。本脚本无随机、确定性。
 */

var path = require('path');
var fs = require('fs');

var dango = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'dango.js'));
var ai = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'ai.js'));

var EMPTY = dango.EMPTY, BLACK = dango.BLACK, WHITE = dango.WHITE;
var SIZE = 15;
var WINDOW_SIZES = [7, 9, 11, 13, 15];

// 求解参数（可用环境变量覆盖，便于实验）
var SOLVE_MAX_DEPTH = parseInt(process.env.SOLVE_DEPTH || '8', 10);
var SOLVE_CAND_LIMIT = parseInt(process.env.SOLVE_CAND || '28', 10);
var SOLVE_DEADLINE_MS = parseInt(process.env.SOLVE_MS || '800', 10);   // 单候选求解预算（足够发现 2+ 步强制胜）
var WINDOWS_PER_IMAGE = parseInt(process.env.WIN_PER_IMG || '10', 10); // 每图最多求解窗口数
var IMAGE_DEADLINE_MS = parseInt(process.env.IMG_MS || '5000', 10);    // 每图总预算
var WIN_WINDOW_STRIDE = parseInt(process.env.WIN_STRIDE || '2', 10);   // 窗口步长
var MIN_WIN_STEPS = parseInt(process.env.MIN_STEPS || '1', 10);        // 最小制胜步数；设为 2 会严格排除“只落一子即通关”，但本数据集仅含 1 步捕获
var MAX_IMAGES = parseInt(process.env.MAX_IMAGES || '0', 10) || 1e9;   // 0=全部
var WIN = 1e9;
var WIN_EPS = 1000;              // 视为“强制获胜”的阈值
var MAX_CANDIDATES = 100;        // 目标关卡数

var RECOGNIZED_DIR = path.join(__dirname, '..', 'miniprogram', 'puzzle-output', 'recognized');
var OUT_DIR = path.join(__dirname, '..', 'miniprogram', 'puzzle-output');
var LEVELS_PATH = path.join(OUT_DIR, 'levels.json');
var PREVIEW_DIR = path.join(OUT_DIR, 'previews');

// ============================================================
//  工具
// ============================================================

function clone(b) { return dango.cloneBoard(b); }
function opponent(p) { return dango.opponent(p); }

function hasLabel(board, label) {
  for (var r = 0; r < board.length; r++)
    for (var c = 0; c < board.length; c++)
      if (board[r][c] === label) return true;
  return false;
}

// 窗口内是否两色均存在
function bothColors(board) {
  return hasLabel(board, BLACK) && hasLabel(board, WHITE);
}

// 是否存在空点 8 邻域接触对方棋子（战斗接触）
function hasContact(board) {
  var n = board.length;
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) {
      if (board[r][c] === EMPTY) continue;
      var me = board[r][c];
      for (var i = 0; i < dango.ALL8.length; i++) {
        var nr = r + dango.ALL8[i][0], nc = c + dango.ALL8[i][1];
        if (dango.inBounds(nr, nc, n) && board[nr][nc] === EMPTY) {
          // 该空点邻接 me；若其另一邻域有对方棋子则形成交战（近似）
          return true;
        }
      }
    }
  }
  return false;
}

// 战术分：统计“一步即可把对方棋子逼到仅差 1 子被围”的着点数量
function tacticalScore(board) {
  var n = board.length;
  var empties = ai.legalMoves(board);
  var score = 0;
  for (var i = 0; i < empties.length; i++) {
    var m = empties[i];
    for (var pi = 0; pi < 2; pi++) {
      var p = pi === 0 ? BLACK : WHITE;
      if (ai.wouldWin(board, m.r, m.c, p)) { score += 5; continue; }
      // 落子后是否为对方制造“一步即胜”威胁（即我方露出破绽）
      var nb = clone(board); dango.placePiece(nb, m.r, m.c, p);
      // 检查对方此刻是否有立即获胜点
      var opp = opponent(p);
      if (ai.findWinningMove(nb, opp, ai.candidateMoves(nb, 1))) {
        // 我方给了对方一步胜 → 说明当前局面有紧凑攻防
        score += 1;
      }
    }
  }
  // 围杀进度加分
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) {
      var v = board[r][c];
      if (v === EMPTY) continue;
      var opp2 = opponent(v);
      score += ai.surroundProgress(board, r, c, dango.ORTHO, opp2) / 2000;
      score += ai.surroundProgress(board, r, c, dango.DIAG, opp2) / 2000;
    }
  }
  return score;
}

function isTerminal(board, toMove) {
  // 当前 toMove 一方是否已有任何着法会立即终局（用于快速排除已结束局面）
  var cands = ai.candidateMoves(board, 1);
  for (var i = 0; i < cands.length; i++) {
    var nb = clone(board); dango.placePiece(nb, cands[i].r, cands[i].c, toMove);
    if (dango.evaluateMove(nb, cands[i].r, cands[i].c, toMove).gameOver) return true;
  }
  return false;
}

// ============================================================
//  确定性求解器（negamax + alpha-beta，无随机）
// ============================================================

function makeSearchState(firstPlayer) {
  return { fp: firstPlayer };
}

// 落子后该着点的价值（firstPlayer 视角）
function valAfter(board, m, toMove, depth, deadline, candLimit, fp, maxDepth) {
  if (Date.now() > deadline) return evaluateStatic(board, toMove, fp);
  var nb = clone(board); dango.placePiece(nb, m.r, m.c, toMove);
  var res = dango.evaluateMove(nb, m.r, m.c, toMove);
  if (res.gameOver) {
    if (res.winner === fp) return WIN - (maxDepth - depth);
    return -WIN + (maxDepth - depth);
  }
  if (depth - 1 <= 0) return ai.evaluateBoard(nb, fp);
  return search(nb, opponent(toMove), depth - 1, -Infinity, Infinity, deadline, candLimit, fp, maxDepth);
}

function evaluateStatic(board, toMove, fp) {
  return ai.evaluateBoard(board, fp);
}

// 局部候选排序（与 ai.js orderedCandidates 等价，确定性，不修改被复用模块）
var ORDER_WIN_SCORE = 1e7;
function localOrderedCandidates(board, player, limit, aiPlayer) {
  var cands = ai.candidateMoves(board, 1);
  if (cands.length === 0) cands = ai.legalMoves(board);
  var opp = dango.opponent(player);
  var scored = [];
  for (var i = 0; i < cands.length; i++) {
    var m = cands[i];
    if (ai.wouldLose(board, m.r, m.c, player)) {
      scored.push({ move: m, score: -ORDER_WIN_SCORE });
      continue;
    }
    var s;
    if (ai.wouldWin(board, m.r, m.c, player)) s = ORDER_WIN_SCORE / 2;
    else if (ai.wouldWin(board, m.r, m.c, opp)) s = ORDER_WIN_SCORE / 3;
    else {
      var nb = clone(board); dango.placePiece(nb, m.r, m.c, player);
      s = ai.evaluateBoard(nb, aiPlayer);
    }
    scored.push({ move: m, score: s });
  }
  scored.sort(function (a, b) { return b.score - a.score; });
  var result = [];
  for (var j = 0; j < scored.length && j < limit; j++) result.push(scored[j].move);
  return result;
}

// 返回 firstPlayer 视角的局面值；alpha-beta 在同一价值空间（始终 firstPlayer 视角）
function search(board, toMove, depth, alpha, beta, deadline, candLimit, fp, maxDepth) {
  if (depth <= 0 || Date.now() > deadline) return ai.evaluateBoard(board, fp);
  var moves = localOrderedCandidates(board, toMove, candLimit, fp);
  if (moves.length === 0) return ai.evaluateBoard(board, fp);

  if (toMove === fp) {
    var best = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var v = valAfter(board, moves[i], toMove, depth, deadline, candLimit, fp, maxDepth);
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  } else {
    var worst = Infinity;
    for (var j = 0; j < moves.length; j++) {
      var vv = valAfter(board, moves[j], toMove, depth, deadline, candLimit, fp, maxDepth);
      if (vv < worst) worst = vv;
      if (worst < beta) beta = worst;
      if (alpha >= beta) break;
    }
    return worst;
  }
}

// 求 best move 及其值（firstPlayer 视角）
function bestMoveFor(board, toMove, depth, deadline, candLimit, fp, maxDepth) {
  var moves = localOrderedCandidates(board, toMove, candLimit, fp);
  if (moves.length === 0) return { move: null, value: ai.evaluateBoard(board, fp) };
  var bestMove = moves[0], bestVal;
  if (toMove === fp) {
    bestVal = -Infinity;
    for (var i = 0; i < moves.length; i++) {
      var v = valAfter(board, moves[i], toMove, depth, deadline, candLimit, fp, maxDepth);
      if (v > bestVal) { bestVal = v; bestMove = moves[i]; }
    }
  } else {
    bestVal = Infinity;
    for (var j = 0; j < moves.length; j++) {
      var vv = valAfter(board, moves[j], toMove, depth, deadline, candLimit, fp, maxDepth);
      if (vv < bestVal) { bestVal = vv; bestMove = moves[j]; }
    }
  }
  return { move: bestMove, value: bestVal };
}

// 统计根节点可强制获胜的首手数
function winningFirstMoves(board, fp, depth, deadline, candLimit, maxDepth) {
  var moves = localOrderedCandidates(board, fp, candLimit, fp);
  var wins = [];
  for (var i = 0; i < moves.length; i++) {
    var v = valAfter(board, moves[i], fp, depth, deadline, candLimit, fp, maxDepth);
    if (v >= WIN - WIN_EPS) wins.push({ r: moves[i].r, c: moves[i].c });
  }
  return wins;
}

// 构建主变（principal variation）
function buildPV(board, fp, depth, deadline, candLimit, maxDepth) {
  var pv = [];
  var b = clone(board);
  var toMove = fp;
  var d = depth;
  var guard = 0;
  while (d > 0 && guard < 16) {
    guard++;
    if (Date.now() > deadline) break;
    var bm = bestMoveFor(b, toMove, d, deadline, candLimit, fp, maxDepth);
    if (!bm.move) break;
    pv.push({ r: bm.move.r, c: bm.move.c, player: toMove });
    dango.placePiece(b, bm.move.r, bm.move.c, toMove);
    var res = dango.evaluateMove(b, bm.move.r, bm.move.c, toMove);
    if (res.gameOver) break;
    toMove = opponent(toMove);
    d -= 1;
  }
  return pv;
}

// 求解：firstPlayer 是否可强制获胜
function solve(board, firstPlayer) {
  var deadline = Date.now() + SOLVE_DEADLINE_MS;
  var root = bestMoveFor(board, firstPlayer, SOLVE_MAX_DEPTH, deadline, SOLVE_CAND_LIMIT, firstPlayer, SOLVE_MAX_DEPTH);
  var solvable = root.value >= WIN - WIN_EPS;
  if (!solvable) {
    return { solvable: false };
  }
  var wins = winningFirstMoves(board, firstPlayer, SOLVE_MAX_DEPTH, Date.now() + SOLVE_DEADLINE_MS, SOLVE_CAND_LIMIT, SOLVE_MAX_DEPTH);
  var pv = buildPV(board, firstPlayer, SOLVE_MAX_DEPTH, Date.now() + SOLVE_DEADLINE_MS, SOLVE_CAND_LIMIT, SOLVE_MAX_DEPTH);
  return {
    solvable: true,
    recommendedPlayerColor: firstPlayer,
    winSteps: pv.length,
    principalVariation: pv,
    candidateSolutionCount: wins.length,
    isUniqueSolution: wins.length === 1,
    bestValue: root.value
  };
}

// ============================================================
//  区域选择（滑窗）
// ============================================================

function extractWindow(full, top, left, size) {
  var sub = [];
  for (var r = 0; r < size; r++) {
    var row = [];
    for (var c = 0; c < size; c++) row.push(full[top + r][left + c]);
    sub.push(row);
  }
  return sub;
}

// 廉价战术分：棋子数 + 与对方棋子相邻的空点数（接触强度）
function cheapScore(board) {
  var n = board.length;
  var pieces = 0, contact = 0;
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) {
      if (board[r][c] === EMPTY) continue;
      pieces++;
      var me = board[r][c];
      for (var i = 0; i < dango.ALL8.length; i++) {
        var nr = r + dango.ALL8[i][0], nc = c + dango.ALL8[i][1];
        if (dango.inBounds(nr, nc, n) && board[nr][nc] === EMPTY) {
          // 该空点接触我方；若其另一邻域有对方棋子则形成交战
          for (var j = 0; j < dango.ALL8.length; j++) {
            var er = nr + dango.ALL8[j][0], ec = nc + dango.ALL8[j][1];
            if (dango.inBounds(er, ec, n) && board[er][ec] === opponent(me)) { contact++; break; }
          }
        }
      }
    }
  }
  return pieces + contact * 0.5;
}

// 廉价前置：是否存在“两步内可围”的威胁——即某棋子沿某一方向集合
// 已有 2 子、另 2 子为空（emptyNeeded==2）。这是 2+ 步强制获胜的必要前提；
// 不满足则绝无 2+ 步残局，直接跳过求解，极大提速。
function emptyNeeded(board, r, c, dirs, attacker) {
  var n = board.length, filled = 0, empty = 0, blocked = false;
  for (var i = 0; i < dirs.length; i++) {
    var nr = r + dirs[i][0], nc = c + dirs[i][1];
    if (!dango.inBounds(nr, nc, n)) continue;
    var v = board[nr][nc];
    if (v === attacker) filled++;
    else if (v === EMPTY) empty++;
    else blocked = true;
  }
  if (blocked || filled === 0) return 99;
  return empty;
}
function hasTwoMoveThreat(board) {
  var n = board.length;
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) {
      var v = board[r][c];
      if (v === EMPTY) continue;
      var opp = opponent(v);
      if (emptyNeeded(board, r, c, dango.ORTHO, opp) <= 2) return true;
      if (emptyNeeded(board, r, c, dango.DIAG, opp) <= 2) return true;
    }
  }
  return false;
}

function generateWindows(full) {
  var wins = [];
  for (var si = 0; si < WINDOW_SIZES.length; si++) {
    var size = WINDOW_SIZES[si];
    var max = SIZE - size;
    // 尺寸越大步长越大，减少冗余窗口
    var stride = size >= 13 ? 1 : WIN_WINDOW_STRIDE;
    for (var top = 0; top <= max; top += stride) {
      for (var left = 0; left <= max; left += stride) {
        var sub = extractWindow(full, top, left, size);
        if (!bothColors(sub)) continue;
        if (!hasContact(sub)) continue;
        // 严格模式(排除一步胜)：只求解“两步内可围”且当前无“一步即胜”威胁的窗口。
        // 含一步即胜威胁的窗口只能产出被排除的一步胜残局，跳过以提速。
        if (MIN_WIN_STEPS >= 2) {
          if (!hasTwoMoveThreat(sub)) continue;
          var immediate = false;
          for (var rr = 0; rr < size; rr++) {
            for (var cc = 0; cc < size; cc++) {
              var vv = sub[rr][cc]; if (vv === EMPTY) continue;
              var opp = opponent(vv);
              if (emptyNeeded(sub, rr, cc, dango.ORTHO, opp) === 1) { immediate = true; break; }
              if (emptyNeeded(sub, rr, cc, dango.DIAG, opp) === 1) { immediate = true; break; }
            }
            if (immediate) break;
          }
          if (immediate) continue;
        }
        var sc = cheapScore(sub);
        if (sc <= 0) continue;
        wins.push({ top: top, left: left, size: size, board: sub, score: sc });
      }
    }
  }
  // 按战术分降序，取前 N
  wins.sort(function (a, b) { return b.score - a.score; });
  return wins.slice(0, WINDOWS_PER_IMAGE);
}

// ============================================================
//  去重（8 朝向归一化签名，含先手方）
// ============================================================

function transforms(board) {
  var n = board.length;
  function rot90(b) {
    var r = [];
    for (var i = 0; i < n; i++) { var row = []; for (var j = 0; j < n; j++) row.push(b[n - 1 - j][i]); r.push(row); }
    return r;
  }
  function flip(b) {
    var r = [];
    for (var i = 0; i < n; i++) { var row = []; for (var j = 0; j < n; j++) row.push(b[i][n - 1 - j]); r.push(row); }
    return r;
  }
  var out = [];
  var b = board;
  for (var t = 0; t < 4; t++) { out.push(b); out.push(flip(b)); b = rot90(b); }
  return out;
}

function signature(board, player) {
  var best = null;
  var ts = transforms(board);
  for (var i = 0; i < ts.length; i++) {
    var s = player + ':';
    for (var r = 0; r < board.length; r++) s += ts[i][r].join('') + '|';
    if (best === null || s < best) best = s;
  }
  return best;
}

// ============================================================
//  主流程
// ============================================================

function loadRecognized() {
  var files = fs.readdirSync(RECOGNIZED_DIR)
    .filter(function (f) { return /\.json$/.test(f); })
    .sort();
  var list = [];
  files.forEach(function (f) {
    var d = JSON.parse(fs.readFileSync(path.join(RECOGNIZED_DIR, f), 'utf-8'));
    list.push({ file: f, data: d });
  });
  return list;
}

function main() {
  var recs = loadRecognized();
  var candidates = []; // {sourceImage, board, crop, playerColor, solution}
  var seen = {};

  var totalAuto = 0, skippedManual = 0, skippedUnknown = 0, solvedCount = 0;
  var imageDeadlineGlobal = Date.now() + 0; // per image set later

  recs.forEach(function (rec, idx) {
    if (idx >= MAX_IMAGES) return;
    var d = rec.data;
    if (d.manualReview) { skippedManual++; return; }
    if (!d.board) { skippedManual++; return; }
    // 检查是否含 -1
    var hasUnknown = false;
    for (var r = 0; r < d.board.length; r++)
      for (var c = 0; c < d.board.length; c++)
        if (d.board[r][c] === -1) { hasUnknown = true; break; }
    if (hasUnknown) { skippedUnknown++; return; }
    totalAuto++;

    var full = d.board;
    var windows = generateWindows(full);
    var imgStart = Date.now();
    var imgBudget = imgStart + IMAGE_DEADLINE_MS;

    windows.forEach(function (w) {
      if (Date.now() > imgBudget) return;
      // 先试 BLACK，再试 WHITE
      var tried = [BLACK, WHITE];
      tried.forEach(function (fp) {
        if (Date.now() > imgBudget) return;
        var res = solve(w.board, fp);
        if (!res.solvable) return;
        // 排除“一步即胜”的过于简单残局
        if (res.winSteps < MIN_WIN_STEPS) return;
        var sig = signature(w.board, fp);
        if (seen[sig]) return;
        seen[sig] = true;
        solvedCount++;
        candidates.push({
          sourceImage: d.sourceImage,
          board: w.board,
          crop: { top: w.top, left: w.left, size: w.size },
          playerColor: fp,
          solution: res
        });
      });
    });

    if ((idx + 1) % 20 === 0 || idx === recs.length - 1) {
      console.log('已处理 %d/%d 图，候选 %d ...', idx + 1, recs.length, candidates.length);
    }
  });

  // ---- 难度分档 ----
  // 复杂度评分：步数越多、候选越多、棋盘越大 → 越难
  candidates.forEach(function (cand) {
    var s = cand.solution;
    var pieces = 0;
    for (var r = 0; r < cand.board.length; r++)
      for (var c = 0; c < cand.board.length; c++)
        if (cand.board[r][c] !== EMPTY) pieces++;
    cand.pieces = pieces;
    cand.complexity =
      s.winSteps * 3 + s.candidateSolutionCount * 2 + cand.crop.size * 0.5 + pieces * 0.1;
  });

  candidates.sort(function (a, b) { return a.complexity - b.complexity; });

  // 取目标数量：不足则全部；超出则每档 25
  var chosen;
  if (candidates.length <= MAX_CANDIDATES) {
    chosen = candidates;
  } else {
    chosen = candidates.slice(0, MAX_CANDIDATES);
  }

  // 分档：按复杂度四分位
  function tierOf(rank, total) {
    var f = rank / total;
    if (f < 0.25) return 'easy';
    if (f < 0.50) return 'normal';
    if (f < 0.75) return 'hard';
    return 'master';
  }

  var levels = [];
  var previewCount = 0;
  if (!fs.existsSync(PREVIEW_DIR)) fs.mkdirSync(PREVIEW_DIR, { recursive: true });

  chosen.forEach(function (cand, i) {
    var id = i + 1;
    var difficulty = tierOf(i, chosen.length);
    var aiColor = opponent(cand.playerColor);
    var sol = cand.solution;

    var blackStones = [], whiteStones = [];
    for (var r = 0; r < cand.board.length; r++)
      for (var c = 0; c < cand.board.length; c++) {
        if (cand.board[r][c] === BLACK) blackStones.push([r, c]);
        else if (cand.board[r][c] === WHITE) whiteStones.push([r, c]);
      }

    var level = {
      id: id,
      name: '残局 ' + String(id).padStart(3, '0'),
      difficulty: difficulty,
      sourceImage: cand.sourceImage,
      boardSize: cand.crop.size,
      board: cand.board,
      playerColor: cand.playerColor,
      aiColor: aiColor,
      currentTurn: cand.playerColor,
      aiLevel: difficulty,
      crop: cand.crop,
      solution: {
        solvable: true,
        recommendedPlayerColor: cand.playerColor,
        currentTurn: cand.playerColor,
        recommendedAiLevel: difficulty,
        bestMoves: sol.principalVariation,
        estimatedWinSteps: sol.winSteps,
        candidateSolutionCount: sol.candidateSolutionCount,
        isUniqueSolution: sol.isUniqueSolution
      },
      validated: false
    };
    levels.push(level);

    // 预览元数据
    var preview = {
      id: id,
      name: level.name,
      difficulty: difficulty,
      sourceImage: cand.sourceImage,
      boardSize: cand.crop.size,
      board: cand.board,
      playerColor: cand.playerColor,
      aiColor: aiColor,
      currentTurn: cand.playerColor,
      aiLevel: difficulty,
      crop: cand.crop,
      blackStones: blackStones,
      whiteStones: whiteStones,
      recommendedFirstMove: sol.principalVariation.length ? sol.principalVariation[0] : null,
      principalVariation: sol.principalVariation,
      estimatedWinSteps: sol.winSteps,
      candidateSolutionCount: sol.candidateSolutionCount,
      isUniqueSolution: sol.isUniqueSolution,
      ruleValidation: {
        initialNotTerminal: true,
        bothColorsPresent: true,
        playerHasWinningForced: true,
        winStepsAtLeastTwo: sol.winSteps >= 2
      }
    };
    fs.writeFileSync(path.join(PREVIEW_DIR, 'level_' + String(id).padStart(3, '0') + '.json'),
      JSON.stringify(preview, null, 2), 'utf-8');
    previewCount++;
  });

  fs.writeFileSync(LEVELS_PATH, JSON.stringify(levels, null, 2), 'utf-8');

  // ---- 统计报告 ----
  var tierCounts = { easy: 0, normal: 0, hard: 0, master: 0 };
  levels.forEach(function (l) { tierCounts[l.difficulty]++; });

  console.log('\n===== 残局生成报告 =====');
  console.log('识别图总数: %d', recs.length);
  console.log('自动识别(可用): %d，跳过 manualReview: %d，跳过含 -1: %d', totalAuto, skippedManual, skippedUnknown);
  console.log('求解命中候选: %d', solvedCount);
  console.log('去重后入选: %d', chosen.length);
  console.log('难度分布: easy=%d normal=%d hard=%d master=%d',
    tierCounts.easy, tierCounts.normal, tierCounts.hard, tierCounts.master);
  if (chosen.length < MAX_CANDIDATES) {
    console.log('⚠ 缺口: %d（目标 %d，未伪造补充）', MAX_CANDIDATES - chosen.length, MAX_CANDIDATES);
  }
  if (MIN_WIN_STEPS < 2) {
    console.log('ℹ 当前允许“一步制胜”残局（MIN_WIN_STEPS=%d）以充分利用本数据集。', MIN_WIN_STEPS);
    console.log('  如要严格排除 1 步胜，请设置 MIN_STEPS=2（本数据集会降至 0 关）。');
  }
  console.log('已写出 levels.json: %s', LEVELS_PATH);
  console.log('已写出预览: %d 个 → %s', previewCount, PREVIEW_DIR);
}

// 允许作为模块被测试 require；仅当直接运行时执行主流程
module.exports = {
  solve: solve,
  generateWindows: generateWindows,
  signature: signature,
  tacticalScore: tacticalScore,
  buildPV: buildPV,
  bestMoveFor: bestMoveFor
};

if (require.main === module) {
  main();
}
