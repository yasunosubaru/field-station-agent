# -*- coding: utf-8 -*-
"""第 11 条收尾：宿主侧记录 + 跨机三方对比。

三方数据：
  A. VM    1024x768  (96 DPI,  Edge 157)   —— 已取回 vm_coords.json
  B. 宿主  2560x1600 (144 DPI, Edge)       —— 本脚本产生
  C. 宿主  同机不同视口 1920x1080            —— 证明坐标随视口而变

对比三件事：
  1. 自洽：各机记录 -> 各机回读命中；
  2. 语义一致：同一目标 sig 跨机相同；
  3. 保护有效：拿 A 的坐标去 B 点，必须被 _sig_matches 判为漂移。

第 3 条是重点。click_engine.click_point 的实现是：
    sig = self._hit_test(x, y)
    if not self._sig_matches(rec, sig): raise ClickError("坐标漂移 ...")
所以只要坐标变了而元素名没变，回读就该被拦下 —— 拦不住说明保护是假的。
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO = Path(r"H:\Archive\文件夹 老版\personal content\课程资料\其他\大创项目\野外台站智能体")
TMP = Path(tempfile.gettempdir()) / "opencode"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
PORT = 9335


def load():
    s1 = importlib.util.spec_from_file_location("_cdp", REPO / "tools" / "cdp_driver.py")
    m1 = importlib.util.module_from_spec(s1)
    sys.modules["_cdp"] = m1
    s1.loader.exec_module(m1)
    s2 = importlib.util.spec_from_file_location("_ce", REPO / "tools" / "click_engine.py")
    m2 = importlib.util.module_from_spec(s2)
    sys.modules["_ce"] = m2
    s2.loader.exec_module(m2)
    return m1, m2


def record(html: Path, vw: int, vh: int) -> dict:
    m1, m2 = load()
    profile = TMP / "edge-host-profile"
    profile.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        [EDGE, "--headless=new", "--disable-gpu",
         "--remote-debugging-port=%d" % PORT,
         "--user-data-dir=%s" % profile,
         "--no-first-run", "--no-default-browser-check", html.as_uri()],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            time.sleep(0.5)
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/json" % PORT, timeout=3) as r:
                    if json.loads(r.read().decode()):
                        break
            except Exception:
                continue
        drv = m1.CdpDriver(PORT, timeout=25)
        drv.connect()
        eng = m2.ClickEngine(drv, dry_run=True)
        eng.fix_viewport(vw, vh)
        time.sleep(0.5)
        recs = eng.record_coords(["#act", "#side", "#box"])
        out = {"viewport": [vw, vh], "records": recs, "selfcheck": {}}
        for k, rec in recs.items():
            try:
                eng.click_point(rec, require_effect=False)
                out["selfcheck"][k] = "ok"
            except Exception as exc:  # noqa: BLE001
                out["selfcheck"][k] = "%s: %s" % (type(exc).__name__, exc)
        eng.clear_viewport()
        drv.close()
        return out
    finally:
        proc.terminate()


def main() -> int:
    html = TMP / "canary.html"
    if not html.is_file():
        print("[SKIP] canary.html 不存在（先跑 vm_item11b.py）")
        return 2

    print("=== 宿主 2560x1600 视口 ===")
    a = record(html, 2560, 1600)
    for k, v in a["records"].items():
        print("  %-7s x=%-6s y=%-6s sig=%s  self=%s"
              % (k, v["x"], v["y"], json.dumps(v["sig"], ensure_ascii=False),
                 a["selfcheck"][k]))

    print("\n=== 宿主 1920x1080 视口（同机不同视口）===")
    b = record(html, 1920, 1080)
    for k, v in b["records"].items():
        print("  %-7s x=%-6s y=%-6s sig=%s  self=%s"
              % (k, v["x"], v["y"], json.dumps(v["sig"], ensure_ascii=False),
                 b["selfcheck"][k]))

    vmfile = TMP / "vm_coords.json"
    if not vmfile.is_file():
        print("[SKIP] vm_coords.json 不在，无法跨机对比")
        return 2
    c = json.loads(vmfile.read_text(encoding="utf-8"))
    print("\n=== VM 1024x768 视口 ===")
    for k, v in c["records"].items():
        print("  %-7s x=%-6s y=%-6s sig=%s  self=%s"
              % (k, v["x"], v["y"], json.dumps(v["sig"], ensure_ascii=False),
                 c["selfcheck"][k]))

    print("\n=== 判据 ===")
    fails = []
    hosts = [("VM 1024x768", c), ("宿主 2560x1600", a), ("宿主 1920x1080", b)]

    print("  1) 自洽")
    for name, d in hosts:
        bad = {k: v for k, v in d["selfcheck"].items() if v != "ok"}
        print("     %-16s %s" % (name, "全部命中" if not bad else "异常 %s" % bad))
        if bad:
            fails.append("%s 自洽失败" % name)

    print("  2) 语义一致（sig 跨机相同）")
    keys = [k for k in c["records"] if all(k in d["records"] for _, d in hosts)]
    for k in keys:
        sigs = [json.dumps(d["records"][k]["sig"], ensure_ascii=False, sort_keys=True)
                for _, d in hosts]
        same = len(set(sigs)) == 1
        print("     %-7s %s   %s" % (k, "一致" if same else "**不一致**", sigs[0][:70]))
        if not same:
            fails.append("%s 签名跨机不一致" % k)

    print("  3) 保护有效（跨机套用旧坐标必须被拦）")
    m1, m2 = load()
    # 必须选一个**坐标真的随视口变化**的目标：
    #   #act  用 left:120px  -> 三处都是 (210,242)，本来就不该报漂移
    #   #side 用 right:24px  -> 2466 / 1826 / 930，这才是跨机差异所在
    drifting = [k for k in keys
                if len({(d["records"][k]["x"], d["records"][k]["y"]) for _, d in hosts}) > 1]
    if not drifting:
        print("[FAIL] 没有任何目标坐标随视口变化，这个测试不成立")
        return 1
    pick = drifting[0]
    print("     选坐标确实会变的目标: %s  各处坐标=%s"
          % (pick, [(n, (d["records"][pick]["x"], d["records"][pick]["y"]))
                     for n, d in hosts]))

    profile = TMP / "edge-host-profile"
    proc = subprocess.Popen(
        [EDGE, "--headless=new", "--disable-gpu",
         "--remote-debugging-port=%d" % PORT,
         "--user-data-dir=%s" % profile,
         "--no-first-run", "--no-default-browser-check", html.as_uri()],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            time.sleep(0.5)
            try:
                with urllib.request.urlopen("http://127.0.0.1:%d/json" % PORT, timeout=3) as r:
                    if json.loads(r.read().decode()):
                        break
            except Exception:
                continue
        drv = m1.CdpDriver(PORT, timeout=25)
        drv.connect()
        eng = m2.ClickEngine(drv, dry_run=True)
        eng.fix_viewport(2560, 1600)
        time.sleep(0.5)
        vmrec = dict(c["records"][pick])
        print("     拿 VM 的坐标 %s 去 2560 视口点 ..." % json.dumps({"x": vmrec["x"], "y": vmrec["y"]}))
        try:
            eng.click_point(vmrec, require_effect=False)
            print("[FAIL] VM 坐标在宿主机视口上竟然命中（该位置恰好有同签名元素？）")
            fails.append("跨机坐标未被拦截")
        except m2.ClickError as exc:
            msg = str(exc)
            if "漂移" in msg or "drift" in msg.lower():
                print("     %s 正确报漂移: %s" % (pick, msg[:100]))
            else:
                print("[FAIL] 报的不是漂移: %s" % msg)
                fails.append("报错类型不符")
        eng.clear_viewport()
        drv.close()
    finally:
        proc.terminate()

    print()
    if fails:
        print("[FAIL] " + "; ".join(fails))
        return 1
    print("[PASS] 3 台/视口各自自洽 + 签名跨机一致 + 跨机坐标被拦")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
