// js/scenes/BaseScene.js
// 场景基类：统一按钮命中处理（按下高亮 → 抬起触发），以及返回按钮绘制。

const ui = require('../render/ui.js');

function BaseScene(manager) {
  this.manager = manager;
  this.buttons = [];
  this._pressed = null;
}

BaseScene.prototype.addButton = function (opts) {
  const btn = new ui.Button(opts);
  this.buttons.push(btn);
  return btn;
};

BaseScene.prototype.clearButtons = function () {
  this.buttons = [];
  this._pressed = null;
};

// 返回场景中命中的按钮（子类可在触摸前先处理棋盘等自定义热区）
BaseScene.prototype.hitButton = function (x, y) {
  for (let i = this.buttons.length - 1; i >= 0; i--) {
    if (this.buttons[i].hitTest(x, y)) return this.buttons[i];
  }
  return null;
};

BaseScene.prototype.onTouchStart = function (x, y) {
  const btn = this.hitButton(x, y);
  if (btn) {
    btn.pressed = true;
    this._pressed = btn;
  }
};

BaseScene.prototype.onTouchMove = function (x, y) {
  if (this._pressed && !this._pressed.hitTest(x, y)) {
    this._pressed.pressed = false;
    this._pressed = null;
  }
};

BaseScene.prototype.onTouchEnd = function (x, y) {
  const btn = this._pressed;
  if (btn) {
    btn.pressed = false;
    this._pressed = null;
    if (btn.hitTest(x, y) && btn.onTap) {
      btn.onTap(btn);
      return true;
    }
  }
  return false;
};

BaseScene.prototype.drawButtons = function (ctx) {
  for (let i = 0; i < this.buttons.length; i++) this.buttons[i].draw(ctx);
};

// 通用返回按钮（左上角）
BaseScene.prototype.addBackButton = function (viewport, onTap) {
  return this.addButton({
    x: 12,
    y: viewport.top + 6,
    w: 60,
    h: 32,
    text: '‹ 返回',
    size: 14,
    radius: 16,
    bg: 'rgba(255,255,255,0.9)',
    color: ui.COLORS.text,
    border: ui.COLORS.panelBorder,
    onTap: onTap || function () {}
  });
};

// 统一背景
BaseScene.prototype.drawBackground = function (ctx, viewport) {
  const grad = ctx.createLinearGradient(0, 0, 0, viewport.height);
  grad.addColorStop(0, ui.COLORS.bg);
  grad.addColorStop(1, ui.COLORS.bgDeep);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, viewport.width, viewport.height);
};

module.exports = BaseScene;
