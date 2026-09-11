// 请求 ID 生成器 + 客户端防重
// 用于联网对战所有写操作的幂等控制

// 已发送请求 ID 缓存（防客户端重复发送）
const MAX_CACHE = 50;
const sentCache = [];

function pad(n, len) {
  const s = String(n);
  return s.length >= len ? s : '0'.repeat(len - s.length) + s;
}

// 生成唯一请求 ID：时间戳(base36) + 随机串
// 形如 "req_<base36时间>-<6位随机>"
function genRequestId() {
  const ts = Date.now().toString(36);
  let rand = '';
  for (let i = 0; i < 6; i++) {
    rand += Math.floor(Math.random() * 36).toString(36);
  }
  const id = 'req_' + ts + '-' + rand;
  // 加入缓存
  if (sentCache.indexOf(id) === -1) {
    sentCache.push(id);
    if (sentCache.length > MAX_CACHE) sentCache.shift();
  }
  return id;
}

// 检查请求 ID 是否已发送过（客户端去重）
function isAlreadySent(requestId) {
  return sentCache.indexOf(requestId) !== -1;
}

module.exports = {
  genRequestId,
  isAlreadySent
};
