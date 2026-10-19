"""工单与设备动作工具包装（M4-3）。"""
from __future__ import annotations

from ...store.work_order import WorkOrderService
from . import ToolResult


class CreateWorkOrderTool:
    name = "create_work_order"
    description = "创建运维工单；低风险，仅记录台站、优先级、证据和建议动作。"
    params = {
        "station_id": {"type": "string", "required": True},
        "title": {"type": "string", "required": True},
        "priority": {"type": "string", "required": True},
        "risk": {"type": "string", "required": False},
        "description": {"type": "string", "required": False},
        "action": {"type": "string", "required": False},
        "evidence_call_ids": {
            "type": "array", "items": "string", "required": False,
        },
    }
    risk = "low"

    def __init__(self, service: WorkOrderService):
        self.service = service

    def invoke(self, args: dict) -> ToolResult:
        try:
            order = self.service.create(
                station_id=args.get("station_id"),
                title=args.get("title"),
                priority=args.get("priority"),
                risk=args.get("risk", "medium"),
                description=args.get("description", ""),
                action=args.get("action", ""),
                evidence_call_ids=args.get("evidence_call_ids", []),
            )
        except (TypeError, ValueError) as exc:
            return ToolResult(ok=False, error=str(exc))
        return ToolResult(ok=True, data=order.to_dict())


class ExecuteDeviceActionTool:
    """高风险动作入口。

    当前阶段返回可审计的授权命令包，不直接连接真实设备；真实 SCM/SSH 执行器
    必须在同一审批门之后接入。工具风险级固定为 ``high``，runtime 会强制审批。
    """

    name = "execute_device_action"
    description = (
        "提交高风险设备动作（重启、断电、配置下发、固件升级等）。"
        "必须通过人工审批；当前返回授权命令包，不直接操作硬件。")
    params = {
        "station_id": {"type": "string", "required": True},
        "action": {"type": "string", "required": True},
        "reason": {"type": "string", "required": True},
        "confidence": {"type": "number", "required": False},
    }
    risk = "high"

    def invoke(self, args: dict) -> ToolResult:
        station = args.get("station_id")
        action = args.get("action")
        reason = args.get("reason")
        confidence = args.get("confidence", 1.0)
        for key, value in (("station_id", station), ("action", action),
                           ("reason", reason)):
            if not isinstance(value, str) or not value.strip():
                return ToolResult(ok=False, error=f"参数 {key} 必须是非空字符串")
        if (isinstance(confidence, bool)
                or not isinstance(confidence, (int, float))
                or not (0.0 <= float(confidence) <= 1.0)):
            return ToolResult(ok=False, error="参数 confidence 必须在 [0,1] 内")
        return ToolResult(ok=True, data={
            "status": "accepted",
            "execution_mode": "simulated",
            "station_id": station.strip(),
            "action": action.strip(),
            "reason": reason.strip(),
            "confidence": float(confidence),
        })
