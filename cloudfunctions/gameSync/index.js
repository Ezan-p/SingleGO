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

const ONLINE_WIN_POINTS = 30;
const ONLINE_LOSS_POINTS = -15;

function getRankNameByPoints(points) {
  points = Math.max(0, points || 0);
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (points >= RANKS[i].points) return RANKS[i].name;
  }
  return RANKS[0].name;
}
const { 
  createBoard, 
  cloneBoard, 
  canPlace, 
  placePiece,
  checkSurroundWin,
  checkSelfSurroundLoss,
  checkTwoRowsLoss,
  opponent,
  BLACK,
  WHITE
} = require('./dango-logic');

// 获取游戏详情
async function getGame(gameId) {
  try {
    const result = await db.collection("games").doc(gameId).get();
    if (!result.data) {
      throw new Error("游戏不存在");
    }
    return result.data;
  } catch (error) {
    console.error("获取游戏失败:", error);
    throw error;
  }
}

// 落子函数
exports.makeMove = async (event, context) => {
  const { gameId, row, col } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  
  try {
    // 获取游戏信息
    const game = await getGame(gameId);
    
    // 验证玩家身份
    const isBlackPlayer = game.black_openid === openid;
    const isWhitePlayer = game.white_openid === openid;
    
    if (!isBlackPlayer && !isWhitePlayer) {
      return {
        code: 403,
        message: "您不是该游戏的玩家",
        data: null
      };
    }
    
    // 验证当前回合
    const currentPlayer = game.current_player;
    const isPlayerTurn = (currentPlayer === "black" && isBlackPlayer) || 
                        (currentPlayer === "white" && isWhitePlayer);
    
    if (!isPlayerTurn) {
      return {
        code: 400,
        message: "现在不是您的回合",
        data: null
      };
    }
    
    // 验证落子位置
    if (!canPlace(game.board_state, row, col)) {
      return {
        code: 400,
        message: "该位置不能落子",
        data: null
      };
    }
    
    // 复制棋盘状态
    const newBoard = cloneBoard(game.board_state);
    const playerPiece = currentPlayer === "black" ? BLACK : WHITE;
    const opponentPiece = currentPlayer === "black" ? WHITE : BLACK;
    
    // 执行落子
    placePiece(newBoard, row, col, playerPiece);
    
    // 检查游戏结果
    let gameResult = "playing";
    let winner = null;
    let winnerReason = null;
    
    // 检查自包围判负
    if (checkSelfSurroundLoss(newBoard, playerPiece)) {
      gameResult = currentPlayer === "black" ? "white_win" : "black_win";
      winner = currentPlayer === "black" ? "white" : "black";
      winnerReason = "self_surround";
    }
    
    // 检查连续两排判负
    if (gameResult === "playing" && checkTwoRowsLoss(newBoard, playerPiece)) {
      gameResult = currentPlayer === "black" ? "white_win" : "black_win";
      winner = currentPlayer === "black" ? "white" : "black";
      winnerReason = "two_rows";
    }
    
    // 检查围子获胜
    if (gameResult === "playing") {
      const winResult = checkSurroundWin(newBoard, playerPiece);
      if (winResult) {
        gameResult = currentPlayer === "black" ? "black_win" : "white_win";
        winner = currentPlayer;
        winnerReason = "surround";
      }
    }
    
    // 更新游戏状态
    const updateData = {
      board_state: newBoard,
      current_player: currentPlayer === "black" ? "white" : "black",
      move_count: game.move_count + 1,
      last_move_time: db.serverDate(),
      updated_at: db.serverDate()
    };
    
    if (gameResult !== "playing") {
      updateData.status = gameResult;
      updateData.winner = winner;
      updateData.winner_reason = winnerReason;
      updateData.end_time = db.serverDate();
    }
    
    // 更新游戏记录
    await db.collection("games").doc(gameId).update({
      data: updateData
    });
    
    // 记录棋步
    const moveData = {
      game_id: gameId,
      move_number: game.move_count + 1,
      player: currentPlayer,
      row: row,
      col: col,
      piece: playerPiece,
      timestamp: db.serverDate(),
      board_state_before: game.board_state,
      board_state_after: newBoard,
      game_result: gameResult,
      is_undo: false,
      created_at: db.serverDate()
    };
    
    await db.collection("moves").add({
      data: moveData
    });
    
    // 如果游戏结束，更新玩家统计
    if (gameResult !== "playing") {
      await updatePlayerStats(game, winner);
    }
    
    return {
      code: 200,
      message: "落子成功",
      data: {
        game: {
          ...game,
          ...updateData
        },
        move: moveData
      }
    };
  } catch (error) {
    console.error("落子失败:", error);
    return {
      code: 500,
      message: "落子失败",
      data: null
    };
  }
};

// 更新玩家统计
async function updatePlayerStats(game, winner) {
  try {
    // 更新黑方统计
    const blackUpdate = {
      total_games: _.inc(1),
      updated_at: db.serverDate()
    };

    if (winner === "black") {
      blackUpdate.wins = _.inc(1);
      blackUpdate.rankPoints = _.inc(ONLINE_WIN_POINTS);
    } else if (winner === "white") {
      blackUpdate.losses = _.inc(1);
      blackUpdate.rankPoints = _.inc(ONLINE_LOSS_POINTS);
    } else {
      blackUpdate.draws = _.inc(1);
    }

    await db.collection("players").doc(game.black_player_id).update({
      data: blackUpdate
    });

    // 重新计算黑方段位名
    try {
      const blackPlayer = await db.collection("players").doc(game.black_player_id).get();
      if (blackPlayer.data) {
        const newPoints = Math.max(0, (blackPlayer.data.rankPoints || 0));
        const newRankName = getRankNameByPoints(newPoints);
        await db.collection("players").doc(game.black_player_id).update({
          data: { rankName: newRankName }
        });
      }
    } catch (e) { console.error("更新黑方段位名失败:", e); }

    // 更新白方统计
    const whiteUpdate = {
      total_games: _.inc(1),
      updated_at: db.serverDate()
    };

    if (winner === "white") {
      whiteUpdate.wins = _.inc(1);
      whiteUpdate.rankPoints = _.inc(ONLINE_WIN_POINTS);
    } else if (winner === "black") {
      whiteUpdate.losses = _.inc(1);
      whiteUpdate.rankPoints = _.inc(ONLINE_LOSS_POINTS);
    } else {
      whiteUpdate.draws = _.inc(1);
    }

    await db.collection("players").doc(game.white_player_id).update({
      data: whiteUpdate
    });

    // 重新计算白方段位名
    try {
      const whitePlayer = await db.collection("players").doc(game.white_player_id).get();
      if (whitePlayer.data) {
        const newPoints = Math.max(0, (whitePlayer.data.rankPoints || 0));
        const newRankName = getRankNameByPoints(newPoints);
        await db.collection("players").doc(game.white_player_id).update({
          data: { rankName: newRankName }
        });
      }
    } catch (e) { console.error("更新白方段位名失败:", e); }
  } catch (error) {
    console.error("更新玩家统计失败:", error);
  }
}

// 悔棋请求
exports.requestUndo = async (event, context) => {
  const { gameId, targetMoveNumber } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  
  try {
    const game = await getGame(gameId);
    
    // 验证玩家身份
    const isBlackPlayer = game.black_openid === openid;
    const isWhitePlayer = game.white_openid === openid;
    
    if (!isBlackPlayer && !isWhitePlayer) {
      return {
        code: 403,
        message: "您不是该游戏的玩家",
        data: null
      };
    }
    
    // 验证游戏状态
    if (game.status !== "playing") {
      return {
        code: 400,
        message: "游戏已结束，无法悔棋",
        data: null
      };
    }
    
    // 验证悔棋步数
    if (targetMoveNumber < 1 || targetMoveNumber >= game.move_count) {
      return {
        code: 400,
        message: "无效的悔棋步数",
        data: null
      };
    }
    
    // 创建悔棋请求
    const requester = isBlackPlayer ? "black" : "white";
    const undoRequest = {
      game_id: gameId,
      requester: requester,
      target_move_number: targetMoveNumber,
      status: "pending",
      created_at: db.serverDate(),
      updated_at: db.serverDate()
    };
    
    const result = await db.collection("undo_requests").add({
      data: undoRequest
    });
    
    return {
      code: 200,
      message: "悔棋请求已发送",
      data: {
        ...undoRequest,
        _id: result._id
      }
    };
  } catch (error) {
    console.error("发送悔棋请求失败:", error);
    return {
      code: 500,
      message: "发送悔棋请求失败",
      data: null
    };
  }
};

// 处理悔棋请求
exports.handleUndo = async (event, context) => {
  const { requestId, approve } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  
  try {
    // 获取悔棋请求
    const request = await db.collection("undo_requests").doc(requestId).get();
    if (!request.data) {
      return {
        code: 404,
        message: "悔棋请求不存在",
        data: null
      };
    }
    
    const undoRequest = request.data;
    
    // 获取游戏信息
    const game = await db.collection("games").doc(undoRequest.game_id).get();
    if (!game.data) {
      return {
        code: 404,
        message: "游戏不存在",
        data: null
      };
    }
    
    const gameData = game.data;
    
    // 验证响应者身份
    const isBlackPlayer = gameData.black_openid === openid;
    const isWhitePlayer = gameData.white_openid === openid;
    
    if (!isBlackPlayer && !isWhitePlayer) {
      return {
        code: 403,
        message: "您不是该游戏的玩家",
        data: null
      };
    }
    
    const responder = isBlackPlayer ? "black" : "white";
    
    // 验证响应者不是请求者
    if (responder === undoRequest.requester) {
      return {
        code: 400,
        message: "不能响应自己的悔棋请求",
        data: null
      };
    }
    
    // 更新悔棋请求状态
    await db.collection("undo_requests").doc(requestId).update({
      data: {
        status: approve ? "approved" : "rejected",
        response_by: responder,
        response_time: db.serverDate(),
        updated_at: db.serverDate()
      }
    });
    
    if (approve) {
      // 执行悔棋
      // 获取目标步数之后的棋步
      const movesToUndo = await db.collection("moves")
        .where({
          game_id: undoRequest.game_id,
          move_number: _.gt(undoRequest.target_move_number),
          is_undo: false
        })
        .orderBy("move_number", "asc")
        .get();
      
      // 获取目标步数时的棋盘状态
      const targetMove = await db.collection("moves")
        .where({
          game_id: undoRequest.game_id,
          move_number: undoRequest.target_move_number
        })
        .get();
      
      if (targetMove.data.length === 0) {
        return {
          code: 404,
          message: "目标步数不存在",
          data: null
        };
      }
      
      const targetBoardState = targetMove.data[0].board_state_after;
      
      // 更新游戏状态
      await db.collection("games").doc(undoRequest.game_id).update({
        data: {
          board_state: targetBoardState,
          move_count: undoRequest.target_move_number,
          current_player: undoRequest.target_move_number % 2 === 0 ? "white" : "black",
          updated_at: db.serverDate()
        }
      });
      
      // 标记已撤销的棋步
      for (const move of movesToUndo.data) {
        await db.collection("moves").doc(move._id).update({
          data: {
            is_undo: true,
            updated_at: db.serverDate()
          }
        });
      }
    }
    
    return {
      code: 200,
      message: approve ? "已同意悔棋" : "已拒绝悔棋",
      data: {
        request: undoRequest,
        approved: approve
      }
    };
  } catch (error) {
    console.error("处理悔棋请求失败:", error);
    return {
      code: 500,
      message: "处理悔棋请求失败",
      data: null
    };
  }
};

// 认输
exports.resignGame = async (event, context) => {
  const { gameId } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  
  try {
    const game = await getGame(gameId);
    
    // 验证玩家身份
    const isBlackPlayer = game.black_openid === openid;
    const isWhitePlayer = game.white_openid === openid;
    
    if (!isBlackPlayer && !isWhitePlayer) {
      return {
        code: 403,
        message: "您不是该游戏的玩家",
        data: null
      };
    }
    
    // 验证游戏状态
    if (game.status !== "playing") {
      return {
        code: 400,
        message: "游戏已结束",
        data: null
      };
    }
    
    // 更新游戏状态
    const resigningPlayer = isBlackPlayer ? "black" : "white";
    const winner = isBlackPlayer ? "white" : "black";
    
    await db.collection("games").doc(gameId).update({
      data: {
        status: `${resigningPlayer}_resign`,
        winner: winner,
        winner_reason: "resign",
        end_time: db.serverDate(),
        updated_at: db.serverDate()
      }
    });
    
    // 更新玩家统计
    await updatePlayerStats(game, winner);
    
    return {
      code: 200,
      message: "认输成功",
      data: {
        winner: winner,
        resigningPlayer: resigningPlayer
      }
    };
  } catch (error) {
    console.error("认输失败:", error);
    return {
      code: 500,
      message: "认输失败",
      data: null
    };
  }
};

// 获取游戏状态
exports.getGameStatus = async (event, context) => {
  const { gameId } = event;
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  
  try {
    const game = await getGame(gameId);
    
    // 验证观看权限
    const isPlayer = game.black_openid === openid || game.white_openid === openid;
    
    if (!isPlayer) {
      return {
        code: 403,
        message: "您不是该游戏的玩家",
        data: null
      };
    }
    
    // 获取最近的棋步
    const recentMoves = await db.collection("moves")
      .where({
        game_id: gameId,
        is_undo: false
      })
      .orderBy("move_number", "desc")
      .limit(10)
      .get();
    
    // 获取待处理的悔棋请求
    const pendingUndoRequests = await db.collection("undo_requests")
      .where({
        game_id: gameId,
        status: "pending"
      })
      .get();
    
    return {
      code: 200,
      message: "获取游戏状态成功",
      data: {
        game: game,
        recentMoves: recentMoves.data,
        pendingUndoRequests: pendingUndoRequests.data
      }
    };
  } catch (error) {
    console.error("获取游戏状态失败:", error);
    return {
      code: 500,
      message: "获取游戏状态失败",
      data: null
    };
  }
};