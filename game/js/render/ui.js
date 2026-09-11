// js/render/ui.js
// Canvas 通用绘制原语与按钮控件（替代小程序 WXML/WXSS）
// 配色沿用小程序版视觉规范（木色棋盘 + 暖色主题）。

const COLORS = {
  bg: '#FFF8E8',
  bgDeep: '#F0E4D0',
  board: '#E8B870',
  boardEdge: '#C8923C',
  line: '#8B5A2B',
  text: '#3a2f1f',
  textSub: '#8B7355',
  textLight: '#FFFFFF',
  primary: '#C8923C',
  primaryDeep: '#8B5A2B',
  danger: '#E53935',
  success: '#4CAF50',
  info: '#1E88E5',
  panel: '#FFFFFF',
  panelBorder: '#D8C8A8',
  disabled: '#CFC6B4',
  mask: 'rgba(0,0,0,0.55)'
};

// ===== 基础图形 =====

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

function fillRoundRect(ctx, x, y, w, h, r, color) {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
}

function strokeRoundRect(ctx, x, y, w, h, r, color, lineWidth) {
  roundRect(ctx, x, y, w, h, r);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth || 1;
  ctx.stroke();
}

function fillCircle(ctx, x, y, r, color) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// 文本绘制
// opts: { size, color, align('left'|'center'|'right'), baseline, bold }
function drawText(ctx, text, x, y, opts) {
  const o = opts || {};
  ctx.save();
  ctx.font = (o.bold ? 'bold ' : '') + (o.size || 14) + 'px sans-serif';
  ctx.fillStyle = o.color || COLORS.text;
  ctx.textAlign = o.align || 'left';
  ctx.textBaseline = o.baseline || 'middle';
  ctx.fillText(String(text), x, y);
  ctx.restore();
}

// 自动换行文本，返回绘制后的下一行 y 坐标
function drawWrappedText(ctx, text, x, y, maxWidth, lineHeight, opts) {
  const o = opts || {};
  ctx.save();
  ctx.font = (o.bold ? 'bold ' : '') + (o.size || 14) + 'px sans-serif';
  ctx.fillStyle = o.color || COLORS.text;
  ctx.textAlign = o.align || 'left';
  ctx.textBaseline = 'middle';

  const chars = String(text).split('');
  let line = '';
  let cy = y;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\n') {
      ctx.fillText(line, x, cy);
      line = '';
      cy += lineHeight;
      continue;
    }
    const test = line + chars[i];
    if (ctx.measureText(test).width > maxWidth && line !== '') {
      ctx.fillText(line, x, cy);
      line = chars[i];
      cy += lineHeight;
    } else {
      line = test;
    }
  }
  if (line !== '') {
    ctx.fillText(line, x, cy);
    cy += lineHeight;
  }
  ctx.restore();
  return cy;
}

// 全屏遮罩
function drawMask(ctx, w, h) {
  ctx.fillStyle = COLORS.mask;
  ctx.fillRect(0, 0, w, h);
}

// ===== 按钮 =====

// Button：矩形热区 + 自绘外观
// opts: { x, y, w, h, text, onTap, bg, color, size, radius, disabled, hidden, bold, border }
function Button(opts) {
  this.x = opts.x || 0;
  this.y = opts.y || 0;
  this.w = opts.w || 100;
  this.h = opts.h || 40;
  this.text = opts.text || '';
  this.onTap = opts.onTap || null;
  this.bg = opts.bg || COLORS.primary;
  this.color = opts.color || COLORS.textLight;
  this.size = opts.size || 16;
  this.radius = opts.radius === undefined ? 10 : opts.radius;
  this.disabled = !!opts.disabled;
  this.hidden = !!opts.hidden;
  this.bold = opts.bold !== false;
  this.border = opts.border || null;
  this.pressed = false;
  this.data = opts.data || null;
}

Button.prototype.setRect = function (x, y, w, h) {
  this.x = x; this.y = y; this.w = w; this.h = h;
  return this;
};

Button.prototype.hitTest = function (px, py) {
  if (this.hidden || this.disabled) return false;
  return px >= this.x && px <= this.x + this.w && py >= this.y && py <= this.y + this.h;
};

Button.prototype.draw = function (ctx) {
  if (this.hidden) return;
  const bg = this.disabled ? COLORS.disabled : this.bg;
  ctx.save();
  if (this.pressed && !this.disabled) ctx.globalAlpha = 0.75;
  fillRoundRect(ctx, this.x, this.y, this.w, this.h, this.radius, bg);
  if (this.border) {
    strokeRoundRect(ctx, this.x, this.y, this.w, this.h, this.radius, this.border, 1.5);
  }
  ctx.restore();
  if (this.text) {
    drawText(ctx, this.text, this.x + this.w / 2, this.y + this.h / 2, {
      size: this.size,
      color: this.disabled ? '#FFFFFF' : this.color,
      align: 'center',
      bold: this.bold
    });
  }
};

// ===== 面板 / 弹窗 =====

// 卡片面板
function drawPanel(ctx, x, y, w, h, radius) {
  ctx.save();
  fillRoundRect(ctx, x, y, w, h, radius === undefined ? 14 : radius, COLORS.panel);
  strokeRoundRect(ctx, x, y, w, h, radius === undefined ? 14 : radius, COLORS.panelBorder, 1);
  ctx.restore();
}

// 顶部标题栏（含返回按钮位置约定：左上角）
function drawTitleBar(ctx, w, topInset, title) {
  const h = topInset + 44;
  ctx.fillStyle = COLORS.bgDeep;
  ctx.fillRect(0, 0, w, h);
  drawText(ctx, title, w / 2, topInset + 22, {
    size: 18, color: COLORS.text, align: 'center', bold: true
  });
  return h;
}

module.exports = {
  COLORS: COLORS,
  roundRect: roundRect,
  fillRoundRect: fillRoundRect,
  strokeRoundRect: strokeRoundRect,
  fillCircle: fillCircle,
  drawText: drawText,
  drawWrappedText: drawWrappedText,
  drawMask: drawMask,
  drawPanel: drawPanel,
  drawTitleBar: drawTitleBar,
  Button: Button
};
