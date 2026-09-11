// js/render/BoardRenderer.js
// 棋盘 Canvas 渲染：木纹底、网格、星位、棋子、最后一手、待确认预览、胜利高亮。
// 取代小程序版 WXML 的 board-grid + cell 结构。

const board_ = require('../board.js');
const ui = require('./ui.js');

const BLACK = board_.BLACK;
const WHITE = board_.WHITE;

// 绘制棋盘底与网格
function drawGrid(ctx, layout) {
  const { x, y, span, size, gap, originX, originY } = layout;

  // 木色底 + 圆角
  ui.fillRoundRect(ctx, x, y, span, span, 8, ui.COLORS.board);
  ui.strokeRoundRect(ctx, x, y, span, span, 8, ui.COLORS.boardEdge, 2);

  // 网格线
  ctx.save();
  ctx.strokeStyle = ui.COLORS.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < size; i++) {
    const p = originX + i * gap;
    const q = originY + i * gap;
    ctx.moveTo(originX, q);
    ctx.lineTo(originX + (size - 1) * gap, q);
    ctx.moveTo(p, originY);
    ctx.lineTo(p, originY + (size - 1) * gap);
  }
  ctx.stroke();

  // 外框加粗
  ctx.lineWidth = 2;
  ctx.strokeRect(originX, originY, (size - 1) * gap, (size - 1) * gap);
  ctx.restore();

  // 星位
  const stars = board_.starPoints(size);
  const sr = Math.max(2, gap * 0.11);
  for (let i = 0; i < stars.length; i++) {
    const p = board_.cellToPixel(layout, stars[i][0], stars[i][1]);
    ui.fillCircle(ctx, p.x, p.y, sr, ui.COLORS.line);
  }
}

// 绘制单颗棋子（带高光，模拟立体感）
function drawStone(ctx, cx, cy, radius, player, alpha) {
  ctx.save();
  if (alpha !== undefined) ctx.globalAlpha = alpha;

  // 阴影
  ctx.beginPath();
  ctx.arc(cx + radius * 0.08, cy + radius * 0.12, radius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fill();

  // 主体渐变
  const grad = ctx.createRadialGradient(
    cx - radius * 0.35, cy - radius * 0.35, radius * 0.1,
    cx, cy, radius
  );
  if (player === BLACK) {
    grad.addColorStop(0, '#6a6a6a');
    grad.addColorStop(1, '#111111');
  } else {
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#d2cfc6');
  }
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  if (player === WHITE) {
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.restore();
}

// 绘制全部棋子
function drawStones(ctx, layout, board) {
  const size = layout.size;
  const r = layout.cellRadius;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const v = board[row][col];
      if (v === board_.EMPTY) continue;
      const p = board_.cellToPixel(layout, row, col);
      drawStone(ctx, p.x, p.y, r, v);
    }
  }
}

// 最后一手标记（红点）
function drawLastMove(ctx, layout, lastMove) {
  if (!lastMove) return;
  const p = board_.cellToPixel(layout, lastMove.r, lastMove.c);
  ui.fillCircle(ctx, p.x, p.y, Math.max(2, layout.cellRadius * 0.22), '#E53935');
}

// 待确认落子预览（半透明棋子 + 虚线圈，对应小程序的两次点击确认交互）
function drawPending(ctx, layout, pending, player) {
  if (!pending) return;
  const p = board_.cellToPixel(layout, pending.r, pending.c);
  drawStone(ctx, p.x, p.y, layout.cellRadius, player, 0.5);
  ctx.save();
  ctx.strokeStyle = '#E53935';
  ctx.lineWidth = 2;
  if (ctx.setLineDash) ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.arc(p.x, p.y, layout.cellRadius + 3, 0, Math.PI * 2);
  ctx.stroke();
  if (ctx.setLineDash) ctx.setLineDash([]);
  ctx.restore();
}

// 胜利高亮：被围目标画方框，参与围子的棋子画描边圈
// phase 用于呼吸动画（0~1）
function drawWinHighlight(ctx, layout, winTarget, winStones, phase, isLoss) {
  const pulse = 0.55 + 0.45 * Math.sin((phase || 0) * Math.PI * 2);
  ctx.save();
  ctx.lineWidth = 3;

  if (winStones && winStones.length) {
    // 胜:绿圈  负:红圈
    ctx.strokeStyle = isLoss ? 'rgba(229,57,53,' + pulse.toFixed(3) + ')' : 'rgba(76,175,80,' + pulse.toFixed(3) + ')';
    for (let i = 0; i < winStones.length; i++) {
      const p = board_.cellToPixel(layout, winStones[i].r, winStones[i].c);
      ctx.beginPath();
      ctx.arc(p.x, p.y, layout.cellRadius + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  if (winTarget) {
    const p = board_.cellToPixel(layout, winTarget.r, winTarget.c);
    const s = layout.cellRadius * 2.1;
    ctx.strokeStyle = 'rgba(229,57,53,' + pulse.toFixed(3) + ')';
    ctx.strokeRect(p.x - s / 2, p.y - s / 2, s, s);
  }
  ctx.restore();
}

// 整块棋盘渲染入口
// state: { board, lastMove, pending, pendingPlayer, winTarget, winStones, phase }
function render(ctx, layout, state) {
  drawGrid(ctx, layout);
  drawStones(ctx, layout, state.board);
  drawLastMove(ctx, layout, state.lastMove);
  if (state.pending) drawPending(ctx, layout, state.pending, state.pendingPlayer);
  if (state.winTarget || (state.winStones && state.winStones.length)) {
    drawWinHighlight(ctx, layout, state.winTarget, state.winStones, state.phase, state.winIsLoss);
  }
}

module.exports = {
  drawGrid: drawGrid,
  drawStone: drawStone,
  drawStones: drawStones,
  drawLastMove: drawLastMove,
  drawPending: drawPending,
  drawWinHighlight: drawWinHighlight,
  render: render
};
