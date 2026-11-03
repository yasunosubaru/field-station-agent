#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""规格校验：认不出的字段、缺审批的 RESET、能写到目录外的产物名，都在加载时挡住。

三条不变量值得单独强调：

1. ``RESET`` / ``FRESET`` 所在流程必须有 ``approval.required: true``；
2. 产物名只能裸文件名；
3. ``on_fail`` 没有 ``retry`` —— 不可逆动作不自动重试。
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fieldstation.workflows import spec

ROOT = Path(__file__).resolve().parents[1]


def _minimal(**overrides):
    data = {
        "id": "demo.test",
        "version": 1,
        "title": "demo",
        "intent": "demo.run",
        "steps": [{"id": "one", "kind": "sleep", "seconds": 1}],
    }
    data.update(overrides)
    return data


class BuildSpec(unittest.TestCase):
    def test_minimal_is_valid(self):
        wf = spec.build_spec(_minimal())
        self.assertEqual(wf.id, "demo.test")
        self.assertEqual(wf.step_count, 1)
        self.assertEqual(wf.risk, "low")

    def test_unknown_top_level_field_rejected(self):
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.build_spec(_minimal(stepz=[]))
        self.assertTrue(any("未知的顶层字段" in e for e in ctx.exception.errors))

    def test_unknown_step_field_rejected(self):
        data = _minimal(steps=[{"id": "one", "kind": "sleep", "seconds": 1, "retry": 3}])
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.build_spec(data)
        self.assertTrue(any("retry" in e for e in ctx.exception.errors))

    def test_unknown_step_kind_rejected(self):
        data = _minimal(steps=[{"id": "one", "kind": "teleport"}])
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.build_spec(data)
        self.assertTrue(any("kind" in e for e in ctx.exception.errors))

    def test_all_errors_reported_at_once(self):
        data = _minimal(version=0, risk="extreme")
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.build_spec(data)
        self.assertGreaterEqual(len(ctx.exception.errors), 2)

    def test_duplicate_step_id_rejected(self):
        data = _minimal(steps=[
            {"id": "one", "kind": "sleep", "seconds": 1},
            {"id": "one", "kind": "sleep", "seconds": 1},
        ])
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.build_spec(data)
        self.assertTrue(any("重复" in e for e in ctx.exception.errors))


class SafetyInvariants(unittest.TestCase):
    def test_reset_without_approval_is_refused(self):
        data = _minimal(steps=[{"id": "reset", "kind": "live_command", "line": "RESET"}])
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.build_spec(data)
        joined = "\n".join(ctx.exception.errors)
        self.assertIn("approval.required", joined)

    def test_reset_with_approval_is_accepted(self):
        data = _minimal(
            steps=[{"id": "reset", "kind": "live_command", "line": "RESET"}],
            approval={"required": True, "risk": "high", "reason": "会中断观测"},
        )
        wf = spec.build_spec(data)
        self.assertTrue(wf.approval["required"])

    def test_freset_with_approval_accepted(self):
        data = _minimal(
            steps=[{"id": "freset", "kind": "live_command", "line": "FRESET"}],
            approval={"required": True, "risk": "high", "reason": "恢复出厂"},
        )
        self.assertTrue(spec.build_spec(data).approval["required"])

    def test_approval_without_reason_rejected(self):
        data = _minimal(
            steps=[{"id": "reset", "kind": "live_command", "line": "RESET"}],
            approval={"required": True})
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.build_spec(data)
        self.assertTrue(any("reason" in e for e in ctx.exception.errors))

    def test_artifact_name_with_directory_rejected(self):
        data = _minimal(steps=[
            {"id": "one", "kind": "artifact", "name": "../escape.json", "content": {}}])
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.build_spec(data)
        self.assertTrue(any("裸文件名" in e for e in ctx.exception.errors))

    def test_download_filename_with_backslash_rejected(self):
        data = _minimal(steps=[
            {"id": "one", "kind": "download", "path": "/api/x",
             "filename": "..\\x.pdf"}])
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.build_spec(data)
        self.assertTrue(any("裸文件名" in e for e in ctx.exception.errors))

    def test_on_fail_retry_rejected(self):
        data = _minimal(steps=[
            {"id": "one", "kind": "sleep", "seconds": 1, "on_fail": "retry"}])
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.build_spec(data)
        self.assertTrue(any("on_fail" in e for e in ctx.exception.errors))


class Templates(unittest.TestCase):
    def test_undeclared_param_rejected(self):
        data = _minimal(steps=[
            {"id": "one", "kind": "artifact", "name": "x.json",
             "content": {"v": "${params.nope}"}}])
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.build_spec(data)
        self.assertTrue(any("nope" in e for e in ctx.exception.errors))

    def test_forward_step_reference_rejected(self):
        data = _minimal(steps=[
            {"id": "one", "kind": "artifact", "name": "x.json",
             "content": {"v": "${steps.two.body}"}},
            {"id": "two", "kind": "http", "path": "/api/health"},
        ])
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.build_spec(data)
        self.assertTrue(any("还没执行" in e for e in ctx.exception.errors))

    def test_save_as_alias_counts_as_executed(self):
        data = _minimal(steps=[
            {"id": "one", "kind": "mark_cursor", "save_as": "mark"},
            {"id": "two", "kind": "artifact", "name": "x.json",
             "content": {"cursor": "${steps.mark.cursor}"}},
        ])
        wf = spec.build_spec(data)
        self.assertEqual(wf.step_count, 2)

    def test_numeric_field_accepts_template(self):
        data = _minimal(steps=[
            {"id": "one", "kind": "http", "path": "/api/x", "timeout_s": "${params.t}"}],
            params={"t": {"type": "number", "default": 5}})
        self.assertEqual(spec.build_spec(data).step_count, 1)

    def test_numeric_field_rejects_negative_literal(self):
        data = _minimal(steps=[{"id": "one", "kind": "sleep", "seconds": -1}])
        with self.assertRaises(spec.WorkflowSpecError):
            spec.build_spec(data)


class Params(unittest.TestCase):
    def _wf(self):
        return spec.build_spec(_minimal(params={
            "target": {"type": "string", "required": True},
            "count": {"type": "integer", "default": 2},
            "flag": {"type": "boolean", "default": False},
            "mode": {"type": "string", "enum": ["fast", "slow"], "default": "fast"},
            "name": {"type": "string", "pattern": "^[a-z]+$", "default": "abc"},
        }))

    def test_defaults_and_required(self):
        wf = self._wf()
        self.assertEqual(spec.validate_params(wf, {"target": "COM8"}),
                         {"target": "COM8", "count": 2, "flag": False,
                          "mode": "fast", "name": "abc"})

    def test_missing_required(self):
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.validate_params(self._wf(), {})
        self.assertTrue(any("target" in e for e in ctx.exception.errors))

    def test_unknown_param_rejected(self):
        with self.assertRaises(spec.WorkflowSpecError) as ctx:
            spec.validate_params(self._wf(), {"target": "COM8", "extra": 1})
        self.assertTrue(any("extra" in e for e in ctx.exception.errors))

    def test_type_and_enum_and_pattern(self):
        wf = self._wf()
        with self.assertRaises(spec.WorkflowSpecError):
            spec.validate_params(wf, {"target": "COM8", "count": "NaN"})
        with self.assertRaises(spec.WorkflowSpecError):
            spec.validate_params(wf, {"target": "COM8", "mode": "medium"})
        with self.assertRaises(spec.WorkflowSpecError):
            spec.validate_params(wf, {"target": "COM8", "name": "ABC"})

    def test_boolean_coercion_from_strings(self):
        wf = spec.build_spec(_minimal(params={"flag": {"type": "boolean", "default": True}}))
        self.assertFalse(spec.validate_params(wf, {"flag": "false"})["flag"])
        self.assertTrue(spec.validate_params(wf, {"flag": "true"})["flag"])


class Resolve(unittest.TestCase):
    def test_whole_template_keeps_type(self):
        ctx = {"params": {"x": [1, 2]}}
        self.assertEqual(spec.resolve("${params.x}", ctx), [1, 2])
        self.assertIsNone(spec.resolve("${params.missing}", ctx))

    def test_mixed_template_becomes_string(self):
        ctx = {"params": {"x": 3}}
        self.assertEqual(spec.resolve("a=${params.x}", ctx), "a=3")

    def test_nested_structures(self):
        ctx = {"params": {"x": "v"}}
        self.assertEqual(spec.resolve({"a": ["${params.x}"]}, ctx), {"a": ["v"]})


class ShippedWorkflows(unittest.TestCase):
    """仓库里真实存在的工作流必须全部可加载——否则``workflow``子命令就是坏的。"""

    def test_all_shipped_specs_load(self):
        workflows = spec.load_all(ROOT / "workflows")
        ids = {w.id for w in workflows}
        self.assertIn("script.device.restart", ids)
        self.assertIn("gui.device.update", ids)
        self.assertIn("gui.graph.export", ids)

    def test_restart_workflow_requires_approval(self):
        wf = spec.load_spec(ROOT / "workflows" / "script.device.restart.yaml")
        self.assertTrue(wf.approval["required"])

    def test_update_workflow_gates_before_apply(self):
        wf = spec.load_spec(ROOT / "workflows" / "gui.device.update.yaml")
        ids = wf.step_ids()
        self.assertIn("approve_apply", ids)
        self.assertLess(ids.index("approve_apply"), ids.index("apply"))

    def test_graph_export_is_read_only(self):
        wf = spec.load_spec(ROOT / "workflows" / "gui.graph.export.yaml")
        self.assertFalse(wf.approval["required"])
        self.assertEqual(wf.risk, "low")

    def test_load_all_rejects_duplicate_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            text = Path(ROOT / "workflows" / "gui.graph.export.yaml").read_text(
                encoding="utf-8")
            (base / "a.yaml").write_text(text, encoding="utf-8")
            (base / "b.yaml").write_text(text, encoding="utf-8")
            with self.assertRaises(spec.WorkflowSpecError):
                spec.load_all(base)


if __name__ == "__main__":
    unittest.main()
