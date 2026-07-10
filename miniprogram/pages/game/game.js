// 单围棋游戏页
const dango = require('../../utils/dango.js');
const undoManager = require('../../utils/undo-manager.js');
const rewardedAd = require('../../utils/rewarded-ad.js');

Page({
  data: {
    boardSize: dango.DEFAULT_SIZE,
    currentPlayer: dango.BLACK, // 1=黑, 2=白；黑先手
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
    showRules: false,
    lastMove: null, // {r, c}
    pendingColor: 0, // 预览落子的颜色（1=黑, 2=白），用于两下落子交互
    sizeOptions: ['13×13', '15×15', '19×19'],
    sizeIndex: 1, // 默认 15×15
    boardPx: 0, // 棋盘像素尺寸（正方形边长）
    cellPx: 0, // 每个交叉点单元格的像素尺寸
    halfCellPx: 0, // 单元格一半，用于网格线偏移与 wrapper 内边距
    gridPx: 0, // 网格区域像素尺寸
    cells: [] // 棋盘交叉点数据（一维数组，按行展开）
  },

  // 非响应式状态
  // this.board      — 二维数组（实时棋局）
  // this.history    — [{r,c,player}] 悔棋历史
  // this.starSet    — {key: true} 星位查找表
  // this._pendingUndo — 待执行的悔棋操作（观看广告后执行）
  // this.pendingCell — 两下落子：当前预览中的交叉点 {r,c}，null 表示无预览

  onLoad: function (options) {
    let size = dango.DEFAULT_SIZE;
    if (options && options.size) {
      const s = parseInt(options.size, 10);
      if (dango.BOARD_SIZES.indexOf(s) !== -1) size = s;
    }
    const sizeIndex = dango.BOARD_SIZES.indexOf(size);
    const sys = wx.getSystemInfoSync();
    const rpxToPx = sys.windowWidth / 750;
    const paddingPx = 24 * 2 * rpxToPx;
    let boardPx = sys.windowWidth - paddingPx;
    if (boardPx > 820) boardPx = 820;
    this.setData({ boardSize: size, sizeIndex: sizeIndex, boardPx: boardPx });
    // 初始化广告
    rewardedAd.init();
    this.initGame(size);
  },

  onResize: function () {
    // 屏幕旋转/窗口变化时仅重算布局尺寸，cells 数据无需重建
    const sys = wx.getSystemInfoSync();
    const rpxToPx = sys.windowWidth / 750;
    const paddingPx = 24 * 2 * rpxToPx;
    let boardPx = sys.windowWidth - paddingPx;
    if (boardPx > 820) boardPx = 820;
    const size = this.data.boardSize;
    const cellPx = boardPx / (size + 1);
    const halfCellPx = cellPx / 2;
    const gridPx = size * cellPx;
    this.setData({
      boardPx: boardPx,
      cellPx: cellPx,
      halfCellPx: halfCellPx,
      gridPx: gridPx
    });
  },

  initGame: function (size) {
    this.board = dango.createBoard(size);
    this.history = [];
    // 初始化悔棋次数
    undoManager.init(1);
    // 预计算星位查找表
    const stars = dango.starPoints(size);
    this.starSet = {};
    for (let i = 0; i < stars.length; i++) {
      this.starSet[stars[i][0] + '-' + stars[i][1]] = true;
    }
    // 计算布局
    const boardPx = this.data.boardPx;
    const cellPx = boardPx / (size + 1);
    const halfCellPx = cellPx / 2;
    const gridPx = size * cellPx;
    // 构建交叉点数据
    const cells = this.buildCells(null);
    this.pendingCell = null;
    // 一次性 setData，避免中间态
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
      pendingColor: 0,
      cellPx: cellPx,
      halfCellPx: halfCellPx,
      gridPx: gridPx,
      cells: cells
    });
    this.refreshUndoBtn();
  },

  // 本地双人：悔棋无次数限制，始终可直接悔棋
  refreshUndoBtn: function () {
    this.setData({ undoBtnText: '悔棋' });
  },

  // 构建棋盘所有交叉点数据
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
          isPending: false,
          isWinTarget: false,
          isWinStone: false
        });
      }
    }
    return cells;
  },

  // 点击交叉点：两下落子（先预览，再确认）
  onCellTap: function (e) {
    if (this.data.gameOver) {
      wx.showToast({ title: '游戏已结束', icon: 'none', duration: 800 });
      return;
    }
    const r = e.currentTarget.dataset.r;
    const c = e.currentTarget.dataset.c;
    // 越界或已有棋子：取消预览并给出提示
    if (!dango.canPlace(this.board, r, c)) {
      if (this.pendingCell) this.clearPending();
      if (dango.inBounds(r, c, this.board.length) && this.board[r][c] !== dango.EMPTY) {
        wx.showToast({ title: '此处已有棋子', icon: 'none', duration: 800 });
      }
      return;
    }
    if (this.pendingCell) {
      if (this.pendingCell.r === r && this.pendingCell.c === c) {
        // 再次点击同一交叉点 → 确认落子
        const pr = r, pc = c;
        this.clearPending();
        this.placePiece(pr, pc);
      } else {
        // 点击另一个空点 → 移动预览位置
        this.setPending(r, c);
      }
    } else {
      this.setPending(r, c);
    }
  },

  // 设置预览交叉点（半透明棋形提示）
  setPending: function (r, c) {
    const size = this.data.boardSize;
    const updates = {};
    if (this.pendingCell) {
      updates['cells[' + (this.pendingCell.r * size + this.pendingCell.c) + '].isPending'] = false;
    }
    updates['cells[' + (r * size + c) + '].isPending'] = true;
    updates.pendingColor = this.data.currentPlayer;
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
    updates.pendingColor = 0;
    this.pendingCell = null;
    this.setData(updates);
  },

  placePiece: function (r, c) {
    const player = this.data.currentPlayer;
    dango.placePiece(this.board, r, c, player);
    this.history.push({ r: r, c: c, player: player });

    const result = dango.evaluateMove(this.board, r, c, player);
    const oldLast = this.data.lastMove;
    const size = this.data.boardSize;

    // 局部更新 cells（路径式 setData，避免重建整个数组）
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
      const delay = isSurroundWin ? 1800 : 300;
      // 不再自动弹窗，改为在结果横幅中显示悔棋按钮
    } else {
      updates.currentPlayer = dango.opponent(player);
      updates.moveCount = this.data.moveCount + 1;
      updates.canUndo = this.history.length > 0;
      updates.lastMove = { r: r, c: c };
      this.setData(updates);
    }
  },

  onNewGame: function () {
    this.initGame(this.data.boardSize);
  },

  onUndo: function () {
    if (!this.data.canUndo) return;
    if (this.history.length === 0) return;

    // 本地双人：悔棋无次数限制，随时可直接悔棋（含对局失败后复活）
    this._pendingUndo = true;
    this.executeUndo();
    this._pendingUndo = false;
  },

  // 执行悔棋操作
  executeUndo: function () {
    if (this.history.length === 0) return;
    if (this.pendingCell) this.clearPending();
    const last = this.history.pop();
    this.board[last.r][last.c] = dango.EMPTY;
    const prev = this.history[this.history.length - 1] || null;
    const size = this.data.boardSize;

    const updates = {};
    const idx = last.r * size + last.c;
    updates['cells[' + idx + '].v'] = dango.EMPTY;
    updates['cells[' + idx + '].isLast'] = false;

    // 清除胜利标记
    updates['cells[' + idx + '].isWinTarget'] = false;
    updates['cells[' + idx + '].isWinStone'] = false;

    if (prev) {
      const prevIdx = prev.r * size + prev.c;
      updates['cells[' + prevIdx + '].isLast'] = true;
    }
    updates.currentPlayer = last.player;
    updates.moveCount = this.data.moveCount - 1;
    updates.canUndo = this.history.length > 0;
    updates.lastMove = prev ? { r: prev.r, c: prev.c } : null;

    // 如果游戏已结束，悔棋后恢复游戏状态
    if (this.data.gameOver) {
      updates.gameOver = false;
      updates.winner = 0;
      updates.winReason = '';
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

  onToggleRules: function () {
    this.setData({ showRules: !this.data.showRules });
  },

  onSizeChange: function (e) {
    const index = parseInt(e.detail.value, 10);
    const newSize = dango.BOARD_SIZES[index];
    if (newSize === this.data.boardSize) return;
    const self = this;
    const inProgress = this.data.moveCount > 0 && !this.data.gameOver;
    const doSwitch = function () {
      self.setData({ sizeIndex: index });
      self.initGame(newSize);
    };
    if (inProgress) {
      wx.showModal({
        title: '切换棋盘',
        content: '切换棋盘将开始新游戏，确认继续？',
        success: function (res) {
          if (res.confirm) doSwitch();
        }
      });
    } else {
      doSwitch();
    }
  },

  onShareAppMessage: function () {
    return {
      title: '单围棋 - 来下一盘吧',
      path: '/pages/index/index'
    };
  }
});
