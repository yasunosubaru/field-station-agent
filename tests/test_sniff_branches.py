#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`reader.sniff` 的非观测分支，与 `approx_xyz` 的 NaN 守卫。

补的是 `docs/known-issues.md` **KI-05** 记的覆盖缺口：

> 给 `sniff` 的 NAV / RINEX4 / CRINEX 三个"识别得出但不支持"分支补测试 ——
> 这三条是 `UnsupportedFormat` 的 `how_to_fix` 文案的唯一来源，智能体将来要靠
> 它们给用户指路。
>
> **附带**：`reader.approx_xyz` 的 NaN 守卫（`if not v or any(x != x for x in v)`）
> 无覆盖；把 `if False:` 不会被捕获。

## 一处要先说清：`sniff` 与 `ObservationFile` 对 NAV 的口径**不同**

| 层 | 对 RINEX 3 导航电文 |
|---|---|
| `reader.sniff(path)` | `format="RINEX3-NAV"`、**`supported=True`**、带 `note`（识别得出，能当广播星历用） |
| `reader.ObservationFile(path)` | **抛 `UnsupportedFormat`**，附「改用同日期的观测文件」的指路文案 |

这不是缺陷，是**有意的分层**：`sniff` 答的是「这是什么文件」，`ObservationFile` 答的是
「能不能当观测用」。`reader._open` 的注释写明了理由（"导航电文是合法输入（作广播星历），
只是不含观测。明确指路，而不是笼统报「不支持」"）。两条都有测试钉住，将来任何一侧改了
口径都会红，改的人必须显式决定。

## 顺带记下两处目前不可达的代码（本次不动 `src/`）

- `reader._FIX["RINEX3-NAV"]`：`_open` 给 NAV 抛异常时传的是内联 `how_to_fix` 且
  `_how_to_fix=True`，`UnsupportedFormat.__init__` 优先取内联那条，所以 `_FIX` 里
  这一项**永不生效**。
- `reader.ObservationFile.capability_report()` 的 `if not info.get("supported")` 分支：
  `__init__` 在 `_open` 阶段就对不支持的格式抛异常了，外部拿不到那种实例，
  所以这个分支目前**不可达**（全仓只有测试在调 `capability_report`）。
"""
from __future__ import annotations

import gzip
import os
import tempfile
import unittest

from fieldstation.ingest import reader
from tests.fixtures_rinex import RINEX2_OBS, RINEX3_OBS

_TMPDIR = tempfile.mkdtemp(prefix="fieldstation-sniff-")

#: RINEX 3 **导航电文**：首行是 RINEX 3 的版本列写法，但没有 `OBSERVATION DATA`。
RINEX3_NAV = (
    "     3.04           NAVIGATION DATA     M                   RINEX VERSION / TYPE\n"
    "FIELDS        1.0                                           PGM / RUN BY / DATE\n"
    "                                                            END OF HEADER\n"
)

#: RINEX **4** 观测：版本列写法与 3.x 一致，只是主版本是 4。
RINEX4_OBS = (
    "     4.02           OBSERVATION DATA    M                   RINEX VERSION / TYPE\n"
    "                                                            END OF HEADER\n"
)

#: 既不是 RINEX 也不是 CRINEX，首行也没有逗号分段（故连 CSV 都不是）。
NOT_OBSERVATIONS = "这不是观测文件\n"


def _write(text: str, name: str, binary: bool = False) -> str:
    path = os.path.join(_TMPDIR, name)
    mode = "wb" if binary else "w"
    kwargs = {} if binary else {"encoding": "utf-8", "newline": ""}
    with open(path, mode, **kwargs) as fh:
        fh.write(text)
    return path


def _write_crinex(d_lines: int, gzf_lines: int, name: str) -> str:
    """造一个 `.crx.gz`：首行声明 CRINEX，正文按需放 `d` 记录与 `3&` 记录。

    `sniff` 对 CRINEX 的分支要求 `gz`（魔数）且首行含 `CRINEX VERS`；
    variant 由正文里 `3&` 的出现次数决定（`> 100` 判为 gfzrnx 私有紧缩）。
    """
    head = ("     3.04           CRINEX VERS   / TYPE\n"
            "     3.04           CRINEX PROG / DATE\n")
    body = ["d" + " " * 8 + "record"] * d_lines
    body += ["3&" + " " * 7 + "record"] * gzf_lines
    raw = (head + "\n".join(body) + "\n").encode("latin-1")
    path = os.path.join(_TMPDIR, name)
    with gzip.open(path, "wb") as fh:
        fh.write(raw)
    return path


def _without_approx(text: str) -> str:
    """去掉 `APPROX POSITION XYZ` 记录 —— 该记录在 RINEX 2/3 里都是可选的。"""
    return "\n".join(l for l in text.split("\n")
                     if "APPROX POSITION XYZ" not in l)


def tearDownModule() -> None:
    import shutil
    shutil.rmtree(_TMPDIR, ignore_errors=True)


class TestSniffNonObservationFormats(unittest.TestCase):
    """`sniff` 对四类「不是观测」的文件给出的识别结果。"""

    def test_rinex3_nav_is_identified(self):
        info = reader.sniff(_write(RINEX3_NAV, "nav.rnx"))
        self.assertEqual(info["format"], "RINEX3-NAV")
        self.assertTrue(info["supported"])
        self.assertEqual(info["version"], "3.04")
        self.assertIn("导航电文", info.get("note", ""))

    def test_rinex4_is_identified_but_unsupported(self):
        info = reader.sniff(_write(RINEX4_OBS, "four.rnx"))
        self.assertEqual(info["format"], "RINEX4")
        self.assertFalse(info["supported"])
        self.assertIn("convbin", info["reason"])

    def test_crinex_hatanaka_variant(self):
        path = _write_crinex(d_lines=3, gzf_lines=0, name="h.crx.gz")
        info = reader.sniff(path)
        self.assertEqual(info["format"], "CRINEX")
        self.assertEqual(info["variant"], "hatanaka-d")
        self.assertEqual(info["n_d_records"], 3)
        self.assertEqual(info["n_gfz_records"], 0)
        self.assertFalse(info["supported"])
        self.assertIn("Hatanaka", info["reason"])

    def test_crinex_gfzrnx_variant(self):
        """`3&` 记录超过 100 条时判为 gfzrnx 私有紧缩，而不是 Hatanaka。"""
        path = _write_crinex(d_lines=0, gzf_lines=101, name="g.crx.gz")
        info = reader.sniff(path)
        self.assertEqual(info["format"], "CRINEX")
        self.assertEqual(info["variant"], "gfzrnx-3&")
        self.assertEqual(info["n_gfz_records"], 101)
        self.assertFalse(info["supported"])
        self.assertIn("gfzrnx", info["reason"])

    def test_unknown_when_nothing_matches(self):
        info = reader.sniff(_write(NOT_OBSERVATIONS, "junk.txt"))
        self.assertEqual(info["format"], "UNKNOWN")
        self.assertFalse(info["supported"])
        self.assertIn("SBF", info["reason"])


class TestUnsupportedFormatGuidance(unittest.TestCase):
    """`UnsupportedFormat` 抛出的文案要给得出可执行的动作（智能体靠它给用户指路）。"""

    def _message(self, path: str) -> str:
        with self.assertRaises(reader.UnsupportedFormat) as cm:
            reader.ObservationFile(path)
        return str(cm.exception)

    def test_nav_raises_and_points_at_observation_files(self):
        msg = self._message(_write(RINEX3_NAV, "nav2.rnx"))
        self.assertIn("nav2.rnx", msg)          # 使用者要能对上文件
        self.assertIn("RINEX3-NAV", msg)
        self.assertIn("导航电文", msg)
        self.assertIn("观测文件", msg)           # 指路：改用同日期观测文件

    def test_rinex4_raises_and_names_a_conversion_tool(self):
        msg = self._message(_write(RINEX4_OBS, "four2.rnx"))
        self.assertIn("RINEX4", msg)
        self.assertIn("convbin", msg)

    def test_crinex_raises_and_names_a_conversion_tool(self):
        msg = self._message(_write_crinex(d_lines=3, gzf_lines=0, name="h2.crx.gz"))
        self.assertIn("CRINEX", msg)
        self.assertIn("gfzrnx", msg)

    def test_nav_message_comes_from_open_not_from_fix_table(self):
        """NAV 走的是 `_open` 的内联文案（`_how_to_fix=True`）。

        这条钉住那份**分层口径**：`sniff` 说 NAV 是 supported 的，
        而 `ObservationFile` 仍然拒绝它并给出指路 —— 两边都别被顺手改掉。
        """
        info = reader.sniff(_write(RINEX3_NAV, "nav3.rnx"))
        self.assertTrue(info["supported"])
        msg = self._message(_write(RINEX3_NAV, "nav3.rnx"))
        self.assertIn("无法反演 TEC", msg)


class TestApproxXyzGuard(unittest.TestCase):
    """`approx_xyz` 的 NaN 守卫：算不出来的坐标必须给 `None`，不能给一串 NaN。"""

    def test_missing_record_yields_none_rinex2(self):
        of = reader.ObservationFile(
            _write(_without_approx(RINEX2_OBS), "noapprox.rnx"))
        self.assertIsNone(of.approx_xyz)

    def test_missing_record_yields_none_rinex3(self):
        of = reader.ObservationFile(
            _write(_without_approx(RINEX3_OBS), "noapprox3.rnx"))
        self.assertIsNone(of.approx_xyz)

    def test_capability_report_also_yields_none(self):
        rep = reader.ObservationFile(
            _write(_without_approx(RINEX2_OBS), "noapprox_rep.rnx")
        ).capability_report()
        self.assertIsNone(rep["approx_xyz"])

    def test_present_record_is_returned_unchanged(self):
        """对照：夹具带该记录时必须给出三元组，守卫不能把正常值也吃掉。"""
        of = reader.ObservationFile(_write(RINEX2_OBS, "withapprox.rnx"))
        self.assertEqual(of.approx_xyz,
                         (-3456000.0, 4653800.0, 4049400.0))
