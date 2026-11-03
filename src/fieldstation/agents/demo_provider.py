#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""确定性演示 provider（WP2）：不联网，也不假装是模型。

桌面版第一次启动时没有 API key，契约 §7 要求回退到 ``fake``。``FakeProvider``
是「按预置顺序吐固定响应」的测试替身，没法撑起一个能点的界面；本模块补的是
**演示用的剧本 provider**：读用户最后一句的关键词，决定这一轮要不要调工具、
调哪个、参数是什么。

三条硬约束：

* **确定性。** 没有随机数、没有墙钟（时间基准固定为 2026-01-01T00:00Z），
  同一句话两次运行给出同样的工具调用与同样的措辞。
* **不伪造结果。** 第二轮回答只看工具真正返回的内容（成功/失败、计数、
  告警）。工具没加载就说没加载，工具失败了就写失败 —— 演示模式也不能
  假装健康。
* **不联网。** provider 本身不发任何网络请求：只 import 本地模块（``synthetic``
  造心跳，工具名来自服务端传入的 ``tools`` 列表）。工具自己会做什么由工具负责。
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone

from .providers.base import ChatMessage, ChatResponse, Provider

#: 剧本里的固定时间基准；所有造出来的时间都从它往后推，保证可复现。
DEMO_EPOCH = datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)

#: 工具结果在对话里的形状：``[工具结果][name][call_id] body``（user 角色）。
_TOOL_MESSAGE_RE = re.compile(
    r"^\[工具结果\]\[(?P<name>[^\]]+)\]\[(?P<call_id>[^\]]+)\]\s(?P<body>.*)$", re.S)

_HEALTH_WORDS = ("健康", "心跳", "在线", "离线", "heartbeat", "health")
_QC_WORDS = ("质控", "质量", "周跳", "统计", "离群", "slip", "qc", "outlier")
_EXPORT_WORDS = ("导出", "pdf", "图表", "报告", "export", "graph", "画图")
_RESTART_WORDS = ("重启", "restart", "reboot")

_HELP_TEXT = (
    "我是演示模式的本地助手，没有接外部模型，只在本地跑确定性脚本。可以试试：\n"
    "- 健康检查 / 心跳 —— 汇总台站设备在线状态\n"
    "- 质控 / 周跳 —— 对固定序列跑稳健统计与周跳检测\n"
    "- 导出 PDF —— 走本机 Node 的图表导出接口\n"
    "- 重启设备 —— 提交工作流（高风险流程会弹审批卡）\n"
    "结果都来自本地工具；工具没加载时我会直说，不会编造。"
)


class DemoProvider(Provider):
    """关键词剧本 provider。``chat`` 的第二个参数是工具描述列表。"""

    name = "fake"

    def __init__(self, *, model: str = "demo") -> None:
        self.model = model

    # ---- Provider 协议 -------------------------------------------------

    def chat(self, messages: list[ChatMessage], tools: list[dict]) -> ChatResponse:
        available = {
            item.get("name") for item in tools or []
            if isinstance(item, dict) and isinstance(item.get("name"), str)
        }
        results = _tool_results(messages)
        if results:
            return ChatResponse(content=self._final(results))
        text = _last_user_text(messages)
        return self._first_turn(text, available)

    # ---- 第一轮：按关键词选剧本 -----------------------------------------

    def _first_turn(self, text: str, available: set[str]) -> ChatResponse:
        lowered = (text or "").lower()

        if _contains(lowered, _HEALTH_WORDS):
            if "device_heartbeat" not in available:
                return ChatResponse(
                    content="心跳工具 device_heartbeat 当前没有加载，无法汇总设备状态。")
            return ChatResponse(
                content="正在汇总 4 台设备的心跳……",
                tool_calls=[{
                    "name": "device_heartbeat",
                    "args": _heartbeat_args(),
                    "reason": "用户要求查看设备心跳/健康度",
                    "confidence": 0.9,
                }],
            )

        if _contains(lowered, _QC_WORDS):
            calls = []
            if "robust_stats" in available:
                calls.append({
                    "name": "robust_stats",
                    "args": {"values": list(_QC_VALUES)},
                    "reason": "先看固定序列的离群点",
                    "confidence": 0.85,
                })
            if "slip_detect" in available:
                calls.append({
                    "name": "slip_detect",
                    "args": _slip_args(),
                    "reason": "再对固定双频序列做周跳检测",
                    "confidence": 0.85,
                })
            if not calls:
                return ChatResponse(
                    content="质控工具（robust_stats / slip_detect）当前没有加载，无法执行。")
            return ChatResponse(content="跑一遍质控脚本……", tool_calls=calls)

        if _contains(lowered, _EXPORT_WORDS):
            if "native_graph_pdf" not in available:
                return ChatResponse(
                    content="导出工具 native_graph_pdf 当前没有加载（需要 Node 服务在线）。")
            return ChatResponse(
                content="正在请求图表导出……",
                tool_calls=[{
                    "name": "native_graph_pdf",
                    "args": {"project": "demo"},
                    "reason": "用户要求导出 PDF",
                    "confidence": 0.8,
                }],
            )

        if _contains(lowered, _RESTART_WORDS):
            if "workflow_run" not in available:
                return ChatResponse(
                    content="工作流工具 workflow_run 当前没有加载，无法提交重启流程。")
            return ChatResponse(
                content="准备提交设备重启工作流……",
                tool_calls=[{
                    "name": "workflow_run",
                    "args": {"workflow": "script.device.restart"},
                    "reason": "用户要求重启设备",
                    "confidence": 0.75,
                }],
            )

        return ChatResponse(content=_HELP_TEXT)

    # ---- 第二轮：只复述工具真正返回的东西 -------------------------------

    def _final(self, results: list[dict]) -> str:
        lines: list[str] = []
        for item in results:
            name = item["name"]
            if not item["ok"]:
                lines.append(f"- {name} 执行失败：{item['error'] or '未返回错误信息'}")
                continue
            data = item["data"] or {}
            if name == "device_heartbeat":
                lines.append(_describe_heartbeat(data))
            elif name == "robust_stats":
                lines.append(_describe_robust_stats(data))
            elif name == "slip_detect":
                lines.append(_describe_slip_detect(data))
            elif name == "native_graph_pdf":
                path = data.get("path") or data.get("file") or "（未返回路径）"
                lines.append(f"- 图表已导出：{path}")
            elif name == "workflow_run":
                status = data.get("status") or data.get("state") or "已提交"
                run_id = data.get("run_id") or data.get("job_id") or ""
                suffix = f"（任务 {run_id}）" if run_id else ""
                lines.append(f"- 工作流状态：{status}{suffix}")
            else:
                lines.append(f"- {name} 已返回 {len(data)} 个字段。")
        lines.append("")
        lines.append("（演示模式：以上结果由本地工具产生，未调用外部模型。）")
        return "\n".join(lines)


# --------------------------------------------------------------------------
# 固定剧本数据
# --------------------------------------------------------------------------

_QC_VALUES = (12.04, 12.01, 12.06, 12.02, 12.05, 41.90, 12.03, 12.07, 12.02, 12.05)


def _heartbeat_args() -> dict:
    """用 ``synthetic.device_heartbeats`` 造 4 台设备；WX200 故意停在早期位置。

    心跳工具不读墙钟（``now`` 必须显式给），所以这里把 ``now`` 取成序列里
    最晚的一刻 —— 同一份输入永远得到同一份判定。
    """
    from ..synthetic import device_heartbeats

    rows = device_heartbeats(
        start=DEMO_EPOCH,
        n=6,
        interval_s=300.0,
        devices=("GNSS-RX", "POWER", "LINK", "WX200"),
        station="SYNTH-01",
        stop_after={"WX200": 1},
    )
    # 每台设备只保留最后一次心跳：工具按「最近一次 + 周期」判定，把 24 条
    # 历史心跳全喂进去会数出 20 多台设备。WX200 的最后一次停在早期位置，
    # 所以它会显示为 stale。
    latest_by_device: dict[str, dict] = {}
    for row in rows:
        device = row["device_id"]
        if (device not in latest_by_device
                or row["last_seen_at"] > latest_by_device[device]["last_seen_at"]):
            latest_by_device[device] = row
    heartbeats = [latest_by_device[key] for key in sorted(latest_by_device)]
    latest = max(row["last_seen_at"] for row in heartbeats)
    return {"heartbeats": heartbeats, "now": latest}


def _slip_args() -> dict:
    """8 个历元的固定双频序列，第 5 个历元的两路 ADR 各跳一下。"""
    series = []
    for index in range(8):
        tow = 30.0 * index
        jump = 1.0 if index >= 4 else 0.0
        series.append({
            "gps_week": 2300,
            "gps_tow_s": tow,
            "quality_flag": 0,
            "L1": {
                "psr_m": 22_000_000.0 + 120.0 * index,
                "adr_cycles": 100_000_000.0 + 3200.0 * index + jump,
            },
            "L2": {
                "psr_m": 22_000_010.0 + 120.0 * index,
                "adr_cycles": 78_000_000.0 + 2500.0 * index,
            },
        })
    return {
        "series": series,
        "system": "GPS",
        "signal_1": "L1",
        "signal_2": "L2",
        "sign": -1,
    }


# --------------------------------------------------------------------------
# 描述与解析
# --------------------------------------------------------------------------

def _describe_heartbeat(data: dict) -> str:
    summary = data.get("summary") or {}
    if not isinstance(summary, dict) or not summary:
        return "- 心跳工具返回了结果，但没有 summary 字段。"
    total = summary.get("total", 0)
    parts = [f"- 共 {total} 台设备"]
    for status, label in (("online", "在线"), ("stale", "迟滞"), ("offline", "离线")):
        if status in summary:
            parts.append(f"{label} {summary[status]}")
    line = "，".join(parts) + "。"
    alerts = summary.get("alerts") or []
    if alerts:
        line += f" 需要关注：{'、'.join(str(a) for a in alerts)}。"
    else:
        line += " 没有告警。"
    return line


def _describe_robust_stats(data: dict) -> str:
    median = _round_number(data.get("median"))
    mad = _round_number(data.get("mad"))
    z = data.get("robust_z") or []
    outliers = [index for index, value in enumerate(z)
                if isinstance(value, (int, float)) and abs(value) >= 3.5]
    line = f"- 稳健统计：n={data.get('n')}，中位数 {median}，MAD {mad}"
    if outliers:
        line += f"，|z|≥3.5 的离群点下标 {outliers}"
    else:
        line += "，没有 |z|≥3.5 的离群点"
    return line + "。"


def _describe_slip_detect(data: dict) -> str:
    counts = data.get("counts") or {}
    indices = data.get("slip_indices") or []
    if indices:
        return (f"- 周跳检测：{data.get('n_epochs')} 个历元，"
                f"检出周跳历元下标 {indices}（GF {counts.get('gf')}，"
                f"MW {counts.get('mw')}）。")
    if counts.get("mw"):
        return (f"- 周跳检测：{data.get('n_epochs')} 个历元，联合判定没有周跳；"
                f"MW 通道有 {counts.get('mw')} 个候选，未形成联合证据。")
    return f"- 周跳检测：{data.get('n_epochs')} 个历元，未检出周跳。"


def _round_number(value, digits: int = 4):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return value
    return round(float(value), digits)


def _contains(text: str, words: tuple[str, ...]) -> bool:
    return any(word.lower() in text for word in words)


def _last_user_text(messages: list[ChatMessage]) -> str:
    for message in reversed(messages or []):
        if getattr(message, "role", "") == "user":
            return getattr(message, "content", "") or ""
    return ""


def _tool_results(messages: list[ChatMessage]) -> list[dict]:
    """把 orchestrator 写回的工具消息解析成结构化结果。

    解析失败也保留条目（``ok=False``），这样演示回答会诚实地说「无法解析」，
    而不是把一段看不懂的文本当成成功。
    """
    out: list[dict] = []
    for message in messages or []:
        content = getattr(message, "content", "") or ""
        match = _TOOL_MESSAGE_RE.match(content)
        if not match:
            continue
        body = match.group("body")
        if body.startswith("失败："):
            out.append({"name": match.group("name"),
                        "call_id": match.group("call_id"),
                        "ok": False, "data": {},
                        "error": body[len("失败："):]})
            continue
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            out.append({"name": match.group("name"),
                        "call_id": match.group("call_id"),
                        "ok": False, "data": {},
                        "error": "工具结果不是合法 JSON"})
            continue
        if not isinstance(data, dict):
            data = {"value": data}
        out.append({"name": match.group("name"),
                    "call_id": match.group("call_id"),
                    "ok": True, "data": data, "error": None})
    return out
