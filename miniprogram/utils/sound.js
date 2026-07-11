// utils/sound.js
// 落子音效：棋子落在棋盘上的“咔嗒”声。
// 使用微信内置音频播放（本地 wav 资源），每次落子调用 playStone()。

const SOUND_SRC = '/audio/stone.wav';

let enabled = true;

/**
 * 播放落子音效。
 * 每次新建一个 InnerAudioContext 并在播放结束后销毁，
 * 避免同一 context 重复 play 的兼容问题。
 */
function playStone() {
  if (!enabled) return;
  if (typeof wx === 'undefined' || !wx.createInnerAudioContext) return;
  try {
    const ctx = wx.createInnerAudioContext();
    ctx.src = SOUND_SRC;
    ctx.onError(function () { ctx.destroy(); });
    ctx.onEnded(function () { ctx.destroy(); });
    ctx.play();
  } catch (e) {
    // 忽略音频不可用的情况，不影响落子逻辑
  }
}

function setEnabled(v) { enabled = !!v; }
function isEnabled() { return enabled; }

module.exports = {
  playStone: playStone,
  setEnabled: setEnabled,
  isEnabled: isEnabled
};
