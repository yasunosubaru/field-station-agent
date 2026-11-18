#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_update_banner.py —— 检查首页横幅是否出现「有更新」。

## 为什么需要它

`gui.app.update` 这条流程的**场景依赖真实数据**：首页横幅只有在
“已装版本 < 远端版本”时才显示。本机原本两者都是 `0.2.0`（0 个更新），
所以整页找不到 `Update application` 节点 —— 这不是流程写错，是没场景。

造场景的办法（已核实来源，不是猜）：
  1. 远端的真实期望版本：
     https://0ne5u3ryyg.execute-api.ap-south-1.amazonaws.com/stageNonCoreAppDetails/fnNonCoreAppDetails?IsDev=F
     返回 `{"perceptionViewer":{"AppVersion":"0.2.0"}, "manage2":{"AppVersion":"2.2.0"}}`
  2. 本机已装版本在
     `%APPDATA%\\NovAtelApplicationSuite\\userSettings.json`
     的 `app.addedAppDetails.<app>.version`
  3. 判定逻辑见 `逆向/01_解包/app/model/serverModel.js::handleUpdateForNonCoreApps`
     —— 逐应用比较 `isUpdateAvailable(current, latest)`，计数写进
     `NONCORE_APP_VERSION_MSG` 的 %1。

所以把本地版本改成更低的合法三段式（如 0.1.0）即可让 updateCount ≥ 1。

## 本探针读什么

* 「Updates are available for N Applications」里的 N（正文）
* `.noncore-app-update-banner` 是否 display:block
* `#new-noncore-app-version-updatebtn` 是否存在

## 用法

    python tools/probe_update_banner.py
    python tools/probe_update_banner.py --port 9223

退出码：0 场景成立（N ≥ 1 且横幅可见）；1 不成立。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

import importlib.util as _iu  # noqa: E402

_spec = _iu.spec_from_file_location("_probe_cdp", TOOLS / "cdp_driver.py")
if _spec is None or _spec.loader is None:
    raise SystemExit("找不到 tools/cdp_driver.py")
_cdp = _iu.module_from_spec(_spec)
sys.modules["_probe_cdp"] = _cdp
_spec.loader.exec_module(_cdp)

#: 页面里「有更新」横幅相关的选择器。与 updateApplication.js / autoUpdates.js 一致。
QUERY = """JSON.stringify((() => {
  const banner = document.querySelector('.noncore-app-update-banner');
  const btn = document.querySelector('#new-noncore-app-version-updatebtn');
  const msg = document.querySelector('[data-lang-noncore-app-version-msg1]');
  const text = document.body ? document.body.innerText : '';
  const m = /Updates are available for (\\d+) Applications/i.exec(text);
  return {
    banner_present: !!banner,
    banner_display: banner ? getComputedStyle(banner).display : null,
    update_button: !!btn,
    count: m ? Number(m[1]) : null,
    count_text: msg ? msg.innerText : null,
  };
})())"""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=9223)
    args = ap.parse_args(argv)

    driver = _cdp.CdpDriver(args.port)
    driver.connect()
    try:
        raw = driver.evaluate(QUERY)
        info = json.loads(raw) if isinstance(raw, str) else raw
    finally:
        driver.close()

    print(f"  banner_present : {info['banner_present']}")
    print(f"  banner_display : {info['banner_display']}")
    print(f"  update_button  : {info['update_button']}")
    print(f"  count          : {info['count']}")
    print(f"  count_text     : {info['count_text']}")

    updates = info["count"] or 0
    visible = info["banner_display"] not in (None, "none")
    if updates >= 1 and visible:
        print(f"\n  场景成立：{updates} 个应用有更新，横幅可见。")
        return 0
    reasons = []
    if updates < 1:
        reasons.append(f"updateCount={updates}（本地版本不低于远端）")
    if not visible:
        reasons.append(f"横幅 display={info['banner_display']}")
    print("\n  场景不成立：" + "；".join(reasons))
    return 1


if __name__ == "__main__":
    sys.exit(main())
