# 真机抓包样例

来源：本机直连的 NovAtel **OEM729-2.03**（PSN `BMGX21030301G`，固件 `OM7MR0400RN0000` = 4.00），
通过 USB 的三路虚拟串口（`NovAtel USB Virtual Serial Port`）采集；采集时间 2026-10-30。

| 文件 | 端口 | 波特率 | 大小 | 内容 |
|---|---|---|---|---|
| `raw/com8-115200.bin` | COM8（USB1） | 115200 8N1 | 268 614 B | 297 帧：RANGE×76、BESTPOS×4、RXSTATUS×2、ASCII 文本若干 |
| `raw/com8-9600.bin` | COM8（USB1） | 9600 8N1 | 270 870 B | 120 帧、0 drop：RANGE×100、RAWEPHEM×8、BESTPOS×5、PORTSTATS×1、HWMONITOR×1 |
| `raw/com9-115200.bin` | COM9（USB2） | 115200 8N1 | 161 366 B | 与 USB1 同构的 `_29` 虚拟日志组 |

USB 虚拟串口不真正按波特率分频（两次采集的字节量几乎一样），9600/115200 都能取到同一路流，
所以这两份的差异来自**采集时刻不同**（接收机的 `ONNEW`/`ONCHANGED` 日志内容会变），不是波特率。

## 怎么复现

```powershell
# 采集（PowerShell 内置串口，无需安装任何东西）
$sp = New-Object System.IO.Ports.SerialPort 'COM8',115200,'None',8,'One'
$sp.Open(); $sp.DiscardInBuffer()
$fs = [System.IO.File]::Create('com8.bin')
$end = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $end) {
  $n = $sp.BytesToRead
  if ($n) { $b = New-Object byte[] $n; $r = $sp.Read($b,0,$n); $fs.Write($b,0,$r) } else { Start-Sleep -Milliseconds 30 }
}
$fs.Close(); $sp.Close()

# 解码（本仓库的协议层，零依赖）
node 04_重实现/packages/cli/src/offline.ts com8.bin --limit 3
```

## 状态

`LOG VERSION` 回 `OEM729-2.03 / OM7MR0400RN0000 / FINESTEERING`；`BESTPOS` 解出
`SOL_COMPUTED / SINGLE`，坐标 30.539975°N、114.352811°E、高 66.42 m，跟踪 23 颗、参与解算 12 颗
（天线接在实验室屋顶，武汉）。

这些抓包同时钉死了三条原先的未解项，见 `03_分析/00_通信协议与调度核心.md §9`：
`SENDHEX` 的真实负载必须是十六进制串、`_28`/`_29` 是套件自选的虚拟日志组、
`FILEROTATECONFIG` 的 `MaxFileSize` 单位是 MB（且不支持 OEM729）。

## Graph 工程（`graph/project/`）

用 Playwright 驱动原版 `Graph.exe`，拿上面那份 `convert/clean-9600.gps` 建出来的真实工程：

| 文件 | 内容 |
|---|---|
| `clean.gpf` | 工程文件（`PageRoute`/`DataSummary`/`fileTimeline`/`updatedProjSummary`） |
| `DataSummary.json` | `DataInfo` + `PlotSummary`（应用自己算的图表清单）+ `Messages` |
| `GOS/position.db`、`GOS/events.db` | SQLCipher 库（`aes128cbc`），密钥派生见 `06_Graph应用.md §9 U1` |

**要注意的坑**：工程目录与日志路径必须是**纯 ASCII**。同一份日志放在含中文/空格的路径下，
`File Validation` 会永远停在 0%（`graphing` 子进程无任何响应）；换到 `%TEMP%\gs` 后立刻
96%→100%。详见 `03_分析/06_Graph应用.md §9.1`。
