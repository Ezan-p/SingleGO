// js/scenes/SceneManager.js
// 场景（画面）管理器：取代小程序的 wx.navigateTo / navigateBack 页面栈。
// 每个场景实现 onEnter / onExit / update / render / onTouchStart / onTouchMove / onTouchEnd。

function SceneManager(ctx, viewport) {
  this.ctx = ctx;
  this.viewport = viewport;   // { width, height, top, bottom, dpr }
  this.factories = {};
  this.instances = {};
  this.stack = [];            // [{ name, params }]
  this.current = null;
}

SceneManager.prototype.register = function (name, factory) {
  this.factories[name] = factory;
  return this;
};

SceneManager.prototype._instance = function (name) {
  if (!this.instances[name]) {
    const factory = this.factories[name];
    if (!factory) throw new Error('未注册的场景: ' + name);
    this.instances[name] = factory(this);
  }
  return this.instances[name];
};

SceneManager.prototype._activate = function (name, params) {
  if (this.current && this.current.onExit) this.current.onExit();
  this.current = this._instance(name);
  this.currentName = name;
  if (this.current.onEnter) this.current.onEnter(params || {});
};

// 替换当前场景（清空栈，用于回主菜单）
SceneManager.prototype.replace = function (name, params) {
  this.stack = [{ name: name, params: params || {} }];
  this._activate(name, params);
};

// 压栈进入新场景
SceneManager.prototype.push = function (name, params) {
  this.stack.push({ name: name, params: params || {} });
  this._activate(name, params);
};

// 返回上一场景；栈底时返回 false（由调用方决定是否退出小游戏）
SceneManager.prototype.pop = function () {
  if (this.stack.length <= 1) return false;
  this.stack.pop();
  const top = this.stack[this.stack.length - 1];
  this._activate(top.name, top.params);
  return true;
};

SceneManager.prototype.update = function (dt) {
  if (this.current && this.current.update) this.current.update(dt);
};

SceneManager.prototype.render = function () {
  if (this.current && this.current.render) {
    this.current.render(this.ctx, this.viewport);
  }
};

SceneManager.prototype.onTouchStart = function (x, y) {
  if (this.current && this.current.onTouchStart) this.current.onTouchStart(x, y);
};

SceneManager.prototype.onTouchMove = function (x, y) {
  if (this.current && this.current.onTouchMove) this.current.onTouchMove(x, y);
};

SceneManager.prototype.onTouchEnd = function (x, y) {
  if (this.current && this.current.onTouchEnd) this.current.onTouchEnd(x, y);
};

SceneManager.prototype.onShow = function () {
  if (this.current && this.current.onShow) this.current.onShow();
};

SceneManager.prototype.onHide = function () {
  if (this.current && this.current.onHide) this.current.onHide();
};

module.exports = SceneManager;
