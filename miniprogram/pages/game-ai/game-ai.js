// AI 对战页
const app = getApp();
const dango = require('../../utils/dango.js');
const ai = require('../../utils/ai.js');
const undoManager = require('../../utils/undo-manager.js');
const sound = require('../../utils/sound.js');
const rewardedAd = require('../../utils/rewarded-ad.js');
const rank = require('../../utils/rank.js');

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
    undoCount: 1, // 悔棋次数
    undoBtnText: '', // 悔棋按钮文案（动态：悔棋（n）/看广告获取次数/看广告悔棋）
    showUndoAdModal: false, // 是否显示广告提示弹窗
    showMockAd: false, // 是否显示模拟广告弹窗
    mockAdCountdown: 3, // 模拟广告倒计时
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
    pendingMove: null, // 玩家首次点击的待确认位置 {r, c}
    // 自定义结算弹窗
    showResult: false,
    resultWon: false,
    resultReason: '',
    resultElapsed: '',
    resultMoves: 0,
    // 段位相关
    showPromotion: false,
    promotionOldRank: '',
    promotionNewRank: '',
    promotionTierIcon: '',
    rankUpdated: false
  },

  // 非响应式
  // this.board / this.history / this.starSet / this.aiTimer / this.startTime / this._pendingUndo

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
    // 初始化广告
    rewardedAd.init();
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
    // 初始化悔棋次数
    undoManager.init(1);
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
      undoCount: undoManager.getCount(),
      showUndoAdModal: false,
      lastMove: null,
      cellPx: cellPx,
      halfCellPx: halfCellPx,
      gridPx: gridPx,
      cells: cells,
      aiThinking: false,
      elapsed: '',
      pendingMove: null,
      showResult: false,
      undoBtnText: '悔棋（1）'
    });
    this.refreshUndoBtn();
  },

  // 根据当前状态刷新悔棋按钮文案
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

      // 围子胜利（规则1/2）：高亮获胜棋形，延迟弹窗
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
        // 围子胜利：等待动画展示 1.8s 后弹窗
        setTimeout(function () { self.showResultModal(result, elapsedSec); }, 1800);
      } else {
        // 判负：直接弹窗
        this.showResultModal(result, elapsedSec);
      }
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

    // 落子音效（玩家与 AI 落子均触发）
    sound.playStone();
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
    const humanWon = result.winner === this.data.humanPlayer;
    this.setData({
      showResult: true,
      resultWon: humanWon,
      resultReason: result.reason,
      resultElapsed: elapsedSec + '秒',
      resultMoves: this.data.moveCount
    });

    // AI对战后更新段位积分（可配置，默认不影响）
    if (!this.data.rankUpdated) {
      this.updateRankAfterAIGame(humanWon);
    }
  },

  // AI对战后更新段位积分
  updateRankAfterAIGame: function(humanWon) {
    this.data.rankUpdated = true;

    var profile = app.getPlayerProfile();
    if (!profile) return;

    // 读取设置，判断AI对战是否影响段位
    var settings = wx.getStorageSync('settings') || {};
    var mode = settings.rankAffectsAI ? 'ai' : 'local';
    var result = humanWon ? 'win' : 'loss';

    var oldRankName = rank.getRankName(profile.rankPoints);
    var rankResult = rank.applyPointsChange(profile.rankPoints, mode, result);

    // 更新战绩（总是统计AI对战数据）
    rank.updateStats(profile.stats, 'ai', humanWon ? 'win' : 'loss');

    // 只有配置了影响段位时才更新积分
    if (settings.rankAffectsAI) {
      profile.rankPoints = rankResult.newPoints;
      profile.rankName = rankResult.newRank.name;
    }
    app.updatePlayerProfile(profile);

    // 升段动画
    if (rankResult.promoted && settings.rankAffectsAI) {
      var tierIcons = { beginner: '🌱', kyu: '🛡', dan: '💎', master: '👑' };
      this.setData({
        showPromotion: true,
        promotionOldRank: oldRankName,
        promotionNewRank: rankResult.newRank.name,
        promotionTierIcon: tierIcons[rankResult.newRank.tier] || '🌱'
      });
    }
  },

  onClosePromotion: function() {
    this.setData({ showPromotion: false });
  },

  onResultReplay: function () {
    this.setData({ showResult: false });
    this.onNewGame();
  },

  onResultHome: function () {
    this.setData({ showResult: false });
    this.onBackHome();
  },

  // 结果弹窗中的悔棋按钮
  onResultUndo: function () {
    if (!this.data.canUndo) return;

    // 关闭结果弹窗
    this.setData({ showResult: false });

    // 检查悔棋次数
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

  onNewGame: function () {
    if (this.aiTimer) { clearTimeout(this.aiTimer); this.aiTimer = null; }
    this.data.rankUpdated = false;
    this.initGame(this.data.boardSize);
    if (this.data.aiPlayer === dango.BLACK) {
      this.scheduleAIMove();
    }
  },

  // 悔棋：撤销双方各一步（共2步），回到玩家回合
  onUndo: function () {
    if (!this.data.canUndo) return;
    if (this.data.aiThinking) return;
    if (this.history.length === 0) return;

    // 检查悔棋次数
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

  // 执行悔棋操作
  executeUndo: function () {
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
      // 清除胜利标记
      updates['cells[' + idx + '].isWinTarget'] = false;
      updates['cells[' + idx + '].isWinStone'] = false;
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

    // 如果游戏已结束，悔棋后恢复游戏状态
    if (this.data.gameOver) {
      updates.gameOver = false;
      updates.winner = 0;
      updates.winReason = '';
      updates.showResult = false;
      // 清除所有高亮标记（获胜/失败棋形），结束高亮展示
      for (let i = 0; i < this.data.cells.length; i++) {
        if (this.data.cells[i].isWinTarget || this.data.cells[i].isWinStone) {
          updates['cells[' + i + '].isWinTarget'] = false;
          updates['cells[' + i + '].isWinStone'] = false;
        }
      }
    }

    this.setData(updates);
  },

  // 点击观看广告
  onWatchAd: function () {
    const self = this;
    this.setData({ showUndoAdModal: false });

    // 显示模拟广告弹窗
    this.setData({ showMockAd: true, mockAdCountdown: 3 });

    // 倒计时
    let countdown = 3;
    const timer = setInterval(() => {
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

  // 取消观看广告
  onCancelAd: function () {
    this._pendingUndo = false;
    this.setData({ showUndoAdModal: false });
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
