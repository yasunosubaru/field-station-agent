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
