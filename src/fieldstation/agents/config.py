"""声明式 agent 配置：读配置 → 组装 Agent + 白名单注册表，运行时代码零改动。

spec §4 的承诺是「新增 agent 只加配置，不改代码」。本模块把承诺落成约定：

* **判据与循环在别处**：多轮循环在 ``runtime.run``，判据在 ``rules/``，
  工具包装在 ``tools/``。本模块只做三件事——读配置、按白名单**过滤**出这个
  agent 能看到的工具注册表视图、把装配好的 ``Agent`` 交回去。
* **白名单以过滤实现，不以放行实现**：不在白名单里的工具对一个 agent 就是
  「未注册」（runtime 的未注册路径天然拒它），而不是「注册了但被审一道」。
  这样一处装配覆盖所有 agent，runtime 不需要知道白名单这个概念。
* **输出契约先做成配置里的声明**（供 system prompt 与评审引用）；把每条结论
  「必须引用工具输出」变成**可校验结构**是 M3-2（issue #52）的事，本模块不做
  半套校验。

设计决定（非事实断言）：

* 校验失败在加载/装配时抛 ``ValueError``（含配置路径与已注册工具清单）——
  配置错误是启动期错误，宁可炸在起飞前，不能跑到一半才发现工具不存在。
* 本模块只用标准库。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from .runtime import Agent
from .providers.base import Provider
from .tools import ToolRegistry

REQUIRED_FIELDS = ("name", "system_prompt", "tools", "provider")


@dataclass
class AgentConfig:
    """一个 agent 的声明式配置。字段含义见配置文件里的 _说明。"""

    name: str
    system_prompt: str
    tools: list[str] = field(default_factory=list)
    provider: str = ""
    output_contract: str = ""


def load_agent_config(path: str) -> AgentConfig:
    """从 JSON 文件读一份 agent 配置并做基本校验。

    缺必需字段、字段为空、白名单重名，一律抛 ``ValueError``，
    报错里带上文件路径 —— 专改配置的人不该翻栈找错。
    """
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raise ValueError(f"agent 配置必须是 JSON object（文件：{path}）")
    missing = [k for k in REQUIRED_FIELDS if not raw.get(k)]
    if missing:
        raise ValueError(f"agent 配置缺必需字段 {missing}（文件：{path}）")
    if not isinstance(raw["tools"], list) or not all(
            isinstance(name, str) and name.strip() for name in raw["tools"]):
        raise ValueError(
            f"agent 配置的 tools 必须是非空字符串数组（文件：{path}）")
    tools = list(raw["tools"])
    if len(set(tools)) != len(tools):
        raise ValueError(f"agent 配置的工具白名单有重名（文件：{path}）：{tools}")
    if not raw["system_prompt"].strip():
        raise ValueError(f"agent 配置的 system_prompt 不能是空白（文件：{path}）")
    return AgentConfig(
        name=raw["name"],
        system_prompt=raw["system_prompt"],
        tools=tools,
        provider=raw["provider"],
        output_contract=raw.get("output_contract", ""),
    )


def build(cfg: AgentConfig, provider: Provider, base: ToolRegistry) -> tuple[Agent, ToolRegistry]:
    """按配置装配出可直接交给 ``runtime.run`` 的 ``(Agent, 过滤注册表)``。

    白名单里的名字必须是 ``base`` 里**已注册**的工具，否则抛 ``ValueError``
    （附完整已注册清单）—— 配置里的一个拼写错误不该等到模型真去调它才发现。
    """
    unknown = [t for t in cfg.tools if base.get(t) is None]
    if unknown:
        raise ValueError(
            f"agent {cfg.name!r} 的工具白名单引用了未注册的工具 {unknown}；"
            f"已注册：{base.names()}")

    scoped = ToolRegistry()
    for name in cfg.tools:
        scoped.register(base.get(name))

    agent = Agent(
        name=cfg.name,
        system_prompt=cfg.system_prompt,
        provider=provider,
        tools=scoped.describe(),
    )
    return agent, scoped
