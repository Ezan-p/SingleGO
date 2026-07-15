#!/usr/bin/env node
'use strict';
/*
 * 残局关卡生成 · 直接用法（完整对局截图 = 残局）
 *
 * 与 puzzle-generator.js（裁剪 7/9/11/13 的 AI 对战初始局面）不同，
 * 本脚本“直接”把每一张完整对局截图识别出的 15×15 全盘，
 * 作为一关残局应用到闯关模式：不裁剪、不重平衡、不强制黑白相等。
 *
 * 仅做最小可用性筛选（保证能玩）：
 *   1) 双方均有子       2) 仍有空点（可落子）
 *   3) 局面未终局（不是已分胜负/已判负）
 * 并对“黑(玩家)一步即胜”的平凡盘面做降权：优先选非一步胜的，
 * 不足 100 关时再补入一步胜盘面，保证数量。
 *
 * 难度（AI 等级）按盘面复杂度四分位分 easy/normal/hard/master。
 *
 * 输出（puzzle-output/，与闯关页 utils/levels.js 约定 schema 一致）：
 *   levels.json      可玩关卡
 *   manifest.json    开发元数据（原图名称/裁剪位置(null)/棋盘数组/AI等级）
 *   puzzles/level_NNN.json  每关明细
 * 不修改任何原始截图。
 */

var fs = require('fs');
var path = require('path');
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

// 难度分档（按复杂度排名四分位）
function tierOf(rank, total) {
  var f = rank / total;
  if (f < 0.25) return 'easy';
  if (f < 0.50) return 'normal';
  if (f < 0.75) return 'hard';
  return 'master';
}

// ============================================================
//  加载已识别棋盘（筛选：可信、无 -1）
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
//  由完整全盘构造残局
// ============================================================
function buildLevels(boards, target) {
  var cand = [];
  var seen = {};
  for (var i = 0; i < boards.length; i++) {
    var b = boards[i].board;
    var c = gen.countPieces(b);
    if (c.black === 0 || c.white === 0) continue;   // 双方均需有子
    if (c.empty === 0) continue;                       // 需有空点可落子
    if (gen.isTerminal(b)) continue;                    // 跳过已终局（已分胜负）
    var sig = gen.signature(b);
    if (seen[sig]) continue;                            // 去重（含旋转/翻转）
    seen[sig] = true;
    var blackInstant = !!gen.checkOneMoveWin(b, gen.BLACK); // 玩家(黑)一步即胜→平凡
    cand.push({
      sourceImage: boards[i].sourceImage,
      board: b,
      complexity: gen.complexityScore(b),
      blackInstant: blackInstant
    });
  }

  // 优先非一步胜，其次复杂度高（更耐玩）
  cand.sort(function (a, b) {
    if (a.blackInstant !== b.blackInstant) return a.blackInstant ? 1 : -1;
    return b.complexity - a.complexity;
  });

  var chosen = cand.slice(0, target);

  // 按复杂度升序重排，使四档难度在 id 上连续（选关页分组标题更整洁）
  var sorted = chosen.slice().sort(function (a, b) { return a.complexity - b.complexity; });

  var levels = [];
  var manifest = [];
  sorted.forEach(function (c, i) {
    var id = i + 1;
    var difficulty = tierOf(i, sorted.length);
    var level = gen.generateLevel({
      id: id, board: c.board, difficulty: difficulty,
      sourceImage: c.sourceImage, crop: null
    });
    levels.push(level);
    manifest.push({
      id: id,
      sourceImage: c.sourceImage,
      crop: null,                       // 直接用全盘，无裁剪
      boardSize: c.board.length,
      difficulty: difficulty,
      aiLevel: difficulty,
      board: c.board
    });
  });

  return {
    levels: levels,
    manifest: manifest,
    report: {
      candidateCount: cand.length,
      chosenCount: chosen.length,
      target: target,
      instantWinIncluded: chosen.filter(function (x) { return x.blackInstant; }).length
    }
  };
}

// ============================================================
//  写出产物
// ============================================================
function writeOutputs(result) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(PUZZLE_DIR)) fs.mkdirSync(PUZZLE_DIR, { recursive: true });

  fs.writeFileSync(LEVELS_PATH, JSON.stringify(result.levels, null, 2), 'utf-8');
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(result.manifest, null, 2), 'utf-8');

  // 额外写出 JS 模块形式 (levels-data.js)，供微信 require 可靠加载。
  // 微信开发者工具不会打包未被显式引用的独立 .json 文件，
  // 仅 require 一个 .js 模块才能保证关卡数据被编入小程序包。
  fs.writeFileSync(
    path.join(OUT_DIR, 'levels-data.js'),
    '// auto-generated by tools/generate-fulllevels.js\nmodule.exports=' +
      JSON.stringify(result.levels) + ';\n',
    'utf-8');

  result.manifest.forEach(function (m) {
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
    console.error('无可用识别结果，请检查 puzzle-source 图片目录。');
    process.exit(1);
  }

  var result = buildLevels(boards, TARGET);
  writeOutputs(result);

  var rep = result.report;
  var tiers = { easy: 0, normal: 0, hard: 0, master: 0 };
  result.levels.forEach(function (l) { tiers[l.difficulty]++; });

  console.log('\n===== 残局生成报告（直接用法 · 完整截图=残局）=====');
  console.log('候选全盘(可用): %d', rep.candidateCount);
  console.log('最终入选: %d（目标 %d）', rep.chosenCount, rep.target);
  if (rep.chosenCount < rep.target) {
    console.log('⚠ 缺口: %d（可用全盘不足，未伪造补充）', rep.target - rep.chosenCount);
  }
  console.log('其中“黑一步即胜”平凡盘面: %d', rep.instantWinIncluded);
  console.log('难度分布: easy=%d normal=%d hard=%d master=%d',
    tiers.easy, tiers.normal, tiers.hard, tiers.master);
  console.log('已写出: %s', LEVELS_PATH);
  console.log('已写出: %s', MANIFEST_PATH);
  console.log('已写出明细: %d 个 → %s', result.manifest.length, PUZZLE_DIR);
}

if (require.main === module) {
  main();
}
