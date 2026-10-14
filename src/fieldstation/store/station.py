# -*- coding: utf-8 -*-
"""台站台账数据模型。

**为什么存在**：智能体要判断"这个台站是不是出故障了"，必须先知道"这个台站长什么样" ——
它叫什么、装了什么接收机和天线、怎么供电、怎么联网、有没人守、在哪、高度多少、
下面挂了哪些传感器。在此之前仓库里**没有任何地方记录这些**，观测数据进来只有一串数字。

**口径**：字段名一旦定下就别改 —— `examples/stations.example.json` 会被 M1 调研
（issue #2）产生的真实台账替换，字段名改一次全仓库跟着动。

**纯标准库**，不依赖第三方包。

**注意**：本文件是**新建**的，不在 `PROVENANCE.md` 的搬运件清单里，因此不受
"搬运件只读"约束 —— 但反过来也不属于任何历史项目的成果。
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

# 枚举白名单：放这里是为了让测试有据可查，而不是散在 if 里
POWER_MODES = ("mains", "solar", "hybrid")
LINK_MODES = ("fiber", "4g", "satellite")

# 合理的物理边界（写死，理由见 validate）
LAT_RANGE = (-90.0, 90.0)
LON_RANGE = (-180.0, 180.0)
ALT_FLOOR_M = -500.0

# 唯一必填字段
_REQUIRED = ("code",)


@dataclass
class Station:
    """一座野外观测台站的台账记录。

    `code`（站名）是**唯一必填字段**，其余未填就是"台账还没补上"，
    与"填了空值"是两种状态 —— 由调用方决定是否视为不完整。
    """

    code: str
    receiver: str = ""
    antenna: str = ""
    power: str = ""
    link: str = ""
    manned: bool = False
    lat_deg: float | None = None
    lon_deg: float | None = None
    alt_m: float | None = None
    sensors: list[str] = field(default_factory=list)
    notes: str = ""


def validate(station: Station) -> list[str]:
    """返回**所有**问题（不要只报第一个就停）。

    一个问题不报就等于台账带病上线；返回列表让调用方一次性看清。
    """
    problems: list[str] = []

    # code：必填、长度上限。站名在 RINEX/GNSS 里是 4 字符，写死。
    code = (station.code or "").strip()
    if not code:
        problems.append("code: 必填且不能为空")
    elif len(code) > 4:
        problems.append(f"code: 长度 {len(code)} > 4（{code!r}）")

    # 枚举
    if station.power and station.power not in POWER_MODES:
        problems.append(
            f"power: {station.power!r} 不在 {POWER_MODES} 中"
        )
    if station.link and station.link not in LINK_MODES:
        problems.append(
            f"link: {station.link!r} 不在 {LINK_MODES} 中"
        )

    # 坐标：给的话必须在合法区间。None = 未填，不算错。
    for name, lo, hi, val in (
        ("lat_deg", *LAT_RANGE, station.lat_deg),
        ("lon_deg", *LON_RANGE, station.lon_deg),
        ("alt_m", ALT_FLOOR_M, None, station.alt_m),
    ):
        if val is None:
            continue
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            problems.append(f"{name}: 不是数值（{val!r}）")
        elif hi is None:
            if val < lo:
                problems.append(f"{name}: {val} < 下限 {lo}")
        elif not (lo <= val <= hi):
            problems.append(f"{name}: {val} 不在 [{lo}, {hi}] 内")

    # 传感器：去重后比较，重复登记本身是个台账问题
    sensors = list(station.sensors or [])
    dup = sorted({s for s in sensors if sensors.count(s) > 1})
    if dup:
        problems.append(f"sensors: 重复登记 {dup}")
    bad = [s for s in sensors if not isinstance(s, str) or not s.strip()]
    if bad:
        problems.append(f"sensors: 存在空/非字符串项 {bad!r}")

    return problems


def _known_keys() -> tuple[str, ...]:
    """Station 的所有字段名（顺序固定，用于 to_dict 与未知键检查）。"""
    return tuple(Station.__dataclass_fields__.keys())


def from_dict(d: dict) -> Station:
    """从字典构造 Station。

    - 缺 `code` → `ValueError`（信息里必须出现 `code`）
    - **未知键 → `ValueError`** —— 台账字段拼错字比缺字段更难查
      （缺了会报缺，多一个拼错的不会）
    """
    if not isinstance(d, dict):
        raise ValueError(f"station 记录必须是 dict，得到 {type(d).__name__}")

    unknown = [k for k in d if k not in _known_keys()]
    if unknown:
        raise ValueError(
            f"未知字段 {unknown}；合法字段: {list(_known_keys())}"
        )

    missing = [k for k in _REQUIRED if k not in d or d[k] in (None, "")]
    if missing:
        raise ValueError(f"缺少必填字段: {missing}")

    kw = dict(d)
    sensors = kw.get("sensors") or []
    kw["sensors"] = list(sensors)
    return Station(**kw)


def to_dict(station: Station) -> dict:
    """转回字典。

    **往返契约**：对"字段齐全且合法"的输入，`to_dict(from_dict(d)) == d` 成立
    （键集合、顺序、值都相同）。这是用 `asdict` 保顺序、不补默认值换来的
    —— 谁要"自动补齐缺失字段"，请在 from_dict 之后显式做。
    """
    return asdict(station)


def _read_json_list(path: str | Path) -> list:
    """读一个 JSON 数组，把文件级错误统一成 ValueError 并带上路径。"""
    p = Path(path)
    if not p.is_file():
        raise ValueError(f"台账文件不存在: {p}")
    try:
        raw = p.read_text(encoding="utf-8")
    except OSError as e:
        raise ValueError(f"台账文件无法读取: {p} ({e})") from e
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"台账不是合法 JSON: {p} ({e})") from e
    if not isinstance(data, list):
        raise ValueError(f"台账顶层必须是数组，得到 {type(data).__name__}: {p}")
    return data


def load_registry(path: str | Path) -> dict[str, Station]:
    """读台账 JSON → {code: Station}。

    集中报错（一次把**所有**台站的**所有**问题一起抛出），而不是撞到第一个就停
    —— 台账一次填十几个站，逐个改逐个重跑太慢。
    - 文件不存在 / 非合法 JSON / 顶层非数组 → ValueError
    - 重复 code → ValueError（宁可崩，也不静默丢掉一份）
    - 任一站记录不合法 → ValueError（列出全部问题）
    """
    records = _read_json_list(path)

    problems: list[str] = []
    registry: dict[str, Station] = {}
    for i, rec in enumerate(records):
        where = f"第 {i} 条"
        try:
            st = from_dict(rec)
        except ValueError as e:
            problems.append(f"{where}: {e}")
            continue
        errs = validate(st)
        if errs:
            problems.append(f"{where} ({st.code}): " + "; ".join(errs))
            continue
        code = st.code.strip()
        if code in registry:
            problems.append(f"{where}: code 重复 {code!r}（同一台账登记两次）")
            continue
        if code != st.code:
            # 只在有前导/尾随空格时才需要归一化；正常数据走不到
            problems.append(f"{where}: code {st.code!r} 含前导/尾随空白，请清洗")
            continue
        registry[code] = st

    if problems:
        raise ValueError("台账载入失败:\n  " + "\n  ".join(problems))
    return registry


def save_registry(registry: dict[str, Station], path: str | Path) -> Path:
    """把 `{code: Station}` 写回 。（存取对称：load 读什么，save 就写什么。）"""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = [to_dict(s) for s in registry.values()]
    p.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                 encoding="utf-8")
    return p
