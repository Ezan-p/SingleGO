// roomSync — 好友对战房间同步云函数
// 与 gameSync 一致：所有写操作走云函数（管理员权限，绕过数据库安全规则），
// 客户端仅用 watch 做实时读取。这样好友（不同 openid）也能加入/操作房主创建的房间。
// 路由：event.$url 决定调用哪个子函数；exports.main 负责分发。
const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

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
} = require("./dango-logic");

// 6 位房号：剔除易混 0/O/1/I/L
function genRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
async function genUniqueRoomCode() {
  const code = genRoomCode();
  const res = await db.collection("rooms").where({ roomId: code }).count();
  if (res.total > 0) return genUniqueRoomCode();
  return code;
}

// 根据 openid 推导当前玩家在房间中的角色（host/guest）
function roleOf(room, openid) {
  if (room.host && room.host.openid === openid) return "host";
  if (room.guest && room.guest.openid === openid) return "guest";
  return null;
}

// ===== 主分发 =====
exports.main = async (event, context) => {
  const action = event.$url || event.action;
  if (action && typeof exports[action] === "function" && action !== "main") {
    try {
      return await exports[action](event, context);
    } catch (err) {
      console.error(`[roomSync.${action}] error:`, err);
      return { code: 500, message: "服务器错误: " + (err.message || err), data: null };
    }
  }
  return { code: 400, message: "未知操作: " + action, data: null };
};

// ===== 创建房间（房主=黑）=====
exports.createRoom = async (event) => {
  const openid = cloud.getWXContext().OPENID;
  const boardSize = event.boardSize || 15;
  const roomId = await genUniqueRoomCode();
  const now = db.serverDate();
  const doc = {
    roomId: roomId,
    boardSize: boardSize,
    host: { openid: openid, nickname: event.nickname || "", avatar: event.avatar || "" },
    guest: null,
    status: "waiting",
    board: createBoard(boardSize),
    currentPlayer: BLACK,
    moves: [],
    lastMove: null,
    lastMoveBy: null,
    winner: 0,
    winReason: "",
    createdAt: now,
    updatedAt: now
  };
  const res = await db.collection("rooms").add({ data: doc });
  return {
    code: 200,
    data: {
      _id: res._id,
      roomId: doc.roomId,
      boardSize: doc.boardSize,
      host: doc.host,
      guest: doc.guest,
      status: doc.status,
      board: doc.board,
      currentPlayer: doc.currentPlayer,
      moves: doc.moves,
      lastMove: doc.lastMove,
      lastMoveBy: doc.lastMoveBy,
      winner: doc.winner,
      winReason: doc.winReason
    }
  };
};

// ===== 通过 6 位房号加入房间（填充 guest=白）=====
exports.joinRoom = async (event) => {
  const openid = cloud.getWXContext().OPENID;
  const roomId = event.roomId;
  const res = await db.collection("rooms").where({ roomId: roomId, status: "waiting" }).get();
  if (!res.data.length) throw new Error("房间不存在或已开始/结束");
  const room = res.data[0];
  if (room.guest && room.guest.openid !== openid) throw new Error("房间已满");
  // _.set：整体替换 guest 字段。update 传嵌套对象默认按点路径合并（guest.avatar），
  // 而 createRoom 初始化 guest 为 null，会报 Cannot create field 'avatar' in {guest: null}
  await db.collection("rooms").doc(room._id).update({
    data: {
      guest: _.set({ openid: openid, nickname: event.nickname || "", avatar: event.avatar || "" }),
      updatedAt: db.serverDate()
    }
  });
  return { code: 200, data: { _id: room._id } };
};

// ===== 通过房号查询房间（客户端 watch 前用）=====
exports.getRoom = async (event) => {
  const roomId = event.roomId;
  const res = await db.collection("rooms").where({ roomId: roomId }).get();
  if (!res.data.length) return { code: 404, message: "房间不存在", data: null };
  return { code: 200, data: res.data[0] };
};

// ===== 房主开局：status -> playing =====
exports.startGame = async (event) => {
  const roomDocId = event.roomDocId;
  await db.collection("rooms").doc(roomDocId).update({
    data: { status: "playing", updatedAt: db.serverDate() }
  });
  return { code: 200, message: "已开始" };
};

// ===== 落子：读-校验-写回 =====
exports.placeMove = async (event) => {
  const openid = cloud.getWXContext().OPENID;
  const roomDocId = event.roomDocId;
  const r = event.r;
  const c = event.c;
  const player = event.player;
  const isTimeout = !!event.isTimeout;

  const res = await db.collection("rooms").doc(roomDocId).get();
  const room = res.data;
  if (!room) throw new Error("房间不存在");
  if (room.status !== "playing") throw new Error("对局未在进行中");
  if (room.currentPlayer !== player) throw new Error("不是你的回合");
  if (!canPlace(room.board, r, c)) throw new Error("此处已有棋子");

  const board = cloneBoard(room.board);
  placePiece(board, r, c, player);
  const result = evaluateMove(board, r, c, player);
  const next = opponent(player);
  // board / lastMove 用 _.set 整体替换：lastMove 初始为 null、board 为嵌套数组，
  // 点路径合并会报 Cannot create field 'r' in {lastMove: null}（同 joinRoom 的 guest）
  const update = {
    board: _.set(board),
    currentPlayer: result.gameOver ? player : next,
    lastMove: _.set({ r: r, c: c, isTimeout: isTimeout }),
    lastMoveBy: openid,
    updatedAt: db.serverDate(),
    moves: _.push({ r: r, c: c, player: player, ts: Date.now(), isTimeout: isTimeout })
  };
  if (result.gameOver) {
    update.status = "ended";
    update.winner = result.winner;
    update.winReason = result.reason;
  }
  await db.collection("rooms").doc(roomDocId).update({ data: update });
  return {
    code: 200,
    message: "落子成功",
    data: { gameOver: result.gameOver, winner: result.winner, winReason: result.reason }
  };
};

// ===== 离开房间 =====
// 仅依据 openid 推导角色（不信任客户端传入的 role），更安全。
exports.leaveRoom = async (event) => {
  const openid = cloud.getWXContext().OPENID;
  const roomDocId = event.roomDocId;
  const res = await db.collection("rooms").doc(roomDocId).get();
  const room = res.data;
  if (!room) return { code: 200, message: "已离开" };
  const role = roleOf(room, openid);
  if (room.status === "waiting" && role === "host") {
    await db.collection("rooms").doc(roomDocId).remove();
    return { code: 200, message: "已解散" };
  }
  if (room.status === "ended") return { code: 200, message: "已结束" };
  const winner = role === "host" ? WHITE : BLACK;
  await db.collection("rooms").doc(roomDocId).update({
    data: {
      status: "ended",
      winner: winner,
      winReason: "对手已离开",
      updatedAt: db.serverDate()
    }
  });
  return { code: 200, message: "已离开" };
};
