"""T7b 测试共用工具（非测试模块，unittest 不会收集）。

只依赖标准库与 fieldstation 自身；不做任何真实数据假设。
合成数据仅用于验证流程与代码自洽性。

本文件由原项目同名文件**缩减**而来：只保留不依赖「本项目不搬运」模块
（反演、映射、轨道与电离层产品读取、质控、合成数据生成）的构造助手。
原文件为让 `import t7_support` 在任意 cwd 下可用而插入 sys.path 的两行，
本仓库不需要 —— 包根由固定的测试命令 `PYTHONPATH="src"` 提供。
后续任务按需在此扩展。
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
