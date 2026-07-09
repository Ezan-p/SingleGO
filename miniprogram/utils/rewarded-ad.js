// utils/rewarded-ad.js
// 激励视频广告模块

/**
 * 激励视频广告管理器
 * 当前使用模拟弹窗，显示3秒后自动关闭
 * 正式上线前替换为真实激励视频广告
 */
const RewardedAdManager = {
  // 是否使用模拟广告（正式上线前设为 false）
  _useMock: true,

  // 模拟广告持续时间（毫秒）
  _mockDuration: 3000,

  // 广告实例（真实广告时使用）
  _adInstance: null,

  // 广告单元 ID（需要在微信小程序后台申请）
  _adUnitId: 'adunit-xxxxxxxxxxxxxxxx',

  /**
   * 初始化广告实例
   * @returns {boolean} 是否成功
   */
  init: function() {
    if (this._useMock) {
      console.log('[rewarded-ad] 使用模拟广告模式');
      return true;
    }

    // 真实广告初始化
    if (!wx.createRewardedVideoAd) {
      console.warn('[rewarded-ad] 当前环境不支持激励视频广告');
      return false;
    }

    if (this._adInstance) {
      return true;
    }

    try {
      this._adInstance = wx.createRewardedVideoAd({
        adUnitId: this._adUnitId
      });

      this._adInstance.onLoad(() => {
        console.log('[rewarded-ad] 广告加载成功');
      });

      this._adInstance.onError((err) => {
        console.error('[rewarded-ad] 广告加载失败:', err);
      });

      this._adInstance.onClose((res) => {
        if (res && res.isEnded) {
          console.log('[rewarded-ad] 用户完整观看广告');
        } else {
          console.log('[rewarded-ad] 用户未完整观看广告');
        }
      });

      return true;
    } catch (err) {
      console.error('[rewarded-ad] 创建广告实例失败:', err);
      return false;
    }
  },

  /**
   * 显示激励视频广告
   * @param {Object} page - 页面实例，用于操作页面数据
   * @returns {Promise} 返回 Promise，完整观看则 resolve，否则 reject
   */
  show: function(page) {
    return new Promise((resolve, reject) => {
      // 模拟广告模式
      if (this._useMock) {
        console.log('[rewarded-ad] 显示模拟广告弹窗');

        // 设置页面数据，显示模拟广告弹窗
        if (page && page.setData) {
          page.setData({ showMockAd: true });
        }

        // 3秒后自动关闭，视为完整观看
        setTimeout(() => {
          if (page && page.setData) {
            page.setData({ showMockAd: false });
          }
          console.log('[rewarded-ad] 模拟广告播放完成');
          resolve({ completed: true });
        }, this._mockDuration);

        return;
      }

      // 真实广告模式
      if (!this._adInstance) {
        const inited = this.init();
        if (!inited) {
          reject({ type: 'not_supported', message: '当前环境不支持激励视频广告' });
          return;
        }
      }

      this._adInstance.load()
        .then(() => this._adInstance.show())
        .then(() => {
          console.log('[rewarded-ad] 广告开始播放');
        })
        .catch((err) => {
          console.error('[rewarded-ad] 显示广告失败:', err);
          this._adInstance.load()
            .then(() => this._adInstance.show())
            .catch((err2) => {
              reject({ type: 'show_error', error: err2 });
            });
        });
    });
  },

  /**
   * 检查广告是否可用
   * @returns {boolean} 是否可用
   */
  isAvailable: function() {
    return this._useMock || !!wx.createRewardedVideoAd;
  }
};

module.exports = RewardedAdManager;
