# `run_link` 四表与唯一耦合点（E2）

- 状态：**W0 冻结**（2026-11-05）
- 适用：DBOS（执行真相）/ LangGraph（推理真相）/ Letta（记忆真相）/ 领域台账（业务真相）
- 代码锚点：`src/fieldstation/botd/store.py`（`task` / `run_link` 的 SQLite 实现）
- 关联：ADR-009 §2、`docs/spec/2026-11-04-v4-实施基线.md` §5
- 一句话：**四张表各写各的；只有 `run_link` 同时出现 `task_id` 与另一本账的实体 id。**

---

## 1. 设计规则

1. **四张表互不设外键。** `thread` 不存 `task_id`，`work_order` 不存 `task_id`，`task` 也不存 `thread_id`。
   任何"任务 ↔ 线程/agent/工单"的关系都只写在 `run_link`。
2. **每张表只有一个写者。** DBOS 写 `task` 的执行字段；LangGraph 写 `thread`；Letta 写 `agent` 的记忆命名空间；
   台账写 `work_order` 的业务字段。跨表读可以，跨表写不行。
3. **`run_link` 是追加型。** 关联建立/解除都追加一行（`status=linked/unlinked`），不物理删除。
4. **外部 id 只出现一次。** `UNIQUE(provider, external_id)` 防止同一个 LangGraph thread 被挂到两个 task。
5. **本地表是镜像，不是第二真相。** `thread`/`agent` 的权威副本在 LangGraph/Letta；本地表只存寻址与展示所需字段，
   冲突时以对应组件为准，并在 `detail` 里记 `mirror_of`。

### 1.1 基数

| 关系 | 基数 | 说明 |
|---|---|---|
| task ↔ thread | 1 : 0..1 | 聊天/管线任务一个线程；纯设备动作可以没有线程 |
| task ↔ agent | 1 : 1..N | Supervisor 一个，worker 每个 step 一个；`kind=agent` 多行 |
| task ↔ work_order | 1 : 0..N | 一次任务可建多张工单；工单也可由人手工建（无 task） |
| agent ↔ thread | N : 0..1 | 同一 agent 可服务多个 task，但同一时刻只挂一个线程 |

## 2. 四张表

### 2.1 `task`

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `task_id` | TEXT PK | 是 | 形如 `t-<24hex>`；DBOS workflow id 与它一一对应 |
| `parent_task_id` | TEXT | 否 | 父任务；Supervisor 拆出的子任务指向根 |
| `root_task_id` | TEXT | 是 | 根任务 id；根任务指向自己，便于一次拉全树 |
| `bot_id` | TEXT | 否 | 归属 bot（编队视角的"谁在跑"） |
| `step_id` | TEXT | 否 | 该任务对应的 step；同一 step 只能有一个任务（唯一索引） |
| `kind` | TEXT | 是 | `chat` / `bot` / `pipeline` / `workflow` |
| `title` | TEXT | 是 | 人可读标题；允许空串但列不为 NULL |
| `payload` | TEXT(JSON) | 是 | 输入快照（含 `seed`、参数、证据引用） |
| `status` | TEXT | 是 | `pending/running/waiting_approval/waiting_operator/done/failed/dead/cancelled` |
| `priority` | INTEGER | 是 | 越大越先；默认 0 |
| `attempts` | INTEGER | 是 | 已尝试次数；从 0 起 |
| `max_attempts` | INTEGER | 是 | 上限；默认 5 |
| `available_at` | TEXT | 是 | 最早可执行时间（UTC 定长 ISO） |
| `lease_owner` | TEXT | 否 | 当前执行者；空表示未领取 |
| `lease_expires_at` | TEXT | 否 | 租约到期；过期可被重新领取 |
| `result` | TEXT(JSON) | 否 | 终态结果摘要（不含大产物，产物给 sha256） |
| `last_error` | TEXT | 否 | 最后一次失败原因（分类 + 一句话） |
| `created_at` | TEXT | 是 | UTC 定长 ISO，可直接字符串比较 |
| `updated_at` | TEXT | 是 | 同上 |

索引：`(status, available_at, priority)` 用于取活；`(parent_task_id)` 用于拉树；`UNIQUE(step_id) WHERE step_id IS NOT NULL`。

### 2.2 `thread`

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `thread_id` | TEXT PK | 是 | LangGraph checkpointer 的 thread id，形如 `th-<24hex>` |
| `runtime` | TEXT | 是 | `opencode` / `claude`；线程属于哪个 Agent 运行时 |
| `external_thread_id` | TEXT | 是 | 运行时自己的会话 id（OpenCode session / SDK session） |
| `checkpointer_ns` | TEXT | 是 | checkpointer 命名空间；DBOS 与 LangGraph 不共用 |
| `trace_path` | TEXT | 是 | `trace.jsonl` 相对路径；回放只读它 |
| `message_count` | INTEGER | 是 | 已落盘消息数（不含 delta） |
| `last_event_seq` | INTEGER | 是 | 最后一条事件序号；续跑从这里往后接 |
| `status` | TEXT | 是 | `open` / `idle` / `closed` / `broken` |
| `created_at` | TEXT | 是 | UTC 定长 ISO |
| `closed_at` | TEXT | 否 | 关闭时间；`closed` 时必填 |

### 2.3 `agent`

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `agent_id` | TEXT PK | 是 | Letta agent id；也是特化定义的实例 id |
| `name` | TEXT | 是 | `ops` / `qc` / `fault_diagnosis` / `supervisor` / `worker-…` |
| `kind` | TEXT | 是 | `supervisor` / `worker` / `runtime` |
| `spec_path` | TEXT | 是 | `config/agents/<name>.json` 或 `agents/fsa-ops.yaml` |
| `spec_sha256` | TEXT | 是 | 特化源哈希；两份产物必须同源 |
| `runtime` | TEXT | 是 | `opencode` / `claude`；agent 跑在哪个运行时 |
| `model` | TEXT | 是 | 实际模型 id，如 `deepseek-v4.1-flash` |
| `memory_namespace` | TEXT | 是 | Letta memory block / archival 的命名空间 |
| `parent_agent_id` | TEXT | 否 | Supervisor 指向空；worker 指向父 agent |
| `allowed_tools` | TEXT(JSON) | 是 | 工具白名单快照；运行期不许扩权 |
| `status` | TEXT | 是 | `active` / `paused` / `retired` |
| `created_at` | TEXT | 是 | UTC 定长 ISO |

### 2.4 `work_order`

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `work_order_id` | TEXT PK | 是 | 形如 `wo-<24hex>`；台账主键 |
| `station_id` | TEXT | 是 | 台站 id |
| `title` | TEXT | 是 | 一句话问题 |
| `priority` | TEXT | 是 | `P0/P1/P2/P3` |
| `risk` | TEXT | 是 | `low/medium/high`；高风险动作的工单必须带审批记录 |
| `status` | TEXT | 是 | `open/acknowledged/in_progress/waiting_approval/done/cancelled/rejected` |
| `action` | TEXT | 否 | 建议动作（`restart_receiver` 等）；只做建议，不直接执行 |
| `description` | TEXT | 否 | 现象、影响、复现步骤 |
| `evidence_call_ids` | TEXT(JSON) | 是 | 证据 `call_id` 数组；必须能回放到 `tool.result.ok=true` |
| `created_by` | TEXT | 是 | `agent:<agent_id>` 或 `user:<id>` |
| `approved_by` | TEXT | 否 | 高风险动作的批准人；未批准为空 |
| `created_at` | TEXT | 是 | UTC 定长 ISO |
| `closed_at` | TEXT | 否 | 关闭时间；`done/cancelled/rejected` 时必填 |
| `artifact_sha256` | TEXT | 否 | 关联产物的哈希；多产物时在 `detail` 里列 |

状态机：`open → acknowledged → in_progress → done`；任意非终态可 `rejected`；
进入 `done` 前若 `risk=high`，必须已有 `approved_by`，否则报 `E_PRECOND`。

### 2.5 `run_link`（唯一耦合点）

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `link_id` | TEXT PK | 是 | 形如 `r-<24hex>` |
| `task_id` | TEXT | 是 | 指向 `task.task_id`；**唯一允许出现在关系表里的任务列** |
| `kind` | TEXT | 是 | `thread` / `agent` / `work_order`；决定另一头查哪张表 |
| `provider` | TEXT | 是 | `dbos` / `langgraph` / `letta` / `ledger` / `runtime` |
| `external_id` | TEXT | 是 | 另一本账的实体 id（thread_id / agent_id / work_order_id） |
| `status` | TEXT | 是 | `linked` / `unlinked` / `stale` |
| `detail` | TEXT(JSON) | 是 | `{mirror_of, step_id, role, note}` 等补充；默认 `{}` |
| `created_at` | TEXT | 是 | UTC 定长 ISO |
| `updated_at` | TEXT | 是 | UTC 定长 ISO |

约束：

```sql
CREATE TABLE run_link (
  link_id     TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('thread','agent','work_order')),
  provider    TEXT NOT NULL,
  external_id TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'linked'
              CHECK (status IN ('linked','unlinked','stale')),
  detail      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_run_link_external ON run_link(provider, external_id);
CREATE INDEX ix_run_link_task ON run_link(task_id, kind, status);
```

**为什么不是四列宽表。** 四列宽表（`task_id, thread_id, agent_id, work_order_id`）在"一个 task 多个 worker"
时要么重复 task 行、要么把多个 agent 塞进一个字段。当前形状与 `botd/store.py` 的实现一致：
一行一个 `provider + external_id`，`kind` 决定去哪张表取详情。

## 3. 查询示例（SQLite）

### 3.1 一条 task 拉全四本账

```sql
SELECT t.task_id, t.title, t.status,
       th.thread_id, th.runtime, th.trace_path,
       ag.agent_id, ag.name AS agent_name, ag.model,
       wo.work_order_id, wo.status AS wo_status, wo.priority
FROM task t
LEFT JOIN run_link lt ON lt.task_id = t.task_id AND lt.kind = 'thread'    AND lt.status = 'linked'
LEFT JOIN thread   th ON th.thread_id = lt.external_id
LEFT JOIN run_link la ON la.task_id = t.task_id AND la.kind = 'agent'     AND la.status = 'linked'
LEFT JOIN agent    ag ON ag.agent_id = la.external_id
LEFT JOIN run_link lw ON lw.task_id = t.task_id AND lw.kind = 'work_order' AND lw.status = 'linked'
LEFT JOIN work_order wo ON wo.work_order_id = lw.external_id
WHERE t.task_id = 't-3f9c2a7d1b8e4c6f0a2d5e7b';
```

预期：1 行 × 12 列；没有的关联列为 `NULL`，不伪造空串。

### 3.2 从工单反查"为什么跑 / 怎么想的 / 记得什么"

```sql
SELECT wo.work_order_id, wo.station_id, t.task_id, t.kind, t.status,
       th.thread_id, th.trace_path,
       ag.agent_id, ag.name, ag.memory_namespace
FROM work_order wo
JOIN run_link lw ON lw.external_id = wo.work_order_id AND lw.kind = 'work_order'
JOIN task t       ON t.task_id = lw.task_id
LEFT JOIN run_link lt ON lt.task_id = t.task_id AND lt.kind = 'thread'
LEFT JOIN thread th   ON th.thread_id = lt.external_id
LEFT JOIN run_link la ON la.task_id = t.task_id AND la.kind = 'agent'
LEFT JOIN agent ag    ON ag.agent_id = la.external_id
WHERE wo.work_order_id = 'wo-7f3a91c4d2e6480b9a1c3e5f';
```

### 3.3 某台站未结工单 + 责任 bot

```sql
SELECT wo.work_order_id, wo.priority, wo.status, wo.created_at,
       t.task_id, t.bot_id, ag.name AS owner_agent
FROM work_order wo
JOIN run_link lw ON lw.external_id = wo.work_order_id AND lw.kind = 'work_order'
JOIN task t       ON t.task_id = lw.task_id
LEFT JOIN run_link la ON la.task_id = t.task_id AND la.kind = 'agent'
LEFT JOIN agent ag    ON ag.agent_id = la.external_id
WHERE wo.station_id = 'WUHN'
  AND wo.status NOT IN ('done','cancelled','rejected')
ORDER BY wo.priority, wo.created_at;
```

### 3.4 崩溃后续跑：找可恢复的 task 与线程

```sql
SELECT t.task_id, t.status, t.attempts, t.lease_expires_at,
       th.thread_id, th.last_event_seq, th.trace_path
FROM task t
JOIN run_link lt ON lt.task_id = t.task_id AND lt.kind = 'thread' AND lt.status = 'linked'
JOIN thread th   ON th.thread_id = lt.external_id
WHERE t.status IN ('running','waiting_approval','waiting_operator')
  AND (t.lease_expires_at IS NULL OR t.lease_expires_at < strftime('%Y-%m-%dT%H:%M:%f+00:00','now'))
ORDER BY t.priority DESC, t.updated_at;
```

续跑规则：从 `last_event_seq + 1` 继续；已成功 step 不重跑；工具调用按 `idempotency_key` 去重。

### 3.5 孤儿与断链体检

```sql
-- run_link 指向了不存在的 thread
SELECT l.link_id, l.task_id, l.external_id
FROM run_link l
LEFT JOIN thread th ON l.kind = 'thread' AND th.thread_id = l.external_id
WHERE l.kind = 'thread' AND l.status = 'linked' AND th.thread_id IS NULL;

-- 有 task 却没有任何 run_link（DBOS 跑了，但 LangGraph/Letta 没接上）
SELECT t.task_id, t.kind, t.status
FROM task t
LEFT JOIN run_link l ON l.task_id = t.task_id AND l.status = 'linked'
WHERE l.link_id IS NULL AND t.status IN ('running','waiting_approval');
```

预期：两条查询都返回 0 行；非 0 行按 `stale` 标记，不自动删。

## 4. 写入时序

```
1  DBOS 建 task（pending）
2  DBOS 领取 task（running，写 lease）
3  运行时建会话 → LangGraph thread → run_link(kind=thread, provider=langgraph)
4  Letta recall → run_link(kind=agent, provider=letta, external_id=agent_id)
5  step 需要工单 → 台账建 work_order → run_link(kind=work_order, provider=ledger)
6  每步结束更新 task.status / step；不改 thread 的业务字段
7  终态：task.done；thread.idle；run_link 仍保留（不 unlink）
```

任一步失败：只回滚本表事务；`run_link` 保留已建立的行并标 `stale`，下次启动由 §3.5 的体检修复。

## 5. 迁移说明（与现有 `botd/store.py`）

现有 `run_link` 只有 `(task_id, bot_id, provider, external_id, status, detail)`。迁移到本契约：

| 现有列 | 本契约 | 处理 |
|---|---|---|
| `task_id` | `task_id` | 直接保留 |
| `bot_id` | `detail.bot_id` | 移到 `detail`；需要索引时另建生成列 |
| `provider` | `provider` | 保留；`dbos/langgraph/letta/ledger` 四值 |
| `external_id` | `external_id` | 保留 |
| 无 | `kind` | 由 `provider` 推导：`langgraph→thread`、`letta→agent`、`ledger→work_order`、`dbos→thread` |
| `id` | `link_id` | 改列名，值不变 |
| `detail` / `status` / 时间列 | 同名 | 保留 |

迁移只加列、不改历史行；`kind` 用 `UPDATE` 回填一次，之后由写入方显式给。
