#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_escalation.py —— 验证「语义失败 → 坐标 + 真鼠标」这条升级链真的生效。

要回答的问题有三个，缺一不可：

1. **语义路径确实会失败**：造一个没有文字、没有 role、`cursor` 不是 `pointer` 的 div，
   `_click_js` 那套（依赖 `__pool()` 的文字匹配）必须点不到它。
2. **坐标路径确实能点中**：同一个 div，给一个 CSS 选择器，`record_coords` +
   `click_point` 必须命中，并且 `elementFromPoint` 的命中签名要对得上。
3. **命中校验真的会拦**：坐标挪 200px 之后，签名不符，必须抛"坐标漂移"而不是硬点下去。

用法::

    python tools/probe_escalation.py --port 9445

退出码：0 = 三条全过；1 = 有一条不成立。
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
    spec = importlib.util.spec_from_file_location(f"_probe_{name}", TOOLS / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[f"_probe_{name}"] = module
    spec.loader.exec_module(module)
    return module


PAGE = """
// 包进 IIFE：页面上的 evaluate 是同一个 JS 上下文，用 top-level `const blind` 会
// 在上一次运行后残留，第二次再声明就报 "Identifier 'blind' has already been declared"。
// 这不是产品缺陷，是探针自己污染了页面 —— 但会让「连跑两次」变成假失败。
(() => {
  document.body.innerHTML = '';
  document.body.style.margin = '0';

  // 1) 语义池抓不到：无文字、无 role、cursor 是 default
  const blind = document.createElement('div');
  blind.id = 'blind-target';
  blind.style.cssText = 'position:absolute;left:200px;top:120px;width:160px;height:80px;'
                      + 'background:#446;cursor:default';
  blind.onclick = () => { window.__hits.push('blind'); };
  document.body.appendChild(blind);

  // 2) 对照组：正常按钮，语义池能抓到
  const normal = document.createElement('button');
  normal.id = 'normal-target';
  normal.textContent = 'Normal Button';
  normal.style.cssText = 'position:absolute;left:200px;top:260px;width:160px;height:60px';
  normal.onclick = () => { window.__hits.push('normal'); };
  document.body.appendChild(normal);

  window.__hits = [];
})();
"""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="验证三级点击升级链")
    ap.add_argument("--port", type=int, default=9445)
    args = ap.parse_args(argv)

    cdp = _load("cdp_driver")
    ce = _load("click_engine")

    driver = cdp.CdpDriver(args.port)
    driver.connect()
    checks: list[tuple[str, bool, str]] = []
    try:
        driver.call("Emulation.setDeviceMetricsOverride", {
            "width": 1920, "height": 1080, "deviceScaleFactor": 1, "mobile": False,
        })
        driver.evaluate(PAGE)
        time.sleep(0.3)

        # ---- 1) 语义路径点不到 blind ----
        driver.evaluate("window.__hits = []")
        ok = driver.evaluate(cdp._click_js("blind-target"))
        hits = json.loads(driver.evaluate("JSON.stringify(window.__hits)"))
        checks.append((
            "语义路径（_click_js）点不到无文字 div",
            not ok and "blind" not in hits,
            f"返回 {ok}，hits={hits}",
        ))

        # ---- 2) 语义路径能点到普通按钮（对照组，证明不是全都失败）----
        driver.evaluate("window.__hits = []")
        ok2 = driver.evaluate(cdp._click_js("Normal Button"))
        hits2 = json.loads(driver.evaluate("JSON.stringify(window.__hits)"))
        checks.append((
            "语义路径能点到普通按钮（对照组）",
            bool(ok2) and "normal" in hits2,
            f"返回 {ok2}，hits={hits2}",
        ))

        # ---- 3) 坐标路径能点中 blind ----
        engine = ce.ClickEngine(driver)
        driver.evaluate("window.__hits = []")
        recs = engine.record_coords(["#blind-target"])
        rec = recs.get("#blind-target")
        checks.append((
            "record_coords 能记录 blind-target",
            rec is not None,
            f"rec={rec}",
        ))
        if rec:
            entry = engine.click_point(rec, timeout=3.0, require_effect=False)
            hits3 = json.loads(driver.evaluate("JSON.stringify(window.__hits)"))
            checks.append((
                "坐标 + 真鼠标 点中 blind-target",
                "blind" in hits3,
                f"entry.ok={entry.get('ok')}，hits={hits3}",
            ))
            checks.append((
                "点击记录带命中签名",
                bool(entry.get("sig")) and entry.get("mode") == "coord",
                f"mode={entry.get('mode')}，sig={entry.get('sig')}",
            ))

        # ---- 4) 坐标漂移会被拦住 ----
        if rec:
            drifted = dict(rec)
            drifted["x"] = rec["x"] + 200
            raised = False
            detail = ""
            try:
                engine.click_point(drifted, timeout=2.0)
            except ce.ClickError as exc:
                raised = "坐标漂移" in str(exc)
                detail = str(exc)[:80]
            checks.append((
                "坐标漂移被 elementFromPoint 拦住",
                raised,
                detail or "没有抛错（会硬点下去）",
            ))

        # ---- 5) 升级链：语义失败后自动退到坐标 ----
        if rec:
            driver.evaluate("window.__hits = []")
            engine2 = ce.ClickEngine(driver)
            escalated = None
            err = ""
            try:
                entry = engine2.click_escalating(
                    "blind-target", css="#blind-target", timeout=3.0,
                    require_effect=False)
                escalated = entry.get("escalation")
            except Exception as exc:  # noqa: BLE001
                err = f"{type(exc).__name__}: {exc}"[:160]
            hits5 = json.loads(driver.evaluate("JSON.stringify(window.__hits)"))
            checks.append((
                "click_escalating 自动升级到 coord-signature",
                escalated == "coord-signature" and "blind" in hits5,
                f"escalation={escalated}，hits={hits5}，err={err}",
            ))
        print()
        ok_all = True
        for name, passed, detail in checks:
            print(f"[{'PASS' if passed else 'FAIL'}] {name}")
            if not passed:
                print(f"       {detail}")
                ok_all = False
        print()
        if ok_all:
            print("结论：三级升级链成立——语义失败会自动退到坐标 + 真鼠标，且命中校验会拦漂移。")
        else:
            print("结论：升级链有一环不成立，见上面 FAIL。")
        return 0 if ok_all else 1
    finally:
        try:
            driver.call("Emulation.clearDeviceMetricsOverride")
        except Exception:  # noqa: BLE001
            pass
        driver.close()


if __name__ == "__main__":
    sys.exit(main())
