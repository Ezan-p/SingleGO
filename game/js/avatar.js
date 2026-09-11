// js/avatar.js
// 头像上传与微信资料同步（小游戏版），供「资料页」与「登录页」共用。
// 取代原先仅存在于 ProfileScene 内的本地实现，避免重复。

const storage = require('./storage.js');
const res = require('./ResourceManager.js');
const network = require('./network.js');

// 上传本地临时文件到云存储，返回可用 URL（云文件临时 URL 或原始路径）
function uploadAvatarToCloud(tempPath) {
  return new Promise(function (resolve) {
    if (!tempPath) { resolve(''); return; }
    if (typeof wx.cloud === 'undefined' || !wx.cloud.uploadFile) { resolve(tempPath); return; }
    const ext = (String(tempPath).split('.').pop() || 'png').split('?')[0];
    const uid = storage.globalData.openid || storage.globalData.uid || Date.now();
    const cloudPath = 'avatars/' + uid + '_' + Date.now() + '.' + ext;
    wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: tempPath }).then(function (up) {
      const fileID = up && up.fileID;
      if (!fileID) { resolve(tempPath); return; }
      if (typeof wx.cloud.getTempFileURL !== 'function') { resolve(fileID); return; }
      wx.cloud.getTempFileURL({ fileList: [fileID] }).then(function (r) {
        const item = r && r.fileList && r.fileList[0];
        const url = (item && (item.tempFileURL || item.fileID)) || fileID;
        resolve(url);
      }).catch(function () { resolve(fileID); });
    }).catch(function () { resolve(tempPath); });
  });
}

// 从微信头像远程 URL 下载并转存到云存储，返回持久 URL（失败返回 ''）
function fetchWechatAvatar(avatarUrl) {
  return new Promise(function (resolve) {
    if (!avatarUrl || typeof wx.downloadFile !== 'function') { resolve(''); return; }
    wx.downloadFile({
      url: avatarUrl,
      success: function (r) {
        if (r && r.statusCode === 200 && r.tempFilePath) {
          uploadAvatarToCloud(r.tempFilePath).then(resolve).catch(function () { resolve(''); });
        } else { resolve(''); }
      },
      fail: function () { resolve(''); }
    });
  });
}

// 用微信 userInfo 更新本地档案昵称/头像，并同步到云端 players 集合
function applyWechatUserInfo(userInfo) {
  const nickname = (userInfo && userInfo.nickName) || '';
  const avatarUrl = (userInfo && userInfo.avatarUrl) || '';
  return fetchWechatAvatar(avatarUrl).then(function (url) {
    const finalAvatar = url || avatarUrl; // 上传失败则退化为原始微信头像 URL
    if (nickname) storage.updateProfileField('nickname', nickname);
    if (finalAvatar) storage.updateProfileField('avatar', finalAvatar);
    if (finalAvatar) {
      res.loadImage('avatar', finalAvatar).then(function () {}).catch(function () {});
    }
    const profile = storage.getPlayerProfile();
    return network.updatePlayerInfo({
      openid: storage.globalData.openid,
      nickname: profile.nickname || nickname,
      avatar: profile.avatar || finalAvatar
    }).then(function () {
      return { nickname: profile.nickname, avatar: profile.avatar };
    }).catch(function () {
      return { nickname: profile.nickname, avatar: profile.avatar };
    });
  });
}

module.exports = { uploadAvatarToCloud, fetchWechatAvatar, applyWechatUserInfo };
