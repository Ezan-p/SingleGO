// 好友连线对局 - 房间与落子同步工具
// 依赖 wx.cloud（需在 app.js 中 init）与 dango.js 游戏逻辑
const dango = require('./dango.js');

function db() {
  return wx.cloud.database();
}

function cmd() {
  return db().command;
}

// 6 位房号：剔除易混 0/O/1/I/L
function genRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
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

// 房号去重校验：已存在则重新生成
function genUniqueRoomCode() {
  const code = genRoomCode();
  return db().collection('rooms').where({ roomId: code }).count().then(function (res) {
    if (res.total > 0) return genUniqueRoomCode();
    return code;
  });
}

// 创建房间：房主=黑
function createRoom(opts) {
  const boardSize = opts.boardSize || dango.DEFAULT_SIZE;
  return ensureAuth().then(function (g) {
    return genUniqueRoomCode().then(function (roomId) {
      const now = db().serverDate();
      const doc = {
        roomId: roomId,
        boardSize: boardSize,
        host: { openid: g.openid, nickname: opts.nickname, avatar: opts.avatar },
        guest: null,
        status: 'waiting',
        board: dango.createBoard(boardSize),
        currentPlayer: dango.BLACK,
        moves: [],
        lastMove: null,
        lastMoveBy: null,
        winner: 0,
        winReason: '',
        createdAt: now,
        updatedAt: now
      };
      return db().collection('rooms').add({ data: doc }).then(function (res) {
        return { _id: res._id, roomId: roomId, boardSize: boardSize, host: doc.host, guest: null, status: 'waiting', board: doc.board, currentPlayer: doc.currentPlayer, moves: [], lastMove: null, lastMoveBy: null, winner: 0, winReason: '' };
      });
    });
  });
}

// 通过 6 位房号查询房间
function getRoomByRoomId(roomId) {
  return db().collection('rooms').where({ roomId: roomId }).get().then(function (res) {
    if (!res.data.length) return null;
    return res.data[0];
  });
}

// 加入房间：填充 guest=白；仅限 status=waiting 且 guest 为空
function joinRoom(opts) {
  return ensureAuth().then(function (g) {
    return db().collection('rooms').where({ roomId: opts.roomId, status: 'waiting' }).get().then(function (res) {
      if (!res.data.length) throw new Error('房间不存在或已开始/结束');
      const room = res.data[0];
      if (room.guest && room.guest.openid !== g.openid) throw new Error('房间已满');
      return db().collection('rooms').doc(room._id).update({
        data: {
          guest: { openid: g.openid, nickname: opts.nickname, avatar: opts.avatar },
          updatedAt: db().serverDate()
        }
      }).then(function () {
        return room._id;
      });
    });
  });
}

// 房主开局：status -> playing
function startGame(roomDocId) {
  return db().collection('rooms').doc(roomDocId).update({
    data: { status: 'playing', updatedAt: db().serverDate() }
  });
}

// 落子：读-校验-写回，全棋盘快照
function placeMove(roomDocId, move) {
  const r = move.r, c = move.c, player = move.player;
  return db().collection('rooms').doc(roomDocId).get().then(function (res) {
    const room = res.data;
    if (!room) throw new Error('房间不存在');
    if (room.status !== 'playing') throw new Error('对局未在进行中');
    if (room.currentPlayer !== player) throw new Error('不是你的回合');
    if (!dango.canPlace(room.board, r, c)) throw new Error('此处已有棋子');

    const board = dango.cloneBoard(room.board);
    dango.placePiece(board, r, c, player);
    const result = dango.evaluateMove(board, r, c, player);
    const next = dango.opponent(player);
    const update = {
      board: board,
      currentPlayer: result.gameOver ? player : next,
      lastMove: { r: r, c: c },
      lastMoveBy: getApp().globalData.openid,
      updatedAt: db().serverDate(),
      moves: cmd().push({ r: r, c: c, player: player, ts: Date.now() })
    };
    if (result.gameOver) {
      update.status = 'ended';
      update.winner = result.winner;
      update.winReason = result.reason;
    }
    return db().collection('rooms').doc(roomDocId).update({ data: update });
  });
}

// 离开房间
// role: 'host' | 'guest'
// 等待中房主离开 -> 删除房间；进行中离开 -> 判对方胜
function leaveRoom(roomDocId, role) {
  return db().collection('rooms').doc(roomDocId).get().then(function (res) {
    const room = res.data;
    if (!room) return null;
    if (room.status === 'waiting' && role === 'host') {
      return db().collection('rooms').doc(roomDocId).remove();
    }
    if (room.status === 'ended') return null;
    const winner = role === 'host' ? dango.WHITE : dango.BLACK;
    return db().collection('rooms').doc(roomDocId).update({
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
  genRoomCode: genRoomCode,
  ensureAuth: ensureAuth,
  createRoom: createRoom,
  getRoomByRoomId: getRoomByRoomId,
  joinRoom: joinRoom,
  startGame: startGame,
  placeMove: placeMove,
  leaveRoom: leaveRoom,
  subscribeRoom: subscribeRoom
};
