# -*- coding: utf-8 -*-
"""纪-2 规则裁决：三类阈值判定必须带规则编号与依据文档。

验收口径（计划书 §8.4 / §33.37）：

* 给定一组读数，裁决输出规则编号；
* 该编号能在规程原文里查到（`docs/operations/qc-rules.md` 的对应小节）；
* 裁决结果能直接放进 `agents/conclusion.py` 的 `attribution`。

**依据文档不取知识库。** `data/kb/knowledge.jsonl` 是 `knowledge_search` 的数据源，
而它的工具结果被钉进 M5 的 6 份已提交回放基线；往里加条目会让那些基线的 sha 全变。
规程原文由 `docs/operations/qc-rules.md` 承载，本测试据此校验可回源性。
"""
from __future__ import annotations

import json
import math
import unittest
from pathlib import Path

from fieldstation.agents.conclusion import validate_conclusion
from fieldstation.rules.verdict import (
    MANUAL_REL_PATH,
    RULES,
    RuleNotFound,
    cn0_verdict,
    jump_verdict,
    load_manual,
    lookup_rule,
    missing_rate_verdict,
    rule_attribution,
)

ROOT = Path(__file__).resolve().parents[1]
MANUAL = ROOT / MANUAL_REL_PATH


class RuleRegistryTest(unittest.TestCase):
    def test_three_rules_are_registered(self):
        self.assertEqual(set(RULES), {"R-4.2", "R-4.3", "R-4.4"})

    def test_each_rule_has_section_and_threshold(self):
        for rule_id, spec in RULES.items():
            self.assertRegex(rule_id, r"^R-\d+\.\d+$")
            self.assertRegex(spec.section, r"^\d+\.\d+$")
            self.assertTrue(spec.unit.strip())
            self.assertTrue(spec.title.strip())
            self.assertGreater(spec.threshold, 0.0)

    def test_thresholds_match_existing_qc_config(self):
        # 这三个值分别对应 rules/qc.py 的 cn0_min_dbhz / 缺测率口径 /
        # slip_min_jump_tecU。规则层不得另造一套阈值。
        self.assertEqual(RULES["R-4.2"].threshold, 30.0)
        self.assertEqual(RULES["R-4.3"].threshold, 0.05)
        self.assertEqual(RULES["R-4.4"].threshold, 0.5)

    def test_unknown_rule_raises_with_error_code(self):
        with self.assertRaises(RuleNotFound) as ctx:
            lookup_rule("R-9.9", load_manual())
        self.assertEqual(ctx.exception.code, "E_RULE_NOT_FOUND")
        self.assertIn("R-9.9", str(ctx.exception))


class Cn0VerdictTest(unittest.TestCase):
    def test_below_threshold_fails_with_rule_id(self):
        v = cn0_verdict([40.0, 29.9, 35.0])
        self.assertEqual(v["verdict"], "fail")
        self.assertEqual(v["rule_id"], "R-4.2")
        self.assertEqual(v["section"], "4.2")
        self.assertEqual(v["threshold"], 30.0)
        self.assertEqual(v["cn0_stats"]["min"], 29.9)
        self.assertEqual(v["cn0_stats"]["count"], 3)
        self.assertIn("R-4.2", v["reason"])

    def test_exactly_at_threshold_passes(self):
        self.assertEqual(cn0_verdict([30.0])["verdict"], "ok")

    def test_missing_values_are_counted_not_judged(self):
        v = cn0_verdict([40.0, None, math.nan, 35.0])
        self.assertEqual(v["verdict"], "ok")
        self.assertEqual(v["cn0_stats"]["count"], 2)
        self.assertEqual(v["cn0_stats"]["missing"], 2)

    def test_no_valid_reading_is_not_applicable(self):
        v = cn0_verdict([None, math.nan])
        self.assertEqual(v["verdict"], "not_applicable")
        self.assertEqual(v["rule_id"], "R-4.2")
        self.assertIsNone(v["value"])

    def test_non_numeric_reading_is_rejected(self):
        # bool 是 int 的子类，必须单独拦；字符串不能被静默转成数字。
        for bad in ([True], ["30"], [object()]):
            with self.assertRaises(ValueError):
                cn0_verdict(bad)

    def test_infinite_reading_is_rejected(self):
        # ±inf 不是有效物理读数，必须拒绝而不是当成「很高所以合格」。
        for bad in ([math.inf], [-math.inf]):
            with self.assertRaises(ValueError):
                cn0_verdict(bad)


class MissingRateVerdictTest(unittest.TestCase):
    def test_exactly_five_percent_passes(self):
        v = missing_rate_verdict(100, 5)
        self.assertEqual(v["verdict"], "ok")
        self.assertAlmostEqual(v["value"], 0.05)

    def test_above_five_percent_fails(self):
        v = missing_rate_verdict(100, 6)
        self.assertEqual(v["verdict"], "fail")
        self.assertEqual(v["rule_id"], "R-4.3")
        self.assertEqual(v["section"], "4.3")
        self.assertIn("5%", v["reason"])

    def test_zero_total_is_not_applicable(self):
        self.assertEqual(missing_rate_verdict(0, 0)["verdict"], "not_applicable")

    def test_invalid_counts_are_rejected(self):
        for args in [(-1, 0), (10, 11), (10, -1), (True, 0), (10.0, 1)]:
            with self.assertRaises(ValueError):
                missing_rate_verdict(*args)


class JumpVerdictTest(unittest.TestCase):
    def test_exactly_at_threshold_passes(self):
        # qc.py 用严格大于；等于 0.5 TECU 不触发。
        self.assertEqual(jump_verdict([1.0, 1.5])["verdict"], "ok")

    def test_above_threshold_fails(self):
        v = jump_verdict([1.0, 1.5001])
        self.assertEqual(v["verdict"], "fail")
        self.assertEqual(v["rule_id"], "R-4.4")
        self.assertEqual(v["section"], "4.4")
        self.assertEqual(v["n_jumps"], 1)
        self.assertAlmostEqual(v["max_jump"], 0.5001)

    def test_gap_breaks_the_pair(self):
        v = jump_verdict([1.0, None, 2.0])
        self.assertEqual(v["verdict"], "not_applicable")
        self.assertEqual(v["n_pairs"], 0)

    def test_each_over_threshold_pair_is_counted(self):
        v = jump_verdict([1.0, 2.0, 1.0])
        self.assertEqual(v["verdict"], "fail")
        self.assertEqual(v["n_jumps"], 2)


class AttributionTest(unittest.TestCase):
    def test_single_failed_rule_becomes_fault_type(self):
        verdict = missing_rate_verdict(100, 12)
        evidence = [{"call_id": "c-001", "tool": "robust_stats",
                     "finding": "缺测率 12%"}]
        attribution = rule_attribution([verdict], evidence)
        self.assertEqual(attribution["fault_type"], "R-4.3")
        self.assertEqual(attribution["evidence"], evidence)

    def test_multiple_failed_rules_are_all_listed(self):
        verdicts = [cn0_verdict([20.0]), jump_verdict([0.0, 1.0])]
        attribution = rule_attribution(
            verdicts,
            [{"call_id": "c-1", "tool": "qc_run", "finding": "CN0 与跳变均超限"}],
        )
        self.assertEqual(attribution["fault_type"], "R-4.2,R-4.4")

    def test_no_failure_cannot_make_attribution(self):
        with self.assertRaises(ValueError):
            rule_attribution([cn0_verdict([40.0])],
                             [{"call_id": "c", "tool": "t", "finding": "f"}])

    def test_empty_evidence_is_rejected(self):
        with self.assertRaises(ValueError):
            rule_attribution([cn0_verdict([20.0])], [])

    def test_unknown_rule_id_in_verdict_is_rejected(self):
        with self.assertRaises(ValueError):
            rule_attribution([{"verdict": "fail", "rule_id": "R-9.9"}],
                             [{"call_id": "c", "tool": "t", "finding": "f"}])

    def test_attribution_passes_conclusion_contract(self):
        verdict = cn0_verdict([25.0, 40.0])
        evidence = [{"call_id": "c-001", "tool": "robust_stats",
                     "finding": "CN0 最低 25.0 dB-Hz"}]
        conclusion = {
            "attribution": rule_attribution([verdict], evidence),
            "recommendation": "复核天线与馈线连接",
            "confidence": 0.8,
        }
        trace = [{"kind": "tool_result", "ok": True, "call_id": "c-001",
                  "tool": "robust_stats"}]
        result = validate_conclusion(conclusion, trace)
        self.assertTrue(result.valid, result.errors)
        self.assertEqual(result.conclusion["attribution"]["fault_type"], "R-4.2")


class ManualTraceabilityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manual = load_manual()

    def test_manual_file_exists_and_is_the_declared_path(self):
        self.assertTrue(MANUAL.is_file(), MANUAL)
        self.assertTrue(self.manual.strip())

    def test_every_rule_section_is_in_the_manual(self):
        for spec in RULES.values():
            self.assertIn(f"§{spec.section}", self.manual, spec.rule_id)
            self.assertIn(spec.rule_id, self.manual, spec.rule_id)

    def test_threshold_text_is_in_the_manual(self):
        self.assertIn("30 dB-Hz", self.manual)
        self.assertIn("5%", self.manual)
        self.assertIn("0.5 TECU", self.manual)

    def test_lookup_returns_original_text_and_source(self):
        result = lookup_rule("R-4.2", self.manual)
        self.assertEqual(set(result), {"rule_id", "text", "source", "section"})
        self.assertEqual(result["rule_id"], "R-4.2")
        self.assertEqual(result["section"], "4.2")
        self.assertIn("30 dB-Hz", result["text"])
        self.assertIn("§4.2", result["source"])
        self.assertTrue(result["text"].startswith("CN0 低于 30 dB-Hz"))

    def test_every_rule_can_be_looked_up(self):
        for rule_id in RULES:
            result = lookup_rule(rule_id, self.manual)
            self.assertEqual(result["rule_id"], rule_id)
            self.assertTrue(result["text"].strip())

    def test_lookup_fails_when_manual_is_empty_or_rule_absent(self):
        for broken in ("", "   ", "## §4.2 只有标题没有原文行"):
            with self.assertRaises(RuleNotFound):
                lookup_rule("R-4.2", broken)

    def test_lookup_fails_when_section_is_missing(self):
        # 有原文行但缺 §4.2 小节标记 —— 编号与章节对不上也算查不到。
        text = "> R-4.2：CN0 低于 30 dB-Hz 判为不合格。\n"
        with self.assertRaises(RuleNotFound):
            lookup_rule("R-4.2", text)


class JsonShapeTest(unittest.TestCase):
    def test_verdicts_are_json_friendly(self):
        verdicts = (
            cn0_verdict([40.0]),
            missing_rate_verdict(10, 0),
            jump_verdict([0.0, 0.1]),
        )
        for v in verdicts:
            json.dumps(v, ensure_ascii=False)
            for key in ("verdict", "rule_id", "section", "threshold",
                        "unit", "value", "reason"):
                self.assertIn(key, v)


if __name__ == "__main__":
    unittest.main()
