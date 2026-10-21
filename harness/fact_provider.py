"""事实合成器：按上游消息决定工具调用，并按工具返回的真实数字拼结论。

M5-1 的 ``FakeProvider`` 是**脚本化文案**：数据换了，文案还是旧的，结论会撒谎。
公开数据链路（``harness/public_data_chain.py``）用本模块替代模型：

* ``plan``：看上游消息里有什么，决定调哪个工具、传什么参数（确定性，不猜）；
* ``compose``：工具返回后，**用返回里的真实数字**拼结论 —— 结论里的每个数字都能
  在同一条 trace 的 ``tool_result`` 里对上。

工具与判据是真的（``slip_detect`` / ``station_health`` / ``knowledge_search`` /
工单 / 审批门 / 归档），只有「模型」这一层被替换。这不是模型能力的评测，是链路与
证据链的演示（见 ``docs/reports/2026-10-20-公开数据全流程演示与DoD核对.md``）。

三条踩过的坑（别再犯）：

1. 拼结论时 ``messages[-1]`` 是**工具返回**，上游 payload 要从**最后一条 user 消息**取；
2. 设备是否异常要看 ``status``（degraded），不能只看 ``health_score``（有质量标记时仍是 1.0）；
3. 归档产物没有 ``bytes`` 字段，别把 ``None`` 写进结论文案。
"""
from __future__ import annotations

import json
import re

_PAYLOAD_RE = re.compile(
    r"^\[(m\d+)\] topic=(\S+) sender=(\S+) refs=\[[^\]]*\] payload=(\{.*\})$")

#: 故障类型 → 面向人的说法（工单标题用；原始 fault_type 仍写进 description）
FAULT_PHRASE = {
    "phase_slip_detected": "载波相位周跳/持续阶跃",
    "no_phase_slip_detected": "未检出周跳",
    "device_quality_flag": "设备读数质量异常",
    "device_normal": "设备读数正常",
    "phase_slip_with_device_degradation": "载波相位周跳 + 设备读数异常",
    "quality_review_with_device_degradation": "质量复核 + 设备读数异常",
    "quality_review": "质量复核",
    "remediation_dispatched": "处置已派发",
    "archive_exported": "已归档",
}

#: 知识库查询词（词表来自 data/kb/knowledge.jsonl 的实测命中）
KB_QUERIES = {
    "phase_slip": "持续相位阶跃 定平链路 处理",
    "device_flag": "读数 持续 偏离 基线",
    "high_risk": "高风险 动作 审批 远程重启",
    "archive": "合成产物 归档",
}


def payloads(messages) -> list[tuple[str, str, dict]]:
    """从**最后一条 user 消息**里取出上游消息的 (msg_id, topic, payload)。"""
    user_text = ""
    for message in messages:
        if message.role == "user":
            user_text = message.content
    out = []
    for line in user_text.splitlines():
        match = _PAYLOAD_RE.match(line.strip())
        if match:
            out.append((match.group(1), match.group(2), json.loads(match.group(4))))
    return out


def tool_results(messages) -> list[tuple[str, str, dict]]:
    """从对话里取出工具返回 (工具名, call_id, 结果)。"""
    out = []
    for message in messages:
        if message.role != "tool":
            continue
        head, _, body = message.content.partition("] ")
        parts = head.strip("[]").split("][")
        name = parts[0] if parts else ""
        call_id = parts[1] if len(parts) > 1 else ""
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = {"error": body}
        out.append((name, call_id, data))
    return out


def conclusion(fault_type: str, evidence: list[dict], recommendation: str,
               confidence: float = 0.9) -> str:
    return json.dumps({
        "attribution": {"fault_type": fault_type, "evidence": evidence},
        "recommendation": recommendation,
        "confidence": confidence,
    }, ensure_ascii=False, sort_keys=True)


class FactProvider:
    """两段式：第一次给工具调用，之后用工具返回拼结论。"""

    name = "fact"

    def __init__(self, plan, compose):
        self._plan = plan
        self._compose = compose
        self._planned = False

    def chat(self, messages, tools):
        from fieldstation.agents.providers.base import ChatResponse

        if not self._planned:
            self._planned = True
            return ChatResponse(content="", tool_calls=self._plan(messages))
        return ChatResponse(content=self._compose(tool_results(messages), messages))


# ------------------------------------------------------------------ 五个阶段
def qc_plan(messages):
    observations = next((p for _, _, p in payloads(messages) if "groups" in p), {})
    return [{"name": "slip_detect", "args": group["tool_args"],
             "reason": f"质控 {group['key']}", "confidence": 0.9}
            for group in observations.get("groups", [])]


def qc_compose(results, messages):
    evidence = []
    slips = 0
    for name, call_id, data in results:
        counts = data.get("counts") or {}
        slips += int(counts.get("union", 0) or 0)
        evidence.append({
            "call_id": call_id, "tool": name,
            "finding": (f"counts={dict(counts)}，"
                        f"slip_indices={list(data.get('slip_indices') or [])}，"
                        f"n_epochs={data.get('n_epochs')}"),
        })
    fault_type = "phase_slip_detected" if slips else "no_phase_slip_detected"
    recommendation = (f"检出 {slips} 处周跳/相位阶跃，按相位滑移流程复查定平链路"
                      if slips else "本批未检出周跳/相位阶跃，可继续下游处理")
    return conclusion(fault_type, evidence, recommendation)


def device_plan(messages):
    device = next((p for _, _, p in payloads(messages) if "readings" in p), {})
    return [{"name": "station_health", "args": {"readings": device.get("readings", [])},
             "reason": "汇总台站读数健康度", "confidence": 0.9}]


def device_compose(results, messages):
    evidence = []
    status, score, missing, flags = "unknown", None, 0, []
    for name, call_id, data in results:
        summary = data.get("summary") or {}
        missing = int(summary.get("missing", 0) or 0)
        for station in data.get("stations") or []:
            status = station.get("status")
            score = station.get("health_score")
            flags = list(station.get("quality_flags") or [])
        evidence.append({
            "call_id": call_id, "tool": name,
            "finding": (f"健康度 {score}（{status}），缺测 {missing} 条，"
                        f"质量标记 {flags}"),
        })
    fault_type = "device_quality_flag" if (flags or missing) else "device_normal"
    recommendation = (f"台站读数异常（质量标记 {flags}、缺测 {missing} 条），按规程派单处置"
                      if (flags or missing) else "台站读数正常，无需派单")
    return conclusion(fault_type, evidence, recommendation)


def diagnosis_plan(messages):
    upstream = payloads(messages)
    qc = next((p for _, _, p in upstream if "conclusion" in p), {})
    device = next((p for _, _, p in upstream
                   if (p.get("artifacts") or {}).get("station_health")), {})
    qc_type = ((qc.get("conclusion") or {}).get("attribution") or {}).get("fault_type", "")
    health = (device.get("artifacts") or {}).get("station_health") or {}
    statuses = [s.get("status") for s in health.get("stations") or []]
    calls = []
    if "phase_slip" in qc_type:
        calls.append({"name": "knowledge_search",
                      "args": {"query": KB_QUERIES["phase_slip"], "limit": 2},
                      "reason": "质控检出相位阶跃，查相位处置规程", "confidence": 0.9})
    if any(status and status != "ok" for status in statuses):
        calls.append({"name": "knowledge_search",
                      "args": {"query": KB_QUERIES["device_flag"], "limit": 2},
                      "reason": "设备读数异常，查传感器偏离规程", "confidence": 0.9})
    if not calls:
        calls.append({"name": "knowledge_search",
                      "args": {"query": KB_QUERIES["phase_slip"], "limit": 2},
                      "reason": "无明确异常，按基线规程复核", "confidence": 0.9})
    return calls


def diagnosis_compose(results, messages):
    evidence = []
    doc_ids = []
    for name, call_id, data in results:
        hits = data.get("results") or []
        doc_ids.extend(hit.get("doc_id") for hit in hits)
        finding = (f"命中规程 {doc_ids[-len(hits):]}："
                   + "；".join(hit.get("title", "") for hit in hits)
                   if hits else "知识库无命中")
        evidence.append({"call_id": call_id, "tool": name, "finding": finding})
    upstream = payloads(messages)
    qc = next((p for _, _, p in upstream if "conclusion" in p), {})
    device = next((p for _, _, p in upstream
                   if (p.get("artifacts") or {}).get("station_health")), {})
    qc_type = ((qc.get("conclusion") or {}).get("attribution") or {}).get("fault_type", "")
    health = (device.get("artifacts") or {}).get("station_health") or {}
    stations = health.get("stations") or []
    score = next((s.get("health_score") for s in stations), None)
    status = next((s.get("status") for s in stations), None)
    fault_type = "phase_slip" if "phase_slip" in qc_type else "quality_review"
    if status and status != "ok":
        fault_type += "_with_device_degradation"
    return conclusion(fault_type, evidence,
                      f"按命中规程处置：质控 {qc_type}，设备健康度 {score}（{status}）")


def dispatch_plan(messages, station: str = "BADG"):
    diagnosis = next((p for _, _, p in payloads(messages) if "conclusion" in p), {})
    conclusion_obj = diagnosis.get("conclusion") or {}
    attribution = conclusion_obj.get("attribution") or {}
    fault_type = attribution.get("fault_type", "")
    evidence_ids = list(diagnosis.get("evidence_call_ids") or [])
    description = (f"研判 {fault_type}；证据 {evidence_ids}；"
                   f"建议 {conclusion_obj.get('recommendation', '')}")
    phrase = FAULT_PHRASE.get(fault_type, fault_type)
    return [
        {"name": "create_work_order", "args": {
            "station_id": station,
            "title": f"{station} {phrase} 处置",
            "priority": "P1",
            "risk": "medium",
            "description": description,
            "action": "restart_receiver",
            "evidence_call_ids": evidence_ids},
         "reason": "按研判结论建单", "confidence": 0.9},
        {"name": "knowledge_search",
         "args": {"query": KB_QUERIES["high_risk"], "limit": 2},
         "reason": "高风险动作需按审批规程执行", "confidence": 0.9},
        {"name": "execute_device_action", "args": {
            "station_id": station, "action": "restart_receiver",
            "reason": description, "confidence": 0.9},
         "reason": "重启接收机并复查定平链路", "confidence": 0.9},
    ]


def dispatch_compose(results, messages):
    evidence = []
    order = action = None
    docs = []
    for name, call_id, data in results:
        if name == "create_work_order":
            order = data
            evidence.append({
                "call_id": call_id, "tool": name,
                "finding": (f"工单 {data.get('order_id')} 已建：{data.get('title')}"
                            f"（{data.get('priority')}）")})
        elif name == "execute_device_action":
            action = data
            evidence.append({
                "call_id": call_id, "tool": name,
                "finding": (f"动作 {data.get('action')} 状态 {data.get('status')}"
                            f"（{data.get('execution_mode')}）")})
        else:
            hits = data.get("results") or []
            docs.extend(hit.get("doc_id") for hit in hits)
            evidence.append({"call_id": call_id, "tool": name,
                             "finding": f"命中规程 {docs}"})
    return conclusion(
        "remediation_dispatched", evidence,
        (f"已建工单 {order.get('order_id') if order else '?'}，"
         f"动作 {action.get('action') if action else '?'} 已提交（需人工审批）"))


def archive_plan(messages, *, relative_path: str = "pipeline/m5_public/chain_summary.json"):
    dispatch = next((p for _, _, p in payloads(messages) if "artifacts" in p), {})
    order = (dispatch.get("artifacts") or {}).get("work_order") or {}
    return [
        {"name": "archive_export", "args": {
            "relative_path": relative_path,
            "payload": {
                "order": {"order_id": order.get("order_id"),
                          "priority": order.get("priority"),
                          "status": order.get("status")},
                "source": "public data chain",
            },
            "synthetic": True},
         "reason": "把本次全链摘要归档", "confidence": 0.9},
        {"name": "knowledge_search",
         "args": {"query": KB_QUERIES["archive"], "limit": 2},
         "reason": "核对归档隔离规程", "confidence": 0.9},
    ]


def archive_compose(results, messages):
    evidence = []
    written = None
    for name, call_id, data in results:
        if name == "archive_export":
            written = data
            size = f"，{data.get('bytes')} B" if data.get("bytes") else ""
            evidence.append({
                "call_id": call_id, "tool": name,
                "finding": (f"已写入 {data.get('path')}（sha256 {data.get('sha256')}"
                            f"{size}，synthetic={data.get('synthetic')}）")})
        else:
            hits = data.get("results") or []
            evidence.append({
                "call_id": call_id, "tool": name,
                "finding": f"命中规程 {[h.get('doc_id') for h in hits]}"})
    return conclusion(
        "archive_exported", evidence,
        f"全链摘要已归档到 {written.get('path') if written else '?'}")


#: 阶段名 → (plan, compose)；dispatch/archive 的 plan 需要额外参数时在链路里包一层
STAGE_PLANS = {
    "qc": (qc_plan, qc_compose),
    "device_monitor": (device_plan, device_compose),
    "fault_diagnosis": (diagnosis_plan, diagnosis_compose),
    "operations_dispatch": (dispatch_plan, dispatch_compose),
    "archive": (archive_plan, archive_compose),
}
