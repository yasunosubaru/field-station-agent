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
