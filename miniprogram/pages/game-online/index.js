// 联网对战对局页面 — watch 实时同步 + 完整流程
const app = getApp();
const dango = require('../../utils/dango.js');
const rank = require('../../utils/rank.js');
const onlineMatch = require('../../utils/online-match.js');
const network = require('../../utils/network.js');

const HEARTBEAT_INTERVAL = 10000; // 10s
const WIN_HIGHLIGHT_DELAY = 1800; // 1.8s 高亮后再弹结算
const REMATCH_TIMEOUT = 15000; // 再来一局邀请超时

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
    rematchSent: false,
    rematchReceived: null,   // 收到的邀请
    rematchCountdown: 0,
    // 段位
    myRankName: '',
    opponentRankName: ''
  },

  // 非 data 状态
  watcher: null,
  heartbeatTimer: null,
  networkUnsub: null,
  rematchTimer: null,
  rematchWatcher: null,
  rematchReceivedTimer: null,
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
  },

  onUnload: function () {
    this.cleanup();
    // 主动退出且对局仍在进行 → 判负
    if (!this.leaving && this.data.game && this.data.game.status === 'playing' && !this.data.gameOver) {
      // 异步认输，不阻塞退出
      onlineMatch.resignGame(this.data.gameId).catch(() => {});
    }
  },

  onHide: function () {
    // 切后台暂停心跳（小程序后台 watch 也会暂停）
    this.stopHeartbeat();
  },

  onShow: function () {
    if (this.data.gameId && this.gameLoaded) {
      this.startHeartbeat();
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
          this.startRematchWatch();
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
    const myOpenid = app.globalData.openid;

    const isBlack = game.black_openid === myOpenid;
    const isWhite = game.white_openid === myOpenid;
    if (!isBlack && !isWhite) {
      wx.showToast({ title: '您不是该游戏的玩家', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }

    const myColor = isBlack ? 'black' : 'white';
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
      undoUsed
    });

    this.calculateBoardLayout(game.board_size, game.board_state, game.last_move, gameOver ? game.win_stones : null, gameOver ? game.win_target : null);

    if (gameOver) {
      this.handleGameOver(game);
    }
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
  },

  // ===== 胜利流程 =====
  handleGameOver: function (game) {
    // 停心跳
    this.stopHeartbeat();

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
    const map = {
      surround: '围子获胜',
      self_surround: '自包围判负',
      two_rows: '连续两排判负',
      resign: '认输',
      disconnect: '对手掉线',
      timeout: '超时判负'
    };
    return map[reason] || '对局结束';
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

  // ===== 再来一局 =====
  onRematch: function () {
    if (this.data.rematchSent) return;
    onlineMatch.inviteRematch(this.data.gameId).then((res) => {
      if (res.result && res.result.code === 200) {
        this.setData({ rematchSent: true });
        wx.showToast({ title: '邀请已发送，等待对方响应', icon: 'none' });
        // 超时
        this.rematchTimer = setTimeout(() => {
          if (this.data.rematchSent) {
            this.setData({ rematchSent: false });
            wx.showToast({ title: '对方未响应，可重新匹配', icon: 'none' });
          }
        }, REMATCH_TIMEOUT);
        // 轮询邀请响应（pending 邀请查不到状态变化，用轮询兜底）
        this.pollInvitation();
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '邀请失败', icon: 'none' });
      }
    }).catch(() => {
      wx.showToast({ title: '网络错误', icon: 'none' });
    });
  },

  // 监听对方发来的再来一局邀请
  startRematchWatch: function () {
    const openid = app.globalData.openid;
    if (!openid) return;
    onlineMatch.watchInvitations(openid, (err, docs) => {
      if (err || !docs) return;
      // 只关注与当前对局相关的、对方发来的邀请
      const incoming = docs.find(d => d.game_id === this.data.gameId && d.to_openid === openid);
      if (incoming) {
        this.setData({ rematchReceived: incoming });
        // 自动超时处理
        if (this.rematchReceivedTimer) clearTimeout(this.rematchReceivedTimer);
        this.rematchReceivedTimer = setTimeout(() => {
          if (this.data.rematchReceived && this.data.rematchReceived._id === incoming._id) {
            this.setData({ rematchReceived: null });
          }
        }, REMATCH_TIMEOUT);
      }
    }).then((watcher) => {
      this.rematchWatcher = watcher;
    }).catch((err) => {
      console.error('watch invitations failed', err);
    });
  },

  pollInvitation: function () {
    const db = wx.cloud.database();
    const openid = app.globalData.openid;
    let count = 0;
    const poll = () => {
      if (!this.data.rematchSent) return;
      if (count > 15) return; // 最多轮询 15 次（约 15s）
      count++;
      db.collection('game_invitations').where({
        from_openid: openid,
        game_id: this.data.gameId
      }).orderBy('created_at', 'desc').limit(1).get().then((res) => {
        if (res.data && res.data.length > 0) {
          const inv = res.data[0];
          if (inv.status === 'accepted' && inv.new_game_id) {
            // 进入新对局
            this.setData({ rematchSent: false });
            if (this.rematchTimer) { clearTimeout(this.rematchTimer); this.rematchTimer = null; }
            this.resetForNewGame(inv.new_game_id);
          } else if (inv.status === 'rejected') {
            this.setData({ rematchSent: false });
            if (this.rematchTimer) { clearTimeout(this.rematchTimer); this.rematchTimer = null; }
            wx.showToast({ title: '对方拒绝再来一局', icon: 'none' });
          } else if (inv.status === 'pending') {
            setTimeout(poll, 1000);
          }
        } else {
          setTimeout(poll, 1000);
        }
      }).catch(() => {
        setTimeout(poll, 1000);
      });
    };
    poll();
  },

  // 响应对方发来的再来一局邀请
  onRespondRematch: function (e) {
    const accept = e.currentTarget.dataset.accept === 'true';
    const inv = this.data.rematchReceived;
    if (!inv) return;
    onlineMatch.respondRematch(inv._id, accept).then((res) => {
      if (res.result && res.result.code === 200) {
        this.setData({ rematchReceived: null });
        if (accept && res.result.data && res.result.data.gameId) {
          this.resetForNewGame(res.result.data.gameId);
        } else if (accept) {
          // 同意但需查询新 gameId
          wx.showToast({ title: '已同意', icon: 'success' });
        } else {
          wx.showToast({ title: '已拒绝', icon: 'none' });
        }
      } else {
        wx.showToast({ title: (res.result && res.result.message) || '操作失败', icon: 'none' });
      }
    }).catch(() => {
      wx.showToast({ title: '网络错误', icon: 'none' });
    });
  },

  // 重置状态进入新对局
  resetForNewGame: function (newGameId) {
    this.cleanup();
    this.gameLoaded = false;
    this.setData({
      gameId: newGameId,
      game: null,
      gameOver: false,
      showSettlement: false,
      settlement: null,
      rematchSent: false,
      rematchReceived: null,
      pendingUndoRequest: null,
      showUndoRequest: false,
      undoUsed: false,
      cells: [],
      winReasonText: '',
      isMyTurn: false,
      submitting: false
    });
    this.loadGame();
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

  onCloseSettlement: function () {
    this.setData({ showSettlement: false });
  },

  onClosePromotion: function () {
    this.setData({ showPromotion: false });
  },

  // ===== 清理 =====
  cleanup: function () {
    this.stopHeartbeat();
    if (this.watcher) {
      try { this.watcher.close(); } catch (e) {}
      this.watcher = null;
    }
    if (this.networkUnsub) {
      this.networkUnsub();
      this.networkUnsub = null;
    }
    if (this.rematchTimer) {
      clearTimeout(this.rematchTimer);
      this.rematchTimer = null;
    }
    if (this.rematchWatcher) {
      try { this.rematchWatcher.close(); } catch (e) {}
      this.rematchWatcher = null;
    }
    if (this.rematchReceivedTimer) {
      clearTimeout(this.rematchReceivedTimer);
      this.rematchReceivedTimer = null;
    }
  }
});
