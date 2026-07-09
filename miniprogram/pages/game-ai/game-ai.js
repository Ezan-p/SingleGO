// AI 对战页
const dango = require('../../utils/dango.js');
const ai = require('../../utils/ai.js');

const DIFFICULTY_NAMES = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
  master: '大师'
};

Page({
  data: {
    boardSize: dango.DEFAULT_SIZE,
    currentPlayer: dango.BLACK,
    gameOver: false,
    winner: 0,
    winReason: '',
    moveCount: 0,
    canUndo: false,
    lastMove: null,
    sizeOptions: ['13×13', '15×15', '19×19'],
    sizeIndex: 1,
    boardPx: 0,
    cellPx: 0,
    halfCellPx: 0,
    gridPx: 0,
    cells: [],
    // AI 模式专用
    difficulty: 'normal',
    difficultyName: '普通',
    humanPlayer: dango.BLACK, // 玩家执棋色
    aiPlayer: dango.WHITE,    // AI 执棋色
    aiThinking: false,
    elapsed: '',
    pendingMove: null // 玩家首次点击的待确认位置 {r, c}
  },

  // 非响应式
  // this.board / this.history / this.starSet / this.aiTimer / this.startTime

  onLoad: function (options) {
    let size = dango.DEFAULT_SIZE;
    const settings = wx.getStorageSync('settings') || {};
    if (settings.boardSize && dango.BOARD_SIZES.indexOf(settings.boardSize) !== -1) {
      size = settings.boardSize;
    }
    const sizeIndex = dango.BOARD_SIZES.indexOf(size);

    const difficulty = options.difficulty || 'normal';
    const color = options.color || 'black';
    const humanPlayer = color === 'white' ? dango.WHITE : dango.BLACK;
    const aiPlayer = dango.opponent(humanPlayer);

    const sys = wx.getSystemInfoSync();
    const rpxToPx = sys.windowWidth / 750;
    const paddingPx = 24 * 2 * rpxToPx;
    let boardPx = sys.windowWidth - paddingPx;
    if (boardPx > 820) boardPx = 820;

    this.setData({
      boardSize: size,
      sizeIndex: sizeIndex,
      boardPx: boardPx,
      difficulty: difficulty,
      difficultyName: DIFFICULTY_NAMES[difficulty] || '普通',
      humanPlayer: humanPlayer,
      aiPlayer: aiPlayer
    });
    this.initGame(size);

    // 若 AI 执黑（先手），AI 先下
    if (aiPlayer === dango.BLACK) {
      this.scheduleAIMove();
    }
  },

  onUnload: function () {
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
  },

  initGame: function (size) {
    this.board = dango.createBoard(size);
    this.history = [];
    const stars = dango.starPoints(size);
    this.starSet = {};
    for (let i = 0; i < stars.length; i++) {
      this.starSet[stars[i][0] + '-' + stars[i][1]] = true;
    }
    const boardPx = this.data.boardPx;
    const cellPx = boardPx / (size + 1);
    const halfCellPx = cellPx / 2;
    const gridPx = size * cellPx;
    const cells = this.buildCells(null);
    this.startTime = Date.now();
    this.setData({
      boardSize: size,
      currentPlayer: dango.BLACK,
      gameOver: false,
      winner: 0,
      winReason: '',
      moveCount: 0,
      canUndo: false,
      lastMove: null,
      cellPx: cellPx,
      halfCellPx: halfCellPx,
      gridPx: gridPx,
      cells: cells,
      aiThinking: false,
      elapsed: '',
      pendingMove: null
    });
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
          r: r, c: c,
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
    if (this.data.gameOver) {
      wx.showToast({ title: '游戏已结束', icon: 'none', duration: 800 });
      return;
    }
    // AI 回合静默忽略（不显示思考中提示）
    if (this.data.currentPlayer !== this.data.humanPlayer) return;
    if (this.data.aiThinking) return;
    const r = e.currentTarget.dataset.r;
    const c = e.currentTarget.dataset.c;
    if (!dango.canPlace(this.board, r, c)) {
      if (dango.inBounds(r, c, this.board.length) && this.board[r][c] !== dango.EMPTY) {
        wx.showToast({ title: '此处已有棋子', icon: 'none', duration: 800 });
      }
      return;
    }
    const pending = this.data.pendingMove;
    if (pending && pending.r === r && pending.c === c) {
      // 第二次点击同一位置 → 落子
      this.clearPending();
      this.placePiece(r, c);
    } else {
      // 第一次点击或切换新位置 → 确认位置
      this.setPending(r, c);
      wx.showToast({ title: '再次点击确认落子', icon: 'none', duration: 700 });
    }
  },

  setPending: function (r, c) {
    const size = this.data.boardSize;
    const updates = { pendingMove: { r: r, c: c } };
    const old = this.data.pendingMove;
    if (old) {
      updates['cells[' + (old.r * size + old.c) + '].isPending'] = false;
    }
    updates['cells[' + (r * size + c) + '].isPending'] = true;
    this.setData(updates);
  },

  clearPending: function () {
    if (!this.data.pendingMove) return;
    const size = this.data.boardSize;
    const old = this.data.pendingMove;
    const updates = { pendingMove: null };
    updates['cells[' + (old.r * size + old.c) + '].isPending'] = false;
    this.setData(updates);
  },

  placePiece: function (r, c) {
    const player = this.data.currentPlayer;
    dango.placePiece(this.board, r, c, player);
    this.history.push({ r: r, c: c, player: player });

    const result = dango.evaluateMove(this.board, r, c, player);
    const oldLast = this.data.lastMove;
    const size = this.data.boardSize;

    const updates = {};
    const idx = r * size + c;
    updates['cells[' + idx + '].v'] = player;
    updates['cells[' + idx + '].isLast'] = true;
    if (oldLast) {
      const oldIdx = oldLast.r * size + oldLast.c;
      updates['cells[' + oldIdx + '].isLast'] = false;
    }

    if (result.gameOver) {
      updates.gameOver = true;
      updates.winner = result.winner;
      updates.winReason = result.reason;
      updates.moveCount = this.data.moveCount + 1;
      updates.canUndo = this.history.length > 0;
      updates.lastMove = { r: r, c: c };
      const elapsedSec = Math.floor((Date.now() - this.startTime) / 1000);
      updates.elapsed = elapsedSec + '秒';
      this.setData(updates);
      this.showResultModal(result, elapsedSec);
    } else {
      updates.currentPlayer = dango.opponent(player);
      updates.moveCount = this.data.moveCount + 1;
      updates.canUndo = this.history.length > 0;
      updates.lastMove = { r: r, c: c };
      this.setData(updates);
      // 轮到 AI
      if (updates.currentPlayer === this.data.aiPlayer) {
        this.scheduleAIMove();
      }
    }
  },

  scheduleAIMove: function () {
    const self = this;
    this.setData({ aiThinking: true });
    this.aiTimer = setTimeout(function () {
      self.aiTimer = null;
      const mv = ai.chooseMove(self.board, self.data.aiPlayer, self.data.difficulty);
      self.setData({ aiThinking: false });
      if (mv) {
        self.placePiece(mv.r, mv.c);
      }
    }, 400);
  },

  showResultModal: function (result, elapsedSec) {
    const self = this;
    const humanWon = result.winner === this.data.humanPlayer;
    setTimeout(function () {
      wx.showModal({
        title: humanWon ? '恭喜获胜' : '对局失败',
        content: humanWon
          ? '用时：' + elapsedSec + '秒\n落子总数：' + self.data.moveCount + '手'
          : '失败原因：' + result.reason,
        showCancel: true,
        cancelText: '返回首页',
        confirmText: '再来一局',
        success: function (res) {
          if (res.confirm) {
            self.onNewGame();
          } else if (res.cancel) {
            self.onBackHome();
          }
        }
      });
    }, 300);
  },

  onNewGame: function () {
    if (this.aiTimer) { clearTimeout(this.aiTimer); this.aiTimer = null; }
    this.initGame(this.data.boardSize);
    if (this.data.aiPlayer === dango.BLACK) {
      this.scheduleAIMove();
    }
  },

  // 悔棋：撤销双方各一步（共2步），回到玩家回合
  onUndo: function () {
    if (!this.data.canUndo || this.data.gameOver) return;
    if (this.data.aiThinking) return;
    if (this.history.length === 0) return;

    const self = this;
    const size = this.data.boardSize;
    const updates = {};

    // 撤销一颗棋子（从历史栈弹出，恢复空位）
    const popOne = function () {
      if (self.history.length === 0) return;
      const last = self.history.pop();
      self.board[last.r][last.c] = dango.EMPTY;
      const idx = last.r * size + last.c;
      updates['cells[' + idx + '].v'] = dango.EMPTY;
      updates['cells[' + idx + '].isLast'] = false;
    };

    // 撤销最近一手（AI 或玩家）
    popOne();
    // 若仍有历史，再撤一手（撤销双方各一步，回到玩家回合）
    if (this.history.length > 0) {
      popOne();
    }

    const prev = this.history[this.history.length - 1] || null;
    if (prev) {
      const prevIdx = prev.r * size + prev.c;
      updates['cells[' + prevIdx + '].isLast'] = true;
    }
    updates.currentPlayer = this.data.humanPlayer;
    updates.moveCount = this.history.length;
    updates.canUndo = this.history.length > 0;
    updates.lastMove = prev ? { r: prev.r, c: prev.c } : null;
    // 清除待确认位置
    if (this.data.pendingMove) {
      updates.pendingMove = null;
      updates['cells[' + (this.data.pendingMove.r * size + this.data.pendingMove.c) + '].isPending'] = false;
    }
    this.setData(updates);
  },

  onSizeChange: function (e) {
    const index = parseInt(e.detail.value, 10);
    const newSize = dango.BOARD_SIZES[index];
    if (newSize === this.data.boardSize) return;
    const self = this;
    const inProgress = this.data.moveCount > 0 && !this.data.gameOver;
    const doSwitch = function () {
      if (self.aiTimer) { clearTimeout(self.aiTimer); self.aiTimer = null; }
      self.setData({ sizeIndex: index });
      self.initGame(newSize);
      if (self.data.aiPlayer === dango.BLACK) {
        self.scheduleAIMove();
      }
    };
    if (inProgress) {
      wx.showModal({
        title: '切换棋盘',
        content: '切换棋盘将开始新游戏，确认继续？',
        success: function (res) { if (res.confirm) doSwitch(); }
      });
    } else {
      doSwitch();
    }
  },

  onBackHome: function () {
    wx.navigateBack();
  },

  onShareAppMessage: function () {
    return { title: '单围棋 - 来与AI下一盘吧', path: '/pages/index/index' };
  }
});
