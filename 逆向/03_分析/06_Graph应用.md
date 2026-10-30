# Graph 应用（NovAtel Application Suite 2.11.0 · 独立 Electron 子程序）

> 覆盖对象：`01_解包/Graph/`（`package.json` 声明 `name=Graph`、`version=2.11.0`、
> `main=out/main/main.js`、`buildType=DEV`、`compiledTime=11 Aug 2026 16:30:00 PM`）。
>
> **引用格式说明**：`out/renderer/assets/index-B86bHcCD.js` 是 Vite 压缩产物，只有 **2386 行**，
> 第 1 行就占 10.6 MB（`wc -L` 实测）。因此本文引用写成
> `…index-B86bHcCD.js:582 @563079`，`:` 后是行号，`@` 后是该行内的**字节偏移**（`node` 读文件
> 后的 `String#indexOf` 位置，可 `fs.readFileSync(f,'utf8').slice(563079, 563079+200)` 复现）。
> `.jsc` 是 V8 bytenode 字节码，无行号，引用写成 `main.jsc@39929`（文件内字节偏移）。
> 抽取脚本与全部中间产物见 `06_Graph应用-附录/K_抽取脚本/`。

---

## 1. 职责

### 1.1 一句话定位

`[观察] package.json` —— Graph 是 NAS（NovAtel Application Suite）的一个 **non-core 子程序**，
独立打包成自己的 Electron 应用（Electron 41，主进程/预加载均用 bytenode 编译成 `.jsc`），
职责是：**把 NovAtel 接收机原始日志（.gps/.log 等二进制或 ASCII）转换成 SQLite 图表库，
再以地图 + 曲线 + 时间轴回放的方式展示、裁剪、打标记并导出报告**。

`[观察] index-B86bHcCD.js:74 @372014` 处 i18n 文案 `GRAPHING_DESCRIPTION` 自述：

> "Transform your NovAtel receiver data into dynamic, interactive visualizations to simplify data
> analysis, gain valuable insights, and reduce the time and effort required for diagnostics and
> troubleshooting."

`[观察] index-B86bHcCD.js:1559 @15993576` 的导出菜单把能力收敛成四项：
`HTML Report` / `PDF Report` / `KML` / `CSV (original data only)`。

### 1.2 它自己不做什么（边界）

| 不做 | 依据 |
|---|---|
| 不解析 SBF/ASCII 协议本身 | renderer 里没有任何 SBF 帧解析代码；解析发生在 `graph-node-wrapper.node` 里（`[观察] main.jsc@~73.3k` 的子进程脚本只做 `new Edie.TabFileReader_api()` 转发） |
| 不直接 `require` 任何 Node 模块 | `[观察]` 全文 0 处 `ipcRenderer` / `contextBridge` / `require("electron")`；渲染进程只用 `window.*` 门面 |
| 不做后处理（PPP/RTK） | `[观察] index-B86bHcCD.js:73` 有 `POST_PROCESS1="Post-Process"`、`POST_PROCESS2="WITH WAYPOINT"` 两条文案，但**路由与组件里都不引用**（死字符串），后处理交给 NovAtel Waypoint |

### 1.3 页面与路由（**逐个枚举，全部 3 条**）

`[观察] index-B86bHcCD.js:2385 @16249777`：

```jsx
<HashRouter>
  <AppHeader/>
  <Routes>
    <Route path="/"         index     element={<Landing/>}/>
    <Route path="/overview"           element={<Overview/>}/>
    <Route path="/process"            element={<FileProcess/>}/>
  </Routes>
</HashRouter>
```

同一份枚举在 `@538800` 处还有一份 `PageRoutes` 常量：
`LANDING="/"`、`OVERVIEW="/overview"`、`PROCESS="/process"`。
路由是 **HashRouter**（`@255575` 是 `HashRouter` 实现，`@16249777` 是唯一使用点），
即 URL 形如 `file:///…/index.html#/process`。

| 路由 | 组件（定义位置） | 功能 | 用户可见文案 |
|---|---|---|---|
| `/` | `Landing` `@1349866` | 首页 = 新建项目向导 + 最近文件 + 帮助/关于入口 | `GET_STARTED`、`NEW_PROJECT`、`OPEN_PROJECT`、`RECENT_FILES`、`NO_RECENT_FILE`、`IMPORT_OPEN` |
| `/overview` | `Overview` `@13850452` | 处理后总览：地图 + 时间轴回放 + 标记面板；"Process/Plot" 按钮触发 `StartProcess`（含裁剪重算） | `OVERVIEW`、`PLOT`、`PROCESS_MESSAGE`、`GRAPHS_AVAILABLE` |
| `/process` | `FileProcess` `@16210749` | 图表工作台：按图组分 Tab，每 Tab 内 `react-grid-layout` 可拖拽的多图块；导出入口 | `PVT`、`HEADING_ATTITUDE`、`TRACKING_MEASUREMENTS`、`RECEIVER_STATUS`、`PROJECT_INFORMATION`、`EXPORT` |

#### 1.3.1 `/` 首页的三个区块（模块级枚举）

`[观察] @1342317 ProjectWizard` + `@599900 RecentActivity`：

1. **新建项目向导 `ProjectWizard`** —— 4 步 `UseMultiStepForm`（`@1343010` 明确列出 4 个 step 元素）：
   `Welcome`（欢迎）→ `ProjectInfo`（项目名/目录/描述）→ `FileUpload`（拖放或浏览）→
   `FileValidation`（校验进度 + 接收机/数据摘要）。
   校验进行中可 `CANCEL`，取消时二次确认（`START_OVER_CONFIRMATION`）。
2. **最近文件 `RecentActivity`** —— 读 `userSettings.json` 的 `recents`（最多 12 条），
   点击时先 `GetEncryptionKey` 再打开；`msg==="FILE_EXISTS_ERROR"` 则提示项目已不存在。
3. **头部 `AppHeader` `@16246025`** —— 左：返回首页图标（有项目时弹 `"Do you want to exit?"`
   确认框）；右：设置菜单 `SettingsMenu`（仅 Theme Light/Dark、Time GPS/UTC、Quit 三项）。

#### 1.3.2 `/overview` 的组成

`[观察] @16210318 GOSTab` + `@13679136 OverviewMap`：

- `OverviewMap`（Luciad RIA 地图，2D `CRS:84`）：轨迹折线按 position type 着色、
  事件图标（干扰/欺骗/压制）、标记（flag）图层、悬停点、当前时刻 marker
- `MapLegend`（图例，可勾选显隐）、`MapControls`（缩放/指北）、`Attribution`
- `FlagsPanel` → `FlagsList` / `TrashControls` / `AddFlag` / `ColorPicker`（最多 10 个标记，可回收站）
- `Timeline`（播放/暂停、±30 s、倍速、`Show Events` 开关、`CropTimeline` 裁剪起止时间）

#### 1.3.3 `/process` 的 Tab（= 图组）

`[观察] @16162103 getGraphGroups()` —— Tab 顺序 = `GOS` 固定第一，其余按 `PlotSummary`
里出现的键，最后补 `Project Information`：

| Tab | 组件 | 内容 |
|---|---|---|
| GOS（Overview） | `GOSTab` `@16210318` | 与 `/overview` 同款地图+时间轴，但嵌在 `/process` 里（`isGDS`） |
| PVT | `PVTChartsPanel` `@16157328` | 7 张图（见附录 C） |
| Heading & Attitude | `HACharts` `@16159647` | 3 张图 |
| Tracking & Measurements | `TrackingMeasurement` `@16168238` | 3 张图，按星座/信号分组，`ber` 特殊处理 |
| Receiver Status | `ReceiverStatusCharts` `@16204516` | 3 张图 |
| Project Information | `ProjectInformation` `@16164766` | 纯文本信息卡（接收机/文件/时间），无图表，**不参与导出** |

每个图块 = `ChartControls`（标题+菜单+配色）+ `LineChart`/`GeoMapChart` + `GraphLabels`（图例 chips），
外面套 `ResponsiveGridWrapper`（`react-grid-layout`，布局持久化到 `PersistenceInfo`）。

#### 1.3.4 死字符串（有文案、无 UI）

`[观察]` 以下 i18n 键在本构建里**只出现在资源表，不出现在任何组件**（`grep` 计数为 1，即只有定义）：
`DETAILS`、`POST_PROCESS1/2`、`MAX_TABS_REACHED`（"…files can be open at once"）、
`PROFILE_SETTINGS_LI_1/2/4/5`、`LANGUAGES`、`PRIVACY_POLICY`、`CHECK_UPDATES`、
`FEEDBACK`、`ABOUT`、`HELP`、`CONTACT_SUPPORT`、全部 `UPDATE_*`。
→ 说明这些是 NAS 主程序/旧版 Graph 的残留，或留给安装版以其他方式接入；**复现时不要照抄为功能**。

---

## 2. 入口与加载顺序

### 2.1 文件级加载链（**必读，决定能否启动**）

`[观察] out/main/main.js`（3 行）：

```js
"use strict";
require("./bytecode-loader.cjs");
require("./main.jsc");
```

`[观察] out/preload/preload.js` 同构，指向 `preload.jsc`。

`[观察] out/main/bytecode-loader.cjs`（全文 72 行，`out/preload/` 下为同一份副本）：

1. `v8.setFlagsFromString("--no-lazy")`、`v8.setFlagsFromString("--no-flush-bytecode")`
   —— 必须先关 lazy，否则缓存的字节码布局对不上；
2. 造一段空 `vm.Script("")` 拿到 `dummyBytecode`，把它的 **offset 12..16 的 4 字节 flag hash**
   覆盖到目标 `.jsc` 上（这是 bytenode 用于跨 V8 版本对齐 flag 的惯用手法）；
3. 读 `.jsc` 的 **offset 8..12 的 4 字节**（小端）作为源码长度 `length`；
4. 若 `length > 1`，构造 `dummyCode = '"' + "\u200b".repeat(length-2) + '"'` ——
   **用零宽字符凑出和原源码等长的假源码**，再 `new vm.Script(dummyCode, {cachedData: bytecodeBuffer})`；
5. `cachedDataRejected` 为真 → 抛 `Invalid or incompatible cached data`；
6. 手工拼 `require`（含 `require.main`、`require.extensions`、`require.cache`），
   `script.runInThisContext()` 后按 CommonJS 六参数 apply。

结论（`[推断]`，推理链：`main.js` 只有 require，没有 `app.whenReady()`，而这些逻辑必须存在）：
**`main.js` 源码确实"缺失"，功能一点没少——全部逻辑在 `main.jsc` 里**，靠上面这个 loader 执行。
`[观察] main.jsc` 内确有 `whenReady`、`window-all-closed`、`will-quit`、`createWindow`、
`handleSingleInstance`、`requestSingleInstanceLock`、`registerFileProtocol` 等字符串，
与"完整主进程"一致。

### 2.2 主进程启动顺序（从字节码常量表恢复）

`[观察] main.jsc` 字符串顺序（即模块注册顺序，`@` 为首次出现偏移）：

1. `require` 依赖：`electron`、`electron-devtools-installer`、`winston`、`child_process`、
   `better-sqlite3-multiple-ciphers`、`dotenv`、`fs/promises`、`@electron-toolkit/utils`
2. 加载配置：`dotenv` → `.env.development` / `.env.production`（按 `NODE_ENV`）
3. 单实例锁：`requestSingleInstanceLock()`，第二次启动发 `second-instance` → `restore()` + `focus()`
4. `app.commandLine.appendSwitch(...)`：`disable-renderer-backgrounding`、
   `disable-backgrounding-occluded-windows`、**`enable-unsafe-webgpu`**、`ignore-gpu-blocklist`
   —— 地图是 WebGPU 渲染，这 4 个开关是硬需求
5. `app.setAppUserModelId("com.default.electron")`（`[观察] APP_USER_MODEL_ID` + `com.default.electron`）
6. 注册协议 `file:` → `localfile`（`registerFileProtocol`），供报表 HTML 里的
   `<img src="localfile://…">` 使用
7. 注册 IPC handler（5 组：`fileOps` / `graphingOps` / `pathOps` / `chartOps` / `postions` /
   `events` / `clipboard` / `dataPreview` / `browserWindow`），完整通道表见附录 B
8. `createWindow()`：`BrowserWindow` + `webPreferences.preload = ../preload/preload.js`、
   `sandbox`、`devTools`、`webSecurity`、`backgroundThrottling=false`；`autoHideMenuBar`、
   `icon.ico`、尺寸取 `getPrimaryDisplay().workAreaSize`；`ready-to-show` 后
   `loadURL(ELECTRON_RENDERER_URL)` 或 `loadFile(../renderer/index.html)`
9. 全局快捷键：`CommandOrControl+R`（重载）、`CommandOrControl+Shift+I`（DevTools）
10. `will-quit` → `unregisterAll()`
11. 日志：`winston` → `error.log` / `warn.log`，启动时把 `Version: 2.11.0` 写进两个日志
    （正则 `Version: (\d+\.\d+\.\d+)`，用来判断日志是不是当前版本的，旧的就 `rmSync`）

### 2.3 渲染进程启动顺序

`[观察] out/renderer/index.html` + `@16249777`：

1. `<script type="module" src="./assets/index-B86bHcCD.js">`（主包 16.2 MB；另有 14 KB 的
   `assets/browser-ponyfill-BdbUY9VD.js` 分包）
2. CSP：`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline' 'self' data:`
   —— 注意 **没有 `connect-src`**，也没有 `img-src`，即默认 `default-src` 缺省=全放开；
   `script-src` 里的 `wasm-unsafe-eval` 是为 Luciad/Photon 的 wasm
3. `ReactDOM.createRoot(#root).render(<StrictMode><Provider store><App/></Provider></StrictMode>)`
4. `App` 内 `useEffect` 第一条就是 **`instance.changeLanguage("en")`**（`@16249600` 附近）——
   即语言被**硬编码成英文**，见 §4.6

另有两类运行期线程（`[观察]` REA 抽取到的 worker 节点）：

- `new Worker(workerUrl, { name: "lcd_base" })` 与 `{ name: "lcd_gltf" }` —— LuciadRIA 的 WebGPU
  基础 worker 与 glTF 解析 worker；`index.html` 的 CSP 为此写了 `worker-src 'self' blob:`
- echarts 自身不建 worker；所有图表计算都在主线程（故有 `large/progressive` 兜底）

### 2.4 与 REA 6.5.0 结果的交叉核对

`[观察]` 用 `rea analyze-javascript-application "…\01_解包\Graph" --artifact-format directory
--source-path out/renderer/assets/index-B86bHcCD.js` 跑通（原始输出 175 MB，未入库；
摘要见附录 `L_REA复核摘要.json`）：

| 指标 | 值 | 对本报告的意义 |
|---|---|---|
| `statistics.text_bytes_read` | `16 252 082` | 与 `index-B86bHcCD.js` 字节数完全一致 → 文件未被改动 |
| `visited_ast_nodes` | `1 181 367` | 单个 bundle 的 AST 规模 |
| `ipc.literal_channels` / `renderer_transmissions` / `renderer_listeners` | `0 / 0 / 0` | **独立佐证 R5**：渲染进程无任何 IPC 直连 |
| `context_bridge_apis` / `exposed_api_members` | `0 / 0` | 同上（bridge 在 preload 里，本文件不含） |
| `native_addon_bindings` | `2`（win/linux 两份 `graph-node-wrapper.node`，各带 sha256） | 佐证 §7.5 的原生模块清单 |
| `storage` 节点 | `12`，含 `sessionStorage["EncryptionKey"]`（具名）与 6 处 `localStorage` 调用 | 佐证附录 E 的 sessionStorage/localStorage 结论 |
| `worker` 节点 | `2`（`lcd_base`、`lcd_gltf`） | 见上文 |
| `parse_failures` | `0` | 16 MB 压缩包可被完整静态解析 |

REA 的 `limitations` 明确声明：静态关系"不证明运行期执行"，webpack/rspack 工厂未执行——
所以它**不能**替代手工抽取（既拿不到 IPC 通道字符串，也拿不到 `PlotSummary` 这类数据契约），
只适合做"有没有漏掉某个 I/O 面"的反向查漏。

---

## 3. 数据结构（逐字段：名称 / 类型 / 单位 / 来源）

### 3.1 `parsedData` —— 原生每次回包（`[观察] @552074`、`@625124`、`@1347635`）

| 字段 | 类型 | 单位 | 来源 / 说明 |
|---|---|---|---|
| `Percentage` | `number` 或 `Record<group,number>` | % | 校验阶段是数字；`StartProcess` 阶段是**按图组的对象**，renderer 求平均后再 `Math.min(…, 99)` 显示，见 §6.3 |
| `ValidationCode` | `number` | 枚举 | `0/1/2/-1/-2/-3/-4`，映射见 §5.4 |
| `Terminated` | `boolean` | — | 用户取消，触发杀进程 + 删 `<project>\GDS` |
| `EncryptionKey` | `string` | — | 仅 `api==="GetEncryptionKey"`；写入 `sessionStorage["EncryptionKey"]` |
| `api` | `"FileValidation" \| "GetEncryptionKey" \| undefined` | — | 有值时表示这是"读/校验类"应答 |
| `PlotSummary` | 见 §3.3 | — | 图组 → 子结构 |
| `DataInfo` | `{StartTime:number, EndTime:number}` | **ms**（GPS 纪元起算） | 见 §5.3 换算 |
| `Messages` | `Record<messageName, {count:number,…}>` | 条 | 缺失日志统计；`sum(count) > 200000` 触发"样本过大"提示 |
| `ReceiverInfo` | `{version:{GPSCARD,ENCLOSURE,IMUCARD}}` | — | 接收机型号/硬件 |
| `filename` | `string` | — | 输入文件名 |
| `msg` | `string` | — | 错误码见 §5.5 |

### 3.2 图表 DB（SQLite，AES-128-CBC 加密）

`[观察] main.jsc@39858..@39949`（pragma 片段）+ `@73511`（库文件名常量）+ `@57719`（SQL）

| 表/库 | 列 | 说明 |
|---|---|---|
| `position.db` | `timestamp`(ms), `latitude`, `longitude`, `height`, `Position_Type` | 轨迹主表；`tableName` 由 `PlotSummary["Position View"]` 决定（通常是 `BESTPOS`）`@1335532` |
| `event_v2.db`（常量名 `EVENTS_V2`，旧名 `events.db`） | `event_type`, `timestamp`, `frequency`(BLOB), `state`, `latitude`, `longitude` | 干扰/欺骗/压制事件；`frequency` 是 5 字节/条记录，见 §5.6 |
| `logginginterval.db` | （未在 renderer 侧引用） | 日志间隔统计，供 `app:get-log-spacing` |
| `<table>.db` | `timestamp` + 若干数值列 | 每个图表一张表：`height.db`/`velocity.db`/`positionsd.db`/`cpuusage.db`/`cno.db`/`satellitestracked.db`/`locktime.db`/`rxstatus.db`/`insupdate.db`/`insattitude_*.db`/`positionmode.db`/`positionvalid.db`/`solutionstatistic.db`/`trajectory.db` |
| 跨度类图（`insupdate` / `rxstatus`） | `name`, `start`, `end`, `min_diff` | `min_diff` **秒**；renderer 乘 1000 转 ms 后做抽稀（`@575103`） |

列名不是猜的：`PRAGMA table_info(<table>)` 是唯一的列名来源（`main.jsc@59248`），
即**复现时表结构可以从真实项目目录反查**（用同一条 pragma，先 `PRAGMA key` 再读）。

### 3.3 `PlotSummary`（图可用性的唯一判据）

`[观察] @16162103`、`@578411`、`@1335532`

```ts
type PlotSummary = {
  "Position View":       { GNSS?: Record<string,string>, INS?: Record<string,string> },
  "PVT":                 { GNSS?: ..., INS?: ... },
  "Heading_Attitude":    Record<string, any>,
  "Tracking_Measurements": Record<string, any>,
  "Receiver_Status":     Record<string, any>,
  "Receiver_Info":       { version: {...} | null }
}
```

- 键是**图组名**，二级键是分段（`GNSS`/`INS`），三级键是"出现序号"，值是**日志名**（如 `BESTPOS`）。
- 图是否出现：`getAvailableGraphs()` 取 `PVT.GNSS`/`PVT.INS` 的**键名集合**，与图表 `title`
  做 `includes` 判断，并额外加入字面量 `"Planimetric"`（`@578411`）。
  → **"图是否有数据"本质上是一次字符串相等比较**，这是复现时最容易被忽略的耦合点。
- 位置表选择：优先 `Position View.GNSS` 且其中必须含 `BESTPOS`，否则整组换 `Position View.INS`，
  再取**数值最小的索引**（`@1335532`）。

### 3.4 Redux store（6 个 slice，`[观察] @190960..@194900`）

| slice `name` | 初始 state | reducers（关键） |
|---|---|---|
| `notifications` | `{dismissedUpdate:""}` | `setDismissedUpdate` |
| `flags` | `{allFlags:[], editFlagId:0, newFlagId:1, isFlagsPanelOpen:false}` | `addFlag`、`updateFlag`、`resetFlagsState`、`toggleFlagsPanel` |
| `appSettings` | `{theme:"light", timeFormat:"GPS"}` | `setAppTheme`、`setAppTimeFormat` |
| `playback` | `{current:0,isEditMode:false,editedStart:0,editedEnd:0,isPlaying:false,isCompleted:false,playbackSpeed:1,showEvents:false,isTimelineClicked:false,currentMarkerTime:0}` | `setCurrentTime`、`setEditedPlaybackState`、`setPlaybackSpeed`、`setShowEvents`、`resetPlaybackData` |
| `chartFilters` | `{zoomRange:[0,0]}` | `updateZoomRange` |
| `maps` | `{registeredMapIds:[]}` | `registerMap`、`unregisterMap` |

`flag` 单项字段（`[观察] @192167` 的 reducers + `@1455874`、`@1454474`、`@13847354`）：
`{id:number, timeCaptured:number(ms), color:string(hex), latitude, longitude, height, category, description:string, state}`
（注意是 **`color`** 与 **`description`**，不是 `colour`/`comment`；`timeCaptured` 同时是
`deleteFlagsOutsideCropRange` 的过滤键）。
`category` 取值来自 i18n：`TRACKING`/`POSITIONING`/`TIMING`/`NAVIGATION`/`SPAN`/`UNCATEGORIZED`；
`state` ∈ `activeFlag | hiddenFlag | hoverFlag | trashFlag | selectedFlag`（`FlagsStatus` 枚举，
`[观察] @191150`，值即字符串本身）。
上限 **10** 个（`N0_FLAGS_TEXT`：“You can add up to 10 flags”；`Tooltip` 里也有
`activeFlags.length==10 → t("MAX_FLAGS")` 的硬判，`@1454591`）。

### 3.5 时间格式

`[观察] @538000 之后` + `@194`

- `TimeFormat` 枚举：`GPS`（默认）/`UTC`
- GPS 显示：`"<week>,<seconds.toFixed(3)>"`，如 `2343,230400.000`
- UTC 显示：`"<DD> <Mon> <YYYY> <HH>:<MM>:<SS>[:<mmm>] UTC"`
- 时长显示：`HH:MM:SS`，超过 1 天则 `"<n> Days HH:MM:SS"`（单数 `Day`）
- 预留常量：`gpsStartTime_OEM="1980-01-06T00:00:00.000Z"`、`MILLISECONDS_PER_WEEK=604800000`、
  `UTC_DIFF_MSEC=18000`

### 3.6 项目状态 `.gpf`

字段、目录布局、校验和算法、`userSettings.json`、`sessionStorage` 键——
完整逐字段表见附录 **`E_GPF项目文件结构.md`**（含可复算算例）。

---

## 4. 接口清单

> 全部为 **renderer → main → (原生)** 的门面；renderer 侧不存在任何 `ipcRenderer` 直连。
> 通道名全表见附录 **B**。

### 4.1 `window.file.*`（文件系统，27 个方法；renderer 实测用到 21 个）

| 方法 | 签名 | 返回值语义 | 副作用/异常 |
|---|---|---|---|
| `readFile` | `(path) => Promise<string>` | 文本内容；**图片会被转成 `data:image/…;base64,…`**（main 侧正则 `\.(png\|jpg\|jpeg\|gif\|bmp\|webp)`） | 读失败返回错误串（不是 throw） |
| `writeFile` | `(path, content) => Promise<string>` | `"File saved successfully"` | 覆盖写 |
| `writeAsBuffer` | `(path, base64OrBuffer) => Promise<string>` | 同上 | 用于二进制 |
| `deleteFile` | `(path) => Promise<string>` | `"File deleted successfully"` | `unlink`；对目录也用它（`deleteFolderFiles`） |
| `renameFile` | `(oldPath,newPath)` | — | — |
| `getFileInfo` | `(path)` | `{birthTime, isFile, birthtime}` | — |
| `readDir` | `(dir) => Promise<string[]>` | 文件名数组 | 失败 `"Directory read failed"` |
| `createDirectory` / `deleteDirectory` | `(path)` | — | `deleteDirectory` 递归 |
| `fileExists` / `directoryExists` | `(path) => Promise<boolean>` | — | — |
| `copyFolder` / `copyFile` | `(src,dst)` | — | — |
| `getUserSettings` / `saveUserSettings` / `saveNASUserSettings` | `(obj)` | — | 写 `userSettings.json` |
| `getNASTheme` | `() => Promise<"light"\|"dark">` | 主程序下发主题 | — |
| `openFileDialog` / `openFileDialogFilter` | `(defaultPath?)` / `(filters[])` | 选中路径或空 | 对话框标题 `Enter Project File`，过滤器 `Project File` |
| `selectDirectoryDialog` / `selectExportDirectoryDialog` | `(defaultPath)` / `(defaultPath, filename, format)` | 目录路径 | 后者标题 `Select a folder to save exported files` |
| `openExportDestination` | `(path)` | — | `shell.openPath` |
| `persistChangesOnClose` | `(cb) => void` | — | **注册关窗回调**；main 收到 `before-quit` 后回调一次，renderer 处理完必须再调 `persistStateComplete()`（`@541475`/`@541557`） |

### 4.2 `window.path.*`

`join(paths[])`（**注意参数是数组**）、`basename`、`dirname`、`getExtension`、`getAppPath()`、
`getUserPath()`。
`[观察] @538000` 处的封装把数组直接透传：`pathJoin = async paths => window.path.join(paths)`，
调用处一律写 `pathJoin([a,b])`——复现时若是 REST/JS 版需要一个"吃数组"的 join。

### 4.3 `window.graphing.*`

| 方法 | 签名 | 说明 |
|---|---|---|
| `requestGraphingData` | `(payload:object) => void` | **无返回值**；结果只通过 `onGraphingResponse` 回来 |
| `onGraphingResponse` | `(cb:(chunk:string\|Buffer)=>void) => void` | 注册回调；每次推一块（不是一行一推），renderer 自己按 `\n` 取最后一行 |
| `killChildProcess` | `() => void` | `taskkill` 子进程；取消/关闭时调用 |
| `openExternal` | `(url)` | `shell.openExternal` |
| `getAppSettingsData` | `() => object` | 读 `appSettings.json` |

### 4.4 `window.charts.* / positions.* / eventsDB.*`（读库）

```ts
charts.getChartDBColumnNames({tableName, chartType, chartName, dbFilename, filePath, key})   // string[]
charts.getChartDBColumnData({…同上, colName, colCount, start, end})                          // number[]
charts.getChartDBData({…同上, start, end})                                                   // 跨度类原始行
positions.getPositionsData({folderPath, startTime, endTime, tableName, key})
positions.getTimeBasedPositionsData({folderPath, tableName, specificTimeEntry, key})         // 最近一条
positions.getDistinctColumnData({…, colName})                                                // 去重值
positions.getTableRowCount({folderPath, tableName, key})                                     // number
eventsDB.getEventsData({folderPath, startTime, endTime, key})                                // 事件行
eventsDB.getCroppedEvents({…})                                                               // 裁剪后事件
```

`key` 恒为 `sessionStorage["EncryptionKey"]`（`@1341680` 系列封装自动注入，调用方不用传）。

### 4.5 `window.app.* / clipboard.* / browserWindow.*`

- `app.onQuitAPP()` —— 退出（`@15993596`，SettingsMenu 的 Quit）
- `app.appIs()`、`app.getPlatform()`、`app.getTmpFolderPath()`、`app.onTabsClose(cb)`、`app.onWindowBlur(cb)`
- `clipboard.copyText(text)` —— 校验页"复制摘要"用
- `browserWindow.generatePDF(htmlPath, pdfPath, headerTemplate)` —— 见 §4.7

### 4.6 i18n（i18next 23.16.3）

`[观察] @384572`

```js
instance.use(Backend).use(Browser).use(initReactI18next).init({
  fallbackLng: "en",
  debug: false,
  interpolation: { escapeValue: false },
  resources: { en: { translation: translationEN }, fr: { translation: translationFR } }
});
```

| 项 | 值 |
|---|---|
| 语言列表 | **`en`、`fr`** 两种；`en` 329 个键，`fr` 只有 69 个键（缺的自动落回英文） |
| 资源位置 | **内联在 bundle 里**（`translationEN` @375247..@380997，`translationFR` @383633..@384534），**不落盘、不走网络** |
| 后端 | 注册了 `i18next-http-backend`（`Backend`），但 `init` 未给 `loadPath`/`backend` 选项 → 实际请求路径为 i18next 默认 `locales/{{lng}}/{{ns}}.json`；由于 `resources` 已内联，**正常情况不会触发网络请求** `[推断：i18next 先查 resources 再打后端]` |
| 检测器 | `i18next-browser-languagedetector` 已 `use()`，但它只写 `localStorage` 缓存（2 处 `setItem` @357957/@358400）；**`App` 里第一条 effect 就 `changeLanguage("en")`，把检测结果覆盖掉** |
| 切换 UI | **没有**。`SettingsMenu` 只有 Theme/Time/Quit，`LANGUAGES` 文案是死字符串 |
| 命名空间 | 只用默认 `translation` |

`fr` 覆盖到的 69 个键见附录 `G2_i18n_FR.tsv`，其余全部显示英文。
`GA_HELP_FOOTER = "Graph Help File, D100356 v1.0, October 2025"` —— 帮助文档号可直接引用。

### 4.7 导出（4 种）

`[观察] @15993576 exportOptions`、`@16011593`、`@16003128`、`@16004406`、`@16196283`

| 类型 | 谁生成 | 关键参数 |
|---|---|---|
| **HTML Report** | renderer 自己拼 HTML（`@16196283`）+ 把 `echarts.min.js`、`Icons/` 拷到 `<project>\html\` | 见 §4.7.1 |
| **PDF Report** | 先走 HTML，再由**主进程** `browserWindow.generatePDF(htmlPath, pdfPath, headerTemplate)`（`browser-window:print-to-pdf`） | main.jsc 里 `printToPDF` 选项名可见：`printBackground`、`displayHeaderFooter`、`marginsType`、`preferCSSPageSize`、`headerTemplate`、`footerTemplate`；footer 模板是 `<span class="pageNumber"></span> / <span class="totalPages"></span>`（右对齐、10 px、左右 40 px 内边距）。加载后用 `executeJavaScript` 等 `window.__reportChartsReady`（拿不到就退化为等 `load` + 双 `requestAnimationFrame`） |
| **KML** | 原生 `ExportKML` | `source=<project>\GDS`、`destination=<选中的父目录>`、`KMLFileName=<项目名>`、`timestamp_format=<TimeFormat 数字>` |
| **CSV (original data only)** | 原生 `ExportCSV` | `source=<project>\GDS`、`destination=<选中目录>\csv`、`timestamp_format="GPS"\|"UTC"`、`selectedPlots=[图标题…]`；导出后 renderer 还会给每个 `.csv` **补 UTF-8 BOM**（`EF BB BF`，`@16213359`） |

**没有 PNG / 图片导出**（`[观察]`：`exportOptions` 仅 4 项；全文件 `"image/png"` 只出现在
Luciad/echarts 库内部，无应用级调用）。图块菜单里的"导出"只导出整包。

#### 4.7.1 报表 HTML 的生成细节（复现必读）

1. `collectECharts(textColor)`：扫 `.echarts-for-react` 容器 → `getInstanceByDom()` → `getOption()`；
   把 `xAxis[0].axisLabel.formatter` 与 `tooltip.formatter` 的**函数序列化成字符串**
   （报表页要重新 eval，所以不能留函数）；`grid` 强制改成 `{show:true,borderWidth:2,left:80,right:30,top:40,bottom:40}`；
   若该图块属于某个星座分组，则 `option.title.push(分组标题样式)`（`#00516f` 底、白字、12 px 粗体）
2. `collectCanvasData()`：扫 `canvas[data-type="custom"]`，从 `window.__allCanvasCharts__` 取数据
3. `collectTabImages()`：**地图**单独处理 —— 用 WebGPU `PostRender` 事件把颜色纹理
   `copyTextureToBuffer` 读回 CPU（`copyTextureToCPU`，处理 `bytesPerRow` 4 字节对齐 + BGRA→RGBA 交换），
   转 `ImageData` → `canvas.toDataURL("image/jpeg")`；再把 `html2canvas(container, {scale:1,
   logging:false, backgroundColor:null, ignoreElements: el => el.tagName === "CANVAS"})` 的覆盖层
   （标签、指北针等 DOM）`drawImage` 叠上去，最后 `toDataURL("image/jpeg", 0.8)`
   —— **只有第一张地图**被采用（`(await collectTabImages())[0]`）
4. 拼 HTML：`<script src="scripts/echarts.min.js"></script>` + 内联 CSS 变量
   （`--background-color`、`--span-text-color`，`[data-theme=dark|light]` 两套）+ 各图块的 option JSON
5. 落盘：`<project>\html\<name>.html`，并把 `resources\scripts\echarts.min.js` 与整个
   `resources\Icons\` 目录复制过去
6. PDF 前会**打补丁**：把 HTML 里 `option.toolbox[0].feature.restore = {…};` 整段删除
   （避免报表里出现"还原"按钮），生成完再写回原文（`finally` 里恢复）

---

## 5. 报文/协议细节（字节级 / 单位 / 边界）

### 5.1 信封

- **读/校验类**：`{"<tabUniqueId>": {...}}`，回包 `hasOwnProperty(tabId)` 为真
- **命令类**：`{"id": {"name": "<Method>", ...}}`
- 回包**一行一个 JSON**，renderer 只取 `buffer.split("\n").at(-1)`（`@552074`）——
  即**一个 chunk 里前面的行会被丢弃**。这是原生侧"进度行 + 结果行"混排时的隐含约定，
  复现时要么保证一块只一行，要么照抄"取最后一行"。

### 5.2 `StartProcess`（裁剪重算）

```json
{"id":{"name":"StartProcess","filePath":[…],"configfilePath":"…\\logger_config.toml",
 "projectDirectory":"…","EncryptKeyInput":"<项目名>",
 "timeLine":{"starttime":<ms>,"endtime":<ms>},"PlotSummary":{…}}}
```

回包 `Percentage` 是 `{ "PVT": 40, "Tracking_Measurements": 12, … }`，
renderer 求算术平均并 `Math.min(avg, 99)` 显示（"到 99 就停"，100 才切页）`@13851466`。

### 5.3 时间基准（**单位换算，必抄**）

| 常量 | 值 | 依据 |
|---|---|---|
| 起点 | `1980-01-06T00:00:00Z` | `gpsStartTime_OEM` |
| 一周 | `604 800 000 ms` | `MILLISECONDS_PER_WEEK` |
| GPS-UTC | `18 000 ms`（硬编码） | `UTC_DIFF_MSEC` |

```
gpsWeek    = floor(ms / 604800000)
gpsSeconds = (ms mod 604800000) / 1000
utc        = new Date(1980-01-06T00:00:00Z + ms - 18000)
```

**算例**：`ms = 1 417 276 800 000`
→ `week = 2343`、`gpsSeconds = 230400.000`、UTC = `2024-12-03T15:59:42.000Z`。
反向：`UTC 2024-12-03T15:59:42Z` → `ms = 1417276800000 + 18000`。
`[注意]` 18 s 是**构建期常量**，2026 年后闰秒若变，UTC 列会偏 1 s。

### 5.4 `ValidationCode` 映射

`[观察] @551948`

| code | severity | messageKey |
|---|---|---|
| `0` | success | （无） |
| `1` | success | `NOVATEL_NMEA_LOGS_FOUND` |
| `2` | success | `POSITION_LOGS_FOUND` |
| `-1` | error | `NO_NOVATEL_NMEA_LOGS_FOUND` |
| `-2` | error | `NO_POSITION_LOGS_FOUND` |
| `-3` | error | `DATA_CORRUPTED`（"No Valid Data."） |
| `-4` | error | `NO_VALID_POS_DATA` |
| 其他 | error | `UNKNOWN_VALIDATION_ERROR` |

`[观察]` 只有 `severity===success` 才继续要密钥/画图；`code≠0 且 ≠1/2` 会杀进程并回向导。

### 5.5 `msg` 错误串

`INVALID_GPF_FILE`、`READWRITE_PERMIT_ERROR`、`FILE_EXISTS_ERROR`，
外加原生可能回 `"no such file or directory"`（`MessageKey.NO_FILE` 的字面值，`@542148`）。
renderer 用**字符串包含**判定：`checkIfPermissionError` 找 `EPERM`/`EACCES`，
`checkIfFileDeleted` 找 `ENOENT`（`@551948` 附近）。

### 5.6 事件 BLOB（干扰频谱）

`[观察] @13650900 decodeInterferenceBlob`

```
每条记录 5 字节（小端）：
  offset 0..3  float32  freq  —— MHz
  offset 4     uint8    flag  —— 1 = 该频点超阈值
```

**算例**：`00 00 48 42 01` → `float32LE = 50.0` → 50 MHz 超限（图上标红）；
`00 00 48 42 00` → 同频点未超限。
解码后结构：`{<freq>: boolean}`，键是 MHz 数值的字符串形式（`frequencyMap[item.freq]`），
再与 `{timestamp → {frequency, active, position:{lat,lon}}}` 合并。

### 5.7 抽稀（下采样）规则

**两层**，不要只抄一层：

1. **SQL 层 `rowid % step`**（`main.jsc@57719` / `@59248`）——`step` 由 renderer 先算：
   ```
   intervals_i = ceil((end_i - start_i) / (min_diff_i*1000 || 1000))
   total       = Σ intervals_i
   step        = total > 100000 ? ceil(total / 100000) : 1
   ```
   （`MAX_DECIMATION_POINTS = 100000`，`@566019`/`@575103`）
2. **echarts 层 `sampling:"lttb"`**（`@15702187`）——`large:true`、`progressive:2000`、
   `progressiveThreshold:3000`；**例外**：`Position Status` / `Position Type` 两张图的
   `sampling` 是 `"none"`（`isPositionChart` 判定，见 `@15702610`）。

**算例**：6 段、每段 30 min、`min_diff=1 s` → 每段 1800 → total 10800 < 1e5 → `step=1`（不抽稀）。
若 total = 250000 → `step = 3`（每 3 个 rowid 取 1）。

### 5.8 图表 option 结构（echarts，逐项）

`[观察] @15710005`（时间序列图）

```js
{
  xAxis: { type:"time", boundaryGap:false, min:zoomRange[0], max:zoomRange[1],
           axisPointer:{snap:false}, axisLine:{show:true, onZero:false},
           axisLabel:{ formatter:createTimeFormatter(timeFormat, zoomRange[0]),
                       fontSize:11, rotate:0, overflow:"truncate",
                       showMinLabel:true, showMaxLabel:true, hideOverlap:true },
           splitNumber:16, minInterval:10000 },
  yAxis: { type:"value", show: chartType!=="bar", name: yAxisUnits ? " "+units : "",
           nameLocation:"middle", nameGap:45, nameTextStyle:{fontSize:16},
           min: minYZero===true ? 0 : yMin, max: yMax,
           axisLine:{show:true,lineStyle:{width:1}}, axisTick:{show:true} },
  dataZoom: [ {type:"inside", xAxisIndex:0, filterMode:"none", minValueSpan:1000,
               zoomOnMouseWheel:false, moveOnMouseMove:false, moveOnMouseWheel:false, start:0, end:100},
              {type:"inside", yAxisIndex:0, filterMode:"none", …同左} ],
  toolbox: { show:true, right:50, feature:{ dataZoom:{ icon:null, yAxisIndex:"all",
             xAxisIndex:"all", brushStyle:{borderType:"dashed", borderWidth:1} } } },
  grid: { show:true, borderWidth:2, left:80, right:30, top:40, bottom:40 },   // 仅在导出时强制
  series: [ …line/bar…, {id:"flagsSeries"…}, 悬停竖线, 悬停文字 ]
}
```

- **x 轴刻度的"两行"用 echarts rich text 实现**，不是 `\n` 换行：
  `createTimeFormatter(timeFormat, xMin)`（`@561444`）在 `timestamp===xMin` **或** GPS 周/UTC 日期
  发生变化时返回 `` `{a|${gpsWeek}}\n{b|${sec}}` ``（UTC 为 `{a|dd Mon yyyy}\n{b|HH:MM:SS}`），
  其余刻度只返回秒/时分秒 —— 即**每周（或每天）交界处重新显示两行**，这是读图时最明显的特征。
  秒格式化 `formatGpsSeconds`：整数用 `toFixed(0)`，否则 `toFixed(3)`。
- 序列样式：`lineChartStyleMap = {line:{symbol:"line",symbolSize:2,lineWidth:2},
  scatter:{symbol:"circle",symbolSize:3,lineWidth:0}, bar:{symbol:"rect",symbolSize:[2,15],lineWidth:0}}`
- 多图**联动**：任何图 hover 时 `window.dispatchEvent(new CustomEvent("globalHover",{detail:x}))`，
  其他图监听后 `dispatchAction({type:"showTip"})` 画同步竖线（`@15702610`）
- 拖动缩放：`takeGlobalCursor({key:"dataZoomSelect", dataZoomSelectActive:true})`，
  鼠标在图上时才开启
- 序列配色：`stringToColor(colName,index,theme)`（FNV-1a 变体 hash → HSL，`@566600`）——
  `height` 列强制用 `MSL_HEIGHT_COLOUR`；用户改色写 `sessionStorage["PersistenceInfo"]`
- 2D 轨迹图（`GeoMapChart` `@15713064`）：**不是 echarts map**，而是
  `xAxis:{type:"value", name:"Longitude (degrees)"}`、
  `yAxis:{type:"value", name:"Latitude (degrees)", axisLabel:{rotate:45, formatter:v=>Number(v).toFixed(5)}}`，
  `series:[{id:"geoMapSeries", type:"line", smooth:true, progressive:2000, symbol:"circle",
  symbolSize:5, lineStyle:{color:"transparent"}, itemStyle:{color:"#5464f8ff"}}]`

---

## 6. 状态机与事件流

### 6.1 首页向导状态机（4 步）

```
Welcome → ProjectInfo → FileUpload → FileValidation ─┬─ success(0/1/2) → 建 gpf → /overview
                                                     ├─ error(-1..-4) → 回 FileUpload + ErrorBanner
                                                     └─ CANCEL → 二次确认 → killChildProcess + 删 <project>\GDS
```

`[观察] @1342317`、`@1344658`、`@1347635`

细节：
- 第 2 步校验：项目名非空、路径字符集（`/[\\/:*?"<>|]/` 命中即错）、
  全路径长度 **< 256**（`MAX_FIELD_LENGTH`）、父目录必须存在、同名目录已存在时弹
  `PROJECT_NAME_EXISTS`/`WANT_TO_CONTINUE_QUESTION`（覆盖则先删）
- 第 3/4 步：`prepareGraphingRequest()` 发一次，然后靠 `Percentage` 流推进进度条
- 收尾：`GetEncryptionKey` → `checkPositionThreshold()`（`SELECT COUNT(*)`，
  超过 **200 000** 行则提示样本过大）→ 写 gpf（`PageRoute`、checksum）→ 跳 `/overview`

### 6.2 校验/处理事件流（谁触发、谁消费）

```
点击 Process / 向导 Next
   → prepareGraphingRequest() 或 StartProcess  ──invoke──▶ main
                                                        └─▶ 子进程 (graph-node-wrapper.node)
子进程 stdout ──▶ main ──"graphing:child-response"──▶ renderer.onGraphingResponse(chunk)
   → parseGraphingResponseData(chunk)         // 只取最后一行 JSON
   → handleReadMessageComplete(parsedData)
        ├─ api==="GetEncryptionKey" → sessionStorage + checkPositionThreshold
        ├─ api==="FileValidation"   → 进度/结果（Overview 里用于裁剪进度）
        ├─ Terminated              → killGraphingProcess + 删 GDS
        ├─ ValidationCode≠0        → 错误横幅
        └─ Percentage===100        → 完成：写回 gpf（DataInfo/PlotSummary/Messages + checksum）
                                     → 跳 /process
```

`[观察] @13850452`（Overview 的 `handleReadMessageComplete`）+ `@1347635`（Wizard 的同名逻辑）

### 6.3 进度语义（**两个不同的 Percentage**）

- 校验阶段：`number`（0..100）
- 处理阶段：`Record<group, number>`，renderer 求平均 → 显示 `min(avg, 99)`，
  `avg===100` 时才真正切页（避免"到 100 但还没完"的闪烁）`@13851466`

### 6.4 导出状态机（Tab 轮转 + 渲染计数）

`[观察] @16210749`

```
点 Export → ExportModal 选类型（4 选 N）+ 选哪些 Tab
  → onExportClick(folderPath)
      ├─ CSV/KML：直接发 `ExportCSV`/`ExportKML`（各自带 selectedPlots / timestamp_format）
      └─ HTML/PDF：必须**逐个 Tab 切换**并等图表画完
            for tab of selectedTabs:
                handleExportRequest(tab)   // 切 Tab，chartsRendered=0
                    → 等 chartsRendered >= tabChartCounts[tab]
                    → 超时 15 000 ms（EXPORT_TIMEOUT）强行继续
            → collectAllTabDataOnce() → 生成 HTML → 可选 generatePDF
  → 完成：copy 结果到目标目录 + addUTF8BOMToCSVFiles() + `FILE_SUCCESSFULLY_EXPORTED`
```

配套：`getSupportedExportTabs()` 会**剔除 `Project Information`**（`@16015706`），
并强制按 `GRAPH_GROUPS` 声明顺序排序（保证报表里 Tab 顺序稳定）。

### 6.5 播放（时间轴）

`[观察] @13842350` + `@13801156` + `@194`：

```js
newTime      = (Date.now() - playbackStartTime) * playbackSpeed   // 绝对映射，不是增量累加
current      = constrainToMaskedArea(effectiveStart + newTime)    // 夹在 [editedStart, editedEnd]
if (current >= maskedEnd || newTime >= effectiveDuration)
    → setCurrentTime(maskedEnd), setIsCompleted(true), setIsPlaying(false)
```

- 倍速只有 **1/2/5/10/20**（`speedOptions`，`@13801156`）
- 循环用 `requestAnimationFrame`（不是 `setInterval`），每帧 `setLocalCurrent` + `dispatch(setCurrentTime)`
- 因为映射是"绝对"的，`playbackSpeed` 变更时必须同时重置 `playbackStartTime`，否则画面会跳变
- 播放时切到非 GOS 的 Tab 会**自动暂停**并记住状态（`handleTabChange`，`@16210749`），
  回到 GOS 再恢复——这是"只有地图页才能播"的产品约束
- 裁剪（`CropTimeline` → `applyCropMasking`，`@13705105`）会把 `editedStart/editedEnd` 写入
  playback slice，并同时 `updateZoomRange([start,end])`（图表横轴跟着缩）；裁剪后
  `deleteFlagsOutsideCropRange` 会删掉区间外的标记

### 6.6 关窗持久化握手

`[观察] @16246025` + `@541475`

```
main: before-quit → webContents.send('file:persistence-on-app-close', cb)
renderer: writeDataForStore(currentState)
   → 读 gpf → 覆盖 FlagsInitialState / currentTimeStamp / isPlaying / editedStart / editedEnd
            / PersistenceInfo → addChecksum → 写回
   → sessionStorage.clear() + dispatch(resetFlagsState/resetPlaybackData)
   → 最后 persistStateComplete()  // 通知 main 可以退
```

**若 renderer 不调 `persistStateComplete`，main 会一直等**（这就是为什么它在 `finally` 里）。

### 6.7 地图事件流

`LuciadMap` 创建 `new RIAMap(div,{reference:CRS:84})` → `createMapInstance` →
`mapNavigator.constraints = {scale:{maxScale:0.001}}`（2D）或
`{above:{terrain:true, mesh:false, minAltitude:50, maxAltitude:1e7}}`（3D）→
`worldMapBounds()` 限制在 `[-180,360,-90,180]`。
图层 id 常量：`overviewMap`、`detailsMap`、`vehicle`、`events`、`flagsLayer`、
`trackHoverLayer`、`trackTravelledLayer`、`timeMarker`、`interference`、`spoofing`、`jamming`。
右键加标记的判定距离 `CONTEXTMENU_SENSITIVITY=30`（像素），弹窗预留
`ADDFLAG_POPUP_SIZE={width:320,height:177,buffer:50}`（防止贴边溢出）。

---

## 7. 与其它子系统的耦合点

### 7.1 NAS 主程序 → Graph 的启动（Windows）

`[观察] 01_解包/app/view/addApplication/addApplication.js:2312-2334`

```js
handleExeAppOpen(id):
  prerequisitesPath = <appRoot>/view/prerequisites/<Name>_prerequisites.json
                      ‖ fallback: readRegistryValueHKCU(name,"NoncoreDataPath") + 同名文件
  exeName = prerequisites.exeName.replace(".exe","")        // "Graph"
  appPath = readRegistryValueHKCU(prerequisites.title,"Path")   // HKCU\Software\NovAtel Inc.\Graph
  launchOrFocusApp(exeName, appPath)
```

`[观察] addApplication.js:2237-2253`

```js
launchOrFocusApp(exeName, appPath):
  if (appExist(appPath, exeName))                       // 要求 <appPath>\Graph.exe 与 uninstall.exe 都存在且非 0 字节（:2335-2351）
     spawn(path.join(appPath, exeName), [], { detached:true, stdio:"ignore" })
```

结论：
- **启动参数：无**（空数组）。Graph 不接收项目路径，靠自己的"最近文件"和 gpf 打开。
- 工作目录继承 NAS 进程；`detached + stdio:"ignore"`，与父进程无管道。
- 子进程 `close` 事件里 `serverModel.isUpdateRequired()`（因为独立安装的 Graph 可能被它自己更新过）。

### 7.2 `Graph_Setup.exe`（157 MB）的作用与安装位置

`[观察] 01_解包/app/Apps/windows/Graph_Setup.exe`，大小 `157 612 185` 字节。
`[观察] 01_解包/app/updater.js:105-128`：

```bat
:: dev 分支用 %var_app_path%（= 当前运行目录）；prod 分支把同样三行里的
:: %var_app_path% 换成 !var_registry_path!（= HKCU\...\NovAtel Application Suite 的 Path）
set "setupPath=%var_app_path%\resources\app.asar.unpacked\Apps\windows\Graph_Setup.exe"
set "installDir=%var_app_path%\Graph"
powershell -Command "Start-Process -FilePath '!setupPath!' -ArgumentList @('/S', ('"/D=!installDir!"')) -Verb RunAs -Wait"
```

- 参数：**`/S`（静默）+ `/D=<安装目录>`（NSIS 的标准静默安装约定，`/D` 必须在最后且不加引号包裹整体）**
- `-Verb RunAs` → **需要管理员提权**
- 安装目录：`<NAS 安装目录>\Graph`
- 触发时机：NAS 自身更新时（dev 分支拷到 `%var_app_path%`，prod 分支拷到注册表 `Path`）
- `[推断]` 安装器会把 Graph 写进 `HKCU\Software\NovAtel Inc.\Graph`（`Path` = 安装目录、
  `NoncoreDataPath` = nonCoreAppData 所在目录），因为启动器只从这两个值取路径（§7.1），
  且 `isExeAppInstalled()` 就是 `Test-Path "Registry::HKCU\Software\NovAtel Inc.\Graph"`（`addApplication.js:1609-1643`）

### 7.3 `nonCoreAppData` 注册机制

三份文件（`01_解包/Graph/resources/nonCoreAppData/`）：

| 文件 | 内容 | 用途 |
|---|---|---|
| `AppDetails.json` | `{"Path":"","Version":""}` —— **空模板** | 运行时由 Graph 主进程 `regNonCoreApp` 填 `Path`（自身 exe 目录）与 `Version`（读 `package.json` 的 `version`），写到 `%APPDATA%\<NAS>\NASnoncorelinks\Graph\AppDetails.json` |
| `Graph_prerequisites.json` | `{appDetails:{title:"Graph", appName:"Graph", version:"2.0.0", exeName:"Graph.exe", uninstallName:"uninstall.exe"}}` | 给**主程序**读的元数据（决定首页磁贴、exe 名、卸载器名）。`[观察]` 其中 `version` 写的是 **"2.0.0"**，与 `package.json` 的 `2.11.0` 不一致——这是强制"认为已过时/需更新"的钩子，还是漏改，`[未知]` |
| `Graph_noncoreapp.svg` | 3 749 B 图标 | 磁贴图标；主程序按 `<userData>\NASnoncorelinks\<App>\<App>_noncoreapp.svg` 取（`addApplication.js:2201`） |

`[观察] main.jsc` 的 `regNonCoreApp` 相关串：`copyFiles`、`readAppDetails`、`copyNoncoreFolder`、
`updateAppDetails`、`NASnoncorelinks`、`APPIMAGE`、`version`，错误串
`regNonCoreApp-Source directory not found:` / `-Failed to copy nonCoreAppData files:` /
`-Failed to write AppDetails.json:`；`[观察] addApplication.js:1710-1753` 反过来校验
"有 `AppDetails.json` 且其 `Path` 指向真实存在目录"才算已安装。

### 7.4 关闭约定：`taskkill /IM Graph.exe /F`

`[观察] 01_解包/app/main.js:34-41`

```js
function killGraphApp() {
  const killCmd = process.platform === 'win32' ? `taskkill /IM Graph.exe /F` : `pkill -f "Graph"`;
  exec(killCmd, (err) => { /* 忽略错误：Graph 没开也算成功 */ });
}
```

触发点（`[观察]` `main.js` 内共 **2 处**调用）：
1. `ipcMain.on('close-App')` —— 主程序收到渲染进程的"关闭"指令时（`main.js:175-183`）
2. `app.on('before-quit')` —— 主程序退出前，同时向**主程序自己的**渲染进程
   `webContents.send('closeApp')`（`main.js:210-215`）

**这是硬杀**：没有 `before-quit` 握手，所以 Graph 自己的 `persistChangesOnClose` 只有在
**用户从 Graph 里退出**时才走得到；被 NAS 杀掉时 `.gpf` 里的播放位置/标记**会丢**。
`[推断]` 这也是 Graph 要额外维护 `PageRoute` + `DataSummary` 快照的原因（下次打开能恢复大半）。

### 7.5 共享的约定与资源

| 耦合 | 内容 |
|---|---|
| `logger_config.toml` | 每次请求都带 `configfilePath = <appPath>\logger_config.toml`；文件由 `winston` 侧生成，**不随包发布**（解包产物里没有），首次运行才生成 |
| `resources/native_modules/<platform>/` | `graph-node-wrapper.node`（Windows 8.8 MB / Linux 10.2 MB）；`[观察]` main.jsc 还引用 `configurationfile.node`，**包内不存在** |
| `resources/scripts/echarts.min.js` | 1 034 147 B，仅用于把报表 HTML 脱离主程序后仍能渲染 |
| `resources/Icons/` | `GraphingLogo.png`、`HxGNLogo.png`、`icon.ico`、`Flags/*.svg`；报表头部的两个 logo 就是它们（base64 内联进 HTML） |
| 主题 | NAS 通过 `get-NAS-theme` 下发 `light/dark`；Graph 里 `document.body.setAttribute("data-theme", …)` 驱动 CSS 变量 |
| 时间度量 | 与 NAS 主程序一致：GPS 周/秒；主程序 `userStore` 里也有 `app.timeFormat` |

### 7.6 安全相关的"意外耦合"

`[观察] index-B86bHcCD.js:1 @~387000..@407000` —— **整个 CI 构建环境的 `process.env` 被打进了
renderer bundle**（`electron-vite` 把 `process.env` 静态替换成对象）。其中有：
GitLab job 变量、`FROGBOT_ACCESS_TOKEN`（JWT）、`ART_DOCKER_PASS`、`ARTI_PUBLISH_PASS`、
`DOCKER_AUTH_CONFIG`（含 base64 凭据）、内网 artifactory 地址、构建机名 `HYD-PWTR10PC1`、
构建路径 `D:\GitLab-Runner\builds\vnuoHTwqV\...\Graphing-UI`。
另有 `GOOGLE_MAPS_API_KEY`（`@1328196`，`AIza…` 明文）与 `STATIC_KEY="GAA170P4468F1218"`（gpf 校验盐）。
本文**不复述具体密钥值**；复现时应改用 `import.meta.env` 白名单，不要整段 `process.env` 替换。

`[观察]` 同处还有构建信息串：
`"\nRelease Build 2.11.0\n\nSee merge request nas-group/nas/dev/noncore/graphing/ui/Graphing-UI!838"`。

---

## 8. 复现清单（R1..R40，每条可验收）

> 格式：断言 → 依据。`[观察]` 均可由附录里的抽取产物复核。

### 8.0 复现范围分级（哪些能纯 JS，哪些必须重写原生）

| 能力 | 现有实现 | 复现代价 | 结论 |
|---|---|---|---|
| 全部 UI（3 个页面、向导、标记、时间轴、网格布局） | React 18 + PrimeReact 10 + primeflex + react-grid-layout | 低：都是 npm 包 | **纯 JS 可复现** |
| 图表（16 张） | echarts 5 + echarts-for-react 3.0.2 | 低：`option` 结构已逐项列出（§5.8、附录 C） | **纯 JS 可复现**，只需把 SQL 换成任意数据源 |
| 抽稀 `step` 计算、配色 `stringToColor`、时间换算、GPF 校验和 | 纯 JS（§5.7、附录 D/E） | 极低：算法已完整还原，可直接照抄 | **纯 JS 可复现** |
| 导出 HTML 报告 | 字符串拼接 + 复制 `echarts.min.js` | 低 | **纯 JS 可复现** |
| 导出 PDF | Electron `webContents.printToPDF`（主进程） | 低：Electron 自带；非 Electron 用 Playwright/Chromium headless | **纯 JS 可复现** |
| 地图（轨迹着色、事件图标、标记拖拽、时间轴联动） | LuciadRIA 2026.0.07（JS + wasm，WebGPU） | 中：Luciad 是商业授权；替换成 MapLibre/Leaflet 需重写 4 个图层 + 拾取 | **纯 JS 可复现**（换库），但**保真度最难**；`taskkill` 无关 |
| 读图表/位置/事件 DB | `better-sqlite3-multiple-ciphers`（**原生 addon**）+ `PRAGMA cipher='aes128cbc'` | 中：库可原样 `npm i`（跨平台有预编译包） | 需 native addon，但**不必自己写 C++** |
| 日志解析 + 建库（SBF/ASCII → `position.db`/`<table>.db`/`event_v2.db`） | `graph-node-wrapper.node` 的 `TabFileReader_api`（Windows 8.8 MB / Linux 10.2 MB） | **高**：协议解析 + 表结构生成 + 分段统计全在里面 | **必须重写**（或用官方 CLI/库）；这是整个复现的 90% 工作量 |
| 派生 DB 密钥 `GetEncryptionKey` | 同一个原生模块 | 高（算法未知，见 U1） | **必须重写**，且只能靠黑盒对照 |
| 导出 CSV/KML 的**内容**生成 | 原生 `ExportCSV`/`ExportKML` | 中：CSV 可从 DB 直接导；KML 需要轨迹抽稀 + 时间戳 | **需重写**（纯 JS 可行，但要自己实现） |
| 日志配置 `logger_config.toml` / `configurationfile.node` | 原生 | 低：可跳过（只影响日志级别） | **可省** |

**最小可行闭环（建议顺序）**：
1. 只做 `/process` + PVT 的 3 张图（`positionmode`/`positionsd`/`height`）+ 读库 + 导出 PDF
   —— 不需要地图、不需要原生解析（用现成加密库直读官方生成的项目目录即可验证）；
2. 加 `/overview` 的地图回放（换 MapLibre）；
3. 最后才做解析与建库（自研 SBF 解析器 + 按 §3.2 表结构写库），此阶段才需要决定
   是否复刻 `aes128cbc` 加密（若数据自产自销，可以不加密，只保留 `key` 字段占位）。

**A. 结构与启动**

- `R1` 主程序用 `require("./bytecode-loader.cjs")` 再 `require("./main.jsc")` 两步加载，加载器必须先把 `--no-lazy`、`--no-flush-bytecode` 设上，并把 dummy bytecode 的 offset 12..16 覆盖到目标文件。`[观察] out/main/main.js`、`bytecode-loader.cjs:1-60`
- `R2` 路由只有 `/`、`/overview`、`/process` 三条，且必须用 **HashRouter**（`#/overview`），不是 BrowserRouter。`[观察] index-B86bHcCD.js:2385 @16249777`
- `R3` 首页向导必须是 4 步，顺序 `Welcome → ProjectInfo → FileUpload → FileValidation`，第 4 步期间可取消并二次确认。`[观察] @1343010`
- `R4` `/process` 的 Tab 顺序固定为 `GOS, PVT, Heading & Attitude, Tracking & Measurements, Receiver Status, Project Information`，其中 `GOS` 永远第一、`Project Information` 永远最后。`[观察] @16162103`
- `R5` 渲染进程不得出现 `require`/`ipcRenderer`/`contextBridge`；一切 I/O 走 `window.{file,path,graphing,charts,positions,eventsDB,clipboard,app,browserWindow}`。`[观察]` 全文 0 命中（`J_Window_API.tsv`）

**B. 协议**

- `R6` 回包解析只取 `buffer.split("\n").at(-1)`，且"是否读类应答"判定为 `hasOwnProperty(tabId) && (!api || api==="FileValidation" || api==="GetEncryptionKey")`。`[观察] @552074`
- `R7` `ValidationCode` 的 7 个取值必须按 §5.4 映射，`-3` 显示 "No Valid Data."、`-4` 显示 "No Valid Position Data."。`[观察] @551948`
- `R8` `tabUniqueId` 形如 `<Date.now().toString(36)>-<random>`，`byteLength` 必须 ≤10，越界抛 `byteLength cannot exceed 10`。`[观察] @645549`
- `R9` `StartProcess` 的 `Percentage` 是对象，UI 显示 `min(mean(values), 99)`，只有 `mean===100` 才切页。`[观察] @13851466`
- `R10` `ExportCSV` 的 `timestamp_format` 是字符串 `"GPS"/"UTC"`，`ExportKML` 的 `timestamp_format` 是 `TimeFormat` 枚举数字——两者不能统一。`[观察] @16010683 vs @16011633`
- `R11` 取消验证的命令名是全小写 `stopfilevalidation`。`[观察] @1344658`
- `R12` 每次 DB 读请求都必须带 `key`，值来自 `sessionStorage["EncryptionKey"]`，由 `GetEncryptionKey`（参数 `EncryptKeyInput`=项目名）取得。`[观察] @1341680`、`@599796`

**C. 数据**

- `R13` 项目目录必须有 `<Name>.gpf`、`DataSummary.json`、`GOS\`、`GDS\` 四项；取消处理只删 `GDS\`。`[观察] @595084`、`@599243`
- `R14` `.gpf` 的 `checksum = sha256hex(JSON.stringify(gpf − {checksum, EncryptionKey}) + "GAA170P4468F1218")`，写盘 `JSON.stringify(obj, null, 2)`；校验失败返回 `INVALID_GPF_FILE`。`[观察] @549423`
- `R15` gpf 的 `updatedProjSummary` 优先于 `DataSummary` 文件；后者存在时把其所有键**平铺合并**进 gpf 对象。`[观察] @549423 fetchDataSummary`
- `R16` 位置表名必须用 `getUsedPositionLog()`：优先 `Position View.GNSS` 且必须含 `BESTPOS`，否则整组换 `.INS`，取数值最小索引。`[观察] @1335532`
- `R17` 图是否出现由"消息名 ∩ 图表 title"决定，并额外加入字面量 `"Planimetric"`。`[观察] @578411`
- `R18` `userSettings.json` 的 `recents` 上限 12，按 `filePath` 去重、新条目 `unshift`。`[观察] MAX_RECENT_ENTRIES=12`、`@548305`
- `R19` SQLite 必须用 `PRAGMA cipher='aes128cbc'`、`PRAGMA key=…`、`PRAGMA query_only=ON`，连接参数 `{readonly:true, fileMustExist:true}`。`[观察] main.jsc@39858-39949`
- `R20` 库文件名常量：`position.db`、`events.db`、`event_v2.db`、`logginginterval.db`；图表库为 `<tableName>.db`。`[观察] main.jsc@73511`、`@577385`
- `R21` 抽稀必须两层：SQL `rowid % step`（step 由 `ceil(total/100000)` 得，total 按 `min_diff` 累计）+ echarts `sampling:"lttb"`；`Position Status`/`Position Type` 用 `sampling:"none"`。`[观察] @575103`、`main.jsc@57719`、`@15702187`
- `R22` 时间换算：`week=floor(ms/604800000)`、`sec=(ms%604800000)/1000`、`UTC=1980-01-06Z+ms−18000`；`1 417 276 800 000 ms` 必须显示 `2343,230400.000` 与 `2024-12-03T15:59:42Z`。`[观察] @538000 附近`

**D. 图表与地图**

- `R23` 图表目录必须是 16 张（PVT 7 + HA 3 + Tracking 3 + Receiver Status 3），表名/标题/单位/类型逐字一致（见附录 C）。`[观察] @562300..@563200`
- `R24` 时间轴 `xAxis` 必须 `type:"time"`、`min/max = zoomRange`、`splitNumber:16`、`minInterval:10000`；x 轴刻度用 rich text：首个刻度与**每个 GPS 周/UTC 日界线**处返回 `{a|周/日期}\n{b|时分秒}`，其余只返回时分秒。`[观察] @15710005`、`@561444`
- `R25` y 轴 `name` 为 `" "+yAxisUnits`（有前导空格）、`nameLocation:"middle"`、`nameGap:45`；`minYZero===true` 时 `min=0`。`[观察] @15710005`
- `R26` 2D 轨迹图不是 echarts map：x=Longitude(degrees)、y=Latitude(degrees)（标签 `rotate:45`、`toFixed(5)`），series 为 `line + smooth + PL 透明 + symbolSize 5 + #5464f8ff`。`[观察] @15714392`
- `R27` 轨迹按 position type 着色，颜色表必须逐字照抄（含 `FIXED_POS` 与 `RTK_FIXED` 同为 `#2980B9` 的重色，以及 `INS_*` 用 25% 透明后缀 `40`、其余用 `33`）。`[观察] @1328196..@1330400`（附录 D）
- `R28` 事件 `frequency` BLOB 按 5 字节/条解码：`float32LE` MHz + `uint8` flag；`00 00 48 42 01` = 50.0 MHz 超限。`[观察] @13650900`
- `R29` 多图 hover 必须广播 `window` 级 `CustomEvent("globalHover",{detail:x})` 并联动所有图的竖线；拖动缩放用 `takeGlobalCursor({key:"dataZoomSelect"})`。`[观察] @15702610`
- `R30` 播放倍速只有 `1/2/5/10/20`；切到非 GOS Tab 自动暂停、回 GOS 恢复。`[观察] @13801156`、`@16210749`
- `R31` 地图 2D 参考系 `CRS:84`、3D `EPSG:4978`、瓦片基线 `EPSG:3857`；provider 只有 `osm`/`google`/`no-basemap`，默认 `google` + `streetview`，暗色主题换 `darkmode` 样式表。`[观察] @1328196`、`@13650389`
- `R32` 标记上限 10 个；重复时间点必须提示 "There's already a flag at this timestamp"；删除进回收站、可恢复/清空。`[观察] @1451713`、i18n `MAX_FLAGS`/`HAS_ALREADY_DUPLICATEACTIVE_FLAG`

**E. 导出与持久化**

- `R33` 导出必须恰好 4 种：HTML/PDF/KML/CSV；**没有 PNG**；PDF 由主进程 `printToPDF` 生成，footer 是 `pageNumber / totalPages`、10 px、右对齐；HTML/PDF 依赖逐 Tab 切页 + 等 `chartsRendered>=tabChartCounts[tab]`，单 Tab 超时 15 s。`[观察] @15993576`、`@16200584`、`main.jsc@~59k`
- `R34` 关闭窗口必须走 `persistChangesOnClose` 握手：回写 `FlagsInitialState/currentTimeStamp/isPlaying/editedStart/editedEnd/PersistenceInfo` + 重算 checksum，最后调 `persistStateComplete()`；被 `taskkill /IM Graph.exe /F` 杀掉时不做任何保存。`[观察] @16246025`、`01_解包/app/main.js:34-41`
- `R35` 报表 HTML 必须自包含：把 `resources/scripts/echarts.min.js` 与整个 `resources/Icons/` 复制到 `<project>\html\`，并把 `toolbox.feature.restore` 段落从 HTML 中剔除。`[观察] @16196283`、`@16004406`

**F. 集成**

- `R36` 主程序启动 Graph 时不传任何参数，`detached:true, stdio:"ignore"`，可执行文件路径取 `HKCU\Software\NovAtel Inc.\Graph` 的 `Path` 值 + `Graph.exe`，且要求同目录 `uninstall.exe` 存在。`[观察] 01_解包/app/view/addApplication/addApplication.js:2237-2253、2312-2351`
- `R37` 安装包静默安装命令必须是 `Graph_Setup.exe /S /D=<installDir>` 且 `-Verb RunAs`；默认安装目录 `<NAS>\Graph`。`[观察] 01_解包/app/updater.js:105-128`
- `R38` 关窗时主程序必须先 `taskkill /IM Graph.exe /F`（Linux 用 `pkill -f "Graph"`），且忽略失败。`[观察] 01_解包/app/main.js:34-41`
- `R39` i18n 必须只有 `en`（329 键）+ `fr`（69 键），`fallbackLng:"en"`，资源内联；启动即 `changeLanguage("en")`，界面不提供语言切换。`[观察] @384572`、`@16249600`
- `R40` `nonCoreAppData` 三件套必须齐：空模板 `AppDetails.json{Path:"",Version:""}`、`Graph_prerequisites.json{title,appName,version,exeName,uninstallName}`、`Graph_noncoreapp.svg`；运行时把 `Path`（exe 目录）与 `Version`（package.json）写入 `%APPDATA%\<NAS>\NASnoncorelinks\Graph\AppDetails.json`。`[观察] main.jsc` 的 `regNonCoreApp` 串、`addApplication.js:1710-1753`

（共 40 条，覆盖结构/协议/数据/图表/导出/集成六类。）

---

## 9. 未解之处（缺什么证据）

| # | 未解点 | 现有证据 | 需要什么才能确定 |
|---|---|---|---|
| U1 | **`EncryptionKey` 的派生算法** | 只知道：入参是项目名（`EncryptKeyInput`）、由原生 `GetEncryptionKey` 返回、DB 用 `aes128cbc` | 反编译 `graph-node-wrapper.node`（8.8 MB，符号已剥？未验证）或动态 hook `TabFileReader_api.GetEncryptionKey` 返回值与入参做对照 |
| U2 | 图表 DB 到底在 `<project>` 还是 `<project>\GDS` | 读请求给 `filePath=<project>` + `dbFilename=<t>.db`；导出与清理只用 `<project>\GDS`；`main.jsc` 里**没有 `GDS` 字面量** | 跑一次真实处理，`dir` 一下项目目录；或反编译 main.jsc 看 `GET_CHART_DATA` 里 `path.join` 的参数 |
| U3 | **`configurationfile.node` 缺失** | main.jsc 引用 `resources/native_modules/windows/configurationfile.node`，包内没有该文件 | 装一次官方 Graph 2.11.0 对比 resources 目录；确认 `load-config-module` 是否有 try/catch 降级 |
| U4 | `printToPDF` 的具体参数值 | 只见选项名（`printBackground`/`preferCSSPageSize`/`marginsType`/…） | 反编译 main.jsc 常量池里的对象字面量（数值不在字符串表里） |
| U5 | `Graph_Setup.exe` 内部（NSIS 安装脚本、注册表写入项、是否捆绑 VC++ 运行时） | 只知大小与静默参数 | 用 7-Zip 解 NSIS，或 `strings` 找 `WriteRegStr` / `HKCU\Software\NovAtel Inc.\Graph` |
| U6 | Graph 自己的更新通道 | i18n 有全套 `UPDATE_*` 文案与 `UPDATE_DIALOG_TITLE="Graph update"`，`package.json` 无 `electron-updater` 依赖 | 查 `main.jsc` 是否有 `autoUpdater` 串（当前抽取未见）；或抓一次"Check for Updates"请求 |
| U7 | `fr` 只有 69 键，是"未翻译完"还是"法语版被裁" | `[观察]` 69 vs 329 | 比对官方法语安装包；或看 GitLab 历史（`!838`） |
| U8 | `nonCoreAppData` 的 `version:"2.0.0"` | 与 `package.json` 2.11.0 冲突 | 看 NAS 主程序怎么用这个字段（是"最低版本"还是"当前版本"）；`updateApplication.js` 的比较逻辑未读完 |
| U9 | 3D 地图是否真的启用 | 有 `REF_3D="EPSG:4978"`、`MAP_CONTRAINTS_3D_ABOVE`、`is2D` 参数，但三处 `LuciadMap` 调用全部传 `is2D` 缺省 `true` | 找到传 `is2D={false}` 的调用点（若不存在，3D 是死代码） |
| U10 | `.jsc` 与 Electron 41 的绑定关系 | loader 会改写 flag hash，说明字节码与 V8 版本强耦合 | 用 Electron 41.x 对应 V8 版本重打包验证；换 El

### 9.1 真机操控结果（2026-10-30，Playwright 驱动原版 Graph.exe）

结论先行：**Graph 可以被完整驱动，而且它的项目是"能造出来的"**；此前的"校验卡在 0%"不是文件问题，
是**路径问题**。

驱动方式（不需要改安装目录、不需要 UI 录制）：

```js
const { _electron } = require('C:/Users/<user>/AppData/Roaming/npm/node_modules/playwright');
const app = await _electron.launch({ executablePath: '…\\Graph\\Graph.exe' });
const page = await app.firstWindow();
// 之后全部走 DOM：page.getByRole('button', { name: 'New Project' }).click() …
// 原生"选择文件夹/打开文件"对话框用坐标点掉（Enter 接受当前目录 / 粘贴完整路径 + Enter）
```

`window.graphing.onGraphingResponse(cb)` 能收到 graphing 子进程的每一条 JSON，这是判定校验进度的正规口子。

**A/B 实验（同一份 270 864 B 的日志，只改路径）**

| 项目路径 | 结果 |
|---|---|
| `H:\…\野外台站智能体\逆向\00_来源\samples\graph`（含中文与空格） | `File Validation` 停在 **0%**，180 s 无变化，`graphing` 子进程**一条响应都没有**，也未派生进程 |
| `C:\Users\<user>\AppData\Local\Temp\gs`（纯 ASCII） | 立刻 `Percentage: 96 → 100`，`Finish` 可点，进入 `#/overview` |

→ **Graph 的校验/建库链路处理不了非 ASCII 路径**（推断是原生侧按 ANSI 路径传参）。这是本子系统
新增的确定性缺陷，复现时若路径含中文，必须先把工程与日志放到纯 ASCII 目录。

**产物（已归档到 `00_来源/samples/graph/project/`）**

```
clean.gpf            4 640 B   工程文件（PageRoute/DataSummary/projectDirectory/fileTimeline/updatedProjSummary）
DataSummary.json     1 438 B   DataInfo + PlotSummary + ReceiverInfo + Messages
GOS\position.db     24 576 B   SQLCipher（aes128cbc，密钥见 U1）
GOS\events.db       24 576 B   同上
```

**同一份日志触发的图表清单**（应用自己算的 `PlotSummary`，可直接对照我们要复现的 16 图）：

| 分组 | 图表 | 数据来源 |
|---|---|---|
| `PVT / GNSS` | 2D Trajectory、Height、Position SD、Position Status、Position Type、Solution Statistics | BESTPOS |
| `Position View` | 地图（1 条轨迹） | BESTPOS |
| `Receiver_Status` | CPU Usage、HW Monitor Status、Receiver Status | BESTPOS / RANGE / HWMONITOR / RXSTATUS |
| `Tracking_Measurements / Primary` | GNSS Signal Strength、Satellites and Signals、Tracking Time | RANGE |

即**"16 图"是上限，实际出哪几张取决于日志里有哪些消息**——这一点直接影响重实现的图表注册方式
（按 `PlotSummary` 动态建，而不是固定 16 个）。

### 9.2 四种导出格式已落盘（2026-10-31）

之前卡住的"点了 Export 没有文件"，根因是 **目的地对话框**：Export 面板确认后，主进程弹的是
`showSaveDialog`（标题 `Select a folder to save exported files`），不处理就永远停在
`Exporting (0%)`。Playwright 能在主进程里执行，把 `dialog.showOpenDialog/showSaveDialog` 换成
桩函数即可，无需人工点。

导出面板的开关（`input[type=checkbox]`，共 10 个）：

| 索引 | 含义 | 默认 |
|---:|---|---|
| 0..4 | 要导出哪些图（Overview / PVT / Tracking & Measurements / Receiver Status） | 0 关，1–4 开 |
| 5 | Project Information | 开 |
| **6..9** | **HTML Report / PDF Report / KML / CSV (original data only)** | **全关** |

目的地规则（实测）：返回路径 `<D>\<name>` 时

```
<D>\<name>.html            331 117 B   报告；旁边生成 html\scripts\echarts.min.js 与 html\icons\*
<D>\<name>.pdf             348 419 B
<D>\<name>.kml               5 728 B   Placemark 轨迹 + 项目信息注释
<D>\csv\*.csv              13 个      每张图一份，头部 #Project Name / #Project Directory / #Data File Name / #Start Time(GPS) …
```

注意 CSV 目录是**基名的兄弟目录**（`<D>\csv`），不是 `<D>\<name>\csv`。

产物已入库：`00_来源/samples/graph/export/`（含 `csv/` 13 份、`clean.html`、`clean.pdf`、`clean.kml`；
`html/scripts` 与 `html/icons` 是随包资源，体积大且不是生成物，未入库）。
驱动脚本：`tools/graph-export.cjs`（`GRAPH_GPF` / `GRAPH_OUT` / 可选 `GRAPH_EXE`）。

---

## 10. 外部参考

| 来源 | 用途 | 状态 |
|---|---|---|
| Graph 自带帮助文档 **D100356 v1.0, October 2025** | 用户手册；文案 `GA_HELP_FOOTER` 里给出编号（`index-B86bHcCD.js:74`） | `[观察]` 只有编号，PDF 不在解包产物内 → 需向 NovAtel 索取 |
| NovAtel OEM7 / OEM firmware 手册（`BESTPOS` 的 `posType` 字段） | 解释 §3.3 position type 数值（0/16/17/32/34/48/49/50/…/65535）的官方含义 | **本文未引用**：附录 D 的取值与颜色全部来自二进制；数值语义需 OEM7 手册 `Table: Position type` 才能坐实 → `[未知]` 部分见 U1 相邻项 |
| NovAtel Application Suite 用户手册 | NAS 首页磁贴 / non-core 应用安装的官方描述 | 未获取；§7 全部结论仅基于 `01_解包/app` 的代码 |
| SQLCipher / `better-sqlite3-multiple-ciphers` 文档 | `PRAGMA cipher='aes128cbc'`、`key`、`query_only` 的语义 | 通用知识，未在本文作为证据使用 |
| LuciadRIA 2026.0 文档 | `RIAMap`、`mapNavigator.constraints`、`RasterTileSetModel` | `[观察]` 版本号 `Copyright={VERSION:"2026.0.07"}`（`@13439879`）；用法全部从代码读出，未查官方文档 |
| `Packery_Commercial_License.pdf`（`01_解包/app/`，与 Graph 无关） | — | 仅记录存在，未使用 |

---

### 附录索引（`03_分析/06_Graph应用-附录/`）

| 文件 | 内容 |
|---|---|
| `A_组件索引.tsv` | 81 个 React 组件的定义偏移 + 行号 |
| `B_IPC通道清单.md` | 57 个 IPC 通道 + namespace → 方法映射 |
| `C_图表目录.json` | 16 张图的表名/标题/单位/类型/上限/抽稀参数 |
| `D_位置类型与事件色表.json` | 28 组 position type + 颜色 + 干扰 BLOB 布局 |
| `E_GPF项目文件结构.md` | 目录布局、gpf 字段、校验和算法（含算例）、userSettings |
| `F_原生进程协议与SQL.md` | 三进程结构、子进程脚本、请求/响应报文、SQL、时间换算算例 |
| `G1_i18n_EN.tsv` / `G1_i18n_EN.txt` / `G2_i18n_FR.tsv` | 329 个英文键值、69 个法文键值 |
| `H1_字符串全表.tsv` | 15 019 条去重字符串（带出现次数） |
| `H2_UI文案.tsv` | 999 条"像 UI 文案"的字符串（含库内嵌文案，已标注易混） |
| `I1_main_jsc_字符串.txt` / `I2_preload_jsc_字符串.txt` | 两个字节码文件的 ASCII 字符串 + 字节偏移（599 / 231 条） |
| `J_Window_API.tsv` | renderer 里 72 个 `window.<ns>.<method>` 出现次数与首次偏移 |
| `L_REA复核摘要.json` | REA 6.5.0 的统计/覆盖率/IPC 计数/native-addon 与 storage 节点（原始 175 MB 输出未入库） |
| `K_抽取脚本/` | 上述全部产物的生成脚本（`node`，无第三方依赖） |

---

## 11. 重实现：`packages/graph`（数据层 + CSV/KML 导出，2026-10-30）

> 落地位置：`04_重实现/packages/graph/`（新包）与 `04_重实现/packages/cli/src/graph.ts`（CLI）。
> 判据不是"看起来一样"，而是 **`assert.deepEqual(Buffer, golden)`**：逐字节。
> 规格来源就是 §9.2 落盘的 `00_来源/samples/graph/export/`；本节每个格式结论都能在那批文件里指出出处。

### 11.1 数据层 API（`packages/graph/src`）

| 模块 | 导出 | 作用 |
|---|---|---|
| `project.ts` | `loadProject(gpfPath)` | 读 `.gpf`（JSON）与同目录 `DataSummary.json`，按 R15 平铺合并（`updatedProjSummary` 优先）；给出 `projectDirectory` / `projectName` / `dataFileName` / `dataInfo` / `plotSummary` / `messages` |
| | `chartTitles(plotSummary)` | 按 `PlotSummary` **动态**列举图名（本工程 12 张）。判据是 R17 的字符串相等：键就是图标题，值是 `{日志名: 条数}`。`PVT.GNSS/INS` 与 `Tracking_Measurements.Primary` 是两层嵌套，函数递归到"叶子全是数字"那层为止 |
| | `chartMessages(plotSummary, title)` | 某张图由哪些日志喂（如 `{BESTPOS:1}`），没有则空对象 |
| `capture.ts` | `loadCapture(capturePath)` | 复用 `packages/protocol` 的 `SbfDeframer` + `decodeEdie`（**没有**重写协议解析），产出 `{name, messageId, week, milliseconds, gpsMs, values, byPath}`、`counts`、`byName()` |
| `csv.ts` | `exportCsv(project, capture, {selectedPlots})` | 12 张图全部 → `{fileName, bytes, buffer}`；`availableCsvCharts` 只返回 `PlotSummary` 认可且已实现的图（本工程 12/12） |
| | `writeCsv(...)` | 写 `<out>/csv/<图名>.csv`（Graph 的目的地规则：**兄弟目录** `csv`） |
| `receiver-status.ts` | `receiverStatusSpans` / `renderReceiverStatus` | `Receiver Status` 的"条件→区间"导出（不是时间序列，见 §11.3 末） |
| `range-charts.ts` | `satelliteColumns` / `trackingTimeColumns` / `gnssSignalStrengthColumns` / `renderSatellitesAndSignals` | 三张 `RANGE` 图的列构造与信号命名（见 §11.3） |
| `kml.ts` | `renderKml(project, capture)` / `writeKml(...)` | 生成 `<project>.kml` |
| `format.ts` | `gpsWeekSeconds` / `formatGpsColumn` / `formatGpsCommentTime` / `formatDuration` / `formatTrimmed` / `formatFixed` / `formatFixedHalfEven` / `SOLUTION_STATUS` / `POSITION_TYPE` | GPS 时间与数字格式；枚举表取自 `01_解包/app/model/NovatelIdConstants.js` |

时间刻度以 Graph 自己的为准：**`gpsMs = week * 604800000 + msOfWeek`**（不减 18 s、不加 315 964 800 000）。
证据：`.gpf` 的 `DataInfo.StartTime = 1477384697350` 正好等于 `2442 * 604800000 + 463097350`，
而 CSV 注释头写的是 `2442,463097.350`；KML/CSV 里的 `1477384700900.000000` 也是同一刻度。

日志对应关系照 §9.1 的表，没有自己推：`2D Trajectory` / `Height` / `Position SD` / `Position Status` /
`Position Type` / `Solution Statistics` ← `BESTPOS`；`CPU Usage` / `HW Monitor Status` / `Receiver Status`
← `BESTPOS` + `RANGE` + `HWMONITOR` + `RXSTATUS`；`GNSS Signal Strength` / `Satellites and Signals` /
`Tracking Time` ← `RANGE`。

### 11.2 复现用的那份日志

`00_来源/samples/graph/` 只有工程与导出产物，**没有**输入日志。输入是
`00_来源/samples/convert/clean-9600.gps`：`270 864 B`，与 `.gpf` 的 `DataInfo.FileSize` 和
`Messages`（`RANGE 100 / BESTPOS 5 / RAWEPHEM 8 / RXSTATUS 4 / PORTSTATS 1 / HWMONITOR 1`）逐项吻合。
CLI 用 `--capture` 指向它（`.gpf` 里记的是 `C:\Users\…\Temp\gs\clean.gps`，早已不存在）。

### 11.3 CSV 规格（逐字节）

```
<UTF-8 BOM EF BB BF>#Project Name:          clean\r\n
#Project Directory:    C:\Users\…\gs\clean\r\n
#Data File Name:      clean.gps\r\n
#Start Time(GPS):      2442,463097.350\r\n
#End Time(GPS):       2442,463102.300\r\n
#Duration:                   00:00:04\r\n
timestamp (GPS week sec),<列…>\r\n
<行>\r\n … （末行后仍有一个 CRLF）
```

- 六行注释的**值列是硬编码空格**凑出来的，不是 `padEnd`：值分别从第 24 / 24 / 22 / 23 / 22 / 29 列开始
  （`#Data File Name:` 与 `#Start Time(GPS):` 标签长度不同，用统一宽度会错一格——第一版就是这么错的）。
- 时间列 `2442  463097.350`：GPS 周 + **两个空格** + 秒（`toFixed(3)`）；注释头里是逗号 `2442,463097.350`。
- 时长 `HH:MM:SS` 向下取整秒（`4950 ms` → `00:00:04`），超过一天写 `N Days HH:MM:SS`。
- **取行窗口是 `StartTime ≤ t < EndTime`（右开）**。证据：最后一条 RANGE 的时间正好等于
  `EndTime = 1477384702300`，它**不在** `GNSS Signal Strength` / `Tracking Time` 里（99 行而非 100 行）；
  而最后一条 BESTPOS 是 `1477384702000`，在窗口内（5 行）。写成右闭就会多一行。
- 小数位**不是全局统一**，逐列从 golden 反推（`csv.ts` 的 `ColumnFormat`）：

| 图 / 列 | 格式 | 依据 |
|---|---|---|
| `2D Trajectory` Latitude/Longitude | 6 位、**去尾零** | `30.539975` / `114.352811` |
| `Height` Height | 6 位、去尾零 | `66.429896`（BESTPOS `orthometric_height` = 66.429895708…） |
| `Position SD` Latitude/Longitude/Height SD | 6 位、去尾零 | 关键证据：`2442  463098.000` 行经度 SD = 1.1976104974…，`%.6f` 应得 `1.197610`，golden 是 **`1.19761`**（全文件唯一能区分"去尾零"与"定长"的值） |
| `Position Status` Solution_Type | 文本枚举 | `SOL_COMPUTED`（`solution_status=0`） |
| `Position Type` Position_Type | 文本枚举 | `SINGLE`（`position_type=16`） |
| `Solution Statistics` Differential Lag / Solution Age | 6 位、**保留尾零** | `0.000000` —— 与上一行同属 PVT 却规则相反，说明原版是**逐列**格式 |
| `Solution Statistics` Satellites Tracked/Used | 整数 | `23`、`12` |
| `CPU Usage` CPU Usage | 1 位小数 | `29.0`/`28.0`/`29.5`；值 = `(200 − idleTimeRaw)/2`（BESTPOS 头 `idle=142 → 29.0`、`144 → 28.0`、`141 → 29.5`） |
| `HW Monitor Status` 各列 | 6 位 | `38.339443`…；列名与列序 = `HWMONITOR` 里 measurement 的**出现顺序**，名字按 `status >> 8` 查表（1 Temperature / 2 Antenna Current / 6 Internal Supply Voltage / 7 Antenna Voltage / 8 Digital Core Voltage / 15 Supply Voltage / 17 V 1.8 / 21 V 5.0 / 23 Peripheral Core Voltage / 22 Secondary Temperature） |
| `Receiver Status` start/end | 6 位定长 | `1477384700900.000000`；值是 GPS 毫秒刻度，不是 UTC |
| `Tracking Time` 每列 | 6 位定长，**半数入偶** | `157.028076`；值 = `obs[].lock_time`（SBF RANGE 的 F4 秒计数） |
| `GNSS Signal Strength` 每列 | 6 位定长，半数入偶 | 值 = `obs[].C_No`；`_Mean` = 同(星座,信号)所有卫星的算术平均 |
| `Satellites and Signals` | 整数计数 | `Signals_X_Y`=该(星座,信号)出现次数、`Satellites_X`=该星座不同 PRN 数、`*_Total` |
| `Receiver Status` | 整份表是"条件→区间" | `name,start,end,value`，**没有时间列**，见下 |

**半数入偶（新发现，必须抄）**：`Fixed6` 不是 JS `toFixed`。`Tracking Time` 里 `2471.9765625`（float32 精确值）
golden 写 `2471.976562`，JS `toFixed(6)` 会写 `2471.976563`；`GNSS Signal Strength` 里 `49.3515625` 同理。
原版是 C `printf("%.6f")`：按二进制精确值展开、**ties-to-even**。`format.ts` 的 `formatFixedHalfEven`
用 BigInt 精确实现，`csv.ts` 的 `fixed6` 走它。

**`RANGE` 的 system / signal 切片**（三张图共用，已用 golden 60 列逐格反验）：

```
system = (c_status >> 16) & 7     // 0 GPS / 4 BEIDOU / 5 QZSS（本样本只出现这三种）
signal = (c_status >> 21) & 0x1f  // 5 位"signal type"，按系统各自编号
```

`(system, signal)` → 列名前缀由 60 列 × 2 种数值（`lock_time` / `C_No`）逐格匹配得到，共 12 对：
GPS `0=L1_CA, 16=L1_CP, 9=L2_PY, 17=L2_CM, 14=L5_Q`；BEIDOU `0=B1I_D1, 4=B1I_D2, 1=B2I_D1,
2=B3I_D1, 6=B3I_D2`；QZSS `0=L1_CA, 16=L1_CP, 17=L2_CM, 14=L5_Q`。
**注意**：这**不是** `graph-node-wrapper.node` 里那张 72 名字的平铺枚举（那张表里 GPS 的 9 是 `L2_CM`，
而接收机把 `L2_PY` 报成 9）。72 名字表只用来定**列序**（见下）。

**逐卫星列的排序规则（已解）**：`(system 升序, PRN 升序, 72 名字枚举里的位次升序)`。
枚举位次：`GPS_L1_CA=0 … GPS_L1_CP=2 … GPS_L2_PY=8 … GPS_L2_CM=9`（`GPS_L5_Q` 在该表里没有字面量，
按 L1<L2<L5 排在 L2 之后，正好与 golden 一致）。这条规则对每个 PRN 组都成立，60 列全对。

**`Receiver Status` 的表结构**：

```
name,start,end,value\r\n
Antenna 1 Gain Anomaly,1477384700900.000000,1477384700900.000000,1\r\n
```

- 没有 `timestamp (GPS week sec)` 列；区间两端是 GPS 毫秒（6 位定长），`value` 恒为 `1`。
- 行按 `name` **字典序**排（golden 是纯字母序，既不是表序也不是出现序）。
- `start` = 该条件变真的第一条 RXSTATUS；`end` = **最后一次观测到仍为真**的那条记录的时间
  （不是 `DataInfo.EndTime`）。所以只在最后一条记录才成立的条件得到零长区间（`Antenna 1 Gain Anomaly`）。

### 11.4 KML 规格（逐字节）

5 728 B、CRLF、无 BOM、`</kml>` 后仍有一个 CRLF。层级与顺序：

```
<?xml version = '1.0' encoding = 'utf-8'?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <!--Project Information-->            ← 6 行注释，值列同样是硬编码空格
    <Document id="root_doc"><Folder><name>clean</name>
        <Style id="Path<TYPE>">    LineStyle(color, width 4) + PolyStyle(color)
        <Style id="Point<TYPE>">   IconStyle(color, scale 0.75, placemark_circle.png) + BalloonStyle
        <Folder id="<TYPE>"><name><TYPE></name>
            <Folder id="Points"><name>Points</name>
                <Folder id="Starting Points"><name>Started <GPS 时间></name><description><TYPE></description>
                    每条定位一个 <Placemark>：气泡 = GPS 时间 / 类型（红字）/ "lat, lon, h" / "Std Dev: a, b, c M"
            <Folder id="Paths"><name>Paths</name>  一条 LineString，坐标空格分隔、**末尾带一个空格**
```

- 坐标顺序 `lon,lat,height`；经纬 6 位、**高程 3 位且保留尾零**（`66.430`，与 CSV 的 6 位不同）。
- 气泡里 `Std Dev: 1.344, 1.198, 2.639 M` 是 3 位定长（`1.1976105 → 1.198`）。
- 颜色是 KML 的 `AABBGGRR`，由渲染层位置类型色（`#3C4AE7`，附录 D）反序而来：`#3C4AE7 → ffe74a3c`；
  `SINGLE` 属 `SINGLE_POINT` 组。每个位置类型一组 `Style` + `Folder` + 一条 `Path`，按首次出现顺序排列。
- 原版怪癖照抄：最后一个 `<Placemark>` 与 `</Folder>` 在**同一行**（`</Placemark></Folder>`）。

### 11.5 验证（自己跑过）

```
node --test --test-force-exit "packages/graph/test/*.test.ts"     # 11 tests, 11 pass
node packages/cli/src/graph.ts --project …/clean.gpf --capture …/clean-9600.gps \
     --out <tmp> --csv --kml --golden …/samples/graph/export
```

实测（`samples/graph/export/` 为 golden）——**12 份 CSV + 1 份 KML 全部逐字节相同**：

| 文件 | 字节 | 结果 |
|---|---:|---|
| `csv/2D Trajectory.csv` | 492 | 逐字节相同 |
| `csv/Height.csv` | 425 | 逐字节相同 |
| `csv/Position Status.csv` | 447 | 逐字节相同 |
| `csv/Position Type.csv` | 417 | 逐字节相同（顺手做的，与上面三份同一套格式） |
| `csv/Position SD.csv` | 537 | 逐字节相同 |
| `csv/Solution Statistics.csv` | 565 | 逐字节相同 |
| `csv/CPU Usage.csv` | 403 | 逐字节相同 |
| `csv/HW Monitor Status.csv` | 550 | 逐字节相同 |
| `csv/Receiver Status.csv` | 610 | 逐字节相同 |
| `csv/Tracking Time.csv` | 73 985 | 逐字节相同 |
| `csv/GNSS Signal Strength.csv` | 76 395 | 逐字节相同 |
| `csv/Satellites and Signals.csv` | 6 473 | 逐字节相同 |
| `clean.kml` | 5 728 | 逐字节相同 |

`node --test` 一共 **21 个测试，21 pass**，其中 12 个是"每份 CSV 一份"的
`assert.deepEqual(Buffer.from(ours), readFileSync(golden))`。

### 11.6 未完成 / 与原版的差异

**12/12 CSV 已完成**（`samples/graph/export/csv/` 里一共 12 份，不是 13）。每份都是逐字节相同，
没有"接近"的文件。

**明确不做的**：HTML 报告（`clean.html` 331 KB）、PDF（`clean.pdf` 348 KB）、地图渲染、
`GOS/*.db`（SQLCipher，密钥 U1 未知）、Wizard / 时间轴 / flags。这些与原版的差距是"整块功能缺失"，
不是精度差异。

**已解出来的两块难点**（上一轮遗留的 1、2 号问题）：

1. **`Receiver Status` 的位→名字表**。22 个名字在 `graph-node-wrapper.node` 里有两份副本，
   连续的一串字面量在 `@7300120..7300703`（另一份 `@7301312..7301903`，顺序不同、且把
   `Error Flag` 拼成 `Error Falg`）。位定义按 OEM7 手册 Table 225 / 227 / 229 / 230 配对，
   再用 golden 的 4 条 RXSTATUS 记录（`w1` 被置位的位只有 `{14,15,23,25}`、`w2` `{18}`、
   `w4` `{4,5,31}`）逐条排除，得到 5 条唯一确定、且**互不冲突**的对应：

   | 名字 | 条件 | 依据 |
   |---|---|---|
   | `Ethernet Not Connected` | AUX1 `word2` bit 18 | 表 227 "Ethernet not connected"，全程为 1 → span 从第一条记录起 |
   | `RF Calibration Data Present` | AUX3 `word4` bit 31 | 表 230 "RF Calibration Data is present"，全程为 1 |
   | `Jamming Detected` | `word1` bit 15 | 表 225 "Jammer Detected"，在 463100.896 那条首次置位 |
   | `Antenna 1 Gain Anomaly` | AUX3 `word4` bits 4-5 == `11` | 表 231 状态 11 = Anomaly，只在 463100.900 出现 → 零长 span |
   | `Antenna 1 Gain High` | `word1` bit 14 | **唯一剩余**的置位（463100.896 第二条起）与唯一剩余的 span 完全吻合；但手册把 bit 14 写作 "Antenna gain state out of range"，与名字措辞不一致，原版可能是旧版位定义。按观测采用，代码里已注明 |

   仍然**没有**确定的是另外 7 个名字：`INS Not Converged`、`No INS Alignment`、`Poor ALIGN COM Link`、
   `Poor RTK COM Link`、`Usable RTK Corrections Status (Bit 0/1)`、以及 `Antenna 1 Gain Low`
   与 `Error Flag` 的具体位（前者只能确定走 AUX3 bits 4-5 == `01`，与本样本无冲突）。这些名字
   在本样本的候选位上全为 0，**无法用 golden 判定**，因此代码里没有给它们硬猜位（留空即"永不触发"，
   不影响本样本的逐字节）。

2. **`RANGE` 三张图的列序**。逐卫星列已解出规则（`(system, PRN, 72 名字枚举位次)`，60 列全对，
   见 §11.3）。**只有 `_Mean` 与 `Signals_*` 两组列序仍是"抄 golden 的表"**：
   `range-charts.ts` 的 `MEAN_ORDER` / `SIGNALS_ORDER` 是观测到的顺序，不是推导出来的规则。
   已排除的模型（都不成立，脚本试过）：枚举序、PRN 序、首次出现序、均值/计数排序、
   FNV-1a(32/64) 与 libstdc++ `_Hash_bytes` 对「列名 / 信号后缀 / 5 位信号号 / 枚举位次」
   取模 bucket 2..97 的两种 bucket 迭代约定（bucket 升序 + 桶内正序/逆序）。两组的顺序还互不相同
   （GPS `_Mean` 是 `L1_CA,L2_PY,L2_CM,L1_CP,L5_Q`，`Signals_*` 是 `L2_PY,L1_CA,L1_CP,L2_CM,L5_Q`），
   更像是两个不同键类型的 `unordered_map` 的迭代序。**风险**：遇到本样本没出现的星座/信号时会退化
   （未知项按枚举位次排在末尾），列序不再保证与原版一致。

**其它已知不确定点**：

3. **`--time-format UTC` 未验证**：golden 只有 GPS 一版。原版标签会从 `#Start Time(GPS):` 变成 UTC 文案，
   具体文案未见；实现只接受 GPS 并在传 UTC 时显式告警。
4. **逐列小数位是"观测结论"不是"机制结论"**：`Position SD` 去尾零、`Solution Statistics` 保尾零，
   同组同源却不同，推测原生侧按表/列各写了格式串。样本每列只覆盖一种取值，不能再细分。
   新补的 6 位列（`Tracking Time` / `GNSS Signal Strength` / `Receiver Status`）都已确认是
   **C `printf("%.6f")` 的 ties-to-even**，不是 JS `toFixed`（见 §11.3）。

附带的三个可复用发现（已写进代码注释）：

- `clean-9600.gps` 就是这套 golden 的输入（`270 864 B` = `DataInfo.FileSize`，`Messages` 逐项相等）。
- `graph-node-wrapper.node` 里能直接抠出三张表：HW Monitor 的 10 个列名、22 个 `Receiver Status`
  名字、72 个全局信号名（`GPS_L1_CA` … `QZSS_L6_X`、`SBAS_*`、`NAVIC_*`、`LBAND_LBAND`、
  `UNKNOWN_SIGNAL`）。**72 名字表里没有 `GPS_L5_*`**，所以 `GPS_L5_Q` 这一列名一定是运行时拼出来的
  （`QZSS_L5_Q` / `SBAS_L5_Q` 有字面量，GPS 的没有）——这也解释了为什么按枚举位次排序时
  `GPS_L5_Q` 的位次要单独定。
- `CPU Usage` 用的是 SBF **头第 12 字节** `idleTimeRaw`（`packages/protocol/src/header.ts` 早就解析了，
  只是当时没人用）：`(200 − idle) / 2`。
