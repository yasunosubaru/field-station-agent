"""智能体运行时最小核：单轮运行循环 + 确定性 trace 留痕。

本模块是 M0-3 的落地：spec §4 六项能力里，本任务只实现三项
（provider 抽象、trace 决策留痕、最小运行循环）；角色声明式配置、
工具注册、消息路由/共享黑板推迟到 M3 —— 那时才有真实消费者，现在造就是投机。

接口形状（tests/test_runtime.py::TestRun 钉死）：
  * 事件顺序固定为 ``run_start → provider_call → run_end``。
  * 每个事件的 payload 含 ``agent``（智能体名）、``i``（该事件之前已完成的
    provider 调用次数，0 起）、``input_digest``（对用户输入做 SHA256 的前 16 位 hex）。
  * ``run`` 返回 provider 输出的正文字符串。

设计决定（非事实断言）：
  * trace 里**不含时间戳或随机量**，否则同输入两次运行的 trace 无法逐字节相同，
    M0-4 回放式评测基线（同输入同输出）无从成立。若需记录时间，放
    store.product.env_fingerprint() 那类旁路产物里，不进 trace。
  * 单轮循环只有一次 provider 调用，故 ``provider_call`` 的 ``i`` 恒为 0、
    ``run_end`` 的 ``i`` 恒为 1；多轮循环（M3）会沿此计数继续增长。

本模块只用标准库，不接真实模型（M0 用 FakeProvider）。
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field

from .providers.base import ChatMessage, Provider


@dataclass
class Agent:
    """一个可被 ``run`` 驱动的智能体。``tools`` 是声明式工具描述列表，M3 才真正使用。"""

    name: str
    system_prompt: str
    provider: Provider
    tools: list[dict] = field(default_factory=list)


def _digest(user_input: str) -> str:
    return hashlib.sha256(user_input.encode("utf-8")).hexdigest()[:16]


def run(agent: Agent, user_input: str, trace: "TraceWriter") -> str:
    """跑一轮：``run_start → provider_call → run_end``，返回 provider 输出文本。"""
    digest = _digest(user_input)
    trace.write("run_start", {"agent": agent.name, "i": 0, "input_digest": digest})

    messages = [
        ChatMessage(role="system", content=agent.system_prompt),
        ChatMessage(role="user", content=user_input),
    ]
    trace.write("provider_call", {"agent": agent.name, "i": 0, "input_digest": digest})
    response = agent.provider.chat(messages, agent.tools)

    trace.write("run_end", {"agent": agent.name, "i": 1, "input_digest": digest})
    return response.content
