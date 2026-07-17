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

// 找当前玩家所有一步获胜位置（不止第一个）
function findAllWinningMoves(board, player, candidates) {
  var cands = candidates || candidateMoves(board, 1);
  var res = [];
  for (var i = 0; i < cands.length; i++) {
    if (wouldWin(board, cands[i].r, cands[i].c, player)) res.push(cands[i]);
  }
  return res;
}

// ===== 规则补充策略 =====

// ===== 指定陷阱防守（相对模板 + 旋转/镜像变体） =====
//
// 思路：把黑方陷阱棋形抽象为「以白棋为中心的相对坐标模板」，再生成该模板在
// 正方形二面体群 D4 下的全部旋转/镜像变体。白方 AI 对每个白棋中心、每个变体
// 做模板匹配；一旦匹配，就落在模板标记的 defense 防守点。
// 这样无论陷阱出现在哪个方向（左/右/上/下、旋转 90/180/270、水平/垂直镜像），
// AI 都能在陷阱启动前提前堵住关键点，而不是只识别固定一侧。

// 调试日志开关：打开后可确认 AI 是否识别到陷阱棋形（落子决策时输出）
var TRAP_DEBUG = true;

// 核心陷阱棋形（相对中心白棋的坐标：dx 向右为正，dy 向下为正）
//   中心白棋被上下黑子夹击，右上方有黑子延伸威胁，左侧空位即黑方陷阱启动点。
//   标记为 role:'defense' 的 EMPTY 单元格即白方应优先落子的防守点。
// 注意：此处使用相对坐标，不使用任何绝对坐标；具体防守点由模板决定，不写死。
var TRAP_BASE_PATTERN = [
  { dx: 0,  dy: 0,  value: WHITE },                 // 中心：白棋
  { dx: 0,  dy: -1, value: BLACK },                 // 上方：黑
  { dx: 0,  dy: 1,  value: BLACK },                 // 下方：黑
  { dx: 1,  dy: -1, value: BLACK },                 // 右上：黑
  { dx: -1, dy: 0,  value: EMPTY, role: 'defense' } // 左侧：空（防守点）
];

// 棋形中棋子值 → 实际棋盘值的映射（白方防守时为单位映射；保留接口以便复用模板）
var TRAP_PLAYER_MAP = {};
TRAP_PLAYER_MAP[EMPTY] = EMPTY;
TRAP_PLAYER_MAP[BLACK] = BLACK;
TRAP_PLAYER_MAP[WHITE] = WHITE;

// 正方形的二面体群 D4：4 个旋转 × {单位, 水平镜像}，覆盖陷阱所有方向变体
var TRAP_TRANSFORMS = [
  { name: '原始',             fn: function (p) { return { dx: p.dx, dy: p.dy }; } },
  { name: '旋转90°',          fn: function (p) { return { dx: -p.dy, dy: p.dx }; } },
  { name: '旋转180°',         fn: function (p) { return { dx: -p.dx, dy: -p.dy }; } },
  { name: '旋转270°',         fn: function (p) { return { dx: p.dy, dy: -p.dx }; } },
  { name: '水平镜像',          fn: function (p) { return { dx: -p.dx, dy: p.dy }; } },
  { name: '水平镜像+旋转90°',  fn: function (p) { return { dx: p.dy, dy: p.dx }; } },
  { name: '水平镜像+旋转180°', fn: function (p) { return { dx: p.dx, dy: -p.dy }; } },
  { name: '水平镜像+旋转270°', fn: function (p) { return { dx: -p.dy, dy: -p.dx }; } }
];

// 对基模板应用一次坐标变换，得到新模板（保留 value 与 role）
function transformPattern(basePattern, fn) {
  var out = [];
  for (var i = 0; i < basePattern.length; i++) {
    var cell = basePattern[i];
    var t = fn(cell);
    var nc = { dx: t.dx, dy: t.dy, value: cell.value };
    if (cell.role) nc.role = cell.role;
    out.push(nc);
  }
  return out;
}

// 模板规范化键：按 (dy,dx) 排序后拼接，用于在变体生成时去重
function patternKey(pattern) {
  var cells = pattern.slice().sort(function (a, b) {
    if (a.dy !== b.dy) return a.dy - b.dy;
    return a.dx - b.dx;
  });
  return cells.map(function (c) {
    return c.dx + ',' + c.dy + ',' + c.value + ',' + (c.role || '');
  }).join('|');
}

// 生成去重后的所有方向变体
function generatePatternVariants(basePattern) {
  var seen = {};
  var variants = [];
  for (var i = 0; i < TRAP_TRANSFORMS.length; i++) {
    var t = TRAP_TRANSFORMS[i];
    var pat = transformPattern(basePattern, t.fn);
    var key = patternKey(pat);
    if (seen[key]) continue;
    seen[key] = true;
    variants.push({ name: t.name, cells: pat });
  }
  return variants;
}

// 取模板中标记的防守点（role === 'defense' 的单元格）
function getDefenseCell(pattern) {
  for (var i = 0; i < pattern.length; i++) {
    if (pattern[i].role === 'defense') return pattern[i];
  }
  return null;
}

// 以 (centerX, centerY) 为中心，检测棋盘是否符合相对坐标模板。
// playerMap 将模板中的棋子值映射到实际棋盘值；未映射时按原值比较。
// 任一单元格越界或棋子值不符即返回 false。
function matchPatternAroundPiece(board, centerX, centerY, pattern, playerMap) {
  var size = board.length;
  for (var i = 0; i < pattern.length; i++) {
    var cell = pattern[i];
    var x = centerX + cell.dx;
    var y = centerY + cell.dy;
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    var expected = (playerMap && playerMap[cell.value] !== undefined)
      ? playerMap[cell.value]
      : cell.value;
    if (board[y][x] !== expected) return false;
  }
  return true;
}

// 模块加载时生成一次全部变体（避免每次决策重复计算）
var TRAP_VARIANTS = generatePatternVariants(TRAP_BASE_PATTERN);

// 指定陷阱防守（模板 + 旋转/镜像变体）：白方防守黑方同类陷阱的所有方向。
// 返回真实棋盘坐标 {r, c} 或 null。多个相同棋形时优先选择距离 lastMove 最近的防守点。
// 说明：仅针对白方防守黑方该固定棋形；防守点若被占用则棋形不成立（模板要求该格为 EMPTY）。
function detectSpecificWhiteDefenseMove(board, lastMove) {
  var size = board.length;
  var best = null, bestDist = Infinity;
  if (TRAP_DEBUG) console.log('检测指定陷阱模板');
  for (var r = 0; r < size; r++) {
    for (var c = 0; c < size; c++) {
      if (board[r][c] !== WHITE) continue; // 中心必须是白棋
      for (var v = 0; v < TRAP_VARIANTS.length; v++) {
        var variant = TRAP_VARIANTS[v];
        if (matchPatternAroundPiece(board, c, r, variant.cells, TRAP_PLAYER_MAP)) {
          var def = getDefenseCell(variant.cells);
          if (!def) break;
          var defX = c + def.dx;
          var defY = r + def.dy;
          if (TRAP_DEBUG) {
            console.log('匹配到的中心白棋:', c, r);
            console.log('匹配到的模板方向:', variant.name);
            console.log('推荐防守点:', defX, defY);
          }
          var dist = 0;
          if (lastMove && typeof lastMove.r === 'number' && typeof lastMove.c === 'number') {
            dist = Math.abs(defY - lastMove.r) + Math.abs(defX - lastMove.c);
          }
          if (dist < bestDist) { bestDist = dist; best = { r: defY, c: defX }; }
          break; // 该中心已匹配一个变体，无需再试其余变体
        }
      }
    }
  }
  if (TRAP_DEBUG && !best) console.log('未匹配到指定陷阱');
  return best;
}

// 通用两步陷阱预判：识别对手「下一步制造强制威胁、再下一步绝杀」的二步陷阱启动点
// 若发现，返回 AI 当前应占据/破坏的 trapStart {r, c}；否则返回 null。
// 仅扩展检测逻辑，不修改基础胜负规则（复用 dango.evaluateMove / wouldWin / wouldLose）。
function detectTwoStepTrapMove(board, aiPlayer, opponentPlayer) {
  var oppMoves = candidateMoves(board, 1);
  if (oppMoves.length === 0) oppMoves = legalMoves(board);
  if (oppMoves.length === 0) return null;

  for (var i = 0; i < oppMoves.length; i++) {
    var trapStart = oppMoves[i];

    // 4. 对方落子 trapStart 触发自身判负 → 跳过
    if (wouldLose(board, trapStart.r, trapStart.c, opponentPlayer)) continue;
    // 5. 对方该步已直接获胜 → 由立即防守逻辑处理，本函数跳过
    if (wouldWin(board, trapStart.r, trapStart.c, opponentPlayer)) continue;

    // 6. 模拟对方落子后，查找对方下一步可直接获胜的所有位置
    var nb = simulate(board, trapStart.r, trapStart.c, opponentPlayer);
    var threatMoves = findAllWinningMoves(nb, opponentPlayer);
    // 7. 威胁点少于 2 个，AI 只需防住其一即可，跳过该 trapStart
    if (threatMoves.length < 2) continue;

    // 8~9. 逐一模拟 AI 防守各威胁点，若任一防守后仍留下对方直接获胜点 → 二步陷阱
    var isTrap = false;
    for (var j = 0; j < threatMoves.length; j++) {
      var t = threatMoves[j];
      if (wouldLose(nb, t.r, t.c, aiPlayer)) continue; // 防守点自损则试下一点
      var nb2 = simulate(nb, t.r, t.c, aiPlayer);
      if (findWinningMove(nb2, opponentPlayer, candidateMoves(nb2, 1))) {
        isTrap = true;
        break;
      }
    }
    // 10. 当前 AI 应返回 trapStart 作为优先防守位置
    if (isTrap) return { r: trapStart.r, c: trapStart.c };
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
  var opp = dango.opponent(aiPlayer);

  // 1. 一步直接获胜（规则 7.1 第 1 条）
  var win = findWinningMove(board, aiPlayer, candidateMoves(board, 1));
  if (win) return win;

  // 2. 阻止对手一步获胜（普通防守，规则 7.1 第 2 条），且不能自损。
  //    立即获胜威胁优先级高于陷阱预判：若黑方下一手可直接获胜，必须立即堵住。
  var block = findBlockingMove(board, aiPlayer, candidateMoves(board, 1));
  if (block && !wouldLose(board, block.r, block.c, aiPlayer)) return block;

  // 3. 指定陷阱防守（仅白方）：识别黑方同类陷阱的「旋转/镜像」所有方向变体，
  //    提前堵住陷阱启动点；优先级高于普通进攻/普通防守/中心占位/随机落子。
  if (aiPlayer === WHITE) {
    var specDef = detectSpecificWhiteDefenseMove(board, opts.lastMove);
    if (specDef && !wouldLose(board, specDef.r, specDef.c, aiPlayer)) return specDef;
  }

  // 4. 通用两步陷阱预判：占据/破坏对手的二步陷阱启动点（优先于常规搜索）
  var trap = detectTwoStepTrapMove(board, aiPlayer, opp);
  if (trap && !wouldLose(board, trap.r, trap.c, aiPlayer)) return trap;

  var deadline = Date.now() + opts.budget;
  var cands = orderedCandidates(board, aiPlayer, opts.candLimit, aiPlayer);
  if (cands.length === 0) cands = legalMoves(board);
  if (cands.length === 0) return null;

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
function chooseHard(board, aiPlayer, opts) {
  opts = opts || {};
  return searchMove(board, aiPlayer, { maxPly: 3, candLimit: 10, budget: 350, lastMove: opts.lastMove });
}

// 大师：完整极小化极大 + Alpha-Beta + 候选剪枝 + 迭代加深（≥4 层）；不随机；控制计算时间
function chooseMaster(board, aiPlayer, opts) {
  opts = opts || {};
  return searchMove(board, aiPlayer, { maxPly: 4, candLimit: 12, budget: 700, lastMove: opts.lastMove });
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

  var move = fn(board, aiPlayer, opts);
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
  detectSpecificWhiteDefenseMove: detectSpecificWhiteDefenseMove,
  detectTwoStepTrapMove: detectTwoStepTrapMove,
  surroundProgress: surroundProgress,
  // 模板陷阱相关（测试 / 复用）
  TRAP_BASE_PATTERN: TRAP_BASE_PATTERN,
  TRAP_VARIANTS: TRAP_VARIANTS,
  TRAP_TRANSFORMS: TRAP_TRANSFORMS,
  generatePatternVariants: generatePatternVariants,
  matchPatternAroundPiece: matchPatternAroundPiece,
  getDefenseCell: getDefenseCell
};
