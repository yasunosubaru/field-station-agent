#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""流水线回归：复现性（同配置 -> 同 config_hash、同字节）与合成数据隔离。

对应 T4：T-17。源项目此文件走上游的 `cli.run_pipeline`，而 cli 不在 spec §1.1 的
搬运清单里（入口留到 Task 7/8），所以本文件直接对 `synthetic` 与 `product` 两个模块
断言，**不 import t7_support**（源文件对它的依赖正是从 cli 那条链路来的）。

⚠️ 隔离语义（synthetic=True 改写落盘路径）是**本项目新增的行为，源项目没有**。
源项目把隔离放在 cli.run_pipeline 里算路径，`product.write_timeseries` 的
`synthetic` 形参只往文件头写两行标记；实测记录见 product.py 顶部注释。
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fieldstation import model, synthetic
from fieldstation.store import product


def _tec_record(t: synthetic.Truth) -> model.TecRecord:
    """用一条真值造一条 TEC 记录（只填必填字段，其余走 model 的默认值）。"""
    return model.TecRecord(
        station=t.station, system=t.system, sv=t.sv, signal_pair="L1C/L2C",
        gps_week=t.gps_week, gps_tow_s=t.gps_tow_s,
        epoch_utc=model.epoch_utc_str(model.gps_to_utc(t.gps_week, t.gps_tow_s, 18)),
        sTEC_TECU=t.stec_true_TECU, vTEC_TECU=t.stec_true_TECU, deltaT_TECU=0.0,
        level_offset_TECU=0.0, arc_id=0, quality_flag=0, algorithm="",
    )


class TestReproducibility(unittest.TestCase):
    def test_same_config_same_sha256(self):
        cfg = synthetic.default_cfg()
        h1 = product.config_hash(cfg)
        h2 = product.config_hash(cfg)
        self.assertEqual(h1, h2)
        self.assertEqual(len(h1), 64)          # SHA256 十六进制

    def test_different_config_different_hash(self):
        self.assertNotEqual(product.config_hash(synthetic.default_cfg()),
                            product.config_hash(synthetic.default_cfg(elev_cutoff_deg=20.0)))

    def test_fixture_seed_is_pinned(self):
        """M0 评测 fixture 必须由种子决定，否则回放基线不成立。

        seed 钉死在 20261013（今天的日期，也是本项目 M0 的批次号），
        任何人改它都会让已发布的基线对不上，故用测试锁住。
        """
        self.assertEqual(synthetic.default_cfg()["seed"], 20261013)

    def test_generate_is_deterministic_under_same_seed(self):
        """同 seed 两次生成必须逐字节相同 —— 这是「回归基线能回放」的前提。

        同时反向验证 seed 真的在起作用：换种子后首条观测的伪距必须变，
        否则一个「恒返回常量」的假实现也能通过上面的两条断言。
        """
        cfg = synthetic.default_cfg()
        obs1, truth1, m1 = synthetic.generate(cfg)
        obs2, truth2, m2 = synthetic.generate(cfg)

        self.assertEqual(product.config_hash(m1), product.config_hash(m2))
        self.assertEqual(len(obs1), len(obs2))
        self.assertGreater(len(obs1), 0)
        self.assertEqual(obs1[0].to_row(), obs2[0].to_row())
        self.assertEqual(truth1[0], truth2[0])

        obs3, _, _ = synthetic.generate(synthetic.default_cfg(seed=1))
        self.assertEqual(len(obs1), len(obs3))
        self.assertNotEqual(obs1[0].psr_m, obs3[0].psr_m, "seed 没有真正作用于观测")


class TestFixtureContent(unittest.TestCase):
    """默认 fixture 必须带**已知异常**，否则 M0 拿不到可判分的评测集。"""

    def _l1_cycles(self, cfg) -> list:
        obs, _, _ = synthetic.generate(cfg)
        return [o.adr_cycles for o in obs
                if o.system == "GPS" and o.sv == 1 and o.signal == "L1"]

    def test_default_fixture_carries_injected_perturbation(self):
        """default_cfg 默认在 index=400 给 GPS/sv=1/L1 一次单历元相位扰动。

        二阶差分 q[i+1] - 2*q[i] + q[i-1] 把平滑的 ADR 趋势（约 +788 cycles/s）
        消掉，剩下的就是扰动本身：注入量只加在被指定的那一行上，
        故此处应读到 -2 * jump_cycles = -2.0 cycle。
        噪声 sigma_phase_cyc = 0.01 -> 二阶差分 sigma = sqrt(6)*0.01 = 0.024，
        门限 0.3 约合 12 sigma，不会偶发。
        """
        cfg = synthetic.default_cfg()
        q = self._l1_cycles(cfg)
        i = cfg["slips"][0]["index"]
        d2 = q[i + 1] - 2.0 * q[i] + q[i - 1]
        self.assertAlmostEqual(-2.0, d2, delta=0.3, msg=f"注入的扰动没读到，实测 {d2}")

    def test_perturbation_is_traceable_to_config(self):
        """去掉 slips 配置扰动就消失 —— 证明上面的异常来自配置而非数值噪声。"""
        with_slip = self._l1_cycles(synthetic.default_cfg())
        without = self._l1_cycles(synthetic.default_cfg(slips=[]))
        self.assertEqual(len(with_slip), len(without))
        i = synthetic.default_cfg()["slips"][0]["index"]
        self.assertAlmostEqual(
            -2.0, with_slip[i + 1] - 2.0 * with_slip[i] + with_slip[i - 1], delta=0.3)
        self.assertAlmostEqual(
            0.0, without[i + 1] - 2.0 * without[i] + without[i - 1], delta=0.3)


class TestCsvRoundTrip(unittest.TestCase):
    """三个 CSV 接口的往返：合成观测落盘 -> 读回 -> 逐字段相同。"""

    def setUp(self):
        self.obs, self.truth, _ = synthetic.generate(synthetic.default_cfg())
        self.base = Path(tempfile.mkdtemp())

    def test_observations_round_trip(self):
        p = synthetic.write_observations_csv(self.obs, self.base / "obs.csv")
        head = p.read_text(encoding="utf-8").splitlines()[:2]
        self.assertEqual([f"# {synthetic.SYNTHETIC_MARKER}",
                          f"# {synthetic.SYNTHETIC_TAG}"], head)
        back = synthetic.read_observations_csv(p)
        self.assertEqual(len(self.obs), len(back))
        self.assertEqual(self.obs[0].to_row(), back[0].to_row())
        self.assertEqual(self.obs[-1].to_row(), back[-1].to_row())

    def test_truth_csv_has_marker_and_columns(self):
        p = synthetic.write_truth_csv(self.truth, self.base / "truth.csv")
        lines = p.read_text(encoding="utf-8").splitlines()
        self.assertEqual([f"# {synthetic.SYNTHETIC_MARKER}",
                          f"# {synthetic.SYNTHETIC_TAG}"], lines[:2])
        self.assertEqual("station,system,sv,gps_week,gps_tow_s,stec_true_TECU,"
                         "elev_deg,azim_deg", lines[2])
        self.assertEqual(len(self.truth) + 3, len(lines))

    def test_empty_observation_list_still_writes_header(self):
        """空列表时不能崩，且仍要带合成标记（0 行也是合成产物）。"""
        p = synthetic.write_observations_csv([], self.base / "empty.csv")
        self.assertEqual([], synthetic.read_observations_csv(p))


class TestSyntheticIsolation(unittest.TestCase):
    def test_synthetic_flag_changes_output_path(self):
        obs, truth, _ = synthetic.generate(synthetic.default_cfg())
        t = truth[0]
        rec = _tec_record(t)
        base = Path(tempfile.mkdtemp())
        real = product.write_timeseries([rec], base / "out.csv", synthetic=False)
        syn = product.write_timeseries([rec], base / "out.csv", synthetic=True)
        self.assertNotEqual(real.name, syn.name)
        self.assertTrue(syn.parent.name.startswith("synthetic"))

    def test_isolation_is_idempotent(self):
        """已经是 SYNTHETIC_ 前缀的路径不被二次加前缀，隔离不会叠加成
        SYNTHETIC_SYNTHETIC_...。"""
        rec = _tec_record(synthetic.generate(synthetic.default_cfg())[1][0])
        base = Path(tempfile.mkdtemp())
        once = product.write_timeseries([rec], base / "out.csv", synthetic=True)
        twice = product.write_timeseries([rec], once, synthetic=True)
        self.assertEqual(once, twice)

    def test_real_path_is_left_alone(self):
        """synthetic=False 时路径逐字符不变 —— 隔离不能反过来污染真实产物。"""
        rec = _tec_record(synthetic.generate(synthetic.default_cfg())[1][0])
        base = Path(tempfile.mkdtemp())
        got = product.write_timeseries([rec], base / "tec_ts" / "runA_tec.csv",
                                       synthetic=False)
        self.assertEqual(base / "tec_ts" / "runA_tec.csv", got)

    def test_marker_only_written_for_synthetic(self):
        """源项目既有行为保留：标记写进文件头，且只对合成产物写。"""
        rec = _tec_record(synthetic.generate(synthetic.default_cfg())[1][0])
        base = Path(tempfile.mkdtemp())
        real = product.write_timeseries([rec], base / "real.csv", synthetic=False)
        syn = product.write_timeseries([rec], base / "syn.csv", synthetic=True)
        self.assertNotIn(synthetic.SYNTHETIC_MARKER, real.read_text(encoding="utf-8"))
        head = syn.read_text(encoding="utf-8")[:300]
        self.assertIn(synthetic.SYNTHETIC_MARKER, head)
        self.assertIn(synthetic.SYNTHETIC_TAG, head)

    def test_write_json_isolated_and_tagged(self):
        base = Path(tempfile.mkdtemp())
        real = product.write_json({"a": 1}, base / "qc.json", synthetic=False)
        syn = product.write_json({"a": 1}, base / "qc.json", synthetic=True)
        self.assertEqual(base / "qc.json", real)
        self.assertEqual("synthetic", syn.parent.name)
        self.assertTrue(syn.name.startswith(synthetic.SYNTHETIC_TAG))
        self.assertNotIn("_synthetic_note", json.loads(real.read_text(encoding="utf-8")))
        self.assertEqual(
            synthetic.SYNTHETIC_MARKER,
            json.loads(syn.read_text(encoding="utf-8"))["_synthetic_note"])

    def test_manifest_isolated_and_self_consistent(self):
        rec = _tec_record(synthetic.generate(synthetic.default_cfg())[1][0])
        base = Path(tempfile.mkdtemp())
        ts = product.write_timeseries([rec], base / "tec_ts" / "runA_tec.csv",
                                      synthetic=True)
        man_path = product.write_manifest(
            base / "manifest" / "runA_manifest.json",
            run_id="runA", cfg=synthetic.default_cfg(), inputs=[],
            outputs=[product.describe_output(ts, rows=1)],
            synthetic=True, started_at=product.utcnow_iso(),
            finished_at=product.utcnow_iso())
        self.assertEqual("synthetic", man_path.parent.name)
        man = json.loads(man_path.read_text(encoding="utf-8"))
        self.assertTrue(man["synthetic"])
        self.assertEqual(product.config_hash(synthetic.default_cfg()), man["config_hash"])
        # describe_output 必须喂 write_* 的返回值：它自己不知道 synthetic 标志
        self.assertEqual(product.sha256_file(ts), man["outputs"][0]["sha256"])
        self.assertEqual(1, man["outputs"][0]["rows"])
        self.assertIn("python", man["env"])


if __name__ == "__main__":
    unittest.main()
