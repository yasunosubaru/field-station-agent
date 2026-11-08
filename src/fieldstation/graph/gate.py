# -*- coding: utf-8 -*-
"""原生闸门：用 LangGraph 的 ``interrupt()`` 把图**原地挂起**，进程可以关掉。

## 为什么不用「存个状态位然后 return」

原来五阶段的闸门是「记一个 gate 字段，然后整个执行循环退出来等」。那样有三条
做不到：

| | 存状态位 + return | 原生 ``interrupt()`` |
|---|---|---|
| 等待期间进程 | 得活着，或靠数据库轮询 | **可以关掉** |
| 关机后能不能继续 | **不能**，这次运行丢了 | 能，``Command(resume=)`` 从闸门那行继续 |
| 已完成节点会不会重跑 | 取决于状态位记全不全 | 不会，快照在 checkpointer 里 |

W7 的验收原文是「杀进程重启任务继续」。只有后者做得到。

## 一条必须写进代码的实测事实

`interrupt()` **所在的节点，在恢复时会从函数开头重跑一遍**（实测见
``docs/operations/graph-interrupt.md`` §2）：

```
run 1:  log = ['A-ran', 'gate-before']
resume: log = ['A-ran', 'gate-before', 'gate-before', 'gate-after:...', 'C-ran']
```

- 已完成节点 ``A`` 只跑了一次 —— 这条是好消息，说明"已完成不重跑"成立。
- 闸门节点 ``gate`` 跑了两次 —— ``interrupt()`` **之前**的代码执行了两遍。

**所以闸门节点在 ``interrupt()`` 之前不许有副作用。** 那里如果发了审批通知，
人就会收到两条；如果写了库，就写了两行。这一条不是风格问题：
它就是"重放安全"在这个框架里的具体含义。

本模块只用标准库 + langgraph（可选）。
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional


class InterruptUnavailable(RuntimeError):
    """本机没有可用的 langgraph interrupt / checkpointer。"""


def available() -> bool:
    """探测原生挂起能力（``langgraph.types.interrupt`` + sqlite checkpointer）。"""
    try:
        from langgraph.types import Command, interrupt  # noqa: F401
    except Exception:  # noqa: BLE001 - 版本差异/依赖缺失
        return False
    try:
        import langgraph.checkpoint.sqlite  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


@dataclass
class GateAsk:
    """要人批什么。这些字段会进 ``interrupt()`` 的值，恢复时原样带回来。"""

    stage: str
    action: str
    reason: str = ""
    risk: str = "high"
    confidence: float = 1.0
    #: 附加上下文；只放**可 JSON 化**的东西（interrupt 的值要序列化）
    detail: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "stage": self.stage,
            "action": self.action,
            "reason": self.reason,
            "risk": self.risk,
            "confidence": float(self.confidence),
            "detail": dict(self.detail),
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "GateAsk":
        return cls(
            stage=str(data.get("stage") or ""),
            action=str(data.get("action") or ""),
            reason=str(data.get("reason") or ""),
            risk=str(data.get("risk") or "high"),
            confidence=float(data.get("confidence") or 1.0),
            detail=dict(data.get("detail") or {}),
        )


@dataclass
class GateAnswer:
    """人的结论。``approved=False`` 表示拒绝。"""

    approved: bool
    by: str = ""
    note: str = ""

    def to_dict(self) -> dict:
        return {"approved": bool(self.approved), "by": self.by, "note": self.note}

    @classmethod
    def from_any(cls, value: Any) -> "GateAnswer":
        """接受 dict / bool / "approved" 这类写法，统一成 :class:`GateAnswer`。

        恢复值时接受宽松输入是有意的：人不一定会按我们的格式写。
        """
        if isinstance(value, GateAnswer):
            return value
        if isinstance(value, Mapping):
            return cls(
                approved=bool(value.get("approved")),
                by=str(value.get("by") or ""),
                note=str(value.get("note") or ""),
            )
        if isinstance(value, str):
            return cls(approved=value.strip().lower() in ("approved", "ok", "yes", "true"))
        return cls(approved=bool(value))


def make_checkpointer(path: str | Path):
    """建一个**持久化**的 checkpointer。

    计划书要求「必须用持久化版，否则重启就丢，等于没改」。所以默认给
    sqlite 版；``check_same_thread=False`` 是因为同一进程里图和测试线程会共用。
    """
    if not available():
        raise InterruptUnavailable(
            "没有 langgraph.types.interrupt 或 langgraph-checkpoint-sqlite；"
            "装法：pip install langgraph-checkpoint-sqlite")
    from langgraph.checkpoint.sqlite import SqliteSaver

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    return SqliteSaver(conn)


def thread_config(thread_id: str) -> dict:
    """LangGraph 的线程配置；``thread_id`` 与 ``store.thread`` 表的主键一致。"""
    return {"configurable": {"thread_id": str(thread_id)}}


def interrupt_value(ask: GateAsk) -> Any:
    """在闸门节点里挂起，等一个结论。

    这一层薄封装存在的唯一理由：``interrupt()`` **只能在 langgraph 的执行
    上下文里调**。在上下之外调它会抛，而那时我们其实是想"没人来批"。
    所以这里把它包住，让"图没跑在 langgraph 上"表现成一个可预期的失败，
    而不是一个从框架深处冒出来的异常。

    返回值的语义（实测）：恢复时 ``interrupt()`` 返回 ``Command(resume=...)``
    带进来的那个值；同一个节点在恢复时会**从函数开头重跑**，所以调用点之前
    不能有副作用。
    """
    from langgraph.types import interrupt

    return interrupt(ask.to_dict())
