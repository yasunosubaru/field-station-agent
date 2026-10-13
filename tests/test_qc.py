#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""质量控制：周跳检测（GF/M-W 两法取或）、门槛、粗差、断点切分。

对应源项目 T4 的 T-02 / T-03 / T-07 / T-08 / T-09 / T-10 / T-11。

## 与源文件的差异（全部由「本项目不搬哪些模块」推出）

源文件里 `inversion`（源项目的反演模块，spec §1.4 明确不搬）与
`product` / `synthetic`（Task 5 才落地）承担了夹具与断言，本项目此刻都拿不到。
因此本文件：

* 用 `t7_support.make_pairs` + 就地改 `Observation` 取代 `t7_support.run(steps=...)`
  与 `synth_cfg(...)`；
* 断言落在 `qc.run_qc` 写回的 `EpochPair.quality_flag` / `arc_id` 与
  `qc.detect_slips` 的诊断上，取代「反演输出与合成真值之差」那一层；
* **不迁移 `TestJumpDetectionRate`** —— 它标定的是
  `t7_support.jump_detection_experiment`（内部调用 `synthetic.generate`）
  这台合成器，`rate >= 0.95` 这个门限是**对那台合成器的噪声模型标定的**，
  换一台合成器就不再是同一个数。真实阶跃的单点检出能力由
  `test_slips_sigma.py` 钉住（逐字搬运，未改断言）；但**聚合检出率未被替代**
  （`test_slips_sigma` 测的是 3 种配置下的单点检出，不是 20 次随机注入的检出率）。

## 延后清单（Task 5 `product` / `inversion` 落地后补回）

* **T07 / T08 的第三段断言**：原版 `test_bit0_and_excluded_from_leveling` /
  `test_bit1_and_excluded_from_leveling` 各有三段，被丢掉的是第三段 ——
  「低仰角 / 低 CN0 历元不参与定平、不产出有限 `sTEC`」，即
  **"打了标记 ⟹ 一定不会流到消费方"**。本项目没有消费方，**测不了**，
  故把测试名改成 `..._and_flagged`（名字不再声称测了它）。
  Task 5 有了 `run_inversion` 之后要回来补这两条。
* **JR 的聚合检出率实验**：`test_true_step_rate_is_high`（真实阶跃检出率 >= 0.95）。
  这是一条**产品级要求**，与合成器无关，故是真损失而不只是延后；
  需要一个可重复的随机注入发生器（Task 5 的 `synthetic` 提供）。
* **T11 附近的近邻误检**（见 T10）：本夹具下 GF 会在尖峰后 3 个历元报一个
  近邻误点（实测 `[603]`）。原版结构相同（只看 `records_at(600)`），不算回归；
  换成 `synthetic.generate` 后是否还这样，**未知** —— Task 5 换夹具时要复查。
"""
from __future__ import annotations

import unittest

from fieldstation import constants as C
from fieldstation.rules import qc
from tests import t7_support

#: `run_qc(pairs_by_key, cfg)` 的 cfg 是 **dict**（源实现内部调 `cfg.get(...)`），
#: 传 `QCConfig` 实例会抛 AttributeError。空 dict 落到
#: `default_qc_config` 的硬编码默认值。
_CFG: dict = {}

#: 与源项目 `synth_cfg` 的默认 `n_epochs` 一致，保证历元下标可比。
N_EPOCHS = 1200


def _series(pairs, sv=1):
    return pairs[("TST", "GPS", sv)]


def _inject_step(series, signal, index, jump_cycles):
    """注入**真实**周跳（模糊度阶跃，持续到弧段末尾）。就地修改。"""
    for ep in series[index:]:
        ep.get(signal).adr_cycles += float(jump_cycles)


def _perturb(series, signal, index, *, psr_delta=0.0, adr_delta=0.0):
    """只在第 ``index`` 个历元给 ``signal`` 打一个单历元粗差。"""
    ob = series[index].get(signal)
    ob.psr_m += psr_delta
    ob.adr_cycles += adr_delta


def _noise(series, signal, *, psr_amp=0.0, adr_amp=0.0):
    """给整条序列加**逐历元交替**的确定性抖动。

    `qc.robust_z` 的尺度来自 MAD；序列完全平直时 MAD 恰为 0，粗差检测会
    整体失效（`robust_z` 返回全 NaN）。源项目靠 `synthetic` 的噪声项提供
    这个基准，此处用固定幅值的交替抖动替代 —— 没有随机数，可复现。
    """
    for i, ep in enumerate(series):
        s = 1.0 if i % 2 else -1.0
        ob = ep.get(signal)
        ob.psr_m += s * psr_amp
        ob.adr_cycles += s * adr_amp


def _detect(series):
    """在一条序列上跑周跳检测（源项目 `t7_support.detect` 的等价物）。"""
    s1, s2 = C.DEFAULT_PAIR["GPS"]
    cfg = qc.default_qc_config({})
    return qc.detect_slips(series, "GPS", s1, s2,
                           C.meas_cycle_sign("adr"), cfg)


def _run(series_setup=None, sv=1):
    """造序列 -> 可选注入 -> 跑 qc.run_qc，返回 (pairs, series, report)。"""
    pairs = t7_support.make_pairs(n=N_EPOCHS, sv=sv)
    series = _series(pairs, sv)
    if series_setup is not None:
        series_setup(series)
    return pairs, series, qc.run_qc(pairs, _CFG)


class TestT02SlipDetectAndSegment(unittest.TestCase):
    """T-02：弧段中央注入**真实阶跃**单频周跳（L1 +5 周）。"""

    STEPS = [("GPS", 1, "L1", 600, 5.0)]

    def _with_steps(self):
        def setup(series):
            for _system, sv, signal, index, jump in self.STEPS:
                _inject_step(series, signal, index, jump)
        return _run(setup, sv=self.STEPS[0][1])

    def test_slip_detected_near_injection(self):
        _pairs, series, _rep = self._with_steps()
        _slips, diag = _detect(series)
        raw = set(diag["slip_indices_raw"])
        self.assertTrue(any(abs(600 - x) <= 2 for x in raw),
                        f"未在 600 附近检出周跳 raw={sorted(raw)}")

    def test_arc_is_split(self):
        _pairs, _series_, rep = self._with_steps()
        self.assertGreaterEqual(rep["series"][0]["n_arcs"], 2,
                                "周跳后弧段应被切开")

    def test_bit2_flag_on_slip_epoch(self):
        """周跳历元要置 BIT_SLIP(bit2)，供下游区分「周跳」与「采样断点」。"""
        _pairs, series, _rep = self._with_steps()
        self.assertTrue(series[600].quality_flag & C.BIT_SLIP,
                        f"bit2 未置位 flag={series[600].quality_flag}")

    def test_no_spurious_extra_splits(self):
        """单个阶跃只切一刀；GF 多项式外推曾实测切出 [600,602,604]。"""
        _pairs, series, _rep = self._with_steps()
        _slips, diag = _detect(series)
        self.assertEqual(len(diag["slip_indices"]), 1,
                         f"单周跳应只有 1 个切点，实测 {diag['slip_indices']}")


class TestT03WideLaneSlip(unittest.TestCase):
    """T-03：宽巷跳变（L1 +77 周、L2 +60 周，几何无关组合精确抵消）。"""

    STEPS = [("GPS", 1, "L1", 600, 77.0), ("GPS", 1, "L2", 600, 60.0)]

    def _with_steps(self):
        def setup(series):
            for _system, sv, signal, index, jump in self.STEPS:
                _inject_step(series, signal, index, jump)
        return _run(setup, sv=1)

    def test_gf_blind_mw_fires(self):
        _pairs, series, _rep = self._with_steps()
        _slips, diag = _detect(series)
        self.assertEqual(diag["n_slip_gf"], 0, "GF 组合应对宽巷跳变不敏感")
        self.assertGreaterEqual(diag["n_slip_mw"], 1, "M-W 组合应检出宽巷跳变")
        self.assertTrue(diag["slip_indices"], "两法取或后应非空")

    def test_or_logic_union_contains_jump(self):
        _pairs, series, _rep = self._with_steps()
        _slips, diag = _detect(series)
        found = set(diag["slip_indices"]) | set(diag["slip_indices_raw"])
        self.assertTrue(any(abs(600 - x) <= 2 for x in found), sorted(found))


class TestT07LowElevation(unittest.TestCase):
    def test_bit0_and_flagged(self):
        def setup(series):
            for ep in series:
                for ob in ep.obs.values():
                    ob.elev_deg = 5.0
        _pairs, series, rep = _run(setup)
        self.assertGreater(rep["series"][0]["flags"]["low_elev"], 0)
        self.assertTrue(all(ep.quality_flag & C.BIT_LOW_ELEV for ep in series),
                        "全部历元低于 15° 仰角掩膜，必须逐个置 bit0")


class TestT08LowCN0(unittest.TestCase):
    def test_bit1_and_flagged(self):
        def setup(series):
            for ep in series:
                ep.get("L1").cn0_dbhz = 20.0
        _pairs, series, rep = _run(setup)
        self.assertGreater(rep["series"][0]["flags"]["low_cn0"], 0)
        self.assertTrue(all(ep.quality_flag & C.BIT_LOW_CN0 for ep in series),
                        "全部历元 CN0 低于 30 dB-Hz，必须逐个置 bit1")


class TestT09PseudorangeOutlier(unittest.TestCase):
    def test_bit4_and_no_pollution(self):
        """伪距粗差：命中历元置 bit4，其余历元不扩散。

        ## 度量对象换过（原版量物理量，这里量标记面）

        原版第二段断言是 `residual_stats(...)` 的 `rms < 1.0 TECU` ——
        「其余历元**反演出的** sTEC 与合成真值之差」没被污染。
        本项目没有反演，改为「其余历元都没有 `BIT_PSR_BAD`」。

        **这个替代是有代价的**，两者不等价：「数据被破坏却没打标记」的 bug 现在
        能一路绿灯通过 —— 例如 `robust_z` 的 MAD 尺度估计被破坏、z 分数整体
        偏低，会导致**所有**粗差漏检，而本测试仍绿（它只看 600 是否亮）。
        在本项目 `quality_flag` 就是交给下游的契约，所以这是可辩护的降级，
        但别把它当成原来那个测试。
        """
        def setup(series):
            _noise(series, "L2", psr_amp=0.05)      # 给 robust_z 一个尺度基准
            _perturb(series, "L1", 600, psr_delta=1.0e6)
        _pairs, series, _rep = _run(setup)
        self.assertTrue(series[600].quality_flag & C.BIT_PSR_BAD,
                        f"bit4 未置位 flag={series[600].quality_flag}")
        others = [ep for i, ep in enumerate(series) if i != 600]
        self.assertFalse(any(ep.quality_flag & C.BIT_PSR_BAD for ep in others),
                         "单历元伪距粗差不得污染弧段其余历元")


class TestT10PhaseOutlier(unittest.TestCase):
    def test_bit5_and_no_pollution(self):
        """相位尖峰：命中历元置 bit5、不判成周跳（bit2），其余历元不扩散。

        ## 度量对象换过 —— 同 T09，代价一样

        原版第二段断言量的是物理量（其余历元反演 sTEC 与真值之差 rms < 1.0 TECU），
        这里改成「其余历元都没有 `BIT_PHASE_BAD`」。`robust_z` 的 MAD 尺度
        被破坏导致全量粗差漏检这一类 bug，本测试看不见。

        ## 已知近邻误检（不是本次重写引入，原版结构相同）

        本夹具下 `detect_slips` 会在 603 报一个 GF 近邻误点（实测 `[603]`、
        `n_slip_gf=1`），而本测试只断言 600 没有 `BIT_SLIP`，故不拦它。
        原版也只看 `records_at(600)`，结构一致，不算回归。Task 5 换夹具时要复查。
        """
        # 单历元巨大相位残差（尖峰）；应判为 bit5，而非周跳
        def setup(series):
            _noise(series, "L1", adr_amp=1.0e-6)     # 给 robust_z 一个尺度基准
            _perturb(series, "L1", 600, adr_delta=1000.0)
        _pairs, series, _rep = _run(setup)
        flag = series[600].quality_flag
        self.assertTrue(flag & C.BIT_PHASE_BAD, f"bit5 未置位 flag={flag}")
        self.assertFalse(flag & C.BIT_SLIP,
                         "单历元尖峰会立刻回到基线，按设计不该判成周跳")
        others = [ep for i, ep in enumerate(series) if i != 600]
        self.assertFalse(any(ep.quality_flag & C.BIT_PHASE_BAD for ep in others),
                         "单历元相位粗差不得污染其它历元")


class TestT11SamplingGap(unittest.TestCase):
    def test_bit6_and_new_arc(self):
        """断点分支：dt 不是采样间隔的普通倍数（> 1.5 x 30 = 45 s）时切段并置 bit6。

        走**完整 `run_qc` 管线**，与原版同构 —— 这是 bit6 唯一的端到端腿。

        ## 为什么这条夹具上周跳检测必然是空的（曾经的错误论断就栽在这里）

        本夹具里 `psr = 2.2e7 + 1.0*t`、`adr_cycles = -(psr/lam)`，且 L1/L2 的 psr
        相同。于是两个几何无关组合对**共模**不敏感，时间间断对它们不可见：

        * ILR = k_P*(lam1*x1 - lam2*x2)，而 x1 = x2 = psr -> 恒 0（实测逐历元 0.0）。
          GF 路 `sigma_gf_window.n_zero = 115`（全部退化到 1.0 TECU 物理地板），
          残差恒 0，低于 `slip_min_jump_tecU`。
        * MW 的 psr 项在 term1/term2 里相消，同样只看 L1/L2 的 adr-psr **失配**；
          失配为 0 时 MW 只剩浮点舍入（本夹具实测 ~1.7e-8 TECU，
          `sigma_mw` = 1.66e-8、判据被 `slip_min_jump_tecU = 0.5` 兜底）。

        所以**任何大小的间断都不会被判成周跳**（已扫 16 s ~ 1e6 s，10/10 零 slip、
        10/10 `BIT_GAP=True`）。曾经这里写的是「M-W 会把间断判成宽巷跳变」——
        那句话忽略了共模相消，是错的，已删除。

        下面的 `assertEqual(diag["slip_indices"], [])` 是这条论断的**可证伪守卫**：
        夹具或 qc 一变、断点分支真被遮蔽时，测试会先自己报红，
        而不是等人用一句注释把原因盖过去。
        """
        pairs = t7_support.make_pairs(n=120, gap_after=60, gap_extra=60.0)
        series = _series(pairs)
        _slips, diag = _detect(series)
        self.assertEqual(diag["slip_indices"], [],
                         "该夹具上不该有任何周跳；若有，BIT_GAP 会被 slip 分支盖住")

        rep = qc.run_qc(pairs, _CFG)
        self.assertGreaterEqual(rep["series"][0]["n_arcs"], 2,
                                "断点后应切成 >=2 段弧")
        a_after = series[60]
        self.assertTrue(a_after.quality_flag & C.BIT_GAP, "断点后首个历元应置 bit6")
        self.assertGreater(a_after.arc_id, series[59].arc_id,
                           "arc_id 应在断点处递增")


if __name__ == "__main__":
    unittest.main()
