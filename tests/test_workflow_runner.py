#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""执行器：状态机、闸门、失败分类、不重试、证据落盘。

这里全部用假引擎与假时钟，不碰网络、不碰真实接收机。**唯一**的集成点是仓库里
真实存在的 ``script.device.restart.yaml``：它证明模板、游标、重连这些串起来是通的。
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fieldstation.workflows import engine as engine_mod
from fieldstation.workflows import gui as gui_mod
from fieldstation.workflows import spec as spec_mod
from fieldstation.workflows.runner import JobBusy, WorkflowRunner
from fieldstation.workflows.service import WorkflowService
from fieldstation.workflows.store import JobStore

ROOT = Path(__file__).resolve().parents[1]


# --------------------------------------------------------------------------- 假件
class FakeResponse:
    def __init__(self, status=200, body=b"{}", headers=None):
        self.status = status
        self.body = body
        self.headers = headers or {}

    def json(self):
        return json.loads(self.body.decode("utf-8"))


class FakeEngine:
    """按脚本回答的引擎。``http`` 是 ``(method, path) -> FakeResponse`` 的表。"""

    base_url = "http://fake"

    def __init__(self, http=None, statuses=None, logs=None, connect=None):
        self.http = http or {}
        self.statuses = list(statuses or [])
        self.logs = logs or {"cursor": 0, "entries": []}
        self.connect_body = connect
        self.calls: list[tuple] = []
        self.commands: list[dict] = []
        self.connected = bool(statuses and statuses[0])

    def _status(self):
        if self.statuses:
            value = self.statuses.pop(0) if len(self.statuses) > 1 else self.statuses[0]
        else:
            value = self.connected
        self.connected = bool(value)
        return {
            "ok": True,
            "connected": self.connected,
            "target": "tcp://127.0.0.1:3001" if self.connected else "tcp://127.0.0.1:3001",
            "connectedAt": "2026-11-03T00:00:00Z",
            "commands": self.commands,
        }

    def request(self, method, path, *, query=None, json_body=None, timeout=None):
        self.calls.append((method, path, dict(query or {})))
        handler = self.http.get((method, path))
        for handler in (self.http.get((method, path)),):
            if isinstance(handler, BaseException):
                raise handler
        if handler is None:
            raise AssertionError(f"FakeEngine 没有为 {method} {path} 配回答")
        if callable(handler):
            return handler(query, json_body)
        return handler

    def download(self, path, query=None, timeout=None):
        self.calls.append(("DOWNLOAD", path, dict(query or {})))
        handler = self.http.get(("DOWNLOAD", path))
        if isinstance(handler, BaseException):
            raise handler
        if handler is None:
            raise AssertionError(f"FakeEngine 没有为 DOWNLOAD {path} 配回答")
        return handler

    def live_status(self):
        self.calls.append(("live_status",))
        return self._status()

    def live_logs(self, after=0, limit=0):
        self.calls.append(("live_logs", after, limit))
        return self.logs

    def live_connect(self, body):
        self.calls.append(("live_connect", dict(body)))
        if self.connect_body:
            return self.connect_body
        return {"ok": True, "connected": True, "target": "tcp://127.0.0.1:3001"}

    def live_command(self, line):
        self.calls.append(("live_command", line))
        entry = {"id": len(self.commands) + 1, "line": line, "ok": True,
                 "status": "ok", "reply": "<OK", "elapsedMs": 3}
        self.commands.append(entry)
        return {"ok": True, "connected": True, "target": "tcp://127.0.0.1:3001",
                "commands": list(self.commands)}


class FakeClock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        self.t += 0.5
        return self.t


def _version_entry(seq=7, model="OEM729", software="7.10.2"):
    return {
        "seq": seq,
        "messageId": 37,
        "name": "VERSION",
        "ascii": f"#VERSIONA,{model},{software}",
        "data": {"kind": "version", "model": model,
                 "hardwareVersion": "HW1", "softwareVersion": software},
    }


class Harness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.store = JobStore(self.root / "jobs")
        # 流程里现在带头部步骤 `ensure_display`（计划书 §3.6：几何固化第三层）。
        # 它读的是**虚拟屏**的模式，而 CI 上既没有虚拟屏、物理屏尺寸也各不相同。
        # 测试验证的是流程逻辑，不是「这台机器有没有虚拟屏」，所以固定一个已知模式：
        # `FSA_SCREEN_MODE` 是 runner 显式提供的测试/无人值守覆盖口，
        # 优先级高于 EnumDisplaySettings（见 runner._screen_mode 的文档）。
        # 用 patch.dict 而不是直接赋值，避免污染同一进程里的其它测试。
        patcher = mock.patch.dict(os.environ, {"FSA_SCREEN_MODE": "1920x1080@60"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def spec(self, **overrides):
        data = {
            "id": "demo.flow",
            "version": 1,
            "title": "demo",
            "intent": "demo.run",
            "steps": [{"id": "one", "kind": "sleep", "seconds": 1}],
        }
        data.update(overrides)
        return spec_mod.build_spec(data, source="memory")

    def runner(self, engine=None, driver=None):
        return WorkflowRunner(
            self.store,
            engine or FakeEngine(),
            driver or gui_mod.AssistedDriver(),
            sleep=lambda _s: None,
            clock=FakeClock(),
        )

    def start(self, spec, params=None, **runner_kwargs):
        job, _ = self.store.create(spec, params or {}, engine="fake", driver="fake")
        return self.runner(**runner_kwargs).run(job, spec)


# --------------------------------------------------------------------------- 成功路径
class SuccessPath(Harness):
    def test_http_then_artifact_succeeds(self):
        engine = FakeEngine(http={("GET", "/api/health"): FakeResponse(
            body=b'{"ok": true, "version": "1"}')})
        spec = self.spec(steps=[
            {"id": "health", "kind": "http", "path": "/api/health",
             "expect": {"json": {"ok": True}}},
            {"id": "record", "kind": "artifact", "name": "out.json",
             "content": {"ok": "${steps.health.body.ok}"}},
        ])
        job = self.start(spec, engine=engine)
        self.assertEqual(job.status, "succeeded")
        self.assertIsNone(job.failure)
        data = json.loads((self.store.artifacts_dir(job.job_id) / "out.json").read_text(
            encoding="utf-8"))
        self.assertTrue(data["ok"])
        self.assertTrue((self.store.artifacts_dir(job.job_id) / "context.json").is_file())
        tail = self.store.audit_tail(job.job_id, limit=50)
        self.assertIn("job.succeeded", [r["event"] for r in tail])

    def test_expect_mismatch_fails_execution(self):
        engine = FakeEngine(http={("GET", "/api/x"): FakeResponse(
            body=b'{"ok": false}')})
        spec = self.spec(steps=[{"id": "x", "kind": "http", "path": "/api/x",
                                 "expect": {"json": {"ok": True}}}])
        job = self.start(spec, engine=engine)
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.failure["class"], "execution")


# --------------------------------------------------------------------------- 失败分类
class FailureClasses(Harness):
    def _run_http(self, exc):
        engine = FakeEngine(http={("GET", "/api/x"): exc})
        spec = self.spec(steps=[{"id": "x", "kind": "http", "path": "/api/x"}])
        return self.start(spec, engine=engine)

    def test_environment_when_engine_unreachable(self):
        job = self._run_http(engine_mod.EngineUnavailable("refused"))
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.failure["class"], "environment")

    def test_input_on_409(self):
        job = self._run_http(engine_mod.EngineHttpError(409, "conflict", body=b"nope"))
        self.assertEqual(job.failure["class"], "input")

    def test_artifact_on_404(self):
        job = self._run_http(engine_mod.EngineHttpError(404, "missing", body=b"nope"))
        self.assertEqual(job.failure["class"], "artifact")

    def test_capability_on_403(self):
        job = self._run_http(engine_mod.EngineHttpError(403, "denied", body=b"nope"))
        self.assertEqual(job.failure["class"], "capability")

    def test_failure_artifact_written(self):
        job = self._run_http(engine_mod.EngineHttpError(500, "boom", body=b"boom"))
        self.assertEqual(job.status, "failed")
        failure = json.loads(
            (self.store.artifacts_dir(job.job_id) / "failure.json").read_text(encoding="utf-8"))
        self.assertEqual(failure["failure"]["class"], "execution")
        self.assertEqual(failure["failure"]["step"], "x")


class NoRetry(Harness):
    def test_failed_step_is_not_retried(self):
        engine = FakeEngine(http={("GET", "/api/x"): engine_mod.EngineHttpError(
            500, "boom", body=b"boom")})
        spec = self.spec(steps=[{"id": "x", "kind": "http", "path": "/api/x"}])
        job = self.start(spec, engine=engine)
        self.assertEqual(job.status, "failed")
        self.assertEqual(sum(1 for c in engine.calls if c[0] == "GET"), 1)
        # 失败之后再 resume 没有闸门，必须拒绝
        with self.assertRaises(ValueError):
            self.runner(engine=engine).resume(job, spec, "done")

    def test_on_fail_continue_records_warning_and_keeps_going(self):
        engine = FakeEngine(http={("GET", "/api/x"): engine_mod.EngineHttpError(
            500, "boom", body=b"boom"),
            ("GET", "/api/y"): FakeResponse(body=b'{"ok": true}')})
        spec = self.spec(steps=[
            {"id": "x", "kind": "http", "path": "/api/x", "on_fail": "continue"},
            {"id": "y", "kind": "http", "path": "/api/y",
             "expect": {"json": {"ok": True}}},
        ])
        job = self.start(spec, engine=engine)
        self.assertEqual(job.status, "succeeded")
        self.assertEqual(len(job.warnings), 1)
        self.assertEqual(job.warnings[0]["class"], "execution")


# --------------------------------------------------------------------------- 闸门
class Gates(Harness):
    def _spec_with_gate(self, **overrides):
        return self.spec(
            steps=[
                {"id": "first", "kind": "http", "path": "/api/one"},
                {"id": "gate", "kind": "human_gate", "reason": "不可逆",
                 "risk": "high"},
                {"id": "second", "kind": "http", "path": "/api/two"},
            ],
            **overrides)

    def _engine(self):
        return FakeEngine(http={
            ("GET", "/api/one"): FakeResponse(body=b'{"ok": true}'),
            ("GET", "/api/two"): FakeResponse(body=b'{"ok": true}'),
        })

    def test_gate_blocks_before_later_steps(self):
        engine = self._engine()
        spec = self._spec_with_gate()
        job = self.start(spec, engine=engine)
        self.assertEqual(job.status, "waiting_approval")
        self.assertEqual(job.pending_gate["step"], "gate")
        self.assertEqual(job.step_index, 1)
        self.assertNotIn(("GET", "/api/two", {}), engine.calls)

    def test_approve_continues_and_skips_gate(self):
        engine = self._engine()
        spec = self._spec_with_gate()
        job = self.start(spec, engine=engine)
        job = self.runner(engine=engine).resume(job, spec, "approved", by="sunch")
        self.assertEqual(job.status, "succeeded")
        self.assertIn(("GET", "/api/two", {}), engine.calls)
        self.assertEqual(job.gates[0]["decision"], "approved")
        self.assertEqual(job.gates[0]["by"], "sunch")

    def test_reject_cancels_and_runs_nothing_after(self):
        engine = self._engine()
        spec = self._spec_with_gate()
        job = self.start(spec, engine=engine)
        job = self.runner(engine=engine).resume(job, spec, "rejected", note="no")
        self.assertEqual(job.status, "cancelled")
        self.assertEqual(job.cancel_reason, "no")
        self.assertNotIn(("GET", "/api/two", {}), engine.calls)

    def test_workflow_level_approval_does_not_advance_step_index(self):
        engine = FakeEngine(http={("GET", "/api/one"): FakeResponse(body=b'{"ok": true}')})
        spec = self.spec(
            approval={"required": True, "risk": "high", "reason": "会中断观测"},
            steps=[{"id": "one", "kind": "http", "path": "/api/one"}])
        job = self.start(spec, engine=engine)
        self.assertEqual(job.status, "waiting_approval")
        self.assertEqual(job.pending_gate["step"], "(workflow)")
        self.assertEqual(job.step_index, 0)
        self.assertEqual(engine.calls, [])
        job = self.runner(engine=engine).resume(job, spec, "approved")
        self.assertEqual(job.status, "succeeded")
        self.assertEqual(job.step_index, 1)

    def test_unknown_decision_rejected(self):
        spec = self._spec_with_gate()
        job = self.start(spec, engine=self._engine())
        with self.assertRaises(ValueError):
            self.runner().resume(job, spec, "maybe")


# --------------------------------------------------------------------------- GUI
class GuiSteps(Harness):
    def test_no_driver_becomes_operator_task(self):
        spec = self.spec(steps=[
            {"id": "click", "kind": "gui", "action": "click", "locator": "Apply"}])
        job = self.start(spec)
        self.assertEqual(job.status, "waiting_operator")
        self.assertEqual(job.pending_gate["kind"], "operator")
        self.assertIn("Apply", job.pending_gate["prompt"])
        job = self.runner().resume(job, spec, "done")
        self.assertEqual(job.status, "succeeded")

    def test_assisted_disabled_turns_into_capability_failure(self):
        spec = self.spec(steps=[
            {"id": "click", "kind": "gui", "action": "click", "locator": "Apply",
             "assisted": {"enabled": False}}])
        job = self.start(spec)
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.failure["class"], "capability")

    def test_scripted_driver_performs_actions(self):
        driver = gui_mod.ScriptedDriver()
        spec = self.spec(steps=[
            {"id": "prep", "kind": "gui", "actions": [
                {"action": "open", "page": "manage"},
                {"action": "type", "locator": "Firmware file", "value": "/tmp/fw.bin"},
            ], "screenshot": True}])
        job = self.start(spec, driver=driver)
        self.assertEqual(job.status, "succeeded")
        self.assertEqual([a["action"] for a in driver.actions],
                         ["open", "type", "screenshot"])
        self.assertTrue(any(a["name"].endswith(".png") for a in job.artifacts))

    def test_verify_ui_reads_control(self):
        driver = gui_mod.ScriptedDriver(reads={"Device > Model": "OEM729"})
        spec = self.spec(steps=[
            {"id": "check", "kind": "verify_ui", "control": "Device > Model",
             "expect": {"equals": "OEM729"}}])
        job = self.start(spec, driver=driver)
        self.assertEqual(job.status, "succeeded")
        self.assertEqual(job.context["steps"]["check"]["value"], "OEM729")

    def test_verify_ui_mismatch_fails(self):
        driver = gui_mod.ScriptedDriver(reads={"Device > Model": "OEM719"})
        spec = self.spec(steps=[
            {"id": "check", "kind": "verify_ui", "control": "Device > Model",
             "expect": {"equals": "OEM729"}}])
        job = self.start(spec, driver=driver)
        self.assertEqual(job.status, "failed")
        self.assertEqual(job.failure["class"], "execution")
        self.assertIn("mismatches", job.failure["evidence"])


# --------------------------------------------------------------------------- 真实规格
class ShippedRestartWorkflow(Harness):
    """用真实规格 + 假引擎，验证模板、游标、断线重连确实串得起来。"""

    def _service(self, engine, driver=None):
        workflows_dir = ROOT / "workflows"
        service = WorkflowService(
            root=ROOT,
            workflows_dir=workflows_dir,
            jobs_root=self.root / "jobs",
            driver_instance=driver or gui_mod.AssistedDriver(),
            store=self.store,
        )
        service.engine = engine
        service.runner = WorkflowRunner(self.store, engine,
                                        driver or gui_mod.AssistedDriver(),
                                        sleep=lambda _s: None, clock=FakeClock())
        return service

    def test_restart_waits_for_approval_then_reconnects(self):
        engine = FakeEngine(
            http={("GET", "/api/health"): FakeResponse(
                body=b'{"ok": true, "version": "test"}')},
            statuses=[True, True, False, True],
            logs={"cursor": 7, "entries": [_version_entry()]},
        )
        service = self._service(engine)
        view = service.run_workflow("script.device.restart", {
            "target": "tcp://127.0.0.1:3001",
            "expect_model": "OEM729",
            "poll_s": 0.1,
            "drop_grace_s": 10,
            "return_timeout_s": 20,
        })
        self.assertEqual(view["status"], "waiting_approval")
        self.assertEqual(view["gate"]["step"], "(workflow)")

        view = service.human_gate(view["job_id"], "approved", by="sunch",
                                  note="现场确认")
        self.assertEqual(view["status"], "succeeded", json.dumps(
            view.get("failure"), ensure_ascii=False))
        after = view["audit_tail"]
        self.assertIn("receiver.reconnected", [r["event"] for r in after] +
                      [r["event"] for r in self.store.audit_tail(view["job_id"], 50)])
        names = [a["name"] for a in service.artifacts(view["job_id"])]
        self.assertIn("restart.json", names)
        record = json.loads(service.read_artifact(view["job_id"], "restart.json"))
        self.assertEqual(record["after"]["model"], "OEM729")
        self.assertTrue(record["after"]["saw_drop"])

    def test_restart_without_target_and_link_down_is_input_error(self):
        engine = FakeEngine(
            http={("GET", "/api/health"): FakeResponse(
                body=b'{"ok": true, "version": "test"}')},
            statuses=[False],
        )
        service = self._service(engine)
        view = service.run_workflow("script.device.restart", {})
        # 工作流级审批先挡住；批准后才轮到 ensure_live 报缺 target
        view = service.human_gate(view["job_id"], "approved")
        self.assertEqual(view["status"], "failed")
        self.assertEqual(view["failure"]["class"], "input")
        self.assertIn("target", view["failure"]["message"])


# --------------------------------------------------------------------------- 锁与服务
class LocksAndIdempotency(Harness):
    def _service(self, engine, driver=None, workflows_dir=None):
        service = WorkflowService(
            root=ROOT,
            workflows_dir=Path(workflows_dir) if workflows_dir else ROOT / "workflows",
            jobs_root=self.root / "jobs",
            driver_instance=driver or gui_mod.AssistedDriver(),
            store=self.store,
        )
        service.engine = engine
        service.runner = WorkflowRunner(self.store, engine,
                                        driver or gui_mod.AssistedDriver(),
                                        sleep=lambda _s: None, clock=FakeClock())
        return service

    def _gui_flow_dir(self) -> Path:
        """一条只有 GUI 步骤的临时流程：没有驱动时必然停在 waiting_operator。"""
        base = self.root / "flows"
        base.mkdir(exist_ok=True)
        (base / "demo.gui.yaml").write_text(
            "id: demo.gui\n"
            "version: 1\n"
            "title: demo gui\n"
            "intent: demo.run\n"
            "steps:\n"
            "  - id: click\n"
            "    kind: gui\n"
            "    action: click\n"
            "    locator: Apply\n",
            encoding="utf-8")
        return base

    def test_single_flight_blocks_second_run_of_same_workflow(self):
        engine = FakeEngine()
        service = self._service(engine, workflows_dir=self._gui_flow_dir())
        first = service.run_workflow("demo.gui", {})
        self.assertEqual(first["status"], "waiting_operator")
        with self.assertRaises(JobBusy):
            service.run_workflow("demo.gui", {})

    def test_idempotency_key_reuses_finished_job(self):
        engine = FakeEngine(http={
            ("GET", "/api/health"): FakeResponse(
                body=b'{"ok": true, "version": "test"}'),
            ("GET", "/api/graph/projects"): FakeResponse(
                body=b'{"ok": true, "count": 1, "projects": []}'),
            ("GET", "/api/graph/files"): FakeResponse(
                body=b'{"ok": true, "count": 1, "files": []}'),
            ("DOWNLOAD", "/api/graph/pdf"): FakeResponse(
                status=200, body=b"%PDF-1.4 " + b"x" * 1200, headers={
                    "X-PDF-Pages": "2", "X-PDF-Charts": "1", "X-PDF-Bytes": "12"}),
        })
        service = self._service(engine)
        first = service.run_workflow("gui.graph.export", {},
                                     idempotency_key="graph-export-1")
        self.assertEqual(first["status"], "succeeded")
        second = service.run_workflow("gui.graph.export", {},
                                      idempotency_key="graph-export-1")
        self.assertEqual(first["job_id"], second["job_id"])
        self.assertEqual(sum(1 for c in engine.calls if c[0] == "DOWNLOAD"), 1)

    def test_cancel_clears_pending_gate(self):
        service = self._service(FakeEngine(), workflows_dir=self._gui_flow_dir())
        view = service.run_workflow("demo.gui", {})
        view = service.cancel(view["job_id"], "wrong receiver")
        self.assertEqual(view["status"], "cancelled")
        self.assertIsNone(view["gate"])


if __name__ == "__main__":
    unittest.main()
