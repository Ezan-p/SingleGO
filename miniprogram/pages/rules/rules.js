// 规则说明页 — 图文并茂示意图
const CELL = 68; // 每格 rpx

const BLACK = 1;
const WHITE = 2;

// 构建棋盘格数据
function buildDiag(cfg) {
  const cols = cfg.cols;
  const rows = cfg.rows;
  const stones = cfg.stones || {};
  const marks = cfg.marks || {};
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const key = r + ',' + c;
      cells.push({
        key: r + '-' + c,
        stone: stones[key] || 0,
        mark: marks[key] || ''
      });
    }
  }
  const gridW = cols * CELL;
  const gridH = rows * CELL;
  let boxStyle = '';
  if (cfg.box) {
    const inset = 6;
    const b = cfg.box;
    boxStyle = 'left:' + (b.c1 * CELL + inset) + 'rpx;top:' + (b.r1 * CELL + inset) +
      'rpx;width:' + ((b.c2 - b.c1 + 1) * CELL - inset * 2) +
      'rpx;height:' + ((b.r2 - b.r1 + 1) * CELL - inset * 2) + 'rpx;';
  }
  // 边界灰色条
  const boundaries = [];
  if (cfg.boundary) {
    for (let i = 0; i < cfg.boundary.length; i++) {
      const side = cfg.boundary[i];
      let style = '';
      if (side === 'left') style = 'left:-26rpx;top:0;width:22rpx;height:' + gridH + 'rpx;';
      else if (side === 'top') style = 'top:-26rpx;left:0;height:22rpx;width:' + gridW + 'rpx;';
      else if (side === 'right') style = 'right:-26rpx;top:0;width:22rpx;height:' + gridH + 'rpx;';
      else if (side === 'bottom') style = 'bottom:-26rpx;left:0;height:22rpx;width:' + gridW + 'rpx;';
      boundaries.push({ side: side, style: style });
    }
  }
  return {
    title: cfg.title,
    desc: cfg.desc,
    cells: cells,
    gridStyle: 'width:' + gridW + 'rpx;height:' + gridH + 'rpx;',
    cellStyle: 'width:' + CELL + 'rpx;height:' + CELL + 'rpx;',
    bgSize: 'background-size:' + CELL + 'rpx ' + CELL + 'rpx;background-position:' + (CELL / 2) + 'rpx ' + (CELL / 2) + 'rpx;',
    boxStyle: boxStyle,
    boundaries: boundaries,
    hasBoundary: boundaries.length > 0,
    check: !!cfg.check
  };
}

// 坐标辅助
function S() { const m = {}; Array.prototype.forEach.call(arguments, function (p) { m[p[0] + ',' + p[1]] = p[2]; }); return m; }
function M() { const m = {}; Array.prototype.forEach.call(arguments, function (p) { m[p[0] + ',' + p[1]] = p[2]; }); return m; }

const diagrams = [
  // 1. 十字围获胜（图示：黑棋围白棋，黑胜）
  buildDiag({
    title: '十字围获胜',
    desc: '当对方棋子的东、南、西、北四个相邻位置均为己方棋子时，立即获胜。无论执黑执白，规则完全对称。',
    cols: 5, rows: 5,
    stones: S([2, 2, WHITE], [1, 2, BLACK], [3, 2, BLACK], [2, 1, BLACK], [2, 3, BLACK]),
    marks: M([1, 2, 'circle'], [3, 2, 'circle'], [2, 1, 'circle'], [2, 3, 'circle'])
  }),
  // 2. 斜角围获胜
  buildDiag({
    title: '斜角围获胜',
    desc: '当对方棋子的四个对角位置均为己方棋子时，立即获胜。',
    cols: 5, rows: 5,
    stones: S([2, 2, BLACK], [1, 3, WHITE], [3, 3, WHITE], [3, 1, WHITE], [1, 1, WHITE]),
    marks: M([1, 3, 'circle'], [3, 3, 'circle'], [3, 1, 'circle'], [1, 1, 'circle'])
  }),
  // 3. 边缘十字围获胜（图示：黑棋围白棋，黑胜）
  buildDiag({
    title: '边缘十字围',
    desc: '棋盘边界视为天然阻挡，只需补齐棋盘内方向即可围住。无论执黑执白，规则完全对称。',
    cols: 5, rows: 5,
    stones: S([2, 0, WHITE], [1, 0, BLACK], [3, 0, BLACK], [2, 1, BLACK]),
    marks: M([1, 0, 'circle'], [3, 0, 'circle'], [2, 1, 'circle']),
    boundary: ['left']
  }),
  // 4. 边缘斜角围获胜
  buildDiag({
    title: '边缘斜角围',
    desc: '边界方向视为已封闭，仅需满足棋盘内方向即可获胜。',
    cols: 5, rows: 5,
    stones: S([0, 0, BLACK], [1, 1, WHITE]),
    marks: M([0, 0, 'circle']),
    boundary: ['left', 'top']
  }),
  // 5. 角落十字围获胜（图示：黑棋围白棋，黑胜）
  buildDiag({
    title: '角落十字围获胜',
    desc: '当目标棋子位于棋盘角落时，棋盘边界可视为天然阻挡，只需占据棋盘内两个正交方向（东、南）即可完成十字围并获胜。无论执黑执白，规则完全对称。',
    cols: 4, rows: 4,
    stones: S([0, 0, WHITE], [0, 1, BLACK], [1, 0, BLACK]),
    marks: M([0, 1, 'circle'], [1, 0, 'circle']),
    boundary: ['left', 'top'],
    check: true
  }),
  // 6. 下边缘斜角围获胜（两对角方向）
  buildDiag({
    title: '下边缘斜角围获胜',
    desc: '当目标棋子位于棋盘边缘时，棋盘边界可视为天然阻挡，只需占据棋盘内两个对角方向（西北、东北）即可完成斜角围并获胜。',
    cols: 5, rows: 5,
    stones: S([4, 2, BLACK], [3, 1, WHITE], [3, 3, WHITE]),
    marks: M([4, 2, 'circle']),
    boundary: ['bottom'],
    check: true
  }),
  // 7. 八方全占判负（图示：黑棋自包围，黑负）
  buildDiag({
    title: '八方全占判负',
    desc: '己方任意棋子周围八个方向全部为己方棋子时，立即判负。无论执黑执白，规则完全对称。',
    cols: 5, rows: 5,
    stones: S(
      [1, 1, BLACK], [1, 2, BLACK], [1, 3, BLACK],
      [2, 1, BLACK], [2, 2, BLACK], [2, 3, BLACK],
      [3, 1, BLACK], [3, 2, BLACK], [3, 3, BLACK]
    ),
    marks: M([2, 2, 'x'])
  }),
  // 6. 横向双排超过三颗判负
  buildDiag({
    title: '横向双排判负',
    desc: '两条相邻横向连续棋子，每条长度大于3，立即判负。',
    cols: 6, rows: 4,
    stones: S(
      [1, 1, WHITE], [1, 2, WHITE], [1, 3, WHITE], [1, 4, WHITE],
      [2, 1, WHITE], [2, 2, WHITE], [2, 3, WHITE], [2, 4, WHITE]
    ),
    box: { r1: 1, c1: 1, r2: 2, c2: 4 }
  }),
  // 7. 竖向双排超过三颗判负（图示：黑棋双排，黑负）
  buildDiag({
    title: '竖向双排判负',
    desc: '两条相邻竖向连续棋子，每条长度大于3，立即判负。无论执黑执白，规则完全对称。',
    cols: 4, rows: 6,
    stones: S(
      [1, 1, BLACK], [2, 1, BLACK], [3, 1, BLACK], [4, 1, BLACK],
      [1, 2, BLACK], [2, 2, BLACK], [3, 2, BLACK], [4, 2, BLACK]
    ),
    box: { r1: 1, c1: 1, r2: 4, c2: 2 }
  }),
  // 8. 斜向双排超过三颗判负
  buildDiag({
    title: '斜向双排判负',
    desc: '两条平行且相邻的斜向连续棋子链，每条长度均大于3，立即判负。',
    cols: 6, rows: 6,
    stones: S(
      [1, 1, WHITE], [2, 2, WHITE], [3, 3, WHITE], [4, 4, WHITE],
      [2, 0, WHITE], [3, 1, WHITE], [4, 2, WHITE], [5, 3, WHITE]
    ),
    marks: M(
      [1, 1, 'circle'], [2, 2, 'circle'], [3, 3, 'circle'], [4, 4, 'circle'],
      [2, 0, 'circle'], [3, 1, 'circle'], [4, 2, 'circle'], [5, 3, 'circle']
    )
  })
];

Page({
  data: {
    diagrams: diagrams,
    cellSize: CELL,
    symmetryNote: '以上所有规则对执黑、执白双方完全对称：任何一方围住对方即可获胜，任何一方自包围或连续两排也会判负。示意图中黑、白棋子交替作为「行动方」演示。'
  },
  onBack: function () {
    wx.navigateBack();
  }
});
