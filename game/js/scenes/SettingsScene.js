// js/scenes/SettingsScene.js
// 设置（取代 pages/settings）：默认棋盘尺寸 / 落子音效
// 存储键沿用 'settings'，与小程序版兼容。

const BaseScene = require('./BaseScene.js');
const ui = require('../render/ui.js');
const storage = require('../storage.js');
const sound = require('../sound.js');
const board_ = require('../board.js');

const SIZES = board_.BOARD_SIZES;

function SettingsScene(manager) {
  BaseScene.call(this, manager);
  this.settings = null;
}
SettingsScene.prototype = Object.create(BaseScene.prototype);
SettingsScene.prototype.constructor = SettingsScene;

SettingsScene.prototype.onEnter = function () {
  const vp = this.manager.viewport;
  const self = this;
  this.clearButtons();
  this.addBackButton(vp, function () { self.manager.pop(); });

  const raw = storage.get('settings', {}) || {};
  this.settings = storage.getSettings();
  this.settings.rankAffectsAI = !!raw.rankAffectsAI;
  sound.setEnabled(this.settings.sound);

  const pad = 20;
  const w = vp.width - pad * 2;
  let y = vp.top + 96;

  // 棋盘尺寸
  this.sizeButtons = [];
  const bw = (w - 20) / 3;
  for (let i = 0; i < SIZES.length; i++) {
    const btn = this.addButton({
      x: pad + i * (bw + 10), y: y, w: bw, h: 44,
      text: SIZES[i] + '×' + SIZES[i], radius: 10, size: 14,
      data: SIZES[i],
      onTap: function (b) {
        self.settings.boardSize = b.data;
        self.save();
      }
    });
    this.sizeButtons.push(btn);
  }

  y += 44 + 40;
  this.soundRowY = y;
  this.soundBtn = this.addButton({
    x: vp.width - pad - 56, y: y + 6, w: 56, h: 32, text: '', radius: 16,
    onTap: function () {
      self.settings.sound = !self.settings.sound;
      sound.setEnabled(self.settings.sound);
      self.save();
    }
  });
};

SettingsScene.prototype.save = function () {
  storage.saveSettings({
    boardSize: this.settings.boardSize,
    sound: this.settings.sound,
    rankAffectsAI: this.settings.rankAffectsAI
  });
};

SettingsScene.prototype.drawSwitchKnob = function (ctx, btn, on) {
  const knobX = on ? btn.x + btn.w - 15 : btn.x + 15;
  ui.fillCircle(ctx, knobX, btn.y + btn.h / 2, 12, '#FFFFFF');
};

SettingsScene.prototype.render = function (ctx, vp) {
  this.drawBackground(ctx, vp);
  ui.drawText(ctx, '设置', vp.width / 2, vp.top + 22, { size: 18, bold: true, align: 'center' });

  const pad = 20;
  ui.drawText(ctx, '默认棋盘尺寸', pad, vp.top + 74, { size: 14, bold: true, color: ui.COLORS.textSub });

  for (let i = 0; i < this.sizeButtons.length; i++) {
    const active = this.settings.boardSize === SIZES[i];
    this.sizeButtons[i].bg = active ? ui.COLORS.primary : '#FFFFFF';
    this.sizeButtons[i].color = active ? '#FFFFFF' : ui.COLORS.text;
    this.sizeButtons[i].border = active ? ui.COLORS.primaryDeep : ui.COLORS.panelBorder;
  }

  const rows = [
    { y: this.soundRowY, label: '落子音效', on: this.settings.sound, btn: this.soundBtn }
  ];
  for (let i = 0; i < rows.length; i++) {
    ui.drawPanel(ctx, pad, rows[i].y, vp.width - pad * 2, 44, 10);
    ui.drawText(ctx, rows[i].label, pad + 14, rows[i].y + 22, { size: 14 });
    rows[i].btn.bg = rows[i].on ? ui.COLORS.success : '#D8D0C0';
  }

  this.drawButtons(ctx);
  for (let i = 0; i < rows.length; i++) {
    this.drawSwitchKnob(ctx, rows[i].btn, rows[i].on);
  }
};

module.exports = function (manager) { return new SettingsScene(manager); };
