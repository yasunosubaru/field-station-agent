# 远程采数 / 截图工具

OEM729 接在一台**远程 Windows 机器**上（下文统称「远程机」），本机只做计算。通道是 **SSH**，不是 RDP：
远程机开着 OpenSSH Server，密码登录已关闭，只认一把公钥。

本目录的脚本全部**纯 ASCII**，机器相关的路径与主机名一律走参数或 `$env:USERPROFILE`，不写死。
用之前先把下面四个变量按自己的环境填一遍：

```powershell
$H = 'user@host'                             # 远程机的 SSH 目标（本机 ~/.ssh/config 里起个别名更好）
$K = "$env:USERPROFILE\.ssh\<私钥文件名>"      # 私钥；ssh 配置里写好了就用别名，不必带 -i
$T = 'C:/Users/<user>/AppData/Local/Temp'    # 远程机上的临时目录（脚本默认走 $env:USERPROFILE）
$r = '逆向\tools\remote'                     # 本仓库里的脚本目录
```

## 核心脚本

| 脚本 | 在哪跑 | 作用 |
|---|---|---|
| `capture-serial.ps1` | 远程 | 打开某个 COM 口，发一批 `LOG …` 命令，抓 N 秒原始字节到文件 |
| `shot-window.ps1` | 远程（需交互会话） | 用 `PrintWindow(PW_RENDERFULLCONTENT)` 抓指定进程主窗口的像素 |
| `run-in-session.ps1` | 远程 | 建一个 `LogonType Interactive` 的一次性计划任务，把某个脚本送进**已登录的桌面会话**里跑，跑完自动删 |
| `port-state.ps1` | 远程 | 端口占用与进程自查（谁占着 COM、还剩哪些临时文件） |

## b7 那一批（ITK / 事件 / 多频）

| 脚本 | 作用 |
|---|---|
| `b7-flood.ps1` | 端口洪流定位：逐步发 `UNLOGALL` / `UNLOGALL USB2` / `UNLOG USB2 RANGEB` / `UNLOG USB2_29 RANGEB` / `UNLOGALL USB2_29`，并打印每步 2 秒收到的字节数 |
| `b7-probe.ps1`、`b7-probe2.ps1` | ITK 命令逐条探针：发一条、排空、把回复按命令写进同名 `.txt` 转录 |
| `b7-capture.ps1` | 正式抓包（ITK 1 Hz + RANGEB + RXSTATUSEVENTA，中途 6 次主动制造事件） |
| `b7-restore.ps1` | 把改过的 `ITWARNINGCONFIG` / `ITSPECTRALANALYSIS` 改回 b1 抓包里的原值，并用 `LOG RXCONFIGA ONCE` 读回 |
| `b7-who.ps1` | 收尾查 `LOGLISTA`：端口上还剩哪些日志、所有者是谁 |
| `b7-idle.ps1`、`b7-quiet.ps1` | 收尾测静默：某口 N 秒还流多少字节 / 清一次再看流不流 |
| `b1-capture.ps1` … `b6-capture.ps1`、`*-probe.ps1`、`cfg-probe*.ps1`、`ifm-probe.ps1` | 各批次的一次性抓包与探针，命名即批次 |

**两个必须知道的实测（详见 [`../../03_分析/05_GRIT-Monitor.md`](../../03_分析/05_GRIT-Monitor.md) 第 13 节）**：

1. **裸 `UNLOGALL` 清不掉套件挂的日志。** 端口上可能存在所有者为 `USB2_29` / `USB2_30` 的日志
   （`RANGEB ONTIME 0.05` 一条就 65 KB/s）。要么 `UNLOGALL USB2_29` + `UNLOGALL USB2_30`，
   要么按名 `UNLOG USB2_29 RANGEB`；只发 `UNLOGALL` / `UNLOGALL USB2` 等于没清。
2. **套件在跑时它会自己把最小 profile 挂回来**（`BESTPOSB 1 Hz`、`RXSTATUSB`、`RAWEPHEMB`、
   `HWMONITORB` / `PORTSTATSB 10 s`，约 0.2–0.4 KB/s）。清完 5 秒内又出现，那不是本目录脚本留下的，
   收尾报「已清掉自己的」即可，别去追这条。

**为什么要 `run-in-session`**：SSH 起的进程在 session 0，没有桌面，`CopyFromScreen` 会是全黑。
而 `PrintWindow` 只要求窗口句柄存在，所以两者结合起来，**不需要有人连着 RDP** 也能截到套件窗口。

## 典型用法

```powershell
# 1) 抓串口（20 秒，COM8；套件占着 COM9 时用 COM8/COM10）
scp -i $K "$r\capture-serial.ps1" "${H}:$T/capture-serial.ps1"
ssh -i $K $H "powershell -NoProfile -ExecutionPolicy Bypass -File $T/capture-serial.ps1 -Port COM8 -Seconds 20 -Out $T/nova.sbf"
scp -i $K "${H}:$T/nova.sbf" .\nova.sbf

# 2) 截套件窗口（无需 RDP）
scp -i $K "$r\shot-window.ps1" "$r\run-in-session.ps1" "${H}:$T/"
ssh -i $K $H "powershell -NoProfile -ExecutionPolicy Bypass -File $T/run-in-session.ps1 -Script $T/shot-window.ps1"
scp -i $K "${H}:$T/nova-printwin.png" .\suite.png
```

> scp 的目标路径要写成 `user@host:C:/…` 的形式；用变量拼时注意别把 Windows 冒号吃掉。

## 坑（都踩过）

1. **`.ps1` 必须纯 ASCII**：Windows PowerShell 5.1 无 BOM 时按 GBK 读，中文字面量会把脚本解析炸掉。
2. **不要用 `ssh host "powershell -Command \"…\""` 传复杂命令**：层层转义必翻车（`$_`、`&`、引号）。
   一律「写文件 → scp → 按路径执行」。
3. **`Start-Process` / `New-Object` 的参数列表里别写类型转换**（`[int]$Baud` 会被当成字面量字符串）。
4. **`Register-ScheduledTask -UserId $env:USERDOMAIN\…` 在 SSH 下会报 0x80070534**，
   要用 `[Security.Principal.WindowsIdentity]::GetCurrent().Name`。
5. **COM 口是独占的**：套件开着就占住它的口。抓包挑空闲口，先用 `try { $sp.Open() } catch { }` 探一下，
   或用 `port-state.ps1`。
6. 收尾要清干净：远程临时脚本 / 图片，以及 `run-in-session.ps1` 留下的计划任务。
7. **别把主机名、IP、用户名、私钥名写进仓库**：脚本参数化 + 本机 ssh 配置别名就够了，
   这台机器的信息属于环境而不是证据。本目录的脚本已按这条清理过一遍。
