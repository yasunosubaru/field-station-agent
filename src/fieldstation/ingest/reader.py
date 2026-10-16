#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""统一观测入口：自动嗅探格式 -> 报告能力 -> 转成 fieldstation.model.Observation。

**存在的理由**：用户手上的数据格式未知。与其让用户先自查，不如让程序自己
判断，并**明确报告**它认出了什么、缺什么、哪些部分仍可用。

## 支持矩阵（全部为本机实测结果，不含推测）

| 格式 | 嗅探 | 解析 | 说明 |
|---|---|---|---|
| RINEX 3 观测 `.rnx` / `.rnx.gz` | ✅ | ✅ | ALBH-like / TWTF 实测通过 |
| RINEX 2 观测 `.rnx` / `.24o` / `.gz` | ✅ | ✅（部分生产者有块对齐缺陷） | |
| CSV（自建宽表） | ✅ | ✅ | 列名自动映射 |
| RINEX 4 观测 | ✅ | ❌ | 能识别、会报「不支持」，不静默失败 |
| CRINEX / Hatanaka（真 `d` 记录） | ✅ | ❌ | 本项目无真实样本，解码器未验证 |
| gfzrnx 私有紧缩（`3&`） | ✅ | ❌ | BKG / GSSC 的 `.crx.gz` 全是这种，已确认非 Hatanaka |
| 厂商原始格式（SBF/OEM/ASC） | 部分 | ❌ | 需要用户先导出 RINEX |

**设计原则**：宁可报「不支持 + 说明缺什么」，也绝不静默给出错误结果。
"""
from __future__ import annotations

import csv
import gzip
import io
import os
import re
from typing import Any

# model 在上一级包（fieldstation.model），不是 fieldstation.ingest 的一部分
from .. import model as S
from . import rinex2, rinex3

GZ_MAGIC = b"\x1f\x8b"


# ---------------------------------------------------------------- 嗅探
_VER_RE = __import__("re").compile(r"^\s{2,}([234])\s*(?:\.\s*([0-9]{1,2}))?\s")


def _rinex_major_version(first_line: str) -> int | None:
    """从 RINEX 首行取主版本号；次版本号可以**缺省**。

    RINEX 规范把版本放在第 1-9 列，形如 "     2.11"。但实测存在只有主版本的
    老文件（irkj0010.24o.gz，CCRINEXO V2.4.1 产）：
        "     2              OBSERVATION DATA    M (MIXED)"
    用 startswith("     2.") 会把它整份判成 UNKNOWN，白丢一个台站。

    判据要点：
      * 只认第 1-9 列（定宽），不扫整行 —— 否则 COMMENT 里出现 "4" 会误判。
      * 主版本后允许直接空白（无小数点），也允许 "2.11" / "3.04" / "4.02"。
      * 返回 int 或 None；不是合法 RINEX 首行就返回 None。
    """
    m = _VER_RE.match(first_line[:20] or "")
    if not m:
        return None
    return int(m.group(1))


# RINEX 2 的观测码 -> 本项目内部 signal 的码回退链。
#
# 为什么需要回退链（实测踩坑）：RINEX 2 只有**一套**观测码，被所有星座共用。
# 5 个真实文件里有 3 个**根本没有 C2**：
#     daej  L1 L2 L5 C1 P1 P2 C5 S1 S2
#     kaza  L1 L2 C1 P2 P1 S1 S2
#     kmnm  C1 P1 L1 S1 P2 L2 S2
# 硬编码 {"L1":"C1","L2":"C2"} 会让 L2 的伪距变成 NaN，
# 于是「有相位没码」的样本全被丢弃，run.py 报「没读到可用观测」。
#
# 优先级依据（GPS 现代化）：
#   C1 = L1C/A 的总码，GPS 现代化后是 C1C（第一路）与 C1W（第二路）的和，
#        所以 **C1 优于 P1**；L2 同理 **C2 优于 P2**。
#   P1/P2 是老式独立跟踪环的码，在 C1/C2 存在时通常平滑性差、有硬件偏差，
#   只在没有 C1/C2 时作为退路。
CODE_FALLBACK = {
    "L1":  ("C1", "P1", "C1C", "C1W", "C1S", "C1L"),
    "L2":  ("C2", "P2", "C2W", "C2X", "C2L", "C2S"),
    "L5":  ("C5", "C5Q", "C5X", "I5"),
    "L6":  ("C6", "C6A", "C6B", "C6C"),
    "L7":  ("C7", "C7Q", "C7X"),
    "L8":  ("C8", "C8Q", "C8X"),
    "B1I": ("C2", "C7", "C1"),
    "B2I": ("C7", "C6", "C2"),
    "B1C": ("C1", "C2"),
    "B2a": ("C5", "C7"),
}
# 信号 -> 信噪比观测码（与 CODE_FALLBACK 同风格，回退到 S1/S2）
SNR_FALLBACK = {
    "L1":  ("S1", "S1C", "S1W"),
    "L2":  ("S2", "S2W", "S2X"),
    "L5":  ("S5", "S5Q"),
    "L6":  ("S6", "S6A"),
    "L7":  ("S7", "S7Q"),
    "L8":  ("S8", "S8Q"),
    "B1I": ("S2", "S7"),
    "B2I": ("S7", "S6"),
    "B1C": ("S1", "S2"),
    "B2a": ("S5", "S7"),
}


def _first_present(value_map: dict, keys) -> tuple:
    """按 keys 顺序取第一个存在于 value_map 且非空的键。

    返回 (键, 值)；全缺时返回 (None, None)。**不猜、不插值。**
    """
    for k in keys:
        if k in value_map:
            v = value_map[k]
            if v is not None and v == v:
                return k, v
    return None, None

def _read_text(path: str) -> tuple[str, str]:
    """返回 (文本, 压缩方式)。支持 .gz 与裸文件。"""
    with open(path, "rb") as fh:
        raw = fh.read()
    if raw[:2] == GZ_MAGIC:
        raw = gzip.decompress(raw)
        return raw.decode("latin-1"), "gzip"
    # 尝试文本
    try:
        return raw.decode("utf-8"), "plain-utf8"
    except UnicodeDecodeError:
        return raw.decode("latin-1"), "plain-latin1"


def sniff(path: str) -> dict:
    """判断文件是什么。**只读前若干字节**，不整文件载入。"""
    info: dict[str, Any] = {
        "path": path, "basename": os.path.basename(path),
        "size_bytes": os.path.getsize(path),
        "extensions": [e.lower() for e in
                       os.path.splitext(path)[0].replace(".", ".").split(".")],
    }
    with open(path, "rb") as fh:
        head = fh.read(65536)
    gz = head[:2] == GZ_MAGIC
    if gz:
        try:
            head = gzip.decompress(head)
        except Exception:
            try:
                with gzip.open(path, "rb") as fh2:
                    head = fh2.read(65536)
            except Exception as exc:
                info.update(format="UNKNOWN", reason=f"gzip 解压失败: {exc}")
                return info
    txt = head.decode("latin-1")
    lines = txt.split("\n")

    if gz and lines and "CRINEX VERS" in lines[0]:
        # **必须全量探测**：实测 BKG 的 .crx.gz 里 `3&` 记录要到第 271 行才出现，
        # 只看前 200 行会把它误判成「疑似 Hatanaka」（踩过）。
        full = txt if len(txt) < 40_000_000 else txt[:40_000_000]
        nd = sum(1 for l in full.split("\n") if l[:1] == "d")
        ng = full.count("3&")
        is_gfz = ng > 100
        info.update(format="CRINEX",
                    variant="gfzrnx-3&" if is_gfz else "hatanaka-d",
                    n_d_records=nd, n_gfz_records=ng,
                    version=lines[0].split()[0],
                    supported=False,
                    reason=("gfzrnx 私有紧缩格式：全文 %d 处 `3&` 记录、%d 条 `d` 记录。"
                            "BKG 与 GSSC 的 .crx.gz 全是这种，已确认**不是** Hatanaka。"
                            "本项目无解码器（无公开规范，逆向风险高）" % (ng, nd)
                            if is_gfz else
                            "Hatanaka（CRINEX）紧缩：%d 条 `d` 记录。"
                            "本项目解码器未在本样本上验证过，暂不启用" % nd))
        return info
    # RINEX 版本号判据：**次版本号可以缺省**。
    # 实测踩坑：irkj0010.24o.gz 的首行是 "     2              OBSERVATION DATA"
    # —— 只有主版本、没有小数点（CCRINEXO 产的老文件）。用 startswith("     2.")
    # 判据会把它整份文件判成 UNKNOWN，直接失去一个可用台站。
    mv = _rinex_major_version(lines[0]) if lines else None
    if mv == 2:
        info.update(format="RINEX2", version=lines[0][:9].strip(),
                    file_type=lines[0][20:40].strip(), supported=True)
        return info
    if mv == 3:
        if "OBSERVATION DATA" in lines[0]:
            info.update(format="RINEX3", version=lines[0][:9].strip(),
                        file_type=lines[0][20:40].strip(), supported=True)
        else:
            info.update(format="RINEX3-NAV", version=lines[0][:9].strip(),
                        file_type=lines[0][20:40].strip(), supported=True,
                        note="导航电文，不含观测；可作广播星历输入")
        return info
    if mv == 4:
        info.update(format="RINEX4", version=lines[0][:9].strip(), supported=False,
                    reason="RINEX 4.02 的 `>` 历元行格式与 3.x 不同；"
                           "请先用 convbin/teqc 3.04 或 `gfzrnx -r 3` 转换")
        return info
    if lines and "," in lines[0] and len(lines[0].split(",")) >= 4:
        info.update(format="CSV", ncols=len(lines[0].split(",")),
                    header=lines[0].strip()[:200], supported=True)
        return info
    info.update(format="UNKNOWN", supported=False,
                reason="既不是 RINEX 2/3/4，也不是 CRINEX/CSV。"
                       "若是厂商原始格式（SBF/OEM/ASC），请先导出为 RINEX 3.04")
    return info


# ---------------------------------------------------------------- 统一观测
CODE_KIND = {"C": "psr", "P": "psr", "L": "adr", "D": "dop", "S": "cn0"}
# 本项目内部 signal 名（只覆盖 GPS 双频，已验证）
SIGNAL_ALIAS = {
    ("GPS", "L1"): ("L1", 1575.42e6), ("GPS", "L2"): ("L2", 1227.60e6),
    ("GPS", "L5"): ("L5", 1176.45e6),
    ("GAL", "L1"): ("L1", 1575.42e6), ("GAL", "L5"): ("L5", 1176.45e6),
    ("GAL", "L7"): ("L7", 1207.14e6), ("GAL", "L8"): ("L8", 1191.795e6),
    ("BDS", "B1I"): ("B1I", 1561.098e6), ("BDS", "B2I"): ("B2I", 1207.14e6),
    ("BDS", "B1C"): ("B1I", 1561.098e6), ("BDS", "B2a"): ("B2I", 1176.45e6),
}


class ObservationFile:
    """统一的观测文件句柄。`source_format` 决定怎么读。"""

    def __init__(self, path: str, elev_mask_deg: float | None = None):
        self.path = path
        self.info = sniff(path)
        self.elev_mask_deg = elev_mask_deg
        self._text: str | None = None
        self._raw: object = None
        self._hdr: dict[str, Any] = {}
        self.warnings: list[str] = []
        self._open()

    # ------------------------------------------------------------ 打开
    def _open(self):
        fmt = self.info["format"]
        if fmt == "RINEX3-NAV":
            # 导航电文是**合法输入**（作广播星历），只是不含观测。明确指路，
            # 而不是笼统报「不支持」。
            raise UnsupportedFormat(
                {"basename": self.info["basename"], "format": "RINEX3-NAV",
                 "reason": "这是导航电文（广播星历），不含观测值，无法反演 TEC",
                 "how_to_fix": "请改用同日期的观测文件；本文件可单独交给 "
                               "导航电文读取器（rinexnav）未搬入本仓库",
                 "_how_to_fix": True})
        if fmt == "RINEX3":
            self._raw = rinex3.Rinex3Obs(self.path)
            self._hdr = self._raw.header.__dict__.copy() if hasattr(
                self._raw.header, "__dict__") else dict(vars(self._raw.header))
            self._station = self._hdr.get("marker", "")
        elif fmt == "RINEX2":
            from . import registry
            # 先按默认（空白切分）建一次，取到 MARKER NAME，
            # 再按登记表套上显式字段宽度。**不能反过来** ——
            # 之前在 self._raw 创建前从 self._hdr 读站名，
            # 那时 _hdr 还是空的，登记表永远查不到（踩过，daej/kmnm 仍 0 记录）。
            self._raw = rinex2.Rinex2Obs(self.path)
            h = self._raw.header
            self._station = h.marker.split()[0] if h.marker else ""
            _fw = registry.field_width_for(self._station, h.program)
            if _fw:
                # 回填宽度并重置探测缓存（reader 还没开始迭代，尚未消费数据）
                self._raw.field_width = int(_fw)
                self._raw.fixed_width_enabled = True
                self._raw._width_cache = int(_fw)
                self._raw._width_probed = True
            self.field_width = _fw
            self._hdr = {"marker": self._station, "version": h.version,
                         "interval_s": h.interval_s,
                         "time_system": h.time_system,
                         "receiver_type": h.receiver_type,
                         "approx_xyz": h.approx_xyz,
                         "program": h.program,
                         "field_width": _fw,
                         "obs_types": list(self._raw.summary()["obs_types"])}
        elif fmt == "CSV":
            self._text, _ = _read_text(self.path)
            self._station = "CSV"
            self._hdr = {}
        else:
            raise UnsupportedFormat(self.info)

    # ------------------------------------------------------------ 元信息
    @property
    def station(self) -> str:
        return self._station or "STA"

    @property
    def approx_xyz(self):
        v = self._hdr.get("approx_xyz")
        if not v or any(x != x for x in v):
            return None
        return tuple(v)

    @property
    def interval_s(self) -> float:
        v = self._hdr.get("interval_s")
        try:
            v = float(v)
        except (TypeError, ValueError):
            v = 0.0
        # `v != v` 就是 NaN 判定，与本文件 `approx_xyz` 用的是同一个写法：
        # 头段没有 `INTERVAL` 记录时，RINEX 2 / 3 的解析器给的是 MISSING，即 NaN。
        if v == v and v > 0:
            return v
        # 头段没写（或写的是 MISSING）时走兜底常量。
        # 原先这里写 `return v or 30.0`，但 NaN 在 Python 里是 truthy，
        # `nan or 30.0` 取回的是 nan —— 兜底自搬运起就没生效过（见 KI-02）。
        # 搬运前那句「头段没写就由历元时间戳反推」是恒假死代码
        # （`... if False else None`），本仓库不启用它，也不在这里补实现。
        return 30.0

    def obs_types(self) -> dict:
        if self.info["format"] == "RINEX3":
            return dict(self._raw.header.obs_types)
        if self.info["format"] == "RINEX2":
            # RINEX 2 只有一组类型，按星座共用
            return {"GPS": list(self._raw.summary()["obs_types"]),
                    "GAL": list(self._raw.summary()["obs_types"]),
                    "BDS": list(self._raw.summary()["obs_types"])}
        return {}

    # ------------------------------------------------------------ 观测
    def observations(self, want_systems=("GPS",)):
        """产出 fieldstation.model.Observation（按「每条同时带 psr 与 adr」的目标结构）。"""
        fmt = self.info["format"]
        if fmt == "RINEX3":
            yield from self._from_rinex3(want_systems)
        elif fmt == "RINEX2":
            yield from self._from_rinex2(want_systems)
        elif fmt == "CSV":
            yield from self._from_csv()
        else:
            raise UnsupportedFormat(self.info)

    # ---- RINEX 3：每条观测自带 psr/adr 分列，需按 signal 归并
    def _from_rinex3(self, want_systems):
        import datetime
        E0 = datetime.datetime(1980, 1, 6, tzinfo=datetime.timezone.utc)
        acc: dict[tuple, dict] = {}
        for o in self._raw.iter_observations(want_systems=want_systems):
            k = (o.system, o.sv, o.gps_week, round(o.gps_tow_s, 3))
            d = acc.setdefault(k, {})
            d[o.signal] = o
            if (self.elev_mask_deg is not None
                    and o.elev_deg < self.elev_mask_deg):
                acc.pop(k, None)
        sgn = -1.0
        for (sysn, sv, wk, tow), d in acc.items():
            # 找出该系统可用的相位信号，按 (高,低) 配对
            phase = sorted([sg for sg in d if sg.startswith("L")])
            for hi in phase:
                lo = _pair_with(phase, hi)
                if lo is None:
                    continue
                o1, o2 = d[hi], d[lo]
                if o1.adr_cycles != o1.adr_cycles or o2.adr_cycles != o2.adr_cycles:
                    continue
                if o1.psr_m != o1.psr_m or o2.psr_m != o2.psr_m:
                    self.warnings.append(
                        f"{sysn} sv{sv} tow{tow}: 双频码缺测，无法定平")
                    continue
                base = dict(station=self.station, receiver_id="",
                            gps_week=wk, gps_tow_s=tow, system=sysn, sv=sv,
                            elev_deg=o1.elev_deg, azim_deg=o1.azim_deg,
                            epoch_utc=o1.epoch_utc)
                for sig, src in ((hi, o1), (lo, o2)):
                    yield S.Observation(
                        signal=sig, freq_hz=src.freq_hz, psr_m=src.psr_m,
                        adr_cycles=sgn * src.adr_cycles,
                        doppler_hz=src.doppler_hz, cn0_dbhz=src.cn0_dbhz,
                        sys_code=0, sig_code=0, **base)

    # ---- RINEX 2：同一观测码已含码+相位
    def _from_rinex2(self, want_systems):
        sgn = -1.0
        GPS_FQ = {"L1": 1575.42e6, "L2": 1227.60e6, "L5": 1176.45e6,
                  "L6": 1278.75e6, "L7": 1207.14e6, "L8": 1191.795e6}
        for dt, sid, v in self._raw.iter_observations(want_systems=want_systems):
            sysletter = sid[:1]
            sysn = rinex2.__dict__.get("SYS_LETTER_MAP", {}).get(
                sysletter, {"G": "GPS", "R": "GLO", "E": "GAL",
                            "C": "BDS", "J": "QZS"}.get(sysletter, "?"))
            try:
                sv = int(sid[1:])
            except ValueError:
                continue
            wk, tow = S.utc_to_gps(dt)
            # 找该星座可用的相位对（**只要求相位在**，码走回退链）
            cands = [(a, b) for a, b in (("L1", "L2"), ("L1", "L5"),
                                         ("B1I", "B2I"), ("L5", "L7"),
                                         ("L7", "L8"))
                     if v.get(a) is not None and v.get(b) is not None]
            el = az = float("nan")
            for hi, lo in cands:
                if v.get(hi) != v.get(hi) or v.get(lo) != v.get(lo):
                    continue
                # 码走回退链：缺 C2 就退到 P2，缺 C1 就退到 P1。
                # 旧实现硬编码 C1/C2，5 个真实台站里 3 个没有 C2，
                # 结果整站「没读到可用观测」（实测 daej/kmnm）。
                ch, cv = _first_present(v, CODE_FALLBACK.get(hi, ()))
                cl, lv = _first_present(v, CODE_FALLBACK.get(lo, ()))
                if cv is None or lv is None:
                    self.warnings.append(
                        f"{sysn} sv{sv} tow{tow:.0f}: {hi}/{lo} 相位齐全但找不到"
                        f"可用码观测（试过 {CODE_FALLBACK.get(hi)} / "
                        f"{CODE_FALLBACK.get(lo)}），丢弃该对")
                    continue
                base = dict(station=self.station, receiver_id="",
                            gps_week=wk, gps_tow_s=tow, system=sysn, sv=sv,
                            elev_deg=el, azim_deg=float("nan"),
                            epoch_utc=S.epoch_utc_str(dt))
                for sig, psr in ((hi, cv), (lo, lv)):
                    _sk, sn = _first_present(v, SNR_FALLBACK.get(sig, ()))
                    fq = GPS_FQ.get(sig)
                    if fq is None:
                        fq = SIGNAL_ALIAS.get((sysn, sig), (sig, 1575.42e6))[1]
                    yield S.Observation(
                        signal=sig, freq_hz=fq,
                        psr_m=psr,
                        adr_cycles=sgn * v[sig],
                        doppler_hz=float("nan"),
                        cn0_dbhz=(sn if sn is not None else float("nan")),
                        sys_code=0, sig_code=0, **base)
                # **每个历元只发一对**。RINEX 2 一颗星可同时有 L1/L2 与 L1/L5，
                # 若不 break，L1 会被两对各发一次、后者覆盖前者，观测数凭空翻倍
                # （实测 hkws 13022 -> 26044），且相位对的选择变成隐式的。
                break

    # ---- CSV
    def _from_csv(self):
        with io.StringIO(self._text) as fh:
            rd = csv.DictReader(fh)
            for row in rd:
                wk = int(float(row.get("gps_week", row.get("week", 0))))
                tow = float(row.get("gps_tow_s", row.get("tow_s", 0)))
                sysn = row.get("system", "GPS")
                sv = int(float(row.get("sv", 0)))
                dt = None
                base = dict(station=row.get("station", self.station),
                            receiver_id="", gps_week=wk, gps_tow_s=tow,
                            system=sysn, sv=sv,
                            elev_deg=float(row.get("elev_deg", "nan")),
                            azim_deg=float(row.get("azim_deg", "nan")),
                            epoch_utc=row.get("epoch_utc", ""))
                sigs = sorted({k for k in row
                               if k[:1] in CODE_KIND and k[1:].isdigit()})
                for sig in sigs:
                    v = float(row[sig] or "nan")
                    yield S.Observation(
                        signal=sig,
                        freq_hz=float(row.get("freq_hz", 1575.42e6)),
                        psr_m=(v if CODE_KIND[sig[0]] == "psr" else float("nan")),
                        adr_cycles=(-v if CODE_KIND[sig[0]] == "adr" else float("nan")),
                        doppler_hz=(v if CODE_KIND[sig[0]] == "dop" else float("nan")),
                        cn0_dbhz=(v if CODE_KIND[sig[0]] == "cn0" else float("nan")),
                        sys_code=0, sig_code=0, **base)

    # ------------------------------------------------------------ 报告
    def capability_report(self) -> dict:
        """把「这是什么 / 能做什么 / 缺什么」一次说清。"""
        info = self.info
        rep = {
            "file": info["basename"],
            "size_mb": round(info["size_bytes"] / 1048576, 2),
            "format": info["format"],
            "supported": bool(info.get("supported")),
            "station": self.station,
            "version": info.get("version", ""),
            "file_type": info.get("file_type", ""),
        }
        if not info.get("supported"):
            rep["blocked_by"] = info.get("reason", "未知原因")
            rep["how_to_fix"] = _FIX.get(info["format"], "请把文件头 20 行发出来")
            return rep
        rep["interval_s"] = self.interval_s
        rep["time_system"] = self._hdr.get("time_system", "")
        rep["receiver"] = self._hdr.get("receiver_type", "")
        rep["program"] = self._hdr.get("program", "")
        rep["approx_xyz"] = self.approx_xyz
        ot = self.obs_types()
        rep["systems"] = {k: len(v) for k, v in ot.items()}
        rep["obs_types"] = {k: v for k, v in ot.items()}
        # 可用的双频相位对
        pairs = {}
        for sysn, codes in ot.items():
            ph = sorted({c[:2] for c in codes if c[:1] == "L"})
            pairs[sysn] = [(hi, lo) for hi in ph for lo in ph if hi < lo]
        rep["phase_pairs"] = pairs
        return rep


def _pair_with(phase: list[str], hi: str):
    """给高频相位信号找一个低频搭档（取紧邻的下一个）。"""
    rest = [p for p in phase if p != hi]
    return min(rest) if rest else None


_FIX = {
    "CRINEX": ("用 `gfzrnx -r 3 <in.crx.gz> > out.rnx` 转成 RINEX 3.04 文本，"
               "或直接向数据提供方索取未压缩的 .rnx / .rnx.gz。"
               "（gfzrnx 私有格式目前无公开规范，解码风险高，不建议逆向）"),
    "RINEX4": ("用 RTKLIB `convbin` 转 RINEX 3.04："
               "`convbin -r 3 -od -os <file>`；或 `gfzrnx -r 3 < in.rnx4 > out.rnx`"),
    "RINEX3-NAV": ("这是导航电文（广播星历），不含观测。可作为上游项目的 rinexnav 读取器的输入。"),
    "UNKNOWN": ("请把文件前 20 行（或 `head -c 512 file`）发出来。"
                "若为 SBF/OEM/ASC 等厂商格式，先用厂商工具或 RTKLIB `convbin` 转 RINEX。"),
}


class UnsupportedFormat(RuntimeError):
    def __init__(self, info: dict):
        self.info = info
        fix = (info.get("how_to_fix") if info.get("_how_to_fix")
               else _FIX.get(info["format"]))
        super().__init__(
            f"{info['basename']}: 识别为 {info['format']}。{info.get('reason', '')}"
            + (f" 建议：{fix}" if fix else ""))


if __name__ == "__main__":  # 手动嗅探：python -m fieldstation.ingest.reader <file>
    import json
    import sys
    p = sys.argv[1]
    print(json.dumps(sniff(p), ensure_ascii=False, indent=2, default=str))
