#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_station_dashboard.py —— 从 M5-1 全链回放日志生成运行看板（M5-3，issue #62）。

## 三类视图与口径

口径的散文版是 `docs/operations/dashboard.md`；改口径时两边一起改。这里只列
**机械规则**，并且尽量不复算已有口径：

1. **台站健康度**：直接取 `device_monitor` 阶段 `station_health` 的工具结果。
   `health_score = 1 - missing/total`、`status` 的三档阈值都在
   `src/fieldstation/agents/tools/station_tools.py` 里，本脚本**只读不算** ——
   第二套口径就是分叉的开始。
2. **告警**：两条来源，规则固定：
   - 台站状态非 `ok`：`degraded` → `warn`、`critical` → `critical`；
   - 数据质量：`qc` 阶段每个 `slip_detect` 结果 `counts.union > 0` → `warn`；
     卫星组名用**输入消息**里 `groups[].tool_args` 与工具入参的规范 JSON 匹配
     得到（工具入参本身不带卫星号，不靠猜）。
3. **工单**：`operations_dispatch` 阶段的 `create_work_order` 结果（工单字段全量）
   + `execute_device_action` 结果（执行状态与模式）。

## 数据流：日志 → 黑板 → 页面

先按上面的口径把三类上下文 `upsert` 进 M5-2 的 `Blackboard`（键 `station/...`、
`alert/...`、`order/...`），再从 `board.snapshot()` 渲染。看板不直接拿日志字段拼
页面：这样「看板看到的就是黑板里的上下文」，M5-3 对 M5-2 的接口只有 `snapshot()`。

## 输出与确定性

- `figures/m5_dashboard.html`：单文件静态页（内联 CSS + div 条形，无 JS、
  无外部资源、不引第三方 BI）；
- `logs/m5_dashboard.json`：同一版页面的机读摘要（计数、健康度、告警、工单、
  源日志 sha 与页面 sha），供 REPRODUCE 数字回源。
- 输出**不含生成时间戳与随机量**（页面里的 `latest_observed_at` 是数据时间，来自
  日志）：同一份日志两次生成的页面与摘要逐字节相同
  （`tests/test_m5_dashboard.py` 钉死）。页面落盘钉 LF（同 `store/product.py`
  的跨平台口径）。

## 退出码

- ``0``：页面与摘要生成完毕；
- ``1``：日志缺三类视图所需的数据（没有 `station_health` 或 `create_work_order` 结果）；
- ``2``：用法错误，或日志不可读 / 不是 M5 回放日志。
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "src"), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fieldstation.agents.blackboard import Blackboard  # noqa: E402
from fieldstation.store.product import canonical_json  # noqa: E402

KINDS = (
    "fieldstation.m5_pipeline_replay.log",
    "fieldstation.public_data_chain.log",
)
KIND = KINDS[0]
ACTOR = "dashboard:hydrate"
#: 台站状态 → 告警级别；``ok`` 不产生告警。
STATUS_LEVEL = {"degraded": "warn", "critical": "critical"}
LEVEL_ORDER = {"critical": 0, "warn": 1, "info": 2}


class DashboardInputError(Exception):
    """日志读不了 / 不是 M5 回放日志（退出码 2）。"""


class DashboardDataError(Exception):
    """日志缺三类视图需要的数据（退出码 1）。"""


# ------------------------------------------------------------------ 读日志
def load_log(path: Path) -> dict:
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise DashboardInputError(f"日志读不了：{path}（{exc}）") from exc
    except UnicodeDecodeError as exc:
        raise DashboardInputError(f"日志不是 UTF-8：{path}（{exc}）") from exc
    try:
        log = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise DashboardInputError(f"日志不是合法 JSON：{path}（{exc}）") from exc
    if not isinstance(log, dict) or log.get("kind") not in KINDS:
        raise DashboardInputError(
            f"不是可用的全链日志：{path}（kind={log.get('kind') if isinstance(log, dict) else type(log).__name__}，"
            f"期望 {list(KINDS)} 之一）")
    for key in ("stages", "messages", "trace", "summary"):
        if key not in log:
            raise DashboardInputError(f"日志缺字段 {key!r}：{path}")
    return log


def _stage(log: dict, name: str) -> dict | None:
    for stage in log.get("stages", []):
        if stage.get("stage") == name:
            return stage
    return None


def _tool_events(log: dict) -> tuple[dict[tuple, dict], list[dict]]:
    """返回 ((agent, call_id) → tool_call 事件, 全部 tool_result 事件)。

    ``call_id`` 每个阶段都从 ``t0001`` 起，**必须带 agent** 才能对上 ——
    只用 call_id 会被后一个阶段覆盖（实测：``t0001`` 变成了 archive 的调用）。
    """
    calls: dict[tuple, dict] = {}
    results: list[dict] = []
    for event in log.get("trace", []):
        if event.get("kind") == "tool_call":
            calls[(event.get("agent"), event.get("call_id"))] = event
        elif event.get("kind") == "tool_result":
            results.append(event)
    return calls, results


def _observation_groups(log: dict) -> dict[str, tuple[str, str]]:
    """输入消息 groups[].tool_args 的规范 JSON → (台站, 卫星组名)。"""
    out: dict[str, tuple[str, str]] = {}
    for message in log.get("messages", []):
        payload = message.get("payload") or {}
        station = payload.get("station")
        for group in payload.get("groups") or []:
            key, args = group.get("key"), group.get("tool_args")
            if isinstance(key, str) and isinstance(args, dict):
                out[canonical_json(args)] = (station, key)
    return out


def _slug(text: str) -> str:
    return "-".join(str(text).split())


def _evidence(event: dict) -> list[dict]:
    """告警证据带上 agent：call_id 每个阶段都从 t0001 起，光有 id 分不清阶段。"""
    return [{"agent": event.get("agent"), "call_id": event.get("call_id")}]


def _display_path(path: Path) -> str:
    """对外显示用路径：仓库内用相对路径，仓库外用文件名（不泄露本机绝对路径）。"""
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return path.name


# ------------------------------------------------------- 日志 → 黑板（口径）
def build_board(log: dict) -> Blackboard:
    """按口径把三类上下文装进黑板；缺关键数据抛 ``DashboardDataError``。"""
    calls, results = _tool_events(log)
    groups = _observation_groups(log)
    board = Blackboard()

    health_result = next((event for event in results
                          if event.get("agent") == "device_monitor"
                          and event.get("tool") == "station_health"
                          and event.get("ok")), None)
    health = (health_result or {}).get("result") or {}
    stations = health.get("stations") or []
    if not stations:
        raise DashboardDataError(
            "日志里没有 device_monitor 的 station_health 台站结果 —— "
            "台站健康度视图无法生成")

    for station in stations:
        station_id = station.get("station_id")
        board.upsert(f"station/{station_id}", {
            "station_id": station_id,
            "health_score": station.get("health_score"),
            "status": station.get("status"),
            "missing": station.get("missing"),
            "total": station.get("total"),
            "latest_observed_at": station.get("latest_observed_at"),
            "quality_flags": list(station.get("quality_flags") or []),
            "metrics": list(station.get("metrics") or []),
        }, by=ACTOR)
        level = STATUS_LEVEL.get(station.get("status"))
        if level:
            board.upsert(f"alert/{station_id}/station_health", {
                "station": station_id,
                "level": level,
                "source": "station_health",
                "title": f"{station_id} 台站状态 {station.get('status')}",
                "detail": (f"{station.get('missing')}/{station.get('total')} 条读数缺测；"
                           f"quality_flags={list(station.get('quality_flags') or [])}"),
                "evidence": _evidence(health_result),
            }, by=ACTOR)

    for event in results:
        if (event.get("agent") != "qc" or event.get("tool") != "slip_detect"
                or not event.get("ok")):
            continue
        result = event.get("result") or {}
        counts = result.get("counts") or {}
        if int(counts.get("union", 0) or 0) <= 0:
            continue
        args = (calls.get((event.get("agent"), event.get("call_id"))) or {}).get("args") or {}
        match = groups.get(canonical_json(args))
        if match is None:
            # 归属不上就不猜：一条无法归到台站/卫星的周跳告警会静默误报。
            raise DashboardDataError(
                f"qc 的 slip_detect 调用 {event.get('call_id')!r} 的入参与任何输入"
                "观测组都匹配不上，无法归属卫星组（不猜）")
        station_id, group = match
        board.upsert(f"alert/{station_id}/data_quality/{_slug(group)}", {
            "station": station_id,
            "level": "warn",
            "source": "data_quality",
            "title": f"{group} 检出周跳 / 相位阶跃",
            "detail": (f"counts={dict(counts)}；"
                       f"slip_indices={list(result.get('slip_indices') or [])}"),
            "evidence": _evidence(event),
        }, by=ACTOR)

    dispatch = _stage(log, "operations_dispatch") or {}
    artifacts = dispatch.get("artifacts") or {}
    order = artifacts.get("work_order")
    if not order:
        raise DashboardDataError(
            "日志里没有 create_work_order 的结果（operations_dispatch 阶段）—— "
            "工单视图无法生成")
    execution = artifacts.get("device_action")
    board.upsert(f"order/{order.get('order_id')}", {
        "order_id": order.get("order_id"),
        "station_id": order.get("station_id"),
        "title": order.get("title"),
        "priority": order.get("priority"),
        "risk": order.get("risk"),
        "status": order.get("status"),
        "action": order.get("action"),
        "assigned_to": order.get("assigned_to"),
        "description": order.get("description"),
        "evidence_call_ids": list(order.get("evidence_call_ids") or []),
        "execution": execution,
    }, by=ACTOR)
    return board


# ------------------------------------------------------------------ 渲染
def _escape(value) -> str:
    return html.escape("" if value is None else str(value))


def _badge(text: str, kind: str) -> str:
    return f'<span class="badge {kind}">{_escape(text)}</span>'


def _status_kind(status: str) -> str:
    return {"ok": "ok", "degraded": "warn", "critical": "critical"}.get(status, "")


def _station_rows(stations: dict) -> str:
    rows = []
    for key, entry in stations.items():
        value = entry.value
        score = value.get("health_score")
        percent = 0.0 if score is None else max(0.0, min(1.0, float(score))) * 100
        metrics = "".join(
            "<tr><td>{sensor}</td><td>{metric}</td><td>{unit}</td>"
            "<td>{count}</td><td>{missing}</td><td>{min}</td><td>{max}</td>"
            "<td>{mean}</td><td>{flags}</td></tr>".format(
                sensor=_escape(m.get("sensor")), metric=_escape(m.get("metric")),
                unit=_escape(m.get("unit")), count=_escape(m.get("count")),
                missing=_escape(m.get("missing")), min=_escape(m.get("min")),
                max=_escape(m.get("max")), mean=_escape(m.get("mean")),
                flags=_escape(", ".join(m.get("quality_flags") or []) or "—"))
            for m in value.get("metrics") or [])
        rows.append(
            f"<tr><td><code>{_escape(value.get('station_id'))}</code></td>"
            f"<td>{_badge(value.get('status'), _status_kind(value.get('status')))}</td>"
            f"<td><div class=\"bar\"><span style=\"width:{percent:.1f}%\"></span></div>"
            f"<small>{_escape(score)}</small></td>"
            f"<td>{_escape(value.get('missing'))}/{_escape(value.get('total'))}</td>"
            f"<td>{_escape(value.get('latest_observed_at'))}</td>"
            f"<td><details><summary>指标 {len(value.get('metrics') or [])} 项</summary>"
            f"<table class=\"inner\"><thead><tr><th>sensor</th><th>metric</th><th>unit</th>"
            f"<th>count</th><th>missing</th><th>min</th><th>max</th><th>mean</th>"
            f"<th>flags</th></tr></thead><tbody>{metrics}</tbody></table></details></td></tr>")
    return "".join(rows)


def _alert_rows(alerts: dict) -> str:
    rows = []
    for _, entry in sorted(alerts.items(),
                           key=lambda item: (LEVEL_ORDER.get(item[1].value.get("level"), 9),
                                             item[0])):
        value = entry.value
        evidence = ", ".join(f"{item.get('agent')}:{item.get('call_id')}"
                             for item in value.get("evidence") or [])
        rows.append(
            f"<tr><td>{_badge(value.get('level'), value.get('level'))}</td>"
            f"<td>{_escape(value.get('source'))}</td>"
            f"<td><code>{_escape(value.get('station'))}</code></td>"
            f"<td>{_escape(value.get('title'))}</td>"
            f"<td>{_escape(value.get('detail'))}</td>"
            f"<td>{_escape(evidence)}</td></tr>")
    return "".join(rows)


def _order_rows(orders: dict) -> str:
    rows = []
    for _, entry in sorted(orders.items()):
        value = entry.value
        execution = value.get("execution") or {}
        execution_text = "—"
        if execution:
            execution_text = (f"{execution.get('status')} / "
                              f"{execution.get('execution_mode')}")
        rows.append(
            f"<tr><td><code>{_escape(value.get('order_id'))}</code></td>"
            f"<td>{_badge(value.get('priority'), 'warn')}</td>"
            f"<td>{_escape(value.get('status'))}</td>"
            f"<td><code>{_escape(value.get('station_id'))}</code></td>"
            f"<td>{_escape(value.get('title'))}</td>"
            f"<td>{_escape(value.get('action'))}</td>"
            f"<td>{_escape(execution_text)}</td>"
            f"<td>{_escape(value.get('description'))}</td></tr>")
    return "".join(rows)


def render_page(board: Blackboard, log: dict, *, source_name: str) -> str:
    """从黑板快照渲染单文件静态页（无 JS、无外部资源）。"""
    snapshot = board.snapshot()
    stations = {k: v for k, v in snapshot.items() if k.startswith("station/")}
    alerts = {k: v for k, v in snapshot.items() if k.startswith("alert/")}
    orders = {k: v for k, v in snapshot.items() if k.startswith("order/")}
    summary = log.get("summary") or {}
    tokens = summary.get("tokens") or {}
    checks = summary.get("checks", "?")
    log_sha = log.get("sha256") or "?"
    counts = {"critical": 0, "warn": 0}
    for entry in alerts.values():
        level = entry.value.get("level")
        if level in counts:
            counts[level] += 1

    # 公开数据链路（issue #98）：页面上必须标明「哪一侧是公开数据、什么许可」
    sources = log.get("data_sources") or {}
    device_src = sources.get("device") or {}
    obs_src = sources.get("observations") or {}
    source_line = ""
    sample_note = ("<strong>合成样本</strong>：真实台站样本受 #28/#33 阻塞，本页由固定种子合成样本\n"
                   "  的全链回放日志生成（替代口径，同 M4-0 / M5-1）；真实样本到位后用同一命令重新生成。")
    if device_src.get("kind") == "public":
        source_line = (
            "<div class=\"meta\"><strong>数据来源</strong>：设备侧 "
            f"<code>{_escape(device_src.get('sample'))}</code>"
            f"（{_escape(device_src.get('license'))}，{_escape(device_src.get('attribution'))}）；"
            "观测侧为<strong>合成样本</strong>（公开 GNSS 观测自 1999 年起全是 CRINEX，"
            "仓库按既有决定不解码 —— issue #99）。</div>\n")
        sample_note = ("<strong>口径</strong>：设备侧是<strong>环境读数</strong>（气温/湿度/气压/风速），"
                       "不是供电/链路/安防；低温标记是演示用示例阈值，不是工程判据。"
                       "观测侧是合成样本，结论里的数字来自工具返回。")
    tokens_line = (f"tokens {_escape(tokens.get('prompt'))}/{_escape(tokens.get('completion'))}")
    if summary.get("tokens_note"):
        tokens_line += "（无模型调用）"
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>野外台站运行看板（M5-3）</title>
<style>
:root {{ --fg:#1f2328; --muted:#656d76; --line:#d0d7de; --bg:#ffffff;
         --ok:#1a7f37; --warn:#9a6700; --critical:#cf222e; --accent:#0969da; }}
* {{ box-sizing:border-box; }}
body {{ margin:0; padding:24px; font:14px/1.6 "Microsoft YaHei", "Segoe UI", sans-serif;
        color:var(--fg); background:var(--bg); }}
h1 {{ font-size:20px; margin:0 0 4px; }}
h2 {{ font-size:16px; margin:0 0 12px; }}
.meta {{ color:var(--muted); font-size:12px; margin-bottom:16px; }}
.panel {{ border:1px solid var(--line); border-radius:8px; padding:16px; margin:0 0 16px; }}
table {{ border-collapse:collapse; width:100%; }}
th, td {{ text-align:left; padding:6px 8px; border-bottom:1px solid var(--line);
          vertical-align:top; }}
th {{ color:var(--muted); font-weight:600; font-size:12px; }}
table.inner {{ margin-top:8px; font-size:12px; }}
.badge {{ display:inline-block; padding:0 8px; border-radius:999px; font-size:12px;
          border:1px solid var(--line); }}
.badge.ok {{ color:var(--ok); border-color:var(--ok); }}
.badge.warn {{ color:var(--warn); border-color:var(--warn); }}
.badge.critical {{ color:var(--critical); border-color:var(--critical); }}
.bar {{ height:8px; background:#eaeef2; border-radius:4px; overflow:hidden;
        min-width:120px; margin-bottom:2px; }}
.bar span {{ display:block; height:100%; background:var(--accent); }}
code {{ font-family:Consolas, monospace; white-space:nowrap; }}
.empty {{ color:var(--muted); }}
footer {{ color:var(--muted); font-size:12px; margin-top:8px; }}
</style>
</head>
<body>
<h1>野外台站运行看板</h1>
<div class="meta">
  数据源：<code>{_escape(source_name)}</code>（sha256 <code>{_escape(log_sha[:16])}…</code>）
  · 链路 {_escape(summary.get('stages'))} 阶段 / {_escape(summary.get('messages'))} 条消息
  · checks {_escape(checks)} · {tokens_line}
  · 台站 {len(stations)} / 告警 {len(alerts)}（严重 {counts['critical']}、警告 {counts['warn']}）/ 工单 {len(orders)}
</div>
{source_line}<div class="meta">{sample_note}</div>

<section class="panel">
  <h2>一、台站健康度</h2>
  <table><thead><tr><th>台站</th><th>状态</th><th>健康度</th><th>缺测</th>
  <th>最近读数</th><th>指标</th></tr></thead>
  <tbody>{_station_rows(stations) or '<tr><td colspan="6" class="empty">无台站</td></tr>'}</tbody></table>
</section>

<section class="panel">
  <h2>二、告警</h2>
  <table><thead><tr><th>级别</th><th>来源</th><th>台站</th><th>标题</th>
  <th>细节</th><th>证据（agent:call_id）</th></tr></thead>
  <tbody>{_alert_rows(alerts) or '<tr><td colspan="6" class="empty">无告警</td></tr>'}</tbody></table>
</section>

<section class="panel">
  <h2>三、工单</h2>
  <table><thead><tr><th>工单</th><th>优先级</th><th>状态</th><th>台站</th>
  <th>标题</th><th>动作</th><th>执行</th><th>说明</th></tr></thead>
  <tbody>{_order_rows(orders) or '<tr><td colspan="8" class="empty">无工单</td></tr>'}</tbody></table>
</section>

<footer>
  口径与规则：<code>docs/operations/dashboard.md</code> ·
  生成命令：<code>python tools/make_station_dashboard.py</code> ·
  本页不含生成时间戳（只含数据时间）；同一份日志两次生成逐字节相同。
</footer>
</body>
</html>
"""


def build_summary(log: dict, board: Blackboard, *, source_name: str,
                  page_sha256: str) -> dict:
    snapshot = board.snapshot()
    stations = [entry.value for key, entry in sorted(snapshot.items())
                if key.startswith("station/")]
    alerts = [entry.value for key, entry in sorted(snapshot.items())
              if key.startswith("alert/")]
    orders = [entry.value for key, entry in sorted(snapshot.items())
              if key.startswith("order/")]
    by_level: dict[str, int] = {}
    for alert in alerts:
        level = alert.get("level")
        by_level[level] = by_level.get(level, 0) + 1
    return {
        "kind": "fieldstation.m5_dashboard.summary",
        "version": 1,
        "source": {"log": source_name, "log_sha256": log.get("sha256"),
                   "scenario": log.get("scenario")},
        "chain": log.get("summary"),
        "counts": {"stations": len(stations), "alerts": len(alerts),
                   "alerts_by_level": by_level, "orders": len(orders)},
        "stations": stations,
        "alerts": alerts,
        "orders": orders,
        # 只记页面内容的 sha：输出路径会随调用方式变，不该进可复现摘要。
        "page": {"sha256": page_sha256},
    }


# --------------------------------------------------------------------- CLI
def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="从 M5-1 全链回放日志生成运行看板（台站健康度 / 告警 / 工单）")
    parser.add_argument("--log", default=str(ROOT / "logs" / "m5_pipeline_replay.json"))
    parser.add_argument("--page", default=str(ROOT / "figures" / "m5_dashboard.html"))
    parser.add_argument("--summary", default=str(ROOT / "logs" / "m5_dashboard.json"))
    args = parser.parse_args(argv)

    try:
        log = load_log(Path(args.log))
    except DashboardInputError as exc:
        print(f"[阻断] {exc}")
        return 2
    try:
        board = build_board(log)
    except DashboardDataError as exc:
        print(f"[阻断] {exc}")
        return 1

    source_name = _display_path(Path(args.log))
    page_text = render_page(board, log, source_name=source_name)
    page_path = Path(args.page)
    _write_text(page_path, page_text)
    page_sha = hashlib.sha256(page_text.encode("utf-8")).hexdigest()

    summary = build_summary(log, board, source_name=source_name,
                            page_sha256=page_sha)
    summary_path = Path(args.summary)
    _write_text(summary_path,
                json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n")

    counts = summary["counts"]
    print(f"[OK] 页面 {_display_path(page_path)}（{len(page_text.encode('utf-8'))} B，"
          f"sha256 {page_sha[:16]}…）")
    print(f"[OK] 摘要 {_display_path(summary_path)}：台站 {counts['stations']} / "
          f"告警 {counts['alerts']} {counts['alerts_by_level']} / "
          f"工单 {counts['orders']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
