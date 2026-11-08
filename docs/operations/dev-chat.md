# 开发群聊（dev_chat）

**这是项目的开发辅助工具，不是交付功能。**

它解决的问题：四条开发线（A 编排 / B 服务面 / C 界面 / D 数据设备）在各自的
worktree 里并行干活，彼此看不到对方说了什么、踩了什么坑、改了哪个共用文件。
没有共享对话场所时，同一个坑会被四个人各踩一次。

---

## 0. 为什么是本地页面，不是 QQ / 微信

| 方案 | 官方支持 | 封号风险 | 要注册 | 群聊 |
|---|---|---|---|---|
| **本工具** | — | **无** | 不用 | ✅ |
| QQ 群机器人（NapCat） | ❌ 第三方协议注入 | **有** | 小号 | ✅ |
| 企业微信群机器人 | ✅ | 无 | 企业微信 + 3 人群 | ✅ |
| Server酱 / PushPlus | 第三方 | 无 | 扫码 | ❌ 单聊 |

**关键理由**：四条线是这台机器上的进程，用户也在同一台机器上工作。
没必要让消息绕一圈去外部服务器再回来——本地页面就够了，而且零风险。

---

## 1. 快速开始

```powershell
$py = "<仓库根>\.deps\venv\Scripts\python.exe"
Set-Location "<仓库根>"

# 起服务（自动分配端口，实际端口看输出的 DEV_CHAT_READY）
& $py tools\dev_chat.py --host 0.0.0.0 --port 7805

# 浏览器打开
Start-Process "http://127.0.0.1:7805"
```

**给手机看**（同一 WiFi）：

```
http://<本机局域网IP>:7805
```

查本机 IP：

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch "^127" } | Select-Object IPAddress, InterfaceAlias
```

---

## 2. 五个人怎么说话

成员固定：`A` / `B` / `C` / `D` / `你`。

### 网页

左下角选身份，输入框打字，`Ctrl+Enter` 发送。
左侧按人过滤，数字是各自说了多少条。

### 命令行（四条线用这个）

```powershell
$py = "<仓库根>\.deps\venv\Scripts\python.exe"
Set-Location "<仓库根>"

# 说话
& $py tools\dev_chat_say.py --who B --text "工-1 完成，存 c0f309a"
& $py tools\dev_chat_say.py --who B --text "..." --tag 进度

# 看最近 20 条
& $py tools\dev_chat_say.py --read 20

# 只看 A 说的
& $py tools\dev_chat_say.py --read 20 --who A
```

**⚠ 必须用 `&` 调用**，不要 `Start-Process`（中文空格会被 PowerShell 拆开）。

---

## 3. 参数

### `dev_chat.py`

| 参数 | 默认 | 说明 |
|---|---|---|
| `--host` | `127.0.0.1` | 监听地址。要给手机看用 `0.0.0.0` |
| `--port` | `0` | 0 = 自动分配，实际端口见 `DEV_CHAT_READY <port>` |
| `--token` | 空 | 给了就要求 `Authorization: Bearer <token>` |
| `--log` | `logs/dev_chat/chat.jsonl` | 消息文件 |
| `--gen-token` | — | 生成随机 token 并打印后退出 |

### `dev_chat_say.py`

| 参数 | 说明 |
|---|---|
| `--who` | `A` / `B` / `C` / `D` / `你`（也认 `USER`） |
| `--text` | 内容 |
| `--file` | 从文件读内容（长文本用） |
| `--tag` | 可选标签，如 `进度` / `问题` / `汇报` |
| `--read N` | 读最近 N 条（不发言时用） |
| `--url` | 覆盖地址，默认 `http://127.0.0.1:7805` |
| `--token` | 覆盖 token |

**环境变量**：`FSA_DEV_CHAT_URL` / `FSA_DEV_CHAT_TOKEN`（命令行参数优先）。

**退出码**：`0` 成功 / `1` 服务端拒绝 / `2` 连不上或 401。

---

## 4. 安全边界

| 项 | 处理 |
|---|---|
| 默认监听 | **只 `127.0.0.1`** |
| `--host 0.0.0.0` 但不给 token | **拒绝启动**（代码里写死） |
| 请求体上限 | 64 KB |
| 单条消息上限 | 4000 字 |
| 不打印 | token、本机绝对路径 |
| 身份验证 | **没有**。这是开发期工具，跑在本机/局域网内 |

**⚠ 不要直接暴露到公网。** 要暴露必须自己加反向代理 + 认证。

---

## 5. 数据

消息落在 `logs/dev_chat/chat.jsonl`，一行一条：

```json
{"seq":1,"who":"B","text":"工-1 完成，存 c0f309a","tag":"进度","at":"2026-11-08T19:13:02"}
```

`seq` 单调递增，客户端用 `?since=N` 做增量拉取。

**这个文件不进 git**（属于运行态）。`logs/` 里其他内容按仓库既有约定处理。

---

## 6. 什么时候该用

| 时机 | 说什么 |
|---|---|
| 开工 | 「开始做 X」 |
| 做完一条 | 「X 完成，存 `<hash>`」 |
| 需要别人配合 | 「@A 我要用 `forest()`，返回里有 `steps_total` 吗」 |
| 发现影响别人 | 「我改了 `runtimes/base.py`，B 注意」 |
| 踩到坑 | 「worktree 里 `node_modules` 要自己装一次」 |

**说人话，但事实要准。** 可以说「`botd/store.py` 改了 8 个文件」，
不要只说「进展顺利」。

---

## 7. 和公告板（board.md）的关系

| 工具 | 用途 |
|---|---|
| `dev_chat`（本工具） | **日常说话**，像同事在群里聊 |
| `_fsa-broadcast/board.md` | **结构化状态汇总**，给「汇报」看 |

两个都能用。群聊更自由，公告板更规整。

---

## 8. 测试

```powershell
$py = "<仓库根>\.deps\venv\Scripts\python.exe"
$env:PYTHONPATH = "src"
& $py -m unittest tests.test_dev_chat -v
```

24 项，涵盖：存储序号、身份归一化（含 `USER` 别名）、API 边界（非法 who /
空文本 / 超长）、token 鉴权（错 token / 无 token / 页面免鉴权）、
端到端（真起进程、按 `DEV_CHAT_READY` 读端口、发一条读回来）。

---

## 9. 已知限制

| 限制 | 说明 |
|---|---|
| 没有身份验证 | 谁能访问端口就能以任何人身份发言。开发期工具，可以接受 |
| 不持久化到数据库 | JSONL 够用；要检索再说 |
| 没有消息编辑/删除 | 刻意不做，日志性质 |
| 轮询而非推送 | 2.5 秒拉一次，简单可靠；真需要可换 SSE |
| 进程重启后从文件恢复 | `seq` 会接着上次继续 |
