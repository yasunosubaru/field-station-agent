# Playback 组件（日志文件回放）

覆盖文件（`01_解包/app/` 下，行号即解包原始行号）：

| 文件 | 行数 | 说明 |
|---|---|---|
| `controller/playback.js` | 2102 | 核心；IIFE 导出 `playbackControl` + 顶层 `playbackEmitter` |
| `view/playbackcontrol/playbackcontrol.html` | 105 | 回放控件 DOM（进度条/倍速/片段/事件开关） |
| `view/playbackcontrol/playbackview.js` | 439 | 控件上的 jQuery 事件代理，全部调 `playbackControl.*` |
| `view/html/playback.html` | 199 | Playback 落地页（最近文件 tile、排序、选文件对话框） |
| `view/GRIT/livePlayback/livePlayback.js` | 844 | GRIT「直播回看」；自带一份时间戳工具副本 |
| `view/GRIT/livePlayback/liveplaybackview.js` | 456 | 直播回看控件事件；复用 `playbackControl.play/onPlayPause/…` |
| `view/GRIT/livePlayback/liveplaybackcontrol.html` | 66 | 直播回看控件 DOM（Record / Return to Live） |

关联但只读引用、不重复分析：`model/NovatelIdConstants.js`、`controller/genericparser.js`、
`model/logparsers.js`、`jarvisInterface.js`、`view/deviceManagement/deviceManagement.js`、
`view/html/setUpMonitor.html`、`view/genericView.js`、`model/featuresList.js`。

---

## 1. 职责

Playback 组件负责把**磁盘上的 NovAtel 二进制日志文件**当作一条"假串口/假网络流"来喂给
与在线连接相同的解析管线，并在底部提供播放器控件（播放/暂停、后退 30 s、倍速、进度条、
片段导出、事件标记）。

三件事它**不做**：

- 不解析日志字段（交给 `logParsers.parseData`，经 `jarvisInterface.logBuffer`）。
- 不发任何命令到接收机；回放 tab 里 `controller.requestlog` 一次都不会被调用
  `[观察] 01_解包/app/controller/playback.js:1-2102`（全文无 `requestlog` 调用，
  对比 `jarvisInterface.js:2895-2898` 的在线分支）。
  例外在**直播回看控件**那一层：`liveplaybackview.js:49-174` 的 Record 功能会对
  **在线连接**追加 `log thisport_30 …` 请求（与回放本身无关）
  `[观察] 01_解包/app/view/GRIT/livePlayback/liveplaybackview.js:97-138`。
- 不做流式解码缓存（`GenericParser` 的 `tempbuffermap` 在回放时仍在用，见 §7）。

它有两种运行形态，共用同一份 `playback.js`：

1. **离线回放**：`connectionDetails.type == "playback"`，打开任意 `.gps/.bin/.dat/.log` 文件。
2. **GRIT 直播回看（live playback）**：`connectionDetails.type` 仍是串口/网络，
   但把本 tab 最近 10 min 的滚动历史文件当成回放文件喂进去（`isLivePanel = true`）
   `[观察] 01_解包/app/view/GRIT/livePlayback/liveplaybackview.js:234-250`。

---

## 2. 入口与加载顺序

`[观察] 01_解包/app/view/html/index.html:100-145`：脚本加载顺序为
`NovatelIdConstants.js`(100) → `communication.js`(105) → **`playback.js`(106)** →
`jarvisInterface.js`(107) → `logparsers.js`(109) → `genericparser.js`(137)。

推论（`[推断]`）：`playback.js` 在 `jarvisInterface` / `GenericParser` / `jDataView` **之前**
求值，所以它在 IIFE 体内只能引用已加载的 `NovatelIdConstants`（第 24-26 行就取 messageId），
凡涉及 `jarvisInterface.*`、`jDataView`、`fs` 的语句全部推迟到函数体内运行。文件顶部
`fs` 未在模块层 require，而是在 `play` 内部 `const fs = require('fs')`
`[观察] 01_解包/app/controller/playback.js:848`——这是一种"用到才 require"的写法，
说明该文件被设计成可以在渲染进程任意时刻被 eval。

三层入口：

```
Playback 落地页 (§)
  playback.html:45  $.getScript("./../playbackcontrol/playbackview.js") → deviceManagement.fetchPlaybackDevices()
  playback.html:52  点 .image-connection-tile / #upload-playback-file / .span-upload → $("#new-playback-modal").modal("show")
        ↓
选文件并点「Start Playback」
  setUpMonitor.html:2796  $(document).on("click",".startBtn")  ← 注意：即使落在 index.html 的 modal 里，处理函数在 setUpMonitor.html
  setUpMonitor.html:2808-2813  优先取 <input type=file> 的 .path，否则取 .selectFilePb 文本框
  setUpMonitor.html:2819  fs.existsSync + isFile 校验（只校验存在性）
  setUpMonitor.html:2836-2866  createPlaybackConnection() → connectionDetails.type="playback" → jarvisInterface.newConnection(tab, details)
        ↓
jarvisInterface.js:815  newConnection → controller.openConnection
communication.js:158-160  else if (connectionDetails.type == "playback") playbackControl.play(fileName, tab)
        ↓
playback.js:846 play → 859 validateFile → 900 validateFileCallback → 299 calculatePlaybackTime
       → 353 generateBinaryLogsAvailable（全文件预扫描）→ 865 updateStartEndTime → 461 parseFirstLog → 469 parseBinaryLog
```

播放器控件的 DOM 是**后注入**的：`jarvisInterface.js:5085-5097` 的 `createPlaybackComponent(tab)`
把 `./../playbackcontrol/playbackcontrol.html` load 进 `#playback-panel-<tab>`，
回调里才做 `playbackControl.processLanguage()`、读回上次的倍速与"显示事件"开关。

`view/html/playback.html` 本身是**落地页**片段，被 `index.html:1124` 懒加载进
`.playback-landing-screen`；`playback.html:42-197` 的 `<script>` 里还重复定义了一份
`addDeviceTile`（`playback.html:58`）——全仓搜索该名字只有定义两处
（`playback.html:58`、`setUpMonitor.html:1815`）**没有调用点**，是死代码；
真正建 tile 的是 `deviceManagement.getPlaybackDeviceTilehtml`
`[观察] 01_解包/app/view/deviceManagement/deviceManagement.js:1208-1275`。

---

## 3. 数据结构（逐字段）

全部是**按 tab 分槽的对象字面量**（`const X = {}` 然后 `X[tab]`），没有类、没有 Map。
这一层"隐式 tab 键"是理解本组件的关键：任何 `delete X[tab]` 的遗漏都会在关闭 tab 后留下脏状态。

### 3.1 常量

| 名称 | 值 | 位置 | 语义 |
|---|---|---|---|
| `MAX_BUFFER_SIZE` | 819200 (800 KiB) | `playback.js:5` | 扫描/epoch 读取的固定窗口 |
| `MIN_BUFFER_SIZE` | 13100 | `playback.js:6` | seek 缓冲下限 |
| `BIN_SYNC` | `"aa44121c"` | `playback.js:7` | OEM 二进制同步字（小写，供 `indexOf(...,"hex")`） |
| `GIII_BIN_SYNC` | `"AACC4756"` | `playback.js:8` | GIII 同步字（大写，同一 API） |
| `MAX_TIMEOUT` | 35000 ms | `playback.js:11` | seek 转圈的兜底隐藏时间 |
| `extraMilliseconds` | 1000 | `playback.js:12` | 事件面板判定的容差 |
| `history_time_msec` | 600000 ms | `playback.js:13` | GRIT 直播回看窗口 = 10 min |
| `HEADER_LENGTH` | 28 | `playback.js:64` | OEM 头长（`NovatelIdConstants.MessageHeaderLength` 同值，`:13`） |
| `CRC_LENGTH` | 4 | `playback.js:65` | 尾部 CRC 长 |

### 3.2 接收机描述符 `RxDetails` / `OEMdetails` / `GIIIdetails`

`playback.js:27-34`（GIII）与 `playback.js:55-62`（OEM），字段：

| 字段 | OEM | GIII | 用途 |
|---|---|---|---|
| `sync` | `"aa44121c"` | `"AACC4756"` | 所有 `indexOf/lastIndexOf(...,"hex")` 的模式串 |
| `rxType` | `"OEM"` | `"GIII"` | 决定注入到 `processMessage_` 还是 `parseGIIIdata`（`:2049-2052`） |
| `msgLenOffset` | 8 | 4 | 负载长度字段偏移（uint16 LE） |
| `headerLen` | 28 | 0 | 本条记录头长 |
| `msgIdOffset` | 4 | 6 | 消息 ID 偏移（uint16 LE） |
| `timeStatusOffset` | 13 | 12 | 时间状态字节偏移 |

GIII 的 4/6 与 `genericparser.js:466-467` 的
`messageLen = getUint16(4)+4` / `messageId = getUint16(6)` 完全一致。

### 3.3 按 tab 的状态表

| 名称 | 类型 | 单位 | 写入点 | 语义 |
|---|---|---|---|---|
| `fileName[tab]` | string | — | `:80-82,853` | 被回放文件绝对路径 |
| `totalFileSize[tab]` | number | byte | `:292,622` | 文件大小（`getTotalFileSize` 与 `readData` 都写） |
| `filePosition[tab]` | number | byte | `:151,732,1437,…` | "下一个 epoch 起点"游标 |
| `currentFilepos/lastFilepos` | number | byte | `:361,889-891` | 预扫描看门狗用 |
| `startTime[tab]` / `endTime[tab]` | Date | 本地时区编码的 GPS 时间 | `:319,324` | 文件首/末条有效日志时间 |
| `totalPlaybackTimeMsec[tab]` | number | ms | `:866` | `Date.parse(end)-Date.parse(start)` |
| `currentLogTime[tab]` | Date **或 string** | 同上 | `:792,1438` | 当前播放位置（类型不一致，见 §9） |
| `previousLogTimeinMsec[tab]` | string/Date | — | `:463` | 初值 `startTime`，之后未再参与计算 |
| `currentLogDetails[tab]` | `{offset,buffer,length,time,timeDiff}` | byte/Buffer/ms | `:796,807` | 下一个要发的 epoch 切片 |
| `nextLogDetails[tab]` | `{offset,time}` | byte | `:717-731` | 再下一个 epoch 的起点与时间 |
| `binaryLogsList[tab]` | number[] | — | `:379` | 文件中出现的**去重消息 ID 列表**（唯一"索引"产物） |
| `chanConfigBuffer[tab]` | Buffer | — | `:386` | 第一条 1148 CHANCONFIGLIST 原文 |
| `hasTimeLog[tab]` | number | — | `:90` | `binaryLogsList.indexOf(101)`，缓存于首查 |
| `state[tab]` | 0/1 | — | `:152,518` | `playbackStatesEnum.PLAY=0 / PAUSE=1`（`NovatelIdConstants.js:4624-4627`） |
| `speedX[tab]` | number | 倍 | `:135,936,943` | 当前倍速；离线取持久化值，live 面板强制 1 |
| `timeOut[tab]` | `Timer` | — | `:774,810` | 手动实现的单次定时器对象 |
| `progressBarUpdateInterval[tab]` | `customInterval` | — | `:784,820` | 进度条平滑刷新 |
| `loaderInterval[tab]` | Timeout/Interval | — | `:926,1156` | 加载遮罩兜底 |
| `delay[tab]` | number | ms | `:503` | 上一轮 `sendParsedDataToGenericParser` 的解析耗时 |
| `playbackStartOffset[tab]` | number | byte | `:163,310` | GRIT 文件跳过自定义头的偏移（普通文件 0） |
| `playbackEventsObj[tab]` | `{ts → {eventId → event}}` | — | `:1004-1046` | **时间戳索引的事件表**（仅"当前在报"的事件） |
| `allPlaybackEventsObj[tab]` | 同上 | — | `:1055-1064,1068` | 含历史事件；seek 时按 key 数值比较回放 |
| `getPlaybackEventTime[tab]` | `{logTimeStamp}` | — | `:1184` | seek 目标时间，用后即删（`:1342`） |
| `sendOnlyOneEpoch[tab]` | bool | — | `:1441` | 暂停态 seek 只渲染一帧 |
| `snippetData` | `{startIndex,endIndex}` | byte | `:1705,1748` | **全局单例**，不按 tab 分槽 |
| `prevLogData[tab]` / `playbackLogTime[tab]` | `{msgId → Buffer}` / `{msgId → nowMs}` | — | `:1886,1877` | 20x 限流用的缓存与时间戳 |

### 3.4 `playbackRenderData`（在 jarvisInterface 里，但语义归 Playback）

`[观察] 01_解包/app/jarvisInterface.js:32` `let playbackRenderData = {};`
——不是导出成员，只能通过 `jarvisInterface.setPlaybackRenderFlag(flag,tab)` 写
（`:5854-5860`），通过 `logBuffer` 内部读（`:3528`）。

- `false` ⇒ 解码出的日志**只**用于 VERSION 建型号、事件、statusBar time/idleTime，
  不 `emitter.emit('process', …)`，即**不刷新任何组件 tile**；
- `true`（或该 tab 无键）⇒ 正常分发。

`generateBinaryLogsAvailable` 在入口置 `false`、在全文件扫完后置 `true`
`[观察] 01_解包/app/controller/playback.js:355,397`。这是"预扫描不刷 UI"的开关。

### 3.5 `createPlaybackPanel(tab)`

`[观察] 01_解包/app/jarvisInterface.js:1143-1152`：纯 DOM 工厂，创建
`div.playback-panel#playback-panel-<tab>`（挂在 tab 容器下）+ 一个 `div.fetch-loader#fetch-loader-<tab>`。
没有状态、没有返回值；`addPlaybackTab` 在 `:5666` 调用它，并把 `#main-panel-<tab>`
加上 `playback-main-panel` 类。

---

## 4. 接口清单

`playback.js:2007-2039` 的导出（`playbackControl.*`）。按调用方归类：

### 4.1 生命周期

| 签名 | 副作用 | 异常路径 |
|---|---|---|
| `play(fileNamePath, tab, isLivePanel=false, canplay=true, ratio)` `:846` | 写 `fileName[tab]`；`fs.existsSync` 失败 → `connectionStatus("connectionerror", tab, "File does not exists")`（硬编码英文，未走 Language 表）；否则 `validateFile` | 之后所有异步错误都不冒泡到调用者 |
| `stopPlayback(tab)` `:95` | 清 `timeOut`/`progressBarUpdateInterval`/`loaderInterval`，强制 `state=PAUSE` | 无 |
| `closePlayback(tab, isLivePanel=false)` `:108` | 删 12 个 tab 槽；非 live 时记录"上次观看时间"、`genericView.deleteElementIds`、`controller.clearTab`、移除 `.tile` 节点 | 无 |
| `replay(tab)` `:426` | 复位 `filePosition=0`、`state=PLAY`、`clearUIData`，1 s 后回调 `handlePlaybackRewindForwardStart(tab,true)` 与 `handleOnReplayClick`；reset 事件 UI | 无 |

### 4.2 播放控制

| 签名 | 说明 |
|---|---|
| `onPlayPause(tab)` `:1589` | 依据 `state[tab]` 切换；从暂停恢复时若 `#playbackprogressBlue` 宽度为 0（从未播过）则从 `startTime` 重新 seek，否则 `timeOut.resume()`；`timeOut` 不存在且无进度条 interval 时按 `filePosition` 重建 `parseBinaryLog` |
| `setSpeedRatio(speed, tab)` `:134` | 写 `speedX`、持久化 `deviceManagement.updatePlaybackSpeed`；播放中改速走 `timeOut.restart(speed)` + `progressBarUpdateInterval.changeinterval()`；未播放且 `canPlay` 为真时 `sendNextLogBuffer` |
| `onProgressbarSeek(ratio, tab, time)` `:1087` | 清定时器 → `onProgressbarSeekASync` |
| `rewind(Msec, tab)` `:1099` | 目标 = `currentLogTime - Msec`，钳到 `startTime`；暂停态先刷进度条再置 PLAY；最后按绝对时间戳 seek |
| `setPlayingState(state, tab, canplay=true)` `:517` | 写 `state`；PAUSE 时 `timeOut.pause()`，PLAY 且 `canplay` 时 `timeOut.resume()` |
| `updateTimeOnMove(ratio, tab)` `:1807` | 拖拽/点击过程中只改文案 `currentTime`，不动播放位置 |

### 4.3 片段（snippet）

`onCreateSnippet(startRatio,endRatio,tab)` `:1765`（只算时长文案）、
`onSaveSnippet(startRatio,endRatio,tab)` `:1683`（定位起止字节 → `showFileDialog`）、
`hideSnippetControls` `:1782`、`onCancelSnippet` `:1790`。

### 4.4 查询

`getBinaryLogList` `:84`、`getRxName` `:49`（无记录时返回 `"OEM"`）、
`getPlaybackEventObject` `:38`、`getPlaybackEvent(tab,ts,dataLang,freqValue)` `:45`、
`getEventLogTime` `:41`、`isTimeLogAvailable` `:88`、`eventsMarked` `:980`、
`getCurrentPlayingTime` `:531`、`fileDataRead`（**直接导出对象引用**，`:2010`）。

### 4.5 内部关键函数（无导出，但决定了行为）

`Timer` `:166`、`customInterval` `:199`、`getLogTimeStamp` `:252`、`getBinaryLogGPSTime` `:653`、
`getGPSTime` `:647`、`getSameLOgBufferIndex` `:671`、`parseBinaryLog` `:804`、
`sendNextLogBuffer` `:769`、`sendParsedDataToGenericParser` `:482`、`checkSkipData` `:1818`、
`findLogIndexWithTimeStamp` `:1422`、`getNearestLog` `:1354`、`readData` `:615`、
`calculatePlaybackTime` `:299`、`generateBinaryLogsAvailable` `:353`、`validateFileCallback` `:900`。

---

## 5. 报文/协议细节

### 5.1 OEM 记录（`RxDetails.sync == "aa44121c"`）

被本组件依赖的字段（其余不管）：

| 偏移 | 长度 | 字段 | 用法 |
|---|---|---|---|
| 0 | 4 | 同步 `AA 44 12 1C` | 扫描/切片的唯一锚点 |
| 4 | 2 | 消息 ID (u16 LE) | 去重入 `binaryLogsList`；`handleEventLogs` 分流 |
| 8 | 2 | 负载长度 (u16 LE) | 记录总长 = `28 + len + 4` |
| 10 | 2 | 序列号 (u16 LE) | `logBuffer` 只在 `seq==0` 时刷 statusBar 的 time/idleTime（`jarvisInterface.js:3514-3525`） |
| 12 | 1 | idle time（`/2` 得百分比） | 同上 |
| 13 | 1 | **timeStatus** | 200/20/0/194 → 视为无效时间 |
| 14 | 2 | GPS 周 (u16 LE) | `getBinaryLogGPSTime` |
| 16 | 4 | GPS 周内毫秒 (u32 LE) | 同上 |

### 5.2 GIII 记录（`RxDetails.sync == "AACC4756"`）

| 偏移 | 长度 | 字段 | 依据 |
|---|---|---|---|
| 0 | 4 | `AA CC 47 56` | `playback.js:8`；`genericparser.js:463` 同判据 |
| 4 | 2 | 长度（含 4 字节尾） | `playback.js:30`；`genericparser.js:466` |
| 6 | 2 | 消息 ID | `playback.js:32`；`genericparser.js:467` |
| 12 | 1 | timeStatus | `playback.js:33` |

**注意**：`getBinaryLogGPSTime` 对 week/ms 的偏移写死为 `+14` / `+16`
`[观察] 01_解包/app/controller/playback.js:664-665`，与接收机类型无关。而 GIII 的
`headerLen` 是 0、`msgIdOffset` 是 6，说明 GIII 头与 OEM 头不同构。因此 GIII 文件的
"周/秒"是从别处偏移的字节读出来的，时间轴按 OEM 布局解释 → 见 §8 R27 与 §9。

### 5.3 比例换算与算例

- **GPS 周内毫秒 → 秒**：`secOfWeek = raw / 1000`（`raw` 为 u32，范围 0…604799999）。
- **GPS → UTC**：`utcMs = raw - 18000`。18000 出现在两处：
  `playback.js:666`（`getGPSTime(week, GpsMsec-18000)`）与
  `NovatelIdConstants.js:12`（`GPStoUTCcorrection = 18000`）。即固定 18 s 闰秒差，**不随周数变化**。
- **算例**（可复算）：`week=2300, raw=388800000`。
  `2300*7 = 16100` 天；`1980-01-06 + 16100 d = 2024-02-04`（1980…2023 间 11 个闰日：16071 d → 2024-01-06，
  再 +29 d）。`388800000 ms = 388800 s = 4 d 12 h`。GPS 时刻 = `2024-02-08 12:00:00`，
  减 18000 ms → `2024-02-08 11:59:42 UTC`。
- **记录总长**：`total = headerLen + msgLength + 4`（`playback.js:689,1839`）。

### 5.4 边界条件（代码里实际做的检查）

| 场景 | 处理 | 位置 |
|---|---|---|
| 剩余字节 < 28（头不完整） | `getBinaryLogGPSTime` 直接返回 `"Invalid Date"`；`getLogTimeStamp` 取 `-1` 时回退到上一个 sync | `:655-657,257-262` |
| 长度字段越界 | `getSameLOgBufferIndex` 判 `index > data.length` → 返回当前结果；`generateBinaryLogsAvailable` 判 `index+headerLen >= buffer.length-lastIndex` → 记为不完整并跳出 | `:697-699,372-376` |
| CRC | **完全不校验**。唯一一处是 `GenericParser` 的 `exstcrc != 0` 才继续 | `genericparser.js:139-141` |
| 空文件/全无有效时间 | `calculatePlaybackTime` 的 while 条件 `offset < totalFileSize` 使 `startTime` 保持 `"Invalid Date"` → `SELECT_VALID_FILE` | `:314-318,925-958` |
| 读越界 | `readData` 把 `length` 截到 `size-offset`；`offset >= size` 时先调 `onPlayBackCompleted` 再读 0 字节 | `:623-630` |

---

## 6. 状态机与事件流

### 6.1 打开一次文件（含"索引"建立）

```
play()  :846
 └ validateFile  :859   readData(0, 819200)
    └ validateFileCallback  :900
        ├ GRIT 专用：前 819200 B 必须含 "HEADER - NAS GRIT FILE"     :902-909
        ├ 魔数探测：buffer.indexOf("aa44121c") / ("AACC4756")        :913-914
        ├ 命中 → initPlayback(tab)（清空全部 tab 槽）                 :916
        ├ RxDetails[tab] = OEMdetails | GIIIdetails（仅首次）          :920-921
        ├ calculatePlaybackTime(tab)                                   :299
        │   ├ getTotalFileSize
        │   ├ GRIT：在前 819200 B 找 "HEADER - DATA START"，命中处即 playbackStartOffset  :305-310
        │   ├ 起点：从 offset 起每 +819200 读一块，getLogTimeStamp(data,0) 直到拿到有效 Date  :314-318
        │   └ 终点：从 size-819200 起，先 lastIndexOf(sync)，再 getLogTimeStamp(buffer,-1)  :320-335
        ├ 起点/终点都有效 → loaderInterval = setInterval(checkAnyExceptions, 30000)  :926-929
        ├ generateBinaryLogsAvailable(tab,0,1)（全文件预扫描）          :353
        ├ connectionStatus("connectionsuccess", tab, RxDetails[tab].rxType)  :935
        ├ speedX[tab] = deviceManagement.getPlaybackSpeed(tab)          :936
        └ setTimeout(updateStartEndTime, 200)  ← 等播放器控件 DOM 就绪   :937-940
             ├ updateTimeline → genericView.updateView(...,"playback") + updatePlaybackTile  :339-351
             ├ markEvents(tab)  （仅 OEM 分支）                          :869
             ├ sendGritOnchangedLogs（补发 GRIT 头部那段数据）            :870,404-409
             ├ chanConfigBuffer 单独 emit 一次（1148）                    :875-878
             └ parseFirstLog(tab) → parseBinaryLog(playbackStartOffset)   :461-474
```

**"索引"的真相**：`generateBinaryLogsAvailable`（`:353-402`）从 offset 0 起顺序读满整个文件，
把见到的每个消息 ID 去重塞进 `binaryLogsList`，顺手缓存第一条 1148 并转发事件类日志。
它**不记录任何 时间→偏移** 的对应关系，也不落盘。所以：

- O(文件大小) 的一次性开销（每块 819200 B，串行 await）；
- 得到的"索引"只能回答"这个文件里有没有某类日志"，用来决定 §7 的 tile 是否创建
  （`jarvisInterface.js:1497-1806` 全是 `logsListplayback.indexOf(...)`）；
- seek 时仍然靠**线性扫描**重新定位（§6.3）。

### 6.2 播放循环（每个 epoch）

```
parseBinaryLog(index)  :804
 ├ dataIndex      = getSameLOgBufferIndex(index,  currentLogTime)
 ├ currentLogTime = dataIndex.time
 ├ currentLogDetails = getSameLOgBufferIndex(dataIndex.offset, nextLogDetails.time)
 ├ interval = dataIndex.timeDiff / speedX
 ├ timeOut = new Timer(cb, interval*speedX, speedX, delay[tab])
 │            cb: state==PLAY 时 sendParsedDataToGenericParser(currentLogDetails.offset & buffer)
 └ interval > 500 → progressBarUpdateInterval = new customInterval(...)（每 500/speed ms 把伪造时间 +500 ms）

sendParsedDataToGenericParser  :482
 ├ state==PAUSE 或 !data → return
 ├ 清 progressBarUpdateInterval
 ├ speedX > 10 → checkSkipData(...)（按消息类型限流）
 │   否则       → playbackEmitter.emit("sendData", data, tab)
 ├ delay[tab] = Date.now()-time1
 ├ sendOnlyOneEpoch → state=PAUSE, return
 ├ updateProgress(tab)
 └ index < totalFileSize → playbackEmitter.emit("parseLogBuffer", tab)
      → 监听器（:2055-2057）→ playbackControl.sendNextLogBuffer(tab)
           ├ 若 currentLogDetails.offset+length <= size：清旧 timer，建新 Timer
           ├ interval > 500 → 新的 customInterval
           ├ currentLogTime = currentLogDetails.time
           └ currentLogDetails = getSameLOgBufferIndex(nextLogDetails.offset, nextLogDetails.time)
```

一个 epoch 的切片由 `getSameLOgBufferIndex`（`:671-767`）决定：从 `lastBinIndex` 到
"第一条时间戳 > 目标时间"的日志起点，即**同一时间戳的所有日志一次性发出**。这正是
NovAtel 日志按时间戳成组落盘的结构，用它替代"逐条日志"能保证一次 UI 刷新拿到整组数据。

### 6.3 seek（进度条点击 / 后退 30 s / 重放）

```
onProgressbarSeek(ratio|"", tab, time)  :1087   → onProgressbarSeekASync  :1154
 ├ showLoader + 35 s 兜底
 ├ setPlayingState(PAUSE)
 ├ 目标时间：给了 time 就用 time；否则 startTime + duration*ratio/100
 ├ bufferSize = clamp(int(totalFileSize/1700), 13100, 819200)     :1186-1193
 ├ 1148 在文件里 → jarvisInterface.clearUIData(tab)               :1194-1196
 ├ handlePlaybackRewindForwardStart(tab,false,ts)                 :1199
 ├ onPlaybackTimelineClick(tab, rewind, current, target)（GRIT 地图标记）  :1203-1208
 ├ findLogIndexWithTimeStamp(filePosition[tab], bufferSize, ts, tab, !rewind)  :1211
 └ clearTimeout + handlePlaybackRewindForwardStart(tab,true) + handleEventsPanel
```

`findLogIndexWithTimeStamp`（`:1422-1556`）：

- 正向：读 `bufferSize` 一块，比较该块的 `start`/`end` 时间戳；
  `seek` 落在区间内 → `getNearestLog` 在块内线性找到落点，`filePosition = startIndex + res.index`，
  再 `parseBinaryLog` 起播；`start > seek`（块整体在目标之后）同样就地落点；
  否则 `startIndex += bufferSize` 递归下一块。
- 反向：先把 `startIndex` 退一块，同样判区间；`end < seek` 时直接把 `filePosition` 推到块尾；
  整块都无有效时间戳时再退一块，退到 0 则 `parseFirstLog` 从头播。

**复杂度**：每次 seek 的顺序读量 ≈ 文件大小（步长≈size/1700，正常文件约 1700 次块读；
文件 >1.39 GB 时步长封顶 819200，次数随大小继续增长），块内 `getNearestLog` 又是线性扫描
→ 总 O(size)。**没有二分，也没有时间索引可查**。

---

## 7. 与其它子系统的耦合点

### 7.1 注入点（本组件最核心的耦合）

`playback.js` 底部三个监听器（`:2043-2057`）：

```js
playbackEmitter.on("sendEventsData", (data, tab) => GenericParser.processMessage_(data, tab));
playbackEmitter.on("sendData", (data, tab) => {
    if (playbackControl.getRxName(tab) == "OEM") GenericParser.processMessage_(data, tab);
    else                                    GenericParser.parseGIIIdata(data, tab);
});
playbackEmitter.on("parseLogBuffer", (tab) => playbackControl.sendNextLogBuffer(tab));
```

- **被替换的不是全局对象，而是"数据源"**：在线路径是 socket `'data'` 事件 →
  `handleLivePlaybackData` → `GenericParser.processMessage_`
  `[观察] 01_解包/app/controller/communication.js:707-719`；回放路径是
  `playbackEmitter` → **同一个** `GenericParser.processMessage_`。
- 因此字节级解析、`tempbuffermap` 半包缓存、CRC 零值判断、`jarvisInterface.logBuffer`
  分发、`logParsers.parseData` 字段解析，全部**复用同一份代码**，不存在"回放专用解析器"。
- 差异只有一处补丁：`genericparser.js:171-177`，当
  `connectionDetailsMap[tab].type == "playback"` 时，遇到 ASCII 起始符只按
  `data.indexOf("aa44121c")` 跳到下一条二进制记录，**不解析文本日志**——即回放不支持
  ASCII/NMEA 日志，静默丢弃。

### 7.2 `jarvisInterface`（调用清单）

| 被调函数 | 调用点 | 作用 |
|---|---|---|
| `setPlaybackRenderFlag(flag,tab)` | `playback.js:355,397,847` | 预扫描期间抑制 UI 刷新 |
| `connectionStatus(status,tab,msg)` | `:850,897,907,935,957,962` | `connectionsuccess/connectionerror` |
| `updatePlaybackTile(data)` | 经 `updateTimeline` `:350` | 填落地页 tile 的 Start/End/Duration |
| `clearUIData(tab)` | `:435,1195` | 清组件缓存（seek 前） |
| `handlePlaybackRewindForwardStart(tab,isLive,ts,isReturnToLive)` | `:428,440,1105,1199,1223` | 只对 grit tab 生效：地图 rewind/forward、mitigationAssistant、`gritEvents.resetEventsData`；非 grit 只 `events.resetEventsData`（`jarvisInterface.js:6039-6052`） |
| `onPlaybackTimelineClick(tab,isRewind,cur,seek)` | `:1204,1207` | 委托 `positionOverview.onPlaybackClick`（`:6120-6127`） |
| `handleOnReplayClick(tab,true,endTime,currentLogTime)` | `:441` | 委托 `positionOverview.onReplayClick` |
| `connectionDetailsMap[tab].type` | 多处读 | 判定"离线回放 / live 面板" |
| `compRegister['events']` | `:418` | 预扫描时决定哪些日志当事件转发 |
| `tabids[tab]` | `:124` | 落地页 tile 的键 |

### 7.3 `controller/genericparser.js`

- `GenericParser.processMessage_(data, tab)` `genericparser.js:13-193`：ASCII/二进制双模态扫描器；
  二进制分支要求 `data[i]==170 && (data[i+2]==18||19)`，`18` 走 28 字节头、
  `19` 走 12 字节头（`genericparser.js:111-126`）。回放只产出 `18` 型记录，所以 `19` 型
  （NovAtel 短头）在回放里不会被单独构造，只在被包含进 epoch 切片时按同一逻辑识别。
- `GenericParser.parseGIIIdata(data, tab)` `genericparser.js:419-498`：GIII 分支。
- `GenericParser.clearLiveDataInPlaybackmode(tab)` `genericparser.js:7-10`：清半包缓存；
  由 `livePlayback` 在进入/退出回看模式时调用（`livePlayback.js:554,572`）。

### 7.4 `model/logparsers.js`

`playback.js` **不直接**调用它。链路是
`playbackEmitter → GenericParser.processMessage_ → jarvisInterface.logBuffer(msgID, jDataView, tab)
→ logParsers.parseData(msgID, data, dummyJSON[msgID], tab)`（`jarvisInterface.js:3530,3564`）。
回放与在线在 `logParsers` 看来完全一样，唯一区别是 `logBuffer` 里
`connectionDetailsMap[tab].type == 'playback'` 的几个分支（`:3512-3527,3532-3551`）。

### 7.5 `view/genericView.js`

- `updateView(data, keys, "playback")`：`keys` 支持 `duration,startTime,endTime`（`:345`）、
  `currentTime,progressBlue`（`:553`）、`snippet-timeline p`（`:1776`）。
- `genericView.js:95-108`：写 `progressBlue`/`scrub` 时若值 **等于 100** 就调
  `genericView.onPlaybackCompleted(tab)` → 给按钮加 `replay` 类（`:803-807`）。
  **这是"文件播完"的唯一 UI 信号**（见 §8 R21/R22）。
- `deleteElementIds` / `hidePlaybackSnippetControls` / `createDialog`（片段保存成功弹窗，
  `playback.js:2098`）。

### 7.6 其它

- `deviceManagement`：`getPlaybackSpeed`/`updatePlaybackSpeed`（`deviceManagement.js:127-130,179-187`，
  上限 20、GRIT 上限 10）、`getPlaybackShowEvents`/`updatePlaybackShowEvents`、
  `updatePlaybackLastViewed`、`getLastUsedPlaybackPath`/`updateLastUsedPlaybackPath`、
  `createPlaybackDeviceTile`/`updatePlaybackDeviceDetails`、`fetchPlaybackDevices`。
- `events` / `gritEvents`：`getEventHandlerObject`、`gethistoricEventObj`、
  `resetEventsData`、`removeEntryFromCurrent`、`updateplaybackEventsOntoUI`、
  `getGritEventCount`、`resetGritPlaybackEventsUI`、`resetPlaybackEventsUI`（`:994-1001,1257-1276,443-444`）。
- `featuresList`：`setDefaultRxProperties` / `setDefaultGIIIProperties` / `readReceiverProperties`
  （§8 R5、R28）。
- `livePlayback`：`getPlaybackTime`、`getLivePlaybackTimeDetails`、`updateHistoryFile`、
  `setHisUpdateFlag`（`:537-539,1131-1137,1216`）。
- `livePlaybackControl`：`getConnectionType(tab)`，`playback.js:839,1161,1592` 用它区分
  `live/playback/handleMissedData/unknown`（`NovatelIdConstants.js:70-75`）。
  **隐含构建依赖**：`livePlayback`/`livePlaybackControl` 只在
  `view/GRIT` 目录存在时才被动态注入（`index.html:1126-1140`），而 `playback.js:537`
  在 `type=="playback"` 时会直接求值 `livePlayback.getPlaybackTime(tab)`（`||` 左值为 false
  不会短路）——去掉 GRIT 目录的构建会在每一帧 `updateProgress` 抛 `ReferenceError`。
  `[观察] 01_解包/app/controller/playback.js:537,839,1161`、`01_解包/app/view/html/index.html:1126-1140`
- `spectrumPlot`：`resetWaterfallPlot`、`setskipHandlePlotCountForTab`
  （`playbackview.js:182-183,434`），seek 时清瀑布图。

### 7.7 回放 tab 与在线 tab 的差异

`jarvisInterface.js:1488-1806` 是同一段建 tile 的代码，`type == "playback"` 时把条件
从"功能是否支持"换成"文件里有没有对应日志"。逐条（`logsListplayback` = `binaryLogsList`）：

| tile / 面板 | 在线 | 回放条件 | 位置 |
|---|---|---|---|
| `statusBar`（tile-0） | 总是 | **总是** | `:1479-1483` |
| `satelliteTracking` | 总是（非 GIII/非 LongHorn） | 需同时含 `83`(TRACKSTATB)、`1043`(SATVIS2)、`1148`(CHANCONFIGLIST)、`93`(RXSTATUS)，否则整页隐藏 | `:1497-1557` |
| `positionStatus` | 是 | `compRegister.positionStatus` 与文件日志有交集 | `:1558-1569` |
| `pppCorrections` | 是（marine/mPak 或 TerraStar） | 交集 + 机型支持 | `:1570-1579,1721-1730` |
| `satelliteView` | 是 | 交集（`42,83,174,1043,1194,1201,1718`） | `:1580-1586,1714-1720` |
| `alignStatus` | 需 `isAlignSupported` | 需文件含 `1335`(HEADING2) 且支持 | `:1587-1606,1731-1750` |
| `spanStatus` | 需 `getSPANSupported` | 需文件含 `1465`(INSPVAX) 且支持 | `:1607-1623,1753-1769` |
| `interferenceStatus` | 非 OEM6/STAR | 交集 | `:1625-1633,1694-1702` |
| `logStatus` | 非 OEM6/STAR | 需 `(2127 或 1146)` **且** `5`(LOGLIST) | `:1634-1643,1781-1790` |
| `portStatus` | 是 | 需 `3`(INTERFACEMODE) 且 `72`(PORTSTATS) 且 `5`(LOGLIST) | `:1644-1652,1792-1800` |
| `events` 面板 | 是 | 交集（`5,42,83,93,94,101,963,1201,1329,1459,2065,2358`） | `:1654-1658,1801-1805` |
| `radioStatus` | 需 `getIsRadioTxSupported` | 交集 + 支持；回放时 `compReqlogs` 仍会发请求但无人响应 | `:1659-1684,1806+` |
| `deviceInfo` | 是 | 交集 | `:1687-1693` |
| 菜单/配置面板 | 可见 | `#configs`、`.menuBar-panel` 被 hide，`.events-menu-link` 被 hide | `:1475-1477,5662-5663` |

GRIT 回放 tab 走 `gritJarvisInterface.checkGritConnectionReady`（`gritJarvisInterface.js:626-760`），
同一套"取交集决定 tile"的逻辑，`compRegister` 换成 `gritCompRegister`。

---

## 8. 复现清单

> 每条都可用"打开一个已知日志 + 观察/断点"验收。

**文件识别与打开**

- `R1` 文件类型判定**只看魔数不看扩展名**：读文件前 819200 B，`indexOf("aa44121c",0,"hex")>-1`
  ⇒ OEM；`indexOf("AACC4756",0,"hex")>-1` ⇒ GIII；两者都不含 ⇒ 报 `SELECT_VALID_FILE`。
  `[观察] 01_解包/app/controller/playback.js:913-914,960-963`
- `R2` 扩展名仅出现在两处 UI 过滤里：浏览对话框 `extensions:["log","dat","gps","bin"]`
  与隐藏 input `accept=".gps,.bin,.dat,.log"`；把 `.gps` 改名 `.txt` 仍可打开（因为 R1）。
  `[观察] 01_解包/app/view/html/playback.html:128-133`、`01_解包/app/view/html/index.html:355`
- `R3` 文件不存在时提示字符串是硬编码 `"File does not exists"`（不走 `Language` 表）；
  文件存在但无魔数/无有效时间时提示 `Language[...].SELECT_VALID_FILE`。
  `[观察] 01_解包/app/controller/playback.js:849-851,962`
- `R4` GRIT 回放额外要求前 819200 B 内含 ASCII 串 `"HEADER - NAS GRIT FILE"`，
  并在前 819200 B 内定位 `"HEADER - DATA START"` 作为 `playbackStartOffset`（找不到则 0）。
  `[观察] 01_解包/app/controller/playback.js:302-310,903`、`01_解包/app/view/GRIT/gritJarvisInterface.js:2-3`
- `R5` `RxDetails[tab]` 只写一次（`if(!hasOwnProperty)`），同一 tab 先开 OEM 再开 GIII
  会沿用旧描述符；且这行把描述符赋给**未声明的全局** `rxDetails`（不是 `RxDetails`）。
  `[观察] 01_解包/app/controller/playback.js:920-921`
- `R6` `if(!($(tabid+".live-playback-panel")))` 恒为假（jQuery 对象恒真），所以
  `featuresList.setDefaultRxProperties/setDefaultGIIIProperties` 在这条路径**永不执行**；
  实际生效的默认值来自 `jarvisInterface.js:1491-1493`（仅当文件里没有 VERSION 时）。
  `[观察] 01_解包/app/controller/playback.js:917-919`、`01_解包/app/jarvisInterface.js:1491-1493`

**型号/固件探测**

- `R7` 型号与固件**不是**从文件头读的，而是从文件里第一条 `37`(VERSION) 日志解析出来的：
  `logBuffer` 在 `playbackRenderData[tab]==false` 时对 `msgID==37` 取
  `featuresList.readReceiverProperties(detailsArray,tab)`，得到
  `hardwareVersion/PSN/firmwareVersion`（GPSCARD 组件）。`[观察] 01_解包/app/jarvisInterface.js:3532-3540`、
  `01_解包/app/model/featuresList.js:7-20`
- `R8` 文件里没有 `37` 时用默认特性表（全星座、SBAS 位置模式、align/span/wifi/storage 全开），
  因此 UI 会显示比实际接收机更多的能力。`[观察] 01_解包/app/model/featuresList.js:352-364`、
  `01_解包/app/jarvisInterface.js:1491-1493`

**读取与索引**

- `R9` 读取是**分段**的：每个窗口 819200 B，`fs.open("r+")` + `fs.read` + `fs.close`，
  一次调用一次开关文件。没有 mmap、没有 ReadStream、没有缓存整文件。
  `[观察] 01_解包/app/controller/playback.js:615-645`
- `R10` 打开时做**一次全文件顺序预扫描**，逐块枚举消息 ID 去重入 `binaryLogsList`，
  并缓存第一条 `1148`(CHANCONFIGLIST)，对 `compRegister['events']`/`versionId`/`bestvelId`
  的日志额外 emit 一次（品牌：`sendEventsData`）。`[观察] 01_解包/app/controller/playback.js:353-402,412-421`
- `R11` 预扫描期间 `playbackRenderData[tab]=false`（`logBuffer` 只建型号/事件、不刷 tile），
  扫完置 `true`。`[观察] 01_解包/app/controller/playback.js:355,397`、`01_解包/app/jarvisInterface.js:3528-3560,5854-5860`
- `R12` **不存在 时间→偏移 索引**：`binaryLogsList` 只含消息 ID，不含时间或字节偏移；
  关闭再打开同一文件必须重新扫一遍。`[观察] 01_解包/app/controller/playback.js:379`（写入点唯一）
- `R13` 起止时间探测：起点从 offset 起每 +819200 读块直到 `getLogTimeStamp(data,0)` 给出有效
  `Date`；终点从 `size-819200` 起读块，取最后一个同步字后再 `getLogTimeStamp(buffer,-1)`，
  若该块无同步字则继续向前退块。`[观察] 01_解包/app/controller/playback.js:314-335`
- `R14` 播放是**按 epoch 流式**：一次读 819200 B，切出"同一时间戳的全部日志"作为一个切片发出；
  每个 epoch 至少触发 2~3 次 819200 B 读（`parseBinaryLog` 两次 + `sendNextLogBuffer` 一次）。
  `[观察] 01_解包/app/controller/playback.js:671-767,804-828,769-802`
- `R15` seek 是线性扫描：步长 `clamp(int(size/1700), 13100, 819200)`，正向 +步长、反向 −步长，
  块内再线性找落点；总读量 ≈ O(文件大小)，无二分。`[观察] 01_解包/app/controller/playback.js:1186-1193,1422-1556`

**播放控制**

- `R16` 倍速枚举只有 `1/2/5/10/20`（下拉框 5 项）；GRIT 回放 tab 会删掉 `speed_10`、`speed_20`
  两项（只剩 1/2/5）；持久化读回时 `speed>20 → 1`、GRIT 且 `speed>=10 → 1`；默认 1。
  `[观察] 01_解包/app/view/playbackcontrol/playbackcontrol.html:79-83`、
  `01_解包/app/jarvisInterface.js:5093-5096`、`01_解包/app/view/deviceManagement/deviceManagement.js:179-187`
- `R17` 定时器间隔算法（`Timer`）：`delay = Δt/speed − parseCost`，且当 `delay>8` 时再 `−8`；
  `Δt` 是"当前 epoch 时间戳 − 上一 epoch 时间戳"（ms），`parseCost` 是上一帧
  `sendParsedDataToGenericParser` 的耗时。`[观察] 01_解包/app/controller/playback.js:166-198,773-778,503`
- `R18` 同档位下的实际间隔：1x≈Δt−parse−8、2x≈Δt/2−parse−8、5x、10x 同理；
  20x 走另一条路径（见 R19），不再逐帧等 Δt/20。
  `[观察] 01_解包/app/controller/playback.js:492-501,808-814`
- `R19` `speedX>10` 时用 `checkSkipData` 做**按消息类型限流**：同一 msgId 在
  `updateSpeedTime[speed]` 毫秒内只发一次，其余帧的最新值缓存在 `prevLogData` 里合并后补发；
  `updateSpeedTime = {20:500, 30:200, 60:130}` ⇒ 只有 20 是可达键，11…19 与 30/60 都为
  `undefined`（`t - last > undefined` 恒假，等于永久不 emit）。`[观察] 01_解包/app/controller/playback.js:476-480,1861-1894`
- `R20` 进度条平滑刷新：仅当 `interval = Δt/speed > 500 ms` 时启动，频率为 `500/speed` ms，
  每次把伪造时间 `+500 ms`（即"日志时间 500 ms/帧"，与倍速成正比）。
  `[观察] 01_解包/app/controller/playback.js:199-219,780-791`
- `R21` 该分支的守卫条件是单位混用：`currentLogDetails.time.getMilliseconds() + 500 < totalPlaybackTimeMsec`
  ——左边是"秒内毫秒(0..999)+500"，右边是总时长(ms)，实际只在总时长 <1.5 s 时才会为假。
  `[观察] 01_解包/app/controller/playback.js:783,819`
- `R22` **没有循环播放、没有单步（逐条/逐 epoch）、没有键盘快捷键**：全文无 `loop`、
  无 `keydown`，控件只有 `rewind`（固定 30 s）/`play-pause`/倍速/进度条/片段/事件开关。
  `[观察] 01_解包/app/view/playbackcontrol/playbackcontrol.html:66-97`、
  `01_解包/app/view/playbackcontrol/playbackview.js:431-436`
- `R23` 跳转只有两种：进度条点击（按像素比例换算百分比）与后退 30 s
  （`rewind(30*1000, tab)`，目标钳到 `startTime`）。拖动只移动蓝色条与文案，
  **mouseup 才真正 seek**。`[观察] 01_解包/app/view/playbackcontrol/playbackview.js:154-188,273-305,431-436`
- `R24` 播放中改倍速：若存在 `progressBarUpdateInterval` 则
  `timeOut.restart(newSpeed)`（`remaining = remaining*speed/newspeed` 后重设）
  + `progressBarUpdateInterval.changeinterval()`（重建 `500/newspeed` 的 interval）。
  `[观察] 01_解包/app/controller/playback.js:134-148,184-189,207-210`
- `R25` 暂停态点击进度条只渲染**一帧**：`!canPlay(tab)` 时置 `sendOnlyOneEpoch=true`，
  发完这一帧后 `state=PAUSE` 并 return；`canPlay` 的判据是 `.playControl` 是否带 `pause` 类。
  `[观察] 01_解包/app/controller/playback.js:505-509,1440-1444,1347-1352`

**注入管线**

- `R26` 注入点固定为 `GenericParser.processMessage_`（OEM）与 `GenericParser.parseGIIIdata`（GIII），
  与在线 socket 路径**同一个入口函数**；分流依据是 `getRxName(tab)`（无记录返回 `"OEM"`）。
  `[观察] 01_解包/app/controller/playback.js:2048-2053`、`01_解包/app/controller/communication.js:707-719`
- `R27` 事件日志走独立 channel `playbackEmitter.emit("sendEventsData")`，但它**也**调
  `GenericParser.processMessage_`，只是不带 epoch 语义（预扫描期 & live 面板各有一条触发条件）。
  `[观察] 01_解包/app/controller/playback.js:412-421,2043-2046`
- `R28` 回放时 `GenericParser` 遇到 ASCII 起始符不做文本解析，直接
  `i = data.indexOf("aa44121c", index, "hex")` 跳走 ⇒ **纯 NMEA/ASCII 日志文件打开后无任何显示**。
  `[观察] 01_解包/app/controller/genericparser.js:169-177`
- `R29` `1148`(CHANCONFIGLIST) 会在开播前单独补发一次（用于干扰工具箱的频率表）：
  `if(chanConfigBuffer[tab]) emit("sendData", …)` 再等 10 ms 后 `parseFirstLog`。
  `[观察] 01_解包/app/controller/playback.js:875-879`
- `R30` GRIT 文件的头部段（`HEADER - NAS GRIT FILE` 到 `HEADER - DATA START` 之间）在
  开播时用 `sendGritOnchangedLogs` 整段补发；`playbackStartOffset==0`（普通文件）则跳过。
  `[观察] 01_解包/app/controller/playback.js:404-409,870`

**时间戳**

- `R31` 时间戳来源：OEM 头 `+13` timeStatus、`+14` GPS 周(u16 LE)、`+16` 周内毫秒(u32 LE)；
  `timeStatus ∈ {200,20,0,194}` 或 `msgId==94`(RXSTATUSEVENT) ⇒ 返回 `"Invalid Date"` 并跳过该条。
  `[观察] 01_解包/app/controller/playback.js:653-667`
- `R32` UTC 换算固定减 18000 ms（18 s），与 `NovatelIdConstants.GPStoUTCcorrection` 同值，
  不随 GPS 周/闰秒表更新。`[观察] 01_解包/app/controller/playback.js:666`、`01_解包/app/model/NovatelIdConstants.js:12`
- `R33` 时间构造用**本地时区**解析基准 `new Date('January 6, 1980 00:00:00')`，再用
  `setHours(week*7*24)`、`setMilliseconds(mSec±18000)` 靠进位滚动，而非
  `Date.UTC`/`setUTCxxx`。推论：内部绝对 epoch 比真 UTC 偏移一个时区量，而显示用本地 getter，
  偏移正好抵消 ⇒ 字符串里的 UTC 字段是对的；但一旦与真实墙钟（`Date.now`）比较就会差一个时区。
  `[观察] 01_解包/app/controller/playback.js:647-652,595-607`（`[推断]` 见下）
  > 推理链：`new Date('January 6, 1980 00:00:00')` 按本地时间解析（UTC+8 时绝对值为
  > `315964800000−28800000`）；`getUTCTimeFormat` 用 `getHours/getDate`（本地）渲染同一 Date；
  > 两处偏移一致，故显示字段等于"GPS 推出 UTC"的字段值。
- `R34` 显示格式**没有毫秒**：`msToTime` → `[HH:]MM:SS`（`hours==0` 时省略小时），
  `msToTimeString` → `H hrs:M m:S s` / `M m:S s`；`getUTCTimeFormat` → `DD Mon YYYY HH:MM:SS UTC`，
  `getUTCTimeFormatOnly` → `HH:MM:SS UTC`。`[观察] 01_解包/app/controller/playback.js:222-249,595-613`
- `R35` 负时长的格式化没有保护：`hours<10` 时前缀补零，`-1` 会变成 `"0-1"`；
  秒/分用 `parseInt` 向零截断。`[观察] 01_解包/app/controller/playback.js:228-233`
- `R36` GIII 文件仍按 `+14/+16` 取周与毫秒（描述符里 GIII 的 `msgIdOffset=6`、
  `headerLen=0`），时间轴 Layout 与 OEM 不同 ⇒ GIII 文件回放的时间/时长不可信，
  仅用于"能放出来"。`[观察] 01_解包/app/controller/playback.js:27-34,664-666`
- `R37` `getNearestLog`（seek 落点）**没有**减 18000，而 `getBinaryLogGPSTime`（起止时间）减了。
  推论：seek 到 T 会落在"校正后时间 ≥ T−18 s"的第一条日志上，即提前约 18 s 起播。
  `[观察] 01_解包/app/controller/playback.js:1391`（对比 `:666`）
- `R38` `currentLogTime[tab]` 类型不固定：`getSameLOgBufferIndex` 赋 `Date`，
  seek 路径赋 `new Date(ts).toString()` 字符串；所有消费点都靠 `Date.parse`/`new Date()` 兼容。
  `[观察] 01_解包/app/controller/playback.js:792,1438,1507,1203`

**结束 / 损坏 / 乱序**

- `R39` 播放结束的判定在 `readData`/`sendNextLogBuffer`：`currentLogDetails.offset+length >= size`
  时把 `offset` 置为 `size+1` 并调 `onPlayBackCompleted`；后者对 `type=="playback"`
  **直接 return**，不做任何界面动作。`[观察] 01_解包/app/controller/playback.js:795-801,830-844`
- `R40` 真正的"播完了"视觉信号来自 `genericView.updateView`：写 `progressBlue`/`scrub` 时
  值 `== 100` 即给 `.playControl` 加 `replay` 类，按钮变成"重播"。所以若最终进度停在 99.x，
  按钮不会变。`[观察] 01_解包/app/view/genericView.js:95-108,803-807`
- `R41` 点"重播"走 `replay(tab)`：`filePosition=0`、`state=PLAY`、`clearUIData`、
  1 s 后回调 `handlePlaybackRewindForwardStart(tab,true)` 与 `handleOnReplayClick`，
  并 reset 事件 UI（grit 与非 grit 各一个函数）。`[观察] 01_解包/app/view/playbackcontrol/playbackview.js:143-146`、
  `01_解包/app/controller/playback.js:426-445`
- `R42` 预扫描有 30 s 看门狗：`checkAnyExceptions` 比较 `currentFilepos` 与 `lastFilepos`，
  不前进则 `hideLoader` + `connectionerror(ERROR_OPENING_FILE)`（提示"打开文件出错"，
  即"损坏/无法前进"的唯一专门提示）。`[观察] 01_解包/app/controller/playback.js:888-899,926-929`
- `R43` 回放链路**不做 CRC 校验**；扫描与切片只信长度字段，长度字段被破坏时靠
  `largeUnknownbuffer` 与"下一块重新找同步字"重同步。`[观察] 01_解包/app/controller/playback.js:721-727,746-765`
- `R44` 时间戳回跳（out-of-order）：`getSameLOgBufferIndex` 把 `time <= 目标时间` 的日志
  一律当作"还没到"继续跳过（`timeDiff<=0` 分支），因此**向后跳的日志会被静默吞掉**，不会
  触发回退；若 `timeDiff` 为负，`Timer` 的 `setTimeout` 收到负延时 ⇒ 立即触发，形成突发。
  `[观察] 01_解包/app/controller/playback.js:694-695,737,168-170`
- `R45` `readData` 以 `"r+"`（读写）打开文件：只读介质/只读属性文件会 `EACCES`；
  且 `fs.open` 的错误在 Promise executor 的回调里 `throw`，不会被 Promise 捕获 ⇒ 渲染进程
  未捕获异常。`[观察] 01_解包/app/controller/playback.js:617-620`

**片段导出与落地页**

- `R46` 片段起止是"进度条像素比例 → 百分比 → 二分（实际是线性）查找字节偏移"：
  `getSnippetData` 每块比较 start/end 时间戳，`findLogEndIndexInBuffer` 找到该时间戳的
  最后一条日志。`[观察] 01_解包/app/controller/playback.js:1738-1762,1558-1586`
- `R47` GRIT 片段会先写入 2 行 ASCII 头再拼数据：
  `Buffer.from("HEADER - NAS GRIT FILE")` + 原文件 `[startIndex,endIndex)` 字节。
  `[观察] 01_解包/app/controller/playback.js:1727-1734`、`01_解包/app/view/GRIT/gritJarvisInterface.js:326-333`
- `R48` 片段默认目录是 `~/Documents/NovAtelData/PlaybackSnippets`，文件名
  `<原文件名>_SnippetFile_<YYYY-MM-DD_HH-MM-SS>.GPS`；保存成功后弹窗问"是否立即打开"，
  "是"→ `controller.updatePlaybackSettings(file, tab)` 关闭当前 tab、新开一个 tab。
  `[观察] 01_解包/app/controller/playback.js:1632-1680,2061-2102`、`01_解包/app/controller/communication.js:632-654`
- `R49` 落地页 tile 的 Start/End/Duration 由 `updatePlaybackTile` 回填，
  且 Start/End 会去掉 `"UTC"` 后缀；Duration 用 `msToTimeString(...,true)`（`H hrs M m S s`）。
  `[观察] 01_解包/app/controller/playback.js:339-351`、`01_解包/app/jarvisInterface.js:5593-5605`
- `R50` 关闭 tab 时把当前时间按 `getUTCTimeFormat` 写进该设备的 `lastViewed`，
  并删掉本 tab 的 12 个状态槽；不删 `chanConfigBuffer`/`RxDetails`/`speedX`
  （它们是跨 open 复用的，见 R5）。`[观察] 01_解包/app/controller/playback.js:108-132`

**GRIT 直播回看（复用面）**

- `R51` live playback **直接复用** `playbackControl.play(snapshotPath, tab, isLivePanel=true, canplay, ratio)`，
  即复用同一套 `validateFile → calculatePlaybackTime → parseBinaryLog` 与同一套注入点；
  差别只是 `isLivePanel=true` 时跳过 `generateBinaryLogsAvailable`、`speedX` 强制 1、
  且 `handleEventLogs` 只转发 `bestvel(99)/bestpos(42)`。`[观察] 01_解包/app/view/GRIT/livePlayback/liveplaybackview.js:234-250`、
  `01_解包/app/controller/playback.js:931-945,412-421`
- `R52` 回看窗口固定 10 min（`history_time_msec`）：`updateHistoryFile` 从历史文件尾部取
  819200 B 求出 end，再 `end-600000` 作为目标调用自己的 `findLogIndexWithTimeStamp`，
  然后**截断历史文件**到该偏移（`truncateFileAt` 用 `fs.writeFile` 整段重写）。
  `[观察] 01_解包/app/view/GRIT/livePlayback/livePlayback.js:128-170`
- `R53` `livePlayback` 里有一份 `getLogTimeStamp`/`getNearestLog`/`getGPSTime` 的**副本**，
  与 `playback.js` 的差异是：`getGPSTime` 自己做了 `-18000`、`getNearestLog` 也走该函数
  ⇒ 直播回看的 seek **没有** R37 的 18 s 偏差。两份代码必须同步改，否则行为分叉。
  `[观察] 01_解包/app/view/GRIT/livePlayback/livePlayback.js:434-439,352-412`（对比 `playback.js:1354-1420,647-652`）
- `R54` "Return to Live" 会调 `GenericParser.clearLiveDataInPlaybackmode(tab)` 清半包缓存，
  并把连接状态从 `liveConnState.playback(1)` 切回 `live(0)`。`[观察] 01_解包/app/view/GRIT/livePlayback/livePlayback.js:553-559`、
  `01_解包/app/view/GRIT/livePlayback/liveplaybackview.js:211-228`、`01_解包/app/model/NovatelIdConstants.js:70-75`

---

## 9. 未解之处

1. **GIII 文件的时间字段真实布局**。代码用 `+14/+16` 读周/毫秒，但 GIII 头 `headerLen=0`、
   同步字 `AA CC 47 56`、长度在 `+4`、ID 在 `+6`。缺：一份 GIII 二进制日志格式说明，
   或一个 GIII `.bin` 样本 + 十六进制核对。没有它无法判断 R36 是"设计如此"还是缺陷。
2. **`jDataView.indexOf(pattern, offset, "hex")` 的确切匹配语义**（大小写、是否需要对齐到
   记录边界、越界返回）。`GIII_BIN_SYNC` 是大写十六进制串而 `BIN_SYNC` 是小写，若实现里
   按字符串比较则两者必有一个失效。缺：`jdataview` 具体版本源码（`node_modules` 未在解包内）。
3. **`timeStatus` 200/20/0/194 的枚举含义**。代码只说"不可信"，未给枚举名。
   缺：OEM7 固件手册 `Header.timeStatus` 表（外部参考，需 PDF 页码）。
4. **20x 的实际观感**。按 R19，只有 20 是有效键，30/60 是死配置；但 `checkSkipData` 里
   `prevLogData` 的合并顺序与"首帧是否丢"取决于运行时刻，静态阅读无法确定首屏颗粒度。
   缺：一段 20x 录屏或对 `playbackLogTime` 的运行时打点。
5. **GRIT 文件头段的字节结构**。只知道两条 ASCII 标记串，不知道头部块长度、
   是否含版本/时间字段、是否参与时间轴。缺：一个 GRIT 录制文件的开头 hexdump。
6. **`sendOnlyOneEpoch` 与 `setPlayingState(PLAY, tab, false)` 的竞态**。
   `playbackview.js:177` 先 `setPlayingState(PLAY)`（会 resume timer），随后
   `findLogIndexWithTimeStamp` 又 `setPlayingState(PLAY, false)`（不 resume）并清/建 timer；
   静态顺序上能否稳定停在"一帧"，取决于这几个 setState 与 `Timer` 的 `remaining` 交互。
   缺：在真实文件上打断点观察 `timeOut` 是否残留。

---

## 10. 外部参考

本组件的行为**只用代码证据**说明；下面这些是判断"是否符合 NovAtel 规范"时才会用到的外部资料，
当前解包产物里没有对应 PDF，故不引用具体页码：

- **OEM7 日志头结构（28 字节 + CRC32）**：对应 §5.1 的偏移表。代码里的
  `headerLen=28`、`msgLenOffset=8`、`msgIdOffset=4`、`timeStatusOffset=13`、
  `week@14`、`ms@16` 与该结构的字段顺序一致 `[观察] 01_解包/app/controller/playback.js:55-62`。
- **GPS 时间 → UTC 的 18 s 闰秒差**：代码硬编码 18000 ms；
  规范值随闰秒增加，本实现的固定值在 2017 年以后仍正确，2017 年以前的历史文件会差 1~17 s。
  `[推断]` 依据 `NovatelIdConstants.js:12` 的单一常量 + 无任何查表逻辑。
- **GIII（SPAN/GIII 系列）日志格式**：见 §9 第 1 条，缺资料。
- **ProPak6/OEM7 手册 "Logging" 章节**：用于解释 `logStatus`/`portStatus` tile 依赖的
  `2127 FILESTATUS`、`1146 LOGFILESTATUS`、`5 LOGLIST`、`3 INTERFACEMODE`、`72 PORTSTATS`
  （§7.7 表）为什么在回放里是"有无该日志"的等价条件。
- **NovAtel Application Suite 用户手册 Playback 章节**（帮助文本内嵌在
  `01_解包/app/view/js/help.js:3975-3976,7570,9557-9562`）：对"replay 按钮 = 回到文件开头"
  与"rewind 按钮 = 后退 30 s"的描述与 R22/R41 的实现一致，可作为行为预期的交叉验证。

---

## 11. 重实现（`packages/playback`）

只做**引擎**，不做 GUI。原版把文件 I/O、`Timer` 定时器、jQuery 控件与事件面板揉在
`playback.js` 一个对象里；这里把它拆成"一次性建时间线 + 纯逻辑播放 + 范围导出"三件事，
不依赖真实时钟，也不碰 DOM。

| 文件 | 内容 |
|---|---|
| `packages/playback/src/timeline.ts` | `buildTimeline(capture)`：`SbfDeframer({crcMode:'mirror'})` 解帧 → 时间线 |
| `packages/playback/src/playback.ts` | `PlaybackEngine`：播放控制、`tick`、事件、导出方法 |
| `packages/playback/src/export.ts` | 范围选择、原始字节拼接、ASCII 输出 |
| `packages/playback/test/playback.test.ts` | 13 条测试 |
| `packages/cli/src/playback.ts` | `--info` / `--export` / `--export-ascii` |

### 11.1 API

```ts
const engine = new PlaybackEngine({ clock?: () => number, speed?: 1 });
engine.load(capture: Uint8Array): void;      // 解帧、丢弃 crcOk=false、建索引
```

| 成员 | 语义 |
|---|---|
| `duration` / `durationSeconds` | 时间线长度（ms / s） |
| `frameCount` / `frames` | 被接受的帧数与数组（`TimedFrame[]`，文件顺序即时间顺序） |
| `startTime` / `finishTime` | 首帧 / 末帧的**GPS 周内秒** |
| `startWeek` / `finishWeek` | 首/末帧的 GPS 周（跨周时两者不同） |
| `startAbsoluteMs` / `finishAbsoluteMs` | `week * 604800000 + ms` |
| `state` | `'idle' \| 'playing' \| 'paused' \| 'ended'` |
| `play()` / `pause()` | 开始/继续、暂停；`ended` 后 `play()` 从 0 重播 |
| `seek(seconds)` | 钳到 `[0, duration]`；游标落到**第一条 `offset >= 目标`** 的帧 |
| `speed` | `0.5 \| 1 \| 2 \| 4 \| 8`，其它值抛 `RangeError` |
| `tick(deltaMs?)` | 推进时间线并返回本次吐出的帧；省略参数时用注入的 `clock`（首次只建基线） |
| `currentTime` / `currentTimeMs` | 当前位置（s / ms） |
| `on('frame' \| 'ended', handler)` | 返回取消订阅函数；`off(event, handler)` 等价 |
| `info()` | `--info` 用：帧数、时长、周/周内秒、消息分布、丢弃统计 |
| `range(from, to)` | 范围内的帧与字节数 |
| `exportRange(from, to)` | 原始 SBF 字节（帧字节原样拼接，不重算 CRC） |
| `exportAscii(from, to, tables, options?)` | ASCII 文本（`encodeAsciiLog` 直出，CRLF 分隔 + 结尾 CRLF） |

`TimedFrame`：`{ index, frame: SbfFrame, messageId, week, milliseconds, absoluteMs, offsetMs }`；
`frame` 事件：`{ index, frame, messageId, week, milliseconds, offsetMs, time }`。

`tick()` 的语义与验收线一致：`speed = 4` 时 `tick(250)` 推进 `4 × 250 = 1000 ms`；
一次 `tick` 只吐出 `offsetMs <= 新位置` 的帧，按 `offsetMs` 升序（流式，不整包回调）。
`seek` 不改变播放状态，暂停态 `seek` 后 `tick` 只吐落点那一帧（对应原版 R25 的
`sendOnlyOneEpoch`，但不需要专门的开关）。

### 11.2 时间基准

- 帧头 `+14` 周（u16 LE）、`+16` 周内毫秒（u32 LE），与 §5.1 一致；
  绝对时间 `week * 604800000 + milliseconds`。**跨周自然成立**：周字段自己会加 1；
  只有"毫秒回绕而周字段没跟"的坏头才补 `+604800000`（判据：比上一帧早超过半周）。
- `offsetMs` 从**第一条被接受的帧**算起，且**单调不减**：时间戳回跳的记录（`clean-9600.gps`
  里有 8 条 17.35 s 之前的 RAWEPHEM，见 §8 R44）不丢弃，而是钳到前一帧的 `offsetMs`，
  与"同一时间戳的日志成组发出"（§6.2）等价。因此 `duration = 末帧 offsetMs`。
- 不做 18 s UTC 修正（§8 R32）：时间线是相对量，没有 UTC 换算，也就没有原版
  `getNearestLog` 少减 18000 的 seek 偏差（R37）。

### 11.3 与原版 GUI 的差异

| 原版 `controller/playback.js` | 本重实现 |
|---|---|
| `fs.open("r+")` + 819200 B 分块读（R9） | 调用方一次性传 `Uint8Array`，解帧交给 `protocol/framing.ts` |
| 无时间索引，seek 每次线性扫描全文件（R12/R15） | `load()` 建一次索引，`seek` 二分 `lowerBound` |
| **不校验 CRC**（R43），只丢 CRC 字段为 0 | `crcMode:'mirror'` 解帧后再丢 `crcOk=false`（更严格；`broad-clean.gps` 首条 RANGE 因此被丢） |
| 时间戳回跳的记录被静默吞掉（R44） | 保留并钳到前一帧，时间线不倒退 |
| `Timer` + `setTimeout` 真实定时，间隔 `Δt/speed − parseCost − 8`（R17/R18） | `tick(deltaMs)` 或注入 `clock`；`Δtimeline = deltaMs × speed` |
| 倍速 1/2/5/10/20；20x 走按消息限流（R16/R19） | 0.5/1/2/4/8（本任务要求），无按消息限流 |
| 进度条平滑 interval 伪造 `+500 ms`（R20/R21） | 无 |
| 播放结束靠进度条到 100 加 `replay` 类（R39/R40） | `ended` 事件，只发一次 |
| 片段按进度条像素比例找起止字节（R46） | `exportRange(from, to)` 按时间线秒数；两端**闭区间**，与"首条 ≥ 起点、末条同时间戳"一致 |
| GRIT 片段前置两行 `HEADER - NAS GRIT FILE`（R47） | 不写 GRIT 头，只拼帧字节 |
| GUI、事件面板、瀑布图、落地页 tile、语言表 | 不在引擎范围 |

另有两处**刻意不同**的边角：

1. 空文件、纯文本文件、全部 CRC 不匹配的文件都能 `load()` 成功，只是 `frameCount = 0`，
   不像原版抛 `SELECT_VALID_FILE`（判断留给调用方，`info().stats` 里有丢弃计数）。
2. 原版 `RxDetails` 只写一次、GIII 按 OEM 偏移取时间（R5/R36）；这里只有 SBF 长/短头
   两种解析，短头（12 B）没有周以外的端口/序列号字段，时间仍取 `+6/+8`（`header.ts` 的
   `ShortHeader`），不模仿 GIII 的错位读取。

### 11.4 实测

```powershell
node --test --test-force-exit "packages/playback/test/*.test.ts"   # 13 pass / 0 fail
node packages/cli/src/playback.ts 逆向/00_来源/samples/convert/clean-9600.gps --info
```

`--info`（`clean-9600.gps`）：

```
frames   : 119 (dropped 0 bad CRC, 0 text)
start    : week 2442, 463097.350 s of week (2026-10-30 08:37:59 UTC)
finish   : week 2442, 463102.300 s of week (2026-10-30 08:38:04 UTC)
duration : 4.950 s (4950 ms)
messages : 6 distinct
            43  RANGE      x100
            41  RAWEPHEM   x8
            42  BESTPOS    x5
            93  RXSTATUS   x4
            72  PORTSTATS  x1
           963  HWMONITOR  x1
```

`duration = 4950 ms` 是 20 Hz RANGE 从 463097.350 到 463102.300 的真实跨度（100 条 × 50 ms），
与"约 5 s"一致；不等于 5000 是因为末帧到文件结束没有第 101 条。

`--export out.bin --from 1.0 --to 2.5`：36 帧、83596 字节，与该区间原始帧字节之和逐字节相等
（`exportRange` 不重算 CRC，回读后每帧 `crcField != 0` 且 `crcOk`）。同范围
`--export-ascii` 36 行，与 `encodeAsciiLog` 对同一批帧直出的结果完全相同。

`broad-clean.gps`：1721 帧（丢弃 1 条 CRC 不匹配的首帧 RANGE）、时长 69.000 s、12 种消息；
因为首帧被丢，起点是随后的 467940.000 而不是 467920.650。

---

## 11.5 手册第 3 章逐条核对（2026-11-01，GUI 侧）

这一节只谈**页面**（`packages/app/src/web/panels/playback.{js,css}`），引擎见 §11.1-11.4。
手册文本取自 `nova-manual.txt` 第 5436-5640 行（3.1 → 3.2.4），原版 DOM 取自
`01_解包/app/view/html/playback.html`、`playbackcontrol/playbackcontrol.html`、
`playbackcontrol/playbackview.js`、`deviceManagement.js:1208-1260`、`statusbar.js:294-338`、
`positionStatus.js:294-397`、`deviceInfo.js:10-130,376-407`。

### 11.5.1 逐条对照

| 手册条目 | 原版实现（证据） | 本重实现 | 结论 |
|---|---|---|---|
| 3.1 有最近文件就显示文件图标，点图标打开 | `playback.html` `#recent-activity` + `.playback-no-activity-section`；`deviceManagement.js:1208-1260` 生成格子（`.recent-pb-img` 24×24 右上角、文件名、Start/End/Duration、`Last Viewed`）；recents 存 `userSettings.json.app.recentActivity.playback`（`userStore.js:27`） | 落地页 `Recent Activity` + `Open Playback File` + 每份文件一格（图标 = 原版 `new_playbackicon.png`、`Start/End` = UTC 时分秒、`Duration` = `0mins 4secs`、`Last Viewed` = `YYYY-MM-DD HH:MM`）；recents 存 `localStorage["nas.playback.recent"]`，同一文件只留一条、新的在前、上限 12；点了就装载 | **一致**（存储位置不同，见 §20 刻意差异 4） |
| 3.1 没有最近文件时的空态 | `.playback-no-activity-section` + `.no-playback-tiles`（`NO_RECENT_ACTIVITY` = "No recent activity."） | 同样一句居中显示；`✕` 删掉最后一格后回到这句 | 一致 |
| 3.2 装载后整窗换成查看界面 | 打开文件 = 新 tab，落地页让位 | 落地页与查看界面互斥（`empty` / `loaded` 两个块） | 一致 |
| 3.2.1 Files bar 显示所有已装载文件 | `#tabs-list` 里一个文件一个 `<li>`（`jarvisInterface.js:5607 addPlaybackTab`） | 应用栏里一个文件一个 `.pb-filetab`，另加尾部 `+`（见刻意差异 3） | 一致（原版实际只留一个，见下条） |
| 3.2.1 正在看的那个是"黑"的（高亮），点 tab 切换 | jQuery UI `.ui-tabs-active`；`playbackview.js:3-19` "as only 1 playback at a time" | 正在看的那格全白 + 2 px 下划线、其余 62% 白；点一下整块仪表盘重画，**每份文件的播放头/帧表各自保留** | 一致（配色随外壳深青应用栏，刻意差异 5） |
| 3.2.1 ✕ 关掉该文件 | `updatePlaybackSettings` 关掉旧的 PI 页签再开新的 | ✕ 只关自己；关掉当前页签后由右邻（没有则左邻）接管；关完回落地页 | 一致 |
| **但**手册允许同时装载多个 | 实现与之矛盾：`communication.js:625-637 updatePlaybackSettings` 先 `.ui-icon-close` 掉上一个 PI 页签，`playbackview.js:12` 直接写 "as only 1 playback at a time" | 按**手册**实现多文件（2 个 tab 实测并存、切换、单独关闭） | **比原版多**，见刻意差异 3 |
| 3.2.2 状态条三色：Green Good / Amber Warning / Red Error | `.status-bar-traffic` 三个 span 只显示一个（`statusbar.js:335-338`） | 同样的三色徽标（绿 #305703 / 琥珀 #F5A623 / 红 #A00214 + "i" 气泡），Gray `Off` 补上（S:19868 `.grey-status`） | 一致 |
| 3.2.2 有 amber/red 时"看 status tiles"，tile 上也出现同色条 | `statusbar.js:294-338` 汇总各 tile 的 RAG，tile 自己的 `.statustiles-traffic` 同步 | 状态条徽标与对应卡片徽标用**同一个 tone**；点状态条徽标滚到那张卡片并闪一下（`title` 写明缺哪条报文） | 一致（点击联动为我们补充，刻意差异 6） |
| 3.2.2 Position：显示配置的所有定位类型，在用的那一种被框住 | `statusbar.js` `#statusBarConfiguredPosition` + `positionStatus.js:362-397 updateRAGIndicator(configured, active)`；配置类型来自 `SBASCONTROL / INTERFACEMODE / GENERATERTK / NTRIPCONFIG / LOGLIST / AVEPOS`（`positionModes.js:42-86`） | 正在用的类型加框（`Single`）；**配置类型未取证**——18 份抓包里没有上述任何一条配置报文，不编 | 部分（见"未取证"） |
| 3.2.2 Latitude / Longitude / Height | BESTPOS `latitude/longitude/orthometric_height` | 同（7 位小数 / 2 位小数 + m） | 一致 |
| 3.2.2 SPAN | `INSPVAX` / SPAN 状态报文（§4 菜单） | 字段在位，值 `--`，`title` 说明需要 `INSPVAX (#1465)`；18 份抓包都没有 | 部分（缺数据源） |
| 3.2.2 Model | `VERSION` 的 `hardware_version`（`statusbar.js:141`） | `versions[0].hardware_version`：`b1-20261101.sbf` → `OEM729-2.03`；`clean-9600.gps` 无 VERSION → `--` | 一致 |
| 3.2.2 CPU Usage | HWMONITOR `idleTime`（`100 − raw/2`） | 二进制 HWMONITOR 无该字段 → `--` + 说明（§13.2 已有结论，未变） | 部分（缺数据源） |
| 3.2.2 Logging | LOGSTATUS / LOGLIST(#5) | `--` + 说明；抓包里没有 | 部分（缺数据源） |
| 3.2.2 Time | TIME(#101) 的 UTC | 播放头所在帧的 UTC（`startUtc + offset`），随拖动/播放走 | 一致（取法不同） |
| 3.2.2 Storage Usage | FILESYSTEMCAPACITY(#2137) `usedStorage/totalStorage` | `--` + 说明；抓包里没有 | 部分（缺数据源） |
| 3.2.2 Interference | ITDETECTSTATUS(#2065)：`itkState` = Detected / Not detected / Disabled | `interference_statuses[i].severity1/2` 全 0 → "Not detected"，任一非 0 → "Detected"；`b1` 实测 "Not detected"；无该报文 → `--` | 一致 |
| 3.2.3 tiles 随播放头变化 | 每个 epoch 由 `parseBinaryLog` 推进 | 拖动/播放都重取当前帧所在 RANGE 纪元，星座计数与 Time 同步 | 一致 |
| 3.2.3 每块 tile 一条颜色码（绿/琥珀/红/灰 Off） | `.statustiles-traffic` 同三色 + `grey-status` | Positioning / Device / Satellite View 三张卡都有徽标，tone 与状态条同源；`Off` = 该块完全无数据源 | 一致 |
| 3.2.4 播放按钮开始回放，状态条/tile/进度条/Date-Time 一起动 | `.playControl` + `Timer` | `pb-play` + `requestAnimationFrame`，Δ时间 = Δt × speed；拖动、播放、后退都会刷新整块仪表盘 | 一致 |
| 3.2.4 Speed 下拉改倍速 | `playbackcontrol.html:79-83` 的 `1x/2x/5x/10x/20x`，`playbackview.js:116` `parseInt` | `1x/2x/5x/10x/20x`（`PLAYBACK_SPEEDS`），`/api/playback/info` 报的 0.5/1/2/4/8 页面**不用** | 一致（引擎档位未动，见刻意差异 7） |
| 3.2.4 暂停 | 同一个按钮切 `pause` 类 | 同一个按钮切播放/暂停（`is-playing`） | 一致 |
| 3.2.4 后退 30 秒 | `playbackview.js:435 rewind(30*1000)` | `REWIND_SECONDS = 30`，钳到 0 | 一致 |
| 3.2.4 重放整个文件 | 到末尾后 `.playControl.replay` | 到末尾后同一按钮变环形箭头、`aria-label="Replay"`，再点从 0 播 | 一致 |
| 3.2.4 进度条 = 当前点 | `.progress-bar` + `#playbackprogressBlue` | 进度条 + 拖动手柄（鼠标拖、←/→ 0.1 s、Shift 1 s、Home/End、空格） | 一致（键盘步进为我们补充） |
| 3.2.4 事件点（红/琥珀/白）与 Show Events 开关、点击弹事件详情 | `.playback-events` + `.show-events-toggle` + `#btn-event` 气泡，事件来自 `markEvents()`，即 `events.js` 的事件引擎 | **已实现**（D1，详见 §11.5.6）：标记位置/颜色/`data-message`/`data-event-freq`/点击只开气泡不动播放头，逐条照原版；事件源换成抓包里真实存在的记录（`ITDETECTSTATUS` #2065 频谱检测为主） | 一致（**事件源不同**：18 份抓包没有原版那类事件日志，见 §11.5.6） |
| 3.2.4 Create Snippet / Save Snippet | 琥珀选框 + 拖两端 + `onCreateSnippet/onSaveSnippet` | 进度条上的琥珀区间（由 From/To 秒数驱动）+ `Create Snippet`/`Download SBF` 直接导出 | 部分（交互不同，刻意差异 8） |

### 11.5.2 倍速两列

| 原版（`playbackcontrol.html:79-83`） | 本页（实测 `#pb-speed` 的 option） | `/api/playback/info.speeds`（引擎） |
|---|---|---|
| 1x | 1 | 0.5 |
| 2x | 2 | 1 |
| 5x | 5 | 2 |
| 10x | 10 | 4 |
| 20x | 20 | 8 |

页面只认左、中两列；第三列是 `packages/playback` 的档位（`PLAYBACK_SPEEDS`），本次按边界**没有动**，
页面也不读它 —— 否则菜单里会出现原版没有的 0.5x/4x/8x。

### 11.5.3 三色判定（照原版代码，不照截图）

```
Positioning  positionStatus.js:294-397
  红  solution_status ∈ {INSUFFICIENT_OBS, NO_CONVERGENCE, INVALID_FIX, INTEGRITY_WARNING}
  琥珀 配了 PSRDIFF 而在用 single / 配了 RTK 而在用 dgnss 且也配了 RTK /
       最高精度模式（RTK→PPP→PSRDIFF→SBAS）不是当前模式 / 在 RTK 但解是 WIDE_INT·PSRDIFF·NARROW_FLOAT
  绿  其余
Device       deviceInfo.js:10-130, 376-407
  红  任一通道落在 error 边界（HWMONITOR status & 0xff ∈ {2,4}）；CPU/Storage > 90
  琥珀任一通道落在 warning 边界（∈ {1,3}）；CPU/Storage ∈ (80,90]；**或状态条里还有字段没取到**
  绿  取到的通道全在允许范围
  灰 Off  一个读数都没有
```

"缺字段 → 琥珀"这一条是我们加的判据：手册把琥珀定义为"功能正常但有需要注意的地方"，把
`--`（这条抓包里没有该报文）涂成绿等于宣布"全部正常"，把绿灯当结论用。`clean-9600.gps`
因此是 `Device Warning`，`b1-20261101.sbf` 也是 Warning（CPU/Logging/Storage/SPAN 仍缺），
两者的 `title` 会逐条列出缺哪条报文。

### 11.5.4 实测（2026-11-01，Playwright，1706×1066）

```
[0] 落地        1 格（clean-9600.gps · Start 08:38:17 · End 08:38:22 · Duration 0mins 4secs · Last Viewed 2026-11-01 09:49）
[1] 点格子装载  Positioning Good · Device Warning · Position[Single] · SPAN -- · 23 tracked PRNs
[2] 再开一份    tabs=[clean-9600.gps, b1-20261101.sbf*] · Model OEM729-2.03 · Interference Not detected
                SATVIS2 (#1043) 在本抓包里（24 条），故提示语不再说"本抓包没有 SATVIS2"
[3] 切回第一格  tabs=[clean-9600.gps*, b1-20261101.sbf] · Model -- · 纬度回到 30.5399749°
[4] 关掉当前格  剩 1 个 tab，b1 自动接管（Model OEM729-2.03）
[5] 倍速/播放   1x 2x 5x 10x 20x；10x 播放 0.9 s → 时钟 +9.0 s；暂停止住；后退 30 s → 0:00.000
                ←/→ 每次 0.1 s；End → 0:28.079，按钮 aria-label="Replay"
[6] 状态条联动  点 Device 琥珀条 → Device 卡 is-flash，title 列出 4 个缺失数据源
[7] 关完回落地  2 格（b1 在前、clean 在后，各带 Last Viewed）
console / pageerror / 非 2xx：0
```

截图：`%USERPROFILE%\AppData\Local\Temp\opencode\agent-playback\`（`00-recent-activity.png`、
`01-files-bar-summary.png`、`02-open-dialog.png`、`03-two-files.png`、`04-switched-back.png`、
`05-after-close.png`、`06-dock-open.png`、`07-controls-ended.png`、`08-band-link.png`、
`09-recent-two-tiles.png`）。

测试：`packages/app/test/playback-parity.test.ts` 26 条（最近文件 / 多文件页签 / 倍速档位 /
三色判定 / 抓包侧事实）。全量 `packages/*/test/*.test.ts` 见 §12 的说明。

### 11.5.5 未取证 / 缺

| 项 | 为什么 |
|---|---|
| Position 里"配置的所有定位类型 + 当前模式加框"的**配置**部分 | 配置类型来自 `SBASCONTROL / INTERFACEMODE / GENERATERTK / NTRIPCONFIG / LOGLIST / AVEPOS`；`samples/` 18 份抓包一条都没有。只把"正在用"的类型加框，不猜 |
| SPAN 值 | 需要 `INSPVAX (#1465)`，抓包里没有 |
| Storage Usage | 需要 `FILESYSTEMCAPACITY (#2137)`，抓包里没有 |
| Logging | 需要 LOGSTATUS / `LOGLIST (#5)`，抓包里没有 |
| 事件点 / Show Events / 事件气泡 | 原版的事件来自 RXSTATUSEVENTB 一类事件日志，18 份抓包一条都没有。D1 改成由抓包里真实存在的记录驱动（`ITDETECTSTATUS` #2065 的频谱检测 / `RXSTATUS` spoofing / `RXSTATUSEVENT` 的两句），**没有原版事件日志样本，行为按代码实现**，见 §11.5.6 |
| Missing（卫星） | `b1` 有 SATVIS2（可见卫星的方位/高度），但"应当可见却没跟踪"的判据在手册与原版代码里没有可引用的定义，不做推测 |

---

## 11.5.6 事件条（D1，2026-11-02）

### 原版语义（量出来的，不是猜的）

| 项 | 出处 | 内容 |
|---|---|---|
| 带子的位置 | `playbackcontrol.html:23` | `.playback-events` 是进度条**下面一条独立的带子**（`display:flex; position:relative`），不画在进度条上 |
| 一个事件一个元素 | `controller/playback.js:991-1071` `markEvents()` | `div`，`id="btn-event"`，`className = state + "Event"` |
| 四个字段 | `:1019-1031` | `data-message` = `data-lang-…` 描述键；`data-event-freq` = 频率（**只有** ITK 事件带）；`time` = `HH:MM:SS UTC`（`:1031` → `getUTCTimeFormatOnly`，`controller/playback.js:608-613`）；`data-event-count` = 序号 |
| 位置 | `:1024-1029` | `per = (Date.parse(start) - Date.parse(startTime)) / totalPlaybackTimeMsec`，`left = calc(per*100% - 17px)` → **标记以事件时间为中心**；`per < 0` 的**不 append**（不是钳到 0） |
| 画哪些 | `:1013` | 只画 `state != "Good" && alive`；带子是 append-only（`:1032`），事件结束后标记留在原处 |
| 事件对象 | `view/events/events.js:1736-1748` | `{startTime, state, alive, description, actualStr, endTime, freqValue}` —— 最小字段就是「时间 + 描述键 + 频率(可空) + 状态」 |
| 颜色 | S:5288-5296 / 5358-5370 | 16.67 px 圆点；`PoorEvent` 红 `#D0021B`；`ModerateEvent` 琥珀警告图标；`GoodEvent` 白（原版从不画） |
| 点击 | `playbackview.js:194-253` | **只开/关气泡**：气泡左右夹取（`:204-218`），正文 = `time.replace("UTC","") + __(message).replace("%1", freq)`（`:244-245`）；再点同一个收起（`:198-203`、`:326-331`），点别处 / 关闭按钮也收起（`:268-271`、`:332-341`）。**全程没有 `onProgressbarSeek` / `updateTimeOnMove`——播放头不动** |
| `Show Events` | `playbackcontrol.html:91-97`，`playbackview.js:122-135` | 只切 `.playback-events` 的 `display` flex/none 与 `#btn-event` 显隐；默认 `true`（`deviceManagement.js:188-193`） |

### 本重实现的事件源（都是抓包里的记录，没有一条是编的）

`packages/app/src/playback.ts#playbackEvents` 把这些记录按接收机时间跑一遍和 `events.js` 一样的状态机：
**某频率/某状态第一次出现 → 开一个事件；下一条不再报 → 闭合 `endTime`；同一频率之后再出现 → 新事件**
（对应 `createEventInHandlerObject` 的 alive/false 两支，`events.js:1719-1734`）。

| 源 | 报文 | 规则 | 级别 |
|---|---|---|---|
| ITK 干扰 | `ITDETECTSTATUS` (#2065)，**文本 `ITDETECTSTATUSA` 与二进制都读** | `view/src/config/events.ts#itkDetections`：只有 `SPECTRUMANALYSIS` 算检测（`STATISTICANALYSIS` 的 `parameter1` 是 5-8 的统计量，不是频率） | `Moderate`，`data-lang-itk-detected-at` |
| Spoofing | `RXSTATUS` (#93) `spoofing == DETECTED`（`events.js:1536-1560`） | 实现完整，但**本批抓包解不出 `spoofing`**（layout 只有 `rx_error` / `status_words`）→ 永远空 | `Poor` |
| `RXSTATUSEVENT` | #94 | 只收原版认的两句：`MODEL INVALID FOR THIS RECEIVER` / `INVALID AUTHORIZATION CODE`（`events.js:727-790`） | `Poor` |

> b7 的 ITK 日志是**文本**（47 条 `#ITDETECTSTATUSA`，0 条二进制 #2065），而时间轴引擎只吃 SBF
> （`timeline.ts` 把文本记录计入 `textFrames` 后跳过）。只读 `engine.frames` 会得到 0 条事件——
> 这就是 §11.5 早先"18 份抓包一条事件都没有"的出处。文本记录自带 `week` / 毫秒，取时间不必靠邻居帧。

### b7 实测（`live-20261031/b7-20261101.sbf`）

47 条 ITDETECTSTATUS（25 STATISTICANALYSIS / 13 SPECTRUMANALYSIS / 9 空）、26 条 RXSTATUS、0 条 #94：

| # | 频率 | 起点（秒） | UTC | 结束 |
|---|---|---|---|---|
| 1 | 1270 MHz | 18.697 | 09:59:21 | 24.697 |
| 2 | 1269 MHz | 24.697 | 09:59:27 | 30.697 |
| 3 | 1270 MHz | 59.697 | 10:00:02 | 抓包结束仍在报（`endTime = null`） |

`/api/playback/events?capture=live-20261031/b7-20261101.sbf` → `count: 3`；
`live-20261031/b1-20261101.sbf`（6 条 #2065，全是 STATISTICANALYSIS）与 `convert/clean-9600.gps` → `count: 0`。

### 页面

- 标记是 `<button>`（可 Tab / Enter），红=Poor、琥珀=Moderate，`left = time / duration`；
- 悬停预览气泡，点击钉住（再点同一个 / 点关闭 / Esc 收起）；**点击不 seek**，
  进度条的 `mousedown` 对 `[data-role="event-marker"]` 直接放行（否则会顺带跳播放头）；
- `Show Events` 开关存 `localStorage["nas.playback.showEvents"]`，默认开；
- 没事件时不是空白：一行说明「读了多少条记录、都不到 Good」，或者「这三条日志一条都没有」。

### 实测 / 截图

```
[1] b7：3 个标记（30.295% / 40.017% / 96.727%），点中间那个 → 气泡
    "09:59:27 Interference is being detected at 1269Mhz."
    "ITDETECTSTATUS (#2065) · 0:24.697 → 0:30.697"，时钟仍 0:00.000（没 seek）
[2] 再点同一个 → 气泡收起；点第 3 个 → 换成 10:00:02 那条；关闭按钮 / Esc 都能收
[3] Show Events 关 → 带子 hidden，localStorage 写 "false"；打开 → 标记回来
[4] b1 → 空态 "No events in this capture — 11 event records read, none above Good."
console / pageerror：0
```

截图：`%USERPROFILE%\AppData\Local\Temp\opencode\agent-playback-events\`
（`d1-b7-tooltip.png` 整页、`d1-b7-strip-tooltip.png` 局部、`d1-b7-strip.png`、
`d1-b7-strip-closeup.png`、`d1-b1-empty.png`、`d1-b1-empty-strip.png`）。

测试：`packages/app/test/playback-events.test.ts` 12 条（b7 的 3 条事件与时间去重 / 频率不是带宽枚举 /
b1 与 clean 的空态 / 标记数量与百分比 / tooltip 文案 / 点击只选中不 seek / Show Events 持久化 / 路由）。

### 没做到 / 与原版不同

| 项 | 说明 |
|---|---|
| **无原版样本** | 18 份抓包没有一条 `RXSTATUSEVENT`，也解不出 `spoofing`；红点（Poor）与白点（Good，原版本来就不画）都没有截屏可对。**行为按代码实现** |
| 画的是整份抓包的事件 | 原版 `markEvents()` 在**装载时**跑一次（`controller/playback.js:869` 在 `updateStartEndTime` 里），当时还活着的事件才画。我们把整份抓包的事件起点都画出来，等价于原版把整份播完后带子累积的结果 |
| 气泡定位 | 原版按 1912 px 窗口算（`playbackview.js:204-218`），我们用 `position:fixed` + 视口夹取；文本、颜色、开合逻辑一致 |
| 活塞（snippet）与事件条并存 | 原版开 snippet 时会把 `.show-events` 藏起来（`playbackview.js:98-99`）；本页没做这个互斥 |
