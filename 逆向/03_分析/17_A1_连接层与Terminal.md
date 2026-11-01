# 17. A1 连接层与 Terminal（2026-11-01）

> 用户 2026-11-01 拍板：**要真连接收机**、「1:1」按**功能等价**、B1 可以加日志、A1 全部推进。
> 本文记录 A1 的第一步：把「能连上接收机并发命令」这条链路做通并验过，
> 后面 14 个配置页 / Events / `.cfg` 都建在它上面。

---

## 17.1 为什么先做这一层

`01_Manage主界面与视图层.md` 与 `02_配置类视图.md` 里的配置页（Ports / ICOM / Networking /
Position / Logging / Align / Radio / SPAN / Longhorn / Device Details / Export / Update / Restart…）
在 `packages/view/src/config/` 里都已有实现并带测试（304 项 view 测试里有它们），
**缺的是两件东西**：

1. app 侧**没有任何连接通道**——`server.ts` 只读 `00_来源/samples` 里的抓包，所以整套配置页
   在浏览器里只能看不能发；
2. 菜单里 `Configuration / Settings / Tools / Device` 是 `wired: false` 的占位按钮。

所以 A1 的地基是：一条 `连接 → 解码 → 给 UI → 收命令 → 发出去` 的链路。`packages/session`
早就有 `ReceiverSession`（TCP/UDP/串口传输、ASCII 与二进制命令、心跳、逐条解码），
本层只是把它接到 web 应用上。

## 17.2 新增

| 文件 | 作用 |
|---|---|
| `packages/app/src/live.ts` | `LiveLink`：一个进程一个会话；`connect()`（serial / tcp / udp）→ 解码事件进 400 条环形缓冲；`send(line)` 原样 + CRLF 发出；`status()` / `logs(after)` 给 UI 轮询 |
| `packages/app/src/server.ts` | 新增 5 个端点：`/api/live/{status,logs,connect,disconnect,command}`（轮询式，不引入 WebSocket 依赖） |
| `packages/app/src/web/panels/manage.js` | `Tools` 菜单改为可用，下拉里 `Terminal` 可用、`Events` 仍标未接；Terminal 抽屉：串口/TCP 两栏、Connect/Disconnect、命令输入、日志区（800 ms 轮询） |
| `packages/app/src/web/panels/manage.css` | 下拉与终端抽屉样式 |
| `packages/app/test/live.test.ts` | 5 项：回放抓包解码、命令到 socket、未连接时报错不抛、注入串口 opener、连不上时留错误 |

**渲染与 Convert 一致**：每条记录用 `encodeAsciiLog` 出整行 ASCII（`#RANGEA,…*crc`），
所以 Terminal 里看到的就是 Convert 会写出的同一行，而不是另一套「调试格式」。

## 17.3 验证（都是实测，不是推断）

### 接口层

```
$ curl -X POST /api/live/connect -d '{"kind":"tcp","host":"127.0.0.1","port":4001}'
{"ok":true,"connected":true,"target":"tcp://127.0.0.1:4001",...}

$ curl /api/live/status
{"connected":true,"target":"tcp://127.0.0.1:4001","records":1322,"crcFailures":1,"droppedBytes":50}

$ curl -X POST /api/live/connect -d '{"kind":"tcp","port":1}'
{"ok":false,"error":"connect ECONNREFUSED 127.0.0.1:1"}

$ curl -X POST /api/live/connect -d '{"kind":"serial","path":"COM9"}'
{"ok":false,"error":"serial needs the optional `serialport` package (npm i serialport)"}
```

视频源是 `replay-tcp.cjs`：把 `b1-20261101.sbf`（25 类 / 2 758 111 B）按 16 KB 分片喂给 TCP 端口。

### UI 层（Playwright 驱动，整屏截图 `term-live.png`）

| 检查 | 结果 |
|---|---|
| 菜单状态 | `status:on  configuration:off  settings:off  tools:on  device:off` |
| Tools 下拉 | `terminal:on  events:off` |
| 抽屉可见 | true |
| 状态行 | `Connected — tcp://127.0.0.1:4001 — 1322 records` |
| 日志区 | 400 行（环形缓冲上限），含 `#BESTPOSA…`、`#RANGEA…` 等 Convert 同款整行 |
| 发命令 | 回显 `> LOG COM1 TIMEB ONTIME 1`，服务端 socket 收到该行 |
| 页面报错 | 0 |

## 17.4 还没做（A1 的剩余部分，按依赖排序）

1. **串口真连**：`serialport` 是可选依赖（仓库不装 npm 包）。要在本机/远程真开 COM 口，
   需 `npm i serialport`（或在远程机上跑服务端）。现在 `LiveLink` 的串口路径已用注入 opener
   单测过，只差真实驱动。
2. **14 个配置页接进 UI**：`packages/view/src/config/*` 的页面目前只在 view 层测试里跑，
   还没有在浏览器里装配。需要把 TS 模块打包进 web（或加一层 `/api/config/*` 适配）。
3. **Events 页**：`events.ts` 已在 view 层完成，同样缺 UI 与连接层的事件流接口
   （`LiveLink` 现在只缓冲日志，没有 RXSTATUSEVENT 事件表）。
4. **`.cfg` 导入导出**：`configurationFile.ts` 已有解析/生成，缺 UI 入口与「先断开再写」的流程。
5. **真机验证**：接收机在 DESKTOP-9POIV0O 的 COM8/9/10 上；本机 app 连不到那串口。
   办法是**把 app 跑在远程机**（Node 在那台机器上有）或给远程机起一条 TCP/串口桥。
   这一步做完才能对 14 个页面做「发命令 → 接收机应答 → 页面变化」的真机验收。

---

## 17.5 14 个配置页怎么装进浏览器：已核实的方案（还没动手）

**为什么不能直接 `<script>` 引进来**：`packages/app/src/web/panels/*.js` 是手写 ESM，浏览器直接跑；
而 `packages/view/src/config/*` 是 TypeScript，且 `import` 关系跨包，没有打包步骤就没法给浏览器。
仓库的约束是「零依赖、不 npm install」，所以不引入 esbuild。

**结论：改成服务端渲染 + 事件回传（HTML over the wire），不打包。** 依据是这些模块本来
就是「在 mini-DOM 上驱动原版 shipped 片段」的控制器：

| 事实 | 出处 |
|---|---|
| `ConfigPageContext` 要的是 `document` / `fragments` / `clock` / `store` / `sendBinary?` `sendRaw?` `sendAsciiFrame?` 这些**接口**，不是浏览器全局 | `packages/view/src/config/types.ts:126-154` |
| `minidom` 就是「零依赖 DOM 子集（Node 里跑真实 shipped 片段）」 | `packages/view/README.md`、`packages/view/src/minidom.ts` |
| 14 个页面已在 Node 里对 shipped 片段 mount / 更新并被 304 项 view 测试覆盖 | `packages/view/test/config*.test.ts` |
| `ConfigBundle.mount(tab, {features, target})` 负责按机型挑模板，`updateFromLog` 喂报文 | `packages/view/src/config/index.ts:325`、`CONFIG_PAGE_NAMES`（14 条） |

于是装配层只需要三件事：

1. **页面**：`GET /api/config/:page?tab=…` → 用 minidom 建文档、`bundle.mount()`、
   返回序列化后的 HTML（片段来自 `01_解包/app/view`，和 view 测试用的是同一份）；
2. **事件**：`POST /api/config/:page/event`（`{selector, value|checked|clicked}`）→ 在同一个
   minidom 文档上触发，控制器会把要发的命令交给 `sendRaw/sendBinary/sendAsciiFrame`，
   这三个钩子直接接到 `LiveLink.send()` / `session.sendBytes()`；
3. **回灌**：`LiveLink` 的每条解码记录顺手喂 `bundle.updateFromLog(msgId, fields)`，
   下次 `GET` 拿到的就是接收机的最新状态。

工作量按页面看：8 个 OEM7 配置页（position / ports / logging / align / span / radio / gnss /
spoofing）+ 3 个 Settings 页（networking / general / language）+ 2 个 Longhorn 页 + SPAN 安装页。
控制器逻辑不用重写，缺的是这一层适配和每页的 HTML 往返，以及 `.cfg` / Terminal / Events 的入口。


## 17.6 配置页吃到真机的配置日志（2026-11-01 实测）

§17.5 第 3 步（"回放：LiveLink 按序把记录喂给 updateFromLog"）此前**从未实现**：
`packages/app/src/config-host.ts` 只有 `feedAscii`（Events），配置页拿不到任何记录，所以即使连着
真机也永远显示 "No receiver configuration yet"。这一节记的是补齐后的实测。

### 真机到底答什么（com10 = 接收机 USB2，OEM729）

| 命令 | 结果 |
|---|---|
| `LOG INTERFACEMODEB ONCE` | **27 条**，端口 `COM1-3`、`CCOM1-6`、`ICOM1-7`、`NCOM1-3`、`USB1-3`、`WCOM1`、`UNKNOWN` |
| `LOG LOGLISTB ONCE` | 1 条 / **60 个条目** |
| `LOG SERIALCONFIGB ONCE` | 3 条（COM1 9600、COM2 38400、COM3 38400） |
| `LOG ICOMCONFIGB ONCE` | 7 条（ICOM1 TCP ":2000" …） |
| `LOG NTRIPCONFIGB ONCE` | 3 条（NCOM1-3, DISABLED） |
| `LOG SOURCETABLEB ONCE` | 1 条，空表（没配 NTRIP 挂载点） |

`CCOM1-6` 不是"多打了个 C"：这台型号真的报这些端口（`CCOM1/2` = `NOVATELMINBINARY`，
`CCOM3-6` = `AUTO`/`NOVATEL`）。`isPortConfigDataAvailable` 要的 `LOGLIST/INTERFACEMODE/
SERIALCONFIG` 与 `SOURCETABLE` 都齐了，页面才肯渲染。

### 两个必须踩过才知道的坑

1. **命令不能连发**。10 条 `LOG … ONCE` 一次性写进去，只有 2 条回 `<OK`，
   INTERFACEMODE/LOGLIST/SERIALCONFIG 全部无声（接收机命令缓冲在日志流占满时丢行）。
   间隔 150 ms 重发同一批，27/1/3/7/3/1 条全部回来。现在 `server.ts` 里 150 ms 一条。
2. **headless 宿主没有轮询定时器**。数据在页面序列化之后才到，页面不会自己重画
   （`checkAndUpdatePortConfigDefaultData` 的 `setTimeout` 被宿主关掉了）。所以 `GET /config/:page`
   改成：先按该页的 `requiredLogs` 发查询 → 在服务端把回答喂进 `updateFromLog` →
   `refreshPage()`（= `dh_createDefaultData` + `v_loadDefaultData`）→ 再序列化。

### 实测结果（Playwright 读序列化文档）

```
lis = 24（CCOM1-6 / COM1-3 / ICOM1-7 / NCOM1-3 / UNKNOWN / USB1-3 / WCOM1）
data-portconfig-note = null（诚实空态消失）
CCOM1  NOVATELMINBINARY / NOVATELMINBINARY
COM1   NOVATEL / NOVATEL      NCOM1  RTCMV3 / NONE
截图  real-ports.png（右侧抽屉 24 行真端口；左侧 Status 同时显示 Single / 30.5399684° /
      114.3528115° / 64.87 m / 18 used of 25 tracked）
```

`UNKNOWN` 那一行是接收机自己报的端口名，原样显示；不猜、不改写。

### 17.6.1 两条取数路径都试过了（2026-11-01 复验）

`INTERFACEMODE` 是**命令**，裸查询不是取数的路：

```
Send-Line 'INTERFACEMODE'        -> 1 条文本回答：<ERROR:Message missing field
Send-Line 'LOG INTERFACEMODEB ONCE' -> 27 条 id=3 记录（0.38 MB 里，其余是历史日志）
```

27 条记录的端口枚举（用 `decodeEdie` 读 level-0 的 `port`）：

```
enum   1, 2, 3                -> COM1, COM2, COM3
enum  13,14,15                -> USB1, USB2, USB3
enum  23,24,25,29,46,47,48    -> ICOM1..ICOM7
enum  26,27,28                -> NCOM1..NCOM3
enum  30                      -> WCOM1
enum  38..43                  -> CCOM1..CCOM6
enum  65,66,67,68             -> UNKNOWN
```

**`UNKNOWN` 不是我们没映射**：把其中一条记录的 `port` 改成 65/66/67/68/64/69 重新封帧、喂给本机套件
（`-a`），六条全部输出 `;UNKNOWN,NOVATEL,NOVATEL,ON*6a9cc0de` —— 套件也没有这几个名字。
所以配置页把它们并成一个 `UNKNOWN` 行，与套件行为一致。

配置页（`GET /config/portConfig` 的序列化文档，页面自己触发取数）：

```
li = 24            data-portconfig-note 不存在（诚实空态消失）
CCOM1..6   NOVATELMINBINARY / NOVATELMINBINARY（CCOM3..6 是 AUTO / NOVATEL）
COM1..3    NOVATEL / NOVATEL
ICOM1..7   NOVATEL / NOVATEL
NCOM1..3   RTCMV3 / NONE
UNKNOWN    NOVATEL / NOVATEL
USB1..3    NOVATEL / NOVATEL
WCOM1      NOVATEL / NOVATEL
0 console / 0 pageerror；截图 port-verify/port-rows.png
```

### 17.6.2 GLO `Missing` 在这台机器上不可验（证据）

`LOG SATVIS2B ONTIME 5` 抓 20 s → 16 条 SATVIS2 记录，系统只有三类：

```
GPS 32 颗 / QZSS 5 颗 / BEIDOU 53 颗（SBAS 记录 0 颗）
RANGE 612 条里没有 GLONASS 的 prn（38..61）
```

即这台接收机**没有在跟 GLONASS**，没有 GLO 样本可比 `Missing` 的 37 偏移。要验得换一台有 GLO 的
接收机，或喂外部 GLO 信号；在那之前不猜、不改 join 规则。`LOG SATVIS2B ONTIME 2` 反而不出记录
（ONTIME 5 才有），也记在这里。

#### 17.6.1a 复验（第三次，走 D3 之后的命令通道）

D3 把 `<OK`/`<ERR` 接进 `LiveLink` 之后，两条路径现在都能在 `/api/live/status.commands[]` 里读到
接收机原话，不用再靠串口 dump：

```json
[
  { "line": "INTERFACEMODE",            "status": "err", "reply": "<ERROR:Message missing field", "ms": 50 },
  { "line": "LOG INTERFACEMODEB ONCE",  "status": "ok",  "reply": "<OK",                          "ms": 25 }
]
```

`LOG INTERFACEMODEB ONCE` 之后 `/api/live/logs` 里 `messageId=3` 的记录 **27 条**，首条
`#INTERFACEMODEA,SPECIAL,26,74.0,UNKNOWN,0,2.180,03801800,7a68,18278;COM1,NOVATEL,NOVATEL,ON*73145ed5`。
配置页（`GET /config/portConfig` 序列化文档）：**24 行**、`data-portconfig-note` 不存在、
`CCOM1/2 = NOVATELMINBINARY`、`CCOM3-6 = AUTO/NOVATEL`、`COM1-3 = NOVATEL`、`ICOM1-7 = NOVATEL`、
`NCOM1-3 = RTCMV3/NONE`、`USB1-3 / WCOM1 / UNKNOWN = NOVATEL`；0 console / 0 pageerror。
截图 `port-verify3/port-rows.png`，证据 `port-verify3/evidence.json`。

同时看到左侧 Status 卡是实时值（`Single / 30.5399761° / 114.3528119° / 65.71 m / 10 used of 26 tracked`），
说明这一轮是"链路上同时看配置页与状态页"，不是离线回放。

### 17.7 实机：`.cfg` 写入真机（2026-11-01，COM10/USB2）

四条日志形态是这一轮最值钱的实测，`READBACK_REQUEST` 与语句解析都按它改：

```
LOG RXCONFIGB ONCE      -> 271 条 message 128，#RXCONFIGA,…,18278;#SERIALCONFIGA,…,18278;COM1,9600,N,8,1,N,ON*80f21651
LOG SERIALCONFIGB ONCE  -> #SERIALCONFIGA,SPECIAL,2,…,18278;COM1,9600,N,8,1,N,ON*3a5821cf
LOG RXCONFIG ONCE       -> 缩略 ASCII，三行一组（<RXCONFIG USB2 270 … / <     ELEVATIONCUTOFF … / <     GLONASS 5.0 0）
LOG RXCONFIGA ONCE      -> 本口 20 s 内一条不出（不要用它做回读）
```

**语句名在 header、参数用逗号**：`configurationLineOf` 原来只取最后一个 `;` 之后，真机上得到的是
没有命令名的 `COM1 9600 N 8 1 N ON`，导出的 190 行 `.cfg` 全是残句。现在按 header 名重建，
`RXCONFIG` 包装层递归进内层（`#RXCONFIGA,…;#SERIALCONFIGA,…;COM1,…` → `SERIALCONFIG COM1 9600 N 8 1 N ON`），
单参数的 `#LOCKOUTSYSTEMA,…;NAVIC` → `LOCKOUTSYSTEM NAVIC`。

**回读是记录不是文本**：`LiveLink.collect(..., { records: true })` 把请求期间新到的记录按
`entry.ascii` 一并交回；只保留**请求的那条日志**（RANGE 20 条/秒会把回读撑成"382 行"，
真值 271 条），`<     GLONASS 5.0 0` 这种续行不算独立应答，`[USB2]` 前缀的端口文本直接跳过。

**两次导入的实测**（`POST /api/config/device/import`，正文一行）：

| 行 | 应答 | 耗时 | 回读 |
|---|---|---|---|
| `SERIALCONFIG COM1 19200 N 8 1 N ON` | `<OK` | 32 ms | matched（回读原文 `…#SERIALCONFIGA,…;COM1,19200,N,8,1,N,ON*3cdd001e*a9277c26`） |
| `SERIALCONFIG COM1 9600 N 8 1 N ON` | `<OK` | 92 ms | matched（`…COM1,9600,…*e20c7d77*0c308657`） |

`verification` 两次都是 `{"attempted":true,"ok":true,"request":"LOG RXCONFIGB ONCE","lines":249,"matched":1,"mismatched":[],"absent":[]}`。
串口侧用 `LOG SERIALCONFIGB ONCE` 单独回读，`COM1` 亲眼从 `9600` 变 `19200` 再变回 `9600`，COM2/COM3 的
`38400` 全程没动。负例 `SERIALCONFIG COM99 9600 N 8 1 N ON` → `<ERROR:Invalid Message. Field = 2`，
`sent:1`、`failedAt:1`、`verification:null`（后续行与回读都没发）。

**配置页的数据缺口根因**（这一轮最该修、但不在本轮文件范围的一项）：
`config-feed.ts#CONFIG_MESSAGE_IDS = [3, 5, 1246, 1248, 1249, 1344]` 只放行 6 个 id，
而接收机实测能回答 `HEADINGOFFSET(1335)=0.000000000,0.000000000`、`ELEVATIONCUTOFF(1735)` 七行、
`PPSCONTROL(613)=ENABLE,NEGATIVE,1.000000000,1000`、`IPCONFIG(1243)=ETHA,STATIC,"192.168.5.10",…`——
全部被这一行挡在页面外；`gnssConfig`/`networkingSettings` 在 `CONFIG_LOG_REQUESTS` 里也没有条目
（`GET /config/gnssConfig` 24 ms 就返回，一条 LOG 都没发）。`deviceDetails` 不在 `ALL_PAGE_NAMES`，
`/config/deviceDetails` 直接 `{"ok":false,"error":"未知配置页：deviceDetails"}`。

原版套件本轮**没能**做控制变量：远程机只有已断开的 RDP 会话，`CopyFromScreen` 抓出纯白，
按键/鼠标注入无效，`PostMessage` 只有首页 Manage 卡片响应；加 `--remote-debugging-port=9222`
时 DevTools 端口一闪即被它自己的参数校验判死（`Invald option  REMOTE-DEBUGGING-PORT`）。
完整证据与逐页对照表见 `C:\Users\SunCh\AppData\Local\Temp\opencode\agent-live\REPORT.md`。
