// 指定陷阱防守策略测试（纯 node 运行：node miniprogram/utils/test-trap-defense.js）
// 覆盖：原始/各旋转/各镜像变体识别、防守点被占用不触发、模板不完整不误判、chooseMove 集成。

var dango = require('./dango.js');
var ai = require('./ai.js');

var EMPTY = dango.EMPTY;
var BLACK = dango.BLACK;
var WHITE = dango.WHITE;

var pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  PASS: ' + msg); }
  else { fail++; console.error('  FAIL: ' + msg); }
}

function createBoard(size) {
  var b = [];
  for (var r = 0; r < size; r++) {
    var row = [];
    for (var c = 0; c < size; c++) row.push(EMPTY);
    b.push(row);
  }
  return b;
}

// 按某个变体在 (cx,cy) 摆出陷阱；defense 格默认留空，override 可强制某些坐标的棋子值
function buildTrapBoard(variant, cx, cy, size, override) {
  var b = createBoard(size);
  var cells = variant.cells;
  for (var i = 0; i < cells.length; i++) {
    var cell = cells[i];
    var x = cx + cell.dx, y = cy + cell.dy;
    if (cell.value === WHITE) b[y][x] = WHITE;
    else if (cell.role === 'defense') { /* 留空，除非被 override */ }
    else if (cell.value === BLACK) b[y][x] = BLACK;
  }
  if (override) {
    for (var k in override) {
      var p = k.split(',');
      b[+p[1]][+p[0]] = override[k];
    }
  }
  return b;
}

var SIZE = 15;
var CX = 7, CY = 7;
var variants = ai.TRAP_VARIANTS;

console.log('=== 变体生成检查 ===');
var names = variants.map(function (v) { return v.name; });
assert(names.indexOf('原始') >= 0, '包含原始方向');
assert(names.indexOf('旋转90°') >= 0, '包含旋转90°');
assert(names.indexOf('旋转180°') >= 0, '包含旋转180°');
assert(names.indexOf('旋转270°') >= 0, '包含旋转270°');
assert(names.indexOf('水平镜像') >= 0, '包含水平镜像(左右镜像)');
assert(names.indexOf('水平镜像+旋转180°') >= 0, '包含垂直镜像(上下镜像)');
assert(variants.length >= 6, '至少生成 6 个方向变体，实际=' + variants.length);

console.log('=== 各方向变体识别 + 防守点正确 ===');
variants.forEach(function (variant) {
  var def = ai.getDefenseCell(variant.cells);
  var defX = CX + def.dx, defY = CY + def.dy;
  var board = buildTrapBoard(variant, CX, CY, SIZE);
  var res = ai.detectSpecificWhiteDefenseMove(board, null);
  var ok = res && res.r === defY && res.c === defX;
  assert(ok, '方向 [' + variant.name + '] 防守点应为 (' + defX + ',' + defY + ')，实际=' +
    (res ? '(' + res.c + ',' + res.r + ')' : 'null'));
});

console.log('=== 防守点被占用时不触发 ===');
// 取原始方向，把防守点强行置为黑，模板 EMPTY 要求不成立 → 应返回 null
(function () {
  var base = variants.filter(function (v) { return v.name === '原始'; })[0];
  var def = ai.getDefenseCell(base.cells);
  var defX = CX + def.dx, defY = CY + def.dy;
  var board = buildTrapBoard(base, CX, CY, SIZE, {});
  board[defY][defX] = BLACK; // 占用防守点
  var res = ai.detectSpecificWhiteDefenseMove(board, null);
  assert(res === null, '防守点被黑棋占用时应返回 null（实际=' + (res ? '(' + res.c + ',' + res.r + ')' : 'null') + '）');
})();

console.log('=== 模板不完整时不误判 ===');
// 原始方向，但缺一颗黑（去掉右上黑）→ 任一变体都不应匹配 → 返回 null
(function () {
  var base = variants.filter(function (v) { return v.name === '原始'; })[0];
  // 找到 value===BLACK 且非上下的一颗（右上）并置空
  var target = null;
  base.cells.forEach(function (cell) {
    if (cell.value === BLACK && !(cell.dx === 0 && (cell.dy === -1 || cell.dy === 1))) {
      target = cell;
    }
  });
  var tx = CX + target.dx, ty = CY + target.dy;
  var board = buildTrapBoard(base, CX, CY, SIZE, {});
  board[ty][tx] = EMPTY; // 移除一颗黑，破坏模板
  var res = ai.detectSpecificWhiteDefenseMove(board, null);
  assert(res === null, '模板缺一颗黑时应返回 null（实际=' + (res ? '(' + res.c + ',' + res.r + ')' : 'null') + '）');
})();

console.log('=== chooseMove(大师, 白方) 集成：直接落防守点 ===');
(function () {
  var base = variants.filter(function (v) { return v.name === '原始'; })[0];
  var def = ai.getDefenseCell(base.cells);
  var defX = CX + def.dx, defY = CY + def.dy;
  var board = buildTrapBoard(base, CX, CY, SIZE);
  var res = ai.chooseMove(board, WHITE, 'master', { lastMove: null });
  var ok = res && res.r === defY && res.c === defX;
  assert(ok, '大师难度白方应直接落在防守点 (' + defX + ',' + defY + ')，实际=' +
    (res ? '(' + res.c + ',' + res.r + ')' : 'null'));
})();

console.log('=== chooseMove(大师, 黑方) 不触发白方防守策略 ===');
(function () {
  var base = variants.filter(function (v) { return v.name === '原始'; })[0];
  var def = ai.getDefenseCell(base.cells);
  var defX = CX + def.dx, defY = CY + def.dy;
  var board = buildTrapBoard(base, CX, CY, SIZE);
  // 黑方视角：该防守点本属于白方逻辑，黑方不应被该策略强制占用
  var res = ai.chooseMove(board, BLACK, 'master', { lastMove: null });
  var notForced = !(res && res.r === defY && res.c === defX);
  assert(notForced, '黑方落子不应被白方指定陷阱策略强制落在 (' + defX + ',' + defY + ')（实际=' +
    (res ? '(' + res.c + ',' + res.r + ')' : 'null') + '）');
})();

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
