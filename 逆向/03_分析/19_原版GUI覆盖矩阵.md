# 原版 GUI 覆盖矩阵（A × B）

> 本文件由 `tools/gui_coverage.py` 生成，**不要手改**；改映射请改
> `tools/gui_coverage_map.json`，改完运行 `python tools/gui_coverage.py`。
> 生成器同时校验「A 每项都有归属」「引用的文件与行存在」「引用的 workflow 存在」，
> 因此这份矩阵既是对照表，也是防止漂移的测试。

## 一、口径

- **A**：在*这台 OEM729 + 当前固件 + 套件 2.11.0* 上，人真的能在原版 GUI 里完成的操作。
  不是「套件所有菜单」——Storage / Wi-Fi / RTK / SPAN / ALIGN / PIM / G-III / Longhorn
  这些在本机原版也不能用的，归入 `not_applicable`，不占 RPA 预算。
- **B**：`逆向/04_重实现/` 的重实现（`/api/*`、配置页类、web 面板、CLI、`workflows/`）。
- **证据等级**：每条结论带 `[观察]`（源码原文，附 `文件:行号`）、`[推断]`（由观察推得）、
  `[未知]`（缺证据）。A 侧行号以 `逆向/01_解包/` 为准；解包目录不在本机时自动降级为 `[未知]`。

## 二、汇总

| 处置 | 条数 | 含义 |
|---|---|---|
| B 已覆盖 | 33 | `covered` |
| B 部分覆盖 | 4 | `partial` |
| A-only（B 没有） | 4 | `a_only` |
| 本机 A 也不适用 | 9 | `not_applicable` |
| **合计** | **50** | |

A 侧扫描：51 个 view 目录、14 个菜单项、7 个外壳页。

## 三、A−B 清单（只列仍有缺口的）

只有这里出现的项才需要处置：`covered` 项是「B 已有，不需要流程」。

| 项 | A 项 | 处置 | 处理方式 | 理由与证据 |
|---|---|---|---|---|
| `tile.agcStatus` | AGC Status tile（AGC 模式与增益） | A-only（B 没有） | 补 B：AgcStatus 类已有，但没接成 Manage 的 tile（本次不做 RPA，补 B 优先）。 | [观察] B 的 status/agcStatus.ts 实现了类，manage.js 里没有它的挂载点；原版在 Manage 状态带有 AGC Status tile（01_解包/app/view/agcStatus/agcStatus.html）。 |
| `tool.events` | Events（事件列表与详情） | B 部分覆盖 | 补 B：spoofing / jamming / L-Band 事件源需要样本或固件支持；不是代码没写。 | [观察] B 的 EventsPage 已接 RXSTATUSEVENT（#94）与 b7 的 ITK 事件；其它事件源在本机样本里没有出现（18 台账 §B4）。 |
| `device.deviceUpdate` | Device ▸ Update（选固件、校验、Apply 刷写） | B 部分覆盖 | workflow `gui.device.update` | [观察] B 把 deviceUpdate 列入 READ_ONLY_PAGES，Browse/Apply 禁用、SOFTLOAD 帧丢弃（18 台账 §J6）；固定流程用 RPA + 人工闸门补这一段。 |
| `graph.newProjectFromSbf` | Graph 从 SBF / 非 SBF 输入新建工程（预处理 Map/Timeline/Flags/Process） | A-only（B 没有） | 补 B：从 SBF/CSV 建工程与 Pre-process 四步（本机只有 Read/Convert/PDF 路径，未见原版完整向导）。 | [推断] B 的 New Project 打开的是 .gpf 工程而不是从 SBF 生成工程；原版 Graph 的 Pre-process（Map/Timeline/Flags/Process）没有对应实现（18 台账 §D 表 6.3）。 |
| `suite.addApplication` | Add application（安装套件外应用/插件） | A-only（B 没有） | 补 B 或 RPA：没有装包源；当前只弹说明。套件级、优先级低，需 GUI 文件对话框与安装包。 | [观察] 原版 addApplication.js 支持导入 .zip 装包；B 的按钮只展开说明（18 台账 §P）。 |
| `suite.updateApplication` | Update Application（套件自更新/安装新版本） | A-only（B 没有） | RPA 或补 B：需要更新服务器/安装器；不可逆性高，若做必须人工闸门。套件级、优先级低。 | [观察] 原版 updateApplication.js 负责下载并启动安装器；B 没有这条链路。 |
| `suite.autoUpdates` | Auto Updates 设置（套件自动更新） | B 部分覆盖 | 补 B：AutoUpdatesPage 类可渲染，但没有更新源/入口；也可用本地配置替代，优先级低。 | [观察] 原版 autoUpdates.js 管理更新检查；B 有页面类但未接入真实更新源，故只算部分覆盖。 |
| `page.deviceManagement` | Add Device / 设备管理（端口扫描、设备档案、多设备切换） | B 部分覆盖 | 补 B：多设备档案与切换（当前是单 live 会话 + Add Device 对话框）。 | [观察] B 有 Add Device 对话框与 /api/ports 扫描（18 台账 §O2）；原版 deviceManagement 支持多设备列表与档案，B 只维护单一 live 连接。 |

## 四、完整矩阵

### 入口与外壳

| 项 | A 项 | B 状态 | A 证据 | B 证据 / 说明 |
|---|---|---|---|---|
| `entry.manage` | Manage 主界面（tab、状态带、状态 tile、配置页容器） | B 已覆盖 | [观察] 逆向/01_解包/app/view/html/setUpMonitor.html:2 | [观察] 逆向/04_重实现/packages/app/src/web/panels/manage.js:15；[观察] B 的 manage.js 复刻 tab、50 px 黑色菜单条、状态带与 tile 容器；tile 集合见 status/ 包。 |
| `entry.menu` | 套件菜单栏（Status / Configuration / Settings / Tools / Device / Events） | B 已覆盖 | [观察] 逆向/01_解包/app/view/menuBar/menuBar.html:5 | [观察] 逆向/04_重实现/packages/app/src/web/panels/manage.js:1489；[观察] B 的 manage.js 以 MENU 数组 + menuBar() 复刻同一组菜单项与下拉层级；页面本体由配置页类提供。 |
| `entry.shell` | 套件外壳（页签栏、抓包条、设置/帮助/主题入口） | B 已覆盖 | [观察] 逆向/01_解包/app/view/html/index.html:320 | [观察] 逆向/04_重实现/packages/app/src/web/index.html:65；[观察] 原版外壳在 01_解包/app/view/html/index.html；B 在 web/index.html 复刻了页签栏与设置/帮助/主题入口，主题语义见 18 台账 §Q。 |

### 状态 tile

| 项 | A 项 | B 状态 | A 证据 | B 证据 / 说明 |
|---|---|---|---|---|
| `tile.agcStatus` | AGC Status tile（AGC 模式与增益） | A-only（B 没有） | [观察] 逆向/01_解包/app/view/agcStatus/agcStatus.html:1 | [观察] 逆向/04_重实现/packages/view/src/status/agcStatus.ts:26；[观察] B 的 status/agcStatus.ts 实现了类，manage.js 里没有它的挂载点；原版在 Manage 状态带有 AGC Status tile（01_解包/app/view/agcStatus/agcStatus.html）。 |
| `tile.deviceInfo` | Device 状态 tile（型号、固件、存储、电池等） | B 已覆盖 | [观察] 逆向/01_解包/app/view/deviceInfo/deviceInfo.html:1 | [观察] 逆向/04_重实现/packages/view/src/status/deviceInfo.ts:24；[观察] B 的 DeviceInfo 类覆盖 VERSION/RXSTATUS/HWMONITOR 字段；空态与存储不可用时的显示见 18 台账 §J7。 |
| `tile.interferenceStatus` | Interference 状态 tile（干扰检测结论） | B 已覆盖 | [观察] 逆向/01_解包/app/view/interferenceStatus/interferenceStatus.html:1 | [观察] 逆向/04_重实现/packages/view/src/status/interferenceStatus.ts:18；[观察] B 的 InterferenceStatus 类按 ITDETECTSTATUS 显示；无 ITK 数据时与原版一样显示 Not detected（18 台账 §B8）。 |
| `tile.logStatus` | Logging 状态 tile（日志请求/占用/丢弃） | B 已覆盖 | [观察] 逆向/01_解包/app/view/logStatus/logStatus.html:1 | [观察] 逆向/04_重实现/packages/view/src/status/logStatus.ts:20；[观察] B 的 LogStatus 类覆盖 LOGSTATUS/LOGLIST 字段；tile 在 Manage 状态带挂载。 |
| `tile.portStatus` | Ports 状态 tile（端口连接/速率/收发计数） | B 已覆盖 | [观察] 逆向/01_解包/app/view/portStatus/portStatus.html:1 | [观察] 逆向/04_重实现/packages/view/src/status/portStatus.ts:38；[观察] B 的 PortStatus 类在 18 台账 §D2/§N 一轮补齐 tile；端口行由 INTERFACEMODE 回读驱动。 |
| `tile.positionStatus` | Positioning 状态 tile（位置/速度/时间与解决方案状态） | B 已覆盖 | [观察] 逆向/01_解包/app/view/positionStatus/positionStatus.html:1 | [观察] 逆向/04_重实现/packages/view/src/status/positionStatus.ts:53；[观察] B 的 PositionStatus 类覆盖 BESTPOS/BESTVEL 等字段与 RAG；状态页 1 的 tile 已挂载。 |
| `tile.satelliteTracking` | Satellite Tracking 跟踪表（每颗星的通道/状态/仰角） | B 已覆盖 | [观察] 逆向/01_解包/app/view/satelliteTracking/satelliteTracking.html:1 | [观察] 逆向/04_重实现/packages/view/src/status/satelliteTracking.ts:126；[观察] B 的 SatelliteTracking 类在 18 台账 §D2 补齐；Manage 侧有 tile，Graph 侧另有 Tracking 页签。 |
| `tile.satelliteView` | Satellite View 天顶图（可见星/方位高度/信噪比） | B 已覆盖 | [观察] 逆向/01_解包/app/view/satelliteView/satelliteView.html:1 | [观察] 逆向/04_重实现/packages/view/src/status/satelliteView.ts:32；[观察] B 的 SatelliteView 类按 SATVIS2 画天顶图；OEM729 只跟踪 GPS/BDS/QZSS 的边界见 18 台账 §H.1。 |
| `tile.statusBar` | 状态条（RAG 灯、消息指示、连接/存储状态） | B 已覆盖 | [观察] 逆向/01_解包/app/view/statusBar/statusBar.html:1 | [观察] 逆向/04_重实现/packages/view/src/status/statusBar.ts:49；[观察] B 有 StatusBar 类与 RAG 指示逻辑；原版 DOM 契约见 01_Manage 文档 §3.3。 |
| `tile.alignStatus` | ALIGN 状态 tile（双天线航向/基线） | 本机 A 也不适用 | [观察] 逆向/01_解包/app/view/alignStatus/alignStatus.html:1 | [观察] 逆向/04_重实现/packages/view/src/status/alignStatus.ts:26；[推断] OEM729 只有一个 MMCX 射频口且 IMU/双天线未授权，ALIGN 数据不会出现；原版在本机同样只有空态（18 台账 §H.3）。 |
| `tile.pppCorrections` | PPP Corrections 状态 tile（PPP 服务改正数） | 本机 A 也不适用 | [观察] 逆向/01_解包/app/view/pppCorrections/pppCorrections.html:1 | [观察] 逆向/04_重实现/packages/view/src/status/pppCorrections.ts:36；[推断] MODELFEATURES 里 PPP UNAUTHORIZED（18 台账 §H.2），本机原版同样没有 PPP 改正数可显示。 |
| `tile.radioStatus` | Radio 状态 tile（电台/波特率/信号） | 本机 A 也不适用 | [观察] 逆向/01_解包/app/view/radioStatus/radioStatus.html:1 | [观察] 逆向/04_重实现/packages/view/src/status/radioStatus.ts:13；[推断] 本机没有电台硬件，原版也读不到 radio 数据（18 台账 §C1/§H.3）；B 的类保留给换机型后的路径。 |
| `tile.spanStatus` | SPAN 状态 tile（IMU/惯导解状态） | 本机 A 也不适用 | [观察] 逆向/01_解包/app/view/spanStatus/spanStatus.html:1 | [观察] 逆向/04_重实现/packages/view/src/status/spanStatus.ts:53；[推断] OEM729 的 MODELFEATURES 里 IMU/INS UNAUTHORIZED（18 台账 §H.2），原版与 B 在本机都无 SPAN 数据。 |

### 配置页

| 项 | A 项 | B 状态 | A 证据 | B 证据 / 说明 |
|---|---|---|---|---|
| `config.displaysSettings` | Settings ▸ Displays（显示项开关） | B 已覆盖 | [观察] 逆向/01_解包/app/view/displaysSettings/displaysSettings.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/index.ts:17；[观察] B 的 ConfigBundle 有 DisplaysSettingsPage 且 MENU_PAGE_NAMES 含 displaysSettings，菜单入口已接。 |
| `config.generalSettings` | Settings ▸ General（高度单位等本地设置） | B 已覆盖 | [观察] 逆向/01_解包/app/view/generalSettings/generalSettings.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/localSettings.ts:6；[观察] B 的 GeneralSettingsPage 只写 userStore，与原版一致；页面挂在 Settings 菜单。 |
| `config.gnssConfig` | Configuration ▸ GNSS（星座/信号选择） | B 已覆盖 | [观察] 逆向/01_解包/app/view/gnssConfig/gnssConfig.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/gnssConfig.ts:25；[观察] B 的 GnssConfigPage 有真机回读；本机能锁的星座只有 GPS/BDS/QZSS（18 台账 §H.1）。 |
| `config.languageSettings` | Settings ▸ Language（界面语言） | B 已覆盖 | [观察] 逆向/01_解包/app/view/languageSettings/languageSettings.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/localSettings.ts:71；[观察] B 的 LanguageSettingsPage 写 userStore.language 并触发语言分发，与原版一致。 |
| `config.loggingConfig` | Configuration ▸ Logging（日志请求与触发） | B 已覆盖 | [观察] 逆向/01_解包/app/view/loggingConfig/loggingConfig.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/loggingConfig.ts:33；[观察] B 的 LoggingConfigPage 走 LOG/UNLOG 命令；与深色 iframe 的主题跟随见 18 台账 §T2。 |
| `config.networkingSettings` | Settings ▸ Networking（网口/IP/端口） | B 已覆盖 | [观察] 逆向/01_解包/app/view/networkingSettings/networkingSettings.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/networkingSettings.ts:137；[观察] B 有 NetworkingSettingsPage；Wi-Fi/Hotspot 段按机型特征隐藏，本机原版也隐藏（18 台账 §B6）。 |
| `config.portConfig` | Configuration ▸ Ports（端口模式/波特率） | B 已覆盖 | [观察] 逆向/01_解包/app/view/portConfig/portConfig.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/portConfig.ts:115；[观察] B 的 PortConfigPage 在 §B9 真机逐行核对过（27 条 INTERFACEMODE → 24 行真端口）。 |
| `config.positionConfig` | Configuration ▸ Positioning（位置解与限制） | B 已覆盖 | [观察] 逆向/01_解包/app/view/positionConfig/positionConfig.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/positionConfig.ts:108；[观察] B 的 PositionConfigPage 按原版 markup 生成命令；18 台账 §B9 已完成 12 页真机核对。 |
| `config.alignConfig` | Configuration ▸ ALIGN（双天线安装与航向） | 本机 A 也不适用 | [观察] 逆向/01_解包/app/view/alignConfig/alignConfig.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/alignConfig.ts:29；[推断] OEM729 单射频口、无 ALIGN 硬件，原版在本机也没有可写项（18 台账 §H.3）；B 保留页面类给换机型。 |
| `config.radioConfig` | Configuration ▸ Radio（电台通道/协议） | 本机 A 也不适用 | [观察] 逆向/01_解包/app/view/radioConfig/radioConfig.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/radioConfig.ts:32；[推断] 本机没有电台硬件，原版也无可配置项（18 台账 §C1/§H.3）；页面类留作换机型扩展点。 |
| `config.spanConfig` | Configuration ▸ SPAN（IMU 安装/对准） | 本机 A 也不适用 | [观察] 逆向/01_解包/app/view/spanConfig/spanConfig.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/spanConfig.ts:33；[推断] IMU/INS UNAUTHORIZED（18 台账 §H.2），本机原版与 B 都没有 SPAN 输入可配置。 |
| `config.spanInstallation` | Configuration ▸ SPAN Installation（IMU 安装参数） | 本机 A 也不适用 | [观察] 逆向/01_解包/app/view/spanInstallation/spanInstallation.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/localSettings.ts:111；[推断] 没有 IMU 时原版该页只写本地设置、无接收机命令（spanInstallation.js:331-357）；本机不具备安装 IMU 的前提。 |
| `config.vehicleSetup` | Configuration ▸ Vehicle Setup（车辆参数，手册 2.2.7） | 本机 A 也不适用 | [推断] 逆向/01_解包/app/view/spanInstallation/spanInstallation.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/vehicleSetup.ts:81；[推断] Vehicle Setup 与 SPAN Installation 同源（同一份 markup），没有 IMU/SPAN 时本机原版也没有车辆参数可设；B 保留页类。 |

### 工具页

| 项 | A 项 | B 状态 | A 证据 | B 证据 / 说明 |
|---|---|---|---|---|
| `tool.interferenceToolKit` | Tools ▸ Interference Toolkit（ITK 检测表与写入类控件） | B 已覆盖 | [观察] 逆向/01_解包/app/view/interferenceToolKit/interferenceToolKit.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/interferenceToolkit.ts:689；[观察] B 的 InterferenceToolkitPage 只读表 + 六组写入控件；HDR/带通/可编程滤波器在本机回 Message is invalid for this model（18 台账 §I）。 |
| `tool.terminalConsole` | Tools ▸ Terminal（命令终端） | B 已覆盖 | [观察] 逆向/01_解包/app/view/terminalConsole/terminalConsole.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/terminalConsole.ts:11；[观察] B 的 TerminalConsolePage 通过 /api/live/command 发命令并回显；行/历史行为对齐原版 terminalConsole.js。 |
| `tool.events` | Events（事件列表与详情） | B 部分覆盖 | [观察] 逆向/01_解包/app/view/events/events.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/events.ts:131；[观察] B 的 EventsPage 已接 RXSTATUSEVENT（#94）与 b7 的 ITK 事件；其它事件源在本机样本里没有出现（18 台账 §B4）。 |

### 设备页

| 项 | A 项 | B 状态 | A 证据 | B 证据 / 说明 |
|---|---|---|---|---|
| `device.deviceDetails` | Device ▸ Details（设备详情与接收机状态） | B 已覆盖 | [观察] 逆向/01_解包/app/view/deviceDetails/deviceDetails.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/deviceDetails.ts:85；[观察] B 的 DeviceDetailsPage 在 18 台账 §D1/§F 完成并真机核对，已进 MENU_PAGE_NAMES。 |
| `device.deviceExport` | Device ▸ Storage（内部/外部存储文件列表与下载） | B 已覆盖 | [观察] 逆向/01_解包/app/view/deviceExport/deviceExport.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/deviceExport.ts:26；[观察] 本机没有存储子系统，原版与 B 都只能显示空列表与原因（18 台账 §J7）；文件传输是换到有存储机型才出现的 A 项，不是本机 A−B。 |
| `device.deviceRestart` | Device ▸ Restart / Factory Reset（RESET / FRESET） | B 已覆盖 | [观察] 逆向/01_解包/app/view/deviceRestart/deviceRestart.html:1 | [观察] 逆向/04_重实现/packages/view/src/config/deviceRestart.ts:18；[观察] B 在 18 台账 §N 完成 RESET/FRESET（强确认、断线重连、VERSION 回读、失败不重试）；固定流程把同一串动作变成可审计 job。；固定流程 `script.device.restart` |
| `device.deviceUpdate` | Device ▸ Update（选固件、校验、Apply 刷写） | B 部分覆盖 | [观察] 逆向/01_解包/app/view/deviceUpdate/deviceUpdate.html:1 | [观察] 逆向/04_重实现/packages/app/src/config-host.ts:56；[观察] B 把 deviceUpdate 列入 READ_ONLY_PAGES，Browse/Apply 禁用、SOFTLOAD 帧丢弃（18 台账 §J6）；固定流程用 RPA + 人工闸门补这一段。；固定流程 `gui.device.update` |

### Graph

| 项 | A 项 | B 状态 | A 证据 | B 证据 / 说明 |
|---|---|---|---|---|
| `graph.newProjectFromSbf` | Graph 从 SBF / 非 SBF 输入新建工程（预处理 Map/Timeline/Flags/Process） | A-only（B 没有） | [观察] 逆向/01_解包/Graph/out/renderer/index.html:1 | [观察] 逆向/04_重实现/packages/app/src/web/panels/graph.js:9；[推断] B 的 New Project 打开的是 .gpf 工程而不是从 SBF 生成工程；原版 Graph 的 Pre-process（Map/Timeline/Flags/Process）没有对应实现（18 台账 §D 表 6.3）。 |
| `graph.charts` | Graph 页签与图表（13 张图，含 Velocity / Heading & Attitude、Flags、地图） | B 已覆盖 | [观察] 逆向/01_解包/Graph/out/renderer/index.html:1 | [观察] 逆向/04_重实现/packages/app/src/web/panels/graph.js:49；[观察] B 的 graph 面板已含 13 张图、Luciad 地图与 Flags store；GNSS _Mean 列序用工程元数据 sidecar 对齐（18 台账 §M/D4）。 |
| `graph.export` | Graph 导出（PDF/CSV/HTML/KML、Message Summary、第 2 页底图） | B 已覆盖 | [观察] 逆向/01_解包/Graph/out/renderer/index.html:1 | [观察] 逆向/04_重实现/packages/app/src/web/panels/graph.js:4346；[观察] B 的 exportAs 走 /api/graph/pdf 真 PDF；Message Summary、第 2 页底图与 8 页版式在 18 台账 §N/§D6 关闭；固定流程只读导出、无人工闸门。；固定流程 `gui.graph.export` |
| `graph.project` | Graph 工程页（New/Open Project、Recent Projects、.gpf 读取） | B 已覆盖 | [观察] 逆向/01_解包/Graph/out/renderer/index.html:1 | [观察] 逆向/04_重实现/packages/app/src/web/panels/graph.js:9；[观察] B 的 graph 面板有工程页与 Recent Projects；多工程切换在 18 台账 §G 关闭。 |

### GRIT Monitor

| 项 | A 项 | B 状态 | A 证据 | B 证据 / 说明 |
|---|---|---|---|---|
| `page.grit` | GRIT Monitor（Position Overview、Signal Matrix、Spectrum/Waterfall、POI/Triggers、Terminal、Events） | B 已覆盖 | [观察] 逆向/01_解包/app/view/GRIT/gritJarvisInterface.js:1 | [观察] 逆向/04_重实现/packages/app/src/web/panels/grit.js:21；[观察] B 的 grit 面板完成 Luciad 位姿概览、信号矩阵、频谱/瀑布、POI/Triggers、内嵌 Terminal 与卫星瓦片（18 台账 §B2/§D4/§M）；底图用 Esri 而非 Google，属来源替代。 |

### Convert

| 项 | A 项 | B 状态 | A 证据 | B 证据 / 说明 |
|---|---|---|---|---|
| `page.convert` | Convert（文件转换、五组输出设置、预览与导出） | B 已覆盖 | [观察] 逆向/01_解包/app/view/convert/convert.html:1 | [观察] 逆向/04_重实现/packages/app/src/web/panels/convert.js:208；[观察] B 的 convert 面板接了 Sample Rate/Unknown/Destination/Prefix/Time Interval；窗口+interleave 已在 18 台账 §K 关闭。 |

### Playback

| 项 | A 项 | B 状态 | A 证据 | B 证据 / 说明 |
|---|---|---|---|---|
| `page.playback` | Playback（Files bar / summary bar / 状态 tile / 控制条 / 事件点） | B 已覆盖 | [观察] 逆向/01_解包/app/view/playbackcontrol/playbackcontrol.html:1 | [观察] 逆向/04_重实现/packages/app/src/web/panels/playback.js:7；[观察] B 的 playback 面板复刻控制条与事件带；18 份抓包没有 #94 事件，事件点行为已实现但缺原版样本（18 台账 §M/D1）。 |

### 套件级

| 项 | A 项 | B 状态 | A 证据 | B 证据 / 说明 |
|---|---|---|---|---|
| `suite.addApplication` | Add application（安装套件外应用/插件） | A-only（B 没有） | [观察] 逆向/01_解包/app/view/addApplication/addApplication.js:1 | [观察] 逆向/04_重实现/packages/app/src/web/index.html:88；[观察] 原版 addApplication.js 支持导入 .zip 装包；B 的按钮只展开说明（18 台账 §P）。 |
| `suite.updateApplication` | Update Application（套件自更新/安装新版本） | A-only（B 没有） | [观察] 逆向/01_解包/app/view/updateApplication/updateApplication.js:1 | [观察] 原版 updateApplication.js 负责下载并启动安装器；B 没有这条链路。 |
| `suite.autoUpdates` | Auto Updates 设置（套件自动更新） | B 部分覆盖 | [观察] 逆向/01_解包/app/view/autoUpdates/autoUpdates.js:1 | [观察] 逆向/04_重实现/packages/view/src/config/localSettings.ts:246；[观察] 原版 autoUpdates.js 管理更新检查；B 有页面类但未接入真实更新源，故只算部分覆盖。 |

### 其它页面

| 项 | A 项 | B 状态 | A 证据 | B 证据 / 说明 |
|---|---|---|---|---|
| `page.dynamicTiles` | Dynamic Tiles 布局（拖动、撤销、重置、持久化） | B 已覆盖 | [观察] 逆向/01_解包/app/view/dynamicTiles/dynamicTiles.html:1 | [观察] 逆向/04_重实现/packages/view/src/layout.ts:2；[观察] B 的 layout.ts 实现 packery 布局与持久化；原版行为见 01_Manage 文档 §3.4/§6.5。 |
| `page.home` | My Applications 主页（五张应用卡片、连接数、Add application） | B 已覆盖 | [观察] 逆向/01_解包/app/view/welcome/welcome.html:124 | [观察] 逆向/04_重实现/packages/app/src/web/index.html:83；[观察] B 的 home-view 复刻官方启动页（卡片尺寸/图标/连接数见 18 台账 §P）；Add application 的装包动作单独列为套件级缺口。 |
| `page.menuBar` | 菜单栏行为（切换到状态页/配置页、Settings/Tools/Device 下拉） | B 已覆盖 | [观察] 逆向/01_解包/app/view/menuBar/menuBar.js:1 | [观察] 逆向/04_重实现/packages/app/src/web/panels/manage.js:1202；[观察] B 的 manage.js 有同一组菜单切换与抽屉挂载逻辑；配置页由 config-host 提供。 |
| `page.deviceManagement` | Add Device / 设备管理（端口扫描、设备档案、多设备切换） | B 部分覆盖 | [观察] 逆向/01_解包/app/view/deviceManagement/deviceManagement.js:1 | [观察] 逆向/04_重实现/packages/app/src/web/panels/manage.js:11；[观察] B 有 Add Device 对话框与 /api/ports 扫描（18 台账 §O2）；原版 deviceManagement 支持多设备列表与档案，B 只维护单一 live 连接。 |

## 五、B 清单（从代码扫描）

### 5.1 `/api/*` 路由

共 30 条：

- `/api/captures` · `/api/config/device/export` · `/api/config/device/import` · `/api/config/device/import/preview` · `/api/config/device/status` · `/api/config/events/summary`
- `/api/config/pages` · `/api/convert` · `/api/download` · `/api/graph/data` · `/api/graph/files` · `/api/graph/flags`
- `/api/graph/pdf` · `/api/graph/projects` · `/api/grit/tiles/config` · `/api/grit/tiles/{z}/{x}/{y}` · `/api/health` · `/api/live/command`
- `/api/live/connect` · `/api/live/disconnect` · `/api/live/logs` · `/api/live/status` · `/api/logs` · `/api/playback/events`
- `/api/playback/export` · `/api/playback/frame` · `/api/playback/frames` · `/api/playback/info` · `/api/ports` · `/api/records`

### 5.2 配置页与菜单页

- `CONFIG_PAGE_NAMES`（14）：`positionConfig`、`portConfig`、`loggingConfig`、`alignConfig`、`spanConfig`、`radioConfig`、`gnssConfig`、`spoofingConfiguration`、`networkingSettings`、`generalSettings`、`languageSettings`、`spanInstallation`、`lghnPositionConfig`、`lghnLoggingConfig`
- `MENU_PAGE_NAMES`（12）：`generalSettings`、`networkingSettings`、`languageSettings`、`spanInstallation`、`vehicleSetup`、`interferenceToolkit`、`displaysSettings`、`deviceDetails`、`deviceExport`、`deviceUpdate`、`deviceRestart`、`terminalConsole`

### 5.3 web 面板

`convert`、`graph`、`grit`、`manage`、`playback`

### 5.4 CLI 选项（`packages/cli/src`）

- `--ascii` `--at` `--baud` `--capture` `--catalog` `--crc` `--csv` `--daily-utc`
- `--decimate` `--duration` `--expand-cmp` `--export` `--export-ascii` `--fields` `--finish-time` `--from`
- `--generation` `--golden` `--help` `--host` `--html` `--info` `--json` `--kml`
- `--limit` `--limit-duration` `--limit-output-duration` `--limit-output-size` `--list` `--log` `--max` `--no-expand-cmp`
- `--only` `--out` `--pdf` `--period` `--port` `--project` `--raw` `--repeat`
- `--serial` `--split` `--start-time` `--time-format` `--to` `--tolerance` `--trigger` `--udp`
- `--unknown-bytes` `--verbose`

### 5.5 固定流程

| workflow | 规格文件 |
|---|---|
| `gui.device.update` | `workflows/gui.device.update.yaml` |
| `gui.graph.export` | `workflows/gui.graph.export.yaml` |
| `script.device.restart` | `workflows/script.device.restart.yaml` |

## 六、未纳入 A 的 view 目录（内部件）

这些目录是页面内部的样式/图片/脚本/语言包或 GRIT 的子图层，不是「人能操作的屏」，
所以不逐项建流程；保留在此是为了说明「没漏看」，而不是「看漏了」。

| 目录 | 不纳入的理由 |
|---|---|
| `2d-sd` | Longhorn 2D 视图子图层，本机无 Longhorn 机型。 |
| `css` | 原版样式表与 jQuery 插件资源，不是可操作页面。 |
| `fonts` | 字体文件，不是可操作页面。 |
| `height-sd` | Longhorn Height 视图子图层，本机无 Longhorn 机型。 |
| `html` | 外壳 HTML（index/setUpMonitor/welcome/playback）已在「入口与外壳」逐项映射；该目录本身不重复计数。 |
| `images` | 图标与截图资源，不是可操作页面。 |
| `js` | 页面共用的旧版脚本副本（help.js、html2canvas 等），不是独立屏幕。 |
| `json` | genericView 的数据表，不是可操作页面。 |
| `languageSupport` | 语言包（cn/de/en…），由 languageSettings 页使用，不是独立屏幕。 |

## 七、维护与扩展

1. **新增页面**：A 目录出现新页面 → 生成器会报「A 目录未映射」，在映射里补一条，
   写清 `disposition`；`a_only` 必须给 `workflow` 或 `backlog`。
2. **新增流程**：在 `workflows/` 加一份 YAML，生成器会自动把它列进 §5.5；
   映射里引用它之前，先保证 `workflow validate` 通过。
3. **新增机型/固件**：把「本机不适用」的项从 `not_applicable` 改成实际处置，
   并更新 A 的口径（本文件 §一）。
4. **防漂移**：`python tools/gui_coverage.py --check` 会在 CI/门禁里比对
   `19_原版GUI覆盖矩阵.md` 与 `附录/gui-inventory.json` 是否与源码一致。
5. **失败分类**：workflow 的失败类固定为 environment / input / execution /
   artifact / capability（见 `src/fieldstation/workflows/spec.py`），矩阵不另立分类。
