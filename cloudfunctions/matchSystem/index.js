const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

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

// 加入匹配队列
exports.main = async (event, context) => {
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
    
    // 检查玩家是否正在游戏中
    const gameCheck = await db.collection("games").where({
      $or: [
        { black_openid: openid, status: "playing" },
        { white_openid: openid, status: "playing" }
      ]
    }).get();
    
    if (gameCheck.data.length > 0) {
      return {
        code: 400,
        message: "您正在进行游戏，无法匹配",
        data: null
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