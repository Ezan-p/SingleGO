#!/usr/bin/env python3
"""离线残局工具 · 第 1 步：图片识别

读取 puzzle-source 下的完整对局截图（递归、忽略隐藏/临时/非图片），
检测棋盘四外边界 → 直接映射标准 15×15 网格（截图正视、无透视畸变，
故不做透视校正；如未来出现倾斜截图再引入 cv2 单应矩阵）。

对每个交叉点分类：
  0 = 空 (EMPTY)   1 = 黑 (BLACK)   2 = 白 (WHITE)   -1 = 不确定 (需人工校对)
并记录置信度。置信度低于阈值(默认 0.5) 的交点置为 -1，记入 unknownPoints，
绝不猜测颜色。

逐图输出到 miniprogram/puzzle-output/recognized/game_NNN.json。

本脚本不修改任何小程序业务代码，仅在开发期运行。
"""

import os
import json
import math
import numpy as np
from PIL import Image

# ===== 路径配置 =====
ROOT = '/Users/ezan/WeChatProjects/miniprogram-1'
CANDIDATE_IMAGE_DIRS = [
    os.path.join(ROOT, 'miniprogram', 'puzzle-source', 'image'),
    os.path.join(ROOT, 'miniprogram', 'puzzle-source', 'images'),
]
OUT_DIR = os.path.join(ROOT, 'miniprogram', 'puzzle-output', 'recognized')
CONF_THRESHOLD = 0.5          # 低于此置信度的交点记为 -1
BOARD_CONF_GATE = 0.6         # 棋盘区域检测最低可信度
GRID_CONF_GATE = 0.5          # 网格检测最低可信度
EXPECTED_LINES = 15

IMAGE_EXTS = {'.png', '.jpg', '.jpeg'}
EMPTY, BLACK, WHITE, UNKNOWN = 0, 1, 2, -1


# ============================================================
#  复用的检测工具（同 analyze_puzzle_images.py，已验证有效）
# ============================================================

def rgb_to_hsv(rgb):
    rgb = rgb.astype(np.float32) / 255.0
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    df = mx - mn
    h = np.zeros_like(mx)
    mask = df != 0
    r_m = (r == mx) & mask
    g_m = (g == mx) & mask
    b_m = (b == mx) & mask
    h[r_m] = (60 * ((g[r_m] - b[r_m]) / df[r_m]) + 360) % 360
    h[g_m] = (60 * ((b[g_m] - r[g_m]) / df[g_m]) + 120) % 360
    h[b_m] = (60 * ((r[b_m] - g[b_m]) / df[b_m]) + 240) % 360
    s = np.zeros_like(mx)
    s[mx != 0] = df[mx != 0] / mx[mx != 0]
    return h, s, mx


def find_best_run(density, mask_sum, threshold=0.05):
    active = density > threshold
    runs = []
    start = None
    for i, val in enumerate(active):
        if val and start is None:
            start = i
        elif not val and start is not None:
            runs.append((start, i - 1))
            start = None
    if start is not None:
        runs.append((start, len(active) - 1))
    if not runs:
        return None
    return max(runs, key=lambda r: mask_sum[r[0]:r[1] + 1].sum())


def detect_board_region(arr):
    """检测棋盘区域（tan/木色掩码）。返回 {x,y,width,height,confidence} 或 None。"""
    h, s, v = rgb_to_hsv(arr)
    mask = (
        (h >= 25) & (h <= 50) &
        (s >= 0.40) & (s <= 0.70) &
        (v >= 0.40) & (v <= 1.0)
    )
    h_img, w_img = arr.shape[:2]
    row_density = mask.sum(axis=1) / w_img
    col_density = mask.sum(axis=0) / h_img
    window = 21
    smoothed_row = np.convolve(row_density, np.ones(window) / window, mode='same')
    smoothed_col = np.convolve(col_density, np.ones(window) / window, mode='same')
    row_run = find_best_run(smoothed_row, mask.sum(axis=1))
    col_run = find_best_run(smoothed_col, mask.sum(axis=0))
    if row_run is None or col_run is None:
        return None
    y, y2 = row_run
    x, x2 = col_run
    width = x2 - x + 1
    height = y2 - y + 1
    aspect_ratio = max(width, height) / max(min(width, height), 1)
    if aspect_ratio > 1.3:
        return None
    if width < w_img * 0.60 or height < h_img * 0.25:
        return None
    region_mask = mask[y:y2 + 1, x:x2 + 1]
    fill_ratio = region_mask.sum() / (width * height)
    confidence = float(min(fill_ratio, 1.0))
    return {
        'x': int(x), 'y': int(y),
        'width': int(width), 'height': int(height),
        'confidence': round(confidence, 3),
    }


def find_regular_peaks(signal, n, expected_spacing, step=1.0):
    """在 1D 信号中找最佳 n 个等距峰。"""
    best_score = -1
    best_positions = None
    spacing_min = max(expected_spacing * 0.85, 1.0)
    spacing_max = expected_spacing * 1.15
    for spacing in np.arange(spacing_min, spacing_max, step):
        for offset in np.arange(0, spacing, step):
            positions = [int(round(offset + i * spacing)) for i in range(n)]
            if positions[-1] >= len(signal):
                continue
            score = sum(signal[p] for p in positions)
            if len(positions) > 1:
                spacings = np.diff(positions)
                regularity = 1.0 - np.std(spacings) / max(np.mean(spacings), 1e-6)
                score *= max(0.0, regularity)
            if positions[0] < 5 or positions[-1] > len(signal) - 5:
                score *= 0.9
            if score > best_score:
                best_score = score
                best_positions = positions
    return best_positions


def detect_grid_lines(board_gray, expected_lines=EXPECTED_LINES):
    """检测棋盘内部网格线位置（相对 board_rgb）。"""
    gx = np.abs(board_gray[:, 1:] - board_gray[:, :-1])
    gy = np.abs(board_gray[1:, :] - board_gray[:-1, :])
    h_grad = np.zeros(board_gray.shape[0])
    h_grad[1:-1] = (gy[:-1, :].sum(axis=1) + gy[1:, :].sum(axis=1)) / 2
    v_grad = np.zeros(board_gray.shape[1])
    v_grad[1:-1] = (gx[:, :-1].sum(axis=0) + gx[:, 1:].sum(axis=0)) / 2
    h_grad = np.convolve(h_grad, np.ones(3) / 3, mode='same')
    v_grad = np.convolve(v_grad, np.ones(3) / 3, mode='same')
    h = board_gray.shape[0]
    w = board_gray.shape[1]
    expected_h_spacing = h / (expected_lines - 1)
    expected_w_spacing = w / (expected_lines - 1)
    h_peaks = find_regular_peaks(h_grad, expected_lines, expected_h_spacing, step=1.0)
    v_peaks = find_regular_peaks(v_grad, expected_lines, expected_w_spacing, step=1.0)
    rows = len(h_peaks) if h_peaks else 0
    cols = len(v_peaks) if v_peaks else 0
    confidence = 0.0
    if rows >= 2 and cols >= 2:
        h_spacings = np.diff(h_peaks)
        v_spacings = np.diff(v_peaks)
        h_reg = 1.0 - (float(np.std(h_spacings)) / max(float(np.mean(h_spacings)), 1e-6))
        v_reg = 1.0 - (float(np.std(v_spacings)) / max(float(np.mean(v_spacings)), 1e-6))
        confidence = (max(0.0, min(1.0, h_reg)) + max(0.0, min(1.0, v_reg))) / 2.0
    return {
        'rows': rows, 'cols': cols,
        'horizontalLines': h_peaks, 'verticalLines': v_peaks,
        'confidence': round(confidence, 3),
    }


# ============================================================
#  交叉点分类（关键改进：明确区分空 / 黑 / 白 / 不确定）
# ============================================================

def classify_cell(rgb, cy, cx, r_in, r_out):
    """返回 (label, confidence)。

    环形采样（避开交叉点正中的网格线）更稳健。真实亮度区间：
      黑子盘面实心暗圆 ≈ 0.23，白子 ≈ 0.93，木色空点 ≈ 0.61~0.78。
    故阈值留足间隔：BLACK<0.45 / WHITE>0.82 / 其余为空。
      - 环内 std 偏高：边缘空点可能是外框线导致（mean 仍在空区间）→ 判空；
        否则（亮度像棋子却杂乱）→ 不确定(-1)。
    绝不猜测：置信度不足一律 -1。
    """
    H, W = rgb.shape[0], rgb.shape[1]
    ry0 = max(0, int(cy - r_out)); ry1 = min(H, int(cy + r_out) + 1)
    rx0 = max(0, int(cx - r_out)); rx1 = min(W, int(cx + r_out) + 1)
    if ry1 <= ry0 or rx1 <= rx0:
        return UNKNOWN, 0.0
    yy, xx = np.mgrid[ry0:ry1, rx0:rx1]
    dist = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
    mask = (dist >= r_in) & (dist <= r_out)
    local = rgb[ry0:ry1, rx0:rx1]
    patch = local[mask]
    if patch.shape[0] == 0:
        return UNKNOWN, 0.0
    gray = patch.mean(axis=1)
    mean = float(gray.mean()) / 255.0
    std = float(gray.std()) / 255.0

    if std >= 0.22:
        # 边缘空点的外框线会把 std 抬高，但亮度仍在空区间 → 仍判空
        if 0.45 <= mean <= 0.82:
            return EMPTY, 0.6
        return UNKNOWN, 0.0

    if mean < 0.45:                       # 黑子
        conf = (0.45 - mean) / 0.30
        return BLACK, max(0.0, min(1.0, conf))
    if mean > 0.82:                       # 白子
        conf = (mean - 0.82) / 0.18
        return WHITE, max(0.0, min(1.0, conf))
    # 0.45 ~ 0.82 之间：木色棋盘背景 → 空（该区间无棋子，可高置信判空）
    return EMPTY, 1.0


def detect_board_and_confidence(board_rgb, h_lines, v_lines):
    """对 15×15 网格逐点分类，返回 (board, confidence, unknownPoints)。"""
    h_lines_sorted = sorted(h_lines)
    v_lines_sorted = sorted(v_lines)
    h_spacing = np.median(np.diff(h_lines_sorted)) if len(h_lines_sorted) > 1 else 1
    v_spacing = np.median(np.diff(v_lines_sorted)) if len(v_lines_sorted) > 1 else 1
    spacing = min(h_spacing, v_spacing)
    r_in = max(1.0, spacing * 0.20)
    r_out = max(r_in + 1.0, spacing * 0.45)

    size = len(h_lines_sorted)
    board = [[EMPTY] * size for _ in range(size)]
    confidence = [[0.0] * size for _ in range(size)]
    unknown = []

    for r, y in enumerate(h_lines_sorted):
        for c, x in enumerate(v_lines_sorted):
            label, conf = classify_cell(board_rgb, y, x, r_in, r_out)
            if conf < CONF_THRESHOLD:
                label = UNKNOWN
            board[r][c] = label
            confidence[r][c] = round(conf, 3)
            if label == UNKNOWN:
                unknown.append([r, c])
    return board, confidence, unknown


# ============================================================
#  目录扫描（递归、忽略隐藏/临时/非图片）
# ============================================================

def is_ignorable(name):
    base = os.path.basename(name)
    if base.startswith('.'):
        return True
    if '~' in base:
        return True
    if base.endswith('~') or base.endswith('.tmp'):
        return True
    return False


def list_image_files(directory):
    files = []
    for root, dirs, names in os.walk(directory):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for n in names:
            if is_ignorable(n):
                continue
            if os.path.splitext(n.lower())[1] in IMAGE_EXTS:
                files.append(os.path.relpath(os.path.join(root, n), ROOT))
    files.sort()
    return files


# ============================================================
#  主流程
# ============================================================

def analyze_image(abs_path, rel_path):
    result = {
        'sourceImage': rel_path.replace(os.sep, '/'),
        'boardSize': EXPECTED_LINES,
        'board': None,
        'confidence': None,
        'unknownPoints': [],
        'manualReview': True,
        'reasons': [],
        'gridLines': None,
    }

    try:
        img = Image.open(abs_path)
        img.load()
        arr = np.array(img.convert('RGB'))
    except Exception as e:
        result['reasons'].append('读取失败: %s' % str(e))
        return result

    board_region = detect_board_region(arr)
    if board_region is None:
        result['reasons'].append('无法可靠定位棋盘区域')
        return result
    if board_region['confidence'] < BOARD_CONF_GATE:
        # 仅标记人工校对，不中止——仍尽力输出棋盘
        result['reasons'].append('棋盘区域检测置信度过低 (%.3f)' % board_region['confidence'])

    x, y = board_region['x'], board_region['y']
    w, h = board_region['width'], board_region['height']
    board_rgb = arr[y:y + h, x:x + w]
    board_gray = np.array(Image.fromarray(board_rgb).convert('L'))

    grid = detect_grid_lines(board_gray, EXPECTED_LINES)
    if grid['rows'] != EXPECTED_LINES or grid['cols'] != EXPECTED_LINES:
        result['reasons'].append(
            '网格识别不全: %dx%d (应为 %dx%d)' % (grid['rows'], grid['cols'], EXPECTED_LINES, EXPECTED_LINES))
        return result
    if grid['confidence'] < GRID_CONF_GATE:
        result['reasons'].append('网格检测置信度过低 (%.3f)' % grid['confidence'])
        return result

    # 交叉点坐标（相对原图，便于调试）
    result['gridLines'] = {
        'horizontal': [int(y + p) for p in grid['horizontalLines']],
        'vertical': [int(x + p) for p in grid['verticalLines']],
    }

    board, confidence, unknown = detect_board_and_confidence(
        board_rgb, grid['horizontalLines'], grid['verticalLines'])
    result['board'] = board
    result['confidence'] = confidence
    result['unknownPoints'] = unknown

    if unknown:
        result['reasons'].append('存在 %d 个不确定交点需人工校对' % len(unknown))

    if not result['reasons']:
        result['manualReview'] = False
    return result


def main():
    image_dir = None
    for d in CANDIDATE_IMAGE_DIRS:
        if os.path.isdir(d):
            image_dir = d
            break
    if image_dir is None:
        print('未找到 puzzle-source 图片目录。候选: %s' % CANDIDATE_IMAGE_DIRS)
        return

    files = list_image_files(image_dir)
    if not files:
        print('未发现任何图片文件。')
        return

    os.makedirs(OUT_DIR, exist_ok=True)

    total = len(files)
    auto = 0
    manual = 0
    for i, rel in enumerate(files, 1):
        abs_path = os.path.join(ROOT, rel)
        res = analyze_image(abs_path, rel)
        out_name = 'game_%03d.json' % i
        with open(os.path.join(OUT_DIR, out_name), 'w', encoding='utf-8') as f:
            json.dump(res, f, ensure_ascii=False, indent=2)
        if res['manualReview']:
            manual += 1
        else:
            auto += 1
        if i % 20 == 0 or i == total:
            print('已识别 %d/%d ...' % (i, total))

    print('\n完成。共 %d 张：自动识别 %d，需人工校对 %d。'
          % (total, auto, manual))
    print('输出目录: %s' % OUT_DIR)


if __name__ == '__main__':
    main()
