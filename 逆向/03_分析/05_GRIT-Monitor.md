# GRIT Monitor（干扰监测 / 频谱 / 地图）

覆盖范围：`01_解包/app/view/GRIT/` 全部 202 个文件（4,205,739 字节）＋入口
`01_解包/app/view/GRIT/gritJarvisInterface.js`。行号均为 `01_解包/` 下解包产物原始行号。

**本次实际读过的文件**（逐个）：`gritJarvisInterface.js`、`js/spectrumPlot.js`、
`spectrumViewer/spectrumViewer.{js,html}`、`signalMatrix/signalMatrix.{js,html}`、
`mitigationAssistant/mitigationAssistant.{js,html}`、`spoofingConfiguration/*`、
`addFilterPopup/addFilterPopup.js`、`gritEvents/gritEvents.{js,html}`、
`gritStatusBar/gritStatusBar.{js,html}`、`gritMenuBar/gritMenuBar.{js,html}`、
`livePlayback/livePlayback.js`（前 400 行 + 755-814）、`mapSettings/mapSettings.js`、
`displaysSettings/displaysSettings.js`（及其 `luciad/` 版）、`pointsOfInterest/pointsOfInterest.js`、
`pointsOfInterest/listView.js`（局部：1-560 / 1632-1751）、`triggers/triggers.js`、
`mapLayer.js`（局部）、`js/gritLandingPage.js`（局部）、`js/luciad/gritLandingPage.js`（局部）、
`luciadPositionOverview/luciadMapLayer.js`（局部）、`luciadPositionOverview/luciadMapViewMapLayer.js`（前 120 行）、
`luciadPositionOverview/luciadPositionOverview.js`（局部）、`luciadPositionOverview/src/license-loader.js`、
`src/luciadria_deployment.txt`、`helpFile/helpFile.{js,html}`（及 `noMapHelpFile.html`）、
`networkingSettings/*`、`spoofing/*`（0 字节）。
**未逐行读**：`helpFile/*.html` 正文（只按章节提取功能清单）、`styles/gritStyles.css`（224 KB 纯样式）、
`styles/images/**`（149 个图片）、`positionOverview/positionOverview.js`（2879 行，只做导出面与关键调用点对照）、
`positionOverview/addPOIDialog.js`、`luciadPositionOverview/addPOIDialog.js`（局部）、`renderer.js`、
`ShapePainter.js`、各 `Custom*Controller.js`、`liveplaybackview.js`、`markerCustomPopup.js`、
`positionOverview/positionOverview.html`、`luciadPositionOverview/luciadPositionOverview.html`。

依赖但**不属于**本子系统、只在需要时引用的：`app/jarvisInterface.js`、`app/model/logparsers.js`、
`app/model/NovatelIdConstants.js`、`app/model/featuresList.js`、`app/model/serverModel.js`、
`app/model/common.js`、`app/model/gritConstellation.js`、`app/model/userStore.js`、
`app/controller/communication.js`、`app/view/html/index.html`、`app/view/html/setUpMonitor.html`。

---

## 1. 职责

GRIT Monitor 是 NovAtel Application Suite 里与 **Manage（SM）/ Playback / Convert** 并列的第二种
"应用视图"（`currentActiveApp == "GRIT"`）。同一台接收机在 GRIT 里对应**另一个 tab**
（`grit-<原tab>`，见 §2.4），它与 SM tab 共用连接、共用解析结果，但这个 tab 不做配置管理，
只做**干扰监测**：

1. 采集与干扰相关的私有日志（`ITDETECTSTATUS`、`ITPSDFINAL`、`ITPSDDETECT`、`ITFILTTABLE`、
   `ITPROGFILTBANK`、`ITBANDPASSBANK`、`ITSPECTRALANALYSIS`、`ITFRONTENDMODE`、`CHANCONFIGLIST`、
   `LBANDTRACKSTAT`）以及状态日志（`RXSTATUS`、`HWSTATUS`、`TRACKSTAT`、`BESTPOS` …）；
2. 把它们画成三块：**摘要/状态栏**（`gritStatusBar`）、**频谱图**（`spectrumViewer` + `spectrumPlot`）、
   **信号矩阵**（`signalMatrix`）；
3. 做**判定与建议**：`mitigationAssistant`（干扰/压制/欺骗事件卡 + "Add filter" 入口）、
   `spoofingConfiguration`（欺骗检测标定与开关）；
4. 做**地理呈现**：`positionOverview`（旧版，Google Maps）或 `luciadPositionOverview`（LuCIAD RIA），
   加上 `pointsOfInterest`（POI 增删改查 + KML 导出）与 `triggers`（MARKxPOS/PVA 事件落点）；
5. 做**事件**：`gritEvents`（当前/历史事件、通知横幅、10 分钟时间轴）；
6. 做**回放**：`livePlayback`（把最近 10 分钟原始字节写成 `<tab>_historyFile.GPS`，可回拖、可录成
   `.gps` 播放文件）。

`[观察] 01_解包/app/view/GRIT/gritJarvisInterface.js:1-1642`（整体 IIFE 就是 GRIT 的"门面"）。

**目录清单与用途**

| 目录/文件 | 文件数 | 角色 |
|---|---|---|
| `gritJarvisInterface.js` | 1（77,537 B / 1644 行） | GRIT 与主程序之间的唯一门面：日志注册表、连接就绪、报文分发、缓存、语言、深色模式 |
| `gritStatusBar/` | 2 | 摘要状态栏 + RAG 灯 + "为什么是红色/黄色"对话框 |
| `gritEvents/` | 2 | 当前/历史事件、通知、时间轴标记 |
| `gritMenuBar/` | 2 | 左侧菜单（Dashboard/Configuration/Settings/Tools/Help）+ 事件铃铛 |
| `spectrumViewer/` | 2 | 频谱窗口外壳、频谱/瀑布切换、高级设置、滤波器侧栏 |
| `js/spectrumPlot.js` | 1（3343 行） | Plotly 绘图内核：频段/通道标注、干扰线、滤波器形状、瀑布、3D |
| `signalMatrix/` | 2 | C/N0 矩阵 |
| `mitigationAssistant/` | 2 | 干扰/压制/欺骗事件卡与建议动作 |
| `addFilterPopup/` | 1 | 加/改滤波器对话框（notch / band-pass） |
| `spoofingConfiguration/` | 2 | 欺骗检测标定（SKKALIBRATE）与开关（SKDETECTCONFIG） |
| `pointsOfInterest/` | 4（含 `luciad/`） | POI 列表/地图视图、KML 导出 |
| `positionOverview/` | 3 | 旧版地图瓦片（Google Maps） |
| `luciadPositionOverview/` | 15（含 `src/`） | LuCIAD RIA 版地图瓦片、图层、控制器、许可加载 |
| `triggers/` | 3（含 `luciad/`） | MARK 事件触发点配置 |
| `displaysSettings/` | 3（含 `luciad/`） | 地图显示设置（车标、历史轨迹、朝向…） |
| `mapSettings/` | 1 | Map 设置的三个子页签容器 |
| `js/gritLandingPage.js`、`html/` | 4（含 `luciad/`） | GRIT 着陆页（设备 tile 网格 / 地图视图） |
| `livePlayback/` | 3 | 10 分钟历史缓冲、回拖、录制 |
| `networkingSettings/` | 2 | **空壳**（3 行 html + 11 行 js），真实现在 `app/view/networkingSettings/` |
| `spoofing/` | 2 | **0 字节占位文件**，无任何引用 |
| `helpFile/` | 4 | 内嵌帮助（`helpFile.html` 680 KB / `noMapHelpFile.html` 638 KB） |
| `styles/` | 149 | CSS 与全部图标 |

`[观察] 01_解包/app/view/GRIT/spoofing/spoofing.js:1`、`spoofing/spoofing.html:1` 均为 0 字节；
`networkingSettings/networkingSettings.html:1-3` 只有标题占位。

---

## 2. 入口与加载顺序

### 2.1 应用级开关：`NovatelIdConstants.gritSupported`

GRIT 整套代码是否加载，只取决于一个文件系统判断：

```js
if (fs.existsSync(appRoot.path + '/view/GRIT')) {
    NovatelIdConstants.gritSupported = true;
    ...逐个 append <script>...
} else {
    NovatelIdConstants.gritSupported = false;
    $(".rx-suite-options #grit-welcome").css("display","none");
    $(".app-menu #home-grit").css("display","none");
}
```
`[观察] 01_解包/app/view/html/index.html:1126-1176`。默认值 `false`
`[观察] 01_解包/app/model/NovatelIdConstants.js:60`。

加载的脚本顺序（`[观察] index.html:1128-1146`）：
`gritStyles.css` → `js/spectrumPlot.js` → `gritJarvisInterface.js` → `gritMenuBar` →
`gritStatusBar` → `gritEvents` → `mitigationAssistant` → `spectrumViewer` → `signalMatrix` →
`spoofingConfiguration` → `livePlayback` → `addFilterPopup` → `liveplaybackview` →
`helpFile` → `model/gritConstellation.js` → `js/deviceInfo.js` → `js/spanStatus.js` →
`mapSettings`。

### 2.2 两套并存实现（LuCIAD 与旧版）的开关

开关只有一处：`serverModel.isLuciadAvailableNow(callback)`，判据是
`serverConnect.getMapConfigObj().mapType` 字符串是否等于 `"luciad"`（大小写不敏感）
`[观察] 01_解包/app/model/serverModel.js:20-24`、`serverModel.js:25-45`。

- 配置对象未就绪时它会**最多重试 20 次、每次间隔 100 ms**，仍失败回调 `false`
  `[观察] serverModel.js:68-87`；
- 回调里还顺带做一次 `navigator.gpu.requestAdapter()` 探测，无适配器则 2 s 后弹
  `LUCIAD_GRAPHICS_WARNING_TITLE` 警告框 `[观察] serverModel.js:36-43, 46-67`；
- `index.html` 里另有一个同名 `isLuciadAvailable` 变量，**硬编码 `return false`**，
  是死代码 `[观察] index.html:1066-1070`。

`true` 分支加载（`[观察] index.html:1147-1158`）：
`triggers/luciad/triggers.js`、`js/luciad/gritLandingPage.js`、`pointsOfInterest/luciad/pointsOfInterest.js`、
`pointsOfInterest/luciad/listView.js`、`displaysSettings/luciad/displaysSettings.js`、
`luciadPositionOverview/src/license-loader.js`（module）、`luciadMapLayer.js`（module）、
`luciadMapViewMapLayer.js`（module）、`luciadPositionOverview.js`、`addPOIDialog.js`。

`false` 分支加载（`[观察] index.html:1159-1167`）：
`js/gritLandingPage.js`、`triggers/triggers.js`、`pointsOfInterest/pointsOfInterest.js`、
`pointsOfInterest/listView.js`、`displaysSettings/displaysSettings.js`、
`positionOverview/positionOverview.js`、`positionOverview/addPOIDialog.js`。

**哪些页面用了哪一套**（逐条）

| 功能 | LuCIAD 版文件 | 旧版文件 | 选谁 |
|---|---|---|---|
| 着陆页地图视图 | `js/luciad/gritLandingPage.js` + `html/luciad/gritLandingPage.html` + `luciadMapViewMapLayer.js` | `js/gritLandingPage.js` + `html/gritLandingPage.html` + `mapLayer.js` | 由 `setUpMonitor.html` 拼 `luciadPath` 决定 `[观察] setUpMonitor.html:239-242` |
| 位置总览瓦片 | `luciadPositionOverview/` | `positionOverview/` | `serverModel.isLuciadAvailable()` `[观察] gritJarvisInterface.js:698-723` |
| POI 设置页 | `pointsOfInterest/luciad/{pointsOfInterest,listView}.js` + `luciad/pointsOfInterest.html` | `pointsOfInterest/{pointsOfInterest,listView}.js` + `pointsOfInterest.html` | `createComponent` 里对 `pointsOfInterest` 特判 `[观察] jarvisInterface.js:4792-4794` |
| Triggers 设置页 | `triggers/luciad/triggers.js`（**共用** `triggers/triggers.html`） | `triggers/triggers.js` | 脚本层二选一 |
| Display 设置页 | `displaysSettings/luciad/displaysSettings.js`（**共用** `displaysSettings.html`） | `displaysSettings/displaysSettings.js` | 脚本层二选一 |
| 频谱 / 矩阵 / 事件 / 状态栏 / 菜单 / 回放 | 无第二套 | 同左 | 单一实现 |

两套的**实质差异只有"调用哪个 positionOverview"**：
`Compare-Object triggers/triggers.js triggers/luciad/triggers.js` 只有 2 行不同
（`positionOverview.onPOIchanged` ↔ `luciadPositionOverview.onPOIchanged`）；
`displaysSettings/luciad/displaysSettings.js` 也只有 `positionOverview.setDisplaysConfiguration`
改成 `luciadPositionOverview.setDisplaysConfiguration` `[观察] 01_解包/app/view/GRIT/displaysSettings/luciad/displaysSettings.js:315-316`。
`pointsOfInterest/luciad/listView.js` 差异较大（616 行差异），因为画圆/画点走
`luciadMapLayer.*` 而不是 `mapLayer.*` `[观察] 01_解包/app/view/GRIT/pointsOfInterest/luciad/listView.js` 全文对比。

### 2.3 着陆页与地图 SDK 的加载

`setUpMonitor.html` 在 `document.ready` 里按 LuCIAD 与否拼路径加载着陆页，再从
`Edie/{windows,linux}/configurationfile.node` 取 Google Maps 的 **secret key**，
用 `$.getScript('https://maps.googleapis.com/maps/api/js?key=<key>&v=3.56')` 注入
`[观察] 01_解包/app/view/html/setUpMonitor.html:238-267`。注释里保留了 dev/weekly 分支但
`IsDev` 被写死 `'F'` `[观察] setUpMonitor.html:252-253`。

也就是说，**两条路线都会加载 Google Maps JS API**（着陆页那份 `setUpMonitor.html` 的
`$.getScript` 不在任何分支里），差别只在 LuCIAD 路线用 `createGoogleMapsSession` 把 Google
的会话转成 LuCIAD 的瓦片模型 `[观察] luciadMapLayer.js:297-323`；而旧版地图、POI 地图视图、
位置总览、加 POI 对话框全部直接 `new google.maps.Map`
`[观察] 01_解包/app/view/GRIT/mapLayer.js:8-15`。
Google 的 `mapId` 取决于主题：亮色 `90f87356969d889c`、暗色 `6c30dd467245eec9`
`[观察] 01_解包/app/model/common.js:4-5, 115-117`。

### 2.4 从设备磁贴进入 GRIT：tab 命名与时序

1. 在 GRIT 着陆页点设备磁贴开关 → 走 `onConnectToggleClick`；若 `featuresList.gritFirmwareCheck(tab)`
   为真 → `jarvisInterface.gritFirmwareNotSupport(tab, false)`（弹 `NOT_SUPPORTED_GRIT_FIRMWARE`）
   `[观察] setUpMonitor.html:727-733`、`jarvisInterface.js:3288-3298`；
2. 复制 tab：`newId = tab.startsWith("grit") ? tab.replace("grit-","") : "grit-" + tab`
   `[观察] setUpMonitor.html:742-747`（tab 名形如 `grit-tabs-2`）；
3. 版本日志到达时做机型/固件双重门禁（见 §3.4），通过后 `connectionReady[tab]=true`，
   随后 `tab.startsWith("grit")` → `gritJarvisInterface.checkGritConnectionReady(tab)`
   `[观察] jarvisInterface.js:2887-2890`、`jarvisInterface.js:3844-3852`。

`checkGritConnectionReady` 的时序（`[观察] gritJarvisInterface.js:626-763`）：

| 时刻 | 动作 |
|---|---|
| 同步 | `rxStatusEventData[tab]={}`；发 `log thisport rxstatuseventb once`、`log thisport versionb once`；建 `gritMenuBar`、菜单容器、`createTile(tab,0)` → `gritStatusBar`；建 `gritEvents`；`delayEventsNotifications`；20 ms 后恢复事件侧栏持久化 |
| 同步 | `loadMapComponents(tab)`（triggers / POI / displays 三块设置页） |
| 同步 | index=1 起依次建：`mitigationAssistant`、`spectrumViewer`（100 ms 后插入 Plotly 容器并 `resetSpectrumViewer` + `gritCompReqlogs(["gritLandingPage"])`）、`signalMatrix`、LuCIAD **或** 旧版位置总览、`deviceInfo`、`spanStatus`（仅 SPAN 支持） |
| 200 ms | `.complete-panel` 显示；无欺骗支持则隐藏 `#menuConfig` |
| 500 ms | 仅 LuCIAD：`luciadPositionOverview.loadMap(tab)`（`handleTabAfterLoadingHtml` 里的 `setTimeout`） |
| 1500 ms | 非回放时 `gritEvents.updateEventsOntoUI` + `setEventNotificationFlag`；`checkForInvalidModelAndAuth` |
| 末尾 | `applyUserLanguagePreference` |

Playback 类型的 tab 额外：`createPlaybackComponent(tab)`，并在缺少 `CHANCONFIGLIST` 时调
`spectrumPlot.getHighestChanconfigList(tab)` / `signalMatrix.createSignalMatrixUI({tab},tab)`
`[观察] gritJarvisInterface.js:646-696`。

---

## 3. 数据结构（逐字段：名称 / 类型 / 单位 / 来源）

### 3.1 `gritCompRegister`：每个组件订阅哪些 messageId、要哪些字段

`gritJarvisInterface.js:6-156`。键是大写 messageId 字符串，值是以逗号分隔的字段名列表；
字段列表为 `""` 表示"整条日志都要"。GRIT 用到的全部 messageId 由
`gritLogsCheck()` 去重汇总成 `gritLogs`，`gritlogProcess` 第一件事就是
`if(gritLogs.indexOf(msgID) < 0) return;` `[观察] gritJarvisInterface.js:340-357, 866-868`。

本子系统关心的 messageId（`[观察] 01_解包/app/model/NovatelIdConstants.js:448-...` 对应行）：

| ID | 名称 | 单位/说明 |
|---|---|---|
| 3 | `INTERFACEMODE` | 端口/收发格式 |
| 5 | `LOGLIST` | `noOfLogs,port,message,messageType,trigger,period,offset` |
| 37 | `VERSION` | 机型/固件/PSN（含 component 明细） |
| 42 | `BESTPOS` | 纬度/经度（deg）、高度（m）、`satellitesTracked/Used`、`solutionStatus`、`positionType` |
| 72 | `PORTSTATS` | `port,rxChars,txChars` |
| 83 | `TRACKSTAT` | 通道级 `cno`（dB-Hz）、`channelTrackingStatus`、`rejectcode` |
| 93 | `RXSTATUS` | 位域：bit9 欺骗、bit15 压制、bit25（`aux3status25bit`）标定状态、bit3 电源 |
| 94 | `RXSTATUSEVENT` | `word,bitPosition,event,description` |
| 99 | `BESTVEL` | `horSpeed,trkGround` |
| 101 | `TIME` | UTC h/m/s |
| 172 | `AVEPOS` | 平均位置状态 `posaveStatus` |
| 379 | `INSCOMMAND` | `switch`（ENABLE/RESET/RESTART/…） |
| 652 | `SBASCONTROL` | 位置模式来源之一 |
| 963 | `HWMONITOR` | 温度、各路电压、天线电压/电流、`idleTime`(→CPU 占用 %) |
| 1043 | `SATVIS2` | 可见卫星 |
| 1146 | `LOGFILESTATUS` | OEM6 用 |
| 1148 | `CHANCONFIGLIST` | `numChans,signalType` |
| 1194 | `BESTSATS` | 参与解算的卫星 |
| 1201 | `LBANDTRACKSTAT` | `data[]`：`name,frequency,C/No,trackingState` |
| 1249 | `NTRIPCONFIG` | 位置模式来源 |
| 1260 | `GENERATERTKCORRECTIONS` | 位置模式来源 |
| 1335 | `HEADING2` | `heading`（deg） |
| 1428 | `CONNECTIMU` | `IMUPort,IMUType` |
| 1459 | `INSPOSX` | INS 位置标准差 |
| 1465 | `INSPVAX` | `posType,northVelocity,roll,pitch,azimuth,…,latDev,longDev,heightDev` |
| 1733 | `ASSIGNLBANDBEAM` | `option,name,frequency,baudRate,dopplerWindow` |
| 1967 | `ITSPECTRALANALYSIS` | `mode,frequency,updatePeriod,fftSize,timeAvg,subCarrierAvg` |
| 1968 | `ITPSDFINAL` | 频谱序列（§5.1） |
| 1991 | `ITFILTTABLE` / `progFilters` | 每频点的滤波器表 |
| 2022 | `ITBANDPASSBANK` | 硬件带通能力 |
| 2023 | `ITPROGFILTBANK` | 可编程滤波器能力 |
| 2039 | `ITFRONTENDMODE` | `frequencyBand,mode`（CIC3/HDR） |
| 2063 | `ITPSDDETECT` | 检测用频谱序列（同 1968 布局，另带 `band`） |
| 2065 | `ITDETECTSTATUS` | `rfPath,detectionType,centerFrequency,bandwidth` |
| 2127 | `FILESTATUS` | `fileStatusEnum` |
| 2137 | `FILESYSTEMCAPACITY` | 存储容量 |
| 2143 | `ITDETECTCONFIG` | `rfpath`（ITK 是否被授权/启用） |
| 2358 | `SKDETECTCONFIG` | `mode`（ENABLE/DISABLE） |
| 2364 | `SKCALIBRATESTATUS` | `mode` + `data[]{calibrationResult,timeStamp}` |
| 2366 | `SKCALIBRATE`（命令） | 标定命令响应 |
| 181/615/1067/1068/1118/1119/1738/1739 | `MARKxPOS`/`MARKxPVA` | `latitude,longitude` |

### 3.2 `gritCompLogsRegister`：请求哪条日志、什么触发、什么周期

`gritJarvisInterface.js:158-291`。值形如 `"ontime,1"` / `"onchanged,0"` / `"onnew,0"` / `"once,0"`
＝ `<trigger>,<period>`，直接拼成 `log thisport_30 <NAME>b <TRIGGER> <PERIOD>`
（`message.name = key.slice(0,-1).toUpperCase()`，即去掉尾字母 `b` 再大写）
`[观察] gritJarvisInterface.js:1236-1253`。

要点：`gritStatusBar` 24 行（`loglistb` 重复一次，去重 23 条）、`gritRagIndicators` 9 条、
`gritLandingPage` 10 条、`mitigationAssistant` 11 条、`signalMatrix` 4 条、
`positionOverview`/`luciadPositionOverview` 各 5 条、`gritEvents` 9 条、
`pointOfInterest` 1 条、`triggers` 8 条、`gritNetworkingSettings` 8 条、`deviceInfo` 2 条、
`spanStatus` 3 条 `[观察] gritJarvisInterface.js:160-290`。`positionOverview`/`triggers` 在
`!serverModel.isMapSupported()` 时整段 `return`
`[观察] gritJarvisInterface.js:1212-1215`。

`triggers` 特殊：只请求用户**当前配置过**的 MARK 日志
（`userStore…poi[tabid].triggers[*].type`，`mark1pos` 映射到 `markpos` 再比 `key`)
`[观察] gritJarvisInterface.js:1226-1235`。`FILESTATUS` 在 OEM7 上改名为 `LOGFILESTATUS`
`[观察] gritJarvisInterface.js:1238-1240`。

### 3.3 `gritMandatoryLogs`：GRIT 播放文件的"前置日志"缓存

结构 `gritMandatoryLogs[tab][msgId] = { timeMsec:number, data:Buffer }`
（`timeMsec` 由 `Date.parse(bufferTime)` 得到，同一毫秒内相同 msgId 的字节做 `Buffer.concat`）
`[观察] gritJarvisInterface.js:295-324`。只对 `gritOnchangedList` 里的日志收集：即
`gritStatusComponents` 里除 `triggers` 外、且 trigger ≠ `ONTIME` 的日志，再排除
`1968`（ITPSDFINAL）和 `1335`（HEADING2）`[观察] 01_解包/app/view/GRIT/livePlayback/livePlayback.js:42-60`。
`resetDataObject(tab)` 会同时清掉 `rxStatusEventData[tab]` 与 `gritMandatoryLogs[tab]`
`[观察] gritJarvisInterface.js:334-337`。

### 3.4 机型/固件判定用到的两条字符串

- `tabFeatures[tab].firmwareVersion = gpsCardComponent.softwareVersion`；
  `minorSWVersion = softwareVersion.substr(5,4)`；`subSWVersion = substr(7,6)`
  `[观察] 01_解包/app/model/featuresList.js:15-18`；
- `gritFirmwareCheck`：`major = parseInt(fw.substr(2,1))`、`minor = parseInt(fw.substr(5,2))`，
  `major < 7 || minor < 7` → 不支持 `[观察] featuresList.js:1310-1322`。
  以 `OM7MR0706RN0000` 为例：`fw[2]='7'` → major 7；`fw.substr(5,2)="07"` → minor 7 → **通过**；
  `OM7MR0604…` → major 6 → 不通过。
- `isOEM7Supported(model)`：白名单
  `OEM729/OEM719/OEM718D/PWRPAK7/OEM7600/SMART7/OEM7500/CPT7/SMART2/OEM2500/MarinePak7`，
  或以 `PWRPAK7/OEM7/SMART7/SMART2/OEM2500` 开头 `[观察] featuresList.js:1340-1346`。
- 机型选项字符第 9 位（`modelString[8]`）决定干扰能力：
  `itkSupport = char∈{E,N,F}`、`itkMitigationSupport = char∈{E,F}`、
  `spoofingSupport = 接收机代号以 7 结尾 && minorSWVersion≥8 && char∈{E,F}`
  `[观察] featuresList.js:99-104, 767-785, 810-818`。

### 3.5 状态栏与事件面板的显示字段（全量）

**状态栏**（`gritStatusBar.html:17-109` 与 `gritStatusBar.js` 的写入点）

| 显示位置（DOM id/class） | 内容 | 来源日志 / 字段 | 刷新 |
|---|---|---|---|
| `.positioning-traffic span.{yellow,red,green}-status` | 定位 RAG 文案（Good/Warning/Error 或 INTERFERENCE 等 7 种组合） | 由 §6.3 合成，输入 `BESTPOS.solutionStatus/positionType/operatingMode`、`AVEPOS.posaveStatus`、`INSPVAX.status`、`PORTSTATS` 等 | 每收到这些日志即算（`gritRagIndicatorLogs` 全部到齐才出一轮 `[观察] gritStatusBar.js:271-282`） |
| `.grit_configuredPositions`（RTK/DGNSS/PPP/SBAS/Single/NONE/FIXEDPOS） | 配置的位置模式，当前模式高亮 | `INTERFACEMODE/LOGLIST/NTRIPCONFIG/SBASCONTROL/GENERATERTKCORRECTIONS/PORTSTATS/ASSIGNLBANDBEAM` → `gritPositionStatusmodes` | 每次模式日志（多为 onchanged） |
| `#gritStatusBarlatitude` / `#gritStatusBarlongitude` | 纬度/经度，7 位小数 + `°` | `BESTPOS.latitude/longitude` | 每帧 BESTPOS |
| `#gritStatusBarheight` | 高度 + 单位（可选椭球高 = height + undulation） | `BESTPOS.height`、`undulation`、`userStore…heightUnits` | 每帧 |
| `#satelliteTrackedStatus` / `#satelliteUsedStatus` | 跟踪/参与解算卫星数 | `BESTPOS.satellitesTracked/Used` | 每帧 |
| `#gritStatusBarhardwareVersion` | 机型（MarinePak7 特判） | `VERSION` → `featuresList.getEnclosurehardwareVersion` | 连接时一次 + 版本变化 |
| `#gritStatusBaridleTime` | "CPU Usage"（%），实为 `100 − raw/2` | `HWMONITOR.idleTime` | 每帧 HWSTATUS（ontime 1 s） |
| `#gritStatusBartime` | UTC `HH:MM:SS` | `TIME` | 每帧 TIME |
| `#gritStatusBaritkState` | Interference：Detected / Not detected / Disabled | `ITDETECTSTATUS.noOfEntries` + `data[].detectionType`；`ITDETECTCONFIG.rfpath=="NONE"` 时显示 Disabled | 每帧 ITDETECTSTATUS + 首次额外 `log thisport itdetectstatusb once` |
| `#gritStatusBarjamming` | Jamming：Detected / Not detected | `RXSTATUS.rxstatus15bit` | 每帧 RXSTATUS |
| `#gritStatusBarspoofing` | Spoofing：Detected / Not detected / Detection disabled / Not calibrated | `RXSTATUS.rxstatus9bit` + `aux3status25bit` + `SKDETECTCONFIG.mode` | 每帧 |
| `.result-banner` | 导出成功/失败横幅 | POI 导出结果 | 事件触发，5 s 自动隐藏 `[观察] pointsOfInterest.js:242-248` |

**事件条目**（`gritEvents.js:1950-2030`）

| 字段 | 值 | 说明 |
|---|---|---|
| 状态圆点 | `green-status`/`yellow-status`/`red-status` + 文案 `Good`/`Warning`/`Error` | 由 `state`（`Good`/`Moderate`/`Poor`）映射 |
| 事件描述 | `events_data_lang_map[description]`，`%1` 会被频率值替换 | 37 种事件见下表 |
| 时间行 | 起始/结束时间（"Began today at…"、"Lasted from…"） | `decodeStartTime`/`decodeEndTime` |
| 关闭按钮 | `.grit-event-pop-close` | 手动移除 |
| DOM 属性 | `id=<时间戳>_<事件名>`、`data-event-freq`、`data-message`、`startTime`、`endTime` | 供时间轴与播放过滤使用 |

`events_data_lang_map` 的 47 个键即**全部事件类型/状态词**（`[观察] gritEvents.js:31-80`）：
`EVENTS_HIGH_INS_STD_DEV, SPOOFING_DETECTED, JAMMING_DETECTED, ITK_DETECTED, ITK_DETECTED_AT,
EVENTS_NO_LBAND, NO_POSITION_AVAILABLE, HIGH_POS_STD_DEV, NO_SBAS_TRACKED, SBAS_TRACKING_LESS,
GPS_TRACKING_LESS(_GOOD), GLO_TRACKING_LESS, GAL_TRACKING_LESS(_GOOD), BDS_TRACKING_LESS(_GOOD),
NAVIC_TRACKING_LESS, 3V3_WARNING, EVENTS_VOLTAGE_WARNING, 1V2_WARNING, ANT_VOL_WARNING,
ANT_VOL_WARNING_LGHN, ANT_CURRENT_WARNING, TCXO_WARNING, 3V3_ERROR, SUPPL_VOLTAGE_LW_ERR,
SUPPL_VOLTAGE_UPP_ERR, EVENTS_VOLTAGE_ERROR, 1V2_ERROR, ANT_VOL_ERROR, ANT_CURRENT_ERROR,
TCXO_ERROR, HIGH_CPU, 1V8_VOL_ERROR, 1V8_VOL_WARNING, DDR_TEMP_ERROR, DDR_TEMP_WARNING,
INVALID_MODEL, INVALID_AUTHCODE, COM1_BUFFER_OVERRUN, COM2_BUFFER_OVERRUN, ENTERED_INTO,
EXITED_FROM`，另有三个通用状态词 `GOOD/WARNING/ERROR`。

### 3.6 `mitigationAssistant.dataObject`

`{ Spoofing:{}, Interference:{}, Jamming:{} }`（`[观察] mitigationAssistant.js:79-109`）

- `Interference[key]`，`key = rfPath + "_" + round(centerFrequency)`：
  `{ type:"Interference", frequency:number(MHz), constellation:string, filterApplied:"0"|1 }`
  `[观察] mitigationAssistant.js:213-218`；
- `Spoofing.Spoofing`：`{ type,timestamp,latitude_before,longitude_before,latitude_now,longitude_now }`
  `[观察] mitigationAssistant.js:389-396`；
- `Jamming.Jamming`：`{ type,timestamp,latitudeValue,longitudeValue }`
  `[观察] mitigationAssistant.js:456-461`。

### 3.7 POI / Triggers 持久化对象

存于 `userStore.userStoreJSON.app.poi[<tabid>]`，最终落到
`%APPDATA%/<app>/userSettings.json`（`getPath('userData') + '/userSettings.json'`，
`JSON.stringify(…, null, 2)` 写盘）`[观察] 01_解包/app/model/userStore.js:5, 86-89`。

```
app.poi[<设备tabid>] = {
  manual  : { "<name>": { name, radius, lat, lng, notification, visible, status, type } },
  triggers: { "<name>": { name, radius, lat, lng, notification, visible, status, type } }
}
```

- `name`：字符串，输入框 `maxlength="16"` `[观察] triggers/triggers.js:87`、`luciadPositionOverview/addPOIDialog.js:326`；
- `radius`：米，`0` 表示"点"不画圆 `[观察] luciadPositionOverview/addPOIDialog.js:20-47`；
- `lat/lng`：度，7 位小数（`formatToSystemLocale(...,7)` 后 `parseFloat`）
  `[观察] listView.js:1647-1648`；
- `notification`：`"entry" | "exit" | "none"` `[观察] triggers.js:327`、`listView.js:50-53`；
- `visible`：`"show"`（其余视为隐藏）；
- `status`：`"active" | "inactive"`；
- `type`：`"manual"` 或 `"MARK1POS" … "MARK4PVA"`（`Triggered by` 列显示 `MANUAL` 或该值）
  `[观察] listView.js:54, 330`。

新增触发器时还会**替换同类型旧记录**（一个 MARK 日志只能有一条触发器）：
按下 Apply 时若 `triggers` 里已有同 `type` 的对象且名字变了，先
`positionOverview/luciadPositionOverview.onPOIchanged("delete", 旧)` 再删键
`[观察] triggers.js:336-352`。

### 3.8 `gritDisplay`（Display 设置）

默认值 `[观察] displaysSettings/displaysSettings.js:3-15`：

| 键 | 类型 | 取值 | 含义 |
|---|---|---|---|
| `showHisMarker` | bool | true | 显示历史点 |
| `showHisLine` | bool | true | 显示历史轨迹线 |
| `hisPersistance` | string/number | `"no limit"` 或整数（**分钟**） | 历史点保留时长，`perMsec = value*60*1000` `[观察] positionOverview.js:1989-2008` |
| `posRefreshFreq` | number | 整数（**秒**） | 车标刷新最小间隔，`timeDiff >= posRefreshFreq*1000` 才挪车标 `[观察] positionOverview.js:1694-1709` |
| `posMarker` | string | `car/boat/drone/fixed_wing/helicopter/human/tractor/train/van` | 车标 |
| `showLegend` | bool | true | 图例 |
| `showHeading` | bool | true | 车标朝向 |
| `showCOG` | bool | true | 航迹角 |
| `showSOG` | bool | true | 地速 |
| `SOGUnits` | string | `m/s` 等 | 速度单位 |
| `orientation` | string | `"north up"` / `"track up"` | 地图朝向 |

存盘路径 `app.gritDisplay[<tabid>]`，Apply 时 `$.extend(true, …)` 合并后
`positionOverview.setDisplaysConfiguration`（LuCIAD 版调 `luciadPositionOverview.…`）
`[观察] displaysSettings.js:304-318`。

### 3.9 频谱高级设置 `advSettings[tab]`

`{ updateRate, spectrumResolution, timeAveraging, detectionSensitivity }`，默认
`1 / 1 / 10 / 5` `[观察] spectrumViewer.js:576-580, 1388-1398`；单位与范围见 §5.4。

---

## 4. 接口清单（对外函数：签名、参数语义、返回值、副作用、异常路径）

### 4.1 `gritJarvisInterface`（唯一门面，34 个导出）

`[观察] gritJarvisInterface.js:1603-1642`。

| # | 名称 | 签名 | 参数语义 | 返回 | 副作用 / 异常路径 |
|---|---|---|---|---|---|
| 1 | `createGritMainPanel` | `(tab)` | tab 名（`grit-tabs-N`） | `undefined` | 在 `#<tab>` 下建 `grit-events-panel/menuBar-panel/grit-status-panel/main-panel/fetch-loader/status-components/config-components`；插入 Spoofing 配置页签、两个 modal、帮助 modal、translucent 遮罩、`connection-loader`；**非 playback** 才建 playback 面板 `[观察] :438-597` |
| 2 | `checkGritConnectionReady` | `(tab, connectionLost=false)` | 连接就绪入口 | `undefined` | 见 §2.4 时序；会 `requestlog` 两条、`createComponent` 多个、`createTile` 多个 |
| 3 | `gritlogProcess` | `(msgID, logData, tab, data)` | 每收到一条已解析日志调用；`data` 是 `jDataView` | `undefined` | ①`data.getUint8(6)` 取 logType，非 0 走 `genericConfig.commandResponseHandler`；②只处理 `gritLogs` 内 ID；③`logData.time = jarvisInterface.getLogTimeStamp(data)`；④live 时 `livePlayback.saveToHistoryFile`；⑤按 msgID 分发到各组件（见 §6.2） |
| 4 | `handleLiveDataInPBMode` | `(data, tab)` | 回放时"边播边实时"通道；`data` 为 `jDataView` | `undefined` | 解析后：TIME→更新 UTC；RXSTATUS→`gritStatusBar.updateView`；其余→`gritEvents.handleLiveDataInPBMode`；位置总览按 LuCIAD 分派；`triggers` 命中则 `routeTriggersLogData(…, true)` `[观察] :823-852` |
| 5 | `gritCompReqlogs` | `(logs: string[], tab)` | 组件名数组，如 `["gritStatusBar"]` | `undefined` | 非 playback 时逐 key 组 `log thisport_30 <NAME>b <TRIGGER> <PERIOD>` 交给 `jarvisInterface.sendLogCommand`；`genericConfig.getMessageId` 返回 −1 时收集到 `invalidMsgs` 仅 `console.log`；重复调用会重复下发（无去重） `[观察] :1197-1264` |
| 6 | `gritConnectionSuccess` | `(tab)` | — | `undefined` | 连发 4 组请求：`gritStatusBar`→`gritRagIndicators`→`gritLandingPage`→`gritEvents` `[观察] :1280-1285` |
| 7 | `getGritCompRegister` | `()` | — | `gritCompRegister` 引用 | 无（注意返回的是引用，外部可改） |
| 8 | `getGritCompLogsRegister` | `()` | — | `gritCompLogsRegister` 引用 | 无 |
| 9 | `getGRITSpecificLogs` | `()` | — | `number[]`（去重后的全部 GRIT messageId） | 无 `[观察] :340-357` |
| 10 | `getGRITPlaybackFileHeader` | `()` | — | `"HEADER - NAS GRIT FILE"` | 无 |
| 11 | `getGRITPlaybackDataStartHeader` | `()` | — | `"HEADER - DATA START"` | 无 |
| 12 | `storeMandatoryLogs` | `(msgId, tab, data:Buffer, bufferTime:string, seqId)` | 按毫秒桶累积前置日志 | `undefined` | 写 `gritMandatoryLogs`；同毫秒 `Buffer.concat` `[观察] :295-319` |
| 13 | `getCompleteMandatoryLogData` | `(tab)` | — | `{msgId:{timeMsec,data}}` | 无 |
| 14 | `resetDataObject` | `(tab)` | — | `undefined` | 删 `rxStatusEventData[tab]`、`gritMandatoryLogs[tab]` `[观察] :334-337` |
| 15 | `gritLoadCachedData` | `(tab)` | — | `undefined` | 把 `jarvisInterface.cachedData[tab]` 里的 `gritStatusBar`/`spectrumPlot`/`gritPositionStatusmodes` 重新 emit 一遍并清空；`spectrumPlot` 里 1968/2063 是**数组**（最多 30 帧）需要循环 emit `[观察] :1310-1337` |
| 16 | `placeLbandConfiguration` | `(tab)` | — | `undefined` | 组 `ITSPECTRALANALYSIS` 命令：`frequency:"LBAND"`, `updatePeriod=updateRate*1000`, `fftSize=<N>K`, `timeAvg`, `subCarrierAvg`；**串口连接强制 `1K/10/5`**；live playback 连接直接 return `[观察] :1287-1306` |
| 17 | `handleGRITLandingPageCommandResponse` | `(logdata)` | 命令响应 | `undefined` | `genericConfig.removeFeatureFrmCmdList("GRITLandingPage")` |
| 18 | `gritLoadConfigComponents` | `(tab)` | — | `undefined` | 若 Spoofing 页签容器为空则 `createComponent('spoofingConfiguration',…)` `[观察] :611-615` |
| 19 | `handleTabAfterLoadingHtml` | `(componentName, tab)` | `createComponent` 载入 html 后回调 | `undefined` | `positionOverview`→`loadMap(tab)`，回放时隐藏"加点/设置"按钮；`luciadPositionOverview`→**500 ms 后** `loadMap(tab)`；`pointsOfInterest`→`adddataUI`；`spoofingConfiguration`→拉 `gritConfigComponents` 日志 `[观察] :358-386` |
| 20 | `catchGritEvents` | `(alive, eventType, datalang, message, count, time, eventId, tab, frequencyValue, mark=true, isCurrentData=true)` | 把事件交给地图打点 | `undefined` | 按 LuCIAD 分派到 `luciadPositionOverview.markGritEvents` / `positionOverview.markGritEvents` `[观察] :1462-1465` |
| 21 | `requestGRITRAGIndicatorLogs` | `(tab)` | — | `undefined` | `gritCompReqlogs(["gritRagIndicators"])` |
| 22 | `loadMapComponents` | `(tab)` | — | `undefined` | `!isMapSupported()` 时 2 s 后隐藏 `#gritMapSettings` 并 return；否则按需建 `triggers`/`pointsOfInterest`/`displaysSettings` 三块，建完 `gritDisplaysSettings.resetDisplaySettingsUI(tab)` `[观察] :1352-1370` |
| 23 | `deepCompareObj` | `(a, b)` | 任意值 | `boolean` | 纯函数；类型不同即 false，对象/数组比 key 数与每 key 递归，其它 `===` `[观察] :1338-1351` |
| 24 | `applyDarkModeChanges` | `async ()` | — | `Promise` | 依次调 `luciad/positionOverview.applyDarkMode`、`addPOIDialog`、`listView`、`spectrumPlot`、`gritlandingPage.changeTheme` `[观察] :1470-1480` |
| 25 | `checkActiveGRITConnection` | `(tab)` | — | `string[]`（0 或 1 个 `"grit-"+tab`） | 无；判据 `tabids["grit-"+tab]` 存在且磁贴无 `device-disconnected` 类 `[观察] :1481-1489` |
| 26 | `activeGRITConnections` | `(tab, smPSN)` | `smPSN`=GPS 卡 PSN | `string[]` | 遍历 `tabids` 里所有 `grit-*`，要求磁贴在线且 `featuresList.getGPSCardPSN(tab)===smPSN` `[观察] :1490-1504` |
| 27 | `showITKBlockedDialog` | `(tab, gritTab, statusScreen=false)` | 干扰功能未授权时的"去 GRIT"弹窗 | `undefined` | 建 dialog，按钮回调里 `#home-grit` 点击 + 打开 GRIT 磁贴；给 modal 加 `config-cancel/blockITKPopup` 类 `[观察] :1505-1537` |
| 28 | `isPlaybackConn` | `(tab)` | — | `boolean` | `$("#"+tab).hasClass("playback-tab")` |
| 29 | `isLivePlaybackConn` | `(tab)` | — | `boolean` | `hasClass("livePlaybackStyle")` |
| 30 | `getPlaybackPauseState` | `(tab)` | — | `boolean` | 读 `.play-pause.playControl` 是否含 `pause`/`replay` |
| 31 | `OnPlaybackPlayPause` | `(tab, state)` | — | `undefined` | 转调 `spectrumViewer.onPlaybackPlayPause(tab,state)` |
| 32 | `refactorPOIObjects` | `(alldevices)` | `{key:poi}` | 过滤后的同形对象 | 以 `lat.toFixed(6)+","+lng.toFixed(6)` 去重（保留先出现者）；`lat/lng` 缺失会抛 TypeError（无 try） `[观察] :1565-1580` |
| 33 | `processLanguage` | `(tab)` | — | `undefined` | 依次调 19 个组件的 `processLanguage`（menuBar/statusBar/landingPage/livePlayback/mitigationAssistant/spoofingConfiguration/addFilterPopup/signalMatrix/positionOverview/POIDialog/mapSettings/triggerSettings/displaysSettings/pointsOfInterest/spectrumViewer/helpFile/listView/spectrumPlot/gritEvents），最后 `$('[data-lang-help]').html(__('HELP'))` `[观察] :1439-1460` |
| 34 | `onSwitchToLivePb` | `(tab)` | — | `undefined` | `gritEvents.resetEventsData(tab,false,true)` |

文档型副作用（不是导出，但影响所有组件）：三个 `emitter.on` 处理器在模块加载时就注册
`[观察] gritJarvisInterface.js:1372-1437`：

- `gritStatusBar`：当前 tab 匹配（或 `tabs-1`、或 `''`）才 `gritStatusBar.updateView`，
  否则塞进 `jarvisInterface.cachedData[tab].gritStatusBar[msgID]`；
- `spectrumPlot`：`tabs-1` 且当前是 waterfall 时**不**直绘；否则直绘或缓存，
  1968/2063 的缓存在 waterfall 且加滤波器弹窗关闭时按 **最多 30 帧**滚动（`shift()` 掉最旧）
  `[观察] :1403-1414`；
- `gritPositionStatusmodes`：同上，缓存的是**单条**（覆盖）。

### 4.2 其它模块导出面（只列签名）

| 模块 | 导出 | 引用 |
|---|---|---|
| `gritStatusBar` | `updateView(msgID,logData,isLiveInPlayback=false)`、`updateStatus(logData,msgID)`、`updateGritPositionModes(cfg,act,logData,tab,msgID)`、`gritRagIndicatorDetection(tab)`、`getCurrentTimeRun(tab)`、`resetDataObject(tab)`、`processLanguage()` | `gritStatusBar.js:896-904` |
| `gritEvents` | `updateData(logData,msgID,valid=false)`、`handleLiveDataInPBMode(logData,msgID,tab)`、`updateEventsOntoUI(tab)`、`setEventNotificationFlag(tab)`、`delayEventsNotifications(tab)`、`resetEventsData(tab,saveEventsData,onconnectionLaunch)`、`onReturnToLive(tab)`、`updateBestVelData`、`getGritEventCount`、`handlePOIHisData`、`removeDeletedPOIEvent(name,tab)`、`getEventHandlerObject/gethistoricEventObj` 等 | `gritEvents.js:2743-2769` |
| `spectrumPlot` | `updateData(msgId,data)`、`resetPlotObjects(tab)`、`resetDataObject(tab)`、`getHighestChanconfigList(tab)`、`getItSpectralAnalysisMode(tab)`、`getAvailableBandByConstellations(tab)`、`addShapesToAddFilter/…`、`resetWaterfallPlot(tab)`、`isFilterPopupOpen(tab)`、`applyDarkMode()` 等 | `spectrumPlot.js:141-…`、`:3103-3307` 各段 |
| `spectrumViewer` | `resetSpectrumViewer(tab)`、`getselectdBandView(tab)`、`getselectdPlotType(tab)`、`getAdvSettingInfo(tab)`、`setAdvSettingInfo(data,tab)`、`setWaterfallAdvSettings(tab)`、`updateFrontEndModeStatus(logData)`、`updateBandView(…)`、`resetHDR(tab)`、`onPlaybackPlayPause(tab,state)`、`placeFilterConfig(freq,tab)`、`updateActiveFilterTiles(tab)`、`processLanguage()` | `spectrumViewer.js:1520-1546` |
| `signalMatrix` | `createSignalMatrixUI(logData,tab)`、`updateData(msgId,data)`、`getRejectCodevalues(tab)`、`renderHTML(tab)`、`handleInterferenceStateStyles(tab)`、`resetSignalMatrix(tab)`、`resetDataObject(tab)`、`updatepassBandUI/updateFrequencyBandUI`、`processSatelliteData`、`updateSMTooltip` | `signalMatrix.js:871-888` |
| `mitigationAssistant` | `updateDataObject(msgID,logData,tab)`、`getdataObject(tab)`、`getProgFiltData`、`getBandPassBankData`、`getFiltTableData`、`getChanconfigData`、`frameConstellationValues(freq,tab)`、`frameValuesToPopulate`、`handlePlaybackRewindForward(tab,isLiveState,timestamp)`、`processLanguage` | `mitigationAssistant.js:2230-2243` |
| `spoofingConfiguration` | `setSpoofingPageStage(logData)`、`displaySpoofingStage(stage,tab)`、`handleSpoofingConfigurationCommandResponse(data,tab,msgID)`、`setSKDetectInitialState(logData)`、`resetSpoofingConfigUI(tab)`、`spoofingPage`、`processLanguage(tab)` | `spoofingConfiguration.js:309-319` |
| `pointsOfInterest` | `adddataUI(tab)`、`updateData(logData,msgID)`、`getLatLng(tab)`、`openLoggingFile(tab)`、`getVisiblePoiIdsByTab(tab,key,toEmpty)`、`resetDataObject`、`processLanguage` | `pointsOfInterest.js:318-326` |
| `triggerSettings` | `restTriggersUI(tab)`、`isTriggersDataChanged(tab)`、`updateData(logData,msgid,tab)`、`updateNotification`、`resetDataObject`、`processLanguage` | `triggers.js:582-589` |
| `gritDisplaysSettings` | `resetDisplaySettingsUI(tab)`、`isDisplayDataChanged(tab)`、`resetDataObject`、`processLanguage` | `displaysSettings.js:405-410` |
| `gritMapSettings` | `onMapTabClick(ele,tab)`、`resetmapSettingsUI(tab)`、`processLanguage` | `mapSettings.js:94-98` |
| `gritlandingPage` | `updateReceiverManagement(view,id)`、`setCurrentPos(pos,tab)`、`updateMapWithPositions()`、`getMap()`、`removeTab`、`deleteDevice`、`deviceDetails`、`changeTheme`、`processLanguage` … | `js/gritLandingPage.js`、`js/luciad/gritLandingPage.js:662-680` |
| `luciadMapLayer` | `createMapInstance`、`createPOIMapInstance`、`createGoogleMapsLayer`、`createAlidadeSmoothLayer`、`updateMapProviderState`、`enforceZoomConstraints`、`addRoute/addRoutePoints`、`createPOIMarker`、`createCircleMarker`、`zoomToLocation`、`getExistingFeature`、`addEventMaker/updateEventMaker` … | `luciadMapLayer.js:2611-2663` |
| `luciadPositionOverview` | `loadMap`、`updateData`、`markGritEvents`、`onPOIchanged`、`setDisplaysConfiguration`、`checkEntryExit`、`showPOIPopup`、`placeAddPoiPopup`、`createCustomPopup/closeCustomPopup`、`handleLiveDataInPBMode`、`applyDarkMode` … | `luciadPositionOverview.js:2595-2630` |
| `positionOverview`（旧） | `loadMap`、`updateData`、`markGritEvents`、`onPOIchanged`、`setDisplaysConfiguration`、`editPOIOnMap`、`changePosMarker`、`showSuccessBanner`、`applyDarkMode` … | `positionOverview.js` 末尾 return 块 |

**异常路径约定**（全目录一致）：几乎所有 DOM/数据访问都包在 `try{…}catch(e){console.log(e)}` 里，
不抛给上层、不弹窗。典型：`checkGritConnectionReady` 内三个 emitter 处理器
`[观察] gritJarvisInterface.js:1377-1388, 1395-1420`、`luciadPositionOverview.loadMap` `[观察] :1285-1333`、
`mitigationAssistant.createMitigationUI` 调用点 `[观察] :586-600`。

---

## 5. 报文/协议细节（字节级布局、换算、边界条件）

### 5.1 频谱数据链路总览

```
接收机 ──BINARY──► jDataView ──logParsers.parseData──► logData{...}
   │                                                     │
   │  (ITSPECTRALANALYSIS 命令要求数据)                   ▼
   └─────────────────────────────────── jarvisInterface.logProcess
                                              │ tab 以 grit 开头
                                              ▼
                                    gritJarvisInterface.gritlogProcess
                                              │ 1968 / 2063
                                              ▼
                                    emitter.emit('spectrumPlot')
                                              │
                                    spectrumPlot.updateData → processITPSDFinalData
                                              │ 按 sequenceId 拼帧
                                              ▼
                                    tabPlotLogs[tab][1968] / plotBandSamples[tab][band]
                                              ▼
                                    handlePlot/updatePlotTraces → Plotly.newPlot/react
```

触发命令：`placeLbandConfiguration` 或 `spectrumViewer.placeSelectedConfig` 组
`ITSPECTRALANALYSIS`（ID 1967），字段
`frequency / mode / updatePeriod / fftSize / timeAvg / subCarrierAvg`
`[观察] gritJarvisInterface.js:1292-1305`、`spectrumViewer.js:824-827`。

枚举（`[观察] 01_解包/app/model/NovatelIdConstants.js:2354-2397`）：

- `mode`：`OFF=0, PREDECIMATION=1, POSTDECIMATION=2, POSTFILTER=3`
- `frequency`：`GPSL1=0, GPSL2=1, GLONASSL1=2, GLONASSL2=3, GPSL5=5, LBAND=6, GALILEOE1=7,
  GALILEOE5A=8, GALILEOE5B=9, GALILEOALTBOC=10, BEIDOUB1=11, BEIDOUB2=12, QZSSL1=13,
  QZSSL2=14, QZSSL5=15, QZSSL6=16, GALILEOE6=17, BEIDOUB3=18, GLONASSL3=19, NAVICL5=20`
- `fftSize`：`1K=0, 2K=1, 4K=2, 8K=3, 16K=4, 32K=5, 64K=6`
- `ITFRONTENDMODE`（2039）`frequencyBand`：`L1=2, L2=3, LBand=4, L5=5`；`mode`：`CIC3=0, HDR=1`

### 5.2 `ITPSDFINAL`（1968）/ `ITPSDDETECT`（2063）的字段与换算

解析器（`[观察] 01_解包/app/model/logparsers.js:187-200`）：

```js
itPSDFinalJSON = {
  status:[ULONG32, 0],
  sats: { frequencyStart:[FLOAT,4], stepSize:[FLOAT,8], noofSamples:[ULONG32,12] },
  system: { sample:[SHORT,16] }        // SHORT = getUint16(…, true)
}
```
（偏移量相对 **28 字节 OEM7 头**之后：`headerOffset` 初值
`NovatelIdConstants.MessageHeaderLength = 28`，`getData` 一律 `headerOffset + offset`，
`[观察] 01_解包/app/model/NovatelIdConstants.js:13`、`logparsers.js:753, 624-692`。
逐样本 `headerOffset += 2`，即样本是连续 `uint16`。）

换算（`[观察] logparsers.js:1126-1143`，2063 同 `:1156-1175`）：

```js
sSize     = stepSize / 1e6;              // 频率步进 → MHz
value     = rawUint16 / 256;             // 定点 8.8：1/256
sample    = value - 200;                 // 功率（dBm）
frequency = frequencyStart + m * sSize;  // MHz
```

- **FFT 点数**：不在这条日志里；由 `ITSPECTRALANALYSIS.fftSize` 决定（1K…64K），
  本条日志的 `noofSamples` 是**本帧样本数**（可分帧，多帧靠 `sequenceId` 合并）。
- **bin 宽度（RBW）**：`RBW = stepSize`（原始 float，单位 Hz）。理由链：
  `stepSize/1e6` 与 `frequencyStart` 直接相加，而 x 轴其它元素（`NovatelIdConstants.BandRanges`
  的 `clickRange` 1141/1202/1515/1631、`bandFrequencies` 的 `start/end` 1548…1614）都是 MHz，
  所以 `sSize` 是 MHz、`stepSize` 是 Hz `[推断] logparsers.js:1127` +
  `[观察] NovatelIdConstants.js:3959-3996, 4076-4081`。
- **功率单位**：代码里唯一给出单位的文字是频谱悬停串
  `` `${data.band} (${parseInt(data.freq)}MHz, ${parseFloat(data.pwr).toFixed(2)}dBm)` ``
  其中 `pwr` 就是 trace 的 y（`event.yvals[0]`）或瀑布的 z `[观察] spectrumViewer.js:283`、
  `spectrumPlot.js:2195, 2207`。GRIT 目录内**没有任何 dBHz 转换**（全目录 grep `dBHz|dB-Hz|dB/Hz` 无命中），
  所以 y 是"每个 bin（=RBW）内的功率 dBm"，不是 dBm/Hz；同理 **参考电平（reference level）
  在代码中不存在**，纵轴完全由数据自动定标（见 §5.3）。

**算例（可复算）**

1. 设某帧 `frequencyStart = 1575.42`（MHz）、`stepSize = 2000`（Hz）、`noofSamples = 1024`：
   - `sSize = 2000/1e6 = 0.002` MHz = 2 kHz → **RBW = 2 kHz**；
   - 第 0 个 bin 频率 `1575.42 + 0×0.002 = 1575.420 MHz`；
   - 第 1 个 bin `1575.422 MHz`；第 1023 个 `1575.42 + 2.046 = 1577.466 MHz`；
   - 覆盖带宽 `1024 × 2 kHz = 2.048 MHz`。
2. 若把 `fftSize` 从 1K 换到 2K 而前端带宽不变（2.048 MHz），则 `RBW` 减半为 1 kHz、
   `stepSize = 1000`，覆盖仍为 2.048 MHz（2048 × 1 kHz）——这正是"频谱分辨率翻倍、
   每个 bin 噪声功率低 3 dB"的来源 `[推断]`（`RBW` 与 `fftSize` 由接收机内部绑定，
   应用侧只被动读 `stepSize`）。
3. 单个样本：`raw = 0x4A00 = 18944` → `18944/256 = 74.0` → `sample = 74.0 − 200 = −126.0 dBm`。
4. 量程边界：`raw=0` → −200.0 dBm；`raw=0xFFFF=65535` → `255.996 − 200 = +55.996 dBm`。
   负值被 `getUint16` 天然排除（`SHORT` 映射到 `getUint16`，无符号）
   `[观察] logparsers.js:650-651`。

### 5.3 拼帧、纵轴定标与"参考电平"

- **多帧合并**：`processITPSDFinalData` 用 `sequenceId`（`logData.getUint16(10,true)`，
  即 OEM7 头的 sequence 字段）作 key 缓存，**只有 `sequenceId === 0` 时才出图**：
  把 `Object.keys(...).reverse()` 逐帧展开累加，得到 `finalData[0..n]` 与 `finalData.noofSamples`
  `[观察] spectrumPlot.js:336-375`、`logparsers.js:1143`。
- **重复帧丢弃**：同一 `sequenceId` 再来一次直接 `flag:false` 返回。
- **纵轴自动定标**：`calculateYRangeWithBuffer`
  `[观察] spectrumPlot.js:1809-1903`：
  - 取当前所有样本（含滤波器迹线 y）的 min/max；
  - `adjustToLowerBound`：负值向下取到"末位 1"（如 −126.0 → −131），正值 `floor(n/10)*10+11`；
  - `adjustToUpperBound`：负值向上取到末位 9（−30.4 → −29），正值 `floor(n/10)*10−1`；
  - 首次进入时把范围再各外扩 **10 dB** 作为滞回带，之后只有当新 min/max 越出滞回带、
    或上下界变化超过 **30 dB**、或 `itspectralanalysis.frequency` 改变时才重新定标
    `[观察] :1846-1880`。这就是代码里唯一类似"参考电平"的东西。
- **瀑布色标**：固定 `zmin=-135`、`zmax=-30`，色阶断点 `[-120,-105,-90,-75,-60,-45]`
  对应 `#1192E8/#1192E8/#198038/#82ad32/#F5A623/#FF832B`，再 `unshift(['0','#6929C4'])`
  与 `push(['1','#DA1E28'])` `[观察] spectrumPlot.js:2795-2806`。也就是说
  **≤−135 dBm 显示紫色、≥−30 dBm 显示红色**。

### 5.4 高级设置的取值域与互相约束

| 项 | 默认 | 范围 | 步进 | 约束 |
|---|---|---|---|---|
| Update Rate (s) | 1 | 0.05 – 100 | 0.05 | 32K → 最小 0.1；64K → 最小 0.2 `[观察] spectrumViewer.js:725-747`；瀑布视图强制 ≥1 `[观察] :702-722, 1415-1425` |
| Spectrum Resolution (K) | 1 | 1 – 64（仅 1/2/4/8/16/32/64） | 1（按档位跳） | 非 `PREDECIMATION` 模式上限 32，且若当前 64 会被改回 32 `[观察] :748-760` |
| Time Averaging (s) | 10 | 0 – 50 | 1 | 0=不平均（帮助文档同义 `helpFile.html:3845-3847`） |
| Detection Sensitivity (bins) | 5 | 1 – 30 | 1 | 1=不积分 `[观察] :44-49` |

串口连接：`updateRate/spectrumResolution/timeAveraging/detectionSensitivity` 四个控件被
`customDisableButton` 禁用 `[观察] spectrumViewer.js:211-214`，且 `placeLbandConfiguration`
把命令参数**硬编码**成 `1K / timeAvg=10 / subCarrierAvg=5` `[观察] gritJarvisInterface.js:1299-1303`；
帮助文档同样写明"串口连接时高级设置不可用" `helpFile.html:3836-3838`。

### 5.5 `ITDETECTSTATUS`（2065）

结构 `[观察] logparsers.js:260-266`：
`noOfEntries:[ULONG32,0]` + 逐条 36 字节 `{ rfPath:ENUM@4, detectionType:ENUM@8,
centerFrequency:FLOAT@12, bandwidth:FLOAT@16 }`，`headerOffset += 36`
`[观察] logparsers.js:1429-1440`。
`detectionType`：`0→SPECTRALANALYSIS`、`1→STATISTICALANALYSIS`
`[观察] NovatelIdConstants.js:3639-3643`；`rfPath` 经 `ITDetectStatusRFPath` 映射。
`centerFrequency` 是 **MHz**（与频谱 x 轴同单位），代码里 `Math.round()` 后用于
"哪些星座/频段被命中"的区间匹配 `[观察] mitigationAssistant.js:190-192`。

### 5.6 `HWMONITOR`（963）里与 GRIT 有关的两个量

- `idleTime = 100 − raw/2`（单位 %）——字段名叫 idleTime，但**语义是 CPU 占用率**
  `[观察] logparsers.js:1055-1057`；
- 每个测量项 `status` 低 8 位是 `boundaryLimit`，高 8 位（`(status>>8)&0xff`）是
  `HwMonitorStatusReadingType` 的键 `[观察] logparsers.js:1066-1077`；
  `boundaryLimit`：`0=acceptable, 1=lower-warning, 2=lower-error, 3=upper-warning, 4=upper-error`
  `[观察] NovatelIdConstants.js:432-439`。

### 5.7 `RXSTATUS`（93）位的语义（GRIT 只用 4 个）

| 位 | 代码字段 | 含义 | 引用 |
|---|---|---|---|
| bit3 | `rxstatus3bit` | 供电状态（影响 HW 事件判定） | `gritEvents.js:765` |
| bit9 | `rxstatus9bit` | 欺骗 detected | `mitigationAssistant.js:340-343` |
| bit15 | `rxstatus15bit` | 压制 detected | `mitigationAssistant.js:447-449` |
| bit25 | `aux3status25bit` | 未标定（`1` → "Not calibrated"） | `gritStatusBar.js:202-241` |

### 5.8 GRIT 播发/录制的文件格式

- 录制文件（`.gps`）：`Buffer.concat([ "HEADER - NAS GRIT FILE",
  <按时间排序的 mandatoryLogs>, "HEADER - DATA START", <historyFile 原始字节> ])`
  `[观察] livePlayback.js:776-805`；文件名 `<GPS卡PSN>_<ISO时间>.gps` `[观察] :759-763`。
- 历史缓冲：`<userData>/liveplayback/<tab>_historyFile.GPS`，只保留 **10 分钟**
  （`history_time_msec = 10*60*1000`），每 **60 s** 落一次盘（`HISTORY_UPDATE_TIME = 60000`），
  时间轴事件每 **4 s** 挪一次（`events_update_time = 4000`）`[观察] livePlayback.js:11-26, 269-349`。
- 裁剪机制：`updateHistoryFile` 先按 `MAX_BUFFER_SIZE=819200` 从文件尾读一段
  （`index = totalSize > MAX ? totalSize-MAX : 0`），以最后一条日志时间 −10 min 为目标时间戳
  二分定位 `startIndexHistoryUpdate`，再 `truncateFileAt` 把该索引之前的内容删掉；
  二分窗口 `bufferSize = clamp(totalSize/1700, MIN=13100, MAX=819200)`
  `[观察] livePlayback.js:128-151`。
- 其它常量：`CRC_LENGTH = 4`、`BIN_SYNC = "aa44121c"`、头长 28
  `[观察] livePlayback.js:11-19, 31-38`。

### 5.9 欺骗相关命令布局

`SKCALIBRATE`（2366）：`[{mode:[enum,4]},{option:[enum,4]},{reserved:[0,ulong,4]}]`，
`mode` 只有 `START=1`，`option` 为 `ALL=0` / `REMAINING=1`
`[观察] spoofingConfiguration.js:218-232`、`NovatelIdConstants.js:1265-1272`。
"重试"逻辑：仅当"上次整体 FAIL 但至少一项 PASS"时用 `REMAINING`，否则 `ALL`
`[观察] spoofingConfiguration.js:199-204`。

`SKDETECTCONFIG`（2358）：`[{mode:[enum,4]},{reserved1:[0,ulong,4]},{reserved2:[0,ulong,4]}]`，
`ENABLE=1/DISABLE=0` `[观察] spoofingConfiguration.js:246-257`、`NovatelIdConstants.js:1273-1279`。

`SKKALIBRATESTATUS`（2364）解析出 `mode` + `data[]{calibrationResult,timeStamp}`，
`calibrationResult` 枚举 `0=PASS,1=FAIL,2=INPROGRESS,3=NONE` `[观察] NovatelIdConstants.js:2931-2937`；
`timeStamp` 是 32 位压缩时间：`秒 = (word>>15)*8`（取高 17 位，每单位 8 s），
`周 = (word>>3)&0xFFF`，`totalSeconds = week*604800 + 秒`，再以 GPS 纪元
`1980-01-06 UTC` 起算 `[观察] spoofingConfiguration.js:36-71`。

### 5.10 滤波器命令

- `ITPROGFILTCONFIG`：`{frequency:enum, filterId, filterSwitch:enum, filterMode:"NOTCHFILTER"|"BANDPASSFILTER",
  cutOffFrequency:float, notchWidth:float}` `[观察] addFilterPopup.js:594-612`；
- `ITBANDPASSCONFIG`：`{frequency:enum, filterSwitch:enum, cutOffFrequency:float}`
  `[观察] addFilterPopup.js:502-513`；
- 下命令前先 `disableITSpectralanalysis`（把 1967 的 `mode` 置 `OFF`）再下滤波命令
  `[观察] spectrumViewer.js:1399-1413, 1427-1443, 1460-1479`；
- 滤波器 id 只有 `PF0` / `PF1` 两个可编程资源，都被占用时返回 `"NONE"`
  `[观察] addFilterPopup.js:447-484`；
- notch 带宽可选项 **0.15 / 0.5 / 1 / 2.5 MHz**（默认 0.15）
  `[观察] addFilterPopup.js:746-751`；中心频率输入最多 4 位小数 `[观察] :768-786`。

---

## 6. 状态机与事件流

### 6.1 连接状态机（GRIT tab）

```
app/view/GRIT 存在? ──否──► gritSupported=false（无 GRIT 入口）
        │是
        ▼
磁贴开关 → firmware 检查 ──fail──► NOT_SUPPORTED_GRIT_FIRMWARE（dialog，连接被拒）
        │ok
        ▼
连接建立 → 等 VERSION(37) → 机型在白名单? ──否──► showGRITnotSupported
        │                                     （unsupportdGRITReceiver[tab]=true,
        │                                       closeConnection, 删 tab）
        │是 → gritFirmwareCheck 通过? ──否──► gritFirmwareNotSupport → 同上
        ▼
connectionReady[tab]=true → checkGritConnectionReady(tab)  （§2.4 时序）
        ▼
gritConnectionSuccess(tab) 下发 4 组日志请求（由主程序在版本就绪的几条路径上调用，
                                       见 §7.2：jarvisInterface.js:3047/3720/3757、setUpMonitor.html:1557）
        ▼
持续运行；断链 → communication.closeConnection 检查 unsupportdGRITReceiver 决定是否 unlog
```

关键事实：`unsupportdGRITReceiver[tab]` **只写不清**（全仓库除声明、写入、导出、读取之外
没有 `delete`），因此一旦某 tab 被判为"不支持 GRIT"，该 key 永久为 true
`[观察] jarvisInterface.js:21, 3306`、`communication.js:386`。

`closeConnection` 里 `unsupported === true` 会**跳过**整个正常关闭流程（不 unlog、不删 tab 细节），
这正是"不支持 GRIT 时不要把 GRIT 的日志状态带进主程序"的保护
`[观察] communication.js:386-393`。

### 6.2 `gritlogProcess` 的分发表（谁触发、谁消费）

`[观察] gritJarvisInterface.js:855-1189`。逐 messageId：

| msgID | 消费者 / 动作 |
|---|---|
| 101 TIME | 拼 `HH:MM:SS UTC` → `gritStatusBar.updateView`；再拼 `HH:MM UTC` → `livePlayback.updateCurrentUTC` |
| 37 VERSION | 补 `hardwareVersion`（MarinePak7 特判）→ emit `gritStatusBar`；`mitigationAssistant.updateDataObject`；位置总览 `updateData`；`hideNetworkingSettings` |
| 42 BESTPOS | emit `gritStatusBar`；emit `gritPositionStatusmodes`；`mitigationAssistant`；LuCIAD 时 `gritlandingPage.setCurrentPos` + 旧版时同；`pointsOfInterest.updateData`；`gritEvents.updateData`；`gritStatusBar.updateStatus` |
| 172 AVEPOS | emit `gritPositionStatusmodes`；`gritStatusBar.updateStatus` |
| 963 HWMONITOR | `idleTime` 加 `%` → emit `gritStatusBar`；`gritEvents`；`deviceInfo.updateView` |
| 2137 FILESYSTEMCAPACITY | `deviceInfo.updateView` |
| 1465 INSPVAX | 格式化经纬高 → `gritStatusBar.updateStatus` + emit；`spanStatus.updateSpanStatus` |
| 1459 INSPOSX | emit + `spanStatus` |
| 2127 / 1146 FILESTATUS | `gritStatusBar.updateView` |
| 652 SBASCONTROL / 3 INTERFACEMODE / 1260 RTK / 1249 NTRIP / 5 LOGLIST / 72 PORTSTATS | 只 emit `gritPositionStatusmodes`（LOGLIST 另存 `genericView.loglistData[tab]`） |
| 1733 ASSIGNLBANDBEAM | emit `spectrumPlot` + `gritPositionStatusmodes` |
| 2039 ITFRONTENDMODE | `spectrumViewer.updateFrontEndModeStatus` |
| 1967 ITSPECTRALANALYSIS | 仅当 `logType == 0` 才 emit `spectrumPlot`（响应帧不画） |
| 2065 ITDETECTSTATUS | emit `gritStatusBar`、`mitigationAssistant`、`spectrumPlot`；`gritEvents`；`signalMatrix.handleInterferenceStateStyles`；位置总览 |
| 93 RXSTATUS | emit `gritStatusBar`；`mitigationAssistant`；`spanStatus` |
| 94 RXSTATUSEVENT | `gritEvents.updateData`；存 `rxStatusEventData[tab][word]` |
| 1991 ITFILTTABLE | `addFilterPopup.updateData`（仅 ITK 缓解支持）；`mitigationAssistant.updateDataObject` + `getFiltTableData`；位置总览；emit `spectrumPlot` |
| 2358 SKDETECTCONFIG | emit `gritStatusBar`；`spoofingConfiguration.setSKDetectInitialState`；`mitigationAssistant` |
| 2364 SKKALIBRATESTATUS | `spoofingConfiguration.setSpoofingPageStage` |
| 1043 SATVIS2 / 83 TRACKSTAT / 1194 BESTSATS | `ConstellationHandler.*`；若 `logData.tab == tabName` → `signalMatrix.getRejectCodevalues` + `renderHTML` |
| 1148 CHANCONFIGLIST | emit `spectrumPlot`；`signalMatrix.createSignalMatrixUI`；`mitigationAssistant.getChanconfigData`；`ConstellationHandler.chanconfigList` |
| 1968 / 2063 | emit `spectrumPlot` |
| 1201 LBANDTRACKSTAT | `gritEvents`；emit `spectrumPlot`；`signalMatrix.updateData` |
| 99 BESTVEL | `gritEvents.updateBestVelData`；位置总览 |
| 1335 HEADING2 | 位置总览 |
| 2023 / 2022 | `addFilterPopup.updateData`（ITK 缓解支持时）、`mitigationAssistant.get*Data`、emit `spectrumPlot` |
| 1428 CONNECTIMU / 379 INSCOMMAND | `gritStatusBar.updateStatus`、`spanStatus` |
| 2210/2091/2093/1243/1289/1244/2091 等网络 | `networkingSettings.dc_updateData`（仅 `tab.startsWith("grit")` 且全局存在） |
| 2143 ITDETECTCONFIG | `gritStatusBar.updateView` |
| 181/615/1067/1068/1118/1119/1738/1739 | `routeTriggersLogData` → 仅 live 时 `listView.addTriggerPOI` |

`logType = data.getUint8(6)`（OEM7 头第 7 字节）：非 0 表示这是**命令响应**，先送
`genericConfig.commandResponseHandler`；若当前是 GRIT 且 ID 是 `UNLOG` 且 `sendSaveConfig`
为真，则接着发 `genericConfig.saveConfigCommandSending(tab)` 并清标志
`[观察] gritJarvisInterface.js:856-865`。

### 6.3 摘要栏 RAG（红/黄/绿）判定

两盏灯：`indicator1`（定位）、`indicator2`（设备）。最终色：

```
indicator1 === indicator2 → 该色
否则任一为 red → red；否则任一为 yellow → yellow；否则 green
```
`[观察] gritStatusBar.js:487-521`。

- **定位灯**：`gritPosRagIndicator[tab]`
  `[观察] gritStatusBar.js:656-733`：
  1. `solutionStatus ∈ {INSUFFICIENT_OBS, NO_CONVERGENCE, INVALID_FIX, INTEGRITY_WARNING}` → **bad**；
  2. `!convergingFlag`（PPP 中间态）或 `aveposStatus == "INPROGRESS"` → **warning**；
  3. 配置含 `PSRDIFF ROVER` 且当前是 Single → warning；配置含 PSRDIFF+RTK ROVER 且当前 DGNSS → warning；
     配置只有/仅 PSRDIFF（已命中）→ good；
  4. 一般情况：按 `configPosModesOrder = [RTK,PPP,PSRDIFF,SBAS]` 取**配置里精度最高**的那个，
     若当前模式与它不一致 → warning，一致 → good；RTK 下 `positionType ∈ {WIDE_INT, PSRDIFF,
     NARROW_FLOAT}` → warning；
  5. 另外 `checkTrackingRagState`：跟踪卫星数 `>=4` → good，`<4` → **bad**（覆盖上面结论）；
  SPAN 支持时再与 `spanStatus.spanRAGColor(tab)` 取"坏中取坏"
  `[观察] :383-395`。
- **设备灯**：`deviceRAG` 由 CPU 占用决定
  `[观察] gritStatusBar.js:407-410`：`80 < x ≤ 90` → warning；`x > 90` → bad；否则 good
  （"为什么是黄/红"弹窗用的是另一套边界 `≥80 && <90` / `≥90`，`[观察] :787`）。
  日志状态 `loggingRAGIndicatorColor` 为 `bad` 时也红
  `[观察] :413-421`（`fileStatusEnum` 判定见 `:92-106`：OEM7 只要枚举 1 就 good、
  枚举 4/6 为 bad；OEM6 枚举 0 为 good、2/3 为 bad）。
- **干扰/欺骗/压制并入设备灯**：若 `itkState`/`spoofing`/`jamming` 任一为 Detected，
  按 7 种组合给出黄/红与文案
  （`INTERFERENCE / SPOOFING / JAMMING / INTERFERENCE + SPOOFING / INTERFERENCE + JAMMING /
  JAMMING + SPOOFING / INTERFERENCE + JAMMING + SPOOFING`），
  单独 interference 且 CPU>90 时也升为红 `[观察] :422-485`。

### 6.4 事件（gritEvents）判定与刷新

事件统一对象（两条流水：`EventHandlerObject`=当前，`historicEventObj`=历史）：
`{startTime, state:"Good"|"Moderate"|"Poor", alive:bool, description:"data-lang-…",
actualStr, endTime, freqValue, poiname}`，`eventId = <时间戳ms>_<事件名>`
`[观察] gritEvents.js:1643-1745`。

| 事件 | 判定 | 引用 |
|---|---|---|
| 位置标准差（BESTPOS） | PPP/PPP_CONVERGING：lat/lon ≤0.1 且 height ≤0.15 好；RTK 系：≤0.4/0.4/0.6；PSRDIFF：≤0.5/0.5/0.75；WAAS：≤0.9/0.9/1.3；SINGLE：≤2/2/4（米） | `:830-867` |
| INS 标准差（INSPOSX） | INS_PPP 同 PPP；INS_RTKFIXED/FLOAT 0.4/0.4/0.6；INS_PSRDIFF 0.5/0.5/0.75；INS_SBAS 0.9/0.9/1.3；INS_PSRSP 2/2/4 | `:1465-1499` |
| 星座跟踪不足 | 每系统"参与解算"卫星数 <4 → Poor；SBAS 且配置了 SBAS 时 <1 → Poor（`channelTrackingStatus & 0x1f ∈ {0x04,0x0b}` 才算参与解算）；串口连接需连续 2 次才报 | `:1010-1040, 1043-1152` |
| L-Band 无信号 | `LBANDTRACKSTAT` 里 `name !== ""` 的条目数 <1 → Poor（仅配置含 PPP 时才判） | `:1154-1204, 750-754` |
| 硬件越限 | `boundaryLimit ∈ {1,3}` → Moderate，`2` → Poor，`4` → upperPoor；`rxstatus3bit==1`（供电状态位）时一律 Good；覆盖 3V3/1V2/1V8/供电电压/天线电压/天线电流/主温度/副温度 | `:1208-1337, 1531-1543` |
| 干扰 | `ITDETECTSTATUS` 里 `detectionType==SPECTRALANALYSIS` 的 `centerFrequency` 四舍五入后进集合即 Moderate；离开即关闭 | `:1339-1358, 775-807` |
| 欺骗 | `rxstatus9bit == 1` → Poor | `:1369-1399, 1510-1518` |
| 压制 | `rxstatus15bit == 1` → Poor | `:1400-1464, 1520-1528` |
| 型号/授权无效 | `RXSTATUSEVENT.description` 变为 `MODEL INVALID FOR THIS RECEIVER` / `INVALID AUTHORIZATION CODE` | `:869-907` |
| POI 进入/退出 | 见 §6.5 | `:607-674` |

刷新节奏：

- 事件列表渲染在 `updateData` 内随日志驱动（`BESTPOS`/`TRACKSTAT`/`LBANDTRACKSTAT`/`HWSTATUS`/
  `INSPVAX`/`RXSTATUSEVENT`/`RXSTATUS`/`ITDETECTSTATUS` 各一条分支）
  `[观察] gritEvents.js:728-771`；
- 时间轴标记每 **4 s** 重排（`setInterval(moveEventsOnTimeline, 4000)`）
  `[观察] livePlayback.js:17, 273-276`；
- 通知横幅 **5 s** 自动淡出（`fadeOut(300)` 前 `setTimeout 5000`）；**HIGH_CPU** 事件例外：
  延迟 **7 s** 后再弹，且要求 `cpuRAGCheck` 为真 `[观察] gritEvents.js:2221-2271`；
- 首连 10 s 内不弹通知（`delayEventsNotifications` 置 `false`，10 s 后置 `true`）
  `[观察] :2539-2547`；
- loading 结束后再等 **2 s** 才允许首屏事件弹窗（`setEventNotificationFlag` 里 50 ms 轮询
  `#loader` 与 `.translucent-layout` 均隐藏，再 `setTimeout 2000`）`[观察] :2549-2561`；
- 免打扰（snooze）支持 30 min / 1 h / 2 h / 整个会话（`snoozeTime == 1000` 表示本会话）
  `[观察] :2650-2673`。

### 6.5 POI 进出判定

```
条件 1：最近一条 BESTVEL 的 horSpeed > 0.1（m/s），否则整轮跳过
        （静止时不产生进出事件）
条件 2：POI.notification != "none" 且 POI.status 为 "active"
判定：  旧版 mapLayer.isPositionInPOI = 球面距离(pos, poi) <= poi.radius
        LuCIAD  luciadPositionOverview.checkEntryExit（内部状态变化才返回非 null）
事件：  进入 → 生成 "Moderate/Entered <name>"，5000 ms 后自动置 alive=false（关闭）
        离开 → 生成 "Moderate/Exited <name>"，同样 5000 ms 后关闭
```
`[观察] gritEvents.js:607-674`、`mapLayer.js:128-137`、`luciadPositionOverview.js:807-834`。

### 6.6 频谱视图状态机（band / plot / filter）

`spectViewerObj[tab]`：
`{bandSelected:"SUPERWIDEBAND", passbandSelected:"", plotType:"spectrumPlot",
plotView:"SUPERWIDEBAND", stepSize:{…}}` `[观察] spectrumViewer.js:19-51`。

- 视图切换：`spectrumPlot` / `waterfallPlot`（`multiDimensionPlot` 3D 入口已在 HTML 里注释
  `[观察] spectrumViewer/spectrumViewer.html:28-31`）；
- 由 `SUPERWIDEBAND` 缩到某 band（L5/L2/L1/LBAND）时，`plotBandSamples[tab][band]` 逐帧更新、
  `updatePlotTraces("LBAND",tab)`；`bandRanges` 决定每个 band 落在 `x` 还是 `x2`
  （`NovatelIdConstants.BandRanges` 的 `xaxisRef`）`[观察] spectrumPlot.js:164-198, 859-874`；
- 瀑布：`sampleLimit = singleView ? 10 : 20` 帧、每帧 y 整体 +1（`yStep=1`，纵轴 0–10）
  `[观察] spectrumPlot.js:39-40, 2904-2912`；
- 加滤波器弹窗打开时 `getPlotElementDetails` 把绘图目标切到 `addFilter-<tab>-graph`
  `[观察] spectrumPlot.js:300-303`。

---

## 7. 与其它子系统的耦合点

### 7.1 GRIT → 主程序（被调用的函数名）

`gritJarvisInterface` 及全部 GRIT 组件对主程序的调用（去重）`[观察]` 全目录 grep 结果：

| 被调 | 用途 |
|---|---|
| `jarvisInterface.createComponent(name, tab, containerId)` | 载入组件 html+js（内部 `<tab>` 路径分派见 `jarvisInterface.js:4780-4814`） |
| `jarvisInterface.createTile(tab, index)` | 建 GRIT 瓦片（`tile-<index>-<tab>`） |
| `jarvisInterface.createPlaybackComponent(tab)` | 回放控件 |
| `jarvisInterface.connectionDetailsMap[tab].type` | 判定 `playback` / `Serial` / `Network` |
| `jarvisInterface.tabids[tab]` | tab ↔ 设备磁贴 id |
| `jarvisInterface.cachedData[tab]` | 非当前 tab 的日志缓存（`gritStatusBar`/`spectrumPlot`/`gritPositionStatusmodes` 三段） |
| `jarvisInterface.sendLogCommand(msg, "THISPORT_30", tab)` | 下发 log 命令 |
| `jarvisInterface.parseLiveDataInPbMode(dataview,msgid,tab)` | 回放/边播边实时解析 |
| `jarvisInterface.getLogTimeStamp(data)` | 从 28 B 头取 GPS 周/毫秒并转本地时间 |
| `jarvisInterface.checkPersistPage(tab, connectionLost)` | 恢复瓦片布局 |
| `jarvisInterface.checkForInvalidModelAndAuth(rxStatusEventData[tab])` | 型号/授权弹窗 |
| `jarvisInterface.applyUserLanguagePreference(lang,tab)` | 语言 |
| `jarvisInterface.darkModeColorCodes(key)` | 主题色 |
| `jarvisInterface.getCurrentTab(elem)` / `sortAlphaNum` / `toFixedDecimal` / `maxLogpopup` / `compRegister` / `configObject` / `handleLoader` / `reEstablishConnection` / `handlePlaybackRewindForwardStart` / `getPlaybackRenderFlag` | 零散工具 |
| `controller.requestlog(tab, cmd)` | 直接发文本命令（`log … once`、`log thisport itdetectstatusb once`） |
| `controller.closeConnection(tab)` | 关闭连接（由主程序侧调用，见 §7.2） |
| `genericConfig.placeCmdReq(name, map, tab)` / `sendCommand` / `setcurrentConfigName` / `removeFeatureFrmCmdList` / `commandResponseHandler` / `saveConfigCommandSending` / `unloggingLogsOnWCOM` / `getMessageId` / `frameUnlogDataMap` | 命令组包与应答状态机 |
| `genericView.updateView(data, fields, "gritStatusBar")` / `createDialog` / `showLoadingScreen` / `closeApplyingScreen` / `closeStatusBanner` / `formatToSystemLocale` / `getCommaLocale` / `getLogsCount` / `isLogsSpaceAvailable` / `showMaxLogsReachedPopup` / `deleteElementIds` / `loglistData` | 视图工具 |
| `featuresList.getSpoofingSupported / getITKMitigationSupported / getSPANSupported / getPositionModesSupported / getReceiverGeneration / getGPSCardPSN / getEnclosurehardwareVersion / getMarinePakSupported / isFeaturesListReady / isFirmwareSupported / isOEM7Supported / gritFirmwareCheck` | 能力判定 |
| `serverModel.isMapSupported() / isLuciadAvailable()` | 地图分支 |
| `positionModes.getConfiguredModes / getActiveModes / getOperatingMode / getLatestConfiguredModes` | 位置模式 |
| `ConstellationHandler.{satvisData,trackStatData,bestSatsData,chanconfigList}` | 信号矩阵数据源 |
| `spanStatus.{updateSpanStatus,spanRAGColor,decodeSPANRagMessages}` | SPAN 状态 |
| `deviceInfo.updateView` | 设备信息瓦片 |
| `networkingSettings.dc_updateData` | 网络页（**主程序**模块，不是 GRIT 空壳） |
| `terminalConsole.*` | 终端页 |
| `playbackControl.getBinaryLogList` | 回放文件里有哪些日志 |
| `emitter.emit('gritStatusBar' | 'spectrumPlot' | 'gritPositionStatusmodes', payload)` | 见 §4.1 |

### 7.2 主程序 → GRIT（反向调用）

`[观察]` 全仓库（排除 `view/GRIT/` 自身）：

- `jarvisInterface.js`：`checkGritConnectionReady`(2888)、`gritConnectionSuccess`(3047, 3720, 3757)、
  `gritlogProcess`(4113 附近)、`createGritMainPanel`、`gritCompReqlogs`、`getGritCompLogsRegister`、
  `getGRITSpecificLogs`、`getGRITPlaybackFileHeader`、`getGRITPlaybackDataStartHeader`、
  `handleGRITLandingPageCommandResponse`、`handleTabAfterLoadingHtml`(5079)、`OnPlaybackPlayPause`、
  `resetDataObject`、`processLanguage`(1378)、`showITKBlockedDialog`、`applyDarkModeChanges`、
  `checkActiveGRITConnection`、`activeGRITConnections`、`deepCompareObj`、`gritFirmwareNotSupport`(6240)；
- `view/deviceManagement/deviceManagement.js`：`NovatelIdConstants.gritSupported` 分支 7 处
  （243, 511, 636, 1055, 1064, 1381, 1755）；
- `view/html/setUpMonitor.html`：`gritConnectionSuccess`(1557)、`gritFirmwareNotSupport`(732)、
  `gritlandingPage.*`、`NovatelIdConstants.currentActiveApp="GRIT"`(769)；
- `controller/communication.js`：`jarvisInterface.unsupportdGRITReceiver`(386)，
  并在 `resetGritTilesData` 里逐个 `resetDataObject` 掉 GRIT 组件
  （`gritlandingPage.removeTab`、`addPOIDialog.resetPOIDialogData`、`signalMatrix.resetDataObject`、
  `spectrumViewer.resetDataObject`、`mitigationAssistant.resetDataObject`、`listView.resetData`）
  `[观察] communication.js:375-384`。

### 7.3 与"非 GRIT"模块的重名/共享关系（易踩坑）

- `pointsOfInterest`、`listView`、`triggers`/`triggerSettings`、`gritDisplaysSettings`、
  `positionOverview`、`addPOIDialog`、`gritlandingPage` 这些**全局名**在 GRIT 与 SM 两套里同名，
  靠"加载了哪个 js"区分；两者不能同时加载（`index.html` 只在启动时选一次）。
- GRIT 目录里的 `networkingSettings/*` 是空壳，`createComponent('networkingSettings',…)` 会解析到
  `app/view/networkingSettings/`（82 KB 的真实实现）`[观察] jarvisInterface.js:4807-4809`；
  `deviceInfo`、`spanStatus`、`terminalConsole` 同理 `[观察] :4804-4812`。

---

## 8. 复现清单

> 每条都是可验收断言。`[观察]` 可直接对源码；`[推断]` 标了推理链。

**A. 启动条件（R1–R10）**

- `R1` 目录 `app/view/GRIT` 不存在时，`NovatelIdConstants.gritSupported = false`，且
  `#home-grit` 与 `#grit-welcome` 都被 `display:none`；存在时置 `true` 并把 1 个 css + 17 个 js
  追加到 `<head>`（顺序见 §2.1）。`[观察] 01_解包/app/view/html/index.html:1126-1176`
- `R2` GRIT tab 只有在机型命中白名单时才允许连接：`OEM729/OEM719/OEM718D/PWRPAK7/OEM7600/
  SMART7/OEM7500/CPT7/SMART2/OEM2500/MarinePak7` 或以 `PWRPAK7`/`OEM7`/`SMART7`/`SMART2`/
  `OEM2500` 开头；否则 `showGRITnotSupported` 弹 `NOT_SUPPORTED_GRIT` 并关连接。
  `[观察] 01_解包/app/model/featuresList.js:1340-1346`、`01_解包/app/jarvisInterface.js:3844-3847`
- `R3` 固件门禁：`firmwareVersion.substr(2,1) < 7` **或** `substr(5,2) < 7` 时判为不支持，
  提示文案为 `NOT_SUPPORTED_GRIT_FIRMWARE`。`[观察] featuresList.js:1310-1322`、
  `jarvisInterface.js:3288-3298`
- `R4` `showGRITnotSupported` 必须同时做 5 件事：弹 dialog、`deletePackeryInstances`、
  `deleteTabDetails`、`delete inprogresstabs[tab]`、置 `unsupportdGRITReceiver[tab]=true`、关连接。
  `[观察] jarvisInterface.js:3299-3309`
- `R5` `unsupportdGRITReceiver` 一旦置真就不再清除；`closeConnection` 读到 true 时整段跳过
  unlog/清理逻辑。`[观察] jarvisInterface.js:21,3306`、`communication.js:386-393`
- `R6` LongHorn（PIM222A）在 GRIT 下直接判为不支持；非 GRIT 下则按 PIM222A 设备接管。
  `[观察] jarvisInterface.js:2902-2920`
- `R7` `spoofingSupport == false` 时隐藏 `#menuConfig`（欺骗配置页签）；
  `itkMitigationSupport == false` 时不显示"Add filter"。`[观察] gritJarvisInterface.js:748-750`、
  `spectrumViewer.js:266-274`
- `R8` 以太网能力为假时隐藏 `#gritNetworkingSettings`；地图不可用且无以太网时连 `#menuSettings`
  一起隐藏。`[观察] gritJarvisInterface.js:778-787`
- `R9` LuCIAD 分支判定只看 `getMapConfigObj().mapType.toLowerCase() === "luciad"`；
  配置 20 次×100 ms 仍未就绪则按 `false` 处理（走旧版）。`[观察] serverModel.js:25-45,68-87`
- `R10` LuCIAD 许可不可读时**不降级**：`license-loader.js` 无 try/catch，`readFileSync` 抛错即
  module 加载失败；后续 `createMapInstance` 抛错被 `catch` 吞掉只 `console.error`，
  地图区空白，页面不会切回旧版。`[观察] luciadPositionOverview/src/license-loader.js:1-6`、
  `luciadMapLayer.js:571-684`

**B. 门面接口与时序（R11–R18）**

- `R11` `gritJarvisInterface` 必须导出恰好 34 个键，名单见 §4.1（多一个/少一个都算不符）。
  `[观察] gritJarvisInterface.js:1603-1642`
- `R12` `gritlogProcess` 对不在 `gritLogs`（`gritCompRegister` 全部 msgId 去重）里的 msgID
  必须**直接 return**，不做任何 UI 更新。`[观察] gritJarvisInterface.js:866-868`
- `R13` 连接就绪时序固定为：同步建菜单/事件/状态栏 → 200 ms 显示面板 → 500 ms（仅 LuCIAD）
  建地图 → 1500 ms 更新事件与无效型号检查。`[观察] gritJarvisInterface.js:745-762`、
  `:366-374`
- `R14` `gritCompReqlogs` 生成的命令必须形如
  `log thisport_30 <KEY去掉末尾b并大写> <TRIGGER> <PERIOD>`，且 trigger/period 来自
  `gritCompLogsRegister` 的 `"<trigger>,<period>"` 拆分。`[观察] gritJarvisInterface.js:1236-1253`
- `R15` `triggers` 的日志请求只覆盖用户配置过的 MARK 类型；`mark1pos` 必须当作 `markpos` 处理。
  `[观察] gritJarvisInterface.js:1226-1235`
- `R16` 非当前 tab 的 `gritStatusBar` 数据必须进 `jarvisInterface.cachedData[tab].gritStatusBar`，
  切回时由 `gritLoadCachedData` 重新 emit 并清空该字段。`[观察] :1372-1389, 1310-1337`
- `R17` waterfall 视图下，`1968/2063` 的缓存必须最多保留 **30 帧**（超出 `shift()`），
  且加滤波器弹窗打开时**不缓存**。`[观察] :1403-1414`
- `R18` `refactorPOIObjects` 用 6 位小数坐标去重，坐标相同的 POI 只保留第一个（按
  `Object.entries` 顺序）。`[观察] :1565-1580`

**C. 频谱链路（R19–R28）**

- `R19` `ITPSDFINAL`/`ITPSDDETECT` 的样本必须按 `raw/256 - 200` 计算，单位 dBm；
  `raw=18944` → `-126.0`。`[观察] logparsers.js:1134-1135, 1164-1165`
- `R20` 频率必须按 `frequencyStart + m*(stepSize/1e6)` 计算，单位 MHz；`frequencyStart=1575.42`、
  `stepSize=2000` 时第 1 个 bin 为 `1575.422 MHz`。`[观察] logparsers.js:1127,1136`
- `R21` RBW 等于 `stepSize`（Hz），应用侧不做任何换算；`fftSize` 只在命令端出现
  （1K…64K ↔ 0…6）。`[推断] 由 R20 的单位一致性推出`、`[观察] NovatelIdConstants.js:2388-2396`
- `R22` 只有 `sequenceId === 0` 的帧能触发绘图；同 `sequenceId` 重复到达必须丢弃；合并时按
  `Object.keys(...).reverse()` 顺序展开。`[观察] spectrumPlot.js:336-375`
- `R23` 纵轴自动定标：负值下界取到"末位 1"、上界取到"末位 9"，首次各外扩 10 dB；
  仅在越界或上下界变化 >30 dB 或 频率改变 时重算。`[观察] spectrumPlot.js:1809-1903`
- `R24` 瀑布色标固定 `zmin=-135 / zmax=-30`，断点 `-120/-105/-90/-75/-60/-45`，
  两端追加 `#6929C4`（0）与 `#DA1E28`（1）。`[观察] spectrumPlot.js:2795-2806`
- `R25` 瀑布最多保留 `singleView?10:20` 帧，每帧 y 递增 1，纵轴 `0–10`。
  `[观察] spectrumPlot.js:38-40, 2904-2912`
- `R26` 频谱分辨率只接受 `1/2/4/8/16/32/64`；非 `PREDECIMATION` 模式下上限 32 且 64 会被降为 32。
  `[观察] spectrumViewer.js:31-37, 748-760`
- `R27` `updateRate` 最小 0.05 s；FFT=32K 时最小 0.1 s、64K 时 0.2 s；瀑布视图强制 ≥1 s。
  `[观察] spectrumViewer.js:725-747, 702-722`
- `R28` 串口连接必须把高级设置四个控件禁用，并把 `ITSPECTRALANALYSIS` 参数强制为
  `fftSize=1K, timeAvg=10, subCarrierAvg=5`。`[观察] spectrumViewer.js:211-214`、
  `gritJarvisInterface.js:1299-1303`

**D. Signal Matrix（R29–R33）**

- `R29` 行＝星座，顺序固定 `GPS, GLO, GAL, BDS, QZSS, NAVIC, TSC, SBAS`；
  列＝频段，顺序固定 `L5, L2, L3, L6, L1, LBAND`，但 **L3/L6 不渲染**。
  `[观察] signalMatrix.js:4, 199-205, 217-224`
- `R30` 每个单元格最多 15 个色块（`MAXLIMIT=15`），数量＝该星座该频段参与解算的卫星数。
  `[观察] signalMatrix.js:22, 524-546`
- `R31` C/N0 → 颜色：`>60` 或 `(20,35)` → amber；`>35`（即 36–60）→ green；
  `≤20` 或 `==35` 或其它 → red。`[观察] signalMatrix.js:378-383`
- `R32` L-Band（TSC）另用一套阈值：`C/No>39` → green，`36<C/No<39` → amber，其余 red；
  且只统计 `frequency>0 && trackingState==2` 的条目。`[观察] signalMatrix.js:461-477`
- `R33` 干扰命中时：受影响星座的频段标签必须有黄色描边（`1px solid rgb(245,166,35)`），
  星座名文字加 `interference-defect-text-field` 类；颜色映射表
  `GLOL3→GLOL5, BDSB3→BDSL2, GALE6→GALL2, QZSSL6→QZSSL2, E1→L1, E5A/E5B/ALTBOC→L5,
  E6→L6, B1C/B1→L1, B2A→L5, B2B/B2→L2, LBAND→TSCL1`。`[观察] signalMatrix.js:747-775, 563-588`

**E. Mitigation Assistant / 欺骗（R34–R38）**

- `R34` 只有 `detectionType == "SPECTRALANALYSIS"` 的干扰条目进 `dataObject.Interference`，
  `STATISTICALANALYSIS` 必须被 `continue` 跳过；key 为 `<rfPath>_<round(centerFrequency)>`。
  `[观察] mitigationAssistant.js:184-218`
- `R35` `filterApplied` 变为 1 的条件：干扰频率落在任一 `progFilters[k].lowerCutOffFrequency …
  upperCutOffFrequency` 之间（闭区间）。`[观察] mitigationAssistant.js:229-246, 286-302`
- `R36` 欺骗卡生成条件是 `rxstatus9bit == 1` 且状态发生跳变；同一事件只生成一次（已存在
  `"Spoofing"` 键则 return）；bit 回 0 时删除该卡。`[观察] mitigationAssistant.js:343-406`
- `R37` 压制卡生成条件同上但用 `rxstatus15bit`。`[观察] mitigationAssistant.js:447-477`
- `R38` 摘要栏欺骗文案三态：`aux3status25bit==1` → "Not calibrated"；
  `SKDETECTCONFIG mode==DISABLE` → "Detection disabled"；否则按 bit9 显示
  Detected/Not detected。`[观察] gritStatusBar.js:205-241`

**F. 地图 / POI / Triggers（R39–R44）**

- `R39` POI 与 Trigger 都存在 `userSettings.json` 的 `app.poi[<tabid>] = {manual, triggers}`，
  每条含 `name/radius/lat/lng/notification/visible/status/type`，`name` 最长 16 字符。
  `[观察] triggers.js:319-352`、`listView.js:1644-1658`、`userStore.js:5,86-89`
- `R40` Trigger 半径合法区间 `0 ≤ radius ≤ 99999`；重名（跨 manual+triggers）必须报错且不提交。
  `[观察] triggers.js:428-456`
- `R41` 同一 MARK 日志只能有一条 Trigger：改类型或改名时旧的必须被删除。
  `[观察] triggers.js:336-349`
- `R42` POI 进出事件必须满足 `horSpeed > 0.1`，且事件 5 s 后自动关闭；
  `notification=="none"` 或 `status!="active"` 时不产生。`[观察] gritEvents.js:607-674`
- `R43` 旧版判定"在 POI 内"用球面距离 `<= radius`；LuCIAD 版用 `checkEntryExit` 且只在
  状态变化时返回非 null。`[观察] mapLayer.js:128-137`、`luciadPositionOverview.js:807-834`
- `R44` Display 设置 11 项的默认值与取值域必须与 §3.8 表一致；Apply 时合并进
  `app.gritDisplay[<tabid>]` 并调用对应 positionOverview 的 `setDisplaysConfiguration`。
  `[观察] displaysSettings.js:3-15, 304-318`

**G. 事件与状态栏刷新（R45–R48）**

- `R45` 事件通知横幅 5 s 自动淡出；`HIGH_CPU` 事件延迟 7 s 且需 CPU RAG 命中；首连 10 s 内
  不弹；loading 结束后 2 s 才允许弹。`[观察] gritEvents.js:2221-2317, 2539-2561`
- `R46` 事件历史显示上限可设 5/10/20/50/100，并写入
  `app.deviceManagement.devices[<tabid>].eventHistoryLimit`。`[观察] gritEvents.js:152-153, 553`、
  `:2685-2689`
- `R47` 设备 RAG：CPU 占用 `80 < x ≤ 90` → 黄，`>90` → 红（"为什么"弹窗用 `≥80 && <90` / `≥90`）；
  定位 RAG：参与解算卫星 `<4` → 红。
  `[观察] gritStatusBar.js:407-410, 787, 725-734`
- `R48` 两灯合成规则与 7 种干扰组合文案必须与 §6.3 一致（单干扰黄、其余红）。
  `[观察] gritStatusBar.js:422-521`

**H. 回放与录制（R49–R51）**

- `R49` 历史文件路径 `<userData>/liveplayback/<tab>_historyFile.GPS`，只保留 10 min，
  每 60 s 落盘，时间轴标记每 4 s 更新。`[观察] livePlayback.js:11-18, 269-349`
- `R50` 录制文件必须依次写入 `HEADER - NAS GRIT FILE`、按毫秒排序的前置日志、
  `HEADER - DATA START`、10 min 数据；文件名 `<PSN>_<ISO时间>.gps`。
  `[观察] livePlayback.js:776-805, 759-763`
- `R51` 前置日志只收集 trigger ≠ ONTIME 的日志，且排除 `1968` 与 `1335`。
  `[观察] livePlayback.js:42-60`

**I. 两套实现的边界（R52–R55）**

- `R52` `triggers/luciad/triggers.js` 与 `triggers/triggers.js` 只在两处不同：
  `[观察] triggers/triggers.js:343,561` 的 `positionOverview.onPOIchanged` 在
  `triggers/luciad/triggers.js:343,561` 变成 `luciadPositionOverview.onPOIchanged`。
- `R53` `displaysSettings/luciad/displaysSettings.js:315-316` 与旧版
  `displaysSettings/displaysSettings.js:314` 的差异只有 `setDisplaysConfiguration` 的目标对象。
- `R54` `pointsOfInterest/luciad/pointsOfInterest.html` 与旧版 html 同时存在，但只有
  `pointsOfInterest` 会被 `createComponent` 做"luciad 目录"特判；`triggers`、`displaysSettings`
  没有 luciad html，必须复用同一份 html。`[观察] jarvisInterface.js:4792-4800`、
  目录清单
- `R55` GRIT 的 `networkingSettings` 目录内容不得被当作真实实现：它是 3 行占位 html，
  实际页面来自 `app/view/networkingSettings/`。`[观察] GRIT/networkingSettings/networkingSettings.html:1-3`、
  `jarvisInterface.js:4807-4809`

**J. 许可（R56）**

- `R56` LuCIAD 许可文件路径为 `<bundle>/node_modules/@luciad/ria/util/License.js` 的
  `setLicenseText` + 同目录 `luciadria_deployment.txt` 全文；许可参数
  `version=2026.0, licenseType=deployment, expiryDate=2045/12/31, serialNumber=afcb3e00`。
  `[观察] license-loader.js:1-6`、`luciadria_deployment.txt:1-14`

---

## 9. 未解之处（缺什么证据）

1. **`stepSize` 的真实单位**只由"与 MHz 相加"推断为 Hz，缺少接收机侧文档/实测报文佐证。
   要确定需要：一份真实 `ITPSDFINAL` 二进制样本 + 同时间 `ITSPECTRALANALYSIS` 的
   `frequency/fftSize`，或 NovAtel OEM7 手册中 ITPSDFINAL 字段表。
2. **`sample` 到底是 dBm 还是 dBm/Hz**：代码只写 `- 200` 且唯一单位标注是 UI 悬停的 `dBm`。
   要确定需要：一份已知功率的注入测试记录（信号源 + 衰减器），或手册中该字段的量纲说明。
3. **`ITDetectStatusRFPath` 的完整映射表**只看到 `3→L2, 5→L5` 两行（`NovatelIdConstants.js:3635-3637`），
   `mitigationAssistant` 用 `rfPath.toString()` 直接当 key，缺少全表无法复现 `1/2/4` 的语义。
4. **`frameConstellationValues` 过滤后的 `supportedChanconfigFreq` 格式**（`GM+band` 拼接，
   如 `GPSL5`）与 `addFilterPopup.frameSupportedChanconfigFreq` 的返回是否严格一致，
   只核对了调用点，未逐行核对 `addFilterPopup.js:114-152`。
5. **`luciadPositionOverview` 的 2671 行图层实现（`luciadMapLayer.js`）**只读了地图创建/底图/provider 部分，
   `renderer.js`、`ShapePainter.js`、`gradientController.js` 的事件打点与渐变配色逻辑未展开，
   无法断言"干扰椭圆/事件标记的具体绘制参数"。
6. **`helpFile.html` 与 `noMapHelpFile.html` 的差异范围**未逐节对比（只确认前者更大、
   两者内容高度重合）。要确定"无地图版隐藏了哪些章节"需要做一次结构化 diff。
7. **`positionOverview.js`（旧版，2879 行）与 LuCIAD 版的行为差异**只对照了导出面与
   `checkEntryExit`/`markGritEvents` 的调用点；旧版的 `updateEvents`、`inActiveGradientColor`、
   `onPlaybackClick/onReplayClick` 未逐行核。
8. **`livePlayback` 的"缺帧补齐"路径**（`missedLiveData` / `writeLiveMissedDatabool` /
   `handleMissedData` 分支）只看到字段被初始化与 `gritJarvisInterface.handleMissedLivePlaybackData`
   的分发，未读 `livePlayback.js:400-750` 的补齐算法，无法断言"边播边实时"时丢包如何拼接。

---

## 10. 外部参考

内嵌帮助文档（`app/view/GRIT/helpFile/`）本身就是产品手册的 HTML 版，GRIT 相关章节：
`[观察] helpFile/helpFile.html`（行号为该文件内行号）

| 主题 | 章节 | 行 | 与代码的对应 |
|---|---|---|---|
| 进入 GRIT | "Open GRIT Monitor for a Device" | 6691 | §2.4 磁贴开关 |
| 摘要/状态 | "GRIT Monitor Dashboard"→ Summary Bar | 6845-6961 | `gritStatusBar` 全部字段（含"CPU Usage 显示接收机算力占用"、Spoofing 未标定显示 "Not calibrated" 与 §6.3 一致） |
| 时间轴 | "Timeline Bar" | 6962-6986 | `livePlayback` 10 min 缓冲、录制流程；"GRIT Monitor keeps a 10 minute running history" 与 `history_time_msec` 完全一致 |
| Mitigation Assistant | 同名小节 | 6987-7015 | 无干扰显示 Not detected；多条时列表；"Add filter" 按钮即 `addFilterPopup` |
| Signal Matrix | 同名小节 | 7017-7022 | "colored squares represent the number of signals"，干扰时星座名变黄 + 黄框（R33） |
| Spectrum Viewer | 同名小节 | 7024-7055 | 频谱/瀑布两种视图、坐标轴语义（"received signal strength (left vertical axis) over the signal frequency"、"time over frequency，强度用颜色"）与 §5.2/5.3 一致；**文档同样没有给出 dBm 单位**，与 R21 的"代码无 dBHz 换算"互为印证 |
| 滤波器 | "Filters / Notch Filter / Band Pass / Edit / Delete" | 7056-3830 区间 | `addFilterPopup` + `spectrumViewer` 的开关/编辑/删除流程；"Filters can not be applied to the LBand signal band" 对应 `spectrumViewer.js:280-294` 里 LBAND 隐藏右键加滤波 |
| 高级设置 | "Advanced Settings" | 3831-3853 | 4 个参数的语义与"32k→0.1 s、64k→0.2 s"限速（R27）；"串口连接不可用"（R28） |
| Events | "Events / Current / Historic" | 3854-3869 | 通知可关 30 min / 1 h / 2 h / 整会话（§6.4 snooze 选项完全对应） |
| 配置/欺骗 | "Configuration" | 7499-7517 | `spoofingConfiguration` 的标定-开关两阶段 |
| 回放 | "Playback" | 7518-7613 | 回放控件、录制回放 |
| 菜单 | "Menu → Dashboard/Configuration/Settings/Tools/Help" | 7614-7649 | `gritMenuBar.html:6-47` 五项一一对应 |
| 网络 | "Networking → Wi-Fi / Ethernet / Wi-Fi Hotspot" | 7650-7762 | 由主程序 `view/networkingSettings/` 提供（R55） |
| 地图设置 | "Map Settings / Points of Interest / List View / Map View / Triggers / Display" | 7763-8100+ | POI 字段（Name/Symbol/Radius/Latitude/Longitude/Notification/Visibility/Status/Triggered by）与 §3.7 完全对应；Display 各开关与 §3.8 对应 |

外部（非本仓库）资料：帮助文档自身引用了
`docs.novatel.com/OEM7/Content/Logs/MARKxPOS.htm` 与 `.../Commands/MARKCONTROL.htm`
`[观察] helpFile.html:7962-7965`（说明 Trigger 依赖接收机侧先配置 MARK 日志）。
本次**没有**拿到 NovAtel OEM7 手册 PDF 中 `ITPSDFINAL / ITPSDDETECT / ITDETECTSTATUS /
ITPROGFILTBANK / ITBANDPASSBANK` 的字段表，因此 §5 的单位结论只能停在
"代码观察 + 单位一致性推断"，见 §9 第 1–2 条。

---

## 11. 真机一轮（2026-10-31 12:05 UTC，OEM729 / OM7MR1002RN0000）

第一次把 GRIT 跑到真接收机上并留证：套件 2.11.0 → 应用启动器 → **GRIT Monitor** → Connect
（COM12）→ Open。截图 `00_来源/samples/grit/live-20261031/grit-dashboard.png`。

| 区域 | 实测显示 |
|---|---|
| Positioning | Good / `Single`，30.5399718°, 114.3528004°, Height (MSL) 63.79 m，Tracked **25**，Used **15** |
| Device | **Warning**，OEM729-2.03，CPU 24%，Interference **Jamming**，Time (UTC) 12:05:33 |
| 警告横幅 | `Interference is being detected at 1270Mhz.` / `Began today at 12:05:32 UTC` |
| Spectrum Viewer | 双窗（L5/L2/BDS B2B + L1），−40…−130 dB，1270 MHz 竖线 + 干扰图标；右轴 GPS/BDS/QZSS/SBAS |
| Signal Matrix | GPS/BDS/QZSS/LBAND/SBAS × L5/L2/L1，绿/橙/红/空心四态 |
| Position Overview | Map / Satellite 页签、`Add Point of Interest`、Timeline |

同一时刻用本仓库解码器读 USB2（`com11-live-8s.bin`，8 s / 487 830 B）：

```
RANGE:168  BESTPOS:9  RXSTATUS:3
BESTPOS: SOL_COMPUTED SINGLE num_svs=25 num_soln_svs=15 lat=30.539972065 lon=114.352801038
RXSTATUS: rx_error=00000000  status_words.count=5
```

`num_svs / num_soln_svs` 与界面 Tracked 25 / Used 15 逐一对应，`rx_error=0` 对应 Device 的
Good（警告只来自干扰，不是接收机错误）。回归用例：
`packages/protocol/test/grit-live.test.ts`。

**没覆盖到的**：干扰频率 1270 MHz 来自 GRIT 自己的频谱采集通道，这次抓包没有
`ITDETECTSTATUS`（该端口未订阅），要复现干扰判定必须同时录该日志与频谱数据。

---

## 12. 重实现补的三块：Map Settings / Terminal / Mitigation Assistant（2026-11-01 实测）

重实现（`04_重实现`）此前把手册 5.7 / 5.8 / 5.2.5 三块留成占位：Settings ▸ Map… 只弹一句
"没有底图渲染器"，Tools ▸ Terminal 直接把页签切到 Manage，Mitigation Assistant 只有一个
`Not detected` 文本。这次按手册补齐，并在浏览器里实测（无接收机，数据来自仓库里的抓包与
Graph 导出的 CSV）。截图与结论如下；详细交互契约见
`packages/app/test/grit-map.test.ts`（14 项）。

### 12.1 Map Settings（手册 5.7）

`Settings ▸ Map…` 打开三段式设置窗（原版 `mapSettings.js` 的 `.map-settings-tabs` +
`.totaldata` 三页），Position Overview 的齿轮按钮也开同一窗；`Add Point of Interest` 直接落到
POI 段。

| 段 | 内容 | 数据来源 |
|---|---|---|
| Points of Interest | 表格列照手册 List View：Name / Symbol / Radius / Latitude / Longitude / Notification / Visibility / Status / Triggered by，另有 Show、Active、Delete 三个行内动作 | **本机列表**，`localStorage` `nas.grit.map.poi.v1`；不来自接收机，也没有新增／`api` 路由（原版写在 Electron 的 `userStore.userStoreJSON.app.poi[tabid]`） |
| Triggers | Event / Point Name / Active 三列 + 空态说明 | **没有事件源**：不订阅 MARKxPOS、无实时会话；只报告本抓包里有没有 MARK 事件日志（`/api/logs` 的 `groups`） |
| Display | Graticule / Labels / Metric Grid / Scale Bar / North Arrow 五个开关 | 共享地图舞台 `/geo/luciad-stage.js` 的 `chrome` 参数（`{type:'chrome'}` 消息），存 `nas.grit.map.display.v1` |

POI 会真的画到 Position Overview 的 LuciadRIA 舞台上：新增 `{type:'pois', pois:[…]}` 消息，
舞台为此加了两层（`pois` 环+标记、`poi-labels` 名字），半径按手册画成圆
（`ringPolyline`，与 1σ 环同一套几何）。实测（`__luciadStage.storeSize()`）：

- 加一个带 6 m 半径的点 → `pois` 层 2 个要素（圈 + 标记），`poi-labels` 1 个；
- 加第二个 → 4 个；删掉第二个 → 回到 2 个、标签 1 个；
- 把该行 Show 关掉 → `pois` 层 0 个、标签 0 个（地图上确实消失），再打开回到 2 个；
- Status 关闭只改颜色（灰），仍留在图上 —— 与手册把 Show / Active 当两个开关一致。

Display 开关与舞台自报逐项对齐（`window.__gritPos.status().chrome` 与
`__luciadStage.status().chrome` 一致）：

| 操作 | 舞台 `chrome` | 画面 |
|---|---|---|
| 开机 | `graticule:true, labels:false, metric:true, scale:true, north:true` | GRIT profile：有经纬网、无经纬度文字 |
| 打开 Labels | `labels:true` | 出现 `114.35270°E` / `30.53998°N` 等刻度文字 |
| 关 Graticule + Labels | `graticule:false, labels:false` | 经纬线与文字一起消失（比例尺、指北针仍在） |
| 关 Scale Bar | `scale:false` | 左下角比例尺隐藏 |
| 关 North Arrow | `north:false` | 右上角 `N` 隐藏（读舞台 DOM `.north.hidden === true`） |
| 关 Metric Grid | `metric:false` | 1-2-5 m 网格消失 |

截图对照：`06-map-graticule-labels-on.png`（经纬网 + 标注开）与
`07-map-graticule-labels-off.png`（两者关）。两张都先把**米制网格关掉**，所以画面里唯一的变量就是
经纬网与标注；其余不变（同一视野、`2D Trajectory.csv` 的 5 点、1σ 1.34 m、同一个 POI 圈、比例尺
与指北针）。关掉后画面只剩轨迹、1σ 环、POI 与两件 HUD 仪表。

**没做到**：自绘回退图（`mapSvg()`，Luciad 起不来时用）不吃 `chrome` —— 它属于 Graph 面板的
导出函数，不在本次改动范围。Display 段因此写明"舞台已就绪 / 回退图不随之变化"。

### 12.2 Triggers 的事件源：按抓包如实报告

`/api/logs` 的 `groups` 里筛 `MARK\d*(POS|TIME)`，实测时 `/api/captures` 的 18 份样本里
**只有两份带 MARK 日志**：

- `live-20261031/b2-20261101.sbf` → `MARKPOS ×31`；
- `live-20261031/b4-20261101.sbf` → `MARK1TIME ×1`、`MARKTIME ×1`；
- 其余 16 份（含 `grit/live-20261031/com11-live-8s.bin`、`convert/clean-9600.gps`）没有任何
  MARK 日志。

于是 Triggers 段在两份抓包上给出两句不同的话（截图
`04-sheet-triggers.png` / `04b-sheet-triggers-marks.png`）：

- 无 MARK 的抓包：`没有事件源：clean-9600.gps 不含 MARKxPOS 事件日志，也没有实时会话…触发器列表为空。`
- b2：`b2-20261101.sbf 里有 MARKPOS ×31，但触发器需要接收机侧先配置好 MARKxPOS 才会产生事件…列表为空，只报告数据源。`

没有 Add / Apply：本 build 不写接收机，也不在图上打事件点，加一个存不进去的触发器没有意义。

### 12.3 Terminal（手册 5.8）

`Tools ▸ Terminal` 现在在 GRIT 面板内打开抽屉（右下角，压在 Timeline 条上方），**不再切页签**
（实测 `#tab-manage` 的 `aria-selected` 保持 `false`）。它与 Manage 的 Terminal 是同一个服务端
会话、同一个端点：

- 发命令 `POST /api/live/command`（`{line}`）；
- 回显 `/api/live/logs`：GRIT 面板本来就在轮询同一个游标，抽屉把那些 `entry.ascii` 原样追加，
  不另开连接；
- 连接行（Serial/Baud 或 TCP host/port、Connect/Disconnect）走 `/api/live/connect|disconnect`。

没有会话时如实报错，不伪造回显（截图 `08-terminal.png`）：

```
> LOG COM1 BESTPOSB ONTIME 1
! 未发送（没有实时会话）：not connected — 在 Manage ▸ Terminal 或本抽屉的 Connect 建立会话后重发。
```

`manage.js` 只导出 `mount/unmount`（且本次改动不许碰它），所以这里按同一套 DOM/行为契约重画了
第二个前台，而不是 import 一个组件。

### 12.4 Mitigation Assistant（手册 5.2.5）

值仍然是 `Not detected` —— 这些抓包里没有 ITK 报文，原版这时也只打印它；不编干扰类型、频率或
时间。补的是**交互**（截图 `00-mitigation-collapsed.png` / `09-mitigation-details.png`）：

- `Details ▾` 展开 / 收起（`aria-expanded` 同步），展开时瓦片收紧顶部留白让正文放得下；
- 正文写清手册的两个状态：没检测到时是 `Not detected`；检测到（干扰 / 压制 / 欺骗）时列出每一项
  及简要说明，点击进入 Interference details（查看详情、Add filter、上一条 / 下一条、返回列表）；
- 写明数据何时才会出现：**需要 ITK 报文**（接收机干扰监测通道上报，或重放带 ITK 的 GRIT 录制
  文件）；
- `Add filter` 标成不可用并说明原因（没有干扰条目）。

**没做到**：`remote-23types.sbf`、`b1`、`broad-clean.gps`、`usb1-broad-60s.bin` 里有
`ITDETECTSTATUS`（21 / 1 / 1 / 1 条），但该日志的字段与"干扰条目"的对应关系本次没有解，且它
不是手册所说的 ITK 通道；Assistant 因此仍然只用 `Not detected`，没有拿 `ITDETECTSTATUS` 去
冒充干扰判定。

### 12.5 回归与实测记录

- 新增 `packages/app/test/grit-map.test.ts`：14 项（Display→chrome 映射、脏 localStorage、
  POI 表单校验/增删/Show-Active、POI 图层消息、事件源筛选、触发器空态文案、Terminal 回声与
  "在 GRIT 内打开"、Map Settings 三段骨架、Mitigation 交互）。该文件 14/14 通过。
- 浏览器实测（Chromium，1706×1066，`http://127.0.0.1:7815`，LuciadRIA 2026.0 / WebGPU 就绪）：
  **0 console error、0 pageerror**；切换抓包、开关 Display、增删 POI、发命令各一轮。
- 起点基线：`node --test --test-force-exit "packages/*/test/*.test.ts"` 777 项全绿（本次改动前
  实测）。跑完本次改动后整套 828 项里有 6 项失败，全部落在 `config-endpoints` /
  `config-host` / `summary-counts`（"18 !== 15"，配置页数量）—— 这些文件正被别的会话同时改动，
  与本次改的三块无交集；本文件的 14 项与 `grit-position` / `grit-capture-spectrum` 全绿。

---

## 13. 干扰（ITK）与多频实测：2026-11-01 真机 b7 抓包

样本 `00_来源/samples/live-20261031/b7-20261101.sbf`（943 486 B，接收机时间 69 s，
OEM729-2.03 / `OM7MR1002RN0000`，COM10 = 接收机 **USB2**）。同一份抓包的套件产物三份：
`golden-b7-20261101.ASCII`（1 100 989 B）、`golden-b7-20261101.ABBREV_ASCII`（1 166 848 B）、
`golden-b7-20261101.Summary.txt`。脚本在 `逆向/tools/remote/`：`b7-capture.ps1`（抓包）、
`b7-probe2.ps1`（逐条探针）、`b7-flood.ps1`（端口洪流定位）、`b7-restore.ps1`（还原并读回）。
回归用例 `packages/protocol/test/live-b7.test.ts`（15 项）。

### 13.1 先要弄清"端口上为什么一直有 65 KB/s 的二进制"

第一次探针时每条命令只回一小段文本、后面跟着约 100 KB 的 `RANGE`（id 43，20 Hz）。查
`LOGLISTA` 才发现它们不属于我们：

```
USB2_29,RANGEB,ONTIME,0.050000,HOLD     ← 套件的多端口实例 29
USB2_29,BESTPOSB,ONTIME,1.000000,HOLD
USB2_30,ITDETECTSTATUSB,ONTIME,1.000000,HOLD
```

`UNLOGALL` 只清**本实例**名下的日志，动不了 `USB2_29` / `USB2_30` 这两个所有者。实测（每步 2 s）：

| 命令 | 之后 2 s 收到的字节 |
|---|---|
| （不动） | 175 054 |
| `UNLOGALL` | 143 677 |
| `UNLOGALL USB2` | 140 561 |
| `UNLOG USB2 RANGEB` | 143 557（无效：不是所有者）|
| `UNLOG USB2_29 RANGEB` | **1 797** |
| `UNLOGALL USB2_29` | **341** |
| `UNLOGALL USB2_30` | 341 |

结论：**在这台机器上收尾必须是 `UNLOGALL` + `UNLOGALL USB2_29` + `UNLOGALL USB2_30`**，
只发前两条等于没清（之前几批抓包里夹带的 `RANGE` 洪流就是这么来的）。`b7-capture.ps1` 在开始
和结束各做一遍。

### 13.2 命令 → 接收机原话 → 产物

裸查询（不带参数）几乎全被拒，`IT*` 命令要带齐参数才执行：

| 发出去 | 接收机回的原话 | 产物 |
|---|---|---|
| `ITSPECTRALANALYSIS` | `<ERROR:Message missing field` | — |
| `ITDETECTCONFIG` | `<ERROR:Message missing field` | — |
| `ITWARNINGCONFIG` | `<ERROR:Message missing field` | — |
| `CHANCONFIGLIST` | `<ERROR:Message missing field` | —（它是**日志**，不是命令）|
| `VERSION` | `<ERROR:Message missing field` | — |
| `ITFRONTENDMODE` / `ITBANDPASSBANK` / `ITPROGFILTBANK` | `<ERROR:Message is invalid for this model` | — |
| `SPOOFDETECT` | `<ERROR:Invalid Message ID` | 该机型无此命令 |
| `LOG ITFILTTABLEB ONCE` | `<ERROR:Message is invalid for this model` | 0 条 |
| `LOG ITDETECTSTATUSA ONTIME 1` | `<OK` | **47** 条 `#ITDETECTSTATUSA`（38 条带检测）|
| `LOG ITPSDFINALA ONTIME 1` | `<OK` | **47** 条，1024 点/条 |
| `LOG ITPSDDETECTA ONTIME 1` | `<OK` | **90** 条（1024 点 ×45、341 点 ×45）|
| `LOG ITDETECTSTATUSB ONCE` | `<OK` + **ASCII** `#ITDETECTSTATUSA,SPECIAL,…` | 1 条（见 §13.3）|
| `LOG ITDETECTCONFIGB ONCE` | `<OK` + `#ITDETECTCONFIGA,SPECIAL,…;ALL,0,0,0` | 1 条 |
| `LOG ITSPECTRALANALYSISB ONCE` | `<OK` + `#ITSPECTRALANALYSISA,SPECIAL,…;PREDECIMATION,GPSL1,200,2K,1,1` | 1 条 |
| `LOG ITPSDDETECTB ONCE` | `<OK` + 两条 `#ITPSDDETECTA,SPECIAL`（1202.537 MHz / 1024 点，1277.537 MHz / 341 点）| 2 条 |
| `LOG CHANCONFIGLISTB ONCE` | `<OK` + `#CHANCONFIGLISTA,SPECIAL,…` | 1 条 |
| `LOG RXCONFIGA ONCE` | `<OK` | 269 条 `#RXCONFIGA`（每行内嵌一条配置记录）|
| `ITWARNINGCONFIG 1` | `<OK` | 写入生效，随后 `RXCONFIGA` 读回 `;1,0` |
| `ITDETECTCONFIG ALL` | `<OK` | 生效（该机本来就是 `ALL`，等于没变）|
| `ITSPECTRALANALYSIS PREDECIMATION GPSL2 1000 1K 1 1` | `<OK` | 生效（抓包末尾，收尾已改回 GPSL1）|

### 13.3 `LOG <名>B` 在这些日志上会回落成 ASCII

`ITDETECTSTATUS` / `ITDETECTCONFIG` / `ITSPECTRALANALYSIS` / `ITPSDDETECT` / `CHANCONFIGLIST`
在本固件上**没有二进制形态**：请求 `…B` 时接收机回 `<OK`，然后送出的是 `#…A` 文本记录
（端口列写 `SPECIAL`）。产物文件名仍是 `.sbf`，内容里这几种记录是文本。ASCII 侧因此必须能把
它们当文本记录解析——`text-log.ts` 已经在做，`b7` 抓包是第一个同时含这五种的真实样本。

### 13.4 ITK 字段与套件逐行比：0 行不同

八类 ITK / 配置记录在 69 s 抓包里的条数，与套件 golden **逐字节相同**
（`packages/protocol/test/live-b7.test.ts` 第 1 项，`assert.deepEqual` 整行数组）：

| 记录 | 条数 | 说明 |
|---|---:|---|
| `#ITDETECTSTATUSA` | 47 | 38 条带检测，全部在 **L2** |
| `#ITPSDFINALA` | 47 | 1024 点 ×43、512 点 ×4 |
| `#ITPSDDETECTA` | 90 | 1024 点 ×45、341 点 ×45 |
| `#ITSPECTRALANALYSISA` | 1 | `PREDECIMATION,GPSL1,200,2K,1,1` |
| `#ITDETECTCONFIGA` | 1 | `ALL,0,0,0` |
| `#ITWARNINGCONFIGA` | 1 | `3,0`（抓包时刻的原值）|
| `#CHANCONFIGLISTA` | 1 | 5 组通道配置，含 `GPSL1L2PL5`、`BEIDOUB1B2B2B`、`LBAND` |

一条**统计法**检测（L2）与一条**频谱法**检测的原样：

```
#ITDETECTSTATUSA,USB2,0,77.0,COARSESTEERING,2443,35956.000,03808800,7fdb,18278;
  1,L2,STATISTICANALYSIS,6.826,0.448,1.040,0.333,00000000,00000000,00000004*2e83f762
#ITDETECTSTATUSA,USB2,0,78.0,COARSESTEERING,2443,35766.000,03809800,7fdb,18278;
  1,L2,SPECTRUMANALYSIS,1270.176,2.051,-38.877,-95.668,00000400,00000000,00000003*d275363b
```

字段与手册 `ITDETECTSTATUS` 一致：`numDetected`、频段枚举（`L1/L2/LBAND/L5`）、检测方法枚举
（`SPECTRUMANALYSIS/STATISTICANALYSIS`）、4 个参数（统计法是相对带宽/门限一类；频谱法是中心频率
MHz / 带宽 MHz / 峰值 / 噪底 dB）、两个掩码字（`severity1/severity2`）。

**覆盖度限制（如实记）**：本机只报 L2（38/47），L1 一条都没有；方法分布
`STATISTICANALYSIS` 25 次、`SPECTRUMANALYSIS` 13 次。室内的真实干扰源就在 1270 MHz 附近，
与 §11 里 GRIT 面板显示 "Interference is being detected at 1270Mhz" 一致。

### 13.5 Signal Matrix 为什么只有 L1：`sv_freq` 不表示频段

47 条 `#RANGEA`、每条 70 个观测（共 3 290 条），`sv_freq` 分布只有两个值：

| `sv_freq` | 观测数 | 是什么 |
|---|---:|---|
| 0 | 3 243 | 除 GLONASS / QZSS L1C/B 外的**所有**信号 |
| 203 | 47 | QZSS **L1C/B 的 PRN**（PRN 196，signal type 24）|

手册（OEM7 Commands and Logs v6A，RANGE 日志字段 4）原文：

> `glofreq` — (GLONASS Frequency + 7) … **For all signals except for GLONASS signals and
> QZSS L1C/B, this field will be zero.**

也就是说 `sv_freq`（= `glofreq`）**从来就不是"频段号"**。而多频其实是有的：一条 RANGE 里只有
19 个不同 PRN 却有 70 个观测，同一 PRN 的多个观测靠 `ch_tr_status` 的 **bit 21–25（signal type）**
区分。实测 GPS PRN 8 的 6 个观测：

```
系统 GPS  signal  0 = L1C/A   C/No 53.8
系统 GPS  signal 17 = L2C (M) C/No 51.1
系统 GPS  signal 14 = L5 (Q)  C/No 52.2
系统 BDS  signal  0 = B1(I) D1 C/No 52.3
系统 BDS  signal  9 = B2a (P) C/No 50.6
系统 BDS  signal 11 = B2b (I) C/No 51.4
```

另有一条 `系统 Other / signal 19 = L-band / glofreq 0`，即 L 波段通道。

所以"Signal Matrix 只画 L1/B1"**不是缺数据**，而是取错了字段：`packages/app/src/web/panels/grit.js`
按 `sv_freq` 映射 `FREQ_BAND = {0:'L1',5:'L2',9:'L5',205:'LBAND'}`，这套映射在本固件上永远
命中 `0 → L1`。要出现 L2/L5 列，需要改成读 `c_status` 的 bit 21–25（signal type），按手册的表
映射（GPS：0=L1C/A、5=L2P、9=L2P(Y)、14=L5(Q)、16=L1C(P)、17=L2C(M)；BDS：0/1/2=B1/B2/B3(D1)、
4/5/6=同左(D2)、7=B1C、9=B2a、11=B2b；Other 19=L-band）。**这一改动属于 `packages/view`/`app`，
不在本轮允许改动的范围**，这里只把证据和映射记下来。

### 13.6 与套件的整文件对比

| 格式 | 套件 | 我们 | 差异 |
|---|---:|---:|---|
| ASCII | 609 行 / 1 100 989 B | 631 行 / 1 104 413 B | 除 `#RXCONFIGA` 外**全部逐行相同**；`#RXCONFIGA` 套件 247 条、我们 269 条（226 条逐字节相同）|
| ABBREV_ASCII | 6 719 行 / 1 166 848 B | 6 780 行 / 1 172 518 B | 同上，差异全在 `#RXCONFIGA` 的嵌入块 |

`#RXCONFIGA` 是 `LOG RXCONFIGA ONCE` 的配置转储：每行内嵌一条完整记录
（`#RXCONFIGA,<头>;#LOGA,<头>;<正文>*内层CRC*外层CRC`）。两处实测差异：

1. **套件会把内嵌记录按字典重渲染**：`INTERFACEMODE` 的端口名 `LCOM1` 在套件输出里变成
   `UNKNOWN`（枚举里没有 `LCOM1`），所以那 43 行我们与它不同；另有 22 行套件整行丢弃。
2. **ABBREV 里内嵌块的内层 CRC**：套件把嵌入报文印成 `<     <名> <9 个头字段>` + 一行正文，
   正文末尾不带内层 CRC；我们把 `*<内层CRC>` 留在最后一个值后面。

顺带修好的一处（`text-log.ts`）：ABBREV 里**可変长标量数组**（`ITPSDFINAL`/`ITPSDDETECT` 的
1024 个采样）原来一个采样一行，`b7` 的 ABBREV 因此是 113 478 行 / 2 522 481 B；改完是
5 973 行 / 1 124 916 B（此时 `#RXCONFIGA` 还没回收）。把 §13.6 的 `#RXCONFIGA` 也补进来之后，
最终是 6 780 行 / 1 172 518 B，剩下的差异只有上面那两类。14 份既有 golden 仍逐字节相同。

### 13.7 收尾（实测回读）

改过的两处配置全部按 b1 抓包里 `RXCONFIGA` 记下的原值改回，并在同一会话里读回：

```
ITWARNINGCONFIG 3                                   → <OK
ITSPECTRALANALYSIS PREDECIMATION GPSL1 200 2K 1 1   → <OK
#RXCONFIGA,…;#ITWARNINGCONFIGA,…;3,0*…
#RXCONFIGA,…;#ITSPECTRALANALYSISA,…;PREDECIMATION,GPSL1,200,2K,1,1*…
```

`ITDETECTCONFIG` 抓包前后都是 `ALL,0,0,0`（没变）。收尾日志
`UNLOGALL` → `UNLOGALL USB2_29` → `UNLOGALL USB2_30` → `UNLOGALL USB2`，随后
`port-state.ps1`：`COM8 FREE / COM9 FREE / COM10 FREE`。

