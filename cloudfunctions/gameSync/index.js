// gameSync — 联网对战对局同步云函数
// 路由：event.$url 决定调用哪个子函数；exports.main 负责分发。
const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

// 段位系统配置（与 miniprogram/utils/rank.js 同步；KEEP IN SYNC）
const RANKS = [
  { id: 0,  name: '棋童',     points: 0,     tier: 'beginner' },
  { id: 1,  name: '棋童一级',  points: 100,   tier: 'beginner' },
  { id: 2,  name: '棋童二级',  points: 300,   tier: 'beginner' },
  { id: 3,  name: '棋童三级',  points: 600,   tier: 'beginner' },
  { id: 4,  name: '业余10级',  points: 1000,  tier: 'kyu' },
  { id: 5,  name: '业余9级',   points: 1400,  tier: 'kyu' },
  { id: 6,  name: '业余8级',   points: 1800,  tier: 'kyu' },
  { id: 7,  name: '业余7级',   points: 2300,  tier: 'kyu' },
  { id: 8,  name: '业余6级',   points: 2800,  tier: 'kyu' },
  { id: 9,  name: '业余5级',   points: 3400,  tier: 'kyu' },
  { id: 10, name: '业余4级',   points: 4100,  tier: 'kyu' },
  { id: 11, name: '业余3级',   points: 4800,  tier: 'kyu' },
  { id: 12, name: '业余2级',   points: 5600,  tier: 'kyu' },
  { id: 13, name: '业余1级',   points: 6500,  tier: 'kyu' },
  { id: 14, name: '业余1段',   points: 7500,  tier: 'dan' },
  { id: 15, name: '业余2段',   points: 8800,  tier: 'dan' },
  { id: 16, name: '业余3段',   points: 10200, tier: 'dan' },
  { id: 17, name: '业余4段',   points: 11800, tier: 'dan' },
  { id: 18, name: '业余5段',   points: 13600, tier: 'dan' },
  { id: 19, name: '业余6段',   points: 15600, tier: 'dan' },
  { id: 20, name: '业余7段',   points: 17800, tier: 'dan' },
  { id: 21, name: '业余8段',   points: 20200, tier: 'dan' },
  { id: 22, name: '准大师',    points: 23000, tier: 'master' },
  { id: 23, name: '大师',      points: 26500, tier: 'master' },
  { id: 24, name: '宗师',      points: 30500, tier: 'master' },
  { id: 25, name: '棋圣',      points: 35000, tier: 'master' }
];

// 心跳超时阈值（毫秒）— 超过即判掉线方负
const HEARTBEAT_TIMEOUT_MS = 30000;
// 每步思考时限（毫秒）— 超过则由系统随机落子
const TURN_TIMEOUT_MS = 30000;
// 每位玩家每局可发起的免费悔棋次数
const UNDO_LIMIT_PER_PLAYER = 1;
// ELO K 因子与上下限
const ELO_K = 32;
const ELO_WIN_MIN = 10, ELO_WIN_MAX = 50;
const ELO_LOSS_MIN = -50, ELO_LOSS_MAX = -10;

const {
  createBoard,
  cloneBoard,
  canPlace,
  chooseRandomMove,
  placePiece,
  evaluateMove,
  BLACK,
  WHITE,
  opponent
} = require('./dango-logic');

// ===== 段位辅助 =====
function getRankIdByPoints(points) {
  points = Math.max(0, points || 0);
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (points >= RANKS[i].points) return RANKS[i].id;
  }
  return 0;
}
function getRankNameByPoints(points) {
  const id = getRankIdByPoints(points);
  return RANKS[id].name;
}

// ===== ELO 积分变化（含不降段规则）=====
// 返回 { delta, newPoints, oldRankId, newRankId, promoted }
function calcPointsChange(myPoints, oppPoints, isWin) {
  const expected = 1 / (1 + Math.pow(10, (oppPoints - myPoints) / 400));
  let delta;
  if (isWin) {
    delta = Math.round(ELO_K * (1 - expected));
    delta = Math.max(ELO_WIN_MIN, Math.min(ELO_WIN_MAX, delta));
  } else {
    delta = Math.round(ELO_K * (0 - expected));
    delta = Math.max(ELO_LOSS_MIN, Math.min(ELO_LOSS_MAX, delta));
  }
  const oldRankId = getRankIdByPoints(myPoints);
  let newPoints = Math.max(0, myPoints + delta);
  const newRankIdRaw = getRankIdByPoints(newPoints);
  let promoted = false;
  if (newRankIdRaw > oldRankId) {
    promoted = true;
  } else if (newRankIdRaw < oldRankId) {
    // 不降段：保持当前段位门槛积分
    newPoints = Math.max(newPoints, RANKS[oldRankId].points);
  }
  return {
    delta,
    newPoints,
    oldRankId,
    newRankId: getRankIdByPoints(newPoints),
    promoted
  };
}

// ===== 幂等：request_log 去重 =====
async function checkIdempotent(requestId) {
  if (!requestId) return { hit: false };
  try {
    const existing = await db.collection('request_log').where({ request_id: requestId }).limit(1).get();
    if (existing.data && existing.data.length > 0) {
      return { hit: true, result: existing.data[0].result };
    }
  } catch (e) {
    console.error('checkIdempotent error', e);
  }
  return { hit: false };
}
async function logRequest(requestId, action, result) {
  if (!requestId) return;
  try {
    await db.collection('request_log').add({
      data: {
        request_id: requestId,
        action,
        result,
        created_at: db.serverDate()
      }
    });
  } catch (e) {
    console.error('logRequest error', e);
  }
}

// ===== 心跳超时检查（懒检查）=====
// 返回 { disconnectedColor } 或 null
function checkOpponentHeartbeat(game, myColor) {
  const oppColor = myColor === 'black' ? 'white' : 'black';
  // AI 对手不发送心跳：跳过掉线判定，避免误判 AI 掉线判负
  if (game[oppColor + '_is_ai']) return null;
  const oppHeartbeat = game['last_heartbeat_' + oppColor];
  if (!oppHeartbeat) return null;
  let t;
  try {
    t = oppHeartbeat instanceof Date ? oppHeartbeat.getTime() : new Date(oppHeartbeat).getTime();
  } catch (e) {
    return null;
  }
  if (!t) return null;
  const elapsed = Date.now() - t;
  if (elapsed > HEARTBEAT_TIMEOUT_MS) return { disconnectedColor: oppColor };
  return null;
}

// ===== 获取游戏 =====
async function getGame(gameId) {
  const result = await db.collection("games").doc(gameId).get();
  if (!result.data) throw new Error("游戏不存在");
  return result.data;
}

// ===== 验证玩家身份 =====
function verifyPlayer(game, openid) {
  const isBlack = game.black_openid === openid;
  const isWhite = game.white_openid === openid;
  if (!isBlack && !isWhite) return null;
  return isBlack ? 'black' : 'white';
}

// 将云端返回的日期（Date / 字符串 / { $date }）统一转为时间戳
function getTimeStamp(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return new Date(v).getTime();
  if (v.$date) return new Date(v.$date).getTime();
  return 0;
}

// ===== 超时系统随机落子 =====
// 对当前行棋方执行一次随机合法落子（服务端权威，无需玩家身份）。
// 由客户端倒计时归零触发（timeoutMove）或服务端定时扫描（turnWatcher）调用。
async function performSystemMove(game, gameId, requestId) {
  const myColor = game.current_player;
  const playerPiece = myColor === 'black' ? BLACK : WHITE;
  const move = chooseRandomMove(game.board_state, playerPiece);
  if (!move) {
    // 棋盘已满（理论上极罕见）：仅切换行棋方，避免对局卡死
    await db.collection('games').doc(gameId).update({
      data: { current_player: myColor === 'black' ? 'white' : 'black', updated_at: db.serverDate() }
    });
    return { code: 200, message: '棋盘已满，已切换行棋方', data: { gameOver: false } };
  }
  return await applyMove(game, myColor, move.r, move.c, requestId, { isSystem: true });
}

// 统一的超时落子入口：先二次校验“确实已超时且对局进行中”，再执行随机落子。
// 这样即使客户端重复触发或服务端扫描并发，也只会产生一次有效落子。
async function doTimeoutMove(gameId) {
  const game = await getGame(gameId);
  if (!game || game.status !== 'playing') return { code: 400, message: '对局已结束' };
  const elapsed = Date.now() - getTimeStamp(game.last_move_time);
  if (elapsed <= TURN_TIMEOUT_MS) return { code: 400, message: '尚未超时' };
  const sysRequestId = 'sys_' + gameId + '_' + game.move_count;
  const idem = await checkIdempotent(sysRequestId);
  if (idem.hit) return idem.result;
  return await performSystemMove(game, gameId, sysRequestId);
}

exports.timeoutMove = async (event, context) => {
  const { gameId } = event;
  try {
    return await doTimeoutMove(gameId);
  } catch (error) {
    console.error('超时随机落子失败:', error);
    return { code: 500, message: '超时随机落子失败: ' + (error.message || error), data: null };
  }
};

// ===== 结束对局（通用）=====
async function finishGame(gameId, game, winner, reason, winTarget, winStones, winRule) {
  const updateData = {
    status: winner === 'black' ? 'black_win' : 'white_win',
    winner,
    winner_reason: reason,
    end_time: db.serverDate(),
    updated_at: db.serverDate()
  };
  if (winTarget) updateData.win_target = _.set(winTarget);
  if (winStones) updateData.win_stones = winStones;
  if (winRule !== undefined && winRule !== null) updateData.win_rule = winRule;
  await db.collection('games').doc(gameId).update({ data: updateData });
  // 更新玩家统计与积分
  const statsResult = await updatePlayerStats(game, winner, reason);
  // 把积分变化回写游戏文档
  await db.collection('games').doc(gameId).update({
    data: {
      points_delta_black: statsResult.blackDelta,
      points_delta_white: statsResult.whiteDelta,
      black_rank_after: statsResult.blackRankName,
      white_rank_after: statsResult.whiteRankName
    }
  });
  return statsResult;
}

// ===== 更新玩家统计与积分（ELO + 不降段）=====
async function updatePlayerStats(game, winner, reason) {
  const blackId = game.black_player_id;
  const whiteId = game.white_player_id;
  const blackDoc = await db.collection('players').doc(blackId).get();
  const whiteDoc = await db.collection('players').doc(whiteId).get();
  const black = blackDoc.data || {};
  const white = whiteDoc.data || {};

  const blackPoints = black.rankPoints || 0;
  const whitePoints = white.rankPoints || 0;
  const blackWon = winner === 'black';
  const whiteWon = winner === 'white';

  const blackChange = calcPointsChange(blackPoints, whitePoints, blackWon);
  const whiteChange = calcPointsChange(whitePoints, blackPoints, whiteWon);

  // 黑方更新
  const blackUpdate = {
    total_games: _.inc(1),
    rankPoints: blackChange.newPoints,
    rankName: getRankNameByPoints(blackChange.newPoints),
    updated_at: db.serverDate()
  };
  if (blackWon) {
    blackUpdate.wins = _.inc(1);
    blackUpdate.current_streak = _.inc(1);
  } else {
    blackUpdate.losses = _.inc(1);
    blackUpdate.current_streak = 0;
  }
  // best_streak
  const blackNewStreak = blackWon ? (black.current_streak || 0) + 1 : 0;
  if (blackNewStreak > (black.best_streak || 0)) blackUpdate.best_streak = blackNewStreak;

  // 白方更新
  const whiteUpdate = {
    total_games: _.inc(1),
    rankPoints: whiteChange.newPoints,
    rankName: getRankNameByPoints(whiteChange.newPoints),
    updated_at: db.serverDate()
  };
  if (whiteWon) {
    whiteUpdate.wins = _.inc(1);
    whiteUpdate.current_streak = _.inc(1);
  } else {
    whiteUpdate.losses = _.inc(1);
    whiteUpdate.current_streak = 0;
  }
  const whiteNewStreak = whiteWon ? (white.current_streak || 0) + 1 : 0;
  if (whiteNewStreak > (white.best_streak || 0)) whiteUpdate.best_streak = whiteNewStreak;

  // recent_games 摘要（最多 20 条）
  const now = Date.now();
  const blackSummary = {
    gameId: game._id,
    opponent: white.nickname || '对手',
    opponentRank: white.rankName || '棋童',
    won: blackWon,
    reason,
    pointsDelta: blackChange.delta,
    rankName: getRankNameByPoints(blackChange.newPoints),
    timestamp: now
  };
  const whiteSummary = {
    gameId: game._id,
    opponent: black.nickname || '对手',
    opponentRank: black.rankName || '棋童',
    won: whiteWon,
    reason,
    pointsDelta: whiteChange.delta,
    rankName: getRankNameByPoints(whiteChange.newPoints),
    timestamp: now
  };
  blackUpdate.recent_games = pushRecent(black.recent_games, blackSummary);
  whiteUpdate.recent_games = pushRecent(white.recent_games, whiteSummary);

  try { await db.collection('players').doc(blackId).update({ data: blackUpdate }); } catch (e) { console.error('更新黑方统计失败', e); }
  try { await db.collection('players').doc(whiteId).update({ data: whiteUpdate }); } catch (e) { console.error('更新白方统计失败', e); }

  return {
    blackDelta: blackChange.delta,
    whiteDelta: whiteChange.delta,
    blackRankName: getRankNameByPoints(blackChange.newPoints),
    whiteRankName: getRankNameByPoints(whiteChange.newPoints),
    blackPromoted: blackChange.promoted,
    whitePromoted: whiteChange.promoted
  };
}

function pushRecent(arr, item) {
  const list = Array.isArray(arr) ? arr.slice() : [];
  list.unshift(item);
  if (list.length > 20) list.length = 20;
  return list;
}

// ===== 主分发 =====
exports.main = async (event, context) => {
  const action = event.$url || event.action;
  if (action && typeof exports[action] === 'function' && action !== 'main') {
    try {
      return await exports[action](event, context);
    } catch (err) {
      console.error(`[gameSync.${action}] error:`, err);
      return { code: 500, message: '服务器错误: ' + (err.message || err), data: null };
    }
  }
  return { code: 400, message: '未知操作: ' + action, data: null };
};

// ===== 落子 =====
exports.makeMove = async (event, context) => {
  const { gameId, row, col, requestId, sessionId, asAI, asAIColor } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  // 幂等检查
  const idem = await checkIdempotent(requestId);
  if (idem.hit) return idem.result;

  try {
    const game = await getGame(gameId);

    // 玩家身份（或 AI 代理落子）
    let myColor;
    if (asAI) {
      // AI 落子由人类客户端代理提交：校验发起方是对局另一方真人，且颜色确为 AI
      const humanColor = asAIColor === 'black' ? 'white' : 'black';
      const humanOpenid = game[humanColor + '_openid'];
      if (openid !== humanOpenid) {
        return { code: 403, message: '您不是该游戏的另一方玩家，无法代理 AI 落子', data: null };
      }
      if (!game[asAIColor + '_is_ai']) {
        return { code: 400, message: '该颜色不是 AI 玩家', data: null };
      }
      // AI 落子跳过 session / 多设备校验
      myColor = asAIColor;
    } else {
      const myColorTmp = verifyPlayer(game, openid);
      if (!myColorTmp) return { code: 403, message: '您不是该游戏的玩家', data: null };
      myColor = myColorTmp;

      // 多设备 session 校验
      if (sessionId && game[myColor + '_session'] && game[myColor + '_session'] !== sessionId) {
        return { code: 409, message: '已在其他设备登录', data: null };
      }
    }

    // 对局状态
    if (game.status !== 'playing') {
      return { code: 400, message: '对局已结束', data: null };
    }

    // 回合校验
    if (game.current_player !== myColor) {
      return { code: 400, message: '现在不是您的回合', data: null };
    }

    // 位置校验
    if (!canPlace(game.board_state, row, col)) {
      return { code: 400, message: '该位置不能落子', data: null };
    }

    return await applyMove(game, myColor, row, col, requestId, { sessionId: sessionId, isSystem: false });
  } catch (error) {
    console.error('落子失败:', error);
    const response = { code: 500, message: '落子失败: ' + (error.message || error), data: null };
    await logRequest(requestId, 'makeMove', response);
    return response;
  }
};

// 统一的落子执行（玩家 / AI 代理 / 超时系统 共用）。
// 调用前应已完成身份、状态、回合、位置等校验。
async function applyMove(game, myColor, row, col, requestId, opts) {
  opts = opts || {};
  const gameId = game._id;
  const sessionId = opts.sessionId;

  const newBoard = cloneBoard(game.board_state);
  const playerPiece = myColor === 'black' ? BLACK : WHITE;
  placePiece(newBoard, row, col, playerPiece);

  // 规则判定（统一引擎，顺序：规则三 → 规则四 → 规则一/二）
  const result = evaluateMove(newBoard, row, col, playerPiece);

  let gameResult = 'playing';
  let winner = null;
  let winnerReason = null;
  let winTarget = null;
  let winStones = null;
  let winRule = null;

  if (result.gameOver) {
    // dango-logic 返回数值棋子(1=黑/2=白)，此处转为字符串颜色供后续逻辑使用
    winner = result.winner === BLACK ? 'black' : 'white';
    winnerReason = result.reason;
    winRule = result.rule;
    if (result.winTarget) winTarget = result.winTarget;
    if (result.winStones) winStones = result.winStones;
    gameResult = winner === 'black' ? 'black_win' : 'white_win';
  }

  // 更新游戏状态
  const updateData = {
    board_state: newBoard,
    current_player: myColor === 'black' ? 'white' : 'black',
    move_count: game.move_count + 1,
    last_move: { row, col, player: myColor },
    last_move_time: db.serverDate(),
    [`last_heartbeat_${myColor}`]: db.serverDate(),
    updated_at: db.serverDate()
  };
  if (sessionId) updateData[myColor + '_session'] = sessionId;

  if (gameResult !== 'playing') {
    updateData.status = gameResult;
    updateData.winner = winner;
    updateData.winner_reason = winnerReason;
    updateData.end_time = db.serverDate();
    if (winTarget) updateData.win_target = _.set(winTarget);
    if (winStones) updateData.win_stones = winStones;
    if (winRule !== null) updateData.win_rule = winRule;
  }

  await db.collection('games').doc(gameId).update({ data: updateData });

  // 记录棋步
  const moveData = {
    game_id: gameId,
    move_number: game.move_count + 1,
    player: myColor,
    row,
    col,
    piece: playerPiece,
    timestamp: db.serverDate(),
    board_state_before: game.board_state,
    board_state_after: newBoard,
    game_result: gameResult,
    is_undo: false,
    is_timeout: !!opts.isSystem,
    created_at: db.serverDate()
  };
  await db.collection('moves').add({ data: moveData });

  // 游戏结束 → 结算
  let statsResult = null;
  if (gameResult !== 'playing') {
    statsResult = await updatePlayerStats({ ...game, _id: gameId }, winner, winnerReason);
    await db.collection('games').doc(gameId).update({
      data: {
        points_delta_black: statsResult.blackDelta,
        points_delta_white: statsResult.whiteDelta,
        black_rank_after: statsResult.blackRankName,
        white_rank_after: statsResult.whiteRankName
      }
    });
  }

  const response = {
    code: 200,
    message: '落子成功',
    data: {
      game: { ...game, ...updateData, _id: gameId },
      move: moveData,
      gameOver: gameResult !== 'playing',
      winner,
      winnerReason,
      winTarget,
      winStones,
      winRule,
      stats: statsResult
    }
  };
  await logRequest(requestId, 'makeMove', response);
  return response;
}

// ===== 悔棋请求 =====
exports.requestUndo = async (event, context) => {
  const { gameId, targetMoveNumber, requestId } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const idem = await checkIdempotent(requestId);
  if (idem.hit) return idem.result;

  try {
    const game = await getGame(gameId);
    const myColor = verifyPlayer(game, openid);
    if (!myColor) return { code: 403, message: '您不是该游戏的玩家', data: null };

    if (game.status !== 'playing') {
      return { code: 400, message: '游戏已结束，无法悔棋', data: null };
    }

    // 悔棋次数限制（每局每玩家 1 次免费）
    const usedKey = 'undo_used_' + myColor;
    if ((game[usedKey] || 0) >= UNDO_LIMIT_PER_PLAYER) {
      return { code: 400, message: '本局悔棋次数已用完', data: null };
    }

    // 已有自己发起的待处理请求
    const existing = await db.collection('undo_requests').where({
      game_id: gameId,
      requester: myColor,
      status: 'pending'
    }).limit(1).get();
    if (existing.data && existing.data.length > 0) {
      return { code: 400, message: '已有待处理的悔棋请求', data: null };
    }

    if (targetMoveNumber < 1 || targetMoveNumber >= game.move_count) {
      return { code: 400, message: '无效的悔棋步数', data: null };
    }

    const undoRequest = {
      game_id: gameId,
      requester: myColor,
      requester_openid: openid,
      target_move_number: targetMoveNumber,
      status: 'pending',
      created_at: db.serverDate(),
      updated_at: db.serverDate()
    };
    const result = await db.collection('undo_requests').add({ data: undoRequest });

    // 递增该玩家本局悔棋发起次数
    const inc = {};
    inc[usedKey] = _.inc(1);
    await db.collection('games').doc(gameId).update({ data: inc });

    const response = {
      code: 200,
      message: '悔棋请求已发送',
      data: { ...undoRequest, _id: result._id }
    };
    await logRequest(requestId, 'requestUndo', response);
    return response;
  } catch (error) {
    console.error('发送悔棋请求失败:', error);
    const response = { code: 500, message: '发送悔棋请求失败', data: null };
    await logRequest(requestId, 'requestUndo', response);
    return response;
  }
};

// ===== 处理悔棋请求 =====
exports.handleUndo = async (event, context) => {
  const { requestId: undoRequestId, idemRequestId, approve } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const idem = await checkIdempotent(idemRequestId);
  if (idem.hit) return idem.result;

  try {
    const request = await db.collection('undo_requests').doc(undoRequestId).get();
    if (!request.data) return { code: 404, message: '悔棋请求不存在', data: null };
    const undoRequest = request.data;

    const game = await db.collection('games').doc(undoRequest.game_id).get();
    if (!game.data) return { code: 404, message: '游戏不存在', data: null };
    const gameData = game.data;

    const myColor = verifyPlayer(gameData, openid);
    if (!myColor) return { code: 403, message: '您不是该游戏的玩家', data: null };
    if (myColor === undoRequest.requester) {
      return { code: 400, message: '不能响应自己的悔棋请求', data: null };
    }

    // 更新悔棋请求状态
    await db.collection('undo_requests').doc(undoRequestId).update({
      data: {
        status: approve ? 'approved' : 'rejected',
        response_by: myColor,
        response_time: db.serverDate(),
        updated_at: db.serverDate()
      }
    });

    if (approve) {
      // 获取目标步数的棋盘状态
      const targetMove = await db.collection('moves')
        .where({ game_id: undoRequest.game_id, move_number: undoRequest.target_move_number })
        .limit(1).get();
      if (targetMove.data.length === 0) {
        return { code: 404, message: '目标步数不存在', data: null };
      }
      const targetBoardState = targetMove.data[0].board_state_after;
      const newMoveCount = undoRequest.target_move_number;
      const newCurrentPlayer = newMoveCount % 2 === 0 ? 'white' : 'black';

      await db.collection('games').doc(undoRequest.game_id).update({
        data: {
          board_state: targetBoardState,
          move_count: newMoveCount,
          current_player: newCurrentPlayer,
          updated_at: db.serverDate()
        }
      });

      // 标记已撤销的棋步
      const movesToUndo = await db.collection('moves')
        .where({
          game_id: undoRequest.game_id,
          move_number: _.gt(undoRequest.target_move_number),
          is_undo: false
        })
        .get();
      for (const move of movesToUndo.data) {
        await db.collection('moves').doc(move._id).update({
          data: { is_undo: true, updated_at: db.serverDate() }
        });
      }
    }

    const response = {
      code: 200,
      message: approve ? '已同意悔棋' : '已拒绝悔棋',
      data: { request: undoRequest, approved: approve }
    };
    await logRequest(idemRequestId, 'handleUndo', response);
    return response;
  } catch (error) {
    console.error('处理悔棋请求失败:', error);
    const response = { code: 500, message: '处理悔棋请求失败', data: null };
    await logRequest(idemRequestId, 'handleUndo', response);
    return response;
  }
};

// ===== 认输 =====
exports.resignGame = async (event, context) => {
  const { gameId, requestId } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  const idem = await checkIdempotent(requestId);
  if (idem.hit) return idem.result;

  try {
    const game = await getGame(gameId);
    const myColor = verifyPlayer(game, openid);
    if (!myColor) return { code: 403, message: '您不是该游戏的玩家', data: null };
    if (game.status !== 'playing') {
      return { code: 400, message: '游戏已结束', data: null };
    }

    const winner = myColor === 'black' ? 'white' : 'black';
    const statsResult = await finishGame(gameId, game, winner, 'resign', null, null, null);

    const response = {
      code: 200,
      message: '认输成功',
      data: { winner, resigningPlayer: myColor, stats: statsResult }
    };
    await logRequest(requestId, 'resignGame', response);
    return response;
  } catch (error) {
    console.error('认输失败:', error);
    const response = { code: 500, message: '认输失败', data: null };
    await logRequest(requestId, 'resignGame', response);
    return response;
  }
};

// ===== 获取游戏状态 =====
exports.getGameStatus = async (event, context) => {
  const { gameId, sessionId } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  try {
    const game = await getGame(gameId);
    const myColor = verifyPlayer(game, openid);
    if (!myColor) return { code: 403, message: '您不是该游戏的玩家', data: null };

    // 懒检查对方心跳（对局进行中）
    let disconnected = false;
    if (game.status === 'playing') {
      const hb = checkOpponentHeartbeat(game, myColor);
      if (hb) {
        // 对方掉线判负
        const winner = myColor;
        await finishGame(gameId, game, winner, 'disconnect', null, null, null);
        const refreshed = await getGame(gameId);
        return {
          code: 200,
          message: '获取游戏状态成功',
          data: {
            game: refreshed,
            recentMoves: [],
            pendingUndoRequests: [],
            disconnected: true
          }
        };
      }
    }

    // 同步 session（首次进入或重连时绑定）
    if (sessionId && game[myColor + '_session'] !== sessionId) {
      const sUpdate = {};
      sUpdate[myColor + '_session'] = sessionId;
      sUpdate['last_heartbeat_' + myColor] = db.serverDate();
      try {
        await db.collection('games').doc(gameId).update({ data: sUpdate });
      } catch (e) { /* ignore */ }
    }

    const recentMoves = await db.collection('moves')
      .where({ game_id: gameId, is_undo: false })
      .orderBy('move_number', 'desc')
      .limit(10)
      .get();

    const pendingUndoRequests = await db.collection('undo_requests')
      .where({ game_id: gameId, status: 'pending' })
      .get();

    return {
      code: 200,
      message: '获取游戏状态成功',
      data: {
        game,
        recentMoves: recentMoves.data,
        pendingUndoRequests: pendingUndoRequests.data,
        myColor
      }
    };
  } catch (error) {
    console.error('获取游戏状态失败:', error);
    return { code: 500, message: '获取游戏状态失败', data: null };
  }
};

// ===== 心跳 =====
exports.heartbeat = async (event, context) => {
  const { gameId, sessionId } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  try {
    const game = await getGame(gameId);
    const myColor = verifyPlayer(game, openid);
    if (!myColor) return { code: 403, message: '您不是该游戏的玩家', data: null };

    if (game.status !== 'playing') {
      return { code: 200, message: '对局已结束', data: { gameOver: true, game } };
    }

    // session 校验（多设备）
    if (sessionId && game[myColor + '_session'] && game[myColor + '_session'] !== sessionId) {
      return { code: 409, message: '已在其他设备登录', data: null };
    }

    // 检查对方心跳
    const hb = checkOpponentHeartbeat(game, myColor);
    if (hb) {
      const winner = myColor;
      const statsResult = await finishGame(gameId, game, winner, 'disconnect', null, null, null);
      return {
        code: 200,
        message: '对手掉线',
        data: { gameOver: true, winner, reason: 'disconnect', stats: statsResult }
      };
    }

    // 更新自己的心跳与 session
    const update = {};
    update['last_heartbeat_' + myColor] = db.serverDate();
    if (sessionId) update[myColor + '_session'] = sessionId;
    await db.collection('games').doc(gameId).update({ data: update });

    return { code: 200, message: 'ok', data: { gameOver: false } };
  } catch (error) {
    console.error('心跳失败:', error);
    return { code: 500, message: '心跳失败', data: null };
  }
};

// ===== 再来一局：构建新对局（交换黑白方，并保留 AI 标记） =====
function buildRematchGame(oldGame) {
  const boardSize = oldGame.board_size || 15;
  const newBoard = createBoard(boardSize);
  const aiWasBlack = !!oldGame.black_is_ai;
  const aiWasWhite = !!oldGame.white_is_ai;
  let aiColor = null;
  let aiUserId = null;
  if (aiWasWhite) { aiColor = 'black'; aiUserId = oldGame.white_openid; }
  else if (aiWasBlack) { aiColor = 'white'; aiUserId = oldGame.black_openid; }
  return {
    board_size: boardSize,
    board_state: newBoard,
    current_player: 'black',
    move_count: 0,
    status: 'playing',
    // 交换黑白方
    black_openid: oldGame.white_openid,
    black_player_id: oldGame.white_player_id,
    black_nickname: oldGame.white_nickname,
    black_avatar: oldGame.white_avatar,
    black_rank_name: oldGame.white_rank_name,
    white_openid: oldGame.black_openid,
    white_player_id: oldGame.black_player_id,
    white_nickname: oldGame.black_nickname,
    white_avatar: oldGame.black_avatar,
    white_rank_name: oldGame.black_rank_name,
    // AI 标记：交换后保持 AI 在对应一方
    black_is_ai: aiWasWhite,
    white_is_ai: aiWasBlack,
    ai_level: oldGame.ai_level || null,
    ai_color: aiColor,
    ai_user_id: aiUserId,
    winner: null,
    winner_reason: null,
    win_target: { r: null, c: null },
    win_stones: [],
    win_rule: null,
    start_time: db.serverDate(),
    end_time: null,
    last_move_time: db.serverDate(),
    last_heartbeat_black: db.serverDate(),
    last_heartbeat_white: db.serverDate(),
    black_session: null,
    white_session: null,
    undo_used_black: 0,
    undo_used_white: 0,
    disconnect_status: { black: false, white: false },
    points_delta_black: 0,
    points_delta_white: 0,
    created_at: db.serverDate(),
    updated_at: db.serverDate()
  };
}

// ===== 再来一局：发起邀请 =====
exports.inviteRematch = async (event, context) => {
  const { gameId } = event;
  const openid = cloud.getWXContext().OPENID;

  try {
    const game = await getGame(gameId);
    const myColor = verifyPlayer(game, openid);
    if (!myColor) return { code: 403, message: '您不是该游戏的玩家', data: null };
    if (game.status === 'playing') {
      return { code: 400, message: '对局仍在进行', data: null };
    }

    const toOpenid = myColor === 'black' ? game.white_openid : game.black_openid;
    const toColor = myColor === 'black' ? 'white' : 'black';
    const toIsAI = !!game[toColor + '_is_ai'];

    // AI 对手：无需对方同意，直接开新局（黑白交换）
    if (toIsAI) {
      const newGame = buildRematchGame(game);
      const res = await db.collection('games').add({ data: newGame });
      return {
        code: 200,
        message: '已开始新对局',
        data: { gameId: res._id, aiRematch: true }
      };
    }

    // 已有 pending 邀请
    const existing = await db.collection('game_invitations').where({
      from_openid: openid,
      game_id: gameId,
      status: 'pending'
    }).limit(1).get();
    if (existing.data && existing.data.length > 0) {
      return { code: 400, message: '已发送邀请，等待对方响应', data: existing.data[0] };
    }

    const inv = {
      game_id: gameId,
      from_openid: openid,
      from_color: myColor,
      to_openid: toOpenid,
      status: 'pending',
      created_at: db.serverDate(),
      expires_at: db.serverDate({ offset: 15000 })
    };
    const res = await db.collection('game_invitations').add({ data: inv });

    return { code: 200, message: '邀请已发送', data: { _id: res._id, ...inv } };
  } catch (error) {
    console.error('发起再来一局失败:', error);
    return { code: 500, message: '发起再来一局失败', data: null };
  }
};

// ===== 再来一局：响应邀请 =====
exports.respondRematch = async (event, context) => {
  const { invitationId, accept } = event;
  const openid = cloud.getWXContext().OPENID;

  try {
    const invDoc = await db.collection('game_invitations').doc(invitationId).get();
    if (!invDoc.data) return { code: 404, message: '邀请不存在', data: null };
    const inv = invDoc.data;
    if (inv.to_openid !== openid) return { code: 403, message: '无权响应此邀请', data: null };
    if (inv.status !== 'pending') return { code: 400, message: '邀请已处理', data: null };

    if (!accept) {
      await db.collection('game_invitations').doc(invitationId).update({
        data: { status: 'rejected', responded_at: db.serverDate() }
      });
      return { code: 200, message: '已拒绝再来一局', data: { accepted: false } };
    }

    // 同意 → 创建新房间（黑白交换）
    const oldGame = await getGame(inv.game_id);
    const newGame = buildRematchGame(oldGame);
    const res = await db.collection('games').add({ data: newGame });
    await db.collection('game_invitations').doc(invitationId).update({
      data: { status: 'accepted', new_game_id: res._id, responded_at: db.serverDate() }
    });

    return { code: 200, message: '已同意再来一局', data: { gameId: res._id, accepted: true } };
  } catch (error) {
    console.error('响应再来一局失败:', error);
    return { code: 500, message: '响应再来一局失败', data: null };
  }
};

// ===== 最近战绩 =====
exports.getRecentGames = async (event, context) => {
  const openid = cloud.getWXContext().OPENID;

  try {
    // 优先从 players.recent_games 读取（已摘要）
    const playerDoc = await db.collection('players').where({ openid }).limit(1).get();
    if (playerDoc.data && playerDoc.data.length > 0 && Array.isArray(playerDoc.data[0].recent_games)) {
      return { code: 200, message: 'ok', data: { games: playerDoc.data[0].recent_games } };
    }
    // 回退：查 games 集合
    const res = await db.collection('games').where(_.or([
      { black_openid: openid },
      { white_openid: openid }
    ])).orderBy('created_at', 'desc').limit(20).get();

    const list = res.data.map(g => {
      const isBlack = g.black_openid === openid;
      const myColor = isBlack ? 'black' : 'white';
      const won = g.winner === myColor;
      return {
        gameId: g._id,
        won,
        opponent: isBlack ? g.white_nickname : g.black_nickname,
        opponentRank: isBlack ? g.white_rank_name : g.black_rank_name,
        reason: g.winner_reason,
        moveCount: g.move_count,
        pointsDelta: isBlack ? (g.points_delta_black || 0) : (g.points_delta_white || 0),
        rankName: isBlack ? (g.black_rank_after || g.black_rank_name) : (g.white_rank_after || g.white_rank_name),
        timestamp: g.created_at
      };
    });
    return { code: 200, message: 'ok', data: { games: list } };
  } catch (error) {
    console.error('获取最近战绩失败:', error);
    return { code: 500, message: '获取最近战绩失败', data: null };
  }
};
