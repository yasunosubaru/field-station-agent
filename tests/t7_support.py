"""T7b 测试共用工具（非测试模块，unittest 不会收集）。

只依赖标准库与 fieldstation 自身；不做任何真实数据假设。
合成数据仅用于验证流程与代码自洽性。

本文件由原项目同名文件**缩减**而来：只保留不依赖「本项目不搬运」模块
（反演、映射、轨道与电离层产品读取、合成数据生成）的构造助手。
原文件为让 `import t7_support` 在任意 cwd 下可用而插入 sys.path 的两行，
本仓库不需要 —— 包根由固定的测试命令 `PYTHONPATH="src"` 提供。
`make_pairs` 为本项目新增（原项目把等价逻辑放在 `test_qc_wiring.py` 的
`_mk_obs` 里，而该文件要重写），故提到此处共用。
"""
from __future__ import annotations

from fieldstation import constants, model


def make_observation(**over) -> model.Observation:
    """构造一条默认合法的 GPS L1 观测；``over`` 覆盖任意字段。"""
    base = dict(
        station="S", receiver_id="R", gps_week=2300, gps_tow_s=1.0,
        system="GPS", sv=1, signal="L1", freq_hz=constants.get_freq("GPS", "L1"),
        psr_m=2.2e7, adr_cycles=1.0e6, doppler_hz=0.0, cn0_dbhz=45.0,
        elev_deg=45.0, azim_deg=100.0,
    )
    base.update(over)
    return model.Observation(**base)


def make_pairs(n: int, gap_after: int | None = None, gap_extra: float = 0.0,
               t0: float = 0.0, dt: float = 30.0,
               sv: int = 1) -> dict[tuple, list[model.EpochPair]]:
    """造 ``n`` 个历元自洽的双频 GPS 观测，按 (station, system, sv) 配成序列。

    原项目把这段逻辑写在 `test_qc_wiring.py::_mk_obs`，本文件要重写，
    故提为共用工具。要点（都踩过）：

    * **时间必须真跳**。只改模糊度不改时间戳，qc 看到的是连续序列，
      自然不切段 —— 那复现不出「跨空档算模糊度」这个症状。
      ``gap_after`` 之后的历元相对前一段额外后移 ``gap_extra`` 秒。
    * adr 符号约定：cfg 用 ``adr_sign="adr"``，对应 s = -1
      （``constants.meas_cycle_sign("adr")``），所以 adr 要取负。
    * 码与相位必须严格一致，否则配对组合算不出有效值。
    """
    lam1 = constants.C_LIGHT / 1575.42e6
    lam2 = constants.C_LIGHT / 1227.60e6
    out = []
    t = t0
    for i in range(n):
        if gap_after is not None and i == gap_after:
            t += gap_extra          # **真时间间断**
        psr = 2.2e7 + 1.0 * t
        base = dict(station="TST", receiver_id="", gps_week=2300,
                    gps_tow_s=100000.0 + t, system="GPS", sv=sv,
                    elev_deg=45.0, azim_deg=180.0, sys_code=0, sig_code=0)
        out.append(model.Observation(
            signal="L1", freq_hz=1575.42e6, psr_m=psr,
            adr_cycles=-(psr / lam1), doppler_hz=float("nan"),
            cn0_dbhz=45.0, **base))
        out.append(model.Observation(
            signal="L2", freq_hz=1227.60e6, psr_m=psr,
            adr_cycles=-(psr / lam2), doppler_hz=float("nan"),
            cn0_dbhz=42.0, **base))
        t += dt
    return model.pair_observations(out)
