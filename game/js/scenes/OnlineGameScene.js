// js/scenes/OnlineGameScene.js
// 联网对战对局场景（取代 pages/game-online）
// 完整保留小程序版流程：watch 实时同步、10s 心跳、30s 思考时限（超时系统随机落子）、
// AI 对手客户端驱动落子（带重试）、悔棋请求/同意/拒绝、认输、结算、再来一局、多设备互踢。
// 规则判定仍由云端 gameSync 负责，客户端不改变任何单围棋规则逻辑。

const BaseScene = require('./BaseScene.js');
const ui = require('../render/ui.js');
const boardRenderer = require('../render/BoardRenderer.js');
const board_ = require('../board.js');
const network = require('../network.js');
const storage = require('../storage.js');
const rank = require('../rank.js');
const sound = require('../sound.js');
const ai = require('../ai.js');

const HEARTBEAT_INTERVAL = 10000; // 10s
const WIN_HIGHLIGHT_DELAY = 1800; // 1.8s 高亮后再弹结算
const AI_MOVE_DELAY = 200;        // AI 落子思考延迟(ms)：仅影响体验/手感，不改变 AI 策略与算路
const AI_MOVE_MAX_RETRY = 2;      // AI 落子失败重试次数（基于最新棋盘重算，不改变策略）
const TURN_TIMEOUT_MS = 30000;    // 每步思考时限(ms)：超时由系统随机落子

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

// 胜负原因文案（与 evaluateMove 输出的原始中文原因保持一致）
const REASON_MAP = {
  '十字围': '十字围获胜',
  '边缘十字围': '边缘十字围获胜',
  '斜角围': '斜角围获胜',
  '边缘斜角围': '边缘斜角围获胜',
  '八方全占（自包围）': '自包围判负',
  '相邻横行连续超过三颗': '连续两排判负',
  '相邻竖列连续超过三颗': '连续两排判负',
  '相邻斜行连续超过三颗': '连续两排判负',
  'surround': '围子获胜',
  'self_surround': '自包围判负',
  'two_rows': '连续两排判负',
  'resign': '认输',
  'disconnect': '对手掉线',
  'timeout': '超时判负'
};

function getWinReasonText(reason) {
  return REASON_MAP[reason] || reason || '对局结束';
}

function OnlineGameScene(manager) {
  BaseScene.call(this, manager);
}
OnlineGameScene.prototype = Object.create(BaseScene.prototype);
OnlineGameScene.prototype.constructor = OnlineGameScene;

// ===== 生命周期 =====

OnlineGameScene.prototype.onEnter = function (params) {
  const gameId = (params || {}).gameId;
  this.resetState();

  if (!gameId) {
    wx.showToast({ title: '游戏参数错误', icon: 'none' });
    const self = this;
    setTimeout(function () { self.manager.pop(); }, 1500);
    return;
  }

  this.gameId = gameId;
  // 会话 ID（多设备登录互踢用）
  this.sessionId = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  this.myRankName = rank.getRankName(storage.globalData.rankPoints || 0);

  this.buildLayout();
  this.buildButtons();
  this.loadGame();
  this.subscribeNetwork();
};

OnlineGameScene.prototype.resetState = function () {
  this.gameId = null;
  this.sessionId = '';
  this.game = null;
  this.myColor = null;
  this.myInfo = null;
  this.opponentInfo = null;
  this.boardSize = 15;
  this.layout = null;
  this.gameOver = false;
  this.winReasonText = '';
  this.submitting = false;
  this.isMyTurn = false;
  this.pendingCell = null;

  this.pendingUndoRequest = null;
  this.showUndoRequest = false;
  this.undoUsed = false;

  this.netConnected = true;
  this.showDisconnectBanner = false;

  this.showSettlement = false;
  this.settlement = null;

  this._onlineStatsRecorded = false; // 每局战绩仅计一次，进入新对局时复位

  this.rematchSent = false;
  this.rematchInvitationId = '';
  this.incomingRematch = null;
  this.rematchProcessing = false;

  this.myRankName = '';
  this.opponentRankName = '';

  this.isAIGame = false;
  this.aiColor = '';
  this.aiLevel = '';
  this.aiThinking = false;

  // 点击头像弹出的对局信息（战绩）弹窗
  this.showProfile = false;
  this.profileView = null;       // { name, avatarColor, isAI, stats:{wins,losses,total,winRate} }
  this._oppRandomStats = null;   // 对手（含 AI）随机战绩缓存，避免每次打开都变
  this._avatarHit = null;        // 头像点击区域 { opp:{x,y,w,h}, me:{x,y,w,h} }
  this._aiWatchdog = null;       // AI 落子看门狗定时器（持久，落子成功后才清除）
  this._aiSubmitTimer = null;    // AI 落子重试定时器
  this._aiTurnStartMoveCount = 0; // 触发 AI 落子时的 move_count，用于看门狗判定是否卡住

  this.turnCountdown = 0;
  this.turnProgress = 100;
  this.turnDeadline = 0;
  this.turnTimeoutFired = true;
  this._lastMoveCount = undefined; // 上次落子步数，用于判定“进入新回合”并重置倒计时
  this._soundMoveCount = undefined;

  this.watcher = null;
  this.rematchInvitationWatcher = null;
  this.rematchInvWatcher = null;
  this.heartbeatTimer = null;
  this.networkUnsub = null;
  this.leaving = false;
  this.gameLoaded = false;

  this.phase = 0;
  this._secTick = 0;
  this.toast = null;
  this._toastTimer = 0;
  this._modalButtons = [];
};

OnlineGameScene.prototype.onExit = function () {
  const gameId = this.gameId;
  const shouldResign = !this.leaving && this.game
    && this.game.status === 'playing' && !this.gameOver;
  this.cleanup();
  // 返回大厅时确保匹配按钮恢复（对齐小程序 matchJustCanceled）
  storage.globalData.matchJustCanceled = true;
  // 主动退出且对局仍在进行 → 判负（异步，不阻塞切场景）
  if (shouldResign && gameId) {
    network.resignGame(gameId).catch(function () {});
  }
};

OnlineGameScene.prototype.onHide = function () {
  // 切后台暂停心跳与倒计时
  this.stopHeartbeat();
};

OnlineGameScene.prototype.onShow = function () {
  if (this.gameId && this.gameLoaded) {
    this.startHeartbeat();
    // 重连后全量同步一次
    this.loadGame();
  }
};

// ===== 布局 =====

OnlineGameScene.prototype.buildLayout = function () {
  const vp = this.manager.viewport;
  const pad = 12;
  let span = vp.width - pad * 2;
  const maxSpan = vp.height - vp.top - vp.bottom - 280;
  if (span > maxSpan) span = maxSpan;
  const x = (vp.width - span) / 2;
  const y = vp.top + 138;
  this.layout = board_.createLayout(x, y, span, this.boardSize);
  this.boardBottom = y + span;
};

OnlineGameScene.prototype.buildButtons = function () {
  const vp = this.manager.viewport;
  const self = this;
  this.clearButtons();
  this.addBackButton(vp, function () { self.onLeave(); });

  const pad = 20;
  const w = vp.width - pad * 2;
  const y = Math.min(this.boardBottom + 78, vp.height - vp.bottom - 62);
  const bw = (w - 12) / 2;

  this.undoBtn = this.addButton({
    x: pad, y: y, w: bw, h: 46, text: '请求悔棋',
    bg: ui.COLORS.primary, radius: 12,
    onTap: function () { self.onRequestUndo(); }
  });
  this.resignBtn = this.addButton({
    x: pad + bw + 12, y: y, w: bw, h: 46, text: '认输',
    bg: '#FFFFFF', color: ui.COLORS.danger, border: ui.COLORS.panelBorder, radius: 12,
    onTap: function () { self.onResign(); }
  });
  this.btnRowY = y;
};

// ===== 网络状态订阅 =====

OnlineGameScene.prototype.subscribeNetwork = function () {
  const self = this;
  this.networkUnsub = network.onNetworkChange(function (status) {
    const wasConnected = self.netConnected;
    self.netConnected = status.connected;
    self.showDisconnectBanner = !status.connected;
    if (!wasConnected && status.connected) {
      // 网络恢复，全量重同步
      self.loadGame();
    }
  });
};

// ===== 加载游戏 =====

OnlineGameScene.prototype.loadGame = function () {
  const self = this;
  network.getGameStatus(this.gameId, this.sessionId).then(function (res) {
    if (res.result && res.result.code === 200 && res.result.data) {
      self.onGameDataLoaded(res.result.data);
      if (!self.gameLoaded) {
        self.gameLoaded = true;
        self.startWatchers();
        self.startHeartbeat();
      }
    } else if (res.result && res.result.code === 409) {
      self.handleMultiDevice();
    } else {
      wx.showToast({ title: (res.result && res.result.message) || '加载游戏失败', icon: 'none' });
    }
  }).catch(function (err) {
    console.error('[dango] 加载游戏失败:', err);
    wx.showToast({ title: '网络错误', icon: 'none' });
  });
};

OnlineGameScene.prototype.onGameDataLoaded = function (data) {
  const game = data.game;
  const self = this;

  // 身份以服务端 getGameStatus 返回的 myColor 为准（基于真实 openid 推导，
  // 与 makeMove 的回合校验完全一致），避免本地 openid 不一致导致回合误判。
  let myColor = data.myColor;
  if (!myColor) {
    const myOpenid = storage.globalData.openid;
    const isBlackSide = game.black_openid === myOpenid;
    const isWhiteSide = game.white_openid === myOpenid;
    if (!isBlackSide && !isWhiteSide) {
      wx.showToast({ title: '您不是该游戏的玩家', icon: 'none' });
      setTimeout(function () { self.leaving = true; self.manager.pop(); }, 1500);
      return;
    }
    myColor = isBlackSide ? 'black' : 'white';
  }

  const isBlack = myColor === 'black';
  this.myColor = myColor;
  this.myInfo = isBlack
    ? { nickname: game.black_nickname, avatar: game.black_avatar }
    : { nickname: game.white_nickname, avatar: game.white_avatar };
  this.opponentInfo = isBlack
    ? { nickname: game.white_nickname, avatar: game.white_avatar, rankName: game.white_rank_name || '' }
    : { nickname: game.black_nickname, avatar: game.black_avatar, rankName: game.black_rank_name || '' };
  this.opponentRankName = this.opponentInfo.rankName;
  this.myRankName = rank.getRankName(storage.globalData.rankPoints || 0);

  // AI 对手识别（超时匹配分配的 AI 模拟用户，当作普通对手展示）
  this.isAIGame = !!(game.black_is_ai || game.white_is_ai);
  this.aiColor = game.black_is_ai ? 'black' : (game.white_is_ai ? 'white' : '');
  this.aiLevel = game.ai_level || '';

  // 待处理悔棋请求
  let pendingUndoRequest = null;
  if (data.pendingUndoRequests && data.pendingUndoRequests.length > 0) {
    pendingUndoRequest = data.pendingUndoRequests.find(function (req) {
      return req.requester !== myColor;
    }) || null;
  }
  this.pendingUndoRequest = pendingUndoRequest;
  this.showUndoRequest = !!pendingUndoRequest;

  const gameOver = game.status !== 'playing';
  this.game = game;
  this.gameOver = gameOver;
  this.isMyTurn = !gameOver && game.current_player === myColor;
  this.undoUsed = (game['undo_used_' + myColor] || 0) >= 1;

  this.applyBoard(game);

  // 落子音效：新棋子落到棋盘上时播放（载入对局不发声）
  const newCount = game.move_count || 0;
  if (this._soundMoveCount === undefined) {
    this._soundMoveCount = newCount;
  } else if (newCount > this._soundMoveCount) {
    sound.playStone();
    this._soundMoveCount = newCount;
  }

  if (gameOver) this.handleGameOver(game);

  this.updateTurnDeadline();
  // 防御：当前不是 AI 回合时，清除可能卡住的 aiThinking（同 onGameUpdate）
  if (game.current_player !== this.aiColor) this._stopAIMoveLoop();
  this.maybeTriggerAIMove();
};

// 远端棋盘重建（清除本地预览，避免预览错位）
OnlineGameScene.prototype.applyBoard = function (game) {
  if (!game || !game.board_size || !game.board_state) return;
  this.pendingCell = null;
  if (game.board_size !== this.boardSize) {
    this.boardSize = game.board_size;
    this.buildLayout();
    this.buildButtons();
  }
};

// ===== Watch 实时同步 =====

OnlineGameScene.prototype.startWatchers = function () {
  const self = this;
  const myColor = this.myColor;
  if (!myColor) return;

  this.watcher = network.watchGameAll(this.gameId, myColor, {
    onGame: function (err, game) {
      if (err || !game) return;
      self.onGameUpdate(game);
    },
    onMove: function () {
      // 落子由 onGame 统一处理（games 文档已含 board_state）
    },
    onUndo: function (err, docs) {
      if (err) return;
      if (docs && docs.length > 0) {
        const req = docs[0];
        if (req.requester !== self.myColor) {
          self.pendingUndoRequest = req;
          self.showUndoRequest = true;
        }
      } else {
        self.pendingUndoRequest = null;
        self.showUndoRequest = false;
      }
    },
    onError: function (err) {
      console.error('[dango] watch error', err);
      // watch 出错后回退全量同步
      self.loadGame();
    }
  });

  // 监听对手发来的"再来一局"邀请（仅真人局；AI 不会发起邀请）
  if (!this.isAIGame) {
    network.watchInvitations(storage.globalData.openid, function (err, docs) {
      if (err || !docs) return;
      const inv = (docs || []).find(function (d) {
        return d.game_id === self.gameId && d.status === 'pending';
      });
      if (inv) {
        self.incomingRematch = inv;
      } else if (self.incomingRematch) {
        self.incomingRematch = null;
      }
    }).then(function (w) { self.rematchInvitationWatcher = w; }).catch(function () {});
  }
};

// 发起方：监听自己发出的邀请，对方接受后进入新对局
OnlineGameScene.prototype.startRematchWatch = function (invitationId) {
  if (this.rematchInvWatcher) return;
  const self = this;
  network.watchInvitation(invitationId, function (err, inv) {
    if (err || !inv) return;
    if (inv.status === 'accepted' && inv.new_game_id) {
      self.switchGame(inv.new_game_id);
    } else if (inv.status === 'rejected') {
      self.rematchSent = false;
      self.rematchInvitationId = '';
      self.rematchProcessing = false;
      wx.showToast({ title: '对方拒绝了再来一局', icon: 'none' });
    }
  }).then(function (w) { self.rematchInvWatcher = w; }).catch(function () {});
};

OnlineGameScene.prototype.onGameUpdate = function (game) {
  const prevOver = this.gameOver;
  const gameOver = game.status !== 'playing';

  this.game = game;
  this.gameOver = gameOver;
  this.isMyTurn = !gameOver && game.current_player === this.myColor;
  this.undoUsed = (game['undo_used_' + this.myColor] || 0) >= 1;

  this.applyBoard(game);

  const newCount = game.move_count || 0;
  if (this._soundMoveCount === undefined) {
    this._soundMoveCount = newCount;
  } else if (newCount > this._soundMoveCount) {
    sound.playStone();
    this._soundMoveCount = newCount;
  }

  if (gameOver && !prevOver) this.handleGameOver(game);

  this.updateTurnDeadline();
  // 防御：当前不是 AI 回合时，清除可能卡住的 aiThinking，
  // 避免一旦某次 AI 落子异常后，后续所有 AI 回合都被该标志永久屏蔽而卡死。
  if (game.current_player !== this.aiColor) this._stopAIMoveLoop();
  this.maybeTriggerAIMove();
};

// ===== AI 对手落子驱动 =====
// AI 决策在客户端完成（复用 js/ai.js，策略与算路完全不变），通过 network.makeAIMove
// 代理提交，服务端以 asAI 标记识别并跳过 session 校验。仅在轮到 AI 且对局进行中触发。

// AI 思考锁软复位：清除思考标志与“重试定时器”，但【保留看门狗】。
// 用于某次落子尝试失败时，让看门狗继续在数秒后重触发，保证 AI 永不卡死。
OnlineGameScene.prototype._resetAiThinking = function () {
  this.aiThinking = false;
  if (this._aiSubmitTimer) { clearTimeout(this._aiSubmitTimer); this._aiSubmitTimer = null; }
};

// 彻底停止 AI 落子循环：落子成功 / 对局结束 / 离开对局 / 已非 AI 回合时调用，
// 同时清除看门狗与重试定时器。
OnlineGameScene.prototype._stopAIMoveLoop = function () {
  this.aiThinking = false;
  if (this._aiSubmitTimer) { clearTimeout(this._aiSubmitTimer); this._aiSubmitTimer = null; }
  if (this._aiWatchdog) { clearTimeout(this._aiWatchdog); this._aiWatchdog = null; }
};

OnlineGameScene.prototype.maybeTriggerAIMove = function () {
  if (!this.isAIGame) return;
  const game = this.game;
  if (!game || game.status !== 'playing') return;
  if (game.current_player !== this.aiColor) return;
  if (this.aiThinking) return; // 已在尝试，避免并发落子
  this._armAIMoveLoop();
};

// 进入一次 AI 落子尝试：置思考锁 + 记录手数 + 安排决策提交 + 武装持久看门狗。
OnlineGameScene.prototype._armAIMoveLoop = function () {
  this.aiThinking = true;
  this._aiTurnStartMoveCount = this.game.move_count;
  const self = this;
  // 仅安排“思考延迟”，真正决策移到延迟结束后、提交前那一刻
  clearTimeout(this._aiSubmitTimer);
  this._aiSubmitTimer = setTimeout(function () { self.submitAIMoveWithRetry(0); }, AI_MOVE_DELAY);
  // 持久看门狗：只要仍是 AI 回合且手数未推进（AI 确实没落下子），就持续重触发，
  // 不因某次失败而取消。这是“玩家落子后 AI 必定回应”的终极保障；
  // 即便所有客户端重试都失败，服务端 30s 超时也会随机落子兜底。
  clearTimeout(this._aiWatchdog);
  this._aiWatchdog = setTimeout(function () {
    const cur = self.game;
    if (cur && cur.status === 'playing' && cur.current_player === self.aiColor
        && cur.move_count === self._aiTurnStartMoveCount) {
      self.aiThinking = false; // 允许重新进入循环
      self._armAIMoveLoop();
    }
  }, AI_MOVE_DELAY + 3000);
};

// 实际提交 AI 落子（带重试）。每次都基于最新棋盘重新决策，不改变 AI 策略，
// 仅保证落子位置合法、回合正确。整条重试链保持 aiThinking=true，避免并发落子。
OnlineGameScene.prototype.submitAIMoveWithRetry = function (attempt) {
  const self = this;
  if (!this.isAIGame) { this._stopAIMoveLoop(); return; }
  const game = this.game;
  if (!game || game.status !== 'playing') { this._stopAIMoveLoop(); return; }
  // 棋盘已推进到人类回合：放弃，等下一次 onGameUpdate 重新触发
  if (game.current_player !== this.aiColor) { this._stopAIMoveLoop(); return; }

  const aiPlayer = this.aiColor === 'black' ? board_.BLACK : board_.WHITE;
  let move;
  try {
    move = ai.chooseMove(game.board_state, aiPlayer, this.aiLevel, { lastMove: game.last_move });
  } catch (e) {
    // AI 决策异常不应让 aiThinking 永久卡住：退化为随机合法落子，保证对手总能应答。
    console.error('[dango] AI 决策异常，退化为随机落子:', e);
    move = board_.chooseRandomMove(game.board_state, aiPlayer);
  }
  // 决策返回空（理论极罕见）→ 随机落子
  if (!move) { move = board_.chooseRandomMove(game.board_state, aiPlayer); }
  if (!move) { this._stopAIMoveLoop(); return; } // 全盘已满，放弃

  // 客户端预校验：位置必须可落子，否则基于最新棋盘重试
  if (!board_.canPlace(game.board_state, move.r, move.c)) {
    const rand = board_.chooseRandomMove(game.board_state, aiPlayer);
    if (rand && board_.canPlace(game.board_state, rand.r, rand.c)) {
      move = rand;
    } else if (attempt < AI_MOVE_MAX_RETRY) {
      clearTimeout(this._aiSubmitTimer);
      this._aiSubmitTimer = setTimeout(function () { self.submitAIMoveWithRetry(attempt + 1); }, 150);
      return;
    } else {
      this._resetAiThinking(); // 仅复位标志，保留看门狗持续重触发
      return;
    }
  }

  network.makeAIMove(this.gameId, move.r, move.c, this.aiColor).then(function (res) {
    const code = res.result && res.result.code;
    if (code === 200 || code === 409) {
      // 成功，或被 409 状态冲突拦截（由后续 watch 更新接管）
      // 用服务端权威状态刷新本地回合/倒计时：AI 落子后应立即切回「我的回合」
      // 并重置 30s 倒计时，避免标签卡在对手回合或倒计时不切换。
      const updated = res.result && res.result.data && res.result.data.game;
      if (updated) {
        self.game = updated;
        self.isMyTurn = !self.gameOver && self.game.current_player === self.myColor;
        self.updateTurnDeadline();
      }
      self._stopAIMoveLoop();
      return;
    }
    const msg = (res.result && res.result.message) || '';
    if (code === 400 && (msg.indexOf('回合') >= 0 || msg.indexOf('已结束') >= 0)) {
      // 服务端认为当前不是 AI 回合/对局已结束：可能是状态短暂不同步。
      // 仅复位思考标志、保留看门狗——若稍后 watch 校正为「确为 AI 回合」，
      // 看门狗会在数秒后重新武装并落子，避免 AI 在此回合永久沉默（否则只能等 30s 超时）。
      self._resetAiThinking();
      return;
    }
    // 非法位置 / 500 / 其他：轻量重试一次；重试耗尽则交看门狗在数秒后重触发
    if (attempt < AI_MOVE_MAX_RETRY) {
      clearTimeout(self._aiSubmitTimer);
      self._aiSubmitTimer = setTimeout(function () { self.submitAIMoveWithRetry(attempt + 1); }, 150);
      return;
    }
    console.error('[dango] AI 落子失败（看门狗将持续重试）:', code, msg);
    self._resetAiThinking(); // 仅复位标志，保留看门狗持续重触发
  }).catch(function (err) {
    console.error('[dango] AI 落子网络错误:', err);
    if (attempt < AI_MOVE_MAX_RETRY) {
      clearTimeout(self._aiSubmitTimer);
      self._aiSubmitTimer = setTimeout(function () { self.submitAIMoveWithRetry(attempt + 1); }, 150);
      return;
    }
    console.error('[dango] AI 落子网络错误（看门狗将持续重试）');
    self._resetAiThinking();
  });
};

// ===== 胜负流程 =====

OnlineGameScene.prototype.handleGameOver = function (game) {
  const self = this;
  this.stopHeartbeat();
  this.turnDeadline = 0;

  const won = game.winner === this.myColor;
  const reasonText = getWinReasonText(game.winner_reason);
  this.winReasonText = reasonText;

  // 记录联网对战战绩（仅本地记账：段位/积分已以云端回写为准，这里只累计 stats.online）
  this.recordOnlineStats(won);

  // 高亮 1.8s 后再弹结算（高亮数据来自 game.win_stones / win_target）
  // 注意：联网对局结束后服务端会回写积分/段位，watch 会再推一次新的文档对象，
  // 不能用对象引用 self.game !== game 判断（会误判为已切换对局而取消结算），
  // 改用稳定的 gameId 判定「是否仍是同一局」。
  const gId = game._id || self.gameId;
  setTimeout(function () {
    // 期间已切换到新对局（再来一局）则不再弹旧局结算
    if (!self.gameOver || self.gameId !== gId) return;
    // 用最新文档（self.game）而非闭包里的旧对象：联网对局结束后服务端会回写
    // 积分/段位，旧对象不含 points_delta_* / *_rank_after。
    self.buildSettlement(self.game, won, reasonText);
  }, WIN_HIGHLIGHT_DELAY);
};

// 本地累计联网对战战绩（与 stats.ai / stats.local 保持一致的本地记账方式）
// 注意：段位/积分由 syncLocalRank 以云端回写为准，这里只更新 stats.online，避免重复加分
OnlineGameScene.prototype.recordOnlineStats = function (won) {
  if (this._onlineStatsRecorded) return; // 每局仅计一次
  this._onlineStatsRecorded = true;
  const profile = storage.getPlayerProfile();
  if (!profile) return;
  if (!profile.stats) {
    profile.stats = {
      online: { total: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0 },
      ai: { total: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0 },
      local: { total: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0 }
    };
  }
  rank.updateStats(profile.stats, 'online', won ? 'win' : 'loss');
  storage.updatePlayerProfile(profile);
};

OnlineGameScene.prototype.buildSettlement = function (game, won, reasonText) {
  let durationText = '';
  try {
    const st = parseTs(game.start_time);
    const et = parseTs(game.end_time);
    if (st && et) {
      const diff = Math.max(0, et - st);
      const mm = Math.floor(diff / 60000);
      const ss = Math.floor((diff % 60000) / 1000);
      durationText = (mm < 10 ? '0' + mm : mm) + ':' + (ss < 10 ? '0' + ss : ss);
    }
  } catch (e) {}

  const isBlack = this.myColor === 'black';
  const pointsDelta = isBlack ? (game.points_delta_black || 0) : (game.points_delta_white || 0);
  const rankAfter = isBlack
    ? (game.black_rank_after || this.myRankName)
    : (game.white_rank_after || this.myRankName);

  this.settlement = {
    won: won,
    reasonText: reasonText,
    moveCount: game.move_count || 0,
    durationText: durationText,
    pointsDelta: pointsDelta,
    rankName: rankAfter
  };
  this.showSettlement = true;

  this.syncLocalRank();
};

// 结算后从云端同步本地段位
OnlineGameScene.prototype.syncLocalRank = function () {
  const self = this;
  network.getPlayerStats(storage.globalData.openid).then(function (res) {
    if (res && res.data && res.data.length > 0) {
      const p = res.data[0];
      const points = p.rankPoints || 0;
      const name = p.rankName || rank.getRankName(points);
      storage.updateProfileField('rankPoints', points);
      storage.updateProfileField('rankName', name);
      storage.globalData.rankPoints = points;
      storage.globalData.rankName = name;
      self.myRankName = name;
    }
  }).catch(function () {});
};

// ===== 心跳 =====

OnlineGameScene.prototype.startHeartbeat = function () {
  this.stopHeartbeat();
  const self = this;
  this.heartbeatTimer = setInterval(function () {
    network.heartbeat(self.gameId, self.sessionId).then(function (res) {
      if (res.result && res.result.code === 409) {
        self.handleMultiDevice();
      } else if (res.result && res.result.data && res.result.data.gameOver) {
        // 对方掉线判负
        self.loadGame();
      }
    }).catch(function (err) {
      console.error('[dango] heartbeat error', err);
    });
  }, HEARTBEAT_INTERVAL);
};

OnlineGameScene.prototype.stopHeartbeat = function () {
  if (this.heartbeatTimer) {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
};

// ===== 思考时限倒计时 =====
// 以服务端 last_move_time + TURN_TIMEOUT_MS 为权威截止时间，
// 归零时由客户端触发一次系统随机落子（服务端会二次校验是否真的超时）。

OnlineGameScene.prototype.updateTurnDeadline = function () {
  const game = this.game;
  if (!game || game.status !== 'playing') {
    this.turnDeadline = 0;
    this.turnTimeoutFired = true; // 非对局中不触发超时落子
    return;
  }
  // 每位行棋方独立拥有 30s：每当 move_count 变化（轮到新的行棋方），
  // 以本地时钟把倒计时重置为完整的 30s，而非双方共用同一段倒计时。
  const mc = game.move_count || 0;
  if (mc !== this._lastMoveCount) {
    this._lastMoveCount = mc;
    this.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
    this.turnTimeoutFired = false;
  }
};

OnlineGameScene.prototype.tickTurnCountdown = function () {
  const self = this;
  if (!this.turnDeadline || this.gameOver) {
    this.turnCountdown = 0;
    this.turnProgress = 0;
    return;
  }
  const remaining = this.turnDeadline - Date.now();
  if (remaining <= 0) {
    this.turnCountdown = 0;
    this.turnProgress = 0;
    if (!this.turnTimeoutFired) {
      this.turnTimeoutFired = true;
      // 触发系统随机落子；服务端会校验"确实已超时"，
      // 若客户端时钟偏快返回 400 则允许下一秒重试
      network.timeoutMove(this.gameId).then(function (res) {
        const code = res && res.result && res.result.code;
        if (code === 400) self.turnTimeoutFired = false;
      }).catch(function () {});
    }
  } else {
    this.turnCountdown = Math.ceil(remaining / 1000);
    let pct = Math.round((remaining / TURN_TIMEOUT_MS) * 100);
    if (pct > 100) pct = 100;
    if (pct < 0) pct = 0;
    this.turnProgress = pct;
  }
};

// ===== 落子 =====

OnlineGameScene.prototype.onCellTap = function (r, c) {
  if (this.gameOver || !this.isMyTurn || this.submitting) return;
  const game = this.game;
  if (!game || !game.board_state) return;

  // 已有棋子：取消预览
  if (game.board_state[r][c] !== board_.EMPTY) {
    this.pendingCell = null;
    return;
  }

  if (this.pendingCell) {
    if (this.pendingCell.r === r && this.pendingCell.c === c) {
      // 再次点击同一交叉点 → 确认落子
      this.pendingCell = null;
      this.submitMove(r, c);
      return;
    }
  }
  // 点击空点 → 设置/移动预览位置
  this.pendingCell = { r: r, c: c };
};

OnlineGameScene.prototype.submitMove = function (r, c) {
  const self = this;
  this.submitting = true;
  network.makeMove(this.gameId, r, c, this.sessionId).then(function (res) {
    self.submitting = false;
    const code = res.result && res.result.code;
    if (code === 200) {
      // 落子成功：用服务端返回的权威状态覆盖本地，再直接驱动 AI 落子。
      // 关键点：必须用包含人类刚落之子的最新 board_state / move_count，
      // 否则 AI 会在「缺了对方那颗子」的旧棋盘上决策，往往落回同一格而 400 失败，
      // 且记下的 _aiTurnStartMoveCount 也会比真实值少 1，导致看门狗兜底失效、AI 卡死到 30s 超时。
      if (self.isAIGame && self.game) {
        const updated = res.result && res.result.data && res.result.data.game;
        if (updated) {
          self.game = updated; // 权威状态：board_state / move_count / current_player 全部正确
        } else {
          self.game.current_player = self.aiColor; // 兜底：至少翻转行棋方
        }
        // 立即按权威状态刷新「是否轮到我」与回合倒计时，不依赖 watch 时序。
        // 否则 AI 在 200ms 内快速应招时，回合标签会一直卡在「我的回合」不切换，
        // 倒计时也不会切到对手一方。
        self.isMyTurn = !self.gameOver && self.game.current_player === self.myColor;
        self.updateTurnDeadline();
        self.maybeTriggerAIMove();
      }
      return;
    }
    if (code === 409) {
      self.handleMultiDevice();
      return;
    }
    const msg = (res.result && res.result.message) || '落子失败';
    if (code === 400 && msg.indexOf('回合') >= 0) {
      // 本地回合状态与服务端不一致：以服务端为准重新同步
      self.loadGame();
      wx.showToast({ title: '回合已同步，请重试', icon: 'none' });
      return;
    }
    wx.showToast({ title: msg, icon: 'none' });
  }).catch(function (err) {
    self.submitting = false;
    console.error('[dango] 落子失败:', err);
    wx.showToast({ title: '网络错误', icon: 'none' });
  });
};

// ===== 悔棋 =====

OnlineGameScene.prototype.onRequestUndo = function () {
  if (this.gameOver || !this.isMyTurn || this.submitting) return;
  if (this.undoUsed) {
    wx.showToast({ title: '本局悔棋次数已用完', icon: 'none' });
    return;
  }
  const self = this;
  wx.showModal({
    title: '悔棋',
    content: '确定要请求悔棋吗？（本局仅 1 次免费机会）',
    success: function (res) { if (res.confirm) self.doRequestUndo(); }
  });
};

OnlineGameScene.prototype.doRequestUndo = function () {
  const self = this;
  const targetMoveNumber = Math.max(1, ((this.game && this.game.move_count) || 1) - 1);
  network.requestUndo(this.gameId, targetMoveNumber).then(function (res) {
    if (res.result && res.result.code === 200) {
      wx.showToast({ title: '悔棋请求已发送', icon: 'success' });
      self.undoUsed = true;
    } else {
      wx.showToast({ title: (res.result && res.result.message) || '发送失败', icon: 'none' });
    }
  }).catch(function () {
    wx.showToast({ title: '网络错误', icon: 'none' });
  });
};

OnlineGameScene.prototype.handleUndoRequest = function (approve) {
  const self = this;
  const req = this.pendingUndoRequest;
  if (!req) return;
  network.handleUndoRequest(req._id, approve).then(function (res) {
    if (res.result && res.result.code === 200) {
      self.pendingUndoRequest = null;
      self.showUndoRequest = false;
      wx.showToast({ title: approve ? '已同意悔棋' : '已拒绝悔棋', icon: 'success' });
      // 同意后 games 文档由服务端更新，watch 会推送新棋盘
    } else {
      wx.showToast({ title: (res.result && res.result.message) || '处理失败', icon: 'none' });
    }
  }).catch(function () {
    wx.showToast({ title: '网络错误', icon: 'none' });
  });
};

// ===== 认输 / 退出 =====

OnlineGameScene.prototype.onResign = function () {
  if (this.gameOver) return;
  const self = this;
  wx.showModal({
    title: '认输',
    content: '确定要认输吗？',
    success: function (res) { if (res.confirm) self.doResign(); }
  });
};

OnlineGameScene.prototype.doResign = function () {
  network.resignGame(this.gameId).then(function (res) {
    if (res.result && res.result.code === 200) {
      wx.showToast({ title: '已认输', icon: 'success' });
    } else {
      wx.showToast({ title: (res.result && res.result.message) || '认输失败', icon: 'none' });
    }
  }).catch(function () {
    wx.showToast({ title: '网络错误', icon: 'none' });
  });
};

OnlineGameScene.prototype.onLeave = function () {
  const self = this;
  if (!this.gameOver && this.game && this.game.status === 'playing') {
    wx.showModal({
      title: '退出对局',
      content: '退出当前对局将被判负，是否继续？',
      confirmText: '退出判负',
      cancelText: '继续对局',
      success: function (res) {
        if (!res.confirm) return;
        self.leaving = true;
        network.resignGame(self.gameId).catch(function () {}).then(function () {
          self.backToHome();
        });
      }
    });
  } else {
    this.leaving = true;
    this.backToHome();
  }
};

OnlineGameScene.prototype.backToHome = function () {
  this.leaving = true;
  this.manager.replace('home');
};

// ===== 多设备登录 =====

OnlineGameScene.prototype.handleMultiDevice = function () {
  if (this.leaving) return;
  this.leaving = true;
  const self = this;
  wx.showModal({
    title: '已在其他设备登录',
    content: '本对局已在其他设备打开，将返回主菜单。',
    showCancel: false,
    success: function () { self.manager.replace('home'); }
  });
};

// ===== 再来一局 =====

// 原地切换到新对局（取代 wx.redirectTo）
OnlineGameScene.prototype.switchGame = function (newGameId) {
  this.leaving = true;
  this.cleanup();
  this.onEnter({ gameId: newGameId });
};

OnlineGameScene.prototype.onRematch = function () {
  if (this.rematchSent || this.incomingRematch || this.rematchProcessing) return;
  const self = this;
  this.rematchProcessing = true;
  network.inviteRematch(this.gameId).then(function (res) {
    self.rematchProcessing = false;
    const r = res.result;
    if (r && r.code === 200 && r.data) {
      if (r.data.gameId) {
        // AI 对手：直接开新局
        wx.showToast({ title: '已开始新对局', icon: 'none' });
        self.switchGame(r.data.gameId);
      } else if (r.data._id) {
        // 真人对手：等待对方同意
        self.rematchSent = true;
        self.rematchInvitationId = r.data._id;
        self.startRematchWatch(r.data._id);
      }
    } else if (r && r.code === 400 && r.data && r.data._id) {
      // 已发送过邀请：进入等待
      self.rematchSent = true;
      self.rematchInvitationId = r.data._id;
      self.startRematchWatch(r.data._id);
    } else {
      wx.showToast({ title: (r && r.message) || '操作失败', icon: 'none' });
    }
  }).catch(function (err) {
    self.rematchProcessing = false;
    console.error('[dango] 再来一局失败:', err);
    wx.showToast({ title: '网络错误', icon: 'none' });
  });
};

OnlineGameScene.prototype.onAcceptRematch = function () {
  const inv = this.incomingRematch;
  if (!inv) return;
  const self = this;
  network.respondRematch(inv._id, true).then(function (res) {
    const r = res.result;
    if (r && r.code === 200 && r.data && r.data.gameId) {
      self.switchGame(r.data.gameId);
    } else {
      wx.showToast({ title: (r && r.message) || '操作失败', icon: 'none' });
    }
  }).catch(function () {
    wx.showToast({ title: '网络错误', icon: 'none' });
  });
};

OnlineGameScene.prototype.onRejectRematch = function () {
  const inv = this.incomingRematch;
  if (!inv) return;
  const self = this;
  network.respondRematch(inv._id, false).then(function () {
    self.incomingRematch = null;
  }).catch(function () {
    wx.showToast({ title: '网络错误', icon: 'none' });
  });
};

// ===== 清理 =====

OnlineGameScene.prototype.cleanup = function () {
  this._stopAIMoveLoop();
  this.stopHeartbeat();
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
};

// ===== 触摸 =====

OnlineGameScene.prototype.hasModal = function () {
  return this.showSettlement || !!this.incomingRematch || this.showUndoRequest || this.showProfile;
};

OnlineGameScene.prototype.onTouchStart = function (x, y) {
  if (this.hasModal()) return;
  BaseScene.prototype.onTouchStart.call(this, x, y);
};

OnlineGameScene.prototype.onTouchEnd = function (x, y) {
  if (this.hasModal()) {
    const list = this._modalButtons || [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        b.onTap();
        return;
      }
    }
    // 战绩弹窗：点击遮罩任意处关闭
    if (this.showProfile) this.showProfile = false;
    return;
  }

  // 无弹窗：检测是否点击了头像区域，弹出对局信息
  const hit = this._avatarHit;
  if (hit) {
    if (x >= hit.opp.x && x <= hit.opp.x + hit.opp.w && y >= hit.opp.y && y <= hit.opp.y + hit.opp.h) {
      this.openProfile('opp');
      return;
    }
    if (x >= hit.me.x && x <= hit.me.x + hit.me.w && y >= hit.me.y && y <= hit.me.y + hit.me.h) {
      this.openProfile('me');
      return;
    }
  }

  const consumed = BaseScene.prototype.onTouchEnd.call(this, x, y);
  if (consumed) return;

  if (!this.layout || !this.game) return;
  const cell = board_.pixelToCell(this.layout, x, y, 0.5);
  if (!cell) return;
  this.onCellTap(cell.r, cell.c);
};

// ===== 帧更新 =====

OnlineGameScene.prototype.update = function (dt) {
  this.phase = (this.phase + dt * 0.8) % 1;

  this._secTick += dt;
  if (this._secTick >= 1) {
    this._secTick -= 1;
    this.tickTurnCountdown();
  }

  if (this._toastTimer > 0) {
    this._toastTimer -= dt;
    if (this._toastTimer <= 0) this.toast = null;
  }
};

// ===== 渲染 =====

OnlineGameScene.prototype.render = function (ctx, vp) {
  this.drawBackground(ctx, vp);

  ui.drawText(ctx, '联网对战', vp.width / 2, vp.top + 22, {
    size: 18, bold: true, align: 'center'
  });

  this.drawPlayerBar(ctx, vp);
  this.drawTurnBar(ctx, vp);

  if (this.game && this.game.board_state) {
    boardRenderer.render(ctx, this.layout, this.getBoardRenderState());
  } else {
    ui.drawText(ctx, '对局加载中…', vp.width / 2, vp.height / 2, {
      size: 15, align: 'center', color: ui.COLORS.textSub
    });
  }

  this.drawStatusLine(ctx, vp);

  this.undoBtn.disabled = this.gameOver || !this.isMyTurn || this.undoUsed;
  this.undoBtn.text = this.undoUsed ? '悔棋已用' : '请求悔棋';
  this.resignBtn.disabled = this.gameOver;
  this.drawButtons(ctx);

  if (this.showDisconnectBanner) this.drawDisconnectBanner(ctx, vp);
  if (this.toast) this.drawToast(ctx, vp);

  this._modalButtons = [];
  if (this.showSettlement) this.drawSettlement(ctx, vp);
  else if (this.incomingRematch) this.drawIncomingRematch(ctx, vp);
  else if (this.showUndoRequest) this.drawUndoRequest(ctx, vp);
  else if (this.showProfile) this.drawProfile(ctx, vp);
};

OnlineGameScene.prototype.getBoardRenderState = function () {
  const game = this.game;
  const lastMove = game.last_move
    ? { r: game.last_move.row, c: game.last_move.col }
    : null;
  const pendingPlayer = this.myColor === 'black' ? board_.BLACK : board_.WHITE;
  return {
    board: game.board_state,
    lastMove: lastMove,
    pending: this.pendingCell,
    pendingPlayer: pendingPlayer,
    winStones: this.gameOver ? (game.win_stones || null) : null,
    winTarget: this.gameOver ? (game.win_target || null) : null,
    winIsLoss: this.gameOver ? (game.winner !== this.myColor) : false,
    phase: this.phase
  };
};

// 对手 / 我方信息条
OnlineGameScene.prototype.drawPlayerBar = function (ctx, vp) {
  const y = vp.top + 46;
  ui.drawPanel(ctx, 14, y, vp.width - 28, 46, 12);

  const opp = this.opponentInfo || {};
  const oppColor = this.myColor === 'black' ? board_.WHITE : board_.BLACK;
  ui.fillCircle(ctx, 36, y + 23, 11, oppColor === board_.BLACK ? '#1a1a1a' : '#f5f5f5');
  if (oppColor !== board_.BLACK) {
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(36, y + 23, 11, 0, Math.PI * 2);
    ctx.stroke();
  }
  const oppName = opp.nickname || (this.isAIGame ? 'AI 对手' : '对手');
  ui.drawText(ctx, oppName, 56, y + 16, { size: 14, bold: true });
  const sub = this.isAIGame
    ? ''
    : (this.opponentRankName || '');
  ui.drawText(ctx, sub, 56, y + 33, { size: 11, color: ui.COLORS.textSub });

  // 右侧：我方
  const myName = (this.myInfo && this.myInfo.nickname) || '我';
  ui.drawText(ctx, myName + '（' + (this.myColor === 'black' ? '黑' : '白') + '）',
    vp.width - 38, y + 16, { size: 13, align: 'right', bold: true });
  ui.drawText(ctx, this.myRankName || '', vp.width - 38, y + 33, {
    size: 11, align: 'right', color: ui.COLORS.textSub
  });
  const myStone = this.myColor === 'black' ? board_.BLACK : board_.WHITE;
  ui.fillCircle(ctx, vp.width - 26, y + 23, 8, myStone === board_.BLACK ? '#1a1a1a' : '#f5f5f5');

  // 记录头像点击区域（左侧对手 / 右侧我方），供点击弹出战绩用
  this._avatarHit = {
    opp: { x: 14, y: y, w: vp.width / 2 - 14, h: 46 },
    me: { x: vp.width / 2, y: y, w: vp.width / 2 - 14, h: 46 }
  };
};

// 思考时限进度条
OnlineGameScene.prototype.drawTurnBar = function (ctx, vp) {
  const y = vp.top + 102;
  const x = 16;
  const w = vp.width - 32;

  let label;
  let barColor = ui.COLORS.success;
  if (this.gameOver) {
    label = '对局已结束';
    barColor = ui.COLORS.disabled;
  } else if (this.isMyTurn) {
    label = '你的回合 · ' + this.turnCountdown + 's';
    barColor = this.turnCountdown <= 10 ? ui.COLORS.danger : ui.COLORS.success;
  } else {
    label = (this.isAIGame ? '对手思考中' : '等待对手落子') + ' · ' + this.turnCountdown + 's';
    barColor = ui.COLORS.info;
  }

  ui.drawText(ctx, label, x, y, { size: 12, color: ui.COLORS.textSub });
  ui.drawText(ctx, '第 ' + ((this.game && this.game.move_count) || 0) + ' 手',
    vp.width - x, y, { size: 12, align: 'right', color: ui.COLORS.textSub });

  const barY = y + 12;
  ui.fillRoundRect(ctx, x, barY, w, 5, 2.5, '#E4DACA');
  const pw = Math.max(0, Math.min(w, w * (this.gameOver ? 0 : this.turnProgress) / 100));
  if (pw > 0) ui.fillRoundRect(ctx, x, barY, pw, 5, 2.5, barColor);
};

OnlineGameScene.prototype.drawStatusLine = function (ctx, vp) {
  const y = this.boardBottom + 26;
  let hint;
  if (this.gameOver) {
    hint = this.winReasonText || '对局结束';
  } else if (this.submitting) {
    hint = '落子提交中…';
  } else if (this.pendingCell) {
    hint = '再次点击同一位置确认落子';
  } else if (this.isMyTurn) {
    hint = '点击棋盘预览，再点同一位置确认';
  } else {
    hint = '等待对手落子…';
  }
  ui.drawText(ctx, hint, vp.width / 2, y, {
    size: 13, align: 'center', color: this.gameOver ? ui.COLORS.primary : ui.COLORS.textSub
  });

  if (this.rematchSent) {
    ui.drawText(ctx, '已发送再来一局邀请，等待对方同意…', vp.width / 2, y + 22, {
      size: 12, align: 'center', color: ui.COLORS.info
    });
  }
};

OnlineGameScene.prototype.drawDisconnectBanner = function (ctx, vp) {
  const h = 28;
  const y = vp.top;
  ctx.fillStyle = 'rgba(229,57,53,0.92)';
  ctx.fillRect(0, y, vp.width, h);
  ui.drawText(ctx, '网络已断开，正在尝试重连…', vp.width / 2, y + h / 2, {
    size: 12, color: '#FFFFFF', align: 'center', bold: true
  });
};

OnlineGameScene.prototype.showToastMsg = function (text, duration) {
  this.toast = text;
  this._toastTimer = duration || 1.2;
};

OnlineGameScene.prototype.drawToast = function (ctx, vp) {
  const text = this.toast;
  ctx.save();
  ctx.font = '14px sans-serif';
  const w = ctx.measureText(text).width + 32;
  ctx.restore();
  const x = (vp.width - w) / 2;
  const y = vp.height * 0.62;
  ui.fillRoundRect(ctx, x, y, w, 36, 18, 'rgba(0,0,0,0.72)');
  ui.drawText(ctx, text, vp.width / 2, y + 18, { size: 14, color: '#FFFFFF', align: 'center' });
};

// ===== 弹窗 =====

OnlineGameScene.prototype._modalBox = function (ctx, vp, h) {
  ui.drawMask(ctx, vp.width, vp.height);
  const w = Math.min(310, vp.width - 44);
  const x = (vp.width - w) / 2;
  const y = (vp.height - h) / 2;
  ui.fillRoundRect(ctx, x, y, w, h, 16, '#FFFFFF');
  return { x: x, y: y, w: w, h: h };
};

OnlineGameScene.prototype._modalButton = function (ctx, x, y, w, h, text, bg, color, onTap) {
  ui.fillRoundRect(ctx, x, y, w, h, 10, bg);
  ui.drawText(ctx, text, x + w / 2, y + h / 2, {
    size: 15, color: color, align: 'center', bold: true
  });
  this._modalButtons.push({ x: x, y: y, w: w, h: h, onTap: onTap });
};

// ===== 头像点击：对局信息（战绩）弹窗 =====

// 生成随机战绩（AI / 无数据对手使用）
function genRandomStats() {
  const total = 20 + Math.floor(Math.random() * 180); // 20~200 局
  const wins = Math.floor(Math.random() * (total + 1));
  const losses = total - wins;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
  return { wins: wins, losses: losses, total: total, winRate: winRate };
}

// 取某一方战绩数据
OnlineGameScene.prototype.getProfileStats = function (which) {
  if (which === 'me') {
    // 我方：读取本地真实战绩（联网模式统计）
    let s = null;
    try {
      const profile = storage.getPlayerProfile();
      if (profile && profile.stats && profile.stats.online) s = profile.stats.online;
    } catch (e) {}
    if (s) {
      const total = s.total || 0;
      const wins = s.wins || 0;
      const losses = s.losses || 0;
      return {
        wins: wins,
        losses: losses,
        total: total,
        winRate: total > 0 ? Math.round((wins / total) * 100) : 0
      };
    }
    return { wins: 0, losses: 0, total: 0, winRate: 0 };
  }
  // 对手：AI 或无数据来源 → 随机（会话内缓存稳定）
  if (!this._oppRandomStats) this._oppRandomStats = genRandomStats();
  return this._oppRandomStats;
};

OnlineGameScene.prototype.openProfile = function (which) {
  const isMe = which === 'me';
  const isAI = !isMe && this.isAIGame;
  const color = isMe
    ? (this.myColor === 'black' ? board_.BLACK : board_.WHITE)
    : (this.myColor === 'black' ? board_.WHITE : board_.BLACK);
  const name = isMe
    ? ((this.myInfo && this.myInfo.nickname) || '我')
    : ((this.opponentInfo && this.opponentInfo.nickname) || (this.isAIGame ? 'AI 对手' : '对手'));
  this.profileView = {
    name: name,
    isAI: isAI,
    avatarColor: color === board_.BLACK ? '#1a1a1a' : '#f5f5f5',
    stats: this.getProfileStats(which)
  };
  this.showProfile = true;
};

OnlineGameScene.prototype.drawProfile = function (ctx, vp) {
  const self = this;
  const v = this.profileView || { stats: { wins: 0, losses: 0, total: 0, winRate: 0 } };
  const box = this._modalBox(ctx, vp, 300);
  const cx = box.x + box.w / 2;

  // 头像（棋子色圆）
  const ax = cx, ay = box.y + 54;
  ui.fillCircle(ctx, ax, ay, 28, v.avatarColor);
  if (v.avatarColor !== '#1a1a1a') {
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ax, ay, 28, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (v.isAI) {
    ui.drawText(ctx, 'AI', ax, ay, { size: 16, align: 'center', bold: true, color: v.avatarColor === '#1a1a1a' ? '#FFFFFF' : '#1a1a1a' });
  }

  // 昵称
  ui.drawText(ctx, v.name, cx, box.y + 100, { size: 17, align: 'center', bold: true });
  if (v.isAI) {
    ui.drawText(ctx, 'AI 对手', cx, box.y + 122, { size: 12, align: 'center', color: ui.COLORS.textSub });
  }

  // 战绩三栏
  const st = v.stats;
  const cols = [
    { label: '胜场', value: st.wins },
    { label: '负场', value: st.losses },
    { label: '胜率', value: st.winRate + '%' }
  ];
  const colW = box.w / 3;
  for (let i = 0; i < cols.length; i++) {
    const xc = box.x + colW * (i + 0.5);
    ui.drawText(ctx, String(cols[i].value), xc, box.y + 168, { size: 22, align: 'center', bold: true, color: ui.COLORS.primary });
    ui.drawText(ctx, cols[i].label, xc, box.y + 192, { size: 12, align: 'center', color: ui.COLORS.textSub });
  }

  // 总场次
  ui.drawText(ctx, '总对局 ' + st.total + ' 场', cx, box.y + 220, { size: 12, align: 'center', color: ui.COLORS.textSub });

  // 关闭按钮
  const btnW = box.w - 48, btnH = 42, btnX = box.x + 24, btnY = box.y + box.h - btnH - 22;
  this._modalButton(ctx, btnX, btnY, btnW, btnH, '关闭', ui.COLORS.primary, '#FFFFFF', function () {
    self.showProfile = false;
  });
};

OnlineGameScene.prototype.drawSettlement = function (ctx, vp) {
  const self = this;
  const s = this.settlement || {};
  const box = this._modalBox(ctx, vp, 306);

  ui.drawText(ctx, s.won ? '胜利！' : '惜败', vp.width / 2, box.y + 44, {
    size: 26, bold: true, align: 'center',
    color: s.won ? ui.COLORS.success : ui.COLORS.danger
  });
  ui.drawText(ctx, s.reasonText || '', vp.width / 2, box.y + 78, {
    size: 14, align: 'center', color: ui.COLORS.textSub
  });

  const infoY = box.y + 108;
  ui.drawText(ctx, '共 ' + (s.moveCount || 0) + ' 手' +
    (s.durationText ? ('  ·  用时 ' + s.durationText) : ''),
    vp.width / 2, infoY, { size: 13, align: 'center', color: ui.COLORS.textSub });

  const delta = s.pointsDelta || 0;
  const deltaText = (delta > 0 ? '+' : '') + delta;
  ui.drawText(ctx, '积分 ' + deltaText + '  ·  ' + (s.rankName || ''),
    vp.width / 2, infoY + 26, {
      size: 14, align: 'center', bold: true,
      color: delta >= 0 ? ui.COLORS.success : ui.COLORS.danger
    });

  const bw = (box.w - 48) / 2;
  const by = box.y + 172;
  const rematchText = this.rematchSent ? '等待对方…' : '再来一局';
  this._modalButton(ctx, box.x + 16, by, bw, 42, rematchText,
    this.rematchSent ? ui.COLORS.disabled : ui.COLORS.success, '#FFFFFF', function () {
      if (!self.rematchSent) self.onRematch();
    });
  this._modalButton(ctx, box.x + 32 + bw, by, bw, 42, '继续匹配',
    ui.COLORS.primary, '#FFFFFF', function () {
      self.leaving = true;
      self.manager.replace('home');
      self.manager.push('match');
    });
  this._modalButton(ctx, box.x + 16, by + 52, box.w - 32, 42, '返回主菜单',
    '#F0E4D0', ui.COLORS.text, function () { self.backToHome(); });
  this._modalButton(ctx, box.x + 16, by + 104, box.w - 32, 30, '查看棋盘',
    '#FFFFFF', ui.COLORS.textSub, function () { self.showSettlement = false; });
};

OnlineGameScene.prototype.drawUndoRequest = function (ctx, vp) {
  const self = this;
  const box = this._modalBox(ctx, vp, 186);
  ui.drawText(ctx, '对手请求悔棋', vp.width / 2, box.y + 40, {
    size: 18, bold: true, align: 'center'
  });
  ui.drawWrappedText(ctx, '对手希望撤回上一步棋，是否同意？', box.x + 20, box.y + 78,
    box.w - 40, 20, { size: 13, color: ui.COLORS.textSub, align: 'left' });

  const bw = (box.w - 48) / 2;
  const by = box.y + box.h - 60;
  this._modalButton(ctx, box.x + 16, by, bw, 42, '拒绝', '#F0E4D0', ui.COLORS.text, function () {
    self.handleUndoRequest(false);
  });
  this._modalButton(ctx, box.x + 32 + bw, by, bw, 42, '同意', ui.COLORS.success, '#FFFFFF', function () {
    self.handleUndoRequest(true);
  });
};

OnlineGameScene.prototype.drawIncomingRematch = function (ctx, vp) {
  const self = this;
  const box = this._modalBox(ctx, vp, 186);
  ui.drawText(ctx, '再来一局邀请', vp.width / 2, box.y + 40, {
    size: 18, bold: true, align: 'center'
  });
  ui.drawWrappedText(ctx, '对手邀请你再来一局，是否接受？', box.x + 20, box.y + 78,
    box.w - 40, 20, { size: 13, color: ui.COLORS.textSub, align: 'left' });

  const bw = (box.w - 48) / 2;
  const by = box.y + box.h - 60;
  this._modalButton(ctx, box.x + 16, by, bw, 42, '拒绝', '#F0E4D0', ui.COLORS.text, function () {
    self.onRejectRematch();
  });
  this._modalButton(ctx, box.x + 32 + bw, by, bw, 42, '接受', ui.COLORS.success, '#FFFFFF', function () {
    self.onAcceptRematch();
  });
};

module.exports = function (manager) { return new OnlineGameScene(manager); };
