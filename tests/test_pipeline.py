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


def _syn_path(base: Path, name: str) -> Path:
    """合成 CSV 的落盘 helper：路径固定落在名字以 synthetic 开头的隔离目录下。

    `write_observations_csv` / `write_truth_csv` 没有 `synthetic` 形参
    （搬运件签名，不许加），隔离只能靠调用方给对路径。本模块凡调这两个函数
    一律经由此 helper 落盘，约定由 `test_synthetic_csv_paths_stay_isolated` 钉住。
    """
    return base / "synthetic" / name


class TestReproducibility(unittest.TestCase):
    def test_same_config_same_sha256(self):
        cfg = synthetic.default_cfg()
        h1 = product.config_hash(cfg)
        h2 = product.config_hash(cfg)
        self.assertEqual(h1, h2)
        self.assertEqual(len(h1), 64)          # SHA256 十六进制

    def test_config_hash_is_key_order_independent(self):
        """`sort_keys=True` 是「基线哈希跨构造顺序稳定」的全部依据，必须有人看守。

        上一条断言把**同一个 dict 对象**哈希两次，只要 config_hash 是纯函数就必然相等
        —— 它防不住任何实现缺陷（删掉 sort_keys=True 它照样绿）。
        而 Task 7/8 一旦从 JSON 读回 cfg、或用不同字面量顺序重建 cfg，
        没有 sort_keys 就会静默算出不同的 config_hash，已发布基线全部对不上且不报错。
        所以这里用**键序不同但内容相同**的两个 dict 来钉它。
        """
        cfg = synthetic.default_cfg()
        reordered = dict(reversed(list(cfg.items())))
        self.assertNotEqual(list(cfg), list(reordered), "本用例的前提：两者键序确实不同")
        self.assertEqual(product.config_hash(cfg), product.config_hash(reordered))
        # 经一趟真实的 JSON 往返再哈希：Task 7/8 的典型重建路径
        self.assertEqual(product.config_hash(cfg),
                         product.config_hash(json.loads(json.dumps(cfg))))

    def test_different_config_different_hash(self):
        # 用**真实生效**的键（stec_base_tecu 被 _stec_true_tecu 直接读取），
        # 不用任务书原文的 elev_cutoff_deg —— 那个键在 generate() 里根本不存在，
        # 拿它做断言只能证明「config_hash 对 dict 内容敏感」，与配置有效性无关。
        self.assertNotEqual(product.config_hash(synthetic.default_cfg()),
                            product.config_hash(synthetic.default_cfg(stec_base_tecu=20.0)))

    def test_task_book_keys_are_inert(self):
        """把「任务书 Step 3 给的那 7 个键是死键」钉成负例。

        这是 default_cfg() 不照抄任务书字典体的依据：若哪天有人「顺手补上」
        elev_cutoff_deg 的实现，这些键会突然开始改变输出，已发布基线静默作废。
        """
        obs_ref, truth_ref, _ = synthetic.generate(synthetic.default_cfg())
        obs_alt, truth_alt, _ = synthetic.generate(synthetic.default_cfg(
            elev_cutoff_deg=20.0, inject_slip_at=1, inject_gap_at=2,
            inject_psr_outlier_at=3, inject_adr_outlier_at=4,
            noise_psr_m=99.0, noise_adr_cycles=99.0))
        self.assertEqual([o.to_row() for o in obs_ref], [o.to_row() for o in obs_alt])
        self.assertEqual(truth_ref, truth_alt)

    def test_fixture_seed_is_pinned(self):
        """M0 评测 fixture 必须由种子决定，否则回放基线不成立。

        seed 钉死在 20261013（今天的日期，也是本项目 M0 的批次号），
        任何人改它都会让已发布的基线对不上，故用测试锁住。
        """
        self.assertEqual(synthetic.default_cfg()["seed"], 20261013)

    def test_default_cfg_is_deep_copied(self):
        """F-7：`default_cfg()` 的嵌套结构必须是不同对象，不能与模块全局共享。

        浅拷贝下 `cfg["sats"] is DEFAULT_SYNTH_CFG["sats"]`，任何人
        `append` 都会污染模块全局、静默改掉已发布基线的 `config_hash`。
        """
        c1 = synthetic.default_cfg()
        c2 = synthetic.default_cfg()
        self.assertIsNot(c1["sats"], synthetic.DEFAULT_SYNTH_CFG["sats"])
        self.assertIsNot(c1["sats"], c2["sats"])
        self.assertIsNot(c1["systems"], synthetic.DEFAULT_SYNTH_CFG["systems"])
        self.assertIsNot(c1["slips"], c2["slips"])
        # 写操作不外溢：改返回的 cfg，模块全局与下一次调用不受影响
        c1["sats"]["GPS"].append(99)
        self.assertNotIn(99, synthetic.DEFAULT_SYNTH_CFG["sats"]["GPS"])
        self.assertNotIn(99, synthetic.default_cfg()["sats"]["GPS"])

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
        p = synthetic.write_observations_csv(self.obs, _syn_path(self.base, "obs.csv"))
        head = p.read_text(encoding="utf-8").splitlines()[:2]
        self.assertEqual([f"# {synthetic.SYNTHETIC_MARKER}",
                          f"# {synthetic.SYNTHETIC_TAG}"], head)
        back = synthetic.read_observations_csv(p)
        self.assertEqual(len(self.obs), len(back))
        self.assertEqual(self.obs[0].to_row(), back[0].to_row())
        self.assertEqual(self.obs[-1].to_row(), back[-1].to_row())

    def test_truth_csv_has_marker_and_columns(self):
        p = synthetic.write_truth_csv(self.truth, _syn_path(self.base, "truth.csv"))
        lines = p.read_text(encoding="utf-8").splitlines()
        self.assertEqual([f"# {synthetic.SYNTHETIC_MARKER}",
                          f"# {synthetic.SYNTHETIC_TAG}"], lines[:2])
        self.assertEqual("station,system,sv,gps_week,gps_tow_s,stec_true_TECU,"
                         "elev_deg,azim_deg", lines[2])
        self.assertEqual(len(self.truth) + 3, len(lines))

    def test_empty_observation_list_still_writes_header(self):
        """空列表时不能崩，且仍要带合成标记（0 行也是合成产物）。"""
        p = synthetic.write_observations_csv([], _syn_path(self.base, "empty.csv"))
        self.assertEqual([], synthetic.read_observations_csv(p))

    def test_synthetic_csv_paths_stay_isolated(self):
        """F-1 约定：本文件凡调 `write_observations_csv` / `write_truth_csv`，
        落盘路径一律经 `_syn_path` 进名字以 synthetic 开头的隔离目录。

        这两个函数没有 `synthetic` 形参（搬运件签名，不许加），隔离只能靠
        调用方给对路径。若后人直接传 `self.base / "x.csv"`，本用例变红。
        """
        import ast
        tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
        offenders = []
        for node in ast.walk(tree):
            if (isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr in ("write_observations_csv", "write_truth_csv")
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "synthetic"):
                arg = node.args[1] if len(node.args) >= 2 else None
                ok = (isinstance(arg, ast.Call) and isinstance(arg.func, ast.Name)
                      and arg.func.id == "_syn_path")
                if not ok:
                    offenders.append(node.lineno)
        self.assertEqual([], offenders,
                         f"这些行的合成 CSV 落盘没走 _syn_path 隔离：{offenders}")
        self.assertTrue(_syn_path(Path("x"), "a.csv").parent.name.startswith("synthetic"))


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
        # 前缀的具体形状也要钉住：`startswith(SYNTHETIC_TAG)` 对
        # "SYNTHETIC_out.csv" 与 "SYNTHETICout.csv" 都成立，分不出对错。
        # 这个下划线是源项目 cli.run_pipeline 的口径，写错了与源项目就对不上。
        self.assertEqual(syn.name, "SYNTHETIC_out.csv")
        self.assertEqual("synthetic", syn.parent.name)

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

    def test_missing_values_written_as_nan_not_zero(self):
        """F-5：搬运件不变量「缺测写 NaN 不写 0」，`_fmt` 是它的唯一执行点。"""
        self.assertEqual(product._fmt(None), "NaN")
        self.assertEqual(product._fmt(float("nan")), "NaN")

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
        self.assertEqual("SYNTHETIC_qc.json", syn.name)
        self.assertNotIn("_synthetic_note", json.loads(real.read_text(encoding="utf-8")))
        self.assertEqual(
            synthetic.SYNTHETIC_MARKER,
            json.loads(syn.read_text(encoding="utf-8"))["_synthetic_note"])

    def test_write_json_pins_lf_line_endings(self):
        """跨平台逐字节一致：文本模式默认在 Windows 写 CRLF。

        M5-1（2026-10-19）发现：归档产物的 sha256 会进入回放 trace（archive_export
        的工具结果被 capture），换行随平台一变，同一条回放在不同宿主机上就得到
        不同的 trace sha —— 回放基线要求同输入在任何宿主机上逐字节相同。写文件
        时钉 ``newline="\\n"`` 是这个前提的落点；本测试在任一平台上都拒收 CRLF。
        """
        base = Path(tempfile.mkdtemp())
        path = product.write_json({"a": 1, "b": [1, 2]}, base / "x.json")
        data = path.read_bytes()
        self.assertNotIn(b"\r\n", data)
        self.assertTrue(data.endswith(b"\n"))

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
