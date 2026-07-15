// 单围棋 · 残局闯关 关卡配置
// 纯 JS，无 wx 依赖，便于复用与测试。
//
// 数据来源：puzzle-output/levels.json —— 由 tools/generate-endgames.js 从完整对局截图
// 自动裁剪生成的 100 关真实残局（AI 对战初始局面）。
// 每个残局满足：黑白数量相同、双方均不能一步取胜、可继续对局、
// 按复杂度自动分 easy/normal/hard/master 四档。
//
// 生成数据 schema（与 tools/puzzle-generator.js 的 generateLevel 一致）：
//   { id, boardSize, difficulty, playerColor:'black'|'white',
//     aiColor:'black'|'white', currentTurn:'black'|'white',
//     aiLevel, board: number[][] }
// 这里统一映射为闯关页使用的数值字段 (humanColor/aiColor/firstPlayer/board/...)，
// 并补齐 tierName / aiLevel，保证 challenge / challenge-game 页面无需改动即可消费。

const dango = require('./dango.js');

const EMPTY = dango.EMPTY;
const BLACK = dango.BLACK;
const WHITE = dango.WHITE;

// 档位中文名（与难度对应）
const TIER_NAMES = {
  easy: '入门',
  normal: '进阶',
  hard: '高手',
  master: '大师'
};

// 尝试加载生成的真实残局（JSON 通过 require 加载，WeChat/Node 均支持）；
// 失败则回退到占位残局（保证链路不中断）。注意：小程序运行时不支持 fs。
function colorFromSchema(s, fallback) {
  if (s === 'white') return WHITE;
  if (s === 'black') return BLACK;
  return fallback;
}

function loadGeneratedLevels() {
  try {
    const arr = require('../puzzle-output/levels-data.js');
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.map(function (lv) {
      const difficulty = lv.difficulty || 'easy';
      return {
        id: lv.id,
        name: lv.name || ('第 ' + lv.id + ' 关'),
        tierName: TIER_NAMES[difficulty] || '',
        difficulty: difficulty,
        aiLevel: lv.aiLevel || difficulty,
        // 闯关页使用数值色：直接读取生成数据 schema 中的字符串字段
        humanColor: colorFromSchema(lv.playerColor, BLACK),
        aiColor: colorFromSchema(lv.aiColor, WHITE),
        firstPlayer: colorFromSchema(lv.currentTurn, BLACK),
        boardSize: lv.boardSize,
        board: lv.board
      };
    });
  } catch (e) {
    return null;
  }
}

// ===== 占位残局（生成数据缺失时的兜底，保证选关→对局链路可验证） =====
const PLACEHOLDER_TIERS = [
  { name: '入门', difficulty: 'easy', boardSize: 13 },
  { name: '进阶', difficulty: 'normal', boardSize: 15 },
  { name: '高手', difficulty: 'hard', boardSize: 15 },
  { name: '大师', difficulty: 'master', boardSize: 19 }
];

function placeholderTierOf(id) { return Math.floor((id - 1) / 25); }

// 空棋盘兜底：无任何生成数据（关卡文件被删除）时，闯关页应只呈现空棋盘，
// 不再放置任何预设棋子。
function generatePlaceholderEndgame(id) {
  const tier = PLACEHOLDER_TIERS[placeholderTierOf(id)];
  const size = tier.boardSize;
  return dango.createBoard(size);
}

function buildPlaceholderLevel(id) {
  const tier = PLACEHOLDER_TIERS[placeholderTierOf(id)];
  const humanColor = BLACK;
  const aiColor = WHITE;
  return {
    id: id,
    name: '第 ' + id + ' 关',
    tierName: tier.name,
    difficulty: tier.difficulty,
    humanColor: humanColor,
    aiColor: aiColor,
    firstPlayer: humanColor,
    boardSize: tier.boardSize,
    board: generatePlaceholderEndgame(id)
  };
}

// ===== 装配关卡列表 =====
const generated = loadGeneratedLevels();
const USE_GENERATED = !!generated && generated.length >= 1;

const LEVELS = USE_GENERATED
  ? generated
  : (function () {
      const list = [];
      for (let i = 1; i <= 100; i++) list.push(buildPlaceholderLevel(i));
      return list;
    })();

const LEVEL_COUNT = LEVELS.length;
const TIERS = USE_GENERATED
  ? [
      { name: '入门', difficulty: 'easy', boardSize: 7 },
      { name: '进阶', difficulty: 'normal', boardSize: 9 },
      { name: '高手', difficulty: 'hard', boardSize: 11 },
      { name: '大师', difficulty: 'master', boardSize: 13 }
    ]
  : PLACEHOLDER_TIERS;

function getLevel(id) {
  const idx = id - 1;
  if (idx < 0 || idx >= LEVELS.length) return null;
  const lv = LEVELS[idx];
  // 返回深拷贝，避免对局中修改污染配置
  const copy = {};
  for (const k in lv) {
    if (lv.hasOwnProperty(k)) copy[k] = lv[k];
  }
  copy.board = lv.board.map(function (row) { return row.slice(); });
  return copy;
}

function getLevels() {
  return LEVELS;
}

module.exports = {
  LEVEL_COUNT: LEVEL_COUNT,
  TIERS: TIERS,
  USE_GENERATED: USE_GENERATED,
  getLevel: getLevel,
  getLevels: getLevels
};
