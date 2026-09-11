// 段位系统工具模块 — 纯函数，无 wx.* 依赖

const RANKS = [
  // 新手阶段 (beginner)
  { id: 0,  name: '棋童',     points: 0,     tier: 'beginner' },
  { id: 1,  name: '棋童一级',  points: 100,   tier: 'beginner' },
  { id: 2,  name: '棋童二级',  points: 300,   tier: 'beginner' },
  { id: 3,  name: '棋童三级',  points: 600,   tier: 'beginner' },
  // 业余级位 (kyu)
  { id: 4,  name: '业余10级',  points: 1000,  tier: 'kyu' },
  { id: 5,  name: '业余9级',   points: 1400,  tier: 'kyu' },
  { id: 6,  name: '业余8级',   points: 1800,  tier: 'kyu' },
  { id: 7,  name: '业余7级',   points: 2300,  tier: 'kyu' },
  { id: 8,  name: '业余6级',   points: 2800,  tier: 'kyu' },
  { id: 9,  name: '业余5级',   points: 3400,  tier: 'kyu' },
  { id: 10, name: '业余4级',   points: 4100,  tier: 'kyu' },
  { id: 11, name: '业余3级',   points: 4800,  tier: 'kyu' },
  { id: 12, name: '业余2级',   points: 5600,  tier: 'kyu' },
  { id: 13, name: '业余1级',   points: 6500,  tier: 'kyu' },
  // 业余段位 (dan)
  { id: 14, name: '业余1段',   points: 7500,  tier: 'dan' },
  { id: 15, name: '业余2段',   points: 8800,  tier: 'dan' },
  { id: 16, name: '业余3段',   points: 10200, tier: 'dan' },
  { id: 17, name: '业余4段',   points: 11800, tier: 'dan' },
  { id: 18, name: '业余5段',   points: 13600, tier: 'dan' },
  { id: 19, name: '业余6段',   points: 15600, tier: 'dan' },
  { id: 20, name: '业余7段',   points: 17800, tier: 'dan' },
  { id: 21, name: '业余8段',   points: 20200, tier: 'dan' },
  // 大师阶段 (master)
  { id: 22, name: '准大师',    points: 23000, tier: 'master' },
  { id: 23, name: '大师',      points: 26500, tier: 'master' },
  { id: 24, name: '宗师',      points: 30500, tier: 'master' },
  { id: 25, name: '棋圣',      points: 35000, tier: 'master' }
];

const POINTS_CONFIG = {
  onlineWin: 30,
  onlineLoss: -15,
  aiWin: 10,
  aiLoss: -5,
  localWin: 0,
  localLoss: 0,
  friendWin: 0,
  friendLoss: 0,
  minPoints: 0
};

const TIER_COLORS = {
  beginner: '#8B7355',
  kyu: '#6B8E23',
  dan: '#4682B4',
  master: '#DAA520'
};

const TIER_LABELS = {
  beginner: '新',
  kyu: '级',
  dan: '段',
  master: '圣'
};

// 生成6位UID（排除易混淆字符）
function generateUID() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = 'DG'; // 前缀 DG（单围棋）
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// 根据积分获取段位对象
function getRankByPoints(points) {
  points = Math.max(POINTS_CONFIG.minPoints, points || 0);
  let rankIndex = 0;
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (points >= RANKS[i].points) {
      rankIndex = i;
      break;
    }
  }
  const rank = RANKS[rankIndex];
  const nextRank = rankIndex < RANKS.length - 1 ? RANKS[rankIndex + 1] : null;
  const progress = nextRank
    ? (points - rank.points) / (nextRank.points - rank.points)
    : 1;
  return {
    id: rank.id,
    name: rank.name,
    tier: rank.tier,
    points: rank.points,
    nextRank: nextRank ? nextRank.name : null,
    nextRankPoints: nextRank ? nextRank.points : null,
    progress: Math.min(1, Math.max(0, progress))
  };
}

function getRankName(points) {
  return getRankByPoints(points).name;
}

function getTierName(points) {
  return getRankByPoints(points).tier;
}

function getProgress(points) {
  return getRankByPoints(points).progress;
}

function getTierColor(tier) {
  return TIER_COLORS[tier] || '#8B7355';
}

function getRankDisplay(points) {
  const rank = getRankByPoints(points);
  const label = TIER_LABELS[rank.tier] || '';
  return '[' + label + ']' + rank.name;
}

// 计算积分变化
function calcPointsChange(mode, result) {
  const key = mode + (result === 'win' ? 'Win' : 'Loss');
  return POINTS_CONFIG[key] || 0;
}

// 应用积分变化，返回变更结果
function applyPointsChange(currentPoints, mode, result) {
  var oldRank = getRankByPoints(currentPoints);
  var change = calcPointsChange(mode, result);
  var newPoints = currentPoints + change;

  // 积分下限
  newPoints = Math.max(POINTS_CONFIG.minPoints, newPoints);

  // 不降段：如果新积分低于当前段位门槛，积分减少但段位不变
  // 只在新积分对应段位低于当前段位时触发
  var newRankByPoints = getRankByPoints(newPoints);
  var promoted = false;

  if (newRankByPoints.id > oldRank.id) {
    // 升段
    promoted = true;
  } else if (newRankByPoints.id < oldRank.id) {
    // 不降段：保持当前段位门槛积分
    newPoints = Math.max(newPoints, RANKS[oldRank.id].points);
  }

  var finalRank = getRankByPoints(newPoints);

  return {
    oldRank: oldRank,
    newRank: finalRank,
    promoted: promoted,
    newPoints: newPoints,
    pointsChange: change
  };
}

// 创建默认玩家数据
function createDefaultProfile(openid) {
  return {
    nickname: '',
    avatar: '',
    openid: openid || '',
    uid: generateUID(),
    rankPoints: 0,
    rankName: '棋童',
    registerTime: Date.now(),
    stats: {
      online: { total: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0 },
      ai: { total: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0 },
      local: { total: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0 }
    },
    version: 1
  };
}

// 更新战绩统计
function updateStats(stats, mode, result) {
  var s = stats[mode];
  if (!s) return;
  s.total++;
  if (result === 'win') {
    s.wins++;
    s.currentStreak++;
    if (s.currentStreak > s.bestStreak) {
      s.bestStreak = s.currentStreak;
    }
  } else {
    s.losses++;
    s.currentStreak = 0;
  }
}

module.exports = {
  RANKS: RANKS,
  POINTS_CONFIG: POINTS_CONFIG,
  TIER_COLORS: TIER_COLORS,
  TIER_LABELS: TIER_LABELS,
  generateUID: generateUID,
  getRankByPoints: getRankByPoints,
  getRankName: getRankName,
  getTierName: getTierName,
  getProgress: getProgress,
  getTierColor: getTierColor,
  getRankDisplay: getRankDisplay,
  calcPointsChange: calcPointsChange,
  applyPointsChange: applyPointsChange,
  createDefaultProfile: createDefaultProfile,
  updateStats: updateStats
};
