// 在线对局页
const dango = require('../../utils/dango.js');
const online = require('../../utils/online.js');
const rank = require('../../utils/rank.js');
const app = getApp();

Page({
  data: {
    docId: '',
    boardSize: dango.DEFAULT_SIZE,
    currentPlayer: dango.BLACK,
    gameOver: false,
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
    pendingColor: 0 // 预览落子颜色（1=黑, 2=白），两下落子交互
  },

  // 非响应式
  // this.board      — 二维数组（来自 room 文档）
  // this.starSet    — {key:true}
  // this.watcher    — watch closer
  // this.myOpenid   — 当前用户 openid
  // this._lastAppliedMove — 回声去重
  // this._endedShown
  // this.pendingCell — 两下落子：当前预览中的交叉点 {r,c}，null 表示无预览

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
  },

  onUnload: function () {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
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

    const isEnded = room.status === 'ended' && room.winner !== 0;
    this.setData({
      currentPlayer: room.currentPlayer,
      gameOver: isEnded,
      winner: room.winner,
      winReason: room.winReason,
      moveCount: (room.moves && room.moves.length) || 0,
      myColor: myColor,
      host: room.host,
      guest: room.guest,
      isMyTurn: room.status === 'playing' && room.currentPlayer === myColor,
      pendingColor: 0
    });

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
