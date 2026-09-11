// 在线对局页
const dango = require('../../utils/dango.js');
const online = require('../../utils/online.js');
const rank = require('../../utils/rank.js');
const sound = require('../../utils/sound.js');
const app = getApp();

// 每步思考时限(ms)：超时由本端随机落子（好友对战为纯客户端逻辑，仅当前行棋方客户端触发）
const TURN_TIMEOUT_MS = 30000;

Page({
  data: {
    docId: '',
    boardSize: dango.DEFAULT_SIZE,
    currentPlayer: dango.BLACK,
    gameOver: false,
    playing: false,
    winner: 0,
    winReason: '',
    moveCount: 0,
    lastMove: null,
    myColor: 0,            // 1=黑(房主) 2=白(客)
    isMyTurn: false,
    host: null,
    guest: null,
    boardPx: 0,
    cellPx: 0,
    halfCellPx: 0,
    gridPx: 0,
    cells: [],
    myRankName: '',
    pendingColor: 0, // 预览落子颜色（1=黑, 2=白），两下落子交互
    // 思考时限倒计时（剩余秒数，显示用）
    turnCountdown: 0,
    // 思考时限倒计时进度百分比（剩余时间占比，显示用，100→0）
    turnProgress: 100
  },

  // 非响应式
  // this.board      — 二维数组（来自 room 文档）
  // this.starSet    — {key:true}
  // this.watcher    — watch closer
  // this.myOpenid   — 当前用户 openid
  // this._lastAppliedMove — 回声去重
  // this._endedShown
  // this.pendingCell — 两下落子：当前预览中的交叉点 {r,c}，null 表示无预览
  // this.turnTimer        — 思考时限倒计时定时器
  // this.turnDeadline     — 当前回合截止时间戳(ms，本地时钟)
  // this.turnTimeoutFired — 本次回合是否已触发超时落子（防重复触发）
  // this._lastMoveCount   — 上次落子数，用于检测新一步并重置倒计时

  onLoad: function (options) {
    wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage', 'shareTimeline'] });
    const docId = options && options.docId;
    if (!docId) {
      wx.showToast({ title: '缺少对局参数', icon: 'none' });
      setTimeout(function () { wx.navigateBack(); }, 1000);
      return;
    }
    this.myOpenid = getApp().globalData.openid;
    this._lastAppliedMove = null;
    this._endedShown = false;
    this.setData({ myRankName: rank.getRankName(app.globalData.rankPoints) });

    const sys = wx.getSystemInfoSync();
    const rpxToPx = sys.windowWidth / 750;
    const paddingPx = 24 * 2 * rpxToPx;
    let boardPx = sys.windowWidth - paddingPx;
    if (boardPx > 820) boardPx = 820;
    this.setData({ docId: docId, boardPx: boardPx });

    this.watcher = online.subscribeRoom(docId, this.onRoomChange.bind(this));

    // 思考时限倒计时状态初始化
    this.turnDeadline = 0;
    this.turnTimeoutFired = false;
    this._lastMoveCount = undefined;
    this.startTurnTimer();
  },

  onUnload: function () {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.stopTurnTimer();
  },

  onHide: function () {
    // 切后台暂停倒计时（避免后台误触发超时落子）
    this.stopTurnTimer();
  },

  onShow: function () {
    if (this.data.docId) {
      this.startTurnTimer();
    }
  },

  onRoomChange: function (room, err) {
    if (err) {
      wx.showToast({ title: '连接断开', icon: 'none' });
      return;
    }
    this.applyRoom(room);
  },

  applyRoom: function (room) {
    if (!room) return;
    // 远端棋盘变化会重建 cells，清除本地预览状态避免错位
    this.pendingCell = null;
    this._placing = false; // 服务器已回写，解除落子锁
    const myOpenid = this.myOpenid;
    const myColor = (room.host && room.host.openid === myOpenid) ? dango.BLACK
                  : (room.guest && room.guest.openid === myOpenid) ? dango.WHITE : 0;

    const boardSize = room.board.length;
    // 首次：根据 boardSize 计算布局
    if (!this.starSet || (this.data.boardSize !== boardSize)) {
      const stars = dango.starPoints(boardSize);
      this.starSet = {};
      for (let i = 0; i < stars.length; i++) {
        this.starSet[stars[i][0] + '-' + stars[i][1]] = true;
      }
      const boardPx = this.data.boardPx;
      const cellPx = boardPx / (boardSize + 1);
      const halfCellPx = cellPx / 2;
      const gridPx = boardSize * cellPx;
      this.setData({ boardSize: boardSize, cellPx: cellPx, halfCellPx: halfCellPx, gridPx: gridPx });
    }

    // 回声去重：自己写入的最近一步，UI 已反映则跳过棋盘重建
    const isEcho = room.lastMoveBy === myOpenid
      && this._lastAppliedMove
      && room.lastMove
      && this._lastAppliedMove.r === room.lastMove.r
      && this._lastAppliedMove.c === room.lastMove.c;

    if (!isEcho) {
      this.board = room.board;
      const cells = this.buildCells(room.lastMove);
      this._lastAppliedMove = room.lastMove;
      this.setData({ cells: cells, lastMove: room.lastMove });
    }

    // 落子音效：新棋子落到棋盘上时播放（载入对局不发声）
    const curMoves = (room.moves && room.moves.length) || 0;
    if (this._soundMoveCount === undefined) {
      this._soundMoveCount = curMoves;
    } else if (curMoves > this._soundMoveCount) {
      sound.playStone();
      this._soundMoveCount = curMoves;
    }

    const isEnded = room.status === 'ended' && room.winner !== 0;
    this.setData({
      currentPlayer: room.currentPlayer,
      gameOver: isEnded,
      playing: room.status === 'playing',
      winner: room.winner,
      winReason: room.winReason,
      moveCount: (room.moves && room.moves.length) || 0,
      myColor: myColor,
      host: room.host,
      guest: room.guest,
      isMyTurn: room.status === 'playing' && room.currentPlayer === myColor,
      pendingColor: 0
    });

    // 思考时限：每产生一步（moveCount 变化）重置倒计时；对局结束则清零
    if (room.status === 'playing' && (this._lastMoveCount === undefined || curMoves !== this._lastMoveCount)) {
      this._lastMoveCount = curMoves;
      this.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
      this.turnTimeoutFired = false;
    } else if (isEnded) {
      this._lastMoveCount = curMoves;
      this.turnDeadline = 0;
      this.turnTimeoutFired = true;
      this.setData({ turnCountdown: 0, turnProgress: 0 });
    }

    if (isEnded && !this._endedShown) {
      this._endedShown = true;
      const self = this;
      setTimeout(function () {
        wx.showModal({
          title: (room.winner === 1 ? '黑棋' : '白棋') + '胜利',
          content: room.winReason || '',
          showCancel: false,
          confirmText: '返回',
          success: function () {
            wx.navigateBack();
          }
        });
      }, 300);
    }
  },

  buildCells: function (lastMove) {
    const size = this.board.length;
    const cells = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const isStar = !!this.starSet[r + '-' + c];
        const isLast = !!(lastMove && lastMove.r === r && lastMove.c === c);
        cells.push({
          key: r + '-' + c,
          r: r,
          c: c,
          v: this.board[r][c],
          isStar: isStar,
          isLast: isLast,
          isPending: false
        });
      }
    }
    return cells;
  },

  onCellTap: function (e) {
    if (this.data.gameOver) return;
    if (!this.data.isMyTurn) {
      wx.showToast({ title: '等待对手落子', icon: 'none', duration: 800 });
      return;
    }
    if (this._placing) return; // 等待服务器回写，避免重复落子
    const r = e.currentTarget.dataset.r;
    const c = e.currentTarget.dataset.c;
    // 已有棋子：取消预览
    if (this.board[r][c] !== dango.EMPTY) {
      if (this.pendingCell) this.clearPending();
      return;
    }
    if (this.pendingCell) {
      if (this.pendingCell.r === r && this.pendingCell.c === c) {
        // 再次点击同一交叉点 → 确认落子（写库后 watch 回调统一刷新）
        const pr = r, pc = c;
        this.clearPending();
        this.confirmMove(pr, pc);
      } else {
        // 点击另一个空点 → 移动预览位置
        this.setPending(r, c);
      }
    } else {
      this.setPending(r, c);
    }
  },

  confirmMove: function (r, c) {
    const self = this;
    this._placing = true;
    online.placeMove(this.data.docId, { r: r, c: c, player: this.data.myColor })
      .catch(function (err) {
        self._placing = false; // 失败则解锁，允许重试
        wx.showToast({ title: (err && err.message) || '落子失败', icon: 'none', duration: 800 });
      });
  },

  // ===== 思考时限倒计时（好友对战，纯客户端）=====
  // 以“每次落子”为重置点（本地时钟，避免双端时钟偏差），轮到对方时亦显示对方剩余时间。
  // 仅当前行棋方客户端在归零时触发随机落子；回合同时只有一方行棋，自然避免双端重复落子。
  startTurnTimer: function () {
    if (this.turnTimer) return;
    const self = this;
    this.turnTimer = setInterval(function () { self.tickTurnCountdown(); }, 1000);
  },

  stopTurnTimer: function () {
    if (this.turnTimer) {
      clearInterval(this.turnTimer);
      this.turnTimer = null;
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
      // 仅当前行棋方且未在落子提交中时触发随机落子
      if (!this.turnTimeoutFired && this.data.isMyTurn && !this._placing) {
        this.turnTimeoutFired = true;
        this.doTimeoutRandomMove();
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

  // 超时由本端随机落子（系统随机落子），提交时标记 isTimeout
  doTimeoutRandomMove: function () {
    const self = this;
    if (!this.board || this._placing) { this.turnTimeoutFired = false; return; }
    const move = dango.chooseRandomMove(this.board, this.data.myColor);
    if (!move) { this.turnTimeoutFired = false; return; } // 棋盘已满等极端情况：下一秒重试
    this._placing = true;
    online.placeMove(this.data.docId, { r: move.r, c: move.c, player: this.data.myColor, isTimeout: true })
      .then(function () {
        wx.showToast({ title: '超时·系统随机落子', icon: 'none', duration: 1200 });
      })
      .catch(function (err) {
        self._placing = false;
        self.turnTimeoutFired = false; // 允许下次重试
        wx.showToast({ title: (err && err.message) || '超时落子失败', icon: 'none', duration: 1000 });
      });
  },

  // 设置预览交叉点（半透明棋形提示）
  setPending: function (r, c) {
    const size = this.board.length;
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
    const size = this.board.length;
    const updates = {};
    if (this.pendingCell) {
      updates['cells[' + (this.pendingCell.r * size + this.pendingCell.c) + '].isPending'] = false;
    }
    updates.pendingColor = 0;
    this.pendingCell = null;
    this.setData(updates);
  },

  onLeave: function () {
    const self = this;
    wx.showModal({
      title: '离开对局',
      content: '离开将判对手胜利，确认离开？',
      success: function (res) {
        if (!res.confirm) return;
        const role = self.data.myColor === dango.BLACK ? 'host' : 'guest';
        if (self.watcher) {
          self.watcher.close();
          self.watcher = null;
        }
        online.leaveRoom(self.data.docId, role).then(function () {
          wx.navigateBack();
        }).catch(function () {
          wx.navigateBack();
        });
      }
    });
  },

  onShareAppMessage: function () {
    return {
      title: '单围棋·好友对战 进行中',
      path: '/pages/online/online?docId=' + this.data.docId
    };
  }
});
