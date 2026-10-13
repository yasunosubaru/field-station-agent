#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""观测接入层（`fieldstation.ingest`）的行为测试。

## 断言怎么选出来的

计划书 Step 1 明确要求"**断言行为，不断言本计划未核实的函数名**"。搬运完成后
先读了 `src/fieldstation/ingest/rinex3.py` 与 `reader.py` 的真实公开入口，
再据此写断言。下面每个断言落点都对应搬运后代码里**实际存在**的名字：

| 断言 | 绑定的真实入口（搬运后源码行号） |
|---|---|
| `header.obs_types["G"]` | `rinex3.Rinex3Obs.__init__` -> `_parse_header`（`ObsHeader.obs_types`） |
| `header.version` | 同上，`_parse_header` 的 `VERSION / TYPE` 分支取 `ln[0:20].strip()` |
| `sniff(path)` 的 dict 键 | `reader.sniff`（`format` / `version` / `file_type` / `supported`） |
| `UnsupportedFormat` | `reader.UnsupportedFormat(RuntimeError)`，由 `_open()` 抛出 |
| `ObservationFile` 的 `station` / `interval_s` / `observations()` | `reader.ObservationFile` 的同名公开成员 |

**`rinex3` 没有模块级 `parse_header`** —— 只有私有的
`Rinex3Obs._parse_header`。头段的公开读法是构造 `Rinex3Obs(path=None, text=...)`
后读 `.header`。有模块级 `parse_header` 的是 `hatanaka.parse_header(lines)`
（入参是行列表，返回 `RinexHeader`），与 `rinex3` 不是同一套东西。

## 已知未覆盖：RINEX 3 的观测段

本仓库的 RINEX 3 测试夹具覆盖头段解析，但**没有覆盖观测段**——
`rinex3.py:248` 的函数级 import 改写因此未被任何测试走到。

原因限于本夹具的形状：`RINEX3_OBS` 的 `SYS / # / OBS TYPES` 块后面紧跟
`END OF HEADER`（前 60 列全空白），而该分支对前 60 列全空白的行是 `i += 1`
跳过，于是 `header_end` 落到文件末尾。真实文件实测（控制者，2026-10-13），
出处：对一份 TWTF RINEX3.04 观测文件构造统一入口
`of = reader.ObservationFile(<该文件路径>)` —— 其底层解析器
`rinex3.Rinex3Obs`（即 `of._raw`）的 `header_end = 44`、`n_epochs = 2880`，
而 **`of.observations(["GPS"])` 逐条吐出 115432 条**：
`len(list(of.observations(["GPS"]))) == 115432`。即这个 115432 是该
`ObservationFile` 实例对 `["GPS"]` 一个系统查询的返回条数，不是夹具、
也不是其他对象的量。真实观测段可正常解析，本任务不因本缺口做任何代码改动。

## 观测码回退链

`RINEX2_OBS` 声明的观测码是 `C1 L1 S1 P2 L2`，**没有 C2**。RINEX 2 只有一套
观测码，`reader.CODE_FALLBACK["L2"]` 的首选是 `C2`，缺了就得沿回退链落到
`P2`。所以 `test_rinex2_is_accepted` 断言 L2 的伪距等于 **P2 列**的值而不是
C2 列的值 —— 这条断言一旦回退链被摘掉就会失败。
"""
from __future__ import annotations

import os
import tempfile
import unittest
import warnings

from fieldstation.ingest import reader, rinex3
from tests.fixtures_rinex import (
    BAD_OBS,
    RINEX2_OBS,
    RINEX2_OBS_PLAN_LITERAL,
    RINEX3_OBS,
    RINEX3_OBS_PLAN_LITERAL,
)

# 搬运自源项目的读取器用 `open(path, "rb").read()` 读文件、不关闭句柄
# （`rinex2._gzip_bytes` / `rinex3.Rinex3Obs.__init__` / `reader._read_text`），
# 每次打开观测文件都会抛一条 ResourceWarning，把 unittest 的输出刷花。
# 这是**搬运来的既有行为**，本任务不改搬运件（改了就不是搬运了），
# 只在 `_open_observation_file` 里精确屏蔽（unittest 的 runner 会把模块级
# 的 filter 覆盖回 `default`，所以必须包在调用点上），并在 task-4-report.md
# 里记为待修项。

_TMPDIR = tempfile.mkdtemp(prefix="fieldstation-ingest-")


def _write_tmp(text: str, name: str = "fixture.rnx") -> str:
    """把夹具落到临时文件并返回路径（由 tearDownModule 统一清理）。"""
    path = os.path.join(_TMPDIR, name)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    return path


def _open_observation_file(text: str, name: str):
    """构造 `ObservationFile`，屏蔽搬运件遗留的「未关闭文件句柄」告警。"""
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore", category=ResourceWarning, message="unclosed file")
        return reader.ObservationFile(_write_tmp(text, name))


def tearDownModule() -> None:
    import shutil
    shutil.rmtree(_TMPDIR, ignore_errors=True)


class TestRinex3Header(unittest.TestCase):
    """`Rinex3Obs(path=None, text=...)` 解析出来的头段。"""

    def test_header_yields_g_system_obs_types(self):
        r = rinex3.Rinex3Obs(text=RINEX3_OBS)
        self.assertEqual(
            r.header.obs_types["G"],
            ["C1C", "L1C", "D1C", "S1C", "C2C", "L2C", "D2C", "S2C"])
        self.assertEqual(list(r.header.obs_types), ["G"])

    def test_version_is_304(self):
        r = rinex3.Rinex3Obs(text=RINEX3_OBS)
        self.assertEqual(r.header.version, "3.04")
        self.assertEqual(r.header.file_type, "OBSERVATION DATA")


class TestSniff(unittest.TestCase):
    """`reader.sniff(path)` 的返回 dict（键名以实现为准，不凭空假设）。"""

    def test_sniffs_rinex3(self):
        info = reader.sniff(_write_tmp(RINEX3_OBS))
        self.assertEqual(info["format"], "RINEX3")
        self.assertEqual(info["version"], "3.04")
        self.assertEqual(info["file_type"], "OBSERVATION DATA")
        self.assertTrue(info["supported"])
        # 认出来了就不该再给「怎么修」的提示
        self.assertNotIn("reason", info)


class TestUnsupported(unittest.TestCase):
    def test_bad_format_raises(self):
        # brief 的 Interfaces 明写 `UnsupportedFormat(RuntimeError)`：
        # assertRaises 对基类变化不敏感，基类得单独钉
        self.assertTrue(issubclass(reader.UnsupportedFormat, RuntimeError))
        with self.assertRaises(reader.UnsupportedFormat):
            _open_observation_file(BAD_OBS, "bad.txt")

    def test_rinex2_is_accepted(self):
        of = _open_observation_file(RINEX2_OBS, "b.rnx")
        self.assertEqual(of.info["format"], "RINEX2")
        self.assertEqual(of.station, "TESTSTN")
        # 夹具的 INTERVAL 特意取 15.00（不等于 reader.py:304 的兜底常量 30.0），
        # 这样本断言才能证明 INTERVAL 记录真的被读了
        self.assertEqual(of.interval_s, 15.0)
        self.assertEqual(of.approx_xyz, (-3456000.0, 4653800.0, 4049400.0))

        obs = list(of.observations())
        # 4 颗星 x (L1, L2) 双频对
        self.assertEqual(
            [(o.sv, o.signal) for o in obs],
            [(1, "L1"), (1, "L2"), (2, "L1"), (2, "L2"),
             (3, "L1"), (3, "L2"), (4, "L1"), (4, "L2")])
        self.assertEqual({o.system for o in obs}, {"GPS"})
        self.assertEqual({o.station for o in obs}, {"TESTSTN"})
        self.assertEqual(of.warnings, [])

        l1 = obs[0]
        self.assertEqual(l1.gps_week, 2243)
        self.assertEqual(l1.epoch_utc, "2023-01-01T00:00:00.000Z")
        self.assertAlmostEqual(l1.psr_m, 23040555.123, places=3)
        # reader._from_rinex2 对相位统一乘 -1
        self.assertAlmostEqual(l1.adr_cycles, -123456789.123, places=3)
        self.assertAlmostEqual(l1.cn0_dbhz, 41.000, places=3)

        # 夹具没有 C2：L2 的伪距必须走回退链落到 P2 列（24000000.456）
        l2 = obs[1]
        self.assertAlmostEqual(l2.psr_m, 24000000.456, places=3)
        self.assertAlmostEqual(l2.adr_cycles, -130000000.987, places=3)
        # SNR_FALLBACK["L2"] 找不到 S2 时应当是 NaN，不是 0
        self.assertNotEqual(l2.cn0_dbhz, l2.cn0_dbhz)


class TestPlanLiteralFixtures(unittest.TestCase):
    """负控制：计划书 Step 1 给的两段内联串**不是**合法 RINEX，读不出东西。

    本条测试只引用 `*_PLAN_LITERAL`，**不碰主夹具**。它的作用是留下
    「计划书原文确实不可用」的可执行记录，防止有人日后误以为那两段串
    可以直接当夹具用。

    注意分工：主夹具若被换回计划书原文，兜住它的是 `test_sniffs_rinex3`
    与 `test_version_is_304`，**不是**本类。
    """

    def test_plan_literals_are_not_usable_fixtures(self):
        # 计划书 RINEX3 首行用的是 RINEX 2 的版本列写法，sniff 判不出来
        info = reader.sniff(_write_tmp(RINEX3_OBS_PLAN_LITERAL, "plan3.rnx"))
        self.assertEqual(info["format"], "UNKNOWN")
        self.assertFalse(info["supported"])
        # 标签从第 46 列起，被 _label() 的 line[60:] 切掉 -> 版本号停在空串
        self.assertEqual(
            rinex3.Rinex3Obs(text=RINEX3_OBS_PLAN_LITERAL).header.version, "")

        # 计划书 RINEX2 缺 `# / TYPES OF OBSERV` 记录，能打开但读不到东西
        of2 = _open_observation_file(RINEX2_OBS_PLAN_LITERAL, "plan2.rnx")
        self.assertEqual(of2.info["format"], "RINEX2")
        # 纯公开 API 的强断言（ledger 裁定，2026-10-13 执行）：三个星座各自的
        # 观测类型表必须都是空的 —— 比原先 `list(of2.observations()) == []`
        # 那条弱断言钉得更死，无需碰白盒、无需动搬运件
        self.assertEqual(of2.obs_types(), {"GPS": [], "GAL": [], "BDS": []})


if __name__ == "__main__":
    unittest.main()
