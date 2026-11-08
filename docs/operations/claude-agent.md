# Claude Agent SDK（B 侧运行时）

- 状态：**W4 落地**（2026-11-08）
- 代码锚点：`src/fieldstation/runtimes/impl.py`（`ClaudeRuntime`）
- 测试：`tests/test_runtimes_claude.py`
- 契约：`docs/contracts/agent-events.md`（九种事件）
- 一句话：**工具循环交给 SDK，审批门留在我们手里，事件翻译层两边共用一套。**

---

## 1. 装的是哪个包（这一步最容易错）

有两个包名字很像，**用途完全不同**：

| 包 | 是什么 | 有 agent loop 吗 |
|---|---|---|
| `anthropic` | Messages API 的 HTTP 客户端 | ❌ 得自己写循环 |
| `claude-agent-sdk` | **完整的 agent loop** | ✅ SDK 自己跑 |

判断标准不是 `import` 成功，而是看有没有这三个概念：

| 概念 | `anthropic` | `claude-agent-sdk` |
|---|---|---|
| `AgentDefinition` | ❌ | ✅ |
| `skills` | ❌ | ✅ |
| `permission_mode` / `can_use_tool` | ❌ | ✅ |

```powershell
python -c "import anthropic; print(hasattr(anthropic,'AgentDefinition'))"        # False
python -c "import claude_agent_sdk as s; print(hasattr(s,'AgentDefinition'))"    # True
```

本仓库当前钉的是 **`claude-agent-sdk==0.2.179`**（wheel 153 MB，内含 Claude Code CLI 二进制）。

`tests/test_runtimes_claude.py::TestSdkIsRealAgentSdk` 同时断言了「SDK 有这三个」
和「`anthropic` 没有这三个」——只验前者会被「两个都装了」这种情况蒙过去。

## 2. 两种工作模式

`ClaudeRuntime` 有两条路径，**事件翻译层共用**：

| 模式 | `use_sdk` | `base_url` 指向 | 谁跑工具循环 |
|---|---|---|---|
| SDK（默认） | `True` | — | `claude_agent_sdk` |
| 有 shim | `False` | `http://127.0.0.1:8765` | 我们自己（单轮） |
| 直连 Anthropic | `False` | `https://api.anthropic.com` | 我们自己（单轮） |

`endpoint_kind()` 返回 `sdk` / `shim` / `anthropic`，判据是**协议**不是名字：

- `use_sdk=True` → `sdk`
- 端口 8765 或路径含 `/shim` → `shim`（`tools/anthropic_shim.py` 把 Anthropic
  Messages 翻成 OpenAI `chat.completions`，**这是协议转换**）
- 其余 → `anthropic`（直连，**跳过 shim**）

**为什么要区分**：智-3 要求「需要转换才走 shim，直连就跳过」。一律走 shim 的代价是
多一跳无谓转换，而且会把「shim 坏了」和「端点坏了」混成同一个故障现象。

## 3. 实际 API（和网上教程不一样）

计划书里写的是 `ClaudeSDKClient(agent=agent)`，**真实签名是**：

```python
from claude_agent_sdk import (AgentDefinition, ClaudeAgentOptions, ClaudeSDKClient)

agent = AgentDefinition(
    description="野外台站值守智能体",
    prompt="…" ,
    tools=["station_health", "robust_stats"],
    disallowedTools=["execute_device_action"],
    model="deepseek-v4.1-flash",
    skills=["health", "qc"],
)
options = ClaudeAgentOptions(
    agents={"fsa-ops": agent},
    system_prompt="…",
    max_turns=12,
    allowed_tools=[...],
    disallowed_tools=[...],
    can_use_tool=callback,          # ← 审批门挂在这里
)
client = ClaudeSDKClient(options=options)
await client.connect()
await client.query(prompt)
async for message in client.receive_response():
    ...
```

> **以真代码为准，不以文档为准。**
> `inspect.signature(ClaudeSDKClient.__init__)` 是 `(options=None, transport=None)`，
> 没有 `agent=` 这个参数。

## 4. SDK 消息 → 九种事件

翻译在 `translate_sdk_message()`，**字段名与 `translate_anthropic` 完全一致**
（智-5 的要求：两侧习惯不同时改代码不改契约）。

| SDK 消息 | 内部事件 | 备注 |
|---|---|---|
| `SystemMessage(subtype=init)` | `session.start` | 只发一次 |
| `AssistantMessage` + `TextBlock` | `message.delta` | 每块一条 |
| `AssistantMessage` + `ToolUseBlock` | `tool.call` | `arguments` 是 **JSON 文本**，不是对象 |
| `UserMessage` + `ToolResultBlock` | `tool.result` | 工具真的跑完了 |
| `AssistantMessage.usage` | `usage` | `input_tokens` → `prompt_tokens` |
| `ResultMessage` | `message.done` | `is_error` 时先补一条 `error` |

### 两个坑（都踩过）

**坑一：`tool.result.name` 会变成空串。**
原先靠 `state["last_tool_name"]` 记「最后见过的工具」，工具一并行 name 就串了。
契约 §3.5 要求它与 `tool.call.name` 相同，所以改成按 `tool_use_id` 反查：

```python
state.setdefault("tool_names", {})[tool_id] = tool_name   # 在 tool.call 时记
name = state["tool_names"].get(tool_use_id, "")            # 在 tool.result 时查
```

空串**不报错**，前端只是把结果挂到错误的卡片上——所以有专门的测试
`test_tool_result_name_matches_call_name`。

**坑二：按类名精确分派太脆。**
SDK 内部有子类/包装，测试里也用假类，精确相等会静默漏掉整条消息。
`_kind_of()` 用**后缀**匹配。名单固定为四类；`StreamEvent` 之类不在名单里的事件
被忽略是有意的（我们不用增量流），但**名单内的四类必须都被处理**。

## 5. 审批门（安全边界只有这一处）

`can_use_tool` 是**唯一**能拦住高风险工具的地方。放在调用方等于任何直连接口
（脚本、另一个 AI）都能绕过。

回调做三件事，顺序不能变：

1. 先发 `approval.request` —— 界面立刻看到「在等人批」；
2. 问台账要结论，**带超时**；
3. 发 `approval.result`，然后才 return。

第 3 步必须在 return 之前发完，否则 SDK 已经开始执行工具了，而界面上的审批卡还停在 pending。

### 超时按拒绝（不许无限等）

```python
return await asyncio.wait_for(
    loop.run_in_executor(None, self.ledger.decide, tool_name, tool_input),
    timeout=self.approval_timeout_s)   # 默认 300s
```

台账本身可能是同步阻塞的（等人点界面），所以放线程里跑 + `wait_for` 兜底。
否则一个人走开就能把整个运行时挂住。超时语义与契约「审批过期按 rejected」一致。

### 默认一律不批

`DenyAllLedger` 是默认：任何调用都 `return False, "…一律拒绝"`。
`ScriptedLedger` 只给测试与本地演示用，**不要用于生产**。

这与 `agents/approval.py`「没有审批者时不给默认放行」是同一条纪律。

## 6. 不可用语义

`RuntimeUnavailable` 的语义不变：**服务不可用时明示，不自动切换**（ADR-009）。

- SDK 没装 → `available()` 返回 `False`，`run()` 抛 `RuntimeUnavailable`，
  错误信息里点明「注意 `anthropic` 是另一个包」
- 端口不通 → 同上
- 两种模式**都不自动回落**到另一种——自动切换会让「哪次用了谁」说不清

## 7. 验收

```powershell
# 1) 装对了
python -c "import claude_agent_sdk as s; print(s.__version__, hasattr(s,'AgentDefinition'))"

# 2) 接线对
python -m unittest tests.test_runtimes_claude -v      # 24 条

# 3) 九种事件齐（SDK 侧）
#    真跑一轮后数事件类型：session.start / message.delta / message.done /
#    tool.call / tool.result / approval.request / approval.result / usage / error
```

`approval.request` 与 `approval.result` **不由 SDK 产生**——它们来自 `can_use_tool`
回调，由 `ClaudeRuntime` 自己补进事件流。所以「九种齐」的验证必须包含一次
被审批门拦住的调用，否则那两种永远不会出现。

## 8. 归属

| 文件 | 归属 | 说明 |
|---|---|---|
| `src/fieldstation/runtimes/impl.py` | **B 线** | 本文件 |
| `requirements-v4.txt` | **A 线** | 钉版本 |
| `deps_smoke.py` | **A 线** | 加 `claude_agent_sdk` 探针 |
| `runtimes/base.py` | **A 线** | 事件类型定义，只读 |

**装包/改清单/加探针必须是同一次改动**——否则就会出现「装完了、清单没改、
门禁全绿、换台机器实际能力却缺失」这种最有欺骗性的缺口。
本仓库由 A 线统一执行这三件事。
