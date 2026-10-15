#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""agent_demo.py —— 多轮运行循环的确定性演示（不接真实模型）。

    $env:PYTHONPATH="src"; python harness/agent_demo.py

## 这个脚本是干什么的

它把 runtime.run 的多轮能力走一遍：模型先要求调 ``robust_stats`` 工具，
拿到结果后再给结论。高风险动作那一步会走到人工审批门 —— 演示里用
``RejectAll``，所以你会看到工具**被拦下、没有执行**。

**这不是产品智能体。** 这里的「模型」是写死的脚本（``ScriptedProvider``），
不会思考，只是按预定顺序发声。真实模型在 M3 接入；接入之前跑这个脚本，
验证的是运行时本身接对了线，不是验证了任何智能体能力。

## 为什么要求确定性

两次运行输出必须逐字节相同（脚本末尾自己断言）。trace 里没有时间戳或随机量，
这是回放式评测的地基 —— 演示脚本要是两次跑得不一样，那才说明线接错了。

本脚本只用标准库。
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fieldstation.agents import runtime                              # noqa: E402
from fieldstation.agents.approval import ApprovalGate, RejectAll     # noqa: E402
from fieldstation.agents.providers.base import ChatMessage, ChatResponse, Provider  # noqa: E402
from fieldstation.agents.tools import ToolRegistry                   # noqa: E402
from fieldstation.agents.tools.qc_tools import robust_stats_tool     # noqa: E402
from fieldstation.agents.trace.reader import read_trace              # noqa: E402
from fieldstation.agents.trace.writer import TraceWriter            # noqa: E402


class ScriptedProvider(Provider):
    """按脚本发声的假模型。

    第一次要求调 robust_stats，第二次给结论。真实模型在 M3 接入前，
    只能这样把多轮循环的前后两轮都走到。
    """

    name = "scripted"

    def __init__(self, rounds):
        self._rounds = rounds
        self._i = 0

    def chat(self, messages: list[ChatMessage], tools: list[dict]) -> ChatResponse:
        if self._i >= len(self._rounds):
            raise RuntimeError("ScriptedProvider 已用尽")
        r = self._rounds[self._i]
        self._i += 1
        return r


# 一组含离群点的观测：第九个值 50.0 明显不像同批数据
OBSERVATIONS = [1.02, 0.98, 1.05, 1.01, 0.99, 1.03, 1.00, 1.04, 50.0, 0.97]

ROUNDS = [
    # 第一轮：要工具
    ChatResponse(
        content="",
        tool_calls=[{
            "name": "robust_stats",
            "args": {"values": OBSERVATIONS},
            "reason": "第九个值 50.0 与其余不在一个量级，先算稳健统计",
            "confidence": 0.95,
        }],
    ),
    # 第二轮：拿到工具结果后给结论
    ChatResponse(content="历元 9 的稳健 z 分数显著高于其余历元，判为离群候选。"),
]


def main() -> int:
    registry = ToolRegistry()
    registry.register(robust_stats_tool())
    tool = registry.get("robust_stats")
    tool.risk = "high"          # 演示用：把统计工具升级为高风险，好让审批门真的被走到

    tmp = tempfile.mkdtemp(prefix="agent_demo_")
    trace_path = Path(tmp) / "agent.jsonl"

    agent = runtime.Agent(
        name="qc",
        system_prompt="你是数据质量校验智能体的雏形。只做统计描述与离群候选识别，"
                      "不自行决定停机或派单。",
        provider=ScriptedProvider(ROUNDS),
        tools=registry.describe(),
    )

    print("=" * 70)
    print("运行（高风险的 robust_stats 会被 RejectAll 拦下）")
    print("=" * 70)
    answer = runtime.run(
        agent,
        "看一下这十个历元有没有离群候选",
        TraceWriter(trace_path),
        registry=registry,
        approval=ApprovalGate(approver=RejectAll()),
    )
    print("模型结论：", answer)
    print()

    events = read_trace(trace_path)
    print(f"trace {len(events)} 条事件（{trace_path}）：")
    for e in events:
        detail = {k: v for k, v in e.items() if k not in ("kind", "agent", "input_digest")}
        print(f"  {e['kind']:<13} i={e['i']}  {detail}")
    print()

    # 自校验：高风险被拦下时，工具不得执行
    results = [e for e in events if e["kind"] == "tool_result"]
    approvals = [e for e in events if e["kind"] == "approval"]
    blocked = [e for e in results if not e["ok"]]
    if len(blocked) != 1:
        print(f"[红] 预期恰好一次被拦下的工具结果，实际 {len(blocked)} 次")
        return 1
    if "批准" not in (blocked[0]["error"] or ""):
        print(f"[红] 拦下原因不含「批准」：{blocked[0]['error']}")
        return 1
    if len(approvals) != 1 or approvals[0]["verdict"] != "rejected":
        print("[红] 审批门没有被走到，或结论不是 rejected")
        return 1
    print("[OK] 高风险工具被人工审批门拦下，未执行")

    # 自校验：两次运行 trace 逐字节相同
    second = Path(tmp) / "agent_again.jsonl"
    runtime.run(
        runtime.Agent(name=agent.name, system_prompt=agent.system_prompt,
                      provider=ScriptedProvider(ROUNDS), tools=agent.tools),
        "看一下这十个历元有没有离群候选",
        TraceWriter(second),
        registry=_new_registry(),
        approval=ApprovalGate(approver=RejectAll()),
    )
    if trace_path.read_text(encoding="utf-8") != second.read_text(encoding="utf-8"):
        print("[红] 两次运行 trace 不一致 —— 回放基线不成立")
        return 1
    print("[OK] 两次运行 trace 逐字节相同")

    print()
    print("放行版把 approver 换成 ApproveAll() 即可看到工具真的执行。")
    return 0


def _new_registry() -> ToolRegistry:
    r = ToolRegistry()
    t = robust_stats_tool()
    t.risk = "high"
    r.register(t)
    return r


if __name__ == "__main__":
    sys.exit(main())