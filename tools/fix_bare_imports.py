#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fix_bare_imports.py —— 把 tools/ 内部的裸导入改成按文件路径加载。

## 为什么要改

`tools/probe_packaged_imports.py` 把这件事当硬门禁。原因（它自己写得很清楚）：

    cdp_driver.click() 里有一行裸导入 `from click_engine import ClickEngine`。
    裸导入只认 sys.path。如果加载时没把 tools/ 塞进 sys.path，那一行必然 ImportError。

源码树里能跑，是因为「脚本所在目录」会自动进 `sys.path`。但打成自包含包之后，
`gui.py` 是用 `importlib.util.spec_from_file_location` 按路径加载的，**不会**把
`tools/` 塞进去。所以打包前必须全部改成按路径加载。

## 采用的范式

沿用 `tools/cdp_driver.py::_load_click_engine` 已经验证过的那套：

    spec = importlib.util.spec_from_file_location("<唯一别名>", <同目录>/<模块>.py)
    module = importlib.util.module_from_spec(spec)
    sys.modules["<唯一别名>"] = module     # dataclasses 解析字符串注解要用（3.9 实测）
    spec.loader.exec_module(module)

`sys.modules` 那一步不是可选的：Python 3.9 的 dataclasses 在解析字符串注解时会去
`sys.modules` 里按 `cls.__module__` 找模块，不先注册就拿到 None，抛
`AttributeError: 'NoneType' object has no attribute '__dict__'`。

## 本脚本做什么

对每个目标文件：
  1. 在文件末尾（若还没有）追加 `_fsa_load_sibling(name)` 辅助函数；
  2. 把裸导入行替换成对这个函数的调用。

它**不猜语义**：只处理 `import X` / `from X import a, b` 且 `X` 是 tools/ 里的模块这一种形态。
改写结果是显式代码，不是运行期 hack，review 时一眼能看出加载了哪个文件。

## 用法

    python tools/fix_bare_imports.py --check     # 只报将要改什么
    python tools/fix_bare_imports.py             # 改写
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent

#: 追加到文件末尾的辅助函数。名字带 _fsa 前缀，避免和文件里已有符号撞名。
LOADER = '''

# --- 按路径加载同目录模块（打包后 sys.path 里没有 tools/）----------------------
# 由 tools/fix_bare_imports.py 生成。为什么不用裸导入、为什么必须写 sys.modules，
# 见那个脚本的模块文档（和 tools/cdp_driver.py::_load_click_engine 的实现）。
def _fsa_load_sibling(name: str):
    """加载与当前文件同目录的 ``<name>.py``，返回模块对象。"""
    import importlib.util as _iu
    import sys as _sys
    from pathlib import Path as _P

    alias = f"_fsa_tool_{name}"
    cached = _sys.modules.get(alias)
    if cached is not None:
        return cached
    path = _P(__file__).with_name(f"{name}.py")
    if not path.is_file():
        raise ImportError(f"同目录缺少 {name}.py（{path}）")
    spec = _iu.spec_from_file_location(alias, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载 {path}")
    module = _iu.module_from_spec(spec)
    # dataclasses 解析字符串注解时要靠 sys.modules 找到模块，必须先注册。
    _sys.modules[alias] = module
    spec.loader.exec_module(module)
    return module
'''

#: 目标文件 → 需要改的模块名集合（None = 只追加 loader，不改导入）
TARGETS: dict[str, tuple[str, ...]] = {
    "agent_server.py": ("agent_store", "eval30_judge"),
    "check_agent_specs.py": ("gen_agent_specs",),
    "probe_cdp_click.py": ("cdp_driver",),
    "probe_cdp_viewport.py": ("cdp_driver",),
    "rpa_calibrate.py": ("click_engine", "cdp_driver"),
    "rpa_fixture.py": ("click_engine", "cdp_driver"),
}

RE_FROM = re.compile(r"^(?P<indent>\s*)from\s+(?P<mod>\w+)\s+import\s+(?P<names>.+?)(?P<comment>\s*#.*)?$")
RE_IMPORT = re.compile(r"^(?P<indent>\s*)import\s+(?P<mod>\w+)\s+as\s+(?P<alias>\w+)(?P<comment>\s*#.*)?$")


def is_tools_module(name: str) -> bool:
    return (TOOLS / f"{name}.py").is_file()


def rewrite(path: Path, modules: tuple[str, ...], *, apply: bool) -> list[str]:
    """返回改动说明。apply=False 时只说明。"""
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    changes: list[str] = []

    for raw in lines:
        line = raw.rstrip("\r\n")
        eol = raw[len(line):]
        m = RE_FROM.match(line)
        if m and m.group("mod") in modules and is_tools_module(m.group("mod")):
            mod = m.group("mod")
            indent = m.group("indent")
            names = m.group("names").strip()
            # 支持 `a, b` 与 `(a, b, )` 两种写法
            cleaned = names.strip("()").replace("\n", " ")
            parts = []
            # 逐个 `X as Y` / `X` 拆分，保留多行续行里的反斜杠形式不做猜测，只提示
            for chunk in _split_names(cleaned):
                if " as " in chunk:
                    orig, alias = [s.strip() for s in chunk.split(" as ", 1)]
                    parts.append(f"{alias} = _{mod}_mod.{orig}")
                else:
                    parts.append(f"{chunk.strip()} = _{mod}_mod.{chunk.strip()}")
            new = f"{indent}_{mod}_mod = _fsa_load_sibling({mod!r}){eol}"
            for p in parts:
                new += f"{indent}{p}{eol}"
            out.append(new)
            changes.append(f"{path.name}: from {mod} import ... -> _fsa_load_sibling")
            continue

        m2 = RE_IMPORT.match(line)
        if m2 and m2.group("mod") in modules and is_tools_module(m2.group("mod")):
            mod, alias, indent = m2.group("mod"), m2.group("alias"), m2.group("indent")
            out.append(f"{indent}_{alias} = _fsa_load_sibling({mod!r}){eol}")
            changes.append(f"{path.name}: import {mod} as {alias} -> _fsa_load_sibling")
            continue

        out.append(raw)

    if not changes:
        return changes

    if apply:
        body = "".join(out)
        if "_fsa_load_sibling" not in text:
            body = body.rstrip("\r\n") + "\n" + LOADER
        # 3.9 的 Path.write_text 没有 newline= 参数（3.10 才有），用 open 保持换行原样。
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(body)
    return changes


def _split_names(text: str) -> list[str]:
    parts: list[str] = []
    depth = 0
    cur = ""
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            if cur.strip():
                parts.append(cur.strip())
            cur = ""
            continue
        cur += ch
    if cur.strip():
        parts.append(cur.strip())
    return parts


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="只报告，不改写")
    args = ap.parse_args(argv)

    all_changes: list[str] = []
    for name, mods in TARGETS.items():
        path = TOOLS / name
        if not path.is_file():
            print(f"跳过（不存在）: {name}")
            continue
        for line in rewrite(path, mods, apply=not args.check):
            all_changes.append(f"  {line}")

    if not all_changes:
        print("没有需要改的裸导入。")
        return 0
    print(("将修改：" if args.check else "已修改："))
    for c in all_changes:
        print(c)
    return 0


if __name__ == "__main__":
    sys.exit(main())
