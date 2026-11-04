# Agent 内部事件协议（E1）

- 状态：**W0 冻结**（2026-11-05）
- 适用：运行时 A（OpenCode / OpenChamber）与运行时 B（Claude Agent SDK）
- 代码锚点：`src/fieldstation/runtimes/base.py`（`TYPES` / `Event`）、`src/fieldstation/runtimes/sse.py`（两个协议的翻译）
- 关联：ADR-001、ADR-009、`docs/spec/2026-11-04-v3-四视角双运行时.md` §4、ADR-004（结论契约）
- 一句话：**UI 与台账只认这九个事件；两个运行时各自把原生流翻译成同一套 `{type, session_id, data}`。**

---

## 0. 为什么要有这一层

两个运行时的原生事件既不同名也不同形：

- OpenCode 走 OpenAI 兼容的 `chat.completion.chunk`，工具调用还是按 `index` 分片到达；
- Claude Agent SDK 走 Anthropic Messages 的 `message_start / content_block_delta / message_stop`。

如果 UI 直接读原生流，换运行时就要改界面，四视角的"状态共享"立刻破功。所以协议只做一件事：
**把"开始、增量、结束、调工具、工具结果、要审批、审批结果、用量、错误"这九件事固定下来**，
其余字段都是 `data` 里的细节。

## 1. 信封（所有事件共用）

```json
{"type": "message.delta", "session_id": "ses-01", "data": {"text": "…"}}
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `type` | string | 是 | 九个事件类型之一；未知类型必须报错，不许静默丢弃 |
| `session_id` | string | 是 | 运行时自己的会话 id；同一轮内不变 |
| `data` | object | 是 | 事件负载；按 `type` 取 §3 的字段表 |
| `seq` | integer | 否 | 单调递增序号，从 1 起；断号说明有事件被丢 |
| `ts` | string | 否 | UTC ISO 8601 毫秒；**不参与回放比对**，只用于排障 |
| `turn_id` | string | 否 | 一轮用户输入的 id；缺省时由消费方按 `message.done` 切分 |

三个硬约束：

1. **只追加，不改写。** 事件流是事实，不是视图；补正只能追加新事件。
2. **`data` 必须可 JSON 序列化。** 二进制一律走产物引用（`artifact_ref`），不塞 base64。
3. **未知 `type` 直接失败。** `coerce_events()` 的做法是抛 `ValueError`；吞掉会让 UI 少画一张审批卡。

## 2. 九个事件（索引）

| 编号 | 类型 | 方向 | 何时发 | 一轮内次数 |
|---|---|---|---|---|
| EVT-01 | `session.start` | 运行时 → UI | 运行时确认会话可用（首字节之前） | 1 |
| EVT-02 | `message.delta` | 运行时 → UI | 助手文本增量 | 0..N |
| EVT-03 | `message.done` | 运行时 → UI | 本轮助手消息结束（含工具轮） | ≥1 |
| EVT-04 | `tool.call` | 运行时 → UI | 模型发起一次工具调用（参数已拼完整） | 0..N |
| EVT-05 | `tool.result` | 运行时 → UI | 工具执行完成（成功或失败都发） | 与 `tool.call` 一一对应 |
| EVT-06 | `approval.request` | 运行时 → UI | 工具风险命中审批门，等待人决定 | 0..N |
| EVT-07 | `approval.result` | 人/审批器 → 运行时 → UI | 审批有了结论 | 与 `approval.request` 一一对应 |
| EVT-08 | `usage` | 运行时 → 指标旁路 | 一次 provider 调用的 token 用量 | 0..N |
| EVT-09 | `error` | 运行时 → UI | 环境/输入/执行/产物/能力/审批/通道错误 | 0..N |

顺序不变量（测试与回放都按这个查）：

```
session.start
  → (message.delta | tool.call | usage | error)*
  → message.done
tool.call → [approval.request → approval.result] → tool.result
approval.request(status=pending) 期间，同一 call_id 不得出现 tool.result
approval.result 必须先于对应 tool.result 落盘
```

## 3. 逐事件字段表

### 3.1 `session.start`（EVT-01）

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `runtime` | string | 是 | `opencode` / `claude` / `fake`；UI 用它显示"当前运行时" |
| `model` | string | 否 | 实际模型 id，如 `deepseek-v4.1-flash` |
| `agent` | string | 否 | 特化 agent 名（`ops` / `qc` / `fault_diagnosis` …） |
| `resumed` | boolean | 否 | 是否续接已有会话 |
| `parent_session_id` | string | 否 | 子会话指向父会话（编队下钻） |
| `toolset_rev` | string | 否 | 工具表版本（`mcp-tools.md` 的 sha256 前 12 位） |

### 3.2 `message.delta`（EVT-02）

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `text` | string | 是 | 本次增量文本；按到达顺序直接拼接 |
| `message_id` | string | 否 | 同一助手消息的 id；缺省时按 `message.done` 归并 |
| `index` | integer | 否 | 增量序号，从 0 起；用于发现丢块 |

### 3.3 `message.done`（EVT-03）

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `reason` | string | 是 | `stop` / `tool_calls` / `length` / `done` / `cancel` / `error` |
| `content` | string | 否 | 完整文本；给了就必须等于所有 `delta.text` 的拼接 |
| `message_id` | string | 否 | 与 `message.delta.message_id` 对齐 |

### 3.4 `tool.call`（EVT-04）

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `id` | string | 是 | `call_id`，形如 `t0001`；证据引用只认它 |
| `name` | string | 是 | MCP 工具名，必须在 `mcp-tools.md` 的 30 条里 |
| `arguments` | string | 是 | JSON 文本（不是对象）；空参数写 `"{}"` |
| `risk` | string | 否 | `low` / `medium` / `high`；来自工具登记，**模型不能改** |
| `approval` | string | 否 | `none` / `required` / `granted`；与审批表一致 |

### 3.5 `tool.result`（EVT-05）

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `id` | string | 是 | 与 `tool.call.id` 相同 |
| `name` | string | 是 | 与 `tool.call.name` 相同；不一致按协议错误处理 |
| `ok` | boolean | 是 | 成败只看它，不看 `data` 里有没有键 |
| `data` | object | 否 | 成功时的返回；形状见 `mcp-tools.md` 对应行 |
| `error` | object | 否 | 失败时必填：`{code, message, retryable, details?}` |
| `duration_ms` | integer | 否 | 工具自身耗时 |
| `truncated` | boolean | 否 | 返回被截断（行数/字节超限） |
| `artifact_ref` | object | 否 | `{name, sha256, bytes, path}`；大产物只给引用 |

### 3.6 `approval.request`（EVT-06）

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `approval_id` | string | 是 | 审批单 id，形如 `ap-01` |
| `call_id` | string | 是 | 要批的那次调用 |
| `name` | string | 是 | 工具名 |
| `risk` | string | 是 | `low` / `medium` / `high` |
| `reason` | string | 是 | 为什么需要批（动作影响，不是复述参数） |
| `prompt` | string | 是 | 给人看的一句话问句 |
| `expires_at` | string | 否 | 过期时间；过期按 `expired` 处理，不默认放行 |
| `requested_by` | string | 否 | 发起方（运行时/agent） |

### 3.7 `approval.result`（EVT-07）

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `approval_id` | string | 是 | 对应 `approval.request.approval_id` |
| `call_id` | string | 是 | 对应调用 |
| `verdict` | string | 是 | `approved` / `rejected` / `expired` |
| `by` | string | 是 | 决定人；自动放行写 `auto` |
| `note` | string | 否 | 备注；拒绝时建议必填 |
| `decided_at` | string | 否 | UTC ISO 8601 毫秒 |

### 3.8 `usage`（EVT-08）

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `prompt_tokens` | integer | 是 | 输入 token |
| `completion_tokens` | integer | 是 | 输出 token |
| `total_tokens` | integer | 否 | 两者之和；缺省由消费方相加 |
| `cache_read_tokens` | integer | 否 | 命中缓存的输入 token |
| `model` | string | 否 | 产生这次用量的模型 |
| `duration_ms` | integer | 否 | 本次 provider 调用耗时 |

### 3.9 `error`（EVT-09）

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `class` | string | 是 | `environment` / `input` / `execution` / `artifact` / `capability` / `approval` / `provider` |
| `message` | string | 是 | 人能读的原因；带关键字段，不写"失败"两个字了事 |
| `code` | string | 否 | `E_*` 错误码（见 `mcp-tools.md` §2） |
| `retryable` | boolean | 否 | 是否值得重试；不可逆动作恒为 `false` |
| `call_id` | string | 否 | 关联的工具调用 |
| `detail` | object | 否 | 结构化上下文（端口、路径、HTTP 状态） |

## 4. 两个运行时怎么映射

### 4.1 运行时 A · OpenCode（OpenAI 兼容 SSE）

适配位置：`runtimes/sse.py::translate_openai`。

| 原生来源 | 内部事件 | 映射规则 |
|---|---|---|
| 首个 `choices[].delta` 或 `[DONE]` 之前 | `session.start` | `data.runtime="opencode"`，只发一次 |
| `choices[].delta.content` | `message.delta` | `data.text` 原样 |
| `choices[].delta.tool_calls[]` | 先缓存，`finish_reason` 时发 `tool.call` | 按 `index` 拼 `id/name/arguments`；`arguments` 保持 JSON 文本 |
| `choices[].finish_reason` | `message.done` | `stop` / `tool_calls` / `length` 原样；`data.reason=finish` |
| `usage` 对象 | `usage` | `prompt_tokens` / `completion_tokens` 原样 |
| SSE 不是合法 JSON | `error` | `class="execution"`，`message` 带解析失败原因 |
| HTTP 连不上 / 端口没起 | `error` | `class="environment"`，`retryable=true`；不冒充"回答失败" |
| OpenCode 插件事件 `permission.asked` / `permission.replied` | `approval.request` / `approval.result` | 仅运行时 A 装配层使用；OpenAI 兼容端点本身没有审批概念 |

### 4.2 运行时 B · Claude Agent SDK（Anthropic Messages）

适配位置：`runtimes/sse.py::translate_anthropic`。

| 原生来源 | 内部事件 | 映射规则 |
|---|---|---|
| `message_start` | `session.start` | `data.runtime="claude"`，只发一次 |
| `content_block_delta` + `text_delta` | `message.delta` | `data.text=delta.text` |
| `content_block_start(type=tool_use)` | 先缓存 | 记 `id/name` |
| `content_block_delta` + `input_json_delta` | 继续缓存 | 累加 `partial_json` |
| `content_block_stop`（工具块） | `tool.call` | `arguments` 为拼好的 JSON；空则 `"{}"` |
| `message_delta.stop_reason` | 暂存 | `end_turn→stop`、`tool_use→tool_calls`、`max_tokens→length` |
| `message_delta.usage` | `usage` | `input_tokens→prompt_tokens`、`output_tokens→completion_tokens` |
| `message_stop` | `message.done` | `data.reason` 用暂存的 stop_reason |
| SDK `can_use_tool` 回调 | `approval.request` | 回调返回 allow/deny 后再发 `approval.result` |
| `result` 子类型 `error_*` / 传输异常 | `error` | `class="provider"` 或 `environment`，不伪造 `message.done(reason=stop)` |

### 4.3 与现有实现/台账的对齐

| 现有来源 | 内部事件 | 说明 |
|---|---|---|
| `docs/product/architecture.md` 的 `message` | `message.delta` + `message.done` | 会话 JSONL 里的完整消息拆成增量与结束 |
| 现有 `token` | `message.delta` | 字段名从 `delta` 改为 `text`；适配层做一次改名 |
| 现有 `tool_call` | `tool.call` | `name/args` 改为 `name/arguments`（字符串） |
| 现有 `tool_result` | `tool.result` | 增加 `error.code` 与 `artifact_ref` |
| 现有 `approval` | `approval.request` + `approval.result` | 一个事件按 `status` 拆成两个；`pending` 只发 request |
| 现有 `done` | `message.done` | `session_id` 保留在信封，不重复进 `data` |
| ADR-004 的 trace `tool_call/tool_result` | `tool.call/tool.result` | `call_id` 即 trace 的 `t0001`；结论 `evidence[].call_id` 直接引用 |
| ADR-004 的 trace `approval` | `approval.result` | 审批记录进 trace，时间戳仍走旁路 |

## 5. 完整事件序列样例（JSON Lines）

### 5.1 高风险动作被拒绝（含审批）

```jsonl
{"type":"session.start","session_id":"ses-01","data":{"runtime":"opencode","model":"deepseek-v4.1-flash","agent":"ops","resumed":false}}
{"type":"message.delta","session_id":"ses-01","data":{"text":"我先汇总 WUHN 的读数，再决定是否重启。"}}
{"type":"tool.call","session_id":"ses-01","data":{"id":"t0001","name":"station_health","arguments":"{\"readings\":[]}","risk":"low","approval":"none"}}
{"type":"tool.result","session_id":"ses-01","data":{"id":"t0001","name":"station_health","ok":true,"data":{"stations":[],"summary":{"total":0,"missing":0,"alerts":[]}},"duration_ms":8}}
{"type":"message.delta","session_id":"ses-01","data":{"text":"读数缺测率 12%，建议重启接收机。"}}
{"type":"tool.call","session_id":"ses-01","data":{"id":"t0002","name":"execute_device_action","arguments":"{\"station_id\":\"WUHN\",\"action\":\"restart_receiver\",\"reason\":\"连续 3 小时无心跳\",\"confidence\":0.93}","risk":"high","approval":"required"}}
{"type":"approval.request","session_id":"ses-01","data":{"approval_id":"ap-01","call_id":"t0002","name":"execute_device_action","risk":"high","reason":"远程重启会中断观测，失败可能无法自动恢复","prompt":"批准重启 WUHN 接收机？","expires_at":"2026-11-05T09:40:00.000Z","requested_by":"ops"}}
{"type":"approval.result","session_id":"ses-01","data":{"approval_id":"ap-01","call_id":"t0002","verdict":"rejected","by":"operator-7","note":"改约 22:00 维护窗口","decided_at":"2026-11-05T09:31:12.000Z"}}
{"type":"tool.result","session_id":"ses-01","data":{"id":"t0002","name":"execute_device_action","ok":false,"error":{"code":"E_APPROVAL_DENIED","message":"未获人工批准，未执行","retryable":false},"duration_ms":0}}
{"type":"message.delta","session_id":"ses-01","data":{"text":"重启未执行；已改为建单并附证据。"}}
{"type":"tool.call","session_id":"ses-01","data":{"id":"t0003","name":"create_work_order","arguments":"{\"station_id\":\"WUHN\",\"title\":\"接收机无心跳\",\"priority\":\"P1\",\"risk\":\"medium\",\"evidence_call_ids\":[\"t0001\"]}","risk":"medium","approval":"none"}}
{"type":"tool.result","session_id":"ses-01","data":{"id":"t0003","name":"create_work_order","ok":true,"data":{"work_order_id":"wo-7f3a","status":"open"},"duration_ms":5}}
{"type":"message.done","session_id":"ses-01","data":{"reason":"stop","content":"重启未执行；已改为建单并附证据。"}}
{"type":"usage","session_id":"ses-01","data":{"prompt_tokens":2140,"completion_tokens":412,"total_tokens":2552,"model":"deepseek-v4.1-flash","duration_ms":1830}}
```

### 5.2 运行时不可用（错误路径）

```jsonl
{"type":"session.start","session_id":"ses-02","data":{"runtime":"claude","model":"deepseek-v4.1-flash","agent":"ops"}}
{"type":"error","session_id":"ses-02","data":{"class":"environment","code":"E_UNAVAILABLE","message":"Claude 运行时端口 8765 未监听","retryable":true,"detail":{"port":8765}}}
{"type":"message.done","session_id":"ses-02","data":{"reason":"error","content":""}}
```

### 5.3 回放校验

1. 按 `seq`（若给出）排序；断号即失败。
2. 每个 `tool.result.id` 必须有同 id 的 `tool.call`；`name` 必须一致。
3. 每个 `approval.request.call_id` 在 `approval.result` 之前不得有 `tool.result`。
4. `verdict != approved` 时，对应 `tool.result.ok` 必须为 `false`。
5. 所有 `message.delta.text` 拼接必须等于最后一条 `message.done.content`（若给了 `content`）。
6. `usage` 只进指标旁路，不参与逐字节回放比对。

## 6. 消费方必须做的事

| 消费方 | 必须做 | 不许做 |
|---|---|---|
| 对话视角 | 按 `type` 渲染；审批卡用 `approval.request`，决定后禁用 | 用 `message.delta` 拼出"已完成" |
| 编队视角 | 把 `tool.call/tool.result` 挂到任务树的 step | 拿 `usage` 当业务结果 |
| 数据视角 | 引用 `tool.result.data` 里的行数/分区 | 自己重算工具已给的数字 |
| 套件视角 | 用 `artifact_ref.sha256` 回源 | 用路径猜产物 |
| 台账 | 存 `session_id + call_id + approval_id` | 存 `ts` 当业务时间 |
