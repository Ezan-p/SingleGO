// js/network.js
// 联网对战 + 云开发 + 网络状态（小游戏版）
// 由小程序版 utils/online-match.js、utils/online.js、utils/network.js 合并而来。
// 唯一改动：getApp().globalData → storage.globalData（小游戏无 App 实例），
// 云函数名、集合名、请求字段与协议完全保持不变，服务端 cloudfunctions/ 无需改动。

const storage = require('./storage.js');
const requestIdUtil = require('./request-id.js');
const rule = require('./rule.js');
const board_ = require('./board.js');
const { envId } = require('./env.js');

// ===== 云开发初始化 =====

function initCloud() {
  if (storage.globalData.cloudInited) return true;
  if (typeof wx === 'undefined' || !wx.cloud || !envId) {
    console.warn('[dango] wx.cloud 未初始化：env.envId 为空，联网对战不可用');
    storage.globalData.cloudInited = false;
    return false;
  }
  try {
    wx.cloud.init({ env: envId, traceUser: true });
    storage.globalData.cloudInited = true;
    return true;
  } catch (e) {
    console.error('[dango] wx.cloud.init 失败:', e);
    storage.globalData.cloudInited = false;
    return false;
  }
}

function db() {
  return wx.cloud.database();
}

function cmd() {
  return db().command;
}

// 确保已获取 openid
function ensureAuth() {
  const g = storage.globalData;
  if (g.openid) return Promise.resolve(g);

  return new Promise((resolve, reject) => {
    if (!g.cloudInited) {
      reject(new Error('云开发未初始化，请在 env.js 填入 envId'));
      return;
    }
    wx.cloud.callFunction({ name: 'getOpenId' }).then(res => {
      const openid = res.result && res.result.openid;
      if (openid) {
        storage.setOpenid(openid);
        resolve(g);
      } else {
        reject(new Error('获取openid失败'));
      }
    }).catch(reject);
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

// ===== 匹配 =====

// 加入匹配队列
function joinMatchQueue() {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({ name: 'matchSystem' });
  });
}

// 取消匹配
function cancelMatch() {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({ name: 'matchSystem', data: { $url: 'cancelMatch' } });
  });
}

// 超时匹配：请求系统分配 AI 模拟用户（30 秒无真人匹配成功时调用）
function createAIMatch() {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({ name: 'matchSystem', data: { $url: 'createAIMatch' } });
  });
}

// 获取匹配状态
function getMatchStatus() {
  return ensureAuth().then(() => {
    return wx.cloud.callFunction({ name: 'matchSystem', data: { $url: 'getMatchStatus' } });
  });
}

// ===== 对局 =====

// 落子（带 requestId 幂等）
function makeMove(gameId, row, col, sessionId) {
  const requestId = requestIdUtil.genRequestId();
  return callGameSync('makeMove', { gameId, row, col, sessionId, requestId });
}

// AI 代理落子（带 requestId 幂等）：由人类客户端提交，asAIColor 为目标 AI 颜色
function makeAIMove(gameId, row, col, aiColor) {
  const requestId = requestIdUtil.genRequestId();
  return callGameSync('makeMove', { gameId, row, col, requestId, asAI: true, asAIColor: aiColor });
}

// 超时系统随机落子：倒计时归零或服务端扫描时调用，由服务端随机落子当前行棋方
function timeoutMove(gameId) {
  const requestId = requestIdUtil.genRequestId();
  return callGameSync('timeoutMove', { gameId, requestId });
}

// 请求悔棋（带 requestId 幂等）
function requestUndo(gameId, targetMoveNumber) {
  const requestId = requestIdUtil.genRequestId();
  return callGameSync('requestUndo', { gameId, targetMoveNumber, requestId });
}

// 处理悔棋请求（带 idemRequestId 幂等）
function handleUndoRequest(undoRequestId, approve) {
  const idemRequestId = requestIdUtil.genRequestId();
  return callGameSync('handleUndo', { requestId: undoRequestId, idemRequestId, approve });
}

// 认输（带 requestId 幂等）
function resignGame(gameId) {
  const requestId = requestIdUtil.genRequestId();
  return callGameSync('resignGame', { gameId, requestId });
}

// 获取游戏状态（绑定 session，用于断线重连）
function getGameStatus(gameId, sessionId) {
  return callGameSync('getGameStatus', { gameId, sessionId });
}

// 心跳
function heartbeat(gameId, sessionId) {
  return callGameSync('heartbeat', { gameId, sessionId });
}

// 再来一局
function inviteRematch(gameId) {
  return callGameSync('inviteRematch', { gameId });
}

function respondRematch(invitationId, accept) {
  return callGameSync('respondRematch', { invitationId, accept });
}

function getRecentGames() {
  return callGameSync('getRecentGames', {});
}

// ===== 实时监听 =====

// 监听对局文档变化（games 集合）
function watchGame(gameId, callback) {
  return ensureAuth().then(() => {
    const database = wx.cloud.database();
    return database.collection('games').doc(gameId).watch({
      onChange: (snapshot) => {
        if (snapshot.docs && snapshot.docs.length > 0) {
          callback(null, snapshot.docs[0], snapshot.type || 'init');
        }
      },
      onError: (err) => { callback(err, null); }
    });
  });
}

// 监听悔棋请求（对手发起的 pending 请求）
function watchUndoRequests(gameId, myColor, callback) {
  return ensureAuth().then(() => {
    const database = wx.cloud.database();
    const opponentColor = myColor === 'black' ? 'white' : 'black';
    return database.collection('undo_requests')
      .where({ game_id: gameId, requester: opponentColor, status: 'pending' })
      .watch({
        onChange: (snapshot) => { callback(null, snapshot.docs || []); },
        onError: (err) => { callback(err, null); }
      });
  });
}

// 监听最近落子（moves 集合，取最新一条）
function watchMoves(gameId, callback) {
  return ensureAuth().then(() => {
    const database = wx.cloud.database();
    return database.collection('moves')
      .where({ game_id: gameId, is_undo: false })
      .orderBy('move_number', 'desc')
      .limit(1)
      .watch({
        onChange: (snapshot) => { callback(null, (snapshot.docs && snapshot.docs[0]) || null); },
        onError: (err) => { callback(err, null); }
      });
  });
}

// 复合订阅：games + moves + undo_requests，返回 { close }
function watchGameAll(gameId, myColor, handlers) {
  const watchers = [];
  let closed = false;

  Promise.all([
    watchGame(gameId, handlers.onGame || function () {}),
    watchMoves(gameId, handlers.onMove || function () {}),
    watchUndoRequests(gameId, myColor, handlers.onUndo || function () {})
  ]).then(results => {
    if (closed) {
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
    return database.collection('game_invitations')
      .where({ to_openid: myOpenid, status: 'pending' })
      .watch({
        onChange: (snapshot) => { callback(null, snapshot.docs || []); },
        onError: (err) => { callback(err, null); }
      });
  });
}

// 监听指定再来一局邀请的状态变化（发起方等待对方接受）
function watchInvitation(invitationId, callback) {
  return ensureAuth().then(() => {
    const database = wx.cloud.database();
    return database.collection('game_invitations').doc(invitationId).watch({
      onChange: (snapshot) => { callback(null, (snapshot.docs && snapshot.docs[0]) || null); },
      onError: (err) => { callback(err, null); }
    });
  });
}

// 监听匹配队列自己的文档
function watchMatchQueue(myOpenid, callback) {
  return ensureAuth().then(() => {
    const database = wx.cloud.database();
    return database.collection('match_queue')
      .where({ openid: myOpenid, status: database.command.in(['waiting', 'matched']) })
      .watch({
        onChange: (snapshot) => { callback(null, (snapshot.docs && snapshot.docs[0]) || null); },
        onError: (err) => { callback(err, null); }
      });
  });
}

// ===== 玩家相关 =====

function getPlayerStats(openid) {
  return ensureAuth().then(() => {
    return wx.cloud.database().collection('players').where({ openid }).get();
  });
}

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

// ===== 好友房间（由 utils/online.js 迁移） =====

const ROOMS = 'rooms';

// 6 位房号：剔除易混 0/O/1/I/L
function genRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// 房号去重校验：已存在则重新生成
function genUniqueRoomCode() {
  const code = genRoomCode();
  return db().collection(ROOMS).where({ roomId: code }).count().then(function (res) {
    if (res.total > 0) return genUniqueRoomCode();
    return code;
  });
}

// 创建房间：房主=黑
function createRoom(opts) {
  const o = opts || {};
  const boardSize = o.boardSize || board_.DEFAULT_SIZE;
  return ensureAuth().then(function (g) {
    return genUniqueRoomCode().then(function (roomId) {
      const now = db().serverDate();
      const doc = {
        roomId: roomId,
        boardSize: boardSize,
        host: { openid: g.openid, nickname: o.nickname, avatar: o.avatar },
        guest: null,
        status: 'waiting',
        board: board_.createBoard(boardSize),
        currentPlayer: board_.BLACK,
        moves: [],
        lastMove: null,
        lastMoveBy: null,
        winner: 0,
        winReason: '',
        createdAt: now,
        updatedAt: now
      };
      return db().collection(ROOMS).add({ data: doc }).then(function (res) {
        return {
          _id: res._id, roomId: roomId, boardSize: boardSize,
          host: doc.host, guest: null, status: 'waiting',
          board: doc.board, currentPlayer: doc.currentPlayer,
          moves: [], lastMove: null, lastMoveBy: null, winner: 0, winReason: ''
        };
      });
    });
  });
}

// 通过 6 位房号查询房间
function getRoomByRoomId(roomId) {
  return db().collection(ROOMS).where({ roomId: roomId }).get().then(function (res) {
    if (!res.data.length) return null;
    return res.data[0];
  });
}

// 加入房间：填充 guest=白；仅限 status=waiting 且 guest 为空
function joinRoom(opts) {
  const o = opts || {};
  return ensureAuth().then(function (g) {
    return db().collection(ROOMS).where({ roomId: o.roomId, status: 'waiting' }).get().then(function (res) {
      if (!res.data.length) throw new Error('房间不存在或已开始/结束');
      const room = res.data[0];
      if (room.guest && room.guest.openid !== g.openid) throw new Error('房间已满');
      return db().collection(ROOMS).doc(room._id).update({
        data: {
          guest: { openid: g.openid, nickname: o.nickname, avatar: o.avatar },
          updatedAt: db().serverDate()
        }
      }).then(function () { return room._id; });
    });
  });
}

// 房主开局：status -> playing
function startGame(roomDocId) {
  return db().collection(ROOMS).doc(roomDocId).update({
    data: { status: 'playing', updatedAt: db().serverDate() }
  });
}

// 房间内落子：读-校验-写回，全棋盘快照
// 规则判定复用 rule.evaluateMove（与小程序版 dango.evaluateMove 同一实现，逻辑不变）
function placeMove(roomDocId, move) {
  const r = move.r, c = move.c, player = move.player;
  return db().collection(ROOMS).doc(roomDocId).get().then(function (res) {
    const room = res.data;
    if (!room) throw new Error('房间不存在');
    if (room.status !== 'playing') throw new Error('对局未在进行中');
    if (room.currentPlayer !== player) throw new Error('不是你的回合');
    if (!board_.canPlace(room.board, r, c)) throw new Error('此处已有棋子');

    const board = board_.cloneBoard(room.board);
    board_.placePiece(board, r, c, player);
    const result = rule.evaluateMove(board, r, c, player);
    const next = board_.opponent(player);
    const update = {
      board: board,
      currentPlayer: result.gameOver ? player : next,
      lastMove: { r: r, c: c, isTimeout: !!move.isTimeout },
      lastMoveBy: storage.globalData.openid,
      updatedAt: db().serverDate(),
      moves: cmd().push({ r: r, c: c, player: player, ts: Date.now(), isTimeout: !!move.isTimeout })
    };
    if (result.gameOver) {
      update.status = 'ended';
      update.winner = result.winner;
      update.winReason = result.reason;
    }
    return db().collection(ROOMS).doc(roomDocId).update({ data: update });
  });
}

// 离开房间
// role: 'host' | 'guest'
// 等待中房主离开 -> 删除房间；进行中离开 -> 判对方胜
function leaveRoom(roomDocId, role) {
  return db().collection(ROOMS).doc(roomDocId).get().then(function (res) {
    const room = res.data;
    if (!room) return null;
    if (room.status === 'waiting' && role === 'host') {
      return db().collection(ROOMS).doc(roomDocId).remove();
    }
    if (room.status === 'ended') return null;
    const winner = role === 'host' ? board_.WHITE : board_.BLACK;
    return db().collection(ROOMS).doc(roomDocId).update({
      data: {
        status: 'ended',
        winner: winner,
        winReason: '对手已离开',
        updatedAt: db().serverDate()
      }
    });
  });
}

// 实时订阅房间文档，返回 closer
function subscribeRoom(roomDocId, cb) {
  return db().collection(ROOMS).doc(roomDocId).watch({
    onChange: function (snapshot) {
      if (snapshot.docs && snapshot.docs.length) cb(snapshot.docs[0], null);
      else cb(null, new Error('房间已删除'));
    },
    onError: function (err) { cb(null, err); }
  });
}

// ===== 网络状态监听（单例，由 utils/network.js 迁移） =====

let netCurrent = { connected: true, type: 'unknown' };
let netListeners = [];
let netInitialized = false;

function initNetworkStatus() {
  if (netInitialized) return;
  netInitialized = true;
  try {
    wx.getNetworkType({
      success(res) {
        netCurrent.type = res.networkType;
        netCurrent.connected = res.networkType !== 'none';
        notifyNet();
      }
    });
  } catch (e) { /* ignore */ }

  try {
    wx.onNetworkStatusChange(function (res) {
      netCurrent.type = res.networkType;
      netCurrent.connected = !!res.isConnected;
      notifyNet();
    });
  } catch (e) { /* ignore */ }
}

function notifyNet() {
  for (let i = 0; i < netListeners.length; i++) {
    try { netListeners[i](netCurrent); } catch (e) { /* ignore */ }
  }
}

// 订阅网络变化，返回取消订阅函数
function onNetworkChange(cb) {
  if (!netInitialized) initNetworkStatus();
  netListeners.push(cb);
  try { cb(netCurrent); } catch (e) { /* ignore */ }
  return function unsubscribe() {
    const idx = netListeners.indexOf(cb);
    if (idx !== -1) netListeners.splice(idx, 1);
  };
}

function getNetworkStatus() {
  return netCurrent;
}

module.exports = {
  // 初始化
  initCloud,
  initNetworkStatus,
  ensureAuth,
  db,
  cmd,

  // 匹配
  joinMatchQueue,
  cancelMatch,
  getMatchStatus,
  createAIMatch,

  // 对局
  makeMove,
  makeAIMove,
  timeoutMove,
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
  watchInvitation,
  watchMatchQueue,

  // 玩家
  getPlayerStats,
  updatePlayerInfo,

  // 好友房间
  genRoomCode,
  createRoom,
  getRoomByRoomId,
  joinRoom,
  startGame,
  placeMove,
  leaveRoom,
  subscribeRoom,

  // 网络状态
  onNetworkChange,
  getNetworkStatus
};
