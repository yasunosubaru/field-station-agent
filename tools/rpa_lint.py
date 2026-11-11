#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""``rpa_lint`` —— RPA 流程的静态检查（RPA-1）。

规格：`docs/plans/2026-11-08-v5-逐步补齐计划书-详细具体细节-AI理解版.md` §7.7。

## 五条规则（全部从已有约束倒推，不新造要求）

| 规则 | 从哪来 | 判据 |
|---|---|---|
| ``no-bare-sleep`` | 已全面改成条件等待 | 任何 ``kind: sleep`` 报错 |
| ``no-blind-coord`` | 点击引擎已要求命中校验 | 坐标点击必须带 ``sig`` |
| ``target-registered`` | 基线文件已存在 | ``target:`` 要在基线里 |
| ``explicit-danger`` | 危险词表已存在 | 危险动作前要有闸门 |
| ``gate-before-irreversible`` | 契约已要求 | 不可逆动作前必须有闸门 |

## 为什么不引 yaml 库

仓库纪律是「纯标准库、无第三方依赖」（`CLAUDE.md` §4）。这里只认 YAML 的
**行结构**——縮进 + ``key: value``——这对本仓库的流程文件足够，因为
`tools/workflows/yaml_lite.py` 本身就是同一子集。真正的解析由那个模块负责，
本工具只做**逐行扫描 + 步骤边界**，两者职责不重叠。

## 退出码

``0`` 无违规；``1`` 有违规；``2`` 用法/IO 错误。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORKFLOWS = ROOT / "workflows"
DEFAULT_SELECTORS = ROOT / "tools" / "uia_selectors.json"


@dataclass(frozen=True)
class Rule:
    """一条 lint 规则。``id`` 进机器可读输出，``doc`` 指向规格出处。"""

    id: str
    doc: str
    message: str


RULES: tuple[Rule, ...] = (
    Rule(
        id="no-bare-sleep",
        doc="docs/operations/rpa-completion.md §2.4（删掉所有 sleep，改条件等待）",
        message="裸 sleep：必须改成条件等待（wait_for 文本出现/元素可点/文件生成）",
    ),
    Rule(
        id="no-blind-coord",
        doc="docs/operations/rpa-click-engine.md（坐标点击必须命中校验）",
        message="盲坐标点击：坐标 locator 必须同时写 sig（命中后的可见特征）",
    ),
    Rule(
        id="target-registered",
        doc="tools/uia_selectors.json（逻辑定位器基线）",
        message="未登记的目标：target 名不在 uia_selectors.json 里",
    ),
    Rule(
        id="explicit-danger",
        doc="docs/operations/high-risk-actions.md（高风险动作必须显式审批）",
        message="危险动作没有前置闸门：必须在它之前出现 human_gate 或流程级 approval",
    ),
    Rule(
        id="gate-before-irreversible",
        doc="docs/spec/…契约（不可逆动作前必须有闸门）",
        message="闸门位置错误：不可逆动作出现在任何闸门之前",
    ),
)

#: 危险词。命中即视为**不可逆/高风险动作**，前面必须有闸门。
#: 取值来自 `docs/operations/high-risk-actions.md` 的动作清单与现有流程里
#: 实际出现的文案（`RESET` / `Delete Device` / `Erase NVM` / `Restart` / `Apply`）。
#:
#: **匹配按词边界**，不是子串：`format` 必须命中「单独的 format」，
#: 否则 `Project Information` 里的 `Information` 会被误判成格式化动作
#: （实测正是这么误报过 3 处）。
DANGER_WORDS: tuple[str, ...] = (
    "erase nvm", "erase-nvm", "erasenvm",
    "delete device", "delete-device",
    "reset", "restart", "factory reset", "factory-reset",
    "format",
)

#: 危险词的词边界模式（大小写不敏感）。
_DANGER_RES = tuple(
    (word, re.compile(r"(?<![A-Za-z0-9])" + re.escape(word) + r"(?![A-Za-z0-9])",
                      re.I))
    for word in DANGER_WORDS
)

#: 这些 key 的值参与危险词匹配。
_DANGER_SCAN_KEYS = ("locator", "line", "control", "id", "value", "description")

_KIND_RE = re.compile(r"^\s*-\s+kind:\s*[\"']?([A-Za-z_]+)[\"']?\s*$")
_STEP_ID_RE = re.compile(r"^\s*-\s+id:\s*[\"']?([^\"'#]+?)[\"']?\s*$")
_KV_RE = re.compile(r"^\s*([A-Za-z_][\w-]*):\s*(.*?)\s*$")
#: ``target:名字`` / ``target!:名字``。名字可含空格（``target:New Project``），
#: 也可带序号（``target:Select@1``）、CSS 选择器（``target:#sm-welcome``）。
_TARGET_RE = re.compile(r"target!?:\s*([^\"']+)")
_COORD_RE = re.compile(r"coord:\s*-?\d+\s*,\s*-?\d+")


@dataclass(frozen=True)
class Finding:
    """一条违规。``path`` 相对仓库根，``line`` 为 1 起行号。

    ``message`` 由规则说明与具体命中（``detail``）拼成，调用方读它就能看到
    「哪个名字、哪个词」，不必再拼第二段。
    """

    rule: str
    path: str
    line: int
    message: str

    def __str__(self) -> str:
        return f"{self.path}:{self.line}  [{self.rule}]  {self.message}"


@dataclass
class _Step:
    """一个 ``steps:`` 条目。只留 lint 需要的字段。"""

    start: int                     # 该步起始行号（1 起）
    step_id: str = ""
    kind: str = ""
    keys: dict[str, list[tuple[int, str]]] = None  # 字段名 -> [(行号, 值)]

    def __post_init__(self):
        if self.keys is None:
            self.keys = {}

    def values(self, name: str) -> list[tuple[int, str]]:
        return self.keys.get(name, [])


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _parse_steps(lines: list[str]) -> tuple[list[_Step], int]:
    """切出 ``steps:`` 段里的每个步骤，返回 (步骤列表, steps 段起始行号)。

    ``steps:`` 之后第一个同级或更浅缩进的非空行即结束。步骤以 ``- id:`` 或
    ``- kind:`` 开头，缩进比 ``steps:`` 深。
    """
    steps: list[_Step] = []
    start_line = 0
    steps_indent = None
    current: _Step | None = None
    step_indent = None

    for number, raw in enumerate(lines, 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        stripped = raw.strip()

        if re.match(r"^steps:\s*$", stripped):
            start_line = number
            steps_indent = _indent(raw)
            continue
        if steps_indent is None:
            continue
        indent = _indent(raw)

        # steps 段结束：回到同级或更浅（且不是 ``- `` 开头的续行）
        if indent <= steps_indent and not stripped.startswith("- "):
            break

        if stripped.startswith("- "):
            if step_indent is None:
                step_indent = indent
            if indent == step_indent:
                if current is not None:
                    steps.append(current)
                current = _Step(start=number)
                body = stripped[2:].strip()
                m = _STEP_ID_RE.match("  - " + body)
                if m:
                    current.step_id = m.group(1).strip()
                m = re.match(r"^kind:\s*[\"']?([A-Za-z_]+)", body)
                if m:
                    current.kind = m.group(1)
                m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", body)
                if m:
                    current.keys.setdefault(m.group(1), []).append(
                        (number, m.group(2).strip()))
                continue
        if current is None:
            continue
        m = _KV_RE.match(raw)
        if m:
            key, value = m.group(1), m.group(2).strip()
            current.keys.setdefault(key, []).append((number, value))
            if key == "kind":
                current.kind = value.strip("\"'").strip()
    if current is not None:
        steps.append(current)
    return steps, start_line


def _has_flow_level_approval(lines: list[str]) -> bool:
    """顶层 ``approval: required: true`` 算一道流程级闸门。"""
    for index, raw in enumerate(lines):
        if re.match(r"^approval:\s*$", raw):
            for follow in lines[index + 1:index + 6]:
                m = re.match(r"^\s+required:\s*(true|True|yes|1)\s*$", follow)
                if m:
                    return True
                if follow.strip() and _indent(follow) == 0:
                    break
    return False


def _danger_in(text: str) -> str:
    """返回命中的危险词（**保留原文大小写**，便于对着源码找）。"""
    for _word, pattern in _DANGER_RES:
        hit = pattern.search(text)
        if hit:
            return hit.group(0)
    return ""


def lint_file(path: Path, *, known_targets: set[str] | None = None) -> list[Finding]:
    """检查单个流程文件，返回违规列表（按行号排序）。"""
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    rel = path.relative_to(ROOT).as_posix() if path.is_relative_to(ROOT) else path.name
    findings: list[Finding] = []
    steps, _ = _parse_steps(lines)
    flow_gate = _has_flow_level_approval(lines)

    def add(rule_index: int, line_no: int, detail: str = "") -> None:
        base = RULES[rule_index].message
        findings.append(Finding(
            rule=RULES[rule_index].id, path=rel, line=line_no,
            message=f"{base}：{detail}" if detail else base))

    gate_seen = flow_gate
    for step in steps:
        # --- 规则 1：裸 sleep
        if step.kind == "sleep":
            # 报 `kind: sleep` 那一行，不是 `- id:` 那一行：违规是「用了 sleep」，
            # 指到具体那行才能直接跳过去修。
            kind_lines = [ln for ln, value in step.values("kind")
                          if value.strip("\"'").strip() == "sleep"]
            add(0, kind_lines[0] if kind_lines else step.start,
                f"步骤 {step.step_id or '(无名)'} 用 kind: sleep")

        # --- 规则 2：盲坐标
        for line_no, value in step.values("locator"):
            if _COORD_RE.search(value) and not step.values("sig"):
                add(1, line_no, value.strip('"'))

        # --- 规则 3：target 必须登记
        if known_targets is not None:
            for line_no, value in step.values("locator"):
                for m in _TARGET_RE.finditer(value):
                    name = m.group(1).strip().strip('"\'')
                    if not name or "${" in name:
                        continue                    # `Select@1` 取 `@` 前部分：序号是第几个同名控件，不是新名字
                    base_name = name.split("@", 1)[0]
                    if base_name not in known_targets and name not in known_targets:
                        add(2, line_no, name)

        # --- 规则 4/5：危险动作必须有前置闸门
        is_gate = step.kind in ("human_gate", "approval")
        danger_hit = ""
        danger_line = 0
        for key in _DANGER_SCAN_KEYS:
            for line_no, value in step.values(key):
                word = _danger_in(value)
                if word:
                    danger_hit, danger_line = word, line_no
                    break
            if danger_hit:
                break
        if danger_hit and not is_gate and not gate_seen:
            add(3, danger_line,
                f"命中 {danger_hit!r}，但之前没有 human_gate 也没有 "
                f"approval.required")
            add(4, step.start,
                f"步骤 {step.step_id or '(无名)'} 在闸门之前执行 {danger_hit!r}")
        if is_gate:
            gate_seen = True

    findings.sort(key=lambda f: (f.line, f.rule))
    return findings


def load_known_targets(path: Path = DEFAULT_SELECTORS,
                       fixtures: Path | None = None) -> set[str]:
    """已登记的目标名：**基线 ∪ fixture 快照**。

    ## 为什么要把 fixture 也算进来

    ``uia_selectors.json`` 是**逻辑定位器**基线（`Manage`、`Add Device`），
    而流程里用的是真实选择器（`#sm-welcome`、`#add_device_btn`）和带序号形式
    （`Select@1`）。只看基线会把这三类全报成「未登记」——那是误报。

    fixture（`tests/fixtures/rpa/<page>/`）是**真实界面快照**，它的
    ``locators.json`` 与 ``targets.json`` 就是「这个名字在原版界面上确实存在」
    的机读证据。所以判据取两者的并集：**基线或 fixture 验过，即算登记**。

    ``Name@n`` 形式取 ``@`` 前的部分去查——序号是同名控件里的第几个，
    不是新名字。
    """
    known: set[str] = set()

    if path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
        controls = data.get("controls")
        if isinstance(controls, dict):
            known.update(controls)
        elif isinstance(controls, list):
            known.update(str(item.get("name") or item.get("id"))
                         for item in controls if isinstance(item, dict))

    base = fixtures or (ROOT / "tests" / "fixtures" / "rpa")
    if base.is_dir():
        for locators in sorted(base.glob("*/locators.json")):
            data = json.loads(locators.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                known.update(str(x) for x in (data.get("locators") or []))
        for targets in sorted(base.glob("*/targets.json")):
            data = json.loads(targets.read_text(encoding="utf-8"))
            if isinstance(data, list):
                for item in data:
                    if not isinstance(item, dict):
                        continue
                    for key in ("id", "label"):
                        value = str(item.get(key) or "").strip()
                        if value:
                            known.add(value)
    return known


def lint_tree(directory: Path, *,
              known_targets: set[str] | None = None) -> list[Finding]:
    """检查目录下所有 ``*.yaml``，按 (文件, 行号) 排序返回。"""
    if known_targets is None:
        known_targets = load_known_targets()
    findings: list[Finding] = []
    for path in sorted(Path(directory).glob("*.yaml")):
        findings.extend(lint_file(path, known_targets=known_targets))
    findings.sort(key=lambda f: (f.path, f.line, f.rule))
    return findings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="RPA 流程静态检查（禁 sleep / 禁盲坐标 / 登记 target / 危险动作闸门）")
    parser.add_argument("--workflows", default=str(DEFAULT_WORKFLOWS),
                        help="流程目录（默认 workflows/）")
    parser.add_argument("--selectors", default=str(DEFAULT_SELECTORS),
                        help="定位器基线（默认 tools/uia_selectors.json）")
    parser.add_argument("--json", action="store_true",
                        help="输出机器可读 JSON")
    args = parser.parse_args(argv)

    directory = Path(args.workflows)
    if not directory.is_dir():
        print(f"[rpa_lint] 目录不存在：{directory}", file=sys.stderr)
        return 2

    findings = lint_tree(directory,
                         known_targets=load_known_targets(Path(args.selectors)))

    if args.json:
        print(json.dumps({
            "workflows": len(list(directory.glob("*.yaml"))),
            "violations": len(findings),
            "findings": [
                {"rule": f.rule, "path": f.path, "line": f.line,
                 "message": f.message}
                for f in findings],
        }, ensure_ascii=False, indent=2))
        return 0 if not findings else 1

    if not findings:
        print(f"[rpa_lint] {len(list(directory.glob('*.yaml')))} 条流程，0 违规")
        return 0
    print(f"[rpa_lint] {len(findings)} 处违规：")
    for finding in findings:
        print(f"  {finding}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
