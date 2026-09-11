// js/scenes/ChallengeScene.js
// 残局闯关选关（取代 pages/challenge）：100 关网格，按进度解锁

const BaseScene = require('./BaseScene.js');
const ui = require('../render/ui.js');
const levels = require('../levels.js');
const progress = require('../challenge-progress.js');

const COLS = 5;

function ChallengeScene(manager) {
  BaseScene.call(this, manager);
  this.scrollY = 0;
  this._dragStartY = 0;
  this._dragStartScroll = 0;
  this._dragging = false;
  this._moved = false;
}
ChallengeScene.prototype = Object.create(BaseScene.prototype);
ChallengeScene.prototype.constructor = ChallengeScene;

ChallengeScene.prototype.onEnter = function () {
  const vp = this.manager.viewport;
  const self = this;
  this.clearButtons();
  this.addBackButton(vp, function () { self.manager.pop(); });

  this.total = levels.LEVEL_COUNT;
  this.listTop = vp.top + 90;
  this.listBottom = vp.height - vp.bottom - 12;

  const pad = 20;
  const gap = 10;
  this.cellSize = (vp.width - pad * 2 - gap * (COLS - 1)) / COLS;
  this.pad = pad;
  this.gap = gap;

  const rows = Math.ceil(this.total / COLS);
  this.contentHeight = rows * (this.cellSize + gap);
  this.maxScroll = Math.max(0, this.contentHeight - (this.listBottom - this.listTop));
  this.scrollY = 0;
  this.refresh();
};

ChallengeScene.prototype.refresh = function () {
  this.unlockedMax = progress.getUnlockedMax();
  this.clearedCount = progress.getClearedCount();
};

ChallengeScene.prototype.onShow = function () { this.refresh(); };

ChallengeScene.prototype.onTouchStart = function (x, y) {
  if (y >= this.listTop && y <= this.listBottom) {
    this._dragging = true;
    this._moved = false;
    this._dragStartY = y;
    this._dragStartScroll = this.scrollY;
    return;
  }
  BaseScene.prototype.onTouchStart.call(this, x, y);
};

ChallengeScene.prototype.onTouchMove = function (x, y) {
  if (this._dragging) {
    const dy = y - this._dragStartY;
    if (Math.abs(dy) > 6) this._moved = true;
    this.scrollY = Math.max(0, Math.min(this.maxScroll, this._dragStartScroll - dy));
    return;
  }
  BaseScene.prototype.onTouchMove.call(this, x, y);
};

ChallengeScene.prototype.onTouchEnd = function (x, y) {
  if (this._dragging) {
    this._dragging = false;
    if (!this._moved) this.tapLevel(x, y);
    return;
  }
  BaseScene.prototype.onTouchEnd.call(this, x, y);
};

ChallengeScene.prototype.tapLevel = function (x, y) {
  const col = Math.floor((x - this.pad) / (this.cellSize + this.gap));
  const row = Math.floor((y - this.listTop + this.scrollY) / (this.cellSize + this.gap));
  if (col < 0 || col >= COLS || row < 0) return;
  const id = row * COLS + col + 1;
  if (id > this.total) return;
  if (!progress.isUnlocked(id)) {
    wx.showToast({ title: '请先通关前面的残局', icon: 'none', duration: 1200 });
    return;
  }
  this.startLevel(id);
};

ChallengeScene.prototype.startLevel = function (id) {
  const level = levels.getLevel(id);
  if (!level) {
    wx.showToast({ title: '关卡不存在', icon: 'none' });
    return;
  }
  this.manager.push('game', {
    mode: 'challenge',
    levelId: id,
    size: level.boardSize,
    initialBoard: level.board,
    humanPlayer: level.humanColor,
    firstPlayer: level.firstPlayer,
    difficulty: level.aiLevel || level.difficulty || 'normal'
  });
};

ChallengeScene.prototype.render = function (ctx, vp) {
  this.drawBackground(ctx, vp);
  ui.drawText(ctx, '残局闯关', vp.width / 2, vp.top + 22, { size: 18, bold: true, align: 'center' });
  ui.drawText(ctx, '已通关 ' + this.clearedCount + ' / ' + this.total,
    vp.width / 2, vp.top + 58, { size: 13, align: 'center', color: ui.COLORS.textSub });

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, this.listTop, vp.width, this.listBottom - this.listTop);
  ctx.clip();

  const s = this.cellSize;
  for (let i = 0; i < this.total; i++) {
    const id = i + 1;
    const row = Math.floor(i / COLS);
    const col = i % COLS;
    const x = this.pad + col * (s + this.gap);
    const y = this.listTop + row * (s + this.gap) - this.scrollY;
    if (y + s < this.listTop || y > this.listBottom) continue;

    const unlocked = progress.isUnlocked(id);
    const cleared = progress.isCleared(id);
    const bg = cleared ? ui.COLORS.success : (unlocked ? '#FFFFFF' : '#E5DCCB');
    ui.fillRoundRect(ctx, x, y, s, s, 10, bg);
    ui.strokeRoundRect(ctx, x, y, s, s, 10, ui.COLORS.panelBorder, 1);

    if (unlocked) {
      ui.drawText(ctx, String(id), x + s / 2, y + s / 2 - 4, {
        size: 17, bold: true, align: 'center',
        color: cleared ? '#FFFFFF' : ui.COLORS.text
      });
      const lv = levels.getLevel(id);
      if (lv) {
        ui.drawText(ctx, lv.tierName || '', x + s / 2, y + s - 14, {
          size: 10, align: 'center',
          color: cleared ? 'rgba(255,255,255,0.85)' : ui.COLORS.textSub
        });
      }
    } else {
      ui.drawText(ctx, '🔒', x + s / 2, y + s / 2, { size: 16, align: 'center' });
    }
  }
  ctx.restore();

  this.drawButtons(ctx);
};

module.exports = function (manager) { return new ChallengeScene(manager); };
