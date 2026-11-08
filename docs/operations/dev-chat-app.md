# DevChat · 开发群聊桌面版（WinUI 3）

`tools/dev_chat.py` 的图形前端。原生 WinUI 3，暗色界面。

**这是开发辅助工具，不是交付功能。**

---

## 0. 为什么有桌面前端

命令行那套（`tools/dev_chat_say.py`）适合四条开发线说话，但人看着不方便：

| 场景 | 命令行 | 桌面版 |
|---|---|---|
| 四条线发言 | ✅ 合适 | — |
| 人看历史、按人筛 | 要敲 `--read` | ✅ 点一下 |
| 人发言 | 要拼 `--who/--text` | ✅ 打字回车 |
| 随手挂在旁边 | ❌ | ✅ |

所以两个都要：**线用命令行，人用窗口。**

---

## 1. 运行

### 1.1 直接跑（开发态）

```powershell
cd tools\DevChatApp
dotnet run
```

### 1.2 生成发布版

```powershell
cd tools\DevChatApp
dotnet publish -c Release -r win-x64 --self-contained false
```

产物在 `bin\Release\net10.0-windows10.0.19041.0\win-x64\publish\`，
主程序 `DevChat.exe`。

**⚠ 目标机需要 .NET 10 Desktop Runtime + Windows App SDK 1.8 运行时。**
Windows App SDK 已设 `WindowsAppSDKSelfContained=true`，会随包带走；
.NET 运行时没有自包含（为了减小体积），Windows 11 通常自带。

要完全免依赖，改成：

```powershell
dotnet publish -c Release -r win-x64 --self-contained true
```

体积会从约 5 MB 涨到约 70 MB。

---

## 2. 两种工作模式

设置里可以切（右上角「设置」）：

| 模式 | 行为 | 什么时候用 |
|---|---|---|
| **内置服务**（默认） | 应用自己起 `tools/dev_chat.py`，退出时杀掉 | 只想开一个窗口 |
| 连已有服务 | 连一个已经在跑的 `dev_chat.py` | 四条线已经在用那个服务 |

### 内置模式的三个细节

**① 端口自动分配**

内置模式用 `--port 0`，实际端口从服务 stdout 的 `DEV_CHAT_READY <port>` 读。
不会和 7805 上已有的服务抢端口。

**② token 自动生成**

每次启动生成新 token，只在本进程内使用。因为内置模式只监听 `127.0.0.1`，
token 是防同一台机器上其它程序误连。

**③ 消息文件与命令行共用**

内置模式写的是仓库里的 `logs/dev_chat/chat.jsonl`，
和四条线用命令行写的是**同一份**。所以窗口里能看到线说的话，线也能看到你在窗口里说的话。

**⚠ 这就是为什么要共用日志**：否则会变成两个互不相通的房间。

---

## 3. 界面

```
┌─────────────────────────────────────────────────────┐
│ ● 开发群聊   共 12 条 · 20:07:18            [设置]  │
├────────┬────────────────────────────────────────────┤
│ 全部 12│  C · 19:38                                  │
│ A 线  1│  视-6 深链双向完成，存 2eaa626…             │
│ B 线  3│                                            │
│ C 线  2│  B · 19:47                                  │
│ D 线  2│  已 rebase 到 main，1813 OK skipped 0…      │
│ 你    4│                                            │
├────────┴────────────────────────────────────────────┤
│ [你（决策）▾] [说点什么…（Ctrl+Enter 发送）] [发送] │
└─────────────────────────────────────────────────────┘
```

| 元素 | 说明 |
|---|---|
| 左侧栏 | 全部 / A / B / C / D / 你，数字是各自条数 |
| 点某一项 | 只看那个人，再点「全部」恢复 |
| 消息 | 头像色块 + 名字 + 时间 + 标签 + 正文 |
| `` `反引号` `` | 渲染成等宽（文件名、函数名） |
| `@A` | 高亮成该成员的颜色 |
| 滚到底 | 自动跟新消息；往上翻时不打断 |

---

## 4. 快捷键

| 键 | 作用 |
|---|---|
| `Ctrl+Enter` | 发送 |
| `Enter` | 换行（输入框支持多行） |

---

## 5. 设置项

| 项 | 说明 |
|---|---|
| 由本应用启动本地服务 | 开 = 内置模式；关 = 连已有服务 |
| 服务地址 | 内置模式会被覆盖为实际端口 |
| token | 服务要求鉴权时填 |
| 仓库根 | 内置模式用；留空自动从 exe 往上找 |
| python.exe | 留空自动找 `.deps/venv/Scripts/python.exe`，再退 PATH |

设置存在 `%LOCALAPPDATA%\DevChat\settings.json`。
窗口尺寸也存那里，下次打开恢复。

---

## 6. 技术要点

| 项 | 做法 | 为什么 |
|---|---|---|
| UI 框架 | WinUI 3（`Microsoft.WindowsAppSDK` 1.8） | 原生，暗色跟随系统 |
| 目标框架 | `net10.0-windows10.0.19041.0` | 与仓库 .NET SDK 一致 |
| 主题 | `RequestedTheme="Dark"` + `ThemeDictionaries` | 暗色为默认，浅色也给一份，切系统不崩 |
| 颜色来源 | `Theme.Res(key)` 从窗口根资源查 | 直接读 `Application.Resources` 在初始化早期取不到，会退回兜底色 |
| 轮询 | 2.5 秒拉一次 `?since=<seq>` | 服务端是简单 HTTP，不引入 SSE 更稳 |
| 杀服务 | `taskkill /PID x /T /F` | Windows 上必须杀整棵树，否则孤儿子进程占端口 |
| 找仓库 | 从 exe 往上 8 层找含 `tools/dev_chat.py` 的目录 | 与仓库既有 `BundleLayout.ResolveRoot` 思路一致 |

### 踩过的两个坑

**坑一：主题资源取不到，界面被强调色铺满**

第一次做出来整个窗口是橙色的。原因：`Application.Current.Resources`
在窗口构造早期还没解析完 `ThemeDictionaries`，`TryGetValue` 失败后
我退回了一个兜底色，而那个兜底色恰好是强调色。

**修法**：把窗口根元素传给 `Theme.Attach()`，优先从元素级 `Resources` 查；
兜底色改成中性灰，不再是强调色。

**坑二：消息显示 0 条**

一开始把日志写到 `%LOCALAPPDATA%\DevChat\chat.jsonl`，
而四条线写的是仓库里 `logs/dev_chat/chat.jsonl` —— 两个房间。
**修法**：内置模式也用仓库里那份。

---

## 7. 与其它工具的关系

| 工具 | 角色 |
|---|---|
| `tools/dev_chat.py` | 服务端（唯一真相） |
| `tools/dev_chat_say.py` | 命令行客户端（四条线用） |
| `tools/DevChatApp/` | 桌面客户端（人用） |

三者共用同一个 `chat.jsonl` 和同一套 HTTP 接口。

---

## 8. 已知限制

| 限制 | 说明 |
|---|---|
| 需要 .NET 10 Runtime | 除非 `--self-contained true` |
| 没有身份验证 | 服务端设计如此（开发期工具、只本机/局域网） |
| 轮询而非推送 | 2.5 秒延迟；聊天够用 |
| 不支持发图片/文件 | 纯文本，刻意保持简单 |
| 不能编辑/删除消息 | 日志性质，改了就不叫日志 |
