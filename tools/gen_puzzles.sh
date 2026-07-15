#!/usr/bin/env bash
# 离线残局工具 · 总入口（直接用法：完整对局截图 = 残局）
# 依次：识别图片 → 生成残局关卡(100关)
#
# 用法说明：直接把每张完整对局截图识别出的 15×15 全盘，
# 作为一关残局应用进闯关模式。不裁剪、不重平衡、不强制黑白相等，
# 仅跳过“已终局/已分胜负”的图，并对“玩家(黑)一步即胜”的
# 平凡盘面做降权（优先选非一步胜的）。
#
# 难度（AI 等级）按盘面复杂度四分位分 easy/normal/hard/master。
#
# 环境变量：
#   TARGET   目标关卡数（默认 100）
set -e

cd "$(dirname "$0")/.."

echo "============================================"
echo "步骤 1/2  图片识别 (recognize.py)"
echo "============================================"
python3 tools/recognize.py

echo
echo "============================================"
echo "步骤 2/2  生成残局关卡 (generate-fulllevels.js)"
echo "============================================"
node tools/generate-fulllevels.js

echo
echo "完成。产物位于 miniprogram/puzzle-output/（levels.json / manifest.json / puzzles/）"
