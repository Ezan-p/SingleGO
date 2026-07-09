// 联网对战工具模块
const dango = require('./dango.js');
const app = getApp();

// 数据库引用
function db() {
  return wx.cloud.database();
}

function cmd() {
  return db().command;
}

// 确保用户已授权并获取openid
function ensureAuth() {
  if (app.globalData.openid) {
    return Promise.resolve(app.globalData);
  }
  
  return new Promise((resolve, reject) => {
    if (!app.cloudInited) {
      reject(new Error('云开发未初始化，请在 envList.js 填入 envId'));
      return;
    }
    
    wx.cloud.callFunction({
      name: 'getOpenId'
    }).then(res => {
      const openid = res.result.openid;
      if (openid) {
        app.globalData.openid = openid;
        resolve(app.globalData);
      } else {
        reject(new Error('获取openid失败'));
      }
    }).catch(err => {
      reject(err);
    });
  });
}

// 加入匹配队列
function joinMatchQueue() {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({
      name: 'matchSystem'
    });
  });
}

// 取消匹配
function cancelMatch() {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({
      name: 'matchSystem',
      data: {
        $url: 'cancelMatch'
      }
    });
  });
}

// 获取匹配状态
function getMatchStatus() {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({
      name: 'matchSystem',
      data: {
        $url: 'getMatchStatus'
      }
    });
  });
}

// 落子
function makeMove(gameId, row, col) {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({
      name: 'gameSync',
      data: {
        $url: 'makeMove',
        gameId: gameId,
        row: row,
        col: col
      }
    });
  });
}

// 请求悔棋
function requestUndo(gameId, targetMoveNumber) {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({
      name: 'gameSync',
      data: {
        $url: 'requestUndo',
        gameId: gameId,
        targetMoveNumber: targetMoveNumber
      }
    });
  });
}

// 处理悔棋请求
function handleUndoRequest(requestId, approve) {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({
      name: 'gameSync',
      data: {
        $url: 'handleUndo',
        requestId: requestId,
        approve: approve
      }
    });
  });
}

// 认输
function resignGame(gameId) {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({
      name: 'gameSync',
      data: {
        $url: 'resignGame',
        gameId: gameId
      }
    });
  });
}

// 获取游戏状态
function getGameStatus(gameId) {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({
      name: 'gameSync',
      data: {
        $url: 'getGameStatus',
        gameId: gameId
      }
    });
  });
}

// 实时监听游戏状态（使用云数据库watch）
function watchGame(gameId, callback) {
  return ensureAuth().then(() => {
    const db = wx.cloud.database();
    const watcher = db.collection('games').doc(gameId).watch({
      onChange: (snapshot) => {
        if (snapshot.type === 'init') {
          // 初始化
          callback(null, snapshot.docs[0]);
        } else if (snapshot.type === 'update') {
          // 更新
          callback(null, snapshot.docs[0]);
        }
      },
      onError: (err) => {
        callback(err, null);
      }
    });
    
    return watcher;
  });
}

// 监听悔棋请求
function watchUndoRequests(gameId, player, callback) {
  return ensureAuth().then(() => {
    const db = wx.cloud.database();
    const watcher = db.collection('undo_requests')
      .where({
        game_id: gameId,
        requester: player === 'black' ? 'white' : 'black', // 监听对手的悔棋请求
        status: 'pending'
      })
      .watch({
        onChange: (snapshot) => {
          if (snapshot.type === 'init' && snapshot.docs.length > 0) {
            // 有新的悔棋请求
            callback(null, snapshot.docs);
          } else if (snapshot.type === 'update' && snapshot.docs.length > 0) {
            // 悔棋请求状态更新
            callback(null, snapshot.docs);
          } else if (snapshot.type === 'update' && snapshot.docs.length === 0) {
            // 悔棋请求被处理
            callback(null, []);
          }
        },
        onError: (err) => {
          callback(err, null);
        }
      });
    
    return watcher;
  });
}

// 获取玩家统计信息
function getPlayerStats(openid) {
  return ensureAuth().then(() => {
    const db = wx.cloud.database();
    return db.collection('players').where({
      openid: openid
    }).get();
  });
}

// 更新玩家信息
function updatePlayerInfo(playerInfo) {
  return ensureAuth().then(() => {
    const { openid, nickname, avatar, elo_rating } = playerInfo;
    
    return wx.cloud.callFunction({
      name: 'matchSystem',
      data: {
        $url: 'updatePlayer',
        openid: openid,
        nickname: nickname,
        avatar: avatar,
        elo_rating: elo_rating || 1200
      }
    });
  });
}

// 获取匹配统计
function getMatchStats() {
  return ensureAuth().then(() => {
    // 这里可以调用云函数获取实时匹配统计
    // 暂时返回模拟数据
    return Promise.resolve({
      totalWaiting: Math.floor(Math.random() * 10) + 1,
      avgWaitTime: Math.floor(Math.random() * 30) + 10,
      matchSuccessRate: 95
    });
  });
}

module.exports = {
  // 匹配相关
  joinMatchQueue,
  cancelMatch,
  getMatchStatus,
  getMatchStats,
  
  // 游戏相关
  makeMove,
  requestUndo,
  handleUndoRequest,
  resignGame,
  getGameStatus,
  
  // 实时监听
  watchGame,
  watchUndoRequests,
  
  // 玩家相关
  getPlayerStats,
  updatePlayerInfo,
  
  // 工具函数
  ensureAuth
};