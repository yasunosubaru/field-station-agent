"""统一中间 schema：数据类、字段单位表、输入校验与配对。

字段名沿用 T0 权威名（adr_cycles、azim_deg，不是 adr_cyc / az_deg）。
时间基准：对外 UTC，内部 GPS 周 + 周内秒。坐标系默认 WGS84。
缺测一律 NaN（constants.MISSING），禁止用 0 代替。

本模块只用标准库。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from .constants import MISSING

# GPS 历元：1980-01-06 00:00:00 UTC；闰秒取固定 18 s（来源须记录，这里是配置默认）
GPS_EPOCH = datetime(1980, 1, 6, tzinfo=timezone.utc)
GPS_WEEK_S = 604800.0
DEFAULT_LEAP_S = 18.0


# ---------------------------------------------------------------- 中间 schema
@dataclass
class Observation:
    """单条观测（一行 = 一个 system/sv/signal 的一个历元）。"""

    station: str
    receiver_id: str
    gps_week: int
    gps_tow_s: float
    system: str
    sv: int
    signal: str
    freq_hz: float
    psr_m: float
    adr_cycles: float
    doppler_hz: float
    cn0_dbhz: float
    elev_deg: float
    azim_deg: float
    sys_code: int = 0
    sig_code: int = 0
    grouped: int = 0
    quality_flag: int = 0
    epoch_utc: str = ""

    def to_row(self) -> dict:
        return {
            "station": self.station,
            "receiver_id": self.receiver_id,
            "epoch_utc": self.epoch_utc,
            "gps_week": self.gps_week,
            "gps_tow_s": self.gps_tow_s,
            "system": self.system,
            "sv": self.sv,
            "signal": self.signal,
            "freq_hz": self.freq_hz,
            "psr_m": self.psr_m,
            "adr_cycles": self.adr_cycles,
            "doppler_hz": self.doppler_hz,
            "cn0_dbhz": self.cn0_dbhz,
            "elev_deg": self.elev_deg,
            "azim_deg": self.azim_deg,
            "sys_code": self.sys_code,
            "sig_code": self.sig_code,
            "grouped": self.grouped,
            "quality_flag": self.quality_flag,
        }


# 输出契约（T0）：每历元一条 TEC 结果
@dataclass
class TecRecord:
    station: str
    system: str
    sv: int
    signal_pair: str
    gps_week: int
    gps_tow_s: float
    epoch_utc: str
    sTEC_TECU: float
    vTEC_TECU: float
    deltaT_TECU: float
    level_offset_TECU: float
    arc_id: int
    quality_flag: int
    elev_deg: float = MISSING
    azim_deg: float = MISSING
    ipp_lat_deg: float = MISSING
    ipp_lon_deg: float = MISSING
    algorithm: str = ""

    def to_row(self) -> dict:
        return {
            "station": self.station,
            "system": self.system,
            "sv": self.sv,
            "signal_pair": self.signal_pair,
            "epoch_utc": self.epoch_utc,
            "gps_week": self.gps_week,
            "gps_tow_s": self.gps_tow_s,
            "sTEC_TECU": self.sTEC_TECU,
            "vTEC_TECU": self.vTEC_TECU,
            "deltaT_TECU": self.deltaT_TECU,
            "level_offset_TECU": self.level_offset_TECU,
            "arc_id": self.arc_id,
            "quality_flag": self.quality_flag,
            "elev_deg": self.elev_deg,
            "azim_deg": self.azim_deg,
            "ipp_lat_deg": self.ipp_lat_deg,
            "ipp_lon_deg": self.ipp_lon_deg,
            "algorithm": self.algorithm,
        }


# ---------------------------------------------------------------- 字段单位表
FIELD_UNITS = {
    "gps_week": "week",
    "gps_tow_s": "s",
    "freq_hz": "Hz",
    "psr_m": "m",
    "adr_cycles": "cycle",
    "doppler_hz": "Hz",
    "cn0_dbhz": "dB-Hz",
    "elev_deg": "deg",
    "azim_deg": "deg",
    "sTEC_TECU": "TECU",
    "vTEC_TECU": "TECU",
    "deltaT_TECU": "TECU",
    "level_offset_TECU": "TECU",
}

OBS_FIELDS = list(Observation.__dataclass_fields__.keys())  # type: ignore[attr-defined]
TEC_FIELDS = list(TecRecord.__dataclass_fields__.keys())  # type: ignore[attr-defined]


# ---------------------------------------------------------------- 配对结构
@dataclass
class EpochPair:
    """同一 station/system/sv/历元 下多个信号的合并视图。"""

    station: str
    system: str
    sv: int
    gps_week: int
    gps_tow_s: float
    epoch_utc: str
    obs: dict[str, Observation] = field(default_factory=dict)
    quality_flag: int = 0
    arc_id: int = -1

    @property
    def elev_deg(self) -> float:
        for o in self.obs.values():
            return o.elev_deg
        return MISSING

    @property
    def azim_deg(self) -> float:
        for o in self.obs.values():
            return o.azim_deg
        return MISSING

    def get(self, signal: str) -> Observation | None:
        return self.obs.get(signal)


def pair_observations(observations: list[Observation]) -> dict[tuple, list[EpochPair]]:
    """把扁平的观测行按 (station, system, sv) 聚成历元配对序列，时间升序。

    GPS 周 1023 -> 0 翻转用连续周计数展开，避免直接相减。
    """
    groups: dict[tuple, dict[tuple, EpochPair]] = {}
    for ob in observations:
        key = (ob.station, ob.system, ob.sv)
        tkey = (ob.gps_week, round(ob.gps_tow_s, 6))
        ep = groups.setdefault(key, {}).get(tkey)
        if ep is None:
            ep = EpochPair(
                station=ob.station,
                system=ob.system,
                sv=ob.sv,
                gps_week=ob.gps_week,
                gps_tow_s=ob.gps_tow_s,
                epoch_utc=ob.epoch_utc,
            )
            groups[key][tkey] = ep
        ep.obs[ob.signal] = ob
    out: dict[tuple, list[EpochPair]] = {}
    for key, tmap in groups.items():
        series = sorted(tmap.values(), key=lambda e: (e.gps_week, e.gps_tow_s))
        out[key] = series
    return out


def continuous_epoch_time_s(series: list[EpochPair], leap_s: float = DEFAULT_LEAP_S) -> list[float]:
    """把 (week, tow) 展开成单调递增的连续秒（处理 1023->0 翻转）。

    返回相对序列首历元的秒数，用无闰秒的 GPS 时标（周内秒连续）。
    """
    if not series:
        return []
    week0 = series[0].gps_week
    # 连续周计数：wrapped week < previous - 512 视为回绕 +1024
    cont_week = [week0]
    for ep in series[1:]:
        prev = cont_week[-1]
        w = ep.gps_week
        while w < prev - 512:
            w += 1024
        while w > prev + 512:
            w -= 1024
        cont_week.append(w)
    t0 = (cont_week[0] - week0) * GPS_WEEK_S + series[0].gps_tow_s
    return [(cont_week[i] - week0) * GPS_WEEK_S + series[i].gps_tow_s - t0 for i in range(len(series))]


# ---------------------------------------------------------------- 时间换算
def gps_to_utc(gps_week: int, gps_tow_s: float, leap_s: float = DEFAULT_LEAP_S) -> datetime:
    total = gps_week * GPS_WEEK_S + gps_tow_s - leap_s
    return GPS_EPOCH + timedelta(seconds=total)


def utc_to_gps(dt: datetime, leap_s: float = DEFAULT_LEAP_S) -> tuple[int, float]:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    total = (dt - GPS_EPOCH).total_seconds() + leap_s
    week = int(math.floor(total / GPS_WEEK_S))
    tow = total - week * GPS_WEEK_S
    return week, tow


def epoch_utc_str(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ---------------------------------------------------------------- 校验
class ValidationError(ValueError):
    pass


def is_finite(x) -> bool:
    try:
        return math.isfinite(float(x))
    except (TypeError, ValueError):
        return False


def validate_observation(ob: Observation, strict: bool = True) -> bool:
    """输入校验：拦截越界 el/az 与非有限必填字段。

    返回 True 表示通过。strict=True 时不合格抛 ValidationError。
    """
    problems = []
    if not (-90.0 <= ob.elev_deg <= 90.0):
        problems.append(f"elev_deg 越界: {ob.elev_deg}")
    if not (0.0 <= ob.azim_deg < 360.0):
        problems.append(f"azim_deg 越界: {ob.azim_deg}")
    if not is_finite(ob.psr_m):
        problems.append("psr_m 非有限")
    if not is_finite(ob.freq_hz) or ob.freq_hz <= 0:
        problems.append("freq_hz 非法")
    if not is_finite(ob.gps_tow_s) or ob.gps_tow_s < 0:
        problems.append("gps_tow_s 非法")
    if not is_finite(ob.cn0_dbhz) and not math.isnan(ob.cn0_dbhz):
        problems.append("cn0_dbhz 非法")
    if problems:
        if strict:
            raise ValidationError("；".join(problems))
        return False
    return True
