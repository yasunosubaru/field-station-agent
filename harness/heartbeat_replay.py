#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""设备心跳回放（M6-5，issue #109）。

公开数据源（Open-Meteo 等）**不带设备心跳**，真实台站样本又受 #28/#33 阻塞。
本回放用 ``synthetic.device_heartbeats`` 造一条固定序列，逐行标注 ``synthetic``，
只演示「心跳 → 在线 / 陈旧 / 离线 / 未知」这条判定，不冒充真实设备状态。

判定本身在 ``src/fieldstation/agents/tools/heartbeat_tools.py``：本脚本**只读**
它的结果，不写第二套阈值。阈值来自 ``config/heartbeat.json``。

输出 ``logs/heartbeat_replay.json``：设备行、告警、汇总、阈值与 sha256。
无时间戳、无随机量 —— 两次运行逐字节相同。

用法：
    python harness/heartbeat_replay.py
    python harness/heartbeat_replay.py --out logs/heartbeat_replay.json
    python harness/heartbeat_replay.py --notify      # 默认 dry-run，见 docs/operations/webhook.md
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT / "harness")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fieldstation import synthetic  # noqa: E402
from fieldstation.agents.tools.heartbeat_tools import (  # noqa: E402
    DeviceHeartbeatTool,
    latest_by_device,
)
from fieldstation.store.product import config_hash  # noqa: E402

LOG_KIND = "fieldstation.heartbeat_replay.log"
LOG_VERSION = 1
STATION = "BADG"
INTERVAL_S = 300.0
N_SLOTS = 73                      # 00:00 → 06:00，每 5 分钟一个槽位
START = datetime(2024, 1, 1, 0, 0, tzinfo=timezone.utc)
NOW = "2024-01-01T06:00:00+00:00"
#: 各设备最后一次上报的槽位（含）；缺省上报到最后一个槽位。
#:   GNSS-RX 72 → age 0            → online
#:   POWER   68 → age 20 min = 4×  → stale
#:   LINK    65 → age 35 min = 7×  → offline
STOP_AFTER = {"GNSS-RX": 72, "POWER": 68, "LINK": 65}
#: 心跳字段缺失的设备：只用于演示「缺字段 → unknown，不判 offline」。
MISSING_FIELDS_DEVICE = {"device_id": "AUX", "station_id": STATION,
                         "last_seen_at": None, "interval_s": INTERVAL_S,
                         "synthetic": True}


def build_log() -> dict:
    series = synthetic.device_heartbeats(
        start=START, n=N_SLOTS, interval_s=INTERVAL_S,
        devices=tuple(STOP_AFTER), station=STATION, stop_after=STOP_AFTER)
    series.append(dict(MISSING_FIELDS_DEVICE))

    tool = DeviceHeartbeatTool()
    result = tool.invoke({"heartbeats": latest_by_device(series), "now": NOW})
    if not result.ok:
        raise RuntimeError(f"心跳工具返回失败：{result.error}")

    payload = {
        "kind": LOG_KIND,
        "version": LOG_VERSION,
        "scenario": "heartbeat-replay",
        "source": {
            "kind": "synthetic",
            "reason": ("公开数据源不带设备心跳；本序列由 synthetic.device_heartbeats "
                       "生成，逐行标注 synthetic=True（M6-5）"),
            "start": START.isoformat(),
            "now": NOW,
            "interval_s": INTERVAL_S,
            "n_slots": N_SLOTS,
            "stop_after": dict(STOP_AFTER),
        },
        "policy": result.data["policy"],
        # 完整序列留档（可复核「最近一次」是怎么折出来的），判定只看 devices。
        "series": series,
        "n_reports": len(series),
        "devices": result.data["devices"],
        "alerts": result.data["alerts"],
        "summary": result.data["summary"],
    }
    payload["sha256"] = config_hash(payload)
    return payload


def run(out_path: Path) -> dict:
    log = build_log()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(log, ensure_ascii=False, indent=2,
                                sort_keys=True) + "\n")
    return log


def _notify(log: dict, audit_path: Path) -> int:
    """把告警交给 Webhook（默认 dry-run）。返回失败条数，供退出码判断。"""
    from fieldstation.agents.notify import WebhookNotifier, notify_alerts

    notifier = WebhookNotifier.from_env(audit_path=audit_path)
    results = notify_alerts(
        notifier, log["alerts"],
        generated_at=log["source"]["now"],
        log_path="logs/heartbeat_replay.json")
    for item in results:
        print(f"  notify {item.status:<8} attempts={item.attempts} "
              f"{item.payload.get('station')} {item.payload.get('title')}")
    if notifier.dry_run:
        print(f"  （dry-run：未发请求，审计 {audit_path}）")
    return sum(1 for item in results if item.status == "failed")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="设备心跳回放（M6-5）")
    parser.add_argument("--out", default=str(ROOT / "logs" / "heartbeat_replay.json"))
    parser.add_argument("--notify", action="store_true",
                        help="把告警交给 Webhook；默认 dry-run 不发请求")
    parser.add_argument("--audit", default=str(ROOT / "logs" / "notify_audit.jsonl"))
    args = parser.parse_args(argv)

    log = run(Path(args.out))
    summary = log["summary"]
    print(f"[OK] {args.out}：{summary['total']} 台设备 / "
          f"online {summary['online']} / stale {summary['stale']} / "
          f"offline {summary['offline']} / unknown {summary['unknown']}")
    failed = 0
    if args.notify:
        failed = _notify(log, Path(args.audit))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
