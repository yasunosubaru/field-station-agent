"""进程内消息总线：agent 之间的唯一通信通道，消息全量落 trace（M5-1，issue #60）。

spec §4 的「消息路由」与 §8 的 YAGNI 放在一起得出的形状：五类 Agent 跑在同一条
进程内链路上，**不引任何消息队列中间件**。本模块只做四件事：

* 顺序号消息信封（``Message``）—— 谁、对哪个主题、说了什么、引了哪些上游消息；
* 订阅与投递 —— 收件箱按「发布顺序」排列，没有优先级、没有重投、没有超时；
* 全量留痕 —— 每条消息以 ``message`` 事件写进 trace，**带 payload 本体**；
* 序列化纪律 —— payload 必须是可 JSON 序列化的 dict（NaN/Inf 也拒）。

## 为什么消息正文全量进 trace（与工具结果的 digest 口径不同）

``agents/runtime.py`` 里工具结果只落 ``result_digest``，理由是结果可能是大数组。
消息不同：它是阶段之间**唯一的**信息通道，M5-4 要核对「消息全部可见、不存在
隐藏状态」。若只落 digest，核对就必须重放全部代码才能读出消息内容 —— 那不叫
核对，叫复算。发布方有责任保证 payload 是**小结**；大数组留在工具结果里，由
call_id 引用。本模块用序列化检查把「不可序列化的东西」挡在发布之前。

## 设计决定（非事实断言）

* **同步、单线程、确定性**：``publish`` 立即投递给当前订阅者；没有异步队列，
  没有后台线程，没有定时器。投递顺序 = 发布顺序 = trace 顺序。
* **msg_id 只由发布顺序决定**（``m0001`` 起）。不含时间戳或随机量 —— 这是
  回放式评测「同输入两跑逐字节相同」的前提（同 ``trace/writer.py`` 的纪律）。
* **未订阅的主题照常入 log**：总线是广播记录，不是 RPC。没有收件人不算错，
  但消息必须留痕。
* **重复订阅直接报错**（同 ``ToolRegistry.register`` 的重名口径）：静默去重会让
  「我以为订上了」与「其实没订」在行为上无法区分。
* **``inbox`` 对未订阅的名字抛 KeyError**：接线错（名字拼错）应该在链路的第一轮
  就炸出来，而不是让某个阶段拿到空收件箱继续跑。
* **payload 浅拷贝后保存**：发布后再改原 dict 不改变已发布的消息与 trace。

本模块只用标准库。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # 仅类型标注；运行期不依赖 trace 模块，避免循环导入
    from .trace.writer import TraceWriter


@dataclass(frozen=True)
class Message:
    """一条已发布的消息。``refs`` 是本条消息所引用（消费）的上游 msg_id。"""

    msg_id: str
    topic: str
    sender: str
    payload: dict
    refs: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        """trace / 日志里的标准形状。键集合固定，多了少了都算接口漂移。"""
        return {
            "msg_id": self.msg_id,
            "topic": self.topic,
            "sender": self.sender,
            "refs": list(self.refs),
            "payload": self.payload,
        }


class MessageBus:
    """同步投递的进程内总线；可选挂一个 TraceWriter 做全量留痕。"""

    def __init__(self, trace: "TraceWriter | None" = None) -> None:
        self._trace = trace
        self._messages: list[Message] = []
        self._subscribers: dict[str, list[str]] = {}
        self._inbox: dict[str, list[Message]] = {}

    def subscribe(self, name: str, topic: str) -> None:
        """登记一个收件人。同一 ``(name, topic)`` 重复订阅报错，不静默去重。"""
        if not (name or "").strip():
            raise ValueError("收件人名称不能为空")
        if not (topic or "").strip():
            raise ValueError("订阅主题不能为空")
        subs = self._subscribers.setdefault(topic, [])
        if name in subs:
            raise ValueError(f"重复订阅：{name!r} 已订阅 {topic!r}")
        subs.append(name)
        self._inbox.setdefault(name, [])

    def publish(
        self,
        topic: str,
        sender: str,
        payload: dict | None = None,
        refs: tuple[str, ...] = (),
    ) -> Message:
        """发布一条消息：先校验与拷贝，再投递并写 trace，最后返回消息信封。

        校验失败抛 ``ValueError``，且**什么都不落** —— 半条消息进了 trace 是
        最难查的一种脏数据。
        """
        if not (topic or "").strip():
            raise ValueError("消息主题不能为空")
        if not (sender or "").strip():
            raise ValueError("消息发送者不能为空")
        if payload is None:
            payload = {}
        if not isinstance(payload, dict):
            raise ValueError(
                "消息 payload 必须是 dict（大数组走工具结果，由 call_id 引用）")
        refs = tuple(refs)
        for ref in refs:
            if not (isinstance(ref, str) and ref.strip()):
                raise ValueError(f"refs 只能是非空字符串，收到 {ref!r}")
        body = dict(payload)
        try:
            json.dumps(body, sort_keys=True, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"消息 payload 必须可 JSON 序列化（拒 NaN/Inf）：{exc}") from exc

        message = Message(
            msg_id=f"m{len(self._messages) + 1:04d}",
            topic=topic,
            sender=sender,
            payload=body,
            refs=refs,
        )
        self._messages.append(message)
        for name in self._subscribers.get(topic, ()):
            self._inbox[name].append(message)
        if self._trace is not None:
            self._trace.write("message", message.to_dict())
        return message

    @property
    def messages(self) -> tuple[Message, ...]:
        """按发布顺序的全部消息。"""
        return tuple(self._messages)

    def inbox(self, name: str) -> tuple[Message, ...]:
        """某个收件人按投递顺序收到的消息；未订阅的名字抛 ``KeyError``。"""
        if name not in self._inbox:
            raise KeyError(
                f"未订阅的收件人：{name!r}（已订阅：{sorted(self._inbox)}）")
        return tuple(self._inbox[name])
