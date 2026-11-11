# -*- coding: utf-8 -*-
"""RPA-1：`rpa_lint` 五条规则的验收。

规格来自 `docs/plans/…AI理解版.md` §7.7：

| 规则 | 判据 |
|---|---|
| 禁裸 sleep | 任何 `kind: sleep` 报错 |
| 禁盲坐标 | 坐标点击必须带 `sig` |
| 目标必须登记 | `target:` 要在基线或 fixture 里 |
| 危险词必须显式 | 只能写显式允许语法 + 要有闸门 |
| 闸门位置 | 不可逆动作前必须有闸门 |

## 验收口径（计划书 §7.7 原文）

* 故意写一条死等 → **报错并指出行号**；
* 现有 8 条跑一遍 → **只剩 2 处**（正是 RPA-2 要改的
  `gui.app.install.yaml:60` 与 `gui.device.add.yaml:75`）。
"""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

from tools import rpa_lint  # noqa: E402

WORKFLOWS = ROOT / "workflows"


class RuleCatalogueTest(unittest.TestCase):
    def test_five_rules_are_registered(self):
        self.assertEqual(len(rpa_lint.RULES), 5)
        ids = {r.id for r in rpa_lint.RULES}
        self.assertEqual(ids, {"no-bare-sleep", "no-blind-coord",
                               "target-registered", "explicit-danger",
                               "gate-before-irreversible"})

    def test_every_rule_has_code_and_doc(self):
        for rule in rpa_lint.RULES:
            self.assertRegex(rule.id, r"^[a-z][a-z0-9-]+$")
            self.assertTrue(rule.doc.strip(), rule)
            self.assertTrue(rule.message.strip(), rule)


class RealWorkflowsTest(unittest.TestCase):
    """验收主判据：现有 8 条只剩 2 处违规，且必须指到那两行的行号。"""

    @classmethod
    def setUpClass(cls):
        cls.findings = rpa_lint.lint_tree(WORKFLOWS)
        cls.sleep = [f for f in cls.findings if f.rule == "no-bare-sleep"]

    def test_exactly_two_bare_sleeps_remain(self):
        self.assertEqual(len(self.sleep), 2, [str(f) for f in self.sleep])

    def test_sleep_findings_point_at_the_known_lines(self):
        got = {(Path(f.path).name, f.line) for f in self.sleep}
        self.assertEqual(got, {("gui.app.install.yaml", 60),
                               ("gui.device.add.yaml", 75)})

    def test_no_other_rule_fires_on_current_workflows(self):
        others = [f for f in self.findings if f.rule != "no-bare-sleep"]
        self.assertEqual(others, [], [str(f) for f in others])

    def test_findings_are_sorted_and_deterministic(self):
        again = rpa_lint.lint_tree(WORKFLOWS)
        self.assertEqual([str(f) for f in self.findings],
                         [str(f) for f in again])


class SleepRuleTest(unittest.TestCase):
    def _lint_one(self, text: str):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "flow.yaml"
            p.write_text(text, encoding="utf-8")
            return rpa_lint.lint_file(p)

    def test_bare_sleep_reports_line_number(self):
        text = "\n".join([
            "id: demo",
            "steps:",
            "  - id: a",
            "    kind: http",
            "  - id: wait",
            "    kind: sleep",
            "    seconds: 3",
        ]) + "\n"
        findings = self._lint_one(text)
        sleep = [f for f in findings if f.rule == "no-bare-sleep"]
        self.assertEqual(len(sleep), 1)
        self.assertEqual(sleep[0].line, 6)
        self.assertIn("sleep", sleep[0].message)

    def test_quoted_sleep_kind_is_still_caught(self):
        text = "\n".join([
            "steps:",
            "  - id: w",
            '    kind: "sleep"',
        ]) + "\n"
        findings = self._lint_one(text)
        self.assertEqual([f.rule for f in findings], ["no-bare-sleep"])


class CoordRuleTest(unittest.TestCase):
    def _lint_one(self, text: str):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "flow.yaml"
            p.write_text(text, encoding="utf-8")
            return rpa_lint.lint_file(p)

    def test_coord_click_without_sig_fails(self):
        text = "\n".join([
            "steps:",
            "  - id: a",
            "    kind: gui",
            "    actions:",
            "      - action: click",
            '        locator: "coord:100,200"',
        ]) + "\n"
        findings = self._lint_one(text)
        coord = [f for f in findings if f.rule == "no-blind-coord"]
        self.assertEqual(len(coord), 1)
        self.assertEqual(coord[0].line, 6)

    def test_coord_click_with_sig_passes(self):
        text = "\n".join([
            "steps:",
            "  - id: a",
            "    kind: gui",
            "    actions:",
            "      - action: click",
            '        locator: "coord:100,200"',
            '        sig: "New Connection"',
        ]) + "\n"
        findings = self._lint_one(text)
        self.assertEqual([f for f in findings if f.rule == "no-blind-coord"], [])


class TargetRuleTest(unittest.TestCase):
    def _lint_one(self, text: str, known: set[str]):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "flow.yaml"
            p.write_text(text, encoding="utf-8")
            return rpa_lint.lint_file(p, known_targets=known)

    def test_unregistered_target_fails(self):
        text = "\n".join([
            "steps:",
            "  - id: a",
            "    kind: gui",
            "    actions:",
            "      - action: click",
            '        locator: "target:NoSuchButton"',
        ]) + "\n"
        findings = self._lint_one(text, {"Manage"})
        reg = [f for f in findings if f.rule == "target-registered"]
        self.assertEqual(len(reg), 1)
        self.assertIn("NoSuchButton", reg[0].message)

    def test_registered_target_passes(self):
        text = "\n".join([
            "steps:",
            "  - id: a",
            "    kind: gui",
            "    actions:",
            "      - action: click",
            '        locator: "target:Manage"',
        ]) + "\n"
        findings = self._lint_one(text, {"Manage"})
        self.assertEqual([f for f in findings if f.rule == "target-registered"], [])

    def test_parameterised_target_is_not_litigated(self):
        """`target:${params.port}` 这种运行时才定的，不能按未登记报错。"""
        text = "\n".join([
            "steps:",
            "  - id: a",
            "    kind: gui",
            "    actions:",
            "      - action: click",
            '        locator: "target:${params.port}"',
        ]) + "\n"
        findings = self._lint_one(text, {"Manage"})
        self.assertEqual([f for f in findings if f.rule == "target-registered"], [])


class DangerWordTest(unittest.TestCase):
    def _lint_one(self, text: str):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "flow.yaml"
            p.write_text(text, encoding="utf-8")
            return rpa_lint.lint_file(p)

    def test_unapproved_danger_action_fails(self):
        text = "\n".join([
            "steps:",
            "  - id: wipe",
            "    kind: gui",
            "    actions:",
            "      - action: click",
            '        locator: "target:Erase NVM"',
        ]) + "\n"
        findings = self._lint_one(text)
        danger = [f for f in findings if f.rule == "explicit-danger"]
        self.assertEqual(len(danger), 1)
        self.assertIn("Erase", danger[0].message)

    def test_danger_action_with_gate_passes(self):
        text = "\n".join([
            "steps:",
            "  - id: gate",
            "    kind: human_gate",
            "    prompt: 确认擦除",
            "  - id: wipe",
            "    kind: gui",
            "    actions:",
            "      - action: click",
            '        locator: "target:Erase NVM"',
        ]) + "\n"
        findings = self._lint_one(text)
        self.assertEqual([f for f in findings if f.rule == "explicit-danger"], [])


class GateRuleTest(unittest.TestCase):
    def _lint_one(self, text: str):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "flow.yaml"
            p.write_text(text, encoding="utf-8")
            return rpa_lint.lint_file(p)

    def test_irreversible_action_before_any_gate_fails(self):
        text = "\n".join([
            "steps:",
            "  - id: wipe",
            "    kind: gui",
            "    actions:",
            "      - action: click",
            '        locator: "target:Erase NVM"',
            "  - id: gate",
            "    kind: human_gate",
            "    prompt: 确认",
        ]) + "\n"
        findings = self._lint_one(text)
        gate = [f for f in findings if f.rule == "gate-before-irreversible"]
        self.assertEqual(len(gate), 1)
        self.assertIn("Erase", gate[0].message)

    def test_gate_before_irreversible_passes(self):
        text = "\n".join([
            "steps:",
            "  - id: gate",
            "    kind: human_gate",
            "    prompt: 确认",
            "  - id: wipe",
            "    kind: gui",
            "    actions:",
            "      - action: click",
            '        locator: "target:Erase NVM"',
        ]) + "\n"
        findings = self._lint_one(text)
        self.assertEqual([f for f in findings if f.rule == "gate-before-irreversible"], [])


class CliTest(unittest.TestCase):
    def test_exit_code_is_one_when_findings_exist(self):
        rc = rpa_lint.main(["--workflows", str(WORKFLOWS)])
        self.assertEqual(rc, 1)

    def test_exit_code_is_zero_on_clean_tree(self):
        with tempfile.TemporaryDirectory() as td:
            rc = rpa_lint.main(["--workflows", td])
            self.assertEqual(rc, 0, "空目录没有违规，应退 0")

    def test_json_output_is_machine_readable(self):
        import json
        import io
        from contextlib import redirect_stdout
        buf = io.StringIO()
        with redirect_stdout(buf):
            rpa_lint.main(["--workflows", str(WORKFLOWS), "--json"])
        data = json.loads(buf.getvalue())
        self.assertEqual(data["violations"], 2)
        self.assertTrue(all("line" in v for v in data["findings"]))


if __name__ == "__main__":
    unittest.main()
