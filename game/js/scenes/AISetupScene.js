// js/scenes/AISetupScene.js
// 人机对战设置（取代 pages/ai-setup）：选择难度与执子颜色

const BaseScene = require('./BaseScene.js');
const ui = require('../render/ui.js');
const board_ = require('../board.js');
const storage = require('../storage.js');

const DIFFICULTIES = [
  { key: 'easy',   name: '简单', desc: '随机落子，偶尔阻挡' },
  { key: 'normal', name: '普通', desc: '一步取胜与拦截' },
  { key: 'hard',   name: '困难', desc: '三层搜索 + 陷阱防守' },
  { key: 'master', name: '大师', desc: '四层搜索，全力应对' }
];

const COLORS_OPT = [
  { key: 'black', name: '执黑先行', player: board_.BLACK },
  { key: 'white', name: '执白后行', player: board_.WHITE }
];

function AISetupScene(manager) {
  BaseScene.call(this, manager);
  this.difficulty = 'normal';
  this.color = 'black';
}
AISetupScene.prototype = Object.create(BaseScene.prototype);
AISetupScene.prototype.constructor = AISetupScene;

AISetupScene.prototype.onEnter = function () {
  const vp = this.manager.viewport;
  const self = this;
  this.clearButtons();
  this.addBackButton(vp, function () { self.manager.pop(); });

  const pad = 24;
  const w = vp.width - pad * 2;
  let y = vp.top + 110;

  this.diffButtons = [];
  for (let i = 0; i < DIFFICULTIES.length; i++) {
    const d = DIFFICULTIES[i];
    const btn = this.addButton({
      x: pad, y: y + i * 62, w: w, h: 52, text: '',
      radius: 12, data: d,
      onTap: function (b) { self.difficulty = b.data.key; }
    });
    this.diffButtons.push(btn);
  }

  y = y + DIFFICULTIES.length * 62 + 52;
  this.colorButtons = [];
  for (let i = 0; i < COLORS_OPT.length; i++) {
    const cOpt = COLORS_OPT[i];
    const btn = this.addButton({
      x: pad + i * ((w - 12) / 2 + 12), y: y, w: (w - 12) / 2, h: 52, text: '',
      radius: 12, data: cOpt,
      onTap: function (b) { self.color = b.data.key; }
    });
    this.colorButtons.push(btn);
  }

  this.startY = y + 78;
  this.addButton({
    x: pad, y: this.startY, w: w, h: 52, text: '开始对局',
    bg: ui.COLORS.success, size: 18, radius: 14,
    onTap: function () {
      const settings = storage.getSettings();
      self.manager.push('game', {
        mode: 'ai',
        size: settings.boardSize,
        difficulty: self.difficulty,
        humanPlayer: self.color === 'white' ? board_.WHITE : board_.BLACK
      });
    }
  });
};

AISetupScene.prototype.render = function (ctx, vp) {
  this.drawBackground(ctx, vp);
  ui.drawText(ctx, '系统对战', vp.width / 2, vp.top + 22, {
    size: 18, bold: true, align: 'center'
  });

  ui.drawText(ctx, '选择难度', 24, vp.top + 86, { size: 14, color: ui.COLORS.textSub, bold: true });

  // 难度卡片
  for (let i = 0; i < this.diffButtons.length; i++) {
    const btn = this.diffButtons[i];
    const d = DIFFICULTIES[i];
    const active = this.difficulty === d.key;
    btn.bg = active ? ui.COLORS.primary : '#FFFFFF';
    btn.border = active ? ui.COLORS.primaryDeep : ui.COLORS.panelBorder;
  }
  const colorTitleY = this.colorButtons[0].y - 26;
  ui.drawText(ctx, '选择执子', 24, colorTitleY, { size: 14, color: ui.COLORS.textSub, bold: true });

  for (let i = 0; i < this.colorButtons.length; i++) {
    const btn = this.colorButtons[i];
    const active = this.color === COLORS_OPT[i].key;
    btn.bg = active ? ui.COLORS.primary : '#FFFFFF';
    btn.border = active ? ui.COLORS.primaryDeep : ui.COLORS.panelBorder;
  }

  this.drawButtons(ctx);

  // 卡片内文字
  for (let i = 0; i < this.diffButtons.length; i++) {
    const btn = this.diffButtons[i];
    const d = DIFFICULTIES[i];
    const active = this.difficulty === d.key;
    const fg = active ? '#FFFFFF' : ui.COLORS.text;
    const sub = active ? 'rgba(255,255,255,0.85)' : ui.COLORS.textSub;
    ui.drawText(ctx, d.name, btn.x + 18, btn.y + 18, { size: 16, bold: true, color: fg });
    ui.drawText(ctx, d.desc, btn.x + 18, btn.y + 37, { size: 12, color: sub });
  }
  for (let i = 0; i < this.colorButtons.length; i++) {
    const btn = this.colorButtons[i];
    const active = this.color === COLORS_OPT[i].key;
    const fg = active ? '#FFFFFF' : ui.COLORS.text;
    const cx = btn.x + 30;
    const cy = btn.y + btn.h / 2;
    ui.fillCircle(ctx, cx, cy, 12, COLORS_OPT[i].key === 'black' ? '#1a1a1a' : '#f5f5f5');
    if (COLORS_OPT[i].key === 'white') {
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, 12, 0, Math.PI * 2);
      ctx.stroke();
    }
    ui.drawText(ctx, COLORS_OPT[i].name, cx + 22, cy, { size: 14, bold: true, color: fg });
  }
};

module.exports = function (manager) { return new AISetupScene(manager); };
