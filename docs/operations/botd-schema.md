# botd schema 迁移（v1 → v3）

- 日期：2026-11-08
- 对应：v5 计划 Bot-6（`run_link` 三表 + `kind`）+ Bot-7（`task.id` → `task_id`）
- 代码锚点：`src/fieldstation/botd/store.py`
- 契约：`docs/contracts/run-link.md` §2 / §3 / §5
- 回归：`tests/test_run_link_contract.py`（40 项）

---

## 1. 三个版本各做了什么

| 版本 | 内容 | 依据 |
|---|---|---|
| v1 | 六张表：`bot` / `task` / `step` / `memory` / `intervention` / `run_link`；`task.id` 是主键 | v4 基线 |
| v2 | 建 `thread` / `agent` / `work_order`；`run_link` 加 `kind` 并回填；`run_link.id` → `link_id` | 契约 §2.2–2.5 |
| v3 | `task.id` → `task_id`、`task.parent_id` → `parent_task_id`、补 `root_task_id` | 契约 §2.1 |

`SCHEMA_VERSION` 现在是 **3**。

### 1.1 v2 与 v3 是一个整体，不是两个可停留的台阶

计划书把 Bot-6 与 Bot-7 列为两条，但**在数据库里它们不能分两次上线**：
契约 §3 的五条查询写的是 `t.task_id`，v2 自己跑不出任何一条 —— 那会留下一个
「表建好了、契约查不了」的中间态，而验收判据恰恰是那五条查询。

所以 `migrate()` 的行为是：新库从 v1 建完一路迁到 `SCHEMA_VERSION`；老库按
`PRAGMA user_version` 补跑缺的台阶。测试里同时覆盖了「从空库建到 v3」和
「从 v1 老库升到 v3」两条路径（`TestMigrationFromV1`）。

---

## 2. `run_link.kind` 怎么回填

契约 §5 给的映射，实现在 `PROVIDER_TO_KIND`：

| provider | kind |
|---|---|
| `langgraph` | `thread` |
| `dbos` | `thread` |
| `runtime` | `thread` |
| `letta` | `agent` |
| `ledger` | `work_order` |

`runtime` 不与 `langgraph` 共用一档是因为契约 §2.5 的 `provider` 枚举里有它
（A/B 两侧运行时的会话 id，形状上是线程）。它归 `thread` 也是契约
`run-link.schema.json` 的 `allOf` 分支所要求的。

**`bot_id` 的处理**：契约要求移到 `detail.bot_id`。列**保留**（删列会破坏旧数据），
但 `link()` 写入时统一放进 `detail.bot_id`，文档层面视该列为 deprecated。

### 2.1 `kind` 与 `provider` 必须自洽

`link()` 里做了一次显式校验：`langgraph/dbos/runtime` 只能配 `thread`，
`letta` 只能配 `agent`，`ledger` 只能配 `work_order`。不自洽直接 `ValueError`。

理由：kind 决定另一头**查哪张表**。写错的话，症状不是报错而是**查询返回 NULL** ——
`§3.1` 那 12 列里某几列永远空着，看上去像"这条任务还没接上"，实际是数据本身
指错了表。这种错最难查，所以在写入侧就挡掉。

---

## 3. 迁移是原子的（实测）

计划书原文要求「`ALTER TABLE ADD COLUMN` 要包列存在判断，因为重复执行会抛
`duplicate column name`」。这条**在本机不成立**，而且照它写反而慢：

- `PRAGMA user_version` 的写入与 DDL 在 **同一个事务**里，中途崩溃两者一起回滚。
- 所以只要每个台阶写成「`BEGIN IMMEDIATE` → DDL → `PRAGMA user_version = n` → `COMMIT`」，
  就不会出现「表建了但版本没写」的状态，也就不需要在 DDL 里再套 `if column exists`。

探针（`sqlite3 3.53.1`）：

```
== B: is PRAGMA user_version transactional?
  inside txn: user_version=2, cols=['a', 'b']
  after ROLLBACK: user_version=1, cols=['a']
  => atomic (both reverted): True
  after COMMIT: user_version=2, cols=['a', 'b']
```

### 3.1 但 `executescript()` 会拆掉这个事务

第一次实现用的是 `conn.executescript(_SCHEMA_V1)`，结果整套 botd 测试全红：

```
sqlite3.OperationalError: cannot commit - no transaction is active
```

原因是 `executescript()` **在执行前隐式提交**当前事务。外面包的 `BEGIN IMMEDIATE`
因此失效，随后的 `COMMIT` 找不到事务。

修法是 `store.execute_script(conn, text)`：按 `sqlite3.complete_statement()` 判断的
完整语句边界逐条 `conn.execute()`，不碰事务。这也顺带说明为什么不能拿
`script.split(";")` 糊弄 —— 字符串常量里的分号会被误切。

---

## 4. `RENAME COLUMN` 会自动改索引和外键（实测，与旧计划相反）

旧计划（AI 理解版 §「第 1 处」）说：「改名后原索引失效，必须 `DROP INDEX` + 重建，
漏了不报错、只会让按父任务查子任务悄悄变慢」。实测在 `sqlite3 3.53.1` 上：

```
--- after rename
  idx_task_parent: CREATE INDEX idx_task_parent ON task(parent_task_id)
  foreign_key_list: [('task', 'parent_task_id', 'task_id')]
  query plan: SEARCH task USING INDEX idx_task_parent (parent_task_id=?)
  FK still enforced: FOREIGN KEY constraint failed
  after DELETE parent, remaining rows: []  (级联删除仍生效)
```

跨表外键也一样（`step.task_id → task(id)` 在改名后被重写成
`REFERENCES task(task_id)`，插入与级联都正常）。

**结论**：本机不需要手工重建索引/外键。`_MIGRATE_V3` 仍然显式重建 `idx_task_parent`，
但那只是为了让 DDL 读起来完整、不去依赖某个具体 SQLite 版本的行为差异，
不是修复一个真实缺陷。

---

## 5. `root_task_id` 的加列方式

契约 §2.1 要求 `root_task_id NOT NULL`。SQLite 的 `ADD COLUMN` 给非空表加
`NOT NULL` 列**必须带默认值**，所以分两步：

1. `ALTER TABLE task ADD COLUMN root_task_id TEXT NOT NULL DEFAULT ''`
2. 递归 CTE 把真值回填进去（根任务指向自己，子任务继承父的根）

回填完库里没有空串。之后的新行由 `create_task()` 显式给值：缺省时**从父任务反查**，
根任务指向自己。这一点刻意不做成"调用方记得填"——漏填会让 `tree()` 少一截而不报错。

---

## 6. `work_order` 的高风险闸门

契约 §2.4：`risk=high` 的工单进 `done` 前必须已有 `approved_by`，否则 `E_PRECOND`。

实现为 `store.PreconditionError`（`code = "E_PRECOND"`，与
`docs/contracts/mcp-tools.md` 的 T12 `update_work_order` 对齐）。检查读的是
「本行现有的 `approved_by`」加上「本次一并传进来的 `approved_by`」——
允许"审批与结单一起来"，但不放过没批就结单。

---

## 7. 怎么自查

```powershell
# 版本号
python -c "import sqlite3; c=sqlite3.connect('botd.sqlite3'); print(c.execute('PRAGMA user_version').fetchone()[0])"

# 九张表
python -c "import sqlite3; c=sqlite3.connect('botd.sqlite3'); print(sorted(r[0] for r in c.execute(\"select name from sqlite_master where type='table'\")))"

# 契约五条查询 + 迁移语义
python -m unittest tests.test_run_link_contract
```

第 5 条「孤儿体检」的两条查询在**关联齐全**的库上都必须返回 0 行
（`test_q35_orphan_checks_both_return_zero`）。非 0 行按契约 §3.5 标 `stale`，
不自动删。
