# All powered-FSA · 产品说明

一个 Windows 桌面程序，把两件事放进同一个窗口：**野外台站的日常运维** 和 **NovAtel 接收机套件的专业操作**。
双击 `AllPoweredFSA.exe` 就能用，不需要另装 Node.js 或 Python。

产品名是 **All powered-FSA**，可执行文件是 `AllPoweredFSA.exe`。本目录的四份文档都对应
[W0 接口契约](../superpowers/plans/2026-11-03-Agent桌面版-契约.md)（2026-11-03 冻结）：

## 当前发布物（2026-11-04）

| 项 | 值 |
|---|---|
| EXE | `dist/AllPoweredFSA-0.2.0-win-x64/AllPoweredFSA.exe` |
| 字节 / SHA256 | 904,169,047 B / `2ce2346bc4304edfe9070a3e35574f61848ae3736e74c28065333ed0eab70ce4` |
| payload | 852,065,709 B / 5223 项 / `6e9c4911df3fe32b6c716c11036638779f90271672676f53d06f6825f5f1c17a` |
| 内置 | Node 24、Python 3.11、B 引擎、样本、原版套件便携副本、8 条流程 |
| 首次启动 | 解压 payload（约 1.7 GB）到 `%LOCALAPPDATA%\AllPoweredFSA\app-0.2.0.0`，然后起本地服务并打开 WebView2 |
| 构建记录 | `dist/AllPoweredFSA-0.2.0-win-x64/release.json` |

> 原版套件随包只用于本机演示/比赛；对外分发前请自行确认 NovAtel 的再分发许可。

| 文档 | 回答什么 |
|---|---|
| 本页 | 它是什么、怎么开始用、日常能做什么、数据放哪 |
| [architecture.md](architecture.md) | 进程、端口、事件、三条工具通道、打包结构 |
| [security.md](security.md) | 审批边界、密钥、日志、RPA、再分发 |
| [acceptance.md](acceptance.md) | 干净机上逐项可勾的验收清单 |

## 状态标记

文档里出现这三种标记时，含义是固定的：

| 标记 | 含义 |
|---|---|
| **当前** | 仓库里已有代码，按文档描述的行为可以复现 |
| **当前** | 本轮桌面版（契约 §10 的 WP1–WP7）正在并行落地；合入后按本页验收 |
| **之后** | 契约里没有排期，不要当成已有能力 |

现在的实际情况：专业面板（六个页签）、Workflows、`AllPoweredFSA.exe` 外壳、payload 组装、
Agent 工作台（三栏对话 + 工具/审批/产物卡）、Python Agent 服务、会话存储与三条工具桥
都已是 **当前**（版本 `0.2.0`）。本页描述的就是已经能点的行为；逐项见
[acceptance.md](acceptance.md)。唯一默认不联网的是模型通道：未配 key 时用 `fake` 演示，
配 OpenAI 兼容或 Ollama 后走真模型。

## 它是什么

台站侧解决的是「没人守着」：供电、蓄电池、在线率、网络时延、探头温度散在不同系统里，出问题要等
下次巡检；观测数据也要靠有经验的人逐段看。产品把这条链路交给一组智能体，但**规则裁决、模型归因**：
低置信度与高风险判断落到人工审批门，模型不自己下结论。

接收机侧解决的是「厂商只给二进制」：NovAtel Application Suite 2.11.0 的 Manage / Playback /
Convert / GRIT / Graph 被重实现成零依赖 TypeScript，行为默认镜像原版，差异放在显式开关后。
本产品把它内嵌进同一个窗口，专业面板就是这套重实现。

两边共用的纪律只有一条：**每个对外数字都能回源，每个动作都留证据**。工具卡上的 `agent:call_id`、
产物旁的 `sha256`、流程 job 里的 `audit.jsonl`，都是这条纪律的落地。

## 两种模式

顶栏切换两个模式，互不遮挡：

### Agent 工作台（当前）

默认页。三栏布局：

| 区域 | 放什么 |
|---|---|
| 左（280） | 会话与任务列表 |
| 中（自适应） | 对话；assistant 全宽 markdown，user 右对齐气泡 |
| 右（320） | 当前设备、日志、产物 |

窗口窄于 1100 收右栏，窄于 800 再收左栏。中间除了文字，还有五种卡片：工具卡、审批卡、产物卡、
失败卡、计划卡。工具卡显示名称、状态、耗时、可折叠的 JSON，以及证据号 `agent:call_id`。
快捷键 `Ctrl+N` 新会话、`Ctrl+K` 命令面板、`Esc` 取消生成；输入框 `Enter` 发送、`Shift+Enter` 换行。

空态给四个建议 chip：健康度 / 质控 / 导出 PDF / 重启——正好覆盖下面「日常任务」里最常用的四条。

### 专业面板（当前）

现有六个页签：**Manage / Playback / Convert / GRIT / Graph / Workflows**，另有主页
「My Applications」与配置抽屉。它们不是「简化版」：默认行为与原版 2.11.0 一致，包括看起来像
bug 的地方；原版静默丢弃的字节、静默忽略的 CRC 不匹配，这里通过 `onDrop` / `crcOk` 暴露，
但不改变消费决策。

**专业面板不做写操作。** 配置下发、固件升级、装应用这类不可逆动作，一律走 Workflows 的固定流程
（人工闸门 + 审计 + 证据），不在面板里另开一条写路径。原因写在
[architecture.md §6](architecture.md#6-为什么专业面板只读)。

## 第一次启动

前置只有两样：Windows 10/11 x64，以及 WebView2 Runtime（一般随 Edge 已装）。

1. 双击 `AllPoweredFSA.exe`。首次启动会把内嵌的 payload 解压到
   `%LOCALAPPDATA%\AllPoweredFSA\app-<版本>`，这一步是几百 MB 级，需要等一会儿。
2. 外壳用自带的 `runtime\node.exe` 启动本地服务（`--port 0`，端口由系统分配），
   读到 stdout 的 `READY <端口>` 后把 WebView2 指过去；超过 40 秒没读到就报错退出，不会停在白屏。
3. 之后每次启动直接复用已解压的目录；换版本会解压新目录并清理更早的 `app-*`。
4. 关窗口时外壳 `Kill(entireProcessTree)`，Node 与它拉起的 Python 一起结束，不留后台进程。

打开后看到什么：**当前** 起默认落在 Agent 工作台；在此之前，源码里的默认页仍是
My Applications，Agent 从页签或顶栏模式切换进入（同样属于 当前）。

首次启动的模型通道有个特殊约定：默认配置是 `openai_compatible`，但还没填 key，于是**自动回退
`fake` 并在界面上说明**。这样第一次打开一定能用，也不会拿着空 key 去请求。

## 模型通道

三条通道，都在设置里选，不需要改代码：

| 通道 | 用途 | 说明 |
|---|---|---|
| `fake` | 确定性演示，默认兜底 | 不联网、不产生费用；同样的输入给同样的回答，适合验收与录屏 |
| `openai_compatible` | 任意讲 `/v1/chat/completions` 的服务 | 填 `base_url`、`model`、`temperature` 与 key；支持 `stream=true`（SSE） |
| `ollama` | 本机模型 | 沿用现有配置，`config/providers.json` 里的地址与模型可覆盖 |

要点：

- `base_url` **只填到主机和前缀，不要带 `/v1`**。请求路径是 `base_url + /v1/chat/completions`，
  填成 `https://host/v1` 会变成 `/v1/v1/...`，错误消息里带完整 URL，一眼能看出来。
- `settings.json` 只存 `provider`、`base_url`、`model`、`temperature`；**key 只进
  `secrets.bin`**，用 Windows DPAPI 按当前用户加密。设置接口只回 `has_key`，永不回声 key。
- 流式回答必须见到 `[DONE]` 或 `finish_reason` 才算完整；半截回答按「流中断」报错，
  不会把未完成的文字当成结论。

## 日常任务示例

下面七条是产品设计里最常走的路径。「审批」一列说明用户会被要求做什么；「证据」一列说明事后能在
哪里核对。

| 想做什么 | 可以怎么说 | 走哪条通道 | 审批 | 证据 |
|---|---|---|---|---|
| 看台站健康度 | 「现在台站怎么样」 | `station_health`、`device_heartbeat` | 无 | 读数、阈值、判定时间 |
| 做数据质控 | 「检查今天这段观测」 | `robust_stats`、`slip_detect`、`continuity_verdict`、`magnitude_verdict` | 无 | 逐条判定 + 规则编号 |
| 导出 PDF | 「把这个工程导成 PDF」 | `native_graph_pdf` 或流程 `gui.graph.export` | 无 | 产物卡 + `sha256` |
| 重启接收机 | 「重启 8 号串口那台」 | 流程 `script.device.restart` | **要**（工作流级） | `restart.json`：RESET 回执、回来后的 VERSION |
| 新建工程 | 「用这份 SBF 建个工程」 | 流程 `gui.graph.newproject` | **要**（Process 之前） | 工程目录、四步预处理回执 |
| 加设备 | 「把新接收机加进来」 | 流程 `gui.device.add` | 无 | 端口扫描、连接、VERSION 回读 |
| 装应用 | 「装上这个应用包」 | 流程 `gui.app.install` | **要**（Install 之前） | 装包哈希、安装回执、应用列表 |

两条硬规则：

1. **模型只能按名字调工具。** 工具目录在服务端固定，模型自造的工具名不会被分发。
2. **不可逆动作必须过人。** `workflow_run` 返回 `waiting_approval` / `waiting_operator` 时，
   界面必须出现审批卡；批准前同一 `call_id` 不会出现 `tool_result`。

## 审批与证据

审批卡是琥珀色边框，写明三件事：**动作**（要做什么，带参数）、**风险**（来自工具/流程定义，
模型改不了）、**影响**（失败或不可逆会发生什么）。用户可以批准、拒绝，并留一句备注。
决定后卡片禁用，显示决定人与时间。

证据分三层，互相能对上：

| 层 | 在哪 | 用来回答 |
|---|---|---|
| 会话事件 | `sessions/<id>.jsonl` | 这次对话里，谁在什么时候调了什么、结果如何 |
| 工具证据 | `tool_result.evidence` 的 `agent:call_id` | 这条结论对应哪一次工具调用 |
| 流程现场 | `jobs/<job_id>/` 的 `job.json`、`audit.jsonl`、`artifacts/` | 具体到某一步：开始、闸门、决定人、产物哈希 |

产物一律带 `sha256` 与 `source_call`。失败不粉饰：环境、输入、执行、产物、能力五类错误分别落
`error` 事件，界面显示失败卡；「不动」始终是一个选项，拒绝后就停，不自动重试。

## 专业面板

六个页签覆盖原版套件的主要工作面：

| 页签 | 做什么 |
|---|---|
| Manage | 19 个配置页与 11 个状态瓦片；AGC、电源、温度等只读观测 |
| Playback | 工程回放、事件带、时间轴与地图联动 |
| Convert | 9 种格式的转换向导与结果 |
| GRIT | 频谱、Signal Matrix、事件与终端 |
| Graph | 图表 / 地图 / 时间轴三块工程编辑区，8 页 PDF 导出 |
| Workflows | 固定流程目录、参数、审批门、失败分类、证据下载 |

它们与 Agent 工作台共用同一个本地服务和同一份数据；Workflows 页签与命令行读的是同一份
`describe`，所以界面不会与流程规格漂移。

## 数据目录

所有用户数据集中在一个目录，方便备份、迁移与卸载：

```text
%LOCALAPPDATA%\AllPoweredFSA\
  app-<版本>\          # 解压后的 payload（Node 运行时、重实现、流程、工具）
  webview2\            # WebView2 用户数据
  sessions\<id>.jsonl  # 会话事件，只追加
  artifacts\<id>\      # 会话产物（PDF / CSV / JSON / PNG）
  jobs\                # Workflow job：job.json、audit.jsonl、artifacts\
  settings.json        # provider / base_url / model / temperature
  secrets.bin          # API key，DPAPI 按当前用户加密
  runtime.json         # 端口与 token，权限仅当前用户
  logs\                # 本地日志（不含 key / token）
```

`jobs\` 故意放在 `app-<版本>` 外面：升级会删旧版本目录，而流程回执必须留得住。

## 卸载

程序不装服务、不写系统目录，也没有安装器。卸载就是三步：

1. 关掉窗口（外壳会结束整棵进程树）。
2. 需要留证据的话，先把 `jobs\` 与 `artifacts\` 拷走。
3. 删除 `%LOCALAPPDATA%\AllPoweredFSA\` 与手边的 `AllPoweredFSA.exe`。

`secrets.bin` 删掉就等于吊销本机保存的 key；同一份文件换一台机器或换一个 Windows 账户都解不开，
这是 DPAPI 用户作用域的设计，不是故障。

## 常见问题

**窗口一直白屏，或提示 40 秒内没 READY。**
先确认 exe 完整（比对发布页的 SHA256），再确认 WebView2 Runtime 在。外壳的 `payload.zip` 是内嵌的，
缺了会在启动时直接报 `payload.zip is missing from this build`，不会白屏。

**Agent 页签说服务不可用（503）。**
服务端是懒启动的：第一次访问 `/api/agent/*` 才拉起 Python。失败时接口返回
`agent server unavailable: ...` 并说明原因。payload 里带 `runtime\python\` 时外壳会设 `NAS_PYTHON`；
没有 Python 就只有 Agent 不可用，其余页面不受影响。

**Workflows 页签说「工作流不可用」。**
同上，流程执行器需要 Python 3.11。`NAS_PYTHON` 指过去即可；`NAS_WORKFLOW_JOBS` 可以换 job 目录。

**Add Device 列不出串口。**
payload 必须带 `packages/app/node_modules/` 里的 `serialport`。发布包已经带上；自己重新组装
payload 时用 `python tools/build_payload.py`，别手工挑文件。

**填了 key，请求还是 401。**
先看 `base_url` 有没有多写 `/v1`（会变成 `/v1/v1/...`），再看 key 是否属于这个服务。
设置页只显示 `has_key`，不回显内容；要换 key 直接覆盖保存。

**换电脑后提示 key 解不开。**
预期行为。DPAPI 是「当前 Windows 用户」作用域，重填一次即可；`secrets.bin` 不要跨机拷贝。

**模型答得像模像样，但数字不对。**
以工具结果为准，不以模型叙述为准。所有对外数字都该能在工具卡或产物里回源；回不到源的说法，
按未验证处理。

**端口会不会被外面访问。**
不会。Node 与 Python 都只监听 `127.0.0.1`，端口是系统分配的临时端口；跨进程调用要带 token，
token 写在只有当前用户能读的 `runtime.json` 里。

## 相关文档

- 契约（冻结）：[2026-11-03-Agent桌面版-契约.md](../superpowers/plans/2026-11-03-Agent桌面版-契约.md)
- 固定流程：[workflows/README.md](../../workflows/README.md)
- 打包与发布：[逆向/05_打包/NovAtelReverseGui/README.md](../../逆向/05_打包/NovAtelReverseGui/README.md)
- 重实现说明：[逆向/04_重实现/README.md](../../逆向/04_重实现/README.md)
- 已知问题：[docs/known-issues.md](../known-issues.md)
