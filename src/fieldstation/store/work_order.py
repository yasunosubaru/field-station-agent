"""工单模型与确定性状态机（M4-3）。"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

from ..agents.approval import ApprovalGate, ApprovalRecord, ApprovalRequest

PRIORITIES = ("P0", "P1", "P2")
RISKS = ("low", "medium", "high")
STATUSES = (
    "open", "pending_approval", "approved", "rejected",
    "scheduled", "in_progress", "done", "cancelled",
)
TRANSITIONS = {
    "open": {"pending_approval", "scheduled", "cancelled"},
    "pending_approval": {"approved", "rejected"},
    "approved": {"scheduled", "cancelled"},
    "rejected": set(),
    "scheduled": {"in_progress", "cancelled"},
    "in_progress": {"done", "cancelled"},
    "done": set(),
    "cancelled": set(),
}


@dataclass
class WorkOrder:
    order_id: str
    station_id: str
    title: str
    priority: str
    risk: str
    status: str
    description: str = ""
    action: str = ""
    evidence_call_ids: list[str] = field(default_factory=list)
    assigned_to: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


class WorkOrderService:
    """内存工单服务；编号按创建顺序生成，便于回放。"""

    def __init__(self):
        self._orders: dict[str, WorkOrder] = {}
        self._next = 1
        self.approval_log: list[ApprovalRecord] = []

    def create(
        self,
        *,
        station_id: str,
        title: str,
        priority: str,
        risk: str = "medium",
        description: str = "",
        action: str = "",
        evidence_call_ids: list[str] | None = None,
    ) -> WorkOrder:
        if not isinstance(station_id, str) or not station_id.strip():
            raise ValueError("station_id 必须是非空字符串")
        if not isinstance(title, str) or not title.strip():
            raise ValueError("title 必须是非空字符串")
        if priority not in PRIORITIES:
            raise ValueError(f"priority 必须是 {PRIORITIES}")
        if risk not in RISKS:
            raise ValueError(f"risk 必须是 {RISKS}")
        evidence = evidence_call_ids or []
        if (not isinstance(evidence, list)
                or any(not isinstance(x, str) or not x.strip() for x in evidence)):
            raise ValueError("evidence_call_ids 必须是非空字符串数组")
        order_id = f"WO-{self._next:04d}"
        self._next += 1
        order = WorkOrder(
            order_id=order_id,
            station_id=station_id.strip(),
            title=title.strip(),
            priority=priority,
            risk=risk,
            status="open",
            description=description.strip(),
            action=action.strip(),
            evidence_call_ids=list(evidence),
        )
        self._orders[order_id] = order
        return order

    def get(self, order_id: str) -> WorkOrder:
        try:
            return self._orders[order_id]
        except KeyError as exc:
            raise KeyError(f"工单不存在：{order_id!r}") from exc

    def transition(self, order_id: str, new_status: str) -> WorkOrder:
        if new_status not in STATUSES:
            raise ValueError(f"未知工单状态：{new_status!r}")
        order = self.get(order_id)
        if new_status not in TRANSITIONS[order.status]:
            raise ValueError(
                f"非法状态转换：{order.status} -> {new_status}（{order_id}）")
        order.status = new_status
        return order

    def decide(
        self,
        order_id: str,
        *,
        gate: ApprovalGate | None,
        confidence: float = 1.0,
    ) -> ApprovalRecord:
        order = self.get(order_id)
        if gate is None:
            raise ValueError("工单审批必须显式提供 ApprovalGate")
        if order.status == "open":
            self.transition(order_id, "pending_approval")
        request = ApprovalRequest(
            agent="operations_dispatch",
            action=order.action or order.title,
            reason=order.description or order.title,
            confidence=confidence,
            risk=order.risk,
        )
        record = gate.decide(request)
        self.transition(
            order_id, "approved" if record.verdict == "approved" else "rejected")
        self.approval_log.append(record)
        return record
