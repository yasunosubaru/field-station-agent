#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_workflow_steps.py —— 打印每条流程的步骤种类序列，供验收核对。

它回答一个具体问题：**`restore_home` / `ensure_display` 到底插进去了没有、插在哪。**
光看 `validate` 通过不够 —— 语法合法但顺序错的流程照样能 validate。

顺序约定（tools/add_home_step.py 的模块文档）：`health` 必须在最前（判「服务在不在」），
然后 `restore_home`（清残留，需要驱动在线），再 `ensure_display`（校验几何基准），
最后才是第一个界面动作。

退出码：0 全部符合约定；1 有流程不符合。
"""
from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "src"))

from fieldstation.workflows import spec  # noqa: E402

WORKFLOWS = REPO / "workflows"

#: 这些流程不碰界面，不要求几何步骤。
GUI_PREFIXES = ("gui.",)


def main() -> int:
    bad: list[str] = []
    for path in sorted(WORKFLOWS.glob("*.yaml")):
        try:
            wf = spec.load_spec(path)
        except Exception as exc:  # noqa: BLE001
            print(f"  {path.name:<28} 加载失败 {exc}")
            bad.append(path.name)
            continue
        kinds = [s["kind"] for s in wf.steps]
        ids = [s.get("id", "") for s in wf.steps]
        print(f"  {path.name:<28} {' -> '.join(kinds[:5])}")

        if not path.name.startswith(GUI_PREFIXES):
            continue
        problems = []
        if "restore_home" not in kinds:
            problems.append("缺 restore_home")
        if "ensure_display" not in kinds:
            problems.append("缺 ensure_display")
        if kinds and kinds[0] != "http":
            problems.append(f"第一步应为 http，实际 {kinds[0]}")
        if "restore_home" in kinds and "ensure_display" in kinds:
            i_home = kinds.index("restore_home")
            i_disp = kinds.index("ensure_display")
            if i_home > i_disp:
                problems.append("restore_home 应在 ensure_display 之前")
            # 几何步骤必须在第一个真正的界面动作之前
            gui_actions = {"click", "click_optional", "type", "select", "open", "read"}
            first_action = None
            for k, s in enumerate(wf.steps):
                if s["kind"] == "gui" and s.get("action") in gui_actions:
                    first_action = k
                    break
            if first_action is not None and first_action < max(i_home, i_disp):
                actions = ids[first_action]
                problems.append(f"界面动作 {actions!r} 出现在几何步骤之前")
        if problems:
            bad.append(path.name)
            for p in problems:
                print(f"      ! {p}")

    print()
    if bad:
        print(f"{len(bad)} 条流程不符合约定：{', '.join(bad)}")
        return 1
    print("全部 GUI 流程都带 restore_home + ensure_display，且顺序正确。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
