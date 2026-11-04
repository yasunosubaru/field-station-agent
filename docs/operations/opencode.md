# OpenCode 运行时（E1 的 A 侧）

状态：初版（2026-11-05，本机实测）

这份文件回答四件事：**装在哪、怎么起、跟 anthropic_shim 怎么分工、升级时改哪个常量**。
所有数字都是 2026-11-05 在本机跑出来的，不是从上游文档抄的。

## 装在哪

| 项 | 值 |
|---|---|
| 路径 | `.deps/opencode/bin/opencode.exe` |
| 版本 | **2.2.0**（`opencode --version` → `opencode v2.2.0`） |
| 文件大小 | 253,303,688 B（241.6 MiB / 253.3 MB） |
| sha256 | `dcb54dc811ac30a9107f2e704b2cf1ac29d52971d288499f0a2c7420e1504a48` |
| 包名 | `@opencode/cli-windows-x64@2.2.0` |
| 来源 URL | `https://registry.npmmirror.com/@opencode/cli-windows-x64/-/cli-windows-x64-2.2.0.tgz` |
| tarball | 118,650,212 B，sha256 `e5b387b4d2af88ffbd689ac84d35b71462072651f7529ab0f36721e35ba859bf` |
| npm shasum / integrity | `7547d355b7fb22853125733b6b2f7deb1518489e` / `sha512-S/eVkzMaUqoiBmeLHgEdr4b3yIQjpfDzLo4CFSSB3skB0UH+lduqqjTnmvAvDeli4fEjcNbZmd/8YwkoKnFkBA==` |
| 实测耗时 | 下载 99.2 s（npmmirror，本机），解压 0.51 s |

`.deps/` 是本地依赖目录，**不入库**：整包 253 MB，且是平台专用的二进制。仓库里
没有它的 `.gitignore` 规则，所以 `git status` 会多出一行 `?? .deps/` —— 这是预期的，
见下面「已知坑」第 1 条。

### 重装 / 复现

```powershell
# 1. 确认包名与版本（注意：不是 -win32-x64）
npm view @opencode/cli-windows-x64@2.2.0 --registry=https://registry.npmmirror.com

# 2. 取包（约 118 MB；不要改全局 npm 配置，--registry 只作用于这一条命令）
$pack = "$env:TEMP\ocpack"
New-Item -ItemType Directory -Force -Path $pack | Out-Null
npm pack @opencode/cli-windows-x64@2.2.0 --registry=https://registry.npmmirror.com --pack-destination $pack

# 3. 解到仓库（--strip-components=1 去掉 tarball 顶层的 package/）
New-Item -ItemType Directory -Force -Path .deps\opencode | Out-Null
tar -xzf "$pack\opencode-cli-windows-x64-2.2.0.tgz" -C .deps\opencode --strip-components=1

# 4. 校验（别用 Get-FileHash：它靠模块自动加载，负载下曾报「命令不存在」）
$sha = [System.Security.Cryptography.SHA256]::Create()
$fs  = [IO.File]::OpenRead(".deps\opencode\bin\opencode.exe")
([BitConverter]::ToString($sha.ComputeHash($fs)) -replace '-','').ToLower()
$fs.Close()
```

tarball 里只有三个条目：`bin/opencode.exe`（253.3 MB）、`package.json`（237 B）、空目录。
`--strip-components=1` 之后就是 `.deps/opencode/{bin/opencode.exe, package.json}`。

包名注意：E1 计划里写的 `@opencode/cli-win32-x64` 在 registry 上**不存在**（404）；
真正的平台包是 `-windows-x64`。而 `@opencode/cli` 本身只是 8.2 kB 的引导包
（`deps: none`，npm 描述自承 "not a functional release"），里面没有二进制。

## 怎么起

```powershell
py tools/opencode_smoke.py --version              # 打印解析到的版本
py tools/opencode_smoke.py --serve --port 4096    # 起服务、等就绪、打印响应码、停掉
```

工具自己负责收尾：`serve` 用 `subprocess` 起，`terminate` → 等 5 s → `kill`，
最后**再探一次端口**确认真的释放了。失败时把 `serve` 日志尾部打出来（其中的
`server password` 行已抹成 `<redacted>`），成功时不打印日志。

手工起也可以：

```powershell
.\.deps\opencode\bin\opencode.exe serve --port 4096
# 另开一个窗口
Invoke-WebRequest http://127.0.0.1:4096/app -UseBasicParsing | Select-Object StatusCode
```

| 项 | 值 |
|---|---|
| 默认端口 | **4096**（`--port` 可改；占用时工具直接退出 2，不去抢端口） |
| 监听地址 | `127.0.0.1`（工具写死回环，`--host` 只用于改本机地址，不要开 `0.0.0.0`） |
| 就绪判据 | `/app` 或 `/config` 返回 2xx，最多等 30 s，每 0.25 s 一轮 |
| 实测就绪 | 1 轮、0.55 s（冷启动，本机） |
| 停止 | 工具自动停；手工是 `Ctrl+C`，或 `Stop-Process -Id <pid>` |

**`/app` 返回 200 只说明「HTTP 服务起来了」**，不说明 provider 配好了、模型能用。
实测 `/`、`/app`、`/config` 三个路径返回的是同一份 SPA 首页（9610 B），所以状态码
对它们几乎等价 —— 想验模型链路得另外跑一次真实会话，那是 E1 的 B 侧。

`opencode serve` 每次启动会往 stdout 打一行一次性 `server password`。本轮冒烟只
GET 页面、不需要它，所以工具把它丢掉；要调 v2 API 时再从那个窗口里取。

Windows 上的 `terminate` 就是 `TerminateProcess`，**没有**优雅退出的中间态；
别在有未落盘任务时随手 kill（本工具只用于空跑冒烟，风险面为零）。

## 与 anthropic_shim / Claude SDK 的分工

**两个运行时互不依赖**：不共享代码、不共享端口、不共享配置，任何一个停掉另一个
照跑。它们解决的是两个方向相反的问题：

| | `opencode.exe`（本文） | `tools/anthropic_shim.py` |
|---|---|---|
| 是什么 | 完整的 agent 运行时（会话、工具、provider 抽象） | 无状态协议翻译器（约 1 400 行，纯标准库） |
| 服务对象 | 人 / 脚本直接驱动 OpenCode | **只会说 Anthropic Messages 的 Claude SDK / CLI** |
| 协议方向 | 自己直连 provider（OpenAI 兼容或原生） | Anthropic `/v1/messages` ↔ OpenAI `/chat/completions` |
| 端口 | 4096（`serve`） | 8765（默认，`--port` 可改） |
| 依赖 | 需要 `.deps/opencode/` 里那份 exe | 只需要 Python 标准库 |
| 起不来时 | 冒烟退出码 2/3/4 | 缺上游时 `--dry-run` 仍可自检 |

为什么不拿 shim 去接 OpenCode：OpenCode 的 provider 配置本来就支持 OpenAI 兼容
端点，中间再塞一层翻译只多一个故障点、多一段要排查的日志。反过来，Claude SDK
没有「换成 OpenAI 协议」这个开关，才必须有 shim。

另外机器上还有**第三份** opencode：OpenChamber 自带的那份在
`%LOCALAPPDATA%\Programs\@openchamberelectron\resources\opencode-cli\opencode.exe`
（259,169,160 B，与本仓库这份大小不同，不是同一个构建），由 OpenChamber 自己
以 `serve --stdio --hostname 127.0.0.1 --port 3358` 拉起来。它不归本仓库管，
**不要覆盖它，也不要拿它当本仓库的被测对象**。`tools/opencode_smoke.py` 刻意
不查 PATH、只认 `--exe` / `OPENCODE_EXE` / 仓库内两处默认位置，就是为了不误测到它。

## 升级时改哪

两个常量都在 `tools/opencode_smoke.py` 顶部，**必须成对改**：

```python
OPENCODE_VERSION    = "2.2.0"                      # 期望版本，--version 与它比对
OPENCODE_NPM_PACKAGE = "@opencode/cli-windows-x64" # 平台包名（换架构/换系统时才动）
```

改完按这个顺序走：

1. 按上面「重装 / 复现」取新版本，替换 `.deps/opencode/`；
2. `py tools/opencode_smoke.py --version` —— 应打印新版本；不一致时工具只**提示**
   不改退出码（0），因为「装了新版但常量没改」本身就是需要看到的现象，让检查
   红掉反而会诱导人去删断言；
3. `py tools/opencode_smoke.py --serve --port 4096` —— 要看到 200 且端口释放；
4. 更新本文表格里的版本 / 大小 / sha256 / 来源 URL / 实测耗时；
5. **同步 OpenChamber 的固定版本**：OpenChamber 2.5.3 钉的是 `@opencode/cli`
   2.2.0，升 OpenChamber 时这份运行时也要跟着对齐，否则「应用里能用、仓库里不通」
   会变成两套事实。

`tests/test_opencode_smoke.py` 不用改：它读的就是这两个常量，并且 exe 不存在时
只 skip 那一条集成用例，其余 23 条照跑。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（`--version` 拿到版本；`--serve` 拿到 2xx 并已停掉） |
| 1 | exe 跑不起来，或输出里解析不到版本号 |
| 2 | 找不到 exe、参数用法错误、或目标端口已被占用 |
| 3 | `serve` 在 `--timeout` 内没有就绪（日志尾部会一起打出来） |
| 4 | 子进程没能停掉（`terminate` 与 `kill` 都失败，需要人工收尾） |

## 已知坑

1. **`.deps/` 没有被整体忽略。** `.gitignore` 里只有 `venv/`，它恰好匹配到
   `.deps/venv`，所以那个目录不显示；`.deps/opencode/` 会作为 `?? .deps/` 出现在
   `git status` 里。**永远不要 `git add -A` / `git add .deps`**。彻底解决要往
   `.gitignore` 加一行 `.deps/`，但那不是本次授权范围，先记账。
2. **文件名带空格和中文**（仓库路径里有 `文件夹 老版` 与 `课程资料`）。脚本里一律
   用 `Path` 拼接、`subprocess` 传 list，不拼命令行字符串 —— 拼字符串在这种路径
   上必炸。`.ps1` 里不要放中文字面量（会按 GBK 读成乱码），ASCII 清单优先。
3. **`/app` 200 不等于「能用」**：见上面「怎么起」那段的说明。
4. **端口被占就用 2 退出**，不会自动换端口 —— 冒烟要的是可复现的位置，静默换端口
   会让「我明明查了 4096」变成假阴性。
5. **serve 会读用户级配置**（provider、认证都在 `~/.config/opencode` 或
   `%LOCALAPPDATA%\opencode` 一带）。它不会写进仓库（本轮实测：跑完 `git status`
   没有新增文件），但也意味着**同一台机器上别人的登录态会影响它**。冒烟只看 HTTP
   状态码，正好绕开这一点。
