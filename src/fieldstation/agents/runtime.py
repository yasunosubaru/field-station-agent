"""智能体运行时：多轮循环 + 工具派发 + 人工审批门 + 确定性 trace 留痕。

M0-3 刚落成时这里只有一个单轮循环（``run_start → provider_call → run_end``）。
本文件在不破坏那条契约的前提下长出多轮：模型要调工具就调，调完把结果回喂，
再让它说下一句；高风险动作先过人工审批门，不批就不执行。

## 向后兼容（tests/test_runtime.py 钉死，不能破）

* 没有 tool_calls 时，事件仍是 ``run_start → provider_call → run_end`` 三个；
* 这三个事件的 payload 键集合固定为 ``kind / agent / i / input_digest``；
* 同输入两次运行 trace 逐字节相同。

新增的事件（``tool_call`` / ``tool_result`` / ``approval`` / ``truncated``）
只在真的发生时才出现，并且同样不含时间戳或随机量。

## 事件顺序与 ``i`` 的含义

``i`` 是该事件**之前已完成的 provider 调用次数**，0 起。所以：

    run_start      i=0
    provider_call  i=0     ← 第一次调用前
    tool_call      i=1     ← 第一次调用已返回
    tool_result    i=1
    provider_call  i=1     ← 第二次调用前
    run_end        i=2

## 设计决定（非事实断言）

* **trace 里不放工具结果本体**，只放 ``result_digest``。理由有两条：
  结果可能是个大数组，会让 trace 无法逐行比对；更重要的是分叉要看得见 ——
  两次运行的 trace 逐字节相同才是基线，掺进大块数据只会让差异更难定位。
  真要结果本身，回放时按 ``args`` 重算即可。
* **未注册的工具按高风险处理**：不执行、报失败。模型编一个工具名出来，
  不能因为它猜了个名就绕过敏捷的判据链。
* ``max_turns`` 是硬上限。模型可以一直要求调工具，没有上限这就是个死循环。
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field

from .approval import ApprovalGate, ApprovalRequest
from .providers.base import ChatMessage, Provider
from .tools import ToolRegistry, ToolResult

MAX_TURNS_DEFAULT = 4


@dataclass
class Agent:
    """一个可被 ``run`` 驱动的智能体。``tools`` 是声明式工具描述列表，M3 才真正使用。"""

    name: str
    system_prompt: str
    provider: Provider
    tools: list[dict] = field(default_factory=list)


def _digest(user_input: str) -> str:
    return hashlib.sha256(user_input.encode("utf-8")).hexdigest()[:16]


def _result_digest(data: dict) -> str:
    """对工具结果做稳定摘要。

    用 ``sort_keys`` 保证同样的 dict 得到同样的摘要 —— 否则回放时两次运行
    结果相同、摘要不同，基线就白建了。
    """
    canonical = json.dumps(data, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _base(trace: "TraceWriter", agent_name: str, i: int, digest: str) -> dict:
    """三个原始事件共用的 payload 前缀。**键集合不许加**（见文件头「向后兼容」）。"""
    return {"agent": agent_name, "i": i, "input_digest": digest}


def _dispatch(
    agent: Agent,
    call: dict,
    trace: "TraceWriter",
    digest: str,
    i: int,
    registry: ToolRegistry | None,
    approval: ApprovalGate | None,
    messages: list[ChatMessage],
) -> None:
    """执行一次工具调用，并把结果追加进对话。"""
    name = call.get("name", "")
    args = call.get("args") or {}
    tool = registry.get(name) if registry is not None else None

    approved = True
    if tool is not None and approval is not None:
        request = ApprovalRequest(
            agent=agent.name, action=name,
            reason=call.get("reason", ""),
            confidence=call.get("confidence", 1.0),
            risk=tool.risk,
        )
        if approval.needs_approval(request):
            record = approval.decide(request)
            trace.write("approval", {
                **_base(trace, agent.name, i, digest),
                "action": name,
                "verdict": record.verdict,
                "by": record.by,
                "confidence": record.confidence,
                "risk": record.risk,
            })
            approved = record.verdict == "approved"

    if tool is None:
        # 未注册的工具按高风险看待：不执行。模型编个工具名出来，
        # 不能靠猜名字绕过 rules/ 的判据链。
        trace.write("tool_call", {**_base(trace, agent.name, i, digest),
                                  "tool": name, "args": args, "approved": False})
        result = ToolResult(ok=False, error=f"未注册的工具：{name!r}")
    elif not approved:
        trace.write("tool_call", {**_base(trace, agent.name, i, digest),
                                  "tool": name, "args": args, "approved": False})
        result = ToolResult(ok=False, error="未获人工批准，未执行")
    else:
        trace.write("tool_call", {**_base(trace, agent.name, i, digest),
                                  "tool": name, "args": args, "approved": True})
        result = tool.invoke(args)

    payload = {
        **_base(trace, agent.name, i, digest),
        "tool": name,
        "ok": result.ok,
        "error": result.error,
    }
    if result.ok:
        payload["result_digest"] = _result_digest(result.data)
    trace.write("tool_result", payload)

    if result.ok:
        body = json.dumps(result.data, sort_keys=True, ensure_ascii=False)
    else:
        body = f"失败：{result.error}"
    messages.append(ChatMessage(role="tool", content=f"[{name}] {body}"))


def run(
    agent: Agent,
    user_input: str,
    trace: "TraceWriter",
    *,
    registry: ToolRegistry | None = None,
    approval: ApprovalGate | None = None,
    max_turns: int = MAX_TURNS_DEFAULT,
) -> str:
    """跑一个任务：可以多轮，每轮都可以调工具；高风险动作先过审批门。

    返回模型最后一次的正文字符串。``registry`` 与 ``approval`` 都不传时行为
    与 M0 的单轮循环完全一致 —— 老调用方不必改。
    """
    digest = _digest(user_input)
    trace.write("run_start", _base(trace, agent.name, 0, digest))

    messages = [
        ChatMessage(role="system", content=agent.system_prompt),
        ChatMessage(role="user", content=user_input),
    ]

    calls = 0
    content = ""
    while True:
        trace.write("provider_call", _base(trace, agent.name, calls, digest))
        response = agent.provider.chat(messages, agent.tools)
        calls += 1
        content = response.content

        if not response.tool_calls:
            break
        for call in response.tool_calls:
            _dispatch(agent, call, trace, digest, calls, registry, approval, messages)

        if calls >= max_turns:
            trace.write("truncated", {**_base(trace, agent.name, calls, digest),
                                      "max_turns": max_turns})
            break

    trace.write("run_end", _base(trace, agent.name, calls, digest))
    return content
