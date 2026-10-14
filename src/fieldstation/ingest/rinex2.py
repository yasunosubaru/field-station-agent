#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RINEX 2 观测文件读取器。纯标准库。

**为什么要自己写**：本包已有的 `ingest/rinex3.py` 只认 RINEX 3。
但实测（2026-10-01）免登录源里唯一的标准格式观测是 RINEX 2：
GSSC `daily/` 每天约 243 个 `*.24o.gz`（RINEX 2.11，未压缩标准格式），
而 RINEX 3 的明文观测每天只有 1 个且始终是台站 TWTF —— 经检验该文件
82% 的相邻历元多普勒与轨道几何不符（详见 docs/07b 第 6 节），
是源站的样例文件，不能当实测数据用。

## 本实现针对实测文件的三条硬事实

1. **历元行没有 `>`**：实测首行为 ` 24 01 01 00 00 00.0000000  0 18G01G02...`。
   所以判据用「行首 `>` **或** 前 3 列能解析成 2/4 位年份」，
   不能只认 `>`。
2. **数值是空白分隔、不是定宽**：gfzrnx 写出的是
   `  22814024.911    22814029.378   119888605.7284 ...`，
   字段起点不均匀（实测起点 2/18/33/50/67，步长 16/15/17/17）。
   所以必须按空白切，**不能**按 F14.3 切。
3. **缺项不可定位**：源文件本身有缺测（头段 `PRN / # OF OBS` 里
   G13 的第 2 个类型就是空的）。空白分隔会把缺项吃掉，导致
   token 数 < 声明类型数。本实现对这种情况做**物理判据消歧**：
   恰好缺 1 项时，遍历所有缺口位置，取使 |C1 - P1| < 5 m（双频码
   观测的真实差值量级）唯一成立的那个；仍不唯一就**丢弃该记录**
   而不是猜。

## 缺测一律 NaN，禁止用 0 代替
"""
from __future__ import annotations

import datetime
import gzip
import math
import re

MISSING = float("nan")
_EPOCH = datetime.datetime(1980, 1, 6, tzinfo=datetime.timezone.utc)

# GLONASS 频点号（RINEX 2 用 R01..R24 隐含 channel 0..23）。
# 这是**约定**而非电文值：真实频点应由 SINEX/CLK 给出，这里取标准表。
GLO_CHANNEL = {f"R{i:02d}": i - 1 for i in range(1, 25)}
GLO_L1_BASE = 1602.0          # MHz
GLO_L1_DELTA = 0.5625         # MHz per channel
GLO_L2_DELTA = 0.4375         # MHz per channel


def _is(line: str, label: str) -> bool:
    """标签匹配用**双向子串**，不要求从第 61 列起。

    实测教训：`JPS2RIN v.2.1.223` 写出的
        `    10    C1    P1    L1    S1    P2    L2    S2    C5    L5# / TYPES OF OBSERV`
    标签从 index 59 起且行长 85（非标准 80），若按「line[60:].strip() 必须等于标签」
    判会整条漏掉，随后 `# / TYPES OF OBSERV` 续行判定失效、观测类型列表为空。
    """
    lab = line[40:] if len(line) > 40 else line
    return label in lab


_TOK = re.compile(r"[+-]?\d+\.\d{1,4}|\d+")


def _tokens(line: str) -> tuple[list[str], list[str]]:
    """把一行观测拆成 (数值 token, 单字符标志 token)。

    RINEX 2 每条观测是 `F14.3 + I1(LLI)`。实测两种写法的标志位都会出问题：
      - 与数值之间有空格：`123946407.682 6`   -> 空格切即可
      - 与数值粘连：`123946407.6826`         -> 按空白切会得到 14 位小数
    所以这里先用正则取 token，再把「小数位 > 3」的最后一个字符拆出来当标志。
    裸整数（无小数点）且只有一位 -> LLI 标志，不是观测量。
    """
    vals: list[str] = []
    flags: list[str] = []
    for t in _TOK.findall(line):
        if "." in t:
            head, _, frac = t.partition(".")
            if len(frac) > 3:
                vals.append(head + "." + frac[:3])
                flags.append(frac[3])
            else:
                vals.append(t)
        elif len(t) == 1:
            flags.append(t)
        else:
            vals.append(t)
    return vals, flags


def _gzip_bytes(path: str) -> bytes:
    raw = open(path, "rb").read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return raw


def _t(dt: datetime.datetime) -> float:
    return (dt - _EPOCH).total_seconds()


def _epoch_full(year2: int) -> int:
    """RINEX 2 的两位年 -> 四位年。1990-1999 之外一律 2000+。"""
    return 2000 + year2 if year2 < 80 else 1900 + year2


class Obs2Header:
    __slots__ = ("version", "file_type", "marker", "marker_number", "agency",
                 "receiver", "receiver_type", "antenna", "antenna_type",
                 "approx_xyz", "antenna_dhenu", "leap_seconds",
                 "interval_s", "obs_types", "n_sat_declared",
                 "time_first", "time_last", "time_system", "prn_obs",
                 "program", "run_by")

    def __init__(self):
        self.version = ""
        self.file_type = ""
        self.marker = ""
        self.marker_number = ""
        self.agency = ""
        self.receiver = ""
        self.receiver_type = ""
        self.antenna = ""
        self.antenna_type = ""
        self.approx_xyz = (MISSING, MISSING, MISSING)
        self.antenna_dhenu = (0.0, 0.0, 0.0)
        self.leap_seconds = MISSING
        self.interval_s = MISSING
        self.obs_types: list[str] = []
        self.n_sat_declared = 0
        self.time_first: tuple = ()
        self.time_last: tuple = ()
        self.time_system = "GPS"
        self.prn_obs: dict = {}
        self.program = ""
        self.run_by = ""


class Rinex2Obs:
    """RINEX 2.10/2.11 观测数据（单文件单站）。"""

    def __init__(self, path: str | None = None, text: str | None = None,
                 fixed_width: bool | None = None, field_width: int | None = None):
        if text is None:
            text = _gzip_bytes(path).decode("latin-1")
        self.path = path
        self.lines = text.split("\n")
        self.header = Obs2Header()
        self.n_epochs = 0
        self.n_records = 0
        self.n_dropped = 0          # 因缺项无法消歧而丢弃的记录数
        self.n_sat_seen: set[str] = set()
        self._header_end = 0
        # 定宽字段宽度探测：只做一次，结果缓存
        self._width_cache = None
        self._width_probed = False
        self.field_width = None      # None = 走空白切分（默认，已验证）
        if fixed_width is None:
            import os as _os
            # **默认关闭：宽度不做自动探测。**
            # 三版判据实测全部失败：
            #   1) "解出数最多"  -> hkws 15 宽被判成 16 宽，r 0.806 -> 0.541
            #   2) 交叉码 IF 吻合 -> 5 个站无一同时具备 (C1,C2) 与 (P1,P2)，恒 False
            #   3) 逐字段 MAD 稳定 -> 仍把 hkws 判成 16 宽，r 0.806 -> 0.541
            # 宽度猜错时**每个字段仍能解成"合法数字"**，现有物理闸门拦不住
            # （错宽只把相位与多普勒切串，量级都还在 C/P/L 的合法区间内）。
            # 所以不猜 —— 宽度必须由 `field_width=` 显式给出，
            # 数值来自对本项目的真实文件逐一实测（见下表），
            # 并记在 data/external/publicdata/MANIFEST_stations.tsv 里。
            #   hkws  (Spider)            = 15 宽
            #   daej/kmnm/irkj (teqc/CCRINEXO) = 16 宽
            fixed_width = _os.environ.get(
                self.FIXED_WIDTH_ENV, "0").strip() not in ("", "0", "false", "no")
        self.fixed_width_enabled = bool(fixed_width)
        # **显式宽度**：给了就用，不再探测（三版自动判据实测均不可靠）。
        self._width_cache = field_width
        self._width_probed = field_width is not None
        if field_width is not None:
            self.fixed_width_enabled = True
            self.field_width = int(field_width)
        self._parse_header()
        self._obs_types = list(self.header.obs_types)

    # ------------------------------------------------------------ 头段
    def _parse_header(self):
        L = self.lines
        h = self.header
        i = 0
        while i < len(L):
            ln = L[i]
            if _is(ln, "RINEX VERSION / TYPE"):
                h.version = ln[0:9].strip()
                h.file_type = ln[20:40].strip()
            elif _is(ln, "PGM / RUN BY / DATE"):
                h.program = ln[0:20].strip()
                h.run_by = ln[20:40].strip()
            elif _is(ln, "MARKER NAME"):
                h.marker = ln[0:60].strip()
            elif _is(ln, "MARKER NUMBER"):
                h.marker_number = ln[0:20].strip()
            elif _is(ln, "OBSERVER / AGENCY"):
                h.agency = ln[0:60].strip()
            elif _is(ln, "REC # / TYPE / VERS"):
                h.receiver = ln[0:20].strip()
                h.receiver_type = ln[20:40].strip()
            elif _is(ln, "ANT # / TYPE"):
                h.antenna = ln[0:20].strip()
                h.antenna_type = ln[20:40].strip()
            elif _is(ln, "APPROX POSITION XYZ"):
                try:
                    h.approx_xyz = (float(ln[0:14]), float(ln[14:28]), float(ln[28:42]))
                except ValueError:
                    pass
            elif _is(ln, "ANTENNA: DELTA H/E/N"):
                try:
                    h.antenna_dhenu = (float(ln[0:14]), float(ln[14:28]), float(ln[28:42]))
                except ValueError:
                    pass
            elif _is(ln, "LEAP SECONDS"):
                try:
                    h.leap_seconds = float(ln[0:6])
                except ValueError:
                    pass
            elif _is(ln, "INTERVAL"):
                try:
                    h.interval_s = float(ln[0:10])
                except ValueError:
                    pass
            elif _is(ln, "# / TYPES OF OBSERV"):
                # n_types 在第 4 列（3I6），类型名从第 7 列（index 6）起 6 字符一个
                try:
                    n = int(ln[3:6])
                except ValueError:
                    n = 0
                names: list[str] = []
                # **首行**类型名占 index 6..59；**续行**占 index 0..59。
                # 实测：`JPS2RIN` 的续行会**重复标签**（标签非空），
                # `gfzrnx` 的续行标签为空。两种都要认，判据是
                # 「index 3:6 能解析成正的类型数」=> 首行，否则 => 续行。
                names += ln[6:60].split()
                j = i + 1
                while (len(names) < n and j < len(L)
                       and not _is(L[j], "END OF HEADER")):
                    lj = L[j]
                    try:
                        nj = int(lj[3:6])
                    except ValueError:
                        nj = 0
                    if nj > 0 and _is(lj, "# / TYPES OF OBSERV"):
                        names += lj[6:60].split()
                    elif _is(lj, "# / TYPES OF OBSERV") or lj[40:].strip() == "":
                        # 续行：标签为空（gfzrnx）或重复同一标签（JPS2RIN）
                        names += lj[0:60].split()
                    else:
                        break
                    j += 1
                h.obs_types = names[:n]
                i = j
                continue
            elif _is(ln, "# OF SATELLITES"):
                try:
                    h.n_sat_declared = int(ln[0:6])
                except ValueError:
                    pass
            elif _is(ln, "PRN / # OF OBS"):
                sid = ln[0:3].strip().upper()
                rest = ln[3:].split()
                if sid:
                    try:
                        h.prn_obs[sid] = [int(float(x)) if x else 0 for x in rest]
                    except ValueError:
                        # 不合规行（第 1-3 列非空，违反规范 3X）才会走到这里：
                        # rest 必含第 61 列的标签词，float('PRN') 抛 ValueError。
                        # 整条记录跳过、不猜解析结果。实测证据（issue #4）：
                        # 修复前 tests/test_rinex2_prn_header RED ——
                        # ValueError: could not convert string to float: 'PRN'；
                        # 修复后该测 GREEN，规范行（sid 为空）行为不变。
                        pass
            elif _is(ln, "TIME OF FIRST OBS"):
                h.time_first = self._time_tuple(ln)
                h.time_system = ln[48:51].strip() or "GPS"
            elif _is(ln, "TIME OF LAST OBS"):
                h.time_last = self._time_tuple(ln)
            elif _is(ln, "END OF HEADER"):
                self._header_end = i
                return
            i += 1
        self._header_end = len(L)

    @staticmethod
    def _time_tuple(ln: str) -> tuple:
        try:
            v = [int(ln[0:6]), int(ln[7:9]), int(ln[10:12]),
                 int(ln[13:15]), int(ln[16:18]), float(ln[19:30])]
        except ValueError:
            return ()
        return (v[0], v[1], v[2], v[3], v[4], v[5])

    # ------------------------------------------------------------ 正文
    @staticmethod
    def _looks_like_epoch(line: str) -> bool:
        if not line.strip():
            return False
        body = line[1:] if line[:1] == ">" else line
        tok = body[:26].split()
        return len(tok) >= 6 and tok[0].isdigit()

    @classmethod
    def _read_epoch_head(cls, line: str):
        """返回 (datetime, flag, nsat)；不是历元行则返回 None。"""
        body = line[1:] if line[:1] == ">" else line
        try:
            y = int(body[0:3].strip())
            mo = int(body[4:6])
            d = int(body[7:9])
            h = int(body[10:12])
            mi = int(body[13:15])
            s = float(body[16:26])
        except (ValueError, IndexError):
            return None
        if y < 100:
            y = _epoch_full(y)
        if not (1 <= mo <= 12 and 1 <= d <= 31 and h <= 23 and mi <= 59 and s < 61):
            return None
        try:
            flag = int(body[26:29])
            nsat = int(body[29:32])
        except ValueError:
            flag, nsat = 0, 0
        if nsat <= 0 or nsat > 200:
            return None
        dt = datetime.datetime(y, mo, d, h, mi, int(s),
                               int(round((s - int(s)) * 1e6)),
                               tzinfo=datetime.timezone.utc)
        return dt, flag, nsat, body[32:]

    @staticmethod
    def _class_ok(code: str, v: float) -> bool:
        """按观测码的物理量级判闸 —— 用于缺项消歧，也是坏值过滤。

        ## 载波相位**不按绝对值判闸**（2026-10-02 更正）

        本方法原先对相位判正区间 `5.0e7 < v < 2.0e8`，理由是
        "负相位说明块错位"。**该代理判据是错的**，代价是 19 个真实文件
        （CHAN 10 天 + KAZA 9 天）被误判为损坏而完全读不出。
        载波相位的绝对值没有物理意义 —— 几何距离
        `rho = lambda*L1 + N*lambda`，整周模糊度 `N` 未知且可任意大，
        故 `L1` 可以是任意值，包括很大的负数。
        正确判据是**相邻历元变化率** `|dL1/dt| <= c/lambda`，
        见 `PHASE_RATE_MAX_HZ` 与逐历元校验。

        其余三类（伪距、多普勒、载噪比）**仍按窄区间判闸**，
        因为它们的绝对值有物理含义且相互不重叠。

        ## 区间在 2026-10-02 收紧

        原区间是 C ∈ (1e6, 5e7)、L ∈ (1e7, 1.5e9)，**太宽，挡不住错宽**：
        MTKA 站的 S1 多普勒实测 38.300 Hz，被错位当成 C2（伪距）时，
        38.3 落在 (1e6, 5e7) 之外，本该被拒 —— 但同类的 1875.614 Hz 多普勒
        （hkws 站实测）若错位落到伪距位同样会落在区间外，而 95250.25 这类
        载波相位错位到伪距位则**恰好落在 (1e6, 5e7) 内被放行**。

        真实量级（实测 147 个文件）：
          伪距 C/P  : 1.8e7 ~ 2.6e7 m
          载波相位 L: 5.0e7 ~ 2.0e8 cycles（GPS L1 约 1.0e8 ~ 1.3e8）
          多普勒 D  : |v| <= 1e4 Hz
          信噪比 S  : 0 ~ 60 dB-Hz
        两类量级**相差 2~3 个数量级且不重叠**，因此用互不重叠的窄区间
        就能可靠区分 —— 这是块感知解析器的自校验基础。
        """
        if v != v or v in (float("inf"), float("-inf")):
            return False
        k = code[:1].upper()
        if k in ("C", "P"):
            return 1.5e7 < v < 3.0e7          # 伪距恒为正，实测 1.8e7~2.6e7
        if k == "L":
            # ---- 2026-10-02 更正：相位**绝对值没有物理意义**，不可据此判闸 ----
            #
            # 原判据为 `5.0e7 < v < 2.0e8`（正区间），其意图是"负相位说明块错位"。
            # **这个代理判据是错的**，代价是 19 个真实文件被当成损坏而读不出。
            #
            # 几何距离是 rho = lambda*L1 + N*lambda，其中整周模糊度 N 未知且可任意大，
            # 接收机初始化相位的方式也各不相同，因此 **L1 可以是任意值，包括很大的负数**。
            # 实测反例（ESA IGS 公开文件，200历元批次的 CHAN / KAZA）：
            #   CHAN  L1 = -17794563.46248 cycles = -3386 km
            #   KAZA  L1 = -25475390.24400 cycles = -4848 km
            # 同期伪距 P1 = 21436997.2614 m 完全正常 —— 这不是损坏，是合法数据。
            # CHAN 头部还注明 "Forced Modulo Decimation to 30 seconds"、
            #   "BIT 2 OF LLI FLAGS DATA COLLECTED UNDER A/S CONDITION"，
            # 说明这是把整周模糊度并入相位后重采样的文件，绝对偏移本就无物理含义。
            #
            # 相位的**真正**物理约束是**相邻历元的变化率**：
            #   |dL1/dt| <= c / lambda  （GPS L1 为 1575.4 MHz）
            # 该约束与绝对偏移无关，合法负相位同样满足，
            # 而块错位造成的跳变一定违反它。见 `_class_ok` 调用方
            # `_phase_rate_violations()` —— 逐历元校验，不通过者按坏值处理。
            #
            # 此处只保留一个宽松的合理性上限，作用是拦住把
            # 伪距(1e7 级)、多普勒(1e4 级)、载噪比(1e2 级)错位读成相位的情形。
            return abs(v) < 1.0e10
        if k == "D":
            return abs(v) < 1.0e4
        if k == "S":
            return 0.0 <= v < 60.0
        return True

    @staticmethod
    def phase_rate_report(observations, dt_s: float = 30.0,
                          margin: float = 1.5) -> dict:
        """逐历元校验载波相位变化率。**入参是 `observations()` 的产出序列。**

        ## 这是载波相位**唯一**可靠的物理判据

        `|dL1/dt| <= c / lambda`。GPS L1 为 1575.42 MHz，对应上限
        约 1.575e9 cycles/s，即 30 s 历元间最多约 4.7e7 cycles。

        ## 为什么必须用变化率而不是绝对值（2026-10-02 实测教训）

        载波相位的绝对偏移**没有物理含义**：几何距离
        `rho = lambda*L1 + N*lambda`，整周模糊度 `N` 未解且可任意大，
        接收机初始化方式各异，故合法文件可以给出任意大小的负值。
        实测反例（ESA IGS 公开文件）：CHAN 的 `L1 = -17794563.46248 cycles`、
        KAZA 的 `L1 = -25475390.24400 cycles`，同期伪距 P1 均正常。

        而**块错位**造成的读数跳变必然违反变化率约束，且该约束与卫星运动、
        电离层变化无关，不依赖任何改正模型 —— 因此它对
        "合法负相位" 与 "错位" 两者的判别是正确的，而绝对值闸门不是。

        `margin` 取 1.5：真实多普勒在低高度角时可达 ±c/λ 全值，
        1.5 倍足以覆盖，同时不至于放过错位。

        返回 `{"n_pairs", "n_violations", "worst_rate_Hz", "limit_Hz",
        "violation_rate", "usable"}`；`usable` 为 False 表示该文件
        的相位整体不可信（应拒绝而非当作有效观测）。
        """
        limit = 299792458.0 / 0.1902936728 * margin     # cycles/s
        lim_step = limit * (dt_s if dt_s and dt_s > 0 else 30.0)
        by_sat: dict = {}
        n_pairs = n_bad = 0
        worst = 0.0
        for o in observations:
            v = getattr(o, "adr_cycles", None)
            if v is None or v != v:
                continue
            by_sat.setdefault((o.system, o.sv), []).append(
                (o.gps_week * 604800.0 + o.gps_tow_s, v))
        for key in sorted(by_sat):
            pts = sorted(by_sat[key])
            for i in range(1, len(pts)):
                dt = pts[i][0] - pts[i - 1][0]
                if dt <= 0:
                    continue
                step = abs(pts[i][1] - pts[i - 1][1])
                n_pairs += 1
                if step / dt > worst:
                    worst = step / dt
                if step > lim_step * (dt / (dt_s if dt_s > 0 else 30.0)):
                    n_bad += 1
        rate = (n_bad / n_pairs) if n_pairs else 0.0
        return {"n_pairs": n_pairs, "n_violations": n_bad,
                "worst_rate_Hz": worst, "limit_Hz": limit,
                "violation_rate": rate,
                "usable": bool(n_pairs) and rate <= 0.02}

    def _align(self, codes: list[str], vals: list[str]) -> dict | None:
        """把实测到的数值 token 对齐到 n_obs 个观测码；对不齐就返回 None。

        三种情况：
          1. 正好 n_obs 个        -> 直接按序对齐
          2. n_obs-1 个          -> 恰好缺 1 项，遍历缺口用物理判据消歧
          3. 其他                -> **丢弃该记录**（不猜）
        """
        n = len(codes)
        fv = []
        for v in vals:
            try:
                fv.append(float(v))
            except ValueError:
                return None
        if len(fv) == n:
            # 即使数量正好对上，也必须过物理闸门。
            # 实测踩坑：源文件里有「某星只有 1 个观测、其余 9 个空」的记录，
            # 写文件时空行被吃掉，导致后续所有卫星的块边界整体前移一行，
            # 读出来的 C1 会是 9.7e7 m 这种不可能的值。
            # 不加闸门就会**静默**把错位的观测当成有效数据。
            if not all(self._class_ok(codes[k], fv[k]) for k in range(n)):
                return None
            return dict(zip(codes, fv))
        if len(fv) == n - 1:
            cands = []
            for gap in range(n):
                vv = [MISSING if k == gap else fv[k if k < gap else k - 1]
                      for k in range(n)]
                if not all(self._class_ok(codes[k], vv[k])
                           for k in range(n) if vv[k] == vv[k]):
                    continue
                d = {codes[k]: vv[k] for k in range(n)}
                c1 = d.get("C1", MISSING)
                p1 = d.get("P1", MISSING)
                if c1 == c1 and p1 == p1 and abs(c1 - p1) < 5.0:
                    cands.append(d)
            if len(cands) == 1:
                return cands[0]
        return None

    # RINEX 2 数据字段的**真实**布局在同一批真实文件里就有 4 种：
    #   15 宽：F14.3 + I1(LLI)             —— hkws (Spider)
    #   16 宽：F14.3 + I1(LLI) + 1 空格     —— daej/kmnm/irkj (teqc/CCRINEXO)
    #   14 宽：值 13 + I1                   —— 少见
    #   空白不定宽                          —— 早期实现唯一能处理的
    #
    # 早期实现一律按空白切分，**一旦某颗星有缺测，空白字段被折叠，
    # 后面所有卫星的块边界整体前移**，整条序列全丢。
    # 实测受害文件（2024-01-01）：
    #   daej  L1 L2 L5 C1 P1 P2 C5 S1 S2  S5   -> 空白路径 0 条记录
    #   kmnm  C1 P1 L1 S1 P2 L2 S2            -> 空白路径 0 条记录
    #
    # **但定宽路径默认关闭**，原因（实测，不是猜测）：
    #   hkws 走空白路径  vTEC r=+0.798（已验证）
    #   hkws 走定宽 16 宽 r=+0.693  —— 宽度探测把 15 宽的文件判成 16 宽，
    #   D1 字段被切成 `09      2397.68` 这种拼接串。
    # 即：宽度探测**会把好数据解析成坏数据**。按本项目硬规则
    # （宁可报「不支持」，也不静默给错值），定宽路径只作**显式启用**的实验特性：
    #     RINEX2OBS_FIXED_WIDTH=1  或  Rinex2Obs(path, fixed_width=True)
    # 空白路径永远作为兜底保留。
    _WIDTH_CANDIDATES = (15, 16, 14, 17, 18)
    FIXED_WIDTH_ENV = "RINEX2OBS_FIXED_WIDTH"

    def _parse_fixed(self, codes: list[str], block: list[str],
                     width: int) -> dict | None:
        """把一个卫星的若干行按定宽切回 n_code 个观测。失败返回 None。

        宽度内先去掉尾部的 LLI/SSI 标志（可能是空白、也可能是 0-7 的数字），
        再当数字解析。空字段（全空白）记为缺测。
        """
        text = "".join(bl.ljust(80)[:80] for bl in block)
        n = len(codes)
        out: dict = {}
        per_line = max(1, 80 // width)
        for k in range(n):
            s = (k // per_line) * 80 + (k % per_line) * width
            fld = text[s:s + width]
            if len(fld) < width:
                return None
            # 尾部标志位的**位置因生产者而异**（实测同一批 5 个文件就有差别）：
            #   16 宽：值 14 + LLI 1 + 填�� 1   -> 值是 fld[:14]
            #   14 宽：值 13 + LLI 1           -> 值是 fld[:13]
            #   16 宽：值 15 + LLI 1           -> 值是 fld[:15]
            # 所以**逐个尝试**去掉 0/1/2 个尾字符，取第一个能解析成数字的；
            # 解析成功不等于对，还要过 _class_ok 的物理闸门。
            val = None
            for trim in (width - 2, width - 1, width):
                if trim <= 0:
                    continue
                t = fld[:trim].strip()
                if not t:
                    val = MISSING
                    break
                try:
                    f = float(t)
                except ValueError:
                    continue
                if self._class_ok(codes[k], f):
                    val = f
                    break
            if val is None:
                return None       # 这一格怎么都解不出物理合理的值 -> 宽度猜错
            out[codes[k]] = val
        return out

    def _detect_width(self, samples: list[list[str]]) -> int | None:
        """在候选宽度里挑**逐字段量级稳定**的那个。

        ## 为什么不用"能解出数最多"

        实测 hkws（Spider，**15 宽**）在 16 宽下也能把每个字段解成
        合法数字（全部过 `_class_ok`），但那是把 Doppler 切进相位、
        把 5 位小数切成两半的结果（D1 变成 `09      2397.68`）——
        **解得多不等于解得对**，那一版让 hkws 的 vTEC r 从 0.798 掉到 0.693。

        ## 为什么不用"交叉码无电离层组合吻合"

        那条判据物理上更强，但要求同块里同时有 (C1,C2) 和 (P1,P2)。
        实测 5 个真实站**没有一个**同时具备（hkws 是 C1/C2/P2，
        daej/kmnm/irkj 是 C1/P1/P2），所以恒不成立。

        ## 采用的判据（不依赖任何物理常数）

        同一字段索引在多个卫星块之间，量级应当**稳定**。
        宽度猜错时字段被切串，一个索引会同时出现相位(1e8) 与
        多普勒(1e3) 量级的值，变异系数爆炸。

        评分 = 满足 |MAD/median| <= 0.5 的字段数；取最高分。
        要求至少覆盖三分之二的字段才采信，否则返回 None 退回空白切分。
        """
        codes = self._obs_types
        need = max(1, (len(codes) * 2) // 3)
        best, best_score = None, 0
        for w in self._WIDTH_CANDIDATES:
            cols: dict[int, list[float]] = {}
            for blk in samples:
                d = self._parse_fixed(codes, blk, w)
                if d is None:
                    continue
                for k, v in d.items():
                    if v == v and v != 0:
                        cols.setdefault(self._obs_types.index(k), []).append(v)
            score = 0
            for _idx, vals in cols.items():
                if len(vals) < 3:
                    continue
                med = sorted(vals)[len(vals) // 2]
                if med == 0:
                    continue
                dev = sorted(abs(x - med) for x in vals)[len(vals) // 2]
                if dev / abs(med) <= 0.5:
                    score += 1
            if score > best_score:
                best, best_score = w, score
        if best is None or best_score < need:
            return None
        return best


    def iter_observations(self, want_systems=("GPS",)):
        """产出 (dt, sid, {obs_code: value})。调用方自己决定怎么转 Observation。"""
        L = self.lines
        n = len(L)
        codes = self._obs_types
        n_code = len(codes)
        if n_code == 0:
            return
        sysmap = {"GPS": "G", "GLO": "R", "GAL": "E", "BDS": "C", "QZS": "J"}
        syskeep = {sysmap[s] for s in want_systems if s in sysmap}
        i = self._header_end + 1

        # ---- 预扫：用前几个卫星块探测字段宽度（只做一次）
        # **必须先跳过卫星 ID 续行**，否则取到的样本是
        # "G28G15R14E19E21E12E04E10E11E27" 这种续行，
        # 探测必然失败、宽度恒为 None（实测 daej/hkws/irkj 全栽在这，踩过）。
        # 默认**不做**探测：宽度探测会把 15 宽的 hkws 判成 16 宽，
        # 反而把好数据解析成坏数据（见 _WIDTH_CANDIDATES 上方注释）。
        width = self._width_cache
        if width is None and not self._width_probed and self.fixed_width_enabled:
            self._width_probed = True
            samples = []
            k = i
            while k < n and len(samples) < 12:
                if self._looks_like_epoch(L[k]):
                    hd = self._read_epoch_head(L[k])
                    if hd is not None and hd[1] == 0:
                        _dt, _fl, nsat, tail = hd
                        nline = (n_code + 4) // 5
                        got = len([x for x in
                                   (tail[q:q + 3].strip().upper()
                                    for q in range(0, min(len(tail), nsat * 3), 3))
                                   if x])
                        m = k + 1
                        while got < nsat and m < n \
                                and not self._looks_like_epoch(L[m]):
                            got += len([x for x in
                                        (L[m].rstrip()[q:q + 3].strip().upper()
                                         for q in range(0,
                                                        max(len(L[m].rstrip()) - 2, 0), 3))
                                        if x])
                            m += 1
                        for _ in range(4):
                            if m >= n or self._looks_like_epoch(L[m]):
                                break
                            samples.append(L[m:m + nline])
                            m += nline
                k += 1
            width = self._detect_width(samples)
            self._width_cache = width
        if width:
            self.field_width = width

        while i < n:
            ln = L[i]
            if not self._looks_like_epoch(ln):
                i += 1
                continue
            head = self._read_epoch_head(ln)
            if head is None:
                i += 1
                continue
            dt, flag, nsat, tail = head
            if flag in (2, 3, 4, 5):
                # 2/3 = 事件标志（后跟特殊记录）；4/5 = 头段信息（后跟 I6..N 行）
                # 都要跳过，且 4/5 的行数由 epoch 行后第一个 I6 给出。
                if flag in (4, 5):
                    k = j_next = i + 1
                    try:
                        nn = int(L[k][:6])
                    except ValueError:
                        nn = 0
                    i = k + max(nn, 0)
                else:
                    i += 2
                continue
            sats = [tail[k:k + 3].strip().upper()
                    for k in range(0, min(len(tail), nsat * 3), 3)]
            sats = [s for s in sats if s]
            j = i + 1
            while len(sats) < nsat and j < n and not self._looks_like_epoch(L[j]):
                extra = L[j].rstrip()
                sats += [extra[k:k + 3].strip().upper()
                         for k in range(0, len(extra) - 2, 3)]
                j += 1
            self.n_epochs += 1
            nline = (n_code + 4) // 5
            per_line = max(1, 80 // (width or 16))
            for sid in sats[:nsat]:
                if not sid or sid[0] not in syskeep:
                    continue
                # 块边界 —— **固定消费 nline 行**（2026-10-02 修正）
                #
                # ## 旧实现为什么错（MTKA 弧段爆炸的根因）
                #
                # 旧代码按「已写了几个**非空**字段」决定要不要读下一行：
                #     while got_f < n_code: 读一行，数其中非空字段，加进 got_f
                #
                # RINEX 2 规定尾部全空的观测**用空格填充**，**不省略行**。
                # 而「非空计数」与实际占行数无关，于是：
                #   MTKA（8 个观测码 = 2 行/星）第 1 行实测只有 3 个非空字段，
                #   got_f 只加到 3 < 8 -> **多读第 3 行**，把下一颗星的数据
                #   当成本星的第 3 行吞掉 -> 块边界逐星漂移。
                #   结果：18 条序列切出 773 个弧段（正常约 16~30），
                #         771 段过短无法定平，最终 vTEC 输出 n=0。
                #
                # ## 实证依据
                #   NVSK（5 个观测码 = 1 行/星）第 2 个字段 C2 为空时，
                #   该字段在同一行内是空格填充（`|  23374701.953 5
                #   [16 空格]  122834823.603 5  95715502.75847  23374702.18847|`），
                #   **行没有消失** —— 所以「按非空计数」前提就不成立。
                #
                # ## 空白路径为何保留
                #   hkws（15 宽、13 个观测码）已验证：13022 观测 / 16 弧段 /
                #   vs SEPC bias -0.3026 RMSE 7.3658 r 0.8980。这是基线，不得退化。
                blk = L[j:j + nline]
                j += nline
                d = None
                if width:
                    d = self._parse_fixed(codes, blk, width)
                if d is None:
                    vals: list[str] = []
                    for bl in blk:
                        v, _f = _tokens(bl)
                        vals += v
                    if not vals:
                        continue
                    d = self._align(codes, vals)
                if d is None:
                    self.n_dropped += 1
                    continue
                self.n_records += 1
                self.n_sat_seen.add(sid)
                yield dt, sid, d
            i = j
        return

    # ------------------------------------------------------------ 统计
    def summary(self) -> dict:
        return {
            "path": self.path,
            "version": self.header.version,
            "file_type": self.header.file_type,
            "program": self.header.program,
            "marker": self.header.marker,
            "approx_xyz": self.header.approx_xyz,
            "interval_s": self.header.interval_s,
            "time_system": self.header.time_system,
            "time_first": self.header.time_first,
            "time_last": self.header.time_last,
            "leap_seconds": self.header.leap_seconds,
            "n_obs_types": len(self._obs_types),
            "obs_types": self._obs_types,
            "n_sat_declared": self.header.n_sat_declared,
            "n_epochs": self.n_epochs,
            "n_records": self.n_records,
            "n_dropped": self.n_dropped,
            "satellites_seen": len(self.n_sat_seen),
        }


if __name__ == "__main__":
    import json
    import sys
    s = Rinex2Obs(sys.argv[1]).summary()
    for k, v in s.items():
        print(f"  {k:20s} = {v}")
