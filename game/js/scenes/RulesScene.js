// js/scenes/RulesScene.js
// 规则说明（取代 pages/rules）：沿用小程序「图文并茂」版，每个规则一页（配示意棋盘），可翻页浏览。

const BaseScene = require('./BaseScene.js');
const ui = require('../render/ui.js');
const COLORS = ui.COLORS;
const PI = Math.PI;

const BLACK = 1;
const WHITE = 2;

// 规则分组：每个获胜 / 判负规则配一张示意棋盘（配置沿用小程序 rules.js）
const SECTIONS = [
  {
    head: '✅ 获胜规则',
    color: COLORS.success,
    diagrams: [
      {
        title: '十字围获胜',
        desc: '当对方棋子的东、南、西、北四个相邻位置均为己方棋子时，立即获胜。无论执黑执白，规则完全对称。',
        cols: 5, rows: 5,
        stones: [[2, 2, WHITE], [1, 2, BLACK], [3, 2, BLACK], [2, 1, BLACK], [2, 3, BLACK]],
        marks: [[1, 2, 'circle'], [3, 2, 'circle'], [2, 1, 'circle'], [2, 3, 'circle']]
      },
      {
        title: '斜角围获胜',
        desc: '当对方棋子的四个对角位置均为己方棋子时，立即获胜。',
        cols: 5, rows: 5,
        stones: [[2, 2, BLACK], [1, 3, WHITE], [3, 3, WHITE], [3, 1, WHITE], [1, 1, WHITE]],
        marks: [[1, 3, 'circle'], [3, 3, 'circle'], [3, 1, 'circle'], [1, 1, 'circle']]
      },
      {
        title: '边缘十字围',
        desc: '棋盘边界视为天然阻挡，只需补齐棋盘内方向即可围住。',
        cols: 5, rows: 5,
        stones: [[2, 0, WHITE], [1, 0, BLACK], [3, 0, BLACK], [2, 1, BLACK]],
        marks: [[1, 0, 'circle'], [3, 0, 'circle'], [2, 1, 'circle']],
        boundary: ['left']
      },
      {
        title: '边缘斜角围',
        desc: '边界方向视为已封闭，仅需满足棋盘内对角方向即可获胜。',
        cols: 5, rows: 5,
        stones: [[0, 0, BLACK], [1, 1, WHITE]],
        marks: [[0, 0, 'circle']],
        boundary: ['left', 'top']
      },
      {
        title: '角落十字围获胜',
        desc: '目标棋子位于角落时，边界可视为天然阻挡，只需占据棋盘内两个正交方向（东、南）即可获胜。',
        cols: 4, rows: 4,
        stones: [[0, 0, WHITE], [0, 1, BLACK], [1, 0, BLACK]],
        marks: [[0, 1, 'circle'], [1, 0, 'circle']],
        boundary: ['left', 'top'],
        check: true
      },
      {
        title: '下边缘斜角围获胜',
        desc: '目标棋子位于下边缘时，边界视为天然阻挡，只需占据两个对角方向（西北、东北）即可获胜。',
        cols: 5, rows: 5,
        stones: [[4, 2, BLACK], [3, 1, WHITE], [3, 3, WHITE]],
        marks: [[4, 2, 'circle']],
        boundary: ['bottom'],
        check: true
      }
    ]
  },
  {
    head: '❌ 判负规则',
    color: COLORS.danger,
    diagrams: [
      {
        title: '八方全占判负',
        desc: '己方任意棋子周围八个方向全部为己方棋子时，立即判负。无论执黑执白，规则完全对称。',
        cols: 5, rows: 5,
        stones: [
          [1, 1, BLACK], [1, 2, BLACK], [1, 3, BLACK],
          [2, 1, BLACK], [2, 2, BLACK], [2, 3, BLACK],
          [3, 1, BLACK], [3, 2, BLACK], [3, 3, BLACK]
        ],
        marks: [[2, 2, 'x']]
      },
      {
        title: '横向双排判负',
        desc: '两条相邻横向连续棋子，每条长度大于 3，立即判负。',
        cols: 6, rows: 4,
        stones: [
          [1, 1, WHITE], [1, 2, WHITE], [1, 3, WHITE], [1, 4, WHITE],
          [2, 1, WHITE], [2, 2, WHITE], [2, 3, WHITE], [2, 4, WHITE]
        ],
        box: { r1: 1, c1: 1, r2: 2, c2: 4 }
      },
      {
        title: '竖向双排判负',
        desc: '两条相邻竖向连续棋子，每条长度大于 3，立即判负。',
        cols: 4, rows: 6,
        stones: [
          [1, 1, BLACK], [2, 1, BLACK], [3, 1, BLACK], [4, 1, BLACK],
          [1, 2, BLACK], [2, 2, BLACK], [3, 2, BLACK], [4, 2, BLACK]
        ],
        box: { r1: 1, c1: 1, r2: 4, c2: 2 }
      },
      {
        title: '斜向双排判负',
        desc: '两条平行且相邻的斜向连续棋子链，每条长度均大于 3，立即判负。',
        cols: 6, rows: 6,
        stones: [
          [1, 1, WHITE], [2, 2, WHITE], [3, 3, WHITE], [4, 4, WHITE],
          [2, 0, WHITE], [3, 1, WHITE], [4, 2, WHITE], [5, 3, WHITE]
        ],
        marks: [
          [1, 1, 'circle'], [2, 2, 'circle'], [3, 3, 'circle'], [4, 4, 'circle'],
          [2, 0, 'circle'], [3, 1, 'circle'], [4, 2, 'circle'], [5, 3, 'circle']
        ]
      }
    ]
  },
  {
    head: '基础规则',
    color: COLORS.textSub,
    text: [
      ['棋盘与先手', '棋盘默认 15×15，可切换 13×13 或 19×19。黑方先手，双方轮流在棋盘交叉点落子。'],
      ['落子限制', '每回合只能落下一枚棋子，落子后不可移动或移除。对局结束后禁止继续落子。'],
      ['判定优先级', '判负规则优先于胜利规则；若落子方新棋子立即被对方围住，则判对方获胜。']
    ]
  }
];

// 展开为「每页一条规则」的扁平列表
const PAGES = [];
for (let i = 0; i < SECTIONS.length; i++) {
  const sec = SECTIONS[i];
  if (sec.diagrams) {
    for (let j = 0; j < sec.diagrams.length; j++) {
      const d = sec.diagrams[j];
      PAGES.push({ type: 'diagram', tag: sec.head, tagColor: sec.color, title: d.title, desc: d.desc, cfg: d });
    }
  }
  if (sec.text) {
    PAGES.push({ type: 'text', title: sec.head, items: sec.text });
  }
}

// 绘制一张示意棋盘
function drawBoard(ctx, cfg, bx, by, cell) {
  const cols = cfg.cols, rows = cfg.rows;
  const gw = cols * cell, gh = rows * cell;

  // 边界灰色条（棋盘外区域）
  if (cfg.boundary) {
    ctx.save();
    ctx.fillStyle = 'rgba(120,120,120,0.25)';
    ctx.strokeStyle = 'rgba(120,120,120,0.6)';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    const s = 8;
    cfg.boundary.forEach(function (side) {
      let x, y, w, h;
      if (side === 'left') { x = bx - s - 2; y = by; w = s; h = gh; }
      else if (side === 'right') { x = bx + gw + 2; y = by; w = s; h = gh; }
      else if (side === 'top') { x = bx; y = by - s - 2; w = gw; h = s; }
      else { x = bx; y = by + gh + 2; w = gw; h = s; }
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    });
    ctx.restore();
  }

  // 棋盘底色
  ui.fillRoundRect(ctx, bx, by, gw, gh, 4, COLORS.board);

  // 网格线
  ctx.save();
  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 1;
  // 网格线画在交叉点（格子中心）上，与棋子坐标 bx + c*cell + cell/2 对齐，
  // 避免棋子落在方格中间而非网格交叉点（围棋棋子应下在交叉点）。
  for (let c = 0; c < cols; c++) {
    ctx.beginPath();
    ctx.moveTo(bx + (c + 0.5) * cell, by);
    ctx.lineTo(bx + (c + 0.5) * cell, by + gh);
    ctx.stroke();
  }
  for (let r = 0; r < rows; r++) {
    ctx.beginPath();
    ctx.moveTo(bx, by + (r + 0.5) * cell);
    ctx.lineTo(bx + gw, by + (r + 0.5) * cell);
    ctx.stroke();
  }
  ctx.restore();

  // 棋子
  const stones = cfg.stones || [];
  const r2 = cell * 0.40;
  for (let i = 0; i < stones.length; i++) {
    const st = stones[i];
    const cx = bx + st[1] * cell + cell / 2;
    const cy = by + st[0] * cell + cell / 2;
    const g = ctx.createRadialGradient(cx - r2 * 0.3, cy - r2 * 0.3, r2 * 0.1, cx, cy, r2);
    if (st[2] === BLACK) {
      g.addColorStop(0, '#666');
      g.addColorStop(1, '#000');
    } else {
      g.addColorStop(0, '#fff');
      g.addColorStop(1, '#ddd');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r2, 0, 2 * PI);
    ctx.fill();
    if (st[2] !== BLACK) {
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // 标注（红圈 / 红叉）
  const marks = cfg.marks || [];
  for (let i = 0; i < marks.length; i++) {
    const m = marks[i];
    const cx = bx + m[1] * cell + cell / 2;
    const cy = by + m[0] * cell + cell / 2;
    ctx.save();
    ctx.strokeStyle = COLORS.danger;
    if (m[2] === 'circle') {
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r2 * 1.15, 0, 2 * PI);
      ctx.stroke();
    } else if (m[2] === 'x') {
      ctx.lineWidth = 3;
      const d = r2 * 0.9;
      ctx.beginPath();
      ctx.moveTo(cx - d, cy - d);
      ctx.lineTo(cx + d, cy + d);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx + d, cy - d);
      ctx.lineTo(cx - d, cy + d);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 区域红框
  if (cfg.box) {
    const b = cfg.box;
    ctx.save();
    ctx.strokeStyle = COLORS.danger;
    ctx.lineWidth = 2.5;
    ctx.strokeRect(bx + b.c1 * cell, by + b.r1 * cell,
      (b.c2 - b.c1 + 1) * cell, (b.r2 - b.r1 + 1) * cell);
    ctx.restore();
  }

  // 绿色对勾：合法获胜示例
  if (cfg.check) {
    const rad = 13;
    const px = bx + gw - rad - 2;
    const py = by + rad + 2;
    ctx.save();
    ui.fillCircle(ctx, px, py, rad, COLORS.success);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(px - 5, py);
    ctx.lineTo(px - 1, py + 4);
    ctx.lineTo(px + 6, py - 5);
    ctx.stroke();
    ctx.restore();
  }
}

// 计算换行文本总高度（不绘制）
function measureWrapped(ctx, text, maxWidth, lineHeight, fontSize) {
  ctx.save();
  ctx.font = fontSize + 'px sans-serif';
  const chars = String(text).split('');
  let line = '';
  let lines = 1;
  for (let i = 0; i < chars.length; i++) {
    const test = line + chars[i];
    if (ctx.measureText(test).width > maxWidth && line !== '') {
      lines++;
      line = chars[i];
    } else {
      line = test;
    }
  }
  ctx.restore();
  return lines * lineHeight;
}

function RulesScene(manager) {
  BaseScene.call(this, manager);
  this.page = 0;
}
RulesScene.prototype = Object.create(BaseScene.prototype);
RulesScene.prototype.constructor = RulesScene;

RulesScene.prototype.onEnter = function () {
  const vp = this.manager.viewport;
  const self = this;
  this.clearButtons();
  this.addBackButton(vp, function () { self.manager.pop(); });

  // 底部翻页按钮
  const by = vp.height - vp.bottom - 56;
  const bw = (vp.width - 60) / 2;
  this.prevBtn = this.addButton({
    x: 20, y: by, w: bw, h: 44,
    text: '‹ 上一页', size: 16, radius: 22,
    bg: COLORS.primary, color: COLORS.textLight,
    onTap: function () { self.page = Math.max(0, self.page - 1); }
  });
  this.nextBtn = this.addButton({
    x: 20 + bw + 20, y: by, w: bw, h: 44,
    text: '下一页 ›', size: 16, radius: 22,
    bg: COLORS.primary, color: COLORS.textLight,
    onTap: function () { self.page = Math.min(PAGES.length - 1, self.page + 1); }
  });

  this.page = 0;
};

RulesScene.prototype.render = function (ctx, vp) {
  this.drawBackground(ctx, vp);

  // 顶部标题栏
  ui.drawText(ctx, '规则说明', vp.width / 2, vp.top + 22, { size: 18, bold: true, align: 'center' });
  ui.drawText(ctx, (this.page + 1) + ' / ' + PAGES.length, vp.width - 16, vp.top + 22,
    { size: 14, align: 'right', color: COLORS.textSub });

  const page = PAGES[this.page];
  const headY = vp.top + 56;

  if (page.type === 'diagram') {
    // 分组标签 + 规则标题
    ui.drawText(ctx, page.tag, 20, headY + 14, { size: 14, bold: true, color: page.tagColor });
    ui.drawText(ctx, page.title, vp.width / 2, headY + 44, {
      size: 18, bold: true, align: 'center', color: COLORS.text
    });

    // 示意棋盘（居中）
    const cell = Math.min(46, Math.floor((vp.width - 80) / page.cfg.cols));
    const gw = page.cfg.cols * cell;
    const boardX = vp.width / 2 - gw / 2;
    const boardY = headY + 72;
    drawBoard(ctx, page.cfg, boardX, boardY, cell);

    // 说明文字
    const descMaxW = vp.width - 80;
    ui.drawWrappedText(ctx, page.desc, vp.width / 2, boardY + page.cfg.rows * cell + 26,
      descMaxW, 22, { size: 14, color: COLORS.textSub, align: 'center' });
  } else {
    // 纯文字页（基础规则）
    ui.drawText(ctx, page.title, vp.width / 2, headY + 28, {
      size: 18, bold: true, align: 'center', color: COLORS.text
    });
    let y = headY + 64;
    const cardX = 20, cardW = vp.width - 40;
    for (let i = 0; i < page.items.length; i++) {
      const item = page.items[i];
      const textEndY = measureWrapped(ctx, item[1], cardW - 24, 20, 13);
      const boxH = 16 + 20 + textEndY + 12;
      ui.drawPanel(ctx, cardX, y, cardW, boxH, 12);
      ui.drawText(ctx, item[0], cardX + 12, y + 16 + 2, { size: 14, bold: true });
      ui.drawWrappedText(ctx, item[1], cardX + 12, y + 16 + 26, cardW - 24, 20, {
        size: 13, color: COLORS.textSub
      });
      y += boxH + 12;
    }
  }

  // 翻页按钮（在首尾页禁用对应按钮）
  this.prevBtn.disabled = (this.page === 0);
  this.nextBtn.disabled = (this.page === PAGES.length - 1);
  this.drawButtons(ctx);
};

module.exports = function (manager) { return new RulesScene(manager); };
