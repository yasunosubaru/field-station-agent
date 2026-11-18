#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""probe_uia_script.py —— 校验 `tools/uia_driver.py` 内嵌的 PowerShell 脚本。

## 为什么需要这个探针

`_PS_SCRIPT` 是一个 Python 字符串，**三道常规检查都发现不了它的问题**：

| 检查 | 为什么发现不了 |
|---|---|
| `ast.parse` | 它只是字符串字面量，内容是 PowerShell |
| 人眼 review | 300+ 行 PowerShell，重点在别处 |
| `python` 里 import | 只证明字符串在，不证明 PowerShell 能解析 |

真实踩到的两次：

1. 在脚本里写了中文注释 → `_call` 用 `encoding="ascii"` 写文件时
   `UnicodeEncodeError`，UIA 驱动整个不可用；
2. 新增 `Wait-TopLevelWindow` 后没确认 `$seconds` 从哪来 → 运行时它是未定义变量，
   而字符串检查一切正常。

## 两个检查

* **纯 ASCII**：`_PS_SCRIPT.encode("ascii")` 必须成功。
* **语法可解析**：用 PowerShell 自己的解析器 `[System.Management.Automation.
  Language.Parser]::ParseInput()`，只解析、不执行。

第二条刻意用 `ParseInput` 而不是 `[scriptblock]::Create`：后者在 `-File` 模式下的
错误输出走 UTF-16，中文系统上会被读成乱码，看不出真正原因。`ParseInput` 能把
行号与消息以纯文本返回。

## 用法

    python tools/probe_uia_script.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))

# 用按路径加载，和打包后的加载方式一致 —— 这样本探针验证的就是「包里能不能跑」。
# 不能写 `from uia_driver import _PS_SCRIPT`：那要求 sys.path 里有 tools/，
# 而 `tools/probe_packaged_imports.py` 正是把这类写法当门禁拦下的。
import importlib.util as _importlib_util  # noqa: E402

_spec = _importlib_util.spec_from_file_location(
    "_probe_uia_driver", TOOLS / "uia_driver.py")
if _spec is None or _spec.loader is None:  # pragma: no cover - 只有文件缺失时
    raise SystemExit("找不到 tools/uia_driver.py")
_uia = _importlib_util.module_from_spec(_spec)
sys.modules["_probe_uia_driver"] = _uia
_spec.loader.exec_module(_uia)
_PS_SCRIPT = _uia._PS_SCRIPT

#: 脚本里必须出现的符号。少一个说明对应功能没接进 PowerShell 侧。
REQUIRED_SYMBOLS = (
    "function Wait-El",
    "function Wait-TopLevelWindow",
    "function Find-Desc",
    "function Invoke-El",
    "'dialog'",
    "'fill_dialog'",
    "UIA_SECONDS",
)

#: 只做语法解析的检查脚本。纯 ASCII；参数通过文件传，避免命令行编码问题。
CHECK_SCRIPT = (
    "$path = [IO.File]::ReadAllText($env:UIA_SRC, [Text.Encoding]::ASCII)\n"
    "$tokens = $null\n"
    "$errors = $null\n"
    "[void][System.Management.Automation.Language.Parser]::ParseInput("
    "$path, [ref]$tokens, [ref]$errors)\n"
    "if ($errors -and $errors.Count -gt 0) {\n"
    "  foreach ($e in $errors) {\n"
    "    Write-Output ('ERR ' + $e.Extent.StartLineNumber + ': ' + $e.Message)\n"
    "  }\n"
    "  exit 1\n"
    "}\n"
    "Write-Output 'SYNTAX_OK'\n"
)


def main() -> int:
    problems: list[str] = []

    # 1) 纯 ASCII
    try:
        data = _PS_SCRIPT.encode("ascii")
        print(f"  ASCII      : OK ({len(data)} bytes)")
    except UnicodeEncodeError as exc:
        problems.append(f"非 ASCII 字符（_call 用 encoding=ascii 写文件，会崩）：{exc}")
        print("  ASCII      : FAIL")

    # 2) 必备符号
    missing = [s for s in REQUIRED_SYMBOLS if s not in _PS_SCRIPT]
    if missing:
        problems.append(f"缺符号：{missing}")
        print(f"  symbols    : FAIL {missing}")
    else:
        print(f"  symbols    : OK ({len(REQUIRED_SYMBOLS)} 项)")

    if problems:
        # 字符串层已经不合格，没必要再起 PowerShell
        print()
        for p in problems:
            print(f"  ! {p}")
        return 1

    # 3) PowerShell 语法解析（只解析，不执行）
    with tempfile.TemporaryDirectory(prefix="uia-syntax-") as tmp:
        src = Path(tmp) / "uia-action.ps1"
        with open(src, "w", encoding="ascii", newline="\r\n") as fh:
            fh.write(_PS_SCRIPT)
        checker = Path(tmp) / "check.ps1"
        with open(checker, "w", encoding="ascii", newline="\r\n") as fh:
            fh.write(CHECK_SCRIPT)

        try:
            # 不要清空 PATH：PowerShell 自己加载模块要用它，清空会直接崩
            # （表现为 UTF-16 的 "PowerShell 已停止工作"，看起来像语法错误）。
            env = dict(os.environ)
            env["UIA_SRC"] = str(src)
            proc = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive",
                 "-ExecutionPolicy", "Bypass", "-File", str(checker)],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=120, env=env,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except FileNotFoundError:
            print("  syntax     : SKIP (没有 powershell.exe，非 Windows)")
            print()
            print("字符串层通过；语法检查需要 Windows。")
            return 0

        out = (proc.stdout or "").strip()
        errs = [ln for ln in out.splitlines() if ln.startswith("ERR ")]
        if proc.returncode == 0 and "SYNTAX_OK" in out:
            print("  syntax     : OK (PowerShell Parser 解析通过)")
        else:
            detail = "; ".join(errs) if errs else (out or (proc.stderr or ""))[:400]
            problems.append(f"PowerShell 解析失败：{detail}")
            print(f"  syntax     : FAIL {detail[:300]}")

    print()
    if problems:
        for p in problems:
            print(f"  ! {p}")
        return 1
    print("内嵌 PowerShell 脚本通过：纯 ASCII + 语法可解析 + 必备符号齐。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
