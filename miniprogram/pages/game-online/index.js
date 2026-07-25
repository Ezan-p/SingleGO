// 联网对战对局页面 — watch 实时同步 + 完整流程
const app = getApp();
const dango = require('../../utils/dango.js');
const rank = require('../../utils/rank.js');
const onlineMatch = require('../../utils/online-match.js');
const network = require('../../utils/network.js');
const sound = require('../../utils/sound.js');
const ai = require('../../utils/ai.js');

const HEARTBEAT_INTERVAL = 10000; // 10s
const WIN_HIGHLIGHT_DELAY = 1800; // 1.8s 高亮后再弹结算
const AI_MOVE_DELAY = 200; // AI 落子思考延迟(ms)：仅影响体验/手感，不改变 AI 策略与算路
const AI_MOVE_MAX_RETRY = 2; // AI 落子失败重试次数（基于最新棋盘重算，不改变策略）
const TURN_TIMEOUT_MS = 30000; // 每步思考时限(ms)：超时由系统随机落子

// 将云端返回的日期（Date / 字符串 / { $date }）统一转为时间戳
function parseTs(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  if (v && v.$date) {
    const d = v.$date;
    const t = typeof d === 'number' ? d : Date.parse(d);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

Page({
  data: {
    gameId: null,
    sessionId: '',
    game: null,
    myColor: null,          // 'black' | 'white'
    myInfo: null,
    opponentInfo: null,
    boardPx: 0,
    cellPx: 0,
    halfCellPx: 0,
    gridPx: 0,
    cells: [],
    boardSize: 15,
    gameOver: false,
    winReasonText: '',
    submitting: false,
    isMyTurn: false,
    pendingColor: '', // 预览落子颜色（'black'/'white'），两下落子交互
    // 悔棋
    pendingUndoRequest: null,
    showUndoRequest: false,
    undoUsed: false,
    // 网络状态
    netConnected: true,
    netType: 'unknown',
    showDisconnectBanner: false,
    // 结算
    showSettlement: false,
    settlement: null,
    // 再来一局
    rematchSent: false,        // 已发起真人再来一局邀请，等待对方同意
    rematchInvitationId: '',   // 我发起的邀请 id（用于监听对方接受）
    incomingRematch: null,     // 对方发来的再来一局邀请（真人）
    rematchProcessing: false,  // 再来一局请求处理中（防重复点击）
    // 段位
    myRankName: '',
    opponentRankName: '',
    // AI 对手（超时匹配）
    isAIGame: false,
    aiColor: '',
    aiLevel: '',
    // 思考时限倒计时（剩余秒数，显示用）
    turnCountdown: 0,
    // 思考时限倒计时进度百分比（剩余时间占比，显示用，100→0）
    turnProgress: 100
  },

  // 非 data 状态
  watcher: null,
  heartbeatTimer: null,
  turnTimer: null,        // 思考时限倒计时定时器
  turnDeadline: 0,        // 当前回合截止时间戳(ms)
  turnTimeoutFired: false,// 本次回合是否已触发超时落子（防重复触发）
  _lastMoveTs: 0,         // 上次落子时间，用于判定新回合
  networkUnsub: null,
  leaving: false,
  gameLoaded: false,

  onLoad: function (options) {
    const gameId = options.gameId;
    if (!gameId) {
      wx.showToast({ title: '游戏参数错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }

    // 生成会话 ID（多设备登录用）
    const sessionId = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    this.aiThinking = false;

    // 棋盘尺寸
    const sys = wx.getSystemInfoSync();
    const rpxToPx = sys.windowWidth / 750;
    const paddingPx = 24 * 2 * rpxToPx;
    let boardPx = sys.windowWidth - paddingPx;
    if (boardPx > 820) boardPx = 820;

    this.setData({
      gameId,
      sessionId,
      boardPx,
      myRankName: rank.getRankName(app.globalData.rankPoints || 0)
    });

    this.loadGame();
    this.subscribeNetwork();
    this.startTurnTimer();
  },

  onUnload: function () {
    this.cleanup();
    // 退出对局返回大厅时，确保大厅按钮恢复为“开始匹配”（不再残留“匹配中”）
    if (app.globalData) app.globalData.matchJustCanceled = true;
    // 主动退出且对局仍在进行 → 判负
    if (!this.leaving && this.data.game && this.data.game.status === 'playing' && !this.data.gameOver) {
      // 异步认输，不阻塞退出
      onlineMatch.resignGame(this.data.gameId).catch(() => {});
    }
  },

  onHide: function () {
    // 切后台暂停心跳（小程序后台 watch 也会暂停）
    this.stopHeartbeat();
    this.stopTurnTimer();
  },

  onShow: function () {
    if (this.data.gameId && this.gameLoaded) {
      this.startHeartbeat();
      this.startTurnTimer();
      // 重连后全量同步一次
      this.loadGame();
    }
  },

  // ===== 网络订阅 =====
  subscribeNetwork: function () {
    this.networkUnsub = network.onNetworkChange((status) => {
      const wasConnected = this.data.netConnected;
      this.setData({
        netConnected: status.connected,
        netType: status.type,
        showDisconnectBanner: !status.connected
      });
      if (!wasConnected && status.connected) {
        // 网络恢复，全量重同步
        this.loadGame();
      }
    });
  },

  // ===== 加载游戏 =====
  loadGame: function () {
    onlineMatch.getGameStatus(this.data.gameId, this.data.sessionId).then((res) => {
      if (res.result && res.result.code === 200 && res.result.data) {
        this.onGameDataLoaded(res.result.data);
        if (!this.gameLoaded) {
          this.gameLoaded = true;
          this.startWatchers();
          this.startHeartbeat();
        }
      } else if (res.result && res.result.code === 409) {
        this.handleMultiDevice();
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '加载游戏失败', icon: 'none' });
      }
    }).catch((err) => {
      console.error('加载游戏失败:', err);
      wx.showToast({ title: '网络错误', icon: 'none' });
    });
  },

  // 游戏数据加载
  onGameDataLoaded: function (data) {
    const game = data.game;

    // 身份以服务端 getGameStatus 返回的 myColor 为准（基于真实 openid 推导，
    // 与 makeMove 的回合校验完全一致）。避免本地 app.globalData.openid 与云端
    // 不一致时算错 myColor，导致“明明是我的回合”却报“现在不是您的回合”。
    let myColor = data.myColor;
    if (!myColor) {
      const myOpenid = app.globalData.openid;
      const isBlack = game.black_openid === myOpenid;
      const isWhite = game.white_openid === myOpenid;
      if (!isBlack && !isWhite) {
        wx.showToast({ title: '您不是该游戏的玩家', icon: 'none' });
        setTimeout(() => wx.navigateBack(), 1500);
        return;
      }
      myColor = isBlack ? 'black' : 'white';
    }

    const isBlack = myColor === 'black';
    const isWhite = myColor === 'white';
    const myInfo = isBlack ? {
      nickname: game.black_nickname, avatar: game.black_avatar
    } : {
      nickname: game.white_nickname, avatar: game.white_avatar
    };
    const opponentInfo = isBlack ? {
      nickname: game.white_nickname, avatar: game.white_avatar, rankName: game.white_rank_name || ''
    } : {
      nickname: game.black_nickname, avatar: game.black_avatar, rankName: game.black_rank_name || ''
    };

    // AI 对手识别（超时匹配分配的 AI 模拟用户，当作普通对手展示）
    const isAIGame = !!(game.black_is_ai || game.white_is_ai);
    const aiColor = game.black_is_ai ? 'black' : (game.white_is_ai ? 'white' : '');
    const aiLevel = game.ai_level || '';

    // 待处理悔棋请求
    let pendingUndoRequest = null;
    if (data.pendingUndoRequests && data.pendingUndoRequests.length > 0) {
      pendingUndoRequest = data.pendingUndoRequests.find(req => req.requester !== myColor);
    }

    const gameOver = game.status !== 'playing';
    const undoUsed = (game['undo_used_' + myColor] || 0) >= 1;

    this.setData({
      game,
      myColor,
      myInfo,
      opponentInfo,
      myRankName: rank.getRankName(app.globalData.rankPoints || 0),
      opponentRankName: opponentInfo.rankName,
      gameOver,
      isMyTurn: !gameOver && game.current_player === myColor,
      pendingUndoRequest,
      showUndoRequest: !!pendingUndoRequest,
      undoUsed,
      isAIGame,
      aiColor,
      aiLevel
    });

    this.calculateBoardLayout(game.board_size, game.board_state, game.last_move, gameOver ? game.win_stones : null, gameOver ? game.win_target : null);

    // 落子音效：新棋子落到棋盘上时播放（载入对局不发声）
    const newCount = game.move_count || 0;
    if (this._soundMoveCount === undefined) {
      this._soundMoveCount = newCount;
    } else if (newCount > this._soundMoveCount) {
      sound.playStone();
      this._soundMoveCount = newCount;
    }

    if (gameOver) {
      this.handleGameOver(game);
    }

    // 刷新思考时限倒计时（以服务端 last_move_time 为基准）
    this.updateTurnDeadline();

    // 若轮到 AI 落子，由客户端驱动 AI
    this.maybeTriggerAIMove();
  },

  // ===== 棋盘布局 =====
  calculateBoardLayout: function (boardSize, boardState, lastMove, winStones, winTarget) {
    if (!boardSize || !boardState) return;
    // 远端棋盘重建会清除本地预览状态，避免预览错位
    this.pendingCell = null;

    const boardPx = this.data.boardPx;
    const cellPx = boardPx / (boardSize + 1);
    const halfCellPx = cellPx / 2;
    const gridPx = boardSize * cellPx;

    const stars = dango.starPoints(boardSize);
    const starSet = {};
    for (let i = 0; i < stars.length; i++) starSet[stars[i][0] + '-' + stars[i][1]] = true;

    const winStoneSet = {};
    if (winStones && winStones.length) {
      for (let i = 0; i < winStones.length; i++) {
        winStoneSet[winStones[i].r + '-' + winStones[i].c] = true;
      }
    }
    const winTargetKey = winTarget ? (winTarget.r + '-' + winTarget.c) : null;

    const cells = [];
    for (let r = 0; r < boardSize; r++) {
      for (let c = 0; c < boardSize; c++) {
        const key = r + '-' + c;
        cells.push({
          key, r, c,
          v: boardState[r][c],
          isStar: !!starSet[key],
          isLast: lastMove && lastMove.row === r && lastMove.col === c,
          isPending: false,
          isWinStone: !!winStoneSet[key],
          isWinTarget: winTargetKey === key
        });
      }
    }

    this.setData({
      boardSize,
      cellPx, halfCellPx, gridPx,
      cells
    });
  },

  // ===== Watch 实时同步 =====
  startWatchers: function () {
    const myColor = this.data.myColor;
    if (!myColor) return;
    this.watcher = onlineMatch.watchGameAll(this.data.gameId, myColor, {
      onGame: (err, game) => {
        if (err || !game) return;
        this.onGameUpdate(game);
      },
      onMove: (err, move) => {
        if (err || !move) return;
        // 落子由 onGame 统一处理（games 文档已含 board_state）
      },
      onUndo: (err, docs) => {
        if (err) return;
        if (docs && docs.length > 0) {
          const req = docs[0];
          if (req.requester !== this.data.myColor) {
            this.setData({ pendingUndoRequest: req, showUndoRequest: true });
          }
        } else {
          this.setData({ pendingUndoRequest: null, showUndoRequest: false });
        }
      },
      onError: (err) => {
        console.error('watch error', err);
        // watch 出错后回退全量同步
        this.loadGame();
      }
    });

    // 监听对手发来的“再来一局”邀请（仅真人局；AI 不会发起邀请）
    if (!this.data.isAIGame) {
      onlineMatch.watchInvitations(app.globalData.openid, (err, docs) => {
        if (err || !docs) return;
        const inv = (docs || []).find(d => d.game_id === this.data.gameId && d.status === 'pending');
        if (inv) {
          this.setData({ incomingRematch: inv });
        } else if (this.data.incomingRematch) {
          // 邀请已被处理（接受/拒绝）→ 清除提示
          this.setData({ incomingRematch: null });
        }
      }).then((w) => { this.rematchInvitationWatcher = w; }).catch(() => {});
    }
  },

  // 发起方：监听自己发出的邀请，对方接受后进入新对局
  startRematchWatch: function (invitationId) {
    if (this.rematchInvWatcher) return;
    onlineMatch.watchInvitation(invitationId, (err, inv) => {
      if (err || !inv) return;
      if (inv.status === 'accepted' && inv.new_game_id) {
        this.leaving = true;
        wx.redirectTo({ url: '/pages/game-online/index?gameId=' + inv.new_game_id });
      } else if (inv.status === 'rejected') {
        this.setData({ rematchSent: false, rematchInvitationId: '', rematchProcessing: false });
        wx.showToast({ title: '对方拒绝了再来一局', icon: 'none' });
      }
    }).then((w) => { this.rematchInvWatcher = w; }).catch(() => {});
  },

  onGameUpdate: function (game) {
    const prevOver = this.data.gameOver;
    const gameOver = game.status !== 'playing';

    this.setData({
      game,
      isMyTurn: !gameOver && game.current_player === this.data.myColor,
      gameOver,
      undoUsed: (game['undo_used_' + this.data.myColor] || 0) >= 1
    });

    const winStones = gameOver ? game.win_stones : null;
    const winTarget = gameOver ? game.win_target : null;
    this.calculateBoardLayout(game.board_size, game.board_state, game.last_move, winStones, winTarget);

    if (gameOver && !prevOver) {
      this.handleGameOver(game);
    }

    // 刷新思考时限倒计时（以服务端 last_move_time 为基准）
    this.updateTurnDeadline();

    // 若轮到 AI 落子，由客户端驱动 AI
    this.maybeTriggerAIMove();
  },

  // ===== AI 对手落子驱动 =====
  // AI 决策在客户端完成（复用 utils/ai.js），通过 onlineMatch.makeAIMove 代理提交，
  // 服务端以 asAI 标记识别并跳过 session 校验。仅在轮到 AI 且对局进行中触发。
  // 关键：决策必须在“即将提交”时基于最新棋盘进行，避免 AI_MOVE_DELAY 期间棋盘被
  // 替换（如 watch 报错触发 loadGame 换盘）导致提交非法/非本回合落子。
  maybeTriggerAIMove: function () {
    if (!this.data.isAIGame) return;
    const game = this.data.game;
    if (!game || game.status !== 'playing') return;
    if (game.current_player !== this.data.aiColor) return;
    if (this.aiThinking) return; // 防止重复触发

    this.aiThinking = true;
    // 仅安排“思考延迟”，真正决策移到延迟结束后、提交前那一刻
    setTimeout(() => {
      this.submitAIMoveWithRetry(0);
    }, AI_MOVE_DELAY);
  },

  // 实际提交 AI 落子（带重试）。每次都基于 this.data.game 的最新棋盘重新决策，
  // 不改变 AI 策略（ai.chooseMove 算路不变），仅保证落子位置合法、回合正确。
  // 整条重试链保持 aiThinking=true，避免 watch 重新触发产生并发落子。
  submitAIMoveWithRetry: function (attempt) {
    if (!this.data.isAIGame) { this.aiThinking = false; return; }
    const game = this.data.game;
    if (!game || game.status !== 'playing') { this.aiThinking = false; return; }
    // 棋盘已推进到人类回合：放弃，等下一次 onGameUpdate 重新触发
    if (game.current_player !== this.data.aiColor) { this.aiThinking = false; return; }

    const aiPlayer = this.data.aiColor === 'black' ? dango.BLACK : dango.WHITE;
    const move = ai.chooseMove(game.board_state, aiPlayer, this.data.aiLevel, { lastMove: game.last_move });
    if (!move) { this.aiThinking = false; return; }

    // 客户端预校验：位置必须可落子，否则基于最新棋盘重试
    if (!dango.canPlace(game.board_state, move.r, move.c)) {
      if (attempt < AI_MOVE_MAX_RETRY) {
        const self = this;
        setTimeout(() => { self.submitAIMoveWithRetry(attempt + 1); }, 150);
        return;
      }
      this.aiThinking = false;
      return;
    }

    const self = this;
    onlineMatch.makeAIMove(this.data.gameId, move.r, move.c, this.data.aiColor).then((res) => {
      const code = res.result && res.result.code;
      if (code === 200 || code === 409) {
        // 成功，或被 409 状态冲突拦截（由后续 watch 更新接管）
        this.aiThinking = false;
        return;
      }
      const msg = (res.result && res.result.message) || '';
      if (code === 400 && (msg.indexOf('回合') >= 0 || msg.indexOf('已结束') >= 0)) {
        // 棋盘已推进到人类回合/对局结束：放弃，等下一次 onGameUpdate 重新触发，不提示
        this.aiThinking = false;
        return;
      }
      // 非法位置 / 500 / 其他：基于最新棋盘重试
      if (attempt < AI_MOVE_MAX_RETRY) {
        setTimeout(() => { self.submitAIMoveWithRetry(attempt + 1); }, 150);
        return;
      }
      this.aiThinking = false;
      wx.showToast({ title: 'AI 落子异常，请重试', icon: 'none' });
    }).catch((err) => {
      console.error('AI 落子网络错误:', err);
      if (attempt < AI_MOVE_MAX_RETRY) {
        setTimeout(() => { self.submitAIMoveWithRetry(attempt + 1); }, 150);
        return;
      }
      this.aiThinking = false;
      wx.showToast({ title: 'AI 落子异常，请重试', icon: 'none' });
    });
  },

  // ===== 胜利流程 =====
  handleGameOver: function (game) {
    // 停心跳与思考时限倒计时
    this.stopHeartbeat();
    this.stopTurnTimer();

    const won = game.winner === this.data.myColor;
    const reasonText = this.getWinReasonText(game.winner_reason);

    this.setData({ winReasonText: reasonText });

    // 高亮已由 calculateBoardLayout 设置，延迟后弹结算
    setTimeout(() => {
      this.showSettlement(game, won, reasonText);
    }, WIN_HIGHLIGHT_DELAY);
  },

  showSettlement: function (game, won, reasonText) {
    let durationText = '';
    try {
      let start = game.start_time;
      let end = game.end_time;
      if (start && end) {
        const st = start instanceof Date ? start.getTime() : new Date(start).getTime();
        const et = end instanceof Date ? end.getTime() : new Date(end).getTime();
        const diff = Math.max(0, et - st);
        const mm = Math.floor(diff / 60000);
        const ss = Math.floor((diff % 60000) / 1000);
        durationText = (mm < 10 ? '0' + mm : mm) + ':' + (ss < 10 ? '0' + ss : ss);
      }
    } catch (e) {}

    const isBlack = this.data.myColor === 'black';
    const pointsDelta = isBlack ? (game.points_delta_black || 0) : (game.points_delta_white || 0);
    const rankAfter = isBlack ? (game.black_rank_after || this.data.myRankName) : (game.white_rank_after || this.data.myRankName);

    this.setData({
      showSettlement: true,
      settlement: {
        won,
        reasonText,
        moveCount: game.move_count || 0,
        durationText,
        pointsDelta,
        rankName: rankAfter
      }
    });

    // 同步本地段位
    this.syncLocalRank();
  },

  syncLocalRank: function () {
    onlineMatch.getPlayerStats(app.globalData.openid).then((res) => {
      if (res && res.data && res.data.length > 0) {
        const p = res.data[0];
        if (app.updateProfileField) {
          app.updateProfileField('rankPoints', p.rankPoints || 0);
          app.updateProfileField('rankName', p.rankName || rank.getRankName(p.rankPoints || 0));
        }
        app.globalData.rankPoints = p.rankPoints || 0;
        app.globalData.rankName = p.rankName || rank.getRankName(p.rankPoints || 0);
        this.setData({ myRankName: p.rankName || rank.getRankName(p.rankPoints || 0) });
      }
    }).catch(() => {});
  },

  getWinReasonText: function (reason) {
    // 来自 evaluateMove 的原始中文原因（与 dango.js/dango-logic.js 保持一致）
    const map = {
      // 围子胜（规则一/二）
      '十字围': '十字围获胜',
      '边缘十字围': '边缘十字围获胜',
      '斜角围': '斜角围获胜',
      '边缘斜角围': '边缘斜角围获胜',
      // 判负（规则三/四）
      '八方全占（自包围）': '自包围判负',
      '相邻横行连续超过三颗': '连续两排判负',
      '相邻竖列连续超过三颗': '连续两排判负',
      '相邻斜行连续超过三颗': '连续两排判负',
      // 其他
      'surround': '围子获胜',
      'self_surround': '自包围判负',
      'two_rows': '连续两排判负',
      'resign': '认输',
      'disconnect': '对手掉线',
      'timeout': '超时判负'
    };
    return map[reason] || reason || '对局结束';
  },

  // ===== 心跳 =====
  startHeartbeat: function () {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      onlineMatch.heartbeat(this.data.gameId, this.data.sessionId).then((res) => {
        if (res.result && res.result.code === 409) {
          this.handleMultiDevice();
        } else if (res.result && res.result.data && res.result.data.gameOver) {
          // 对方掉线判负
          this.loadGame();
        }
      }).catch((err) => {
        console.error('heartbeat error', err);
      });
    }, HEARTBEAT_INTERVAL);
  },

  stopHeartbeat: function () {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  },

  // ===== 思考时限倒计时 =====
  // 倒计时显示用：以服务端 last_move_time + TURN_TIMEOUT_MS 为权威截止时间，
  // 归零时由客户端触发一次系统随机落子（服务端会二次校验是否真的超时）。
  startTurnTimer: function () {
    if (this.turnTimer) return;
    const self = this;
    this.turnTimer = setInterval(() => { self.tickTurnCountdown(); }, 1000);
  },

  stopTurnTimer: function () {
    if (this.turnTimer) {
      clearInterval(this.turnTimer);
      this.turnTimer = null;
    }
  },

  // 根据当前棋局刷新回合截止时间（每次落子/对局加载时调用）
  updateTurnDeadline: function () {
    const game = this.data.game;
    if (!game || game.status !== 'playing') {
      this.turnDeadline = 0;
      this.turnTimeoutFired = true; // 非对局中不触发超时落子
      return;
    }
    const ts = parseTs(game.last_move_time);
    if (ts && ts !== this._lastMoveTs) {
      this._lastMoveTs = ts;
      this.turnDeadline = ts + TURN_TIMEOUT_MS;
      this.turnTimeoutFired = false;
    }
  },

  tickTurnCountdown: function () {
    if (!this.turnDeadline || this.data.gameOver) {
      if (this.data.turnCountdown !== 0) this.setData({ turnCountdown: 0 });
      if (this.data.turnProgress !== 0) this.setData({ turnProgress: 0 });
      return;
    }
    const remaining = this.turnDeadline - Date.now();
    if (remaining <= 0) {
      this.setData({ turnCountdown: 0, turnProgress: 0 });
      if (!this.turnTimeoutFired) {
        this.turnTimeoutFired = true;
        // 触发系统随机落子；服务端会校验“确实已超时”，若客户端时钟偏快返回 400 则允许下一秒重试
        onlineMatch.timeoutMove(this.data.gameId).then((res) => {
          const code = res && res.result && res.result.code;
          if (code === 400) this.turnTimeoutFired = false;
        }).catch(() => {});
      }
    } else {
      const secs = Math.ceil(remaining / 1000);
      let pct = Math.round((remaining / TURN_TIMEOUT_MS) * 100);
      if (pct > 100) pct = 100;
      if (pct < 0) pct = 0;
      const patch = {};
      if (secs !== this.data.turnCountdown) patch.turnCountdown = secs;
      if (pct !== this.data.turnProgress) patch.turnProgress = pct;
      if (Object.keys(patch).length) this.setData(patch);
    }
  },

  // ===== 落子 =====
  onCellTap: function (e) {
    if (this.data.gameOver || !this.data.isMyTurn || this.data.submitting) return;

    const r = parseInt(e.currentTarget.dataset.r);
    const c = parseInt(e.currentTarget.dataset.c);

    // 已有棋子：取消预览
    if (this.data.cells) {
      const cell = this.data.cells.find(cl => cl.r === r && cl.c === c);
      if (cell && cell.v !== 0) {
        this.clearPending();
        return; // 位置非空
      }
    }

    if (this.pendingCell) {
      if (this.pendingCell.r === r && this.pendingCell.c === c) {
        // 再次点击同一交叉点 → 确认落子
        const pr = r, pc = c;
        this.clearPending();
        this.submitMove(pr, pc);
      } else {
        // 点击另一个空点 → 移动预览位置
        this.setPending(r, c);
      }
    } else {
      this.setPending(r, c);
    }
  },

  submitMove: function (r, c) {
    this.setData({ submitting: true });
    onlineMatch.makeMove(this.data.gameId, r, c, this.data.sessionId).then((res) => {
      this.setData({ submitting: false });
      if (res.result && res.result.code === 200) {
        // 落子成功，watch 会推送更新；这里无需手动更新
      } else if (res.result && res.result.code === 409) {
        this.handleMultiDevice();
      } else if (res.result && res.result.code === 400) {
        const msg = (res.result && res.result.message) || '落子失败';
        if (msg.indexOf('回合') >= 0) {
          // 本地回合状态与服务端不一致：以服务端为准重新同步，避免误报“现在不是您的回合”
          this.loadGame();
          wx.showToast({ title: '回合已同步，请重试', icon: 'none' });
        } else {
          wx.showToast({ title: msg, icon: 'none' });
        }
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '落子失败', icon: 'none' });
      }
    }).catch((err) => {
      this.setData({ submitting: false });
      console.error('落子失败:', err);
      wx.showToast({ title: '网络错误', icon: 'none' });
    });
  },

  // 设置预览交叉点（半透明棋形提示）
  setPending: function (r, c) {
    const size = this.data.boardSize;
    const updates = {};
    if (this.pendingCell) {
      updates['cells[' + (this.pendingCell.r * size + this.pendingCell.c) + '].isPending'] = false;
    }
    updates['cells[' + (r * size + c) + '].isPending'] = true;
    updates.pendingColor = this.data.myColor;
    this.pendingCell = { r: r, c: c };
    this.setData(updates);
  },

  // 清除预览交叉点
  clearPending: function () {
    const size = this.data.boardSize;
    const updates = {};
    if (this.pendingCell) {
      updates['cells[' + (this.pendingCell.r * size + this.pendingCell.c) + '].isPending'] = false;
    }
    updates.pendingColor = '';
    this.pendingCell = null;
    this.setData(updates);
  },

  // ===== 悔棋 =====
  onRequestUndo: function () {
    if (this.data.gameOver || !this.data.isMyTurn || this.data.submitting) return;
    if (this.data.undoUsed) {
      wx.showToast({ title: '本局悔棋次数已用完', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '悔棋',
      content: '确定要请求悔棋吗？（本局仅 1 次免费机会）',
      success: (res) => {
        if (res.confirm) this.doRequestUndo();
      }
    });
  },

  doRequestUndo: function () {
    const targetMoveNumber = Math.max(1, (this.data.game.move_count || 1) - 1);
    onlineMatch.requestUndo(this.data.gameId, targetMoveNumber).then((res) => {
      if (res.result && res.result.code === 200) {
        wx.showToast({ title: '悔棋请求已发送', icon: 'success' });
        this.setData({ undoUsed: true });
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '发送失败', icon: 'none' });
      }
    }).catch(() => {
      wx.showToast({ title: '网络错误', icon: 'none' });
    });
  },

  onApproveUndo: function () { this.handleUndoRequest(true); },
  onRejectUndo: function () { this.handleUndoRequest(false); },

  handleUndoRequest: function (approve) {
    const req = this.data.pendingUndoRequest;
    if (!req) return;
    onlineMatch.handleUndoRequest(req._id, approve).then((res) => {
      if (res.result && res.result.code === 200) {
        this.setData({ pendingUndoRequest: null, showUndoRequest: false });
        if (approve) {
          wx.showToast({ title: '已同意悔棋', icon: 'success' });
          // games 文档会由服务端更新，watch 会推送新棋盘
        } else {
          wx.showToast({ title: '已拒绝悔棋', icon: 'success' });
        }
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '处理失败', icon: 'none' });
      }
    }).catch(() => {
      wx.showToast({ title: '网络错误', icon: 'none' });
    });
  },

  // ===== 认输 =====
  onResign: function () {
    if (this.data.gameOver) return;
    wx.showModal({
      title: '认输',
      content: '确定要认输吗？',
      success: (res) => {
        if (res.confirm) this.doResign();
      }
    });
  },

  doResign: function () {
    onlineMatch.resignGame(this.data.gameId).then((res) => {
      if (res.result && res.result.code === 200) {
        wx.showToast({ title: '已认输', icon: 'success' });
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '认输失败', icon: 'none' });
      }
    }).catch(() => {
      wx.showToast({ title: '网络错误', icon: 'none' });
    });
  },

  // ===== 离开对局 =====
  onLeave: function () {
    if (!this.data.gameOver && this.data.game && this.data.game.status === 'playing') {
      wx.showModal({
        title: '退出对局',
        content: '退出当前对局将被判负，是否继续？',
        confirmText: '退出判负',
        cancelText: '继续对局',
        success: (res) => {
          if (res.confirm) {
            this.leaving = true;
            onlineMatch.resignGame(this.data.gameId).catch(() => {}).then(() => {
              wx.navigateBack({
                fail: () => wx.reLaunch({ url: '/pages/lobby/index' })
              });
            });
          }
        }
      });
    } else {
      this.leaving = true;
      wx.navigateBack({
        fail: () => wx.reLaunch({ url: '/pages/lobby/index' })
      });
    }
  },

  // ===== 多设备登录 =====
  handleMultiDevice: function () {
    this.leaving = true;
    wx.showModal({
      title: '已在其他设备登录',
      content: '本对局已在其他设备打开，将返回大厅。',
      showCancel: false,
      success: () => {
        wx.reLaunch({ url: '/pages/lobby/index' });
      }
    });
  },

  // ===== 结算页按钮 =====
  onBackToHome: function () {
    this.leaving = true;
    wx.reLaunch({ url: '/pages/index/index' });
  },

  onBackToLobby: function () {
    this.leaving = true;
    wx.reLaunch({ url: '/pages/lobby/index' });
  },

  onContinueMatch: function () {
    this.leaving = true;
    wx.redirectTo({ url: '/pages/match/index' });
  },

  // ===== 再来一局 =====
  onRematch: function () {
    if (this.data.rematchSent || this.data.incomingRematch || this.data.rematchProcessing) return;
    this.setData({ rematchProcessing: true });
    onlineMatch.inviteRematch(this.data.gameId).then((res) => {
      this.setData({ rematchProcessing: false });
      const r = res.result;
      if (r && r.code === 200 && r.data) {
        if (r.data.gameId) {
          // AI 对手：直接开新局
          wx.showToast({ title: '已开始新对局', icon: 'none' });
          this.leaving = true;
          wx.redirectTo({ url: '/pages/game-online/index?gameId=' + r.data.gameId });
        } else if (r.data._id) {
          // 真人对手：等待对方同意
          this.setData({ rematchSent: true, rematchInvitationId: r.data._id });
          this.startRematchWatch(r.data._id);
        }
      } else if (r && r.code === 400 && r.data && r.data._id) {
        // 已发送过邀请：进入等待
        this.setData({ rematchSent: true, rematchInvitationId: r.data._id });
        this.startRematchWatch(r.data._id);
      } else {
        wx.showToast({ title: (r && r.message) || '操作失败', icon: 'none' });
      }
    }).catch((err) => {
      this.setData({ rematchProcessing: false });
      console.error('再来一局失败:', err);
      wx.showToast({ title: '网络错误', icon: 'none' });
    });
  },

  // 同意对手的再来一局邀请
  onAcceptRematch: function () {
    const inv = this.data.incomingRematch;
    if (!inv) return;
    onlineMatch.respondRematch(inv._id, true).then((res) => {
      const r = res.result;
      if (r && r.code === 200 && r.data && r.data.gameId) {
        this.leaving = true;
        wx.redirectTo({ url: '/pages/game-online/index?gameId=' + r.data.gameId });
      } else {
        wx.showToast({ title: (r && r.message) || '操作失败', icon: 'none' });
      }
    }).catch(() => {
      wx.showToast({ title: '网络错误', icon: 'none' });
    });
  },

  // 拒绝对手的再来一局邀请
  onRejectRematch: function () {
    const inv = this.data.incomingRematch;
    if (!inv) return;
    onlineMatch.respondRematch(inv._id, false).then(() => {
      this.setData({ incomingRematch: null });
    }).catch(() => {
      wx.showToast({ title: '网络错误', icon: 'none' });
    });
  },

  onCloseSettlement: function () {
    this.setData({ showSettlement: false });
  },

  onClosePromotion: function () {
    this.setData({ showPromotion: false });
  },

  // ===== 清理 =====
  cleanup: function () {
    this.aiThinking = false;
    this.stopHeartbeat();
    this.stopTurnTimer();
    if (this.watcher) {
      try { this.watcher.close(); } catch (e) {}
      this.watcher = null;
    }
    if (this.networkUnsub) {
      this.networkUnsub();
      this.networkUnsub = null;
    }
    if (this.rematchInvitationWatcher) {
      try { this.rematchInvitationWatcher.close(); } catch (e) {}
      this.rematchInvitationWatcher = null;
    }
    if (this.rematchInvWatcher) {
      try { this.rematchInvWatcher.close(); } catch (e) {}
      this.rematchInvWatcher = null;
    }
  }
});
