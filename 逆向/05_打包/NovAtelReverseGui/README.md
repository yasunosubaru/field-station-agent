# All powered-FSA 桌面壳（打包源）

WinForms + WebView2 外壳，产物是单文件 `AllPoweredFSA.exe`。启动时把嵌入的
`payload.zip` 解压到 `%LOCALAPPDATA%\AllPoweredFSA\app-<version>`，用自带的
`runtime/node.exe` 启动 `逆向/04_重实现/packages/app/src/server.ts --port 0`，
读到 `READY <port>` 后把 WebView2 指向 `http://127.0.0.1:<port>/`。

契约见 [`docs/superpowers/plans/2026-11-03-Agent桌面版-契约.md`](../../../docs/superpowers/plans/2026-11-03-Agent桌面版-契约.md)
（§1 进程与端口、§6 会话存储：`%LOCALAPPDATA%\AllPoweredFSA\`）。

**不需要装 Node.js**，只需要 Windows 10/11 x64 与 WebView2 Runtime（一般随 Edge 已装）。

## 文件

| 文件 | 作用 |
|---|---|
| `MainForm.cs` | 主窗口：解压 payload、拉起内置 Node、等 `READY <port>`、导航 WebView2；关窗时 `Kill(entireProcessTree)` |
| `Program.cs` | 入口：单实例 `Mutex`（`Local\AllPoweredFSA.SingleInstance`）、DPI 感知（csproj 的 `PerMonitorV2`） |
| `NasGui.csproj` | 程序集名 `AllPoweredFSA`、`<Version>`、产品名、图标、payload 资源 |
| `app.ico` / `app-inverted.ico` | 原版图标与反相版 |

几个容易被误改的点：

- **payload 资源名固定是 `NasGui.payload.zip`。** `AssemblyName` 已改成 `AllPoweredFSA`，
  但 csproj 用 `<EmbeddedResource ... LogicalName="NasGui.payload.zip" />` 钉住了逻辑名，
  `MainForm.PayloadResource` 也读这个名字。两边要一起改，只改一边会得到
  “payload.zip is missing from this build”。
- **根命名空间仍是 `NasGui`**，源码里的 `namespace NasGui` 不用动。
- **解压目录带了产品名**：旧版是 `%LOCALAPPDATA%\NovAtelReverse\`，现在会话、jobs、WebView2
  缓存都在 `%LOCALAPPDATA%\AllPoweredFSA\`。旧目录不会自动删除（那是用户数据，不替用户删，
  想省地方手动删掉即可）。
- **每次改 `<Version>` 都会换解压目录**（`app-0.2.0.0` 这种），外壳启动时清理更早的 `app-*`。

## 环境变量（外壳注入子进程）

| 变量 | 值 | 用途 |
|---|---|---|
| `FSA_ROOT` | 解压后的 payload 根 | Python 侧从这里找 `src/`、`tools/`、`config/`、`workflows/` |
| `FSA_SUITE_DIR` | `<root>/original`（仅 `--with-original` 打包时存在） | 已安装的 NovAtel 套件目录 |
| `NAS_PYTHON` | `<root>/runtime/python/python.exe`（仅带 Python 时） | 固定流程执行器用的解释器 |
| `NAS_WORKFLOW_JOBS` | `%LOCALAPPDATA%\AllPoweredFSA\jobs` | 流程 job 回执，跨版本升级保留 |
| `NAS_DEBUG_PORT` | 例如 `9222` | 维护用：给 WebView2 开 DevTools 端口 |

## 生成 payload.zip

payload 的内容与排除规则写在 [`tools/build_payload.py`](../../../tools/build_payload.py)，
**不要手搓 zip**：清单、`manifest.json`、压缩参数都只有一处。

```powershell
# 只校验输入并打印清单，不写任何文件（0 退出 = 必填项齐全）
python tools/build_payload.py --check

# 打包到默认位置：本目录的 payload.zip
python tools/build_payload.py

# 指定 node / 附带 Python 运行时 / 另外留一份解压好的目录（调试用）
python tools/build_payload.py `
  --node-exe "C:\Program Files\nodejs\node.exe" `
  --python-dir "C:\python311-embed" `
  --payload-dir ..\..\tmp\payload

# 顺带把本机已安装的套件打进去（见下面的体积与许可提醒）
python tools/build_payload.py --with-original
```

| 参数 | 说明 |
|---|---|
| `--root` | 仓库根，默认 `tools/` 的上级 |
| `--out` | 输出 zip，默认 `逆向/05_打包/NovAtelReverseGui/payload.zip`（已在 `.gitignore`） |
| `--payload-dir` | 额外写一份未压缩的 payload 树，便于对比/排查 |
| `--node-exe` | 默认用 PATH 里的 `node`，否则 `C:\Program Files\nodejs\node.exe` |
| `--python-dir` | 可选；整份复制到 `runtime/python/`，缺 `python.exe` 只告警 |
| `--with-original` | 复制已安装套件到 `original/` |
| `--suite-dir` | 配合 `--with-original` 换源目录 |
| `--check` | 只校验、只打印清单 |
| `--strict` | 连可选输入（`tools/agent_server.py` 等）缺失也报错，适合发版卡口 |
| `--print-default-out` | 打印默认 zip 路径后退出（`build_release.ps1` 用它取路径） |

### payload 结构

```
payload/
  manifest.json                         # 本脚本生成：文件数 / 字节数 / 逐项摘要
  runtime/node.exe
  runtime/python/                       # 可选：Python embeddable（固定流程用）
  逆向/04_重实现/                        # TS 重实现；node_modules 只留 serialport 及其依赖
  逆向/00_来源/samples/                  # 首次启动能打开的样例
  逆向/01_解包/app/{view,model,assets,controller}
  逆向/01_解包/Graph/out/renderer/assets
  workflows/                            # 固定流程 YAML，不含 jobs/
  src/fieldstation/                     # 执行器（纯标准库）
  tools/workflow_cli.py
  tools/uia_driver.py
  tools/uia_selectors.json
  tools/agent_server.py                 # WP2，缺失时 Agent 页不可用
  tools/agent_store.py
  tools/suite_launcher.py               # WP6
  tools/secret_store.py                 # WP3
  config/
  docs/operations/                      # 可选
  README.md LICENSE PROVENANCE.md
  original/                             # 仅 --with-original
```

排除规则：`.git`、`__pycache__`、`.venv`、`.pytest_cache`、`.vs`、`.vscode`、
`*.pyc/*.pyo/*.tmp`、`Thumbs.db` 等一律不进包；`workflows/jobs/` 不进包；
`packages/app/node_modules` 只保留串口运行时要用的
`serialport`、`@serialport`、`debug`、`ms`、`node-gyp-build`、`node-addon-api`
（**serialport 必须进包，否则 Add Device 列不出真实串口**）。

关于 `manifest.json`：逐项记录文件数、字节数和“名字 + 大小”摘要（`sha256_tree`），
每项再抽 8 个文件算真实内容 SHA-256（`sample[]`）。400 MB 的整树不做全量哈希——
每打一次包多花几分钟，换不到诊断价值。zip 成员时间戳固定、顺序按路径排序，
同样的输入得到同样的字节。

当前本机实测（`--check`）：**约 1792 个文件、270.3 MB**（含 88.2 MB 的 `node.exe`、
124.4 MB 的样例），压完大约 120–160 MB 量级；并行工作包还在往 `tools/`、`src/` 加文件，
数字会小幅变动。

### `--with-original` 的体积与许可提醒

- 体积：本机 `C:\Program Files\NovAtel Inc\NovAtel Application Suite` 是 **408 个文件、1.36 GB**，
  而 zip 对已压缩的二进制几乎压不动，所以带 `original/` 的包会从 ~150 MB 涨到 **~1.4 GB**，
  首次启动解压时间也从十几秒变成几分钟。
- 许可：套件本身是 NovAtel 的专有软件。`--with-original` 只用于**本机/离线演示**，
  **不要把带 `original/` 的 exe 传到 Releases、网盘或任何公开位置**。发版一律不带这个开关；
  需要套件时让目标机器自己装，或用 `FSA_SUITE_DIR` 指过去。
- 不带 `original/` 时，外壳不设置 `FSA_SUITE_DIR`，套件相关流程会明确报“套件不可用”，
  其余功能不受影响。

## 发布流程

```powershell
# 一条命令：打包 payload → dotnet publish 单文件 → 算 SHA256 → 写 release.json
powershell -NoProfile -File tools\build_release.ps1 -Version 0.2.0

# 复用已有 payload（调 UI 时省掉几分钟）
powershell -NoProfile -File tools\build_release.ps1 -Version 0.2.0 -SkipPayload
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `-Version` | `0.2.0` | 同时传给 `-p:Version`，并与 csproj 的 `<Version>` 比对，不一致会告警 |
| `-WithOriginal` | 关 | 透传给 `build_payload.py --with-original` |
| `-SkipPayload` | 关 | 不重打 payload，直接用现有 `payload.zip` |
| `-Configuration` / `-Runtime` | `Release` / `win-x64` | 透传给 `dotnet publish` |

产物：

```
dist/AllPoweredFSA-<版本>-win-x64/
  AllPoweredFSA.exe      # 单文件，payload 内嵌
  release.json           # 版本、字节数、exe/payload 的 SHA256、工具链版本
```

脚本做的事：`build_payload.py --print-default-out` 取路径（脚本本身是纯 ASCII，
不写中文路径字面量）→ 校验 zip 里有 `manifest.json`、`runtime/node.exe` 和
`packages/app/src/server.ts` → `dotnet publish -c Release -r win-x64 --self-contained true
-p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true
-p:EnableCompressionInSingleFile=true -p:DebugType=None` → 用 .NET 的 SHA256 直接算哈希
（不用 `Get-FileHash`，它在负载下出现过“命令不存在”）。

手工等价命令（不带 `release.json`）：

```powershell
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true -p:DebugType=None `
  -p:Version=0.2.0 -o ..\..\dist\AllPoweredFSA-0.2.0-win-x64
```

发版仍然要动四处，缺一处就会出现“README 说 0.2.0、Release 里是 0.1.10”：

| 步骤 | 做什么 |
|---|---|
| 1 | 改 `NasGui.csproj` 的 `<Version>`，跑 `build_release.ps1`，记下 exe 字节数与 SHA256 |
| 2 | 产物留在 `dist/AllPoweredFSA-<版本>-win-x64/`（`dist/` 不入库），保留 `release.json` |
| 3 | 在 `Releases` 建 tag 与发布说明，附 `AllPoweredFSA.exe`、`release.json` |
| 4 | 更新 [`CHANGELOG.md`](../../../CHANGELOG.md) 的版本表 |

本机网络的实测记录（下次发布不用重新排查）：`api.github.com` 与 `uploads.github.com` 在这个网络下会
被解析到不可达地址（`20.205.243.x`）；`api.github.com` 用 `curl --resolve` 钉到 `140.82.112.6`
可以直连，而**资产上传必须走本地代理**（`http://127.0.0.1:7897`），钉 IP 会返回 404。
`gh` 的 keyring token 可能报 invalid，但 git 凭据里的同一 token 可用（`repo` scope）。

## 构建环境

| 需要 | 说明 |
|---|---|
| .NET SDK 10 | `net10.0-windows`、`Microsoft.Web.WebView2` 1.0.3351.48 |
| Python 3.9+ | 只用于 `build_payload.py`；`FSA_PYTHON` 可指定解释器（Store 的假 `python.exe` 会返回 9009，脚本会跳过它） |
| Node（仅打包机） | 要打进 payload 的 `node.exe`，默认 PATH 或 `C:\Program Files\nodejs\node.exe` |
| WebView2 Runtime（目标机） | Windows 11 一般已随 Edge 安装 |

## 限制

- 关闭窗口会 `Kill(entireProcessTree)` 结束内置 Node；不会留下后台进程。
- 改版本换解压目录，旧 `app-*` 会在下次启动时被清理；旧版 `%LOCALAPPDATA%\NovAtelReverse\` 不自动清。
- **Workflows 页签需要 Python**（`runtime/python/` 或 PATH 里的 `python`；`NAS_PYTHON` 可覆盖）。
  payload 不带 Python 时，页签会显示「工作流不可用」并给出原因，其余页面不受影响。
- 原版套件的 **Update 写路径**通过固定流程 `gui.device.update` 完成：默认人工任务
  （`assisted`）；要用 UIA 自动点，套件必须以 `--force-renderer-accessibility` 启动，
  且 `tools/uia_selectors.json` 要随套件版本维护。
- 套件级 RPA（Add Application / Auto Updates / Update Application）仍未纳入，见
  [覆盖边界](../../README.md#覆盖边界)。
