"""编队台交互层的**后端**：任务树、事件流、三种受控干预。

## 为什么这一层要单独存在

ADR-009 §"交互层（人与正在跑的 bot）"写得很具体：

> 编队台的交互抽屉 = **任务树 + 事件流 + 三种受控干预**，不是聊天窗口的复制品
>
> | 形态 | 内容 |
> | 任务树 | Supervisor 为根，每个 worker 一步；点开看输入、工具调用、证据、耗时 |
> | 事件流 | 派发 → 执行中（工具/耗时）→ 停闸门 → 已批准 → 完成 |
> | 干预 | 暂停/继续（任何人）、改参重试（记审计）、接管该步（需审批） |
> | 对话 | 可以和大 bot 自由对话；也可下钻到某个小 bot 的任务步直接对话/接管 |
>
> 干预指令进 `intervention` 表，由 DBOS 在**步骤边界**消费（不在工具执行中途强插）。

`botd/store.py` 已经有 `task` / `step` / `intervention` / `run_link` 四张表，
`botd/supervisor.py` 已经有拆步与队列。缺的是**把四张表读成一棵能点的树**、
**把干预写进制裁表并说清"什么时候生效"**这一层。

本模块只做这两件事，不执行、不调度、不判断——那三件分别是 DBOS / LangGraph / 人工的事。

## 三种干预的语义区别（这是本模块最容易做错的地方）

| kind | 谁可以 | 生效时机 | 为什么要区分 |
|---|---|---|---|
| `pause` | 任何人 | **步骤边界** | 工具执行中途强插会留下半截的 `tool.result`，那是审计上的灾难 |
| `resume` | 任何人 | 立即（下一个边界） | 与 pause 对称 |
| `retry` | 任何人，但**必须记审计** | 该步重跑 | 改参重试会改写输入，不记清楚就没人能解释"为什么这次结果不同" |
| `takeover` | **需审批** | 该步由人接管 | 接管是"人替代 bot 做决定"，与"改参数"不同，必须过审批门 |

`takeover` 需要审批，所以本模块**不自己批准它**：它写一条 `pending` 的干预，
并要求调用方给出审批结论（`approval_id`）。把"需要审批"和"已经批了"混在一个
布尔量里，是这类交互层最常见的漏洞。

## 为什么不在这里判断"暂停点在哪"

ADR-009 明写「由 DBOS 在**步骤边界**消费」。所以本模块只负责**记下"要暂停"**，
并提供 `effective_boundary()` 告诉调用方"这条干预会在哪个边界生效"——
真正的"停下来"发生在 `Supervisor._drive()` 的循环里（它每领取一步都是一个边界）。

这条分工不是洁癖：如果这里自己判断"现在能不能停"，就会和 Supervisor 的循环
各有一套"边界"的定义，两边迟早不一致，表现是"点了暂停但没停"或"停在了工具中间"。
"""

from __future__ import annotations

from typing import Any, Dict, List, Mapping, Optional, Sequence

from .store import BotStore

#: 三种受控干预 + 一个"继续"（ADR-009 把继续与暂停算一类，这里分开更好读）。
INTERVENTION_KINDS = ("pause", "resume", "retry", "takeover")

#: 只有这几种需要审批。"暂停/继续"是任何人的权利，不该被审批门挡住——
#: 出故障时需要立刻停，让人去等审批是反的。
NEEDS_APPROVAL = ("takeover",)

#: 干预的终态。与 `BotStore.resolve_intervention()` 的白名单**必须是同一份**：
#: 之前这里多写了一个 `cancelled`，于是"终态判定"与"可写入状态"不一致，
#: 表现为 `resolve(status="cancelled")` 抛 `ValueError` 而不是 `InterventionError`。
_TERMINAL_STATUS = ("resolved", "rejected", "expired")


class InterventionError(RuntimeError):
    """干预本身不合法（未知 kind、缺必填、已经终态还想改）。"""


class InteractionBoard:
    """把四张表读成"一棵树 + 一条流 + 一叠待办"，并写受控干预。

    无状态：所有东西都在 `BotStore` 里，所以多进程/多窗口看到的是同一份。
    这点很重要——编队台可能同时开在主窗口与某个下钻窗口里。
    """

    def __init__(self, store: BotStore) -> None:
        if not isinstance(store, BotStore):
            raise TypeError("InteractionBoard 需要 BotStore")
        self.store = store

    # ================================================================ 任务树
    def tree(self, root_task_id: str) -> Dict[str, Any]:
        """以某个任务为根，返回它 + 它的全部子任务与步骤。

        形状（前端直接用，不要再加工）：

            {
              "root": {task...},
              "steps": [ {step..., "task": {子任务...} | None}, ... ],
              "children": [ {task..., "steps": [...]}, ... ],
              "counts": {"steps": n, "done": n, "failed": n, "pending": n},
            }

        `steps` 与 `children` 都按 `idx` 排序：任务树的阅读顺序必须稳定，
        否则每次刷新位置都在跳，用户点错是迟早的事。
        """
        root = self.store.get_task(str(root_task_id))
        steps = self.store.list_steps(root["task_id"])
        steps.sort(key=lambda s: int(s.get("idx") or 0))

        children = self.store.list_tasks(parent_task_id=root["task_id"])
        children.sort(key=lambda t: (int(t.get("priority") or 0) * -1,
                                     str(t.get("created_at") or "")))

        # 每个 step 关联到"执行它的那个子任务"（step.task_ref → task.id）。
        by_id = {str(t["task_id"]): t for t in children}
        merged: List[Dict[str, Any]] = []
        for step in steps:
            child = by_id.get(str(step.get("task_ref") or ""))
            item = dict(step)
            item["task"] = child
            item["acceptance"] = step.get("acceptance") or ""
            item["tools"] = list(step.get("tools") or [])
            merged.append(item)

        counts = {
            "steps": len(merged),
            "done": sum(1 for s in merged if s.get("status") == "done"),
            "failed": sum(1 for s in merged if s.get("status") == "failed"),
            # `skipped` 必须单列：`STEP_STATUSES` 有五个值，只数三档会让
            # done+failed+pending != steps（有一步 skipped 时），而进度条按
            # 前三个算就会永远卡在 N/N+1。
            "skipped": sum(1 for s in merged if s.get("status") == "skipped"),
            "pending": sum(1 for s in merged
                           if s.get("status") in ("pending", "running")),
        }
        return {"root": root, "steps": merged, "children": children, "counts": counts}

    def forest(self, *, limit: int = 50) -> List[Dict[str, Any]]:
        """所有顶层任务（没有 parent 的），按创建时间倒序。

        编队台的首屏要的是"现在在跑什么"，不是"全部历史"。所以默认只取顶层，
        子任务要点进去才看——一屏塞几百个嵌套节点，等于什么都看不到。
        """
        top = [t for t in self.store.list_tasks() if not t.get("parent_task_id")]
        top.sort(key=lambda t: str(t.get("created_at") or ""), reverse=True)
        out: List[Dict[str, Any]] = []
        for task in top[: max(1, int(limit))]:
            steps = self.store.list_steps(task["task_id"])
            out.append({
                "task": task,
                "step_count": len(steps),
                "done": sum(1 for s in steps if s.get("status") == "done"),
                "failed": sum(1 for s in steps if s.get("status") == "failed"),
                "open_interventions": len([
                    i for i in self.store.list_interventions(status="pending")
                    if str(i.get("task_id") or "") == str(task["task_id"])]),
            })
        return out

    # ================================================================ 事件流
    def event_stream(self, task_id: str) -> List[Dict[str, Any]]:
        """把任务的步骤状态变化折成一条有顺序的流。

        ADR-009 的形态是「派发 → 执行中（工具/耗时）→ 停闸门 → 已批准 → 完成」。

        这里**只从数据库现状推导**，不读运行日志。理由：日志是 `trace.jsonl` 那种
        逐步追加的东西，而编队台要的是"现在卡在哪"，两者口径不同。
        数据库里有 `created_at` / `updated_at` / `attempts` / `last_error`，
        足够拼出一条人看得懂的流；要更细的工具调用细节，去点开某一步看 trace。

        每条事件的 `at` 可能为 `None`（老数据没有该字段）——**不猜时间**，
        让前端按顺序展示而不是编一个时间戳出来。
        """
        task = self.store.get_task(str(task_id))
        steps = self.store.list_steps(task["task_id"])
        steps.sort(key=lambda s: int(s.get("idx") or 0))
        interventions = [i for i in self.store.list_interventions()
                         if str(i.get("task_id") or "") == str(task["task_id"])]
        interventions.sort(key=lambda i: str(i.get("created_at") or ""))

        flow: List[Dict[str, Any]] = [{
            "phase": "dispatched",
            "at": task.get("created_at"),
            "label": f"派发：{task.get('title') or task.get('kind')}",
            "task_id": task["task_id"],
        }]

        for step in steps:
            name = step.get("name") or step.get("kind") or "（未命名步骤）"
            status = step.get("status")
            attempts = int(step.get("attempts") or 0)
            base = {"step_id": step["id"], "step": name, "attempts": attempts,
                    "at": step.get("updated_at") or step.get("created_at")}
            if status == "done":
                flow.append({**base, "phase": "completed", "label": f"完成：{name}"})
            elif status == "failed":
                flow.append({**base, "phase": "failed",
                             "label": f"失败：{name}",
                             # `step` 表的列名是 `error`；`last_error` 是 **task** 表的列。
                             # 拿错列名的后果不是报错，是永远取到空串——事件流上
                             # 看得见"失败"却看不到原因，排查时最需要的那句话没了。
                             "error": step.get("error") or ""})
            elif status == "skipped":
                # `skipped` 是 STEP_STATUSES 里的合法值。归到 queued 会写成
                # "待执行：跳过的一步"，读起来像还在排队，而它其实已经结束了。
                flow.append({**base, "phase": "skipped", "label": f"跳过：{name}"})
            elif status == "running":
                flow.append({**base, "phase": "running", "label": f"执行中：{name}"})
            else:
                flow.append({**base, "phase": "queued", "label": f"待执行：{name}"})
            if attempts > 1:
                # 重试是审计重点：同一名字出现多次、看起来像重复行，
                # 不标出来会让人以为流程卡住了。
                flow.append({**base, "phase": "retried",
                             "label": f"重试第 {attempts} 次：{name}"})

        for item in interventions:
            kind = str(item.get("kind") or "")
            status = str(item.get("status") or "")
            flow.append({
                "phase": f"intervention:{kind}",
                "at": item.get("created_at"),
                "label": f"干预 {kind}（{status}）：{item.get('prompt') or ''}".strip(),
                "intervention_id": item.get("id"),
                "status": status,
            })

        # 有时间的按时间排；没有时间的保持插入顺序（稳定排序，Python 的 sort 保证）。
        flow.sort(key=lambda e: (0, "") if e.get("at") is None else (1, str(e["at"])))
        return flow

    # ================================================================ 干预
    def request(
        self,
        kind: str,
        *,
        task_id: Optional[str] = None,
        bot_id: Optional[str] = None,
        prompt: str = "",
        step_id: Optional[str] = None,
        approval_id: Optional[str] = None,
        parametrized: bool = False,
    ) -> Dict[str, Any]:
        """写一条干预。

        三条硬规矩：

        1. **未知 kind 直接拒绝**，不静默接受。`intervention` 表里出现一个没人认得的
           kind，下游（DBOS 的消费者）会直接忽略它，然后"点了没反应"，且没人知道为什么。
        2. **`takeover` 必须带 `approval_id`**。这是"人替代 bot 做决定"，
           与"改参数重试"不是一个重量级。没有审批结论的接管必须被拒。
        3. **`retry` 必须说明改了什么**。ADR-009 要求"改参重试（记审计）"——
           一条没有任何说明的 retry，等于无法解释的输入变更。
        """
        kind = str(kind or "").strip().lower()
        if kind not in INTERVENTION_KINDS:
            raise InterventionError(
                f"未知的干预类型 {kind!r}；只支持 {', '.join(INTERVENTION_KINDS)}")
        if not task_id and not bot_id:
            raise InterventionError("干预必须指向 task_id 或 bot_id（否则没人知道该停谁）")
        if kind in NEEDS_APPROVAL and not approval_id:
            raise InterventionError(
                f"{kind} 需要审批：请先拿到审批结论并传 approval_id")
        if kind == "retry" and not (prompt.strip() or parametrized):
            raise InterventionError(
                "retry 必须说明改了什么（prompt 写清改动，或 parametrized=True 走改参路径）；"
                "没有说明的重试无法解释输入变更")

        note = prompt.strip()
        meta = {
            "step_id": str(step_id or ""),
            "approval_id": str(approval_id or ""),
            "parametrized": bool(parametrized),
        }
        row = self.store.add_intervention(
            kind=kind,
            task_id=task_id,
            bot_id=bot_id,
            # `intervention` 表没有 metadata 列，所以把这些拼进 prompt ——
            # 不是"偷懒"，是这张表的 schema 已经定了，加列要迁移，而这条信息
            # 只要能被人读到、能被审计就够。
            prompt=_compose_prompt(note, meta),
        )
        result = dict(row)
        result["needs_approval"] = kind in NEEDS_APPROVAL
        result["effective_at"] = self.effective_boundary(row)
        return result

    def resolve(
        self,
        intervention_id: str,
        response: str,
        *,
        status: str = "resolved",
    ) -> Dict[str, Any]:
        """给一条干预一个结论。

        允许三种：`resolved` / `rejected` / `expired`。

        **刻意不支持 `cancelled`**：`BotStore.resolve_intervention()` 的白名单是
        前三个，而 `_TERMINAL_STATUS` 里原先多写了一个 `cancelled` —— 三处定义不一致，
        调用方 `except InterventionError` 会漏掉它抛出的 `ValueError`。现在两边对齐成
        同一份：这里的校验就是唯一入口，越过它不可能写进库。

        已经终态的不能再改：干预是审计记录，允许反复改写等于允许篡改。
        """
        allowed = ("resolved", "rejected", "expired")
        if status not in allowed:
            raise InterventionError(
                f"status 只能是 {' / '.join(allowed)}，收到 {status!r}")
        current = self.store.get_intervention(str(intervention_id))
        current_status = str(current.get("status") or "")
        if current_status in _TERMINAL_STATUS:
            raise InterventionError(
                f"干预 {intervention_id!r} 已经是终态 {current_status!r}，"
                "审计记录不允许改写")
        return self.store.resolve_intervention(intervention_id, str(response or ""),
                                               status=status)

    def effective_boundary(self, intervention: Mapping[str, Any]) -> Dict[str, Any]:
        """这条干预什么时候生效。

        返回值是给界面用的一句话说清，**不在这里真的去停**（那是 DBOS 的事）。

        - `pause` / `resume`：下一个步骤边界（正在跑的那一步会跑完，工具不会被强插）；
        - `retry`：目标步骤重跑时；
        - `takeover`：目标步骤被人工接管时（需审批已通过）。
        """
        kind = str(intervention.get("kind") or "")
        step_id = _extract(intervention.get("prompt") or "", "step_id")
        if kind in ("pause", "resume"):
            return {
                "kind": kind,
                "when": "next_step_boundary",
                "note": "正在执行的步骤会跑完，不会在工具中途强插（ADR-009）",
            }
        if kind == "retry":
            return {
                "kind": kind,
                "when": "step_restart",
                "step_id": step_id,
                "note": "该步按新参数重跑；旧尝试保留在 attempts 里",
            }
        if kind == "takeover":
            return {
                "kind": kind,
                "when": "step_handover",
                "step_id": step_id,
                "note": "需审批已通过；接管后该步不再由 bot 执行",
            }
        return {"kind": kind, "when": "unknown",
                "note": "未知类型：生效时机由消费方决定"}

    # ================================================================ 待办
    def pending(self, *, task_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """所有还没结论的干预，按创建时间正序（先点的先处理）。

        编队台右上角那个"待处理 N"就读这个。按时间正序而不是倒序：
        待办是队列，不是流水账。
        """
        rows = self.store.list_interventions(status="pending")
        if task_id:
            rows = [r for r in rows if str(r.get("task_id") or "") == str(task_id)]
        rows.sort(key=lambda r: str(r.get("created_at") or ""))
        out = []
        for row in rows:
            item = dict(row)
            item["needs_approval"] = str(row.get("kind") or "") in NEEDS_APPROVAL
            item["effective_at"] = self.effective_boundary(row)
            out.append(item)
        return out


# --------------------------------------------------------------------------- 小工具
def _compose_prompt(note: str, meta: Mapping[str, Any]) -> str:
    """把备注与结构化字段合成一段人可读、又可解析回去的文本。

    `intervention` 表只有 `prompt TEXT` 一个自由字段，没有 `metadata` 列。
    加列要迁移；而这条信息的用途是"被人看见、能被审计"，不是被高频查询，
    所以拼进文本足够。格式固定成 `key=value` 且用 `;` 分隔，
    这样 `_extract()` 能稳定拿回来——不用正则猜。
    """
    parts = [note] if note else []
    for key in ("step_id", "approval_id", "parametrized"):
        value = meta.get(key)
        if value:
            parts.append(f"{key}={value}")
    return " ; ".join(parts)


def _extract(text: str, key: str) -> str:
    """从 `_compose_prompt()` 造出的文本里取一个字段；取不到返回空串。"""
    prefix = f"{key}="
    for chunk in str(text).split(";"):
        chunk = chunk.strip()
        if chunk.startswith(prefix):
            return chunk[len(prefix):].strip()
    return ""


def summarize_kinds(rows: Sequence[Mapping[str, Any]]) -> Dict[str, int]:
    """按 kind 计数。界面上的"暂停 2 / 重试 1"这种小标就靠它。"""
    counts: Dict[str, int] = {kind: 0 for kind in INTERVENTION_KINDS}
    for row in rows:
        kind = str(row.get("kind") or "")
        if kind in counts:
            counts[kind] += 1
    return counts
