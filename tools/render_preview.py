#!/usr/bin/env python3
"""离线残局工具 · 第 3 步：渲染预览图

读取 miniprogram/puzzle-output/previews/<id>.json，渲染裁剪后残局棋盘 PNG：
  木色背景 + 网格线 + 星位 + 黑/白棋子 + 高亮推荐首手 + 主变序号。
输出 miniprogram/puzzle-output/previews/<id>.png。

与 build_levels.js 解耦：纯 Node 产出元数据后，可单独跑本脚本出图。
"""

import os
import json
import glob
import math
from PIL import Image, ImageDraw, ImageFont

ROOT = '/Users/ezan/WeChatProjects/miniprogram-1'
PREVIEW_DIR = os.path.join(ROOT, 'miniprogram', 'puzzle-output', 'previews')

# 尝试加载支持中文的系统字体；失败则用默认字体
CANDIDATE_FONTS = [
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
]
_font = None
for _fn in CANDIDATE_FONTS:
    if os.path.exists(_fn):
        try:
            _font = ImageFont.truetype(_fn, 16)
            break
        except Exception:
            pass

CELL = 44
MARGIN = 26
LINE_W = 2
STONE_R = int(CELL * 0.42)
WOOD = (217, 179, 138)
WOOD_LINE = (120, 84, 50)
BLACK_STONE = (28, 28, 30)
WHITE_STONE = (245, 245, 245)
HILITE = (220, 60, 60)
TXT = (40, 30, 20)


def _draw_text(draw, xy, text, fill, font=None):
    if font is None:
        font = _font if _font else ImageFont.load_default()
    draw.text(xy, text, fill=fill, font=font)


def draw_board(d, out_path):
    size = d['boardSize']
    board = d['board']
    img_w = MARGIN * 2 + CELL * (size - 1)
    img_h = img_w + 34  # 底部留白写说明
    img = Image.new('RGB', (img_w, img_h), WOOD)
    draw = ImageDraw.Draw(img)

    # 网格线
    def px(i):
        return MARGIN + i * CELL
    for i in range(size):
        draw.line([(px(0), px(i)), (px(size - 1), px(i))], fill=WOOD_LINE, width=LINE_W)
        draw.line([(px(i), px(0)), (px(i), px(size - 1))], fill=WOOD_LINE, width=LINE_W)

    # 星位（仅 15 路标准 3-3-3；其余尺寸按中心近似）
    if size == 15:
        star = [3, 7, 11]
    elif size >= 7:
        star = [size // 2]
        if size >= 9:
            star = [size // 4, size // 2, size - 1 - size // 4]
    else:
        star = [size // 2]
    for r in star:
        for c in star:
            draw.ellipse([px(c) - 3, px(r) - 3, px(c) + 3, px(r) + 3], fill=WOOD_LINE)

    # 棋子
    def draw_stone(r, c, color):
        x, y = px(c), px(r)
        fill = BLACK_STONE if color == 1 else WHITE_STONE
        outline = (10, 10, 10) if color == 2 else (60, 60, 60)
        bbox = [x - STONE_R, y - STONE_R, x + STONE_R, y + STONE_R]
        draw.ellipse(bbox, fill=fill, outline=outline, width=1)
        # 高光
        hr = int(STONE_R * 0.45)
        draw.ellipse([x - hr, y - hr - 2, x + hr, y + hr - 2], fill=(255, 255, 255, 60))

    for r in range(size):
        for c in range(size):
            if board[r][c] in (1, 2):
                draw_stone(r, c, board[r][c])

    # 主变序号
    pv = d.get('principalVariation') or []
    for idx, mv in enumerate(pv):
        x, y = px(mv['c']), px(mv['r'])
        draw.ellipse([x - 9, y - 9, x + 9, y + 9], outline=HILITE, width=2)
        _draw_text(draw, (x - 4, y - 7), str(idx + 1), HILITE)

    # 推荐首手（实心红圈）
    rf = d.get('recommendedFirstMove')
    if rf:
        x, y = px(rf['c']), px(rf['r'])
        draw.ellipse([x - 11, y - 11, x + 11, y + 11], outline=HILITE, width=3)

    # 说明文字
    pc = '黑' if d.get('playerColor') == 1 else '白'
    diff = d.get('difficulty', '')
    steps = d.get('estimatedWinSteps', 0)
    caption = '残局 #%s  %s先手  难度:%s  制胜:%d步  来源:%s' % (
        d.get('id'), pc, diff, steps, os.path.basename(d.get('sourceImage', '')))
    _draw_text(draw, (MARGIN, img_w - MARGIN + 8), caption, TXT)

    img.save(out_path)


def main():
    files = sorted(glob.glob(os.path.join(PREVIEW_DIR, 'level_*.json')))
    if not files:
        print('未发现预览元数据 (previews/level_*.json)。请先运行 build_levels.js。')
        return
    count = 0
    for f in files:
        try:
            d = json.load(open(f, 'r', encoding='utf-8'))
            out = f[:-5] + '.png'
            draw_board(d, out)
            count += 1
        except Exception as e:
            print('渲染失败 %s: %s' % (f, e))
    print('已渲染 %d 张预览 PNG → %s' % (count, PREVIEW_DIR))


if __name__ == '__main__':
    main()
