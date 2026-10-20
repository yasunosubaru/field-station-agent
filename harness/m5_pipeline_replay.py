#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M5-1 全链回放：观测数据进，工单与归档出（issue #60）。

## 这条回放跑的是什么

一条五阶段链路（``qc → device_monitor → fault_diagnosis → operations_dispatch
→ archive``），阶段之间只有消息（``MessageBus``），阶段内的模型输出由
``FakeProvider`` 脚本化给出、工具调用参数**由样本数据算出**（不是手抄常量）。
数据接入方（intake）发两条消息：观测批次与设备读数。

样本口径（**替代口径**）：真实台站样本受 #28/#33 阻塞（成员侧还没交脱敏样本）。
本回放先用固定种子合成样本走通全链并记录范围说明；真实样本到位后，同一条命令
``--bless`` 复跑即可把基线换成真实样本的数字，场景与 checks 不用改。

* 合成参数：``seed=FIXTURE_SEED``、``station=BADG``、``n_epochs=60``、
  ``systems=["GPS"]``、``sats={"GPS": [1, 2]}``、生成器 ``slips=[]``；
* 后处理：GPS 01 的 L1 相位自第 30 个历元起整体 +5.0 cycles（**持续阶跃**）。
  实验实测（`_fsa-ledger/m5_probe_scene.py`）：该步长在 ``slip_detect`` 的
  gf / mw 双通道均命中（counts 全 1、slip_indices=[30]），GPS 02 全 0；
* 设备读数：BADG 三条——power 12.0 V（正常）、link −88 dBm（正常）、
  uplink packets_5min 缺测（``quality_flag="missing"``），期望
  ``station_health`` 报 missing=1、degraded。

## 十项 checks

1. ``chain_complete`` —— 5 个阶段按序、7 条消息主题与发送者全对；
2. ``messages_in_trace`` —— 总线上 7 条消息与 trace 里的 ``message`` 事件
   一一对应（id / 主题 / refs / payload 全等）；
3. ``qc_slip_detected`` —— qc 阶段 GPS 01 命中 1 处阶跃（union/gf/mw 全 1、
   索引 30），GPS 02 为 0；
4. ``device_missing_flagged`` —— station_health 报 summary.missing=1、
   BADG degraded；
5. ``diagnosis_kb_cited`` —— 研判阶段命中的规程同时包含 ``qc-phase-slip``
   与 ``network-loss``；
6. ``approval_recorded`` —— 高风险动作在执行前留下 approval 事件
   （verdict=approved、by=approve_all）；
7. ``work_order_created`` —— WO-0001 状态 open、优先级 P0，且与链路提取的
   ``work_order`` 产物一致；
8. ``action_executed`` —— execute_device_action 受理（simulated），且
   approval 事件在对应 tool_result **之前**；
9. ``archive_synthetic_isolated`` —— 归档落在 ``synthetic/`` 子目录、带
   ``SYNTHETIC_`` 前缀、文件存在、字节无 CRLF、结果里的 sha256 与文件实际
   sha256 一致（跨平台逐字节一致，见 PROVENANCE.md 里 ``write_json`` 的
   2026-10-19 修改记录）；
10. ``tokens_recorded`` —— provider 的 token 用量与脚本化响应完全一致
    （确定性），逐次耗时只写旁路 ``m5_pipeline_metrics.jsonl``，不进基线。

## 用法与退出码

::

    $env:PYTHONPATH="src"; python harness/m5_pipeline_replay.py --fixture harness/fixtures/m5_pipeline_replay_20261020.json
    $env:PYTHONPATH="src"; python harness/m5_pipeline_replay.py --verify-log logs/m5_pipeline_replay.json
    $env:PYTHONPATH="src"; python harness/m5_pipeline_replay.py --fixture <路径> --bless

退出码 ``0``：与 fixture 一致 / 日志复校通过；``1``：漂移或复校失败；
``2``：用法或 IO 错误（含 fixture 不存在——先 ``--bless`` 建立基线）。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tempfile
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from fieldstation import synthetic  # noqa: E402
from fieldstation.agents.approval import ApprovalGate, ApproveAll  # noqa: E402
from fieldstation.agents.bus import MessageBus  # noqa: E402
from fieldstation.agents.conclusion import ConclusionContract  # noqa: E402
from fieldstation.agents.config import build, load_agent_config  # noqa: E402
from fieldstation.agents.knowledge import (  # noqa: E402
    KnowledgeBase,
    knowledge_search_tool,
    load_documents,
)
from fieldstation.agents.pipeline import (  # noqa: E402
    Pipeline,
    PipelineStage,
    observation_payload,
    reading_payloads,
)
from fieldstation.agents.providers.base import ChatResponse  # noqa: E402
from fieldstation.agents.providers.fake import FakeProvider  # noqa: E402
from fieldstation.agents.tools import ToolRegistry  # noqa: E402
from fieldstation.agents.tools.archive_tools import ArchiveExportTool  # noqa: E402
from fieldstation.agents.tools.qc_tools import (  # noqa: E402
    continuity_verdict_tool,
    magnitude_verdict_tool,
    robust_stats_tool,
    slip_detect_tool,
)
from fieldstation.agents.tools.station_tools import station_health_tool  # noqa: E402
from fieldstation.agents.tools.work_order_tools import (  # noqa: E402
    CreateWorkOrderTool,
    ExecuteDeviceActionTool,
)
from fieldstation.agents.trace.reader import read_trace  # noqa: E402
from fieldstation.agents.trace.writer import TraceWriter  # noqa: E402
from fieldstation.store import product  # noqa: E402
from fieldstation.store.model import StationReading  # noqa: E402
from fieldstation.store.work_order import WorkOrderService  # noqa: E402

FIXTURE_KIND = "fieldstation.m5_pipeline_replay.fixture"
FIXTURE_VERSION = 1
LOG_KIND = "fieldstation.m5_pipeline_replay.log"
LOG_NAME = "m5_pipeline_replay.json"
METRICS_NAME = "m5_pipeline_metrics.jsonl"
FIXTURE_NAME = "m5_pipeline_replay_20261020.json"
CONFIG_DIR = ROOT / "config" / "agents"
KB_DOCS = ROOT / "data" / "kb" / "knowledge.jsonl"
DEFAULT_FIXTURE = ROOT / "harness" / "fixtures" / FIXTURE_NAME

SCENARIO = "m5-full-chain"
STATION = "BADG"
N_EPOCHS = 60
STEP_INDEX = 30
STEP_CYCLES = 5.0
ARCHIVE_EXPECTED_PATH = "pipeline/m5/synthetic/SYNTHETIC_chain_summary.json"

#: (阶段名, 配置文件, 发布主题, 消费主题, 任务说明)
STAGE_SPECS = (
    ("qc", "qc.json", "qc.verdict", ("data.observations",),
     "对本批观测做质量控制：检查相位阶跃并给出结论。"),
    ("device_monitor", "device_monitor.json", "device.health", ("data.device",),
     "汇总 BADG 的设备读数健康度（含缺测）并给出结论。"),
    ("fault_diagnosis", "fault_diagnosis.json", "fault.diagnosis",
     ("qc.verdict", "device.health"),
     "结合质控结论与设备健康度做故障研判，引用规程。"),
    ("operations_dispatch", "operations_dispatch.json", "dispatch.work_order",
     ("fault.diagnosis",),
     "按研判结果建单并评估是否需要设备动作（高风险动作需人工批准）。"),
    ("archive", "archive.json", "archive.done", ("dispatch.work_order",),
     "把本次全链摘要作为合成产物归档。"),
)

#: 阶段记录里参与 sha256 的字段（固定集合——键多了少了都算接口漂移）
STAGE_SHA_FIELDS = ("stage", "topic", "message_id", "config_hash", "conclusion",
                    "evidence_call_ids", "tool_calls", "artifacts")


def _sha256_canonical(obj) -> str:
    return hashlib.sha256(product.canonical_json(obj).encode("utf-8")).hexdigest()


def _config_hash(path: Path) -> str:
    data = json.loads(path.read_text(encoding="utf-8"))
    return _sha256_canonical(data)


def _short(digest: str) -> str:
    return (digest or "")[:12] + "…"


# ------------------------------------------------------------------ 场景数据
def _sample():
    """固定种子合成样本 + GPS 01 L1 持续阶跃后处理（见模块 docstring）。"""
    cfg = synthetic.default_cfg(
        seed=synthetic.FIXTURE_SEED, station=STATION,
        n_epochs=N_EPOCHS, systems=["GPS"], sats={"GPS": [1, 2]}, slips=[])
    obs, _truth, _merged = synthetic.generate(cfg)
    l1 = sorted((ob for ob in obs
                 if (ob.station, ob.system, ob.sv) == (STATION, "GPS", 1)
                 and ob.signal == "L1"),
                key=lambda ob: ob.gps_tow_s)
    if len(l1) != N_EPOCHS:
        raise RuntimeError(f"样本形状异常：GPS 01 L1 历元数 {len(l1)} != {N_EPOCHS}")
    from_tow = l1[STEP_INDEX].gps_tow_s
    for ob in obs:
        if ((ob.station, ob.system, ob.sv) == (STATION, "GPS", 1)
                and ob.signal == "L1" and ob.gps_tow_s >= from_tow - 1e-9):
            ob.adr_cycles += STEP_CYCLES
    return obs


def _device_readings() -> list[StationReading]:
    """BADG 三条读数：两条正常 + uplink 缺测一条。"""
    def at(text: str):
        return datetime.fromisoformat(text)

    return [
        StationReading(station_id=STATION, sensor="power", metric="voltage",
                       value=12.0, unit="V",
                       observed_at=at("2026-10-19T08:00:00+00:00"), quality_flag=""),
        StationReading(station_id=STATION, sensor="link", metric="rssi",
                       value=-88.0, unit="dBm",
                       observed_at=at("2026-10-19T08:05:00+00:00"), quality_flag=""),
        StationReading(station_id=STATION, sensor="uplink", metric="packets_5min",
                       value=None, unit="count",
                       observed_at=at("2026-10-19T08:10:00+00:00"),
                       quality_flag="missing"),
    ]


def _scenario(sample) -> dict:
    """把样本组织成 intake payload（观测批次 + 设备读数）。"""
    return {
        "observations": observation_payload(sample),
        "device": {
            "station": STATION,
            "n_readings": 3,
            "readings": reading_payloads(_device_readings()),
        },
    }


def _scripted(obs_payload: dict) -> dict[str, list[ChatResponse]]:
    """五阶段的脚本化响应；工具入参由 payload 里的 ``tool_args`` 直接取用。"""
    groups = {g["key"]: g for g in obs_payload["groups"]}
    g1, g2 = groups["GPS 01"], groups["GPS 02"]
    readings = reading_payloads(_device_readings())

    def json_conclusion(obj: dict) -> str:
        return json.dumps(obj, ensure_ascii=False, sort_keys=True)

    qc_evidence = [
        {"call_id": "t0001", "tool": "slip_detect",
         "finding": (f"BADG GPS 01 自历元 {STEP_INDEX} 起出现约 {STEP_CYCLES:.1f} cycles "
                     "的持续阶跃；gf / mw 与并集计数均为 1")},
        {"call_id": "t0002", "tool": "slip_detect",
         "finding": "BADG GPS 02 同批数据无阶跃（计数全 0），异常限于 GPS 01 的 L1"},
    ]
    device_evidence = [
        {"call_id": "t0001", "tool": "station_health",
         "finding": ("BADG 3 条读数中 uplink 的 packets_5min 缺测 1 条；"
                     "健康度 0.667、状态 degraded（标记 missing）")},
    ]
    diagnosis_evidence = [
        {"call_id": "t0001", "tool": "knowledge_search",
         "finding": "命中规程 qc-phase-slip：末段相位跳变需按相位滑移处理并复查定平链路"},
        {"call_id": "t0002", "tool": "knowledge_search",
         "finding": ("命中规程 network-loss：上行链路异常先核对链路状态，"
                     "不能凭遥测缺失推断设备损坏")},
    ]
    dispatch_evidence = [
        {"call_id": "t0001", "tool": "create_work_order",
         "finding": "工单 WO-0001 已建：GPS 01 L1 持续相位阶跃 + 上行遥测缺测（P0）"},
        {"call_id": "t0002", "tool": "execute_device_action",
         "finding": "重启接收机动作已获人工批准并受理（simulated）"},
    ]
    archive_evidence = [
        {"call_id": "t0001", "tool": "archive_export",
         "finding": f"全链摘要已隔离写入 {ARCHIVE_EXPECTED_PATH}"},
        {"call_id": "t0002", "tool": "knowledge_search",
         "finding": "命中归档规程 archive-synthetic：合成数据必须进 synthetic/ 目录并带 SYNTHETIC_ 前缀"},
    ]

    return {
        "qc": [
            ChatResponse(content="", tool_calls=[
                {"name": "slip_detect", "args": g1["tool_args"]}],
                usage={"prompt_tokens": 120, "completion_tokens": 14}),
            ChatResponse(content="", tool_calls=[
                {"name": "slip_detect", "args": g2["tool_args"]}],
                usage={"prompt_tokens": 150, "completion_tokens": 12}),
            ChatResponse(content=json_conclusion({
                "attribution": {"fault_type": "phase_slip_step",
                                "evidence": qc_evidence},
                "recommendation": "标记 GPS 01 L1 该段相位不可用，转入故障研判核对定平链路",
                "confidence": 0.93}),
                usage={"prompt_tokens": 180, "completion_tokens": 60}),
        ],
        "device_monitor": [
            ChatResponse(content="", tool_calls=[
                {"name": "station_health", "args": {"readings": readings}}],
                usage={"prompt_tokens": 90, "completion_tokens": 10}),
            ChatResponse(content=json_conclusion({
                "attribution": {"fault_type": "uplink_telemetry_missing",
                                "evidence": device_evidence},
                "recommendation": "核对上行链路状态与遥测缓存，确认缺测期间是否发生丢包",
                "confidence": 0.8}),
                usage={"prompt_tokens": 130, "completion_tokens": 48}),
        ],
        "fault_diagnosis": [
            ChatResponse(content="", tool_calls=[{
                "name": "knowledge_search",
                "args": {"query": "持续相位阶跃 定平链路 处理", "limit": 3}}],
                usage={"prompt_tokens": 160, "completion_tokens": 12}),
            ChatResponse(content="", tool_calls=[{
                "name": "knowledge_search",
                "args": {"query": "上行链路中断 未上报", "limit": 3}}],
                usage={"prompt_tokens": 200, "completion_tokens": 12}),
            ChatResponse(content=json_conclusion({
                "attribution": {"fault_type": "phase_slip_with_uplink_loss",
                                "evidence": diagnosis_evidence},
                "recommendation": "按 qc-phase-slip 隔离该段相位并复查定平链路；同时按 network-loss 核对上行链路",
                "confidence": 0.9}),
                usage={"prompt_tokens": 260, "completion_tokens": 70}),
        ],
        "operations_dispatch": [
            ChatResponse(content="", tool_calls=[{
                "name": "create_work_order",
                "args": {"station_id": STATION,
                         "title": "GPS 01 L1 持续相位阶跃 + 上行遥测缺测",
                         "priority": "P0", "risk": "medium",
                         "description": (f"QC 检出 GPS 01 L1 自历元 {STEP_INDEX} 起 "
                                         f"{STEP_CYCLES:.1f} cycles 持续阶跃；"
                                         "设备侧上行遥测缺测 1 条"),
                         "action": "restart_receiver"}}],
                usage={"prompt_tokens": 140, "completion_tokens": 18}),
            ChatResponse(content="", tool_calls=[{
                "name": "execute_device_action",
                "args": {"station_id": STATION, "action": "restart_receiver",
                         "reason": "持续相位阶跃疑似接收机异常，远程重启后复检",
                         "confidence": 0.99}}],
                usage={"prompt_tokens": 170, "completion_tokens": 16}),
            ChatResponse(content=json_conclusion({
                "attribution": {"fault_type": "phase_slip_remediation",
                                "evidence": dispatch_evidence},
                "recommendation": "跟踪重启与链路恢复情况；相位数据按 qc-phase-slip 规程复检后再放行",
                "confidence": 0.95}),
                usage={"prompt_tokens": 210, "completion_tokens": 66}),
        ],
        "archive": [
            ChatResponse(content="", tool_calls=[{
                "name": "archive_export",
                "args": {"relative_path": "pipeline/m5/chain_summary.json",
                         "payload": {"run": "m5-pipeline-replay", "station": STATION,
                                     "chain": ["data.observations", "qc.verdict",
                                               "device.health", "fault.diagnosis",
                                               "dispatch.work_order", "archive.done"]},
                         "synthetic": True}}],
                usage={"prompt_tokens": 80, "completion_tokens": 12}),
            ChatResponse(content="", tool_calls=[{
                "name": "knowledge_search",
                "args": {"query": "合成产物 归档", "limit": 3}}],
                usage={"prompt_tokens": 110, "completion_tokens": 10}),
            ChatResponse(content=json_conclusion({
                "attribution": {"fault_type": "archive_exported",
                                "evidence": archive_evidence},
                "recommendation": "归档完成；该产物为合成数据，不得与真实产物混放",
                "confidence": 0.9}),
                usage={"prompt_tokens": 140, "completion_tokens": 52}),
        ],
    }


# ------------------------------------------------------------------ trace 工具
def _stage_segments(trace: list[dict]) -> list[list[dict]]:
    """按 ``message`` 事件把 trace 切成阶段段。

    阶段先跑完、再发布自己的消息，所以「上一条 message 之后、下一条 message
    之前」的事件恰好属于同一个阶段；intake 的两条消息之前没有事件，不产生
    空段。返回顺序即阶段顺序（每段对应 ``STAGE_SPECS`` 的一项）。
    """
    segments: list[list[dict]] = []
    current: list[dict] = []
    for event in trace:
        if event.get("kind") == "message":
            if current:
                segments.append(current)
                current = []
            continue
        current.append(event)
    if current:
        segments.append(current)
    return segments


def _tool_results(segment: list[dict]) -> dict[str, dict]:
    return {e["call_id"]: e for e in segment
            if e.get("kind") == "tool_result" and isinstance(e.get("call_id"), str)}


def _read_metrics(path: Path) -> list[dict]:
    events: list[dict] = []
    if not path.is_file():
        return events
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            events.append(json.loads(line))
    return events


def _token_totals(metrics_events: list[dict]) -> dict[str, dict]:
    totals: dict[str, dict] = {}
    for event in metrics_events:
        if event.get("kind") != "provider_metrics":
            continue
        bucket = totals.setdefault(event.get("agent"), {
            "calls": 0, "prompt_tokens": 0, "completion_tokens": 0})
        usage = event.get("usage") or {}
        bucket["calls"] += 1
        bucket["prompt_tokens"] += int(usage.get("prompt_tokens", 0) or 0)
        bucket["completion_tokens"] += int(usage.get("completion_tokens", 0) or 0)
    return totals


def _token_expectations(scripted: dict[str, list[ChatResponse]]) -> dict[str, dict]:
    expected: dict[str, dict] = {}
    for stage, responses in scripted.items():
        expected[stage] = {
            "calls": len(responses),
            "prompt_tokens": sum(int((r.usage or {}).get("prompt_tokens", 0))
                                 for r in responses),
            "completion_tokens": sum(int((r.usage or {}).get("completion_tokens", 0))
                                     for r in responses),
        }
    return expected


# ------------------------------------------------------------------- 十项 checks
def _checks(*, result, trace: list[dict], metrics_events: list[dict],
            archive_root: Path, scripted: dict[str, list[ChatResponse]]) -> dict:
    segments = _stage_segments(trace)
    stage_names = [stage for stage, *_ in STAGE_SPECS]
    messages = [m.to_dict() for m in result.messages]
    trace_messages = [e for e in trace if e.get("kind") == "message"]
    segments_ok = len(segments) == len(STAGE_SPECS)
    results = [_tool_results(seg) for seg in segments] if segments_ok else []

    chain_complete = bool(
        [o.stage for o in result.outcomes] == stage_names
        and [(m.topic, m.sender) for m in result.messages] == [
            ("data.observations", "intake"), ("data.device", "intake"),
            ("qc.verdict", "qc"), ("device.health", "device_monitor"),
            ("fault.diagnosis", "fault_diagnosis"),
            ("dispatch.work_order", "operations_dispatch"),
            ("archive.done", "archive")]
        and [o.message_id for o in result.outcomes]
        == [f"m{i:04d}" for i in range(3, 8)])

    messages_in_trace = bool(
        len(trace_messages) == len(messages) == 7
        and all(tm.get("msg_id") == m["msg_id"] and tm.get("topic") == m["topic"]
                and tm.get("sender") == m["sender"] and tm.get("refs") == m["refs"]
                and tm.get("payload") == m["payload"]
                for tm, m in zip(trace_messages, messages)))

    qc_slip_detected = False
    device_missing_flagged = False
    diagnosis_kb_cited = False
    approval_recorded = False
    work_order_created = False
    action_executed = False
    archive_synthetic_isolated = False
    if segments_ok:
        # 3. qc：GPS 01 命中 1 处阶跃、GPS 02 干净
        g1 = results[0].get("t0001", {})
        g2 = results[0].get("t0002", {})
        d1 = g1.get("result") or {}
        d2 = (g2.get("result") or {}).get("counts") or {}
        counts = d1.get("counts") or {}
        qc_slip_detected = bool(
            g1.get("ok") and g1.get("tool") == "slip_detect"
            and counts.get("union") == 1 and counts.get("gf") == 1
            and counts.get("mw") == 1 and counts.get("split_points") == 1
            and d1.get("slip_indices") == [STEP_INDEX]
            and g2.get("ok") and d2.get("union") == 0)

        # 4. 设备缺测被标出
        health = results[1].get("t0001", {})
        hdata = health.get("result") or {}
        device_missing_flagged = bool(
            health.get("ok") and health.get("tool") == "station_health"
            and (hdata.get("summary") or {}).get("missing") == 1
            and any(row.get("station_id") == STATION
                    and row.get("status") == "degraded"
                    and row.get("missing") == 1
                    for row in (hdata.get("stations") or [])))

        # 5. 研判引用的规程
        doc_ids = set()
        for event in results[2].values():
            if event.get("tool") == "knowledge_search" and event.get("ok"):
                for row in (event.get("result") or {}).get("results") or []:
                    doc_ids.add(row.get("doc_id"))
        diagnosis_kb_cited = {"qc-phase-slip", "network-loss"} <= doc_ids

        # 6. 高风险动作的审批留痕
        segment = segments[3]
        approvals = [e for e in segment if e.get("kind") == "approval"]
        approval_recorded = bool(
            len(approvals) == 1
            and approvals[0].get("verdict") == "approved"
            and approvals[0].get("by") == "approve_all"
            and approvals[0].get("action") == "execute_device_action")

        # 7. 工单
        order = results[3].get("t0001", {})
        odata = order.get("result") or {}
        work_order_created = bool(
            order.get("ok") and order.get("tool") == "create_work_order"
            and odata.get("order_id") == "WO-0001" and odata.get("status") == "open"
            and odata.get("priority") == "P0"
            and result.outcomes[3].artifacts.get("work_order") == odata)

        # 8. 动作执行 + 审批在动作之前
        action = results[3].get("t0002", {})
        adata = action.get("result") or {}
        approval_before_action = False
        for i, event in enumerate(segment):
            if event.get("kind") == "approval":
                approval_before_action = any(
                    later.get("kind") == "tool_result"
                    and later.get("call_id") == "t0002"
                    for later in segment[i + 1:])
        action_executed = bool(
            action.get("ok") and action.get("tool") == "execute_device_action"
            and adata.get("status") == "accepted"
            and adata.get("execution_mode") == "simulated"
            and approval_before_action
            and result.outcomes[3].artifacts.get("device_action") == adata)

        # 9. 归档隔离 + 字节跨平台一致
        export = results[4].get("t0001", {})
        edata = export.get("result") or {}
        path = edata.get("path") or ""
        file_path = archive_root / path
        file_ok = file_path.is_file()
        payload = file_path.read_bytes() if file_ok else b""
        note_ok = False
        if payload:
            try:
                note_ok = bool(json.loads(payload.decode("utf-8")).get("_synthetic_note"))
            except ValueError:
                note_ok = False
        archive_synthetic_isolated = bool(
            export.get("ok") and export.get("tool") == "archive_export"
            and edata.get("synthetic") is True and path == ARCHIVE_EXPECTED_PATH
            and file_ok and b"\r\n" not in payload and note_ok
            and product.sha256_file(file_path) == edata.get("sha256"))

    # 10. token 用量与脚本化响应一致
    tokens_recorded = bool(
        _token_totals(metrics_events) == _token_expectations(scripted))

    return {
        "chain_complete": chain_complete,
        "messages_in_trace": messages_in_trace,
        "qc_slip_detected": qc_slip_detected,
        "device_missing_flagged": device_missing_flagged,
        "diagnosis_kb_cited": diagnosis_kb_cited,
        "approval_recorded": approval_recorded,
        "work_order_created": work_order_created,
        "action_executed": action_executed,
        "archive_synthetic_isolated": archive_synthetic_isolated,
        "tokens_recorded": tokens_recorded,
    }


# -------------------------------------------------------------------- 回放主体
def _top_payload(log: dict) -> dict:
    """顶层 sha256 覆盖的字段（verify-log 用它复算，字段集合即接口）。"""
    return {
        "scenario": log["scenario"],
        "sample": log["sample"],
        "stages": [{k: s[k] for k in ("stage", "config_hash", "sha256")}
                   for s in log["stages"]],
        "messages": log["messages"],
        "checks": log["checks"],
        "tokens": log["tokens"],
        "trace": log["trace"],
    }


def run_once(log_dir: Path) -> dict:
    log_dir.mkdir(parents=True, exist_ok=True)
    metrics_path = log_dir / METRICS_NAME
    metrics_path.write_text("", encoding="utf-8")

    sample = _sample()
    scene = _scenario(sample)
    obs_payload = scene["observations"]
    if obs_payload["n_obs"] != N_EPOCHS * 2 * 2:
        raise RuntimeError(
            f"样本形状异常：n_obs {obs_payload['n_obs']} != {N_EPOCHS * 2 * 2}")
    if [g["key"] for g in obs_payload["groups"]] != ["GPS 01", "GPS 02"]:
        raise RuntimeError("样本形状异常：观测分组不是 GPS 01 / GPS 02")
    scripted = _scripted(obs_payload)

    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        kb = KnowledgeBase(td / "kb.sqlite3")
        kb.index(load_documents(KB_DOCS))
        archive_root = td / "archive"
        base = ToolRegistry()
        for tool in (knowledge_search_tool(kb), station_health_tool(),
                     robust_stats_tool(), continuity_verdict_tool(),
                     magnitude_verdict_tool(), slip_detect_tool(),
                     CreateWorkOrderTool(WorkOrderService()),
                     ExecuteDeviceActionTool(), ArchiveExportTool(archive_root)):
            base.register(tool)

        stages: list[PipelineStage] = []
        for name, config, topic, consumes, note in STAGE_SPECS:
            cfg = load_agent_config(str(CONFIG_DIR / config))
            if cfg.name != name:
                raise RuntimeError(
                    f"配置 {config} 的 name={cfg.name!r} 与阶段名 {name!r} 不符")
            agent, scoped = build(cfg, FakeProvider(list(scripted[name])), base)
            stages.append(PipelineStage(
                name=name, agent=agent, registry=scoped, topic=topic,
                consumes=consumes, note=note,
                approval=(ApprovalGate(approver=ApproveAll())
                          if name == "operations_dispatch" else None),
                contract=ConclusionContract()))

        trace_path = td / "trace.jsonl"
        bus = MessageBus(TraceWriter(trace_path))
        pipeline = Pipeline(bus, trace_path, stages,
                            metrics=TraceWriter(metrics_path))
        result = pipeline.run(intake=[("data.observations", obs_payload),
                                      ("data.device", scene["device"])])
        trace = read_trace(trace_path)
        metrics_events = _read_metrics(metrics_path)
        checks = _checks(result=result, trace=trace, metrics_events=metrics_events,
                         archive_root=archive_root, scripted=scripted)

        stage_records = []
        for spec, outcome in zip(STAGE_SPECS, result.outcomes):
            record = outcome.to_dict()
            record["config_hash"] = _config_hash(CONFIG_DIR / spec[1])
            record["sha256"] = _sha256_canonical(
                {k: record[k] for k in STAGE_SHA_FIELDS})
            stage_records.append(record)

        archive_segments = _stage_segments(trace)
        archive_event = (_tool_results(archive_segments[-1]).get("t0001", {})
                         if archive_segments else {})
        archive_data = archive_event.get("result") or {}
        archive_file = archive_root / (archive_data.get("path") or "")
        tokens = _token_totals(metrics_events)
        checks_passed = sum(1 for value in checks.values() if value)

        log = {
            "kind": LOG_KIND,
            "version": 1,
            "scenario": SCENARIO,
            "sample": {
                "mode": "synthetic",
                "note": ("真实台站样本受 #28/#33 阻塞；本基线为固定种子合成样本，"
                         "真实样本到位后同一命令 --bless 复跑"),
                "station": STATION,
                "seed": synthetic.FIXTURE_SEED,
                "systems": ["GPS"],
                "sats": {"GPS": [1, 2]},
                "n_epochs": N_EPOCHS,
                "generator_slips": [],
                "postprocess": {"target": "GPS 01 L1", "from_index": STEP_INDEX,
                                "step_cycles": STEP_CYCLES},
                "n_obs": obs_payload["n_obs"],
            },
            "stages": stage_records,
            "messages": [m.to_dict() for m in result.messages],
            "checks": checks,
            "summary": {
                "stages": len(stage_records),
                "messages": len(result.messages),
                "checks": f"{checks_passed}/{len(checks)}",
                "tokens": {
                    "prompt": sum(t["prompt_tokens"] for t in tokens.values()),
                    "completion": sum(t["completion_tokens"] for t in tokens.values()),
                },
            },
            "tokens": tokens,
            "archive": {
                "path": archive_data.get("path"),
                "sha256": archive_data.get("sha256"),
                "bytes": archive_file.stat().st_size if archive_file.is_file() else None,
            },
            "trace": trace,
            "trace_sha256": _sha256_canonical(trace),
        }
    log["sha256"] = _sha256_canonical(_top_payload(log))
    return log


# ------------------------------------------------------------------ 读写与比较
def _write_json(path: Path, obj: dict) -> None:
    # 钉 LF（同 harness/m4_agents_replay.py）：Windows 默认写 CRLF，会让「照
    # REPRODUCE 跑一遍」后工作区里的日志/fixture 与入库版本字节不同，而
    # .gitattributes 的归一化又让 git status 看不出来 —— 沉默的差异会被当成结论。
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=False) + "\n")


def _write_fixture(path: Path, log: dict) -> None:
    _write_json(path, {
        "kind": FIXTURE_KIND,
        "version": FIXTURE_VERSION,
        "created": "2026-10-20",
        "scenario": SCENARIO,
        "note": ("M5-1 全链回放基线：合成样本（受 #28/#33 阻塞的替代口径）+ "
                 "五阶段脚本化响应；sha 为 canonical JSON 的 sha256。"),
        "sample": log["sample"],
        "stages": [{k: s[k] for k in ("stage", "config_hash", "sha256")}
                   for s in log["stages"]],
        "checks": log["checks"],
        "summary": log["summary"],
        "sha256": log["sha256"],
    })


def _compare(fixture: dict, log: dict) -> tuple[dict[str, bool], list[str]]:
    """逐阶段与顶层比较；返回 (每阶段是否一致, 问题清单)。"""
    problems: list[str] = []
    expected = {s["stage"]: s for s in fixture.get("stages", [])}
    got = {s["stage"]: s for s in log["stages"]}
    stage_ok: dict[str, bool] = {}
    if set(expected) != set(got):
        problems.append(
            f"阶段集合不一致：fixture {sorted(expected)} / 实跑 {sorted(got)}")
    for name in got:
        exp = expected.get(name) or {}
        ok = all(exp.get(key) == got[name].get(key)
                 for key in ("config_hash", "sha256"))
        stage_ok[name] = ok
        if not ok:
            problems.append(
                f"{name} 漂移：config_hash {_short(str(exp.get('config_hash')))}"
                f"→{_short(str(got[name].get('config_hash')))}、"
                f"sha256 {_short(str(exp.get('sha256')))}"
                f"→{_short(str(got[name].get('sha256')))}")
    for key in ("checks", "summary", "sample"):
        if fixture.get(key) != log.get(key):
            problems.append(f"{key} 与 fixture 不一致")
    if fixture.get("sha256") != log.get("sha256"):
        problems.append(
            f"顶层 sha256 不一致：fixture {_short(str(fixture.get('sha256')))} / "
            f"实跑 {_short(str(log.get('sha256')))}")
    return stage_ok, problems


def verify_log(path: Path) -> int:
    """复校一份回放日志：内部一致性 + 证据引用有效性（不重跑链路）。"""
    try:
        log = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"[verify] 读不了日志 {path}：{exc}", file=sys.stderr)
        return 2
    if log.get("kind") != LOG_KIND:
        print(f"[verify] {path} 不是 {LOG_KIND}（kind={log.get('kind')!r}）",
              file=sys.stderr)
        return 2

    problems: list[str] = []
    stages = log.get("stages") or []
    trace = log.get("trace") or []
    messages = log.get("messages") or []

    for record in stages:
        try:
            recomputed = _sha256_canonical({k: record[k] for k in STAGE_SHA_FIELDS})
        except KeyError as exc:
            problems.append(f"{record.get('stage')} 记录缺字段 {exc}")
            continue
        if recomputed != record.get("sha256"):
            problems.append(f"{record.get('stage')} 阶段 sha256 复算不一致")
    if _sha256_canonical(trace) != log.get("trace_sha256"):
        problems.append("trace_sha256 复算不一致")
    if _sha256_canonical(_top_payload(log)) != log.get("sha256"):
        problems.append("顶层 sha256 复算不一致")

    trace_messages = [e for e in trace if e.get("kind") == "message"]
    if len(trace_messages) != len(messages):
        problems.append(
            f"消息条数不一致：trace {len(trace_messages)} / 日志 {len(messages)}")
    else:
        for tm, m in zip(trace_messages, messages):
            if {k: tm.get(k) for k in ("msg_id", "topic", "sender", "refs", "payload")} \
                    != {k: m.get(k) for k in ("msg_id", "topic", "sender", "refs", "payload")}:
                problems.append(f"消息 {m.get('msg_id')} 与 trace 不一致")

    segments = _stage_segments(trace)
    if len(segments) != len(stages):
        problems.append(f"阶段段数 {len(segments)} != 阶段记录数 {len(stages)}")
    else:
        for record, segment in zip(stages, segments):
            results = _tool_results(segment)
            missing = [cid for cid in record.get("evidence_call_ids", [])
                       if cid not in results]
            if missing:
                problems.append(
                    f"{record.get('stage')} 证据引用 {missing} 在本地段里没有对应工具结果")
            # 结论内部的证据列表也要逐条落到本阶段的工具结果上 —— 只看顶层
            # evidence_call_ids 会漏掉「结论正文被改、字段没动」的篡改。
            conclusion = record.get("conclusion") or {}
            evidence = ((conclusion.get("attribution") or {}).get("evidence")
                        or [])
            for item in evidence:
                cid = item.get("call_id")
                if cid not in results:
                    problems.append(
                        f"{record.get('stage')} 结论证据 {cid!r} "
                        "在本地段里没有对应工具结果")
            cited = [item.get("call_id") for item in evidence]
            if sorted(cited) != sorted(record.get("evidence_call_ids", [])):
                problems.append(
                    f"{record.get('stage')} 结论证据列表与 evidence_call_ids 不一致")

    bad_checks = [k for k, v in (log.get("checks") or {}).items() if not v]
    if bad_checks:
        problems.append(f"checks 未通过：{bad_checks}")

    print(f"[verify] {path}")
    for record in stages:
        print(f"  {record.get('stage'):<20} sha256 {_short(str(record.get('sha256')))}  "
              f"证据引用 {len(record.get('evidence_call_ids', []))} 条")
    if problems:
        for problem in problems:
            print(f"  FAIL {problem}")
        print(f"FAIL 日志复校发现 {len(problems)} 个问题")
        return 1
    print(f"PASS 5 个阶段、{len(messages)} 条消息、checks "
          f"{len(log.get('checks') or {})}/{len(log.get('checks') or {})} 全部有效"
          f"（顶层 sha256 {_short(str(log.get('sha256')))}）")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="M5-1 全链回放：观测数据进，工单与归档出")
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE,
                        help="基线 fixture 路径（默认 %(default)s）")
    parser.add_argument("--log-dir", type=Path, default=ROOT / "logs",
                        help="回放日志与耗时 sidecar 的目录（默认 %(default)s）")
    parser.add_argument("--bless", action="store_true",
                        help="把本次运行写入 fixture（建立或更新基线）")
    parser.add_argument("--verify-log", type=Path, metavar="PATH",
                        help="只复校一份回放日志，不重跑链路")
    args = parser.parse_args(argv)

    if args.verify_log is not None:
        return verify_log(args.verify_log)

    try:
        log = run_once(args.log_dir)
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"[m5] 回放失败：{exc}", file=sys.stderr)
        return 2
    _write_json(args.log_dir / LOG_NAME, log)

    if args.bless:
        _write_fixture(args.fixture, log)
        for record in log["stages"]:
            print(f"  {record['stage']:<20} sha256 {_short(record['sha256'])}  bless")
        print(f"  summary {log['summary']['stages']} 阶段, checks "
              f"{log['summary']['checks']}, {log['summary']['messages']} 条消息")
        print(f"[BLESS] 已写入 {args.fixture}")
        return 0

    try:
        fixture = json.loads(args.fixture.read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(f"[m5] fixture 不存在：{args.fixture}（先加 --bless 建立基线）",
              file=sys.stderr)
        return 2
    except (OSError, ValueError) as exc:
        print(f"[m5] 读不了 fixture {args.fixture}：{exc}", file=sys.stderr)
        return 2
    if fixture.get("kind") != FIXTURE_KIND:
        print(f"[m5] fixture kind 不是 {FIXTURE_KIND}：{fixture.get('kind')!r}",
              file=sys.stderr)
        return 2

    stage_ok, problems = _compare(fixture, log)
    for record in log["stages"]:
        tag = "PASS" if stage_ok.get(record["stage"]) else "FAIL"
        print(f"  {record['stage']:<20} sha256 {_short(record['sha256'])}  {tag}")
    print(f"  summary {log['summary']['stages']} 阶段, checks "
          f"{log['summary']['checks']}, {log['summary']['messages']} 条消息, "
          f"tokens {log['summary']['tokens']['prompt']}/"
          f"{log['summary']['tokens']['completion']}")
    print(f"  expected    {fixture.get('sha256')}")
    print(f"sha256: {log['sha256']}")
    if problems:
        for problem in problems:
            print(f"  FAIL {problem}")
        print("FAIL 回放与 fixture 不一致")
        return 1
    print("PASS M5 回放基线与 fixture 一致")
    return 0


if __name__ == "__main__":
    sys.exit(main())
