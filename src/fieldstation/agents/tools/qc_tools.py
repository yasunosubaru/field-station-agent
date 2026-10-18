"""确定性工具：把 ``rules/`` 的纯函数包成智能体能调的形。

**判据不在本文件里。** 统计口径与守卫判决一律由 ``rules/qc.py`` 给，本文件只做
参数校验、形状转换与错误包装。任何在 agents/ 里重新计算一遍判据的做法，都是在
制造第二套判据 —— 而两套判据的分歧，测试不报错，只有人对着数字发愣时才发现。

当前清单（M3-1，issue #51）：

* ``robust_stats`` —— median / MAD / robust_z。M0 起的第一个工具，当时的原因它现在
  依然保持：**只吃一串数，不依赖任何台站字段**，不需要等数据字典就能跑。
* ``slip_detect`` —— 周跳检测（``qc.detect_slips``）。它只接收**已经由 ingest
  配对好的历元切片**，不读原始 RINEX，也不在工具层另造一套数据装配。
* ``continuity_verdict`` —— 弧段/序列比守卫（``qc.phase_continuity_verdict``）。
* ``magnitude_verdict`` —— 输出物理量级守卫（``qc.physical_rmse_verdict``）。
"""
from __future__ import annotations

import math

from fieldstation import constants as C
from fieldstation.model import EpochPair, Observation

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


def _finite_number(value) -> bool:
    return (not isinstance(value, bool)
            and isinstance(value, (int, float))
            and math.isfinite(float(value)))


def _signal_value(payload: dict, key: str, index: int, signal: str) -> float:
    value = payload.get(key)
    if value is None:
        return C.MISSING
    if not _finite_number(value):
        raise ValueError(
            f"series[{index}].{signal}.{key} 必须是有限数值或 null，收到：{value!r}")
    return float(value)


class SlipDetectTool:
    """周跳检测：把已配对历元切片交给 ``qc.detect_slips``。

    本工具刻意**不接收原始 RINEX**。``series`` 的每一格已经是一个
    station/system/sv 下的历元切片，两个信号各自给出 ``psr_m`` 与
    ``adr_cycles``；缺测用 null。这样工具层只做形状校验与数据类构造，
    不会另造第二套 ingestion。
    """

    name = "slip_detect"
    description = (
        "对一条已经配对好的双频历元序列做周跳检测。series 每项须含 "
        "gps_week、gps_tow_s、可选 quality_flag，以及以 signal_1 / signal_2 "
        "为键的两个信号对象；信号对象含 psr_m 与 adr_cycles，缺测可写 null。"
        "返回周跳历元下标与归一后的诊断摘要。"
    )
    params = {
        "series": {
            "type": "array",
            "items": "object",
            "required": True,
            "description": (
                "已配对的历元数组；每项含 gps_week、gps_tow_s、quality_flag，"
                "以及 signal_1 / signal_2 两个信号对象"),
        },
        "system": {
            "type": "string", "required": True,
            "description": "卫星系统名，如 GPS",
        },
        "signal_1": {
            "type": "string", "required": True,
            "description": "第一路信号名，如 L1",
        },
        "signal_2": {
            "type": "string", "required": True,
            "description": "第二路信号名，如 L2",
        },
        "sign": {
            "type": "number", "required": True,
            "description": "载波相位符号；GPS 常见为 -1",
        },
    }
    risk = "low"

    def invoke(self, args: dict) -> ToolResult:
        series_raw = args.get("series")
        if not isinstance(series_raw, list) or not series_raw:
            return ToolResult(ok=False, error="参数 series 必须是非空数组")
        system = args.get("system")
        signal_1 = args.get("signal_1")
        signal_2 = args.get("signal_2")
        for key, value in (("system", system), ("signal_1", signal_1),
                           ("signal_2", signal_2)):
            if not isinstance(value, str) or not value.strip():
                return ToolResult(
                    ok=False, error=f"参数 {key} 必须是非空字符串，收到：{value!r}")
        if signal_1 == signal_2:
            return ToolResult(ok=False, error="signal_1 与 signal_2 不能相同")
        sign = args.get("sign")
        if not _finite_number(sign):
            return ToolResult(
                ok=False, error=f"参数 sign 必须是有限数值，收到：{sign!r}")

        pairs: list[EpochPair] = []
        previous_time: tuple[int, float] | None = None
        try:
            for index, raw in enumerate(series_raw):
                if not isinstance(raw, dict):
                    raise ValueError(
                        f"series[{index}] 必须是 object，收到：{type(raw).__name__}")
                week = raw.get("gps_week")
                if isinstance(week, bool) or not isinstance(week, int):
                    raise ValueError(
                        f"series[{index}].gps_week 必须是整数，收到：{week!r}")
                tow = raw.get("gps_tow_s")
                if not _finite_number(tow):
                    raise ValueError(
                        f"series[{index}].gps_tow_s 必须是有限数值，收到：{tow!r}")
                tow = float(tow)
                timestamp = (week, tow)
                if previous_time is not None and timestamp <= previous_time:
                    raise ValueError(
                        f"series 必须按时间严格递增，series[{index}] 未递增")
                previous_time = timestamp

                quality_flag = raw.get("quality_flag", 0)
                if (isinstance(quality_flag, bool)
                        or not isinstance(quality_flag, int)):
                    raise ValueError(
                        f"series[{index}].quality_flag 必须是整数，"
                        f"收到：{quality_flag!r}")

                observations: dict[str, Observation] = {}
                for signal in (signal_1, signal_2):
                    payload = raw.get(signal)
                    if payload is None:
                        continue
                    if not isinstance(payload, dict):
                        raise ValueError(
                            f"series[{index}].{signal} 必须是 object 或 null，"
                            f"收到：{type(payload).__name__}")
                    observations[signal] = Observation(
                        station="",
                        receiver_id="",
                        gps_week=week,
                        gps_tow_s=tow,
                        system=system,
                        sv=0,
                        signal=signal,
                        freq_hz=0.0,
                        psr_m=_signal_value(payload, "psr_m", index, signal),
                        adr_cycles=_signal_value(
                            payload, "adr_cycles", index, signal),
                        doppler_hz=C.MISSING,
                        cn0_dbhz=C.MISSING,
                        elev_deg=C.MISSING,
                        azim_deg=C.MISSING,
                    )
                pairs.append(EpochPair(
                    station="",
                    system=system,
                    sv=0,
                    gps_week=week,
                    gps_tow_s=tow,
                    epoch_utc="",
                    obs=observations,
                    quality_flag=quality_flag,
                ))
        except ValueError as exc:
            return ToolResult(ok=False, error=str(exc))

        from fieldstation.rules import qc

        slips, diag = qc.detect_slips(
            pairs, system, signal_1, signal_2, float(sign), qc.QCConfig())
        return ToolResult(ok=True, data={
            "n_epochs": len(pairs),
            "slip_indices": sorted(slips),
            "counts": {
                "gf": diag["n_slip_gf"],
                "mw": diag["n_slip_mw"],
                "union": diag["n_slip_union"],
                "split_points": diag["n_slip_split_points"],
            },
            "sigma": {
                "gf_window": diag["sigma_gf_window"],
                "mw": diag["sigma_mw"],
                "mw_degenerate": diag["sigma_mw_degenerate"],
                "gf_window_samples": diag["gf_window_samples"],
            },
        })


def slip_detect_tool() -> SlipDetectTool:
    return SlipDetectTool()


class ContinuityVerdictTool:
    """弧段/序列比守卫：某算法的相位定平输出可否作为有效结果。

    判据、门限与「试过并否决的判据」全在 ``qc.phase_continuity_verdict``
    的 docstring（该守卫是内部代理，有假阳假阴，门限因此保守）。
    本工具原样透传参数；返回键集合即它的公开返回 schema：
    ``applicable / n_arcs / n_series / arc_ratio / short_arc_rate /
    rejected / reason / criterion``。
    """

    name = "continuity_verdict"
    description = (
        "弧段/序列比守卫：判断一个相位定平算法的输出能否当作有效结果。"
        "输入算法名与它产出的弧段数、卫星序列数；返回是否被拒与触发的判据。"
    )
    params = {
        "algorithm": {
            "type": "string", "required": True,
            "description": "算法名（如 ilr）；不在相位依赖算法集合里时守卫不适用",
        },
        "n_arcs": {
            "type": "integer", "required": True,
            "description": "检出的弧段数",
        },
        "n_series": {
            "type": "integer", "required": True,
            "description": "参与的卫星序列数（必须 > 0）",
        },
        "rejected_short_arcs": {
            "type": "integer", "required": False,
            "description": "因长度不足被丢弃的弧段数（默认 0）",
        },
        "n_rows": {
            "type": "integer", "required": False,
            "description": "参与统计的行数；给定时返回里附短弧率",
        },
        "arc_ratio_guard": {
            "type": "number", "required": False,
            "description": "弧段/序列比门限；不给则用 rules 内置默认",
        },
        "short_arc_guard": {
            "type": "number", "required": False,
            "description": "短弧丢弃率门限；默认 0（该判据已实测否决）",
        },
    }
    risk = "low"

    def invoke(self, args: dict) -> ToolResult:
        from fieldstation.rules import qc

        algorithm = args.get("algorithm")
        if not isinstance(algorithm, str) or not algorithm.strip():
            return ToolResult(ok=False, error=f"参数 algorithm 必须是非空字符串，收到：{algorithm!r}")
        for key in ("n_arcs", "n_series"):
            v = args.get(key)
            if isinstance(v, bool) or not isinstance(v, int):
                return ToolResult(ok=False, error=f"参数 {key} 必须是整数，收到：{v!r}")
        if args["n_series"] <= 0:
            return ToolResult(ok=False, error="参数 n_series 必须 > 0——没有序列就没有比值可算")

        kwargs: dict = {}
        for key in ("rejected_short_arcs", "n_rows"):
            v = args.get(key)
            if v is None:
                continue
            if isinstance(v, bool) or not isinstance(v, int):
                return ToolResult(ok=False, error=f"参数 {key} 必须是整数，收到：{v!r}")
            kwargs[key] = v
        for key in ("arc_ratio_guard", "short_arc_guard"):
            v = args.get(key)
            if v is None:
                continue
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                return ToolResult(ok=False, error=f"参数 {key} 必须是数值，收到：{v!r}")
            kwargs[key] = float(v)

        data = qc.phase_continuity_verdict(
            algorithm, args["n_arcs"], args["n_series"], **kwargs)
        return ToolResult(ok=True, data=data)


class MagnitudeVerdictTool:
    """输出物理量级守卫：RMSE 大到不可能是 TEC 时拒收。

    判据与物理上限在 ``qc.physical_rmse_verdict``（物理边界，不是代理；
    ``None`` 一律放行——没有可比数字时不能据此下结论）。返回键集合即它的
    公开返回 schema：``applicable / rmse / cap_tecu / rejected / reason /
    criterion``。
    """

    name = "magnitude_verdict"
    description = (
        "输出物理量级守卫：判断一个反演相对参考解的 RMSE（单位 TECU）"
        "是否为非物理值（超过垂 TEC 的物理上限）。rmse 为 null（没有可比数字）"
        "时不据此下结论，直接放行并注明不可判定。"
    )
    params = {
        "rmse": {
            "type": "number", "required": True,
            "description": "反演相对参考解的 RMSE，单位 TECU；没有可比数字改为 null",
        },
        "cap_tecu": {
            "type": "number", "required": False,
            "description": "物理上限（TECU）；不给则用 rules 内置默认 500",
        },
    }
    risk = "low"

    def invoke(self, args: dict) -> ToolResult:
        from fieldstation.rules import qc

        if "rmse" not in args:
            return ToolResult(ok=False, error="缺少必需参数 rmse（可为 null）")
        rmse = args.get("rmse")
        if rmse is not None and (isinstance(rmse, bool)
                                 or not isinstance(rmse, (int, float))):
            return ToolResult(ok=False, error=f"参数 rmse 必须是数值或 null，收到：{rmse!r}")
        kwargs: dict = {}
        cap = args.get("cap_tecu")
        if cap is not None:
            if isinstance(cap, bool) or not isinstance(cap, (int, float)):
                return ToolResult(ok=False, error=f"参数 cap_tecu 必须是数值，收到：{cap!r}")
            kwargs["cap_tecu"] = float(cap)

        data = qc.physical_rmse_verdict(rmse, **kwargs)
        return ToolResult(ok=True, data=data)


def continuity_verdict_tool() -> ContinuityVerdictTool:
    return ContinuityVerdictTool()


def magnitude_verdict_tool() -> MagnitudeVerdictTool:
    return MagnitudeVerdictTool()
