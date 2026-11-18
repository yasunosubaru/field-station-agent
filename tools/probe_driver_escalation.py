#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_driver_escalation.py —— 验证 CdpDriver.escalating_click 这一层。

上面 probe_escalation.py 验的是 ClickEngine 的三级链；这个文件验的是
**驱动层**：仿真流程里 `driver.click()` / `driver.escalating_click()` 的真实表现，
以及「驱动不支持升级时退化」这条路径。

用法:
    python tools/probe_driver_escalation.py --port 9558
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parent


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"_pd_{name}", TOOLS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"_pd_{name}"] = module
    spec.loader.exec_module(module)
    return module


PAGE = """
document.body.innerHTML = '';
document.body.style.margin = '0';

// 语义池抓不到：无文字、无 role、cursor 是 default
const blind = document.createElement('div');
blind.id = 'blind2';
blind.style.cssText = 'position:absolute;left:300px;top:200px;width:150px;height:70px;'
                     + 'background:#355;cursor:default';
blind.onclick = () => { window.__h2 = (window.__h2 || 0) + 1; };
document.body.appendChild(blind);
window.__h2 = 0;
"""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="验证 CdpDriver.escalating_click")
    ap.add_argument("--port", type=int, default=9558)
    args = ap.parse_args(argv)

    cdp = _load("cdp_driver")
    driver = cdp.CdpDriver(args.port)
    driver.connect()
    checks: list[tuple[str, bool, str]] = []
    try:
        driver.call("Emulation.setDeviceMetricsOverride", {
            "width": 1920, "height": 1080, "deviceScaleFactor": 1, "mobile": False,
        })
        driver.evaluate(PAGE)
        time.sleep(0.3)

        checks.append((
            "CdpDriver 暴露 escalating_click",
            hasattr(driver, "escalating_click"),
            f"属性存在={hasattr(driver, 'escalating_click')}",
        ))

        # 普通 click（语义路径）应当找不到这个 div
        raised = False
        why = ""
        try:
            driver.click("blind2")
        except Exception as exc:  # noqa: BLE001
            raised = True
            why = f"{type(exc).__name__}: {exc}"[:100]
        checks.append((
            "普通 click 对无文字 div 报错（不是假成功）",
            raised,
            why or "没有抛错 —— 这就是假成功",
        ))

        # escalating_click 应当升级并点中
        driver.evaluate("window.__h2 = 0")
        entry = driver.escalating_click("blind2", css="#blind2")
        hits = int(driver.evaluate("window.__h2") or 0)
        checks.append((
            "escalating_click 升级到 coord-signature 并点中",
            entry.get("escalation") == "coord-signature" and hits >= 1,
            f"escalation={entry.get('escalation')}，hits={hits}",
        ))

        # _locator_to_css 的翻译能力
        cases = {
            "#sm-welcome": "#sm-welcome",
            "css:.app-tab": ".app-tab",
            "sm-welcome": "#sm-welcome",
            "Normal Button": None,
        }
        ok_translate = True
        detail = []
        for raw, want in cases.items():
            got = cdp._locator_to_css(raw)
            detail.append(f"{raw!r}→{got!r}")
            if got != want:
                ok_translate = False
        checks.append((
            "_locator_to_css 只把「能确定唯一元素」的写法翻成 CSS",
            ok_translate,
            "；".join(detail),
        ))

        print()
        ok_all = True
        for name, passed, detail_txt in checks:
            print(f"[{'PASS' if passed else 'FAIL'}] {name}")
            if not passed:
                print(f"       {detail_txt}")
                ok_all = False
        print()
        if ok_all:
            print("结论：驱动层升级链成立；不能确定的 locator 不会被硬翻成坐标。")
        return 0 if ok_all else 1
    finally:
        try:
            driver.call("Emulation.clearDeviceMetricsOverride")
        except Exception:  # noqa: BLE001
            pass
        driver.close()


if __name__ == "__main__":
    sys.exit(main())
