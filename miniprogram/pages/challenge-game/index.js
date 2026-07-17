// 残局闯关 · 对局页
// 复用 dango 引擎与 ai 模块，从预设残局续弈。
const dango = require('../../utils/dango.js');
const ai = require('../../utils/ai.js');
const undoManager = require('../../utils/undo-manager.js');
const sound = require('../../utils/sound.js');
const levels = require('../../utils/levels.js');
const progress = require('../../utils/challenge-progress.js');
const rewardedAd = require('../../utils/rewarded-ad.js');

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
    undoCount: 1,
    undoBtnText: '',
    showUndoAdModal: false, // 是否显示广告提示弹窗（复用系统对战）
    showMockAd: false, // 是否显示模拟广告弹窗（复用系统对战）
    mockAdCountdown: 3, // 模拟广告倒计时（复用系统对战）
    lastMove: null,
    cells: [],
    // 关卡信息
    levelId: 1,
    levelName: '第 1 关',
    tierName: '',
    difficultyName: '',
    humanPlayer: dango.BLACK,
    aiPlayer: dango.WHITE,
    aiThinking: false,
    elapsed: '',
    pendingMove: null,
    boardPx: 0,
    cellPx: 0,
    halfCellPx: 0,
    gridPx: 0,
    // 结算弹窗
    showResult: false,
    resultWon: false,
    resultReason: '',
    resultElapsed: '',
    resultMoves: 0,
    showNextLevel: false,
    nextLevelId: 0,
    clearedNew: false // 本次是否首次通关（用于提示）
  },

  // 非响应式
  // this.board / this.history / this.starSet / this.aiTimer / this.startTime / this._pendingUndo / this._level

  onLoad: function (options) {
    const id = parseInt(options.level, 10) || 1;
    const level = levels.getLevel(id);
    if (!level) {
      wx.showToast({ title: '关卡不存在', icon: 'none' });
      setTimeout(function () { wx.navigateBack(); }, 1000);
      return;
    }
    this._level = level;

    // 初始化广告（复用系统对战逻辑）
    rewardedAd.init();

    const sys = wx.getSystemInfoSync();
    const rpxToPx = sys.windowWidth / 750;
    const paddingPx = 24 * 2 * rpxToPx;
    let boardPx = sys.windowWidth - paddingPx;
    if (boardPx > 820) boardPx = 820;

    this.setData({
      levelId: level.id,
      levelName: level.name,
      tierName: level.tierName,
      difficultyName: DIFFICULTY_NAMES[level.difficulty] || '普通',
      humanPlayer: level.humanColor,
      aiPlayer: level.aiColor,
      boardPx: boardPx
    });

    this.initGame(level);
  },

  onUnload: function () {
    if (this.aiTimer) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
  },

  initGame: function (level) {
    this.board = dango.cloneBoard(level.board);
    this.history = [];
    undoManager.init(1); // 残局闯关初始仅 1 次悔棋（与系统对战一致）
    const stars = dango.starPoints(level.boardSize);
    this.starSet = {};
    for (let i = 0; i < stars.length; i++) {
      this.starSet[stars[i][0] + '-' + stars[i][1]] = true;
    }
    const boardPx = this.data.boardPx;
    const cellPx = boardPx / (level.boardSize + 1);
    const halfCellPx = cellPx / 2;
    const gridPx = level.boardSize * cellPx;
    const cells = this.buildCells(null);
    this.startTime = Date.now();
    this.setData({
      boardSize: level.boardSize,
      currentPlayer: level.firstPlayer,
      gameOver: false,
      winner: 0,
      winReason: '',
      moveCount: 0,
      canUndo: false,
      undoCount: undoManager.getCount(),
      lastMove: null,
      cellPx: cellPx,
      halfCellPx: halfCellPx,
      gridPx: gridPx,
      cells: cells,
      aiThinking: false,
      elapsed: '',
      pendingMove: null,
      showResult: false,
      showNextLevel: false,
      nextLevelId: 0,
      clearedNew: false
    });
    this.refreshUndoBtn();

    // 若 AI 先手（真实棋面可能如此），AI 先下
    if (level.firstPlayer === this.data.aiPlayer) {
      this.scheduleAIMove();
    }
  },

  refreshUndoBtn: function () {
    let text;
    if (!this.data.canUndo) {
      text = '悔棋';
    } else if (this.data.undoCount > 0) {
      text = '悔棋（' + this.data.undoCount + '）';
    } else if (this.data.gameOver) {
      text = '广告悔棋';
    } else {
      text = '看广告获取次数';
    }
    this.setData({ undoBtnText: text });
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
          isPending: false,
          isWinTarget: false,
          isWinStone: false
        });
      }
    }
    return cells;
  },

  onCellTap: function (e) {
    if (this.data.gameOver) {
      wx.showToast({ title: '对局已结束', icon: 'none', duration: 800 });
      return;
    }
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
      this.clearPending();
      this.placePiece(r, c);
    } else {
      this.setPending(r, c);
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

      const isSurroundWin = (result.rule === 1 || result.rule === 2);
      if (isSurroundWin && result.winTarget) {
        updates['cells[' + (result.winTarget.r * size + result.winTarget.c) + '].isWinTarget'] = true;
        for (let i = 0; i < result.winStones.length; i++) {
          const s = result.winStones[i];
          updates['cells[' + (s.r * size + s.c) + '].isWinStone'] = true;
        }
      }
      this.setData(updates);
      this.refreshUndoBtn();

      const self = this;
      if (isSurroundWin) {
        setTimeout(function () { self.showResultModal(result, elapsedSec); }, 1800);
      } else {
        this.showResultModal(result, elapsedSec);
      }
    } else {
      updates.currentPlayer = dango.opponent(player);
      updates.moveCount = this.data.moveCount + 1;
      updates.canUndo = this.history.length > 0;
      updates.lastMove = { r: r, c: c };
      this.setData(updates);
      if (updates.currentPlayer === this.data.aiPlayer) {
        this.scheduleAIMove();
      }
    }

    sound.playStone();
  },

  scheduleAIMove: function () {
    const self = this;
    this.setData({ aiThinking: true });
    this.aiTimer = setTimeout(function () {
      self.aiTimer = null;
      const mv = ai.chooseMove(self.board, self.data.aiPlayer, self._level.aiLevel, { lastMove: self.data.lastMove });
      self.setData({ aiThinking: false });
      if (mv) {
        self.placePiece(mv.r, mv.c);
      }
    }, 400);
  },

  showResultModal: function (result, elapsedSec) {
    const humanWon = result.winner === this.data.humanPlayer;
    const updates = {
      showResult: true,
      resultWon: humanWon,
      resultReason: result.reason,
      resultElapsed: elapsedSec + '秒',
      resultMoves: this.data.moveCount
    };
    if (humanWon) {
      const before = progress.getHighestCleared();
      const p = progress.markCleared(this.data.levelId);
      const nextId = this.data.levelId + 1;
      const hasNext = this.data.levelId < progress.TOTAL_LEVELS && nextId <= p.unlockedMax;
      updates.showNextLevel = hasNext;
      updates.nextLevelId = hasNext ? nextId : 0;
      updates.clearedNew = this.data.levelId > before; // 是否刷新了最高记录
    }
    this.setData(updates);
  },

  // 胜利弹窗：下一关
  onResultNext: function () {
    const nextId = this.data.nextLevelId;
    this.setData({ showResult: false });
    if (!nextId) return;
    const level = levels.getLevel(nextId);
    if (!level) return;
    this._level = level;
    this.setData({
      levelId: level.id,
      levelName: level.name,
      tierName: level.tierName,
      difficultyName: DIFFICULTY_NAMES[level.difficulty] || '普通',
      humanPlayer: level.humanColor,
      aiPlayer: level.aiColor
    });
    this.initGame(level);
  },

  // 胜利弹窗：重玩本关
  onResultReplay: function () {
    this.setData({ showResult: false });
    this.initGame(this._level);
  },

  // 失败弹窗：重新挑战（重置本关预设）
  onResultRetry: function () {
    this.setData({ showResult: false });
    this.initGame(this._level);
  },

  // 弹窗：返回选关
  onResultHome: function () {
    this.setData({ showResult: false });
    wx.navigateBack();
  },

  // 控制栏：返回选关
  onBackSelect: function () {
    wx.navigateBack();
  },

  // 控制栏：重新开始（重置本关预设）
  onRestart: function () {
    if (this.aiTimer) { clearTimeout(this.aiTimer); this.aiTimer = null; }
    this.initGame(this._level);
  },

  // 悔棋：撤销双方各一步，回到玩家回合（有限免费次数，用尽后可看广告）
  onUndo: function () {
    if (!this.data.canUndo) return;
    if (this.data.aiThinking) return;
    if (this.history.length === 0) return;

    // 检查悔棋次数（复用系统对战逻辑）
    if (undoManager.getCount() > 0) {
      // 有悔棋次数，执行悔棋
      this._pendingUndo = true;
      this.executeUndo();
      undoManager.consume();
      this.setData({ undoCount: undoManager.getCount() });
      this.refreshUndoBtn();
    } else {
      // 没有悔棋次数，显示广告弹窗（进行中=获取次数，失败=看完自动悔一步不增次数）
      this._pendingUndo = true;
      this.setData({ showUndoAdModal: true });
    }
  },

  executeUndo: function () {
    if (this.history.length === 0) return;
    const self = this;
    const size = this.data.boardSize;
    const updates = {};

    const popOne = function () {
      if (self.history.length === 0) return;
      const last = self.history.pop();
      self.board[last.r][last.c] = dango.EMPTY;
      const idx = last.r * size + last.c;
      updates['cells[' + idx + '].v'] = dango.EMPTY;
      updates['cells[' + idx + '].isLast'] = false;
      updates['cells[' + idx + '].isWinTarget'] = false;
      updates['cells[' + idx + '].isWinStone'] = false;
    };

    popOne();
    if (this.history.length > 0) popOne();

    const prev = this.history[this.history.length - 1] || null;
    if (prev) {
      const prevIdx = prev.r * size + prev.c;
      updates['cells[' + prevIdx + '].isLast'] = true;
    }
    updates.currentPlayer = this.data.humanPlayer;
    updates.moveCount = this.history.length;
    updates.canUndo = this.history.length > 0;
    updates.lastMove = prev ? { r: prev.r, c: prev.c } : null;

    if (this.data.gameOver) {
      updates.gameOver = false;
      updates.winner = 0;
      updates.winReason = '';
      updates.showResult = false;
      for (let i = 0; i < this.data.cells.length; i++) {
        if (this.data.cells[i].isWinTarget || this.data.cells[i].isWinStone) {
          updates['cells[' + i + '].isWinTarget'] = false;
          updates['cells[' + i + '].isWinStone'] = false;
        }
      }
    }

    if (this.data.pendingMove) {
      const pm = this.data.pendingMove;
      updates.pendingMove = null;
      updates['cells[' + (pm.r * size + pm.c) + '].isPending'] = false;
    }

    this.setData(updates);
  },

  // 结果弹窗中的悔棋按钮（复用系统对战逻辑）
  onResultUndo: function () {
    if (!this.data.canUndo) return;

    // 关闭结果弹窗
    this.setData({ showResult: false });

    // 检查悔棋次数
    if (undoManager.getCount() > 0) {
      this._pendingUndo = true;
      this.executeUndo();
      undoManager.consume();
      this.setData({ undoCount: undoManager.getCount() });
      this.refreshUndoBtn();
    } else {
      this._pendingUndo = true;
      this.setData({ showUndoAdModal: true });
    }
  },

  // 点击观看广告（复用系统对战逻辑）
  onWatchAd: function () {
    const self = this;
    this.setData({ showUndoAdModal: false });

    // 显示模拟广告弹窗
    this.setData({ showMockAd: true, mockAdCountdown: 3 });

    // 倒计时
    let countdown = 3;
    const timer = setInterval(function () {
      countdown--;
      if (countdown > 0) {
        self.setData({ mockAdCountdown: countdown });
      } else {
        clearInterval(timer);
        self.setData({ showMockAd: false, mockAdCountdown: 3 });

        if (self.data.gameOver) {
          // 对局失败：看完广告自动悔一步，不增加悔棋次数
          if (self._pendingUndo && self.history.length > 0) {
            self.executeUndo();
          }
          self._pendingUndo = false;
        } else {
          // 对局进行中：看完广告获取 1 次悔棋机会
          undoManager.add(1);
          wx.showToast({ title: '已获得 1 次悔棋机会', icon: 'success', duration: 1500 });

          // 自动执行悔棋（消耗刚获取的次数）
          if (self._pendingUndo) {
            self.executeUndo();
            self._pendingUndo = false;
          }
        }

        // 更新悔棋次数显示与按钮文案
        self.setData({ undoCount: undoManager.getCount() });
        self.refreshUndoBtn();
      }
    }, 1000);
  },

  // 取消观看广告（复用系统对战逻辑）
  onCancelAd: function () {
    this._pendingUndo = false;
    this.setData({ showUndoAdModal: false });
  },

  onShareAppMessage: function () {
    return { title: '单围棋 - 残局闯关', path: '/pages/index/index' };
  }
});
