# `docs/operations/shell.md` —— Electron 外壳的运行手册

> 这份文档只讲**外壳怎么跑、失败时看哪里**。外壳的目录结构与 W2/W3 的历史背景见
> `shell/README.md`（那份写到 Electron 45.2.2 实测与嵌入层为止），本文补的是
> **壳-1（payload 解压）与壳-2（拉 Python 服务）**落地之后的部分。
>
> 图上原文：「只负责 payload 解压、拉起 Python 服务与界面服务、把窗口指过去」。
> 三个动词对应三个文件：`payload.js` / `pyserver.js` / `main.js`。

## 1. 启动顺序

```
app.whenReady()
  → Menu / ipcMain 注册
  → preparePayload()                  ← 壳-1，payload.js
       <userData>/payload 已是最新 → 跳过（秒过）
       否则解压，控制台打「已解压 N/M」
       没有 payload.zip → status=absent，继续（开发态常态）
  → startServer()                     ← Node 服务（原有）
  → startPython()                     ← 壳-2，pyserver.js
  → waitForHealth()                   ← GET /api/health，400 ms 一次，≤ 40 s
  → createWindow() / createTray()
  → await startPython() 的结果         ← 窗口已开，Python 慢也不挡界面
```

**两个服务的失败语义不一样，这是有意的**：

| 服务 | 起不来时 | 为什么 |
|---|---|---|
| Node（界面入口） | 弹错误框，`app.exit(1)` | 窗口没有内容可显示 |
| Python（Agent 后端） | 只记日志，状态进 `shell:info` | 缺的是能力，不是入口；用户仍应能看窗口与日志 |

## 2. 壳-1：payload 解压

### 输入与输出

| 项 | 值 |
|---|---|
| 输入 | `<repo>/逆向/05_打包/payload.zip`（`tools/build_payload.py` 的默认输出） |
| 覆盖 | `NAS_PAYLOAD_ZIP` 环境变量，或 `--payload-zip <文件>` |
| 解压目标 | `app.getPath('userData')/payload`（Windows 上是 `%APPDATA%\nas-reimpl-shell\payload`） |
| 标记文件 | `payload/.extracted`（JSON，含 zip 的 sha256、清单摘要、解压时间） |

### 幂等怎么判

三方同时成立才跳过，缺一条就重解压：

1. `.extracted` 里的 zip sha256 与**当前** payload.zip 的 sha256 相同；
2. `payload/manifest.json` 的 sha256 与 zip 里那份 manifest 的 sha256 相同；
3. 磁盘上的**文件数**与**总字节**与清单 `payload.files` / `payload.bytes` 相同。

第 3 条是「不要只判目录存在」的落实。目录还在但文件被删了一半、被截断、被另一个版本的
payload 覆盖过 —— 数与字节都会露出来。

**计数口径**：manifest.json 自己**不计入** `files` / `bytes`（`build_payload.py` 是在收集完
文件之后单独写清单的）。这个口径与清单一致，否则「已解压 N/M」里的 M 会永远差 1，
而那只会表现成「每次启动都悄悄重解压一次」。

### 进度

解压按 5% 步长打：「已解压 400/5223（78.1 MB / 852.1 MB）」。首次与末次必打。
回调形态是 `onProgress({done, total, bytes, totalBytes, name, text})`，
将来要在窗口里画进度条直接接这个回调，不必改 `payload.js`。

### 原子性

解压先写 `<payload>.partial`，全部完成、校验过数与字节与 manifest sha256、写完 stamp 之后，
才删旧目录并 rename。中途失败（磁盘满、zip 坏、进程被杀）不会留下一个「看起来像解压好了」
的目录 —— 那种坏法下一次启动会被误判成有效载荷。

### 失败

| 情形 | 行为 |
|---|---|
| 没有 payload.zip | `status=absent`，打一行日志，继续启动 |
| zip 损坏 / 不是 zip | 抛 `PayloadError`，不换名、不写 stamp |
| 清单缺 `payload.files` / `payload.bytes` | 抛 `PayloadError`（宁可报错，也不要拿 `undefined` 去比） |
| 解出来数与清单不符 | 删 staging，抛错 |
| 成员名越界（`../`、绝对路径、盘符） | 抛错，**不写盘** |

### 验收（2026-11-09 真机跑过）

```powershell
# ① 首次：删掉 payload 目录后启动
node -e "require('fs').rmSync(process.env.APPDATA + '\\nas-reimpl-shell\\payload', {recursive:true, force:true})"
cd shell\electron
npx electron . --no-tray --port 7812 --payload-zip "..\..\outbound\smoke\payload.zip" --view chat
#   → [payload] 判定：extract（no-stamp） 需要解压 …
#   → [payload] 已解压 20/400 … 400/400
#   → [payload] 解压完成：400 文件 / 1.8 MB，耗时 0.4s

# ② 二次：再启动一次
npx electron . --no-tray --port 7813 --payload-zip "..\..\outbound\smoke\payload.zip" --view chat
#   → [payload] 判定：skip（ok） 跳过解压 清单 400 文件 / 1.8 MB 磁盘 400 文件 / 1.8 MB
#   → [shell] payload 已是最新，跳过解压（400 文件）
```

> 实测用的是 `outbound/smoke/` 下用脚本生成的 **400 成员合成 zip**（1.8 MB）：
> 真 payload（852 MB / 5223 成员）**本机没有**，`逆向/05_打包/payload.zip` 在 `.gitignore` 里，
> 需要先跑 `python tools/build_payload.py` 才存在。zip 的结构（根上 manifest.json、
> manifest 不计入 payload.files）与真件一致。**852 MB 那一档没有跑过。**

## 3. 壳-2：Python 服务

### 拉起什么

```powershell
<python> -m fieldstation.runtimes.server --host 127.0.0.1 --port 8788
# PYTHONPATH=<repo>/src, PYTHONUTF8=1, PYTHONIOENCODING=utf-8
```

`fieldsation.runtimes.server` 是运行时网关（`/v1/runtimes` 状态 + `/v1/chat` SSE）。
`tools/agent_server.py` **不由外壳拉**：它由 Node 桥懒启动（首次访问 `/api/agent/*`），
外壳再拉一次就会变成两个进程抢同一件事。

### 解释器从哪来

按顺序找，第一个存在的就用：

1. `<userData>/payload/runtime/python/python.exe` —— payload 里带的那份
   （`build_payload.py --python-dir` 放的），打包后机器上未必有 venv，所以它优先；
2. `<repo>/.deps/venv/Scripts/python.exe`；
3. `<repo>/.venv/Scripts/python.exe`；
4. `<repo>/venv/Scripts/python.exe`。

`NAS_PYTHON` 可以指名一个，跳过以上全部。

### 就绪协议

**照 Python 侧已有的约定，不改那边**：`src/fieldstation/runtimes/server.py` 第 115 行已经在
stdout 打

```
RUNTIME_GATEWAY_READY http://127.0.0.1:8788
```

外壳认这一行，并兼容项目里另外两种既有写法（`READY <port>`，见
`docs/product/architecture.md`；`AGENT_READY <port>`，见 `tools/agent_server.py`）。
**这一行没有新造协议，也没有改 `server.py`。**

用例外的两条硬要求，都是本机实测踩出来的：

- **读到就绪行还不够，要探 `/health`**。`server.py` 是先 `print` 再 `ThreadingHTTPServer(...)`，
  端口被占时它会先打一行 READY 再崩（实测 `PermissionError: [WinError 10013]`）。
- **`/health` 通了也还不够，要确认自己那个进程没死**。端口上可能跑着**别人**的服务，
  `/health` 会答 200，而外壳会以为「起来了」，然后去 taskkill 一个已经死掉的 pid ——
  端口上留着一个不是自己拉的服务。所以就绪判定是「读到行 + `/health` 通 + 再等 250 ms
  自己没退出」。

### 端口

默认 8788（`server.py` 自己的默认值）。冲突时向后试 8788–8792，最多 5 个。
不用 `--port 0`（系统分配）：那需要从 stdout 读真实端口，而 `server.py` 是在 bind **之前**
打就绪行的，打出来的 0 不是真端口。

冲突分两步挡：起之前用 `net.createServer().listen()` 预探一次（被占就直接换下一个，
不拉一个注定要崩的进程）；起来之后靠上面的 settle 检查兜住「预探与真 bind 之间的竞态」。

### 退出

`taskkill /pid <pid> /T /F` —— 与 `main.js` 结束 Node 服务完全同一做法。
只 kill 父进程会留下 Python 的子进程，而它们会占着端口。
`window-all-closed` / `before-quit` / `SIGINT` / `SIGTERM` 四条路都会调，且**先 Python 后 Node**。

### 命令行开关

| 开关 | 作用 |
|---|---|
| `--python-port 8788` | 指定起始端口（冲突时仍会 +1） |
| `--attach-python` | 只连不拉（语义与 `--attach` 同）；连不上就变成 `state=failed`，不弹框 |
| `--no-python` | 完全不碰 Python（没有解释器的机器上启动外壳用） |
| `--payload-zip <文件>` | 指定 payload.zip |

`NAS_PYTHON` 环境变量可以指定解释器。

### 状态可观测

`window.nasShell.info()` 里多了一段：

```js
{
  python: { state: 'ready' | 'attached' | 'failed' | 'skipped' | 'starting' | 'idle',
            url: 'http://127.0.0.1:8788', error: '', port: 8788 },
  payloadDir: 'C:\\Users\\<user>\\AppData\\Roaming\\nas-reimpl-shell\\payload',
  // …原有的 baseUrl / port / view / attach / views / versions / appearance / windows
}
```

### 验收（2026-11-09 真机跑过）

```
[payload] 判定：skip（ok） 跳过解压 …
[python] 启动：<repo>\.deps\venv\Scripts\python.exe -m fieldstation.runtimes.server --host 127.0.0.1 --port 8801（cwd <repo>）
[python] RUNTIME_GATEWAY_READY http://127.0.0.1:8801
[server] nas-reimpl app listening on http://127.0.0.1:7816
[server] READY 7816
[shell] http://127.0.0.1:7816 就绪（探测 2 次）
[python] 就绪：http://127.0.0.1:8801
[shell] Python 服务就绪：http://127.0.0.1:8801（解释器 <repo>\.deps\venv\Scripts\python.exe，来源 venv）
[shell] 截图已保存：…（53563 字节）
[shell] [python] 已结束进程树：taskkill /pid 21900 /T /F
```

退出后立刻查：

```powershell
Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
  Where-Object { $_.CommandLine -match 'fieldstation.runtimes' }        # 空
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'line-b-service' }               # 空
Get-CimInstance Win32_Process -Filter "Name='electron.exe'"             # 空
```

三项都为空 = 两个服务都不残留。

端口冲突也真机验过一次（先手动在 8788 起一个，再让外壳去拉）：

```
[python] 端口 8788 已被占用，换下一个
[python] 启动：… --port 8789
[python] RUNTIME_GATEWAY_READY http://127.0.0.1:8789
[python] 就绪：http://127.0.0.1:8789
```

## 4. 失败时先看哪里

| 现象 | 先看 |
|---|---|
| 启动慢 / 每次都像在解压 | `[payload] 判定：` 那一行的 `reason`（`disk-count` / `disk-bytes` 说明磁盘与清单对不上） |
| 窗口打不开 | `[shell] 启动失败：` 与 `[server]` 开头那些行（Node 服务的问题） |
| 窗口能开、Agent 不工作 | `[shell] Python 服务未就绪：`；再 `window.nasShell.info().python.state` |
| Python 说起来了但连不上 | 查端口：`Get-NetTCPConnection -LocalPort 8788`；也看是不是**别人**的服务占着 |
| 关窗后进程还在 | `main.js` 的 `stopPython()` / `stopServer()`；确认走的是 `before-quit` 而不是 `window-all-closed` + 托盘 |

## 5. 没做到的

- **852 MB / 5223 成员的真 payload 没有跑过**。仓库里没有那个 zip（`.gitignore` 排除），
  实测用的是 400 成员的合成件。解压是流式 + 逐个 crc 校验，规模上应该只是更慢；
  但「解压期间窗口是否卡住」这一条只能在真件上验。
- **进度没有画在窗口里**。计划书 §壳-1 步骤 3 写的是「主窗口显示进度」；现在是主进程控制台
  打「已解压 N/M」，`onProgress` 回调已经留好接口，接一个进度窗不必改 `payload.js`。
  进度窗需要先有窗口，而窗口要等服务就绪 —— 顺序上要另做一次改动。
- **`--payload-zip` 只对本次进程生效**，没有写进任何配置。
