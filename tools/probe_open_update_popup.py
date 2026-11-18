#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_open_update_popup.py —— 点开 Update application 弹窗并读出正文。

## 用途

`gui.app.update` 里 `open_popup` 是 human_gate：这一步以前「只能人工」的原因是
横幅条件性显示 + 更新清单来自 AWS。但点开弹窗**本身是网页元素操作**，CDP 能做：

    · 首页顶部横幅按钮 `#new-noncore-app-version-updatebtn`
    · 或者文案含「New noncore app version available」

所以这个探针把「造好场景之后怎么真的打开弹窗」自动化，供闸门批准前核对。

## 读什么

弹窗正文的真实文案是 `Select the application(s) to update`（与
`workflows/gui.app.update.yaml::verify_popup` 的断言一致）。
同时列出弹窗内可点的应用卡片，便于确认 `params.application` 在里面。

## 用法

    python tools/probe_open_update_popup.py --check          # 只看有没有横幅
    python tools/probe_open_update_popup.py                  # 点开并读正文
    python tools/probe_open_update_popup.py --port 9223
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import importlib.util as _iu  # noqa: E402

_spec = _iu.spec_from_file_location("_probe_cdp2", TOOLS / "cdp_driver.py")
if _spec is None or _spec.loader is None:
    raise SystemExit("找不到 tools/cdp_driver.py")
_cdp = _iu.module_from_spec(_spec)
sys.modules["_probe_cdp2"] = _cdp
_spec.loader.exec_module(_cdp)

BANNER_QUERY = """JSON.stringify((() => {
  const btn = document.querySelector('#new-noncore-app-version-updatebtn');
  const banner = document.querySelector('.noncore-app-update-banner');
  const text = document.body ? document.body.innerText : '';
  const m = /Updates are available for (\\d+) Applications/i.exec(text);
  return {
    button: !!btn,
    button_display: btn ? getComputedStyle(btn).display : null,
    banner_display: banner ? getComputedStyle(banner).display : null,
    count: m ? Number(m[1]) : null,
  };
})())"""

POPUP_QUERY = """JSON.stringify((() => {
  const text = document.body ? document.body.innerText : '';
  const hit = text.includes('Select the application(s) to update');
  const cards = [...document.querySelectorAll('.app-card-container .appFullName, .app-card-container [class*=appName]')]
    .map(n => (n.innerText || '').trim()).filter(Boolean).slice(0, 12);
  return { open: hit, cards,
           modal_visible: !!document.querySelector('#popupModal.appInstallerPopup') };
})())"""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=9223)
    ap.add_argument("--check", action="store_true", help="只看横幅，不点")
    args = ap.parse_args(argv)

    driver = _cdp.CdpDriver(args.port)
    driver.connect()
    try:
        raw = driver.evaluate(BANNER_QUERY)
        banner = json.loads(raw) if isinstance(raw, str) else raw
        print(f"  banner button : {banner['button']}  display={banner['button_display']}")
        print(f"  banner div    : display={banner['banner_display']}")
        print(f"  updateCount   : {banner['count']}")

        if args.check:
            return 0 if (banner["count"] or 0) >= 1 else 1

        if not banner["button"]:
            print("\n  没有横幅按钮 —— 场景未成立（用 probe_update_banner.py 先确认 count≥1）")
            return 1

        # 点开：优先用真实鼠标路径（click 走 click_engine），失败再退到 DOM click。
        try:
            driver.click("#new-noncore-app-version-updatebtn")
            how = "cdp-click"
        except Exception as exc:  # noqa: BLE001
            driver.evaluate(
                "(() => { const b = document.querySelector('#new-noncore-app-version-updatebtn');"
                " if (b) b.click(); })()")
            how = f"dom-click({type(exc).__name__})"
        print(f"  clicked       : {how}")

        import time
        info = {}
        for _ in range(30):
            time.sleep(0.3)
            raw2 = driver.evaluate(POPUP_QUERY)
            info = json.loads(raw2) if isinstance(raw2, str) else raw2
            if info.get("open"):
                break
    finally:
        driver.close()

    print(f"  popup open    : {info.get('open')}")
    print(f"  modal visible : {info.get('modal_visible')}")
    print(f"  cards         : {info.get('cards')}")
    if info.get("open"):
        print("\n  弹窗已打开，正文含 'Select the application(s) to update'。")
        return 0
    print("\n  弹窗没打开或正文不含预期文案。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
