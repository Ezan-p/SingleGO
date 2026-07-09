// 联网对战游戏页面
const app = getApp();
const dango = require('../../utils/dango.js');
const rank = require('../../utils/rank.js');

Page({
  data: {
    gameId: null,                    // 游戏ID
    game: null,                      // 游戏数据
    myPlayer: null,                  // 我的玩家身份：black/white
    myColor: null,                   // 我的棋子颜色：black/white
    opponentInfo: null,              // 对手信息
    myInfo: null,                    // 我的信息
    boardPx: 0,                      // 棋盘像素大小
    cellPx: 0,                       // 单元格像素大小
    halfCellPx: 0,                   // 半单元格像素大小
    gridPx: 0,                       // 网格像素大小
    cells: [],                       // 棋盘单元格数据
    gameOver: false,                 // 游戏是否结束
    winReasonText: '',               // 胜利原因文本
    pendingUndoRequest: null,        // 待处理的悔棋请求
    showUndoRequest: false,          // 是否显示悔棋请求弹窗
    isMyTurn: false,                 // 是否是我的回合
    pollTimer: null,                 // 轮询计时器
    undoRequestTimer: null,          // 悔棋请求计时器
    // 段位相关
    myRankName: '',
    opponentRankName: '',
    showPromotion: false,
    promotionOldRank: '',
    promotionNewRank: '',
    promotionTierIcon: '',
    rankUpdated: false               // 防止重复更新段位
  },

  onLoad: function(options) {
    const gameId = options.gameId;
    if (!gameId) {
      wx.showToast({ title: '游戏参数错误', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }

    this.setData({ gameId: gameId });
    
    // 获取系统信息计算棋盘大小
    const sys = wx.getSystemInfoSync();
    const rpxToPx = sys.windowWidth / 750;
    const paddingPx = 24 * 2 * rpxToPx;
    let boardPx = sys.windowWidth - paddingPx;
    if (boardPx > 820) boardPx = 820;
    
    this.setData({ boardPx: boardPx });
    
    // 加载游戏
    this.loadGame();
    
    // 开始轮询游戏状态
    this.startPolling();
  },

  onUnload: function() {
    // 清理计时器
    this.clearTimers();
  },

  onShow: function() {
    // 页面显示时恢复轮询
    if (this.data.gameId && !this.data.pollTimer) {
      this.startPolling();
    }
  },

  onHide: function() {
    // 页面隐藏时暂停轮询
    this.clearTimers();
  },

  // 加载游戏
  loadGame: function() {
    wx.showLoading({ title: '��载中...' });
    
    wx.cloud.callFunction({
      name: 'gameSync',
      data: {
        $url: 'getGameStatus',
        gameId: this.data.gameId
      }
    }).then(res => {
      wx.hideLoading();
      
      if (res.result.code === 200) {
        this.onGameDataLoaded(res.result.data);
      } else {
        wx.showToast({ title: res.result.message || '加载游戏失败', icon: 'none' });
        console.error('加载游戏失败:', res.result);
      }
    }).catch(err => {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
      console.error('加载游戏失败:', err);
    });
  },

  // 游戏数据加载完成
  onGameDataLoaded: function(data) {
    const game = data.game;
    const myOpenid = app.globalData.openid;
    
    // 确定我的玩家身份
    const isBlack = game.black_openid === myOpenid;
    const isWhite = game.white_openid === myOpenid;
    
    if (!isBlack && !isWhite) {
      wx.showToast({ title: '您不是该游戏的玩家', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }
    
    const myPlayer = isBlack ? 'black' : 'white';
    const myColor = isBlack ? 'black' : 'white';
    
    // 设置玩家信息
    const myInfo = isBlack ? {
      nickname: game.black_nickname,
      avatar: game.black_avatar
    } : {
      nickname: game.white_nickname,
      avatar: game.white_avatar
    };
    
    const opponentInfo = isBlack ? {
      nickname: game.white_nickname,
      avatar: game.white_avatar
    } : {
      nickname: game.black_nickname,
      avatar: game.black_avatar
    };
    
    // 检查是否有待处理的悔棋请求
    let pendingUndoRequest = null;
    if (data.pendingUndoRequests && data.pendingUndoRequests.length > 0) {
      // 找到不是自己发起的悔棋请求
      pendingUndoRequest = data.pendingUndoRequests.find(req => 
        req.requester !== myPlayer
      );
    }
    
    // 计算棋盘布局
    this.calculateBoardLayout(game.board_size, game.board_state);
    
    // 检查游戏状态
    const gameOver = game.status !== 'playing';
    let winReasonText = '';
    
    if (gameOver) {
      winReasonText = this.getWinReasonText(game);
    }
    
    this.setData({
      game: game,
      myPlayer: myPlayer,
      myColor: myColor,
      myInfo: myInfo,
      opponentInfo: opponentInfo,
      gameOver: gameOver,
      winReasonText: winReasonText,
      isMyTurn: !gameOver && game.current_player === myPlayer,
      pendingUndoRequest: pendingUndoRequest,
      showUndoRequest: !!pendingUndoRequest,
      myRankName: rank.getRankName(app.globalData.rankPoints),
      opponentRankName: game.winner !== undefined ? '' : ''
    });

    // 游戏结束时更新段位积分
    if (gameOver && !this.data.rankUpdated) {
      this.updateRankAfterGame(game, myPlayer);
    }
  },

  // 计算棋盘布局
  calculateBoardLayout: function(boardSize, boardState) {
    if (!boardSize || !boardState) return;
    
    const boardPx = this.data.boardPx;
    const cellPx = boardPx / (boardSize + 1);
    const halfCellPx = cellPx / 2;
    const gridPx = boardSize * cellPx;
    
    // 计算星位点
    const stars = dango.starPoints(boardSize);
    const starSet = {};
    for (let i = 0; i < stars.length; i++) {
      starSet[stars[i][0] + '-' + stars[i][1]] = true;
    }
    
    // 构建单元格数据
    const cells = [];
    for (let r = 0; r < boardSize; r++) {
      for (let c = 0; c < boardSize; c++) {
        cells.push({
          key: `${r}-${c}`,
          r: r,
          c: c,
          v: boardState[r][c],
          isStar: !!starSet[`${r}-${c}`],
          isLast: false // 需要从游戏数据中获取最后一步
        });
      }
    }
    
    this.setData({
      boardSize: boardSize,
      cellPx: cellPx,
      halfCellPx: halfCellPx,
      gridPx: gridPx,
      cells: cells
    });
  },

  // 获取胜利原因文本
  getWinReasonText: function(game) {
    const reasons = {
      'surround': '围子获胜',
      'self_surround': '自包围判负',
      'two_rows': '连续两排判负',
      'resign': '对手认输',
      'disconnect': '对手掉线',
      'timeout': '超时判负'
    };
    
    return reasons[game.winner_reason] || '游戏结束';
  },

  // 开始轮询游戏状态
  startPolling: function() {
    this.clearTimers();
    
    this.data.pollTimer = setInterval(() => {
      this.pollGameStatus();
    }, 2000); // 每2秒轮询一次
  },

  // 轮询游戏状态
  pollGameStatus: function() {
    if (!this.data.gameId) return;
    
    wx.cloud.callFunction({
      name: 'gameSync',
      data: {
        $url: 'getGameStatus',
        gameId: this.data.gameId
      }
    }).then(res => {
      if (res.result.code === 200) {
        const game = res.result.data.game;
        
        // 检查游戏状态是否变化
        if (this.data.game && game.status !== this.data.game.status) {
          // 游戏状态变化，重新加载
          this.onGameDataLoaded(res.result.data);
        } else if (this.data.game && 
                   (game.move_count !== this.data.game.move_count ||
                    game.current_player !== this.data.game.current_player)) {
          // 棋步或回合变化，更新数据
          this.setData({
            'game.move_count': game.move_count,
            'game.current_player': game.current_player,
            'game.board_state': game.board_state,
            'game.last_move_time': game.last_move_time,
            isMyTurn: !this.data.gameOver && game.current_player === this.data.myPlayer
          });
          
          // 更新棋盘显示
          this.calculateBoardLayout(game.board_size, game.board_state);
        }
        
        // 检查悔棋请求
        if (res.result.data.pendingUndoRequests && 
            res.result.data.pendingUndoRequests.length > 0) {
          const pendingUndoRequest = res.result.data.pendingUndoRequests.find(req => 
            req.requester !== this.data.myPlayer
          );
          
          if (pendingUndoRequest && 
              (!this.data.pendingUndoRequest || 
               pendingUndoRequest._id !== this.data.pendingUndoRequest._id)) {
            this.setData({
              pendingUndoRequest: pendingUndoRequest,
              showUndoRequest: true
            });
          }
        }
      }
    }).catch(err => {
      console.error('轮询游戏状态失败:', err);
    });
  },

  // 单元格点击事件
  onCellTap: function(e) {
    if (this.data.gameOver || !this.data.isMyTurn) {
      return;
    }
    
    const r = parseInt(e.currentTarget.dataset.r);
    const c = parseInt(e.currentTarget.dataset.c);
    
    // 发送落子请求
    wx.showLoading({ title: '落子中...' });
    
    wx.cloud.callFunction({
      name: 'gameSync',
      data: {
        $url: 'makeMove',
        gameId: this.data.gameId,
        row: r,
        col: c
      }
    }).then(res => {
      wx.hideLoading();
      
      if (res.result.code === 200) {
        // 落子成功，更新本地状态
        this.onGameDataLoaded({
          game: res.result.data.game,
          pendingUndoRequests: []
        });
        
        wx.showToast({ title: '落子成功', icon: 'success' });
      } else {
        wx.showToast({ title: res.result.message || '落子失败', icon: 'none' });
      }
    }).catch(err => {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
      console.error('落子失败:', err);
    });
  },

  // 请求悔棋
  onRequestUndo: function() {
    if (this.data.gameOver || !this.data.isMyTurn) {
      return;
    }
    
    wx.showModal({
      title: '悔棋',
      content: '确定要请求悔棋吗？',
      success: (res) => {
        if (res.confirm) {
          this.requestUndo();
        }
      }
    });
  },

  // 发送悔棋请求
  requestUndo: function() {
    wx.showLoading({ title: '发送悔棋请求...' });
    
    const targetMoveNumber = Math.max(1, this.data.game.move_count - 1);
    
    wx.cloud.callFunction({
      name: 'gameSync',
      data: {
        $url: 'requestUndo',
        gameId: this.data.gameId,
        targetMoveNumber: targetMoveNumber
      }
    }).then(res => {
      wx.hideLoading();
      
      if (res.result.code === 200) {
        wx.showToast({ title: '悔棋请求已发送', icon: 'success' });
      } else {
        wx.showToast({ title: res.result.message || '发送悔棋请求失败', icon: 'none' });
      }
    }).catch(err => {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
      console.error('发送悔棋请求失败:', err);
    });
  },

  // 同意悔棋
  onApproveUndo: function() {
    this.handleUndoRequest(true);
  },

  // 拒绝悔棋
  onRejectUndo: function() {
    this.handleUndoRequest(false);
  },

  // 处理悔棋请求
  handleUndoRequest: function(approve) {
    if (!this.data.pendingUndoRequest) return;
    
    wx.showLoading({ title: '处理中...' });
    
    wx.cloud.callFunction({
      name: 'gameSync',
      data: {
        $url: 'handleUndo',
        requestId: this.data.pendingUndoRequest._id,
        approve: approve
      }
    }).then(res => {
      wx.hideLoading();
      
      if (res.result.code === 200) {
        this.setData({
          pendingUndoRequest: null,
          showUndoRequest: false
        });
        
        if (approve) {
          wx.showToast({ title: '已同意悔棋', icon: 'success' });
          // 重新加载游戏状态
          setTimeout(() => this.loadGame(), 500);
        } else {
          wx.showToast({ title: '已拒绝悔棋', icon: 'success' });
        }
      } else {
        wx.showToast({ title: res.result.message || '处理失败', icon: 'none' });
      }
    }).catch(err => {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
      console.error('处理悔棋请求失败:', err);
    });
  },

  // 认输
  onResign: function() {
    if (this.data.gameOver) return;
    
    wx.showModal({
      title: '认输',
      content: '确定要认输吗？',
      success: (res) => {
        if (res.confirm) {
          this.resignGame();
        }
      }
    });
  },

  // 发送认输请求
  resignGame: function() {
    wx.showLoading({ title: '认输中...' });
    
    wx.cloud.callFunction({
      name: 'gameSync',
      data: {
        $url: 'resignGame',
        gameId: this.data.gameId
      }
    }).then(res => {
      wx.hideLoading();
      
      if (res.result.code === 200) {
        wx.showToast({ title: '认输成功', icon: 'success' });
        // 重新加载游戏状态
        setTimeout(() => this.loadGame(), 500);
      } else {
        wx.showToast({ title: res.result.message || '认输失败', icon: 'none' });
      }
    }).catch(err => {
      wx.hideLoading();
      wx.showToast({ title: '网络错误', icon: 'none' });
      console.error('认输失败:', err);
    });
  },

  // 离开对局
  onLeave: function() {
    wx.showModal({
      title: '离开对局',
      content: '确定要离开当前对局吗？',
      success: (res) => {
        if (res.confirm) {
          wx.navigateBack();
        }
      }
    });
  },

  // 返回首页
  onBackToHome: function() {
    wx.reLaunch({
      url: '/pages/index/index'
    });
  },

  // 再来一局
  onRematch: function() {
    // 跳转到匹配页面重新开始匹配
    wx.redirectTo({
      url: '/pages/match/index'
    });
  },

  onClosePromotion: function() {
    this.setData({ showPromotion: false });
  },

  // 清理计时器
  clearTimers: function() {
    if (this.data.pollTimer) {
      clearInterval(this.data.pollTimer);
      this.data.pollTimer = null;
    }
    
    if (this.data.undoRequestTimer) {
      clearTimeout(this.data.undoRequestTimer);
      this.data.undoRequestTimer = null;
    }
  }
});