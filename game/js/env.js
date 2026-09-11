// 云开发环境配置（小游戏版，等同小程序 envList.js）
const envList = [];
const isMac = false;
// 云开发环境 ID（云开发控制台 -> 设置 -> 环境ID）
// 留空时仅单机模式可用（本地双人 / 人机对战 / 残局闯关）。
// 与小程序版 miniprogram/envList.js 保持一致，确保云函数与数据库集合共用同一环境。
const envId = 'cloud1-d7gwqwpsgfd516d69';

module.exports = {
  envList: envList,
  isMac: isMac,
  envId: envId
};
