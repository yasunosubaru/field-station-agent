#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_path_load.py —— 验证 tools/ 里的脚本能在「不在 sys.path」的前提下加载。

## 为什么要单独一个探针

`tools/probe_packaged_imports.py` 只是**静态**扫描（看有没有裸导入）。静态通过
不代表能跑：改写后的 `_fsa_load_sibling(...)` 可能写错名字、`sys.modules` 注册
遗漏、或者目标模块自己又裸导入了别的东西。

这个探针用**和打包后完全一样的方式**加载：`spec_from_file_location`，
并且先把仓库根和 `tools/` 从 `sys.path` 里摘掉。

## 用法

    python tools/probe_path_load.py

退出码：0 全部可加载；1 有失败。
"""
from __future__ import annotations

import importlib.util
import os
import sys
import traceback
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
REPO = TOOLS.parent

#: 需要验证的模块。都是「会被按路径加载」的入口，或反过来按路径加载别人的模块。
TARGETS = (
    "rpa_fixture.py",
    "rpa_calibrate.py",
    "probe_cdp_click.py",
    "probe_cdp_viewport.py",
    "agent_server.py",
    "check_agent_specs.py",
    "cdp_driver.py",
    "click_engine.py",
    "rpa_lint.py",
    "ensure_virtual_display.py",
    "build_payload.py",
    "fix_bare_imports.py",
)


def load(source: Path, alias: str):
    spec = importlib.util.spec_from_file_location(alias, source)
    if spec is None or spec.loader is None:
        raise ImportError(f"spec_from_file_location 失败: {source}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[alias] = module
    spec.loader.exec_module(module)
    return module


def main() -> int:
    # 模拟打包后：仓库根与 tools/ 都不在 sys.path 上
    for entry in (str(REPO), str(TOOLS), os.path.dirname(str(TOOLS))):
        while entry in sys.path:
            sys.path.remove(entry)

    failures: list[str] = []
    for name in TARGETS:
        path = TOOLS / name
        if not path.is_file():
            print(f"  skip  {name}  (不存在)")
            continue
        alias = f"_probe_{name[:-3]}"
        try:
            load(path, alias)
            print(f"  OK    {name}")
        except SystemExit:
            # 脚本在 import 期就 sys.exit 也算正常（它自己拒绝被当模块导入）
            print(f"  OK    {name}  (sys.exit at import)")
        except Exception as exc:  # noqa: BLE001
            failures.append(name)
            print(f"  FAIL  {name}  {type(exc).__name__}: {exc}")
            if os.environ.get("PROBE_TRACE"):
                traceback.print_exc()

    print()
    if failures:
        print(f"{len(failures)} 个模块在「不在 sys.path」前提下加载失败：{', '.join(failures)}")
        return 1
    print("全部按路径可加载 —— 打包后不会 ImportError。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
