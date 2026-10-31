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

