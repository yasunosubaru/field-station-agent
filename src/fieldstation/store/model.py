"""台站通用观测模型（M2-1）。

**为什么存在**：`src/fieldstation/model.py` —— 父包里那个 `model.py`，**不是本文件** ——
是搬运件、只读，且专为 GNSS 而写。台站的传感 / 供电 / 网络 / 安防四类数据要有一个
统一模型，M2-2 的适配器与 M3 的智能体都拿它当输入。

**口径**：字段名一旦定下就别改 —— M1-a 的数据字典正在往这张表上挂，
`examples/stations.json` 之类的台账也会引用同一批字段名。

**纯标准库**，不依赖第三方包。

**注意**：本文件是**新建**的，不在 `PROVENANCE.md` 的搬运件清单里，不受
"搬运件只读"约束 —— 但反过来也不属于任何历史项目的成果。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from math import isfinite
from typing import Iterable


@dataclass
class StationReading:
    """一条台站观测：某站、某设备、某个字段的某个取值。

    ``quality_flag`` 为空表示「还没判质」—— 那是正常的中间态，不是错。
    ``observed_at`` 用 ISO 8601 存，**不存时间戳数字**：各台站时区与
    闰秒处理各不相同，存字符串可以晚点再决定怎么对齐。
    """

    station_id: str
    sensor: str
    metric: str
    value: float
    unit: str
    observed_at: datetime
    quality_flag: str = ""


def validate_reading(
    reading: StationReading,
    *,
    units: Iterable[str] | None = None,
) -> list[str]:
    """返回**所有**问题（不要只报第一个就停）。空列表表示通过。

    ``units`` 是数据字典声明的单位集。传 None 或空集表示**不查单位** ——
    数据字典还没填完时不该拿一份半成品清单去误报。

    为什么单位集要传参而不是在代码里写死：单位清单的权威在数据字典。
    代码里写死一份，等真实台站报上来一个清单里没有的单位，就得改代码 ——
    而那个改动会同时改变「什么算合法」的判据，等于让代码去改需求。
    """
    problems: list[str] = []

    # 站名：必填、去空白。空站名会让下游按站名聚合时出现一个"无名氏"桶。
    sid = (reading.station_id or "").strip()
    if not sid:
        problems.append("station_id: 必填且不能为空")

    # 字段名：必填。没有字段名的观测无法归档。
    if not (reading.metric or "").strip():
        problems.append("metric: 必填且不能为空")

    # 设备：必填。观测必须能指回是哪个设备给的。
    if not (reading.sensor or "").strip():
        problems.append("sensor: 必填且不能为空")

    # 取值：必须有限。NaN 与 Inf 会让所有统计量变 NaN，而且不报错。
    if not isfinite(reading.value):
        problems.append(f"value: 必须是非 NaN/Inf 的有限数，收到 {reading.value!r}")

    # 单位：必填，且（给了清单时必须对上）。
    unit = (reading.unit or "").strip()
    if not unit:
        problems.append("unit: 必填且不能为空")
    elif units is not None:
        declared = {u.strip() for u in units}
        if declared and unit not in declared:
            problems.append(
                f"unit: {unit!r} 不在数据字典声明的单位集内（{len(declared)} 个）")

    return problems


def to_dict(reading: StationReading) -> dict:
    """转成 JSON 友好的字典。``observed_at`` 走 ISO 8601 字符串。"""
    return {
        "station_id": reading.station_id,
        "sensor": reading.sensor,
        "metric": reading.metric,
        "value": reading.value,
        "unit": reading.unit,
        "observed_at": reading.observed_at.isoformat(),
        "quality_flag": reading.quality_flag,
    }


def from_dict(d: dict) -> StationReading:
    """从字典还原。缺字段直接抛 ``TypeError`` —— 不猜默认值，
    因为猜出来的默认值会被当成真实观测混进数据里。
    """
    observed = d["observed_at"]
    if not isinstance(observed, datetime):
        observed = datetime.fromisoformat(str(observed))
    return StationReading(
        station_id=str(d["station_id"]),
        sensor=str(d["sensor"]),
        metric=str(d["metric"]),
        value=float(d["value"]),
        unit=str(d["unit"]),
        observed_at=observed,
        quality_flag=str(d.get("quality_flag", "")),
    )