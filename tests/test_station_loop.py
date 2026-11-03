"""M6-4：任务调度与失败分类（issue #111）。

钉住四件事：

* 注入时钟的三种情形：到点触发 / 错过触发 / 超时，各有独立用例；
* 任务失败**不抛未捕获异常**，也不阻塞后面的任务；
* 同一时钟序列两次运行写出的台账**逐字节相同**；
* 调度台账与试运行台账**同形**：``tools/trial_ledger.py`` 能直接汇总，
  且能把「任务失败」与「数据源失败」分开计数。
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT / "tools"), str(ROOT / "harness")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

START = datetime(2024, 1, 1, 0, 0, tzinfo=timezone.utc)


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module          # dataclass 需要模块已登记
    spec.loader.exec_module(module)
    return module


LOOP = _load("station_loop", ROOT / "harness" / "station_loop.py")
LEDGER = _load("trial_ledger", ROOT / "tools" / "trial_ledger.py")


def _at(minutes: float = 0.0, seconds: float = 0.0) -> datetime:
    from datetime import timedelta
    return START + timedelta(minutes=minutes, seconds=seconds)


class TestScheduling(unittest.TestCase):
    def test_triggers_on_time(self):
        clock = LOOP.ManualClock(START)
        seen: list[datetime] = []
        tasks = (LOOP.TaskSpec("collect", 60.0, seen.append),)
        rows = LOOP.StationLoop(tasks, clock=clock).run_until(
            _at(minutes=3), start=START)
        self.assertEqual(seen, [_at(), _at(minutes=1), _at(minutes=2),
                                _at(minutes=3)])
        self.assertEqual(len(rows), 4)
        self.assertEqual({row["status"] for row in rows}, {"ok"})
        self.assertEqual({row["failure_class"] for row in rows}, {None})

    def test_missed_trigger_is_recorded_once_and_skips_ahead(self):
        clock = LOOP.ManualClock(START)
        clock.advance(150)                       # 调度器晚醒了 2.5 个周期
        tasks = (LOOP.TaskSpec("collect", 60.0, lambda due: None, grace_s=60.0),)
        rows = LOOP.StationLoop(tasks, clock=clock).run_until(
            _at(minutes=3), start=START)
        self.assertEqual(len(rows), 2, rows)
        self.assertEqual(rows[0]["status"], "failed")
        self.assertEqual(rows[0]["failure_class"], "任务未执行")
        self.assertIn("错过 3 个周期", rows[0]["notes"])
        self.assertIsNone(rows[0]["started_at"])
        self.assertEqual(rows[1]["status"], "ok")
        self.assertEqual(rows[1]["ts"], _at(minutes=3).isoformat())

    def test_timeout_is_detected_from_injected_clock(self):
        clock = LOOP.ManualClock(START)
        tasks = (LOOP.TaskSpec("slow", 600.0,
                               lambda due: clock.advance(120), timeout_s=60.0),)
        rows = LOOP.StationLoop(tasks, clock=clock).run_until(START,
                                                             start=START)
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual(rows[0]["status"], "failed")
        self.assertEqual(rows[0]["failure_class"], "任务超时")
        self.assertAlmostEqual(rows[0]["duration_ms"], 120000.0, places=1)
        self.assertIn("超过上限", rows[0]["notes"])

    def test_task_failure_does_not_stop_the_loop(self):
        clock = LOOP.ManualClock(START)

        def boom(_due):
            raise RuntimeError("采集失败（演示）")

        tasks = (
            LOOP.TaskSpec("broken", 60.0, boom),
            LOOP.TaskSpec("collect", 60.0, lambda due: None),
        )
        rows = LOOP.StationLoop(tasks, clock=clock).run_until(
            START, start=START)
        self.assertEqual(len(rows), 2, rows)
        self.assertEqual(rows[0]["task_id"], "broken")
        self.assertEqual(rows[0]["failure_class"], "未知")
        self.assertIn("采集失败", rows[0]["notes"])
        self.assertEqual(rows[1]["status"], "ok")

    def test_duplicate_task_ids_rejected(self):
        with self.assertRaises(ValueError):
            LOOP.StationLoop(
                (LOOP.TaskSpec("a", 60.0, lambda due: None),
                 LOOP.TaskSpec("a", 60.0, lambda due: None)),
                clock=LOOP.ManualClock(START))

    def test_rows_are_ledger_shaped(self):
        clock = LOOP.ManualClock(START)
        rows = LOOP.StationLoop(
            (LOOP.TaskSpec("collect", 60.0, lambda due: None),),
            clock=clock, run_id="r1").run_until(START, start=START)
        row = rows[0]
        for key in ("ts", "run_id", "source_id", "url", "status",
                    "failure_class", "bytes", "sha256", "n_records",
                    "duration_ms", "notes", "task_id", "scheduled_at",
                    "started_at", "finished_at"):
            self.assertIn(key, row)
        self.assertEqual(row["source_id"], "task:collect")


class TestLedgerIntegration(unittest.TestCase):
    def test_summary_separates_task_and_source_failures(self):
        rows = [
            {"status": "ok", "failure_class": None, "source_id": "task:a",
             "task_id": "a"},
            {"status": "failed", "failure_class": "任务未执行",
             "source_id": "task:a", "task_id": "a"},
            {"status": "failed", "failure_class": "任务超时",
             "source_id": "task:b", "task_id": "b"},
            {"status": "failed", "failure_class": "连接失败",
             "source_id": "openmeteo"},
        ]
        summary = LEDGER.summarize(rows)
        self.assertEqual(summary["by_failure_kind"],
                         {"data_source": 1, "task": 2})
        self.assertEqual(set(summary["failure_classes"]),
                         set(LEDGER.ALL_FAILURE_CLASSES))
        self.assertEqual(len(LEDGER.TASK_FAILURE_CLASSES), 2)

        loop_summary = LOOP.summarize(rows)
        self.assertEqual(loop_summary["missed"], 1)
        self.assertEqual(loop_summary["timeouts"], 1)


class TestDemo(unittest.TestCase):
    def test_demo_is_deterministic(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            LOOP.demo(td / "a.jsonl", td / "a.json")
            LOOP.demo(td / "b.jsonl", td / "b.json")
            self.assertEqual((td / "a.jsonl").read_bytes(),
                             (td / "b.jsonl").read_bytes())
            self.assertEqual((td / "a.json").read_bytes(),
                             (td / "b.json").read_bytes())
            for path in (td / "a.jsonl", td / "a.json"):
                raw = path.read_bytes()
                self.assertNotIn(b"\r\n", raw)
                self.assertTrue(raw.endswith(b"\n"))

    def test_cli_demo_covers_all_three_cases(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            out = td / "ledger.jsonl"
            summary_path = td / "summary.json"
            env = dict(os.environ)
            env["PYTHONPATH"] = "src"
            env["PYTHONIOENCODING"] = "utf-8"
            run = subprocess.run(
                [sys.executable, str(ROOT / "harness" / "station_loop.py"),
                 "--out", str(out), "--summary-out", str(summary_path)],
                capture_output=True, text=True, encoding="utf-8",
                errors="replace", cwd=str(ROOT), env=env, timeout=120)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertGreaterEqual(summary["missed"], 1)
            self.assertGreaterEqual(summary["timeouts"], 1)
            rows = [json.loads(line) for line in
                    out.read_text(encoding="utf-8").splitlines() if line.strip()]
            self.assertIn("未知", summary["by_failure_class"])
            # 与试运行台账同形：同一份行能被 trial_ledger 直接汇总。
            self.assertEqual(LEDGER.summarize(rows)["rows"], len(rows))


if __name__ == "__main__":
    unittest.main()
