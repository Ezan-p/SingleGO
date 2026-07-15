#!/usr/bin/env node
'use strict';
/*
 * 残局关卡自动生成 · 核心模块（AI 对战初始局面）
 *
 * 设计目标（区别于“解题模式”）：
 *   残局不是让玩家找唯一解，而是 AI 对战的“初始局面”。
 *   因此只需保证：公平、可继续对局即可。无需唯一解、无需验证固定解法。
 *
 * 复用 miniprogram/utils/dango.js（游戏规则引擎），使“十字围 / 斜角围”
 * 的判定与小程序运行时完全一致：
 *   - 十字围  -> ORTHO 方向（上下左右）被当前方棋子围住对方一子
 *   - 斜角围  -> DIAG  方向（四对角）被当前方棋子围住对方一子
 *   越界方向视为“已满足”（棋盘边界即天然阻挡）。
 *
 * 对外函数（与需求一一对应）：
 *   recognizeBoard(imagePath, opts)  -> 识别棋盘为二维数组 board[row][col]
 *   cropBoard(full, top, left, size) -> 从完整棋盘裁剪连续区域
 *   countPieces(board)               -> { black, white, empty }
 *   balancePieces(board)             -> 删除外围多余棋子使黑白数量一致
 *   checkOneMoveWin(board, player)   -> 该方是否一步即可完成十字围/斜角围
 *   validatePuzzle(board)            -> 合法性（四条件）
 *   generateLevel(opts)              -> 单关 JSON
 *   batchGenerateLevels(boards,opts) -> 批量生成并去重，产出 100 关
 *
 * 本模块为纯逻辑（无文件 I/O），便于单元测试与复用。
 */

var path = require('path');
var fs = require('fs');
var cp = require('child_process');

var dango = require(path.join(__dirname, '..', 'miniprogram', 'utils', 'dango.js'));

var EMPTY = dango.EMPTY;
var BLACK = dango.BLACK;
var WHITE = dango.WHITE;

var RECOGNIZE_ONE = path.join(__dirname, 'recognize_one.py');

// 支持的裁剪尺寸（不含整盘 15×15）
var CROP_SIZES = [7, 9, 11, 13];

// ============================================================
//  recognizeBoard —— 第一步：识别棋盘
// ============================================================
//
// 输入：截图路径（png/jpg/jpeg）
// 输出：{ sourceImage, boardSize, board, confidence, unknownPoints, manualReview }
//   board[row][col]: 0=空 1=黑 2=白  -1=不确定（需人工校对）
//
// 识别本身由 Python(CV) 完成（tools/recognize.py），因为 Node 端缺少
// 成熟的栅格图像处理库；此处优先命中已识别缓存（puzzle-output/recognized），
// 未命中再调用 recognize_one.py 实时识别，保证 recognizeBoard 可作为独立函数使用。

var _recIndex = null; // 缓存索引： basename -> 识别结果

function _buildRecIndex(recognizedDir) {
  var map = {};
  if (!recognizedDir || !fs.existsSync(recognizedDir)) return map;
  var files = fs.readdirSync(recognizedDir).filter(function (f) {
    return /\.json$/.test(f);
  }).sort();
  files.forEach(function (f) {
    try {
      var d = JSON.parse(fs.readFileSync(path.join(recognizedDir, f), 'utf-8'));
      var key = path.basename(d.sourceImage || f);
      map[key] = d;
    } catch (e) { /* 跳过损坏文件 */ }
  });
  return map;
}

function recognizeBoard(imagePath, opts) {
  opts = opts || {};
  var base = path.basename(imagePath);

  // 1) 命中已识别缓存
  if (opts.recognizedDir) {
    if (_recIndex === null) _recIndex = _buildRecIndex(opts.recognizedDir);
    if (_recIndex[base]) {
      var cached = _recIndex[base];
      return {
        sourceImage: cached.sourceImage || base,
        boardSize: cached.boardSize,
        board: cached.board,
        confidence: cached.confidence,
        unknownPoints: cached.unknownPoints || [],
        manualReview: !!cached.manualReview
      };
    }
  }

  // 2) 实时识别（子进程调用 Python 识别器）
  var out;
  try {
    out = cp.execFileSync('python3', [RECOGNIZE_ONE, imagePath], { encoding: 'utf-8' });
  } catch (e) {
    throw new Error('识别失败: ' + imagePath + ' -> ' + (e.message || e));
  }
  var result = JSON.parse(out);
  return {
    sourceImage: result.sourceImage || base,
    boardSize: result.boardSize,
    board: result.board,
    confidence: result.confidence,
    unknownPoints: result.unknownPoints || [],
    manualReview: !!result.manualReview
  };
}

// ============================================================
//  countPieces —— 第三步辅助：统计棋子
// ============================================================
function countPieces(board) {
  var black = 0, white = 0, empty = 0;
  for (var r = 0; r < board.length; r++) {
    for (var c = 0; c < board[r].length; c++) {
      var v = board[r][c];
      if (v === BLACK) black++;
      else if (v === WHITE) white++;
      else if (v === EMPTY) empty++;
    }
  }
  return { black: black, white: white, empty: empty };
}

// ============================================================
//  cropBoard —— 第二步：裁剪连续区域
// ============================================================
function cropBoard(full, top, left, size) {
  var sub = [];
  for (var r = 0; r < size; r++) {
    var row = [];
    for (var c = 0; c < size; c++) {
      row.push(full[top + r][left + c]);
    }
    sub.push(row);
  }
  return sub;
}

// ============================================================
//  balancePieces —— 条件三：黑白数量一致
// ============================================================
//
// 删除“外围多余棋子”使双方数量一致。外围 = 距离棋盘中心最远的己方棋子
// （切比雪夫距离最大，平局按 (r,c) 字典序确定，保证确定性）。
// 若某色已为 0 则无法平衡（调用方应拒绝该残局）。
function balancePieces(board) {
  var b = dango.cloneBoard(board);
  var size = b.length;
  var center = (size - 1) / 2;
  var removed = [];
  var guard = size * size + 5;

  while (guard-- > 0) {
    var cnt = countPieces(b);
    if (cnt.black === cnt.white) break;
    if (cnt.black === 0 || cnt.white === 0) break; // 某色已空，无法平衡

    var majority = cnt.black > cnt.white ? BLACK : WHITE;
    var target = null;
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (b[r][c] !== majority) continue;
        var d = Math.max(Math.abs(r - center), Math.abs(c - center));
        if (target === null ||
            d > target.d ||
            (d === target.d && (r > target.r || (r === target.r && c > target.c)))) {
          target = { r: r, c: c, d: d };
        }
      }
    }
    if (!target) break;
    b[target.r][target.c] = EMPTY;
    removed.push([target.r, target.c]);
  }

  var finalCnt = countPieces(b);
  return {
    board: b,
    removed: removed,
    black: finalCnt.black,
    white: finalCnt.white,
    balanced: finalCnt.black === finalCnt.white && finalCnt.black > 0
  };
}

// ============================================================
//  checkOneMoveWin —— 条件一/二：一步即胜判定
// ============================================================
//
// 遍历所有空点，若当前方落子后能通过“十字围”(ORTHO) 或“斜角围”(DIAG)
// 围住对方一子，则视为一步即可获胜，返回该落点 {r,c}；否则返回 null。
// 直接复用 dango.checkSurroundWin，与运行时规则一致。
function checkOneMoveWin(board, player) {
  var size = board.length;
  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      if (board[r][c] !== EMPTY) continue;
      var nb = dango.cloneBoard(board);
      nb[r][c] = player;
      if (dango.checkSurroundWin(nb, player)) return { r: r, c: c };
    }
  }
  return null;
}

// 当前局面是否已经终局（已分胜负 / 判负 / 无合法落子）—— 条件四反面
function isTerminal(board) {
  if (dango.checkSurroundWin(board, BLACK)) return true;   // 黑已围住白
  if (dango.checkSurroundWin(board, WHITE)) return true;   // 白已围住黑
  if (dango.checkSelfSurroundLoss(board, BLACK)) return true;
  if (dango.checkSelfSurroundLoss(board, WHITE)) return true;
  if (dango.checkConsecutiveRowsLoss(board, BLACK)) return true;
  if (dango.checkConsecutiveRowsLoss(board, WHITE)) return true;
  if (countPieces(board).empty === 0) return true;        // 无空点
  return false;
}

// ============================================================
//  validatePuzzle —— 第三步/第四步：合法性校验
// ============================================================
//
// 条件一：黑不能一步获胜（checkOneMoveWin(BLACK) === null）
// 条件二：白不能一步获胜（checkOneMoveWin(WHITE) === null）
// 条件三：黑白数量必须相同（balancePieces 已保证）
// 条件四：残局必须能够继续（双方均有子、非空、未终局）
function validatePuzzle(board) {
  var reasons = [];
  var cnt = countPieces(board);

  var bothColors = cnt.black > 0 && cnt.white > 0;
  if (!bothColors) reasons.push('缺少某一颜色的棋子');

  var equalCounts = cnt.black === cnt.white;
  if (!equalCounts) reasons.push('黑白数量不一致 (黑' + cnt.black + '/白' + cnt.white + ')');

  var blackWin = checkOneMoveWin(board, BLACK);
  if (blackWin) reasons.push('黑一步即胜 @' + JSON.stringify(blackWin));

  var whiteWin = checkOneMoveWin(board, WHITE);
  if (whiteWin) reasons.push('白一步即胜 @' + JSON.stringify(whiteWin));

  var terminal = isTerminal(board);
  if (terminal) reasons.push('局面已终局，无法继续对局');

  var valid = bothColors && equalCounts && !blackWin && !whiteWin && !terminal;
  return {
    valid: valid,
    reasons: reasons,
    checks: {
      bothColors: bothColors,
      equalCounts: equalCounts,
      blackOneMoveWin: blackWin,
      whiteOneMoveWin: whiteWin,
      playable: !terminal
    }
  };
}

// ============================================================
//  区域选择辅助（滑窗 + 战术评分）
// ============================================================

// 战斗接触点：同时 8 邻域接触黑与白的空点数量（攻防关系强度）
function contactCount(board) {
  var size = board.length, n = 0;
  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      if (board[r][c] !== EMPTY) continue;
      var b = 0, w = 0;
      for (var i = 0; i < dango.ALL8.length; i++) {
        var nr = r + dango.ALL8[i][0], nc = c + dango.ALL8[i][1];
        if (dango.inBounds(nr, nc, size)) {
          if (board[nr][nc] === BLACK) b++;
          else if (board[nr][nc] === WHITE) w++;
        }
      }
      if (b > 0 && w > 0) n++;
    }
  }
  return n;
}

// 张力：落子后“立刻送给对方一步胜”的危险空点数量（越高=越紧张=越难）
function tension(board) {
  var size = board.length, t = 0;
  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      if (board[r][c] !== EMPTY) continue;
      var nb1 = dango.cloneBoard(board); nb1[r][c] = BLACK;
      if (dango.checkSurroundWin(nb1, WHITE)) t++;
      var nb2 = dango.cloneBoard(board); nb2[r][c] = WHITE;
      if (dango.checkSurroundWin(nb2, BLACK)) t++;
    }
  }
  return t;
}

// 廉价战术分：用于优先选择“密集 + 攻防 + 有发展空间”的区域
function cheapScore(board) {
  var cnt = countPieces(board);
  var contact = contactCount(board);
  var size = board.length;
  var center = (size - 1) / 2;
  var border = 0;
  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      if (board[r][c] === EMPTY) continue;
      if (r === 0 || r === size - 1 || c === 0 || c === size - 1) border++;
    }
  }
  // 棋子越多、接触点越多越好；裁剪边界上的棋子（可能是被切断的关键棋形）扣分
  return cnt.black + cnt.white + contact * 4 - border * 0.5 + size * 0.3;
}

// 复杂度评分（用于 AI 难度分档）
function complexityScore(board) {
  var cnt = countPieces(board);
  var contact = contactCount(board);
  var ten = tension(board);
  return cnt.black * 1 + contact * 4 + ten * 3 + board.length * 0.5;
}

// 生成候选窗口（滑窗），按 cheapScore 降序
function generateWindows(full, sizes) {
  sizes = sizes || CROP_SIZES;
  var SIZE = full.length;
  var wins = [];
  for (var si = 0; si < sizes.length; si++) {
    var s = sizes[si];
    var max = SIZE - s;
    var stride = s >= 13 ? 1 : 2; // 大尺寸步长更小，避免漏掉密集区
    for (var top = 0; top <= max; top += stride) {
      for (var left = 0; left <= max; left += stride) {
        var sub = cropBoard(full, top, left, s);
        var cnt = countPieces(sub);
        if (cnt.black === 0 || cnt.white === 0) continue;       // 需双方均存在
        if (cnt.black + cnt.white < 8) continue;                // 需一定密度
        if (contactCount(sub) < 1) continue;                    // 需存在攻防接触
        wins.push({ top: top, left: left, size: s, board: sub, score: cheapScore(sub) });
      }
    }
  }
  wins.sort(function (a, b) { return b.score - a.score; });
  return wins;
}

// ============================================================
//  去重（8 朝向归一化签名，含棋盘尺寸）
// ============================================================
function transforms(board) {
  var n = board.length;
  function rot90(b) {
    var r = [];
    for (var i = 0; i < n; i++) {
      var row = [];
      for (var j = 0; j < n; j++) row.push(b[n - 1 - j][i]);
      r.push(row);
    }
    return r;
  }
  function flip(b) {
    var r = [];
    for (var i = 0; i < n; i++) {
      var row = [];
      for (var j = 0; j < n; j++) row.push(b[i][n - 1 - j]);
      r.push(row);
    }
    return r;
  }
  var out = [];
  var b = board;
  for (var t = 0; t < 4; t++) { out.push(b); out.push(flip(b)); b = rot90(b); }
  return out;
}

function signature(board) {
  var best = null;
  var ts = transforms(board);
  for (var i = 0; i < ts.length; i++) {
    var s = ts[i].length + ':';
    for (var r = 0; r < ts[i].length; r++) s += ts[i][r].join('') + '|';
    if (best === null || s < best) best = s;
  }
  return best;
}

// ============================================================
//  generateLevel —— 第五步：生成单关
// ============================================================
function generateLevel(opts) {
  var board = opts.board;
  var difficulty = opts.difficulty;
  return {
    id: opts.id,
    boardSize: board.length,
    difficulty: difficulty,
    playerColor: 'black',
    aiColor: 'white',
    currentTurn: 'black',
    aiLevel: difficulty,           // AI 等级与难度一致
    board: board
  };
}

// 难度分档（按复杂度排名的四分位）
function tierOf(rank, total) {
  var f = rank / total;
  if (f < 0.25) return 'easy';
  if (f < 0.50) return 'normal';
  if (f < 0.75) return 'hard';
  return 'master';
}

// ============================================================
//  batchGenerateLevels —— 第六步：批量生成 100 关
// ============================================================
//
// 输入：recognizedBoards = [{ sourceImage, board }]（来自 recognizeBoard）
//       opts = { targetCount, sizes, perImageCap }
// 输出：{ levels, manifest, report }
//   levels  —— 可玩关卡数组（需求中的 schema）
//   manifest—— 开发元数据（原图名称/裁剪位置/棋盘/AI等级）
//   report —— 统计
function batchGenerateLevels(recognizedBoards, opts) {
  opts = opts || {};
  var target = opts.targetCount || 100;
  var sizes = opts.sizes || CROP_SIZES;
  var perImageCap = opts.perImageCap || 14;

  var seen = {};
  var all = [];
  var filteredNoBoth = 0, filteredSparse = 0, filteredUnbalanced = 0,
      filteredInvalid = 0, filteredDup = 0;

  for (var k = 0; k < recognizedBoards.length; k++) {
    var rec = recognizedBoards[k];
    var full = rec.board;
    if (!full || full.length === 0) continue;

    var wins = generateWindows(full, sizes);
    var added = 0;
    for (var i = 0; i < wins.length; i++) {
      if (added >= perImageCap) break;
      var w = wins[i];

      // 平衡：删除外围多余棋子使黑白一致
      var bal = balancePieces(w.board);
      if (!bal.balanced) { filteredUnbalanced++; continue; }

      // 合法性：四条件
      var v = validatePuzzle(bal.board);
      if (!v.valid) { filteredInvalid++; continue; }

      // 去重（8 朝向归一化）
      var sig = signature(bal.board);
      if (seen[sig]) { filteredDup++; continue; }
      seen[sig] = true;

      all.push({
        sourceImage: rec.sourceImage,
        crop: { top: w.top, left: w.left, size: w.size },
        board: bal.board,
        complexity: complexityScore(bal.board)
      });
      added++;
    }
  }

  // 选择目标数量：复杂度升序后按跨度均匀采样，保证难度分布均衡
  all.sort(function (a, b) { return a.complexity - b.complexity; });
  var chosen;
  if (all.length <= target) {
    chosen = all.slice();
  } else {
    chosen = [];
    var step = (all.length - 1) / (target - 1);
    for (var j = 0; j < target; j++) {
      var idx = Math.round(j * step);
      chosen.push(all[idx]);
    }
    // 跨度采样可能引入重复（极端情况），再次去重
    var seen2 = {};
    chosen = chosen.filter(function (c) {
      var s = signature(c.board);
      if (seen2[s]) return false;
      seen2[s] = true;
      return true;
    });
  }

  // 赋 id / 难度分档
  var levels = [];
  var manifest = [];
  chosen.forEach(function (c, i) {
    var id = i + 1;
    var difficulty = tierOf(i, chosen.length);
    var level = generateLevel({
      id: id, board: c.board, difficulty: difficulty,
      sourceImage: c.sourceImage, crop: c.crop
    });
    levels.push(level);
    manifest.push({
      id: id,
      sourceImage: c.sourceImage,
      crop: c.crop,
      boardSize: c.board.length,
      difficulty: difficulty,
      aiLevel: difficulty,            // 每项保存 AI 等级
      board: c.board
    });
  });

  var report = {
    candidateCount: all.length,
    chosenCount: chosen.length,
    target: target,
    filtered: {
      unbalanced: filteredUnbalanced,
      invalid: filteredInvalid,
      duplicate: filteredDup
    },
    tierCounts: { easy: 0, normal: 0, hard: 0, master: 0 }
  };
  levels.forEach(function (l) { report.tierCounts[l.difficulty]++; });

  return { levels: levels, manifest: manifest, report: report };
}

module.exports = {
  EMPTY: EMPTY, BLACK: BLACK, WHITE: WHITE, CROP_SIZES: CROP_SIZES,
  recognizeBoard: recognizeBoard,
  cropBoard: cropBoard,
  countPieces: countPieces,
  balancePieces: balancePieces,
  checkOneMoveWin: checkOneMoveWin,
  isTerminal: isTerminal,
  validatePuzzle: validatePuzzle,
  contactCount: contactCount,
  tension: tension,
  cheapScore: cheapScore,
  complexityScore: complexityScore,
  generateWindows: generateWindows,
  signature: signature,
  generateLevel: generateLevel,
  batchGenerateLevels: batchGenerateLevels
};

if (require.main === module) {
  // 直接运行本模块时，打印各函数存在性（供冒烟测试）
  console.log('puzzle-generator loaded. exports:', Object.keys(module.exports).join(', '));
}
