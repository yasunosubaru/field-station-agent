"""结构化归因结论与证据引用校验（M3-2，issue #52）。

契约只接受单个 JSON object。每条证据必须引用一条**成功执行过的工具调用**；
只写“有依据”但没有可核对的 ``call_id``，一律判无效。

本模块不调用模型，也不实现归因判据；它只做机械校验。
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass


TOP_LEVEL_FIELDS = ("attribution", "recommendation", "confidence")
ATTRIBUTION_FIELDS = ("fault_type", "evidence")
EVIDENCE_FIELDS = ("call_id", "tool", "finding")


@dataclass(frozen=True)
class ConclusionValidation:
    """一次结论校验的结果。``errors`` 为空才表示有效。"""

    valid: bool
    errors: tuple[str, ...]
    conclusion: dict | None
    evidence_call_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class ConclusionContract:
    """结论契约的版本化参数。

    当前只有置信度范围与“是否要求证据”两个可调项。契约字段本身改动必须走
    ADR，不能在这里静默放宽。
    """

    confidence_min: float = 0.0
    confidence_max: float = 1.0
    require_evidence: bool = True

    def validate(self, text_or_obj, trace_events: list[dict]) -> ConclusionValidation:
        return validate_conclusion(text_or_obj, trace_events, contract=self)


class ConclusionRejected(RuntimeError):
    """运行时拒绝把无效结论作为有效结果返回。"""

    def __init__(self, errors: tuple[str, ...], conclusion: dict | None = None):
        self.errors = errors
        self.conclusion = conclusion
        super().__init__("结论不符合契约：" + "；".join(errors))


def _nonempty_string(value) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _parse(text_or_obj) -> tuple[dict | None, tuple[str, ...]]:
    if isinstance(text_or_obj, dict):
        return text_or_obj, ()
    if not isinstance(text_or_obj, str):
        return None, ("结论必须是 JSON object 或 JSON 字符串",)
    text = text_or_obj.strip()
    if not text:
        return None, ("结论为空",)
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        return None, (f"结论不是合法 JSON：{exc.msg}",)
    if not isinstance(value, dict):
        return None, ("结论顶层必须是 JSON object",)
    return value, ()


def _successful_calls(trace_events: list[dict]) -> dict[str, dict]:
    calls: dict[str, dict] = {}
    for event in trace_events:
        if event.get("kind") != "tool_result" or not event.get("ok"):
            continue
        call_id = event.get("call_id")
        if isinstance(call_id, str) and call_id:
            calls[call_id] = event
    return calls


def validate_conclusion(
    text_or_obj,
    trace_events: list[dict],
    *,
    contract: ConclusionContract | None = None,
) -> ConclusionValidation:
    """校验结论字段、置信度与工具证据引用。"""
    contract = contract or ConclusionContract()
    data, errors = _parse(text_or_obj)
    if data is None:
        return ConclusionValidation(False, errors, None)
    errors = list(errors)

    if set(data) != set(TOP_LEVEL_FIELDS):
        errors.append(
            "顶层字段必须且只能是 " + ", ".join(TOP_LEVEL_FIELDS) +
            f"；实际为 {sorted(data)}")

    attribution = data.get("attribution")
    if not isinstance(attribution, dict):
        errors.append("attribution 必须是 object")
        attribution = {}
    elif set(attribution) != set(ATTRIBUTION_FIELDS):
        errors.append(
            "attribution 字段必须且只能是 fault_type, evidence；"
            f"实际为 {sorted(attribution)}")

    fault_type = attribution.get("fault_type")
    if not _nonempty_string(fault_type):
        errors.append("attribution.fault_type 必须是非空字符串")

    recommendation = data.get("recommendation")
    if not _nonempty_string(recommendation):
        errors.append("recommendation 必须是非空字符串")

    confidence = data.get("confidence")
    if (isinstance(confidence, bool)
            or not isinstance(confidence, (int, float))
            or not math.isfinite(float(confidence))):
        errors.append("confidence 必须是有限数值")
    elif not (contract.confidence_min <= float(confidence)
              <= contract.confidence_max):
        errors.append(
            f"confidence 必须在 [{contract.confidence_min}, "
            f"{contract.confidence_max}] 内")

    evidence = attribution.get("evidence")
    if not isinstance(evidence, list):
        errors.append("attribution.evidence 必须是数组")
        evidence = []
    if contract.require_evidence and not evidence:
        errors.append("attribution.evidence 至少需要一条工具证据")

    successful = _successful_calls(trace_events)
    seen: set[str] = set()
    evidence_ids: list[str] = []
    for index, item in enumerate(evidence):
        prefix = f"evidence[{index}]"
        if not isinstance(item, dict):
            errors.append(f"{prefix} 必须是 object")
            continue
        if set(item) != set(EVIDENCE_FIELDS):
            errors.append(
                f"{prefix} 字段必须且只能是 call_id, tool, finding；"
                f"实际为 {sorted(item)}")
            continue
        for key in EVIDENCE_FIELDS:
            if not _nonempty_string(item.get(key)):
                errors.append(f"{prefix}.{key} 必须是非空字符串")
        call_id = item.get("call_id")
        tool = item.get("tool")
        if not _nonempty_string(call_id) or not _nonempty_string(tool):
            continue
        if call_id in seen:
            errors.append(f"{prefix}.call_id 重复引用 {call_id!r}")
            continue
        seen.add(call_id)
        event = successful.get(call_id)
        if event is None:
            errors.append(
                f"{prefix}.call_id {call_id!r} 不存在于成功的工具调用中")
            continue
        if event.get("tool") != tool:
            errors.append(
                f"{prefix}.tool {tool!r} 与调用 {call_id!r} 的工具名 "
                f"{event.get('tool')!r} 不一致")
            continue
        evidence_ids.append(call_id)

    return ConclusionValidation(
        valid=not errors,
        errors=tuple(errors),
        conclusion=data if not errors else None,
        evidence_call_ids=tuple(evidence_ids),
    )
