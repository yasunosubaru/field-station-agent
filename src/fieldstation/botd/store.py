"""E2 botd 持久层：SQLite schema v3 与迁移。

为什么先落到 SQLite 而不是直接依赖 DBOS / Letta：

* 桌面版必须能在没有网络、没有外部服务、甚至没装那些包的机器上起来；
  队列、记忆、人工介入这些**状态**一旦只能存在外部服务里，离线就什么都跑不了。
* 九张表是编队的最小状态面：``bot`` / ``task`` / ``step`` / ``memory`` /
  ``intervention`` / ``run_link`` / ``thread`` / ``agent`` / ``work_order``。
  DBOS 的 run id、Letta 的 agent id 只作为 ``run_link`` 里的外部引用，换实现时
  不动本地表。
* 所有时间字段是 UTC ISO8601 **定长**字符串（``...+00:00``，微秒 6 位），
  因此可以直接按字符串比较先后；这也让"注入时钟"的测试不用等真实时间。

并发约定：一个 :class:`BotStore` 可以被多个线程共用，但**每个操作各自开连接**
（SQLite 连接不是线程安全的）。写操作走 ``BEGIN IMMEDIATE``，用
``busy_timeout`` 排队，而不是在 Python 层加锁 —— 锁在进程内，挡不住第二个进程。

## schema 版本

=================  ==========================================================
v1                 六张表（``bot`` / ``task`` / ``step`` / ``memory`` /
                   ``intervention`` / ``run_link``），``task.id`` 是主键
v2                 ``docs/contracts/run-link.md`` §2.2–2.5：建
                   ``thread`` / ``agent`` / ``work_order``；``run_link`` 加
                   ``kind`` 并回填；``run_link.id`` 改名 ``link_id``
v3                 契约 §2.1：``task.id`` → ``task_id``、
                   ``task.parent_id`` → ``parent_task_id``，并补 ``root_task_id``
=================  ==========================================================

v2 与 v3 **总是连续执行**。契约 §3 的五条查询写的是 ``t.task_id``，v2 自己
跑不出任何一条；把两者拆成两个可独立停留的版本只会制造一个"能建表但查不了"
的中间态。所以 :meth:`BotStore.migrate` 把 v2 之后的台阶视为一个整体：新库
在 v1 建完之后一路迁到 ``SCHEMA_VERSION``，中途失败整段回滚（DDL 与
``PRAGMA user_version`` 在 SQLite 里是同一个事务，实测见
``docs/operations/botd-schema.md`` §3）。
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Mapping, Optional

SCHEMA_VERSION = 3

#: 定长便于字符串比较；不用 ``isoformat()`` 是因为 3.9 的 fromisoformat 不认 Z。
ISO_FORMAT = "%Y-%m-%dT%H:%M:%S.%f+00:00"

#: ``task.status``。``waiting_approval`` / ``waiting_operator`` 是契约 §2.1 的
#: 值，也是「闸门挂起」在队列层唯一的表达方式 —— 这两种状态下任务仍然占着
#: 一行、但**不该被 ``lease`` 领走**（见 ``queue.lease`` 的 ``status='pending'``）。
TASK_STATUSES = (
    "pending", "running", "waiting_approval", "waiting_operator",
    "done", "failed", "dead", "cancelled",
)
STEP_STATUSES = ("pending", "running", "done", "failed", "skipped")

# ---- 契约 §2.2–2.5 的枚举，与 DDL 里的 CHECK 逐字一致 ----------------------
#: ``thread.status``；续跑逻辑靠这四个状态判断"这条线程还能不能接"。
THREAD_STATUSES = ("open", "idle", "closed", "broken")
#: ``thread.runtime`` / ``agent.runtime`` —— 两条 Agent 链路。
RUNTIMES = ("opencode", "claude")
AGENT_KINDS = ("supervisor", "worker", "runtime")
AGENT_STATUSES = ("active", "paused", "retired")
WO_PRIORITIES = ("P0", "P1", "P2", "P3")
WO_RISKS = ("low", "medium", "high")
WO_STATUSES = (
    "open", "acknowledged", "in_progress", "waiting_approval",
    "done", "cancelled", "rejected",
)
#: 终态：进这些状态时 ``closed_at`` 必填。
WO_CLOSED_STATUSES = ("done", "cancelled", "rejected")
#: ``run_link.kind`` —— 决定另一头查哪张表。
LINK_KINDS = ("thread", "agent", "work_order")
#: ``run_link.provider`` —— 契约 §2.5 五值。
LINK_PROVIDERS = ("dbos", "langgraph", "letta", "ledger", "runtime")
#: ``run_link.status``；解除关联是 ``unlinked``，从不物理删。
LINK_STATUSES = ("linked", "unlinked", "stale")
#: provider → kind 的回填映射（契约 §5）。``runtime`` 指 A/B 两侧运行时的
#: 会话 id，形状上是线程，归 ``thread``。
PROVIDER_TO_KIND = {
    "langgraph": "thread",
    "dbos": "thread",
    "runtime": "thread",
    "letta": "agent",
    "ledger": "work_order",
}


class PreconditionError(ValueError):
    """前置条件不满足。``code`` 与 ``docs/contracts/mcp-tools.md`` 的 ``E_PRECOND`` 对齐。

    典型场景：``risk=high`` 的工单没有 ``approved_by`` 就想进 ``done``。
    这是**业务拒绝**，不是程序 bug，所以带 ``code`` 供上层原样透传给模型/前端。
    """

    code = "E_PRECOND"


def utcnow() -> datetime:
    """当前 UTC 时间；测试通过显式传 ``now`` 覆盖，不 monkeypatch 本函数。"""
    return datetime.now(timezone.utc)


def to_iso(moment: Optional[datetime] = None) -> str:
    """把时间点格式化成数据库里的 ISO8601 字符串（始终 UTC）。"""
    value = moment if moment is not None else utcnow()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime(ISO_FORMAT)


def from_iso(text: str) -> datetime:
    """解析 :func:`to_iso` 写出的字符串，也接受尾缀 ``Z``。"""
    if not isinstance(text, str) or not text.strip():
        raise ValueError("时间字段必须是非空 ISO8601 字符串")
    raw = text.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"不是合法的 ISO8601 时间：{text!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def add_seconds(moment: datetime, seconds: float) -> datetime:
    return moment + timedelta(seconds=float(seconds))


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:24]}"


def dumps(value: Any) -> str:
    """稳定 JSON：键排序，中文不转义，便于人工查库与对拍。"""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def loads(text: Optional[str], default: Any = None) -> Any:
    if text is None or text == "":
        return default
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        # 库里被人手改坏时不炸整个进程：原样留在字段里，由上层决定怎么报。
        return default


def execute_script(conn: sqlite3.Connection, script: str) -> None:
    """在**当前事务里**逐句执行一段 DDL/DML。

    不用 ``executescript()``：它会在执行前**隐式提交**当前事务，导致外面包的
    ``BEGIN IMMEDIATE`` 失效，随后 ``COMMIT`` 报 ``no transaction is active``。
    迁移要的是「整段 DDL + 版本号」原子生效，所以按完整语句边界切开逐条执行
    （``sqlite3.complete_statement`` 负责判断语句是否已经结束，不会在字符串
    常量里的分号处误切）。
    """
    buffer = ""
    for line in script.splitlines(keepends=True):
        buffer += line
        if sqlite3.complete_statement(buffer):
            statement = buffer.strip()
            if statement:
                conn.execute(statement)
            buffer = ""
    tail = buffer.strip()
    if tail:
        conn.execute(tail)


_SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS bot (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'active',
    meta        TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
    id               TEXT PRIMARY KEY,
    bot_id           TEXT,
    parent_id        TEXT,
    step_id          TEXT,
    kind             TEXT NOT NULL,
    title            TEXT NOT NULL DEFAULT '',
    payload          TEXT NOT NULL DEFAULT '{}',
    status           TEXT NOT NULL DEFAULT 'pending',
    priority         INTEGER NOT NULL DEFAULT 0,
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 5,
    available_at     TEXT NOT NULL,
    lease_owner      TEXT,
    lease_expires_at TEXT,
    result           TEXT,
    last_error       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    FOREIGN KEY (parent_id) REFERENCES task(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_task_ready
    ON task(status, available_at, priority);
CREATE INDEX IF NOT EXISTS idx_task_parent ON task(parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_step
    ON task(step_id) WHERE step_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS step (
    id          TEXT PRIMARY KEY,
    task_id     TEXT NOT NULL,
    idx         INTEGER NOT NULL,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL DEFAULT '',
    tools       TEXT NOT NULL DEFAULT '[]',
    acceptance  TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    task_ref    TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    output      TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES task(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_step_task ON step(task_id, idx);

CREATE TABLE IF NOT EXISTS memory (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id      TEXT NOT NULL,
    key         TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    source      TEXT NOT NULL DEFAULT 'manual',
    backend     TEXT NOT NULL DEFAULT 'local',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_bot ON memory(bot_id, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_key
    ON memory(bot_id, key) WHERE key <> '';

CREATE TABLE IF NOT EXISTS intervention (
    id          TEXT PRIMARY KEY,
    task_id     TEXT,
    bot_id      TEXT,
    kind        TEXT NOT NULL,
    prompt      TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'pending',
    response    TEXT,
    created_at  TEXT NOT NULL,
    resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_intervention_task ON intervention(task_id, status);

CREATE TABLE IF NOT EXISTS run_link (
    id          TEXT PRIMARY KEY,
    task_id     TEXT,
    bot_id      TEXT,
    provider    TEXT NOT NULL,
    external_id TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'linked',
    detail      TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_link_external
    ON run_link(provider, external_id);
CREATE INDEX IF NOT EXISTS idx_run_link_task ON run_link(task_id);
"""

#: v2 新建的三张表（契约 §2.2–2.4 逐列）。``CREATE TABLE IF NOT EXISTS`` 幂等。
_MIGRATE_V2_TABLES = """
CREATE TABLE IF NOT EXISTS thread (
    thread_id          TEXT PRIMARY KEY,
    runtime            TEXT NOT NULL CHECK (runtime IN ('opencode', 'claude')),
    external_thread_id TEXT NOT NULL,
    checkpointer_ns    TEXT NOT NULL,
    trace_path         TEXT NOT NULL,
    message_count      INTEGER NOT NULL DEFAULT 0,
    last_event_seq     INTEGER NOT NULL DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'idle', 'closed', 'broken')),
    created_at         TEXT NOT NULL,
    closed_at          TEXT
);

CREATE INDEX IF NOT EXISTS ix_thread_status ON thread(status, created_at);

CREATE TABLE IF NOT EXISTS agent (
    agent_id         TEXT PRIMARY KEY,
    name             TEXT NOT NULL,
    kind             TEXT NOT NULL
                     CHECK (kind IN ('supervisor', 'worker', 'runtime')),
    spec_path        TEXT NOT NULL,
    spec_sha256      TEXT NOT NULL,
    runtime          TEXT NOT NULL CHECK (runtime IN ('opencode', 'claude')),
    model            TEXT NOT NULL,
    memory_namespace TEXT NOT NULL,
    parent_agent_id  TEXT,
    allowed_tools    TEXT NOT NULL DEFAULT '[]',
    status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'paused', 'retired')),
    created_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_agent_name ON agent(name, status);

CREATE TABLE IF NOT EXISTS work_order (
    work_order_id    TEXT PRIMARY KEY,
    station_id       TEXT NOT NULL,
    title            TEXT NOT NULL,
    priority         TEXT NOT NULL CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
    risk             TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
    status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open', 'acknowledged', 'in_progress',
                                       'waiting_approval', 'done', 'cancelled',
                                       'rejected')),
    action           TEXT,
    description      TEXT,
    evidence_call_ids TEXT NOT NULL DEFAULT '[]',
    created_by       TEXT NOT NULL,
    approved_by      TEXT,
    created_at       TEXT NOT NULL,
    closed_at        TEXT,
    artifact_sha256  TEXT
);

CREATE INDEX IF NOT EXISTS ix_work_order_station
    ON work_order(station_id, status, priority);
CREATE INDEX IF NOT EXISTS ix_work_order_status ON work_order(status, created_at);
"""

#: v2 的 `run_link` 改造。``id`` → ``link_id`` 是**改列名**（契约 §5「值不变」），
#: 不是新列；SQLite 3.25+ 的 ``RENAME COLUMN`` 只改名字，不动值、不动索引。
_MIGRATE_V2_LINK = """
ALTER TABLE run_link RENAME COLUMN id TO link_id;
ALTER TABLE run_link ADD COLUMN kind TEXT NOT NULL DEFAULT 'thread'
    CHECK (kind IN ('thread', 'agent', 'work_order'));
UPDATE run_link SET kind = 'thread'     WHERE provider IN ('langgraph', 'dbos', 'runtime');
UPDATE run_link SET kind = 'agent'      WHERE provider = 'letta';
UPDATE run_link SET kind = 'work_order' WHERE provider = 'ledger';
CREATE UNIQUE INDEX IF NOT EXISTS ux_run_link_external
    ON run_link(provider, external_id);
CREATE INDEX IF NOT EXISTS ix_run_link_task ON run_link(task_id, kind, status);
DROP INDEX IF EXISTS idx_run_link_external;
DROP INDEX IF EXISTS idx_run_link_task;
"""

#: v3：契约 §2.1 的列名对齐。
#:
#: **索引与跨表外键不用手工重建** —— 实测 SQLite 3.53 在 ``RENAME COLUMN`` 时会
#: 一起改写 ``idx_task_parent`` 的定义、``task`` 自引用外键、以及 ``step.task_id``
#: 指向 ``task(id)`` 的那条外键（见 ``docs/operations/botd-schema.md`` §4 的探针
#: 输出）。旧计划说"不重建索引会悄悄变慢"在本机不成立；这里仍显式重建一次，
#: 是为了让 DDL 本身读起来完整，并且不依赖某个具体 SQLite 版本的行为。
_MIGRATE_V3 = """
ALTER TABLE task RENAME COLUMN id TO task_id;
ALTER TABLE task RENAME COLUMN parent_id TO parent_task_id;
DROP INDEX IF EXISTS idx_task_parent;
CREATE INDEX IF NOT EXISTS idx_task_parent ON task(parent_task_id);
"""

#: v3 第二段：契约 §2.1 的 ``root_task_id``。
#:
#: 契约要求它 ``NOT NULL``，但 SQLite 的 ``ADD COLUMN`` 给非空表加 ``NOT NULL``
#: 列**必须带默认值**，而 ``ADD COLUMN`` 又改不了既有行的约束写法。所以走
#: 「``NOT NULL DEFAULT ''`` 建列 → 递归 CTE 回填真值」两步：建完列立刻回填，
#: 库里不会留下空串；之后新行由 :meth:`BotStore.create_task` 显式给值。
_MIGRATE_V3_ROOT = """
ALTER TABLE task ADD COLUMN root_task_id TEXT NOT NULL DEFAULT '';
WITH RECURSIVE root_of(task_id, root_task_id) AS (
    SELECT task_id, task_id FROM task WHERE parent_task_id IS NULL
    UNION ALL
    SELECT child.task_id, parent.root_task_id
    FROM task child JOIN root_of parent ON child.parent_task_id = parent.task_id
)
UPDATE task SET root_task_id = COALESCE(
    (SELECT root_task_id FROM root_of WHERE root_of.task_id = task.task_id), '');
CREATE INDEX IF NOT EXISTS ix_task_root ON task(root_task_id, status);
"""


class BotStore:
    """SQLite 连接工厂 + 六张表的读写原语。

    连接**不缓存**：每次操作新开一个，``check_same_thread`` 因此永远为真，
    多线程测试不需要在线程间传连接。
    """

    def __init__(
        self,
        path: str | Path,
        *,
        timeout: float = 30.0,
        migrate: bool = True,
    ) -> None:
        self.path = Path(path)
        if str(self.path) == ":memory:":
            raise ValueError(
                "BotStore 不支持 :memory:：每个操作各自开连接，内存库会在连接之间丢失"
                "schema；请传入文件路径"
            )
        if str(self.path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.timeout = float(timeout)
        if migrate:
            self.migrate()

    # ---------------------------------------------------------------- 连接 --
    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            str(self.path), timeout=self.timeout, isolation_level=None
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout = %d" % int(self.timeout * 1000))
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = self._connect()
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """``BEGIN IMMEDIATE`` 事务；并发领取串行化的唯一入口。"""
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")
        finally:
            conn.close()

    # ---------------------------------------------------------------- 迁移 --
    def migrate(self) -> int:
        """迁移到 ``SCHEMA_VERSION``，返回迁移后的版本号；可重复调用。

        每一级台阶在**一个事务**里完成「DDL + ``PRAGMA user_version``」，中途崩溃
        两者一起回滚，不会留下"表建了但版本没写"的状态 —— 那会让下次启动重跑一段
        非幂等的 ``ALTER``。实测结论见 ``docs/operations/botd-schema.md`` §3。

        v2 与 v3 连续执行，理由见模块 docstring：契约 §3 的查询要 ``t.task_id``，
        停在任何一档之间都查不了。
        """
        with self.connect() as conn:
            if str(self.path) != ":memory:":
                conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
            version = int(conn.execute("PRAGMA user_version").fetchone()[0])
            if version > SCHEMA_VERSION:
                raise RuntimeError(
                    f"数据库 schema v{version} 比本程序支持的 v{SCHEMA_VERSION} 新，"
                    "拒绝降级写入"
                )
            # 连接是 isolation_level=None（自动提交），所以台阶要自己开事务。
            # 用 execute_script 而不是 executescript：后者会隐式提交，把 BEGIN 拆掉。
            if version < 1:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    execute_script(conn, _SCHEMA_V1)
                    conn.execute("PRAGMA user_version = 1")
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
                version = 1
            if version < 2:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    execute_script(conn, _MIGRATE_V2_TABLES)
                    execute_script(conn, _MIGRATE_V2_LINK)
                    conn.execute("PRAGMA user_version = 2")
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
                version = 2
            if version < 3:
                conn.execute("BEGIN IMMEDIATE")
                try:
                    execute_script(conn, _MIGRATE_V3)
                    execute_script(conn, _MIGRATE_V3_ROOT)
                    conn.execute("PRAGMA user_version = 3")
                    conn.execute("COMMIT")
                except BaseException:
                    conn.execute("ROLLBACK")
                    raise
                version = 3
        return version

    def schema_version(self) -> int:
        with self.connect() as conn:
            return int(conn.execute("PRAGMA user_version").fetchone()[0])

    # ------------------------------------------------------------ task 写入 --
    def create_task(
        self,
        *,
        kind: str,
        bot_id: Optional[str] = None,
        parent_task_id: Optional[str] = None,
        step_id: Optional[str] = None,
        title: str = "",
        payload: Optional[Mapping[str, Any]] = None,
        status: str = "pending",
        priority: int = 0,
        max_attempts: int = 5,
        available_at: Optional[datetime] = None,
        now: Optional[datetime] = None,
        task_id: Optional[str] = None,
        root_task_id: Optional[str] = None,
    ) -> dict:
        """建一条任务。

        ``root_task_id`` 缺省时**从父任务反查**：根任务指向自己，子任务继承父的根。
        契约 §2.1 的用途是「一次拉全树」，所以这个值不能靠调用方记得填 —— 漏填
        会让 ``tree()`` 少一截而**不报错**，是最难发现的那种坏法。
        """
        if not isinstance(kind, str) or not kind.strip():
            raise ValueError("task.kind 必须是非空字符串")
        if status not in TASK_STATUSES:
            raise ValueError(f"未知 task 状态：{status!r}")
        if int(max_attempts) < 1:
            raise ValueError("max_attempts 至少为 1")
        moment = now or utcnow()
        stamp = to_iso(moment)
        task_id = task_id or new_id("t")
        if root_task_id is None:
            root_task_id = task_id
            if parent_task_id:
                with self.connect() as conn:
                    row = conn.execute(
                        "SELECT root_task_id FROM task WHERE task_id = ?",
                        (parent_task_id,),
                    ).fetchone()
                # 父任务不存在时不让 root 指向一个非法 id：交给 task 表的外键去报错。
                if row is not None and row["root_task_id"]:
                    root_task_id = row["root_task_id"]
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO task (
                    task_id, bot_id, parent_task_id, root_task_id, step_id, kind,
                    title, payload, status, priority, attempts, max_attempts,
                    available_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
                """,
                (
                    task_id,
                    bot_id,
                    parent_task_id,
                    root_task_id,
                    step_id,
                    kind.strip(),
                    title or "",
                    dumps(dict(payload or {})),
                    status,
                    int(priority),
                    int(max_attempts),
                    to_iso(available_at or moment),
                    stamp,
                    stamp,
                ),
            )
        return self.get_task(task_id)

    def get_task(self, task_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM task WHERE task_id = ?", (task_id,)
            ).fetchone()
        if row is None:
            raise KeyError(f"任务不存在：{task_id!r}")
        return _task_dict(row)

    def task_exists(self, task_id: str) -> bool:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM task WHERE task_id = ?", (task_id,)
            ).fetchone()
        return row is not None

    def list_tasks(
        self,
        *,
        parent_task_id: Optional[str] = None,
        root_task_id: Optional[str] = None,
        status: Optional[str] = None,
        kind: Optional[str] = None,
    ) -> list[dict]:
        clauses: list[str] = []
        params: list[Any] = []
        if parent_task_id is not None:
            clauses.append("parent_task_id = ?")
            params.append(parent_task_id)
        if root_task_id is not None:
            clauses.append("root_task_id = ?")
            params.append(root_task_id)
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        if kind is not None:
            clauses.append("kind = ?")
            params.append(kind)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM task{where} ORDER BY created_at, rowid", params
            ).fetchall()
        return [_task_dict(row) for row in rows]

    # ------------------------------------------------------------ step 读写 --
    def create_step(
        self,
        *,
        task_id: str,
        idx: int,
        name: str,
        kind: str = "",
        tools: Optional[list[str]] = None,
        acceptance: str = "",
        task_ref: Optional[str] = None,
        now: Optional[datetime] = None,
        step_id: Optional[str] = None,
    ) -> dict:
        if not isinstance(name, str) or not name.strip():
            raise ValueError("step.name 必须是非空字符串")
        stamp = to_iso(now or utcnow())
        step_id = step_id or new_id("s")
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO step (
                    id, task_id, idx, name, kind, tools, acceptance, status,
                    task_ref, attempts, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)
                """,
                (
                    step_id,
                    task_id,
                    int(idx),
                    name.strip(),
                    kind or "",
                    dumps(list(tools or [])),
                    acceptance or "",
                    task_ref,
                    stamp,
                    stamp,
                ),
            )
        return self.get_step(step_id)

    def get_step(self, step_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM step WHERE id = ?", (step_id,)).fetchone()
        if row is None:
            raise KeyError(f"步骤不存在：{step_id!r}")
        return _step_dict(row)

    def list_steps(self, task_id: str) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM step WHERE task_id = ? ORDER BY idx, rowid", (task_id,)
            ).fetchall()
        return [_step_dict(row) for row in rows]

    def update_step(
        self,
        step_id: str,
        *,
        status: Optional[str] = None,
        output: Any = None,
        error: Optional[str] = None,
        attempts: Optional[int] = None,
        task_ref: Optional[str] = None,
        now: Optional[datetime] = None,
        touch: bool = True,
    ) -> dict:
        sets: list[str] = []
        params: list[Any] = []
        if status is not None:
            if status not in STEP_STATUSES:
                raise ValueError(f"未知 step 状态：{status!r}")
            sets.append("status = ?")
            params.append(status)
        if output is not None:
            sets.append("output = ?")
            params.append(dumps(output))
        if error is not None:
            sets.append("error = ?")
            params.append(str(error))
        if attempts is not None:
            sets.append("attempts = ?")
            params.append(int(attempts))
        if task_ref is not None:
            sets.append("task_ref = ?")
            params.append(task_ref)
        if touch:
            sets.append("updated_at = ?")
            params.append(to_iso(now or utcnow()))
        if not sets:
            return self.get_step(step_id)
        params.append(step_id)
        with self.transaction() as conn:
            cur = conn.execute(
                f"UPDATE step SET {', '.join(sets)} WHERE id = ?", params
            )
            if cur.rowcount == 0:
                raise KeyError(f"步骤不存在：{step_id!r}")
        return self.get_step(step_id)

    # ------------------------------------------------------------ bot 读写 --
    def upsert_bot(
        self,
        bot_id: str,
        *,
        name: str = "",
        role: str = "",
        status: str = "active",
        meta: Optional[Mapping[str, Any]] = None,
        now: Optional[datetime] = None,
    ) -> dict:
        if not isinstance(bot_id, str) or not bot_id.strip():
            raise ValueError("bot.id 必须是非空字符串")
        stamp = to_iso(now or utcnow())
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO bot (id, name, role, status, meta, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    role = excluded.role,
                    status = excluded.status,
                    meta = excluded.meta,
                    updated_at = excluded.updated_at
                """,
                (
                    bot_id,
                    name or bot_id,
                    role or "",
                    status,
                    dumps(dict(meta or {})),
                    stamp,
                    stamp,
                ),
            )
        return self.get_bot(bot_id)

    def get_bot(self, bot_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM bot WHERE id = ?", (bot_id,)).fetchone()
        if row is None:
            raise KeyError(f"bot 不存在：{bot_id!r}")
        return _row_dict(row)

    def list_bots(self) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM bot ORDER BY id").fetchall()
        return [_row_dict(row) for row in rows]

    # -------------------------------------------------------- memory 读写 --
    def add_memory(
        self,
        bot_id: str,
        content: str,
        *,
        key: str = "",
        tags: Optional[list[str]] = None,
        source: str = "manual",
        backend: str = "local",
        now: Optional[datetime] = None,
    ) -> dict:
        if not isinstance(bot_id, str) or not bot_id.strip():
            raise ValueError("memory.bot_id 必须是非空字符串")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("memory.content 必须是非空字符串")
        stamp = to_iso(now or utcnow())
        with self.transaction() as conn:
            if key:
                existing = conn.execute(
                    "SELECT id FROM memory WHERE bot_id = ? AND key = ?",
                    (bot_id, key),
                ).fetchone()
            else:
                existing = None
            if existing is not None:
                conn.execute(
                    """
                    UPDATE memory SET content = ?, tags = ?, source = ?, backend = ?,
                                      updated_at = ?
                    WHERE id = ?
                    """,
                    (content, dumps(list(tags or [])), source, backend, stamp,
                     existing["id"]),
                )
                memory_id = int(existing["id"])
            else:
                cur = conn.execute(
                    """
                    INSERT INTO memory (bot_id, key, content, tags, source, backend,
                                        created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (bot_id, key, content, dumps(list(tags or [])), source,
                     backend, stamp, stamp),
                )
                memory_id = int(cur.lastrowid)
        return self.get_memory(memory_id)

    def get_memory(self, memory_id: int) -> dict:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM memory WHERE id = ?", (int(memory_id),)
            ).fetchone()
        if row is None:
            raise KeyError(f"记忆不存在：{memory_id!r}")
        return _memory_dict(row)

    def list_memory(self, bot_id: str) -> list[dict]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM memory WHERE bot_id = ? ORDER BY updated_at, id",
                (bot_id,),
            ).fetchall()
        return [_memory_dict(row) for row in rows]

    def delete_memory(self, memory_id: int) -> bool:
        with self.transaction() as conn:
            cur = conn.execute("DELETE FROM memory WHERE id = ?", (int(memory_id),))
        return cur.rowcount > 0

    # ---------------------------------------------------- intervention 读写 --
    def add_intervention(
        self,
        *,
        kind: str,
        task_id: Optional[str] = None,
        bot_id: Optional[str] = None,
        prompt: str = "",
        now: Optional[datetime] = None,
        intervention_id: Optional[str] = None,
    ) -> dict:
        if not isinstance(kind, str) or not kind.strip():
            raise ValueError("intervention.kind 必须是非空字符串")
        intervention_id = intervention_id or new_id("i")
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO intervention (id, task_id, bot_id, kind, prompt, status,
                                          created_at)
                VALUES (?, ?, ?, ?, ?, 'pending', ?)
                """,
                (intervention_id, task_id, bot_id, kind.strip(), prompt,
                 to_iso(now or utcnow())),
            )
        return self.get_intervention(intervention_id)

    def get_intervention(self, intervention_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM intervention WHERE id = ?", (intervention_id,)
            ).fetchone()
        if row is None:
            raise KeyError(f"介入记录不存在：{intervention_id!r}")
        return _row_dict(row)

    def resolve_intervention(
        self,
        intervention_id: str,
        response: str,
        *,
        status: str = "resolved",
        now: Optional[datetime] = None,
    ) -> dict:
        if status not in ("resolved", "rejected", "expired"):
            raise ValueError(f"未知介入状态：{status!r}")
        stamp = to_iso(now or utcnow())
        with self.transaction() as conn:
            cur = conn.execute(
                """
                UPDATE intervention SET status = ?, response = ?, resolved_at = ?
                WHERE id = ?
                """,
                (status, response, stamp, intervention_id),
            )
            if cur.rowcount == 0:
                raise KeyError(f"介入记录不存在：{intervention_id!r}")
        return self.get_intervention(intervention_id)

    def list_interventions(self, *, status: Optional[str] = None) -> list[dict]:
        if status is None:
            sql, params = "SELECT * FROM intervention ORDER BY created_at", []
        else:
            sql, params = (
                "SELECT * FROM intervention WHERE status = ? ORDER BY created_at",
                [status],
            )
        with self.connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_dict(row) for row in rows]

    # --------------------------------------------------------- run_link 读写 --
    def link(
        self,
        *,
        kind: str,
        provider: str,
        external_id: str,
        task_id: Optional[str] = None,
        status: str = "linked",
        detail: Optional[Mapping[str, Any]] = None,
        now: Optional[datetime] = None,
        link_id: Optional[str] = None,
        bot_id: Optional[str] = None,
    ) -> dict:
        """建立（或刷新）一条 task ↔ 另一本账的关联。

        * ``kind`` 决定另一头查哪张表；它与 ``provider`` 必须自洽
          （``langgraph/dbos/runtime ↔ thread``、``letta ↔ agent``、
          ``ledger ↔ work_order``），不自洽直接报错 —— 让错行进库再靠查询
          返回 NULL，比当场拒绝难查得多。
        * 同一个 ``(provider, external_id)`` 再 link 一次是**更新**而不是插两行
          （契约 §1 第 4 条 ``UNIQUE(provider, external_id)``）。
        * ``bot_id`` 按契约 §5 移到 ``detail.bot_id``；库里的 ``bot_id`` 列保留
          但标 deprecated（删列会破坏旧数据）。
        """
        pro = _require_choice(provider, LINK_PROVIDERS, "run_link.provider")
        knd = _require_choice(kind, LINK_KINDS, "run_link.kind")
        expected = PROVIDER_TO_KIND[pro]
        if knd != expected:
            raise ValueError(
                f"run_link kind 与 provider 不自洽：provider={pro!r} 只对应 "
                f"kind={expected!r}，收到 {knd!r}"
            )
        if not isinstance(external_id, str) or not external_id.strip():
            raise ValueError("run_link.external_id 不能为空")
        st = _require_choice(status, LINK_STATUSES, "run_link.status")
        stamp = to_iso(now or utcnow())
        link_id = link_id or new_id("r")
        body = dict(detail or {})
        if bot_id is not None:
            body["bot_id"] = bot_id
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO run_link (link_id, task_id, bot_id, kind, provider,
                                      external_id, status, detail,
                                      created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(provider, external_id) DO UPDATE SET
                    task_id = excluded.task_id,
                    bot_id = excluded.bot_id,
                    kind = excluded.kind,
                    status = excluded.status,
                    detail = excluded.detail,
                    updated_at = excluded.updated_at
                """,
                (link_id, task_id, bot_id, knd, pro, external_id.strip(), st,
                 dumps(body), stamp, stamp),
            )
        return self.get_run_link(provider=pro, external_id=external_id.strip())

    def unlink(
        self,
        *,
        provider: str,
        external_id: str,
        now: Optional[datetime] = None,
    ) -> dict:
        """解除关联：``UPDATE status='unlinked'``，**从不物理删**（契约 §1 第 3 条）。"""
        stamp = to_iso(now or utcnow())
        with self.transaction() as conn:
            cur = conn.execute(
                """
                UPDATE run_link SET status = 'unlinked', updated_at = ?
                WHERE provider = ? AND external_id = ?
                """,
                (stamp, provider.strip(), external_id.strip()),
            )
            if cur.rowcount == 0:
                raise KeyError(
                    f"关联不存在：provider={provider!r} external_id={external_id!r}"
                )
        return self.get_run_link(provider=provider, external_id=external_id)

    #: v1 的方法名，保留为别名：旧调用方（以及"不改契约、只对齐代码"的纪律）
    #: 不该因为改名而红。新代码请用 :meth:`link` / :meth:`unlink`。
    add_run_link = link

    def get_run_link(self, *, provider: str, external_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM run_link WHERE provider = ? AND external_id = ?",
                (provider.strip(), external_id.strip()),
            ).fetchone()
        if row is None:
            raise KeyError(
                f"关联不存在：provider={provider!r} external_id={external_id!r}"
            )
        return _link_dict(row)

    def list_run_links(
        self,
        *,
        task_id: Optional[str] = None,
        provider: Optional[str] = None,
        kind: Optional[str] = None,
        status: Optional[str] = None,
    ) -> list[dict]:
        clauses: list[str] = []
        params: list[Any] = []
        if task_id is not None:
            clauses.append("task_id = ?")
            params.append(task_id)
        if provider is not None:
            clauses.append("provider = ?")
            params.append(provider)
        if kind is not None:
            clauses.append("kind = ?")
            params.append(kind)
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM run_link{where} ORDER BY created_at, rowid", params
            ).fetchall()
        return [_link_dict(row) for row in rows]

    # ------------------------------------------------------------ thread 读写 --
    def create_thread(
        self,
        *,
        runtime: str,
        external_thread_id: str,
        checkpointer_ns: str,
        trace_path: str,
        status: str = "open",
        message_count: int = 0,
        last_event_seq: int = 0,
        now: Optional[datetime] = None,
        thread_id: Optional[str] = None,
    ) -> dict:
        if not isinstance(external_thread_id, str) or not external_thread_id.strip():
            raise ValueError("thread.external_thread_id 不能为空")
        if not isinstance(checkpointer_ns, str) or not checkpointer_ns.strip():
            raise ValueError("thread.checkpointer_ns 不能为空")
        if not isinstance(trace_path, str) or not trace_path.strip():
            raise ValueError("thread.trace_path 不能为空")
        run = _require_choice(runtime, RUNTIMES, "thread.runtime")
        st = _require_choice(status, THREAD_STATUSES, "thread.status")
        if int(message_count) < 0 or int(last_event_seq) < 0:
            raise ValueError("thread.message_count / last_event_seq 不能为负")
        stamp = to_iso(now or utcnow())
        thread_id = thread_id or new_id("th")
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO thread (thread_id, runtime, external_thread_id,
                                    checkpointer_ns, trace_path, message_count,
                                    last_event_seq, status, created_at, closed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (thread_id, run, external_thread_id.strip(),
                 checkpointer_ns.strip(), trace_path.strip(), int(message_count),
                 int(last_event_seq), st, stamp,
                 stamp if st == "closed" else None),
            )
        return self.get_thread(thread_id)

    def get_thread(self, thread_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM thread WHERE thread_id = ?", (thread_id,)
            ).fetchone()
        if row is None:
            raise KeyError(f"线程不存在：{thread_id!r}")
        return _row_dict(row)

    def list_threads(self, *, status: Optional[str] = None) -> list[dict]:
        if status is None:
            sql, params = "SELECT * FROM thread ORDER BY created_at, rowid", []
        else:
            sql, params = (
                "SELECT * FROM thread WHERE status = ? ORDER BY created_at, rowid",
                [status],
            )
        with self.connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_row_dict(row) for row in rows]

    def update_thread(
        self,
        thread_id: str,
        *,
        status: Optional[str] = None,
        message_count: Optional[int] = None,
        last_event_seq: Optional[int] = None,
        now: Optional[datetime] = None,
    ) -> dict:
        """推进线程状态。``closed`` 时自动写 ``closed_at``，其余状态不动它。"""
        sets: list[str] = []
        params: list[Any] = []
        if status is not None:
            st = _require_choice(status, THREAD_STATUSES, "thread.status")
            sets.append("status = ?")
            params.append(st)
            if st == "closed":
                sets.append("closed_at = ?")
                params.append(to_iso(now or utcnow()))
        if message_count is not None:
            if int(message_count) < 0:
                raise ValueError("thread.message_count 不能为负")
            sets.append("message_count = ?")
            params.append(int(message_count))
        if last_event_seq is not None:
            if int(last_event_seq) < 0:
                raise ValueError("thread.last_event_seq 不能为负")
            sets.append("last_event_seq = ?")
            params.append(int(last_event_seq))
        if not sets:
            return self.get_thread(thread_id)
        params.append(thread_id)
        with self.transaction() as conn:
            cur = conn.execute(
                f"UPDATE thread SET {', '.join(sets)} WHERE thread_id = ?", params
            )
            if cur.rowcount == 0:
                raise KeyError(f"线程不存在：{thread_id!r}")
        return self.get_thread(thread_id)

    # ------------------------------------------------------------- agent 读写 --
    def create_agent(
        self,
        *,
        name: str,
        kind: str,
        spec_path: str,
        spec_sha256: str,
        runtime: str,
        model: str,
        memory_namespace: str,
        allowed_tools: Optional[list[str]] = None,
        parent_agent_id: Optional[str] = None,
        status: str = "active",
        now: Optional[datetime] = None,
        agent_id: Optional[str] = None,
    ) -> dict:
        if not isinstance(name, str) or not name.strip():
            raise ValueError("agent.name 必须是非空字符串")
        for field, value in (("spec_path", spec_path), ("model", model),
                             ("memory_namespace", memory_namespace)):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"agent.{field} 必须是非空字符串")
        if not isinstance(spec_sha256, str) or not spec_sha256.strip():
            raise ValueError("agent.spec_sha256 必须是非空字符串")
        knd = _require_choice(kind, AGENT_KINDS, "agent.kind")
        run = _require_choice(runtime, RUNTIMES, "agent.runtime")
        st = _require_choice(status, AGENT_STATUSES, "agent.status")
        tools = list(allowed_tools or [])
        if any(not isinstance(t, str) or not t.strip() for t in tools):
            raise ValueError("agent.allowed_tools 只接受非空字符串数组")
        stamp = to_iso(now or utcnow())
        agent_id = agent_id or new_id("ag")
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO agent (agent_id, name, kind, spec_path, spec_sha256,
                                   runtime, model, memory_namespace,
                                   parent_agent_id, allowed_tools, status,
                                   created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (agent_id, name.strip(), knd, spec_path.strip(),
                 spec_sha256.strip(), run, model.strip(), memory_namespace.strip(),
                 parent_agent_id, dumps(tools), st, stamp),
            )
        return self.get_agent(agent_id)

    def get_agent(self, agent_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM agent WHERE agent_id = ?", (agent_id,)
            ).fetchone()
        if row is None:
            raise KeyError(f"agent 不存在：{agent_id!r}")
        return _agent_dict(row)

    def list_agents(
        self, *, status: Optional[str] = None, name: Optional[str] = None
    ) -> list[dict]:
        clauses: list[str] = []
        params: list[Any] = []
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        if name is not None:
            clauses.append("name = ?")
            params.append(name)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM agent{where} ORDER BY created_at, rowid", params
            ).fetchall()
        return [_agent_dict(row) for row in rows]

    def update_agent_status(
        self, agent_id: str, status: str
    ) -> dict:
        st = _require_choice(status, AGENT_STATUSES, "agent.status")
        with self.transaction() as conn:
            cur = conn.execute(
                "UPDATE agent SET status = ? WHERE agent_id = ?", (st, agent_id)
            )
            if cur.rowcount == 0:
                raise KeyError(f"agent 不存在：{agent_id!r}")
        return self.get_agent(agent_id)

    # -------------------------------------------------------- work_order 读写 --
    def create_work_order(
        self,
        *,
        station_id: str,
        title: str,
        risk: str,
        created_by: str,
        priority: str = "P3",
        status: str = "open",
        action: Optional[str] = None,
        description: Optional[str] = None,
        evidence_call_ids: Optional[list[str]] = None,
        approved_by: Optional[str] = None,
        artifact_sha256: Optional[str] = None,
        now: Optional[datetime] = None,
        work_order_id: Optional[str] = None,
    ) -> dict:
        for field, value in (("station_id", station_id), ("title", title),
                             ("created_by", created_by)):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"work_order.{field} 必须是非空字符串")
        pri = _require_choice(priority, WO_PRIORITIES, "work_order.priority")
        rsk = _require_choice(risk, WO_RISKS, "work_order.risk")
        st = _require_choice(status, WO_STATUSES, "work_order.status")
        evidence = list(evidence_call_ids or [])
        if any(not isinstance(c, str) or not c.strip() for c in evidence):
            raise ValueError("work_order.evidence_call_ids 只接受非空字符串数组")
        if rsk == "high" and st == "done" and not approved_by:
            raise PreconditionError(
                "risk=high 的工单进 done 前必须已有 approved_by"
            )
        stamp = to_iso(now or utcnow())
        work_order_id = work_order_id or new_id("wo")
        with self.transaction() as conn:
            conn.execute(
                """
                INSERT INTO work_order (work_order_id, station_id, title, priority,
                                        risk, status, action, description,
                                        evidence_call_ids, created_by, approved_by,
                                        created_at, closed_at, artifact_sha256)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (work_order_id, station_id.strip(), title.strip(), pri, rsk, st,
                 action, description, dumps(evidence), created_by.strip(),
                 approved_by, stamp,
                 stamp if st in WO_CLOSED_STATUSES else None,
                 artifact_sha256),
            )
        return self.get_work_order(work_order_id)

    def get_work_order(self, work_order_id: str) -> dict:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM work_order WHERE work_order_id = ?",
                (work_order_id,),
            ).fetchone()
        if row is None:
            raise KeyError(f"工单不存在：{work_order_id!r}")
        return _work_order_dict(row)

    def list_work_orders(
        self,
        *,
        station_id: Optional[str] = None,
        status: Optional[str] = None,
        open_only: bool = False,
    ) -> list[dict]:
        """按契约 §3.3 的口径排序：``priority`` 再 ``created_at``。"""
        clauses: list[str] = []
        params: list[Any] = []
        if station_id is not None:
            clauses.append("station_id = ?")
            params.append(station_id)
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        if open_only:
            clauses.append(
                "status NOT IN ('done', 'cancelled', 'rejected')")
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
        with self.connect() as conn:
            rows = conn.execute(
                f"SELECT * FROM work_order{where} ORDER BY priority, created_at",
                params,
            ).fetchall()
        return [_work_order_dict(row) for row in rows]

    def update_work_order(
        self,
        work_order_id: str,
        *,
        status: Optional[str] = None,
        approved_by: Optional[str] = None,
        action: Optional[str] = None,
        description: Optional[str] = None,
        artifact_sha256: Optional[str] = None,
        now: Optional[datetime] = None,
    ) -> dict:
        """推进工单。**高风险进 ``done`` 必须有批准人**，否则 ``E_PRECOND``。

        审批检查读的是「本行现有的 ``approved_by``」加上「本次一并传进来的
        ``approved_by``」——后者允许"审批与结单一起来"，但绝不放过没批就结单。
        """
        current = self.get_work_order(work_order_id)
        sets: list[str] = []
        params: list[Any] = []
        if approved_by is not None:
            if not isinstance(approved_by, str) or not approved_by.strip():
                raise ValueError("work_order.approved_by 必须是非空字符串")
            sets.append("approved_by = ?")
            params.append(approved_by.strip())
        if status is not None:
            st = _require_choice(status, WO_STATUSES, "work_order.status")
            effective_approver = (
                approved_by.strip() if approved_by is not None
                else current.get("approved_by")
            )
            if st == "done" and current.get("risk") == "high" and not effective_approver:
                raise PreconditionError(
                    f"工单 {work_order_id} 的 risk=high，进 done 前必须已有 approved_by"
                )
            sets.append("status = ?")
            params.append(st)
            if st in WO_CLOSED_STATUSES:
                sets.append("closed_at = ?")
                params.append(to_iso(now or utcnow()))
        if action is not None:
            sets.append("action = ?")
            params.append(action)
        if description is not None:
            sets.append("description = ?")
            params.append(description)
        if artifact_sha256 is not None:
            sets.append("artifact_sha256 = ?")
            params.append(artifact_sha256)
        if not sets:
            return current
        params.append(work_order_id)
        with self.transaction() as conn:
            cur = conn.execute(
                f"UPDATE work_order SET {', '.join(sets)} WHERE work_order_id = ?",
                params,
            )
            if cur.rowcount == 0:
                raise KeyError(f"工单不存在：{work_order_id!r}")
        return self.get_work_order(work_order_id)

    # ---------------------------------------------------------- 契约 §3 查询 --
    def task_accounts(self, task_id: str) -> list[dict]:
        """契约 §3.1：一条 task 拉全四本账（没有的关联是 ``None``，不伪造空串）。"""
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT t.task_id, t.title, t.status,
                       th.thread_id, th.runtime, th.trace_path,
                       ag.agent_id, ag.name AS agent_name, ag.model,
                       wo.work_order_id, wo.status AS wo_status, wo.priority
                FROM task t
                LEFT JOIN run_link lt ON lt.task_id = t.task_id AND lt.kind = 'thread'     AND lt.status = 'linked'
                LEFT JOIN thread   th ON th.thread_id = lt.external_id
                LEFT JOIN run_link la ON la.task_id = t.task_id AND la.kind = 'agent'      AND la.status = 'linked'
                LEFT JOIN agent    ag ON ag.agent_id = la.external_id
                LEFT JOIN run_link lw ON lw.task_id = t.task_id AND lw.kind = 'work_order' AND lw.status = 'linked'
                LEFT JOIN work_order wo ON wo.work_order_id = lw.external_id
                WHERE t.task_id = ?
                """,
                (task_id,),
            ).fetchall()
        return [_row_dict(r) for r in rows]

    def work_order_trace(self, work_order_id: str) -> list[dict]:
        """契约 §3.2：从工单反查"为什么跑 / 怎么想的 / 记得什么"。"""
        with self.connect() as conn:
            rows = conn.execute(
                """
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
                WHERE wo.work_order_id = ?
                """,
                (work_order_id,),
            ).fetchall()
        return [_row_dict(r) for r in rows]

    def resumable_tasks(self, *, now: Optional[datetime] = None) -> list[dict]:
        """契约 §3.4：崩溃后可续跑的 task 与线程（租约已过期或从未领取）。"""
        stamp = to_iso(now or utcnow())
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT t.task_id, t.status, t.attempts, t.lease_expires_at,
                       th.thread_id, th.last_event_seq, th.trace_path
                FROM task t
                JOIN run_link lt ON lt.task_id = t.task_id AND lt.kind = 'thread' AND lt.status = 'linked'
                JOIN thread th   ON th.thread_id = lt.external_id
                WHERE t.status IN ('running', 'waiting_approval', 'waiting_operator')
                  AND (t.lease_expires_at IS NULL OR t.lease_expires_at < ?)
                ORDER BY t.priority DESC, t.updated_at
                """,
                (stamp,),
            ).fetchall()
        return [_row_dict(r) for r in rows]

    def orphan_links(self) -> list[dict]:
        """契约 §3.5 第一条：``run_link`` 指向了不存在的 thread。"""
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT l.link_id, l.task_id, l.external_id
                FROM run_link l
                LEFT JOIN thread th ON l.kind = 'thread' AND th.thread_id = l.external_id
                WHERE l.kind = 'thread' AND l.status = 'linked' AND th.thread_id IS NULL
                """
            ).fetchall()
        return [_row_dict(r) for r in rows]

    def unlinked_tasks(self) -> list[dict]:
        """契约 §3.5 第二条：有 task 却没有任何 ``run_link``。"""
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT t.task_id, t.kind, t.status
                FROM task t
                LEFT JOIN run_link l ON l.task_id = t.task_id AND l.status = 'linked'
                WHERE l.link_id IS NULL
                  AND t.status IN ('running', 'waiting_approval')
                """
            ).fetchall()
        return [_row_dict(r) for r in rows]


# --------------------------------------------------------------- row 解码 --
def _row_dict(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in row.keys()}


def _task_dict(row: sqlite3.Row) -> dict:
    data = _row_dict(row)
    data["payload"] = loads(data.get("payload"), {})
    data["result"] = loads(data.get("result"), None)
    return data


def _step_dict(row: sqlite3.Row) -> dict:
    data = _row_dict(row)
    data["tools"] = loads(data.get("tools"), [])
    data["output"] = loads(data.get("output"), None)
    return data


def _memory_dict(row: sqlite3.Row) -> dict:
    data = _row_dict(row)
    data["tags"] = loads(data.get("tags"), [])
    return data


def _link_dict(row: sqlite3.Row) -> dict:
    data = _row_dict(row)
    data["detail"] = loads(data.get("detail"), {})
    return data


def _agent_dict(row: sqlite3.Row) -> dict:
    data = _row_dict(row)
    data["allowed_tools"] = loads(data.get("allowed_tools"), [])
    return data


def _work_order_dict(row: sqlite3.Row) -> dict:
    data = _row_dict(row)
    data["evidence_call_ids"] = loads(data.get("evidence_call_ids"), [])
    return data


def _require_choice(value: Any, allowed: tuple[str, ...], field: str) -> str:
    """枚举校验：不在 ``allowed`` 里就报错，并把可选值一起打出来。

    这里刻意不"顺手补默认值" —— 拼错的 ``kind`` / ``status`` 如果被默默改成
    默认值，写进去的行会指向错的表，而且**查询返回 NULL 而不是报错**。
    """
    if not isinstance(value, str) or value not in allowed:
        raise ValueError(f"{field} 必须是 {allowed} 之一，收到 {value!r}")
    return value
