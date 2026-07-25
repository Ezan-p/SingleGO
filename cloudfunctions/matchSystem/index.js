const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

// 段位系统配置（与 matchChecker / gameSync 同步）
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

// ===== AI 模拟用户（超时匹配） =====
// AI 头像使用微信默认头像
const AI_DEFAULT_AVATAR = "https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0";
// AI 昵称池（随机取一个，显示为普通玩家）
const AI_NICKNAMES = [
  "棋韵清风", "落子无悔", "玄机妙手", "星河棋客", "淡墨棋盘",
  "无名高手", "孤影棋仙", "云中落子", "半山听雨", "弈海渔樵",
  "寒江独钓", "碧落棋缘", "九天揽月", "静水流深", "竹影棋声"
];
// AI 难度按玩家段位档位映射（始终 ≥ normal）
// beginner(棋童等) → normal；kyu(业余级)/dan(业余段) → hard；master(准大师/大师/宗师/棋圣) → master
const AI_LEVEL_BY_TIER = {
  beginner: "normal",
  kyu: "hard",
  dan: "hard",
  master: "master"
};

// 按段位积分取 AI 难度
function getAILevelByPlayerRank(rankPoints) {
  const rank = getRankByPoints(rankPoints || 0);
  return AI_LEVEL_BY_TIER[rank.tier] || "normal";
}

// 生成 AI 资料：随机昵称/头像/段位，难度按玩家段位映射，始终 ≥ normal
function generateAIProfile(rankPoints) {
  const nickname = AI_NICKNAMES[Math.floor(Math.random() * AI_NICKNAMES.length)];
  const aiLevel = getAILevelByPlayerRank(rankPoints);
  // 段位名称随难度档位随机抽取，显示为普通玩家
  let rankName;
  if (aiLevel === "master") {
    const pool = RANKS.filter(r => r.tier === "master");
    rankName = pool[Math.floor(Math.random() * pool.length)].name;
  } else if (aiLevel === "hard") {
    const pool = RANKS.filter(r => r.tier === "kyu" || r.tier === "dan");
    rankName = pool[Math.floor(Math.random() * pool.length)].name;
  } else {
    const pool = RANKS.filter(r => r.tier === "beginner");
    rankName = pool[Math.floor(Math.random() * pool.length)].name;
  }
  const userId = "ai_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  return { userId, isAI: true, nickname, avatar: AI_DEFAULT_AVATAR, rank: rankName, aiLevel };
}

// 判定对局是否已“被放弃”：仅当参与双方心跳均超时才算放弃。
// AI 一方不发送心跳，因此 AI 对局只对真人一方的掉线敏感。
const STALE_GAME_MS = 60000; // 比普通心跳超时(30s)宽松，避免误判短暂断网
function isHeartbeatStale(hb, isAI) {
  if (isAI) return false;
  if (!hb) return true;
  let t;
  try {
    t = hb instanceof Date ? hb.getTime() : new Date(hb).getTime();
  } catch (e) {
    return true;
  }
  if (!t) return true;
  return (Date.now() - t) > STALE_GAME_MS;
}

// 查找当前用户“进行中”的对局：若双方均已掉线/放弃（心跳都超时）则直接结束该孤儿对局，
// 释放其匹配资格；返回 { hasActiveGame, activeGameId }，activeGameId 为仍有效进行中的对局（用于客户端自动回到该局）。
// 关键：以“用户本人是否仍在线”为准——只要用户自己的心跳超时，即视为其已离开该局，直接结束（对方获胜）
// 并释放匹配资格；仅在用户仍在线（心跳新鲜）时才视为有效进行中并予以拦截。
// 这样即使是“人机/人人对局中对方仍在线、但用户已离开”的孤儿对局，也不会再卡住用户重新匹配。
async function resolveStaleGames(openid) {
  const playing = await db.collection("games").where({
    $or: [
      { black_openid: openid, status: "playing" },
      { white_openid: openid, status: "playing" }
    ]
  }).get();
  let hasActiveGame = false;
  let activeGameId = null;
  for (const g of playing.data) {
    const myColor = g.black_openid === openid ? "black" : "white";
    const myIsAI = !!g[myColor + "_is_ai"]; // 用户不会是 AI，仅作保险
    const myStale = isHeartbeatStale(g["last_heartbeat_" + myColor], myIsAI);
    if (myStale) {
      // 用户本人已掉线/放弃该对局 → 结束它（对方获胜），释放匹配资格
      try {
        await db.collection("games").doc(g._id).update({
          data: {
            status: "abandoned",
            end_time: db.serverDate(),
            winner: myColor === "black" ? "white" : "black",
            winner_reason: "abandoned",
            updated_at: db.serverDate()
          }
        });
      } catch (e) {
        console.error("清理孤儿对局失败:", e);
      }
    } else {
      hasActiveGame = true;
      activeGameId = g._id;
    }
  }
  return { hasActiveGame, activeGameId };
}

// 超时匹配：为玩家分配 AI 模拟用户（真人未匹配成功时调用）
// 边界规则：若已匹配真人 / 已在进行中的对局 → 返回 409（真人优先，避免重复房间）
exports.createAIMatch = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;

  try {
    const player = await getPlayerInfo(openid);

    // 边界1：已取得真人匹配房间 → 真人优先
    const existingMatched = await db.collection("match_queue").where({
      openid: openid,
      status: "matched"
    }).get();
    if (existingMatched.data.length > 0) {
      return {
        code: 409,
        message: "已匹配真人对手",
        data: { gameId: existingMatched.data[0].matched_game_id }
      };
    }

    // 边界2：已在进行中的对局（自动清理用户已放弃的孤儿对局）
    const { hasActiveGame, activeGameId } = await resolveStaleGames(openid);
    if (hasActiveGame) {
      return {
        code: 409,
        message: "已存在进行中的对局",
        data: { gameId: activeGameId }
      };
    }

    // 超时后不再等待真人：将仍在等待的队列标记为 ai_timeout
    await db.collection("match_queue").where({
      openid: openid,
      status: "waiting"
    }).update({
      data: { status: "ai_timeout", updated_at: db.serverDate() }
    });

    // 生成 AI 资料
    const ai = generateAIProfile(player.rankPoints || 0);

    // 创建 AI 玩家记录（用于积分/统计；AI 无需真实授权）
    const aiPlayerDoc = {
      openid: ai.userId,
      nickname: ai.nickname,
      avatar: ai.avatar,
      elo_rating: 1200,
      rankPoints: player.rankPoints || 0,
      rankName: ai.rank,
      is_ai: true,
      ai_level: ai.aiLevel,
      total_games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      created_at: db.serverDate(),
      updated_at: db.serverDate()
    };
    const aiAdd = await db.collection("players").add({ data: aiPlayerDoc });
    const aiPlayerId = aiAdd._id;

    // 随机分配黑白方
    const humanIsBlack = Math.random() > 0.5;
    let blackPlayer, whitePlayer, blackIsAI, whiteIsAI, aiColor;
    if (humanIsBlack) {
      blackPlayer = { player_id: player._id, openid: openid, nickname: player.nickname, avatar: player.avatar, rankName: player.rankName || "棋童" };
      whitePlayer = { player_id: aiPlayerId, openid: ai.userId, nickname: ai.nickname, avatar: ai.avatar, rankName: ai.rank };
      blackIsAI = false; whiteIsAI = true; aiColor = "white";
    } else {
      blackPlayer = { player_id: aiPlayerId, openid: ai.userId, nickname: ai.nickname, avatar: ai.avatar, rankName: ai.rank };
      whitePlayer = { player_id: player._id, openid: openid, nickname: player.nickname, avatar: player.avatar, rankName: player.rankName || "棋童" };
      blackIsAI = true; whiteIsAI = false; aiColor = "black";
    }

    const boardSize = 15;
    const board = [];
    for (let i = 0; i < boardSize; i++) board.push(new Array(boardSize).fill(0));

    const gameData = {
      board_size: boardSize,
      board_state: board,
      current_player: "black",
      move_count: 0,
      status: "playing",
      winner: null,
      winner_reason: null,
      win_target: { r: null, c: null },
      win_stones: [],
      win_rule: null,
      black_player_id: blackPlayer.player_id,
      white_player_id: whitePlayer.player_id,
      black_openid: blackPlayer.openid,
      white_openid: whitePlayer.openid,
      black_nickname: blackPlayer.nickname,
      white_nickname: whitePlayer.nickname,
      black_avatar: blackPlayer.avatar,
      white_avatar: whitePlayer.avatar,
      black_rank_name: blackPlayer.rankName,
      white_rank_name: whitePlayer.rankName,
      // AI 标记（对局页与 gameSync 据此识别 AI 对手）
      black_is_ai: blackIsAI,
      white_is_ai: whiteIsAI,
      ai_level: ai.aiLevel,
      ai_color: aiColor,
      ai_user_id: ai.userId,
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
      black_rank_after: null,
      white_rank_after: null,
      created_at: db.serverDate(),
      updated_at: db.serverDate()
    };

    const result = await db.collection("games").add({ data: gameData });

    return {
      code: 200,
      message: "已为你匹配对手",
      data: {
        game: { ...gameData, _id: result._id },
        aiColor,
        aiLevel: ai.aiLevel
      }
    };
  } catch (error) {
    console.error("创建 AI 对局失败:", error);
    return {
      code: 500,
      message: "创建 AI 对局失败: " + (error.message || error),
      data: null
    };
  }
};

// 段位查询（与 matchChecker / gameSync 对齐）
function getRankByPoints(points) {
  points = Math.max(0, points || 0);
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (points >= RANKS[i].points) return RANKS[i];
  }
  return RANKS[0];
}

// 获取玩家信息
async function getPlayerInfo(openid) {
  try {
    const result = await db.collection("players").where({
      openid: openid
    }).get();
    
    if (result.data.length > 0) {
      return result.data[0];
    }
    
    // 如果玩家不存在，创建新玩家记录
    const wxContext = cloud.getWXContext();
    const userInfo = await cloud.callFunction({
      name: "getOpenId",
    });
    
    const newPlayer = {
      openid: openid,
      nickname: `玩家${Math.random().toString(36).substr(2, 6)}`,
      avatar: "https://mmbiz.qpic.cn/mmbiz/icTdbqWNOwNRna42FI242Lcia07jQodd2FJGIYQfG0LAJGFxM4FbnQP6yfMxBgJ0F3YRqJCJ1aPAK2dQagdusBZg/0",
      elo_rating: 1200,
      rankPoints: 0,
      rankName: '棋童',
      total_games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      created_at: db.serverDate(),
      updated_at: db.serverDate()
    };
    
    const addResult = await db.collection("players").add({
      data: newPlayer
    });
    
    return {
      ...newPlayer,
      _id: addResult._id
    };
  } catch (error) {
    console.error("获取玩家信息失败:", error);
    throw error;
  }
}

// 主分发：根据 event.$url 路由到子函数；无 $url 时默认加入匹配队列
exports.main = async (event, context) => {
  const action = event.$url || event.action;
  if (action && action !== 'main' && typeof exports[action] === 'function') {
    try {
      return await exports[action](event, context);
    } catch (err) {
      console.error(`[matchSystem.${action}] error:`, err);
      return { code: 500, message: '服务器错误: ' + (err.message || err), data: null };
    }
  }
  // 默认：加入匹配队列
  return exports.joinMatch(event, context);
};

// 加入匹配队列
exports.joinMatch = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  
  try {
    // 获取玩家信息
    const player = await getPlayerInfo(openid);
    
    // 检查玩家是否已经在队列中
    const queueCheck = await db.collection("match_queue").where({
      openid: openid,
      status: "waiting"
    }).get();
    
    if (queueCheck.data.length > 0) {
      return {
        code: 400,
        message: "您已经在匹配队列中",
        data: queueCheck.data[0]
      };
    }
    
    // 检查玩家是否正在游戏中（自动清理用户已放弃的孤儿对局）
    const { hasActiveGame, activeGameId } = await resolveStaleGames(openid);
    if (hasActiveGame) {
      return {
        code: 400,
        message: "您正在进行游戏，无法匹配",
        data: { gameId: activeGameId }
      };
    }
    
    // 加入匹配队列
    const queueData = {
      player_id: player._id,
      openid: openid,
      nickname: player.nickname,
      avatar: player.avatar,
      elo_rating: player.elo_rating,
      rankPoints: player.rankPoints || 0,
      rankName: player.rankName || '棋童',
      join_time: db.serverDate(),
      status: "waiting",
      created_at: db.serverDate()
    };
    
    const result = await db.collection("match_queue").add({
      data: queueData
    });
    
    // 触发匹配检查
    await cloud.callFunction({
      name: "matchChecker",
      data: {}
    });
    
    return {
      code: 200,
      message: "已加入匹配队列",
      data: {
        ...queueData,
        _id: result._id
      }
    };
  } catch (error) {
    console.error("加入匹配队列失败:", error);
    return {
      code: 500,
      message: "加入匹配队列失败",
      data: null
    };
  }
};

// 取消匹配
exports.cancelMatch = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  
  try {
    const result = await db.collection("match_queue").where({
      openid: openid,
      status: "waiting"
    }).update({
      data: {
        status: "cancelled",
        updated_at: db.serverDate()
      }
    });
    
    if (result.stats.updated === 0) {
      return {
        code: 404,
        message: "未找到匹配记录",
        data: null
      };
    }
    
    return {
      code: 200,
      message: "已取消匹配",
      data: result
    };
  } catch (error) {
    console.error("取消匹配失败:", error);
    return {
      code: 500,
      message: "取消匹配失败",
      data: null
    };
  }
};

// 获取匹配状态
exports.getMatchStatus = async (event, context) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  
  try {
    const result = await db.collection("match_queue").where({
      openid: openid,
      status: _.in(["waiting", "matched"])
    }).get();
    
    if (result.data.length === 0) {
      return {
        code: 404,
        message: "未找到匹配记录",
        data: null
      };
    }
    
    const matchRecord = result.data[0];
    
    if (matchRecord.status === "matched" && matchRecord.matched_game_id) {
      // 获取游戏详情
      const gameResult = await db.collection("games").doc(matchRecord.matched_game_id).get();
      
      return {
        code: 200,
        message: "匹配成功",
        data: {
          match: matchRecord,
          game: gameResult.data
        }
      };
    }
    
    return {
      code: 200,
      message: "正在匹配中",
      data: {
        match: matchRecord,
        game: null
      }
    };
  } catch (error) {
    console.error("获取匹配状态失败:", error);
    return {
      code: 500,
      message: "获取匹配状态失败",
      data: null
    };
  }
};