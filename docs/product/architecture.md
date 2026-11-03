# All powered-FSA · 架构

本文对应 [W0 契约](../superpowers/plans/2026-11-03-Agent桌面版-契约.md) 的 §1–§7 与 §10。
标记沿用 [README](README.md#状态标记)：**当前** = 代码已在仓库；**Wave 1** = 本轮并行落地中。

## 1 进程与端口

三层，全部在本机，全部只监听 `127.0.0.1`：

```text
AllPoweredFSA.exe            WinForms + WebView2 外壳
  └─ runtime\node.exe packages/app/src/server.ts --port 0
       stdout: "READY <nodePort>"
       └─ python tools/agent_server.py            （懒启动：首次访问 /api/agent/*）
            --port 0 --token <random>
            --node-url http://127.0.0.1:<nodePort> --repo <payload 根>
            stdout: "AGENT_READY <agentPort>"
```

| 进程 | 谁拉起 | 端口 | 发现方式 |
|---|---|---|---|
| 外壳 | 用户双击 | 无 | — |
| Node 服务 | 外壳 | `--port 0`，系统分配 | stdout `READY <port>`，外壳最多等 40 秒 |
| Python Agent | Node 桥，懒启动 | `--port 0`，系统分配 | stdout `AGENT_READY <port>` |

### token 与鉴权

- 外壳生成随机 token，写 `%LOCALAPPDATA%\AllPoweredFSA\runtime.json`，ACL 仅当前用户。
  **当前**：外壳的启动、`READY` 握手、`Kill(entireProcessTree)` 已实现；`runtime.json` 与 token
  的下发是 **Wave 1**（契约 §1）。
- Node → Python：`Authorization: Bearer <token>`。
- Python → Node：`X-FSA-Token: <token>`。
- token 不写日志；Node 桥启动失败返回 503 `{ok:false,error:"agent server unavailable: ..."}`，
  不吞掉原因，也不假装服务在线。

### 关闭

关窗口 → 外壳 `Kill(entireProcessTree)`。先 Python 后 Node 或整棵树一起结束都可以，要求只有一个：
不留后台进程。`--port 0` 是为了避免固定端口冲突；代价是每次启动端口都不同，所以端口只从 stdout
读，不写死。

## 2 事件模型

会话 JSONL 与 SSE 共用一套事件，一行 / 一个 `data:` 就是一个事件：

| `type` | 关键字段 | 说明 |
|---|---|---|
| `message` | `id`、`role`、`content`、`ts` | 用户或助手的一条消息 |
| `tool_call` | `id`、`name`、`args`、`risk`、`status` | 发起工具调用；`risk` 来自工具登记，不由模型给 |
| `tool_result` | `id`、`ok`、`summary`、`data`、`evidence`、`duration_ms` | 结果；`evidence` 至少含 `agent` 与 `call_id` |
| `approval` | `id`、`call_id`、`risk`、`reason`、`prompt`、`status` | `pending` / `approved` / `rejected` |
| `artifact` | `id`、`name`、`kind`、`path`、`sha256`、`source_call` | 产物；`path` 相对会话产物目录 |
| `plan` | `items[{title,status}]` | 多步计划，`todo/doing/done/blocked` |
| `error` | `class`、`message` | 五类：`environment`、`input`、`execution`、`artifact`、`capability` |
| `token` | `id`、`delta` | 流式增量 |
| `done` | `session_id` | 本轮结束 |

不变量：

1. **只追加，不改写。** `id` 在会话内唯一；重放就是把事件按顺序再渲染一遍。
2. **审批先行。** `approval.status=pending` 时，同一 `call_id` 不得出现 `tool_result`；
   决定之后先写 `approval`（含决定），再写 `tool_result`。顺序反了，事后就无法证明「谁批的」。
3. **错误不抛穿。** 任何一步失败都落 `error` 事件；未捕获异常会毁掉会话，也毁掉证据链。
4. SSE 帧：`event: agent\ndata: <json>\n\n`，结束时 `event: done`；不缓冲，逐块 flush。

## 3 三条工具通道

模型只认工具名。工具目录在服务端固定（`ToolRegistry.describe()` 给出 `name/description/risk/params`），
模型自造的名字查不到，也就不会被分发。

### local —— Python 直接调用 A 侧

| 工具 | 风险 | 做什么 |
|---|---|---|
| `station_health` | low | 台站读数健康度汇总 |
| `device_heartbeat` | low | 设备心跳三态（online / stale / offline / unknown） |
| `robust_stats` | low | 稳健统计 |
| `slip_detect` | low | 周跳检测 |
| `continuity_verdict` | low | 连续性判定 |
| `magnitude_verdict` | low | 量级越限判定 |
| `knowledge_search` | low | 知识库检索 |
| `create_work_order` | medium | 建工单（可撤） |
| `list_work_orders` | low | 列工单 |
| `execute_device_action` | **high** | 设备动作，必须过审批 |
| `archive_export` | low | 归档导出 |

### native —— Python → Node 现有 `/api/*`

| 工具 | 风险 | 对应接口 |
|---|---|---|
| `native_captures` | low | `GET /api/captures` |
| `native_records` | low | `GET /api/records?capture=&msgId=&offset=&limit=` |
| `native_ports` | low | `GET /api/ports` |
| `native_convert` | medium | `POST /api/convert` |
| `native_graph_projects` | low | `GET /api/graph/projects` |
| `native_graph_files` | low | `GET /api/graph/files?project=` |
| `native_graph_pdf` | low | `GET /api/graph/pdf?...`，落 artifacts |
| `native_live_status` | low | `GET /api/live/status` |
| `native_live_connect` | medium | `POST /api/live/connect` |
| `native_live_command` | medium | `POST /api/live/command` |
| `native_playback_info` | low | `GET /api/playback/info` |

### rpa —— Python → `tools/workflow_cli.py`

| 工具 | 风险 | 说明 |
|---|---|---|
| `workflow_list` | low | 列目录 |
| `workflow_describe` | low | 一条流程的完整定义 |
| `workflow_run` | 按流程 | `waiting_approval` / `waiting_operator` 必须发审批卡 |
| `workflow_status` | low | 读 `job.json` |
| `workflow_gate` | **high** | 批准即执行不可逆动作；只接受 `approved` / `rejected` |
| `workflow_resume` | medium | 人工任务完成；只接受 `done` / `failed` |
| `workflow_cancel` | medium | 取消未结束的 job |
| `workflow_artifacts` | low | 产物列表与下载 |

三条通道的共同规则：风险等级来自登记/流程规格，模型不能降级；失败落 `error` 事件；
不自动重试不可逆动作。风险与闸门的细节见 [security.md](security.md)。

## 4 会话存储

```text
%LOCALAPPDATA%\AllPoweredFSA\
  sessions\<id>.jsonl     # 事件流；第一行 meta，之后按 §2 追加
  artifacts\<id>\         # 会话产物
  settings.json           # provider / base_url / model / temperature
  secrets.bin             # API key，DPAPI（tools/secret_store.py）
  runtime.json            # 端口与 token，仅当前用户
  logs\                   # 本地日志
  jobs\                   # workflow jobs（NAS_WORKFLOW_JOBS 可覆盖）
```

JSONL 第一行固定是：

```json
{"type":"meta","session_id":"...","title":"...","created_at":"ISO"}
```

`GET /sessions/{id}` 原样返回事件数组，UI 直接重放渲染——没有第二套「展示态」数据，也就不会出现
「日志说的」和「界面说的」不一致。`jobs\` 放在 `app-<版本>` 之外，因为升级会删旧版本目录，
而流程回执必须跨版本留存。

## 5 打包结构

发布物是单文件 `AllPoweredFSA.exe`（WinForms + WebView2），payload 以 zip 资源内嵌，
由 `tools/build_payload.py` 组装。目录结构：

```text
runtime/node.exe                 # 自带 Node，用户不用装
runtime/python/                  # 可选：Python 3.11 embeddable（Agent / Workflows 用）
逆向/04_重实现/                   # 零依赖 TypeScript 重实现（含 serialport）
逆向/00_来源/samples/             # 首次可打开的样本抓包
逆向/01_解包/app/{view,model,assets,controller}
逆向/01_解包/Graph/out/renderer/assets
workflows/                       # 固定流程 YAML（不含 jobs/）
src/fieldstation/                # 流程执行器、智能体（纯标准库）
config/                          # 阈值、provider、agent 配置
tools/{workflow_cli,uia_driver,uia_selectors,agent_server,agent_store,secret_store,suite_launcher}.py
original/                        # 可选：--with-original 才带厂商套件
manifest.json                     # 每项的 file/byte 计数 + 名称和大小摘要
```

启动路径：

1. 外壳读内嵌 `payload.zip`，解压到 `%LOCALAPPDATA%\AllPoweredFSA\app-<版本>`，写 `.ready` 标记；
   已存在标记就跳过解压。旧 `app-*` 会被清理，删不掉（旧实例还占着）也不致命。
2. 外壳在 `app-<版本>\逆向\04_重实现` 下启动 `runtime\node.exe packages/app/src/server.ts --port 0`。
3. 外壳设三个环境变量：`FSA_ROOT`（payload 根）、`NAS_PYTHON`（payload 带 Python 时）、
   `NAS_WORKFLOW_JOBS`（`%LOCALAPPDATA%\AllPoweredFSA\jobs`）；
   `--with-original` 构建时另设 `FSA_SUITE_DIR`。
4. 读到 `READY <port>` 后 WebView2 导航过去；关窗杀整棵树。

重新打包的命令、版本号位置与发布四步，见
[逆向/05_打包/NovAtelReverseGui/README.md](../../逆向/05_打包/NovAtelReverseGui/README.md)。
payload 的输入清单以 `tools/build_payload.py` 为唯一准绳，`--check` 只列不写，适合在发布前核对。

## 6 为什么专业面板只读

专业面板（Manage / Playback / Convert / GRIT / Graph）复刻的是原版 2.11.0 的**读取与展示**行为。
写入不在面板里做，原因有三个：

1. **保真度要求默认镜像原版。** 原版有些行为看起来像 bug，重实现也照样镜像；镜像的前提是行为可测。
   一旦面板里多出一条「我们自己的写路径」，镜像就不再是镜像，差异也无法归因。
2. **不可逆动作不能有第二条路径。** 配置下发、固件升级、装应用失败会留下半套状态。固定流程把
   准备（只读）与提交（写）分开，中间放人工闸门；面板再开一条写路径，就绕过了闸门、锁与审计。
3. **证据只能有一个出口。** 流程 job 的 `audit.jsonl` 与 artifacts 是事后复核的唯一现场。
   面板直接写盘，产生的状态没有 `job_id`、没有哈希、没有决定人，出了事查不回来。

因此写操作统一走 `workflows/` 的固定流程，面板只负责「看清楚」。Workflows 页签与
`tools/workflow_cli.py` 读同一份 `describe`，界面与规格不会各说各话。

## 7 扩展

### 加一个工具

1. 在 `src/fieldstation/agents/tools/` 下新增模块，实现 `Tool` 协议：`name`、`description`、
   `params`、`risk`、`invoke(args) -> ToolResult`。
2. 在组装处 `register()` 进 `ToolRegistry`；重名会直接报错（已有此保护）。
3. 风险按后果定，不按代码复杂度定。不可逆或影响现场设备的，写 `high`；`config/actions/high_risk.json`
   里的动作名必须与工具口径一致。
4. 只读工具返回可回源的数字与规则编号；写工具返回回执（时间、目标、前后状态）。
5. 加单测：正常路径、拒绝路径、错误分类。纯标准库，不引第三方包。

### 加一条固定流程

1. 在 `workflows/<id>.yaml` 写规格。加载器只认
   `http` / `download` / `live_command` / `ensure_live` / `await_receiver` / `mark_cursor` /
   `file_digest` / `gui` / `verify_ui` / `human_gate` / `assert` / `artifact` / `sleep` 这些步骤；
   拼错的键在加载期就报错。
2. 含 `RESET` / `FRESET` 等不可逆步骤的，执行器在加载时强制要求 `approval.required: true`；
   闸门放在提交之前（准备步骤必须只读或可撤）。
3. `on_fail` 只有 `stop` / `continue`，没有 `retry`——不自动重刷固件。
4. 若对应原版 GUI 缺口，同步 `tools/gui_coverage.py` 的覆盖矩阵，`--check` 必须过。
5. 加执行器测试（stub 驱动，不启动真套件）与 CLI 用例。

### 加一个 native 接口

Node 侧新增 `/api/*` 后，在 `native_bridge.py` 加同名工具，风险按「是否改变接收机/文件状态」定，
并在契约 §5 的表里登记。桥只转发，不重写业务逻辑——两套实现必然漂移。

## 8 已知边界

- 只支持 Windows 10/11 x64；WebView2 必需。
- Agent 工作台的界面与 Node 代理是 **Wave 1**；Python 侧的 Agent 服务、会话存储与工具桥已有代码与单测。
- 流程执行器需要 Python 3.11；payload 不带 Python 时只有 Agent / Workflows 不可用。
- 串口路径依赖 payload 内的 `serialport`；缺了会明确报「列不出端口」，不会假装没有设备。
- 原版套件的写路径默认 `assisted`（人工完成），要机器点需 `--force-renderer-accessibility`
  并维护选择器表，见 [security.md](security.md#5-rpa-无坐标原则)。
