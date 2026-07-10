// 最近战绩
const onlineMatch = require('../../utils/online-match.js');

const REASON_MAP = {
  surround: '围子获胜',
  self_surround: '自包围判负',
  two_rows: '连续两排判负',
  resign: '认输',
  disconnect: '对手掉线',
  timeout: '超时判负'
};

Page({
  data: {
    games: [],
    loading: true
  },

  onLoad: function () {
    this.loadRecords();
  },

  loadRecords: function () {
    this.setData({ loading: true });
    onlineMatch.getRecentGames().then((res) => {
      if (res.result && res.result.code === 200 && res.result.data) {
        const list = (res.result.data.games || []).map((g) => {
          return Object.assign({}, g, {
            reasonText: REASON_MAP[g.reason] || g.reason || '对局结束',
            timeText: this.formatTime(g.timestamp)
          });
        });
        this.setData({ games: list, loading: false });
      } else {
        this.setData({ games: [], loading: false });
      }
    }).catch((err) => {
      console.error('加载战绩失败', err);
      this.setData({ games: [], loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    });
  },

  formatTime: function (ts) {
    if (!ts) return '';
    let t;
    try {
      t = ts instanceof Date ? ts : new Date(ts);
    } catch (e) {
      return '';
    }
    if (isNaN(t.getTime())) return '';
    const now = Date.now();
    const diff = now - t.getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
    if (diff < 86400000 * 7) return Math.floor(diff / 86400000) + '天前';
    const m = (t.getMonth() + 1);
    const d = t.getDate();
    return (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
  }
});
