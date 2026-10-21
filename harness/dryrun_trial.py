"""试运行演练（M6-1 / M6-2 / M6-3 的 dry run）。

真实台站试运行受 #28/#33 阻塞。这个 harness 先跑一遍**试运行的机器**：

* **设备侧**：公开气象数据（Open-Meteo 八达岭，2024-01 整月，CC BY 4.0）逐日切出
  24 小时 × 4 指标 → `station_health` → 状态 / 质量标记 / 缺测；
* **观测侧**：合成观测（每天一批 60 历元 × 2 颗星），**奇数日**在 GPS 01 L1 上注入
  5 cycle 持续阶跃，偶数日不注入 → 用 `slip_detect` 跑真实判据；
* **台账**：每天一行（数据源可用性 + 判据结果），汇总出可用率、检出率、误报率；
* **敏感度扫描**：注入幅度 1/2/3/5/10/20 cycles，看 `slip_detect` 的检出下限。

**这不是真实台站试运行**：观测是合成的，设备是环境再分析数据，也没有模型与操作时滞。
它验证的是试运行的**字段、口径、汇总与报告模板** —— 真实样本到位后换数据源重跑即可。

输出（确定性：无时间戳、无耗时）：
- ``logs/dryrun_trial_202401.json``：逐日记录 + 敏感度扫描；
- ``logs/dryrun_trial_summary_202401.json``：汇总。

用法：
    python harness/dryrun_trial.py
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fieldstation import synthetic  # noqa: E402
from fieldstation.agents.pipeline import observation_payload  # noqa: E402
from fieldstation.agents.tools.qc_tools import slip_detect_tool  # noqa: E402
from fieldstation.agents.tools.station_tools import station_health_tool  # noqa: E402
from fieldstation.store.model import StationReading, to_dict  # noqa: E402

CACHE = ROOT / "data" / "public" / "cache" / "openmeteo_badg_202401.json"
LOG_KIND = "fieldstation.dryrun_trial.log"
LOG_VERSION = 1
STATION = "BADG"
DAYS = 31
EPOCHS = 60
LOW_TEMP_C = -10.0
INJECT_CYCLES = 5.0
SENSITIVITY_CYCLES = (1.0, 2.0, 3.0, 5.0, 10.0, 20.0)
METRICS = {
    "temperature_2m": ("env", "temperature_c", "degC"),
    "relative_humidity_2m": ("env", "relative_humidity_percent", "%"),
    "surface_pressure": ("env", "surface_pressure_hpa", "hPa"),
    "wind_speed_10m": ("env", "wind_speed_mps", "m/s"),
}
GPS_EPOCH = datetime(1980, 1, 6, tzinfo=timezone.utc)


def _gps_week_tow(moment: datetime) -> tuple[int, float]:
    seconds = (moment - GPS_EPOCH).total_seconds()
    return int(seconds // 604800), seconds % 604800


def _readings_for_day(data: dict, day: int) -> list[StationReading]:
    hourly = data["hourly"]
    start = day * 24
    readings: list[StationReading] = []
    for offset in range(24):
        index = start + offset
        observed_at = datetime.fromisoformat(hourly["time"][index]).replace(
            tzinfo=timezone.utc)
        for key, (sensor, metric, unit) in METRICS.items():
            value = hourly[key][index]
            flag = "low_temp" if (metric == "temperature_c"
                                  and value is not None and value < LOW_TEMP_C) else ""
            readings.append(StationReading(
                station_id=STATION, sensor=sensor, metric=metric, value=value,
                unit=unit, observed_at=observed_at, quality_flag=flag))
    return readings


def _observations_for_day(day: int, *, cycles: float | None) -> list:
    date = datetime(2024, 1, 1, tzinfo=timezone.utc) + timedelta(days=day)
    week, tow = _gps_week_tow(date)
    cfg = synthetic.default_cfg(
        seed=synthetic.FIXTURE_SEED + day, n_epochs=EPOCHS,
        start_week=week, start_tow_s=tow,
        systems=["GPS"], sats={"GPS": [1, 2]}, slips=[])
    obs, _, _ = synthetic.generate(cfg)
    if cycles:
        obs = _inject_step(obs, cycles=cycles)
    return obs


def _inject_step(obs: list, *, sv: int = 1, signal: str = "L1",
                 from_index: int = 30, cycles: float = 5.0) -> list:
    """在指定卫星/信号的相位上，自 ``from_index`` 起整体加一个持续阶跃。"""
    rows = [o for o in obs if o.sv == sv and o.signal == signal]
    rows.sort(key=lambda o: o.gps_tow_s)
    targets = {id(o) for o in rows[from_index:]}
    return [type(o)(**{**vars(o), "adr_cycles": o.adr_cycles + cycles})
            if id(o) in targets else o for o in obs]


def _inject_spike(obs: list, *, sv: int = 1, signal: str = "L1",
                  at_index: int = 30, cycles: float = 5.0) -> list:
    """只在**一个历元**上加相位尖峰（与持续阶跃对照）。"""
    rows = [o for o in obs if o.sv == sv and o.signal == signal]
    rows.sort(key=lambda o: o.gps_tow_s)
    targets = {id(o) for o in rows[at_index:at_index + 1]}
    return [type(o)(**{**vars(o), "adr_cycles": o.adr_cycles + cycles})
            if id(o) in targets else o for o in obs]


def _slip_verdict(obs: list) -> dict:
    payload = observation_payload(obs)
    tool = slip_detect_tool()
    union = 0
    indices: list[int] = []
    counts: dict = {}
    for group in payload["groups"]:
        result = tool.invoke(group["tool_args"])
        if not result.ok:
            raise SystemExit(f"[阻断] slip_detect 失败：{result.error}")
        counts[group["key"]] = dict(result.data.get("counts") or {})
        union += int((result.data.get("counts") or {}).get("union", 0) or 0)
        indices.extend(result.data.get("slip_indices") or [])
    return {"groups": counts, "union": union, "slip_indices": sorted(set(indices))}


def _device_verdict(readings: list[StationReading]) -> dict:
    result = station_health_tool().invoke(
        {"readings": [to_dict(reading) for reading in readings]})
    if not result.ok:
        raise SystemExit(f"[阻断] station_health 失败：{result.error}")
    station = result.data["stations"][0]
    return {
        "status": station["status"],
        "health_score": station["health_score"],
        "missing": result.data["summary"]["missing"],
        "total": result.data["summary"]["total"],
        "quality_flags": list(station.get("quality_flags") or []),
    }


def run(*, days: int = DAYS) -> dict:
    if not CACHE.is_file():
        raise SystemExit(
            f"[阻断] 缺公开数据缓存：{CACHE}\n"
            "先跑：python tools/fetch_public_data.py --id openmeteo_badg_202401")
    data = json.loads(CACHE.read_text(encoding="utf-8"))
    if len(data["hourly"]["time"]) < days * 24:
        raise SystemExit(f"[阻断] 缓存只有 {len(data['hourly']['time'])} 小时，不够 {days} 天")

    rows = []
    for day in range(days):
        date = (datetime(2024, 1, 1, tzinfo=timezone.utc)
                + timedelta(days=day)).date().isoformat()
        readings = _readings_for_day(data, day)
        device = _device_verdict(readings)
        injected = day % 2 == 1
        obs = _observations_for_day(day, cycles=INJECT_CYCLES if injected else None)
        qc = _slip_verdict(obs)
        detected = qc["union"] > 0
        rows.append({
            "date": date,
            "source_ok": True,
            "n_readings": len(readings),
            "low_temp_hours": sum(1 for r in readings
                                  if r.quality_flag == "low_temp"),
            "device": device,
            "injected": injected,
            "injected_cycles": INJECT_CYCLES if injected else None,
            "qc": qc,
            "detected": detected,
            "false_positive": bool(not injected and detected),
        })

    sensitivity = []
    for mode, inject in (("sustained", _inject_step), ("spike", _inject_spike)):
        for cycles in SENSITIVITY_CYCLES:
            obs = inject(_observations_for_day(0, cycles=None), cycles=cycles)
            qc = _slip_verdict(obs)
            sensitivity.append({
                "mode": mode, "cycles": cycles,
                "detected": qc["union"] > 0,
                "union": qc["union"], "slip_indices": qc["slip_indices"],
            })

    injected_days = [row for row in rows if row["injected"]]
    detected_days = [row for row in injected_days if row["detected"]]
    clean_days = [row for row in rows if not row["injected"]]
    false_positives = [row for row in clean_days if row["false_positive"]]
    degraded = [row for row in rows if row["device"]["status"] != "ok"]
    summary = {
        "days": len(rows),
        "source_ok_days": sum(1 for row in rows if row["source_ok"]),
        "availability": round(sum(1 for row in rows if row["source_ok"]) / len(rows), 3),
        "low_temp_hours": sum(row["low_temp_hours"] for row in rows),
        "device_degraded_days": len(degraded),
        "injected_days": len(injected_days),
        "detected_days": len(detected_days),
        "detection_rate": round(len(detected_days) / len(injected_days), 3),
        "clean_days": len(clean_days),
        "false_positive_days": len(false_positives),
        "false_positive_rate": round(len(false_positives) / len(clean_days), 3),
        "sensitivity": sensitivity,
    }
    return {
        "kind": LOG_KIND,
        "version": LOG_VERSION,
        "source": {
            "device": {
                "kind": "public",
                "dataset": "Open-Meteo 八达岭 2024-01 逐小时气象",
                "license": "CC BY 4.0",
                "attribution": "Open-Meteo.com（ERA5 再分析）",
                "cache": CACHE.relative_to(ROOT).as_posix(),
                "sha256_normalized": _normalized_sha(CACHE),
            },
            "observations": {
                "kind": "synthetic",
                "seed": f"FIXTURE_SEED + day（{synthetic.FIXTURE_SEED}…）",
                "n_epochs": EPOCHS,
                "injection": (f"奇数日在 GPS 01 L1 自历元 30 起注入 {INJECT_CYCLES} cycles 持续阶跃；"
                              "偶数日不注入"),
            },
        },
        "rules": {
            "low_temp_c": LOW_TEMP_C,
            "note": "低温标记是演示用示例阈值，不是工程判据",
        },
        "rows": rows,
        "summary": summary,
    }


def _normalized_sha(path: Path) -> str:
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "fetch_public_data", ROOT / "tools" / "fetch_public_data.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.normalized_digest(path.read_bytes())


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="试运行演练（M6-1/2/3 dry run）")
    parser.add_argument("--days", type=int, default=DAYS)
    parser.add_argument("--out", default=str(ROOT / "logs" / "dryrun_trial_202401.json"))
    parser.add_argument("--summary",
                        default=str(ROOT / "logs" / "dryrun_trial_summary_202401.json"))
    args = parser.parse_args(argv)
    log = run(days=args.days)
    for target, payload in ((Path(args.out), log), (Path(args.summary), log["summary"])):
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, indent=2,
                                    sort_keys=True) + "\n")
    summary = log["summary"]
    print(f"[OK] {summary['days']} 天：可用率 {summary['availability']}，"
          f"低温小时 {summary['low_temp_hours']}，设备异常 {summary['device_degraded_days']} 天；"
          f"注入 {summary['injected_days']} 天 → 检出 {summary['detected_days']} "
          f"（{summary['detection_rate']}），误报 {summary['false_positive_days']}/"
          f"{summary['clean_days']}（{summary['false_positive_rate']}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
