#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_popup_dom.py —— 把 Update application 弹窗里的 DOM 结构打出来。

用途：`gui.app.update` 的 `verify_popup` 只断言正文文案；但真正点「更新」需要知道
**应用卡片**的真实选择器（卡片选中前 Update 按钮是禁用态）。这个探针把可见的
弹窗容器、卡片类名、按钮 id 一次性列出来，避免对着猜测写选择器。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
import importlib.util as _iu  # noqa: E402

_spec = _iu.spec_from_file_location("_probe_cdp3", TOOLS / "cdp_driver.py")
_cdp = _iu.module_from_spec(_spec)
sys.modules["_probe_cdp3"] = _cdp
_spec.loader.exec_module(_cdp)

PROBE = r"""JSON.stringify((() => {
  const visible = (n) => {
    if (!n) return false;
    const s = getComputedStyle(n);
    const r = n.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.height > 0;
  };
  const containers = [...document.querySelectorAll('[class*=popup],[class*=modal],[class*=dialog],[id*=popup],[id*=modal]')]
    .filter(visible)
    .map(n => ({tag: n.tagName, id: n.id || null,
                cls: String(n.className || '').slice(0, 80),
                text: (n.innerText || '').trim().slice(0, 100)}));
  const cards = [...document.querySelectorAll('[class*=card],[class*=appFullName],[class*=app-name]')]
    .filter(visible)
    .map(n => ({tag: n.tagName, id: n.id || null,
                cls: String(n.className || '').slice(0, 80),
                text: (n.innerText || '').trim().slice(0, 80)}));
  const buttons = [...document.querySelectorAll('button,[role=button]')]
    .filter(visible)
    .map(n => ({id: n.id || null, cls: String(n.className || '').slice(0, 60),
                text: (n.innerText || '').trim().slice(0, 40),
                disabled: !!n.disabled}));
  const body = (document.body ? document.body.innerText : '')
    .split('\n').map(s => s.trim()).filter(Boolean).slice(0, 25);
  return {containers: containers.slice(0, 6), cards: cards.slice(0, 12),
          buttons: buttons.slice(0, 15), body};
})())"""


def main() -> int:
    driver = _cdp.CdpDriver(9223)
    driver.connect()
    try:
        raw = driver.evaluate(PROBE)
    finally:
        driver.close()
    data = json.loads(raw) if isinstance(raw, str) else raw
    for key in ("containers", "cards", "buttons", "body"):
        print(f"=== {key} ===")
        print(json.dumps(data.get(key), ensure_ascii=False, indent=1))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
