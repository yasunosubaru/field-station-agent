"""M7-1 一页摘要的「数字回源」守卫。

摘要里的每个对外数字都必须与 `logs/` 下的机读文件一致；改数字先改文件，
否则这里会红。这与 `tools/audit_claims.py` 对 README 机维护块做的事同源，
只是对象换成结题材料。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SUMMARY_DOC = ROOT / "docs" / "m7" / "一页摘要.md"
REPORT_DOC = ROOT / "docs" / "m7" / "结题报告-骨架.md"
DRYRUN = ROOT / "logs" / "dryrun_trial_summary_202401.json"
DASHBOARD = ROOT / "logs" / "public_chain_dashboard.json"
COPYRIGHT = ROOT / "logs" / "copyright_source_summary.json"
LEDGER = ROOT / "logs" / "trial_ledger_summary_20261021.json"


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


class TestOnePageSummary(unittest.TestCase):
    def setUp(self) -> None:
        self.text = SUMMARY_DOC.read_text(encoding="utf-8")

    def test_dryrun_numbers(self):
        d = _load(DRYRUN)
        self.assertIn(f"{d['days']} 天", self.text)
        self.assertIn(f"{d['source_ok_days']}/{d['days']}", self.text)
        self.assertIn(f"{d['low_temp_hours']} 小时", self.text)
        self.assertIn(f"{d['device_degraded_days']}/{d['days']}", self.text)
        self.assertIn(f"{d['detected_days']}/{d['injected_days']}", self.text)
        self.assertIn(f"{d['false_positive_days']}/{d['clean_days']}", self.text)
        self.assertIn(f"{d['detection_rate']:.1f}", self.text)
        self.assertIn(f"{d['false_positive_rate']:.1f}", self.text)

    def test_sensitivity_claim_matches_data(self):
        d = _load(DRYRUN)
        sustained = [s for s in d["sensitivity"] if s["mode"] == "sustained"]
        spike = [s for s in d["sensitivity"] if s["mode"] == "spike"]
        self.assertTrue(sustained and spike)
        self.assertTrue(all(s["detected"] for s in sustained))
        self.assertFalse(any(s["detected"] for s in spike))
        self.assertIn("1 cycle 即检出", self.text)
        self.assertIn("1–20 cycle 均不检出", self.text)

    def test_dashboard_numbers(self):
        d = _load(DASHBOARD)
        self.assertIn(f"{d['counts']['alerts']} 条 warn", self.text)
        self.assertIn(f"{d['counts']['orders']} 张工单", self.text)
        station = d["stations"][0]
        self.assertIn(station["station_id"], self.text)
        self.assertIn(station["status"], self.text)
        self.assertIn(f"{station['health_score']:.1f}", self.text)

    def test_copyright_numbers(self):
        d = _load(COPYRIGHT)
        self.assertIn(f"{d['files']} 个文件", self.text)
        self.assertIn(f"{d['lines']:,} 行", self.text)
        self.assertIn(f"{d['pages_total']} 页", self.text)

    def test_ledger_numbers(self):
        d = _load(LEDGER)
        self.assertIn(f"{d['rows']} 行", self.text)
        self.assertIn(f"{d['success_rate']:.3f}", self.text)

    def test_every_number_cites_a_source_file(self):
        for name in ("dryrun_trial_summary_202401.json",
                     "public_chain_dashboard.json",
                     "copyright_source_summary.json",
                     "trial_ledger_summary_20261021.json"):
            self.assertIn(name, self.text, name)

    def test_report_points_at_summary(self):
        report = REPORT_DOC.read_text(encoding="utf-8")
        self.assertIn("一页摘要.md", report)
        # 归属一节必须点名 PROVENANCE 与移植说明
        self.assertIn("PROVENANCE.md", report)
        self.assertIn("移植说明", report)
        # 未完成项不得省略
        self.assertIn("未完成项与原因", report)


if __name__ == "__main__":
    unittest.main()
