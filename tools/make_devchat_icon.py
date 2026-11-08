#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 DevChat 的应用图标（多尺寸 ICO）。

设计：
    深色圆角方块底（#1C1C1A）+ 五个小圆点排成对话的形状，
    颜色对应 A/B/C/D/你 五条线 —— 一眼能认出「这是那个群」。

为什么自己画：
    用 .ico 需要 16/32/48/64/128/256 六个尺寸，交给 Pillow 一次出全，
    比拿一张大图让系统缩放清晰得多（小尺寸下系统缩放过糊）。

用法：
    python tools/make_devchat_icon.py           生成 tools/DevChatApp/Assets/AppIcon.ico
    python tools/make_devchat_icon.py --png     额外输出一张 256 的预览图
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
OUT = HERE / "DevChatApp" / "Assets"

# 与 App.xaml 的暗色主题一致
BG = (28, 28, 26, 255)
DOTS = [
    (0x6F, 0xA8, 0xDC),   # A 蓝
    (0x7F, 0xBF, 0x6A),   # B 绿
    (0xC0, 0x8B, 0xD0),   # C 紫
    (0xE0, 0xA9, 0x4F),   # D 橙
    (0xE8, 0x89, 0x6A),   # 你 红棕
]

SIZES = [16, 24, 32, 48, 64, 128, 256]


def rounded_rect(draw, box, radius, fill):
    x0, y0, x1, y1 = box
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill)


def make_icon(size: int) -> Image.Image:
    """按尺寸绘制。小尺寸下减少细节、加粗元素，避免糊成一团。"""
    S = size * 4                      # 先在 4 倍画布里画，再缩下去抗锯齿
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = int(S * 0.06)
    radius = int(S * 0.22)
    rounded_rect(d, (pad, pad, S - pad, S - pad), radius, BG)

    # 五个点：上排三个、下排两个，像一句对话的回声
    if size <= 24:
        # 太小：只放三个点，越大越糊
        layout = [(0.30, 0.38), (0.50, 0.38), (0.70, 0.38)]
        r = S * 0.085
    elif size <= 48:
        layout = [(0.28, 0.40), (0.50, 0.40), (0.72, 0.40), (0.38, 0.63), (0.62, 0.63)]
        r = S * 0.072
    else:
        layout = [(0.26, 0.40), (0.50, 0.40), (0.74, 0.40), (0.37, 0.64), (0.63, 0.64)]
        r = S * 0.070

    for i, (cx, cy) in enumerate(layout):
        x, y = cx * S, cy * S
        col = DOTS[i % len(DOTS)]
        d.ellipse([x - r, y - r, x + r, y + r], fill=col + (255,))

    return img.resize((size, size), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--png", action="store_true", help="额外输出 256 预览 PNG")
    ap.add_argument("--out", default=str(OUT), help="输出目录")
    a = ap.parse_args()

    outdir = Path(a.out)
    outdir.mkdir(parents=True, exist_ok=True)

    images = [make_icon(s) for s in SIZES]
    ico = outdir / "AppIcon.ico"
    images[-1].save(ico, format="ICO", sizes=[(s, s) for s in SIZES])
    print("已生成 %s（%d 个尺寸）" % (ico, len(SIZES)))
    print("  尺寸: " + ", ".join(str(s) for s in SIZES))

    if a.png:
        p = outdir / "AppIcon-256.png"
        images[-1].save(p, format="PNG")
        print("已生成预览 %s" % p)

    # 顺带给窗口标题栏/任务栏用的方形 logo
    logo = outdir / "Square44x44Logo.png"
    make_icon(44).save(logo, format="PNG")
    print("已生成 %s" % logo)


if __name__ == "__main__":
    main()
