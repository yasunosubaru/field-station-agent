"""公开数据版：公开气象数据 → 设备读数 → ``station_health`` → 记录。

用法：

    python harness/public_data_replay.py \
        --input data/public/samples/openmeteo_badg_202401_d01.json \
        --out logs/public_data_device_202401d01.json

数据源登记在 ``data/public/manifest.json``（来源、许可、校验和、用途），
取数用 ``tools/fetch_public_data.py``；映射口径见 ``docs/operations/public-data.md``。

本 harness 只用标准库与本仓模块；输出**不含时间戳**，同一份输入两次运行逐字节相同。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fieldstation.agents.tools.station_tools import station_health_tool  # noqa: E402
from fieldstation.store.model import StationReading, to_dict  # noqa: E402

MANIFEST = ROOT / "data" / "public" / "manifest.json"
LOG_KIND = "fieldstation.public_data_device.log"
LOG_VERSION = 1
STATION = "BADG"

#: Open-Meteo 的 hourly 变量 → 本仓读数口径 (sensor, metric, unit)
METRICS = {
    "temperature_2m": ("env", "temperature_c", "degC"),
    "relative_humidity_2m": ("env", "relative_humidity_percent", "%"),
    "surface_pressure": ("env", "surface_pressure_hpa", "hPa"),
    "wind_speed_10m": ("env", "wind_speed_mps", "m/s"),
}

CAVEAT = ("这是**环境**读数（气温/湿度/气压/风速），不是供电/链路/安防 —— "
          "后三类没有公开对应物，仍用 synthetic 的设备异常场景。")


def readings_from_open_meteo(data: dict, station: str = STATION) -> list[StationReading]:
    """Open-Meteo 逐小时 → 设备读数；缺测记 ``value=None`` + ``quality_flag="missing"``。"""
    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    if not times:
        raise ValueError("输入里没有 hourly.time —— 不是 Open-Meteo 的 archive 响应")
    readings: list[StationReading] = []
    for index, stamp in enumerate(times):
        observed_at = datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc)
        for key, (sensor, metric, unit) in METRICS.items():
            values = hourly.get(key) or []
            value = values[index] if index < len(values) else None
            readings.append(StationReading(
                station_id=station, sensor=sensor, metric=metric, value=value,
                unit=unit, observed_at=observed_at,
                quality_flag="" if value is not None else "missing"))
    return readings


def apply_low_temp_rule(readings: list[StationReading], *,
                        threshold_c: float = -10.0) -> list[StationReading]:
    """演示规则：气温低于阈值记 ``low_temp`` 质量标记（**示例阈值，非工程判据**）。

    只改 ``quality_flag``，不判健康度 —— 健康度仍由 ``station_health`` 统一计算。
    """
    out = []
    for reading in readings:
        if (reading.metric == "temperature_c" and reading.value is not None
                and reading.value < threshold_c):
            out.append(replace(reading, quality_flag="low_temp"))
        else:
            out.append(reading)
    return out


def _source_for(input_path: Path, digest: str) -> dict:
    """按 sha256 在清单里找源；找不到就只记文件本身。"""
    if not MANIFEST.is_file():
        return {}
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    for source in manifest.get("sources", []):
        if source.get("sha256") == digest:
            return {key: source.get(key) for key in
                    ("id", "title", "url", "license", "attribution",
                     "retrieved", "sha256", "used_for")}
    return {}


def run(input_path: Path, out_path: Path) -> dict:
    raw = input_path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    data = json.loads(raw.decode("utf-8"))
    readings = readings_from_open_meteo(data)
    result = station_health_tool().invoke(
        {"readings": [to_dict(reading) for reading in readings]})
    if not result.ok:
        raise ValueError(f"station_health 失败：{result.error}")
    times = data["hourly"]["time"]
    try:
        shown = input_path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        shown = input_path.name
    log = {
        "kind": LOG_KIND,
        "version": LOG_VERSION,
        "source": _source_for(input_path, digest),
        "input": {
            "path": shown,
            "sha256": digest,
            "records": len(times),
            "window": [times[0], times[-1]],
        },
        "mapping": {
            "station": STATION,
            "readings": len(readings),
            "metrics": [
                {"sensor": metric["sensor"], "metric": metric["metric"],
                 "unit": metric["unit"], "count": metric["count"],
                 "missing": metric["missing"]}
                for metric in result.data["stations"][0]["metrics"]
            ],
        },
        "health": result.data,
        "caveat": CAVEAT,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(log, ensure_ascii=False, indent=2,
                                sort_keys=True) + "\n")
    return log


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="公开数据版：公开气象 → 设备读数 → station_health")
    parser.add_argument("--input", required=True, help="Open-Meteo archive JSON")
    parser.add_argument("--out", required=True, help="输出记录路径")
    args = parser.parse_args(argv)

    try:
        log = run(Path(args.input), Path(args.out))
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"[阻断] {exc}")
        return 2
    station = log["health"]["stations"][0]
    print(f"[OK] {args.out}：台站 {station['station_id']} "
          f"健康度 {station['health_score']}（{station['status']}），"
          f"读数 {log['mapping']['readings']} 条，"
          f"缺测 {log['health']['summary']['missing']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
