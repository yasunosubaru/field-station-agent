"""纪-2 规则裁决：CN0 下限、缺测率上限、相位跳变门限。

裁决与「模型说数据不好」的区别在于**可回源**：每条裁决都带规则编号，
编号能在人工手册 ``docs/operations/qc-rules.md`` 的对应小节里查到原文。
阈值只有一套来源：

* ``R-4.2`` 的 30 dB-Hz 与 ``R-4.4`` 的 0.5 TECU 直接取 :class:`QCConfig`
  的默认值（与 ``rules/qc.py`` 的 ``cn0_min_dbhz`` / ``slip_min_jump_tecU``
  是同一个数，不另造一套）；
* ``R-4.3`` 的 5% 与 ``agents/tools/station_tools.py`` 的健康度口径一致
  （``health_score < 0.95`` 即缺测率超过 5%）。

边界值一律**通过**：CN0 ``>= 30``、缺测率 ``<= 5%``、跳变 ``<= 0.5 TECU``。
其中跳变判据与 ``qc.py`` 相同，用严格 ``>``。

## 依据为什么落在手册而不是知识库

``data/kb/knowledge.jsonl`` 是 ``knowledge_search`` 的数据源，而
``knowledge_search`` 的工具结果被钉进 M5 的 6 份已提交回放基线
（``logs/m5_pipeline_replay.json``、``logs/public_data_chain_*.json`` 等）。
往里加条目会让那些基线的 sha 全变，等于用「加两条规程」换「重写十来个
派生产物」——代价与收益不成比例。规程原文本来就是人读的东西，
因此权威来源取 ``docs/operations/qc-rules.md``，知识库保持原样。

本模块只用标准库，也不 import ``agents.knowledge``：:func:`lookup_rule`
接收手册正文（字符串），保持纯函数，便于在服务、CLI 与测试里复用同一份规则。
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

from .qc import QCConfig

RULE_NOT_FOUND = "E_RULE_NOT_FOUND"

#: 规程原文所在文件（相对仓库根）。:func:`load_manual` 用这个默认值。
MANUAL_REL_PATH = "docs/operations/qc-rules.md"

_DEFAULT_QC = QCConfig()

#: R-4.3 的缺测率上限。与 ``station_tools.py`` 的 ``score < 0.95`` 等价：
#: 缺测率恰好 5% 仍算合格，超过 5% 才判 degraded。
MISSING_RATE_MAX = 0.05


@dataclass(frozen=True)
class RuleSpec:
    """一条可回源的阈值规则。

    ``doc_id`` 是依据文档的稳定标识（手册文件名去掉扩展名），``section`` 是
    该文档里的小节号。两者合起来才唯一确定一条原文：``qc-rules`` §4.2。
    """

    rule_id: str
    doc_id: str
    section: str
    threshold: float
    unit: str
    title: str


#: 规则编号 -> 规则定义。``doc_id`` + ``section`` 必须能在手册里定位到原文行。
RULES = {
    "R-4.2": RuleSpec(
        rule_id="R-4.2",
        doc_id="qc-rules",
        section="4.2",
        threshold=float(_DEFAULT_QC.cn0_min_dbhz),
        unit="dB-Hz",
        title="CN0 下限",
    ),
    "R-4.3": RuleSpec(
        rule_id="R-4.3",
        doc_id="qc-rules",
        section="4.3",
        threshold=MISSING_RATE_MAX,
        unit="ratio",
        title="缺测率上限",
    ),
    "R-4.4": RuleSpec(
        rule_id="R-4.4",
        doc_id="qc-rules",
        section="4.4",
        threshold=float(_DEFAULT_QC.slip_min_jump_tecU),
        unit="TECU",
        title="跳变门限",
    ),
}

_VERDICTS = ("ok", "fail", "not_applicable")


class RuleNotFound(LookupError):
    """规则编号在规则表或手册正文里查不到。"""

    code = RULE_NOT_FOUND

    def __init__(self, rule_id):
        self.rule_id = rule_id
        super().__init__(
            f"规则编号 {rule_id!r} 在规程中查不到（{RULE_NOT_FOUND}）")


def load_manual(path=None) -> str:
    """读入手册正文。``path`` 缺省时按 :data:`MANUAL_REL_PATH` 从仓库根解析。"""
    from pathlib import Path

    if path is None:
        repo_root = Path(__file__).resolve().parents[3]
        path = repo_root / MANUAL_REL_PATH
    return Path(path).read_text(encoding="utf-8")


def _reading(value, field: str):
    """把一条读数归一成 float；``None`` / NaN 视为缺测，其余非法值抛错。

    ``bool`` 是 ``int`` 的子类，必须单独拦；字符串不能静默转成数字；
    ±inf 不是有效读数（物理量不可能无限大），也一并拒绝。
    """
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} 读数必须是数值或 None，收到 {value!r}")
    number = float(value)
    if math.isnan(number):
        return None
    if not math.isfinite(number):
        raise ValueError(f"{field} 读数必须是有限值，收到 {value!r}")
    return number


def _verdict(spec: RuleSpec, verdict: str, value, reason: str, **extra) -> dict:
    out = {
        "verdict": verdict,
        "rule_id": spec.rule_id,
        "doc_id": spec.doc_id,
        "section": spec.section,
        "threshold": spec.threshold,
        "unit": spec.unit,
        "value": value,
        "reason": reason,
    }
    out.update(extra)
    return out


def cn0_verdict(values) -> dict:
    """按 R-4.2 裁决一组 CN0 读数（dB-Hz）。

    缺测（``None`` / NaN）只计数、不参与判定；没有任何有效读数时
    裁决为 ``not_applicable``，不能用「没数据」冒充「数据合格」。
    """
    spec = RULES["R-4.2"]
    readings = [_reading(v, "CN0") for v in values]
    valid = [v for v in readings if v is not None]
    stats = {
        "min": min(valid) if valid else None,
        "max": max(valid) if valid else None,
        "count": len(valid),
        "missing": len(readings) - len(valid),
    }
    if not valid:
        return _verdict(
            spec, "not_applicable", None,
            f"{spec.rule_id}：无有效 CN0 读数，无法裁决", cn0_stats=stats)
    lowest = stats["min"]
    if lowest < spec.threshold:
        return _verdict(
            spec, "fail", lowest,
            f"{spec.rule_id}：最低 CN0 {lowest:.1f} dB-Hz 低于手册 §{spec.section} "
            f"下限 {spec.threshold:g} dB-Hz",
            cn0_stats=stats)
    return _verdict(
        spec, "ok", lowest,
        f"{spec.rule_id}：最低 CN0 {lowest:.1f} dB-Hz 不低于手册 §{spec.section} "
        f"下限 {spec.threshold:g} dB-Hz",
        cn0_stats=stats)


def _count(value, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{field} 必须是非负整数，收到 {value!r}")
    if value < 0:
        raise ValueError(f"{field} 必须是非负整数，收到 {value!r}")
    return value


def missing_rate_verdict(total, missing) -> dict:
    """按 R-4.3 裁决缺测率（缺测数 / 总数）。

    总数为 0 时没有可裁决的样本，返回 ``not_applicable``。
    """
    spec = RULES["R-4.3"]
    total_n = _count(total, "total")
    missing_n = _count(missing, "missing")
    if missing_n > total_n:
        raise ValueError(
            f"missing({missing_n}) 不能大于 total({total_n})，缺测率无意义")
    if total_n == 0:
        return _verdict(
            spec, "not_applicable", None,
            f"{spec.rule_id}：样本总数为 0，无法裁决",
            counts={"total": total_n, "missing": missing_n})
    rate = missing_n / total_n
    counts = {"total": total_n, "missing": missing_n}
    limit = f"{spec.threshold * 100:g}%"
    if rate > spec.threshold:
        return _verdict(
            spec, "fail", rate,
            f"{spec.rule_id}：缺测率 {rate * 100:.1f}% 超过手册 §{spec.section} "
            f"上限 {limit}（{missing_n}/{total_n}）",
            counts=counts)
    return _verdict(
        spec, "ok", rate,
        f"{spec.rule_id}：缺测率 {rate * 100:.1f}% 不超过手册 §{spec.section} "
        f"上限 {limit}（{missing_n}/{total_n}）",
        counts=counts)


def jump_verdict(values) -> dict:
    """按 R-4.4 裁决相邻历元的相位跳变（TECU）。

    只有**相邻且都有效**的两点才构成一对；缺测会打断配对，不跨缺测比较。
    判据与 ``qc.py`` 一致：``|后 - 前| > 0.5`` 才计一次跳变。
    """
    spec = RULES["R-4.4"]
    readings = [_reading(v, "跳变") for v in values]
    pairs = 0
    jumps = 0
    max_jump = None
    for previous, current in zip(readings, readings[1:]):
        if previous is None or current is None:
            continue
        pairs += 1
        size = abs(current - previous)
        if max_jump is None or size > max_jump:
            max_jump = size
        if size > spec.threshold:
            jumps += 1
    stats = {"n_pairs": pairs, "n_jumps": jumps, "max_jump": max_jump}
    if pairs == 0:
        return _verdict(
            spec, "not_applicable", None,
            f"{spec.rule_id}：没有相邻有效读数，无法裁决", **stats)
    if jumps:
        return _verdict(
            spec, "fail", max_jump,
            f"{spec.rule_id}：{jumps} 对相邻历元跳变超过手册 §{spec.section} "
            f"门限 {spec.threshold:g} TECU（最大 {max_jump:.4g} TECU）",
            **stats)
    return _verdict(
        spec, "ok", max_jump,
        f"{spec.rule_id}：最大跳变 {max_jump:.4g} TECU 不超过手册 §{spec.section} "
        f"门限 {spec.threshold:g} TECU",
        **stats)


def _manual_section(text: str, rule_id: str) -> str | None:
    """从手册正文里取 ``> R-4.x：…`` 那一行，返回去掉引用符后的原文。"""
    pattern = re.compile(rf"(?m)^>\s*{re.escape(rule_id)}[：:]\s*(.+?)\s*$")
    hit = pattern.search(text)
    return hit.group(1).strip() if hit else None


def lookup_rule(rule_id, manual_text) -> dict:
    """按规则编号查手册原文，返回 ``{rule_id, text, source, section}``。

    手册里没有对应小节、或该小节里没有 ``> R-4.x：…`` 原文行，一律抛
    :class:`RuleNotFound`（错误码 ``E_RULE_NOT_FOUND``）—— 编号是编的，
    就必须在这里失败，不能返回一条「看起来像依据」的文本。
    """
    if not isinstance(rule_id, str) or rule_id not in RULES:
        raise RuleNotFound(rule_id)
    if not isinstance(manual_text, str) or not manual_text.strip():
        raise RuleNotFound(rule_id)
    spec = RULES[rule_id]
    if f"§{spec.section}" not in manual_text:
        raise RuleNotFound(rule_id)
    text = _manual_section(manual_text, rule_id)
    if not text:
        raise RuleNotFound(rule_id)
    return {
        "rule_id": rule_id,
        "doc_id": spec.doc_id,
        "text": text,
        "source": f"{MANUAL_REL_PATH} §{spec.section}",
        "section": spec.section,
    }


def failed_rule_ids(verdicts) -> list[str]:
    """收集所有判 ``fail`` 的规则编号（去重、排序）。"""
    ids: set[str] = set()
    for item in verdicts:
        if not isinstance(item, dict):
            raise ValueError(f"裁决结果必须是 dict，收到 {type(item).__name__}")
        verdict = item.get("verdict")
        if verdict not in _VERDICTS:
            raise ValueError(f"未知裁决 {verdict!r}，只能是 {_VERDICTS}")
        rule_id = item.get("rule_id")
        if rule_id not in RULES:
            raise ValueError(f"裁决带了未登记的规则编号 {rule_id!r}")
        if verdict == "fail":
            ids.add(rule_id)
    return sorted(ids)


def rule_attribution(verdicts, evidence) -> dict:
    """把失败裁决拼成结论契约里的 ``attribution``。

    结论契约（``agents/conclusion.py``）的 ``attribution`` 只允许
    ``fault_type`` / ``evidence`` 两个字段，因此失败规则编号按升序用逗号
    拼进 ``fault_type``（例如 ``"R-4.2,R-4.4"``），不回源信息不丢：
    拿这个字符串里的任一编号都能走 :func:`lookup_rule` 查到原文。

    没有失败裁决或证据为空都抛 ``ValueError`` —— 不能凭空造归因。
    """
    ids = failed_rule_ids(verdicts)
    if not ids:
        raise ValueError("没有失败的裁决，不能生成归因")
    if not isinstance(evidence, list) or not evidence:
        raise ValueError("归因至少需要一条工具证据")
    return {"fault_type": ",".join(ids), "evidence": list(evidence)}
