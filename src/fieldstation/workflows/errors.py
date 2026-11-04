"""errors —— 失败分类（八类）。

为什么要分类
------------
「找不到 X」这一句在 RPA 里至少对应五种完全不同的处境：**界面文案变了**（改选择器）、
**弹窗根本没开**（看看是不是被挡住/网络没回来）、**等得不够久**（加时间或换条件）、
**设备没插**（插上再跑）、**环境没起**（起引擎/套件）。只报一句话，人就得从头猜一遍。

所以失败类别不是「错误码」，而是**下一步该谁动**：

===============  ==========================================  ================
类别             典型消息                                     下一步
===============  ==========================================  ================
environment      套件没有开 CDP / 引擎连不上                  起环境
input            参数不是数值 / 缺少必填参数                   改参数
execution        点了没反应 / 未预期异常                       看截图与审计
policy           审批被拒 / 命中危险词                         走审批，不要硬来
selector_drift   找不到目标 / 不唯一 / 坐标漂移                 跑校准，改选择器
dialog_unavailable 更新弹窗没出现                            看对话框是否被遮住
gate_timeout     10s 内没有满足等待条件                       加时间或查为什么慢
hardware_missing 接收机/串口不存在                            插设备
===============  ==========================================  ================

判定顺序（先具体后笼统，写死在 :func:`classify_failure` 里）
-------------------------------------------------------------
1. ``policy``：策略异常 / 审批拒绝 / 危险词拦截；
2. ``input``：规格或参数校验失败；
3. ``environment``：消息里明确是**计算机这一侧**（CDP、套件没开、没有 GUI 驱动、引擎）；
   放在设备判定之前，免得「CDP 端口不存在」被当成没插设备；
4. ``hardware_missing``：设备名词（接收机/设备/串口/端口/COMx）+ 缺失动词；
5. ``gate_timeout``：:class:`GateTimeout`、等待类步骤的超时消息、``TimeoutError``；
6. ``dialog_unavailable``：``GuiUnavailable`` 且报的是对话框/弹窗；
7. ``selector_drift``：``ClickError``（含坐标漂移）或「找不到/不唯一」类消息；
8. ``execution``：其余（含 ``ClickNoEffect``：「点下去了，但没效果」不是选择器问题）。

**不认识就归 execution**：宁可让人再看一眼证据，也不要乱指一个方向。
"""
from __future__ import annotations

import re
import socket

from . import spec as spec_mod

__all__ = [
    "ApprovalRejected",
    "GateTimeout",
    "PolicyViolation",
    "classify_failure",
    "is_click_error",
    "is_gui_unavailable",
]

#: 八类，顺序即「动作优先级」，与 :data:`spec.FAILURE_CLASSES` 保持一致。
FAILURE_CLASSES = spec_mod.FAILURE_CLASSES


class GateTimeout(RuntimeError):
    """条件等待在预算内没有满足。**不是**环境坏了，是「还没到时候」。"""


class PolicyViolation(RuntimeError):
    """策略层拒绝：危险动作没过闸门，或审批被拒。"""


class ApprovalRejected(PolicyViolation):
    """审批门给出 ``rejected``。"""


# --------------------------------------------------------------------------- 词表
_ENV = re.compile(
    r"cdp"
    r"|套件\s*(?:没有|没|未)\s*开"
    r"|套件未启动"
    r"|没有\s*gui\s*驱动"
    r"|gui\s*驱动.{0,40}(?:不存在|不可用|加载失败|导入失败)"
    r"|引擎\s*(?:连不上|不可达|没起|没有起|未启动|不在)"
    r"|engine"
    r"|connection refused|连接被拒绝|拒绝连接|连不上|refused"
    r"|network is unreachable|无法连接|urlopen error",
    re.IGNORECASE)

#: 设备名词只收**中文**词与明确的硬件词（COMx / receiver）。
#: 故意不收英文 ``device``/``port``：控件名里就常有 “Device > Model”，
#: 把「找不到 'Device > Model' 控件」判成「没插设备」会指错方向。
_DEVICE = re.compile(
    r"设备|接收机|串口|端口|receiver|com\d+",
    re.IGNORECASE)
_DEVICE_ABSENT = re.compile(
    r"不存在|找不到|未找到|没找到|缺失|没有\s*插|没插|未插|没有\s*接|没接"
    r"|未连接|断开|打不开|没有回到|没回来|不可用"
    r"|not found|missing|absent|no such|not connected|disconnected|no device",
    re.IGNORECASE)

_DIALOG = re.compile(r"对话框|弹窗|弹框|弹出窗口|dialog|popup|modal", re.IGNORECASE)
_SELECTOR = re.compile(
    r"找不到|未找到|没找到|不唯一|坐标漂移|已消失|selector"
    r"|页面上没有|not found|stale",
    re.IGNORECASE)

_TIMEOUT = re.compile(
    r"超时|timeout|timed out|内没有等到|没有在.{0,12}内|等待.{0,8}失败",
    re.IGNORECASE)

_INPUT = re.compile(
    r"参数|不是数值|不合法|缺少必填|没有给\s*target|规格",
    re.IGNORECASE)

_POLICY = re.compile(
    r"审批|批准|reject|approval|危险词|必须先过闸门|policy",
    re.IGNORECASE)

_WAIT_KINDS = frozenset({"wait_ui", "await_receiver"})


def _mro_names(exc: object) -> set[str]:
    if not isinstance(exc, BaseException):
        return set()
    return {klass.__name__.lower() for klass in type(exc).__mro__}


def is_gui_unavailable(exc: object) -> bool:
    """判断是不是「GUI 驱动不可用/找不到控件」。

    为什么不直接 ``isinstance(exc, gui.GuiUnavailable)``：仓库里有**三个**
    ``GuiUnavailable``（本包的、``tools/cdp_driver.py`` 的、``tools/uia_driver.py`` 的），
    驱动是可选插件，包不能反向 import 它们。按类名认是这里唯一不引入耦合的做法——
    它们表达的是同一件事，也都被同一批执行器代码接住。
    """
    return "guiunavailable" in _mro_names(exc)


def is_click_error(exc: object) -> bool:
    """判断是不是点击引擎说的「找不到/不唯一/坐标漂移」。

    ``tools/click_engine.py`` 也是可选插件（``tools`` 不在包路径里），所以同样按类名认；
    ``ClickNoEffect`` 继承 ``ClickError``，这里一并算「点不到」。
    """
    return "clickerror" in _mro_names(exc)


def _text(exc: object, message: str | None) -> str:
    if message is not None:
        return str(message)
    return "" if exc is None else str(exc)


def classify_failure(
    exc: BaseException | None,
    *,
    step_kind: str = "",
    message: str | None = None,
) -> str:
    """把一个异常/一句话归到八类之一。

    ``step_kind`` 只在时间是「等出来的」还是「连不上」需要区分时才用得上；
    ``message`` 可以覆盖 ``str(exc)``（执行器手里往往有更完整的一句话）。
    """
    text = _text(exc, message)
    names = _mro_names(exc)
    kind = (step_kind or "").strip().lower()

    if isinstance(exc, PolicyViolation) or names & {"approvalrejected", "policyviolation"}:
        return "policy"
    if _POLICY.search(text):
        return "policy"

    if isinstance(exc, spec_mod.WorkflowSpecError) or "workflowspecerror" in names:
        return "input"
    if _INPUT.search(text):
        return "input"

    # 计算机这一侧的问题先判：否则「CDP 端口 9223 不存在」会被算成没插设备。
    if "engineunavailable" in names or _ENV.search(text):
        return "environment"

    if _DEVICE.search(text) and _DEVICE_ABSENT.search(text):
        return "hardware_missing"

    if isinstance(exc, GateTimeout) or "gatetimeout" in names:
        return "gate_timeout"
    if isinstance(exc, (TimeoutError, socket.timeout)):
        # 等待类步骤里的超时是「闸门超时」；别处（连接/HTTP）的超时是环境问题。
        return "gate_timeout" if kind in _WAIT_KINDS else "environment"
    if _TIMEOUT.search(text) and (kind in _WAIT_KINDS or "超时" in text):
        return "gate_timeout"

    is_gui = is_gui_unavailable(exc)
    if is_gui and _DIALOG.search(text):
        return "dialog_unavailable"

    if "clicknoeffect" in names:
        # 点下去了但没效果：先怀疑「点空/被遮住/状态没变」，不是选择器错位。
        return "execution"
    if "clickerror" in names or _SELECTOR.search(text):
        return "selector_drift"

    if isinstance(exc, (ConnectionError, OSError)):
        return "environment"

    return "execution"
