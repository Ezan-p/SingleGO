// js/game.js
// 对局核心状态机（小游戏版）
// 取代小程序 pages/game、pages/game-ai、pages/challenge-game 三个 Page 的 data + 交互逻辑，
// 与渲染完全解耦：只维护棋盘状态、回合、历史、AI 调度与胜负结果。
// 规则判定一律走 rule.evaluateMove，逻辑与小程序版一致。

const board_ = require('./board.js');
const rule = require('./rule.js');
const ai = require('./ai.js');
const sound = require('./sound.js');
const undoManager = require('./undo-manager.js');

const EMPTY = board_.EMPTY;
const BLACK = board_.BLACK;
const WHITE = board_.WHITE;

const DIFFICULTY_NAMES = {
  easy: '简单',
  normal: '普通',
  hard: '困难',
  master: '大师'
};

// AI 思考延迟（秒），与小程序版 setTimeout 400ms 一致
const AI_DELAY = 0.4;
// 围子胜利高亮展示时长（秒），与小程序版 1800ms 一致
const WIN_ANIM_DURATION = 1.8;

// opts:
//   mode        'local' | 'ai' | 'challenge'
//   size        棋盘路数
//   humanPlayer 玩家执子（ai/challenge 模式）
//   difficulty  AI 难度
//   initialBoard 初始局面（残局模式）
//   firstPlayer 先手方
//   levelId     残局关卡号
function Game(opts) {
  const o = opts || {};
  this.mode = o.mode || 'local';
  this.size = o.size || board_.DEFAULT_SIZE;
  this.difficulty = o.difficulty || 'normal';
  this.difficultyName = DIFFICULTY_NAMES[this.difficulty] || '普通';
  this.humanPlayer = o.humanPlayer || BLACK;
  this.aiPlayer = board_.opponent(this.humanPlayer);
  this.firstPlayer = o.firstPlayer || BLACK;
  this.initialBoard = o.initialBoard || null;
  this.levelId = o.levelId || 0;

  // 事件回调（由场景注入）
  this.onGameOver = o.onGameOver || null;   // (result, elapsedSec)
  this.onMove = o.onMove || null;           // ({r,c,player})
  this.onWinAnimEnd = o.onWinAnimEnd || null;

  this.reset();
}

Game.prototype.reset = function () {
  if (this.initialBoard) {
    this.board = board_.cloneBoard(this.initialBoard);
    this.size = this.board.length;
  } else {
    this.board = board_.createBoard(this.size);
  }
  this.history = [];
  this.currentPlayer = this.firstPlayer;
  this.gameOver = false;
  this.winner = 0;
  this.winReason = '';
  this.winRule = 0;
  this.winTarget = null;
  this.winStones = null;
  this.lastMove = null;
  this.pendingMove = null;
  this.moveCount = 0;
  this.aiThinking = false;
  this._aiTimer = 0;
  this._winAnimTimer = 0;
  this._winAnimPending = false;
  this.startTime = Date.now();
  this.elapsedSec = 0;

  undoManager.init(1);

  // AI 先手则立即排队
  if (this.mode !== 'local' && this.currentPlayer === this.aiPlayer) {
    this.scheduleAI();
  }
};

Game.prototype.isHumanTurn = function () {
  if (this.gameOver) return false;
  if (this.mode === 'local') return true;
  return this.currentPlayer === this.humanPlayer && !this.aiThinking;
};

Game.prototype.canUndo = function () {
  return this.history.length > 0;
};

Game.prototype.getUndoCount = function () {
  return undoManager.getCount();
};

// 处理棋盘点击：两次点击确认（首次预览，同点再次点击落子）
// 返回 'placed' | 'pending' | 'occupied' | 'ignored' | 'over'
Game.prototype.tapCell = function (r, c) {
  if (this.gameOver) return 'over';
  if (!this.isHumanTurn()) return 'ignored';
  if (!board_.canPlace(this.board, r, c)) {
    if (board_.inBounds(r, c, this.size) && this.board[r][c] !== EMPTY) return 'occupied';
    return 'ignored';
  }
  const p = this.pendingMove;
  if (p && p.r === r && p.c === c) {
    this.pendingMove = null;
    this.place(r, c);
    return 'placed';
  }
  this.pendingMove = { r: r, c: c };
  return 'pending';
};

// 落子并判定（与小程序 placePiece 流程一致）
Game.prototype.place = function (r, c) {
  const player = this.currentPlayer;
  board_.placePiece(this.board, r, c, player);
  this.history.push({ r: r, c: c, player: player });
  this.lastMove = { r: r, c: c };
  this.moveCount++;

  const result = rule.evaluateMove(this.board, r, c, player);
  sound.playStone();
  if (this.onMove) this.onMove({ r: r, c: c, player: player });

  if (result.gameOver) {
    this.gameOver = true;
    this.winner = result.winner;
    this.winReason = result.reason;
    this.winRule = result.rule;
    this.winTarget = result.winTarget || null;
    this.winStones = result.winStones || null;
    this.winIsLoss = (this.winner !== this.humanPlayer);
    this.elapsedSec = Math.floor((Date.now() - this.startTime) / 1000);
    this.aiThinking = false;
    this._aiTimer = 0;

    // 有高亮数据时先播放高亮动画（胜/负通用），再回调结算
    if (this.winTarget || this.winStones) {
      this._winAnimPending = true;
      this._winAnimTimer = WIN_ANIM_DURATION;
    } else if (this.onGameOver) {
      this.onGameOver(result, this.elapsedSec);
    }
    return result;
  }

  this.currentPlayer = board_.opponent(player);
  if (this.mode !== 'local' && this.currentPlayer === this.aiPlayer) {
    this.scheduleAI();
  }
  return result;
};

// 排队 AI 落子（真正计算在 update 中延迟触发，避免阻塞首帧渲染）
Game.prototype.scheduleAI = function () {
  if (this.gameOver) return;
  this.aiThinking = true;
  this._aiTimer = AI_DELAY;
};

Game.prototype._runAI = function () {
  this.aiThinking = false;
  if (this.gameOver) return;
  const mv = ai.chooseMove(this.board, this.aiPlayer, this.difficulty, { lastMove: this.lastMove });
  if (mv) this.place(mv.r, mv.c);
};

// 悔棋：撤销双方各一步，回到玩家回合（与小程序 executeUndo 一致）
Game.prototype.executeUndo = function () {
  if (this.history.length === 0) return false;

  const self = this;
  const popOne = function () {
    if (self.history.length === 0) return;
    const last = self.history.pop();
    self.board[last.r][last.c] = EMPTY;
  };

  popOne();
  if (this.mode !== 'local' && this.history.length > 0) popOne();

  const prev = this.history[this.history.length - 1] || null;
  this.lastMove = prev ? { r: prev.r, c: prev.c } : null;
  this.moveCount = this.history.length;
  this.pendingMove = null;
  this.currentPlayer = (this.mode === 'local')
    ? (prev ? board_.opponent(prev.player) : this.firstPlayer)
    : this.humanPlayer;

  // 悔棋后恢复对局状态并清除胜利高亮
  this.gameOver = false;
  this.winner = 0;
  this.winReason = '';
  this.winRule = 0;
  this.winTarget = null;
  this.winStones = null;
  this._winAnimPending = false;
  this._winAnimTimer = 0;
  this.aiThinking = false;
  this._aiTimer = 0;
  return true;
};

// 悔棋入口：有次数则消耗；无次数返回 'need-ad' 交由场景弹广告
Game.prototype.requestUndo = function () {
  if (!this.canUndo()) return 'unavailable';
  if (this.aiThinking) return 'unavailable';
  if (undoManager.getCount() > 0) {
    this.executeUndo();
    undoManager.consume();
    return 'ok';
  }
  return 'need-ad';
};

// 更换棋盘尺寸（重开一局）
Game.prototype.changeSize = function (size) {
  this.size = size;
  this.initialBoard = null;
  this.reset();
};

// 帧更新：驱动 AI 延迟与胜利动画计时
Game.prototype.update = function (dt) {
  if (this._aiTimer > 0) {
    this._aiTimer -= dt;
    if (this._aiTimer <= 0) {
      this._aiTimer = 0;
      this._runAI();
    }
  }
  if (this._winAnimPending) {
    this._winAnimTimer -= dt;
    if (this._winAnimTimer <= 0) {
      this._winAnimPending = false;
      this._winAnimTimer = 0;
      if (this.onGameOver) {
        this.onGameOver({
          gameOver: true,
          winner: this.winner,
          reason: this.winReason,
          rule: this.winRule,
          winTarget: this.winTarget,
          winStones: this.winStones
        }, this.elapsedSec);
      }
      if (this.onWinAnimEnd) this.onWinAnimEnd();
    }
  }
  if (!this.gameOver) {
    this.elapsedSec = Math.floor((Date.now() - this.startTime) / 1000);
  }
};

// 供渲染层读取的快照
Game.prototype.getRenderState = function (phase) {
  return {
    board: this.board,
    lastMove: this.lastMove,
    pending: this.pendingMove,
    pendingPlayer: this.currentPlayer,
    winTarget: this.winTarget,
    winStones: this.winStones,
    winIsLoss: this.winIsLoss || false,
    phase: phase
  };
};

module.exports = Game;
module.exports.DIFFICULTY_NAMES = DIFFICULTY_NAMES;
module.exports.BLACK = BLACK;
module.exports.WHITE = WHITE;
