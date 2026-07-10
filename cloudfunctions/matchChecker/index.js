const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

// 段位系统配置（与 miniprogram/utils/rank.js 同步）
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

function getRankByPoints(points) {
  points = Math.max(0, points || 0);
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (points >= RANKS[i].points) return RANKS[i];
  }
  return RANKS[0];
}

// 匹配算法：根据段位积分和等待时间进行匹配
async function findMatch(player1) {
  const now = Date.now();
  const waitingTime = now - new Date(player1.join_time).getTime();

  // 根据玩家段位积分计算段位索引
  const player1Rank = getRankByPoints(player1.rankPoints || 0);

  // 根据等待时间调整匹配范围（段位差）
  let rankRange = 1; // ±1 个段位
  if (waitingTime > 20000) rankRange = 2;
  if (waitingTime > 45000) rankRange = 4;
  if (waitingTime > 90000) rankRange = 8;

  const minRank = Math.max(0, player1Rank.id - rankRange);
  const maxRank = Math.min(RANKS.length - 1, player1Rank.id + rankRange);

  // 转换为积分范围
  const minPoints = RANKS[minRank].points;
  const maxPoints = maxRank < RANKS.length - 1 ? RANKS[maxRank + 1].points : 999999;

  // 查找匹配的对手
  const potentialMatches = await db.collection("match_queue")
    .where({
      _id: _.neq(player1._id),
      status: "waiting",
      rankPoints: _.gte(minPoints).and(_.lt(maxPoints)),
      join_time: _.lt(player1.join_time)
    })
    .orderBy("join_time", "asc")
    .limit(5)
    .get();

  if (potentialMatches.data.length === 0) {
    // 降级：用 ELO 范围匹配（兼容旧数据）
    let eloRange = 200;
    if (waitingTime > 30000) eloRange = 400;
    if (waitingTime > 60000) eloRange = 800;

    const fallbackMatches = await db.collection("match_queue")
      .where({
        _id: _.neq(player1._id),
        status: "waiting",
        elo_rating: _.gte((player1.elo_rating || 1200) - eloRange)
                  .and(_.lte((player1.elo_rating || 1200) + eloRange)),
        join_time: _.lt(player1.join_time)
      })
      .orderBy("join_time", "asc")
      .limit(5)
      .get();

    if (fallbackMatches.data.length === 0) return null;

    // 优先匹配段位积分最接近的
    let bestMatch = fallbackMatches.data[0];
    let minDiff = Math.abs((bestMatch.rankPoints || 0) - (player1.rankPoints || 0));
    for (let i = 1; i < fallbackMatches.data.length; i++) {
      const diff = Math.abs((fallbackMatches.data[i].rankPoints || 0) - (player1.rankPoints || 0));
      if (diff < minDiff) {
        bestMatch = fallbackMatches.data[i];
        minDiff = diff;
      }
    }
    return bestMatch;
  }

  // 优先匹配段位积分最接近的对手
  let bestMatch = potentialMatches.data[0];
  let minDiff = Math.abs((bestMatch.rankPoints || 0) - (player1.rankPoints || 0));

  for (let i = 1; i < potentialMatches.data.length; i++) {
    const candidate = potentialMatches.data[i];
    const diff = Math.abs((candidate.rankPoints || 0) - (player1.rankPoints || 0));

    if (diff < minDiff) {
      bestMatch = candidate;
      minDiff = diff;
    }
  }

  return bestMatch;
}

// 创建新游戏
async function createGame(player1, player2) {
  // 随机决定谁执黑谁执白
  const isPlayer1Black = Math.random() > 0.5;
  const blackPlayer = isPlayer1Black ? player1 : player2;
  const whitePlayer = isPlayer1Black ? player2 : player1;
  
  // 默认棋盘大小为15
  const boardSize = 15;
  
  // 创建初始棋盘
  const board = [];
  for (let i = 0; i < boardSize; i++) {
    board.push(new Array(boardSize).fill(0));
  }
  
  const gameData = {
    black_player_id: blackPlayer.player_id,
    white_player_id: whitePlayer.player_id,
    black_openid: blackPlayer.openid,
    white_openid: whitePlayer.openid,
    black_nickname: blackPlayer.nickname,
    white_nickname: whitePlayer.nickname,
    black_avatar: blackPlayer.avatar,
    white_avatar: whitePlayer.avatar,
    black_rank_name: blackPlayer.rankName || getRankByPoints(blackPlayer.rankPoints).name,
    white_rank_name: whitePlayer.rankName || getRankByPoints(whitePlayer.rankPoints).name,
    board_size: boardSize,
    current_player: "black", // 黑方先手
    board_state: board,
    move_count: 0,
    last_move: null,
    status: "playing",
    winner: null,
    winner_reason: null,
    win_target: null,
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
    black_rank_after: null,
    white_rank_after: null,
    created_at: db.serverDate(),
    updated_at: db.serverDate()
  };
  
  const result = await db.collection("games").add({
    data: gameData
  });
  
  return {
    ...gameData,
    _id: result._id
  };
}

// 发送匹配成功通知（通过云数据库实时推送）
async function sendMatchNotification(game, player1, player2) {
  try {
    // 更新玩家队列状态
    await db.collection("match_queue").doc(player1._id).update({
      data: {
        status: "matched",
        matched_game_id: game._id,
        matched_player_id: player2.player_id,
        updated_at: db.serverDate()
      }
    });
    
    await db.collection("match_queue").doc(player2._id).update({
      data: {
        status: "matched",
        matched_game_id: game._id,
        matched_player_id: player1.player_id,
        updated_at: db.serverDate()
      }
    });
    
    // 这里可以添加推送消息逻辑，如使用云数据库的watch功能
    // 或使用订阅消息功能通知玩家
    
    return true;
  } catch (error) {
    console.error("发送匹配通知失败:", error);
    throw error;
  }
}

// 主函数：执行匹配检查
exports.main = async (event, context) => {
  try {
    // 获取所有等待匹配的玩家
    const waitingPlayers = await db.collection("match_queue")
      .where({
        status: "waiting"
      })
      .orderBy("join_time", "asc")
      .limit(20)
      .get();
    
    if (waitingPlayers.data.length < 2) {
      return {
        code: 200,
        message: "等待匹配的玩家不足",
        data: {
          matchedCount: 0,
          totalWaiting: waitingPlayers.data.length
        }
      };
    }
    
    const matchedGames = [];
    const processedPlayers = new Set();
    
    // 遍历所有等待玩家，尝试匹配
    for (let i = 0; i < waitingPlayers.data.length; i++) {
      const player1 = waitingPlayers.data[i];
      
      if (processedPlayers.has(player1._id)) {
        continue;
      }
      
      // 为当前玩家寻找匹配
      const player2 = await findMatch(player1);
      
      if (player2 && !processedPlayers.has(player2._id)) {
        // 创建新游戏
        const game = await createGame(player1, player2);
        
        // 发送通知
        await sendMatchNotification(game, player1, player2);
        
        matchedGames.push(game);
        processedPlayers.add(player1._id);
        processedPlayers.add(player2._id);
        
        console.log(`匹配成功: ${player1.nickname} vs ${player2.nickname}`);
      }
    }
    
    // 清理过期的匹配记录（超过5分钟）
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    await db.collection("match_queue").where({
      status: "waiting",
      join_time: _.lt(fiveMinutesAgo)
    }).update({
      data: {
        status: "expired",
        updated_at: db.serverDate()
      }
    });
    
    return {
      code: 200,
      message: "匹配检查完成",
      data: {
        matchedCount: matchedGames.length,
        totalWaiting: waitingPlayers.data.length,
        matchedGames: matchedGames
      }
    };
  } catch (error) {
    console.error("匹配检查失败:", error);
    return {
      code: 500,
      message: "匹配检查失败",
      data: null
    };
  }
};