"""人工审批门：高风险动作必须有人批过才执行。

spec §2 与 README 的「规则裁决，模型归因」是同一条约束的两面：**模型只负责归因，
不确定性规则负责裁决，而高风险动作必须留人工审批门**。一次错误的停机建议可能
造成不可逆的数据损失，所以「不动作」必须始终是可选项。

本模块是那条约束的落地。三层结构，每层都能单独换：

* ``ApprovalRequest`` —— 要批什么（agent、动作、理由、置信度、风险级）
* ``Approver`` —— 谁来批。现在是脚本化的 ``ApproveAll`` / ``RejectAll``，
  M3 之后换成真实的人机界面，**本文件不需要改**
* ``ApprovalGate`` —— 什么情况下需要批（风险级命中，或置信度低于阈值）

设计取舍：

* **没有审批者时不给默认放行。** ``ApprovalGate`` 必须显式拿到一个 approver；
  没配 approver 就不接审批请求，宁可让调用方在启动时就失败。默认放行等于
  把安全约束交给人有没有记得配。
* **审批记录不含时间戳或随机量。** 它要进 trace，而 trace 的同输入两跑
  逐字节相同是回放式评测的地基。时间戳放 ``store.product.env_fingerprint()``
  那类旁路产物里。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

#: 默认必须人工审批的风险级
DEFAULT_RISK_LEVELS = ("high",)

#: 默认置信度阈值：低于它就算模型自己没把握，要人看一眼
DEFAULT_CONFIDENCE_THRESHOLD = 0.9

#: 允许的风险级取值。写死的白名单，拼错一个字母就等于静默关掉审批。
RISK_LEVELS = ("low", "medium", "high")


@dataclass
class ApprovalRequest:
    """一次待批的动作。``confidence`` 取 0-1，模型没给就默认 1.0。"""

    agent: str
    action: str
    reason: str
    confidence: float = 1.0
    risk: str = "low"


@dataclass
class ApprovalRecord:
    """审批结论。字段刻意铺平而不是嵌一个 request 对象 —— 要直接进 trace，
    嵌套结构会让 JSON 化与比对都变麻烦。"""

    verdict: str          # approved / rejected / pending
    agent: str
    action: str
    reason: str
    confidence: float
    risk: str
    by: str


@runtime_checkable
class Approver(Protocol):
    def decide(self, request: ApprovalRequest) -> ApprovalRecord:
        ...


class ApproveAll:
    by = "approve_all"

    def decide(self, request: ApprovalRequest) -> ApprovalRecord:
        return self._record(request, "approved")

    @staticmethod
    def _record(request: ApprovalRequest, verdict: str) -> ApprovalRecord:
        return ApprovalRecord(
            verdict=verdict, agent=request.agent, action=request.action,
            reason=request.reason, confidence=request.confidence,
            risk=request.risk, by="approve_all")


class RejectAll:
    by = "reject_all"

    def decide(self, request: ApprovalRequest) -> ApprovalRecord:
        return ApprovalRecord(
            verdict="rejected", agent=request.agent, action=request.action,
            reason=request.reason, confidence=request.confidence,
            risk=request.risk, by="reject_all")


class ApprovalGate:
    """决定「这个动作要不要人批」，并拿到结论。

    ``needs_approval`` 为假时 ``decide`` 直接返回 ``approved`` 且 ``by="auto"``
    —— 不给低风险动作增加打扰，一次纯统计查询不该走一遍审批。
    """

    def __init__(
        self,
        approver: Approver,
        confidence_threshold: float = DEFAULT_CONFIDENCE_THRESHOLD,
        risk_needing_approval: tuple[str, ...] = DEFAULT_RISK_LEVELS,
    ) -> None:
        bad = [r for r in risk_needing_approval if r not in RISK_LEVELS]
        if bad:
            raise ValueError(f"未知风险级：{bad}（只认 {RISK_LEVELS}）")
        self.approver = approver
        self.confidence_threshold = confidence_threshold
        self.risk_needing_approval = tuple(risk_needing_approval)

    def needs_approval(self, request: ApprovalRequest) -> bool:
        if request.risk in self.risk_needing_approval:
            return True
        return request.confidence < self.confidence_threshold

    def decide(self, request: ApprovalRequest) -> ApprovalRecord:
        if not self.needs_approval(request):
            return ApprovalRecord(
                verdict="approved", agent=request.agent, action=request.action,
                reason=request.reason, confidence=request.confidence,
                risk=request.risk, by="auto")
        return self.approver.decide(request)