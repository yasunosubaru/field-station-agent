"""设备心跳与离线判定（M6-5，issue #109）。

**心跳与读数健康度是两条正交的判据，不合并成一个分数**：

* ``station_health``（``station_tools.py``）看**读数**：缺测、质量标记、阈值状态
  → ``ok`` / ``degraded`` / ``critical``；
* ``device_heartbeat``（本文件）看**设备还活着吗**：最近一次心跳距今多久
  → ``online`` / ``stale`` / ``offline`` / ``unknown``。

离线设备通常表现为「没有读数」，而读数异常也可能来自在线的设备 —— 把两者压成
一个健康分，就再也分不清「设备掉线」与「设备在线但数据坏」。这是 ADR-007 里
P0 第二条要解决的问题。

## 判定规则

阈值按**心跳周期**计，不按绝对秒数（不同设备的 ``interval_s`` 可以不同）：

* ``age <= stale_after_intervals * interval_s`` → ``online``；
* ``age <= offline_after_intervals * interval_s`` → ``stale``；
* 再大 → ``offline``；
* ``last_seen_at`` 或 ``interval_s`` 缺失 / 不可解析 → ``unknown``，**不判 offline**
  （字段缺失是「不知道」，不是「掉线」）；
* ``last_seen_at`` 晚于 ``now``（时钟偏差）→ ``online``，并在 ``reason`` 里写明。

阈值来自 ``config/heartbeat.json``，不在代码里硬编码；``DeviceHeartbeatTool``
也允许显式传值（测试与离线复算用）。

本模块只用标准库。
"""
from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path

from . import ToolResult

#: 仓库根（src/fieldstation/agents/tools/ 向上四级）。
ROOT = Path(__file__).resolve().parents[4]
CONFIG_PATH = ROOT / "config" / "heartbeat.json"

#: 配置文件缺失时的兜底值（与 config/heartbeat.json 的出厂值一致）。
DEFAULT_STALE_AFTER_INTERVALS = 2.0
DEFAULT_OFFLINE_AFTER_INTERVALS = 6.0

STATUSES = ("online", "stale", "offline", "unknown")
#: 需要告警的状态（``unknown`` 不告警：不知道不等于出事）。
ALERT_STATUSES = ("stale", "offline")
ALERT_LEVEL = {"stale": "warn", "offline": "critical"}


def _parse_time(value: str) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("时间必须是非空 ISO 8601 字符串")
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _positive_number(value) -> float | None:
    """有限正数返回 float，否则 None（不猜、不把 NaN 当阈值）。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        return None
    return number


def load_policy(path: str | Path | None = None) -> dict:
    """读心跳阈值配置。文件不存在时用出厂值（并保留来源标记）。"""
    target = Path(path) if path is not None else CONFIG_PATH
    raw: dict = {}
    if target.is_file():
        loaded = json.loads(target.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError(f"心跳配置必须是 JSON object：{target}")
        raw = loaded
    stale = _positive_number(raw.get("stale_after_intervals"))
    offline = _positive_number(raw.get("offline_after_intervals"))
    stale = DEFAULT_STALE_AFTER_INTERVALS if stale is None else stale
    offline = DEFAULT_OFFLINE_AFTER_INTERVALS if offline is None else offline
    if not stale < offline:
        raise ValueError(
            f"心跳阈值必须满足 stale < offline（收到 {stale} / {offline}）：{target}")
    return {
        "stale_after_intervals": stale,
        "offline_after_intervals": offline,
        "source": "config" if target.is_file() else "default",
    }


def latest_by_device(heartbeats) -> list[dict]:
    """把心跳**序列**折成每台设备**最新一条**（工具的输入形状）。

    判定看的是「最近一次心跳」，而不是整段序列；这里只做折叠，不做判定 ——
    阈值仍只在 ``classify`` 一处。没有可解析 ``last_seen_at`` 的行保留原样，
    交给 ``classify`` 判 ``unknown``（不在这里猜）。
    """
    latest: dict[str, dict] = {}
    for raw in heartbeats or []:
        if not isinstance(raw, dict):
            continue
        device_id = raw.get("device_id")
        if not isinstance(device_id, str) or not device_id.strip():
            continue
        key = device_id.strip()
        current = latest.get(key)
        try:
            candidate = _parse_time(raw.get("last_seen_at"))
        except (TypeError, ValueError):
            if current is None:
                latest[key] = raw
            continue
        if current is None:
            latest[key] = raw
            continue
        try:
            previous = _parse_time(current.get("last_seen_at"))
        except (TypeError, ValueError):
            latest[key] = raw
            continue
        if candidate >= previous:
            latest[key] = raw
    return [latest[key] for key in sorted(latest)]


def classify(*, last_seen_at, interval_s, now: datetime,
             policy: dict) -> tuple[str, float | None, str]:
    """返回 ``(status, age_s, reason)``。字段缺失一律 ``unknown``。"""
    interval = _positive_number(interval_s)
    if interval is None:
        return ("unknown", None, "缺少有效的 interval_s（不判 offline）")
    if last_seen_at is None or (isinstance(last_seen_at, str)
                               and not last_seen_at.strip()):
        return ("unknown", None, "缺少 last_seen_at（不判 offline）")
    try:
        seen = _parse_time(last_seen_at)
    except (TypeError, ValueError) as exc:
        return ("unknown", None, f"last_seen_at 不可解析（{exc}）")
    age = (now - seen).total_seconds()
    if age < 0:
        return ("online", age, "last_seen_at 晚于 now（时钟偏差，按在线处理）")
    stale_after = float(policy["stale_after_intervals"]) * interval
    offline_after = float(policy["offline_after_intervals"]) * interval
    if age <= stale_after:
        return ("online", age, f"age {age:.0f}s ≤ {stale_after:.0f}s")
    if age <= offline_after:
        return ("stale", age, f"age {age:.0f}s ≤ {offline_after:.0f}s")
    return ("offline", age, f"age {age:.0f}s > {offline_after:.0f}s")


class DeviceHeartbeatTool:
    """把一批心跳压成设备状态与告警；不碰读数、不碰健康度。"""

    name = "device_heartbeat"
    description = (
        "按最近一次心跳与心跳周期判定设备是否在线：online / stale / offline / "
        "unknown。与读数健康度正交；心跳字段缺失按 unknown 处理，不误判 offline。"
    )
    params = {
        "heartbeats": {
            "type": "array",
            "items": "object",
            "required": True,
            "description": ("心跳数组；每项含 device_id、last_seen_at（ISO 8601）、"
                            "interval_s，可选 station_id"),
        },
        "now": {
            "type": "string",
            "required": True,
            "description": "判定基准时间（ISO 8601）；不在工具内读墙钟，保证可复现",
        },
    }
    risk = "low"

    def __init__(self, *, stale_after_intervals: float | None = None,
                 offline_after_intervals: float | None = None) -> None:
        policy = load_policy()
        if stale_after_intervals is not None:
            policy["stale_after_intervals"] = _positive_number(
                stale_after_intervals)
        if offline_after_intervals is not None:
            policy["offline_after_intervals"] = _positive_number(
                offline_after_intervals)
        if (policy["stale_after_intervals"] is None
                or policy["offline_after_intervals"] is None):
            raise ValueError("心跳阈值必须是有限正数")
        if not policy["stale_after_intervals"] < policy["offline_after_intervals"]:
            raise ValueError("心跳阈值必须满足 stale_after_intervals < "
                             "offline_after_intervals")
        self.policy = policy

    def invoke(self, args: dict) -> ToolResult:
        heartbeats = args.get("heartbeats")
        if not isinstance(heartbeats, list):
            return ToolResult(ok=False, error="参数 heartbeats 必须是数组")
        try:
            now = _parse_time(args.get("now"))
        except (TypeError, ValueError) as exc:
            return ToolResult(ok=False, error=f"参数 now 无效：{exc}")

        devices = []
        alerts = []
        counts = {status: 0 for status in STATUSES}
        for index, raw in enumerate(heartbeats):
            prefix = f"heartbeats[{index}]"
            if not isinstance(raw, dict):
                return ToolResult(ok=False, error=f"{prefix} 必须是 object")
            device_id = raw.get("device_id")
            if not isinstance(device_id, str) or not device_id.strip():
                return ToolResult(
                    ok=False, error=f"{prefix}.device_id 必须是非空字符串")
            station_id = raw.get("station_id")
            if station_id is not None and not isinstance(station_id, str):
                return ToolResult(
                    ok=False, error=f"{prefix}.station_id 必须是字符串")
            status, age, reason = classify(
                last_seen_at=raw.get("last_seen_at"),
                interval_s=raw.get("interval_s"), now=now,
                policy=self.policy)
            counts[status] += 1
            row = {
                "device_id": device_id.strip(),
                "station_id": station_id.strip() if station_id else "",
                "last_seen_at": raw.get("last_seen_at"),
                "interval_s": raw.get("interval_s"),
                "age_s": None if age is None else round(age, 3),
                "status": status,
                "reason": reason,
            }
            devices.append(row)
            if status in ALERT_STATUSES:
                alerts.append({
                    "device_id": row["device_id"],
                    "station_id": row["station_id"],
                    "status": status,
                    "level": ALERT_LEVEL[status],
                    "reason": reason,
                })

        devices.sort(key=lambda item: item["device_id"])
        alerts.sort(key=lambda item: (item["level"] != "critical", item["device_id"]))
        return ToolResult(ok=True, data={
            "now": now.isoformat(),
            "policy": {key: self.policy[key] for key in
                       ("stale_after_intervals", "offline_after_intervals")},
            "devices": devices,
            "alerts": alerts,
            "summary": {
                "total": len(devices),
                **counts,
                "alerts": [alert["device_id"] for alert in alerts],
            },
        })


def device_heartbeat_tool(**kwargs) -> DeviceHeartbeatTool:
    return DeviceHeartbeatTool(**kwargs)
