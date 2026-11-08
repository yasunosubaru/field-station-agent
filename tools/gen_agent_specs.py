#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gen_agent_specs.py —— 一份源 → 两份产物（特化同源）。

## 为什么要有这个

`agents/fsa-ops.yaml` 是特化的**唯一源**。A 侧（OpenCode）与 B 侧（Claude Agent SDK）
各自需要一份配置，但**能力必须完全一致**——否则同一个问题在两侧得到不同答案，
而没有任何一处会报错。

手抄两份的做法必然分叉。所以这里从源生成两份产物，并在每份里写
`spec_sha256`（源文件的哈希）。`tools/check_agent_specs.py` 比对的是
「产物记录的哈希 == 当前源的哈希」。

## 产物里绝不能有时间戳

时间戳会让每次生成字节都不同，`--check` 就永远报陈旧，人就会开始忽略它。
**只写源文件哈希。** 这条与 `tools/suite_field_parity.py` 同一条纪律。

## 用法

    python tools/gen_agent_specs.py            # 生成两份产物
    python tools/gen_agent_specs.py --check    # 校验产物是否与源一致

退出码：0 成功；1 `--check` 发现陈旧；2 源不可读/不合法。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from fieldstation.workflows import yaml_lite  # noqa: E402

SPEC = ROOT / "agents" / "fsa-ops.yaml"

#: 产物路径。两处都在仓库内，且都在各自运行时会读的位置。
PRODUCTS = {
    "opencode": ROOT / "agents" / "fsa-ops.opencode.json",
    "claude": ROOT / "config" / "agents" / "fsa-ops.json",
}

#: 权限策略的合法取值。拼错一个字母等于静默关掉审批，所以写死白名单。
PERMISSION_VALUES = ("allowed", "approval_required", "denied")

#: 契约里的风险级（仅用于交叉检查，不参与生成）。
RISK_LEVELS = ("low", "medium", "high")

REQUIRED_TOP_KEYS = ("name", "description", "runtimes", "model",
                     "tools", "permissions", "skills", "output_contract", "rules")


class SpecError(RuntimeError):
    """源不合法。调用方应退出码 2，而不是生成一份半对的产物。"""


def spec_sha256(path: Path | None = None) -> str:
    """源文件的哈希。这是「同源」唯一能被机器判定的凭据。

    ``path`` 默认取模块级 ``SPEC``，但**在调用时解析**，不写成默认参数——
    默认参数在定义时绑定，测试替换 ``G.SPEC`` 后会静默读到旧路径。
    """
    target = Path(path) if path is not None else SPEC
    return hashlib.sha256(target.read_bytes()).hexdigest()


def load_spec(path: Path | None = None) -> dict:
    """读源并做结构校验。**校验失败要报错，不许猜**。

    同 :func:`spec_sha256`：``path`` 在调用时解析，避免默认参数绑定旧路径。
    """
    path = Path(path) if path is not None else SPEC
    try:
        raw = yaml_lite.load(path)
    except FileNotFoundError as exc:
        raise SpecError(f"找不到源文件：{path}") from exc
    except yaml_lite.YamlError as exc:
        raise SpecError(f"源文件不是合法 YAML 子集：{exc}") from exc
    if not isinstance(raw, dict):
        raise SpecError(f"源文件顶层必须是映射（实际 {type(raw).__name__}）")

    missing = [k for k in REQUIRED_TOP_KEYS if not raw.get(k)]
    if missing:
        raise SpecError(f"源文件缺必需字段：{missing}")

    tools = raw["tools"]
    if not isinstance(tools, dict) or not isinstance(tools.get("allow"), list):
        raise SpecError("tools 必须是含 allow 列表的映射")
    allow = [str(t) for t in tools["allow"]]
    deny = [str(t) for t in (tools.get("deny") or [])]

    overlap = sorted(set(allow) & set(deny))
    if overlap:
        raise SpecError(
            f"工具同时出现在 allow 与 deny 里：{overlap}（deny 的语义是「即使 allow 放宽也拒绝」，"
            "同时出现说明源写错了）")

    perms = raw["permissions"]
    if not isinstance(perms, dict) or not perms:
        raise SpecError("permissions 必须是「每个工具一个策略」的映射")
    bad = {k: v for k, v in perms.items() if v not in PERMISSION_VALUES}
    if bad:
        raise SpecError(f"permissions 有非法取值：{bad}（只认 {PERMISSION_VALUES}）")

    # 每个 allow 的工具都要有策略。缺了就等于「没声明」，不能默认放行。
    undeclared = [t for t in allow if t not in perms]
    if undeclared:
        raise SpecError(
            f"这些工具在 allow 里但没有权限策略：{undeclared}。"
            "每个工具都必须显式声明 allowed/approval_required/denied。")

    # denied 的工具不该在 allow 里（会出现「允许但拒绝」的矛盾）
    contradictory = [t for t in allow if perms.get(t) == "denied"]
    if contradictory:
        raise SpecError(
            f"这些工具在 allow 里但策略是 denied：{contradictory}（自相矛盾）")

    if not isinstance(raw["skills"], list) or not raw["skills"]:
        raise SpecError("skills 必须是非空列表")
    for item in raw["skills"]:
        if not isinstance(item, dict) or not item.get("path"):
            raise SpecError(f"skills 每一项都要有 path：{item!r}")
        target = ROOT / str(item["path"])
        if not target.is_file():
            raise SpecError(f"技能文件不存在：{item['path']}")

    return raw


def _system_prompt(spec: dict) -> str:
    """把规则与输出契约拼成系统提示。

    **两侧共用同一段文字**——这是「能力一致」最直接的保证：提示不同，行为就会不同。
    """
    rules = "\n".join(f"{i}) {r}" for i, r in enumerate(spec["rules"], 1))
    return (
        f"你是 {spec.get('title') or spec['name']}（{spec['name']}）。\n\n"
        f"{spec['description']}\n\n"
        f"硬规则：\n{rules}\n\n"
        f"输出契约：{spec['output_contract']}"
    )


def _common(spec: dict, digest: str, runtime_id: str) -> dict:
    """两份产物共有的字段。**同源的部分必须逐字相同**。"""
    perms = {str(k): str(v) for k, v in spec["permissions"].items()}
    allow = [str(t) for t in spec["tools"]["allow"]]
    deny = [str(t) for t in (spec["tools"].get("deny") or [])]
    skills = [{"id": str(s["id"]), "path": str(s["path"]),
               "when": str(s.get("when") or "")} for s in spec["skills"]]
    return {
        "name": str(spec["name"]),
        "description": str(spec["description"]),
        "system_prompt": _system_prompt(spec),
        "model": str(spec["model"]),
        "runtime": runtime_id,
        "tools": {"allow": allow, "deny": deny},
        "permissions": perms,
        "skills": skills,
        "output_contract": str(spec["output_contract"]),
        "rules": [str(r) for r in spec["rules"]],
        # ---- 同源凭据：源文件哈希。生成时间戳一律不写（会让 --check 永远失败）。
        "spec_sha256": digest,
    }


def build_products(spec: dict | None = None, digest: str | None = None) -> dict[str, str]:
    """生成两份产物的**文本**（不写盘，方便测试直接比对）。"""
    data = spec if spec is not None else load_spec()
    sha = digest if digest is not None else spec_sha256()

    products: dict[str, str] = {}

    # ---- 产物 A：OpenCode。顶层多一个 ``provider`` 与 ``agent`` 包装，
    #      因为 OpenCode 侧按 agent 名索引。
    opencode = _common(data, sha, "opencode")
    opencode["provider"] = "fake"      # 运行期由设置里的真实 provider 覆盖
    products["opencode"] = json.dumps(
        {"_说明": "由 agents/fsa-ops.yaml 生成，请勿手工编辑。"
                  "改了源就跑 python tools/gen_agent_specs.py。",
         "agent": opencode},
        ensure_ascii=False, indent=2, sort_keys=False) + "\n"

    # ---- 产物 B：Claude Agent SDK（字段铺平，与 config/agents/*.json 同形）
    claude = _common(data, sha, "claude")
    claude["provider"] = "fake"
    products["claude"] = json.dumps(
        {"_说明": "由 agents/fsa-ops.yaml 生成，请勿手工编辑。"
                  "改了源就跑 python tools/gen_agent_specs.py。",
         **claude},
        ensure_ascii=False, indent=2, sort_keys=False) + "\n"

    return products


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):  # pragma: no cover
            pass

    ap = argparse.ArgumentParser(description="一份源 → 两份产物（特化同源）")
    ap.add_argument("--check", action="store_true",
                    help="只校验产物与源是否同源，不写盘")
    args = ap.parse_args(argv)

    try:
        products = build_products()
    except SpecError as exc:
        print(f"[阻断] {exc}")
        return 2

    if args.check:
        stale = []
        for key, path in PRODUCTS.items():
            if not path.exists():
                stale.append(f"{path.relative_to(ROOT)}（缺失）")
                continue
            current = path.read_text(encoding="utf-8", errors="replace")
            if current != products[key]:
                stale.append(str(path.relative_to(ROOT)))
        if stale:
            print(f"[陈旧] {len(stale)} 份产物与源不一致：")
            for item in stale:
                print(f"  {item}")
            print("[提示] 运行 python tools/gen_agent_specs.py 重新生成")
            return 1
        print(f"[同源] 2 份产物与 {SPEC.relative_to(ROOT)} 一致"
              f"（spec_sha256={spec_sha256()[:12]}）")
        return 0

    for key, path in PRODUCTS.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(products[key], encoding="utf-8", newline="\n")
        print(f"[写入] {path.relative_to(ROOT)}")
    print(f"[同源] spec_sha256={spec_sha256()[:12]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
