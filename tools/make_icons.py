#!/usr/bin/env python3
"""生成占位图标（纯色圆角方块）。无 PIL 时跳过。"""
import os
try:
    from PIL import Image, ImageDraw
except ImportError:
    print("PIL 未安装，跳过图标生成 (pip install pillow)")
    raise SystemExit(0)
OUT = os.path.join(os.path.dirname(__file__), "..", "src", "icons")
os.makedirs(OUT, exist_ok=True)
for s in (16, 48, 128):
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([1, 1, s - 2, s - 2], radius=max(2, s // 8), fill=(37, 99, 235, 255))
    img.save(os.path.join(OUT, f"icon{s}.png"))
print("icons written:", OUT)
