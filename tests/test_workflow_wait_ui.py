#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""``wait_ui``：条件等待而不是盲等。

钉住四件事：

1. **满足就继续**：第 N 次读到符合 ``expect`` 的值就停，轮询间隔默认 200ms；
2. **读不到不等于失败**：``GuiUnavailable``（弹窗还没画出来）只算「还没到时候」；
3. **总时长不超过 timeout**：最后一次 sleep 会被夹到剩余预算，超时归类 ``gate_timeout``；
4. **没有驱动就不假装等**：变成 ``waiting_operator`` 人工任务（``assisted.enabled=false`` 则
   ``capability`` 失败），与 ``verify_ui`` 同一条纪律。

全部用假时钟/假驱动，不连 CDP、不碰套件。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fieldstation.workflows import gui as gui_mod
from fieldstation.workflows import spec as spec_mod
from fieldstation.workflows.runner import WorkflowRunner
from fieldstation.workflows.store import JobStore


class StepClock:
    """只有被 sleep 时才前进的时钟： slept 总量就是「等了多久」。"""

    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(round(seconds, 6))
        self.now += seconds


class SequenceDriver:
    """按顺序吐读值；列表只剩一项时一直重复它。抛异常就表示「读不到」。"""

    name = "cdp"
    available = True

    def __init__(self, reads: list) -> None:
        self.reads = list(reads)
        self.controls: list[str] = []
        self.read_count = 0

    def read(self, control: str) -> str:
        self.read_count += 1
        self.controls.append(control)
        item = self.reads.pop(0) if len(self.reads) > 1 else self.reads[0]
        if isinstance(item, BaseException):
            raise item
        return item

    def open(self, page: str) -> None:
        raise AssertionError("wait_ui 不应该导航")

    def click(self, locator: str) -> None:
        raise AssertionError("wait_ui 不应该点击")

    def type_text(self, locator: str, text: str) -> None:
        raise AssertionError("wait_ui 不应该输入")

    def select(self, locator: str, option: str) -> None:
        raise AssertionError("wait_ui 不应该选择")

    def screenshot(self, path: Path) -> str | None:
        return None


class _DummyEngine:
    base_url = "http://fake"


POPUP = "Current Version: 2.11.0"


class WaitUi(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = JobStore(Path(self.tmp.name) / "jobs")

    def spec(self, step: dict, **overrides):
        data = {
            "id": "demo.flow", "version": 1, "title": "demo", "intent": "demo.run",
            "steps": [step],
        }
        data.update(overrides)
        return spec_mod.build_spec(data, source="memory")

    def wait_step(self, **overrides) -> dict:
        step = {
            "id": "wait", "kind": "wait_ui", "control": "Current Version",
            "expect": {"contains": "Current Version"},
        }
        step.update(overrides)
        return step

    def run_flow(self, spec, driver, clock=None):
        clock = clock or StepClock()
        job, _ = self.store.create(spec, {}, engine="fake", driver="fake")
        runner = WorkflowRunner(self.store, _DummyEngine(), driver,
                                sleep=clock.sleep, clock=clock)
        return runner.run(job, spec), clock

    # ---------------------------------------------------------------- 成功
    def test_continues_as_soon_as_expect_matches(self):
        driver = SequenceDriver(["", "", POPUP])
        job, clock = self.run_flow(self.spec(self.wait_step()), driver)
        self.assertEqual(job.status, "succeeded", job.failure)
        output = job.context["steps"]["wait"]
        self.assertEqual(output["value"], POPUP)
        self.assertEqual(output["polls"], 3)
        self.assertEqual(output["waited_s"], 0.4)
        self.assertEqual(driver.read_count, 3)
        self.assertEqual(driver.controls[0], "Current Version")
        self.assertEqual(clock.sleeps, [0.2, 0.2])

    def test_default_interval_is_200_ms(self):
        job, clock = self.run_flow(
            self.spec(self.wait_step(expect={"matches": r"^Current Version: "})),
            SequenceDriver(["", POPUP]))
        self.assertEqual(job.status, "succeeded")
        self.assertEqual(clock.sleeps, [0.2])

    def test_gui_unavailable_is_polled_not_failed(self):
        driver = SequenceDriver([
            gui_mod.GuiUnavailable("页面上找不到 'Current Version'"),
            POPUP,
        ])
        job, clock = self.run_flow(self.spec(self.wait_step()), driver)
        self.assertEqual(job.status, "succeeded", job.failure)
        self.assertEqual(job.context["steps"]["wait"]["polls"], 2)
        self.assertEqual(clock.sleeps, [0.2])
        self.assertIsInstance(driver.reads[0], str)  # 只剩成功值

    def test_matches_regex(self):
        job, _ = self.run_flow(
            self.spec(self.wait_step(
                expect={"contains": "Current Version",
                        "matches": r"Current Version: [0-9]+(\.[0-9]+)+"})),
            SequenceDriver([POPUP]))
        self.assertEqual(job.status, "succeeded")

    def test_driver_own_gui_unavailable_class_is_polled(self):
        """``cdp_driver.GuiUnavailable`` 不是本包那个类，但意思一样，不能被当致命错误。"""
        cdp_error = type("GuiUnavailable", (RuntimeError,), {})
        driver = SequenceDriver([cdp_error("页面上找不到 'Current Version'"), POPUP])
        job, clock = self.run_flow(self.spec(self.wait_step()), driver)
        self.assertEqual(job.status, "succeeded", job.failure)
        self.assertEqual(job.context["steps"]["wait"]["polls"], 2)
        self.assertEqual(clock.sleeps, [0.2])

    # ---------------------------------------------------------------- 超时
    def test_timeout_is_gate_timeout_and_keeps_evidence(self):
        job, clock = self.run_flow(
            self.spec(self.wait_step(timeout=1)),
            SequenceDriver(["还没出现"]))
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.failure["class"], "gate_timeout")
        self.assertEqual(job.failure["step"], "wait")
        self.assertEqual(job.failure["kind"], "wait_ui")
        self.assertIn("没有等到", job.failure["message"])
        evidence = job.failure["evidence"]
        self.assertEqual(evidence["timeout_s"], 1.0)
        self.assertEqual(evidence["last_value"], "还没出现")
        self.assertLessEqual(evidence["elapsed_s"], 1.0)
        # 总时长不得超过预算：时钟正好停在 1.0s，不是 1.2s
        self.assertEqual(clock.now, 1.0)
        self.assertEqual(evidence["polls"], sum(1 for _ in clock.sleeps) + 1)

    def test_default_timeout_is_ten_seconds(self):
        job, clock = self.run_flow(
            self.spec(self.wait_step()),
            SequenceDriver(["还没出现"]))
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.failure["class"], "gate_timeout")
        self.assertEqual(job.failure["evidence"]["timeout_s"], 10.0)
        self.assertEqual(clock.now, 10.0)

    def test_poll_slower_than_timeout_is_clamped(self):
        job, clock = self.run_flow(
            self.spec(self.wait_step(timeout=0.5, poll_ms=5000)),
            SequenceDriver(["还没出现"]))
        self.assertEqual(job.status, "failed")
        self.assertEqual(clock.now, 0.5)
        self.assertTrue(all(s <= 0.5 for s in clock.sleeps))

    def test_timeout_s_is_accepted_as_alias(self):
        job, clock = self.run_flow(
            self.spec(self.wait_step(timeout_s=0.4)),
            SequenceDriver(["还没出现"]))
        self.assertEqual(job.failure["evidence"]["timeout_s"], 0.4)
        self.assertEqual(clock.now, 0.4)

    # ------------------------------------------------------------ 消失模式
    def absent_step(self, **overrides) -> dict:
        step = {
            "id": "gone", "kind": "wait_ui",
            "control": "NovAtel Application Suite Update",
            "expect": {"absent": True},
        }
        step.update(overrides)
        return step

    def test_absent_matches_when_control_is_not_visible(self):
        driver = SequenceDriver([
            gui_mod.GuiUnavailable("页面上找不到 'NovAtel Application Suite Update'")])
        job, _ = self.run_flow(self.spec(self.absent_step()), driver)
        self.assertEqual(job.status, "succeeded", job.failure)
        output = job.context["steps"]["gone"]
        self.assertIsNone(output["value"])
        self.assertEqual(output["polls"], 1)

    def test_absent_polls_while_still_visible_then_passes(self):
        driver = SequenceDriver([
            "NovAtel Application Suite Update Close",
            gui_mod.GuiUnavailable("页面上找不到 'NovAtel Application Suite Update'"),
        ])
        job, clock = self.run_flow(self.spec(self.absent_step(timeout=2)), driver)
        self.assertEqual(job.status, "succeeded", job.failure)
        self.assertEqual(job.context["steps"]["gone"]["polls"], 2)
        self.assertEqual(clock.sleeps, [0.2])

    def test_absent_timeout_reports_gate_timeout(self):
        job, _ = self.run_flow(self.spec(self.absent_step(timeout=0.5)),
                               SequenceDriver(["还挂在屏上"]))
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.failure["class"], "gate_timeout")
        self.assertIn("没有等到", job.failure["message"])
        self.assertIn("消失", job.failure["message"])

    def test_absent_with_dead_cdp_is_environment_not_success(self):
        """驱动都连不上时「读不到」不能算「控件不在了」，否则会秒过。"""
        driver = SequenceDriver([
            gui_mod.GuiUnavailable("套件没有开 CDP（127.0.0.1:9223）：refused")])
        job, _ = self.run_flow(self.spec(self.absent_step()), driver)
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.failure["class"], "environment")

    # ------------------------------------------------------------ 没有驱动
    def test_no_driver_becomes_operator_task(self):
        spec = self.spec(self.wait_step())
        job, _ = self.run_flow(spec, gui_mod.AssistedDriver())
        self.assertEqual(job.status, "waiting_operator")
        self.assertEqual(job.pending_gate["kind"], "operator")
        self.assertIn("Current Version", job.pending_gate["prompt"])

    def test_no_driver_with_assisted_disabled_fails_capability(self):
        spec = self.spec(self.wait_step(assisted={"enabled": False}))
        job, _ = self.run_flow(spec, gui_mod.AssistedDriver())
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.failure["class"], "capability")


class WaitUiSpec(unittest.TestCase):
    def build(self, step: dict):
        return spec_mod.build_spec({
            "id": "demo.flow", "version": 1, "title": "demo", "intent": "demo.run",
            "steps": [step],
        }, source="memory")

    def test_expect_is_required(self):
        with self.assertRaises(spec_mod.WorkflowSpecError) as ctx:
            self.build({"id": "wait", "kind": "wait_ui", "control": "X"})
        self.assertIn("expect", str(ctx.exception))

    def test_empty_expect_rejected(self):
        with self.assertRaises(spec_mod.WorkflowSpecError):
            self.build({"id": "wait", "kind": "wait_ui", "control": "X", "expect": {}})

    def test_unknown_operator_rejected(self):
        with self.assertRaises(spec_mod.WorkflowSpecError) as ctx:
            self.build({"id": "wait", "kind": "wait_ui", "control": "X",
                        "expect": {"starts_with": "Current"}})
        self.assertIn("contains", str(ctx.exception))

    def test_control_is_required(self):
        with self.assertRaises(spec_mod.WorkflowSpecError):
            self.build({"id": "wait", "kind": "wait_ui",
                        "expect": {"contains": "x"}})

    def test_timeout_and_timeout_s_conflict(self):
        with self.assertRaises(spec_mod.WorkflowSpecError) as ctx:
            self.build({"id": "wait", "kind": "wait_ui", "control": "X",
                        "expect": {"contains": "x"}, "timeout": 5, "timeout_s": 5})
        self.assertIn("timeout_s", str(ctx.exception))

    def test_non_positive_poll_ms_rejected(self):
        with self.assertRaises(spec_mod.WorkflowSpecError):
            self.build({"id": "wait", "kind": "wait_ui", "control": "X",
                        "expect": {"contains": "x"}, "poll_ms": -5})

    def test_absent_accepted(self):
        wf = self.build({"id": "wait", "kind": "wait_ui", "control": "X",
                         "expect": {"absent": True}})
        self.assertEqual(wf.steps[0]["expect"], {"absent": True})

    def test_absent_false_rejected(self):
        with self.assertRaises(spec_mod.WorkflowSpecError) as ctx:
            self.build({"id": "wait", "kind": "wait_ui", "control": "X",
                        "expect": {"absent": False}})
        self.assertIn("absent", str(ctx.exception))

    def test_absent_cannot_mix_with_contains(self):
        with self.assertRaises(spec_mod.WorkflowSpecError) as ctx:
            self.build({"id": "wait", "kind": "wait_ui", "control": "X",
                        "expect": {"absent": True, "contains": "x"}})
        self.assertIn("absent", str(ctx.exception))


class OptionalClick(unittest.TestCase):
    """``click_optional``：有就点、没有就算；普通 ``click`` 仍然必须失败可见。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = JobStore(Path(self.tmp.name) / "jobs")

    def run_flow(self, steps, driver):
        spec = spec_mod.build_spec({
            "id": "demo.flow", "version": 1, "title": "demo", "intent": "demo.run",
            "steps": steps,
        }, source="memory")
        job, _ = self.store.create(spec, {}, engine="fake", driver="fake")
        runner = WorkflowRunner(self.store, _DummyEngine(), driver,
                                sleep=lambda _s: None, clock=StepClock())
        return runner.run(job, spec)

    def _driver(self):
        from tools.click_engine import ClickError

        class MissingTarget(gui_mod.ScriptedDriver):
            def click(self, locator: str) -> None:
                raise ClickError(f"找不到目标 {locator!r}（当前页 0 个可点目标）")
        return MissingTarget()

    def test_optional_click_skips_missing_target(self):
        job = self.run_flow([
            {"id": "dismiss", "kind": "gui", "action": "click_optional",
             "locator": "Close"},
            {"id": "record", "kind": "artifact", "name": "x.json", "content": {"ok": True}},
        ], self._driver())
        self.assertEqual(job.status, "succeeded", job.failure)
        done = job.context["steps"]["dismiss"]["actions"][0]
        self.assertFalse(done["clicked"])
        self.assertIn("找不到目标", done["why"])

    def test_plain_click_on_missing_target_still_fails(self):
        job = self.run_flow([
            {"id": "dismiss", "kind": "gui", "action": "click", "locator": "Close"},
        ], self._driver())
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.failure["class"], "selector_drift")


if __name__ == "__main__":
    unittest.main()
