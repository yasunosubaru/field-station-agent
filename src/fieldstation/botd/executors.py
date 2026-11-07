"""把 `BotMemory` 接到 `Supervisor` 的执行器上：`memory.recall` / `memory.remember`。

## 为什么单独一层，而不是塞进 Supervisor

`Supervisor` 的 `StepSpec.tools` 是**白名单字符串**（`StepSpec` 顶部注释写明了：
"真实工具注册表不在这一步校验，这样 RulePlanner 可以离线跑测试"）。也就是说
执行器是**注入**的：`run(executor=...)` 拿到的是一个 `dict -> Any` 的可调用对象。

所以记忆能力该长成一个"执行器工厂"，而不是给 Supervisor 加构造函数参数——
后者会让拆步与工具实现耦合，而 ADR-009 定的分工恰好是反过来的。

## `memory_missing` 到底表示什么

ADR-009 §"降级梯度" 与契约 EV-13 都要求：**记忆不可用时任务照跑，并标 `memory_missing`**。

这条标记的语义是「**这次运行的结论没有外部记忆支撑**」，不是「记忆写失败了」。
两者要分开，否则一个只读任务（本来就不写记忆）会被误标成降级：

* `bot_memory` 为空或后端降级 → 召回结果标 `memory_missing=True`，任务继续；
* 写入失败 → 同样标 `memory_missing=True`，但 `error` 字段带上原因；
* 一切正常 → `memory_missing=False`。

## 为什么返回值形状要这么严

`Supervisor` 用 `is_failure_result()` 判断是否失败，而它只看**字符串里有没有
"失败"字样**这类约定（见 `supervisor.py` 的 `is_failure_result`）。所以这里的
返回值必须是：

* 成功：`{"ok": True, ...}` —— 带结构化的键，便于下游 consume；
* 记忆不可用但任务可继续：`{"ok": True, "memory_missing": True, ...}` —— **仍然是 ok**，
  因为"没有记忆"不是任务失败（EV-13 明确要求任务 `done`）；
* 真正失败（参数错等）：抛异常或 `{"ok": False, ...}`。
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Mapping, Optional

from .memory import BotMemory


def _flatten_child_payload(child: Mapping[str, Any]) -> Dict[str, Any]:
    """把 `Supervisor` 造的子任务 payload 摊成"工具的入参"。

    `Supervisor.run()` 造子任务时把父 payload **包在 `task` 键下面**
    （见 `supervisor.py` 的 `"payload": {"task": dict(payload), ...}`）。
    所以执行器看到的不是 `{"query": ...}` 而是 `{"task": {"query": ...}, ...}`。

    这个形状很关键：直接 `dict(child["payload"])` 拿到的键是 `task` / `step` /
    `acceptance` / `tools`，真正的参数在下一层，于是 `memory.recall` 收到空 query、
    召回为空 —— 一个不会报错的错误。这里把 `task` 那一层摊上来，
    并保留原键（`step` 之类）供需要时读。
    """

    raw = child.get("payload")
    if not isinstance(raw, Mapping):
        return {}
    inner = raw.get("task")
    if isinstance(inner, Mapping):
        merged: Dict[str, Any] = dict(inner)
        for key, value in raw.items():
            merged.setdefault(str(key), value)
        return merged
    return dict(raw)


class MemoryExecutor:
    """`memory.recall` / `memory.remember` 两个工具的宿主。

    只认这两个工具名；别的调用一律抛 `KeyError`，让"拼错工具名"在第一次就跑出来
    ——静默返回 `{"ok": True}` 会让一个根本没执行的动作记成成功。
    """

    def __init__(self, memory: BotMemory, limit: int = 5) -> None:
        if not isinstance(memory, BotMemory):
            raise TypeError("MemoryExecutor 需要 BotMemory")
        self.memory = memory
        self.limit = max(1, int(limit))

    # ---------------------------------------------------------------- 工具
    def recall(self, bot_id: str, query: str, limit: Optional[int] = None) -> Dict[str, Any]:
        """召回记忆。

        `memory_missing` 的判据是 `BotMemory.degraded`（外部后端没接上/已失败）
        **加上**"本 bot 一条记忆都没有"。后者很重要：一个全新的 bot 召回为空
        与"记忆系统坏了"在界面上要能区分，而 EV-13 要的正是前者也要标出来
        （"不伪造 recall 结果"）。
        """
        if not isinstance(bot_id, str) or not bot_id.strip():
            raise ValueError("memory.recall 需要非空 bot_id")
        size = self.limit if limit is None else max(1, int(limit))
        rows = self.memory.recall(bot_id, str(query or ""), limit=size)
        missing = bool(self.memory.degraded) or not rows
        result: Dict[str, Any] = {
            "ok": True,
            "backend": self.memory.backend_name,
            "degraded": bool(self.memory.degraded),
            "memory_missing": missing,
            "count": len(rows),
            "memories": rows,
        }
        if self.memory.degraded and self.memory.degraded_reason:
            result["reason"] = self.memory.degraded_reason
        return result

    def remember(
        self,
        bot_id: str,
        content: str,
        *,
        key: str = "",
        tags=None,
        source: str = "bot",
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> Dict[str, Any]:
        """写一条记忆。

        写本地一定成功（`BotMemory` 的约定），所以这条返回 `ok: True`；
        外部镜像失败只体现在 `memory_missing` 与 `degraded` 上，**不把任务判失败**
        ——那会让"记忆服务挂了"变成"任务挂了"，与降级梯度的意思相反。
        """
        if not isinstance(bot_id, str) or not bot_id.strip():
            raise ValueError("memory.remember 需要非空 bot_id")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("memory.remember 需要非空 content")
        row = self.memory.remember(
            bot_id,
            content,
            key=str(key or ""),
            tags=tags or (),
            source=str(source or "bot"),
            metadata=metadata,
        )
        result: Dict[str, Any] = {
            "ok": True,
            "id": row.get("id"),
            "backend": row.get("backend", self.memory.backend_name),
            "degraded": bool(row.get("degraded", self.memory.degraded)),
            "memory_missing": bool(row.get("degraded", self.memory.degraded)),
            "external_id": row.get("external_id"),
        }
        if self.memory.degraded and self.memory.degraded_reason:
            result["reason"] = self.memory.degraded_reason
        return result

    # ---------------------------------------------------------------- 分派
    def __call__(self, tool: str, payload: Mapping[str, Any]) -> Dict[str, Any]:
        """按工具名分派。`payload` 是步骤的 `payload`（含 `bot_id` / `query` 等）。"""
        if not isinstance(payload, Mapping):
            raise TypeError("payload 必须是 mapping")
        name = str(tool).strip()
        if name == "memory.recall":
            return self.recall(
                str(payload.get("bot_id") or ""),
                str(payload.get("query") or payload.get("task") or ""),
                payload.get("limit"),
            )
        if name == "memory.remember":
            return self.remember(
                str(payload.get("bot_id") or ""),
                str(payload.get("content") or payload.get("result") or ""),
                key=str(payload.get("key") or ""),
                tags=payload.get("tags"),
                source=str(payload.get("source") or "bot"),
                metadata=payload.get("metadata"),
            )
        raise KeyError(f"MemoryExecutor 不认识工具 {tool!r}（只支持 memory.recall / memory.remember）")

    def as_executor(self, fallback: Optional[Callable[[dict], Any]] = None) -> Callable[[dict], Any]:
        """做成 `Supervisor.run(executor=...)` 能直接用的形状。

        `Supervisor` 递给执行器的是**子任务 dict**（`queue.lease()` 的返回，来自 `task` 表）。
        工具白名单落在 `step` 表（`step.tools`），业务参数落在**子任务的 `payload`**
        （`task.payload`，`queue.lease` 已经给的是解析后的 dict）。

        这两处要分别查：把 payload 当成在 step 表上，就会永远拿到空 dict，
        而"参数为空"在 `memory.recall` 里表现为召回为空 —— 一个静默的错误。
        """

        def _execute(child: dict) -> Any:
            step_id = child.get("step_id")
            step: dict = {}
            if step_id:
                try:
                    step = self.memory.store.get_step(str(step_id))
                except Exception:  # noqa: BLE001 - 查不到就交给 fallback，不在这里崩
                    step = {}
            tools = list(step.get("tools") or [])
            payload = _flatten_child_payload(child)
            payload.setdefault("bot_id", child.get("bot_id") or "")
            for tool in tools:
                if tool in ("memory.recall", "memory.remember"):
                    return self(tool, payload)
            if fallback is not None:
                return fallback(child)
            raise KeyError(
                f"步骤 {step_id!r} 的工具 {tools!r} 里没有 memory.*，且没有给 fallback")

        return _execute
