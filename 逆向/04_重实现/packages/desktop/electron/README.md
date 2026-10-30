# electron/ —— Electron 外壳

一个**独立可启动**的 Electron app 目录：自己的 `package.json`（`main: main.cjs`），
`electron <本目录>` 就能起窗口。壳自己不做协议、不做界面，只负责

1. 找到或起一个 `packages/app/src/server.ts`（端口 7788 起，被占用就顺延，最多 5 个）；
2. 轮询 `/api/health` 直到 `service === "nas-reimpl-app"`；
3. `new BrowserWindow(...).loadURL("http://127.0.0.1:<port>/")`；
4. 窗口关掉 / `app.quit()` 时杀掉**自己起的**那个 node 子进程（复用别人实例时一个都不杀）。

## 启动

本机已有可用的 Electron 运行时（DaVinci Resolve 自带，v8.0.1），不需要联网：

```powershell
..\Start-FieldStation-GUI.cmd
```

`.cmd` 里的探测顺序（命中即用，全部找不到会打印完整清单而不是崩）：

1. `FIELD_STATION_ELECTRON` 环境变量
2. `packages/desktop/node_modules/electron/dist/electron.exe`（只有 `npm i` 之后才有）
3. `%ProgramFiles%\Blackmagic Design\DaVinci Resolve\Electron\electron.exe`
4. `%ProgramFiles(x86)%\Blackmagic Design\DaVinci Resolve\Electron\electron.exe`
5. `%ProgramFiles%\DaVinci Resolve\Electron\electron.exe`
6. `electron.exe` on `PATH`
7. `%APPDATA%\npm\node_modules\electron\dist\electron.exe`、
   `%LOCALAPPDATA%\Programs\electron\electron.exe`、`%LOCALAPPDATA%\electron\dist\electron.exe`

`node` 同样要找一个（Electron 8 自带的 Node 是 12，跑不了 `.ts`）：`.cmd` 会把找到的路径
写进 `FIELD_STATION_NODE` 再交给 Electron。

## 有网之后换成新版 Electron

```powershell
cd packages/desktop
npm i                      # 装 devDependencies.electron（^33.2.0）
npm run electron           # = electron electron，直接跑本目录
```

装了之后探测顺序里的第 2 条会优先命中 `node_modules`，也就顺带把 Chromium 从 80 升到
现代版本（下面那点排版瑕疵随之消失）。想指定别的版本，改 `package.json` 里的
`devDependencies.electron` 再 `npm i` 即可，其它代码不用动。

Electron ≥ 37 自带的 Node 是 22.x，`nodeCommand()` 会改成
`ELECTRON_RUN_AS_NODE=1` 复用 `process.execPath`，那时 `FIELD_STATION_NODE` 都可以不设。
Electron 8 走的是「PATH 上的真 node」这条分支，两条分支都有实测。

## 环境变量

| 变量 | 作用 |
|---|---|
| `FIELD_STATION_PORT` | 首选端口（默认 7788） |
| `FIELD_STATION_NODE` | 跑 `server.ts` 的 node.exe；不设则用 Electron 自带或 PATH |
| `FIELD_STATION_CAPTURE` | 首次 `did-finish-load` 后把页面截图写到这个 PNG 路径，只用于验收/文档 |
| `FIELD_STATION_LOG_DIR` | 日志目录，默认 `%LOCALAPPDATA%\FieldStation` |

日志：`%LOCALAPPDATA%\FieldStation\electron.log`，含启动参数、候选端口、服务端 stdout、
`did-finish-load`、渲染进程 console 消息（级别 ≥ 2 的警告/错误会原样记下来），只保留最近 200 KB。

## 关于 Electron 8（Chromium 80）的实测结论

`packages/app/src/web/index.html` **不需要改**就能跑：页面里没有 `?.` / `??` / `.at()` /
`replaceAll` / `structuredClone` / 顶层 await，脚本在 Chromium 80 下零报错（`console-message`
里只有我们自己 `enableRemoteModule: false` 之后消失的那条安全提示）。

唯一的可见差异是 CSS：`packages/app` 用 flex `gap` 做间距（26 处），而 flex `gap` 到
Chromium 84 才支持。Electron 8 里这些间距全部塌掉（logo 压住标题、页签文字黏在一起、
按钮贴住下拉框），功能、布局顺序、交互都正常。要修只能在 `packages/app` 加 `margin`
回退，那是另一个任务的文件，这里不动。

`main.cjs` 为此守了几条线：不写 `require('node:*')`（Node 12 不认）、不用可选链/空值合并、
`webContents.setWindowOpenHandler`（Electron 12+）先 `typeof` 判定存在才调用、
`app.allowRendererProcessReuse = true` 消掉 Electron 8 的弃用提示。

## 为什么端口逻辑在这里写了两遍

`main.cjs` 是 CommonJS，要在**没有构建步骤**的前提下直接跑，所以它没办法 `import`
`../src/launcher.ts`（那是 ESM + TypeScript）。重复的只有 `candidatePorts()` 那五行和
一次 `/api/health` 探测；真正的复用/顺延/杀进程规则以 `src/launcher.ts` 为准，改规则时
两边一起看（`packages/desktop/test/launcher.test.ts` 只锁 `launcher.ts`）。
