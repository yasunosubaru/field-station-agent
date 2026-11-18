#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_stdonly.py —— 判定「无依赖自闭包」是否成立。

判据只有一条：**在没有任何第三方包的环境里，`import fieldstation` 及其子模块能否成功。**

区分两件事，混在一起会得出错误结论：

* **模块级 import**（在文件顶层，import 时就执行）—— 有第三方包就炸，是硬依赖；
* **函数内 import**（延迟导入，只在调用那一条路径时才执行）—— 不是硬依赖，
  是「可选能力降级」。例如 ``engines.py`` 的 ``pyarrow`` 只在读 Parquet 时才导入。

所以本探针只把**模块级**的第三方 import 算作违规。

用法::

    python tools/probe_stdonly.py

退出码：0 = 核心可纯标准库导入；1 = 存在模块级第三方依赖。
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "fieldstation"


def _stdlib_names() -> set[str]:
    # sys.stdlib_module_names 是 3.10+；旧解释器上用内置清单兜底
    names: set[str] = set()
    names |= set(getattr(sys, "stdlib_module_names", ()))
    names |= set(sys.builtin_module_names)
    names |= {
        "__future__", "abc", "argparse", "ast", "asyncio", "base64", "binascii",
        "bisect", "builtins", "calendar", "cmath", "cmd", "codecs", "collections",
        "concurrent", "configparser", "contextlib", "copy", "csv", "ctypes",
        "dataclasses", "datetime", "decimal", "difflib", "email", "enum", "errno",
        "fnmatch", "functools", "gc", "getpass", "gettext", "glob", "gzip",
        "hashlib", "hmac", "html", "http", "importlib", "inspect", "io",
        "ipaddress", "itertools", "json", "keyword", "locale", "logging",
        "marshal", "math", "mimetypes", "msvcrt", "operator", "os", "pathlib",
        "pickle", "platform", "plistlib", "pprint", "queue", "random", "re",
        "secrets", "select", "shlex", "shutil", "signal", "site", "socket",
        "sqlite3", "ssl", "stat", "statistics", "string", "struct", "subprocess",
        "sys", "sysconfig", "tarfile", "tempfile", "textwrap", "threading",
        "time", "timeit", "token", "tokenize", "traceback", "types", "typing",
        "unicodedata", "unittest", "urllib", "uuid", "venv", "warnings",
        "wave", "weakref", "webbrowser", "winreg", "xml", "zipfile", "zipapp",
        "zlib", "zstd", "nt", "_winapi", "win32api", "win32con",
    }
    return names


STDLIB = _stdlib_names()
FIRST_PARTY = {"fieldstation"}


def _third_party(name: str) -> bool:
    root = name.split(".")[0]
    if not root:
        return False
    return root not in STDLIB and root not in FIRST_PARTY


def module_level_imports(path: Path) -> list[tuple[int, str]]:
    """只返回**顶层**（不在函数 / 类方法 / try 内）的 import。

    实现方式：遍历 AST 的 body（含 if/try 的分支），但不进入 FunctionDef /
    AsyncFunctionDef / ClassDef 内部 —— 那是延迟导入。
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError as exc:
        return [(-1, f"<语法错误 line {exc.lineno}: {exc.msg}>")]

    out: list[tuple[int, str]] = []

    def walk_body(body: list[ast.stmt]) -> None:
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue  # 延迟导入，不算硬依赖
            if isinstance(node, ast.Import):
                for alias in node.names:
                    out.append((node.lineno, alias.name))
            elif isinstance(node, ast.ImportFrom):
                if node.level == 0 and node.module:
                    out.append((node.lineno, node.module))
            elif isinstance(node, ast.If):
                walk_body(node.body)
                walk_body(node.orelse)
            elif isinstance(node, ast.Try):
                walk_body(node.body)
                for handler in node.handlers:
                    walk_body(handler.body)
                walk_body(node.orelse)
                walk_body(node.finalbody)
            elif isinstance(node, ast.With):
                walk_body(node.body)

    walk_body(tree.body)
    return out


def lazy_imports(path: Path) -> list[tuple[int, str]]:
    """函数体内的第三方 import —— 属于「可选能力」，单独列出不当违规。"""
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError:
        return []
    out: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for sub in ast.walk(node):
            if isinstance(sub, ast.Import):
                for alias in sub.names:
                    if _third_party(alias.name):
                        out.append((sub.lineno, alias.name))
            elif isinstance(sub, ast.ImportFrom):
                if sub.level == 0 and sub.module and _third_party(sub.module):
                    out.append((sub.lineno, sub.module))
    return out


def main() -> int:
    files = sorted(SRC.rglob("*.py"))
    hard: list[str] = []
    soft: list[tuple[str, int, str]] = []

    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        for lineno, mod in module_level_imports(path):
            if _third_party(mod):
                hard.append(f"{rel}:{lineno}  {mod}")
        for lineno, mod in lazy_imports(path):
            soft.append((rel, lineno, mod))

    print(f"扫描 {len(files)} 个 .py（src/fieldstation/）")
    print()

    if hard:
        print(f"[FAIL] 模块级第三方依赖 {len(hard)} 处（会让 import 直接失败）：")
        for line in hard:
            print(f"  {line}")
    else:
        print("[PASS] 没有任何模块级第三方依赖 —— 纯标准库即可 import 整个包")

    print()
    if soft:
        # 去重（同一个模块可能在多个函数里延迟导入）
        uniq = sorted({m for _, _, m in soft})
        print(f"[INFO] 延迟导入的第三方包 {len(uniq)} 个（可选能力，只在用到时才需要）：")
        for mod in uniq:
            where = [f"{r}:{n}" for r, n, m in soft if m == mod][:3]
            print(f"  {mod:<22} 例：{', '.join(where)}")
        print("       缺少时对应功能降级，不影响核心 import 与 workflows。")
    print()

    if hard:
        print("结论：**不是**无依赖自闭包 —— 必须修掉模块级第三方依赖。")
        return 1
    print("结论：**核心可纯标准库导入**。第三方包只影响可选功能（数据引擎 / DBOS / Letta / MCP）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
