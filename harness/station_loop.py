#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""任务调度与失败分类（M6-4，issue #111）。

无人值守的第一块短板：所有入口原来都是按需脚本，**没有调度器**，台账六类失败里
也没有「任务没跑」这一维。数据没进来时，分不清是设备坏了、数据源挂了，还是任务
压根没触发。

本模块只负责「什么时候跑」，不碰链路内部逻辑：

* 时钟**注入**（``SystemClock`` / ``ManualClock``），trace 与台账里不出现墙钟；
* 任务记录写 JSONL，字段与 ``tools/trial_ledger.py`` 的行**同形**，所以同一套
  汇总/看板能直接读（``source_id = task:<id>``）；
* 两类新失败：``任务未执行``（错过窗口）与 ``任务超时``（跑过上限）—— 都在
  ``tools/trial_ledger.py`` 的分类表里登记，不在本文件另立一套；
* 任务失败**不抛未捕获异常**：记一行台账，继续跑下一个任务。

## 三种情形（验收口径）

| 情形 | 判据 | 台账 |
|---|---|---|
| 到点触发 | ``now`` 落在 ``[due, due + grace]`` | ``status=ok`` |
| 错过触发 | ``now > due + grace``（调度线程被上一个任务拖住） | ``任务未执行`` |
| 超时 | 单次执行耗时 ``> timeout_s`` | ``任务超时`` |

同一时钟序列两次运行写出的 JSONL 逐字节相同（``tests/test_station_loop.py`` 钉死）。

用法：
    python harness/station_loop.py                 # 确定性演示，写 logs/
    python harness/station_loop.py --out <路径> --summary-out <路径>
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Protocol

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT / "tools")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

DEFAULT_OUT = ROOT / "logs" / "station_loop_demo.jsonl"
DEFAULT_SUMMARY = ROOT / "logs" / "station_loop_demo_summary.json"
STATUSES = ("ok", "failed")
MISSED = "任务未执行"
TIMEOUT = "任务超时"


class Clock(Protocol):
    """调度器唯一的时钟来源（注入，不读墙钟）。"""

    def now(self) -> datetime:
        ...

    def sleep_until(self, when: datetime) -> None:
        ...


class SystemClock:
    """生产时钟：UTC + ``time.sleep``。"""

    def now(self) -> datetime:
        return datetime.now(timezone.utc)

    def sleep_until(self, when: datetime) -> None:
        delay = (when - self.now()).total_seconds()
        if delay > 0:
            time.sleep(delay)


class ManualClock:
    """测试 / 演示时钟：``sleep_until`` 直接把指针拨到目标时刻。

    任务 runner 也可以调 ``advance`` 模拟「这一趟跑了很久」——超时与错过的判据
    都从时钟取，因此两者都可复现。
    """

    def __init__(self, start: datetime) -> None:
        if not isinstance(start, datetime):
            raise ValueError("start 必须是 datetime")
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        self._now = start

    def now(self) -> datetime:
        return self._now

    def sleep_until(self, when: datetime) -> None:
        if when > self._now:
            self._now = when

    def advance(self, seconds: float) -> None:
        if seconds < 0:
            raise ValueError("advance 不接受负值")
        self._now += timedelta(seconds=float(seconds))


@dataclass(frozen=True)
class TaskSpec:
    """一个定时任务。``runner`` 接收「应执行的时刻」（不是墙钟）。"""

    task_id: str
    interval_s: float
    runner: Callable[[datetime], object]
    timeout_s: float | None = None
    grace_s: float | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.task_id, str) or not self.task_id.strip():
            raise ValueError("task_id 必须是非空字符串")
        if not isinstance(self.interval_s, (int, float)) or self.interval_s <= 0:
            raise ValueError(f"任务 {self.task_id!r} 的 interval_s 必须是正数")
        if not callable(self.runner):
            raise ValueError(f"任务 {self.task_id!r} 的 runner 必须可调用")
        if self.timeout_s is not None and self.timeout_s <= 0:
            raise ValueError(f"任务 {self.task_id!r} 的 timeout_s 必须是正数")
        if self.grace_s is not None and self.grace_s < 0:
            raise ValueError(f"任务 {self.task_id!r} 的 grace_s 不能为负")


def _iso(value: datetime | None) -> str | None:
    return None if value is None else value.isoformat()


def _sanitize(text) -> str:
    """台账要入库：把本机家目录换成 ``<home>``。"""
    value = "" if text is None else str(text)
    home = str(Path.home())
    for form in (home, home.replace("\\", "/")):
        if form:
            value = value.replace(form, "<home>")
    return value


def _row(*, ts: datetime, run_id: str, task: TaskSpec, started: datetime | None,
         finished: datetime, status: str, failure_class: str | None,
         duration_ms: float, notes: str) -> dict:
    """一行台账：与 ``tools/trial_ledger.py`` 的行同形 + 任务专有字段。"""
    return {
        "ts": ts.isoformat(),
        "run_id": run_id,
        "source_id": f"task:{task.task_id}",
        "url": "",
        "status": status,
        "failure_class": failure_class,
        "bytes": None,
        "sha256": None,
        "n_records": None,
        "duration_ms": round(duration_ms, 3),
        "notes": _sanitize(notes),
        # 任务记录专有字段（issue #111 的交付物）。
        "task_id": task.task_id,
        "scheduled_at": ts.isoformat(),
        "started_at": _iso(started),
        "finished_at": finished.isoformat(),
        "interval_s": float(task.interval_s),
    }


class StationLoop:
    """单线程、同步、确定性的调度循环（标准库，不引 APScheduler / cron）。"""

    def __init__(self, tasks, *, clock: Clock, run_id: str = "local",
                 max_rows: int = 10000) -> None:
        self.tasks = list(tasks)
        if not self.tasks:
            raise ValueError("至少需要一个任务")
        ids = [task.task_id for task in self.tasks]
        if len(set(ids)) != len(ids):
            raise ValueError(f"任务 id 重复：{ids}")
        self.clock = clock
        self.run_id = run_id
        self.max_rows = int(max_rows)

    def run_until(self, end: datetime, *, start: datetime | None = None) -> list[dict]:
        """从 ``start`` 跑到 ``end``（含端点），返回台账行。"""
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        if start is None:
            start = self.clock.now()
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if end < start:
            raise ValueError("end 不能早于 start")

        next_due = {task.task_id: start for task in self.tasks}
        rows: list[dict] = []
        while True:
            pending = [task for task in self.tasks
                       if next_due[task.task_id] <= end]
            if not pending:
                break
            earliest = min(next_due[task.task_id] for task in pending)
            if self.clock.now() < earliest:
                self.clock.sleep_until(earliest)
            now = self.clock.now()

            for task in self.tasks:
                due = next_due[task.task_id]
                if due > end or due > now:
                    continue
                grace = (task.grace_s if task.grace_s is not None
                         else task.interval_s)
                late = (now - due).total_seconds()
                if late > grace:
                    # 单线程调度被上一个任务拖住：错过的不逐个补跑，记一行
                    # 「错过 N 个周期」，然后把下一站推到 now 之后。
                    span = int(late // task.interval_s) + 1
                    next_due[task.task_id] = due + timedelta(
                        seconds=float(task.interval_s) * span)
                    rows.append(_row(
                        ts=due, run_id=self.run_id, task=task, started=None,
                        finished=now, status="failed", failure_class=MISSED,
                        duration_ms=0.0,
                        notes=(f"错过 {span} 个周期；最近应执行 {due.isoformat()}，"
                               f"实际到 {now.isoformat()}")))
                    if len(rows) > self.max_rows:
                        raise RuntimeError(f"台账行数超过上限 {self.max_rows}")
                    continue

                started = self.clock.now()
                failure_class = None
                status = "ok"
                notes = ""
                try:
                    task.runner(due)
                except Exception as exc:  # noqa: BLE001 —— 任务失败不炸调度器
                    status = "failed"
                    failure_class = "未知"
                    notes = f"{type(exc).__name__}: {exc}"
                finished = self.clock.now()
                duration_s = (finished - started).total_seconds()
                if (status == "ok" and task.timeout_s is not None
                        and duration_s > task.timeout_s):
                    status = "failed"
                    failure_class = TIMEOUT
                    notes = (f"耗时 {duration_s:.3f}s 超过上限 "
                             f"{task.timeout_s}s")
                rows.append(_row(
                    ts=due, run_id=self.run_id, task=task, started=started,
                    finished=finished, status=status,
                    failure_class=failure_class, duration_ms=duration_s * 1000,
                    notes=notes))
                next_due[task.task_id] = due + timedelta(
                    seconds=float(task.interval_s))
                if len(rows) > self.max_rows:
                    raise RuntimeError(f"台账行数超过上限 {self.max_rows}")
        return rows


def summarize(rows: list[dict]) -> dict:
    """按状态、失败类、任务汇总；口径与试运行台账一致。"""
    by_status: dict[str, int] = {}
    by_class: dict[str, int] = {}
    by_task: dict[str, int] = {}
    for row in rows:
        status = row.get("status", "unknown")
        by_status[status] = by_status.get(status, 0) + 1
        failure = row.get("failure_class")
        if failure:
            by_class[failure] = by_class.get(failure, 0) + 1
        task = row.get("task_id") or row.get("source_id")
        by_task[task] = by_task.get(task, 0) + 1
    total = len(rows)
    ok = by_status.get("ok", 0)
    return {
        "rows": total,
        "by_status": by_status,
        "by_failure_class": by_class,
        "by_task": by_task,
        "success_rate": round(ok / total, 3) if total else None,
        "missed": by_class.get(MISSED, 0),
        "timeouts": by_class.get(TIMEOUT, 0),
    }


def write_rows(path: str | Path, rows: list[dict]) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False,
                                    sort_keys=True) + "\n")
    return target


def write_summary(path: str | Path, summary: dict) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(summary, ensure_ascii=False, indent=2,
                                sort_keys=True) + "\n")
    return target


def demo(out: Path, summary_out: Path) -> tuple[list[dict], dict]:
    """确定性演示：到点、失败、超时、错过四种台账行各至少一条。"""
    start = datetime(2024, 1, 1, 0, 0, tzinfo=timezone.utc)
    end = datetime(2024, 1, 1, 0, 30, tzinfo=timezone.utc)
    clock = ManualClock(start)

    state = {"poll_runs": 0, "flush_runs": 0}

    def collect(_due: datetime) -> None:
        return None

    def qc(_due: datetime) -> None:
        return None

    def flush(_due: datetime) -> None:
        state["flush_runs"] += 1
        if state["flush_runs"] == 1:
            return None
        raise ValueError("归档目录不可写（演示）")

    def poll(_due: datetime) -> None:
        state["poll_runs"] += 1
        if state["poll_runs"] == 1:
            # 演示：这一趟跑了 15 分钟，把后面的任务全拖过窗口。
            clock.advance(900)

    tasks = (
        TaskSpec("collect", 300.0, collect, grace_s=60.0),
        TaskSpec("qc", 600.0, qc, grace_s=600.0),
        TaskSpec("flush", 1800.0, flush),
        TaskSpec("poll", 600.0, poll, timeout_s=60.0),
    )
    rows = StationLoop(tasks, clock=clock, run_id="demo-20240101").run_until(
        end, start=start)
    summary = summarize(rows)
    write_rows(out, rows)
    write_summary(summary_out, summary)
    return rows, summary


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="任务调度与失败分类（M6-4）")
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    parser.add_argument("--summary-out", default=str(DEFAULT_SUMMARY))
    args = parser.parse_args(argv)
    try:
        rows, summary = demo(Path(args.out), Path(args.summary_out))
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"[阻断] {exc}")
        return 2
    print(f"[OK] {args.out}：{summary['rows']} 行 / ok "
          f"{summary['by_status'].get('ok', 0)} / 错过 {summary['missed']} / "
          f"超时 {summary['timeouts']}")
    print(f"[OK] {args.summary_out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
