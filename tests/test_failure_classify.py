#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""八类失败分类：每类至少一例，外加「不认识 → execution」。

这里的例子全部是**构造出来的异常/消息**，不连引擎、不连套件、不碰设备：

* 分类器只在消息里找「谁该动」的线索，所以测试要钉的是**判定顺序**——
  比如「CDP 端口不存在」必须是 `environment` 而不是 `hardware_missing`，
  「点了没反应」必须是 `execution` 而不是 `selector_drift`。
* 另外两条接线测试：驱动异常经执行器后真的落到 `job.failure["class"]`，
  并且 `message` / `step` 都还在。
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fieldstation.workflows import gui as gui_mod
from fieldstation.workflows import spec as spec_mod
from fieldstation.workflows.engine import EngineUnavailable
from fieldstation.workflows.errors import (
    ApprovalRejected,
    GateTimeout,
    PolicyViolation,
    classify_failure,
)
from fieldstation.workflows.runner import WorkflowRunner
from fieldstation.workflows.store import JobStore
from tools.click_engine import ClickError, ClickNoEffect


class FailureTaxonomy(unittest.TestCase):
    def test_the_eight_classes_are_fixed(self):
        self.assertEqual(len(spec_mod.FAILURE_CLASSES), 8)
        self.assertEqual(set(spec_mod.FAILURE_CLASSES), {
            "environment", "input", "execution", "policy",
            "selector_drift", "dialog_unavailable", "gate_timeout",
            "hardware_missing",
        })

    def check(self, exc, expected: str, **kwargs) -> None:
        got = classify_failure(exc, **kwargs)
        self.assertEqual(got, expected, f"{exc!r} → {got}，期望 {expected}")
        self.assertIn(got, spec_mod.FAILURE_CLASSES)

    # ---------------------------------------------------------------- 1 环境
    def test_environment_suite_not_running(self):
        self.check(gui_mod.GuiUnavailable(
            "套件没有开 CDP（127.0.0.1:9223）：[WinError 10061] 目标计算机积极拒绝"),
            "environment")

    def test_environment_no_gui_driver(self):
        self.check(gui_mod.GuiUnavailable(
            "没有 GUI 驱动，不能读取控件 'Current Version'。"), "environment")

    def test_environment_engine_unreachable(self):
        self.check(EngineUnavailable("连不上 http://127.0.0.1:7803/api/health：refused"),
                   "environment")

    def test_cdp_port_is_environment_not_hardware(self):
        """「CDP 端口不存在」说的是计算机这一侧，不能被算成没插设备。"""
        self.check(RuntimeError("CDP 端口 9223 不存在，套件可能没起来"), "environment")

    # ---------------------------------------------------------------- 2 参数
    def test_input_spec_error(self):
        self.check(spec_mod.WorkflowSpecError(
            "gui.device.update 参数", ["缺少必填参数 firmware"]), "input")

    def test_input_non_numeric(self):
        self.check(ValueError("步骤 wait 的 timeout 不是数值：'abc' → 'abc'"), "input")

    # ---------------------------------------------------------------- 3 执行
    def test_execution_click_had_no_effect(self):
        self.check(ClickNoEffect("点了 'Apply' 但没有预期效果（expect={'changed': True}）"),
                   "execution")

    def test_unknown_exception_falls_back_to_execution(self):
        """兜底：不认识的异常不乱指方向。"""
        self.check(RuntimeError("something odd happened"), "execution")
        self.check(None, "execution", message="完全看不懂的一句话")

    # ---------------------------------------------------------------- 4 策略
    def test_policy_approval_rejected(self):
        self.check(ApprovalRejected("审批被拒绝：rejected（note=现场不同意）"), "policy")
        self.check(PolicyViolation("审批门未通过，拒绝执行 Apply"), "policy")

    def test_policy_danger_word_blocked(self):
        self.check(ClickError(
            "目标 'Add application' 命中危险词，必须先过闸门（allow_danger=True 仅由审批流使用）"),
            "policy")

    # ------------------------------------------------------ 5 选择器漂移
    def test_selector_target_missing(self):
        self.check(ClickError("找不到目标 'Check For Updates'（当前页 48 个可点目标）"),
                   "selector_drift")

    def test_selector_target_not_unique(self):
        self.check(ClickError("目标 'Select' 不唯一：['Select', 'Select']"),
                   "selector_drift")

    def test_selector_coordinate_drift(self):
        self.check(ClickError("坐标漂移：(1024,517) 处期望 {'tag': 'button'}，实际 {'tag': 'div'}"),
                   "selector_drift")

    def test_selector_gui_control_missing(self):
        self.check(gui_mod.GuiUnavailable("页面上找不到 'Device > Model'"), "selector_drift")

    # ------------------------------------------------------ 6 对话框不在
    def test_dialog_popup_missing(self):
        self.check(gui_mod.GuiUnavailable("页面上找不到 Add application 弹窗"), "dialog_unavailable")

    def test_dialog_update_window_missing(self):
        self.check(gui_mod.GuiUnavailable("更新对话框没有出现（点完 Check 后 3 秒内没画出来）"),
                   "dialog_unavailable")

    # ------------------------------------------------------ 7 等待超时
    def test_gate_timeout_from_wait_ui(self):
        self.check(GateTimeout(
            "10s 内没有等到 'Current Version' 满足 {'contains': 'Current Version'}"),
            "gate_timeout")

    def test_gate_timeout_socket_timeout_while_waiting(self):
        import socket
        self.check(socket.timeout("timed out"), "gate_timeout", step_kind="wait_ui")

    def test_gate_timeout_from_receiver_wait(self):
        self.check(RuntimeError("60s 内没有等到匹配的 VERSION（model='OEM729'）"),
                   "gate_timeout", step_kind="await_receiver")

    def test_plain_timeout_is_environment_not_gate(self):
        """同一句「超时」，在连接步骤里是环境问题，在等待步骤里才是闸门超时。"""
        import socket
        self.check(socket.timeout("timed out"), "environment", step_kind="http")

    # ------------------------------------------------------ 8 没有设备
    def test_hardware_serial_port_missing(self):
        self.check(RuntimeError("串口 COM8 不存在：设备未找到"), "hardware_missing")

    def test_hardware_receiver_not_connected(self):
        self.check(RuntimeError("链路未连接，读不到接收机的记录"), "hardware_missing")

    def test_hardware_receiver_did_not_come_back(self):
        self.check(RuntimeError("接收机在 60s 内没有回到链路（target='COM8@115200'）"),
                   "hardware_missing")


# --------------------------------------------------------------------------- 接线
class _DummyEngine:
    base_url = "http://fake"


class _RaiseDriver:
    """读到指定消息就抛 ``GuiUnavailable``；其余动作记账。"""

    name = "cdp"
    available = True

    def __init__(self, message: str) -> None:
        self.message = message
        self.actions: list[dict] = []

    def open(self, page: str) -> None:
        self.actions.append({"open": page})

    def read(self, control: str) -> str:
        self.actions.append({"read": control})
        raise gui_mod.GuiUnavailable(self.message)

    def click(self, locator: str) -> None:
        self.actions.append({"click": locator})
        raise gui_mod.GuiUnavailable(self.message)

    def type_text(self, locator: str, text: str) -> None:
        self.actions.append({"type": locator})

    def select(self, locator: str, option: str) -> None:
        self.actions.append({"select": locator})

    def screenshot(self, path: Path) -> str | None:
        return None


class ClassificationReachesJobRecord(unittest.TestCase):
    """分类必须出现在 ``job.failure["class"]`` 上，而不是只活在异常里。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = JobStore(Path(self.tmp.name) / "jobs")

    def _run(self, steps, driver):
        spec = spec_mod.build_spec({
            "id": "demo.flow", "version": 1, "title": "demo", "intent": "demo.run",
            "steps": steps,
        }, source="memory")
        job, _ = self.store.create(spec, {}, engine="fake", driver="fake")
        runner = WorkflowRunner(self.store, _DummyEngine(), driver,
                                sleep=lambda _s: None)
        return runner.run(job, spec)

    def test_missing_control_is_selector_drift(self):
        job = self._run(
            [{"id": "check", "kind": "verify_ui", "control": "Device > Model",
              "expect": {"equals": "OEM729"}, "assisted": {"enabled": False}}],
            _RaiseDriver("页面上找不到 'Device > Model'"))
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.failure["class"], "selector_drift")
        self.assertEqual(job.failure["step"], "check")
        self.assertIn("找不到", job.failure["message"])
        self.assertEqual(job.failure["kind"], "verify_ui")

    def test_missing_dialog_is_dialog_unavailable(self):
        job = self._run(
            [{"id": "close", "kind": "gui", "action": "click", "locator": "Close",
              "assisted": {"enabled": False}}],
            _RaiseDriver("页面上找不到 Close 弹窗"))
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.failure["class"], "dialog_unavailable")
        self.assertEqual(job.failure["step"], "close")

    def test_failure_artifact_keeps_message_and_step(self):
        job = self._run(
            [{"id": "check", "kind": "verify_ui", "control": "Device > Model",
              "expect": {"equals": "OEM729"}, "assisted": {"enabled": False}}],
            _RaiseDriver("页面上找不到 'Device > Model'"))
        record = json.loads(
            (self.store.artifacts_dir(job.job_id) / "failure.json")
            .read_text(encoding="utf-8"))
        self.assertEqual(record["failure"]["class"], "selector_drift")
        self.assertEqual(record["failure"]["step"], "check")
        self.assertEqual(record["failure"]["message"], "页面上找不到 'Device > Model'")


if __name__ == "__main__":
    unittest.main()
