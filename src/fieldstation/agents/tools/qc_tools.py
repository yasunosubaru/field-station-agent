"""确定性工具：把 ``rules/`` 的纯函数包成智能体能调的形。

**判据不在本文件里。** 统计口径一律由 ``rules/qc.py`` 给，本文件只做参数校验、
形状转换与错误包装。任何在 agents/ 里重新计算一遍 median/mad/robust_z 的做法，
都是在制造第二套判据 —— 而两套判据的分歧，测试不报错，只有人对着数字发愣时才发现。

为什么挑这三个函数做第一个工具：它们**只吃一串数、返回数与数的列表**，
不依赖任何台站字段。也就是说这个工具今天就能跑，不需要等数据字典 ——
这也是 M1 未完成时唯一诚实的起点。
"""
from __future__ import annotations

from . import ToolResult


class RobustStatsTool:
    """中位数、MAD 与稳健 z 分数。用来问「这批观测里哪个值不像自己人」。"""

    name = "robust_stats"
    description = (
        "对一串数值观测计算中位数、MAD（中位数绝对偏差）与每个点的稳健 z 分数。"
        "z 分数绝对值大的点是离群候选。只做统计描述，不判定该点是否真的异常——"
        "那是 rules/qc.detect_slips 与 flag_epochs 的职责。"
    )
    params = {
        "values": {
            "type": "array",
            "items": "number",
            "required": True,
            "description": "一串数值观测，按时间顺序",
        }
    }
    risk = "low"

    def invoke(self, args: dict) -> ToolResult:
        values = args.get("values")
        if not isinstance(values, list):
            return ToolResult(ok=False, error=f"参数 values 必须是数组，收到：{type(values).__name__}")
        if not values:
            return ToolResult(ok=False, error="values 为空数组——没有观测可算")

        # bool 是 int 的子类，混进来会让 False 变成 0.0 参与统计，必须单独拦。
        for v in values:
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                return ToolResult(ok=False, error=f"values 含非数值元素：{v!r}")

        from fieldstation.rules import qc

        med = qc.median(values)
        spread = qc.mad(values)
        return ToolResult(ok=True, data={
            "n": len(values),
            "median": med,
            "mad": spread,
            "robust_z": qc.robust_z(values),
        })


def robust_stats_tool() -> RobustStatsTool:
    return RobustStatsTool()