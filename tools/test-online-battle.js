/*
 * 联网对战（gameSync 云函数）集成测试
 * 通过 mock wx-server-sdk + 内存数据库，模拟两名玩家完成整局对战，
 * 覆盖：落子/回合校验/胜负判定/ELO积分/悔棋/认输/掉线判负/多设备/幂等/再来一局。
 *
 * 运行： node tools/test-online-battle.js
 */
const path = require('path');
const Module = require('module');

// ============== 1. 内存数据库 ==============
function makeStore() {
  const collections = {}; // name -> [doc]
  let idCounter = 0;
  const genId = (prefix) => `${prefix}_${++idCounter}`;

  function findCollection(name) {
    if (!collections[name]) collections[name] = [];
    return collections[name];
  }

  const _ = {
    inc: (v) => ({ __op: 'inc', value: v }),
    gt: (v) => ({ __op: 'gt', value: v }),
    gte: (v) => ({ __op: 'gte', value: v }),
    lt: (v) => ({ __op: 'lt', value: v }),
    lte: (v) => ({ __op: 'lte', value: v }),
    eq: (v) => ({ __op: 'eq', value: v }),
    ne: (v) => ({ __op: 'ne', value: v }),
    in: (v) => ({ __op: 'in', value: v }),
    or: (v) => ({ __op: 'or', value: v }),
    and: (v) => ({ __op: 'and', value: v }),
  };

  function matchQuery(doc, query) {
    if (query && typeof query === 'object' && query.__op === 'or')
      return query.value.some((q) => matchQuery(doc, q));
    if (query && typeof query === 'object' && query.__op === 'and')
      return query.value.every((q) => matchQuery(doc, q));
    return Object.keys(query).every((k) => matchField(doc, k, query[k]));
  }
  function matchField(doc, key, cond) {
    const docVal = doc[key];
    if (cond && typeof cond === 'object' && cond.__op) {
      switch (cond.__op) {
        case 'gt': return docVal > cond.value;
        case 'gte': return docVal >= cond.value;
        case 'lt': return docVal < cond.value;
        case 'lte': return docVal <= cond.value;
        case 'eq': return docVal === cond.value;
        case 'ne': return docVal !== cond.value;
        case 'in': return Array.isArray(cond.value) && cond.value.includes(docVal);
        case 'or': return cond.value.some((q) => matchQuery(doc, q));
        case 'and': return cond.value.every((q) => matchQuery(doc, q));
        default: return false;
      }
    }
    return docVal === cond;
  }

  function applyUpdate(doc, data) {
    for (const k of Object.keys(data)) {
      const v = data[k];
      if (v && typeof v === 'object' && v.__op === 'inc') {
        doc[k] = (doc[k] || 0) + v.value;
      } else {
        doc[k] = JSON.parse(JSON.stringify(v));
      }
    }
    return doc;
  }

  function makeQuery(name, baseFilter, isDoc) {
    let whereCond = baseFilter || null;
    let orderField = null, orderDir = 'asc', limitN = null;
    const isDocQuery = !!isDoc;

    const chain = {
      where(q) { whereCond = q; return chain; },
      orderBy(f, dir) { orderField = f; orderDir = dir; return chain; },
      limit(n) { limitN = n; return chain; },
      async get() {
        let docs = findCollection(name).filter((d) => (whereCond ? matchQuery(d, whereCond) : true));
        if (orderField) {
          docs = docs.slice().sort((a, b) => {
            const av = a[orderField], bv = b[orderField];
            if (av == null && bv == null) return 0;
            if (av == null) return 1;
            if (bv == null) return -1;
            let cmp = av < bv ? -1 : av > bv ? 1 : 0;
            return orderDir === 'desc' ? -cmp : cmp;
          });
        }
        if (limitN != null) docs = docs.slice(0, limitN);
        const cloned = docs.map((d) => JSON.parse(JSON.stringify(d)));
        // 真实 wx-server-sdk：doc().get() 返回单对象/ null，where().get() 返回数组
        return { data: isDocQuery ? (cloned[0] || null) : cloned };
      },
      async count() {
        const docs = findCollection(name).filter((d) => (whereCond ? matchQuery(d, whereCond) : true));
        return { total: docs.length };
      },
      async add({ data }) {
        const doc = JSON.parse(JSON.stringify(data));
        doc._id = genId(name);
        findCollection(name).push(doc);
        return { _id: doc._id };
      },
      async update({ data }) {
        let docs = findCollection(name).filter((d) => (whereCond ? matchQuery(d, whereCond) : true));
        let n = 0;
        for (const d of docs) { applyUpdate(d, data); n++; }
        return { updated: n };
      },
      async remove() {
        const keep = findCollection(name).filter((d) => !(whereCond ? matchQuery(d, whereCond) : true));
        collections[name] = keep;
        return { removed: keep.length };
      },
    };
    return chain;
  }

  const db = {
    command: _,
    serverDate() { return new Date(); },
    collection(name) {
      return {
        doc(id) {
          const baseFilter = { _id: id };
          const chain = makeQuery(name, baseFilter, true);
          return chain;
        },
        where(q) { return makeQuery(name, q); },
        orderBy(f, dir) { return makeQuery(name).orderBy(f, dir); },
        limit(n) { return makeQuery(name).limit(n); },
        async add({ data }) { return makeQuery(name).add({ data }); },
        async get() { return makeQuery(name).get(); },
      };
    },
  };

  return { db, _, collections, genId, findCollection };
}

// ============== 2. mock wx-server-sdk ==============
const store = makeStore();
let currentOpenid = null;

const mockCloud = {
  DYNAMIC_CURRENT_ENV: 'test-env',
  init() {},
  database() { return store.db; },
  getWXContext() { return { OPENID: currentOpenid, APPID: 'test' }; },
  async callFunction() { throw new Error('callFunction not mocked'); },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'wx-server-sdk') return mockCloud;
  return origLoad.apply(this, arguments);
};

// ============== 3. 加载被测模块 ==============
const gameSync = require(path.join(__dirname, '..', 'cloudfunctions', 'gameSync', 'index.js'));
const logic = require(path.join(__dirname, '..', 'cloudfunctions', 'gameSync', 'dango-logic.js'));

// ============== 4. 测试基础设施 ==============
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${extra ? '  -> ' + JSON.stringify(extra) : ''}`); }
}

let ridCounter = 0;
const rid = () => `req_${++ridCounter}`;

function call(action, event, openid) {
  currentOpenid = openid;
  return gameSync[action](event, {});
}

// 创建玩家
function seedPlayer(openid, opts = {}) {
  const id = `player_${openid}`;
  const doc = {
    _id: id, openid,
    nickname: opts.nickname || openid,
    avatar: '', rankPoints: opts.rankPoints || 0, rankName: opts.rankName || '棋童',
    total_games: 0, wins: 0, losses: 0, draws: 0,
    current_streak: 0, best_streak: 0, recent_games: [],
  };
  store.collections.players = store.collections.players || [];
  store.collections.players.push(doc);
  return id;
}

function seedGame(blackOpenid, whiteOpenid, opts = {}) {
  const id = `game_${++seedGame.c}`;
  const blackId = `player_${blackOpenid}`, whiteId = `player_${whiteOpenid}`;
  const board = logic.createBoard(opts.size || 15);
  const now = new Date();
  const game = {
    _id: id,
    board_size: opts.size || 15,
    board_state: board,
    current_player: 'black',
    move_count: 0,
    status: opts.status || 'playing',
    winner: null, winner_reason: null, win_target: null, win_stones: [], win_rule: null,
    black_openid: blackOpenid, white_openid: whiteOpenid,
    black_player_id: blackId, white_player_id: whiteId,
    black_nickname: blackOpenid, white_nickname: whiteOpenid,
    black_avatar: '', white_avatar: '',
    black_rank_name: '棋童', white_rank_name: '棋童',
    start_time: now, end_time: null,
    last_move_time: now,
    last_heartbeat_black: opts.blackHb || now,
    last_heartbeat_white: opts.whiteHb || now,
    black_session: opts.blackSession || null,
    white_session: opts.whiteSession || null,
    undo_used_black: 0, undo_used_white: 0,
    disconnect_status: { black: false, white: false },
    points_delta_black: 0, points_delta_white: 0,
    created_at: now, updated_at: now,
  };
  store.collections.games = store.collections.games || [];
  store.collections.games.push(game);
  return id;
}
seedGame.c = 0;

function getGame(gameId) {
  return store.collections.games.find((g) => g._id === gameId);
}
function getPlayer(openid) {
  return store.collections.players.find((p) => p.openid === openid);
}

// ============== 5. 测试场景 ==============
async function run() {
  const BLACK = 'user_black';
  const WHITE = 'user_white';

  // ---------- 场景 A：完整对局 + 围子胜（规则一 十字围）----------
  console.log('\n[场景 A] 落子 / 回合校验 / 围子胜 / ELO 积分');
  seedPlayer(BLACK, { rankPoints: 0 });
  seedPlayer(WHITE, { rankPoints: 0 });
  const gA = seedGame(BLACK, WHITE);

  const movesA = [
    [5, 5, BLACK], [0, 7, WHITE], [1, 7, BLACK], [6, 6, WHITE],
    [0, 6, BLACK], [7, 7, WHITE], [0, 8, BLACK],
  ];
  let i = 0;
  for (const [r, c, color] of movesA) {
    const openid = color === BLACK ? BLACK : WHITE;
    const res = await call('makeMove', { gameId: gA, row: r, col: c, requestId: rid(), sessionId: 'sess-A' }, openid);
    check(`第 ${i + 1} 手 ${color} 落子 (${r},${c}) code=200`, res.code === 200, res);
    i++;
  }
  const ga = getGame(gA);
  check('对局结束，状态 black_win', ga.status === 'black_win', ga.status);
  check('胜者为 black', ga.winner === 'black', ga.winner);
  check('胜利原因含"十字围"', /十字围/.test(ga.winner_reason || ''), ga.winner_reason);
  check('胜利规则 = 1', ga.win_rule === 1, ga.win_rule);
  check('棋步数记录为 7', store.collections.moves.filter((m) => m.game_id === gA).length === 7);
  check('黑方积分上涨(16)', getPlayer(BLACK).rankPoints === 16, getPlayer(BLACK).rankPoints);
  check('白方不降段(仍为0)', getPlayer(WHITE).rankPoints === 0, getPlayer(WHITE).rankPoints);
  check('黑方 total_games=1', getPlayer(BLACK).total_games === 1);
  check('黑方 wins=1', getPlayer(BLACK).wins === 1);
  check('白方 losses=1', getPlayer(WHITE).losses === 1);

  // 非法回合：轮到白方时黑方再次落子
  const illegalTurn = await call('makeMove', { gameId: gA, row: 3, col: 3, requestId: rid() }, BLACK);
  check('已结束对局落子被拒 code=400', illegalTurn.code === 400, illegalTurn);

  // ---------- 场景 B：非法位置 / 非法回合 ----------
  console.log('\n[场景 B] 非法位置与回合校验');
  const gB = seedGame(BLACK, WHITE);
  const r1 = await call('makeMove', { gameId: gB, row: 2, col: 2, requestId: rid(), sessionId: 's' }, BLACK);
  check('黑方首手成功', r1.code === 200);
  const w1 = await call('makeMove', { gameId: gB, row: 3, col: 3, requestId: rid(), sessionId: 's' }, WHITE);
  check('白方轮到时落子成功', w1.code === 200);
  const whiteFirst = await call('makeMove', { gameId: gB, row: 4, col: 4, requestId: rid() }, WHITE);
  check('非白方回合白方落子被拒(非其回合) code=400', whiteFirst.code === 400, whiteFirst);
  const occupied = await call('makeMove', { gameId: gB, row: 2, col: 2, requestId: rid() }, BLACK);
  check('黑方落在已占位置被拒 code=400', occupied.code === 400, occupied);

  // ---------- 场景 C：认输 ----------
  console.log('\n[场景 C] 认输结算 + 幂等');
  const gC = seedGame(BLACK, WHITE);
  await call('makeMove', { gameId: gC, row: 2, col: 2, requestId: rid(), sessionId: 's' }, BLACK);
  const resignId = rid();
  const resC = await call('resignGame', { gameId: gC, requestId: resignId }, BLACK);
  check('黑方认输成功 code=200', resC.code === 200, resC);
  const gc = getGame(gC);
  check('对局 white_win', gc.status === 'white_win', gc.status);
  check('胜者 white', gc.winner === 'white', gc.winner);
  check('认输原因 resign', gc.winner_reason === 'resign', gc.winner_reason);
  check('白方积分上涨', getPlayer(WHITE).rankPoints > 0, getPlayer(WHITE).rankPoints);
  const resC2 = await call('resignGame', { gameId: gC, requestId: resignId }, BLACK);
  check('同 requestId 幂等返回成功', resC2.code === 200 && resC2.message === '认输成功', resC2);

  // ---------- 场景 D：悔棋 ----------
  console.log('\n[场景 D] 悔棋请求 / 同意回退');
  const gD = seedGame(BLACK, WHITE);
  await call('makeMove', { gameId: gD, row: 4, col: 4, requestId: rid(), sessionId: 's' }, BLACK);
  await call('makeMove', { gameId: gD, row: 5, col: 5, requestId: rid(), sessionId: 's' }, WHITE);
  check('悔棋前 move_count=2', getGame(gD).move_count === 2, getGame(gD).move_count);
  const req = await call('requestUndo', { gameId: gD, targetMoveNumber: 1, requestId: rid() }, BLACK);
  check('黑方发起悔棋成功', req.code === 200, req);
  // 自己不能响应自己的请求
  const selfResp = await call('handleUndo', { requestId: req.data._id, idemRequestId: rid(), approve: true }, BLACK);
  check('不能响应自己的悔棋请求 code=400', selfResp.code === 400, selfResp);
  // 白方同意
  const approve = await call('handleUndo', { requestId: req.data._id, idemRequestId: rid(), approve: true }, WHITE);
  check('白方同意悔棋成功', approve.code === 200, approve);
  const gd = getGame(gD);
  check('move_count 回退到 1', gd.move_count === 1, gd.move_count);
  check('当前回合回到 black', gd.current_player === 'black', gd.current_player);
  check('第1手黑子(4,4)保留', gd.board_state[4][4] === 1, gd.board_state[4][4]);
  check('第2手白子(5,5)已撤销', gd.board_state[5][5] === 0, gd.board_state[5][5]);
  check('被撤回的棋步标记 is_undo', store.collections.moves.some((m) => m.game_id === gD && m.is_undo === true));
  // 悔棋次数用尽后再发起
  await call('makeMove', { gameId: gD, row: 4, col: 4, requestId: rid(), sessionId: 's' }, BLACK);
  await call('makeMove', { gameId: gD, row: 5, col: 5, requestId: rid(), sessionId: 's' }, WHITE);
  const req2 = await call('requestUndo', { gameId: gD, targetMoveNumber: 1, requestId: rid() }, BLACK);
  check('免费悔棋用尽后被拒 code=400', req2.code === 400, req2);

  // ---------- 场景 E：掉线判负（心跳）----------
  console.log('\n[场景 E] 心跳掉线判负');
  const gE = seedGame(BLACK, WHITE, { whiteHb: new Date(Date.now() - 60000) });
  const hb = await call('heartbeat', { gameId: gE, sessionId: 's' }, BLACK);
  check('黑方心跳检测到白方掉线 gameOver', hb.data && hb.data.gameOver === true, hb);
  const ge = getGame(gE);
  check('掉线结算 black_win', ge.status === 'black_win' && ge.winner === 'black', ge);
  check('掉线原因 disconnect', ge.winner_reason === 'disconnect', ge.winner_reason);

  // ---------- 场景 F：多设备冲突 ----------
  console.log('\n[场景 F] 多设备登录冲突');
  const gF = seedGame(BLACK, WHITE, { blackSession: 'sess-A' });
  const conflict = await call('makeMove', { gameId: gF, row: 1, col: 1, requestId: rid(), sessionId: 'sess-B' }, BLACK);
  check('不同 session 落子被拒 code=409', conflict.code === 409, conflict);

  // ---------- 场景 G：幂等（落子）----------
  console.log('\n[场景 G] 落子幂等');
  const gG = seedGame(BLACK, WHITE);
  const rg = rid();
  const m1 = await call('makeMove', { gameId: gG, row: 2, col: 2, requestId: rg, sessionId: 's' }, BLACK);
  const m2 = await call('makeMove', { gameId: gG, row: 2, col: 2, requestId: rg, sessionId: 's' }, BLACK);
  check('相同 requestId 第二次返回缓存结果 code=200', m2.code === 200 && m1.data.move.move_number === m2.data.move.move_number, { m1: m1.code, m2: m2.code });
  check('幂等未导致重复落子(仍为黑方回合=白)', getGame(gG).current_player === 'white', getGame(gG).current_player);

  // ---------- 场景 H：再来一局 ----------
  console.log('\n[场景 H] 再来一局（邀请/响应/交换黑白）');
  const gH = seedGame(BLACK, WHITE, { status: 'white_win', winner: 'white', winner_reason: 'resign' });
  const inv = await call('inviteRematch', { gameId: gH }, BLACK);
  check('黑方发起再来一局成功', inv.code === 200, inv);
  const invitationId = inv.data._id;
  const resp = await call('respondRematch', { invitationId, accept: true }, WHITE);
  check('白方同意再来一局成功', resp.code === 200 && resp.data.accepted === true, resp);
  const newGameId = resp.data.gameId;
  const ngg = getGame(newGameId);
  check('新对局已创建 status=playing', ngg && ngg.status === 'playing', ngg && ngg.status);
  check('黑白方交换(新黑=原白)', ngg.black_openid === WHITE, ngg.black_openid);
  check('新白方=原黑', ngg.white_openid === BLACK, ngg.white_openid);
  check('新对局 current_player=black', ngg.current_player === 'black', ngg.current_player);

  // ---------- 场景 I：服务端规则引擎与客户端一致性 ----------
  console.log('\n[场景 I] 服务端 dango-logic 与客户端副本一致性');
  const fs = require('fs');
  const clientPath = path.join(__dirname, '..', 'miniprogram', 'utils', 'dango.js');
  if (fs.existsSync(clientPath)) {
    const clientSrc = fs.readFileSync(clientPath, 'utf8');
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'cloudfunctions', 'gameSync', 'dango-logic.js'), 'utf8');
    // 抽取核心规则函数名，确认两端都实现了 规则三/四
    check('客户端存在 checkSelfSurroundLoss', /checkSelfSurroundLoss/.test(clientSrc));
    check('客户端存在 checkConsecutiveRowsLoss', /checkConsecutiveRowsLoss/.test(clientSrc));
    check('服务端存在 checkSelfSurroundLoss', /checkSelfSurroundLoss/.test(serverSrc));
    check('服务端存在 checkConsecutiveRowsLoss', /checkConsecutiveRowsLoss/.test(serverSrc));
  } else {
    check('客户端 dango.js 存在', false, '未找到 miniprogram/utils/dango.js');
  }

  // ============== 汇总 ==============
  console.log(`\n========== 测试结果：通过 ${pass} / 失败 ${fail} ==========`);
  if (fail > 0) {
    console.log('失败项：\n - ' + failures.join('\n - '));
    process.exit(1);
  } else {
    console.log('联网对战核心逻辑全部通过 ✅');
  }
}

run().catch((e) => { console.error('测试运行异常:', e); process.exit(2); });
