#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_cdp_click.py —— 验证「CDP 点击」是否受物理窗口大小限制。

要回答的问题只有一个：**视口钉到 1920×1080，但窗口物理上只有 800×600 时，
点击落在窗口外的 CSS 坐标（例如 1900,1000）还能不能命中？**

为什么这条必须先验：本机方案的坐标模式建立在
`fix_viewport(1920,1080)` + `record_coords()` + `click_point()` 之上。如果 CDP 的
`Input.dispatchMouseEvent` 会被物理窗口裁剪，那「钉视口」只解决了布局、没解决点击，
坐标模式仍然绑死在窗口大小上 —— 那就还是不可移植。

用法::

    python tools/probe_cdp_click.py --port 9445

退出码：0 = 窗外坐标也能点中（与窗口大小无关）；1 = 被裁剪（必须让窗口足够大）。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


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


sys.path.insert(0, str(Path(__file__).resolve().parent))


def _json(value):
    return json.loads(value) if isinstance(value, str) else value


def click_at(driver, x: float, y: float) -> None:
    """与 click_engine.click_point 发的完全同一种事件序列。"""
    for kind, extra in (("mouseMoved", {}),
                        ("mousePressed", {"clickCount": 1}),
                        ("mouseReleased", {"clickCount": 1})):
        driver.call("Input.dispatchMouseEvent", {
            "type": kind, "x": x, "y": y, "button": "left", **extra,
        })
        time.sleep(0.05)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="验证 CDP 点击是否受窗口物理尺寸限制")
    ap.add_argument("--port", type=int, default=9445)
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--no-viewport", action="store_true",
                    help="不钉视口（对照实验：看点击是否仍受窗口限制）")
    args = ap.parse_args(argv)

    CdpDriver = _fsa_load_sibling("cdp_driver").CdpDriver

    driver = CdpDriver(args.port)
    driver.connect()
    try:
        if not args.no_viewport:
            # 只钉尺寸，不覆盖 deviceScaleFactor —— 某些 target 不支持带 dpr 的 override
            driver.call("Emulation.setDeviceMetricsOverride", {
                "width": args.width, "height": args.height,
                "deviceScaleFactor": 1, "mobile": False,
                "screenOrientation": {"type": "portraitPrimary", "angle": 0},
            })
        else:
            print("(--no-viewport：不钉视口，用窗口真实尺寸做对照)")

        driver.evaluate("""
            document.body.innerHTML = '';
            document.body.style.margin = '0';
            document.body.style.overflow = 'visible';
            const mk = (id, l, t) => {
              const b = document.createElement('button');
              b.id = id; b.textContent = id;
              b.style.cssText = `position:absolute;left:${l}px;top:${t}px;width:120px;height:60px`;
              b.onclick = () => { window.__hits.push(id); };
              document.body.appendChild(b);
            };
            window.__hits = [];
            mk('inside', 10, 10);
            mk('edge', 700, 500);
            mk('outside', 1800, 960);
            document.documentElement.scrollTop = 0;
            document.body.scrollTop = 0;
        """)

        layout = _json(driver.evaluate("""
            JSON.stringify({
              inner: [innerWidth, innerHeight],
              outer: [outerWidth, outerHeight],
              dpr: devicePixelRatio,
              boxes: ['inside','edge','outside'].map(id => {
                const r = document.getElementById(id).getBoundingClientRect();
                return {id, x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)};
              })
            })
        """))
        print(f"视口 inner={layout['inner']}  outer(窗口)={layout['outer']}  dpr={layout['dpr']}")
        print()

        checks = []
        for box in layout["boxes"]:
            driver.evaluate("window.__hits = []")
            click_at(driver, box["x"], box["y"])
            time.sleep(0.3)
            hits = _json(driver.evaluate("JSON.stringify(window.__hits || [])"))
            hit = box["id"] in hits
            outside_window = (box["x"] > layout["outer"][0]) or (box["y"] > layout["outer"][1])
            tag = "窗口外" if outside_window else "窗口内"
            print(f"  点 {box['id']:<8} @({box['x']},{box['y']}) [{tag}] -> "
                  f"{'HIT' if hit else 'MISS'}")
            checks.append((box["id"], hit, outside_window))

        print()
        inside_ok = next(ok for name, ok, _ in checks if name == "inside")
        edge_ok = next(ok for name, ok, _ in checks if name == "edge")
        outside_ok = next(ok for name, ok, _ in checks if name == "outside")

        print(f"[{'PASS' if inside_ok else 'FAIL'}] 窗口内坐标可点")
        print(f"[{'PASS' if edge_ok else 'FAIL'}] 近窗口边缘的坐标可点")
        print(f"[{'PASS' if outside_ok else 'FAIL'}] 远在窗口外的坐标可点")
        print()
        if outside_ok:
            print("结论：CDP 点击用的是**视口坐标**，不被物理窗口裁剪。")
            print("      不需要把窗口开大，也不需要改分辨率。")
            return 0
        print("结论：CDP 点击被物理窗口裁剪 —— 必须保证窗口物理尺寸 >= 视口尺寸。")
        return 1
    finally:
        driver.close()


if __name__ == "__main__":
    sys.exit(main())
