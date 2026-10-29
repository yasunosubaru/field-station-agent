# `@nas-reimpl/view` — Manage 视图层

NovAtel Application Suite 2.11.0 的 Manage（设备管理）界面：页签、容器、瓦片、Packery 等价布局、
连接流程、刷新节流、语言层、`updateView` 渲染契约、三套模板下的配置页，以及设备管理、
`.cfg` 交换、Terminal、Events。

依据来自 `03_分析/01_Manage主界面与视图层.md`。验收测试在适用处带 §8/§11 的 `R<n>` 编号；
DOM 子集、端到端和组件边界的测试名称直接描述行为。

## 为什么可以不装 Electron 就跑

原套件是「一个 SPA + jQuery + `nodeIntegration:true`」，行为藏在 1 000 多个 DOM 操作里。
这里把 DOM 换成一个**零依赖子集**（`src/minidom.ts`），于是全部行为都能在 Node 里用
**真实的 shipped 片段**（`01_解包/app/view/**/*.html`）断言，而不是对着自造 fixture。

```
src/
  minidom.ts    零依赖 DOM 子集：解析、选择器、classList/dataset/style、事件冒泡、isConnected
  clock.ts      Clock + FakeClock（可 advance，用来钉 1200 ms / 35 s / 30 s / 10 s 这些定时）
  types.ts      模块契约（TabRegistry / LayoutEngine / TileSystem / Throttle / LanguageLayer / ViewLayer / ManageRuntime）
  ids.ts        容器 id、§5.1 的 selector 拼装、tile 的最终 class
  userStore.ts  userSettings.json 的 `app.dynamic` / `defaultLayout` 等
  tabs.ts       页签系统：静态 Add-device 页、`enableTabs` 置灰、`allocIndex`、关闭策略
  containers.ts `createMainPanel` 的 16 步容器 + 三套配置页
  tiles.ts      §3.2 的按机型 tile 计划 + 真实片段挂载
  layout.ts     Packery 等价布局 + 持久化 + Undo/Reset
  connection.ts 35 s 守卫、VERSIONB 门闩、初始日志下发、加载器预算
  throttle.ts   活动 tab 直渲 / 非活动 tab 缓存 + 切回重放
  language.ts   字典、语言解析、20+9 个 `processLanguage` 扇出、marker 应用
  view.ts       `updateView` 的 selector/缓存/RAG/格式化
  status/       14 个 status 组件、组件状态、RAG、数值格式化和图表桥
  config/       14 个配置页、三态字典、命令协调器、Longhorn 文本配置解析
  manage.ts     唯一的装配点，实现 `ManageRuntime`
test/
  minidom.test.ts            9    DOM 子集本身
  view.test.ts              21    §5.1 选择器、缓存、RAG、格式化、R47
  throttle-language.test.ts 16    R40/R41 + R31–R38
  tabs.test.ts              23    R10–R12/R45/R49/R54/R55
  layout.test.ts            22    R19–R26/R61/R62
  connection.test.ts        28    R28–R30/R36/R43/R51–R53
  containers.test.ts        12    16 步顺序、每 tab 一份弹窗（R13–R16）
  tiles.test.ts             16    §3.2 计划与真实片段挂载（R17/R18）
  manage.test.ts            14    端到端：enterManage → addTab → VERSIONB → 瓦片 → 日志 → DOM；R60；mirrorDefects 装配
  status-components.test.ts 43    14 个组件：真实 HTML、生产解码器与分支/交互
  config-pages.test.ts      38    14 个配置页、三套模板、命令字节、应答状态机、弹窗与持久化
  operations.test.ts        38    设备管理、.cfg、Terminal、Events、原生/宿主边界
```

## 运行

Node ≥ 22.6，零 npm 依赖：

```powershell
cd 04_重实现\packages\view
node --test --test-force-exit "test/*.test.ts"     # 280 项，约 20 s
```

独立验收记录（当前 356 项、空断言审计、R17/R19/R22/R40/R60/R61 的 shipped 证据和保真约定结论）
见 [`ACCEPTANCE.md`](./ACCEPTANCE.md)。

`--test-force-exit` 必须加：模块里保留了原实现的 `setInterval`（心跳/轮询），否则进程不退出。

### 测试里两条硬规则（踩过才知道）

1. **永远不要拿两个 DOM 节点做 `assert` 相等**。`assert` 失败时会 `util.inspect` 整个 shim 树，
   包括 `style`/`dataset` 代理和 `parentNode` 环 —— 实测一次这样的失败让单条测试跑了 **161 秒**。
   `minidom` 现在给 `MiniNode` 加了 `[Symbol.for('nodejs.util.inspect.custom')]`，把节点打印成
   `<div#tabs-3.tab-view>`，但根本的规矩仍是「断言 id / 布尔 / 文本，不比节点」。
2. **重复 id 必须用 `#<tab> ` 前缀选择**。`#popupModal`/`#helpModal`/`#connection-loader`/
   `#loader-text-id`/`#fetch-loader-tabs-1` 在整页各有多份，裸 id 查询在真实浏览器里拿第一个、
   在 shim 里拿第一个（修完 `walk` 的提前退出后一致），但正确性依赖前缀。

## 镜像开关（默认全部复现 shipped 缺陷）

| 位置 | 默认行为（2.11.0） | 修正方式 | 依据 |
|---|---|---|---|
| 元素缓存 | 只判 `null`，`innerHTML` 替换后继续写脱离文档的节点 | `createView({mirrorDefects:false})` 用 `isConnected` 重查 | R57 |
| `removeDataLangAttr` | 遍历活属性并删除，隔一个漏一个 | `mirrorDefects:false` 先收集再统一删 | R36 |
| `updateView` 空值 | DOM 得到字符串 `"undefined"`/`"null"` | `mirrorDefects:false` 写空串 | §5.2 |
| `addDataLangAttr` | 只增新 marker，不删旧 marker | `mirrorDefects:false` 先清旧 marker | R35 |
| `tabs.getOpenState` | 查询不存在的 `#setupMonitorConn_*`，恒 false | `createTabRegistry({mirrorOpenState:false})` 查 `#<tab>` | R45 |
| 语言字典 | `addDict` 只增不清，缺键回落到上一个语言 | 默认保留；显式调用 `clearDictionary()` 隔离语言 | R31 |

`resetButtonVisible` 按「有差异才显示」实现（R61：文档 §6.5 原先读反了源码）。

`minidom` 自身修掉的三个缺陷（都会影响所有上层）：`walk` 不传播提前退出（导致 `querySelector`
返回**最后一个**匹配，重复 id 会拿错 tab）、`innerHTML`/`textContent` 替换时不清理子节点
`parentNode`（`isConnected` 失真）、`textContent` 把注释文本算进去。

## 验收对照（`03_分析/01_Manage主界面与视图层.md §8` 的 R1–R50）

| R | 落在哪 | 状态 |
|---|---|---|
| R1–R7, R9 | 进程侧 / `index.html` 的 4 s splash / `Components.json` / GRIT 脚本注入 | 不在本包（宿主与启动器职责），文档 §2.1–2.4 已描述 |
| R8 | 进入 Manage 时应用语言偏好 | `manage.enterManage` → `language.applyUserLanguagePreference` ✅ |
| R10–R12 | 页签可见性、`enterManage` 的 11 步顺序、`enableTabs` 置灰 | `tabs.ts` ✅ |
| R13–R16 | 16 步容器、每 tab 一份弹窗、三套配置页、page1/page2/Reset | `containers.ts` ✅ |
| R17–R18 | `createTile` 落位、首元素 `*-status` 身份 | `tiles.ts` ✅（最终 class 由 `manage.buildTiles` + `ids.tileClassFor` 施加） |
| R19–R26 | Packery 参数、恒 1 列、拖动手柄、持久化、Undo、默认布局捕获、排序、销毁 | `layout.ts` ✅ |
| R27–R28 | page1/page2 切换的可见性与重排 | `containers.setPage` + `manage.onPageChange` → `satelliteTracking.resetTrackingUI` ✅ |
| R29 | 恢复上次停留页 | `manage.restorePersistedPage`（注入 `persistedPage`）✅ |
| R30 | 连接加载器 1200/500/30 s | `connection.ts` ✅ |
| R31–R34 | `__()`、忽略 tab 参数、`split('-')[0]` 匹配、20+9 扇出 | `language.ts` ✅ |
| R35–R36 | marker 只作标记、`removeDataLangAttr` 先收集再删 | `view.ts` + `language.ts` ✅ |
| R37 | `createDialog` 按文案反查 key 派生 `data-lang-*` | `view.createDialog` ✅；默认镜像查不到 key 时的 `TypeError`，`mirrorDefects:false` 才容错 |
| R38 | 高度单位三处改写 | `status/statusBar.ts` + `status/positionStatus.ts` ✅（R67/R68 固定格式化） |
| R39–R42 | `updateView` 选择器与门禁、缓存分桶、节流、11 通道重放 | `view.ts` + `throttle.ts` ✅ |
| R43 | 40 s 兜底 + 文案复位 `CONNECTING` | `connection.ts` ✅（`manage` 提供 DOM 侧） |
| R44 | `updateAppBackgroundThrottling` IPC | ✗ 主进程职责（`main.js`），见 R44 的「二选一」建议 |
| R45 | `getTabOpenState` 改为查 `#<tab>` | 默认镜像恒 false；显式 `mirrorOpenState:false` 修正 ✅ |
| R46 | 死代码不实现 | ✅ 未实现，符合要求 |
| R47 | `data-lang-<type>-type` | `ids.deviceTypeMarker` ✅ |
| R48 | 设备落地页 A-Z 排序 | ✗ 属 `setUpMonitor.html` 的设备卡片墙，不在本包 |
| R49 | 关闭前 `FILE_LOGGING_CLOSE_WARNING` | `tabs.close` 的 `beforeClose` 钩子 ✅（弹窗本体在配置页） |
| R50 | `checkTileSpacing`（MarinePak 间距） | ✗ 未实现 |

新增事实 R51–R66 的落点：R51–R53 → `connection.ts`；R54–R55 → `tabs.ts`；R57 → `view.ts`；
R58–R59 → `language.ts`；R60 → `ids.tileClassFor` + `manage.buildTiles`；R61–R62 → `layout.ts`；
R56 是文档级事实（`positionStatus.html` 的两个 why-this-* 链接被注释掉了），由
`throttle-language.test.ts` 固定；R63–R66 分别由 `tiles.ts`、`tabs.ts` 和 shipped fragment 测试固定。

## status 组件对照（`03_分析/01_Manage主界面与视图层.md §11` 的 R67–R80）

| R | 组件 | 实现与测试 | 证据 |
|---|---|---|---|
| R67 | statusBar | `src/status/statusBar.ts`；`status-components.test.ts:102,836,857,876,886` | `statusbar.js:72-130,349-356` |
| R68 | positionStatus | `src/status/positionStatus.ts`；`status-components.test.ts:125,910,934,951` | `positionStatus.js:89-234,326-397` |
| R69 | portStatus | `src/status/portStatus.ts`；`status-components.test.ts:137,976,1006` | `portStatus.js:30-485` |
| R70 | deviceInfo | `src/status/deviceInfo.ts`；`status-components.test.ts:165,1056,1083` | `deviceInfo.js:11-407`; `NovatelIdConstants.js:421-436` |
| R71 | spanStatus | `src/status/spanStatus.ts`；`status-components.test.ts:196,1233` | `spanStatus.js:5-200` |
| R72 | alignStatus | `src/status/alignStatus.ts`；`status-components.test.ts:223,1278` | `alignStatus.js:3-127` |
| R73 | radioStatus | `src/status/radioStatus.ts`；`status-components.test.ts:248` | `radioStatus.js:2-35` |
| R74 | interferenceStatus | `src/status/interferenceStatus.ts`；`status-components.test.ts:263,1306` | `interferencestatus.js:4-87` |
| R75 | logStatus | `src/status/logStatus.ts`；`status-components.test.ts:277,1112` | `logStatus/logStatus.js:29-285` |
| R76 | agcStatus | `src/status/agcStatus.ts`；`status-components.test.ts:302,1334,1374` | `agcStatus/agcStatus.js:129-287,400-586` |
| R77 | pppCorrections | `src/status/pppCorrections.ts`；`status-components.test.ts:328,378` | `pppCorrections/pppCorrections.js:14-340,471-612` |
| R78 | satelliteView | `src/status/satelliteView.ts`；`status-components.test.ts:442,460,1153` | `satelliteView.js:4-57`; 天空点由 `constellation.js:497-540,821-877,1067-1106` |
| R79 | satelliteTracking | `src/status/satelliteTracking.ts`；`status-components.test.ts:497,534,615,657,708,747` | `satelliteTracking.js:187-246,1499-1770,2178-2194` |
| R80 | longhornStatusUI | `src/status/longhornStatusUI.ts`；`status-components.test.ts:1128,1153,1178,1204` | `longhornStatusUI.js:164-246,317-820,946-1058` |

`Manage` 的接线测试见 `manage.test.ts:190`（状态灯→每 tab 弹窗）、
`manage.test.ts` 的 decoder-produced BESTPOS 和 injected-session 两项。字段输入由
`test/helpers.ts#decodedFixture` 写入 `packages/protocol/data/message-specs.json` 声明的字节，
`decodedStatusRepeatedFixture()` 再执行 production `deriveStatusFields()`；不是手写 DOM
fixture 或手写“解析结果”。

实现期新增的 shipped 事实 R81–R87（副天线 header bit、分组
`CHANCONFIGLIST`、CARDSTATUS fans、AGC 详情、PPP 排序/显隐、Longhorn
GGA/GSV/CPU 延迟、LOGSTATUS 世代边界）已追加到
`03_分析/01_Manage主界面与视图层.md §11`，对应测试同样列在该节。

## 配置页与通用弹窗对照

配置实现的共同骨架在 `src/config/base.ts:211`、`src/config/state.ts:61`、
`src/config/state.ts:225`：三态字典分别是 `baseline/defaultData`、`current/data`、
`pending/changedData`；Apply 才把 pending 合并进 current，响应成功后提交，失败保留待改值。
命令协调器按 msgID 记期望条数，UNKNOWN 保持未完成，窗口内 ERROR 短路为整体 ERROR，
完成后调用页面的 `handleXxxCommandResponse`，随后 `removeFeature` 清计数。

| 范围 | 实现 | 测试/证据 |
|---|---|---|
| 标准 8 pill / GIII / Longhorn 模板 | `manage.statusConfigClick` 与 `config.selectPage` 挂载真实片段 | `config-pages.test.ts:199,230,256,270,1025`；`jarvisInterface.js:945-1033` |
| Positioning | `config/positionConfig.ts:99`：模式确认、静态范围、Transmit 顺序、MSM/File 分支 | `config-pages.test.ts:617,638,655,689`；R30–R35 |
| Ports | `config/portConfig.ts:42`：1 s 完备轮询、`send abcd`、格式切换、NCOM/NTRIP 校验 | `config-pages.test.ts:495,513,538,555,588`；R24–R29 |
| Logging / GIII Logging | `config/loggingConfig.ts:33,360`：FILE/`_29`、4096 轮转、最后一条关闭、GIII 重启提示 | `config-pages.test.ts:230,755,785`；R38–R40 |
| Align | `config/alignConfig.ts:18`：四命令固定顺序和硬编码字段 | `config-pages.test.ts:459`；R41 |
| SPAN | `config/spanConfig.ts:33`：IMU 事件→CONNECTIMU→INSCOMMAND→平移；ANT1/ANT2/USER 扇出 | `config-pages.test.ts:727`；R36–R37 |
| Radio | `config/radioConfig.ts:32`：3 口探测、READY 轮询、SATEL4 Hz 与 900 MHz 范围 | `config-pages.test.ts:804`；R42–R44 |
| GNSS | `config/gnssConfig.ts:25`：ALL 仰角与 PPS 固定周期/脉宽 | `config-pages.test.ts:327,354,617`；R45–R46 |
| Networking | `config/networkingSettings.ts:23`：DHCP/DNS/保存以太网、热点模式公式 | `config-pages.test.ts:840`；R47–R49 |
| General / Displays / Language / Span Installation / Auto Updates | `config/localSettings.ts:6,53,93,172,228`，只写 userStore/settings | `config-pages.test.ts:870,896`；R81–R85 |
| Spoofing | `config/spoofingConfiguration.ts:20`：SKCALIBRATE/SKDETECTCONFIG 与四阶段显示 | `config-pages.test.ts:905` |
| Longhorn Positioning/Logging | `config/longhorn.ts:134,202,279`，真实 lghn 片段与文本配置解析 | `config-pages.test.ts:256,925`；R90–R92 |
| 通用弹窗 | `view.createDialog`：标题/正文/按钮 marker、模板克隆、垂直定位 | `config-pages.test.ts:945,976,997,1012`；R86–R89 |
| 未保存拦截 | `view.requestHideDialog` + `manage.statusConfigClick` | `config-pages.test.ts:1012,1025`；R89 |
| 语言扇出 | 9 个 config 模块 + 条件 GIII/Longhorn/MarinePak | `config-pages.test.ts:1045`；`jarvisInterface.js:1411-1435` |
| 配置读日志 | `config.index.requiredLogs` + `manage.requestConfigLogs`，包含 §5.11 清单 | `config-pages.test.ts:199` |

## 设备操作、配置交换、终端与事件

本轮新增 `test/operations.test.ts`，所有页面测试均通过 `realFragmentLoader()` 读取
`01_解包/app/view/**/*.html`；二进制命令使用 production `buildBinaryCommand`，
协议字段使用 `decodeMessage/decodeRepeated + deriveStatusFields` 或同一 shipped 字段表生成。
下表中的 R50–R101 指 `03_分析/02_配置类视图.md`，不要与上面 status 章的同号条目混用。

| 范围 | 实现 | 测试与 shipped 证据 |
|---|---|---|
| Device Details / GIII Device Details | `config/deviceDetails.ts`：AUTH 五段、model/date、OEMSTAR ASCII、30 s restart；GIII 4108 动态表、4101 ETH 状态、剪贴板、信号频段与 MODELFEATURES | `operations.test.ts:250-478`；R50–R51、R95；`deviceDetails.js:112-205,351-616,1080-1125`、`giii-deviceDetails.js:104-353` |
| Device Export | `config/deviceExport.ts`：真实多帧文件列表、`*` 全删、4 ms 逐条删除、USB COPY 串行、3 s 兜底、FTP 宿主边界、两位小数/0 KB | `operations.test.ts:479-670`；R52–R53、R96；`deviceExport.js:230-310,386-779` |
| Device Update | `config/deviceUpdate.ts`：S0/S3/S5/S7、4088 合并、production SOFTLOAD 帧、状态 16–35、完成重启；Longhorn 专属片段和设备类型校验 | `operations.test.ts:671-824`；R54、R100；`deviceUpdate.js:225-449`、`lghn-deviceUpdate.js:94-220,515-720` |
| Device Restart | `config/deviceRestart.ts`：RESET/FRESET、擦除 Lua、GIII、MarinePak、Longhorn 原生 reset | `operations.test.ts:825-896`；R55–R56；`deviceRestart.js:75-306` |
| `.cfg` 保存 | `config/configurationFile.ts`：15 条日志、2 s/3.5 s 时序、端口过滤、注释、追加写、PSN 文件名 | `operations.test.ts:897-963`；R57–R60、R94；`saveConfiguration.js:2-183,312-434,440-514` |
| `.cfg` 加载 | `config/configurationFile.ts` + `manage.chooseAndLoadConfigurationFile`：FRESET 建议、过滤、版本差异、逐命令 30 s、补发、应答报告 | `operations.test.ts:964-1147`；R61–R65、R99；`loadConfiguration.js:30-280,390-661` |
| Terminal | `config/terminalConsole.ts`：OEM/GIII/Longhorn 片段、LOGR、虚拟口 28、GIII Apply、1 s 文件回放、Save/Record | `operations.test.ts:1148-1257`；R66–R70、R97；`terminalConsole.js:61-102,409-607,812-847`、GIII/Longhorn 对应文件 |
| Events | `config/events.ts`：Good/Moderate/Poor、100 条历史、筛选/限制/清空/暂停通知、`.esl`、Longhorn 2353/223、GSV 发布接线 | `operations.test.ts:1258-1552`；R71–R73、R98；`events.js:134-316,555-627,724-815,969-1049,1132-1385` |

逐条对照（`02_配置类视图.md §8`）：

| R | 实现与测试 | shipped 证据 |
|---|---|---|
| R50 | `deviceDetails.ts:38,158`；`operations.test.ts:249,277` | `deviceDetails.js:112-167` |
| R51 | `deviceDetails.ts:210`；`operations.test.ts:289` | `deviceDetails.js:185-204` |
| R52 | `deviceExport.ts:208,418`；`operations.test.ts:478` | `deviceExport.js:617-664` |
| R53 | `deviceExport.ts:260`；`operations.test.ts:510` | `deviceExport.js:668-693` |
| R54 | `deviceUpdate.ts:34,97,284`；`operations.test.ts:638-739` | `deviceUpdate.js:225-369` |
| R55 | `deviceRestart.ts:117,170`；`operations.test.ts:792` | `deviceRestart.js:214-306` |
| R56 | `deviceRestart.ts:190`；`operations.test.ts:792` | `deviceRestart.js:293-300` |
| R57 | `configurationFile.ts:58,110`；`operations.test.ts:867` | `saveConfiguration.js:20-36,374-388` |
| R58 | `configurationFile.ts:280`；`operations.test.ts:888` | `saveConfiguration.js:114-145` |
| R59 | `configurationFile.ts:40,144`；`operations.test.ts:867` | `saveConfiguration.js:314,407-417` |
| R60 | `configurationFile.ts:86,280`；`operations.test.ts:888` | `saveConfiguration.js:459-514` |
| R61 | `configurationFile.ts:368`；`operations.test.ts:929` | `loadConfiguration.js:261,399,411` |
| R62 | `configurationFile.ts:383,431`；`operations.test.ts:929` | `loadConfiguration.js:196-207` |
| R63 | `configurationFile.ts:585`；`operations.test.ts:973` | `loadConfiguration.js:250-259` |
| R64 | `configurationFile.ts:529`；`operations.test.ts:929,973,1008` | `loadConfiguration.js:424-465,648-655` |
| R65 | `configurationFile.ts:571`；`operations.test.ts:1008` | `loadConfiguration.js:572-593` |
| R66 | `terminalConsole.ts:84`；`operations.test.ts:1113` | `terminalConsole.js:61-102` |
| R67 | `terminalConsole.ts:121`；`operations.test.ts:1113` | `terminalConsole.js:423-439` |
| R68 | `terminalConsole.ts:181`；`operations.test.ts:1113` | `terminalConsole.js:564-577` |
| R69 | `terminalConsole.ts:214`；`operations.test.ts:1113` | `terminalConsole.js:594-605` |
| R70 | `terminalConsole.ts:317,423`；`operations.test.ts:1130` | `terminalConsole.js:374-405`、GIII/Longhorn 文件 |
| R71 | `events.ts:937`；`operations.test.ts:1223` | `events.js:1811-1820,1848` |
| R72 | `events.ts:367`；`operations.test.ts:1223` | `events.js:1872-1875` |
| R73 | `events.ts:228,947`；`operations.test.ts:1398` | `events.js:284-316,1892-1905`；勘误见 R93 |
| R93 | 同 R73；`operations.test.ts:1398` | `events.js:300-303` |
| R94 | `configurationFile.ts:280,304`；`operations.test.ts:888` | `saveConfiguration.js:114-183` |
| R95 | `deviceDetails.ts:105,445`；`operations.test.ts:337` | `giii-deviceDetails.js:104-295` |
| R96 | `deviceExport.ts:537,647`；`operations.test.ts:561` | `deviceExport.js:175-199,755-779` |
| R97 | `terminalConsole.ts:289,361`；`operations.test.ts:1145,1207` | `terminalConsole.js:812-847`、`giii-terminalConsole.js:233-311` |
| R98 | `events.ts:611,703`；`operations.test.ts:1311` | `events.js:602-618,724-815,969-1049,1289-1385` |
| R99 | `manage.ts:649`；`operations.test.ts:929,1068` | `loadConfiguration.js:30-141,335-349` |
| R100 | `deviceExport.ts:347`、`deviceDetails.ts:348`、`deviceUpdate.ts:245`、`deviceRestart.ts:156`、`terminalConsole.ts:181` | `deviceExport.js:506-611`、`deviceRestart.js:141-152`、`lghn-deviceUpdate.js:545-669`、`LoadConfig.bat:5-8,43-67` |
| R101 | `config/index.ts:71`；`operations.test.ts:232` | `jarvisInterface.js:5246-5307` |

## 还没做的

- 设备管理页、`.cfg` 保存/加载、Terminal、Events 的标准 OEM 路径已接通；Longhorn
  PIMTP update/config 状态机仍缺，FTP/TerraStar 需要宿主提供真实网络依赖。
- 配置页的完整控件级 DOM 交互仍不是逐按钮差分：核心 Apply 路径已用真实命令帧验证，
  但下拉滚动、所有校验提示样式和移动端 accordion 细节仍需要截图/事件差分。
- MarinePak 间距（R50）和设备卡片墙排序（R48）仍未实现。
- Longhorn 的 `LoadConfig.bat` 依赖外部 `tosrec`、`datablk` 与 Winload；RNX 转换不含在本批
  Manage 页面代码路径中。没有可执行真机/工具证据的部分保持显式边界，不用近似算法冒充。
- GRIT tab 的容器（`#grit-status-panel-*`）只有 id 约定，未建 GRIT 专属面板。
- `message-specs.json` 的 31 条 `repeat:true` 消息现在全部有布局：26 条固定块，
  5 条变长/多级计数 custom 布局；fans、副天线和分组 CHANCONFIG 继续有专用派生。
  Longhorn update/config 的 PIMTP 完整状态机仍未重建；当前只有文本配置解析、页面切换
  和宿主回调契约。
- AGC、satelliteTracking、Longhorn 已调用 shipped Plotly API，但 threshold shape、
  highest/lowest marker、Plotly 像素布局和全部 hover/relayout 细节仍是功能近似，不能称为
  像素级 1:1。
- Longhorn NMEA 的 VERSION/RXERROR/RXSTATUS 子事件已接到 Events；`lghnPositionConfig`
  文本解析已接入，但 `lghn-deviceUpdate` 的 PIMTP `UPDATE_BEGIN/UPDATE_DATA` 真机状态机
  仍需 `Edie.inputstream_api/pimtpframer_api` 与真实 ACK 轨迹。
- GIII satelliteTracking 的 IRIMS/WAAS 等模型分支、GIII AGC 弹窗后半段、PPP 的完整
  subscription/beam 组合矩阵仍需要更多 shipped-oracle 差分用例。

因此当前结论是：14 个 status 组件、14 个配置页以及本轮 7 类设备操作页的可验证核心路径
已可运行，356 项回归全绿；但 Longhorn PIMTP 写路径、Plotly/像素级 DOM 差分、GRIT 专属面板
以及非 status 消息的完整枚举/展示派生仍未完成，不能把“测试全绿”写成整个 P1 的逐像素 1:1。
