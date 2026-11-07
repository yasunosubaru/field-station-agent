# 编队台交互层（`botd/interaction.py`）：职责边界与前端接法

- 状态：**后端已落地并有测试**；UI 未做，`Supervisor` 消费干预的循环未接
- 代码：`src/fieldstation/botd/interaction.py`
- 测试：`tests/test_botd_interaction.py`（30 项，单元）、
  `tests/test_botd_interaction_wiring.py`（26 项，与 Supervisor / 记忆执行器的组合）
- 上游依据：ADR-009 §"交互层（人与正在跑的 bot）"

---

## 1. 这一层只做两件事

| 做 | 不做 |
|---|---|
| 把 `task` / `step` / `intervention` 读成**一棵树**、**一条流**、**一叠待办** | **不执行**任何步骤（那是 `Supervisor` / `Executor`） |
| 把三种受控干预**写进** `intervention` 表，并说清它会在什么时候生效 | **不调度**（那是 `TaskQueue` / DBOS） |
| 校验干预本身合不合法（未知 kind、缺审批、retry 没说明） | **不判断**业务对错（那是 LangGraph / 人） |

一句话：**读成树/流 + 写干预**。它没有自己的状态——所有东西都在 `BotStore` 里，
所以主窗口与某个下钻窗口同时打开时看到的是同一份（多进程也一样）。

### 三种干预的生效时机

| kind | 谁可以下 | 什么时候才真的生效 | 为什么是这个时机 |
|---|---|---|---|
| `pause` | 任何人 | **下一个步骤边界** | 工具执行到一半强插，会留下半截的 `tool.result`，审计上无法解释 |
| `resume` | 任何人 | 下一个边界（与 pause 对称） | 对称才不会有"停得下、续不上" |
| `retry` | 任何人，**必须说明改了什么** | 该步重跑时 | 改参重试会改写输入，不记清楚就没人能解释"为什么两次结果不同" |
| `takeover` | **需审批** | 人工接管该步时 | 接管是"人替代 bot 做决定"，不是"改个参数" |

"下一个步骤边界"在代码里的位置是 `Supervisor._drive()` 的循环——它每领取一步就是
一个边界（详见 §3）。

### 调用形状

```python
from fieldstation.botd import BotStore, InteractionBoard

board = InteractionBoard(BotStore("botd.sqlite3"))

board.tree(task_id)            # 一个任务的树
board.forest(limit=50)         # 首屏：所有顶层任务
board.event_stream(task_id)    # 一个任务的事件流
board.pending(task_id=None)    # 待处理干预（队列，最老的在前）

board.request("pause", task_id=task_id, prompt="先停一下")
board.request("takeover", task_id=task_id, step_id=..., approval_id="ap-...")
board.resolve(intervention_id, "已停", status="resolved")
```

`InteractionBoard.__init__` 只接 `BotStore`；传别的类型直接 `TypeError`
（这一层不猜数据库）。

---

## 2. 为什么 `pause` 不需要审批，而 `takeover` 需要

两条理由，方向相反但都成立：

**`pause` 免审批，是因为审批会把它变慢。** 出故障时要的是**立刻停**。
给"停"加一道审批门，等于要求操作者先证明自己有权停止一台正在失控的机器——
真正需要停的那一刻，没有人有余裕走流程。ADR-009 把暂停/继续写成"任何人"，
就是这个意思。

**`takeover` 要审批，是因为它换的是"谁来做决定"。** 接管之后，那一步不再由 bot
产出结论，而是由人给出；事后的台账里，"这一步"与"这个人"绑定。这与"把阈值从 5
改成 8 再跑一次"不是一个重量级——后者只是参数变更，前者是责任主体的变更。

所以代码里 `NEEDS_APPROVAL = ("takeover",)`，且这一层**不自己批准它**：
`request("takeover", ...)` 没有 `approval_id` 会直接抛 `InterventionError`，并且
**不落库**（不会留一行"待批准的空白支票"）。

> 常见错法：用一个 `needs_approval: bool` 字段同时表示"需要审批"和"已经批了"。
> 两者混在一个布尔量里，界面上就永远分不清"还没批"和"批过但被撤了"。
> 这里把"需要审批"（由 kind 推导）和"审批结论"（`approval_id`）分开存。

---

## 3. "点了暂停"不等于"已经停了"

这是这一层最容易误解的一点，值得单独说清楚。

`request("pause", ...)` 做的是**记一条待办**：

```
intervention(kind='pause', status='pending', prompt='先停一下')
```

它**不会**去改任何 `step.status`，也**不会**去改 `task.status`。真正"停下来"发生在
`Supervisor._drive()` 的循环里——那里每领取一步都是一个边界，消费方在那个边界上看到
`pause` 才停止继续领取（ADR-009 原话：「由 DBOS 在**步骤边界**消费（不在工具执行中途强插）」）。

由此有三个必然后果，界面上必须如实体现：

| 现象 | 是不是 bug |
|---|---|
| 点了暂停，当前正在跑的那一步还跑完了 | **不是**。工具中途强插会留下半截结果 |
| 点暂停后 `step.status` 一点没变 | **不是**。"要暂停"与"改状态"是两件事 |
| 任务已经 `done` 了还能点暂停 | **不是**。它只是记一条审计记录，不会把已完成的改回去 |

`test_botd_interaction_wiring.py` 里 `InterventionDoesNotRewriteState` 这一组就是钉这条：
写完 pause 之后断言每个 `step.status` 与之前**逐项相同**，`tree()["counts"]` 也不变。
这条一旦红，说明有人把"记待办"和"改状态"混成一步了。

界面文案建议：**"已申请暂停（下一个步骤边界生效）"**，而不是"已暂停"。

### 这一层怎么告诉界面"什么时候生效"

不猜，直接给：

```python
row = board.request("pause", task_id=task_id)
row["effective_at"]
# {'kind': 'pause', 'when': 'next_step_boundary',
#  'note': '正在执行的步骤会跑完，不会在工具中途强插（ADR-009）'}
```

`when` 的取值：`next_step_boundary`（pause/resume）、`step_restart`（retry）、
`step_handover`（takeover）。

---

## 4. 为什么 `step_id` / `approval_id` 拼在 `prompt` 里

`intervention` 表的 schema（`botd/store.py` 的 `_SCHEMA_V1`）只有这些列：

```sql
CREATE TABLE intervention (
    id, task_id, bot_id, kind, prompt, status, response, created_at, resolved_at
);
```

**没有 `metadata` 列**，也没有 `step_id` / `approval_id` 列。而这三样东西必须能被
人读到、能被审计：

| 字段 | 为什么要存 |
|---|---|
| `step_id` | retry / takeover 是针对**哪一步**的；不写就只能在整单任务上猜 |
| `approval_id` | 接管凭什么被批准；没有它，事后无法回溯到审批单 |
| `parametrized` | retry 走的是"改参"路径（`True` 时才省略说明文字） |

**处理方式**：拼进 `prompt`，格式固定成 `key=value ; key=value`：

```
我来接手 ; step_id=s-0d4d72a7d7db4f74a59a3a47 ; approval_id=ap-2026-11-07-01
```

`_compose_prompt()` 负责拼，`_extract()` 负责取回来（按 `;` 切块，跳过前缀不是
`key=` 的块）。`parametrized=False` 不写（只写 `True`，省掉无意义的噪声）。

**这是取舍，不是偷懒**：

- 加列要迁移（`PRAGMA user_version` 从 1 升到 2），而这条信息的使用频率是"人偶尔看一眼"，
  不是"高频查询"；
- 它只需要**可读 + 可审计**，不需要被 SQL 索引；
- 真到了需要按 `step_id` 聚合的那天，再迁移一次、把历史行回填即可——历史行里的
  `key=value` 是机器可解析的，回填脚本不需要人肉读。

**已知限制（如实写）**：`_extract()` 是按 `;` 切块、取**第一个**以 `key=` 开头的块。
所以如果操作者在备注正文里自己写了 `step_id=...`，会被误当作字段。规避办法是备注里
不要出现 `=` 形状的键值对；真要根治就得加列。

> 另一处同源的取舍：`resolve()` 只允许 `resolved` / `rejected` / `cancelled`，
> 但底层 `BotStore.resolve_intervention()` 只认 `resolved` / `rejected` / `expired`。
> 传 `cancelled` 会从 `store` 那层抛 `ValueError`（不是 `InterventionError`）。
> 见 §6 的已知缺陷。

---

## 5. 前端接什么：四个返回值的真实形状

下面的 JSON **全部是真实跑出来的**，不是手编。生成它用的脚本见 §5.5，
任何人在本仓库按那段命令重跑都能得到同样形状的输出（id 与时间戳会不同）。

任务：`kind=data_qc`、`bot_id=bot1`、一步 `memory.remember`，用
`Supervisor.run(executor=MemoryExecutor(BotMemory(store)).as_executor())` 真跑完。

### 5.1 `tree(task_id)`

`{"root": {...}, "steps": [...], "children": [...], "counts": {...}}`

- `root` / `children`：`task` 表的完整行（`payload` / `result` 已解析成对象）
- `steps[i]`：`step` 表的完整行，外加 `task` 键指到"执行这一步的子任务"（`None` 表示没关联）
- `steps` 与 `children` 都按 `idx` / 优先级排好序，前端**不要重排**（位置跳会让人点错）

```json
{
  "children": [
    {
      "attempts": 1,
      "available_at": "2026-11-07T10:51:45.159856+00:00",
      "bot_id": "bot1",
      "created_at": "2026-11-07T10:51:45.159856+00:00",
      "id": "t-c398cf6d28094871b1cccc83",
      "kind": "data_qc",
      "last_error": null,
      "lease_expires_at": null,
      "lease_owner": null,
      "max_attempts": 3,
      "parent_id": "t-cd054f1cd6694ef480608cf1",
      "payload": {
        "acceptance": "",
        "step": "归档结论",
        "task": {
          "content": "Q3 无异常"
        },
        "tools": [
          "memory.remember"
        ]
      },
      "priority": 0,
      "result": {
        "backend": "local",
        "degraded": false,
        "external_id": null,
        "id": 1,
        "memory_missing": false,
        "ok": true
      },
      "status": "done",
      "step_id": "s-0d4d72a7d7db4f74a59a3a47",
      "title": "归档结论",
      "updated_at": "2026-11-07T10:51:45.188617+00:00"
    }
  ],
  "counts": {
    "done": 1,
    "failed": 0,
    "pending": 0,
    "steps": 1
  },
  "root": {
    "attempts": 0,
    "available_at": "2026-11-07T10:51:45.146156+00:00",
    "bot_id": "bot1",
    "created_at": "2026-11-07T10:51:45.146156+00:00",
    "id": "t-cd054f1cd6694ef480608cf1",
    "kind": "data_qc",
    "last_error": null,
    "lease_expires_at": null,
    "lease_owner": null,
    "max_attempts": 3,
    "parent_id": null,
    "payload": {
      "content": "Q3 无异常"
    },
    "priority": 0,
    "result": {
      "attempts": 1,
      "counts": {
        "done": 1
      },
      "status": "done",
      "steps": [
        {
          "name": "归档结论",
          "status": "done",
          "step_id": "s-0d4d72a7d7db4f74a59a3a47",
          "task_ref": "t-c398cf6d28094871b1cccc83"
        }
      ]
    },
    "status": "done",
    "step_id": null,
    "title": "data_qc",
    "updated_at": "2026-11-07T10:51:45.206529+00:00"
  },
  "steps": [
    {
      "acceptance": "",
      "attempts": 1,
      "created_at": "2026-11-07T10:51:45.153731+00:00",
      "error": "",
      "id": "s-0d4d72a7d7db4f74a59a3a47",
      "idx": 0,
      "kind": "",
      "name": "归档结论",
      "output": {
        "backend": "local",
        "degraded": false,
        "external_id": null,
        "id": 1,
        "memory_missing": false,
        "ok": true
      },
      "status": "done",
      "task": {
        "attempts": 1,
        "available_at": "2026-11-07T10:51:45.159856+00:00",
        "bot_id": "bot1",
        "created_at": "2026-11-07T10:51:45.159856+00:00",
        "id": "t-c398cf6d28094871b1cccc83",
        "kind": "data_qc",
        "last_error": null,
        "lease_expires_at": null,
        "lease_owner": null,
        "max_attempts": 3,
        "parent_id": "t-cd054f1cd6694ef480608cf1",
        "payload": {
          "acceptance": "",
          "step": "归档结论",
          "task": {
            "content": "Q3 无异常"
          },
          "tools": [
            "memory.remember"
          ]
        },
        "priority": 0,
        "result": {
          "backend": "local",
          "degraded": false,
          "external_id": null,
          "id": 1,
          "memory_missing": false,
          "ok": true
        },
        "status": "done",
        "step_id": "s-0d4d72a7d7db4f74a59a3a47",
        "title": "归档结论",
        "updated_at": "2026-11-07T10:51:45.188617+00:00"
      },
      "task_id": "t-cd054f1cd6694ef480608cf1",
      "task_ref": "t-c398cf6d28094871b1cccc83",
      "tools": [
        "memory.remember"
      ],
      "updated_at": "2026-11-07T10:51:45.196479+00:00"
    }
  ]
}
```

**画图需要哪几个字段**（其余可按需展开）：

| 用途 | 字段 |
|---|---|
| 树的节点标题 | `steps[i].name`、`steps[i].idx`（排序） |
| 节点颜色/状态点 | `steps[i].status`（`pending` / `running` / `done` / `failed` / `skipped`） |
| 进度条 | `counts.done` / `counts.failed` / `counts.steps` |
| 点开看"是谁跑的" | `steps[i].task.id` + `steps[i].task.bot_id` |
| 点开看输入 | `steps[i].task.payload.task`（注意：**业务参数在 `task` 键下一层**） |
| 点开看工具 | `steps[i].tools`（白名单字符串数组） |
| 点开看验收 | `steps[i].acceptance` |
| 点开看证据/结果 | `steps[i].output` |
| 重试了几次 | `steps[i].attempts` |
| 耗时 | `steps[i].updated_at − steps[i].created_at` |

> `counts.pending` 是 **`pending` + `running` 的合计**，不是只有 `pending`。
> 注意 `done + failed + pending == steps` **只在没有 `skipped` 步骤时成立**：
> `skipped`（`STEP_STATUSES` 里的第五个状态）既不进 `done` 也不进 `pending`，
> 会从计数里"消失"。实测两步任务（一步 `skipped`、一步 `done`）得到
> `{"steps": 2, "done": 1, "failed": 0, "pending": 0}`。见 §6 缺陷 3。

### 5.2 `forest(limit=50)`

顶层任务（没有 `parent_id`）按 `created_at` 倒序。每项是给首屏列表用的一行摘要：

```json
[
  {
    "done": 1,
    "failed": 0,
    "open_interventions": 0,
    "step_count": 1,
    "task": {
      "attempts": 0,
      "available_at": "2026-11-07T10:51:45.146156+00:00",
      "bot_id": "bot1",
      "created_at": "2026-11-07T10:51:45.146156+00:00",
      "id": "t-cd054f1cd6694ef480608cf1",
      "kind": "data_qc",
      "last_error": null,
      "lease_expires_at": null,
      "lease_owner": null,
      "max_attempts": 3,
      "parent_id": null,
      "payload": {
        "content": "Q3 无异常"
      },
      "priority": 0,
      "result": {
        "attempts": 1,
        "counts": {
          "done": 1
        },
        "status": "done",
        "steps": [
          {
            "name": "归档结论",
            "status": "done",
            "step_id": "s-0d4d72a7d7db4f74a59a3a47",
            "task_ref": "t-c398cf6d28094871b1cccc83"
          }
        ]
      },
      "status": "done",
      "step_id": null,
      "title": "data_qc",
      "updated_at": "2026-11-07T10:51:45.206529+00:00"
    }
  }
]
```

首屏需要：`task.id` / `task.title` / `task.kind` / `task.status`、
`step_count`、`done`、`failed`、`open_interventions`（右上角"待处理 N"的每行小标）。

`open_interventions` 只数 `status='pending'` 的干预；已 `resolved` / `rejected`
的不算（`test_botd_interaction_wiring.py` 有断言钉这条）。

### 5.3 `event_stream(task_id)`

一条有顺序的流。**只从数据库现状推导**，不读 `trace.jsonl`——日志问的是"当时发生了什么"，
编队台问的是"现在卡在哪"，两者口径不同。

```json
[
  {
    "at": "2026-11-07T10:51:45.146156+00:00",
    "label": "派发：data_qc",
    "phase": "dispatched",
    "task_id": "t-cd054f1cd6694ef480608cf1"
  },
  {
    "at": "2026-11-07T10:51:45.196479+00:00",
    "attempts": 1,
    "label": "完成：归档结论",
    "phase": "completed",
    "step": "归档结论",
    "step_id": "s-0d4d72a7d7db4f74a59a3a47"
  },
  {
    "at": "2026-11-07T10:51:45.231314+00:00",
    "intervention_id": "i-50497ed958c344ab818d1e4a",
    "label": "干预 pause（pending）：先停一下",
    "phase": "intervention:pause",
    "status": "pending"
  },
  {
    "at": "2026-11-07T10:51:45.237667+00:00",
    "intervention_id": "i-cbc77808070e4bb89335ef7b",
    "label": "干预 takeover（pending）：我来接手 ; step_id=s-0d4d72a7d7db4f74a59a3a47 ; approval_id=ap-2026-11-07-01",
    "phase": "intervention:takeover",
    "status": "pending"
  }
]
```

`phase` 的全部取值：

| phase | 来自 | 附带字段 |
|---|---|---|
| `dispatched` | 任务本身 | `task_id` |
| `queued` | `step.status == pending` **或任何未知状态**（含 `skipped`） | `step_id`、`step`、`attempts` |
| `running` | `step.status == running` | 同上 |
| `completed` | `step.status == done` | 同上 |
| `failed` | `step.status == failed` | 同上（`error` 恒为空，见 §6） |
| `retried` | `attempts > 1` | 同上；是同一状态的**附加标注**，不是替代 |
| `intervention:<kind>` | `intervention` 表 | `intervention_id`、`status` |

要点：

- **`at` 可能为 `null`**（老数据没有该字段）。这时**不编时间**，让前端按顺序展示；
  排序规则是"有时间按时间升序，没时间的保持插入顺序在前"。
- 判等关系（`test_botd_interaction_wiring.py` 逐条断言）：
  `done → completed`、`failed → failed`、`pending → queued`、`running → running`。
- `retried` 事件与前一条共用 `step_id`，前端按 `step_id` 聚合时要**跳过它**，
  否则会以为一步跑了两遍。它存在的理由是：同一名字出现两次、看起来像重复行，
  不标出来会让人以为流程卡住。

### 5.4 `pending(task_id=None)`

还没结论的干预，**按 `created_at` 正序**（待办是队列，不是流水账）。
每一项 = `intervention` 行 + 两个推导字段：

```json
[
  {
    "bot_id": null,
    "created_at": "2026-11-07T10:51:45.231314+00:00",
    "effective_at": {
      "kind": "pause",
      "note": "正在执行的步骤会跑完，不会在工具中途强插（ADR-009）",
      "when": "next_step_boundary"
    },
    "id": "i-50497ed958c344ab818d1e4a",
    "kind": "pause",
    "needs_approval": false,
    "prompt": "先停一下",
    "resolved_at": null,
    "response": null,
    "status": "pending",
    "task_id": "t-cd054f1cd6694ef480608cf1"
  },
  {
    "bot_id": null,
    "created_at": "2026-11-07T10:51:45.237667+00:00",
    "effective_at": {
      "kind": "takeover",
      "note": "需审批已通过；接管后该步不再由 bot 执行",
      "step_id": "s-0d4d72a7d7db4f74a59a3a47",
      "when": "step_handover"
    },
    "id": "i-cbc77808070e4bb89335ef7b",
    "kind": "takeover",
    "needs_approval": true,
    "prompt": "我来接手 ; step_id=s-0d4d72a7d7db4f74a59a3a47 ; approval_id=ap-2026-11-07-01",
    "resolved_at": null,
    "response": null,
    "status": "pending",
    "task_id": "t-cd054f1cd6694ef480608cf1"
  }
]
```

前端要区分两种"待办"：`needs_approval` 为 `false`（pause/resume/retry，可以直接点"处理"）
与为 `true`（takeover，**必须走审批流程**）。

`summarize_kinds(rows)` 直接给出小标计数：

```python
summarize_kinds(board.pending())   # {'pause': 1, 'resume': 0, 'retry': 0, 'takeover': 1}
```

未知 kind 不计入（免得界面出现幽灵项）。

### 5.5 这段 JSON 怎么复现

```powershell
$p  = "H:\...\野外台站智能体"
$py = "$p\.deps\venv\Scripts\python.exe"
Set-Location $p
$env:PYTHONPATH = "src"
$env:PYTHONIOENCODING = "utf-8"
```

```python
import json, tempfile
from pathlib import Path
from fieldstation.botd import (BotMemory, BotStore, InteractionBoard,
                               MemoryExecutor, StepSpec, Supervisor)

class FixedPlanner:
    def __init__(self, specs): self._specs = list(specs)
    def plan(self, task): return list(self._specs)

store = BotStore(Path(tempfile.mkdtemp()) / "botd.sqlite3")
board = InteractionBoard(store)
sup = Supervisor(store, planner=FixedPlanner(
    [StepSpec(name="归档结论", tools=("memory.remember",))]))
run = sup.run({"kind": "data_qc", "bot_id": "bot1",
               "payload": {"content": "Q3 无异常"}},
              executor=MemoryExecutor(BotMemory(store)).as_executor())

step_id = board.tree(run.task_id)["steps"][0]["id"]
board.request("pause", task_id=run.task_id, prompt="先停一下")
board.request("takeover", task_id=run.task_id, prompt="我来接手",
              approval_id="ap-2026-11-07-01", step_id=step_id)

for label, value in [("tree", board.tree(run.task_id)),
                     ("forest", board.forest()),
                     ("event_stream", board.event_stream(run.task_id)),
                     ("pending", board.pending(task_id=run.task_id))]:
    print("=" * 20, label)
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))
```

---

## 6. 还没做的，以及已知缺陷

### 还没做

| 项 | 状态 | 说明 |
|---|---|---|
| **UI 本身** | ❌ **没做** | 这一层是**后端**。抽屉、树控件、流的时间轴、右上角"待处理 N"都没有实现 |
| **`Supervisor` 消费干预的循环** | ❌ **没接** | `Supervisor._drive()` 目前**不读** `intervention` 表。写进去的 pause/retry/takeover 仍然只是记录，没有消费者执行它们。按 ADR-009 这属于 DBOS 那一侧 |
| 与大 bot 的自由对话 | ❌ 没做 | ADR-009 里有这一项，本模块不含对话 |
| 干预过期（`expired`） | ⚠️ 半成品 | `_TERMINAL_STATUS` 认 `expired`，`store.resolve_intervention()` 也接受，但**没有任何地方会把过期的 pending 置为 expired** |
| 按 `step_id` 查干预 | ❌ 没做 | 因为 `step_id` 不在列上（§4），只能读出来后过滤 |

> 也就是说：**现在这一层的价值是"把状态读出来给人看"**，写进去的干预暂时不会被
> 任何执行体消费。写文档时不能把它说成"已经能远程暂停 bot"。

### 已知缺陷（已实测确认，**未修改** `interaction.py`）

1. **失败事件的 `error` 永远是空串。**
   `event_stream()` 里失败分支取的是 `step.get("last_error")`，而 `step` 表的列名是
   `error`（`last_error` 是 `task` 表的列）。实测：`step["error"]` 是
   `"阈值超限 8 > 5"`，同一条步骤产生的 `event_stream` 事件里 `"error": ""`。
   影响：前端在事件流上永远看不到失败原因，只能点进步骤看 `steps[i].error`。
   修法是一行（改读 `error`），但那是别人的成品文件，未动。

2. **`resolve(..., status="cancelled")` 会抛 `ValueError` 而不是 `InterventionError`。**
   `InteractionBoard.resolve()` 的 docstring 与入参校验都接受
   `resolved` / `rejected` / `cancelled`，但底层 `BotStore.resolve_intervention()`
   的白名单是 `resolved` / `rejected` / `expired`。实测传 `cancelled` 得到
   `ValueError: 未知介入状态：'cancelled'`。
   影响：调用方按 docstring 写 `cancelled` 会拿到一个**不是** `InterventionError`
   的异常；若只 `except InterventionError`，会漏掉并冒到上层。
   `cancelled` 也从未被写进库，而 `_TERMINAL_STATUS` 却把它当终态——三者口径不一致。

3. **`skipped` 步骤既不计入 `counts` 的任何一栏，也被事件流说成"待执行"。**
   `STEP_STATUSES` 有五个值（`pending` / `running` / `done` / `failed` / `skipped`），
   但 `tree()` 的 `counts` 只数 `done` / `failed` / `pending+running`；`event_stream()`
   的 `else` 分支把 `skipped` 归到 `queued`（"待执行"）。
   实测两步任务（一步手动置 `skipped`、一步 `done`）：
   `counts = {"steps": 2, "done": 1, "failed": 0, "pending": 0}`——
   `1 + 0 + 0 != 2`，界面上的进度条会停在 50% 而任务其实已经收尾；
   事件流则会对那一步显示"待执行：跳过的一步"，读起来像是它还在排队。
   这是 `interaction.py` 里 `test_botd_interaction.py` 未覆盖的一条路径（那份测试里
   没有 `skipped` 用例）。修法需要在 `counts` 加一栏、在事件流加一个 `skipped` phase，
   属于改行为，未动。

4. **备注正文里的 `key=...` 会被当成字段**（见 §4 的"已知限制"）。
   这是拼进 `prompt` 这个方案的固有代价，不是实现错误。

---

## 7. 跑测试

```powershell
$env:PYTHONPATH = "src"
.deps\venv\Scripts\python.exe -m unittest `
    tests.test_botd_interaction `
    tests.test_botd_interaction_wiring `
    tests.test_botd_executors `
    tests.test_botd_supervisor
```

份内合计 79 项（30 + 26 + 11 + 12），本仓库纪律：**skip 必须为 0**。
