#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""check_agent_specs.py —— 校验两份特化产物与**源文件**同源。

## 这个脚本存在的唯一理由

「特化只写一份源」这句话，能被机器判定的定义只有一个：
**产物里记录的 `spec_sha256` 等于当前源文件的哈希。**

有两种写错的校验脚本，都会给出「通过」而实际什么都没验：

| 错法 | 为什么它恒真 |
|---|---|
| `assert a["spec_sha256"] == b["spec_sha256"]` | 两份产物**一起**过期时仍然相等 |
| `assert a == b`（整份比） | 两侧结构本来就不同，比不了；真比了又会因为字段差异永远失败 |

正确做法是**分别与源比**：

    assert a["spec_sha256"] == src_sha and b["spec_sha256"] == src_sha

本脚本对同源字段（权限、工具、规则、系统提示…）还做内容比对——只比哈希会漏掉
「源没变但产物被手改过」这种情况（哈希对得上，内容是错的）。

## 用法

    python tools/check_agent_specs.py          # 校验
    python tools/check_agent_specs.py --json   # 机器可读

退出码：0 全过；1 有陈旧/漂移；2 输入不可用（源缺失或产物缺失）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(ROOT / "tools"))

import gen_agent_specs as G  # noqa: E402


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8", errors="replace"))


def unwrap(key: str, payload: dict) -> dict:
    """产物 A 有一层 ``agent`` 包装，产物 B 是铺平的。这里统一成铺平形状。"""
    if "agent" in payload and isinstance(payload["agent"], dict):
        return payload["agent"]
    return payload


#: 两份产物**必须逐字相同**的字段。少一个就等于两侧能力分叉。
SHARED_FIELDS = (
    "name", "description", "system_prompt", "model", "tools",
    "permissions", "skills", "output_contract", "rules",
)


def _rel(path: Path) -> str:
    """相对仓库根的 POSIX 路径。仓库根用 ``G.ROOT``（可被测试替换）。

    不能用本模块自己的 ``ROOT``：测试会把 ``G.ROOT`` 指到临时目录，
    此时 ``path.relative_to(ROOT)`` 会抛 ``ValueError``。
    """
    try:
        return path.relative_to(G.ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def check() -> tuple[list[str], dict]:
    """返回 ``(问题列表, 报告)``。问题列表为空即同源。"""
    problems: list[str] = []
    try:
        spec = G.load_spec()
    except G.SpecError as exc:
        return [f"源不可用：{exc}"], {"ok": False, "reason": "spec_unavailable"}

    src_sha = G.spec_sha256()
    expected = G.build_products(spec, src_sha)

    report: dict = {
        "ok": True,
        "spec": _rel(G.SPEC),
        "spec_sha256": src_sha,
        "products": {},
    }

    loaded: dict[str, dict] = {}
    for key, path in G.PRODUCTS.items():
        rel = _rel(path)
        entry: dict = {"path": rel}
        if not path.exists():
            problems.append(f"{rel}：产物缺失，先跑 python tools/gen_agent_specs.py")
            entry["exists"] = False
            report["products"][key] = entry
            continue
        entry["exists"] = True
        payload = _load(path)
        body = unwrap(key, payload)
        loaded[key] = body

        recorded = body.get("spec_sha256")
        entry["spec_sha256"] = recorded
        # ---- 第一关：与**源**比，不是与另一份产物比
        if recorded != src_sha:
            problems.append(
                f"{rel}：spec_sha256 与源不一致（产物 {str(recorded)[:12]}，"
                f"源 {src_sha[:12]}）——源改了但没重新生成")
            entry["sha_match"] = False
        else:
            entry["sha_match"] = True

        # ---- 第二关：内容与「从当前源重新生成」逐字相同。
        #      只比哈希会漏掉「源没变、产物被手改」的情况。
        current = path.read_text(encoding="utf-8", errors="replace")
        if current != expected[key]:
            problems.append(f"{rel}：内容与源重新生成的结果不一致（被手改过？）")
            entry["bytes_match"] = False
        else:
            entry["bytes_match"] = True

        report["products"][key] = entry

    # ---- 第三关：两份产物在共享字段上必须逐字相同（能力一致）
    if len(loaded) == 2:
        for field in SHARED_FIELDS:
            a = loaded["opencode"].get(field)
            b = loaded["claude"].get(field)
            if a != b:
                problems.append(
                    f"两侧产物在字段 {field!r} 上不一致——同一份源生成了两种能力")
                report.setdefault("field_drift", []).append(field)

    # ---- 第四关：权限不是粗粒度，必须每个工具一条
    try:
        perms = spec["permissions"]
        allow = [str(t) for t in spec["tools"]["allow"]]
        missing = [t for t in allow if t not in perms]
        if missing:
            problems.append(f"这些工具没有权限策略：{missing}")
        report["permission_count"] = len(perms)
        report["tool_count"] = len(allow)
    except (KeyError, TypeError) as exc:
        problems.append(f"源结构异常：{exc}")

    report["ok"] = not problems
    report["problems"] = problems
    return problems, report


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):  # pragma: no cover
            pass

    ap = argparse.ArgumentParser(
        description="校验两份特化产物与源文件同源")
    ap.add_argument("--json", action="store_true", help="输出机器可读报告")
    args = ap.parse_args(argv)

    if not G.SPEC.exists():
        print(f"[阻断] 源文件不存在：{_rel(G.SPEC)}")
        return 2

    problems, report = check()

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    else:
        if problems:
            print(f"[不同源] {len(problems)} 个问题：")
            for item in problems:
                print(f"  - {item}")
            print("[提示] 若只是源改了，跑 python tools/gen_agent_specs.py")
        else:
            print(f"[同源] 2 份产物均与 {report['spec']} 一致")
            print(f"  spec_sha256 : {report['spec_sha256'][:12]}")
            print(f"  工具 / 权限 : {report.get('tool_count')} / "
                  f"{report.get('permission_count')}")
            for key, entry in report["products"].items():
                print(f"  {key:<9} : {entry['path']}")

    if problems:
        # 输入不可用（源缺失/产物缺失）与「不同源」都是非零，但语义不同：
        # 缺失是 2（没法判），陈旧是 1（判了，不合格）。
        missing = [p for p in problems if "缺失" in p or "不可用" in p]
        return 2 if missing else 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
