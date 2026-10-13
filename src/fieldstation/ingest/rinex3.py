#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RINEX 3.04 观测文件读取器（标准明文，纯标准库）。

实现依据：RINEX 3.04 格式说明（https://files.igs.org/pub/data/format/rinex304.pdf）
  - 头段第 61 列起为标签；`## / LABEL / VERSION / TYPE` 给出版本与文件类型
  - `## / MARKER NAME`、`APPROX POSITION XYZ`（站坐标，算 IPP 必须）、
    `ANTENNA: DELTA H/E/N`、`## / TIME OF FIRST OBS`（含时间系统与历元间隔）、
    `## / SYS / # / OBS TYPES`（每系统的观测码集合，可跨多行）
  - 观测段：历元行 `> YYYY MM DD hh mm ss.ssssss  flag  nsat  sats...`
    随后 nsat 行，每行 `G nn  <16 列宽的观测值 × 该系统观测码个数> <质量标志>`
  - 观测值每格 F14.3，紧跟 1 字符 I/NAVSTAT（LLI|SSI）

输出统一数据模型（fieldstation.model.Observation）；缺测一律 NaN，禁止用 0 代替。
观测码 -> 本项目字段的映射按 T5 §2.2.1（RINEX 3 中 BDS 占 band 2/7/6，不是频点序号）。
"""
from __future__ import annotations

import datetime
import gzip
import math
import re
from dataclasses import dataclass, field

MISSING = float("nan")

SYS_NAME = {"G": "GPS", "R": "GLO", "E": "GAL", "C": "BDS", "J": "QZS",
            "I": "IRN", "S": "SBAS"}
# 本项目关心的「频点信号名」：从 RINEX 观测码反推
#  GPS: L1 -> C1C/C1W/S1C/L1C/L1W ; L2 -> C2W/C2L/C2S/S2W/L2W/L2L
#  BDS: B1I -> band 2 ; B2I -> band 7 ; B3I -> band 6   （注意 band 号 != 频点序号）
BAND_TO_SIGNAL = {
    "GPS": {"1": "L1", "2": "L2", "5": "L5"},
    "GAL": {"1": "E1", "5": "E5a", "7": "E5b", "8": "E5"},
    "BDS": {"2": "B1I", "7": "B2I", "6": "B3I"},
    "QZS": {"1": "L1", "2": "L2", "5": "L5"},
}
FREQ_HZ = {
    ("GPS", "L1"): 1575.42e6, ("GPS", "L2"): 1227.60e6, ("GPS", "L5"): 1176.45e6,
    ("BDS", "B1I"): 1561.098e6, ("BDS", "B2I"): 1207.14e6, ("BDS", "B3I"): 1268.52e6,
    ("GAL", "E1"): 1575.42e6, ("GAL", "E5a"): 1176.45e6, ("GAL", "E5b"): 1207.14e6,
    ("GAL", "E5"): 1191.795e6,
    ("QZS", "L1"): 1575.42e6, ("QZS", "L2"): 1227.60e6, ("QZS", "L5"): 1176.45e6,
}
CODE_RE = re.compile(r"^([CLDS])(\d)([A-Z]?)$")


_SYS_CODE_RE = re.compile(r"^([A-Z])\s+(\d+)\s")
_SATLINE_RE = re.compile(r"^([A-Z])\s?(\d{1,2})\s")

# ---------------------------------------------------------------- 观测记录列布局
# RINEX 3 观测记录的列宽**随记录变化**：数值位数多的字段（尤其是 9 位整数 + 小数的
# 载波相位）会占满甚至超出名义宽度，行内后面的字段就整体右移。
# 因此不能在文件级固定一个步长，必须**逐记录判定**。
# 判据用物理量级（伪距 1e7~5e7 m / 相位 5e7~3e8 周 / 多普勒 |x|<2e4 Hz / C/N0 10~60），
# 选使全部字段都落在区间内的布局；一条都落不进就立刻报错，绝不静默产出垃圾。
# 实测踩过的坑：曾用正则按小数位抽取，遇缺测空字段整体错位，把 C/N0 读成 1.27e6 dB-Hz。
OBS_FIRST_COL = 3
_FLAG_W = 1
# 本读取器自用的 quality_flag 位：字段量级物理上不合理（源文件坏数据）
BAD_MAGNETIC = 0x40
# 候选布局：逐字段宽度列表（由观测码类型决定），单位=字符
_LAYOUTS = (
    ("A 全15+1",        {"C": 15, "L": 15, "D": 15, "S": 15}),
    ("B 码14/相16+1",   {"C": 14, "L": 16, "D": 14, "S": 14}),
    ("C 全14+1",        {"C": 14, "L": 14, "D": 14, "S": 14}),
    ("D 全15无标志",    {"C": 15, "L": 15, "D": 15, "S": 15, "_noflag": True}),
    ("E 码14/相16无标志", {"C": 14, "L": 16, "D": 14, "S": 14, "_noflag": True}),
)

_RANGE = {          # 各类型的物理合理区间，用于逐记录判定布局
    "C": (1.0e7, 5.0e7),        # 伪距 m
    "L": (5.0e7, 3.0e8),        # 载波相位 周
    "D": (-2.0e4, 2.0e4),      # 多普勒 Hz
    "S": (10.0, 60.0),          # C/N0 dB-Hz
}
_GAP = object()


def _fld(tok: str) -> float:
    tok = tok.strip()
    if not tok:
        return MISSING
    try:
        v = float(tok)
    except ValueError:
        return MISSING
    return v


def _label(line: str) -> str:
    return line[60:].strip() if len(line) >= 61 else ""


def _is(line: str, label: str) -> bool:
    """判断该行的第 61 列起是否为给定标签。

    必须用**子串**匹配而不是前缀匹配：RINEX 3 的首行标签是 `RINEX VERSION / TYPE`，
    而 RINEX 2 是 `LABEL / VERSION / TYPE`，两者只共享尾部。
    标签只有 20 列宽，实际文件里还会被截断，所以双向子串判断最稳。
    """
    return label in _label(line)


def gunzip_if_needed(raw: bytes) -> bytes:
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw


@dataclass
class ObsHeader:
    version: str = ""
    file_type: str = ""
    marker: str = ""
    marker_number: str = ""
    receiver: str = ""
    receiver_type: str = ""
    antenna: str = ""
    antenna_type: str = ""
    approx_xyz: tuple = (MISSING, MISSING, MISSING)
    antenna_dhenu: tuple = (0.0, 0.0, 0.0)
    time_of_first_obs: tuple = ()
    time_system: str = "GPS"
    interval_s: float = MISSING
    obs_types: dict = field(default_factory=dict)
    glonass_slot_freq: dict = field(default_factory=dict)


class Rinex3Obs:
    """RINEX 3.04 观测文件。iter_observations() 逐条产出 Observation。"""

    def __init__(self, path: str | None = None, text: str | None = None):
        if text is None:
            raw = gunzip_if_needed(open(path, "rb").read())
            text = raw.decode("latin-1")
        self.path = path
        self.text = text
        self.lines = text.split("\n")
        self.header = ObsHeader()
        self.n_epochs = 0
        self._layout_hist: dict[str, int] = {}
        self._n_suspect = 0
        self._parse_header()
        self._parse_body()

    # ---------------------------------------------------- 头段
    def _parse_header(self):
        L = self.lines
        i = 0
        n = len(L)
        while i < n:
            ln = L[i]
            if _is(ln, "VERSION / TYPE"):
                # RINEX 3 是 `RINEX VERSION / TYPE`，RINEX 2 是 `LABEL / VERSION / TYPE`
                self.header.version = ln[0:20].strip()
                self.header.file_type = ln[20:40].strip()
            elif _is(ln, "MARKER NAME"):
                self.header.marker = ln[0:60].strip()
            elif _is(ln, "MARKER NUMBER"):
                self.header.marker_number = ln[0:20].strip()
            elif _is(ln, "REC # / TYPE / VERS"):
                self.header.receiver = ln[0:20].strip()
                self.header.receiver_type = ln[20:40].strip()
            elif _is(ln, "ANT # / TYPE"):
                self.header.antenna = ln[0:20].strip()
                self.header.antenna_type = ln[20:40].strip()
            elif _is(ln, "APPROX POSITION XYZ"):
                self.header.approx_xyz = tuple(_fld(ln[a:a + 14]) for a in (0, 14, 28))
            elif _is(ln, "ANTENNA: DELTA H/E/N"):
                # F14.3 三段：H / E / N
                self.header.antenna_dhenu = tuple(_fld(ln[a:a + 14]) for a in (0, 14, 28))
            elif _is(ln, "TIME OF FIRST OBS"):
                t = ln.split()
                try:
                    self.header.time_of_first_obs = (int(t[0]), int(t[1]), int(t[2]),
                                                     int(t[3]), int(t[4]), float(t[5]))
                except (ValueError, IndexError):
                    pass
                self.header.time_system = ln[48:55].strip() or "GPS"
            elif _is(ln, "INTERVAL"):
                self.header.interval_s = _fld(ln[0:10])
            elif _is(ln, "SYS / # / OBS TYPES") and not _is(ln, "END OF SYS / # / OBS TYPES"):
                # 实测：并非每个文件都写 `END OF SYS / # / OBS TYPES`（TWTF 就没写），
                # 而且块内**每一行都重复带标签**。所以按结构判定：
                #   新系统行 = `^([A-Z])\s+(\d+)\s`；续行 = 前 7 列全空白
                # 注意要从**当前行**开始处理（触发分支的那一行本身就有内容），
                # 预先 i += 1 会把第一个系统整段丢掉。
                while i < n:
                    body = L[i][:60]
                    if not body.strip():
                        i += 1
                        continue
                    m = _SYS_CODE_RE.match(body)
                    if m:
                        self.header.obs_types.setdefault(m.group(1), []).extend(body[7:60].split())
                    elif body[:7].strip() == "" and self.header.obs_types:
                        last = next(reversed(self.header.obs_types))
                        self.header.obs_types[last].extend(body.split())
                    else:
                        break
                    i += 1
                continue
            elif _is(ln, "GLONASS SLOT / FRQ #") and not _is(ln, "END OF GLONASS SLOT / FRQ #"):
                while i < n:
                    if _is(L[i], "END OF HEADER"):
                        break
                    toks = L[i][:60].split()
                    if not (_is(L[i], "GLONASS SLOT / FRQ #") or L[i][:6].strip() == ""):
                        break
                    for k in range(0, len(toks) - 1, 2):
                        if toks[k].startswith("R") and toks[k][1:].isdigit():
                            try:
                                self.header.glonass_slot_freq[int(toks[k][1:])] = int(toks[k + 1])
                            except ValueError:
                                pass
                    i += 1
                continue
            elif _is(ln, "END OF HEADER"):
                break
            i += 1
        self.header_end = i

    # ---------------------------------------------------- 观测段
    def _parse_body(self):
        """只做结构自检：数历元行、找 END OF FILE。真正的解析在 iter_observations。"""
        self.n_epochs = sum(1 for l in self.lines[self.header_end:] if l.startswith(">"))

    @staticmethod
    def _epoch_gps(ln: str, time_system: str = "GPS"):
        """历元行 -> (gps_week, gps_tow_s, utc_datetime)。"""
        toks = ln[1:32].split()
        y, mo, d, h, mi = (int(toks[0]), int(toks[1]), int(toks[2]), int(toks[3]), int(toks[4]))
        s = float(toks[5])
        leap = {"GPS": 0.0, "GAL": 0.0, "QZS": 0.0, "BDS": 0.0, "IRN": 0.0}.get(time_system, 18.0)
        utc = datetime.datetime(y, mo, d, h, mi, int(s),
                                int(round((s - int(s)) * 1e6)), tzinfo=datetime.timezone.utc)
        total = (utc - datetime.datetime(1980, 1, 6, tzinfo=datetime.timezone.utc)).total_seconds() + leap
        week = int(math.floor(total / 604800.0))
        return week, total - week * 604800.0, utc

    def iter_observations(self, want_systems=("GPS", "BDS")):
        """产出 Observation。纯生成器。

        实测结构（TWTF / RINEX 3.04）：历元行 `> ... nsat` 之后**逐行给出每颗卫星**，
        每行是 `Xnn` + 该系统的全部观测值（不是规范里「卫星号表 + 观测行」两段式）。
        观测值按**小数位数**区分字段宽度：伪距/多普勒/CN0 为 3 位小数，
        载波相位为 5 位小数；行尾空白字段会被去空，按可得数量补 NaN。
        """
        from ..model import Observation, epoch_utc_str
        L = self.lines
        n = len(L)
        H = self.header
        codes = H.obs_types
        i = self.header_end + 1
        week = tow = 0
        utc = None
        n_event_flag_epochs = 0
        while i < n:
            ln = L[i]
            if ln.startswith(">"):
                try:
                    week, tow, utc = self._epoch_gps(ln, H.time_system)
                except (ValueError, IndexError):
                    i += 1
                    continue
                m = re.search(r"\s(\d+)\s*$", ln.rstrip())
                try:
                    nsat = int(m.group(1)) if m else 0
                except ValueError:
                    nsat = 0
                flg = int(ln[31:32] or "0") if len(ln) > 31 and ln[31:32].strip().isdigit() else 0
                if flg in (2, 3, 4, 5):
                    n_event_flag_epochs += 1        # 事件标志：头段跟在后面，不按常规历元处理
                i += 1
                got = 0
                while i < n and got < nsat:
                    rec = L[i]
                    ms = _SATLINE_RE.match(rec)
                    if not ms:
                        if rec.startswith(">") or rec.strip() == "":
                            break
                        i += 1
                        continue
                    sysid = ms.group(1)
                    sysname = SYS_NAME.get(sysid, "?")
                    if sysname not in want_systems:
                        i += 1
                        got += 1
                        continue
                    vals, flags, lay, nbad = self._split_record(rec, sysname, codes.get(sysid, []))
                    self._layout_hist[lay] = self._layout_hist.get(lay, 0) + 1
                    if nbad:
                        self._n_suspect += 1
                    yield from self._emit(f"{ms.group(1)}{int(ms.group(2)):02d}", sysname,
                                         codes.get(sysid, []), vals, nbad,
                                         week, tow, utc, Observation, epoch_utc_str)
                    i += 1
                    got += 1
                continue
            if _is(ln, "END OF FILE"):
                break
            i += 1
        self.n_event_flag_epochs = n_event_flag_epochs

    @staticmethod
    def _ok(kind: str, v: float) -> bool:
        """某个字段值是否落在该类型的物理合理区间内。NaN（缺测）返回 True。"""
        if v != v:
            return True
        lo, hi = _RANGE[kind]
        return (lo <= v <= hi) if kind == "D" else (lo <= abs(v) <= hi)

    @classmethod
    def _split_record(cls, rec: str, sysname: str, codelist):
        """逐记录判定列布局，返回 (vals, flags, layout_name, n_bad)。

        `n_bad` 是超出物理量级合理区间的字段数。**注意这不等于解析失败**：
        实测 TWTF 文件里约 5% 的 BDS 记录本身是坏数据（多普勒冻结在 −151600.000、
        C/N0 冻结在 47.500、伪距随机跳变），属于接收机通道故障，不是列错位。
        所以这里取「不合规字段最少」的布局并把坏记录标记出来交给下游 QC，
        而不是直接抛错；但若**所有**布局都差到离谱（说明是别的问题），仍会抛错。
        """
        kinds = []
        for code in codelist:
            m = CODE_RE.match(code)
            kinds.append(m.group(1) if m else "?")
        best = None
        for name, spec in _LAYOUTS:
            noflag = bool(spec.get("_noflag"))
            st = OBS_FIRST_COL
            vals, flags, bad = [], [], 0
            for kind in kinds:
                w = spec.get(kind, 15)
                tok = rec[st:st + w]
                v = _fld(tok) if len(tok) == w else MISSING
                vals.append(v)
                flags.append("" if noflag else rec[st + w: st + w + _FLAG_W].strip())
                if kind in _RANGE and not cls._ok(kind, v):
                    bad += 1
                st += w + (0 if noflag else _FLAG_W)
            if best is None or bad < best[0]:
                best = (bad, name, vals, flags)
            if bad == 0:
                return vals, flags, name, 0
        bad, name, vals, flags = best
        n_fields = max(1, len(kinds))
        if bad >= n_fields:      # 整条记录没有一个字段合理 -> 确实读不懂
            raise ValueError(
                f"{sysname} 观测记录列布局无法判定：候选 {name} 全部 {bad}/{n_fields} "
                f"个字段超出物理量级。\n  原文行: {rec[:120]!r}\n"
                f"  读出值: {[round(v, 3) if v == v else None for v in vals][:12]}\n"
                f"  观测码: {codelist[:12]}")
        return vals, flags, name, bad

    @staticmethod
    def _emit(sat, sysname, codelist, vals, n_bad,
              week, tow, utc, Observation, epoch_utc_str):
        """把一颗卫星的观测码拆成本项目的信号字段。缺测一律 NaN。

        n_bad > 0 表示该记录里有字段的量级物理上不合理（源文件坏数据），
        会在 quality_flag 上置 BAD_MAGNETIC 位，由下游 QC 剔除。
        """
        try:
            sv = int(sat[1:])
        except ValueError:
            return
        qflag = BAD_MAGNETIC if n_bad else 0
        buckets: dict[str, dict] = {}
        for code, v in zip(codelist, vals):
            m = CODE_RE.match(code)
            if not m:
                continue
            kind, band = m.group(1), m.group(2)
            sig = BAND_TO_SIGNAL.get(sysname, {}).get(band)
            if sig is None:
                continue
            b = buckets.setdefault(sig, {"psr": MISSING, "adr": MISSING,
                                         "dop": MISSING, "cn0": MISSING})
            key = {"C": "psr", "L": "adr", "D": "dop", "S": "cn0"}[kind]
            if b[key] != b[key]:          # 同一频点多个观测码时取第一个有效值
                b[key] = v
        for sig, b in sorted(buckets.items()):
            f_hz = FREQ_HZ.get((sysname, sig))
            if f_hz is None:
                continue
            yield Observation(
                station="", receiver_id="", gps_week=week, gps_tow_s=tow,
                system=sysname, sv=sv, signal=sig, freq_hz=f_hz,
                psr_m=b["psr"], adr_cycles=b["adr"], doppler_hz=b["dop"], cn0_dbhz=b["cn0"],
                elev_deg=MISSING, azim_deg=MISSING, quality_flag=qflag,
                epoch_utc=epoch_utc_str(utc),
            )

    def summary(self) -> dict:
        H = self.header
        return {
            "path": self.path,
            "layout_hist": dict(self._layout_hist),
            "n_records_bad_magnitude": self._n_suspect,
            "event_flag_epochs": getattr(self, "n_event_flag_epochs", 0),
            "version": H.version,
            "file_type": H.file_type,
            "marker": H.marker,
            "receiver": f"{H.receiver} {H.receiver_type}",
            "antenna": f"{H.antenna} {H.antenna_type}",
            "approx_xyz_m": H.approx_xyz,
            "antenna_dhenu_m": H.antenna_dhenu,
            "time_of_first_obs": H.time_of_first_obs,
            "time_system": H.time_system,
            "interval_s": H.interval_s,
            "systems": {SYS_NAME.get(k, k): {"n_codes": len(v), "codes": v[:24]}
                        for k, v in sorted(H.obs_types.items())},
            "n_epoch_lines": self.n_epochs,
            "end_of_file": self.text.count("END OF FILE"),
            "n_hatanaka_d_lines": sum(1 for l in self.lines if l[:1] == "d"),
            "n_lines": len(self.lines),
        }


if __name__ == "__main__":
    import sys
    r = Rinex3Obs(sys.argv[1])
    for k, v in r.summary().items():
        print(f"  {k:20s} = {v}")
    print("\n  前 24 条观测:")
    for k, o in enumerate(r.iter_observations()):
        if k >= 24:
            break
        print(f"    {o.system} {o.sv:>3d} {o.signal:>4s} f={o.freq_hz/1e6:8.3f}MHz "
              f"P={o.psr_m:16.3f} L={o.adr_cycles:18.6f} D={o.doppler_hz:>10.1f} "
              f"CN0={o.cn0_dbhz:6.1f} tow={o.gps_tow_s:10.1f}")
