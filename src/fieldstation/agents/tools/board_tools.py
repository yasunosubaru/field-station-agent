"""黑板工具：给 agent 的受控入口（spec §4「上下文管理」的 agent 侧）。

黑板本体在 ``agents/blackboard.py``；本模块只把一个 ``BoardView`` 包成两个工具：

* ``board_read``  —— 读一个键（含版本与写入者）；
* ``board_write`` —— 写一个键：``must_not_exist=true`` 是 create、
  ``expect_version=n`` 是 CAS update、两者都不给是无条件 upsert（显式覆盖）。

约定沿用 ``tools/__init__.py`` 的三条：失败返回 ``ToolResult(ok=False)`` 而不是抛；
越权（``BoardPermissionError``）、冲突（``BoardConflict``）与参数不合法都翻成失败
结果 —— 冲突错误里带当前实际值，读一眼就能重试。``by`` 自动填视图的 ``actor``。

写是 low 风险：黑板是上下文，不是设备动作；高风险动作走审批门那条路
（``ApprovalGate`` + ``execute_device_action``）。权限与范围由视图决定：
**阶段没声明的方向，工具调不通**（见 ``pipeline.Pipeline`` 的注入逻辑）。
"""
from __future__ import annotations

from ..blackboard import BoardConflict, BoardPermissionError, BoardView
from . import ToolResult

_KEY_DESC = "黑板键，形如 station/BADG、station/BADG/health、alert/A-0001、order/WO-0001"

#: 黑板工具的名字。``Pipeline`` 用它做装配检查：阶段注册表里预置这些名字直接报错。
BOARD_TOOL_NAMES = ("board_read", "board_write")


class BoardReadTool:
    """读共享黑板的一个上下文条目（受视图范围约束）。"""

    name = "board_read"
    description = (
        "读共享黑板上的一个上下文条目（台站/告警/工单）。返回 value、version 与"
        "写入者；键不存在时 found=false（不是错误）。超出本阶段范围会失败。")
    params = {"key": {"type": "string", "required": True, "description": _KEY_DESC}}
    risk = "low"

    def __init__(self, view: BoardView) -> None:
        self._view = view

    def invoke(self, args: dict) -> ToolResult:
        key = args.get("key")
        try:
            entry = self._view.read(key)
        except BoardPermissionError as exc:
            return ToolResult(ok=False, error=str(exc))
        except ValueError as exc:
            return ToolResult(ok=False, error=f"键不合法：{exc}")
        if entry is None:
            return ToolResult(ok=True, data={"found": False, "key": key})
        return ToolResult(ok=True, data={"found": True, **entry.to_dict()})


class BoardWriteTool:
    """写共享黑板的一个上下文条目（受视图范围约束）。"""

    name = "board_write"
    description = (
        "写共享黑板上的一个上下文条目（整值替换，不就地修改）。"
        "must_not_exist=true 用于新建（键已存在则失败）；expect_version=n 用于"
        "按版本更新（不符则失败，错误里带当前版本，重读后可重试）；"
        "两者都不给是无条件覆盖。超出本阶段范围会失败。")
    params = {
        "key": {"type": "string", "required": True, "description": _KEY_DESC},
        "value": {"type": "object", "required": True,
                  "description": "要写入的 dict（整值替换）"},
        "must_not_exist": {"type": "boolean", "required": False,
                           "description": "true = 只在键不存在时写入（create）"},
        "expect_version": {"type": "integer", "required": False,
                           "description": "CAS：只在版本等于该值时写入"},
    }
    risk = "low"

    def __init__(self, view: BoardView) -> None:
        self._view = view

    def invoke(self, args: dict) -> ToolResult:
        key = args.get("key")
        value = args.get("value")
        must_not_exist = args.get("must_not_exist", False)
        expect = args.get("expect_version")
        if not isinstance(must_not_exist, bool):
            return ToolResult(ok=False, error="must_not_exist 必须是布尔值")
        if must_not_exist and expect is not None:
            return ToolResult(ok=False,
                              error="must_not_exist 与 expect_version 不能同时给")
        try:
            if must_not_exist:
                entry = self._view.create(key, value)
            elif expect is not None:
                if isinstance(expect, bool) or not isinstance(expect, int) or expect < 1:
                    return ToolResult(ok=False, error="expect_version 必须是 ≥1 的整数")
                entry = self._view.update(key, value, expect_version=expect)
            else:
                entry = self._view.upsert(key, value)
        except BoardConflict as exc:
            return ToolResult(ok=False, error=f"版本冲突：{exc}")
        except BoardPermissionError as exc:
            return ToolResult(ok=False, error=str(exc))
        except ValueError as exc:
            return ToolResult(ok=False, error=f"参数不合法：{exc}")
        return ToolResult(ok=True, data={"key": entry.key,
                                         "version": entry.version,
                                         "by": entry.by})


def board_tools(view: BoardView) -> tuple[BoardReadTool, BoardWriteTool]:
    """给一个受控视图造一对黑板工具（读 + 写）。"""
    return BoardReadTool(view), BoardWriteTool(view)
