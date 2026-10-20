#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""env_snapshot.py —— 把「这次是在什么环境里跑的」变成可入库的 JSON（M7-3 的一部分）。

记录：Python 版本/实现、操作系统（system / release / machine）、git commit 与工作区
是否干净、入库 `.py` 的第三方 import 清单（按 `sys.stdlib_module_names` 过滤）、
provider 配置里的模型与确定性选项。

**不记录**：本机绝对路径、用户名、主机名、环境变量值（可能含密钥）、venv 路径。
输出可以直接提交进公开仓库；`tests/test_env_snapshot.py` 钉住「不含绝对路径」。

它不是基线：环境快照本来就会随机器变。基线是 M5 的 fixture/日志（REPRODUCE §3.5）。

用法：

    python tools/env_snapshot.py                       # 写 logs/env_snapshot_<日期>.json
    python tools/env_snapshot.py --out <路径>
    python tools/env_snapshot.py --root <仓库根>

退出码：0 生成完成；2 用法错误 / 不是 git 仓库。
"""
from __future__ import annotations

import argparse
import ast
import json
import platform
import subprocess
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCAN_DIRS = ("src", "tools", "harness", "tests")


def _git(root: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(root), *args],
                            capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败：{root}")
    return result.stdout.decode("utf-8", "replace").strip()


def third_party_imports(root: Path) -> list[str]:
    """入库 .py 里 import 的第三方顶层模块（排除标准库与仓库内模块）。"""
    local = {path.stem for name in SCAN_DIRS for path in (root / name).rglob("*.py")}
    local |= set(SCAN_DIRS) | {"fieldstation"}
    found: set[str] = set()
    for name in SCAN_DIRS:
        for path in (root / name).rglob("*.py"):
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            except (OSError, SyntaxError, UnicodeDecodeError):
                continue
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    modules = [node.module]
                else:
                    continue
                for module in modules:
                    top = module.split(".")[0]
                    if top and top not in sys.stdlib_module_names and top not in local:
                        found.add(top)
    return sorted(found)


def model_channel(root: Path) -> list[dict]:
    """provider 名称 + 模型 + 确定性选项；**不含 url**（可能带本机地址）。"""
    path = root / "config" / "providers.json"
    if not path.is_file():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    providers = data.get("providers") or {}
    out = []
    for name in sorted(providers):
        cfg = providers[name] or {}
        entry = {"name": name}
        for key in ("model", "think", "temperature", "seed", "num_ctx"):
            value = cfg.get(key, (cfg.get("options") or {}).get(key))
            if value is not None:
                entry[key] = value
        out.append(entry)
    return out


def collect(root: Path) -> dict:
    # dirty 只统计**已跟踪文件**的改动：快照本身在生成时还是未跟踪文件，
    # 若把未跟踪也算进去，每份快照都会写 dirty=true。
    dirty = bool(_git(root, "status", "--porcelain", "--untracked-files=no"))
    third_party = third_party_imports(root)
    return {
        "kind": "fieldstation.env_snapshot",
        "version": 1,
        "python": {
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
        },
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "git": {"commit": _git(root, "rev-parse", "HEAD"), "dirty": dirty},        "dependencies": {
            "third_party_imports": third_party,
            # 测试与门禁只依赖标准库：第三方 import 全部是可选工具（当前只有 matplotlib）
            "tests_use_third_party": False,
            "note": ("third_party_imports 全部来自可选工具；"
                     "unittest / selftest / 回放 / 审计 / 看板 / 脱敏守卫均只用标准库"),
        },
        "model_channel": model_channel(root),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="环境快照（M7-3）")
    parser.add_argument("--root", default=str(ROOT))
    parser.add_argument("--out",
                        default=str(ROOT / "logs" /
                                    f"env_snapshot_{date.today():%Y%m%d}.json"))
    args = parser.parse_args(argv)

    root = Path(args.root)
    try:
        snapshot = collect(root)
    except (RuntimeError, OSError, json.JSONDecodeError) as exc:
        print(f"[阻断] {exc}")
        return 2

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(snapshot, ensure_ascii=False, indent=2,
                                sort_keys=True) + "\n")
    print(f"[OK] 环境快照 {out.name}：Python {snapshot['python']['version']} / "
          f"{snapshot['platform']['system']} / commit {snapshot['git']['commit'][:12]} / "
          f"第三方 import {snapshot['dependencies']['third_party_imports']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
