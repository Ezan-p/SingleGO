// 好友连线对局 - 房间与落子同步工具
// 依赖 wx.cloud（需在 app.js 中 init）与 dango.js 游戏逻辑
//
// 重要：所有「写」操作（创建/加入/开局/落子/离开）都走 roomSync 云函数，
// 由服务端以管理员权限执行，规避 rooms 集合默认的跨用户安全规则——
// 否则好友（不同 openid）既读不到也写不进房主创建的房间，导致无法加入/开始。
// 客户端只保留 watch 做实时读取（需 rooms 集合 read 权限放开给双方）。
const dango = require('./dango.js');

function db() {
  return wx.cloud.database();
}

function cmd() {
  return db().command;
}

// 懒加载 openid：复用已部署的 getOpenId 云函数；缓存到 globalData + storage
function ensureAuth() {
  const app = getApp();
  if (app.globalData.openid) return Promise.resolve(app.globalData);
  const cached = wx.getStorageSync('openid');
  if (cached) {
    app.globalData.openid = cached;
    return Promise.resolve(app.globalData);
  }
  if (!app.cloudInited) {
    return Promise.reject(new Error('云开发未初始化，请在 envList.js 填入 envId'));
  }
  return wx.cloud.callFunction({ name: 'getOpenId' }).then(function (res) {
    const openid = res && res.result && res.result.openid;
    if (!openid) throw new Error('获取 openid 失败');
    app.globalData.openid = openid;
    wx.setStorageSync('openid', openid);
    return app.globalData;
  });
}

// 统一调用 roomSync 云函数；失败时把服务端 message 透传为 Error
function callRoomSync(action, data) {
  return ensureAuth().then(function () {
    return wx.cloud.callFunction({
      name: 'roomSync',
      data: Object.assign({ $url: action }, data || {})
    });
  }).then(function (res) {
    const result = res && res.result;
    if (!result || result.code !== 200) {
      throw new Error((result && result.message) || '操作失败');
    }
    return result.data;
  });
}

// 创建房间：房主=黑（服务端生成房号与棋盘）
function createRoom(opts) {
  const boardSize = opts.boardSize || dango.DEFAULT_SIZE;
  return callRoomSync('createRoom', {
    boardSize: boardSize,
    nickname: opts.nickname,
    avatar: opts.avatar
  }).then(function (data) {
    return {
      _id: data._id,
      roomId: data.roomId,
      boardSize: data.boardSize,
      host: data.host,
      guest: data.guest,
      status: data.status,
      board: data.board,
      currentPlayer: data.currentPlayer,
      moves: data.moves,
      lastMove: data.lastMove,
      lastMoveBy: data.lastMoveBy,
      winner: data.winner,
      winReason: data.winReason
    };
  });
}

// 通过 6 位房号查询房间（客户端读取，需 rooms 集合 read 权限）
function getRoomByRoomId(roomId) {
  return callRoomSync('getRoom', { roomId }).then(function (data) {
    return data; // 完整房间文档（含 _id）
  });
}

// 加入房间：填充 guest=白（服务端以管理员权限写入）
function joinRoom(opts) {
  return callRoomSync('joinRoom', {
    roomId: opts.roomId,
    nickname: opts.nickname,
    avatar: opts.avatar
  }).then(function (data) {
    return data._id;
  });
}

// 房主开局：status -> playing
function startGame(roomDocId) {
  return callRoomSync('startGame', { roomDocId: roomDocId }).then(function () {
    return;
  });
}

// 落子：服务端校验回合/合法性后写回（全棋盘快照）
function placeMove(roomDocId, move) {
  return callRoomSync('placeMove', {
    roomDocId: roomDocId,
    r: move.r,
    c: move.c,
    player: move.player,
    isTimeout: !!move.isTimeout
  });
}

// 离开房间（role 仅作展示，服务端以 openid 推导真实角色）
function leaveRoom(roomDocId, role) {
  return callRoomSync('leaveRoom', { roomDocId: roomDocId, role: role });
}

// 实时订阅房间文档，返回 closer（客户端读取，需 rooms 集合 read 权限放开给双方）
function subscribeRoom(roomDocId, cb) {
  return db().collection('rooms').doc(roomDocId).watch({
    onChange: function (snapshot) {
      if (snapshot.docs && snapshot.docs.length) cb(snapshot.docs[0], null);
      else cb(null, new Error('房间已删除'));
    },
    onError: function (err) {
      cb(null, err);
    }
  });
}

module.exports = {
  ensureAuth: ensureAuth,
  createRoom: createRoom,
  getRoomByRoomId: getRoomByRoomId,
  joinRoom: joinRoom,
  startGame: startGame,
  placeMove: placeMove,
  leaveRoom: leaveRoom,
  subscribeRoom: subscribeRoom
};
