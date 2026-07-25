// turnWatcher — 思考时限超时扫描（定时触发器）
// 作为“系统随机落子”的权威兜底：当对局某一方超过 TURN_TIMEOUT_MS 未落子、
// 且客户端（双方）均已关闭时，由本定时任务代为执行系统随机落子。
// 活跃对局由客户端倒计时归零触发 gameSync.timeoutMove，本函数仅作补充。
const cloud = require('wx-server-sdk');
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});
const db = cloud.database();
const _ = db.command;

// 与 gameSync.TURN_TIMEOUT_MS 保持一致
const TURN_TIMEOUT_MS = 30000;
const BATCH = 100;

exports.main = async (event, context) => {
  const cutoff = new Date(Date.now() - TURN_TIMEOUT_MS);
  let processed = 0;
  let moved = 0;
  let skip = 0;

  while (true) {
    const res = await db.collection('games').where({
      status: 'playing',
      last_move_time: _.lt(cutoff)
    }).limit(BATCH).skip(skip).get();

    const list = (res && res.data) || [];
    if (list.length === 0) break;

    for (const g of list) {
      processed++;
      try {
        const r = await cloud.callFunction({
          name: 'gameSync',
          data: { $url: 'timeoutMove', gameId: g._id }
        });
        if (r && r.result && r.result.code === 200) moved++;
      } catch (e) {
        console.error('[turnWatcher] timeoutMove 失败 gameId=%s:', g._id, e);
      }
    }

    if (list.length < BATCH) break;
    skip += BATCH;
  }

  console.log('[turnWatcher] 扫描超时对局 processed=%d moved=%d', processed, moved);
  return { code: 200, processed, moved };
};
