// js/storage.js
// 全局数据与本地存储模块（小游戏版）
// 取代小程序的 App.globalData + app.js 中的档案初始化逻辑。
// 存储仍使用 wx.setStorageSync / wx.getStorageSync，键名与小程序版保持一致，
// 因此老用户升级到小游戏后本地段位、战绩、闯关进度不会丢失。

const rank = require('./rank.js');

const KEY_PROFILE = 'playerProfile';
const KEY_OPENID = 'openid';
const KEY_SETTINGS = 'settings';

// 全局数据（等价于小程序 App.globalData）
const globalData = {
  openid: null,
  nickname: '',
  avatar: '',
  cloudInited: false,
  rankPoints: 0,
  rankName: '棋童',
  uid: '',
  playerProfile: null
};

function safeGet(key, fallback) {
  try {
    const v = wx.getStorageSync(key);
    return (v === '' || v === null || v === undefined) ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function safeSet(key, value) {
  try {
    wx.setStorageSync(key, value);
  } catch (e) {
    console.warn('[dango] 写入本地存储失败:', key, e);
  }
}

// ===== 玩家档案 =====

// 初始化玩家档案（段位、战绩等）——对应 app.js#initPlayerProfile
function initPlayerProfile() {
  var profile = safeGet(KEY_PROFILE, null);
  if (profile && profile.version === 1) {
    globalData.rankPoints = profile.rankPoints || 0;
    globalData.rankName = profile.rankName || rank.getRankName(profile.rankPoints);
    globalData.uid = profile.uid || '';
    globalData.playerProfile = profile;
    if (profile.nickname) globalData.nickname = profile.nickname;
    if (profile.avatar) globalData.avatar = profile.avatar;
  } else {
    var openid = safeGet(KEY_OPENID, '') || '';
    profile = rank.createDefaultProfile(openid);
    safeSet(KEY_PROFILE, profile);
    globalData.rankPoints = 0;
    globalData.rankName = '棋童';
    globalData.uid = profile.uid;
    globalData.playerProfile = profile;
  }
  return profile;
}

function getPlayerProfile() {
  if (!globalData.playerProfile) initPlayerProfile();
  return globalData.playerProfile;
}

// 更新档案单个字段并持久化（支持 'stats.online.wins' 形式）
function updateProfileField(field, value) {
  var profile = globalData.playerProfile;
  if (!profile) return;
  if (field.indexOf('.') > -1) {
    var parts = field.split('.');
    var obj = profile;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!obj[parts[i]]) obj[parts[i]] = {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = value;
  } else {
    profile[field] = value;
  }
  safeSet(KEY_PROFILE, profile);
  if (field === 'rankPoints') globalData.rankPoints = value;
  if (field === 'rankName') globalData.rankName = value;
}

// 覆盖整份档案
function updatePlayerProfile(profile) {
  globalData.playerProfile = profile;
  globalData.rankPoints = profile.rankPoints || 0;
  globalData.rankName = profile.rankName || rank.getRankName(profile.rankPoints);
  globalData.uid = profile.uid || '';
  if (profile.nickname) globalData.nickname = profile.nickname;
  if (profile.avatar) globalData.avatar = profile.avatar;
  safeSet(KEY_PROFILE, profile);
}

// 更新昵称头像（授权后调用）
function updatePlayerInfo(userInfo) {
  if (!userInfo) return;
  globalData.nickname = userInfo.nickName || userInfo.nickname || globalData.nickname;
  globalData.avatar = userInfo.avatarUrl || userInfo.avatar || globalData.avatar;
  updateProfileField('nickname', globalData.nickname);
  updateProfileField('avatar', globalData.avatar);
}

function setOpenid(openid) {
  globalData.openid = openid;
  safeSet(KEY_OPENID, openid);
  updateProfileField('openid', openid);
}

// ===== 对局结算（段位 + 战绩） =====
// mode: 'ai' | 'online' | 'local'（与 rank.POINTS_CONFIG / profile.stats 的键一致）
// result: 'win' | 'lose'
// 返回 { profile, oldRank, newRank, promoted, pointsChange }
function applyGameResult(mode, result) {
  const profile = getPlayerProfile();
  const change = rank.applyPointsChange(profile.rankPoints || 0, mode, result);

  profile.rankPoints = change.newPoints;
  profile.rankName = change.newRank.name;
  if (profile.stats) rank.updateStats(profile.stats, mode, result);
  updatePlayerProfile(profile);

  return {
    profile: profile,
    oldRank: change.oldRank,
    newRank: change.newRank,
    promoted: change.promoted,
    pointsChange: change.pointsChange
  };
}

// ===== 设置 =====

const DEFAULT_SETTINGS = { boardSize: 15, sound: true, vibrate: true };

function getSettings() {
  const s = safeGet(KEY_SETTINGS, null) || {};
  return {
    boardSize: s.boardSize || DEFAULT_SETTINGS.boardSize,
    sound: s.sound !== false,
    vibrate: s.vibrate !== false
  };
}

function saveSettings(patch) {
  const merged = Object.assign(getSettings(), patch || {});
  safeSet(KEY_SETTINGS, merged);
  return merged;
}

// ===== 通用读写（对局记录等） =====

function get(key, fallback) { return safeGet(key, fallback); }
function set(key, value) { safeSet(key, value); }
function remove(key) {
  try { wx.removeStorageSync(key); } catch (e) { /* ignore */ }
}

module.exports = {
  globalData: globalData,
  KEY_PROFILE: KEY_PROFILE,
  KEY_SETTINGS: KEY_SETTINGS,
  initPlayerProfile: initPlayerProfile,
  getPlayerProfile: getPlayerProfile,
  updateProfileField: updateProfileField,
  updatePlayerProfile: updatePlayerProfile,
  updatePlayerInfo: updatePlayerInfo,
  setOpenid: setOpenid,
  applyGameResult: applyGameResult,
  getSettings: getSettings,
  saveSettings: saveSettings,
  get: get,
  set: set,
  remove: remove
};
