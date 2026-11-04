# 变更记录

本仓库有两条线，各自记版本：

| 线 | 版本形态 | 现在 |
|---|---|---|
| **重实现 GUI**（`NovAtelReverse`，交付物 B 的产物） | `0.1.x`，跟 `逆向/05_打包/NovAtelReverseGui/NasGui.csproj` 的 `<Version>` 走 | `0.2.0`（All powered-FSA） |
| **野外台站智能体**（交付物 A） | 按阶段 M0 — M7 推进，不打语义化版本 | M0、M4 已完成；M6 无人值守前置已落地 |

规则：一个版本号对应一次 `dotnet publish`，exe 的 SHA256 与发布说明一起记在 Release 里；
只用 `0.1.0` 起的递增号，跳号表示那版没出。

## 2026-11-04（v4 实施基线）

**Electron 壳 · 套件台重做 · RPA 先收口**

| 项 | 内容 |
|---|---|
| 壳 | 改用 OpenChamber 的 **Electron** 壳（体积不再设上限）；窗口逻辑不再自己写 |
| 套件台 | 判定"UI 太烂"，**重做**：保留原版信息架构与数据契约，重建组件层（Tailwind + shadcn 风格，三栏 + 检查器 + 密度切换）；`modern.css` 叠皮做法退役 |
| RPA | 先收口：校准工具（dump 可交互元素 → 生成选择器 + diff）· DOM fixture 回放（无套件也能在 CI 抓失效）· 通道升级（能走 API/CLI 就绕 GUI）· 真机验收清单（缺硬件标 `blocked: hardware`） |
| 其余 | 四视角等价、双 Agent 运行时、Bot 三组件、数据双引擎保持不变 |
| 周期 | 约 19 周（RPA 2 周 + 套件台 3 周是新增的主要工期） |
| 状态 | 代码未动；W0 出契约与三个假设的验证结果 |

## 2026-11-04（v3 定稿，已被 v4 取代）

**四个等价视角 · 双 Agent 运行时 · Bot 三组件 · 数据双引擎**

| 项 | 内容 |
|---|---|
| 四视角 | 对话 / 编队 / 数据 / 套件——**能力不分区**，共享同一会话池/任务表/工具/trace，跨视角深链 |
| E1 双运行时 | OpenChamber+OpenCode 与 Claude Agent SDK（官方），**各自独立完成全部任务、互不依赖**；后者接 deepseek 走 `anthropic_shim`，缺了不影响它自己干活 |
| E2 三组件 | DBOS（执行真相）· LangGraph（推理真相）· Letta（记忆真相），用 `run_link` 串联；交互层＝任务树＋事件流＋三种干预＋可与大 bot 对话/下钻小 bot |
| E4 双引擎 | 一份 Parquet 为真相；DuckDB 默认、ClickHouse 随包可选，自动回落并明示 |
| 命名 | 第四个台定名 **套件台 Suite**（原"专业面板/专业台"退役） |
| 体积 | 预算 1.5–1.6 GB（+300 MB 来自 ClickHouse 与第二运行时），W0 实测 |
| 状态 | 代码未动；W0 先验三个假设（Letta 内嵌 / shim / 体积） |

## 2026-11-04（v2 立项，已被 v3 取代）

**四个台 + 七个引擎；界面底座三选一（待拍板），循环收敛到 LangGraph**

| 项 | 内容 |
|---|---|
| 决策 | [ADR-008 界面底座与四台](docs/decisions/2026-11-04-界面底座与四台.md)、[ADR-009 七引擎与工具面](docs/decisions/2026-11-04-七引擎与工具面.md) |
| 设计 | [v2 设计：四个台 · 七个引擎](docs/spec/2026-11-04-v2-四台七引擎.md) |
| 四台 | ① 会话台（框架原生 Chat）② Bot 台（Workspace→Models + `/fleet`）③ 专业台（`/pro`，唯一自建显示层）④ 数据台（Knowledge/Files + `/data`） |
| 七引擎 | E1 会话循环（LangGraph operator 图，作底座的 Pipe）· E2 Bot（`botd` + Pydantic AI）· E3 领域编排（LangGraph 五阶段）· E4 数据（DuckDB）· E5 存储（SQLite/DuckDB/Chroma）· E6 知识（LlamaIndex）· E7 设备（CDP/UIA/native，不动） |
| 明确不做 | 不再引 OpenCode 当宿主（省 247 MB 与第二个循环）、不引 Claude Code Best（无 LICENSE）、不再手写第二套设计系统 |
| 现状 | 0.2.0 仍是可用版本；v2 从 W0（契约定版）开始，代码未动 |

## 2026-11-04

**All powered-FSA 0.2.0 桌面版（首个可用单文件 EXE）**

| 项 | 内容 |
|---|---|
| 产物 | `dist/AllPoweredFSA-0.2.0-win-x64/AllPoweredFSA.exe`，**904,181,335 B**，SHA256 `4cb3a0b90c8841d60803cb7a5a22164df9ef44ef31938788fe03a48d1d6796b4` |
| payload | 5222 文件 / 1.7 GB → zip 812.6 MB；含 Node 24、Python 3.11、B 引擎、样本、解包视图、8 条流程、原版套件便携副本 |
| 双模式 | 默认 **Agent 工作台**（三栏对话/工具卡/审批卡/产物卡/计划卡/失败卡/命令面板/深浅主题/窄屏收栏）；顶栏切 **专业面板**（原版 6 页） |
| Agent 服务 | `tools/agent_server.py`：会话 JSONL、SSE、审批阻塞/超时、取消、409、5MB；默认 `fake` 演示，不联网 |
| 模型通道 | OpenAI 兼容（流式/工具调用/usage）+ 本机 Ollama + fake；key 走 Windows DPAPI；未配 key 自动回退 fake 并提示 |
| 工具 | 30 个：local 9 / native 11 / RPA 8；`workflow_run` 按流程真实 risk 动态升为 high；产物只暴露文件名/相对路径 |
| RPA | `tools/cdp_driver.py`：手写 WebSocket/CDP，按页面文字找控件（无坐标），open/click/type/select/read/截图；`suite_launcher --launch --cdp-port` 启动原版 |
| 原版启动陷阱 | 原版 `main.js` 把任何多余 argv 当 Convert CLI；`suite_launcher` 用 `NASRunner.exe` 硬链接把 Chromium 开关真正传进去 |
| 安全 | Node 只监听 127.0.0.1，Host/Origin 必须回环同源（403 兜底）；壳生成 token 写 `runtime.json`；Chromium 禁用端口自动换 |
| 打包 | `tools/build_payload.py`（确定性 zip + manifest，核心模块缺失即失败）与 `tools/build_release.ps1`（dotnet publish + SHA256 + release.json） |
| 验证 | Python 827 项全过 skip 0；Node 1275 项（1272 pass / 3 skip / 0 fail）；selftest 5/5；audit 3/3；脱敏 0；EXE 内实测：健康度对话、审批拒绝、产物下载 5.3 MB PDF、专业面板、原版套件便携启动、CDP open/read/click/截图 |

**已知边界（不写成已完成）**：原版套件再分发需自行确认许可；工作流的控件文字映射需按套件
版本继续校准（RPA 框架已通，个别流程会停在 `GuiUnavailable` 并转人工）；真实台站样本仍受
#28/#33 阻塞；`fake` 演示的数字不是业务结论。


## 2026-11-03

**覆盖矩阵 8 项缺口收口（B 侧）**

| 项 | 处置 |
|---|---|
| `tile.agcStatus` | **补 B**：Manage 面板新增 AGC Status tile（AGCINFO #4096 → 卡/RF、pulseWidth/modulus、bins 与 bad/warn 判据；无 #4096 保持 Off），矩阵转 `covered`；测试 4 项 |
| `graph.newProjectFromSbf` | 流程 `gui.graph.newproject`：原版 Graph 从 SBF/CSV 新建工程 + Pre-process 四步，Process 之前人工闸门 |
| `page.deviceManagement` | 流程 `gui.device.add`：Add Device 扫描端口 → 连接 → VERSION 回读；多档案仍保留 `partial` |
| `suite.addApplication` | 流程 `gui.app.install`：装包哈希 → 选包 → Install 前闸门 → 应用列表回读 |
| `suite.updateApplication` | 流程 `gui.app.update`：Update 前闸门 → 版本回读 |
| `suite.autoUpdates` | 明确不做自动更新；流程 `gui.suite.autoupdate` 只读设置并留证据 |
| `device.deviceUpdate` | 已有 `gui.device.update`（不变） |
| `tool.events` | **不做（等样本）**：spoofing / jamming / L-Band 事件源在本机 b1..b7 里没有，不写猜测性代码 |

`tools/uia_selectors.json` 补齐新流程的控件名；覆盖矩阵与清单已重新生成
（矩阵 `--check` 通过）。B 侧 `node --test`：1246 项，1243 pass / 3 skip / 0 fail。

**M6 无人值守前置：心跳 / Webhook / 调度（#109 #110 #111）**

| 项 | 内容 |
|---|---|
| 心跳 | `src/fieldstation/agents/tools/heartbeat_tools.py`：`online/stale/offline/unknown` 三态 + 未知；阈值在 `config/heartbeat.json`（按心跳周期计）；与读数健康度正交，不合并成健康分 |
| 心跳回放 | `harness/heartbeat_replay.py` → `logs/heartbeat_replay.json`：4 台设备（online 1 / stale 1 / offline 1 / unknown 1），2 条告警；序列逐行 `synthetic=True` |
| Webhook | `src/fieldstation/agents/notify.py`：标准库 `urllib`，**默认 dry-run 不发请求**；载荷白名单 + 摘要化 + `<home>` 脱敏；5xx/429 有上限重试、4xx 不重试、失败不阻塞链路；审计只记 URL host |
| 调度 | `harness/station_loop.py`：注入时钟，到点 / 错过 / 超时三种情形；台账行与 `tools/trial_ledger.py` 同形（`source_id=task:<id>`） |
| 失败分类 | `tools/trial_ledger.py` 增加 `任务未执行` / `任务超时` 两类；汇总多一列 `by_failure_kind`（data_source / task），回答「没数据是源还是任务」 |
| 看板 | `tools/make_station_dashboard.py` 新增可选 `--heartbeat` / `--trial-ledger`：多「设备心跳」「数据源 / 任务失败」两块面板；不给参数时原三大视图逐字节不变 |
| 演示产物 | `figures/heartbeat_dashboard.html`、`logs/heartbeat_dashboard.json`、`logs/station_loop_demo.jsonl`、`logs/station_loop_demo_summary.json` |
| 测试 | 新增 `tests/test_heartbeat.py`（11 项）、`tests/test_webhook.py`（10 项）、`tests/test_station_loop.py`（9 项）；全量 622 项 |
| 材料 | 软著源程序随新增源码重生成（48 文件 / 11,120 行 / 223 页）；一页摘要与说明书数字同步 |

**混合版：应用内 Workflows 页签 + 原版套件 UIA 驱动（本次提交）**

| 项 | 内容 |
|---|---|
| 应用内入口 | 重实现应用新增 **Workflows** 页签：目录/参数/审批门/失败分类/证据下载，与 CLI 共用 `describe` 与 `job.json` |
| HTTP | `/api/workflows`（目录 + 执行器状态）、`describe`、`run`、`job`、`job/gate`、`job/resume`、`job/cancel`、`job/artifacts`、`artifact`；高风险运行返回 202 并停在闸门，`gate`/`resume` 异步执行后轮询 |
| 执行器边界 | Node 侧只起子进程（`python tools/workflow_cli.py`），不重写执行器；Python/执行器缺失时 503 并说明原因 |
| UIA 驱动 | 新增 `tools/uia_driver.py` + `tools/uia_selectors.json`：按 Name/AutomationId/ControlType 操作原版套件，无坐标；套件需 `--force-renderer-accessibility`，找不到控件即报错 |
| 测试 | 新增 `packages/app/test/workflows.test.ts`（9 项，stub 执行器）与 `tests/test_uia_driver.py`（12 项，不启动套件） |

**仓库界面整理（提交 `e5c2360`）**

| 项 | 内容 |
|---|---|
| README | 重写为「两件交付物 + 仓库地图 + 门禁」结构，补现状数字与界面速览截图 |
| 新增 | [`CHANGELOG.md`](CHANGELOG.md)、[`docs/README.md`](docs/README.md)（文档索引）、`.github` 下的 issue 与 PR 模板 |
| 截图 | [`docs/images/`](docs/images/) 加入 0.1.10 的界面截图 |
| 门禁 | 脱敏守卫补上「证据文件单列豁免」的口径（见 [KI-12](docs/known-issues.md)），其余文件仍按原规则拦 |
| 软著材料 | 源程序文档按当前 `tools/` / `harness/` / `agents/` 重新生成（41 个文件、8,486 行、170 页），说明书里的数字同步 |
| 工具 | `逆向/tools/remote/` 下脚本的本机路径与主机名改为参数，不再写死 |

**原版 GUI 缺口固化为固定流程（提交 `299b4e0`）**

| 项 | 内容 |
|---|---|
| A−B 盘点 | 新增 [`逆向/03_分析/19_原版GUI覆盖矩阵.md`](逆向/03_分析/19_原版GUI覆盖矩阵.md)，由 `tools/gui_coverage.py` 从 A/B 两侧源码生成：50 项逐项映射，A 目录不许漏项，引用的文件/行/workflow 失效即报错 |
| 流程执行器 | `src/fieldstation/workflows/`：严格 YAML 子集、加载期规格校验、状态机、文件锁、幂等键、只追加审计、人工闸门、可插拔 GUI 驱动；纯标准库 |
| 固定流程 | `workflows/`：`script.device.restart`、`gui.device.update`（Apply 前人工闸门）、`gui.graph.export`，附 [`workflows/README.md`](workflows/README.md) |
| 入口 | `python tools/workflow_cli.py list/describe/run/status/gate/resume/cancel/artifacts/validate`；`python -m fieldstation.cli workflow ...`；退出码 0 成功 / 1 失败 / 2 用法 / 3 停在闸门 |
| 门禁 | 新增 `python tools/gui_coverage.py --check`，并与测试、五项自检、数字回源、脱敏守卫并列进质量门禁表 |
| 软著材料 | 源程序文档随新增源码重新生成（43 个文件、9,496 行、190 页），说明书与一页摘要的数字同步 |

**NovAtelReverse 0.1.10**（[Release](https://github.com/yasunosubaru/field-station-agent/releases/tag/v0.1.10)，提交 `747af9a`）

| 改动 | 说明 |
|---|---|
| Graph 工程编辑区暗色 | 图表区深底浅轴、网格线与轴线；地图叠加层保持浅色墨（画在影像瓦片上）；Legend / 时间轴 / dock 深底浅字 |
| 配置抽屉暗色 | 抽屉内的原版 markup 跟随外壳的 `body.darkMode`，`MutationObserver` 实时同步，开着抽屉切主题立即生效；新增 `config-dark.css` 补齐原版暗色段漏掉的控件 |
| 覆盖审计 | 5 个面板 + 配置抽屉 20 页，浅色与暗色两侧对比度审计均为 0 |
| 产物 | `NovAtelReverse.exe`，139,001,951 B，SHA256 `f79aa94e…ed53d` |

## GUI 版本

| 版本 | 日期 | 改了什么 |
|---|---|---|
| `0.1.0` | 2026-11-02 | 单文件 GUI 外壳（WinForms + WebView2 + 内嵌 payload），用原版图标 |
| `0.1.1` | 2026-11-02 | Add Device 不再禁用；点开 live 连接抽屉（Serial / TCP），未连接时聚焦 COM 端口 |
| `0.1.2` | 2026-11-02 | 图标按像素反相（原版蓝底黑块反成黑底蓝块） |
| `0.1.4` | 2026-11-02 | 远程机实测修复三处：打包内嵌 `serialport`、Add Device 列真实串口、`PerMonitorV2` 修 DPI 变形 |
| `0.1.5` | 2026-11-02 | 补上官方主界面 My Applications：五张应用卡片、活动连接数、Add application；启动即主页 |
| `0.1.6` | 2026-11-02 | 默认浅色（与原版一致，不跟随系统）；暗色补齐 Manage / GRIT / 弹窗与终端 |
| `0.1.7` | 2026-11-02 | 修 Playback 深底标签不可读、暗色 `--pb-*` token 缺失；暗色 span 改为继承；两侧对比度审计归零 |
| `0.1.9` | 2026-11-03 | 修 GRIT Signal Matrix 错位与窄屏堆叠；Convert / Graph 补暗色；徽章深字 |
| `0.1.10` | 2026-11-03 | Graph 工程编辑区与配置抽屉暗色；抽屉跟随外壳主题 |

`0.1.3` 与 `0.1.8` 未出。

## 交付物 A 的阶段

| 阶段 | 状态 | 落地内容 |
|---|---|---|
| M0 骨架与评测底座 | 已完成 2026-10-14 | 仓库骨架、旧代码整合、运行时最小核、五项门禁、确定性回放 |
| M1 需求调研与接口梳理 | 交付物已落地，仍在补充 | 调研记录表、数据字典与 `datadict` 门禁 |
| M2 真实数据接入层 | 未开始 | 摄取层已就绪（RINEX 2/3、CRINEX），等真实数据 |
| M3 数据质量校验智能体 | 进行中 | M3-0…M3-3 完成；M3-4 待标注样本 |
| M4 研判 / 调度 / 归档与知识库 | 已完成 2026-10-18 | 工单状态机、归档策略、知识库 |
| M5 集成联调与告警看板 | 已落地部分 | 共享黑板、看板、公开数据通路；真实样本验收待 #28 / #33 |
| M6 试运行与指标评估 | 未开始 | 评估协议已预注册，试运行台账有骨架 |
| M7 成果整理与结题验收 | 进行中 | 一页摘要、结题报告骨架、软著三件套 |

## 交付物 B 的阶段

| 阶段 | 状态 | 落地内容 |
|---|---|---|
| 解包与证据 | 完成 | `app.asar` 与 Graph 的 asar 解包、REA 对 166 个 JS 文件的静态分析（不入库） |
| 逆向文档 | 完成主体 | [`逆向/03_分析/`](逆向/03_分析/) 30 篇、约 16 500 行、R1–R101 条可验收断言 |
| 协议与会话 | 完成 | CRC32、SBF 成帧、123 条消息 879 个字段、TCP/UDP/串口会话与心跳 |
| 视图与应用 | 完成主体 | Manage 19 个配置页与 11 个状态瓦片、Convert 9 种格式、GRIT、Playback、Graph |
| 打包与发布 | 进行中 | 单文件 GUI 已发到 `0.1.10`；固件 Update 只读、Longhorn 分支待真机 |
