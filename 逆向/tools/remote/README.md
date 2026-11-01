# 远程采数/截图工具（跑在 desktop-9poiv0o 上）

OEM729 从 2026-10-31 起接在 **DESKTOP-9POIV0O**（Tailscale `100.120.149.8`，局域网 `192.168.5.16`），
本机（`schtitanlaptop`，`100.69.255.49`）只做计算。通道是 **SSH**，不是 RDP：

```powershell
ssh nova-desktop        # ~/.ssh/config 里的别名：niwawa@100.120.149.8，用 ~/.ssh/nova_9poiv0o
```

那台机器上：OpenSSH Server 自启、**密码登录已关闭**（只有一把公钥）、防火墙只放行 tailnet。
`C:\ProgramData\nova\status.ps1` 和 `ssh-toggle.ps1` 是原会话留下的自查/开关工具。

## 三个脚本

| 脚本 | 在哪跑 | 作用 |
|---|---|---|
| `capture-serial.ps1` | 远程 | 打开某个 COM 口，发一批 `LOG …` 命令，抓 N 秒原始字节到文件 |
| `shot-window.ps1` | 远程（需交互会话） | 用 `PrintWindow(PW_RENDERFULLCONTENT)` 抓指定进程主窗口的像素 |
| `run-in-session.ps1` | 远程 | 建一个 `LogonType Interactive` 的一次性计划任务，把某个脚本送进**已登录的桌面会话**里跑，跑完自动删 |

## b7 那一批（ITK / 事件 / 多频，2026-11-01）

| 脚本 | 作用 |
|---|---|
| `b7-flood.ps1` | 端口洪流定位：逐步发 `UNLOGALL` / `UNLOGALL USB2` / `UNLOG USB2 RANGEB` / `UNLOG USB2_29 RANGEB` / `UNLOGALL USB2_29` 并打印每步 2 s 收到的字节数 |
| `b7-probe.ps1`、`b7-probe2.ps1` | ITK 命令逐条探针：发一条、排空、把回复按命令写进同名 `.txt` 转录 |
| `b7-capture.ps1` | 正式抓包（ITK 1 Hz + RANGEB + RXSTATUSEVENTA，中途 6 次主动制造事件）|
| `b7-restore.ps1` | 把改过的 `ITWARNINGCONFIG` / `ITSPECTRALANALYSIS` 改回 b1 抓包里的原值，并用 `LOG RXCONFIGA ONCE` 读回 |
| `b7-who.ps1` | 收尾查 `LOGLISTA`：端口上还剩哪些日志、所有者是谁 |
| `b7-idle.ps1`、`b7-quiet.ps1` | 收尾测静默：某口 N 秒还流多少字节 / 清一次再看流不流 |

**两个必须知道的实测（详见 `03_分析/05_GRIT-Monitor.md` §13）**：

1. **裸 `UNLOGALL` 清不掉套件挂的日志。** 这台机器的 USB2 上有所有者是 `USB2_29` / `USB2_30` 的
   日志（`RANGEB ONTIME 0.05` 一条就 65 KB/s）。要么 `UNLOGALL USB2_29` + `UNLOGALL USB2_30`，
   要么按名 `UNLOG USB2_29 RANGEB`；只发 `UNLOGALL` / `UNLOGALL USB2` 等于没清。
2. **套件在跑时它会自己把最小 profile 挂回来**（`BESTPOSB 1 Hz`、`RXSTATUSB`、`RAWEPHEMB`、
   `HWMONITORB`/`PORTSTATSB 10 s`，约 0.2–0.4 KB/s）。清完 5 s 内又出现，那不是本仓库脚本留下的，
   收尾报「已清掉自己的」即可，别去追这条。

**为什么要 `run-in-session`**：SSH 起的进程在 session 0，没有桌面，`CopyFromScreen` 会是全黑。
而 `PrintWindow` 只要求窗口句柄存在，所以两者结合起来，**不需要有人连着 RDP** 也能截到套件窗口。

## 典型用法

```powershell
$k = "$env:USERPROFILE\.ssh\nova_9poiv0o"
$r = '逆向\tools\remote'

# 1) 抓串口（20 秒，COM8；套件占着 COM9 时用 COM8/COM10）
scp -i $k "$r\capture-serial.ps1" 'niwawa@100.120.149.8:C:/Users/niwawa/AppData/Local/Temp/capture-serial.ps1'
ssh -i $k niwawa@100.120.149.8 "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\niwawa\AppData\Local\Temp\capture-serial.ps1 -Port COM8 -Seconds 20 -Out C:\Users\niwawa\AppData\Local\Temp\nova.sbf"
scp -i $k 'niwawa@100.120.149.8:C:/Users/niwawa/AppData/Local/Temp/nova.sbf' .\nova.sbf

# 2) 截套件窗口（无需 RDP）
scp -i $k "$r\shot-window.ps1" "$r\run-in-session.ps1" 'niwawa@100.120.149.8:C:/Users/niwawa/AppData/Local/Temp/'
ssh -i $k niwawa@100.120.149.8 "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\niwawa\AppData\Local\Temp\run-in-session.ps1 -Script C:\Users\niwawa\AppData\Local\Temp\shot-window.ps1"
scp -i $k 'niwawa@100.120.149.8:C:/Users/niwawa/AppData/Local/Temp/nova-printwin.png' .\suite.png
```

## 坑（都踩过）

1. **`.ps1` 必须纯 ASCII**：Windows PowerShell 5.1 无 BOM 时按 GBK 读，中文字面量会把脚本解析炸掉。
2. **不要用 `ssh host "powershell -Command \"…\""` 传复杂命令**：层层转义必翻车（`$_`、`&`、引号）。
   一律"写文件 → scp → 按路径执行"。
3. **`Start-Process`/`New-Object` 的参数列表里别写类型转换**（`[int]$Baud` 会被当成字面量字符串）。
4. **`Register-ScheduledTask -UserId $env:USERDOMAIN\...` 在 SSH 下会报 0x80070534**，
   要用 `[Security.Principal.WindowsIdentity]::GetCurrent().Name`（形如 `DESKTOP-9POIV0O\niwawa`）。
5. **COM 口是独占的**：套件开着就占住它的口（实测占 COM9）。抓包挑空闲口，先用
   `try { $sp.Open() } catch { }` 探一下，或用 `status.ps1` 的思路。
6. 收尾要清干净：远程临时脚本/图片、以及 `nova-task` / `nova-shot` 计划任务。
