# -*- coding: utf-8 -*-
"""设-1 收口：**用户反馈问卷**不是设备字段，不进 EV-30 的差异口径。

## 事实（逐条查过，见 `docs/operations/suite-field-parity.md`）

`app/view/html/index.html` 里 `SM2IP`/`PL3IP`/`CS4IP`/`GS2IP`/`VS4IP`… 这 15 个
`<textarea>` 全部落在 `*-survey-section` 容器里（`setup-monitor-survey-section`、
`playback-survey-section`、`convert-survey-section`、`grit-survey-section`、
`graph-survey-section`），祖先链固定为
`carousel-fb-data` / `rating-msg-section` / `feature-other`。
它们是让用户给这套界面打分的意见框（"Very easy / Exceeds expectations / Other"），
不是设备参数。B 侧没复刻它们，是**对的**——那不是业务字段。

`fileUploadInput`（`index.html:355`）落在 `select-file` 里，`style="display: none"`，
是给"新建回放"对话框选文件的隐藏 input，B 侧用 `capture-select` 承载抓包选择、
回放走面板内的 `input[type=file]`，不是同一个字段。

## 为什么必须机判而不是列黑名单

清单里的键名会随原版改版变化；写死 15 个 id 等于把"当前样本"当规律。
所以判据是**结构性的**：控件的祖先容器 class 命中问卷标记，就判 `not_applicable`。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))

import tools.suite_field_parity as P  # noqa: E402

INDEX_HTML = "逆向/01_解包/app/view/html/index.html"


class SurveyDetectionTest(unittest.TestCase):
    def test_survey_marker_constant_exists(self):
        self.assertTrue(hasattr(P, "SURVEY_CLASS_MARKERS"))
        self.assertTrue(P.SURVEY_CLASS_MARKERS)

    def test_detects_the_15_survey_textareas(self):
        """index.html 里那 15 个问卷 textarea 必须被识别为问卷控件。"""
        survey = P.survey_field_keys(ROOT / INDEX_HTML)
        expect = {"SM2IP", "SM3IP", "SM4IP", "PL2IP", "PL3IP", "PL4IP",
                  "CS2IP", "CS3IP", "CS4IP", "GS2IP", "GS3IP", "GS4IP",
                  "VS2IP", "VS3IP", "VS4IP"}
        self.assertEqual(survey, expect)

    def test_real_device_fields_are_not_flagged_as_survey(self):
        """同页的真设备字段不能被误判成问卷（防止排除口径过宽）。"""
        survey = P.survey_field_keys(ROOT / INDEX_HTML)
        for key in ("capture-select", "tabs-list", "welcome"):
            self.assertNotIn(key, survey)

    def test_survey_rows_become_not_applicable(self):
        """判为问卷的控件，在报告里必须是 not_applicable 而不是 a_only。"""
        report = P.build_report()
        rows = [r for r in report.rows if r.page == "index"]
        survey_rows = [r for r in rows if r.verdict == "not_applicable"]
        keys = {r.field_key for r in survey_rows}
        self.assertTrue({"SM2IP", "VS4IP"} <= keys,
                        f"问卷控件未判 not_applicable：{sorted(keys)}")
        for r in survey_rows:
            self.assertTrue(r.reason, "not_applicable 必须带理由，不能静默排除")

    def test_not_applicable_does_not_enter_mismatches(self):
        report = P.build_report()
        u = report.unique_counts
        self.assertIn("not_applicable", u)
        self.assertGreater(u["not_applicable"], 0)
        # mismatches 只算 b_only + a_only
        self.assertEqual(report.mismatches, u["b_only"] + u["a_only"])


if __name__ == "__main__":
    unittest.main()
