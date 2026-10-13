"""物理常量、频点表、组合系数与 quality_flag 位定义。

约定（T1 / T4 已定，不要改数值）：
  * 色散常数固定 K = 40.3 m^3/s^2（不用 SI 导出的 40.308），以与基线逐字节对拍。
  * k_P = (1/1e16) * f1^2 f2^2 / (K (f1^2 - f2^2))，单位 TECU/m。
  * 基线里的 120/154/118/152.6 是相对 10.23 MHz 的倍频信道号，不是波长。

本模块只用标准库。
"""
from __future__ import annotations

import math

# ---------------------------------------------------------------- 物理守卫
# 电离层只对群延迟做**正**延迟，故 k_P (P2 - P1) 在物理上不可能显著为负。
# 下限以**组合自身的噪声**为单位定，不写死绝对数：
#   sigma_teca = k_P * sigma_psr * sqrt(2)
#   floor      = -TEC_PHYS_FLOOR_K_SIGMA * sigma_teca
# 25 的依据：默认 sigma_psr_m = 0.3 m -> sigma_teca = 9.5196*0.3*1.4142 = 4.039
# TECU -> floor = -100.97 TECU。真实数据的正常负噪声只有 +-4 TECU（1 sigma），
# 即 floor 距 0 有 25 sigma，**不会误伤真实数据**；它只拦真正不物理的输入
# （需要负的电子含量才会落到 floor 以下）。
TEC_PHYS_FLOOR_K_SIGMA = 25.0

# ---------------------------------------------------------------- 基本常量
C_LIGHT = 299792458.0          # 真空光速 (m/s)
K = 40.3                       # 色散常数 (m^3/s^2)，固定值，见 T1 结论 1
Re = 6371000.0                 # 地球平均半径 (m)，单层映射用，见 T4
TECU = 1.0e16                  # 1 TECU = 1e16 el/m^2
REF_CHANNEL_HZ = 10.23e6       # 倍频基准 10.23 MHz

# ---------------------------------------------------------------- 频点表
# 键：(system, signal) -> 频率 (Hz)
FREQ_HZ = {
    ("GPS", "L1"): 1575.42e6,
    ("GPS", "L2"): 1227.60e6,
    ("BDS", "B1I"): 1561.098e6,
    ("BDS", "B2I"): 1207.14e6,
}
WAVELENGTH_M = {key: C_LIGHT / f for key, f in FREQ_HZ.items()}

# 各系统的默认频点对：f1 为高频（相位超前的参考），f2 为低频
DEFAULT_PAIR = {
    "GPS": ("L1", "L2"),
    "BDS": ("B1I", "B2I"),
}

# ---------------------------------------------------------------- quality_flag 位
BIT_LOW_ELEV = 1 << 0          # bit0 高度角低
BIT_LOW_CN0 = 1 << 1           # bit1 CN0 低
BIT_SLIP = 1 << 2              # bit2 周跳
BIT_NO_PAIR = 1 << 3           # bit3 无配对
BIT_PSR_BAD = 1 << 4           # bit4 伪距异常
BIT_PHASE_BAD = 1 << 5         # bit5 相位异常
BIT_GAP = 1 << 6             # bit6 采样断点
BIT_DCB_UNKNOWN = 1 << 7     # bit7 差分码偏差未知（Bias-SINEX 无对应记录，dcb=NaN）

FLAG_NAMES = {
    BIT_LOW_ELEV: "low_elev",
    BIT_LOW_CN0: "low_cn0",
    BIT_SLIP: "slip",
    BIT_NO_PAIR: "no_pair",
    BIT_PSR_BAD: "psr_bad",
    BIT_PHASE_BAD: "phase_bad",
    BIT_GAP: "gap",
    BIT_DCB_UNKNOWN: "dcb_unknown",
}

MISSING = float("nan")         # 缺测一律 NaN，禁止用 0 代替


def flags_to_list(flag: int) -> list[str]:
    """把整型 quality_flag 展开成命名的置位列表（按低位到高位）。"""
    return [name for bit, name in sorted(FLAG_NAMES.items()) if flag & bit]


def get_freq(system: str, signal: str) -> float:
    try:
        return FREQ_HZ[(system, signal)]
    except KeyError as exc:  # pragma: no cover - 输入错误路径
        raise KeyError(f"未知频点 ({system!r}, {signal!r})") from exc


def get_wavelength(system: str, signal: str) -> float:
    return C_LIGHT / get_freq(system, signal)


def relative_channel(freq_hz: float) -> float:
    """相对 10.23 MHz 的信道号（L1=154、L2=120、B1I=152.6、B2I=118）。"""
    return freq_hz / REF_CHANNEL_HZ


def k_P(system: str, K_const: float = K, pair: tuple[str, str] | None = None) -> float:
    """几何无关码组合系数 k_P，单位 TECU/m。

    k_P = (1/1e16) * f1^2 f2^2 / (K (f1^2 - f2^2))
    GPS(L1/L2) ~= 9.5196，BDS(B1I/B2I) ~= 8.9932。
    """
    s1, s2 = pair if pair is not None else DEFAULT_PAIR[system]
    f1 = get_freq(system, s1)
    f2 = get_freq(system, s2)
    if f1 == f2:
        raise ValueError("f1 == f2，几何无关组合退化")
    return (1.0 / TECU) * (f1 * f1) * (f2 * f2) / (K_const * (f1 * f1 - f2 * f2))


def meas_cycle_sign(adr_sign: str) -> float:
    """把观测的 cycle 值换算为教科书载波相位所需的分号。

    基线相位组合用 (L2 - L1)，与教科书 (L1 - L2) 符号相反，因为 adr_cycles 实为
    累积多普勒范围 ADR（随距离减小而增大）。等价于 T4 的 s 开关：
      adr_sign == 'adr'   -> 该值需取负才能得到教科书相位
      adr_sign == 'phase' -> 直接就是教科书相位

    返回 +1 表示直接用，-1 表示取负。
    """
    if adr_sign == "adr":
        return -1.0
    if adr_sign == "phase":
        return 1.0
    raise ValueError(f"未知 adr_sign={adr_sign!r}（应为 'adr' 或 'phase'）")


def first_order_delay_per_tecu(system: str = "GPS", signal: str = "L1") -> float:
    """1 TECU 在给定频点造成的首阶群延迟 (m)。L1 ~= 0.162 m。"""
    f = get_freq(system, signal)
    return K / (f * f) * TECU


def dcb_ns_to_tecu(ns: float, system: str = "GPS", pair: tuple[str, str] | None = None) -> float:
    """差分码偏差 1 ns 折合多少 TECU。GPS ~= 2.85 TECU/ns。"""
    return k_P(system, pair=pair) * (C_LIGHT * abs(ns) * 1e-9)


def self_check(raise_on_fail: bool = True) -> dict:
    """模块级数值自检：k_P、首阶延迟、DCB 量纲锚点。返回实测值。"""
    results = {
        "k_P_GPS": k_P("GPS"),
        "k_P_BDS": k_P("BDS"),
        "delay_per_TECU_L1_m": first_order_delay_per_tecu("GPS", "L1"),
        "dcb_1ns_TECU": dcb_ns_to_tecu(1.0, "GPS"),
        "channel_L1": relative_channel(get_freq("GPS", "L1")),
        "channel_L2": relative_channel(get_freq("GPS", "L2")),
        "channel_B1I": relative_channel(get_freq("BDS", "B1I")),
        "channel_B2I": relative_channel(get_freq("BDS", "B2I")),
    }
    ok = True
    checks = [
        (abs(results["k_P_GPS"] - 9.5196) < 5e-4, "k_P(GPS) 应为 9.5196"),
        (abs(results["k_P_BDS"] - 8.9932) < 5e-4, "k_P(BDS) 应为 8.9932"),
        (abs(results["delay_per_TECU_L1_m"] - 0.162) < 1e-3, "1 TECU@L1 首阶延迟应 ~= 0.162 m"),
        (abs(results["dcb_1ns_TECU"] - 2.85) < 0.01, "1 ns DCB 应 ~= 2.85 TECU"),
        (abs(results["channel_L1"] - 154.0) < 1e-6, "L1 信道号应为 154"),
        (abs(results["channel_L2"] - 120.0) < 1e-6, "L2 信道号应为 120"),
    ]
    for cond, msg in checks:
        results.setdefault("checks", []).append({"ok": bool(cond), "msg": msg})  # type: ignore[attr-defined]
        ok = ok and cond
    results["ok"] = ok
    if raise_on_fail and not ok:
        raise AssertionError(f"constants.self_check 失败: {results}")
    return results
