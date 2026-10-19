"""设备状态监测工具：把 StationReading 记录压成可解释的健康度摘要。"""
from __future__ import annotations

import math
from datetime import datetime, timezone

from . import ToolResult


def _parse_time(value: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("observed_at 必须是非空 ISO 8601 字符串")
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


class StationHealthTool:
    name = "station_health"
    description = (
        "汇总台站传感/供电/网络/安防读数：按台站、设备、指标统计缺测、"
        "最小值、最大值、均值与健康度。value 为 null 计为缺测，不抛异常。"
    )
    params = {
        "readings": {
            "type": "array",
            "items": "object",
            "required": True,
            "description": (
                "StationReading 数组；每项含 station_id、sensor、metric、"
                "value、unit、observed_at、quality_flag"),
        }
    }
    risk = "low"

    def invoke(self, args: dict) -> ToolResult:
        readings = args.get("readings")
        if not isinstance(readings, list):
            return ToolResult(ok=False, error="参数 readings 必须是数组")
        if not readings:
            return ToolResult(ok=True, data={
                "stations": [],
                "summary": {"total": 0, "missing": 0, "alerts": []},
                "note": "没有读数，无法计算健康度",
            })

        groups: dict[tuple[str, str, str], dict] = {}
        latest: dict[str, datetime] = {}
        total = 0
        missing_total = 0

        for index, raw in enumerate(readings):
            prefix = f"readings[{index}]"
            if not isinstance(raw, dict):
                return ToolResult(ok=False, error=f"{prefix} 必须是 object")
            for key in ("station_id", "sensor", "metric", "unit"):
                value = raw.get(key)
                if not isinstance(value, str) or not value.strip():
                    return ToolResult(
                        ok=False, error=f"{prefix}.{key} 必须是非空字符串")
            try:
                observed = _parse_time(raw.get("observed_at"))
            except (TypeError, ValueError) as exc:
                return ToolResult(ok=False, error=f"{prefix}.observed_at 无效：{exc}")

            station = raw["station_id"].strip()
            sensor = raw["sensor"].strip()
            metric = raw["metric"].strip()
            unit = raw["unit"].strip()
            flag = raw.get("quality_flag", "")
            if not isinstance(flag, str):
                return ToolResult(
                    ok=False, error=f"{prefix}.quality_flag 必须是字符串")
            key = (station, sensor, metric)
            group = groups.setdefault(key, {
                "station_id": station,
                "sensor": sensor,
                "metric": metric,
                "unit": unit,
                "values": [],
                "missing": 0,
                "quality_flags": set(),
            })
            total += 1
            latest[station] = max(latest.get(station, observed), observed)
            if flag:
                group["quality_flags"].add(flag)

            value = raw.get("value")
            if (value is None or isinstance(value, bool)
                    or not isinstance(value, (int, float))
                    or not math.isfinite(float(value))):
                group["missing"] += 1
                missing_total += 1
            else:
                group["values"].append(float(value))

        stations: dict[str, dict] = {}
        for group in groups.values():
            station = stations.setdefault(group["station_id"], {
                "station_id": group["station_id"],
                "total": 0,
                "missing": 0,
                "quality_flags": set(),
                "metrics": [],
                "latest_observed_at": latest[group["station_id"]].isoformat(),
            })
            values = group["values"]
            station["total"] += len(values) + group["missing"]
            station["missing"] += group["missing"]
            station["quality_flags"].update(group["quality_flags"])
            station["metrics"].append({
                "sensor": group["sensor"],
                "metric": group["metric"],
                "unit": group["unit"],
                "count": len(values) + group["missing"],
                "missing": group["missing"],
                "min": min(values) if values else None,
                "max": max(values) if values else None,
                "mean": (sum(values) / len(values)) if values else None,
                "quality_flags": sorted(group["quality_flags"]),
            })

        out = []
        alerts = []
        for station in sorted(stations.values(), key=lambda s: s["station_id"]):
            score = round(1.0 - station["missing"] / station["total"], 3)
            flags = sorted(station.pop("quality_flags"))
            if score <= 0.5:
                status = "critical"
            elif score < 0.95 or flags:
                status = "degraded"
            else:
                status = "ok"
            station["health_score"] = score
            station["status"] = status
            station["quality_flags"] = flags
            station["metrics"].sort(key=lambda m: (m["sensor"], m["metric"]))
            out.append(station)
            if status != "ok":
                alerts.append(station["station_id"])

        return ToolResult(ok=True, data={
            "stations": out,
            "summary": {
                "total": total,
                "missing": missing_total,
                "alerts": alerts,
            },
        })


def station_health_tool() -> StationHealthTool:
    return StationHealthTool()
