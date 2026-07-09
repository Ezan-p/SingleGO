Page({
  data: {
    difficulties: [
      { key: 'easy', name: '简单', desc: '适合新手，随机为主，约30%胜率' },
      { key: 'normal', name: '普通', desc: '能发现一步胜机，偶尔失误，约50%胜率' },
      { key: 'hard', name: '困难', desc: '主动围子与破坏，规避判负，约70%胜率' },
      { key: 'master', name: '大师', desc: '深度搜索，极少失误，90%以上胜率' }
    ],
    selectedDifficulty: 'normal',
    selectedColor: 'black', // black=玩家执黑(先手), white=玩家执白(后手)
    difficultyIndex: 1
  },

  onSelectDifficulty: function (e) {
    const idx = parseInt(e.currentTarget.dataset.idx, 10);
    this.setData({
      difficultyIndex: idx,
      selectedDifficulty: this.data.difficulties[idx].key
    });
  },

  onSelectColor: function (e) {
    const color = e.currentTarget.dataset.color;
    this.setData({ selectedColor: color });
  },

  onStart: function () {
    const diff = this.data.selectedDifficulty;
    const color = this.data.selectedColor;
    wx.navigateTo({
      url: '/pages/game-ai/game-ai?difficulty=' + diff + '&color=' + color
    });
  },

  onBack: function () {
    wx.navigateBack();
  }
});
