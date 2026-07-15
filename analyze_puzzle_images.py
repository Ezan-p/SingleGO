#!/usr/bin/env python3
"""Analyze puzzle source images and produce a structured JSON report.

This script does NOT modify business code. It only reads images from
miniprogram/puzzle-source/image and writes a report to
miniprogram/puzzle-output/image-analysis.json.
"""

import os
import json
import math
import numpy as np
from PIL import Image
from collections import Counter

IMAGE_DIR = '/Users/ezan/WeChatProjects/miniprogram-1/miniprogram/puzzle-source/image'
OUTPUT_PATH = '/Users/ezan/WeChatProjects/miniprogram-1/miniprogram/puzzle-output/image-analysis.json'


def list_image_files(directory):
    """List all PNG/JPG/JPEG files in the directory, sorted."""
    exts = {'.png', '.jpg', '.jpeg'}
    files = [f for f in os.listdir(directory)
             if os.path.splitext(f.lower())[1] in exts]
    files.sort()
    return files


def rgb_to_hsv(rgb):
    """Vectorized RGB -> HSV conversion (H in degrees 0-360, S,V 0-1)."""
    rgb = rgb.astype(np.float32) / 255.0
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx = np.maximum(np.maximum(r, g), b)
    mn = np.minimum(np.minimum(r, g), b)
    df = mx - mn

    # Hue
    h = np.zeros_like(mx)
    mask = df != 0
    r_m = (r == mx) & mask
    g_m = (g == mx) & mask
    b_m = (b == mx) & mask
    h[r_m] = (60 * ((g[r_m] - b[r_m]) / df[r_m]) + 360) % 360
    h[g_m] = (60 * ((b[g_m] - r[g_m]) / df[g_m]) + 120) % 360
    h[b_m] = (60 * ((r[b_m] - g[b_m]) / df[b_m]) + 240) % 360

    # Saturation
    s = np.zeros_like(mx)
    s[mx != 0] = df[mx != 0] / mx[mx != 0]

    return h, s, mx


def longest_contiguous_run(bool_arr):
    """Return (start, end) of the longest True run in a boolean array."""
    best_start = best_end = None
    best_len = 0
    cur_start = None
    for i, val in enumerate(bool_arr):
        if val and cur_start is None:
            cur_start = i
        elif not val and cur_start is not None:
            length = i - cur_start
            if length > best_len:
                best_len = length
                best_start = cur_start
                best_end = i - 1
            cur_start = None
    if cur_start is not None:
        length = len(bool_arr) - cur_start
        if length > best_len:
            best_len = length
            best_start = cur_start
            best_end = len(bool_arr) - 1
    if best_start is None:
        return None
    return best_start, best_end


def find_best_run(density, mask_sum, threshold=0.05):
    """Find the longest contiguous run of True in a density array.

    When multiple runs exist, select the one with the highest total mask sum
    (so the board region wins over spurious tan UI pixels).
    """
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
    return max(runs, key=lambda r: mask_sum[r[0]:r[1]+1].sum())


def detect_board_region(arr):
    """Detect the board region using a tan/wood color mask.

    Returns a dict with keys:
      x, y, width, height, confidence (0-1), or None if detection fails.
    """
    h, s, v = rgb_to_hsv(arr)
    # Tan/wood board: relatively narrow hue/saturation range to exclude
    # white backgrounds, UI elements, and black/white pieces.
    mask = (
        (h >= 25) & (h <= 50) &
        (s >= 0.40) & (s <= 0.70) &
        (v >= 0.40) & (v <= 1.0)
    )

    h_img, w_img = arr.shape[:2]

    # Use density along rows and columns to find the largest contiguous block
    # of board-like color. The board is a solid rectangle, so its rows/columns
    # have high tan density, while surrounding UI/background have near zero.
    row_density = mask.sum(axis=1) / w_img
    col_density = mask.sum(axis=0) / h_img

    # Smooth the density to bridge the dark grid lines and pieces
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

    # Sanity checks: board should be roughly square and occupy a reasonable area
    aspect_ratio = max(width, height) / max(min(width, height), 1)
    if aspect_ratio > 1.3:
        return None
    if width < w_img * 0.60 or height < h_img * 0.25:
        return None

    # Confidence based on the fill ratio inside the detected rectangle
    region_mask = mask[y:y2+1, x:x2+1]
    fill_ratio = region_mask.sum() / (width * height)
    confidence = float(min(fill_ratio, 1.0))

    return {
        'x': int(x),
        'y': int(y),
        'width': int(width),
        'height': int(height),
        'confidence': round(confidence, 3),
    }


def longest_contiguous_run(bool_arr):
    """Return (start, end) of the longest True run in a boolean array."""
    best_start = best_end = None
    best_len = 0
    cur_start = None
    for i, val in enumerate(bool_arr):
        if val and cur_start is None:
            cur_start = i
        elif not val and cur_start is not None:
            length = i - cur_start
            if length > best_len:
                best_len = length
                best_start = cur_start
                best_end = i - 1
            cur_start = None
    if cur_start is not None:
        length = len(bool_arr) - cur_start
        if length > best_len:
            best_len = length
            best_start = cur_start
            best_end = len(bool_arr) - 1
    if best_start is None:
        return None
    return best_start, best_end


def detect_grid_lines(board_gray, expected_lines=15):
    """Detect horizontal and vertical grid lines inside the board region.

    Uses gradient projections combined with a regular grid search to find the
    expected number of evenly spaced lines (default 15x15).

    Returns:
      {
        'rows': int, 'cols': int,
        'horizontalLines': [y positions relative to full image],
        'verticalLines': [x positions relative to full image],
        'confidence': 0-1
      }
    """
    # Compute gradient magnitude
    gx = np.abs(board_gray[:, 1:] - board_gray[:, :-1])
    gy = np.abs(board_gray[1:, :] - board_gray[:-1, :])

    h_grad = np.zeros(board_gray.shape[0])
    h_grad[1:-1] = (gy[:-1, :].sum(axis=1) + gy[1:, :].sum(axis=1)) / 2
    v_grad = np.zeros(board_gray.shape[1])
    v_grad[1:-1] = (gx[:, :-1].sum(axis=0) + gx[:, 1:].sum(axis=0)) / 2

    # Smooth the 1D projections to reduce noise from pieces and anti-aliasing
    h_grad = np.convolve(h_grad, np.ones(3) / 3, mode='same')
    v_grad = np.convolve(v_grad, np.ones(3) / 3, mode='same')

    h = board_gray.shape[0]
    w = board_gray.shape[1]
    expected_h_spacing = h / (expected_lines - 1)
    expected_w_spacing = w / (expected_lines - 1)

    h_peaks = find_regular_peaks(h_grad, expected_lines, expected_h_spacing, step=1.0)
    v_peaks = find_regular_peaks(v_grad, expected_lines, expected_w_spacing, step=1.0)

    rows = len(h_peaks)
    cols = len(v_peaks)

    confidence = 0.0
    if rows >= 2 and cols >= 2:
        h_spacings = np.diff(h_peaks)
        v_spacings = np.diff(v_peaks)
        h_reg = 1.0 - (float(np.std(h_spacings)) / max(float(np.mean(h_spacings)), 1e-6))
        v_reg = 1.0 - (float(np.std(v_spacings)) / max(float(np.mean(v_spacings)), 1e-6))
        h_reg = max(0.0, min(1.0, h_reg))
        v_reg = max(0.0, min(1.0, v_reg))
        confidence = (h_reg + v_reg) / 2.0

    return {
        'rows': rows,
        'cols': cols,
        'horizontalLines': h_peaks,
        'verticalLines': v_peaks,
        'confidence': round(confidence, 3),
    }


def find_regular_peaks(signal, n, expected_spacing, step=1.0):
    """Find the best set of n evenly spaced peaks in a 1D signal.

    Searches over spacing and offset to maximize the sum of signal values at
    the expected line positions, with a regularity bonus.
    """
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
            # Regularity bonus
            if len(positions) > 1:
                spacings = np.diff(positions)
                regularity = 1.0 - np.std(spacings) / max(np.mean(spacings), 1e-6)
                score *= max(0.0, regularity)
            # Slight penalty for edge positions (likely board border, not grid line)
            if positions[0] < 5 or positions[-1] > len(signal) - 5:
                score *= 0.9
            if score > best_score:
                best_score = score
                best_positions = positions
    return best_positions


def find_peaks(signal, min_distance, expected_count=None):
    """Find local maxima in 1D signal with minimum distance between peaks."""
    if len(signal) == 0:
        return []
    # Simple peak detection: point greater than neighbors within min_distance
    peaks = []
    for i in range(min_distance, len(signal) - min_distance):
        window = signal[max(0, i - min_distance):min(len(signal), i + min_distance + 1)]
        if signal[i] == np.max(window) and signal[i] > np.mean(window) + 1e-6:
            # Avoid duplicates within min_distance
            if not peaks or i - peaks[-1] >= min_distance:
                peaks.append(i)

    # If we expect a specific count, keep the strongest peaks
    if expected_count is not None and len(peaks) > expected_count:
        sorted_peaks = sorted(peaks, key=lambda p: signal[p], reverse=True)
        kept = sorted(sorted_peaks[:expected_count])
        return kept

    return peaks


def detect_piece_colors(board_rgb, h_lines, v_lines):
    """Sample colors at grid intersections and classify pieces.

    Returns a dict with:
      - colors: list of detected piece colors ('black', 'white')
      - positions: list of dicts {row, col, color, confidence} or empty if uncertain
    """
    if len(h_lines) < 2 or len(v_lines) < 2:
        return {'colors': [], 'positions': []}

    h_lines_sorted = sorted(h_lines)
    v_lines_sorted = sorted(v_lines)

    # Estimate grid spacing and piece sampling radius
    h_spacing = np.median(np.diff(h_lines_sorted))
    v_spacing = np.median(np.diff(v_lines_sorted))
    cell_radius = int(min(h_spacing, v_spacing) * 0.32)

    positions = []
    color_votes = Counter()

    for r, y in enumerate(h_lines_sorted):
        for c, x in enumerate(v_lines_sorted):
            # Sample a circular region around the intersection
            y1 = max(0, y - cell_radius)
            y2 = min(board_rgb.shape[0], y + cell_radius + 1)
            x1 = max(0, x - cell_radius)
            x2 = min(board_rgb.shape[1], x + cell_radius + 1)
            patch = board_rgb[y1:y2, x1:x2]
            if patch.size == 0:
                continue

            # Convert patch to grayscale
            gray = patch.mean(axis=2)
            mean_brightness = float(gray.mean()) / 255.0
            std_brightness = float(gray.std()) / 255.0

            color = None
            confidence = 0.0

            # Pieces are relatively uniform (low std) and distinctly darker or
            # brighter than the empty board cells.
            if std_brightness < 0.20:
                if mean_brightness < 0.45:
                    color = 'black'
                    confidence = (0.45 - mean_brightness) / 0.30
                elif mean_brightness > 0.70:
                    color = 'white'
                    confidence = (mean_brightness - 0.70) / 0.25

            confidence = max(0.0, min(1.0, confidence))

            if color and confidence >= 0.5:
                color_votes[color] += 1
                positions.append({
                    'row': r,
                    'col': c,
                    'color': color,
                    'confidence': round(confidence, 3),
                })

    colors = sorted(list(color_votes.keys()))
    return {'colors': colors, 'positions': positions}


def analyze_image(path):
    """Analyze a single image and return a structured dict."""
    filename = os.path.basename(path)
    result = {
        'filename': filename,
        'readable': False,
        'width': None,
        'height': None,
        'boardRegion': None,
        'boardSize': None,
        'pieceColors': [],
        'piecePositions': 'unknown',
        'manualReview': True,
        'reasons': [],
    }

    try:
        img = Image.open(path)
        img.load()
        result['readable'] = True
        result['width'] = img.width
        result['height'] = img.height
        arr = np.array(img.convert('RGB'))
    except Exception as e:
        result['reasons'].append(f'Failed to read image: {str(e)}')
        return result

    # Detect board region
    board_region = detect_board_region(arr)
    if board_region is None:
        result['reasons'].append('Board region not detected reliably')
        return result

    result['boardRegion'] = board_region

    if board_region['confidence'] < 0.6:
        result['reasons'].append('Board region detection has low confidence')

    # Crop board region for further analysis
    x, y = board_region['x'], board_region['y']
    w, h = board_region['width'], board_region['height']
    board_rgb = arr[y:y+h, x:x+w]
    board_gray = np.array(Image.fromarray(board_rgb).convert('L'))

    # Detect grid lines (relative to board_rgb)
    grid = detect_grid_lines(board_gray, expected_lines=15)
    result['boardSize'] = {
        'rows': grid['rows'],
        'cols': grid['cols'],
    }
    # Convert to absolute image coordinates for the report
    result['gridLines'] = {
        'horizontal': [int(y + p) for p in grid['horizontalLines']],
        'vertical': [int(x + p) for p in grid['verticalLines']],
    }
    result['gridConfidence'] = round(grid['confidence'], 3)

    if grid['rows'] != 15 or grid['cols'] != 15:
        result['reasons'].append(
            f"Unexpected board size: {grid['rows']}x{grid['cols']} (expected 15x15)"
        )

    if grid['confidence'] < 0.5:
        result['reasons'].append('Grid line detection has low confidence')

    # Detect piece colors and positions (relative to board_rgb)
    piece_info = detect_piece_colors(board_rgb, grid['horizontalLines'], grid['verticalLines'])
    result['pieceColors'] = piece_info['colors']

    # Count pieces with high confidence
    high_conf_positions = [p for p in piece_info['positions'] if p['confidence'] >= 0.5]
    if high_conf_positions and len(high_conf_positions) >= 2:
        result['piecePositions'] = high_conf_positions
    else:
        result['piecePositions'] = 'unknown'
        result['reasons'].append('Piece positions not reliably determined')

    if not piece_info['colors']:
        result['reasons'].append('Piece colors not detected')

    # Determine manualReview
    # Mark manual review if: board failed, grid failed, colors failed, or positions uncertain
    result['manualReview'] = len(result['reasons']) > 0

    return result


def build_summary(results):
    """Build the summary statistics from the list of image results."""
    total = len(results)
    readable = [r for r in results if r['readable']]
    unreadable = [r for r in results if not r['readable']]
    auto_recognized = [r for r in results if not r['manualReview']]
    manual_review = [r for r in results if r['manualReview']]

    # Consistency checks
    board_sizes = [(r['boardSize']['rows'], r['boardSize']['cols']) for r in readable
                   if r['boardSize']]
    size_counter = Counter(board_sizes)
    most_common_size = size_counter.most_common(1)[0] if size_counter else (None, 0)

    # Collect color sets
    color_sets = [tuple(sorted(r['pieceColors'])) for r in readable]
    color_counter = Counter(color_sets)
    most_common_colors = color_counter.most_common(1)[0] if color_counter else (None, 0)

    # Aspect ratio / region consistency
    regions = [r['boardRegion'] for r in readable if r['boardRegion']]
    aspect_ratios = [reg['width'] / max(reg['height'], 1) for reg in regions]
    aspect_std = float(np.std(aspect_ratios)) if aspect_ratios else 0
    angle_consistent = aspect_std < 0.15

    # Shooting angle: all are screenshots, so we assume upright/front-facing
    # We check board angle by looking at rectangle orientation; since we only
    # do axis-aligned bounding boxes, low aspect ratio std means consistent angle.
    size_consistent = (
        most_common_size[1] / max(len(readable), 1) >= 0.95
        if most_common_size[0] else False
    )
    color_consistent = (
        most_common_colors[1] / max(len(readable), 1) >= 0.95
        if most_common_colors[0] else False
    )

    # Board style: based on color consistency and region consistency
    style_consistent = color_consistent and len(set(
        tuple(sorted(r['pieceColors'])) for r in readable
    )) <= 1

    return {
        'totalImages': total,
        'readableImages': len(readable),
        'unreadableImages': len(unreadable),
        'autoRecognizedCount': len(auto_recognized),
        'manualReviewCount': len(manual_review),
        'commonBoardSize': {
            'rows': most_common_size[0][0] if most_common_size[0] else None,
            'cols': most_common_size[0][1] if most_common_size[0] else None,
            'count': most_common_size[1],
        },
        'commonPieceColors': list(most_common_colors[0]) if most_common_colors[0] else [],
        'boardStyleConsistent': bool(style_consistent),
        'boardSizeConsistent': bool(size_consistent),
        'shootingAngleConsistent': bool(angle_consistent),
        'unreadableFiles': [r['filename'] for r in unreadable],
        'manualReviewFiles': [r['filename'] for r in manual_review],
    }


def main():
    files = list_image_files(IMAGE_DIR)
    if not files:
        print('No image files found.')
        return

    results = []
    for i, filename in enumerate(files, 1):
        path = os.path.join(IMAGE_DIR, filename)
        result = analyze_image(path)
        results.append(result)
        if i % 10 == 0 or i == len(files):
            print(f'Analyzed {i}/{len(files)} images...')

    summary = build_summary(results)
    report = {
        'summary': summary,
        'images': results,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print('\nDone. Summary:')
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
