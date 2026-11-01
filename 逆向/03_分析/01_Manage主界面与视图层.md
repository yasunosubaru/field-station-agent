# Manage 主界面与视图层

> 覆盖范围：NovAtel Application Suite 2.11.0 解包产物 `01_解包/app` 中的**表现层**——
> 顶部导航、welcome 落地页、Manage（原 setUpMonitor）页签与 tile 容器、全部 status tile 组件、
> 布局持久化（Packery/Draggabilly）、语言切换、加载器与弹窗。
> 不覆盖：报文解析（`model/logparsers.js`）、连接与串口（`controller/*`）、设备 CRUD
> （`view/deviceManagement`）、各 `*Config` 配置页内部逻辑——仅在「耦合点」一节列出被调用的函数名。

事实等级遵循 `03_分析/_约定.md`：`[观察]` 必带 `文件:行号`；`[推断]` 必写推理链；`[未知]` 必写缺什么证据。

---

## 1. 职责

视图层在 2.11.0 里承担 6 件事：

| # | 职责 | 主要实现位置 |
|---|---|---|
| 1 | 应用外壳：顶部导航（Home / Manage / Playback / Convert / GRIT Monitor + 设置 + 帮助）、splash、关于、反馈问卷 | `view/html/index.html:189-1034` |
| 2 | welcome 落地页：应用入口卡片、最近活动、广告轮播、客户满意度弹窗 | `view/html/welcome.html`、`view/js/welcome.js` |
| 3 | **Manage 主界面**：jQuery UI tabs（每个已连接设备一个 tab）+ 每个 tab 内 4 层容器（菜单栏 / 状态栏 / 状态 tile / 配置页） | `view/html/setUpMonitor.html`、`jarvisInterface.js:893` |
| 4 | 状态 tile 组件：statusBar、positionStatus、deviceInfo、spanStatus、alignStatus、portStatus、logStatus、radioStatus、interferenceStatus、satelliteView、pppCorrections、agcStatus（GIII）、2d-sd/height-sd（Longhorn）、satelliteTracking（page2） | `view/js/*.js` + 同名 HTML 片段 |
| 5 | tile 自由布局：Packery 网格 + Draggabilly 拖动 + 撤销横幅 + 恢复默认布局 + 按设备持久化 | `view/dynamicTiles/dynamicTiles.js` |
| 6 | 语言与主题：`data-lang-*` 属性标记体系、8 语言字典、darkMode 类切换 | `jarvisInterface.js:1350-1435`、`view/js/*.js` 的 `processLanguage()` |

一个容易误判的点：**本子系统不解析任何 NovAtel 报文**。它只接收上游已经解析好的
`jsonData` 并写进 DOM；唯一的「数值逻辑」是 DOP 计算与单位/小数位格式化（见第 5 节）。

---

## 2. 入口与加载顺序

### 2.1 进程侧到窗口

1. `main.js:78` `createWindow()`；`:81` 新建 `BrowserWindow`，`show:false`、
   `webPreferences:{ nodeIntegration:true, contextIsolation:false, backgroundThrottling:false }`。
   `[观察] 01_解包/app/main.js:81`
2. `main.js:102` `win.loadURL('file://'+__dirname+'/view/html/index.html')`。`[观察] main.js:102`
3. `main.js:128-131` `ready-to-show` 里 `win.show()`（`maximise` 在所有非 CLI 启动下为 `true`，
   由 `:95` 置位）。`[观察] main.js:128-131`
4. `ipcMain.on('updateAppBackgroundThrottling')` → `win.webContents.setBackgroundThrottling(flag)`
   已注册，但**渲染进程没有任何发送方**（全仓仅此一处出现该字符串）。`[观察] main.js:206-208`

> 注意 `main.js:81` 用到的 `w`/`h` 在 `:93-94` 才被 `var` 重新赋值，而 `:81` 先于赋值执行
> （`var` 提升为 `undefined`）→ 初始窗口尺寸参数为 `undefined`，实际尺寸由最大化决定。
> `[观察] main.js:11-12, 81, 93-95`

### 2.2 index.html 的静态脚本装配（决定全局对象可用性）

`view/html/index.html:86-183` 一次性顺序加载 76 个脚本，顺序即依赖顺序：

| 段 | 内容 | 行 |
|---|---|---|
| 1 | `module` 让位（`:86`）→ jQuery、jQuery UI、mousewheel、popper、bootstrap | 86-91 |
| 2 | plotly、pagination、packery、draggabilly、markerclusterer | 92-97 |
| 3 | model 层：userStore、4 套 MessageId 常量、MessageIdTweaks | 99-104 |
| 4 | controller：communication、playback | 105-106 |
| 5 | **`jarvisInterface.js`**（核心，`:107`） | 107 |
| 6 | model：constellation、logparsers、constellationHandler、featuresList、positionModes、common、Blob、FileSaver、jsin | 108-117 |
| 7 | `help.js`（1.34 MB 帮助文本，`:119`） | 119 |
| 8 | **view 组件脚本**（positionStatus…longhornStatusUI、addApplication、dynamicTiles、updateApplication） | 121-182 |
| 9 | `module` 复位（`:183`） | 183 |

两个必须知道的顺序事实：

- `jarvisInterface.js`（:107）在 `model/common.js`（:113）**之前**加载，但 `jarvisInterface`
  内部只在函数体里引用 `Common`，所以不报错；而 `genericView.js`（:138）在 `en.js`（:129）之后，
  所以它的 `processLanguage()` 能用 `__()`。`[观察] index.html:107,113,129,138`
- **`welcome.js` 不在上述清单里**。它由 `welcome.html:149` 的
  `<script src="./../js/welcome.js">` 在 `jQuery.load()` 注入时执行。`[观察] view/html/welcome.html:149, index.html:1121`
- `application.js` 与 `index.js` **没有被任何 HTML 引用**（`index.html` 脚本表中不存在，
  全仓只有 `index.js` 自己调用 `application.*`）。→ 二者是旧「每连接一个 BrowserWindow」
  架构的遗留死代码。`[观察] 01_解包/app/application.js:1-92、01_解包/app/index.js:1-31`

### 2.3 `$(document).ready` 的 8 步（`index.html:1111-1200`）

| 步 | 动作 | 行 |
|---|---|---|
| 1 | 不支持地图则隐藏 `#check-updates` | 1112 |
| 2 | `$(".splashscreen-text").text(serverModel.displayVersion)` | 1113 |
| 3 | 读 `Components.json` → `deviceManagement.setNASComponents()`（决定 playback/convert 是否存在） | 1114-1119 |
| 4 | `$('.welcome-layout').load("./welcome.html")`，随后**立即** `display:none` | 1121-1122 |
| 5 | `$('.setUpMonitor-layout').load("./setUpMonitor.html", cb)`；cb 里再按需 load
playback/convert 落地页，并在 `view/GRIT` 存在时用 `$('head').append('<script>')` 动态挂 25+ 个 GRIT 脚本 | 1123-1177 |
| 6 | `$(".setUpMonitor-layout").css("display","none")` | 1179 |
| 7 | `deviceManagement.readDevicesData()`（建落地页设备 tile） | 1180 |
| 8 | 合并 MessageId 常量表（OEMSTAR/OEM6 用 M6、OEM7/SMART2 用 M7、GIII 用 GIII）+ MessageIdTweaks 覆盖，然后 `jarvisInterface.loadLanguageData()`（生成语言菜单项、按用户偏好插入 `<script src="…/xx.js">`） | 1182-1199 |

第 4、5 步都是**异步**的（`$.load` 无回调 / 有回调），与 splash 的 4 s 定时器之间**没有任何
同步信号**（见 2.4）。`[观察] index.html:1121-1123, 1077-1110`

### 2.4 splash → welcome 的 4 秒切换（`index.html:1047-1110`）

1. 顶层脚本：`$(".banner-img").css("display","none")`（先藏导航条）`:1048`
2. `showSplashScreenLoader()`：`setInterval(circularProgress, 37)`，每拍把
   `.splashProgress` 宽度 +1%，到 100% 时 `clearInterval`（≈3.7 s）`:1050-1065, 1075`
3. `if(userStore.theme=="dark-theme") $('body').addClass("darkMode")` `:1071-1074`
4. `setTimeout(..., 4000)`：按 `Components.json` 移除 playback/convert 入口（`:1078-1088`）→
   隐藏 `.splashscreen-layout`、显示 `.banner-img`（flex）、显示 `.welcome-layout`（block）→
   `deviceManagement.welcomScreenHeightChange()` → 恢复广告侧栏（若 `userStore.slider==true`）→
   **`jarvisInterface.applyUserLanguagePreference(userStore.language)`** → `clearInterval(interval)`
   `:1077-1110`

> `[推断]` 因为 `.load("./welcome.html")` 无回调、`.load("./setUpMonitor.html")` 的回调里还要再
> 串 3 个 `.load` 和 25+ 个 `<script>`，而 4 s 是硬编码常量，所以「4 s 到点但 welcome.html 尚未
> 注入完成」在慢盘上是可能发生的竞态：此时 `$(".welcome-layout").css("display","block")` 作用在
> 一个空 div 上，用户会看到空白的 welcome 页直到注入完成。推理链：`:1121` 无回调 + `:1077` 固定延时。

### 2.5 「能看见 Manage 界面」的完整链路

初始可见页是 **welcome**，Manage 是**点击驱动**的，不存在自动进入：

```
用户点 #home-setupmonitor（顶部下拉导航 index.html:232）
  → setUpMonitor.html:196-199  $("#sm-welcome").click()
      → welcome.js:140-179
          隐藏 .noncoreapp-layout 及其子元素
          .welcome-layout display:none
          .setUpMonitor-layout display:block
          .landing-pages 全部 hide，再 show .setupMonitor-landing-screen
          $('.sm-title')[0].innerText = "Manage"
          .tabImg hide，.default-icon show
          #tabs-list li 全部 show，再隐藏 connType=PI / GRIT 的 li
          jarvisInterface.applyUserLanguagePreference(userStore.language)
          enableTabs("SM")            // welcome.js:128-139 -> $("#tabs").tabs("enable"/"disable", index)
          deviceManagement.fetchAllDevices()  (若设 tile 数为 0)
          deviceManagement.fetchAllGroups()
          $('#tabs-list a[href="#tabs-1"]').trigger('click')   // 激活 1 号"Add device"页
          200 ms 后 $("#sideView .folder-all").click()
      → 此时才可见 Manage 页签条 + 设备卡片墙
```

`setUpMonitor.html` 被注入时，其内联脚本（`:143-3037`）整体执行，其中 `$(function(){…})`
（`:336-3015`）在 DOM 就绪时初始化：`$("#tabs").tabs({...})`（`:342-357`）、
`$("#dialog").dialog({...})`（`:360-379`）、`help.appendHelpContent()`（`:333-335`）。

### 2.6 从「连接设备」到「首屏 tile 出现」

```
点设备 tile 的 .connectedIcon（setUpMonitor.html:713-737）
  → onConnectToggleClick(id,false)                       :480-522
      → reciverConnectionEstablish(id, details)          :437-466
          → jarvisInterface.newConnection(newId, details)   jarvisInterface.js:815-864
              → controller.openConnection(...)              （连接子系统）
              → 35 s 超时保护：超时后 showEditDialog + 关 tab + hideApplicationLoader（:820-839）
              ⚠ 另有**独立**的 30 s 看门狗 conTimeOut[tab]（:3153-3176），在 connectionStatus 成功分支里
                启动、等 connectionReady 期间计时；它与 35 s 那个不是同一个定时器（见 §11 R51）
  → controller 回报 → jarvisInterface.connectionStatus("connectionsuccess",tab,error)
                                                         jarvisInterface.js:2858-2991
      clearTimeout(connectionTimeout[tab])               :2861
      （成功分支内 close/hide 应用级 loader，见 :2934 / :2991）
  → jarvisInterface.checkConnectionReady(tab)            jarvisInterface.js:1450-1970
      createComponent('menuBar')       → #menuBar-panel-<tab>
      createMenuComponents(tab)        → .menuBar-layouts + 10 个 .menu-layouts
      createTile(tab,0)                → #status-panel-<tab> 里的 tile
      createComponent('statusBar', …)
      （按机型分支建 page1 / page2 tile，见 3.2）
      checkPersistPage(tab)            → 恢复上次停留的 menu/statusPage
      1500 ms 后：events.updateEventsOntoUI + 高度单位/定位标题改写
      100 ms 后 ：checkTileSpacing(tab)
      applyUserLanguagePreference(language, tab)
```

`addTab()`（`setUpMonitor.html:382-427`）额外做两件加载器动作：
`genericView.showConnectionLoader(id)`（`:422`，30 s 自动隐藏，`genericView.js:1026-1028`）与
`setTimeout(genericView.hideConnectionLoader(id), 1200)`（`:408-410`）。
GRIT tab 用 `gritJarvisInterface.createGritMainPanel` + 500 ms 后 `jarvisInterface.handleLoader`（`:412-418`）。

### 2.7 DOM 容器创建顺序（一个 tab 内，逐层）

`jarvisInterface.createMainPanel(tab)`（`:893-1141`）按**固定顺序** append 到 `#<tab>`：

```
1  .events-panel.complete-panel      #events-panel-<tab>          :895-898
2  .menuBar-panel.complete-panel     #menuBar-panel-<tab>         :900-903
3  .status-panel.complete-panel      #status-panel-<tab>          :905-908
4  .main-panel.complete-panel        #main-panel-<tab>            :910-913
5    └ .fetch-loader                 #fetch-loader-<tab>          :915-918
6    └ .row.status-config            #status-config-<tab>         :920-923
7    └ .status-components.manage-status-components
                                     #status-components-<tab>     :925-928   ← page 1 (Packery 容器)
8    └ .status-components-page2      #status-components-page2-<tab> :930-933 ← page 2
9    └ .config-components            #config-components-<tab>     :935-938
10 config 页三套模板之一（标准 8 项 pill / GIII 单 Logging / Longhorn 两页） :945-1033
11 #status-config-<tab> 内 page1/page2 切换条 + #resetDefault   :1035-1044
12 .popup-modal#tabs-popup（含 #popupModal + #btn-template）    :1046-1071
13 .cancel-modal[data-popup=overlay-popup]（含 #overlayPopupModal） :1073-1098
14 .help-modal.container（含 #helpModal）                        :1100-1118
15 .translucent-layout（.applying-spinner/.apply-label/.counter-val=30） :1123-1128
16 #connection-loader（display:none，内嵌 .load-screen.inset）    :1129-1140
```

`[观察]` 第 12-16 号元素在每个 tab 内**各有一份**，因此 `#popupModal`、`#helpModal`、
`#connection-loader`、`#loader-text-id` 在整页是**重复 id**；所有代码一律用
`"#"+tab+" #…"` 前缀限定作用域才不冲突（如 `genericView.js:1024-1034`）。

---

## 3. 数据结构

### 3.1 页签（tab）

| 名称 | 类型 | 取值/规则 | 来源 |
|---|---|---|---|
| tab DOM id | string | `tabs-<N>`（SM/Playback）或 `grit-tabs-<N>`（GRIT） | `setUpMonitor.html:438, 452-454`；playback 见 `:2852-2855` |
| N | number | `tabCounter`，初值 2，每次建 tab 后 `++`；**不复用**已关闭的号 | `:340, 464, 2861` |
| panel class | string | `tab-view`；GRIT 追加 `grit-connection` | `:384-392` |
| `connType` 属性 | string | `SM` / `GRIT`（写在 `li` 与 panel 上，用于 `enableTabs` 与显隐过滤） | `:339, 397` |
| tab 标题 | string | 模板里用的是传入的 `name`（`connectionDetails.name`）；`label` 由 `$("#tab_title").val()` 计算，而该元素不存在 → `label` 恒为 `"Tab "+tabCounter`，是**未被使用的中间量** | `:337-339, 382-385` |
| tab 面板内容 | — | 由 `createMainPanel` 按 2.7 生成 | — |

`[观察]` `:397` 的模板字符串在 `id` 值与 `connType` 之间**缺一个空格**
（`"<div id='"+id+"'connType='…'"`）。浏览器按容错规则仍解析出两个属性，但这是畸形 HTML；
复现时应写成 `id='…' connType='…'`。

**tab 的登记表**（`jarvisInterface` 内，视图层大量读取）：

| 对象 | 结构 | 语义 | 引用 |
|---|---|---|---|
| `jarvisInterface.tabids` | `{tabId: deviceTileId}` | tab ↔ 设备 tile id 双向映射 | `jarvisInterface.js:463`、`setUpMonitor.html:745` |
| `connectionDetailsMap` | `{tabId: {name,type,port,ipAddress,…,type:'playback'}}` | 连接参数 | `jarvisInterface.js:817` |
| `connectionLostMap` | `{tabId: deviceTileId}` | 连接丢失但 tab 保留 | `genericView.js:655-660` |
| `cachedData` | `{tabId: {statusBar:[…],positionStatus:[…],…}}` | 非活动 tab 的最近一帧 | `jarvisInterface.js:6730, 5449-5495` |
| `tabScrollTopPosition` | `{tabId: number}` | tab 切换时恢复滚动位置 | `setUpMonitor.html:350-352` |
| `NovatelIdConstants.tabName` | string | **当前活动 tab**（数据节流的唯一判据） | `model/NovatelIdConstants.js:10` |
| `NovatelIdConstants.currentActiveApp` | `HOME/SM/PI/CONVERT/GRIT` | 当前所在应用 | `:61`；`welcome.js:248-258` |
| `NovatelIdConstants.maxConnection` | number = 10 | 同时连接上限（含 GRIT 侧） | `:9` |

### 3.2 一个 tab 里的固定 tile（按机型分支，决定性事实）

**所有分支都以 index=0 的 statusBar 开头**，且该 tile 挂到 `#status-panel-<tab>`（不是
`status-components`）。`[观察] jarvisInterface.js:1219-1234, 1479-1483`

`createTile(tab, index, page)` 的落点规则（`:1215-1235`）：

- `index === 0` → `#status-panel-<tab>`（或 GRIT 的 `#grit-status-panel-<tab>`）
- `index > 0` 且 `page` 为空 → `#status-components-<tab>`（= **page 1**）
- `index > 0` 且 `page = "page2"` → `#status-components-page2-<tab>`（= **page 2**）

| 机型分支 | page 0（status-panel） | page 1（status-components）顺序 | page 2 |
|---|---|---|---|
| 标准 OEM（含 MarinePak） | statusBar | positionStatus → [pppCorrections¹] → [satelliteView²] → [alignStatus³] → [spanStatus⁴] → [interferenceStatus⁵] → logStatus⁶ → portStatus → [radioStatus⁷] | satelliteTracking（条件满足才建） |
| Longhorn（`getIsLongHorn`） | statusBar | positionStatus → 2d-sd → height-sd → deviceInfo → satelliteView | 无（`#status-pages2` 被隐藏⁸） |
| GIII（`getIsGIII`） | statusBar | positionStatus → agcStatus | satelliteTracking |

¹ 仅 MarinePak 且 `PositionModes` 不含 NONE（`:1570-1579`）；标准 OEM 分支要求
`isTerrastarSupported`（`:1721-1730`）。
² MarinePak 分支无条件（`:1580-1586`）；标准 OEM 分支也建（`:1714-1720`）。
³ 仅 `featuresList.isAlignSupported(tab)`（`:1587-1606` / `:1731-1750`）；串口 115200 时会改
`compLogsRegister.alignStatus`（`:1590-1599`）。
⁴ 仅 `getSPANSupported(tab) != -1`；OEM6 时 100 ms 后隐藏 `.span-alignment/.span-convergence`（`:1609-1621`）。
⁵ 仅 `rxGen` 不是 OEM6/OEMSTAR（`:1625-1633` / `:1694-1702`）。
⁶ 仅非 OEM6/OEMSTAR（`:1634-1643` / `:1781-1790`）；OEM6 走 `:1703-1712` 的 else-if 分支。
⁷ 通过 `setInterval(…,500)` 轮询 `getIsRadioTxSupported(tab)`，支持才建，建完 1000 ms 后
`radioStatus.processLanguage()` + `dynamicTiles.initialisePackery(tab)`（`:1659-1684` / `:1806-1831`）。
⁸ `:1555-1557`、`:1918-1920`：`#statusPage2` 的 `<a>` 被 hide、指针样式改 `inherit`。

`[观察]` `events` 与 `menuBar` 不是 tile：`events` 落在 `#events-panel-<tab>`（`:1655, 1802`），
`menuBar` 落在 `#menuBar-panel-<tab>`（`:1471, 1974`）。

### 3.3 tile 的「身份」= 首个子 div 的 `*-status` class

Packery 的布局持久化、撤销、恢复默认，全部靠这个命名约定定位 tile：

```js
// dynamicTiles.js:502-505（同样逻辑在 :358-363, :607-611, :809-815）
const $firstDiv = $tile.find('> div').first();
const statusClass = Array.from($firstDiv.attr('class').split(' '))
      .find(c => c.endsWith('-status') || c === 'satellite-view');
```

因此**每个 tile 片段的第一个子元素必须带下列 class 之一**（`[观察]` 逐个 HTML 首行）：

| tile | 首元素 class | 文件:行 |
|---|---|---|
| positionStatus | `position-status` | `view/positionStatus/positionStatus.html:1` |
| deviceInfo | `device-status` | `view/deviceInfo/deviceInfo.html:1` |
| spanStatus | `span-status` | `view/spanStatus/spanStatus.html:1` |
| alignStatus | `align-status` | `view/alignStatus/alignStatus.html:1` |
| portStatus | `port-status` | `view/portStatus/portStatus.html:1` |
| logStatus | `log-status` | `view/logStatus/logStatus.html:1` |
| radioStatus | `radio-status` | `view/radioStatus/radioStatus.html:1` |
| interferenceStatus | `interference-status` | `view/interferenceStatus/interferenceStatus.html:1` |
| pppCorrections | `pppCorrection-status` | `view/pppCorrections/pppCorrections.html:1` |
| agcStatus | `agc-status` | `view/agcStatus/agcStatus.html:1` |
| 2d-sd | `2d-sd-status` | `view/2d-sd/lghn-2d-sd.html` |
| height-sd | `height-sd-status` | `view/height-sd/lghn-height-sd.html` |
| satelliteView | `satellite-view` | `view/satelliteView/satelliteView.html:1` |
| satelliteTracking（page2） | `satelliteTracking-status` | `view/satelliteTracking/satelliteTracking.html:1`、`view/satelliteTracking/giii-satelliteTracking.html:1`（§R65 补充） |
| statusBar | `row status-bar`（不进 Packery，在 status-panel 内；包装层被改名为 `tile receiverPanel`，见 R60） | `view/statusBar/statusBar.html:2` |

`[观察]` 已知缺陷：`view/interferenceStatus/interferenceStatus.html` 的黄灯与红灯**都**用了
`interferenceStatusRed`，没有 `interferenceStatusAmber`（同文件内 `class="yellow-status
interferenceStatusRed Interference"`）。`[推断]` 后果是 `statusBar.createStatusDialog` 走
`why-this-amber` 文案时查不到对应 `data-lang-title-interferenceStatusAmber` 元素。

### 3.4 布局持久化结构（userStore）

```jsonc
{
  "app": {
    "dynamic": {                    // 用户最后摆放的位置
      "<deviceTileId>": [ { "id": "position-status", "position": { "left": 0, "top": 0 } }, … ]
    },
    "defaultLayout": {              // 首次进入时抓取的"默认"位置，供 Reset 用
      "<deviceTileId>": [ … 同结构 … ]
    },
    "lastManageSortedDevices": [ "<deviceTileId>", … ],
    "lastGritSortedDevices": [ … ],
    "heightUnits": { "<deviceTileId>": "Ellipsoidal" | "MSL" },
    "connectionMode": { "network_mode": "Host Name"|"IP Address", "network_type": "tcp"|"udp" }
  }
}
```

| 字段 | 类型 | 单位 | 来源 |
|---|---|---|---|
| `dynamic[devId]` | `Array<{id:string, position:{left:number,top:number}}>` | px（相对 `#status-components-<tab>` 左上角） | `dynamicTiles.js:765-782` `saveLayout` |
| `defaultLayout[devId]` | 同上 | px | `dynamicTiles.js:377-391` |
| 排序口径 | `left`/`top` 先按 `top`（同行阈值 20 px）再按 `left` | — | `dynamicTiles.js:627-639` |
| `devicedetails.menu` | `"statusPage1"`/`"statusPage2"`/`"menuConfig"` | — | `menuBar.js:287, 394` |
| `lastManageSortedDevices` | `string[]`（设备 tile DOM id） | — | `deviceManagement.js:1914-1928` |

**关键：持久化的键是「设备 tile id」（`new Date().getTime()` 生成的毫秒时间戳），不是 tab id。**
所以同一台设备换 tab（SM ↔ GRIT）时布局可继承，参见 `menuBar.js:401-426` 与
`jarvisInterface.js:3714`（`cachedData[newId] = cachedData[tab]` 同理）。

### 3.5 尺寸模型：**2.11.0 没有 1x1 / 2x1 / 2x2 的 tile 跨度**

这是本子系统最容易被误传的一点，必须写清：

- Packery 实例参数（`dynamicTiles.js:309-327`）：`itemSelector:'.manage-tile'`、
  `columnWidth = floor((容器宽 - 4) / 3)`、`gutter = 2`（`totalGutters=2, gutterSize=2`）、
  `transitionDuration:0`、`resize:false`、`percentPosition:false`、`isOriginLeft/Top:true`。
- tile 自身尺寸来自 CSS 固定值：`.tile{width:392px; min-height:350px}`（`style.css:379-390`）。
- 由此 `_applyGridGutter(392, columnWidth+2)` 向上取整到 1 列 → **每个 tile 恒占 1 列**，
  位置只剩 `position.x / position.y` 两个整数，没有宽高字段。
- 结论：**不存在 tile 跨度（span）的存储**，也就不存在 2x1/2x2；「拖动」只改 x/y 或换列顺序。
  `[推断]` 推理链：`dynamicTiles.js:316-327` 未设置 `itemSelector` 之外任何尺寸属性 +
  `:615-621` 只记录 `left/top` + `:572-578` 重排时只按 id 顺序 append 不写宽高。
- 遗留的绝对定位拖动实现（`view/js/tileMovement.js`）里存在「等宽 420 / 等高三行」的
  网格假设（`:195-196` 硬编码 `width=420,height=314`），但调用点已被注释
  （`jarvisInterface.js:1682, 1829` 均为 `// tileMovement.tileMove(...)`），
  且 `moveTiles()` 写死 `tab='tabs-2'`（`tileMovement.js:539`）→ 整个模块是死代码。

### 3.6 各 status 组件的内部状态对象（`processLanguage` 之外的唯一可变状态）

| 组件 | 状态容器 | 消费的 msgID（常量名） | 引用 |
|---|---|---|---|
| statusBar | `skdetectConfig`, `itDetectConfigData`, `spoofingRAGColor`, `jammingRAGColor`, `ragIndicatorLogs`, `ragIndicatorLogsList` | bestpos, hwMonitor, cardStatus(GIII), fileSystemCapacity, time, version, itdetectstatus, inspvax, rxStatus, skDetectConfig, itdetectconfig | `statusbar.js:2-8, 503-524` |
| positionStatus | `positionStatusObj`(bestpos/heading2/inspvax/connectIMU/inscommand/autoSurvey/avepos/posave…), `posragIndicatorColor`, `configuredPosModes`, `clockComputed` | bestpos, heading2, inspvax, connectimu, inscommand, autosurvey, avepos, posave, dualantennaalign, wifialignautomation, alignautomation + GIII rxCommands/timeSolution | `positionStatus.js:5-13` |
| portStatus | `portStatusObj[tab].{interfacemode,configuredPorts,portStats}`, `previousPortStatsData`, `ChangedPortStatsData`, `rxDataList`, `bufferOverflowList` | portstats（+ `updateStatus` 路由其它） | `portStatus.js:2-14` |
| deviceInfo | `fsDictionary`, `hwDictionary`, `RAGTexts`, `powerstatus`, `deviceRAGIndicatorColor` | hwMonitor, fileSystemCapacity, rxStatus, cardStatus(GIII) | `deviceInfo.js:3-4` |
| spanStatus | `spanStatusObj[tab].{inspvaxData,connectIMUData,insCommandData,rxStatusData}`, `spanRAGIndicatorColor` | rxStatus, inspvax, connectimu, inscommand | `spanStatus.js:3-4` |
| alignStatus | `alignStatusObj[tab].{heading2,dualAntennaAlign,wifiAlign,alignAutomation}` | heading2, dualantennaalign, wifialignautomation, alignautomation | `alignStatus.js:2-17` |
| radioStatus | 无持久对象（直接读 `logData.state`），写 `featuresList.setRadioPort` | satelStatus, satelDetect | `radioStatus.js:2-35` |
| interferenceStatus | `ITKRagIndicatorColor` | itdetectstatus | `interferencestatus.js:3` |
| logStatus | `fileMessageList`, `fileStatus`, `tempFileMessageList` | fileStatus(+ 文件名/大小/消息列表) | `logStatus.js:2` |
| agcStatus | `cardsUpdateFlag`, `RAGStatus`, `AGCUIData`, `agcPlotData`, `plotCreated`, `popopPlotCreated`, `hoverInfo`, `agcDetailedInfo` | agcInfo（GIII） | `agcStatus.js:4-11, 348` |
| pppCorrections | `pppRagStatus`, `ntripData`, `interfaceModeData`, `oceanixStatus` | terrastarInfo/Status, veriposinfo, veriposDecoderStatus, oceanixinfo, oceanixStatus, ntripConfig, interfaceMode, assignLbandBeam, lbandTrackstat | `pppCorrections.js:2-4` |
| satelliteView | 无状态，纯渲染 + `ConstellationHandler` 查询 | — | `satelliteView.js:1-82` |
| longhornStatusUI | `sdXAxisData/sdYAxisData/hdXAxisData/hdYAxisData`, `plotInterval`, `idleTimeTimer`, `deviceInfoRAG`, `positionStatusRAG`, `gsvPRNsList`, `completeSatsObj` | 无 msgID 常量，收原始 `data` | `longhornStatusUI.js:3-15` |

---

## 4. 接口清单

> 约定：`tab` 均为 tab DOM id（`tabs-3` / `grit-tabs-3`）；`feature` 为组件名（与目录名同名）。

### 4.1 容器层（`jarvisInterface`，视图层的真正入口）

| 签名 | 参数语义 | 返回 | 副作用 | 异常路径 |
|---|---|---|---|---|
| `createMainPanel(tab)` | tab id | 无 | 见 2.7 的 16 个容器 | `document.getElementById(tab)` 为 null 时抛 TypeError（tab 未插入 DOM 就调用） `jarvisInterface.js:893-1141` |
| `createTile(tab, index, page)` | `page` 省略/`""`→page1，`"page2"`→page2 | 无 | 建 `div.tile.status-tile#tile-<index>-<tab>` 并 append 到对应容器；**不改 className**（调用方随后覆盖） | 容器不存在时抛错 `:1215-1235` |
| `createComponent(componentName, tab, parent, isLongHornOrGIII)` | `parent` 为**父元素 id 不带 `#`** | 无（异步） | `$('#'+parent).load(path, cb)`；cb 里 `eval(componentName).processLanguage(tab)`，并按组件做 id/for 的 `-<tab>` 后缀重写 | `eval` 失败仅 `console.log("Component error:", ...)`，组件静默不初始化 `:4779-5083` |
| `createMenuComponents(tab)` | — | 无 | 建 `.menuBar-layouts` + 10 个 `.menu-layouts`（itk/deviceDetails/deviceExport/deviceUpdate/deviceRestart/terminalConsole/networkingSettings/displaysSettings/languageSettings/generalSettings） | — `:1237-1286` |
| `createPlaybackPanel(tab)` / `createPlaybackComponent(tab)` | — | — | `#playback-panel-<tab>` + load `playbackcontrol.html` | `:1143-1152, 5085-5098` |
| `createLoader(tab)` / `showLoader` / `hideLoader` | — | — | 旧版全局加载器（`.fetch-loader`/`.load-screen`），已被 `genericView.showApplicationLoader` 取代 | `:1193-1214, 1154-1191` |

`createComponent` 的路径解析规则（复现必须逐条命中，`:4782-4815`）：

```
默认            ./../<name>/<name>.html
GIII 变体       ./../<name>/giii-<name>.html      (仅当 isLongHornOrGIII 传 true)
Longhorn 变体   ./../<name>/lghn-<name>.html      (仅当 isLongHornOrGIII 传 true)
tab 以 grit 开头 ./../GRIT/<name>/<name>.html     (gritSupported 时)
pointsOfInterest + luciad + grit → ./../GRIT/pointsOfInterest/luciad/pointsOfInterest.html
spoofingConfiguration 且 tab 以 tab 开头 → ./../GRIT/spoofingConfiguration/spoofingConfiguration.html
终端/网络/设备信息/SPAN 在 grit tab 下仍用 ./../<name>/<name>.html（4 个显式特例）
```

### 4.2 布局层（`dynamicTiles`）

| 签名 | 语义 | 返回 | 备注 |
|---|---|---|---|
| `initialisePackery(tab)` | 建/重建 Packery + Draggabilly + ResizeObserver + 恢复布局 | 无 | Longhorn 直接 return（并隐藏 Reset 按钮）`:277-283`；无 `tabids[tab]` 时 return `:285-288` |
| `deletePackeryInstances(tab)` | 关 tab / 重连前保存并销毁 | 无 | 先 `saveLayout`，再清 observer、销毁 draggie `:887-903` |
| `getPackeryInstance(tab)` | — | 实例或 `undefined` | `:882-885` |
| `getCurrentLayout(tab)` | — | `[{id,position:{left,top}}]`（按 top→left 排序） | `:597-642` |
| `saveLayout(tab)` | 写 `app.dynamic[devId]` | 无 | 无 `tabids[tab]` 时静默 return `:765-782` |
| `loadLayout(tab)` | 按 `isLayoutDifferent(tab,true)` 选 default 还是 dynamic | 无 | `:784-797` |
| `processLanguage()` | 只刷 Undo 横幅两条文案 | 无 | `:955-958` |
| `updateResetButtonVisibility(tab)` | `#resetDefault` 显隐 | 无 | 依据 `isLayoutDifferent` `:878-881` |
| `clearDynamicTilesInstance(tab)` | 只 `layout()` 后删实例（不保存） | 无 | `:960-964` |

内部常量（复现需要一致）：`SCROLL_THRESHOLD=150`、`SCROLL_SPEED=8`、`MENU_BAR_HEIGHT=100`、
自动滚动 `setInterval(...,16)`（`:6-8, 104-139`）；撤销横幅 `setTimeout(...,10000)`
但注释写「5 seconds」（`:188-191`）→ 实际 10 s。

### 4.3 视图工具层（`genericView`，39 个导出）

按用途分组（全部 `[观察] genericView.js:1171-1216`）：

- **数据渲染**：`updateView(jsonData, fields, featureName)`、`updateStatusIndicatorClrAndText(parent, state, tab)`、
  `compareJson(oldLog,newLog)`、`formatToSystemLocale(value,fractionDigits,tab)`、`getCommaLocale(tab)`。
- **弹窗**：`createDialog(options, displayOptions)`、`closeDialog(tab)`、`popupPositionCalculation(tabid,isOverlayPopup,isPOIPopup)`、
  `openAlreadyCreatedPoiPopup(tab)`、`getCloseConfirm/setCloseConfirm`、
  `setIs{Com,PortMsg,ICom,NCom}PopupDialogDataChanged(flag)`。
- **加载器**：`showApplicationLoader(time=30000)`、`hideApplicationLoader()`、
  `showConnectionLoader(tab)`（30 s 兜底）、`hideConnectionLoader(tab)`、
  `showLoadingScreen(time,displaytext,displayCount,tab,comp,dataLangValue)`、
  `showCounterLoader(tab,time)`、`clearLoaderInterval(tab)`、
  `closeApplyingScreen(close,success,tab)`、`closeApplyingScreenWithoutBanner(tab)`、`closeStatusBanner(tab)`。
- **语言标记**：`removeDataLangAttr(elementSelector)`、`addDataLangAttr(selector,attrName)`、
  `removeDataLanguageAttrs(tab)`、`basicpopupProcessLanguage()`。
- **其它**：`deleteElementIds(tab)`、`resetDataObject(tab)`、`tilesAlignment()`（死代码）、
  `hidePlaybackSnippetControls(tab)`、`findCommonElement(a1,a2)`、`toggleElementActive/addElementActive`、
  `loglistData`（**导出的是对象引用，不是函数**）、`isLogsSpaceAvailable(tab,count)`、
  `getLogsCount(logs,tab)`、`showMaxLogsReachedPopup(tab,toUnlogCount,check)`、
  `messagePeriodValidation($el)`、`set/getRequestResetFromApp(tab,flag)`、`closeAndReestablishConnection(tab,loader)`。

`updateView` 的 ID 拼接规则（第 5 节详述）与**活动 tab 门禁**是本子系统最核心的两条行为：
`if(tab !== NovatelIdConstants.tabName) return;`（`genericView.js:27-30`）。

### 4.4 配置命令层（`genericConfig`，17 个导出）

| 签名 | 语义 |
|---|---|
| `placeCmdReq(commandName, configDataMap, tab)` | 登记待响应计数 → `sendCommand` |
| `sendCommand(configDataMap, commandName, tab)` | 组参数 → `frameCommand.binaryCommand` → `controller.requestlog(tab, Uint8Array)`（`webui` 走 `WebSocketWriter`） |
| `commandResponseHandler(logData,msgid)` | 按 feature 归并 OK/ERROR/UNKNOWN，回调 18 个 `xxx.handleXxxCommandResponse`（userLogin、deviceDetails、positionConfig、spoofingConfiguration、portConfig、interferenceToolKit、spectrumViewer、GRITLandingPage、addFilterPopup、spanConfig、positioningConfig、loggingConfig、alignConfig、deviceExport、networkingSettings、deviceUpdate、radioConfig、gnssConfig） |
| `removeFeatureFrmCmdList(feature)` | 断开连接时清三张表 |
| `resetCommandObj()` | 整体清空（断开/重连时调用） |
| `saveConfigCommandSending(tab)` / `maxLogCountCheck(tab)` / `requestConfigComponents(tab)` / `requestStatusConfigLogs(list,tab)` | 配置下发与 log 上限自查 |
| `unloggingLogsOnWCOM(tab)` / `unlogComponentLogs(component,tab)` / `frameUnlogDataMap(obj)` | 反注册 log |
| `getMessageId(name,tab,rxType)` | 名称 → msgID，找不到返回 `-1` |
| `maxLogCountConfigFlag` | 导出对象（供 `genericView.closeStatusBanner` 复位） |

### 4.5 status 组件（每个组件的对外签名，共 14 个文件）

| 组件 | 导出函数 | 颗粒 |
|---|---|---|
| `statusBar` | `updateView(msgID,logData)`、`processLanguage()`、`editRagIndicatorObject(tab,msgID)`、`getitDetectConfigData(tab)`、`getInternalFlashOnly(logData)` | `statusbar.js:560-566` |
| `positionStatus` | `updateStatus(msgID,logData)`、`updateGIIIStatus(msgID,logData)`、`setisAlignSupported/setisSpanSupported/setisMarinePakSupported(flag)`、`updatePositionModes(...)`、`decodePositionStatusRagMessages(tab,state)`、`decodeGIIIPositionStatusRagMessages(tab,state)`、`posRAGColor(tab)`、`resetData(tab)`、`processLanguage(tab)` + `positionStatusObj`、`clockComputed` | `positionStatus.js:647-660` |
| `portStatus` | `updateStatus(msgID,logData)`、`updateData(msgID,logData)`、`deletePortStatusData(tab)`、`processLanguage()` | `portStatus.js:513-519` |
| `deviceInfo` | `updateView(msgID,logData)`、`decodeDeviceStatusRagMessages(tab)`、`deviceInfoRAGColor(tab)`、`processLanguage()` | `deviceInfo.js:451-456` |
| `spanStatus` | `updateSpanStatus(msgID,logData)`、`decodeSPANRagMessages(tab)`、`spanRAGColor(tab)`、`resetData(tab)`、`processLanguage()` | `spanStatus.js:208-215` |
| `alignStatus` | `updateAlignStatus(msgID,data)`、`resetData(tab)`、`processLanguage()` | `alignStatus.js:152-156` |
| `radioStatus` | `updateStatus(msgID,logData)`、`processLanguage()` | `radioStatus.js:72-75` |
| `interferenceStatus` | `updateStatus(msgID,logData)`、`ITKRagColor(tab)`、`processLanguage()` | `interferencestatus.js:91-95` |
| `logStatus` | `updateData(...)`、`updateLogStatus(msgID,logData)`、`loggingRAGColor(tab)`、`processLanguage()` | `logStatus.js:280-285` |
| `agcStatus` | `dc_updateData(msgID,logData)`、`updateAGCPlot(...)`、`AGCStatusRAGMessages(tab)`、`clearPlotDetails(...)`、`processLanguage()` | `agcStatus.js:594-600` |
| `pppCorrections` | `updateStatus(msgID,logData)`、`getSubscribedState(tab,clicked)`、`resetDataObject(tab)`、`processLanguage()` | `pppCorrections.js:670-675` |
| `satelliteView` | `updateSatViewStatus(totalGoodSats,tab)`、`displayingSupportedConstellations(list,tab)`、`updateDOP(logData,msgID)`、`processLanguage()` | `satelliteView.js:76-81` |
| `longhornStatusUI` | `uiUpdate(data,tab)`、`createPlot(tab)`、`sdXAxisData/sdYAxisData(...)`、`addPort(portName,tab)`、`clearPlotInterval(tab)`、`decodeDeviceStatusRagMessages(tab)`、`processLanguage()` | `longhornStatusUI.js:1328-1337` |

`[观察]` 所有组件的 `processLanguage` 签名**统一为 `processLanguage(tab?)`**，但绝大多数实现
**不使用 `tab` 参数**（内部全是全局 `$('[data-lang-xxx]').html(__('XXX'))`）。真正消费 `tab` 的只有两个：
`positionStatus.processLanguage(tab)`（`positionStatus.js:562`）与 `menuBar.processLanguage(tab)`
（`menuBar.js:987-1023`，其中 GIII 的 SOLUTIONS/POSITIONING 文案切换读的是全局
`NovatelIdConstants.tabName`，而 `tab` 只被转发给子组件）。

### 4.6 语言层

| 签名 | 语义 | 引用 |
|---|---|---|
| `applyUserLanguagePreference(languageId, tab)` | 只做一件事：`loadLanguageData(languageId)`。`tab` 参数被**完全忽略** | `jarvisInterface.js:1350-1352` |
| `loadLanguageData(languageId='')` | 读 `view/languageSupport/languageSettings.json`；空参→`populateLanguageButtons`，否则→`applyLanguageChanges` | `:6133-6157` |
| `populateLanguageButtons(json)` | 按 `languageName` 倒序生成 `<li id="<name>-lang">`，若等于用户偏好则动态插 `<script src="…/<key>.js">` | `:6159-6189` |
| `applyLanguageChanges(json, languageId)` | 取 `languageId.split("-")[0]` 匹配 `languageName.toLowerCase()` → `$.getScript(filePath)`，成功后**串行**调用 9 个 `processLanguage` 系列 | `:1354-1374` |
| `statusComponentsProcessLanguage(tab)` | 20 个 status 组件的 `processLanguage` + 条件分支（GRIT/GIII） | `:1375-1410` |
| `configComponentsProcessLanguage(tab)` | 9 个 config 组件 + Longhorn/GIII/MarinePak 条件块 | `:1411-1435` |

`[观察]` 语言文件 `languageSettings.json` 只有 7 项（en/cn/de/eg/es/fr/pt），
但目录里另有 `ru.js`（未登记 → 永远不会被加载）。`view/languageSupport/languageSettings.json`、`ru.js`

### 4.7 页面级模块

| 模块 | 导出 |
|---|---|
| `welcome` | `showHideSWAndFeedbackUI(showSW,showFeedback)`、`autoUpdate`、`feedbackshow`、`feedbackResponse`、`loadAds()`、`enableTabs(connType)`、`openCustomerSatisfactionPopup()`、`processLanguage(tab?)` `welcome.js:2084-2093` |
| `saveConfiguration` | `placeLogRequest`、`processIncomingData`、`getSaveConfigActive`、`getDefaultExportDir`、`getLogVersionData`、`processLanguage()` `saveConfiguration.js:627-634` |
| `loadConfiguration` | `processResponses`、`getLoadConfigActive`、`getLogversionDetails`、`processLanguage()` `loadConfiguration.js:799-804` |
| `addApplication` | `fetchAppsToLandingScreen()`、`addApptoLandingScreen(cards)`、`openAddAppDialog`、`processLanguage()` 等 `addApplication.js:2781-2790` |
| `updateApplication` | `processLanguage()`、`readLinuxVersion` `updateApplication.js:698-702` |
| `tilesManagement` | **空对象**（只有 6 个委托事件，无导出）`tilesManagement.js:95-97` |
| `pagination` | 自注册 jQuery 插件 `$.fn.pagination`（paginationjs），Manage 视图**无调用方** `pagination.js:24, 1099` |

---

## 5. 报文/协议细节（本子系统的「字节级」等价物：DOM ID 契约与数值格式化）

视图层不碰字节流，但它与上游之间有一条**严格字符串契约**，错一位整块数据就不显示。

### 5.1 `updateView` 的字段 → DOM id 拼接规则

`updateView(jsonData, fields, featureName)`，`fields` 是逗号分隔的字段名串
（如 `"State,Mode,Software,Week,Milliseconds"`）。逐字段拼 id（`genericView.js:38-77`）：

| 条件 | 生成的选择器 |
|---|---|
| `featureName=="statusBar"` | `#status-panel-<tab> #statusBar<field>` |
| `featureName=="gritStatusBar"` | `#grit-status-panel-<tab> #gritStatusBar<field>` |
| `featureName=="playback"` 或 `"hot-spot"` | `#playback-panel-<tab> #<feature><field>` |
| 其它（positionStatus/deviceInfo/spanStatus/alignStatus/portStatus/logStatus/radioStatus/interferenceStatus/pppCorrections/alignStatus/satelliteView…） | `#main-panel-<tab> #<feature><field>` |
| `tab==""`（webui）且 `featureName` 含 `Status` 或等于 `satelliteView` | 移动端（UA 匹配 `/iPhone|Android|blackberry|mini|windows\sce/i` 或 `innerWidth<768`）→ `.for-mobiles #<feature><field>`；否则 `.for-desktop #<feature><field>` |
| `tab==""` 且 `featureName∈{splashScreen,statusBar,gritStatusBar}` | `#<feature><field>` |
| 其它 `tab==""` | `#<feature><field>` |

示例（可复算）：`fields="latitude,longitude"` + `feature="statusBar"` + `tab="tabs-3"`
→ `#status-panel-tabs-3 #statusBarlatitude`、`…#statusBarlongitude`，
对应 `view/statusBar/statusBar.html:39,43` 的 `id="statusBarlatitude"`。
`[观察]` `statusbar.js:83`、`view/statusBar/statusBar.html:39`

### 5.2 缓存与空值语义

- 每个 `(tab+feature)` 一个字典 `elementIds[tab+feature][field] = document.querySelector(id)`；
  命中后**不再 querySelector**，只在 `null` 时重查（`:81-93`）。
- 例外：`solStatus` 与 `headingTitle` 永不缓存（`:84`）——因为它们指向的元素会被整块替换。
- `textContent` 赋值前判 `elementIds[...][field] != null`（`:115`），否则静默跳过。

### 5.3 RAG（红黄绿灰）判定与状态类

统一映射（`genericView.js:13-18`）：

| state | class |
|---|---|
| `good` | `green-status` |
| `warning` | `yellow-status` |
| `bad` | `red-status` |
| `idle` | `grey-status` |

`updateStatusIndicatorClrAndText(parent,state,tab)` = 先隐藏
`#<tab> .<parent>.statustiles-traffic span`，再显示其中的 `span.<clr>-status`（`:188-192`）。
注意 `statusBar` 的 status-bar 灯用的是 **`traffic-lights`** 而不是 `statustiles-traffic`
（`view/statusBar/statusBar.html:25,75`），所以 statusBar 的两颗灯由
`statusbar.js:335-338` 直接操作，不走这个函数——`[推断]` 复现时若混用会导致状态灯不亮。

### 5.4 数值格式化

- `formatToSystemLocale(value, fractionDigits, tab)`：用 `Intl.NumberFormat(navigator.language,
  {min/maxFractionDigits: fractionDigits, useGrouping:false})`。`getCommaLocale` 对 27 个
  「逗号作小数点」的 locale（cs-CZ/de-DE/fr-FR/es-ES/it-IT/nl-NL/pt-PT/pt-BR/ru-RU/pl-PL/tr-TR/
  uk-UA/…）返回该 locale，否则返回 `navigator.language`。`genericView.js:1052-1074`
- `[推断]` `useGrouping:false` 意味着**千位不加分隔符**，但小数分隔符随系统（德/法/俄为 `,`）；
  这让所有「先格式化再 parseFloat」的代码在逗号 locale 下退化——`statusbar.js:79-81` 已经打了补丁
  （`if(getCommaLocale(tab) != NovatelIdConstants.getDefaultLocale) heightValue = logData.height`）。
- DOP 计算（`satelliteView.js:39`）：
  `vdop = sqrt(pdop² − hdop²)`，若 `hdop==9999 && pdop==9999` 则 `vdop=9999`（无效值透传）。
  算例：`pdop=2.5, hdop=1.2` → `vdop=sqrt(6.25−1.44)=sqrt(4.81)=2.193`，显示 3 位小数 `2.193`。
- 存储占用百分比（`statusbar.js:127-128`）：`usedStorage = usedStorage/totalStorage*100`，
  取 `Math.round` 后加 `%`，只取 `massStorageDevice=="INTERNAL_FLASH"` 那一项（`:349-355`）。

---

## 6. 状态机与事件流

### 6.1 tab 生命周期

```
[不存在] --addTab(id,name)--> [connecting] --showConnectionLoader 1200ms--> [ready]
       --连接超时 35s--> [失败]（showEditDialog + hideApplicationLoader）
       --close (×)--> [销毁]
       --连接丢失--> [connectionLost]（tab 保留，connectionLostMap 记 tileId）
       --重新连接--> [ready]
```

关键判据：

- `#tabs-list [connType='<currentActiveApp>']` 数量为 0 时（`:972-979`）隐藏竖线与 `+` 按钮，
  并 `$(".sm-title").click()` 回到落地页。
- 关闭时若有日志在写且未确认（`loggingCloseConfirmed`，`:147`），先弹
  `FILE_LOGGING_CLOSE_WARNING`（`:871-917`）；GRIT 录制中同理（`livePlayback.isRecordingActive`）。
- 关闭后的激活策略（`:944-951`）：优先右邻 tab，无则左邻；`deviceToggleClicked==true` 时强制回 `tabs-1`。

### 6.2 弹窗 / 遮罩：出现条件与驱动事件

| 元素 | 何时出现 | 驱动 | 关闭 |
|---|---|---|---|
| `.splashscreen-layout` | 页面一加载（CSS 默认可见） | `$(document).ready` | `setTimeout 4000` 后 `display:none`（`index.html:1089`） |
| `#loader`（应用级白屏） | `genericView.showApplicationLoader()` | 客户端建连接、loadConfig、AGC 详情等 | 连接成功/失败回调 `hideApplicationLoader()`；30 s（默认）或 40 s（连接流程）兜底 |
| `#connection-loader`（tab 级） | `showConnectionLoader(tab)` | `addTab()` 尾部（`setUpMonitor.html:422`）、`statusConfigClick` 切回配置/状态页（`menuBar.js:329, 372-374`）、`checkPersistPage`（`jarvisInterface.js:2632, 2640, 2653, 2666`） | 1200 ms（addTab）/500 ms（GRIT）或 30 s 兜底 |
| `.translucent-layout`（tab 内半透明遮罩 + 倒计时） | `showLoadingScreen(time,text,displayCount,tab,comp,dataLangValue)` | 下发配置命令前 | `closeApplyingScreen` / `closeApplyingScreenWithoutBanner` / `clearLoaderInterval`；倒计时到 0 时 Longhorn 会再加 60 s（`genericView.js:693-704`） |
| `.translucent-layout-Loader`（落地页命令进度条） | `#cmd-loading-progress-class` 显示 | `loadConfiguration.showProgressBar`（`:715-741`）、`saveConfiguration.downloadProgressBar`（`:575-616`） | `hideProgressBar` / `closeLoader`（3 s 后藏 banner） |
| `#tabs-popup > #popupModal` | `genericView.createDialog({...},{tab})` | 确认类、错误类、AGC 详情、satellite 全量信息、maxLog 等 | `closeDialog(tab)`；`hide.bs.modal` 里会因「未保存改动」而 `preventDefault`（`:456-465`） |
| `#notab-popup > #popupModal` | `createDialog({...},{tab:""})` | 落地页级错误、connect 失败、loadConfig 失败 | 同上 |
| `.cancel-modal[data-popup=overlay-popup]` / `#overlayPopupModal` | `{isOverlayPopup:true}` | 应用安装/删除/更新的二次确认（addApplication） | `closeDialog(tab)` 里 `css("display","none")`（`:538`） |
| `#helpModal`（`.help-modal`） | 点 tile 右下 `need-help` 或 `.help-link` | help 子系统 | 关闭按钮 → `genericView.removeDataLanguageAttrs(tab)`（`:515-522`） |
| `.about-screen` / `.feedback-survey-screen` / `.cust-satisfaction-popup` | 顶部设置菜单「About」/ 反馈按钮 / 满意度轮询 | `welcome.openCustomerSatisfactionPopup()` | 各自关闭按钮 |
| `#dialog`（jQuery UI dialog） | `openConnectionDialog()` / `openAddfolderDialog()` / `addDeviceToGroup()` | 「+ Add device」「+ 新建文件夹」「Update devices」 | `dialog.dialog("close")`；`close` 回调里 `clearInterval(listports)` + `heightIncrementing()`（`:374-378`） |

`popupPositionCalculation(tabid,isOverlayPopup,isPOIPopup)`（`genericView.js:372-426`）是统一的
垂直居中算法：`viewHeight = $(window).height()-190`，超过 `0.8*viewHeight` 时给 `.modal-body`
加 `overflow-y:auto`；`tabName=="tabs-1"` 时再上移 70 px。

### 6.3 语言切换流

```
设置菜单点某个语言 <li id="<lang>-lang">（由 populateLanguageButtons 生成）
  → jarvisInterface.applyUserLanguagePreference(<lang>)
      → loadLanguageData(<lang>) → fs.readFile(languageSettings.json)
          → applyLanguageChanges(json, <lang>)
              → $.getScript(filePath)                // 该语言文件末尾 jsIn.addDict(Language.XX)
                  → deviceTileTranslation()
                  → statusComponentsProcessLanguage(activeTab)
                  → configComponentsProcessLanguage(activeTab)
                  → welcome/playbackControl/convert/addApplication/updateApplication .processLanguage()
                  → genericView.basicpopupProcessLanguage()
```

`__()` 的实现来自 `view/css/jsin.1.2.min.js:8`（`window.__ = jsIn.translate`），字典由
**每个语言文件最后一行的 `jsIn.addDict(Language.XX)`** 覆盖写入（如 `en.js:1923`）。
因此「切语言 = 换字典 + 重跑一遍所有 `processLanguage()`」，**不刷新页面、不重建 DOM**。

### 6.4 数据节流与「休眠/恢复」（问题 6 的正面回答）

视图层的「休眠」**不是**靠浏览器后台节流，而是靠三处软件门禁：

1. **emitter 门禁**（`jarvisInterface.js:6725-6812`）：每个组件通道都有同一模式

   ```js
   if (tabName=="tabs-1" || tabName==data[1].tab || tabName=="")
        <component>.updateView(...);        // 活动 tab：立刻渲染
   else  cachedData[data[1].tab].<component> = data;   // 非活动 tab：只留最后一帧
   ```
2. **updateView 二次门禁**（`genericView.js:27-30`）：`tab !== NovatelIdConstants.tabName` 直接 return。
3. **恢复**：切 tab 时 `tabs` 的 `beforeActivate`（`setUpMonitor.html:344-356`）记
   `NovatelIdConstants.tabName = tabc`、恢复 `tabScrollTopPosition`、调
   `jarvisInterface.loadCachedData(tabc)`，后者把 `cachedData` 里 11 类通道重新 `emitter.emit`
   一遍（`jarvisInterface.js:5449-5495`）。

结论：
- `[观察]` **只有一个 tab 的 DOM 在被持续更新**，其余 tab 用「最后一帧缓存 + 切回时重放」，
  这是本子系统真正的刷新节流机制。
- `[观察]` `main.js:81` 把 `backgroundThrottling` 固定为 `false`，`updateAppBackgroundThrottling`
  这条 IPC 通道**没有发送方**——即窗口最小化/失焦时渲染不降频。若复现时开启后台节流，
  `cachedData` 的重放语义不变，但各 `setTimeout` 基准（1200 ms / 2000 ms / 5000 ms）会漂移。
- `[观察]` `jarvisInterface.getTabOpenState(tabId, comp)` 查的是 `#setupMonitorConn_<tabId>` /
  `#gritConn_<tabId>` 的子元素数，而**这两个 id 在全仓不存在**（仅 `jarvisInterface.js:1439,1444`
  两处出现）→ 该函数恒返回 `false`，且无任何调用方。属于死接口。

### 6.5 Packery 拖动 / 撤销 / 重置

```
dragStart  : lastOperation[tab]={previousState: saveTileState(tab), prevDraggedTile: firstChild.className}
             zIndex=1004, .statustiles-traffic pointer-events:none
dragMove   : handleAutoScroll(pointer)（距顶/底 <150px 时 16ms 滚动一档 8px）
dragEnd    : 清 autoScroll、恢复 pointer-events、清 zIndex
dragItemPositioned : saveLayout(tab) → getCurrentLayout → hasLayoutChanged?
                     有变化 → showUndoBanner(tab)（10 s 后自动消失）
                              → app.dynamic[devId]=newState
                              → updateResetButtonVisibility(tab)
点 Undo    : applyTileState(previousState) + 修正被拖 tile 的 left/top 与 packery item.x/y
             + saveLayout + 隐横幅
点 Reset   : app.dynamic[devId]=[...defaultLayout] → applyLayout → 隐横幅 → 隐藏 #resetDefault
```

`[观察]` 复位按钮的语义是反的：`updateResetButtonVisibility` 在
`isLayoutDifferent(tab) === false`（即**当前就是默认布局**）时显示按钮（`dynamicTiles.js:880`）。
`[推断]` 复现时应改为「有差异时显示」，否则用户看到「Reset」却无效果。

---

## 7. 与其它子系统的耦合点（逐个列出被调用的函数名）

### 7.1 ← `jarvisInterface`（视图层依赖它最多）

被视图层**调用**的成员：
`createMainPanel`、`createTile`、`createComponent`、`createLoader`、`createPlaybackPanel`、
`createPlaybackComponent`、`checkConnectionReady`、`newConnection`、`updateActualTab`、`getActualTab`、
`applyUserLanguagePreference`、`loadLanguageData`、`handleLoader`、`loadCachedData`、`deleteTabDetails`、
`reEstablishConnection`、`deletePingPongCounter`、`closeApp`、`clearportsList`、`getAppConfigComponents`、
`getAppCompLogsRegister`、`getCurrentTab`、`getOtherAppTab`、`checkPersistPage`、`compReqlogs`、
`gIIICompReqlogs`、`requestInitialLogs`、`initConfigPage`、`getHardwareVersion`、`darkModeColorCodes`、
`updateAppLogList`、`clearUIData`、`gritFirmwareNotSupport`、`onTabClick`。
读取的共享状态：`tabids`、`connectionDetailsMap`、`editedConnectionDetailsMap`、
`connectionLostMap`、`connectionStatusMap`、`cachedData`、`tabScrollTopPosition`、`userLanguage`、
`compRegister`、`compLogsRegister`、`connectedPortName`、`maxLogpopup`、`isInvalidModelOrAuth`、
`configObject`、`inprogresstabs`、`addNewTabFlag`、`isAddConnectionInProgress`。
`[观察]` 典型调用点：`setUpMonitor.html:406,462,724,3027`；`menuBar.js:276-277, 373`；
`genericView.js:657-665, 774`；`dynamicTiles.js:100, 927, 942`。

**`appLevelLogInfo` 的实情**：`jarvisInterface.getAppLevelLogInfo(tab)` 只是
`return appLevelLogInfo[tab]`（`jarvisInterface.js:5389-5391`），并且**视图层无任何调用方**
（全仓仅 `controller/communication.js:342,348` 写入与 `jarvisInterface.js` 自身导出）。→ 复现时可省略。

### 7.2 → `deviceManagement`

`getAppLayout()`（返回 `"#<landing-layout> "`，注意**带尾随空格**，`deviceManagement.js:747-749`）、
`getAppLandingLayout(app)`、`getDevicesList`、`getGroupsList`、`getActiveGroupId`、
`deviceTileStatusUpdate(tileId,state,closeLoader,connectionLostTab,e)`、
`heightIncrementing`、`welcomScreenHeightChange`、`readDevicesData`、`fetchAllDevices`、`fetchAllGroups`、
`fetchRecentConnections`、`createDeviceTile`、`createDeviceFolder`、`addGroup`、`deleteGroup`、
`addDeviceToGroup`、`deleteDeviceFromGroup`、`deleteDevice`、`confirmRemoveDevFromGroup`、
`getNASComponents`、`setNASComponents`、`sortDevices`、`sortDevicesOnDisconnecting`、
`displayEventsLabelOnConnection`、`getPlaybackSpeed`、`getPlaybackShowEvents`、
`getManageTilesList`、`getGritTilesList`。
`[观察]` **`getAppLayout()` 的 `appLayouts` 只有 `SM`/`GRIT` 两个键**（`deviceManagement.js:740-743`），
当 `currentActiveApp` 是 `HOME`/`PI`/`CONVERT` 时返回 `"#undefined "`，选择器全部失效——
这是复现时必须处理的边界。

### 7.3 ↔ `genericView` / `genericConfig`

- status 组件依赖 `genericView.updateView`、`updateStatusIndicatorClrAndText`、
  `formatToSystemLocale`、`createDialog`、`closeDialog`、`showMaxLogsReachedPopup`、
  `isLogsSpaceAvailable`、`getLogsCount`、`showLoadingScreen`、`closeApplyingScreen`、
  `hideApplicationLoader`、`showConnectionLoader`、`hideConnectionLoader`、`removeDataLangAttr`。
- `genericConfig` 被 `saveConfiguration`/`loadConfiguration`/`menuBar`/所有 `processIncomingData` 调用：
  `placeCmdReq`、`sendCommand`、`saveConfigCommandSending`、`maxLogCountCheck`、
  `removeFeatureFrmCmdList`、`resetCommandObj`、`unloggingLogsOnWCOM`、`requestConfigComponents`、`getMessageId`。

### 7.4 → `menuBar`

`statusConfigClick(page, tab)`（切 page1/page2/config 的唯一入口，`menuBar.js:267-399`）、
`switchToConfig(menuItem, tab)`、`handleDynamicTilesLayout(tab)`、`getActiveTab(tab)`、
`processLanguage(tab)`、`hideEventsLayout`、`showUnsavedWarningDialog`、`checkUnSavedChanges`。
被 4 个 `switchToXxxConfig` 点击处理器调用：`radioStatus.js:44-51`、`spanStatus.js:18-25`、
`alignStatus.js:115-122`（同类还有若干 config 组件）。

### 7.5 → 其它

| 模块 | 被视图层调用 |
|---|---|
| `featuresList` | `getIsLongHorn`、`getIsGIII`、`getMarinePakSupported`、`getReceiverGeneration`、`getSPANSupported`、`isAlignSupported`、`getIsRadioTxSupported`、`getRadioType`、`getPositionModesSupported`、`isTerrastarSupported`、`getIsDualAntennaSupported`、`getIncreasedLogLimitSupport`、`getGPSCardPSN`、`getFirmwareVersion`/`setFirmwareVersion`、`getGIIIPortType`、`getDataPortState`、`isFeaturesListReady`、`gritFirmwareCheck` |
| `Common` | `getKeyByValue`（`:7`）、`getUnits`、`setNewConnectionFlag`、`isSameAppTab`、`getISODateTimeFormat` |
| `controller` | `openConnection`、`closeConnection`、`closePlayback`、`clearTab`、`listSerialPorts`、`requestlog`、`getDeviceConnectionSocket` |
| `deviceRestart` | `getMarinePakFresetActiveFlag`、`clearMarinePakFresetObj` |
| `events` | `processLanguage`、`updateData`、`updateEventsOntoUI`、`setEventNotificationFlag` |
| `livePlayback` | `isRecordingActive`、`setRecordingPath` |
| `help` | `helpContent()`、`appendHelpContent()`、`deviceStatusContent(color,tab)` |
| `gritJarvisInterface` | `createGritMainPanel`、`checkGritConnectionReady`、`gritConnectionSuccess`、`processLanguage`、`handleGRITLandingPageCommandResponse`、`checkActiveGRITConnection`、`activeGRITConnections`、`showITKBlockedDialog`、`getGritCompLogsRegister` |
| `gritlandingPage` | `fetchGritAllGroups`、`updateGritTile`、`updateReceiverManagement`、`setViewingReceiversStyles`、`deviceGroupChanged`、`processLanguage` |
| `serverModel` | `isMapSupported`、`isLuciadAvailableNow`、`isLuciadAvailable`、`displayVersion`、`currentVersion`、`newVersion`、`isUpdateAvailable` |
| `userStore` | `userStoreJSON`（直接改：`app.dynamic`、`app.defaultLayout`、`heightUnits`、`connectionMode`、`slider`、`theme`、`language`）、`getData([...])` 深拷贝读 |

`[观察]` `userStore.getData(["app","deviceManagement"])` 返回的是**深拷贝**（所以
`setUpMonitor.html:3007-3012` 那种「改 `alldevices[...]` 再指望落盘」的写法是无效写入——
代码先 `if(!alldevices["connectionMode"])` 再赋值，但对象未回写 `userStore`）。这是复现时必须
修掉的一段：`setUpMonitor.html:1089-1095` 与 `:3007-3013`。

---

## 8. 复现清单（R1..R50，逐条可验收）

**加载与外壳**

- `R1` 应用启动后先建 `BrowserWindow{show:false, backgroundThrottling:false}`，加载
  `view/html/index.html`，在 `ready-to-show` 时才 `show()`。`[观察] main.js:81,102,128-131`
- `R2` `index.html` 的脚本加载顺序必须保持「jQuery→jQueryUI→bootstrap→packery→draggabilly→model→controller→jarvisInterface→model→help→view 组件」；`jarvisInterface.js` 必须早于所有 `view/js/*.js`。`[观察] index.html:87-182`
- `R3` `welcome.js` 不得加入 `index.html` 的静态脚本表，必须通过 `welcome.html` 的 `<script>` 在 `.load()` 时执行；否则 `welcome` 未定义会使 `index.html:1101` 抛错。`[观察] welcome.html:149, index.html:1121`
- `R4` `.welcome-layout` 与 `.setUpMonitor-layout` 加载完成后都必须 `display:none`；页面初始可见的只有 splash。`[观察] index.html:1122, 1179`
- `R5` splash 进度条 `setInterval(...,37)` 逐 1% 递增到 100 后清除；`4000 ms` 后隐藏 splash、显示 `.banner-img`（flex）与 `.welcome-layout`（block）。`[观察] index.html:1050-1065, 1077-1110`
- `R6` splash 结束前必须执行 `if(theme=="dark-theme") body.classList.add("darkMode")`。`[观察] index.html:1071-1074`
- `R7` `Components.json` 存在时必须 `deviceManagement.setNASComponents()`，并据此移除 `#home-playback`/`#home-convert` 与对应 welcome 卡片。`[观察] index.html:1078-1088, 1116-1119`
- `R8` 4 s 到点后必须调用一次 `jarvisInterface.applyUserLanguagePreference(userStore.language)`。`[观察] index.html:1104-1107`
- `R9` `view/GRIT` 目录存在时置 `NovatelIdConstants.gritSupported=true` 并用 `$('head').append('<script>')` 动态注入 ≥20 个 GRIT 脚本（含 luciad 分支）。`[观察] index.html:1126-1177`

**Manage 可见性**

- `R10` Manage 界面只能由 `#sm-welcome` 的 click 处理器变为可见（或 `#home-setupmonitor` 转发），加载后不得自动显示。`[观察] welcome.js:140-179, setUpMonitor.html:196-199`
- `R11` 进入 Manage 必须按顺序做：隐藏非核心 app 布局 → 隐藏 welcome → 显示 setUpMonitor → 隐藏所有 `.landing-pages` → 显示 `.setupMonitor-landing-screen` → 标题改 "Manage" → 切图标 → 隐藏 `connType` 为 PI/GRIT 的 tab → `applyUserLanguagePreference` → `enableTabs("SM")` → 激活 `#tabs-1`。`[观察] welcome.js:141-168`
- `R12` `enableTabs(connType)` 必须把不匹配的 tab 用 `$("#tabs").tabs("disable", index)` 置灰而不是隐藏。`[观察] welcome.js:128-139`

**容器结构**

- `R13` `createMainPanel` 必须按 16 步固定顺序生成容器，且 `#fetch-loader-<tab>` 必须是 `#main-panel-<tab>` 的子节点、`#status-components-<tab>` 必须在 `#main-panel-<tab>` 内。`[观察] jarvisInterface.js:893-938`
- `R14` `#tabs-popup`、`overlay-popup`、`#helpModal`、`.translucent-layout`、`#connection-loader` 必须**每 tab 一份**，且所有选择器都必须带 `#<tab> ` 前缀。`[观察] jarvisInterface.js:1046-1140`
- `R15` config 页必须按机型三选一：标准 8 项 pill（Positioning/Ports/Logging/Align/SPAN/Radio/GNSS/Spoofing）、GIII 单 Logging + 重启提示、Longhorn 两页（Positioning/Logging）。`[观察] jarvisInterface.js:945-1033`
- `R16` `#status-config-<tab>` 必须含 `#statusPage1`（Positioning）、`#statusPage2`（Tracking）、`#resetDefault`（Reset layout to default）三项。`[观察] jarvisInterface.js:1035-1044`
- `R17` `createTile(tab,index,page)` 必须按 `index==0`→`#status-panel`、`page=="page2"`→`#status-components-page2`、否则→`#status-components` 落位，且元素 class 初始为 `tile status-tile`、id 为 `tile-<index>-<tab>`。`[观察] jarvisInterface.js:1215-1235`

**tile 布局**

- `R18` 每个 status tile 片段的**第一个子 div** 的 class 必须含 `*-status`（或 `satellite-view`），否则该 tile 不会出现在布局快照里。`[观察] dynamicTiles.js:502-505`
- `R19` Packery 必须用 `itemSelector:'.manage-tile'`、`columnWidth=floor((容器宽-4)/3)`、`gutter=2`、`transitionDuration:0`、`resize:false`。`[观察] dynamicTiles.js:309-327`
- `R20` 每个 tile 恒占 1 列，持久化只存 `{id, position:{left,top}}`，不得引入 span/宽高字段。`[推断] dynamicTiles.js:615-621, 572-578`
- `R21` 拖动手柄必须是 `.status-header`（各 tile 的 header 同时带 `drag-area` class），并且 `dragStart` 时必须禁用 `.statustiles-traffic` 的 pointer-events。`[观察] dynamicTiles.js:396-417, dynamicTiles.js:926-938`
- `R22` 拖动结束后必须 `saveLayout` 并写入 `userStore.userStoreJSON.app.dynamic[deviceTileId]`（键是设备 tile id，不是 tab id）。`[观察] dynamicTiles.js:440-454, 765-782`
- `R23` 布局变化时必须显示 Undo 横幅，10 s 后自动消失；点 Undo 必须还原上一个 `previousState` 并再存一次。`[观察] dynamicTiles.js:175-192, 212-275`
- `R24` 首次进入时必须抓取 `defaultLayout[deviceTileId]`，条件是「无该项 / 无 position 数据 / 项数与 tile 数不符 / id 集合与 dynamic 不一致 / 所有 tile 的 left 相同」。`[观察] dynamicTiles.js:377-391`
- `R25` 布局恢复的排序口径为「先 top（同行阈值 20 px）再 left」，取整到整数像素。`[观察] dynamicTiles.js:627-639`
- `R26` 关闭 tab 或重连前必须 `deletePackeryInstances(tab)`（内部先 `saveLayout`）。`[观察] setUpMonitor.html:866, genericView.js:657`

**page1 / page2 与配置页切换**

- `R27` 切到 page2 必须隐藏 `#status-components-<tab>`、显示 `#status-components-page2-<tab>`、把 `#resetDefault` 设为 `visibility:hidden`、并调用 `satelliteTracking.resetTrackingUI(tab)`（GIII 用 `giiiSatelliteTracking`）。`[观察] menuBar.js:381-392`
- `R28` 切到 page1 必须重新显示 page1、必要时补建 Packery（`getPackeryInstance==undefined` 且非丢失连接且 tab 可见时 `initialisePackery`），否则 `handleDynamicTilesLayout(tab)`。`[观察] menuBar.js:361-379`
- `R29` 当前停留页必须写回 `devicedetails.menu`（`statusPage1`/`statusPage2`/`menuConfig`）并在重连时由 `checkPersistPage` 还原。`[观察] menuBar.js:287,394；jarvisInterface.js:2621-2684`
- `R30` `showConnectionLoader(tab)` 必须在 1200 ms（addTab）/500 ms（GRIT）后 `hideConnectionLoader`，兜底 30 s。`[观察] setUpMonitor.html:408-418, genericView.js:1022-1035`

**语言**

- `R31` `__()` 必须解析到 `jsIn.translate`，字典由当前语言文件末尾的 `jsIn.addDict(Language.XX)` 写入；切换语言只换字典，不重建 DOM。`[观察] view/css/jsin.1.2.min.js:8, en.js:1923, jarvisInterface.js:1361`
- `R32` `applyUserLanguagePreference(languageId, tab)` 的第二参数必须被视为无效（实现忽略）。`[观察] jarvisInterface.js:1350-1352`
- `R33` `applyLanguageChanges` 必须用 `languageId.split("-")[0]` 与 `languageName.toLowerCase()` 匹配（如 `zh-CN`→`Chinese` 失败→回落 `en`）。`[观察] jarvisInterface.js:1355-1360`
- `R34` `statusComponentsProcessLanguage` 必须覆盖 20 个组件；`configComponentsProcessLanguage` 必须覆盖 9 个配置模块，并在 Longhorn/GIII/MarinePak 时追加对应 `processLanguage`。`[观察] jarvisInterface.js:1375-1435`
- `R35` 所有 `data-lang-*` 属性只能是**标记**，不得承载文案；文案一律由 `processLanguage()` 里的 `$('[data-lang-x]').html(__('X'))` 写入。`[观察] genericView.js:1076-1150`
- `R36` 动态生成文案前必须 `removeDataLangAttr(el)`（清除**所有** `data-lang` 前缀属性）再 `attr(newAttr,"")`。`[观察] genericView.js:1037-1046` 该函数在遍历 `attributes` 的同时 `removeAttr`，`[推断]` 会跳过相邻属性（活集合被修改）；复现时应先收集属性名再统一删除。
- `R37` `createDialog` 必须为标题和按钮派生 `data-lang-<key.toLowerCase()>`（key 由 `Common.getKeyByValue(Language[current], text)` 反查）；反查失败时按钮分支会抛 `TypeError`（标题分支有 `typeof` 保护）。复现必须给按钮分支加保护。`[观察] genericView.js:279-281, 307-312`
- `R38` 高度单位切换必须同时改写 `data-lang-height-msl` / `data-lang-height-ellipsoidal` 三个位置（statusBarHeader、positionStatus `.height-msl`、spanStatus `.height-msl`）。`[观察] jarvisInterface.js:1950-1958, 2035-2036`

**数据渲染与节流**

- `R39` `updateView` 必须按第 5.1 的规则拼 id，且 `tab !== NovatelIdConstants.tabName` 时立即 return。`[观察] genericView.js:25-77`
- `R40` 每个组件 emitter 必须实现「活动 tab 直渲、其它 tab 存 `cachedData[tab][component]`」的双分支，且 `tabs-1` 与空 tabName 视为活动。`[观察] jarvisInterface.js:6725-6812`
- `R41` 切 tab 必须重放 `cachedData` 中 11 类通道。`[观察] jarvisInterface.js:5449-5495, setUpMonitor.html:344-356`
- `R42` `elementIds` 缓存必须按 `tab+feature` 分桶，`solStatus`/`headingTitle` 永不缓存，`deleteElementIds(tab)` 按前缀清除。`[观察] genericView.js:81-93, 779-787`
- `R43` `showApplicationLoader()` 默认 30 s 兜底，连接流程用 40 s；超时后必须把 `#loader-text-id` 文案复位为 `CONNECTING`。`[观察] genericView.js:1008-1021, setUpMonitor.html:1454,1505,1521`

**已知缺陷必须在复现时修正**

- `R44` `updateAppBackgroundThrottling` 通道当前无发送方且窗口固定 `backgroundThrottling:false`；复现需二选一：删掉无效通道，或在窗口失焦时真正发消息并在主进程生效。`[观察] main.js:81, 206-208`
- `R45` `getTabOpenState` 查询的 `#setupMonitorConn_*` / `#gritConn_*` 在全仓不存在，恒返回 `false` 且无调用方；复现应改为查询 `#<tab>` 是否在 DOM 中。`[观察] jarvisInterface.js:1436-1449`
- `R46` `tileMovement`、`application.js`、`index.js`、`view/welcome/welcome.html`、`genericView.tilesAlignment`、`pagination.js`、`ru.js` 均为无调用方的死代码，复现时不实现，但应在文档中标注为「2.11.0 遗留」。`[观察] tileMovement.js:539；application.js:1-92；index.js:1-31；genericView.js:561-592,1178；pagination.js:24,1099；languageSettings.json`

**其它必须落地的细节**

- `R47` 设备类型标签必须写成 `data-lang-<connectionType>-type`（`data-lang-network-type`/`data-lang-serial-type`/`data-lang-USB-type`）。`[观察] setUpMonitor.html:1830, 2699`
- `R48` `Sort by` 下拉必须按 `#device-sort li.selected` 的 index 决定 A-Z（1）/Z-A（2），且用 `.appendTo(".device-tiles-view")` 原地重排 DOM。`[观察] setUpMonitor.html:313-332`
- `R49` 关闭 tab 时若日志在写必须先弹 `FILE_LOGGING_CLOSE_WARNING`（YES 才 `stopalllogs` 并关闭）。`[观察] setUpMonitor.html:871-917`
- `R50` `checkTileSpacing(tab)` 必须在建完 tile 后 100 ms 执行，给 MarinePak 的 pppCorrections 及其后第三个 tile 加 `spaceRemoval`。`[观察] jarvisInterface.js:1965-1967, 2584-2619`

**R51 起为「重实现过程中新增的事实」**，全部来自 `04_重实现/packages/view` 的落地过程（读源码时发现的、
R1–R50 未覆盖或写错的地方）。

- `R51` 连接超时是**两个独立定时器**：35 s（`jarvisInterface.js:820-839`，回调整体放弃）与 30 s
  （`:3153-3176` 的 `conTimeOut[tab]`，在 `connectionStatus` 成功分支内启动、等 `connectionReady`）。
  §2.6/§6.1 原先只写了 35 s。复现必须两者都实现，且 `connectionStatus` 的两支都要 `clearTimeout` 35 s 那个。
  `[观察]`
- `R52` `showApplicationLoader(40000)` 超时后**先 `hideApplicationLoader()` 再把 `#loader-text-id` 写成
  `CONNECTING`**，是「隐藏 + 改名」而不是只复位文案（`genericView.js:1008-1021` 与
  `setUpMonitor.html:1454,1505,1521`）。`[观察]`
- `R53` tab 级连接加载器的 30 s 兜底在 `addTab` 路径上**实际不会触发**：
  `hideConnectionLoader` 会 `clearTimeout` 掉兜底定时器（`genericView.js:1022-1035`），而它 1200 ms 就被调用。
  想验证 30 s 兜底必须单独构造路径。`[观察]`
- `R54` 静态 `#tabs-1` 不是普通 tab：它是 `<li class="tab-title-list"><a class="sm-title" href="#tabs-1">`
  (`setUpMonitor.html:4-11`)，**没有 `connType` 属性**；而 `#add-newtab` 是一个塞在 `<ul>` 里的 `<div>`
  (`:12`，畸形 HTML)。因此 `enableTabs` 的 `[connType=…]` 过滤永远不会碰到这两个元素，
  `countFor()` 天然只数设备 tab。`[观察]`
- `R55` `addTab` 把 tab id 同时当 CSS 类加在 `li` 上（`li.addClass(id)`，`setUpMonitor.html:393`），
  于是 `$(".<panelId> .ui-icon-close")` 这类选择器成立；并且 `addTab` 自己就
  `tabs("option","active",index)` 激活新 tab（`:403`）。连接上限判定为 `length > maxConnection - 1`
  （`:481`），即第 11 条被挡。`[观察]`
- `R56` `positionStatus.html:12-13` 的「why this amber / why this red」两个 `<a>` 被 `<!-- -->` 注释掉了，
  所以 `data-lang-why-this-amber` / `-why-this-red` **在 DOM 里根本不存在**（`markers()` 不会列出它们），
  §9.4 的取值清单要据此修正。`[观察]`
- `R57` `elementIds` 缓存必须判「节点是否仍在文档中」才能复用：原实现只判 `null`
  （`genericView.js:83`），而 `innerHTML` 整块替换后旧节点会成为孤儿，原实现会把整块数据写进脱离文档的节点、
  页面上看不到更新。复现改为 `isConnected` 判定。`[观察]`（`minidom` 为此补了 `isConnected` 与
  断开子节点 back-pointer 的 `removeAllChildren()`）
- `R58` 语言切换的 `languageId` 实际取值是 `<languageName 小写>-lang`（`index.html:1145,1212`、
  `welcome.js:44-46`），所以 `split('-')[0]` 命中的是**语言名**而不是 ISO 码：`german-lang` → `de`，
  而 `de-DE` 会匹配失败回落 `en`。写测试时按 ISO 码断言会得到与产品相反的结果。`[观察]`
- `R59` `data-lang-*` → `Language` key 的映射**不能靠属性名推导**（`data-lang-connection-lost-content`
  对应的是 `DATACONNECTIONLOST`），原实现逐处硬编码。自动应用只能做「候选拼写命中字典才写」的尽力而为，
  缺键时**必须保持原 Markdown/HTML 文本不动**。`[观察]` + `[推断]`
- `R60` tile 包装层的**最终** class 不是 `createTile` 写的那个：`createTile` 只写
  `"tile status-tile"`（`:1217`），随后调用方逐 tile 改写 —— statusBar 被改成 **`"tile receiverPanel"`**
  （`:1482`，连 `status-tile` 都没有了），其余是 `"tile manage-tile status-tile"`
  （`:1563-1566`），MarinePak 的 positionStatus 额外带 `mPak-posTile`。
  这正是 Packery（`itemSelector: '.manage-tile'`）**看不见 statusBar tile** 的原因，
  也是 §3.2「statusBar 挂 `#status-panel`」之外必须补的一条：它连网格项都不是。
  `[观察]`（落地时 `layout.snapshot()` 为空才暴露出来；新增 `ids.tileClassFor()`）
- `R61` §6.5 对 `isLayoutDifferent()` 的读法**是反的**。逐行跟踪 `dynamicTiles.js:645-763` 可见：
  「全部 tile 都在默认位置 60 px 内」时它返回 **true**，任一超出则返回 false，而调用点
  `:880` 是 `if (… === false) display:block` —— 源码的可观察行为**已经**是「有差异才显示 Reset」。
  即原实现不是 bug，是注释/命名误导；复现按「有差异才显示」实现即可。`[观察]`（`layout.ts` 的
  `resetButtonVisible()` 按此实现并在测试注释里留了逐行轨迹）
- `R62` `tileElements()` / `captureLayout()` 的口径是 `container.children` 里带 `.manage-tile` 的元素，
  因此「往 `#status-components-<tab>` 里 append 的非 tile 节点（如 undo 横幅）会被算进 `$tilesLength`」
  这条原实现缺陷可以避免：判定 tile 数一律用 `.manage-tile`，不要用 `children('div').length`。`[观察]`
- `R63` §3.2 表格的「标准 OEM（含 MarinePak）」一行其实是 **MarinePak 分支**（`:1570-1684`）的原样顺序；
  纯 OEM7 分支（`:1686-1831`）另有一块 `deviceInfo`，且 `interferenceStatus`/`logStatus` 排在
  `satelliteView` **之前**、`pppCorrections` 在其**之后**。两条分支都已在其 `tiles.ts` 里实现，
  用 `isMarinePak` 分流。`[观察]`
- `R64` §3.2 的 GIII 行（positionStatus→agcStatus）取自 `:1857-1933`，那段位于
  `if(!isLongHorn && !isGIII)` 之内，**永远不可达**；GIII 的活路径是 `:2100-2176`，
  除 positionStatus 外还有 `deviceInfo`/`satelliteView`/`logStatus`。文档顺序作为子序列仍然成立。`[观察]`
- `R65` §3.3 的身份表缺一行：`satelliteTracking` 的首个子 div 是 `satelliteTracking-status`
  （`satelliteTracking.html` 与 `giii-satelliteTracking.html` 都是），它满足 `endsWith('-status')`，
  所以 page2 的跟踪图**确实是** Packery 可见瓦片。另有两个容易踩的重复 class：
  `radioStatus.html` 内部 header 复用了 `span-status-header`（`#<tab> .span-status-header` 会同时命中 radio 瓦片）；
  `giii-logStatus.html` 的根 div 自带片段级 `id="giii-logStatus"`（每 tab 重复，必须加前缀）。
  还有 `statusBar.html` 第 1 行是空行，**首个节点是空白文本**，`firstElementChild` 才是
  `<div class="row status-bar">` —— 取身份时必须用 `firstElementChild` 而不是 `firstChild`。`[观察]`
- `R66` `#connection-loader` 与菜单布局的 id 都是**字面量 + 前缀消歧**，不能改成每 tab 唯一：
  `#connection-loader`（`:1129`）、`#loader-text-id`/`#fetch-loader-tabs-1`（`:1130`，后者写死了 `tabs-1`）。
  菜单布局则是 `<name>-layout_<tab>`（`createMenuComponents`，`:1237-1286`），
  与容器 id 的 `<name>-<tab>` 规则不同。`[观察]`（`ids.connectionLoaderId()` 已改为返回字面量并新增
  `connectionLoaderSelector(tab)`）

---

## 9. 未解之处

1. **`help.js`（1.34 MB）未通读**：`help.helpContent()` 返回的结构、`help.appendHelpContent()` 如何按
   tile 的 `need-help` 链接定位章节，只能确认调用点（`setUpMonitor.html:333-335`、
   `jarvisInterface.js:1119-1121`）。要确定「每个 tile 的帮助锚点」，需读 `help.js` 的
   key 结构与 `help.deviceStatusContent(color,tab)` 分支。
2. **GRIT 侧视图未纳入**：`#grit-status-panel`/`#grit-status-components` 的建法只从
   `createTile` 的条件分支推出（`jarvisInterface.js:1219-1232`），`gritStatusBar.js`（50 KB）、
   `gritMenuBar.js`、`gritEvents.js` 未读，故 GRIT tab 的 page1 顺序、tile 集合无法给出同级精度的表。
3. **Packery 的 1 列结论仍是推断**：`packery.pkgd.min.js`（33 KB，minified）未逐行核对
   `_applyGridGutter` / `_setRectSize` 的取整行为。要坐实「恒 1 列」，需在真实运行环境里
   对 `.manage-tile` 读 `getComputedStyle().width` 与 `packeryItem.rect.width` 各采样一次
   （同时覆盖 1280/1920/2560 三档窗口宽度）。
4. **`data-lang-*` 的「全部取值」无法穷举**：属性名由运行时反查 `Language` key 生成
   （`genericView.js:281,311`；`setUpMonitor.html:470,1830`），理论上取值集合 = `en.js` 的 1900+
   个 key 的小写形式 + 手工特例（`data-lang-<type>-type`、`data-lang-height-msl/-ellipsoidal`、
   `data-lang-tile-repositioned`、`data-tile-nodata`）。本文给出**生成规则**而非清单；要出全量清单，
   需在运行时遍历 `document.querySelectorAll('[data-lang-*]')` 并导出属性名集合。
5. **4 s splash 定时器与异步 `.load` 的竞态是否真实发生**：本文只指出无同步信号（2.4），
   未在慢 I/O 环境实测。要确认需在 100 MB/s 以下磁盘或人为延迟 `file://` 读取的条件下录屏。
6. **`eg.js`（阿拉伯语，118 KB）是否参与 RTL 布局**：`style.css` 中未见 `dir="rtl"` 或
   `[dir=rtl]` 规则（grep 未命中），但 `languageSettings.json` 登记了 Arabic。需核对
   `eg.js` 是否只换文案、以及是否存在运行时的 `document.body.dir` 赋值（未找到）。
7. **`pagination.js` 的真实消费方**：Manage 视图无调用；`loggingConfig.js`/`deviceExport.js`/
   `gritEvents.js` 等大文件未全读，不能排除 GRIT 事件列表在用。
8. **`updateApplication.js` 的完整职责**：只确认了 `processLanguage()` 与
   `readLinuxVersion`，其 703 行中的版本比对/下载分支未读，故「非核心 app 版本横幅」
   （`#new-noncore-app-version-updatebtn`，`index.html:260`）的完整驱动链未闭环。

---

## 10. 外部参考

`00_原始/`、`02_证据/` 目录当前为空，工作区内**没有任何 NovAtel PDF 手册**可供交叉引用。
因此本节只记录「本子系统对应的产品文档面」，不虚构章节号：

| 需对照的产品文档面 | 本子系统对应实现 | 状态 |
|---|---|---|
| NovAtel Application Suite User Guide —— 「Manage」页签、状态 tile 与 RAG 指示灯说明 | `statusbar.js`、各 `*-status` tile、`genericView.updateStatusIndicatorClrAndText` | 无 PDF，`[未知]` |
| 同上 —— 「Layout / Customize dashboard」 | `dynamicTiles.js` 全部 | 无 PDF，`[未知]` |
| 同上 —— 「Language / Theme 设置」 | `jarvisInterface.applyLanguageChanges`、`body.darkMode` | 无 PDF，`[未知]` |
| OEM7 / OEM6 固件手册的 `RXSTATUS`、`BESTPOS`、`INSPVAX`、`HEADING2` 等日志字段定义 | 仅被 `statusbar.js`/`spanStatus.js`/`alignStatus.js` 消费（字段名见第 3.6 节） | 属解析子系统，本层不引用 |

`[推断]` 由于本子系统是纯表现层，其可验证性完全来自「DOM 结构与事件时序」，
不依赖任何协议文档；复现时真正需要外部依据的是 `model/logparsers.js` 的字段比例因子，
那属于解析子系统的文档范围。

---

## 11. status 组件实现期补充（R67–R80）

这些条目只补充实现所依赖的既有源码事实，不改变 §3.6/§4.5/§5 的接口约定。范围均指
`01_解包/app/view/` 下的 shipped JavaScript 与 HTML；实现和逐组件断言位于
`04_重实现/packages/view/src/status/` 与 `test/status-components.test.ts`。

- `R67` statusBar 的 BESTPOS 显示使用经纬度 7 位小数、高度 2 位小数；高度是否叠加
  `undulation` 由设备级 `heightUnits` 决定，内部闪存占用按 `usedStorage/totalStorage*100`
  取整。依据：`js/statusbar.js:72-86,121-130,349-356`；
  `statusBar.html:20-74`。`[观察]`
- `R68` positionStatus 的 RAG 不是单一 solutionStatus 开关：恶化状态、PPP 中间态、
  survey 进行中、已配置 PSRDIFF/Rover 但活动模式不符，分别进入 red/amber 分支。
  `INS_INACTIVE` 在 SPAN 组件中仍映射为 **bad**，这是一个看起来反直觉但必须镜像的行为。
  依据：`js/positionStatus.js:89-234,326-397`、`js/spanStatus.js:5-14,48-200`。`[观察]`
- `R69` positionStatus 的配置模式显示把 `PSRDIFF ROVER` 映射为 `DGNSS`、NTRIP client/server
  映射为 RTK rover/base；最低选中的模式以 `activePosMode` 标记。依据：
  `js/positionStatus.js:398-530`；`positionStatus.html:25-38`。`[观察]`
- `R70` portStatus 只在 INPUT/OUTPUT 类型非 `NONE`（且不是 SCOM/CCOM/FILE/WCOM）时把
  interface-mode 行纳入列表；PORTSTATS 与前帧计数比较决定 green，未变化为 yellow，
  RXSTATUS 的端口 bit 为 1 时该端口整体为 red。依据：`js/portStatus.js:30-229,230-433,434-462`。`[观察]`
- `R71` deviceInfo 的 CPU/存储边界是 `>80 && <=90` 为 amber、`>90` 为 red、
  `<=80` 为 green；HWMONITOR 的 status 高字节 1/3 为 amber、2/4 为 red。
  依据：`model/NovatelIdConstants.js:421-436`、`js/deviceInfo.js:11-134,150-407`。`[观察]`
- `R72` alignStatus 只有 dual-antenna、Wi-Fi alignment、align-automation 至少一个 ENABLE
  时才退出 idle；启用后 HEADING2 `solStatus == 0` 为 green，否则 red，且 red 分支把
  heading/pitch/baseline/标准差全部显示为 `--`。依据：`js/alignStatus.js:3-127`。`[观察]`
- `R73` radioStatus 的 `READY/BUSY/ERROR/其它` 分别映射 green/amber/red/idle；
  SATELDETECT 只记录 port，不改变状态灯。依据：`js/radioStatus.js:2-35`。`[观察]`
- `R74` interferenceStatus 的 `noOfEntries == 0` 或只有 statistical-analysis 行为
  “Not Detected/green”；存在 SPECTRALANALYSIS 行为 “Detected/amber”；配置
  `rfpath == "NONE"` 时强制 Disabled/idle。依据：`js/interferencestatus.js:4-87`。`[观察]`
- `R75` logStatus 的文件大小先按 `fileSize * 0.001` 取整再加 ` KB`（十进制换算，不是
  1024 进制）；无文件打开时隐藏文件名/大小/消息并转 idle。依据：
  `logStatus/logStatus.js:29-108,126-285`。`[观察]`
- `R76` AGCINFO 的 rfType/cardId/flags 不是普通 payload 字段，而是从 statusWord 的
  bit 段派生；pulseWidth 为 0/1000 或 VGA 连续 3 秒 rail 时 red，pulseWidth 越过
  100..900 范围或 bins 异常时 amber。依据：`agcStatus/agcStatus.js:129-287,541-586`。`[观察]`
- `R77` pppCorrections 将 LBAND C/No 按 60 dB/Hz 画满、bit success rate 按
  94/98/100% 分界，并用 `(首/次/第三 beam)` 的多行详情展示；订阅、锁定和 NTRIP
  是三组独立状态。依据：`pppCorrections/pppCorrections.js:14-340,348-589`。`[观察]`
- `R78` satelliteView 的 VDOP 是 `sqrt(pdop²-hdop²)`；只有 hdop/pdop 同时为 9999
  才透传 9999，其它非法值落入 9999。好星数至少 4 才 green。依据：
  `js/satelliteView.js:4-57`。`[观察]`
- `R79` OEM6/OEMSTAR 的 satelliteTracking 以好星数至少 4 为 green；OEM7 的现有分支
  还要求 GPS 好星数 **严格大于 4**，再根据 RXSTATUS aux4 低 2 bit 的 0/1/其它
  映射 green/amber/red。依据：`satelliteTracking/satelliteTracking.js:187-246`。`[观察]`
- `R80` Longhorn GPGST 的 2D SD 为 `sqrt(STDLatitude²+STDLongitude²)*100 cm`，
  height SD 为 `STDAltitude*100 cm`；PVA 消息同时驱动位置、姿态、速度与 SPAN
  状态，2D/height 两个图表共享最近 10 分钟窗口。依据：
  `js/longhornStatusUI.js:266-820,902-1058,1237-1241`。`[观察]`
- `R81` `TRACKSTAT` 的主/副天线来源是 SBF header 的 message-type bit 0，不是 payload
  字段；同一位在源码中先经过 response 分支，但仍继续走 log 解析，因此不能像普通 command
  response 一样提前 `return`。`SATVIS2` 的 `sequence` 取 header 偏移 10 的 u16。
  依据：`model/logparsers.js:757-758,920-933,950-990,2974-3014`。
  实现：`packages/session/src/session.ts:254-260,278-298,303-322`、
  `packages/protocol/src/status-fields.ts:333-345`。测试：
  `packages/protocol/test/repeated.test.ts` 的 “TRACKSTAT derives the antenna…”、
  `packages/session/test/session.test.ts` 的 “TRACKSTAT message-type bit 0…”。`[观察]`
- `R82` `CHANCONFIGLIST` 不是连续 4-byte signalType 数组：固定头为 setInUse、
  numOfChanConfig，随后每组为 numOfSignalTypes 和若干 `(numChans, signalType)` 8-byte
  记录；只有 setInUse 指向的配置进入 `currentChanConfigData`。
  依据：`model/logparsers.js:1533-1572`。实现：
  `packages/protocol/src/status-fields.ts:216-260,401-405`。测试：
  `packages/protocol/test/repeated.test.ts` 的 “CHANCONFIGLIST follows…”与
  `packages/view/test/status-components.test.ts:525`。`[观察]`
- `R83` `CARDSTATUS` 的 fans 块位于 `20 + cardsCount * 60`：先读 u32 fanCount，
  每个风扇再读两个 u16；该后段不包含在 cards 的 60-byte 循环内。
  依据：`model/logparsers.js:3234-3265`。实现：
  `packages/protocol/src/status-fields.ts:262-287,444-454`。测试：
  `packages/protocol/test/repeated.test.ts` 的 “CARDSTATUS exposes the fan block…”。`[观察]`
- `R84` AGC 首轮只创建一次 card 列表并激活第一张卡；后续数据只重绘当前卡，但仍用全部
  card 计算 RAG。详情弹窗包含六 bin、AGC word、pulse width、modulus、噪声和每个
  statusWord 位域，并把 Plotly 图迁移到 `agcStatusPopupPlot-<tab>`。
  依据：`agcStatus/agcStatus.js:103-179,229-287,345-500,541-586`。实现：
  `packages/view/src/status/agcStatus.ts:26-530`（详情入口 `:429`）；测试：
  `packages/view/test/status-components.test.ts:1322,1362`。`[观察]`
- `R85` PPP 的 signal-strength 与 bit-success-rate 行始终按同一 C/No 降序重排；
  “Show Details/Hide Details”由 class 和无障碍标记翻转，默认首次更新保留全部行。
  satellite status `access==1 && syncState==0` 时两个进度条宽度都归零。
  依据：`pppCorrections/pppCorrections.js:471,494-589`。实现：
  `packages/view/src/status/pppCorrections.ts:36-446`；测试：
  `packages/view/test/status-components.test.ts:369`。`[观察]`
- `R86` Longhorn GGA 的 quality 只把 1 映射为 warning、4/5 为 good，并切换
  `.single/.RTK.activePosMode`；GGA 到达后 NMEA 227 不再覆盖时间。GSA/GSV 合成
  `completeSatsObj`，供卫星视图与 good-sat count 共用；CPU `>=90` 的红色要延迟 5 s，
  温度/天线 status=1 则立即红色。
  依据：`js/longhornStatusUI.js:164-246,317-430,485-700`。实现：
  `packages/view/src/status/longhornStatusUI.ts:22-815`、
  `packages/view/src/status/satelliteView.ts:73-340`；测试：
  `packages/view/test/status-components.test.ts:1116,1141,1166,1192`。`[观察]`
- `R87` `LOGSTATUS` 对 OEM7 的文件打开集合是 `{1,4,6}`、OEM6 是 `{0,2,3}`；
  GIII 固定 `isFileOpen=true`，没有本地文件信息时仍显示 Idle/Logging off。
  FILESTATUS 还要回写 statusBar 的 RAG 标记。依据：
  `logStatus/logStatus.js:29-108,126-155,280-285`。实现：
  `packages/view/src/status/logStatus.ts:20-224`、
  `packages/view/src/status/index.ts:48-75`；测试：
  `packages/view/test/status-components.test.ts:268,1100`。`[观察]`
- `R88` `message-specs.json` 中全部 31 条 `repeat:true` 消息可按布局形态分成 26 个固定步长块表
  和 5 个非固定记录：VALIDMODELS/AUTHCODES 为变长字符串记录，
  INSCONFIG/ITFILTTABLE/ITPROGFILTBANK 为多级计数。固定块及步长证据：
  GGAQUALITY `8`、MODELFEATURES `8`、ITPSDFINAL/ITPSDDETECT `2`（样本），
  ITBANDPASSBANK `24`、SKCALIBRATESTATUS `20`、ETHSTATUS/GIII VERSION `232`。
  依据：`model/logparsers.js:826-851,1010-1049,1116-1176,1618-1657,1688-1733,
  1841-1865,1933-1988,2522-2548,2685-2717,3112-3157`。实现：
  `tools/gen_repeat_layouts.js`、`packages/protocol/data/repeat-layouts.json`。`[观察]`
- `R89` 5 个非固定重复消息不能共享一个固定 `blockSize`：VALIDMODELS/AUTHCODES 的下一记录
  起点由 NUL 对齐后的字符串结束位置决定；INSCONFIG 先 N 个 36-byte translation 再
  rotations；ITFILTTABLE 是先记录后 `24×noOfProgFilters`；ITPROGFILTBANK 是
  `8 + 28×noOfBanks`。依据：
  `model/logparsers.js:1618-1657,1688-1733,1933-1988,2522-2548,1029-1049`。
  实现：`packages/protocol/src/decode.ts:237-550` 的 `custom` 布局解码器。`[观察]`
- `R90` `decodeRepeated` 的 `declaredCount` 取自计数字段，`decodedCount` 只计完整记录；
  capacity 不足时 `truncated=true`，不得伪造缺失记录。自定义变长/多级布局也必须保持同一
  语义。依据：`model/logparsers.js:826-851,1029-1049,1116-1176,1618-1657,1688-1733,
  1933-1988,2522-2548`。测试：`packages/protocol/test/repeated.test.ts` 的三项 truncation
  断言、`packages/session/test/session.test.ts` 的 ReceiverSession GGAQUALITY 截断用例。`[观察]`
- `R91` `genericView.updateView` 的 detached cache、`undefined/null` 文本强制、
  `removeDataLangAttr` 活属性删除以及 `getTabOpenState` 死 id 查询均属 2.11.0 可观察行为；
  重实现默认镜像它们，只有 `mirrorDefects:false` / `mirrorOpenState:false` 才启用修正。
  依据：`view/genericView.js:25-30,81-115,267-276`、
  `jarvisInterface.js` 的 `getTabOpenState` 调用处（R45）。实现：
  `packages/view/src/view.ts:70-90,175-200,277-303`、
  `packages/view/src/manage.ts:62,133`、`packages/view/src/tabs.ts:64,127,262-267`。
  测试：`packages/view/test/view.test.ts:71,78,110,121,190,207`、
  `packages/view/test/manage.test.ts:137`、`packages/view/test/tabs.test.ts:224-236`。`[观察]`

## 12. Status 页补 tile（§2.3.4–§2.3.12）与三个缺页（§2.2.7/§2.2.11/§2.2.12）——本轮实测

口径：数据源只有抓包（`/api/records`，capture 模式），接收机 COM10 被别的进程占着，本轮**没有**
接实时链路。控件值一律从浏览器 DOM 读，原始值从同一份 `.sbf` 解码出来，两边逐字段对过。
截图与对照脚本见 §12.5。

### 12.1 补的 7 块 tile

`packages/app/src/web/panels/manage.js` 的 `.mg-grid` 现在按顺序是：Positioning / Device /
Interference / **Ports** / **Logging** / Satellite View（宽）/ **PPP Corrections** / **Radio** /
**ALIGN** / **SPAN** / **Satellite Tracking**（宽）。后七块是本轮新增或重写。

| tile | 手册 | 读的报文 | 每列/每行怎么来 |
|---|---|---|---|
| Ports | 2.3.4 | `SERIALCONFIG #1246`（每串口一条）、`PORTSTATS #72`（一条，内含 30 个 port 项）、`LOGLIST #5`、`INTERFACEMODE #3` | Rate = `baud_rate` + `data_bits/parity/stop_bits`；Logs = `log_list[]` 里该 `log_port_address` 的条数；State 由 `PORTSTATS` 的 `framing_errors/parity_errors/over_runs`（红）与 rx/tx 字节（绿）判，`--` 只在整份记录缺失时出现 |
| Logging | 2.3.5 | `FILESTATUS #2127` | Status = `file_status`；Size = `file_size`；Name = `file_name`；Messages = 该文件的日志列表 |
| PPP Corrections | 2.3.10 | `TERRASTARINFO #1719` / `OCEANIXINFO #2159` / `VERIPOSINFO #1728`、`TERRASTARSTATUS #1729` / `OCEANIXSTATUS #2160` / `VERIPOSDECODERSTATUS #2075`、`LBANDTRACKSTAT #1201`、`NTRIPCONFIG #1249`、`PPPPOS #1538`、`PPPDOP #1997` / `PPPDOP2 #1546` | Subscribed = `operating_mode` + `subscription_details`；Locked / Primary Signal / Signal Strength / Bit Success Rate 各自等 `#1729/#2160/#2075`、`#1201`（缺则 `--`）；PPP Position / DOP 直接印报文原值 |
| Radio | 2.3.11 | `SATELSTATUS #2205`、`SATELDETECT #2204` | 有记录才印 `satel_status` / `comm_port` / `failed_command`，没有就是手册的 Off（灰） |
| ALIGN | 2.3.8 | `HEADING2 #1335`，回退 `DUALANTENNAALIGN #1761` | Heading/Pitch 带 `heading_std_dev`/`pitch_std_dev`；Baseline = `b_length` |
| SPAN | 2.3.9 | `INSPVAX #1465` | Status/Position Type/Azimuth/Pitch/Roll/三路速度/经纬高，各自带 `*_std_dev`；**Alignment 与 Converged 在 INSPVAX 里没有独立字段，保持 `--`**，不拿标准差倒推 |
| Satellite Tracking | 2.3.12 | `RANGE #43` 最新历元 + `SATVIS2 #1043` | 每星一行、每信号（`(c_status>>21)&0x1f`）一根条；C/No = `obs[].C_No`，Lock = `obs[].lock_time`，El/Az = SATVIS2 的 `sat_vis_list[].elevation/azimuth`；阈值照 `satelliteTracking.js:71-72`（C/No 20/35，锁星 1800/3600 s） |

信号名表 `RANGE_SIGNALS` 抄自 `packages/graph/src/range-charts.ts:43-67`（那张表是拿 golden 逐格
对过的）；表里没有的系统印 `S<system>·s<signal>`，不借名字。`[观察]`

### 12.2 「显示值 vs 抓包原字段」逐条对照

b1 = `live-20261031/b1-20261101.sbf`（2026-10-31 14:23 UTC，机型 `PFNLYNTBN` / `OEM729-2.03`）；
b4 = `live-20261031/b4-20261101.sbf`（2026-11-01 03:44 UTC，唯一带 PPP / L-Band 订阅记录的一份）。

| tile | 字段 | 页面显示（capture 模式） | 抓包原始字段 | 判定 |
|---|---|---|---|---|
| Ports | COM1 Rate | `9600 8N1` | `SERIALCONFIG`: `port=COM1, baud_rate=9600, data_bits=8, parity=N, stop_bits=1` | 一致 |
| Ports | COM2 / COM3 Rate | `38400 8N1` | `SERIALCONFIG` 记录 1/2：`baud_rate=38400` | 一致 |
| Ports | COM3 State | `Error`（行左红条 + tile 角标 `Error`） | `PORTSTATS[2]`: `port=COM3, framing_errors=393838` | 一致（接收机自己的计数器动了） |
| Ports | USB1 Rate | `--` | `SERIALCONFIG` 没有 USB1 记录 | 一致（不编 9600） |
| Ports | COM1 Logs | `--` | b1 里没有 `LOGLIST #5` | 一致（不印 0） |
| Ports | 行数 | 7 行（COM1/2/3、USB1/2/3、WCOM1） | `PORTSTATS` 有 30 个 port 项，其余 23 个 rx=tx=0 且无配置 | 一致（0 流量不占行） |
| Logging | Status / Size / Name / Messages | `--`（角标 `Off` 灰） | b1 无 `FILESTATUS #2127`；本机 `LOG FILESTATUS ONCE` → `<ERROR:Message is invalid for this model`（`17_A1_连接层与Terminal.md` §17.8.6） | 一致（无文件日志机型） |
| PPP | Subscribed | `Unsubscribed · UNASSIGNED · 0x00000000`（b4） | `TERRASTARINFO`: `operating_mode=UNASSIGNED`, `subscription_details=0(00000000)` | 一致 |
| PPP | PPP Position | `INSUFFICIENT_OBS / NONE · 0 sv` | `PPPPOS`: `solution_status=INSUFFICIENT_OBS`, `position_type=NONE`, `num_svs=0` | 一致 |
| PPP | DOP (G/P/H/V) | `9999.00 / 9999.00 / 9999.00 / --` | `PPPDOP`: `gdop=pdop=hdop=9999`；该记录没有 `vdop`（`PPPDOP2` 才有） | 一致（缺的印 `--`，没把 9999 改成 0） |
| PPP | Lband Tracking | `--` | b4 无 `LBANDTRACKSTAT #1201` | 一致 |
| PPP | PPP NTRIP (SID) Link | `Off` | b4 无 `NTRIPCONFIG #1249` | 一致（未启用） |
| Radio | Status / Comm Port | `--` `--`（角标 `Off`） | b1/b4 都没有 `SATELSTATUS #2205` / `SATELDETECT #2204` | 一致（手册 2.3.11：只在外接发射电台的系统上出现） |
| ALIGN | Heading / Pitch / Baseline | `--` `--` `--`（角标 `Off`） | 无 `HEADING2 #1335`；`MODELFEATURES #1329` feature 10 `ALIGN_HEADING=AUTHORIZED`、feature 28 `ANTENNA=SINGLE` | 一致（单天线出不了航向） |
| SPAN | 全部 13 行 | `--`（角标 `Off`） | 无 `INSPVAX #1465`；`MODELFEATURES` feature 23 `IMU=UNAUTHORIZED`、feature 22 `INS=UNAUTHORIZED` | 一致（该机型没有 SPAN） |
| Satellite Tracking | 首行 GPS 1 | `GPS 1 · GPS_L1_CA 42.0 dB-Hz · GPS_L5_Q 43.1 · GPS_L2_CM 42.2 · 17.5° / 45.5°` | RANGE 最新历元 `sv_prn=1` 三条：`C_No=42.0400/42.2305/43.1488`，`lock_time=1476.1/18317.1/18086.6`；`SATVIS2` GPS 记录 `sat_vis_list[6]`：`elevation=17.5581`、`azimuth=45.4961` | 一致（42.04→42.0、43.15→43.1、42.23→42.2 是 1 位小数显示） |
| Satellite Tracking | 历元 | `RANGE (#43) 14:24:15 UTC · 29 颗 / 79 个信号` | b1 共 531 个 RANGE 历元，最后一个 `2026-10-31T14:24:15.150Z`；SATVIS2 最新一版 `14:23:55.000Z`（比 RANGE 早 20 s，tile 里两个时间分别印出） | 一致 |

`--` 的文案不是「无数据」四个字，而是点名缺哪条报文 / 哪个机型位，例如
`PPP 未授权（MODELFEATURES #1329 里 PPP = UNAUTHORIZED） · 缺 TERRASTARINFO (#1719) / … / PPPPOS (#1538)`。

### 12.3 三个缺页

| 页 | 手册 | 实现 | 抽屉分组 | 数据 |
|---|---|---|---|---|
| **Vehicle Setup** | 2.2.7 | 新页 `packages/view/src/config/vehicleSetup.ts`，容器 `#vehicleSetup-layout_<tab>`，片段就是 `spanInstallation.html`（原版没有单独的 vehicleSetup 组件，`jarvisInterface.js:4998` 也是从 `#displaysSettings-layout_<tab> … #vehicleSetupTab` 进去的） | Settings ▸ Vehicle Setup… | **不读任何报文**。手册自己写的：「These fields are used to properly scale the visual representation… not used in the position solution」「used only to show the location of the IMU」；`requiredLogs('vehicleSetup')` 返回 `[]`，Apply 只写 userStore（同 `spanInstallation.js:331-357`） |
| **Storage** | 2.2.11 | 已有页 `deviceExport`（`deviceExport.html` 就是 Storage：面包屑 Device/Storage、active log、Available Log Files、Download / Copy to USB / Remove），本轮接进抽屉 | Device ▸ Storage… | 源是 `FILESTATUS #2127` + `FILELIST #2100`；本机没有文件日志子系统（同 §12.2 Logging 那条），所以页面固定是「No log files found.」+ 一条「该机型无存储」说明，三个按钮**禁用**。片段里写死的示例 `LOG_9898` / `72 KB` 被 `DeviceExportPage.mount` 隐藏（`setVisible('.active-log-layout', false)`），不会当成实测值 |
| **Update** | 2.2.12 | 已有页 `deviceUpdate`，本轮接进抽屉并**改成只读** | Device ▸ Update… | 只读：版本行本来来自 `VERSION #37`，但本 build 无实时链路，两行都是 `--`；`Browse` / `Apply` 在服务端渲染时打 `disabled`，页面顶部印「Read-only in this build…」；`ConfigHost.takeCommands()` 对只读页**丢弃**队列里的帧（`readOnlyRefusals()` 计数），手写 POST 也发不出 `SOFTLOADRESET/SREC/DATA`。测试里用一份 `.hex` 真跑 `start()`，断言零帧外发 |

三页都在 `CONFIG_PAGE_NAMES`（`packages/app/src/config-host.ts`，15 → 18 条）、`CONFIG_LABELS`
（`config-http.ts`：`deviceExport: 'Storage'`、`deviceUpdate: 'Update'`、`vehicleSetup: 'Vehicle Setup'`）
和 `MENU_PAGE_NAMES`（`view/src/config/index.ts` 增 `vehicleSetup`）里；`/api/config/pages` 的
`settings` 标记让 `manage.js` 把它们分进 Settings / Device 两组（实测 optgroup，见 §12.5）。

三处片段/词典对不上，都按原版自己的补法补的：

- `spanInstallation.html` 的 `data-lang-frombaseline/-fromtbdline/-fromrearline` 三个标记，通用
  `data-lang-*` 规则会拼成 `FROMBASELINE`，而词典键是 `FROM_BASE_LINE`，原版在
  `spanInstallation.js:424-463` 有一张显式表；`VehicleSetupPage` 抄同一张表，否则三个 RP 输入框
  没有标签。`[观察]`
- `deviceUpdate.html` 把两个标记拼错了：`data-lang-current-firmaware-version`、
  `data-lang-current-software-monitor-verison`，词典键是 `CURRENT_FIRMWARE_VERSION` /
  `CURRENT_SOFTWARE_MONITOR_VERSION`，原版靠 `deviceUpdate.js:17-27` 显式填。`deviceUpdate.ts`
  补了同一张表，否则两行版本只有 `--` 没有标题。`[观察]`
- `.veh-images .card` 在片段里是 `display:none`，原版由 `jarvisInterface.js:5016` 按 `MarinePak`
  显示非船用那一组（外加 Large Vessel）；`VehicleSetupPage.decorate` 照抄这一步，否则 Type 一行
  是空的。`[观察]`

### 12.4 本轮没做到

1. **实时链路一律没跑**（COM10 被占）。新增 7 块 tile 在 Live 模式下统一 `--`，并在 `mg-reason`
   里说明「这一路解码器只产出 Positioning/Device/Interference/Satellite 的视图模型，这几块读的是
   `/api/records` 字段路径」——`live.ts` 不在本轮改动范围，没有为了好看去伪造 live 值。
2. **`FILESTATUS #2127` / `SATELSTATUS #2205` / `HEADING2 #1335` / `INSPVAX #1465` /
   `INTERFACEMODE #3` 都没有可用记录**：b1–b5 一条都没有，接收机也不出。所以这几块只验了 `--` 态与
   原因文案，「有值时怎么显示」的分支只有单测用合成字段走过。
3. **Storage 的 Download / Copy to USB / Remove 没有真做过一次**：没有接收机、没有挂在接收机上的
   U 盘，按钮现在是禁用的；接上实时链路要另开一轮。
4. **Update 的固件写入故意没做**：只读门禁是这一轮的结论，不是待办。
5. 手册 2.3.6 Device 里的 **Storage Usage** 仍未接（要 `FILESYSTEMCAPACITY #2137`），本轮没动
   Device tile。

### 12.5 截图与对照脚本

目录 `C:\Users\SunCh\AppData\Local\Temp\opencode\agent-manage\`，服务
`node packages/app/src/server.ts --port 7813`，Playwright 1706×1400：

| 文件 | 内容 |
|---|---|
| `b1-ports.png` `b4-ports.png` | Ports（b1：7 行、COM3 红；b4：17 行、Logs 列有数） |
| `b1-logging.png` `b4-logging.png` | Logging 的「该机型无文件日志」态 |
| `b1-ppp.png` `b4-ppp.png` | PPP Corrections（b1：Off + 全 `--`；b4：Unsubscribed + PPPPOS/PPPDOP） |
| `b1-radio.png` `b4-radio.png` | Radio 的「无电台」态 |
| `b1-align.png` `b4-align.png` | ALIGN（b1 有 MODELFEATURES 依据，b4 连能力都未知） |
| `b1-span.png` `b4-span.png` | SPAN |
| `b1-tracking.png` `b4-tracking.png` | Satellite Tracking（C/No 视图） |
| `b1-tracking-locktime.png` `b4-tracking-locktime.png` | 同一块的 Lock Time 视图（b4 无 SATVIS2，El/Az 全 `--`） |
| `b1-dashboard-full.png` `b4-dashboard-full.png` | 整页（新 tile 的排布） |
| `page-vehicle-setup.png` `page-storage.png` `page-update.png` | 三个新页单独打开 |
| `drawer-vehicle-setup.png` `drawer-storage.png` `drawer-update.png` | 同一页在 Configuration 抽屉里（含分组 optgroup 与只读/无存储提示） |

对照脚本：`%TEMP%\opencode\crosscheck.mjs`（DOM 值 ↔ 解码字段，输出即 §12.2 的表）、
`shoot.mjs`（tile 截图）、`shoot-pages.mjs`（三页截图 + 抽屉分组 + console 计数）。两次运行均
`0 console / 0 pageerror`。

### 12.6 判据

```powershell
cd "逆向\04_重实现"
node --test --test-force-exit "packages/*/test/*.test.ts"   # 873 tests / 873 pass / 0 fail
```

新增：`packages/app/test/manage-tiles.test.ts`（12 项：用 b1/b4 的真实字段做样本 + `--` 文案）、
`packages/app/test/manage-pages.test.ts`（8 项：三页可打开、标签、抽屉分组、Vehicle Setup 零请求、
Storage 无存储态与禁用按钮、Update 只读门禁）。既有 `config-host.test.ts` / `config-endpoints.test.ts`
里「非 operational 页 = 15」的断言按新页数改成 18，并加了三个新名字与标签的断言。

---

## 13. Events 实测：`RXSTATUSEVENT` 到底由什么触发（2026-11-01 真机）

样本 `00_来源/samples/live-20261031/b7-20261101.sbf`（69 s，OEM729 / `OM7MR1002RN0000`，COM10）。
做法：`LOG RXSTATUSEVENTA ONCHANGED` 全程挂着，再用各类"该出错"的命令去戳，看接收机是否发
`#RXSTATUSEVENTA`。脚本 `逆向/tools/remote/b7-capture.ps1`（事件在 t=10/16/22/28/34/40 s 各戳一次）。

### 13.1 结论：一条都没出来，而且这不是"没抓到"

`RXSTATUSEVENTA` 从 t=0 开到 t=45 s（收尾前），期间 6 次主动制造条件，抓包里
`#RXSTATUSEVENTA` / `<RXSTATUSEVENT` 记录数 **0**（二进制 id 94 也是 0；套件 Summary 的转换表里
没有这一行）。逐条证据：

| 发出去 | 接收机回的原话 | 该记录条数（整段 45 s）|
|---|---|---:|
| `LOG RXSTATUSEVENTA ONCHANGED` | `<OK` | 0（就是这个日志本身）|
| `LOG NOTAREALLOGB ONCE` | `<ERROR:Invalid Message. Field = 2` | 0 |
| `LOG RANGEB NOTAREALTYPE ONCE` | `<ERROR:Invalid Message. Field = 4` | 0 |
| `LOG RANGEB ONTIME`（漏参数）| `<ERROR:Invalid offset.` | 0 |
| `INTERFACEMODE COM9 BAD BAD ON` | `<ERROR:Invalid Message. Field = 2` | 0 |
| `ITWARNINGCONFIG 1`（配置写入）| `<OK` | 0 |
| `ITDETECTCONFIG ALL`（配置写入）| `<OK` | 0 |
| `ITSPECTRALANALYSIS PREDECIMATION GPSL2 1000 1K 1 1` | `<OK` | 0 |

`INTERFACEMODE COM9 …` 被拒之后，`COM9` 的接口模式没有变（收尾的 `LOG RXCONFIGA ONCE` 里
`#INTERFACEMODEA,…` 与抓包前一致）。

### 13.2 它是什么，为什么命令错误戳不动

`RXSTATUSEVENT`（id 94）是 **RXSTATUS 字里的位发生变化时的文本说明**：字段
`word` / `bit_position` / `event(CLEAR/SET/UPDATE)` / `description`。也就是说，只有接收机自己
的状态位翻动（天线开路/短路、电压/温度越界、授权码、型号不符……）才会产生它；**命令被拒不是
事件**，那只是 `<ERROR:…>` 应答，而且应答不发日志。

本轮的物理限制（如实记）：要触发这些位得动硬件——拔天线、换不合法的授权/型号、制造过压过温。
机器挂在野外台站的机柜里、天线在屋顶，本轮**不能也不该**去动，所以这类事件在真机上没有造出来。
可造的路径只有"命令/配置被拒"和"干扰检测"两类，而实测这两类都不产生 `RXSTATUSEVENT`：

- 命令/配置被拒 → 只有 `<ERROR:…>`，0 条事件；
- 干扰检测 → 走 `ITDETECTSTATUS`（本抓包 47 条，38 条带 L2 检测），**不**经过
  `RXSTATUSEVENT`。Events 页对干扰的判断是 `itk()` 读 `ITDETECTSTATUS` 自己算的。

### 13.3 `events.ts` 认哪些 key，各自的数据来源

`packages/view/src/config/events.ts` 的 `EVENTS_DATA_LANG_MAP` 有 44 个 `data-lang-*` key。按
`updateData()` 的分派，它们来自**四种**完全不同的源，只有前两个 key 来自 `RXSTATUSEVENT`：

| 源 | 触发的 key | 本次抓包能否产出 |
|---|---|---|
| `RXSTATUSEVENT` 文本（`rxStatusEvent()`）| `data-lang-invalid-model`（"MODEL INVALID FOR THIS RECEIVER"）、`data-lang-invalid-authcode`（"INVALID AUTHORIZATION CODE"）| 否：没有这两种状态位 |
| `ITDETECTSTATUS`（`itk()`）| `data-lang-itk-detected-at`（带 `%1` 频率）| **是**：38 条检测，L2，其中频谱法给 1270.176 MHz |
| `TRACKSTAT` / `BESTPOS` / `LBANDTRACKSTAT` / `INSPVAX`（本地计算）| `gps/glo/gal/bds/navic-tracking-less`、`no-sbas-tracked`、`no-position-available`、`high-pos-std-dev`、`high-ins-std-dev`、`no-lband` | 是（`#TRACKSTATA` 9、`#BESTPOSA` 62）|
| `HWMONITOR` / `RXSTATUS`（本地计算）| 3V3/1V2/1V8/天线电压电流/TCXO/DDR 温度、`high-cpu`、`spoofing-detected` | 需阈值越界；本机 6 条 `#HWMONITORA` 全在界内，`rx_error=0`，故无事件 |

一个待核对项（读代码得出，未在本轮改动）：`itk()` 取 `row.detectionType` / `row.centerFrequency`，
而 `edie-layouts.json` 里 `ITDETECTSTATUS` 的字段名是
`frequency` / `int_detect_method` / `parameter1…4` / `severity1` / `severity2`，数组键是
`interference_statuses`（`rowsOf()` 认的是 `data/Data/blocks/channelData/sats` 或数字键）。要让
Events 页真的显示干扰条目，这两处名字得先对上；`packages/view` 本轮不在改动范围，只记在这里。
