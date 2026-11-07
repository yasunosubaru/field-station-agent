#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""eval30_judge.py —— 按 `docs/contracts/eval-30.md` 的六条机器规则给一轮运行判分。

## 为什么要有这个东西

`eval-30.md` §3.3 要求两个运行时各出一份「每条一行」的报告。但**判分规则写在散文里**
（S1 工具链 / S2 证据闭合 / …）：只要靠人读日志填表，"这条算过"就变成了主观判断，
而两份报告来自两个不同的人/两次不同心情时，它们根本没有可比性 —— 这与
"两个运行时**各自独立**跑完 30 条、不排名"的初衷正好相反。

所以判分必须机械。本脚本只做一件事：**吃事件 JSONL，吐报告行**，不解释、不商量。

## 任务清单不硬编码

30 条任务 id、期望工具链、判分规则**从契约文档当场解析**（`docs/contracts/eval-30.md` §2 的表）。
硬编码一份副本的唯一结局是：契约改了、脚本没改，然后两边各自"自洽"。
这与 `tools/audit_claims.py` 的纪律同源：**期望值从文档取，不在脚本里另写一份**。

## 哪些规则真的机判，哪些不能

| 规则 | 能不能机判 | 说明 |
|---|---|---|
| S1 工具链 | **能** | 期望工具名按顺序作为子序列出现（允许插入只读补充调用，与契约 §1.2 一致） |
| S2 证据闭合 | **能** | 结论 `attribution.evidence[].call_id` 逐个回查 `tool.result(ok=true)`，且工具名一致、不重复引用 |
| S3 字段与数值 | **部分** | 结论走 ADR-004 校验；契约里写成 `字段∈[a,b]` 的区间自动核对。**没写区间的数值不猜** |
| S4 产物回源 | **能** | `artifact_ref.sha256` 等于磁盘文件哈希；`bytes` 一致；路径在 `artifacts/` 下 |
| S5 审批合规 | **能** | pending 期间同 `call_id` 无 `tool.result`；`approval.result` 先于 `tool.result`；拒绝后无成功副作用 |
| S6 边界与确定 | **部分** | 仅 EV-08（零工具调用）与 EV-20（只读拒写）可机判；其余标 `manual`，**不冒充通过** |

**"不能机判"绝不等于"通过"**：报告行里单列 `manual_rules`，汇总里单列计数。
把 `manual` 当 pass 是这类脚本最容易犯、也最贵的错。

## 用法

    python tools/eval30_judge.py --events logs/eval/opencode/EV-01.jsonl --task EV-01
    python tools/eval30_judge.py --events-dir logs/eval/opencode --runtime opencode
    python tools/eval30_judge.py --list-tasks

退出码：``0`` 全部判出的都通过且没有 manual 项 / ``1`` 有 FAIL 或 manual 项 /
``2`` 用法错误或契约解析不出来。

## 与 `harness/selftest.py` 的关系

本脚本**不进五项门禁**：它需要真实事件日志，而门禁必须能在干净 clone 上离线全绿。
它自己的行为由 `tests/test_eval30_judge.py` 用合成日志钉住。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "docs" / "contracts" / "eval-30.md"

RULES = ("S1", "S2", "S3", "S4", "S5", "S6")

#: 判分方式列里「字段∈[下界,上界]」这种区间断言。数值容差按契约 §3.2：区间内即可。
_RANGE_RE = re.compile(r"`?([A-Za-z_][A-Za-z0-9_.]{1,40})`?\s*[∈]\s*\[\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]")
#: 「字段=数字」的精确相等断言（契约 §3.2：计数/行数/分区数精确相等）。
#: 千分位逗号要认，`4,924,800` 是真值不是区间。
_EXACT_RE = re.compile(
    r"`?([A-Za-z_][A-Za-z0-9_.]{1,40})`?\s*=\s*`?(-?\d[\d,]*(?:\.\d+)?)`?")
#: 表格行里的 `backticked` 工具名。
_TICK_RE = re.compile(r"`([A-Za-z_][A-Za-z0-9_.]*)`")

#: 期望里出现这些词，说明这条任务**不要求**产出结论 JSON。
#: 契约 §2 的 EV-08（"不给结论 JSON"）、EV-20（只要求错误码）、
#: EV-29/EV-30（CLI 与对照表，本来就没有对话结论）都属于这一类。
_NO_CONCLUSION_HINTS = ("不给结论", "不给 attribution", "无工具调用", "对照表", "--replay-all")

#: 可以机判的 S6 子项：task_id → 判定函数名（在 Judge 里实现）。
S6_MACHINE = {
    "EV-08": "zero_tool_calls",
    "EV-20": "readonly_rejected",
}


# --------------------------------------------------------------------------- 契约解析
class Task:
    """一条验收任务。字段与 `eval-30.md` §2 的表列一一对应。"""

    __slots__ = ("task_id", "view", "prompt", "tools", "expect", "rules",
                 "ranges", "exact", "needs_conclusion")

    def __init__(self, task_id: str, view: str, prompt: str,
                 tools: Sequence[str], expect: str, rules: Sequence[str],
                 ranges: Sequence[Tuple[str, float, float]],
                 exact: Sequence[Tuple[str, float]] = (),
                 needs_conclusion: bool = True) -> None:
        self.task_id = task_id
        self.view = view
        self.prompt = prompt
        self.tools = list(tools)
        self.expect = expect
        self.rules = list(rules)
        self.ranges = list(ranges)
        self.exact = list(exact)
        self.needs_conclusion = bool(needs_conclusion)

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return f"Task({self.task_id}, tools={self.tools}, rules={self.rules})"


def _cells(line: str) -> List[str]:
    """把 Markdown 表行切成单元格；`|` 两侧的空白去掉，首尾空段丢弃。"""
    parts = [c.strip() for c in line.strip().strip("|").split("|")]
    return parts


def parse_tasks(text: str) -> List[Task]:
    """从契约正文解析 §2 的任务表。

    只看形状（第一列是 `EV-xx`），不认小节标题 —— 契约改标题不会让解析器失明，
    改表结构会（那是应该失明：解析不出来必须是硬失败，不能静默返回空表）。
    """
    tasks: List[Task] = []
    for line in text.splitlines():
        s = line.strip()
        if not s.startswith("|"):
            continue
        cells = _cells(s)
        if len(cells) < 6:
            continue
        tid = cells[0]
        if not re.fullmatch(r"EV-\d{2}", tid):
            continue
        view, prompt, chain, expect, scoring = cells[1], cells[2], cells[3], cells[4], cells[5]
        # 工具链列写成 `a` → `b`；「无」表示期望零工具调用。
        tools = [] if chain.strip() in ("无", "—", "-") else _TICK_RE.findall(chain)
        rules = [r for r in re.findall(r"S[1-6]", scoring)]
        # 保序去重：同一规则写两遍不该判两次。
        rules = list(dict.fromkeys(rules))
        ranges = [(m.group(1), float(m.group(2)), float(m.group(3)))
                  for m in _RANGE_RE.finditer(scoring)]
        # 精确值两个来源都要看：契约把「row_count=4,924,800」这类写在**期望输出**列，
        # 把「p50∈[42,48]」写在**判分方式**列。只扫一列会漏掉一半数值断言。
        exact = [(m.group(1), float(m.group(2).replace(",", "")))
                 for m in _EXACT_RE.finditer(scoring + " " + expect)]
        # 区间里的两个端点不会被 `=` 匹配到，但保险起见去掉同名字段的精确断言；
        # 同一字段写两遍（契约「attempts=2；旧尝试保留」那种）只判一次。
        exact = [(k, v) for k, v in exact if k not in {r[0] for r in ranges}]
        dedup: Dict[str, float] = {}
        for key, value in exact:
            dedup.setdefault(key, value)
        exact = list(dedup.items())
        needs = not any(h in (expect + " " + scoring) for h in _NO_CONCLUSION_HINTS)
        tasks.append(Task(tid, view, prompt, tools, expect, rules, ranges, exact, needs))
    return tasks


def load_tasks(path: Path = CONTRACT) -> List[Task]:
    if not path.exists():
        raise SystemExit(f"[阻断] 找不到契约文档：{path}")
    return parse_tasks_or_exit(path.read_text("utf-8", errors="replace"))


# --------------------------------------------------------------------------- 事件读取
class JudgeInputError(RuntimeError):
    """输入不可用（坏行、表解析不出来）。CLI 把它折成退出码 2，与"判分不通过"的 1 区分。

    分开的理由：退出码 1 表示"跑完了，有 FAIL"；2 表示"根本没跑成"。
    两者混在一个码里时，CI 上一句 `exit 1` 会让人去查任务，而实际是日志坏了。
    """


def read_events(path: Path) -> List[dict]:
    """读事件 JSONL。坏行不静默跳过：判分吃的是证据，丢一行就可能把 FAIL 变成 PASS。"""
    events: List[dict] = []
    for lineno, line in enumerate(path.read_text("utf-8", errors="replace").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError as exc:
            raise JudgeInputError(f"{path.name} 第 {lineno} 行不是合法 JSON：{exc.msg}")
        if not isinstance(value, dict):
            raise JudgeInputError(f"{path.name} 第 {lineno} 行不是 JSON object")
        events.append(value)
    return events


def _data(event: dict) -> dict:
    d = event.get("data")
    return d if isinstance(d, dict) else {}


def _kind(event: dict) -> str:
    return str(event.get("type") or "")


# --------------------------------------------------------------------------- 判分
class Judge:
    """一条任务 × 一份事件日志 → 一行报告。

    刻意不缓存跨任务状态：两条任务之间共享任何东西，都会让"独立完成"这句话失去意义。
    """

    def __init__(self, task: Task, events: Sequence[dict],
                 artifacts_root: Optional[Path] = None) -> None:
        self.task = task
        self.events = list(events)
        self.artifacts_root = artifacts_root
        self.failed: List[str] = []
        self.manual: List[str] = []
        self.notes: List[str] = []

    # ---------------------------------------------------------------- 索引
    def _tool_calls(self) -> List[dict]:
        return [_data(e) for e in self.events if _kind(e) == "tool.call"]

    def _tool_results(self) -> List[dict]:
        return [_data(e) for e in self.events if _kind(e) == "tool.result"]

    def _conclusion(self) -> Any:
        """取最后一条 `message.done` 的 `data.content` 当结论。没有就返回 None。"""
        last = None
        for e in self.events:
            if _kind(e) == "message.done":
                last = _data(e)
        if last is None:
            return None
        content = last.get("content")
        if isinstance(content, (dict, str)):
            return content
        return None

    # ---------------------------------------------------------------- S1
    def s1_tool_chain(self) -> bool:
        """期望工具名按顺序作为子序列出现。

        子序列而不是全等：契约 §1.2 明写「未注明『恰好』时允许插入只读补充调用」。
        """
        expected = list(self.task.tools)
        if not expected:
            return True
        actual = [str(c.get("name") or "") for c in self._tool_calls()]
        i = 0
        for name in actual:
            if i < len(expected) and name == expected[i]:
                i += 1
        if i == len(expected):
            return True
        missing = expected[i:]
        self.notes.append(f"S1 期望工具链 {expected}，实际 {actual}；缺 {missing}")
        return False

    # ---------------------------------------------------------------- S2
    def s2_evidence_closure(self) -> bool:
        """结论里的每条证据都要能在同一份日志里回查到成功的工具结果。"""
        raw = self._conclusion()
        if raw is None:
            self.notes.append("S2 没有 message.done.content 可作结论")
            return False
        try:
            data = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError as exc:
            self.notes.append(f"S2 结论不是合法 JSON：{exc.msg}")
            return False
        if not isinstance(data, dict):
            self.notes.append("S2 结论不是 JSON object")
            return False
        evidence = ((data.get("attribution") or {}).get("evidence")
                    if isinstance(data.get("attribution"), dict) else None)
        if not isinstance(evidence, list) or not evidence:
            self.notes.append("S2 结论没有 attribution.evidence（至少需要一条）")
            return False

        ok_results: Dict[str, str] = {}
        for r in self._tool_results():
            if r.get("ok") is True and isinstance(r.get("id"), str):
                ok_results[str(r["id"])] = str(r.get("name") or "")

        seen: set = set()
        problems: List[str] = []
        for index, item in enumerate(evidence):
            if not isinstance(item, dict):
                problems.append(f"evidence[{index}] 不是 object")
                continue
            call_id = str(item.get("call_id") or "")
            tool = str(item.get("tool") or "")
            if not call_id or not tool:
                problems.append(f"evidence[{index}] 缺 call_id 或 tool")
                continue
            if call_id in seen:
                problems.append(f"evidence[{index}] 重复引用 {call_id}")
                continue
            seen.add(call_id)
            if call_id not in ok_results:
                problems.append(f"evidence[{index}] {call_id} 不在成功的 tool.result 里")
                continue
            if ok_results[call_id] != tool:
                problems.append(
                    f"evidence[{index}] 工具名不符：证据写 {tool}，调用是 {ok_results[call_id]}")
        if problems:
            self.notes.extend(["S2 " + p for p in problems])
            return False
        return True

    def _number_sources(self, data: Any) -> List[Tuple[str, float]]:
        """把"某字段的所有数值来源"列出来，带来源标签。

        数值可能出现在两处，契约 §3.4 把两者不一致本身列为失败：

          * `conclusion` —— 模型在结论里复述的数；
          * `tool.result(t0001)` —— 工具真正返回的数。

        只查一处会得出两种相反的错误结论：只查结论会漏掉"工具给了 45、模型写了 47"
        （那正是 EV-18 要防的），只查工具会放过"模型自己编了个数"。
        """
        found: List[Tuple[str, float]] = []
        flat = _flatten(data)
        for key, value in flat.items():
            short = key.split(".")[-1]
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                found.append((f"conclusion.{short}", float(value)))
        for r in self._tool_results():
            payload = r.get("data")
            if not isinstance(payload, dict):
                continue
            label = f"tool.result({r.get('id')})."
            for key, value in _flatten(payload).items():
                short = key.split(".")[-1]
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    found.append((label + short, float(value)))
        return found

    def _resolve(self, sources: Sequence[Tuple[str, float]], name: str) -> Tuple[Optional[float], str]:
        """按名字（可带点）取值；多处不一致时返回 (None, 说明)，绝不挑一个"看起来对的"。"""
        hits = [(label, value) for label, value in sources
                if label.split(".")[-1] == name or label.endswith("." + name)]
        if not hits:
            return None, "在结论与工具返回里都找不到"
        values = {round(value, 9) for _label, value in hits}
        if len(values) > 1:
            detail = "；".join(f"{label}={value}" for label, value in hits)
            return None, f"多处数值不一致（{detail}）"
        return hits[0][1], ""

    def s3_fields_and_numbers(self) -> bool:
        """结论契约 + 契约里写死的数值区间/精确值，并与工具返回交叉核对。

        没写区间也没给精确值的数值**不猜**：契约 §3.2 只给"区间 / 精确相等"两类，
        散文里的"落在区间"没有上下界时，人判才算数（那会落进 `manual`）。
        """
        raw = self._conclusion()
        if raw is None:
            if not self.task.needs_conclusion:
                # 契约明说这条不要结论（EV-08 / EV-20 / EV-29 / EV-30）。
                return True
            self.notes.append("S3 没有结论 JSON 可校验")
            return False
        valid, errors = self._validate_conclusion(raw)
        if not valid:
            self.notes.extend(["S3 " + e for e in errors])
            return False
        data = json.loads(raw) if isinstance(raw, str) else raw
        if not self.task.ranges and not self.task.exact:
            return True

        sources = self._number_sources(data)
        ok = True
        for name, low, high in self.task.ranges:
            value, why = self._resolve(sources, name)
            if value is None:
                self.notes.append(f"S3 契约要求的数值 {name!r} {why}")
                ok = False
                continue
            if not (low <= value <= high):
                self.notes.append(f"S3 {name}={value} 不在 [{low}, {high}] 内")
                ok = False
        for name, expected in self.task.exact:
            value, why = self._resolve(sources, name)
            if value is None:
                self.notes.append(f"S3 契约要求的精确值 {name!r} {why}")
                ok = False
                continue
            if value != expected:
                self.notes.append(f"S3 {name}={value} 与契约的 {expected} 不相等")
                ok = False
        return ok

    def _validate_conclusion(self, raw: Any) -> Tuple[bool, List[str]]:
        """优先用仓库自己的 ADR-004 校验器；导入失败时退回本文件的结构检查。

        退回不是"宽松通过"：检查项一样（三个顶层字段、evidence 形状、confidence 范围），
        只是不复用那条已经过了 40 多个测试的实现。导入不到通常意味着跑本脚本时
        没设 `PYTHONPATH=src`，那种环境下**不该假装校验过了**。
        """
        try:
            from fieldstation.agents.conclusion import validate_conclusion  # noqa: WPS433
        except Exception:  # noqa: BLE001 - 导入失败只影响实现选择，不影响判分口径
            return _fallback_validate(raw)
        trace = [{"kind": "tool_result", "ok": r.get("ok"),
                  "call_id": r.get("id"), "tool": r.get("name")}
                 for r in self._tool_results()]
        result = validate_conclusion(raw, trace)
        return bool(result.valid), list(result.errors)

    # ---------------------------------------------------------------- S4
    def s4_artifact_provenance(self) -> bool:
        """`artifact_ref` 的哈希/字节数必须与磁盘对得上，且路径在 artifacts/ 下。"""
        refs = [r for r in self._tool_results() if isinstance(r.get("artifact_ref"), dict)]
        if not refs:
            # 任务期望里出现 artifact/sha256 才要求有产物；否则这条规则不适用。
            wants = ("artifact" in self.task.expect.lower()
                     or "sha256" in self.task.expect.lower())
            if wants:
                self.notes.append("S4 期望有产物引用，但日志里没有 artifact_ref")
                return False
            return True
        ok = True
        for r in refs:
            ref = r["artifact_ref"]
            path = ref.get("path")
            if not isinstance(path, str) or not path:
                self.notes.append("S4 artifact_ref 缺 path")
                ok = False
                continue
            p = Path(path)
            if not p.is_absolute():
                p = (self.artifacts_root or ROOT) / p
            if self.artifacts_root is not None:
                try:
                    p.resolve().relative_to(self.artifacts_root.resolve())
                except ValueError:
                    self.notes.append(f"S4 产物路径不在 artifacts/ 下：{path}")
                    ok = False
                    continue
            if not p.is_file():
                self.notes.append(f"S4 产物不存在：{p}")
                ok = False
                continue
            actual_bytes = p.stat().st_size
            if ref.get("bytes") is not None and int(ref["bytes"]) != actual_bytes:
                self.notes.append(
                    f"S4 bytes 不符：日志写 {ref['bytes']}，磁盘 {actual_bytes}")
                ok = False
            digest = hashlib.sha256(p.read_bytes()).hexdigest()
            if str(ref.get("sha256") or "").lower() != digest:
                self.notes.append(
                    f"S4 sha256 不符：日志写 {ref.get('sha256')}，实测 {digest}")
                ok = False
        return ok

    # ---------------------------------------------------------------- S5
    def s5_approval_order(self) -> bool:
        """审批与执行的先后关系，以及"拒绝之后不许有副作用"。"""
        calls = {str(c.get("id")): str(c.get("name")) for c in self._tool_calls()}
        requests: Dict[str, dict] = {}
        results: Dict[str, dict] = {}
        order: List[Tuple[str, int, dict]] = []
        for index, e in enumerate(self.events):
            kind = _kind(e)
            d = _data(e)
            if kind == "approval.request":
                requests[str(d.get("approval_id"))] = d
                order.append((kind, index, d))
            elif kind == "approval.result":
                results[str(d.get("approval_id"))] = d
                order.append((kind, index, d))
            elif kind in ("tool.call", "tool.result"):
                order.append((kind, index, d))

        if not requests and not results:
            # 任务明确要求审批合规却没有审批事件 —— 那是漏了，不是"不需要"。
            if "S5" in self.task.rules:
                self.notes.append("S5 任务要求审批合规，但日志里没有任何 approval 事件")
                return False
            return True

        tool_result_index: Dict[str, List[Tuple[int, dict]]] = {}
        for kind, index, d in order:
            if kind == "tool.result":
                tool_result_index.setdefault(str(d.get("id")), []).append((index, d))

        problems: List[str] = []
        for approval_id, req in requests.items():
            res = results.get(approval_id)
            if res is None:
                problems.append(f"审批 {approval_id} 一直没有结论")
                continue
            req_index = next(i for k, i, d in order
                             if k == "approval.request" and str(d.get("approval_id")) == approval_id)
            res_index = next(i for k, i, d in order
                             if k == "approval.result" and str(d.get("approval_id")) == approval_id)
            call_id = str(req.get("call_id") or "")
            if res_index <= req_index:
                problems.append(f"审批 {approval_id} 的结论先于请求")
            # pending 期间（请求之后、结论之前）同 call_id 不得有 tool.result
            for index, _d in tool_result_index.get(call_id, []):
                if req_index < index < res_index:
                    problems.append(
                        f"审批 {approval_id} 还是 pending，{call_id} 却已经有 tool.result")
            verdict = str(res.get("verdict") or "")
            if verdict == "rejected":
                for index, d in tool_result_index.get(call_id, []):
                    if index > res_index and d.get("ok") is True:
                        problems.append(f"审批 {approval_id} 被拒后 {call_id} 仍然成功执行")
            if verdict not in ("approved", "rejected", "expired"):
                problems.append(f"审批 {approval_id} 的 verdict 非法：{verdict!r}")
            if str(res.get("call_id") or "") != call_id:
                problems.append(f"审批 {approval_id} 的 call_id 与请求不一致")
            if call_id and call_id not in calls:
                problems.append(f"审批 {approval_id} 指向未发起的调用 {call_id}")
        if problems:
            self.notes.extend(["S5 " + p for p in problems])
            return False
        return True

    # ---------------------------------------------------------------- S6
    def s6_boundary(self) -> Optional[bool]:
        """只能机判两条；其余返回 None（= manual），**不返回 True**。"""
        handler = S6_MACHINE.get(self.task.task_id)
        if handler is None:
            return None
        return bool(getattr(self, handler)())

    def zero_tool_calls(self) -> bool:
        calls = self._tool_calls()
        if calls:
            self.notes.append(f"S6 EV-08 要求零工具调用，实际 {len(calls)} 次")
            return False
        raw = self._conclusion()
        if raw is not None:
            try:
                data = json.loads(raw) if isinstance(raw, str) else raw
            except json.JSONDecodeError:
                data = None
            if isinstance(data, dict) and "attribution" in data:
                self.notes.append("S6 EV-08 要求不给结论，但出现了 attribution")
                return False
        return True

    def readonly_rejected(self) -> bool:
        for r in self._tool_results():
            err = r.get("error")
            if isinstance(err, dict) and str(err.get("code") or "") == "E_READONLY":
                if r.get("ok") is False:
                    return True
        self.notes.append("S6 EV-20 期望 E_READONLY 且 ok=false，日志里没有")
        return False

    # ---------------------------------------------------------------- 汇总
    def run(self) -> dict:
        checks = {
            "S1": self.s1_tool_chain,
            "S2": self.s2_evidence_closure,
            "S3": self.s3_fields_and_numbers,
            "S4": self.s4_artifact_provenance,
            "S5": self.s5_approval_order,
        }
        for rule in self.task.rules:
            if rule == "S6":
                value = self.s6_boundary()
                if value is None:
                    self.manual.append("S6")
                elif not value:
                    self.failed.append("S6")
                continue
            fn = checks.get(rule)
            if fn is None:
                self.manual.append(rule)      # 契约里出现的未知规则：不猜
                continue
            if not fn():
                self.failed.append(rule)

        calls = self._tool_calls()
        tokens = 0
        for e in self.events:
            if _kind(e) == "usage":
                d = _data(e)
                tokens += int(d.get("prompt_tokens") or 0) + int(d.get("completion_tokens") or 0)

        finish = None
        for e in self.events:
            if _kind(e) in ("message.done", "error"):
                finish = e
        return {
            "task_id": self.task.task_id,
            "runtime": str(_data(self.events[0]).get("runtime") or "") if self.events else "",
            "pass": not self.failed and not self.manual,
            "failed_rules": list(dict.fromkeys(self.failed)),
            "manual_rules": list(dict.fromkeys(self.manual)),
            "tool_calls": len(calls),
            "tokens": tokens,
            "events": len(self.events),
            "finished_with": _kind(finish) if finish else "",
            "notes": self.notes,
        }


# --------------------------------------------------------------------------- 小工具
def _flatten(obj: Any, prefix: str = "") -> Dict[str, Any]:
    """把嵌套 dict 摊平成 `a.b.c` → 值；数组下标不进键（判分只认字段名）。"""
    out: Dict[str, Any] = {}
    if isinstance(obj, dict):
        for key, value in obj.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            out[path] = value
            if isinstance(value, dict):
                out.update(_flatten(value, path))
    return out


def _lookup_number(flat: Dict[str, Any], name: str) -> Optional[float]:
    """按名字（可带点）找数值；有歧义就返回 None（不猜）。保留给外部调用者。"""
    candidates = [v for k, v in flat.items() if k == name or k.endswith("." + name)]
    numbers = [float(v) for v in candidates
               if isinstance(v, (int, float)) and not isinstance(v, bool)]
    unique = set(numbers)
    return unique.pop() if len(unique) == 1 else None


def parse_tasks_or_exit(text: str) -> List[Task]:
    """解析失败即硬失败；空表绝不能被当成"0 条全部通过"。"""
    tasks = parse_tasks(text)
    if not tasks:
        raise JudgeInputError(
            "契约表解析出 0 条任务 —— 表结构变了或解析器坏了，本次判分作废。")
    return tasks


def _fallback_validate(raw: Any) -> Tuple[bool, List[str]]:
    """没有 `fieldstation` 可导入时的结构检查，口径与 ADR-004 一致。"""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except json.JSONDecodeError as exc:
        return False, [f"结论不是合法 JSON：{exc.msg}"]
    if not isinstance(data, dict):
        return False, ["结论顶层必须是 JSON object"]
    errors: List[str] = []
    if set(data) != {"attribution", "recommendation", "confidence"}:
        errors.append(f"顶层字段必须且只能是 attribution, recommendation, confidence；实际 {sorted(data)}")
    attribution = data.get("attribution")
    if not isinstance(attribution, dict):
        errors.append("attribution 必须是 object")
        attribution = {}
    elif set(attribution) != {"fault_type", "evidence"}:
        errors.append("attribution 只能有 fault_type 与 evidence")
    if not isinstance(attribution.get("fault_type"), str) or not attribution.get("fault_type"):
        errors.append("fault_type 必须是非空字符串")
    if not isinstance(data.get("recommendation"), str) or not data.get("recommendation"):
        errors.append("recommendation 必须是非空字符串")
    confidence = data.get("confidence")
    if isinstance(confidence, bool) or not isinstance(confidence, (int, float)):
        errors.append("confidence 必须是数值")
    elif not (0.0 <= float(confidence) <= 1.0):
        errors.append("confidence 必须在 [0, 1] 内")
    evidence = attribution.get("evidence")
    if not isinstance(evidence, list) or not evidence:
        errors.append("attribution.evidence 至少一条")
    return not errors, errors


# --------------------------------------------------------------------------- CLI
def judge_one(task: Task, events_path: Path, artifacts_root: Optional[Path]) -> dict:
    events = read_events(events_path)
    return Judge(task, events, artifacts_root).run()


def main(argv: Optional[Sequence[str]] = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):  # pragma: no cover
            pass

    try:
        return _main(argv)
    except JudgeInputError as exc:
        print(f"[阻断] {exc}")
        return 2


def _main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(
        description="按 eval-30.md 的 S1–S6 对事件日志机械判分")
    ap.add_argument("--events", help="单条任务的事件 JSONL")
    ap.add_argument("--task", help="任务 id（EV-01…EV-30）")
    ap.add_argument("--events-dir", help="目录：<task_id>.jsonl；与 --runtime 一起用")
    ap.add_argument("--runtime", default="", help="运行时名（写进报告行）")
    ap.add_argument("--artifacts-root", default=None, help="产物根目录（S4 用）")
    ap.add_argument("--contract", default=str(CONTRACT), help="契约文档路径")
    ap.add_argument("--list-tasks", action="store_true", help="打印解析出的任务清单")
    ap.add_argument("--json", action="store_true", help="机读输出")
    args = ap.parse_args(argv)

    tasks = load_tasks(Path(args.contract))
    by_id = {t.task_id: t for t in tasks}

    if args.list_tasks:
        for t in tasks:
            extra = ""
            if t.ranges:
                extra += f"  ranges={t.ranges}"
            if t.exact:
                extra += f"  exact={t.exact}"
            if not t.needs_conclusion:
                extra += "  [不需要结论]"
            print(f"{t.task_id}  {t.view:4}  tools={t.tools}  rules={t.rules}{extra}")
        print(f"\n共 {len(tasks)} 条")
        return 0

    artifacts_root = Path(args.artifacts_root) if args.artifacts_root else None
    rows: List[dict] = []

    if args.events:
        if not args.task:
            print("[阻断] --events 必须配 --task")
            return 2
        task = by_id.get(args.task)
        if task is None:
            print(f"[阻断] 契约里没有任务 {args.task!r}")
            return 2
        rows.append(judge_one(task, Path(args.events), artifacts_root))
    elif args.events_dir:
        root = Path(args.events_dir)
        if not root.is_dir():
            print(f"[阻断] 不是目录：{root}")
            return 2
        for task in tasks:
            path = root / f"{task.task_id}.jsonl"
            if not path.exists():
                rows.append({
                    "task_id": task.task_id, "runtime": args.runtime,
                    "pass": False, "failed_rules": [], "manual_rules": [],
                    "tool_calls": 0, "tokens": 0, "events": 0,
                    "finished_with": "", "blocked": "no_log",
                    "notes": [f"没有 {task.task_id}.jsonl：按契约 §3.3 记为环境阻塞，"
                              "既不判 pass 也不判 fail"],
                })
                continue
            row = judge_one(task, path, artifacts_root)
            if args.runtime and not row["runtime"]:
                row["runtime"] = args.runtime
            rows.append(row)
    else:
        ap.print_help()
        return 2

    if args.json:
        print(json.dumps({"runtime": args.runtime, "rows": rows}, ensure_ascii=False, indent=1))
    else:
        w = max(len(r["task_id"]) for r in rows)
        print(f"{'任务':<{w}}  {'通过':<4} {'失败规则':<12} {'人判':<6} "
              f"{'工具':<4} {'tokens':<8} 说明")
        print("-" * 100)
        for r in rows:
            verdict = "BLOCK" if r.get("blocked") else ("PASS" if r["pass"] else "FAIL")
            failed = ",".join(r["failed_rules"]) or "—"
            manual = ",".join(r["manual_rules"]) or "—"
            note = "" if not r["notes"] else r["notes"][0]
            print(f"{r['task_id']:<{w}}  {verdict:<5} {failed:<12} {manual:<6} "
                  f"{r['tool_calls']:<4} {r['tokens']:<8} {note}")

    passed = sum(1 for r in rows if r["pass"])
    failed = sum(1 for r in rows if not r["pass"] and not r.get("blocked"))
    manual = sum(1 for r in rows if r["manual_rules"])
    blocked = sum(1 for r in rows if r.get("blocked"))
    print(f"\n合计 {len(rows)} 条：PASS {passed}，FAIL {failed}，"
          f"含人判项 {manual}，环境阻塞 {blocked}")
    if manual:
        print("注意：含人判项的行**不算通过**。S6 里只有 EV-08 / EV-20 可机判，"
              "其余要靠报告里的人判结论。")
    return 0 if (failed == 0 and manual == 0 and blocked == 0 and len(rows) > 0) else 1


if __name__ == "__main__":
    sys.exit(main())
