# -*- coding: utf-8 -*-
"""两个运行时的薄实现 + 一个可脚本化的假运行时。

网络部分都用标准库 ``urllib``；解析在 :mod:`sse` 里，纯函数、可离线测。

## 三个实现的分工

| 类 | 谁跑工具循环 | 用途 |
|---|---|---|
| :class:`OpenAICompatibleRuntime` | 我们自己（只有一轮） | A 侧通用兼容端点（vLLM / Ollama / 网关） |
| :class:`ClaudeRuntime` | **SDK 自己** | B 侧：官方 ``claude-agent-sdk`` |
| :class:`FakeRuntime` | 无 | 离线测试与演示 |

## `ClaudeRuntime` 的一条关键约束

它**不自己跑工具循环**。把 ``ClaudeAgentOptions`` 交给 SDK，SDK 负责
「模型说要调工具 → 调 → 把结果塞回去 → 再问」那一整圈；我们只做两件事：

1. 把 SDK 的消息流翻译成九种内部事件（:func:`translate_sdk_message`）；
2. 在 ``can_use_tool`` 回调里落到我们的审批门（:class:`ApprovalGate`），
   而不是自己放行。

第二条是安全边界：SDK 的权限回调是**唯一**能拦住高风险工具的地方，
放在调用方等于任何直连接口都能绕过。

## 为什么保留 ``urllib`` 那条路径

``ClaudeRuntime`` 仍然能用 ``base_url`` 指向 ``anthropic_shim``（智-3 的「有 shim」路径）；
``use_sdk=False`` 时不加载 SDK，走原来的 Messages HTTP 流。
两条路径共用同一套事件翻译——不然「九种事件一致」这条一天就会分叉。
"""
from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from typing import Any, Callable, Iterator

from .base import Event, RuntimeRequest, RuntimeUnavailable
from .sse import (AnthropicState, OpenAIState, iter_sse, translate_anthropic,
                  translate_openai)


def _post_json(url: str, body: dict, headers: dict, timeout: float = 120.0,
               proxy: str = ""):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    # 某些网关（commandcode）前面有 Cloudflare，缺这个 UA 直接 403。
    req.add_header("User-Agent", "opencode/1.2.3")
    for key, value in headers.items():
        req.add_header(key, value)
    opener = urllib.request.build_opener()
    if proxy:
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    try:
        return opener.open(req, timeout=timeout)
    except urllib.error.URLError as exc:  # 端口没起/连不上都算运行时不可用
        raise RuntimeUnavailable("连不上运行时 %s：%s" % (url, exc)) from exc


#: Chat 补全路径。
#:
#: **两种 provider 的 base_url 约定不同，这里必须自己补 `/v1`**：
#:   - `agents/providers/openai_compatible.py` 的 `CHAT_PATH` 就是
#:     `"/v1/chat/completions"`，所以它的 base_url **不带** `/v1`
#:     （配置里写 `https://api.commandcode.ai/provider`）；
#:   - 本模块原先拼 `"/chat/completions"`，于是同一条配置在这里变成
#:     `/provider/chat/completions` -> 404（实测）。
#:
#: 这里同时容忍两种写法：base_url 已经以 `/v1` 结尾就不重复加。
CHAT_COMPLETIONS_PATH = "/v1/chat/completions"


def _chat_url(base_url: str) -> str:
    """按 base_url 是否已带 `/v1` 决定 chat 补全的完整地址。"""
    base = (base_url or "").rstrip("/")
    if base.endswith("/v1"):
        return base + "/chat/completions"
    return base + CHAT_COMPLETIONS_PATH


class OpenAICompatibleRuntime:
    """任何 OpenAI 兼容端点（vLLM / Ollama / 网关；默认 http://127.0.0.1:11434/v1）。"""

    name = "openai-compatible"

    def __init__(self, base_url: str = "http://127.0.0.1:11434/v1",
                 api_key: str = "", timeout: float = 120.0, *,
                 api_model: str = "", proxy: str = ""):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        #: 真实发给端点的模型名。
        #:
        #: ``req.model`` 是**对外规范名**（纪-1 只认 ``deepseek-v4.1-flash``），
        #: 而端点要的可能是带 provider 前缀的形式：
        #: commandcode 要 ``deepseek/deepseek-v4.1-flash``，Ollama 要
        #: ``qwen3.8-flash-next-iq2_xs:latest``。留空则原样用 ``req.model``。
        self.api_model = api_model.strip()
        #: HTTP 代理（``http://127.0.0.1:7900``）。留空走直连。
        self.proxy = proxy.strip()

    def _opener(self):
        if self.proxy:
            handler = urllib.request.ProxyHandler(
                {"http": self.proxy, "https": self.proxy})
            return urllib.request.build_opener(handler)
        return urllib.request.build_opener()

    def available(self) -> bool:
        try:
            req = urllib.request.Request(
                self.base_url + "/models",
                headers={"User-Agent": "opencode/1.2.3",
                         **({"Authorization": "Bearer " + self.api_key}
                            if self.api_key else {})})
            with self._opener().open(req, timeout=8) as resp:
                return resp.status < 500
        except Exception:  # noqa: BLE001
            return False

    def run(self, req: RuntimeRequest):
        body = {
            "model": self.api_model or req.model,
            "stream": True,
            "messages": [{"role": "system", "content": req.system}] if req.system else [],
        }
        body["messages"].extend(req.history or [])
        body["messages"].append({"role": "user", "content": req.prompt})
        if req.tools:
            body["tools"] = [{"type": "function", "function": t} for t in req.tools]

        headers = {"Authorization": "Bearer " + self.api_key} if self.api_key else {}
        state = OpenAIState(req.session_id)
        resp = _post_json(_chat_url(self.base_url), body, headers,
                          self.timeout, self.proxy)
        with resp:
            for _, payload in iter_sse(resp):
                for event in translate_openai(payload, state):
                    yield event

    def cancel(self, session_id: str) -> None:
        # OpenAI 兼容端点通常没有取消接口；调用方直接关闭迭代即可
        return None


# --------------------------------------------------------------------- SDK 翻译
#: SDK 的 ``ResultMessage.stop_reason`` → 契约的 ``message.done.reason``。
_SDK_STOP = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "max_tokens": "length",
    "tool_use": "tool_calls",
    "pause_turn": "stop",
    "refusal": "stop",
}


#: SDK 的四种消息类型名。**按类名分派**是刻意的：
#: 这四类来自 SDK 的可选依赖，``isinstance`` 需要先 import 真包；而按类名
#: 只需字符串比较，测试里用假类也能走同一条分派逻辑。
#:
#: 之所以把名单显式列出来：未在名单里的消息会被忽略（SDK 还会吐 ``StreamEvent``
#: 之类我们不用的事件），但**名单内的四类必须都被处理**——漏一个就会表现成
#: 「事件流照常结束、只是少了几个」，不报错。
HANDLED_SDK_MESSAGES = ("SystemMessage", "AssistantMessage", "UserMessage",
                        "ResultMessage")


def _kind_of(message: Any) -> str:
    """取消息的契约类名（``AssistantMessage`` 之类）。

    用**后缀**匹配而不是精确相等：SDK 内部的类可能带前缀（子类、包装类），
    测试里的假类也叫 ``FakeAssistantMessage``。精确匹配看着更严，实际是把
    「类名形状」当成接口的一部分——那不是我该依赖的东西。
    """
    name = type(message).__name__
    for kind in HANDLED_SDK_MESSAGES:
        if name == kind or name.endswith(kind):
            return kind
    return ""


def translate_sdk_message(message: Any, session_id: str,
                          state: dict | None = None) -> list[Event]:
    """``claude_agent_sdk`` 的消息 → 九种内部事件。

    这是智-0b 第 4 处的「**保留事件翻译层，只改输入源**」：不推倒重来，
    而是把 SDK 的消息类型映射到与 ``translate_anthropic`` 完全相同的字段。

    映射（SDK 消息 → 内部事件）：

    | SDK | 内部事件 | 说明 |
    |---|---|---|
    | ``SystemMessage(subtype=init)`` | ``session.start`` | 只发一次 |
    | ``AssistantMessage`` + ``TextBlock`` | ``message.delta`` | 每块一条 |
    | ``AssistantMessage`` + ``ToolUseBlock`` | ``tool.call`` | ``arguments`` 是 JSON 文本 |
    | ``UserMessage`` + ``ToolResultBlock`` | ``tool.result`` | 工具真的跑完了 |
    | ``AssistantMessage.usage`` | ``usage`` | prompt/completion tokens |
    | ``ResultMessage`` | ``message.done`` | 收尾；``is_error`` 时补一条 ``error`` |

    **审批两种事件不由 SDK 产生**：它们来自 ``can_use_tool`` 回调，
    由 :meth:`ClaudeRuntime.run` 自己发（见那里的注释）。
    """
    state = state if state is not None else {}
    out: list[Event] = []
    kind = _kind_of(message)

    if kind == "SystemMessage":
        subtype = getattr(message, "subtype", "") or ""
        if subtype == "init" and not state.get("started"):
            state["started"] = True
            data = getattr(message, "data", None) or {}
            out.append(Event("session.start", session_id, {
                "runtime": "claude",
                "model": str(data.get("model") or ""),
                "agent": str(data.get("agent") or ""),
                "toolset_rev": str(data.get("toolset_rev") or ""),
            }))
        return out

    if kind == "AssistantMessage":
        for block in getattr(message, "content", None) or []:
            bname = type(block).__name__
            if bname.endswith("TextBlock"):
                text = getattr(block, "text", "") or ""
                if text:
                    out.append(Event("message.delta", session_id, {"text": text}))
            elif bname.endswith("ToolUseBlock"):
                payload = getattr(block, "input", None)
                tool_id = str(getattr(block, "id", ""))
                tool_name = str(getattr(block, "name", ""))
                # 记下 id → name，供 tool.result 反查（契约要求两侧一致）
                state.setdefault("tool_names", {})[tool_id] = tool_name
                out.append(Event("tool.call", session_id, {
                    "id": tool_id,
                    "name": tool_name,
                    "arguments": json.dumps(payload or {}, ensure_ascii=False),
                }))
        usage = getattr(message, "usage", None) or {}
        if usage:
            out.append(Event("usage", session_id, {
                "prompt_tokens": int(usage.get("input_tokens") or 0),
                "completion_tokens": int(usage.get("output_tokens") or 0),
            }))
        return out

    if kind == "UserMessage":
        #: 工具名靠 tool_use_id 反查。契约 §3.5 要求 `tool.result.name`
        #: 与对应 `tool.call.name` 相同；靠「最后见过的工具」猜在多工具并行时是错的。
        names: dict[str, str] = state.setdefault("tool_names", {})
        for block in getattr(message, "content", None) or []:
            if not type(block).__name__.endswith("ToolResultBlock"):
                continue
            is_error = bool(getattr(block, "is_error", False))
            content = getattr(block, "content", None)
            text = _flatten_sdk_content(content)
            tool_id = str(getattr(block, "tool_use_id", ""))
            name = names.get(tool_id) or str(state.get("last_tool_name") or "")
            if is_error:
                out.append(Event("tool.result", session_id, {
                    "id": tool_id,
                    "name": name,
                    "ok": False,
                    "error": {"code": "E_INTERNAL", "message": text,
                              "retryable": False},
                }))
            else:
                out.append(Event("tool.result", session_id, {
                    "id": tool_id,
                    "name": name,
                    "ok": True,
                    "data": _parse_sdk_payload(text),
                }))
        return out

    if kind == "ResultMessage":
        if getattr(message, "is_error", False):
            out.append(Event("error", session_id, {
                "class": "provider",
                "message": str(getattr(message, "result", "") or "SDK 返回错误"),
                "retryable": bool(getattr(message, "duration_ms", 0) == 0),
            }))
        raw = str(getattr(message, "stop_reason", "") or "")
        out.append(Event("message.done", session_id,
                         {"reason": _SDK_STOP.get(raw, "stop")}))
        return out

    return out


def _flatten_sdk_content(content: Any) -> str:
    """把 ``ToolResultBlock.content`` 压成文本。它可能是 str / 块列表 / None。"""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                parts.append(str(item.get("text") or ""))
            else:
                parts.append(str(getattr(item, "text", "") or ""))
        return "\n".join(p for p in parts if p)
    return str(content)


def _parse_sdk_payload(text: str) -> dict:
    """工具结果是 JSON 文本时还原成对象；不是就包成 ``{"text": ...}``。

    **不抛异常**：工具可能返回纯文本，那不是错误。
    """
    stripped = (text or "").strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, dict):
                return parsed
            return {"value": parsed}
        except json.JSONDecodeError:
            pass
    return {"text": text}


# --------------------------------------------------------------------- 审批
class Ledger:
    """审批台账的**最小**接口：只回答「这个 call 有没有被批准」。"""

    def decide(self, tool_name: str, tool_input: dict) -> tuple[bool, str]:
        """返回 ``(allow, reason)``。默认拒绝——与 ``agents/approval.py`` 同一条纪律。"""
        return False, "没有配置审批者：按拒绝处理"


class DenyAllLedger(Ledger):
    """默认实现：一律不批。宁可高风险工具不可用，也不默认放行。"""

    def decide(self, tool_name: str, tool_input: dict) -> tuple[bool, str]:  # noqa: ARG002
        return False, "DenyAllLedger：未接审批表，一律拒绝"


class ScriptedLedger(Ledger):
    """脚本化台账：测试与本地演示用。**不接真实审批，不要用于生产**。"""

    def __init__(self, allow: set[str] | None = None,
                 reason: str = "scripted approve"):
        self.allow = set(allow or ())
        self.reason = reason
        self.calls: list[tuple[str, dict]] = []

    def decide(self, tool_name: str, tool_input: dict) -> tuple[bool, str]:
        self.calls.append((tool_name, dict(tool_input or {})))
        return (True, self.reason) if tool_name in self.allow else (False, "not in allow set")


class ClaudeRuntime:
    """Claude Agent SDK 侧。

    两种工作模式，**事件翻译层共用**：

    * ``use_sdk=True``（默认，智-0b）：工具循环交给 ``claude_agent_sdk``；
      审批走 ``can_use_tool`` 回调 → :class:`Ledger`。
    * ``use_sdk=False``（智-3 的「有 shim」路径）：``base_url`` 指向
      ``tools/anthropic_shim.py``，走 Anthropic Messages HTTP 流。

    ``available()`` 的语义两种模式都一样：SDK 没装、或端口不通，都算
    :class:`RuntimeUnavailable`，**不自动回落到另一种模式**——自动切换会让
    「哪次用了谁」说不清（ADR-009）。
    """

    name = "claude"

    def __init__(self, base_url: str = "http://127.0.0.1:8765",
                 api_key: str = "", timeout: float = 120.0, *,
                 use_sdk: bool = True,
                 ledger: Ledger | None = None,
                 agent_name: str = "fsa-ops",
                 agent_description: str = "野外台站值守智能体",
                 system_prompt: str = "",
                 allowed_tools: list[str] | None = None,
                 disallowed_tools: list[str] | None = None,
                 skills: list[str] | None = None,
                 cwd: str | None = None,
                 max_turns: int = 12,
                 approval_timeout_s: float = 300.0,
                 on_intervention: Callable[[dict], Any] | None = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.use_sdk = use_sdk
        self.ledger = ledger or DenyAllLedger()
        self.agent_name = agent_name
        self.agent_description = agent_description
        self.system_prompt = system_prompt
        self.allowed_tools = list(allowed_tools or [])
        self.disallowed_tools = list(disallowed_tools or [])
        self.skills = list(skills or [])
        self.cwd = cwd
        self.max_turns = max_turns
        #: 审批等待上限。**不能无限等**——卡死的运行时要能被上层放弃。
        self.approval_timeout_s = approval_timeout_s
        self.on_intervention = on_intervention

    # ---- 状态
    def _sdk(self):
        """延迟导入 SDK。没装时抛 :class:`RuntimeUnavailable`，不静默降级。"""
        try:
            import claude_agent_sdk  # noqa: F401
        except ImportError as exc:
            raise RuntimeUnavailable(
                "claude-agent-sdk 未安装（注意：anthropic 是另一个包，"
                "装了它不等于装了 Agent SDK）：%s" % exc) from exc
        return claude_agent_sdk

    def available(self) -> bool:
        if self.use_sdk:
            try:
                self._sdk()
            except RuntimeUnavailable:
                return False
            return True
        try:
            with urllib.request.urlopen(self.base_url + "/health", timeout=3) as resp:
                return resp.status == 200
        except Exception:  # noqa: BLE001
            return False

    # ---- 无 shim 分支（智-3）
    def endpoint_kind(self) -> str:
        """判断端点类型：``sdk`` / ``anthropic`` / ``shim``。

        判据是**协议**，不是名字：

        * ``use_sdk=True`` → ``sdk``（SDK 自己处理协议，不需要转换）
        * ``base_url`` 指向 ``anthropic_shim`` 的默认端口 8765 → ``shim``
          （它把 Anthropic Messages 翻成 OpenAI chat.completions，是协议转换）
        * 其余 → ``anthropic``（真的 Anthropic 端点，直连即可，**跳过 shim**）

        这条判断存在的意义：智-3 要求「需要转换才走 shim，直连就跳过」。
        如果一律走 shim，直连 Anthropic 的场景就多了一跳无谓的转换，
        而且会把「shim 坏了」和「端点坏了」混成同一个故障。
        """
        if self.use_sdk:
            return "sdk"
        host = self.base_url.split("://", 1)[-1].split("/", 1)[0]
        if host.endswith(":8765") or "/shim" in self.base_url:
            return "shim"
        return "anthropic"

    def needs_shim(self) -> bool:
        """是否需要协议转换。**直连时不走 shim**。"""
        return self.endpoint_kind() == "shim"

    # ---- 主入口
    def run(self, req: RuntimeRequest):
        kind = self.endpoint_kind()
        if kind == "sdk":
            yield from self._run_sdk(req)
            return
        yield from self._run_http(req)

    # ---- SDK 驱动
    def _run_sdk(self, req: RuntimeRequest):
        sdk = self._sdk()
        try:
            events = asyncio.run(self._collect_sdk(sdk, req))
        except RuntimeUnavailable:
            raise
        except Exception as exc:  # noqa: BLE001 —— SDK 内部错误要变成事件
            raise RuntimeUnavailable("Claude Agent SDK 运行失败：%s" % exc) from exc
        yield from events

    async def _collect_sdk(self, sdk, req: RuntimeRequest) -> list[Event]:
        """跑一轮 SDK 会话，把消息流翻译成事件序列。

        **审批事件在这里自己发**：``can_use_tool`` 是 SDK 的回调，
        它不知道「审批」这个概念，所以由我们把 ``approval.request`` 与
        ``approval.result`` 补进事件流——这也正是智-5 要求的那两种事件。
        """
        state: dict = {}
        events: list[Event] = []
        agent = sdk.AgentDefinition(
            description=self.agent_description,
            prompt=req.system or self.system_prompt or self.agent_description,
            tools=self.allowed_tools or None,
            disallowedTools=self.disallowed_tools or None,
            model=req.model or None,
            skills=self.skills or None,
        )
        options = sdk.ClaudeAgentOptions(
            agents={self.agent_name: agent},
            system_prompt=req.system or self.system_prompt or None,
            model=req.model or None,
            max_turns=int(req.max_steps or self.max_turns),
            cwd=self.cwd,
            allowed_tools=self.allowed_tools or [],
            disallowed_tools=self.disallowed_tools or [],
            can_use_tool=self._make_permission_callback(events, req.session_id),
            include_partial_messages=False,
        )

        client = sdk.ClaudeSDKClient(options=options)
        await client.connect()
        try:
            await client.query(req.prompt)
            async for message in client.receive_response():
                for event in translate_sdk_message(message, req.session_id, state):
                    if event.type == "tool.call":
                        state["last_tool_name"] = event.data.get("name", "")
                    events.append(event)
                if type(message).__name__.endswith("ResultMessage"):
                    break
        finally:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001 —— 断开失败不该盖住真正的错误
                pass
        return events

    def _make_permission_callback(self, sink: list[Event], session_id: str):
        """构造 SDK 的 ``can_use_tool`` 回调。

        它做三件事，顺序不能变：

        1. 先发 ``approval.request``（界面要立刻看到「在等人批」）；
        2. 问台账要结论——**带超时**，不许无限等；
        3. 发 ``approval.result``，然后才放行/拒绝。

        第 3 步必须在 ``return`` 之前发完，否则 SDK 已经开始执行工具了，
        而界面上的审批卡还停在 pending。
        """
        sdk = self._sdk()

        async def callback(tool_name: str, tool_input: dict[str, Any], context: Any):
            approval_id = "ap-%s" % (getattr(context, "tool_use_id", "") or tool_name)
            call_id = str(getattr(context, "tool_use_id", "") or "")
            sink.append(Event("approval.request", session_id, {
                "approval_id": approval_id,
                "call_id": call_id,
                "name": tool_name,
                "risk": "high",
                "reason": str(getattr(context, "decision_reason", "") or
                              "该工具在审批门内"),
                "prompt": "批准调用 %s？" % tool_name,
                "requested_by": self.agent_name,
            }))

            allow, reason = await self._decide_with_timeout(tool_name, tool_input)

            sink.append(Event("approval.result", session_id, {
                "approval_id": approval_id,
                "call_id": call_id,
                "verdict": "approved" if allow else "rejected",
                "by": "ledger",
                "note": reason,
            }))

            if allow:
                return sdk.PermissionResultAllow(behavior="allow",
                                                 updated_input=tool_input)
            return sdk.PermissionResultDeny(behavior="deny",
                                            message=reason, interrupt=False)

        return callback

    async def _decide_with_timeout(self, tool_name: str, tool_input: dict) -> tuple[bool, str]:
        """问台账，**带超时**。超时按拒绝处理（与契约「审批过期按 rejected」一致）。

        台账本身可能是同步阻塞的（比如等人点界面），所以放到线程里跑，
        用一个 ``wait_for`` 兜底——否则一个人走开就能把整个运行时挂住。
        """
        try:
            loop = asyncio.get_running_loop()
            return await asyncio.wait_for(
                loop.run_in_executor(None, self.ledger.decide, tool_name, tool_input),
                timeout=self.approval_timeout_s)
        except asyncio.TimeoutError:
            return False, "审批超时（%.0fs）按拒绝处理" % self.approval_timeout_s

    # ---- HTTP 分支（有 shim / 直连 Anthropic）
    def _run_http(self, req: RuntimeRequest):
        body = {
            "model": req.model,
            "max_tokens": 4096,
            "stream": True,
            "messages": [{"role": "user", "content": req.prompt}],
        }
        if req.system:
            body["system"] = req.system
        if req.tools:
            body["tools"] = req.tools

        headers = ({"x-api-key": self.api_key, "anthropic-version": "2023-06-01"}
                   if self.api_key else {})
        state = AnthropicState(req.session_id)
        resp = _post_json(self.base_url + "/v1/messages", body, headers, self.timeout)
        with resp:
            for event_name, payload in iter_sse(resp):
                for event in translate_anthropic(event_name, payload, state):
                    yield event

    def cancel(self, session_id: str) -> None:
        return None


class FakeRuntime:
    """脚本化运行时：按预设事件序列吐出，用于离线测试与演示。"""

    name = "fake"

    def __init__(self, script: list[dict] | None = None):
        self.script = script or [
            {"type": "session.start", "data": {"runtime": "fake"}},
            {"type": "message.delta", "data": {"text": "（演示）"}},
            {"type": "message.done", "data": {"reason": "stop"}},
        ]

    def available(self) -> bool:
        return True

    def run(self, req: RuntimeRequest):
        for item in self.script:
            yield Event(str(item["type"]), req.session_id, dict(item.get("data") or {}))

    def cancel(self, session_id: str) -> None:
        return None


#: 兼容旧名：OpenCode 的 v2 API 不是 OpenAI 兼容的（实测 /openapi.json 401，
#: serve 会打印 server password），要接它得单独写原生适配器。在那之前，
#: 这个名字指向通用 OpenAI 兼容实现，避免"以为已经接了 OpenCode"。
OpenCodeRuntime = OpenAICompatibleRuntime
