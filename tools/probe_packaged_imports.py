#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_packaged_imports.py —— 验证「做成一自体包」时，tools/ 下的脚本会不会失效。

要回答的问题：`gui.py` 用 ``importlib`` **按路径**加载 ``tools/cdp_driver.py``，
而 ``cdp_driver.click()`` 里有一行裸导入 ``from click_engine import ClickEngine``。
裸导入只认 ``sys.path``。如果加载时没把 ``tools/`` 塞进 ``sys.path``，那一行必然 ImportError。

而 `build_payload.py` 目前**没有把 click_engine.py / rpa_fixture.py 收进 payload**，
所以自体包里这一行会直接炸 —— 除非改成按路径加载。

用法::

    python tools/probe_packaged_imports.py

退出码：0 = 所有 tools/ 之间的互相引用都能在「不加入 sys.path」的前提下解析；1 = 有裸导入。
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"

#: tools/ 下会被 payload 或驱动层按路径加载的脚本
TOOLS_MODULES = {p.stem for p in TOOLS.glob("*.py")}

#: 标准库白名单（粗略：只判断「是不是 tools/ 里的另一个模块」）
def is_tools_module(name: str) -> bool:
    return name.split(".")[0] in TOOLS_MODULES


def imports_of(path: Path) -> list[tuple[int, str]]:
    """返回 [(行号, 模块名)]，只取顶层 import / from-import。"""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError as exc:
        return [(-1, f"<语法错误: {exc}>")]
    out: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                out.append((node.lineno, alias.name))
        elif isinstance(node, ast.ImportFrom):
            if node.module and node.level == 0:
                out.append((node.lineno, node.module))
    return out


def main() -> int:
    problems: list[str] = []
    ok: list[str] = []

    for path in sorted(TOOLS.glob("*.py")):
        for lineno, mod in imports_of(path):
            if not is_tools_module(mod):
                continue
            # 裸导入：模块名 == tools/ 里的另一个模块，且不是 package 形式
            problems.append(
                f"{path.name}:{lineno}  裸导入 {mod!r}"
                f" —— 只有在 tools/ 进入 sys.path 时才成立")

    print(f"扫描 {len(list(TOOLS.glob('*.py')))} 个 tools/ 脚本")
    print()
    if problems:
        print(f"发现 {len(problems)} 处 tools/ 内部裸导入：")
        for line in problems:
            print(f"  {line}")
    else:
        print("没有 tools/ 内部裸导入。")

    # 检查 payload 是否收了被引用的脚本
    print()
    payload = (TOOLS / "build_payload.py").read_text(encoding="utf-8", errors="replace")
    print("payload 收录情况：")
    for name in ("click_engine.py", "cdp_driver.py", "uia_driver.py",
                 "rpa_fixture.py", "suite_launcher.py", "workflow_cli.py"):
        included = name in payload
        mark = "收" if included else "**未收**"
        print(f"  {name:<22} {mark}")
        if not included and name != "rpa_fixture.py":
            ok.append(name)

    print()
    if problems:
        print("结论：自体包里这行会 ImportError。必须改成按路径加载。")
        return 1
    print("结论：tools/ 内部没有裸导入，可安全按路径加载。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
