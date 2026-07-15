#!/usr/bin/env python3
"""离线残局工具 · 单图识别

读取单个对局截图，输出识别结果 JSON 到 stdout（不写文件）。
供 puzzle-generator.js 的 recognizeBoard() 通过子进程调用。

复用 recognize.py 的检测函数（已验证有效），保持识别逻辑与
批量识别一致。
"""
import os
import sys
import json

# 允许作为脚本直接运行，也能被其它模块 import
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import recognize  # noqa: E402


def main():
    if len(sys.argv) < 2:
        sys.stderr.write('usage: recognize_one.py <image_path>\n')
        sys.exit(2)

    image_path = sys.argv[1]
    # analyze_image(abs_path, rel_path)；此处 rel_path 仅用于展示，
    # 实际 sourceImage 用 basename，便于与批量结果对齐。
    result = recognize.analyze_image(image_path, image_path)
    result['sourceImage'] = os.path.basename(image_path)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
