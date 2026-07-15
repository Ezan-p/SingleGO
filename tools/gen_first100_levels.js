#!/usr/bin/env node
'use strict';
/*
 * 残局关卡生成（裁剪 + 合法性校验 + AI 自动分档）— Req 9
 *
 * 第二步 · 裁剪
 *   不直接用整个 15×15 棋盘，而是从中选一块连续区域作为残局。
 *   支持裁剪尺寸：7×7 / 9×9 / 11×11 / 13×13。
 *   优先选择（见 puzzle-generator.cheapScore）：
 *     - 黑白棋最密集区域
 *     - 双方形成攻防关系区域（接触点 contactCount）
 *     - 双方都有继续发展空间（bothColorsHaveLiberty 软约束）
 *
 * 第三步 · 合法性（四条件，任一不满足则更换裁剪区域）
 *   条件一  黑棋不能一步获胜   -> checkOneMoveWin(BLACK) === null
 *   条件二  白棋不能一步获胜   -> checkOneMoveWin(WHITE) === null
 *   条件三  黑白棋数量必须相同 -> balancePieces 删除外围多余棋子
 *   条件四  残局必须能够继续   -> 双方均有子、有空点、未终局
 *
 * 第四步 · AI 难度（按复杂度升序四分位，各 25 关一档）
 *   难度标签(选关分组)：easy / normal / hard / master
 *   实际 AI 对决强度：前 25 关(简单档)仍 = normal，其余与档位一致
 *   -> 第 1–25 关 标签=easy 但 AI=normal；26–50 关 normal；51–75 关 hard；76–100 关 master
 *
 * 数据来源：puzzle-output/recognized（前 100 张截图识别结果）
 * 输出（puzzle-output/）：
 *   levels.json         闯关页 utils/levels.js 直接消费
 *   levels-data.js      JS 模块形式，供微信 require 可靠加载（微信不打包孤立 .json）
 *   manifest.json       开发元数据
 *   puzzles/level_NNN.json  每关明细
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RECOGNIZED_DIR = path.join(ROOT, 'miniprogram', 'puzzle-output', 'recognized');
const IMG_DIR = path.join(ROOT, 'miniprogram', 'puzzle-source', 'image');
const OUT_DIR = path.join(ROOT, 'miniprogram', 'puzzle-output');
const PUZZLE_DIR = path.join(OUT_DIR, 'puzzles');
const TARGET = 100;
const EMPTY = 0, BLACK = 1, WHITE = 2;

const gen = require('./puzzle-generator.js');
const dango = require(path.join(ROOT, 'miniprogram', 'utils', 'dango.js'));

// 第四档难度标签（选关页分组，各 25 关一档）：easy / normal / hard / master
// 实际 AI 对决强度：前 25 关(简单档)仍用 normal，其余档位与标签一致。
//   -> 简单关卡 AI 强度 = normal（用户要求“简单关卡，但 AI 对决难度还是 normal”）
const DIFF_TIERS = ['easy', 'normal', 'hard', 'master'];
const AI_LEVELS  = ['normal', 'normal', 'hard', 'master'];

// 裁剪尺寸（不含整盘 15×15）
const CROP_SIZES = gen.CROP_SIZES; // [7, 9, 11, 13]

// 加载识别结果（game_NNN 顺序 = 图片文件名升序，与 recognize.py 写入顺序一致）
function loadRecognized() {
  if (!fs.existsSync(RECOGNIZED_DIR)) return [];
  return fs.readdirSync(RECOGNIZED_DIR)
    .filter(f => /\.json$/.test(f))
    .sort()
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(RECOGNIZED_DIR, f), 'utf-8')); }
      catch (e) { return null; }
    })
    .filter(Boolean);
}

// 将 -1（不确定点）按正交邻域多数投票修正；无多数（含平局）视为空位。
// 保证进入裁剪/对局前棋盘全是 0/1/2。
function resolveNeg(board) {
  const size = board.length;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] !== -1) continue;
      const cnt = { 0: 0, 1: 0, 2: 0 };
      for (const [dr, dc] of dirs) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nc < 0 || nr >= size || nc >= size) continue;
        const v = board[nr][nc];
        if (v === 0 || v === 1 || v === 2) cnt[v]++;
      }
      let best = EMPTY, bestN = -1;
      for (const k of [BLACK, WHITE, EMPTY]) {
        if (cnt[k] > bestN) { bestN = cnt[k]; best = k; }
      }
      board[r][c] = best;
    }
  }
}

// 双方都有“发展空间”：某一颜色的棋子至少一颗仍与空点相邻（可在其附近落子）。
// 作为残局质量的软约束（需求第三步“双方都有继续发展的空间”）。
function bothColorsHaveLiberty(board) {
  const size = board.length;
  let bHas = false, wHas = false;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const v = board[r][c];
      if (v !== BLACK && v !== WHITE) continue;
      let lib = false;
      for (const [dr, dc] of dango.ORTHO) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < size && nc >= 0 && nc < size && board[nr][nc] === EMPTY) { lib = true; break; }
      }
      if (v === BLACK) bHas = bHas || lib;
      else wHas = wHas || lib;
      if (bHas && wHas) return true;
    }
  }
  return bHas && wHas;
}

// 把裁剪出的子棋盘放回完整棋盘尺寸（默认 15×15）的对应位置，
// 子区域之外的格子清空为空位。这样闯关页仍以 15×15 渲染，
// 残局棋子保留在原始坐标，其余区域留给玩家继续发展。
function embedCrop(fullSize, top, left, size, sub) {
  const board = [];
  for (let r = 0; r < fullSize; r++) {
    const row = [];
    for (let c = 0; c < fullSize; c++) row.push(EMPTY);
    board.push(row);
  }
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) board[top + r][left + c] = sub[r][c];
  }
  return board;
}

// 收集某张完整棋盘上所有“合法”的候选裁剪窗口。
// 已按 cheapScore 降序、再按“有发展空间”优先排列，返回可复用的候选数组。
// 每个候选最终以 15×15 嵌入棋盘形式返回（见 embedCrop）。
function allValidCrops(full) {
  const fullSize = full.length; // 识别棋盘尺寸（15）
  const wins = gen.generateWindows(full, CROP_SIZES);
  const preferred = []; // 双方都有发展空间
  const others = [];
  const seenSig = {};
  for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    // 条件三：黑白数量相同（删除外围多余棋子）
    const bal = gen.balancePieces(w.board);
    if (!bal.balanced) continue;
    // 条件一/二/四：不可一步胜、未终局、可继续（针对裁剪子区域）
    if (!gen.validatePuzzle(bal.board).valid) continue;
    // 嵌入 15×15 后再校验一次（边缘胜利/发展空间在整盘下更安全，但双保险）
    const embedded = embedCrop(fullSize, w.top, w.left, w.size, bal.board);
    if (!gen.validatePuzzle(embedded).valid) continue;
    if (gen.checkOneMoveWin(embedded, BLACK)) continue;
    if (gen.checkOneMoveWin(embedded, WHITE)) continue;
    const sig = gen.signature(embedded);
    if (seenSig[sig]) continue;
    seenSig[sig] = true;
    const item = {
      board: embedded,
      crop: { top: w.top, left: w.left, size: w.size },
      complexity: gen.complexityScore(embedded),
      liberty: bothColorsHaveLiberty(embedded)
    };
    if (item.liberty) preferred.push(item); else others.push(item);
  }
  return preferred.concat(others);
}

// 前十关专用：基于“棋子最少”的十个对局设计，要求黑白数量相同（硬性），
// 并尽量让黑（人类）一步制胜（软性“尽量”）。
// 对每张源图：优先在其内部裁剪一个“黑白已平衡 + 嵌入 15×15 后仍黑一步制胜”的小区域；
// 找不到则退回该图整体平衡后的全盘（仍保证黑白相等，一步制胜尽力求之）。
// 返回 { board, crop, winMove, total, balance, isFull } 候选（已平衡）。
function findBalancedWinCrop(full) {
  const fullSize = full.length;
  const out = [];
  const wins = gen.generateWindows(full, CROP_SIZES);
  for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    const bal = gen.balancePieces(w.board);     // 黑白数量相同（硬性）
    if (!bal.balanced) continue;
    const cnt0 = gen.countPieces(bal.board);
    if (cnt0.black === 0 || cnt0.white === 0) continue;
    // 嵌入 15×15 后再次校验（裁剪边界在整盘下变为空位，可能丢失边角制胜）
    const embedded = embedCrop(fullSize, w.top, w.left, w.size, bal.board);
    const winEmbed = gen.checkOneMoveWin(embedded, BLACK); // 尽量一步制胜
    if (!winEmbed) continue;
    const cnt = gen.countPieces(embedded);
    out.push({
      board: embedded,
      crop: { top: w.top, left: w.left, size: w.size },
      winMove: winEmbed,
      total: cnt.black + cnt.white,
      balance: 0,
      isFull: false,
      sourceImage: null
    });
  }
  out.sort(function (a, b) {
    return (a.total - b.total) || (a.crop.size - b.crop.size);
  });
  return out;
}

// 退回方案：整盘平衡（黑白相等），不保证一步制胜。
function fullBalancedFallback(full) {
  const bal = gen.balancePieces(full);
  if (!bal.balanced) return null;
  const cnt = gen.countPieces(bal.board);
  if (cnt.black === 0 || cnt.white === 0) return null;
  return {
    board: bal.board,
    crop: { top: 0, left: 0, size: full.length, full: true },
    winMove: gen.checkOneMoveWin(bal.board, BLACK),
    total: cnt.black + cnt.white,
    balance: 0,
    isFull: true,
    sourceImage: null
  };
}

// L11/L12 专用：从“最少棋子的对局”产出特殊风格残局候选（沿用 L1–L10 设计法）。
// 要求：黑白数量相同（硬性）、可继续（非终局）、嵌入 15×15。
// 排序：能“黑一步制胜”者优先，其次按棋子数升序。返回候选数组（已平衡）。
function allSpecialCrops(full) {
  const fullSize = full.length;
  const wins = gen.generateWindows(full, CROP_SIZES);
  const out = [];
  for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    const bal = gen.balancePieces(w.board);
    if (!bal.balanced) continue;
    const c0 = gen.countPieces(bal.board);
    if (c0.black === 0 || c0.white === 0) continue;
    const embedded = embedCrop(fullSize, w.top, w.left, w.size, bal.board);
    if (!gen.validatePuzzle(embedded).valid) continue; // 必须能继续（非终局）
    const win = gen.checkOneMoveWin(embedded, BLACK);  // 尽量黑一步制胜
    out.push({
      board: embedded,
      crop: { top: w.top, left: w.left, size: w.size },
      winMove: win,
      total: c0.black + c0.white,
      isFull: false,
      sourceImage: null
    });
  }
  const fb = fullBalancedFallback(full);
  if (fb && !out.some(o => gen.signature(o.board) === gen.signature(fb.board))) out.push(fb);
  out.sort((a, b) => (b.winMove ? 1 : 0) - (a.winMove ? 1 : 0) || (a.total - b.total));
  return out;
}

// 把候选包装成与 allValidCrops 同构的 item（便于统一装配）。
function makeSpecialItem(cand, sourceImage) {
  return {
    board: cand.board,
    crop: cand.crop,
    complexity: gen.complexityScore(cand.board),
    liberty: bothColorsHaveLiberty(cand.board),
    special: true,
    winMove: cand.winMove,
    isFullBoard: !!cand.isFull,
    sourceImage: sourceImage
  };
}

function main() {
  const recs = loadRecognized();
  if (recs.length === 0) {
    console.error('未找到识别结果，请先运行 tools/recognize.py');
    process.exit(1);
  }

  // 解析 -1 后的完整棋盘
  const fulls = recs.map(rec => {
    const b = rec.board.map(row => row.slice());
    resolveNeg(b);
    return { board: b, sourceImage: rec.sourceImage };
  });

  // ===== 前十关：基于“棋子最少”的十个对局，黑白相等，尽量一步制胜 =====
  // 1) 统计每张识别图总棋子数（已解析 -1），升序排列 -> 最少棋子的对局在前。
  const stoneOrder = fulls.map(function (f, idx) {
    const c = gen.countPieces(f.board);
    return { idx: idx, total: c.black + c.white };
  }).sort(function (a, b) { return a.total - b.total; });

  // 2) 取前若干张最少棋子的对局，各产出一个“黑白相等、尽量一步制胜”的残局，凑满 10 关。
  //    优先裁剪“平衡 + 一步制胜”的小区域；找不到则退回整盘平衡（仍黑白相等）。
  const SPECIAL_COUNT = 10;
  const special = [];
  const specialSources = {};
  const specialSigs = {};
  for (let s = 0; s < stoneOrder.length && special.length < SPECIAL_COUNT; s++) {
    const k = stoneOrder[s].idx;
    const full = fulls[k].board;
    const crops = findBalancedWinCrop(full);
    let cand = crops.length ? crops[0] : fullBalancedFallback(full);
    if (!cand) continue; // 该图无法平衡（某色为 0），跳过，取下一少子图
    const sig = gen.signature(cand.board);
    if (specialSigs[sig]) continue;
    specialSigs[sig] = true;
    special.push(makeSpecialItem(cand, fulls[k].sourceImage));
    specialSources[fulls[k].sourceImage] = true;
  }
  const cropTarget = TARGET - special.length; // 其余 90 关走裁剪管线

  // 裁剪候选池：排除已被前五关占用的源图，避免同一局重复出现
  const cropPool = fulls
    .filter(f => !specialSources[f.sourceImage])
    .map(f => allValidCrops(f.board).map(it => Object.assign({ sourceImage: f.sourceImage }, it)));

  // 轮询取候选：优先每张图取一个，不足时再取下一个合法裁剪（去重）
  let cropChosen = [];
  const cropUsed = {};
  const sigOf = it => gen.signature(it.board);
  let guard = 0;
  const MAX_GUARD = cropTarget * cropPool.length + cropTarget;
  while (cropChosen.length < cropTarget && guard++ < MAX_GUARD) {
    const idx = (guard - 1) % cropPool.length;
    const list = cropPool[idx] || [];
    let took = false;
    for (let i = 0; i < list.length; i++) {
      const sig = sigOf(list[i]);
      if (cropUsed[sig]) continue;
      cropUsed[sig] = true;
      cropChosen.push(list[i]);
      took = true;
      break;
    }
    if (!took) {
      const allExhausted = cropPool.every(list => list.every(it => cropUsed[sigOf(it)]));
      if (allExhausted) break;
    }
  }

  if (cropChosen.length < cropTarget) {
    console.error('合法裁剪候选不足 %d（仅 %d），请检查识别数据。', cropTarget, cropChosen.length);
    process.exit(1);
  }

  // 裁剪关按复杂度升序排序 -> 难度递进；前十关固定置顶。
  // 前十关内部再按“最终棋子数”升序、且一步制胜优先排序，保证难度由易到难。
  cropChosen.sort((a, b) => a.complexity - b.complexity);
  special.sort(function (a, b) {
    const ca = gen.countPieces(a.board), cb = gen.countPieces(b.board);
    const ta = ca.black + ca.white, tb = cb.black + cb.white;
    return (ta - tb) || ((b.winMove ? 1 : 0) - (a.winMove ? 1 : 0));
  });

  // ===== 重新设计 L11–L17：专挑“≥10 子”的合法裁剪，避免与 L1–L10 及彼此重复 =====
  // 从裁剪池（已通过四条件校验、已与源图去重）中取复杂度最低、且棋子数 ≥ MIN_STONES 的
  // 7 个候选作为 L11–L17；其余裁剪顺延为 L18–L100，保持复杂度升序、且与 L1–L10/彼此去重。
  const MIN_STONES_L1117 = 10;
  const newFront = [];
  const newFrontSigs = {};
  for (let i = 0; i < cropChosen.length && newFront.length < 7; i++) {
    const it = cropChosen[i];
    const sig = gen.signature(it.board);
    if (specialSigs[sig]) continue;            // 与 L1–L10 重复，跳过
    if (newFrontSigs[sig]) continue;           // L11–L17 内部去重
    const c = gen.countPieces(it.board);
    if (c.black + c.white < MIN_STONES_L1117) continue; // 不足 10 子，跳过
    newFrontSigs[sig] = true;
    newFront.push(it);
  }
  if (newFront.length < 7) {
    console.error('无法为 L11–L17 凑齐 7 个“≥10 子”的合法裁剪（仅 %d），请检查识别数据。', newFront.length);
    process.exit(1);
  }
  // 其余裁剪：去掉被 L11–L17 占用、以及与 L1–L10 重复的签名，保持复杂度升序
  const tail = cropChosen.filter(function (it) {
    const sig = gen.signature(it.board);
    return !newFrontSigs[sig] && !specialSigs[sig];
  });
  cropChosen = newFront.concat(tail);

  // ===== L11/L12 专按“最少棋子的两张对局”设计（沿用 L1–L10 特殊设计法）=====
  // 取识别对局中总棋子数最少的两张（stoneOrder[0]、stoneOrder[1]），
  // 各产出一个“黑白相等 + 尽量黑一步制胜 + 嵌入 15×15”的残局，
  // 且与 L1–L10 及彼此不重复（棋盘签名去重）。
  const twoFewestIdx = [stoneOrder[0].idx, stoneOrder[1].idx];
  const l11l12 = [];
  const l11l12Sigs = Object.assign({}, specialSigs); // 先排除与 L1–L10 重复的签名
  for (let t = 0; t < twoFewestIdx.length; t++) {
    const k = twoFewestIdx[t];
    const cands = allSpecialCrops(fulls[k].board);
    let picked = null;
    for (let i = 0; i < cands.length; i++) {
      const sig = gen.signature(cands[i].board);
      if (l11l12Sigs[sig]) continue;  // 与 L1–L10 或已选的 L11/L12 重复，跳过
      l11l12Sigs[sig] = true;
      picked = cands[i];
      break;
    }
    if (!picked) {
      console.error('无法为 L%d 从最少棋子对局 %s 取得非重复残局', 11 + t, fulls[k].sourceImage);
      process.exit(1);
    }
    l11l12.push(makeSpecialItem(picked, fulls[k].sourceImage));
  }
  // 用特殊设计替换裁剪池中 L11、L12 的位置（cropChosen[0]、cropChosen[1]）
  cropChosen[0] = l11l12[0];
  cropChosen[1] = l11l12[1];

  const chosen = special.concat(cropChosen);

  // ===== 按用户要求互换关卡位置：第2关↔第12关，第3关↔第11关 =====
  // 仅交换关卡“内容”所在位置；id/名称/难度档位均按最终位置重新计算，故随位置不变。
  function swapInPlace(arr, i, j) { const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
  swapInPlace(chosen, 1, 11);  // 第2关(下标1) ↔ 第12关(下标11)
  swapInPlace(chosen, 2, 10);  // 第3关(下标2) ↔ 第11关(下标10)

  const levels = [];
  const manifest = [];
  chosen.forEach((c, i) => {
    const id = i + 1;
    const tierIdx = Math.floor((id - 1) / 25); // 0..3
    const difficulty = DIFF_TIERS[tierIdx];
    const aiLevel = AI_LEVELS[tierIdx];
    const cnt = gen.countPieces(c.board);
    const isSpecial = !!c.special;

    const level = {
      id,
      name: '残局 ' + String(id).padStart(3, '0'),
      boardSize: c.board.length,
      difficulty,
      playerColor: 'black',
      aiColor: 'white',
      currentTurn: 'black',
      aiLevel: aiLevel,
      humanColor: BLACK,
      aiColorNum: WHITE,
      firstPlayer: BLACK,
      board: c.board,
      crop: c.crop,
      sourceImage: c.sourceImage,
      winInOne: !!(isSpecial && c.winMove),
      winMove: c.winMove || null,
      isFullBoard: !!c.crop.full,
      blackCount: cnt.black,
      whiteCount: cnt.white,
      stoneCount: cnt.black + cnt.white,
      complexity: Math.round(c.complexity * 100) / 100
    };
    levels.push(level);
    manifest.push({
      id,
      sourceImage: c.sourceImage,
      crop: c.crop,
      boardSize: c.board.length,
      difficulty,
      aiLevel: aiLevel,
      board: c.board,
      winInOne: !!(isSpecial && c.winMove),
      winMove: c.winMove || null,
      isFullBoard: !!c.crop.full,
      blackCount: cnt.black,
      whiteCount: cnt.white,
      stoneCount: cnt.black + cnt.white,
      complexity: Math.round(c.complexity * 100) / 100,
      hasDevelopmentSpace: c.liberty
    });
  });

  // ===== 终检：L11–L17 必须与残局闯关全部 100 关中的其他所有关卡不重复 =====
  // 遍历最终 levels 集合，逐关记录棋盘签名；若任两关签名相同则构建失败。
  // 并单独确认 L11–L17（id 11..17）切片既内部唯一、也不与 L1–L10、L18–L100 任一关重复。
  (function assertGlobalUnique() {
    const allSigs = new Map(); // sig -> id
    for (const lv of levels) {
      const s = gen.signature(lv.board);
      if (allSigs.has(s)) {
        console.error('✗ 发现重复关卡：L%d 与 L%d 棋盘完全相同', allSigs.get(s), lv.id);
        process.exit(1);
      }
      allSigs.set(s, lv.id);
    }
    // 其余 93 关（L1–L10 + L18–L100）的签名集合
    const restSigs = new Set(
      levels.filter(l => l.id < 11 || l.id > 17).map(l => gen.signature(l.board))
    );
    const frontIds = [];
    for (const lv of levels.slice(10, 17)) {
      if (restSigs.has(gen.signature(lv.board))) {
        console.error('✗ L%d 与残局其他关卡重复', lv.id);
        process.exit(1);
      }
      frontIds.push(lv.id);
    }
    console.log('✓ 终检通过：L' + frontIds.join('/') + ' 与全部 100 关中的其他所有关卡均无重复。');
  })();

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(PUZZLE_DIR)) fs.mkdirSync(PUZZLE_DIR, { recursive: true });

  fs.writeFileSync(path.join(OUT_DIR, 'levels.json'), JSON.stringify(levels), 'utf-8');
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  fs.writeFileSync(
    path.join(OUT_DIR, 'levels-data.js'),
    '// auto-generated by tools/gen_first100_levels.js (Req9: crop + legality + AI tier)\nmodule.exports=' + JSON.stringify(levels) + ';\n',
    'utf-8');

  for (const lv of levels) {
    fs.writeFileSync(
      path.join(PUZZLE_DIR, 'level_' + String(lv.id).padStart(3, '0') + '.json'),
      JSON.stringify(lv, null, 2), 'utf-8');
  }

  // ===== 统计报告 =====
  const ids = levels.map(l => l.id);
  const tierDist = {};
  const aiDist = {};
  const sizeDist = {};
  const devCount = manifest.filter(m => m.hasDevelopmentSpace).length;
  let totalStones = 0, minStones = 1e9, maxStones = 0;
  levels.forEach(l => {
    tierDist[l.difficulty] = (tierDist[l.difficulty] || 0) + 1;
    aiDist[l.aiLevel] = (aiDist[l.aiLevel] || 0) + 1;
    sizeDist[l.boardSize] = (sizeDist[l.boardSize] || 0) + 1;
    totalStones += l.stoneCount;
    minStones = Math.min(minStones, l.stoneCount);
    maxStones = Math.max(maxStones, l.stoneCount);
  });

  console.log('\n===== 残局生成（前十关=最少棋子对局·黑白相等·尽量一步制胜 + 其余裁剪 7/9/11/13 + 四条件 + AI 分档）=====');
  console.log('识别图总数: %d | 生成关卡: %d (目标 %d)', recs.length, levels.length, TARGET);
  console.log('前十关(最少棋子对局/黑白相等/尽量一步制胜): %d | 裁剪关: %d', special.length, cropChosen.length);
  const winInfo = special.map((s, i) => {
    const cnt = gen.countPieces(s.board);
    const win = s.winMove ? JSON.stringify(s.winMove) : '无(平衡全盘)';
    return 'L' + (i + 1) + ' 子数=' + (cnt.black + cnt.white) + '(B' + cnt.black + '/W' + cnt.white + ') 一步制胜=' + win + ' (' + s.sourceImage.split('/').pop() + ')';
  });
  if (winInfo.length) console.log(winInfo.join('\n'));
  console.log('难度标签分布(选关分组, 按 id 升序):', JSON.stringify(tierDist));
  console.log('AI 对决强度分布:', JSON.stringify(aiDist));
  console.log('尺寸分布:', JSON.stringify(sizeDist));
  console.log('双方均有发展空间(软约束命中): %d / %d', devCount, levels.length);
  console.log('棋子数范围: [%d, %d]，平均 %d', minStones, maxStones, Math.round(totalStones / levels.length));
  console.log('已写出: levels.json, levels-data.js, manifest.json, puzzles/level_*.json');
  console.log('id 区间: [%d, %d]', Math.min.apply(null, ids), Math.max.apply(null, ids));
}

if (require.main === module) main();

module.exports = { resolveNeg, allValidCrops, bothColorsHaveLiberty };
