# -*- coding: utf-8 -*-
"""第 11 条实证：在 VM (1024x768/96dpi, Edge 157) 与宿主 (2560x1600/144dpi, 套件)
上，用**同一套** click_engine 记录/回读坐标，验证三件事：

  1. 各自自洽：本机记录的坐标，本机回读命中；
  2. 语义一致：同一目标的 sig（tag+文字）跨机器相同；
  3. **保护有效**：拿宿主的坐标去 VM 点，必须被 `_sig_matches` 判为坐标漂移。

第 3 条是这条验收的真正意义 —— 否则那套坐标保护等于不存在。

## 承载页

两边都加载同一个 `canary.html`：布局固定、元素语义固定，
坐标由各机自己的视口与 DPI 缩放决定。这就是「换机器」的干净复现。

## 坑（前面已实测）

  * VIX `runProgramInGuest` 的 `/c` 与命令必须是一个 argv；
  * guest stdout 不回传，必须让它写文件再 copyFileFromGuestToHost；
  * 所以这里把要跑的逻辑写成 .py，push 进 guest，用包内 python 执行。
"""
from __future__ import annotations

import base64
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(r"C:\Users\SunCh\AppData\Local\Temp\opencode")))
from vm_exec import push_and_run, vm  # noqa: E402

REPO = Path(r"H:\Archive\文件夹 老版\personal content\课程资料\其他\大创项目\野外台站智能体")
APP = REPO / "dist" / "AllPoweredFSA-v5" / "AllPoweredFSA-dir" / "resources" / "app"
TMP = Path(tempfile.gettempdir()) / "opencode"
VMX = r"C:\Users\SunCh\Documents\Virtual Machines\Windows 10 x64\Windows 10 x64.vmx"
G_ROOT = r"C:\fsa_vm"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

CANARY = """<!doctype html><meta charset="utf-8"><title>coord-canary</title>
<style>
 body{margin:0;font-family:Segoe UI}
 #box{position:absolute;left:40px;top:30px;width:220px;height:80px;
      border:2px solid #333;background:#eef;font-size:16px}
 #act{position:absolute;left:120px;top:220px;width:180px;height:44px;font-size:16px}
 #side{position:absolute;right:24px;top:24px;width:140px;height:34px;font-size:14px}
</style>
<div id="box">semantic-box</div>
<button id="act">canary-button</button>
<button id="side">corner-button</button>
"""

# 在任意一台机器上跑：起 Edge/CDP -> 记录坐标 -> 自洽回读 -> 导出 JSON
RECORDER = r'''# -*- coding: utf-8 -*-
"""在 guest 里跑：用包内 click_engine 记录 canary 页面的坐标。

用法: python record.py <html路径> <输出json> <viewport_w> <viewport_h>
"""
import importlib.util
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

html, out, vw, vh = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
port = 9333
profile = Path(os.environ["TEMP"]) / "edge-cdp-profile"
profile.mkdir(parents=True, exist_ok=True)

proc = subprocess.Popen([edge, "--headless=new", "--disable-gpu",
                         "--remote-debugging-port=%d" % port,
                         "--user-data-dir=%s" % profile,
                         "--no-first-run", "--no-default-browser-check",
                         Path(html).as_uri()],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def ws_urls():
    with urllib.request.urlopen("http://127.0.0.1:%d/json" % port, timeout=3) as r:
        return json.loads(r.read().decode())

try:
    for _ in range(60):
        time.sleep(0.5)
        try:
            pages = ws_urls()
        except Exception:
            continue
        if pages:
            break
    else:
        print(json.dumps({"error": "edge cdp never came up"}))
        sys.exit(1)

    sys.path.insert(0, str(Path(__file__).parent / "tools"))
    spec = importlib.util.spec_from_file_location(
        "_cdp", Path(__file__).parent / "tools" / "cdp_driver.py")
    cdpm = importlib.util.module_from_spec(spec)
    sys.modules["_cdp"] = cdpm
    spec.loader.exec_module(cdpm)
    spec2 = importlib.util.spec_from_file_location(
        "_ce", Path(__file__).parent / "tools" / "click_engine.py")
    ce = importlib.util.module_from_spec(spec2)
    sys.modules["_ce"] = ce
    spec2.loader.exec_module(ce)

    drv = cdpm.CdpDriver(port, timeout=25)
    drv.connect()
    eng = ce.ClickEngine(drv, dry_run=True)
    eng.fix_viewport(vw, vh)
    time.sleep(0.5)

    recs = eng.record_coords(["#act", "#side", "#box"])
    result = {"viewport": [vw, vh], "records": recs, "selfcheck": {}}
    for k, rec in recs.items():
        try:
            eng.click_point(rec, require_effect=False)
            result["selfcheck"][k] = "ok"
        except Exception as exc:
            result["selfcheck"][k] = "%s: %s" % (type(exc).__name__, exc)
    eng.clear_viewport()
    drv.close()
    Path(out).write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print("RECORDED", out)
finally:
    proc.terminate()
'''


def push_canary_and_recorder() -> tuple[str, str]:
    html_local = TMP / "canary.html"
    html_local.write_text(CANARY, encoding="utf-8")
    rec_local = TMP / "record_coords.py"
    rec_local.write_text(RECORDER, encoding="utf-8")

    gh = G_ROOT + r"\canary.html"
    gr = G_ROOT + r"\record_coords.py"
    vm("copyFileFromHostToGuest", VMX, str(html_local), gh)
    vm("copyFileFromHostToGuest", VMX, str(rec_local), gr)
    return gh, gr


def main() -> int:
    print("=== 1. 传 canary + recorder 进 VM ===")
    gh, gr = push_canary_and_recorder()
    rc, txt = push_and_run("fsa_has", [
        'if exist "%s" echo HTML_OK' % gh,
        'if exist "%s" echo REC_OK' % gr,
        'if exist "%s\\tools\\cdp_driver.py" echo CDP_OK' % G_ROOT,
        'if exist "%s\\tools\\click_engine.py" echo CE_OK' % G_ROOT,
    ])
    print("  " + txt.replace("\r", "").replace("\n", "  ").strip()[:200])

    print("\n=== 2. VM 里记录（1024x768 视口，96 DPI）===")
    rc, txt = push_and_run("fsa_rec", [
        'set "PYTHONIOENCODING=utf-8"',
        '"%s\\payload\\runtime\\python\\python.exe" "%s" "%s" "%s\\vm_coords.json" 1024 768'
        % (G_ROOT, gr, gh, G_ROOT),
        'echo ---OUT---',
        'type "%s\\vm_coords.json" 2>nul' % G_ROOT,
    ], timeout=600)
    print("  rc=%s" % rc)
    for ln in txt.splitlines():
        if ln.strip():
            print("  " + ln.strip()[:220])

    # 取回 JSON
    lo = TMP / "vm_coords.json"
    if lo.exists():
        lo.unlink()
    vm("copyFileFromGuestToHost", VMX, G_ROOT + r"\vm_coords.json", str(lo))
    if lo.exists():
        print("\n=== 3. VM 坐标（取回确认）===")
        print(lo.read_text(encoding="utf-8")[:900])
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    raise SystemExit(main())
