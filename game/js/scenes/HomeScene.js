// js/scenes/HomeScene.js
// 主菜单（取代 pages/index）：本地双人 / 好友对战 / 联网对战 / 系统对战 / 残局闯关 / 规则说明 / 设置

const BaseScene = require('./BaseScene.js');
const ui = require('../render/ui.js');
const storage = require('../storage.js');
const rank = require('../rank.js');
const network = require('../network.js');
const res = require('../ResourceManager.js');

const MENU = [
  { key: 'local',     text: '本地双人', desc: '同一设备两人对弈', bg: '#C8923C' },
  { key: 'ai',        text: '系统对战', desc: '四档 AI 难度挑战',  bg: '#4CAF50' },
  { key: 'online',    text: '联网对战', desc: '在线匹配真人对手',  bg: '#1E88E5' },
  { key: 'room',      text: '好友对战', desc: '房间号邀请好友',    bg: '#8B5A2B' },
  { key: 'challenge', text: '残局闯关', desc: '100 关真实残局',    bg: '#E53935' },
  { key: 'rules',     text: '规则说明', desc: '十条胜负规则',      bg: '#8B7355' }
];

function HomeScene(manager) {
  BaseScene.call(this, manager);
  this._netStatus = { connected: true, type: 'unknown' };
  this._unsubscribe = null;
}
HomeScene.prototype = Object.create(BaseScene.prototype);
HomeScene.prototype.constructor = HomeScene;

HomeScene.prototype.onEnter = function () {
  const vp = this.manager.viewport;
  const self = this;
  this.clearButtons();

  const pad = 24;
  const w = vp.width - pad * 2;
  const startY = vp.top + 200;
  const gap = 12;
  const h = Math.min(64, (vp.height - startY - vp.bottom - 70 - gap * MENU.length) / MENU.length + gap - gap);

  for (let i = 0; i < MENU.length; i++) {
    const item = MENU[i];
    this.addButton({
      x: pad,
      y: startY + i * (h + gap),
      w: w,
      h: h,
      text: '',
      bg: item.bg,
      radius: 14,
      data: item,
      onTap: function (btn) { self.onMenu(btn.data.key); }
    });
  }

  // 底部：我的资料 / 设置
  const bottomY = vp.height - vp.bottom - 56;
  this.addButton({
    x: pad, y: bottomY, w: (w - 12) / 2, h: 44, text: '我的资料',
    bg: '#FFFFFF', color: ui.COLORS.text, border: ui.COLORS.panelBorder, radius: 12,
    onTap: function () { self.manager.push('profile'); }
  });
  this.addButton({
    x: pad + (w - 12) / 2 + 12, y: bottomY, w: (w - 12) / 2, h: 44, text: '设置',
    bg: '#FFFFFF', color: ui.COLORS.text, border: ui.COLORS.panelBorder, radius: 12,
    onTap: function () { self.manager.push('settings'); }
  });

  this._unsubscribe = network.onNetworkChange(function (s) { self._netStatus = s; });
};

HomeScene.prototype.onExit = function () {
  if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
};

HomeScene.prototype.onMenu = function (key) {
  const m = this.manager;
  switch (key) {
    case 'local':
      m.push('game', { mode: 'local' });
      break;
    case 'ai':
      m.push('ai-setup');
      break;
    case 'online':
      if (!storage.globalData.cloudInited) {
        wx.showToast({ title: '云开发未配置，联网不可用', icon: 'none', duration: 1800 });
        return;
      }
      if (!this._netStatus.connected) {
        wx.showToast({ title: '当前无网络连接', icon: 'none', duration: 1500 });
        return;
      }
      m.push('match');
      break;
    case 'room':
      if (!storage.globalData.cloudInited) {
        wx.showToast({ title: '云开发未配置，好友对战不可用', icon: 'none', duration: 1800 });
        return;
      }
      m.push('room');
      break;
    case 'challenge':
      m.push('challenge');
      break;
    case 'rules':
      m.push('rules');
      break;
  }
};

HomeScene.prototype.render = function (ctx, vp) {
  this.drawBackground(ctx, vp);

  const g = storage.globalData;
  const points = g.rankPoints || 0;
  const rankInfo = rank.getRankByPoints(points);

  // 顶部段位条
  const barY = vp.top + 8;
  ui.drawPanel(ctx, 16, barY, vp.width - 32, 48, 24);
  const avatar = res.getImage('avatar');
  if (avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(16 + 28, barY + 24, 16, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(avatar, 16 + 12, barY + 8, 32, 32);
    ctx.restore();
  } else {
    ui.fillCircle(ctx, 16 + 28, barY + 24, 16, ui.COLORS.bgDeep);
  }
  ui.drawText(ctx, g.nickname || '棋友', 16 + 54, barY + 17, { size: 14, bold: true });
  ui.drawText(ctx, rankInfo.name + ' · ' + points + '分', 16 + 54, barY + 34, {
    size: 12, color: rank.getTierColor(rankInfo.tier)
  });
  ui.drawText(ctx, this._netStatus.connected ? '● 在线' : '● 离线',
    vp.width - 32, barY + 24, {
      size: 12, align: 'right',
      color: this._netStatus.connected ? ui.COLORS.success : ui.COLORS.danger
    });

  // 标题
  ui.drawText(ctx, '单围棋', vp.width / 2, vp.top + 110, {
    size: 40, bold: true, align: 'center', color: ui.COLORS.primaryDeep
  });
  ui.drawText(ctx, '双人原创棋类游戏', vp.width / 2, vp.top + 148, {
    size: 14, align: 'center', color: ui.COLORS.textSub
  });

  // 菜单按钮（自绘文字：主标题 + 副标题）
  this.drawButtons(ctx);
  for (let i = 0; i < MENU.length; i++) {
    const btn = this.buttons[i];
    ui.drawText(ctx, MENU[i].text, btn.x + 20, btn.y + btn.h / 2 - 9, {
      size: 18, bold: true, color: '#FFFFFF'
    });
    ui.drawText(ctx, MENU[i].desc, btn.x + 20, btn.y + btn.h / 2 + 12, {
      size: 12, color: 'rgba(255,255,255,0.85)'
    });
    ui.drawText(ctx, '›', btn.x + btn.w - 22, btn.y + btn.h / 2, {
      size: 22, color: 'rgba(255,255,255,0.9)', align: 'center'
    });
  }
};

module.exports = function (manager) { return new HomeScene(manager); };
