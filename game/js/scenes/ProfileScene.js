// js/scenes/ProfileScene.js
// 我的资料（取代 pages/profile + pages/records）：段位、积分进度、三种模式战绩

const BaseScene = require('./BaseScene.js');
const ui = require('../render/ui.js');
const storage = require('../storage.js');
const rank = require('../rank.js');
const res = require('../ResourceManager.js');
const avatar = require('../avatar.js');

const MODES = [
  { key: 'online', label: '联网对战' },
  { key: 'ai', label: '系统对战' }
];

function ProfileScene(manager) {
  BaseScene.call(this, manager);
}
ProfileScene.prototype = Object.create(BaseScene.prototype);
ProfileScene.prototype.constructor = ProfileScene;

ProfileScene.prototype.onEnter = function () {
  const vp = this.manager.viewport;
  const self = this;
  this.clearButtons();
  this.addBackButton(vp, function () { self.manager.pop(); });
  this.profile = storage.getPlayerProfile();

  // 编辑状态
  this.keyboardOpen = false;
  this._nickDraft = '';

  // 若已设置过自定义头像（URL/路径），重新载入资源管理器，保证重启后仍显示
  if (this.profile && this.profile.avatar) this.applyAvatar(this.profile.avatar);

  // 头像 / 昵称的点击热区（与 render 中的资料卡布局一致）
  const pad = 20;
  const cardY = vp.top + 60;
  const cardW = vp.width - pad * 2;
  this._avatarRect = { x: pad + 12, y: cardY + 12, w: 72, h: 72 };
  this._nameRect = { x: pad + 82, y: cardY + 8, w: cardW - (pad + 82) - 12, h: 52 };
};

// 头像 / 昵称区域可点击编辑；其余点击交给基类（返回按钮等）
ProfileScene.prototype.onTouchEnd = function (x, y) {
  if (this._avatarRect && this.hitRect(this._avatarRect, x, y)) {
    this.editAvatar();
    return true;
  }
  if (this._nameRect && this.hitRect(this._nameRect, x, y)) {
    this.editNickname();
    return true;
  }
  return BaseScene.prototype.onTouchEnd.call(this, x, y);
};

ProfileScene.prototype.hitRect = function (r, x, y) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
};

// ===== 昵称编辑（小游戏键盘，复用 RoomScene 的交互模式）=====

ProfileScene.prototype.editNickname = function () {
  if (this.keyboardOpen || typeof wx.showKeyboard !== 'function') return;
  const self = this;
  this.keyboardOpen = true;
  const cur = (this.profile && this.profile.nickname) || '';
  this._nickDraft = cur;

  this._kbInput = function (res) { self._nickDraft = String(res.value || ''); };
  this._kbConfirm = function (res) {
    self._nickDraft = String(res.value || '');
    self.closeKeyboard();
    self.commitNickname(self._nickDraft);
  };
  this._kbComplete = function () { self.closeKeyboard(); };

  wx.onKeyboardInput(this._kbInput);
  wx.onKeyboardConfirm(this._kbConfirm);
  wx.onKeyboardComplete(this._kbComplete);
  wx.showKeyboard({ defaultValue: cur, maxLength: 12, multiple: false, confirmType: 'done' });
};

ProfileScene.prototype.closeKeyboard = function () {
  if (!this.keyboardOpen) return;
  this.keyboardOpen = false;
  try { wx.hideKeyboard({}); } catch (e) {}
  try {
    if (this._kbInput) wx.offKeyboardInput(this._kbInput);
    if (this._kbConfirm) wx.offKeyboardConfirm(this._kbConfirm);
    if (this._kbComplete) wx.offKeyboardComplete(this._kbComplete);
  } catch (e) {}
  this._kbInput = this._kbConfirm = this._kbComplete = null;
};

ProfileScene.prototype.commitNickname = function (raw) {
  const name = String(raw || '').trim().slice(0, 12);
  if (!name) { wx.showToast({ title: '昵称不能为空', icon: 'none' }); return; }
  storage.updateProfileField('nickname', name);
  this.profile = storage.getPlayerProfile();
  wx.showToast({ title: '已保存', icon: 'success' });
};

// ===== 头像编辑（从相册 / 拍照选择，上传云存储持久化）=====

ProfileScene.prototype.editAvatar = function () {
  const self = this;
  if (typeof wx.chooseImage !== 'function') {
    wx.showToast({ title: '当前基础库不支持选择图片', icon: 'none' });
    return;
  }
  wx.chooseImage({
    count: 1,
    sizeType: ['compressed', 'original'],
    sourceType: ['album', 'camera'],
    success: function (res) {
      const temp = (res.tempFilePaths && res.tempFilePaths[0]) ||
        (res.tempFiles && res.tempFiles[0] && res.tempFiles[0].path) || '';
      if (!temp) return;
      self.saveAvatar(temp);
    },
    fail: function () { wx.showToast({ title: '已取消选择', icon: 'none' }); }
  });
};

// 选图后：优先上传云存储得到持久 URL；失败则退化为临时路径（本机有效）
ProfileScene.prototype.saveAvatar = function (tempPath) {
  const self = this;
  wx.showLoading({ title: '保存中', mask: true });
  avatar.uploadAvatarToCloud(tempPath).then(function (url) {
    storage.updateProfileField('avatar', url);
    self.applyAvatar(url);
    self.profile = storage.getPlayerProfile();
    wx.hideLoading();
    wx.showToast({ title: '已保存', icon: 'success' });
  });
};

// 把微信头像 URL 重新载入资源管理器，使资料卡即时显示
ProfileScene.prototype.applyAvatar = function (url) {
  if (!url) return;
  res.loadImage('avatar', url).then(function () {}).catch(function () {});
};

ProfileScene.prototype.render = function (ctx, vp) {
  this.drawBackground(ctx, vp);
  ui.drawText(ctx, '我的资料', vp.width / 2, vp.top + 22, { size: 18, bold: true, align: 'center' });

  const p = this.profile || {};
  const points = p.rankPoints || 0;
  const info = rank.getRankByPoints(points);
  const pad = 20;
  const w = vp.width - pad * 2;

  // 资料卡
  let y = vp.top + 60;
  ui.drawPanel(ctx, pad, y, w, 116, 14);
  const avatar = res.getImage('avatar');
  if (avatar) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(pad + 46, y + 46, 28, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(avatar, pad + 18, y + 18, 56, 56);
    ctx.restore();
  } else {
    ui.fillCircle(ctx, pad + 46, y + 46, 28, ui.COLORS.bgDeep);
  }
  // 头像可编辑角标（铅笔）
  ui.fillCircle(ctx, pad + 68, y + 68, 11, ui.COLORS.primary);
  ui.drawText(ctx, '✎', pad + 68, y + 68, { size: 12, align: 'center', color: '#FFFFFF', bold: true });
  ui.drawText(ctx, p.nickname || '棋友', pad + 86, y + 32, { size: 17, bold: true });
  ui.drawText(ctx, 'UID ' + (p.uid || '------'), pad + 86, y + 54, {
    size: 12, color: ui.COLORS.textSub
  });
  ui.drawText(ctx, rank.getRankDisplay(points), pad + 86, y + 76, {
    size: 14, bold: true, color: rank.getTierColor(info.tier)
  });

  // 积分进度条
  const barX = pad + 18, barY = y + 98, barW = w - 36;
  ui.fillRoundRect(ctx, barX, barY, barW, 6, 3, '#E8E0D0');
  ui.fillRoundRect(ctx, barX, barY, Math.max(4, barW * info.progress), 6, 3, rank.getTierColor(info.tier));
  y += 128;
  ui.drawText(ctx, points + ' 分' + (info.nextRank ? '  距 ' + info.nextRank + ' 还差 ' + (info.nextRankPoints - points) + ' 分' : '  已达最高段位'),
    pad + 2, y, { size: 12, color: ui.COLORS.textSub });

  // 综合战绩（不含本地双人）—— 放大特写
  y += 22;
  const stats = p.stats || {};
  const onlineS = stats.online || { total: 0, wins: 0, losses: 0 };
  const aiS = stats.ai || { total: 0, wins: 0, losses: 0 };
  const totGames = (onlineS.total || 0) + (aiS.total || 0);
  const totWins = (onlineS.wins || 0) + (aiS.wins || 0);
  const totLosses = (onlineS.losses || 0) + (aiS.losses || 0);
  const totRate = totGames > 0 ? Math.round((totWins / totGames) * 100) : 0;

  const bigH = 162;
  const px = pad, py = y, pw = w;
  // 高亮面板：浅底 + 主色加粗描边，突出特写感
  ui.fillRoundRect(ctx, px, py, pw, bigH, 14, ui.COLORS.panel);
  ui.strokeRoundRect(ctx, px, py, pw, bigH, 14, ui.COLORS.primary, 2);

  // 标题
  ui.drawText(ctx, '综合战绩', px + 16, py + 28, { size: 16, bold: true });

  // 胜率（右上，放大）
  const rx = vp.width - pad - 16;
  ui.drawText(ctx, '胜率', rx, py + 22, { size: 12, align: 'right', color: ui.COLORS.textSub });
  ui.drawText(ctx, totRate + '%', rx, py + 54, { size: 30, align: 'right', bold: true, color: ui.COLORS.primary });

  // 三大数字：总场次 / 胜场 / 负场（放大）
  const cols = [
    { label: '总场次', value: totGames, color: ui.COLORS.text },
    { label: '胜场', value: totWins, color: ui.COLORS.success },
    { label: '负场', value: totLosses, color: ui.COLORS.danger }
  ];
  const colW = pw / 3;
  for (let i = 0; i < cols.length; i++) {
    const cx = px + colW * (i + 0.5);
    ui.drawText(ctx, String(cols[i].value), cx, py + 110, { size: 32, align: 'center', bold: true, color: cols[i].color });
    ui.drawText(ctx, cols[i].label, cx, py + 136, { size: 12, align: 'center', color: ui.COLORS.textSub });
  }

  y += bigH + 14;

  // 各模式战绩
  ui.drawText(ctx, '各模式战绩', pad, y + 4, { size: 13, bold: true, color: ui.COLORS.textSub });
  y += 18;
  for (let i = 0; i < MODES.length; i++) {
    const m = MODES[i];
    const s = stats[m.key] || { total: 0, wins: 0, losses: 0, bestStreak: 0 };
    const rate = s.total > 0 ? Math.round((s.wins / s.total) * 100) : 0;
    ui.drawPanel(ctx, pad, y, w, 68, 12);
    ui.drawText(ctx, m.label, pad + 14, y + 22, { size: 14, bold: true });
    ui.drawText(ctx, '胜率 ' + rate + '%', vp.width - pad - 14, y + 22, {
      size: 13, align: 'right', color: ui.COLORS.primary, bold: true
    });
    ui.drawText(ctx, '共 ' + s.total + ' 局 · 胜 ' + s.wins + ' · 负 ' + s.losses + ' · 最高连胜 ' + (s.bestStreak || 0),
      pad + 14, y + 48, { size: 12, color: ui.COLORS.textSub });
    y += 78;
  }

  // 编辑提示
  ui.drawText(ctx, '点击头像或昵称可修改', vp.width / 2, vp.height - vp.bottom - 16,
    { size: 12, align: 'center', color: ui.COLORS.textSub });

  this.drawButtons(ctx);
};

module.exports = function (manager) { return new ProfileScene(manager); };
