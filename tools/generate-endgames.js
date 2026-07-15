#!/usr/bin/env node
'use strict';
/*
 * 残局关卡自动生成 · 运行入口（AI 对战初始局面）
 *
 * 流程：
 *   1. 加载已识别棋盘（puzzle-output/recognized/*.json）
 *      —— 若缓存为空，则先调用 recognize.py 重新识别源图
 *   2. batchGenerateLevels() 生成并去重，产出 100 关
 *   3. 写出 puzzle-output/：
 *        levels.json       可玩关卡（需求 schema：id/boardSize/difficulty/
 *                          playerColor/aiColor/currentTurn/aiLevel/board）
 *        manifest.json     开发元数据（原图名称/裁剪位置/棋盘数组/AI等级）
 *        puzzles/level_NNN.json  每关明细
 *
 * 不修改任何原始截图（仅读取）。
 */

var path = require('path');
var fs = require('fs');
var cp = require('child_process');

var gen = require('./puzzle-generator.js');

var ROOT = path.join(__dirname, '..');
var RECOGNIZED_DIR = path.join(ROOT, 'miniprogram', 'puzzle-output', 'recognized');
var OUT_DIR = path.join(ROOT, 'miniprogram', 'puzzle-output');
var LEVELS_PATH = path.join(OUT_DIR, 'levels.json');
var MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json');
var PUZZLE_DIR = path.join(OUT_DIR, 'puzzles');
var RECOGNIZE_PY = path.join(__dirname, 'recognize.py');

var TARGET = parseInt(process.env.TARGET || '100', 10);

// ============================================================
//  加载已识别棋盘（筛选：可信、无 -1、双方均有子）
// ============================================================
function loadRecognized() {
  if (!fs.existsSync(RECOGNIZED_DIR)) return [];
  var files = fs.readdirSync(RECOGNIZED_DIR)
    .filter(function (f) { return /\.json$/.test(f); })
    .sort();
  var list = [];
  files.forEach(function (f) {
    var d;
    try { d = JSON.parse(fs.readFileSync(path.join(RECOGNIZED_DIR, f), 'utf-8')); }
    catch (e) { return; }
    if (d.manualReview) return;
    if (!d.board || d.board.length === 0) return;
    // 含不确定交点(-1)的图跳过，保证残局公平
    for (var r = 0; r < d.board.length; r++) {
      for (var c = 0; c < d.board[r].length; c++) {
        if (d.board[r][c] === -1) return;
      }
    }
    list.push({ sourceImage: d.sourceImage || f, board: d.board });
  });
  return list;
}

function ensureRecognized() {
  var list = loadRecognized();
  if (list.length > 0) return list;
  console.log('未找到已识别缓存，先运行 recognize.py 识别源图...');
  cp.execFileSync('python3', [RECOGNIZE_PY], { stdio: 'inherit' });
  return loadRecognized();
}

// ============================================================
//  写出产物
// ============================================================
function writeOutputs(result) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(PUZZLE_DIR)) fs.mkdirSync(PUZZLE_DIR, { recursive: true });

  fs.writeFileSync(LEVELS_PATH, JSON.stringify(result.levels, null, 2), 'utf-8');
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(result.manifest, null, 2), 'utf-8');

  result.manifest.forEach(function (m) {
    // 明细：补充棋子坐标、玩家/AI 颜色、当前手
    var blackStones = [], whiteStones = [];
    for (var r = 0; r < m.board.length; r++) {
      for (var c = 0; c < m.board[r].length; c++) {
        if (m.board[r][c] === gen.BLACK) blackStones.push([r, c]);
        else if (m.board[r][c] === gen.WHITE) whiteStones.push([r, c]);
      }
    }
    var detail = {
      id: m.id,
      sourceImage: m.sourceImage,
      crop: m.crop,
      boardSize: m.boardSize,
      difficulty: m.difficulty,
      aiLevel: m.aiLevel,
      playerColor: 'black',
      aiColor: 'white',
      currentTurn: 'black',
      board: m.board,
      blackStones: blackStones,
      whiteStones: whiteStones
    };
    fs.writeFileSync(
      path.join(PUZZLE_DIR, 'level_' + String(m.id).padStart(3, '0') + '.json'),
      JSON.stringify(detail, null, 2), 'utf-8');
  });
}

function main() {
  var boards = ensureRecognized();
  console.log('已加载可信识别图: %d 张', boards.length);
  if (boards.length === 0) {
    console.error('无可用识别结果，无法生成残局。请检查 puzzle-source 图片目录。');
    process.exit(1);
  }

  var result = gen.batchGenerateLevels(boards, { targetCount: TARGET });

  writeOutputs(result);

  var rep = result.report;
  console.log('\n===== 残局生成报告（AI 对战初始局面）=====');
  console.log('候选残局数(去重后): %d', rep.candidateCount);
  console.log('最终入选: %d（目标 %d）', rep.chosenCount, rep.target);
  if (rep.chosenCount < rep.target) {
    console.log('⚠ 缺口: %d（未伪造补充）', rep.target - rep.chosenCount);
  }
  console.log('难度分布: easy=%d normal=%d hard=%d master=%d',
    rep.tierCounts.easy, rep.tierCounts.normal, rep.tierCounts.hard, rep.tierCounts.master);
  console.log('过滤统计: 不平衡=%d 非法=%d 重复=%d',
    rep.filtered.unbalanced, rep.filtered.invalid, rep.filtered.duplicate);
  console.log('已写出: %s', LEVELS_PATH);
  console.log('已写出: %s', MANIFEST_PATH);
  console.log('已写出明细: %d 个 → %s', result.manifest.length, PUZZLE_DIR);
}

if (require.main === module) {
  main();
}
