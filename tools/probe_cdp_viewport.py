#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_cdp_viewport.py —— 验证「CDP 钉视口」是否与物理屏幕/DPI 无关。

为什么要单独验这一条：本机方案把几何固化押在 `Emulation.setDeviceMetricsOverride` 上。
如果它依赖物理分辨率，那么换一台机器、换一个缩放比、接一个外接屏，坐标就全废。
如果它不依赖物理屏幕，那「钉死几何」这件事只需要写一行 CDP 调用，跟本机装了什么虚拟
显示驱动、屏幕多大、DPI 多少都无关 —— 这才是能带得走的通用方案。

用法::

    python tools/probe_cdp_viewport.py --port 9333

退出码：0 = 视口钉死生效且与物理屏无关；1 = 不成立。
"""
from __future__ import annotations

import argparse
import json
import sys

# 复用仓库已有的 CDP 客户端，不另写一套 WebSocket

# --- 按路径加载同目录模块（打包后 sys.path 里没有 tools/）----------------------
# 由 tools/apply_loader_safe.py 生成。为什么不用裸导入、为什么必须写 sys.modules，
# 见那个脚本的模块文档（和 tools/cdp_driver.py::_load_click_engine 的实现）。
def _fsa_load_sibling(name: str):
    """加载与当前文件同目录的 ``<name>.py``，返回模块对象。"""
    import importlib.util as _iu
    import sys as _sys
    from pathlib import Path as _P

    alias = f"_fsa_tool_{name}"
    cached = _sys.modules.get(alias)
    if cached is not None:
        return cached
    path = _P(__file__).with_name(f"{name}.py")
    if not path.is_file():
        raise ImportError(f"同目录缺少 {name}.py（{path}）")
    spec = _iu.spec_from_file_location(alias, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载 {path}")
    module = _iu.module_from_spec(spec)
    # dataclasses 解析字符串注解时要靠 sys.modules 找到模块，必须先注册。
    _sys.modules[alias] = module
    spec.loader.exec_module(module)
    return module


sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="验证 CDP 钉视口与物理屏幕无关")
    ap.add_argument("--port", type=int, default=9333, help="CDP 端口")
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    args = ap.parse_args(argv)

    CdpDriver = _fsa_load_sibling("cdp_driver").CdpDriver  # 仓库现成的客户端

    driver = CdpDriver(args.port)
    driver.connect()
    try:
        checks: list[tuple[str, bool, str]] = []

        # 1. 钉之前：视口 = 窗口实际尺寸 × 缩放
        before = driver.evaluate(
            "JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio,"
            " sw: screen.width, sh: screen.height})")
        b = json.loads(before) if isinstance(before, str) else before
        print(f"[before] inner={b['w']}x{b['h']} dpr={b['dpr']} screen={b['sw']}x{b['sh']}")

        # 2. 钉视口：Emulation.setDeviceMetricsOverride（click_engine.fix_viewport 用的就是这条）
        driver.call("Emulation.setDeviceMetricsOverride", {
            "width": args.width, "height": args.height,
            "deviceScaleFactor": 1, "mobile": False,
        })

        after = driver.evaluate(
            "JSON.stringify({w: innerWidth, h: innerHeight, dpr: devicePixelRatio,"
            " sw: screen.width, sh: screen.height})")
        a = json.loads(after) if isinstance(after, str) else after
        print(f"[after]  inner={a['w']}x{a['h']} dpr={a['dpr']} screen={a['sw']}x{a['sh']}")

        checks.append((
            "innerWidth 等于钉的值",
            a["w"] == args.width,
            f"期望 {args.width}，实际 {a['w']}",
        ))
        checks.append((
            "innerHeight 等于钉的值",
            a["h"] == args.height,
            f"期望 {args.height}，实际 {a['h']}",
        ))
        checks.append((
            "devicePixelRatio 被钉成 1",
            abs(a["dpr"] - 1.0) < 1e-6,  # CDP 返回的是浮点，1 会回成 1.0000000149…
            f"期望 1，实际 {a['dpr']}",
        ))
        checks.append((
            "screen.* 未被改变（说明只影响视口，不影响物理屏）",
            a["sw"] == b["sw"] and a["sh"] == b["sh"],
            f"钉前 {b['sw']}x{b['sh']}，钉后 {a['sw']}x{a['sh']}",
        ))

        # 3. 关键：同一元素在钉死视口后的坐标是否可复现
        driver.evaluate(
            "document.body.innerHTML = "
            "'<div id=box style=\"position:absolute;left:100px;top:200px;"
            "width:300px;height:150px;background:#ccc\">box</div>'")
        pos1 = driver.evaluate(
            "JSON.stringify((()=>{const r=document.getElementById('box').getBoundingClientRect();"
            "return {x:r.x, y:r.y, w:r.width, h:r.height};})())")
        p1 = json.loads(pos1) if isinstance(pos1, str) else pos1
        print(f"[box]    x={p1['x']} y={p1['y']} w={p1['w']} h={p1['h']}")

        # 4. 清掉 override，再钉一次，看坐标是否一致（幂等）
        driver.call("Emulation.clearDeviceMetricsOverride")
        driver.call("Emulation.setDeviceMetricsOverride", {
            "width": args.width, "height": args.height,
            "deviceScaleFactor": 1, "mobile": False,
        })
        pos2 = driver.evaluate(
            "JSON.stringify((()=>{const r=document.getElementById('box').getBoundingClientRect();"
            "return {x:r.x, y:r.y, w:r.width, h:r.height};})())")
        p2 = json.loads(pos2) if isinstance(pos2, str) else pos2
        print(f"[box2]   x={p2['x']} y={p2['y']} w={p2['w']} h={p2['h']}")

        checks.append((
            "清掉 override 再钉，坐标完全一致（可复现）",
            p1 == p2,
            f"第一次 {p1}，第二次 {p2}",
        ))
        checks.append((
            "绝对定位元素坐标 = CSS 里写的值（100,200）",
            p1["x"] == 100 and p1["y"] == 200,
            f"实际 {p1['x']},{p1['y']}",
        ))

        driver.call("Emulation.clearDeviceMetricsOverride")

        print()
        ok = True
        for name, passed, detail in checks:
            mark = "PASS" if passed else "FAIL"
            print(f"[{mark}] {name}")
            if not passed:
                print(f"       {detail}")
                ok = False

        print()
        if ok:
            print("结论：视口钉死**不依赖物理屏幕**，坐标可复现。")
        else:
            print("结论：视口钉死不成立，坐标方案需要重新设计。")
        return 0 if ok else 1
    finally:
        driver.close()


if __name__ == "__main__":
    sys.exit(main())
