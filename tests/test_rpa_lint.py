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
    """验收主判据分两个时点。

    RPA-1 落地时（未清死等）：现有 8 条只剩 2 处，正是
    `gui.app.install.yaml:60` 与 `gui.device.add.yaml:75`。
    RPA-2 清完之后：**0 违规**。两段都钉住，避免「先修 YAML 再写 lint」
    那种倒序做法——那样 lint 就失去了验证对象，也无从证明它真的能报出问题。
    """

    @classmethod
    def setUpClass(cls):
        cls.findings = rpa_lint.lint_tree(WORKFLOWS)

    def test_current_workflows_are_clean(self):
        """RPA-2 之后：8 条流程 0 违规。"""
        self.assertEqual(self.findings, [], [str(f) for f in self.findings])

    def test_lint_still_catches_the_two_original_sleeps(self):
        """把历史那两处死等还原成 sleep，lint 必须还能报出它们。

        这条防的是「修完 YAML 后把 lint 也一起放松」——
        它用**历史原文片段**做负例，不依赖当前 YAML 内容。
        """
        import tempfile
        from pathlib import Path as _P

        cases = {
            "gui.app.install.yaml": "\n".join([
                "steps:",
                "  - id: settle_home",
                "    kind: sleep",
                "    seconds: 2.0",
            ]) + "\n",
            "gui.device.add.yaml": "\n".join([
                "steps:",
                "  - id: settle_home",
                "    kind: sleep",
                "    seconds: 2.0",
            ]) + "\n",
        }
        with tempfile.TemporaryDirectory() as td:
            root = _P(td)
            for name, text in cases.items():
                (root / name).write_text(text, encoding="utf-8")
            findings = rpa_lint.lint_tree(root, known_targets=set())
        sleep = [f for f in findings if f.rule == "no-bare-sleep"]
        self.assertEqual(len(sleep), 2, [str(f) for f in sleep])
        self.assertEqual({_P(f.path).name for f in sleep}, set(cases))
        for finding in sleep:
            self.assertEqual(finding.line, 3, "必须指到 kind: sleep 那一行")

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
    def test_exit_code_is_zero_when_workflows_are_clean(self):
        """RPA-2 之后现有 8 条 0 违规，应退 0。"""
        rc = rpa_lint.main(["--workflows", str(WORKFLOWS)])
        self.assertEqual(rc, 0)

    def test_exit_code_is_one_when_findings_exist(self):
        with tempfile.TemporaryDirectory() as td:
            bad = Path(td) / "bad.yaml"
            bad.write_text("steps:\n  - id: w\n    kind: sleep\n", encoding="utf-8")
            self.assertEqual(rpa_lint.main(["--workflows", td]), 1)

    def test_exit_code_is_zero_on_empty_tree(self):
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
        self.assertEqual(data["violations"], 0)
        self.assertEqual(data["findings"], [])


if __name__ == "__main__":
    unittest.main()
