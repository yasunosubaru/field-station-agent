#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""deps_smoke.py —— v4 Python 依赖是否真的装上了的冒烟检查。

## 为什么需要这个

`requirements-v4.txt` 只证明"我们打算装这些"，不证明"这台机器上装上了"。v4 起
DuckDB / LangGraph / pydantic-ai / DBOS / LlamaIndex 都是**按需降级**的：
缺一个不该炸全链，但必须**当场说出来**，否则运行时会静默走到降级路径，
分数掉了没人知道为什么（ADR-009 §2 的降级梯度、W6「未装 langgraph 时
`pipeline.py` 照跑」都默认"缺了能被发现"）。

所以这里只做一件事：逐个 import，把**装的是哪个版本**打出来。版本号是关键 ——
"能 import"和"是我们在 requirements 里钉的那个版本"是两件事，后者才可复现。

## 判据

对每个包：`importlib.import_module(模块名)` 成功即算装上，版本优先取
`importlib.metadata`（装的是哪个发行版），取不到再退 `模块.__version__`。

**不在失败时抛异常**：import 阶段的 `ImportError` / `OSError`（Windows 上缺
DLL 很常见）/ 其他任何异常都就地捕获、记为 `fail` 并继续下一个，最后统一汇总。
冒烟工具自己崩掉，等于把"缺哪个"这条信息也一起吞掉了。

## 两档

| 档 | 查什么 | 用在哪 |
|---|---|---|
| `core` | 第一批四个：duckdb / langgraph / pydantic-ai / dbos | CI、任何门禁 |
| `all` | 再加 LlamaIndex 两个（第二批） | 本机自检 |

第二批是"尽力装"：装不上时 E6 知识检索整体不可用，但 E2/E3/E4 照跑。
所以默认 `all`、CI 钉 `--tier core`，不是默认放宽，而是分工不同。

## 用法

    .deps\\venv\\Scripts\\python.exe tools/deps_smoke.py
    .deps\\venv\\Scripts\\python.exe tools/deps_smoke.py --tier core
    .deps\\venv\\Scripts\\python.exe tools/deps_smoke.py --expect duckdb=2.0.0

`--expect 包=版本` 可重复，用来核对版本是否正是 requirements-v4.txt 钉的那个；
版本不符算 `fail`（等价于"装的不是我们验过的那一套"）。

## 退出码

- ``0``：查的包全部 import 成功（且给了 `--expect` 时版本相符）
- ``1``：有包缺失或版本不符，末尾列出缺哪个
"""

from __future__ import annotations

import argparse
import importlib
import sys
from importlib import metadata

# (发行版名, 模块名, 档位, 用途)
# 发行版名和 import 名不一样的地方都在这张表里说清楚：llama-index-core 的
# import 名是 llama_index.core，直接拿发行版名去 import 会失败。
PACKAGES = [
    ("duckdb", "duckdb", "core", "E4/E5 数据查询"),
    ("langgraph", "langgraph", "core", "E3 五阶段编排"),
    ("pydantic-ai", "pydantic_ai", "core", "E2 agent 运行时"),
    ("dbos", "dbos", "core", "E2 持久化执行"),
    ("llama-index-core", "llama_index.core", "all", "E6 知识索引"),
    ("llama-index-vector-stores-lancedb", "llama_index.vector_stores.lancedb", "all", "E6 向量库"),
]

TIERS = {"core": ["core"], "all": ["core", "all"]}


def _version(module_name: str, module: object) -> str:
    """装的是哪个发行版。取不到就退模块自带属性，再取不到就是 unknown。"""
    dist = module_name.split(".")[0].replace("_", "-")
    for name in (module_name, dist):
        try:
            return metadata.version(name)
        except Exception:  # noqa: BLE001 —— 版本取不到不算失败，继续退
            pass
    got = getattr(module, "__version__", None)
    return str(got) if got else "unknown"


def _check(module_name: str) -> tuple[str, str, str]:
    """返回 (状态, 版本, 说明)。任何异常都在这里收住，绝不外抛。"""
    try:
        module = importlib.import_module(module_name)
    except KeyboardInterrupt:
        raise
    except BaseException as exc:  # noqa: BLE001 —— 缺 DLL 的 OSError 也要报，不要炸
        return "fail", "-", f"{type(exc).__name__}: {exc}"
    return "ok", _version(module_name, module), ""


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="逐个 import v4 的 Python 依赖并打印版本，缺哪个就列出哪个。"
    )
    ap.add_argument(
        "--tier",
        choices=sorted(TIERS),
        default="all",
        help="core=第一批四个；all=再加 LlamaIndex 两个（默认）",
    )
    ap.add_argument(
        "--expect",
        action="append",
        default=[],
        metavar="PKG==VER",
        help="要求某个包的版本正好是这个值；可重复。v4 用它在 CI 上钉住版本",
    )
    args = ap.parse_args(argv)

    wanted = {}
    for item in args.expect:
        pkg, _, ver = item.partition("=")
        pkg = pkg.strip()
        ver = ver.strip().lstrip("=")
        if not pkg or not ver:
            print(f"--expect 用法是 包=版本，收到: {item}", file=sys.stderr)
            return 2
        wanted[pkg] = ver

    tiers = TIERS[args.tier]
    selected = [p for p in PACKAGES if p[2] in tiers]

    print(f"python: {sys.version.split()[0]}  ({sys.executable})")
    print(f"tier:   {args.tier}（{len(selected)} 个包）")
    print()
    print(f"{'package':<38} {'version':<14} {'status':<6} purpose")
    print("-" * 88)

    failed = []
    for dist, module_name, _tier, purpose in selected:
        status, version, detail = _check(module_name)
        if status == "ok" and dist in wanted and version != wanted[dist]:
            status, detail = "fail", f"版本应为 {wanted[dist]}，实际 {version}"
        print(f"{dist:<38} {version:<14} {status:<6} {purpose}")
        if status != "ok":
            failed.append((dist, module_name, detail))

    print("-" * 88)
    for dist, module_name in [(p[0], p[1]) for p in selected]:
        if dist in wanted and not any(f[0] == dist for f in failed):
            print(f"版本钉住: {dist} == {wanted[dist]}")

    if not failed:
        print(f"结果: {len(selected)}/{len(selected)} ok")
        return 0

    print(f"结果: {len(selected) - len(failed)}/{len(selected)} ok，缺 {len(failed)} 个：")
    for dist, module_name, detail in failed:
        print(f"  - {dist}（import {module_name}）: {detail}")
    print()
    print("修法: 见 docs/operations/deps.md —— 用 requirements-v4.txt 重建或补齐。")
    return 1


def _utf8_when_redirected() -> None:
    """重定向到文件/管道时按 UTF-8 写，直连控制台时保持控制台自己的编码。

    输出里有中文包用途。Windows 下 `>` 或 CI 捕获时，Python 默认按本地代码页
    （中文机器是 GBK）写，下游按 UTF-8 读就是乱码；而直接显示在中文控制台时
    反过来 —— 强写 UTF-8 才会乱。两边都要对，只能按 isatty 分：
    管道/文件给 UTF-8 字节，控制台交给 Python 用本地编码。与
    `tools/build_payload.py` 的处置同源，只是多了 isatty 这层判断。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            if not stream.isatty():
                stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass


if __name__ == "__main__":
    _utf8_when_redirected()
    raise SystemExit(main())
