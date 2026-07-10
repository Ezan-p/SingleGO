// 联网对战工具模块
const dango = require('./dango.js');
const requestIdUtil = require('./request-id.js');

let app = null;
function getAppSafe() {
  if (app) return app;
  try { app = getApp(); } catch (e) { app = null; }
  return app;
}

// 数据库引用
function db() {
  return wx.cloud.database();
}

function cmd() {
  return db().command;
}

// 确保用户已授权并获取openid
function ensureAuth() {
  const a = getAppSafe();
  if (a && a.globalData && a.globalData.openid) {
    return Promise.resolve(a.globalData);
  }

  return new Promise((resolve, reject) => {
    if (!a || !a.cloudInited) {
      reject(new Error('云开发未初始化，请在 envList.js 填入 envId'));
      return;
    }
    wx.cloud.callFunction({
      name: 'getOpenId'
    }).then(res => {
      const openid = res.result.openid;
      if (openid) {
        a.globalData.openid = openid;
        resolve(a.globalData);
      } else {
        reject(new Error('获取openid失败'));
      }
    }).catch(err => {
      reject(err);
    });
  });
}

// 通用云函数调用封装
function callGameSync(action, data) {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({
      name: 'gameSync',
      data: Object.assign({ $url: action }, data || {})
    });
  });
}

// 加入匹配队列
function joinMatchQueue() {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({ name: 'matchSystem' });
  });
}

// 取消匹配
function cancelMatch() {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({
      name: 'matchSystem',
      data: { $url: 'cancelMatch' }
    });
  });
}

// 获取匹配状态
function getMatchStatus() {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({
      name: 'matchSystem',
      data: { $url: 'getMatchStatus' }
    });
  });
}

// 落子（带 requestId 幂等）
function makeMove(gameId, row, col, sessionId) {
  const requestId = requestIdUtil.genRequestId();
  return callGameSync('makeMove', {
    gameId, row, col, sessionId, requestId
  });
}

// 请求悔棋（带 requestId 幂等）
function requestUndo(gameId, targetMoveNumber) {
  const requestId = requestIdUtil.genRequestId();
  return callGameSync('requestUndo', {
    gameId, targetMoveNumber, requestId
  });
}

// 处理悔棋请求（带 idemRequestId 幂等）
function handleUndoRequest(undoRequestId, approve) {
  const idemRequestId = requestIdUtil.genRequestId();
  return callGameSync('handleUndo', {
    requestId: undoRequestId,
    idemRequestId,
    approve
  });
}

// 认输（带 requestId 幂等）
function resignGame(gameId) {
  const requestId = requestIdUtil.genRequestId();
  return callGameSync('resignGame', { gameId, requestId });
}

// 获取游戏状态（绑定 session）
function getGameStatus(gameId, sessionId) {
  return callGameSync('getGameStatus', { gameId, sessionId });
}

// 心跳
function heartbeat(gameId, sessionId) {
  return callGameSync('heartbeat', { gameId, sessionId });
}

// 发起再来一局邀请
function inviteRematch(gameId) {
  return callGameSync('inviteRematch', { gameId });
}

// 响应再来一局邀请
function respondRematch(invitationId, accept) {
  return callGameSync('respondRematch', { invitationId, accept });
}

// 获取最近战绩
function getRecentGames() {
  return callGameSync('getRecentGames', {});
}

// ===== 实时监听 =====

// 监听对局文档变化（games 集合）
function watchGame(gameId, callback) {
  return ensureAuth().then(() => {
    const database = wx.cloud.database();
    const watcher = database.collection('games').doc(gameId).watch({
      onChange: (snapshot) => {
        if (snapshot.docs && snapshot.docs.length > 0) {
          callback(null, snapshot.docs[0], snapshot.type || 'init');
        }
      },
      onError: (err) => {
        callback(err, null);
      }
    });
    return watcher;
  });
}

// 监听悔棋请求（对手发起的 pending 请求）
function watchUndoRequests(gameId, myColor, callback) {
  return ensureAuth().then(() => {
    const database = wx.cloud.database();
    const opponentColor = myColor === 'black' ? 'white' : 'black';
    const watcher = database.collection('undo_requests')
      .where({
        game_id: gameId,
        requester: opponentColor,
        status: 'pending'
      })
      .watch({
        onChange: (snapshot) => {
          callback(null, snapshot.docs || []);
        },
        onError: (err) => {
          callback(err, null);
        }
      });
    return watcher;
  });
}

// 监听最近落子（moves 集合，取最新一条）
function watchMoves(gameId, callback) {
  return ensureAuth().then(() => {
    const database = wx.cloud.database();
    const watcher = database.collection('moves')
      .where({ game_id: gameId, is_undo: false })
      .orderBy('move_number', 'desc')
      .limit(1)
      .watch({
        onChange: (snapshot) => {
          callback(null, (snapshot.docs && snapshot.docs[0]) || null);
        },
        onError: (err) => {
          callback(err, null);
        }
      });
    return watcher;
  });
}

// 复合订阅：games + moves + undo_requests
// 返回 { close } 用于统一关闭所有 watcher
function watchGameAll(gameId, myColor, handlers) {
  const watchers = [];
  let closed = false;

  const promises = [
    watchGame(gameId, handlers.onGame || function () {}),
    watchMoves(gameId, handlers.onMove || function () {}),
    watchUndoRequests(gameId, myColor, handlers.onUndo || function () {})
  ];

  Promise.all(promises).then(results => {
    if (closed) {
      // 在订阅完成前已关闭
      results.forEach(w => { try { w.close(); } catch (e) {} });
      return;
    }
    results.forEach(w => watchers.push(w));
  }).catch(err => {
    if (handlers.onError) handlers.onError(err);
  });

  return {
    close() {
      closed = true;
      watchers.forEach(w => { try { w.close(); } catch (e) {} });
      watchers.length = 0;
    }
  };
}

// 监听再来一局邀请（发给自己的）
function watchInvitations(myOpenid, callback) {
  return ensureAuth().then(() => {
    const database = wx.cloud.database();
    const watcher = database.collection('game_invitations')
      .where({ to_openid: myOpenid, status: 'pending' })
      .watch({
        onChange: (snapshot) => {
          callback(null, snapshot.docs || []);
        },
        onError: (err) => {
          callback(err, null);
        }
      });
    return watcher;
  });
}

// 监听匹配队列自己的文档
function watchMatchQueue(myOpenid, callback) {
  return ensureAuth().then(() => {
    const database = wx.cloud.database();
    const watcher = database.collection('match_queue')
      .where({ openid: myOpenid, status: database.command.in(['waiting', 'matched']) })
      .watch({
        onChange: (snapshot) => {
          callback(null, (snapshot.docs && snapshot.docs[0]) || null);
        },
        onError: (err) => {
          callback(err, null);
        }
      });
    return watcher;
  });
}

// ===== 玩家相关 =====

// 获取玩家统计信息
function getPlayerStats(openid) {
  return ensureAuth().then(() => {
    const database = wx.cloud.database();
    return database.collection('players').where({ openid }).get();
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
        openid, nickname, avatar,
        elo_rating: elo_rating || 1200
      }
    });
  });
}

// 获取匹配统计（占位）
function getMatchStats() {
  return ensureAuth().then(() => {
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
  heartbeat,

  // 再来一局
  inviteRematch,
  respondRematch,
  getRecentGames,

  // 实时监听
  watchGame,
  watchMoves,
  watchUndoRequests,
  watchGameAll,
  watchInvitations,
  watchMatchQueue,

  // 玩家相关
  getPlayerStats,
  updatePlayerInfo,

  // 工具函数
  ensureAuth
};
