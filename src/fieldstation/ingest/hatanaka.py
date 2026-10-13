#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RINEX 紧缩（Hatanaka / crx）解压 + RINEX 3.04 观测/导航解析。

纯标准库。

Hatanaka 记录结构（CDDIS "RINEX Hatanaka Compression" 规范）：
    'd' <十进制长度 n> <n 个字符的片段> <1 个控制字符>
  - 长度 n 是**本片段**的字符数
  - 控制字符若为空格，表示本片段就是整行结束，无需再删字符
  - 控制字符若非空格，其 ASCII 值减 32 得到 k，表示**在拼上下一片段之前，
    要先把已拼内容末尾的 k 个字符删掉**（这些字符是被压缩掉的、在原行中
    位于此处但可由规范恢复的部分）
非 'd' 开头的记录（文件头、以及偶发的原样行）整行保留。

本模块对解压结果做**可判定自检**（见 self_check），不靠"看起来对"。
"""
from __future__ import annotations

import gzip
import io
import math
import re
from dataclasses import dataclass, field
from typing import Optional

MISSING = float("nan")

# ---------------------------------------------------------------- gunzip

def gunzip_if_needed(data: bytes) -> bytes:
    """识别 gzip 魔数 1f 8b 并解压，否则原样返回。"""
    if len(data) >= 2 and data[0] == 0x1F and data[1] == 0x8B:
        return gzip.decompress(data)
    return data


def read_bytes(path: str) -> bytes:
    with open(path, "rb") as f:
        return gunzip_if_needed(f.read())


# ---------------------------------------------------------------- Hatanaka

def decompress_hatanaka(text: str) -> str:
    """把紧缩体还原为普通 RINEX 文本（保持行数与定长对齐）。"""
    out: list[str] = []
    del_k = 0          # 下一个片段拼上来之前，要从 out 末尾删掉的字符数
    for raw in text.split("\n"):
        if raw.endswith("\r"):
            raw = raw[:-1]
        if raw[:1] == "d":
            i, n = 1, 0
            while i < len(raw) and raw[i].isdigit():
                n = n * 10 + (ord(raw[i]) - 48)
                i += 1
            seg = raw[i:i + n]
            ctrl = raw[i + n] if (i + n) < len(raw) else " "
            if del_k:
                joined = "".join(out)
                out = [joined[:len(joined) - del_k]] if len(joined) > del_k else []
                del_k = 0
            out.append(seg)
            if ctrl != " ":
                del_k = ord(ctrl) - 32
        else:
            if del_k:
                joined = "".join(out)
                out = [joined[:len(joined) - del_k]] if len(joined) > del_k else []
                del_k = 0
            out.append(raw)
    return "\n".join(out)


def read_hatanaka_rinex(path: str) -> str:
    """gunzip + 解压，返回完整文本。普通 .rnx / .rnx.gz 也能直接走这条路径。"""
    return decompress_hatanaka(read_bytes(path).decode("latin-1"))


# ---------------------------------------------------------------- 头段

@dataclass
class RinexHeader:
    version: str = ""
    rinex_type: str = ""
    marker: str = ""
    receiver: str = ""
    receiver_type: str = ""
    antenna: str = ""
    antenna_type: str = ""
    approx_xyz: tuple = (MISSING, MISSING, MISSING)   # ECEF, m
    antenna_dhenu: tuple = (0.0, 0.0, 0.0)             # H 向上, E 北, N 东 (m)
    time_of_first_obs: tuple = ()                      # (y,m,d,h,mi,s)
    time_system: str = ""
    interval_s: float = MISSING
    obs_types: dict = field(default_factory=dict)      # {sys: [codes]}
    n_systems: int = 0

    @property
    def station(self) -> str:
        return self.marker or ""

    def geodetic(self) -> tuple:
        """APPROX POSITION XYZ -> (lat_deg, lon_deg, h_m)。WGS84。"""
        x, y, z = self.approx_xyz
        if any(v != v for v in (x, y, z)):     # NaN 检查
            return (MISSING, MISSING, MISSING)
        a, f = 6378137.0, 1.0 / 298.257223563
        e2 = 2 * f - f * f
        lon = math.atan2(y, x)
        p = math.hypot(x, y)
        lat = math.atan2(z, p * (1 - e2))
        for _ in range(8):
            n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
            h = p / math.cos(lat) - n
            lat = math.atan2(z, p * (1 - e2 * n / (n + h)))
        n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
        h = p / math.cos(lat) - n
        return (math.degrees(lat), math.degrees(lon), h)


def _f(tok: str) -> float:
    tok = tok.strip()
    if tok == "":
        return MISSING
    try:
        return float(tok)
    except ValueError:
        return MISSING


def parse_header(lines: list) -> RinexHeader:
    h = RinexHeader()
    i = 0
    in_obs = False
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("END OF HEADER"):
            break
        i += 1
        if in_obs:
            if ln.startswith("END OF OBSERVATION TYPES"):
                in_obs = False
                continue
            parts = ln[:60].split()
            if len(parts) >= 2:
                h.obs_types[parts[0]] = parts[1:]
            else:
                sysname = ln[:1]
                codes = ln[3:60].split()
                if codes:
                    h.obs_types.setdefault(sysname, []).extend(codes)
            continue
        if "LABEL / VERSION / TYPE" in ln:
            h.version = ln[0:20].strip()
            h.rinex_type = ln[40:80].strip()
        elif "MARKER NAME" in ln:
            h.marker = ln[20:60].strip()
        elif ln.startswith("REC # / TYPE / VERS"):
            h.receiver = ln[0:20].strip()
            h.receiver_type = ln[20:40].strip()
        elif ln.startswith("ANT # / TYPE"):
            h.antenna = ln[0:20].strip()
            h.antenna_type = ln[20:40].strip()
        elif "APPROX POSITION XYZ" in ln:
            h.approx_xyz = (_f(ln[0:14]), _f(ln[14:28]), _f(ln[28:42]))
        elif "ANTENNA: DELTA H/E/N" in ln:
            h.antenna_dhenu = (_f(ln[0:14]), _f(ln[14:22]), _f(ln[22:30]))
        elif "TIME OF FIRST OBS" in ln:
            toks = ln.split()
            try:
                h.time_of_first_obs = (int(toks[0]), int(toks[1]), int(toks[2]),
                                       int(toks[3]), int(toks[4]), float(toks[5]))
            except Exception:
                pass
            h.time_system = ln[48:55].strip()
        elif "INTERVAL" in ln:
            h.interval_s = _f(ln[0:10])
        elif "OBSERVATION TYPES" in ln:
            in_obs = True
    h.n_systems = len(h.obs_types)
    return h


def split_sections(text: str) -> tuple:
    """返回 (header_lines, body_lines, header_obj)。"""
    lines = text.split("\n")
    idx = None
    for i, ln in enumerate(lines):
        if ln.startswith("END OF HEADER"):
            idx = i
            break
    if idx is None:
        raise ValueError("找不到 END OF HEADER —— 解压或文件格式有问题")
    return lines[:idx + 1], lines[idx + 1:], parse_header(lines[:idx + 1])


# ---------------------------------------------------------------- 自检

def self_check(text: str) -> dict:
    """对解压结果做可判定自检。"""
    res = {"has_end_of_header": False, "n_header_lines": 0,
           "n_epochs": 0, "n_body_lines": 0, "line_lengths_ok": None}
    lines = text.split("\n")
    for i, ln in enumerate(lines):
        if ln.startswith("END OF HEADER"):
            res["has_end_of_header"] = True
            res["n_header_lines"] = i + 1
            break
    body = lines[res["n_header_lines"]:]
    res["n_body_lines"] = len(body)
    res["n_epochs"] = sum(1 for ln in body if ln.startswith(">"))
    return res


if __name__ == "__main__":
    import sys
    p = sys.argv[1]
    txt = read_hatanaka_rinex(p)
    r = self_check(txt)
    for k, v in r.items():
        print(f"{k} = {v}")
    hl, bl, hd = split_sections(txt)
    print("version   =", hd.version, "| type =", hd.rinex_type)
    print("marker    =", hd.marker)
    print("receiver  =", hd.receiver, hd.receiver_type)
    print("antenna   =", hd.antenna, hd.antenna_type)
    print("xyz       =", hd.approx_xyz)
    print("geodetic  =", hd.geodetic())
    print("dhenu     =", hd.antenna_dhenu)
    print("tofo      =", hd.time_of_first_obs, hd.time_system, "interval =", hd.interval_s)
    print("obs_types =", hd.obs_types)
    # 前 3 条历元行原样打印，供人工核对
    k = 0
    for ln in bl:
        if ln.startswith(">"):
            print("EPOCH>", ln)
            k += 1
            if k >= 3:
                break
