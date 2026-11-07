# `shell/` —— Electron 外壳骨架（W2）

> **状态：骨架已在本地跑通（Electron 45.2.2），但仓库里没有提交 `node_modules`。**
> 主进程/预加载/窗口/截图都是在本机实际运行过的；`electron-builder` / 签名 / 自动更新
> 仍然没有。`shell/electron/package.json` 里 `electron` 只写在 `devDependencies`，
> 换一台机器需要重新 `npm install`（见 §7、§9）。

## 1. 和现有 Node 服务是什么关系

外壳**不重写任何界面**。现有的零依赖服务
(`逆向/04_重实现/packages/app/src/server.ts`) 仍然是唯一的 HTTP 入口：

```
┌─────────────────────── Electron 主进程（shell/electron/main.js）───────────────────────┐
│  ── 单实例锁 ── 拉起 `node src/server.ts --port <port>` ── 轮询 /api/health（≤ 40s）    │
│  ── BrowserWindow（preload.js，contextIsolation）── 退出时结束整个子进程树              │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ http://127.0.0.1:<port>/chat
┌───────────────────────────────────────────▼────────────────────────────────────────────┐
│ 现有 Node 服务：同时提供                                                    │
│   · 四个视角外壳页 /chat /fleet /data /suite（web/views/layout.html，共用一份）          │
│   · 原有 Agent 工作台 `/`、专业面板 `/?mode=pro`、/api/health 与全部 API                 │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

因此 Electron 只负责“窗口 + 生命周期 + 端口”，页面仍然是浏览器里那一套；
将来换 WebView2 / Tauri / 直接开浏览器都不影响 Node 服务与 `web/views/**`。

## 2. 目录

| 文件 | 作用 |
|---|---|
| `electron/main.js` | 主进程：单实例、启动编排、窗口、菜单占位、就绪探测、退出清理 |
| `electron/preload.js` | `window.nasShell` 契约（`info()` / `navigate()` / `versions` / `platform`） |
| `electron/embed.js` | W3 嵌入层：`user32.SetParent` 把别的进程的窗口挂进面板，含样式裁剪 / DPI 补偿 / 一键解挂 |
| `electron/embed-smoke.js` | 嵌入的真机冒烟（起第二个 Electron 进程当目标，16 条断言） |
| `electron/test/embed.test.js` | 嵌入状态机的单测（假 user32，不需要 Windows 也不需要 koffi） |
| `electron/package.json` | `name/version/main`；`electron` 在 `devDependencies`，`koffi` 在 `dependencies`（`node_modules` 不提交） |
| `README.md` | 本文 |

视角路由表不在 `shell/`，而在
`逆向/04_重实现/packages/app/src/web/views/routes.ts`：`server.ts` 和
`packages/app/test/views.test.ts` 共用它。主进程里只有一份四个 id 的副本
（`VIEW_IDS` / `VIEW_PATHS`），因为它不 import `.ts`，也不参与构建；改视角时两处一起改。

## 3. 主进程职责（已实现的骨架）

1. **单实例**：`app.requestSingleInstanceLock()`；第二个进程把已有窗口 restore/focus 后退出。
2. **启动编排**：
   - 默认用系统的 `node` 启动 `逆向/04_重实现/packages/app/src/server.ts --port <port>`；
     `NAS_NODE` 可换解释器。用系统 Node 而不是 Electron 内置 Node，是因为服务直接跑 `.ts`
     （Node 的类型擦除），Electron 自带运行时版本未必支持。
   - 子进程 stdout/stderr 带 `[server]` 前缀转进主进程控制台；保留最后 8 KB stderr 用于报错。
   - 子进程启动即退出时立刻失败（不等满 40 秒）。
3. **就绪探测**：每 400 ms 请求一次 `/api/health`，要求 `ok:true`；最多 40 秒。
   失败弹 `dialog.showErrorBox('启动失败', …)`，并清理子进程后 `app.exit(1)`。
4. **窗口**：1440×900（最小 960×640），`ready-to-show` 后再显示；
   `contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`；
   外部 http(s) 链接交给系统浏览器，页面不能自己开新窗口。
5. **菜单占位**：应用（关于/退出）、视角（四个 id 的跳转，只换 URL）、开发者（reload/devtools/缩放）、帮助。
6. **退出清理**：`window-all-closed` / `before-quit` / `SIGINT` / `SIGTERM` 调 `stopServer()`；
   Windows 上用 `taskkill /T /F` 结束整棵进程树，避免 node 孙进程留下。

命令行参数：

```powershell
cd shell\electron

# 用 7810 端口，直接进 /fleet（自己拉起 Node 服务）
npx electron . --port 7810 --view fleet

# 连接已经在跑的服务，不再拉起第二个
npx electron . --port 7810 --attach

# 冒烟测试：加载完 3.5 秒截图后自己退出
npx electron . --attach --port 7810 --view chat --screenshot "$env:TEMP\opencode\electron-shot.png"
```

`--port` / `-p` / `--port=` 都认；端口也能用 `NAS_SHELL_PORT` 给。`--view` 只接受
`chat` / `fleet` / `data` / `suite`，非法值在启动前就弹错误框。

## 4. 启动编排与 payload

```
app.whenReady()
  → Menu.setApplicationMenu(buildMenu())
  → ipcMain.handle('shell:info' / 'shell:navigate')          ← preload.js 的两个调用
  → (--attach 时跳过) startServer()
  → waitForHealth()  // GET /api/health，400ms 一次，≤ 40s，ok:true 才算
  → createWindow()   // loadURL(`${baseUrl}/chat`)
```

`preload.js` 通过 `contextBridge` 暴露（不暴露任何 Node 能力）：

```js
await window.nasShell.info()
// { baseUrl: 'http://127.0.0.1:7803', port: 7803, view: 'chat', attach: false,
//   views: ['chat','fleet','data','suite'],
//   versions: { electron, node, chrome } }

await window.nasShell.navigate('fleet')   // true | false
window.nasShell.versions / platform
```

现有外壳页只用左导航链接跳转，**不依赖**这份契约；它是给打包后（原生菜单状态、深链、
窗口标题）留的稳定入口。

## 5. 四个视角（Node 服务侧，已可用）

| 路由 | `data-view` | 中栏 iframe（现有页面，未改动） |
|---|---|---|
| `/chat` | `chat` | `/`（Agent 工作台） |
| `/fleet` | `fleet` | `/geo/luciad-stage.html`（唯一的独立地图页，占位） |
| `/data` | `data` | `/config/events`（现有的记录/事件页，占位） |
| `/suite` | `suite` | `/?mode=pro`（专业面板） |

- 四个路由返回同一份 `web/views/layout.html`，服务器只替换 `data-view`、标题和 iframe 源。
- `/` 与所有 `/api/*` **原样保留**；四个路由是 additive 的。
- `/suite` 的写法：`web/index.html` 目前不读 `?mode=pro`（只认 `localStorage.fsa-mode`），
  所以 layout 在 iframe `load` 后点一次它自己的 `[data-mode-switch="pro"]`；`/chat` 反向点回
  `agent`。参数先留在 src 里，等 index 以后支持查询串时直接生效。
- 右检查器三段 `data-panel="device" / "evidence" / "logs"` 是**占位**（写死的空状态 +
  说明将来接哪个 API），没有假装有数据；`web/views/views.css` 只写布局，颜色全部取
  `agent.css` 已有 token，不新造主题。

## 6. 现在怎么验证（不需要 Electron）

```powershell
cd "逆向/04_重实现"
node --test packages/app/test/views.test.ts
node packages/app/src/server.ts --port 7810
# 另开一个终端：
curl.exe -s -o NUL -w "%{http_code} " http://127.0.0.1:7810/chat
curl.exe -s http://127.0.0.1:7810/chat | Select-String 'data-view="chat"'
```

浏览器直接开 `http://127.0.0.1:7810/chat` 就是外壳页；窄屏宽度 < 1100px 时右栏收起，
< 820px 时左导航变成顶部横条。

## 7. 换机器时怎么接上 Electron

1. 在 `shell/electron/` 里安装（**`package.json` 就是 Electron 的应用根**，`main` 指向同目录
   的 `main.js`）：

   ```powershell
   cd shell\electron
   npm install --no-save --no-package-lock electron@45.2.2 --registry=https://registry.npmmirror.com
   # 如果 npm 报成功但没有 node_modules\electron\dist\electron.exe（见 §9），补一次二进制：
   $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
   node .\node_modules\electron\install.js
   npm start              # = electron .，窗口打开后保持不退出
   ```

   安装会在 `shell/electron/` 下生成 `node_modules/`，不要提交；`--no-package-lock` 让这次
   试装不改 `package-lock.json`。不安装时 `npm start` 会报找不到 `electron`。
2. 确认系统 `node` ≥ 22.18（服务直接跑 `.ts`；`package.json` 里写的 engines 是 ≥ 22.6，
   但无 flag 的类型擦除从 22.18 才默认开启）。或用 `NAS_NODE` 指向一个足够新的解释器。
3. 打包（electron-builder / electron-forge）**还没写**：没有 `build` 段、没有图标、
   没有签名与自动更新；需要时再在 `electron/package.json` 里加，别把打包产物提交进仓库。
4. 若要把 `web/views/**` 打进 asar，注意 `server.ts` 用相对路径读
   `src/web/views/layout.html`；`paths.ts` 的 `WEB_DIR` 已经按文件位置算，只要整棵
   `packages/app/src` 一起进包即可。

## 8. 实测（2026-11-05，本机 Windows）

| 项 | 值 |
|---|---|
| Electron | **45.2.2**（`npx electron --version` → `v45.2.2`；`electron.exe` FileVersion 45.2.2） |
| 安装命令 | `npm install --no-save --no-package-lock electron@45.2.2 --registry=https://registry.npmmirror.com` |
| npm 阶段 | 11.4 s（13 个包；但 `dist/electron.exe` 没生成，postinstall 未落地） |
| 二进制补下载 | `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` + `node node_modules/electron/install.js`，**116.6 s** |
| 磁盘占用 | `node_modules/electron/dist` **356.5 MB**，其中 `electron.exe` 249,469,440 B |
| 窗口 | 加载 `http://127.0.0.1:7810/chat`（`--attach`，Node 服务另起）；标题 **“对话 · Agent 工作台”**（页面 `<title>` 覆盖了 BrowserWindow 的默认标题） |
| 截图 | `%TEMP%\opencode\electron-shot.png`，**142,537 字节**（2056×1200 设备像素） |

为什么是 7810 而不是 7803：本机 7803 是改动**之前**启动的旧进程（`/chat` 返回 404，
`/api/health` 里没有 `views`），按任务里的兜底条款在 7810 起了当前代码的服务再指过去。
7803 的 `/` 一直可用，没有动它。

实际跑的命令：

```powershell
# 终端 A：当前代码的 Node 服务
cd "逆向\04_重实现"
node packages/app/src/server.ts --port 7810

# 终端 B：Electron 窗口（--screenshot 让它拍完自己退出）
cd shell\electron
npx electron . --attach --port 7810 --view chat --screenshot "$env:TEMP\opencode\electron-shot.png"
```

实际输出（控制台里的中文可能因代码页显示成乱码）：

```
[shell] http://127.0.0.1:7810 就绪（探测 1 次）
[shell] 窗口标题：对话 · Agent 工作台
[shell] 截图已保存：%TEMP%\opencode\electron-shot.png（142537 字节）
```

没有装任何截图库：`--screenshot` 走 `webContents.capturePage().toPNG()`，拍完 `app.quit()`；
进程退出码 0，退出后 `Get-Process electron` 为空。

## 9. 已知边界 / 刻意没做的事

- 已实测 Electron 45.2.2 起窗与截图；但 `node_modules` 不提交，打包（electron-builder）、
  签名、自动更新都还没有。
- `/fleet`、`/data` 的 iframe 源是现有页面里最接近的两个（地图 / Events），
  专用页面落地后只改 `routes.ts` 的一行。
- 右栏检查器不轮询任何 API；`data-panel` 只是以后接 `/api/config/device/status`、
  `/api/captures`、`/api/live/logs` 的锚点。
- 没有改 `web/index.html`、`web/agent/**`、`web/panels/**` 或任何 API。
- 回滚：`shell/` 整个是新增目录，删掉即可；视角路由是 additive 的四条 if 分支
  （`server.ts`）与 `web/views/**`，删除后 `/` 与 API 行为不变。

## 10. W2 的五个验收缺口（2026-11-07 补上）

计划 W2 的这五项此前**关键词命中 0**，现在都在 `main.js` 里：

| 验收项 | 实现 | 命令行 |
|---|---|---|
| `fsa://job/<id>` 深链 | `registerProtocol()` + `parseDeepLink()` + `openJob()` | `electron . "fsa://job/j-001"` |
| 托盘 | `createTray()` + `buildTrayMenu()`，图标是内嵌 16×16 PNG | `--no-tray` 可关 |
| 崩溃守护 | `attachCrashGuard()`（渲染进程 / 无响应）+ `watchChildProcesses()`（子进程只记录） | — |
| 主题 / 密度 | `nativeTheme.themeSource` 三档 + `density`；菜单可循环切 | `--theme system\|light\|dark` |
| 多窗口 | `windows` 集合 + `canCreateWindow()`；关窗只隐藏、托盘菜单才真退出 | 菜单「在新窗口打开」 |

### 10.1 深链只认 `fsa://job/<id>`

id 的字符集收窄到 `[A-Za-z0-9._-]{1,128}`。它会被拼进 `/fleet?job=<id>` 交给页面，
又可能来自**任意第三方程序**发起的协议调用，允许 `?` `&` `#` `/` 等于把注入点送出去。

`parseDeepLink()` **刻意不解码百分号**：`fsa://job/%2e%2e` 这类编码绕过在解码后才显形，
不 decode 时百分号直接通不过字符集校验，等于免费挡一层。

畸形链接一律「记日志 + 忽略」，绝不让一个乱链接把主进程带崩。
`fsa://device/<id>` 明确拒绝并留日志——现在假装支持会让点击落在一个没实现的页面上。

### 10.2 托盘与「关窗」语义

有托盘时**关窗只是隐藏**，不是退出：服务是全局的，重新拉起要再等 40 秒就绪探测。
真正的退出只有三条路，都会先 `beginQuit()` 立标记：托盘菜单「退出」、`Ctrl+Q`、崩溃提示框。

`--screenshot` 与 `--no-tray` **不建托盘**：否则 `window-all-closed` 的退出会被托盘挡掉，
截图冒烟测试在 CI 上会挂住不返回。

### 10.3 崩溃守护分清「崩了」和「正常关窗」

关窗过程中 Chromium 也会发 `render-process-gone`（reason 可能是 `killed` 或 `clean-exit`），
照崩处理就等于每次关窗都收获一个错误框。所以用 `meta.closing` 与 `quitting` 把正常关闭挡掉，
只留日志。

`child-process-gone` **只记录不弹框**：Node 服务自己的退出已由 `serverChild.on('exit')`
弹过一次，两处都弹会连着出现两个框，用户分不清是哪一个进程没了。

### 10.4 主题怎么"看得见"

`preload.js` 这次**没有改**（它不在本次授权范围内），所以页面侧没有订阅通道。
既要让主题真的生效，就只剩「主进程写一次 DOM 属性」这条路——`syncPageAppearance()`
往 `document.body` 写 `data-agent-theme` 与 `data-density`，而 `web/index.html` 与
`layout.html` 本来就是读这两个属性的，所以立刻可见，不需要改前端。

### 10.5 与 W3 嵌入的关系（还没接）

`embed.js` 已经是可用的模块（真机 16/16，见 [`docs/operations/suite-embed.md`](../docs/operations/suite-embed.md)），
但 `main.js` 里**还没有**「打开套件台」的入口把它用起来。这是 W3 第 1 周剩的最后一步，
要和 `embed.attach({ child, parent })` 的父句柄（`win.getNativeWindowHandle()`）对接。

