# `tools/idd` —— 随包分发的 IDD（Indirect Display Driver）驱动

## 这是什么

一块**由我们自己控制**的虚拟显示屏的驱动源码。计划书 §3.3 的第一层（几何固化）
需要一块「分辨率由我们定、不随硬件变」的绘制目标；本机上现有的两块虚拟屏
（向日葵 `OrayIddDriver`、网易 `GameViewerIddDriver`）都依赖各自厂商的客户端去挂接，
不能自包含交付，所以这一层必须自带驱动。

## 来源与许可

| 项 | 值 |
|---|---|
| 上游 | <https://github.com/microsoft/Windows-driver-samples> |
| 路径 | `video/IndirectDisplay` |
| 许可 | MIT（微软官方样例，见上游 `LICENSE`） |
| 取用方式 | `git clone --depth 1 --filter=blob:none --sparse` + `git sparse-checkout set video/IndirectDisplay` |
| 拉取时间 | 2026-11-16 |
| 修改情况 | **尚未修改**（见下方「待改造」） |

## 为什么是它

Windows 的显示栈里，一个虚拟屏要能被 `EnumDisplaySettings` / `ChangeDisplaySettingsEx`
看见，驱动必须做两件事：

1. **上报一个 monitor**（`IddCxMonitorCreate` + `IddCxMonitorArrival`）；
2. **报告它支持的 monitor mode 列表**（`IDDCX_MONITOR_MODE`）。

本机实测的三块间接显示驱动，前一步都没做：

| 驱动 | 设备实例 | 状态 | `EnumDisplaySettings` 模式数 |
|---|---|---|---|
| `OrayIddDriver` | `ROOT\DISPLAY\0000` | OK | 0 |
| `GameViewerIddDriver` | `ROOT\DISPLAY\0001` | OK | 0 |
| `RdpIdd`（微软） | `SWD\REMOTEDISPLAYENUM\..._0001` | Code 45 幽灵 | — |

设备实例是好的、驱动文件也在 `System32\drivers\UMDF\`，但它们**不主动上报显示器**，
要等各自厂商的客户端触发。我们自己带驱动，就能让「上报」发生在启动时、无条件。

## 上游样例的可直接复用部分

| 需要的能力 | 样例里的位置 | 是否已满足 |
|---|---|---|
| 根枚举设备（不依赖硬件） | `IddSampleDriver.inf`：`Root\IddSampleDriver` | 满足 |
| 上报 monitor | `Driver.cpp` 的 `IndirectDeviceContext::FinishInit` → `IddCxMonitorCreate` + `IddCxMonitorArrival` | 满足 |
| 默认模式 `1920×1080@60` | `s_SampleDefaultModes[]` 第一项就是 `{1920, 1080, 60}` | **正好对上** |
| 多个 monitor | `IDD_SAMPLE_MONITOR_COUNT = 3` | 满足（我们只要 1 块，需调小） |
| EDID 支持 | 有（Dell S2719DGF / Lenovo Y27fA 的修改版） | 满足 |

## 待改造（进打包前必须做）

| 项 | 为什么 | 改动点 |
|---|---|---|
| monitor 数量 3 → 1 | 多出来的两块屏会让坐标基准有歧义 | `Driver.cpp`：`IDD_SAMPLE_MONITOR_COUNT` |
| 设备名改成自己的 | 与厂商驱动区分，卸载时不会误伤 | `IddSampleDriver.inf`：`DeviceName` / `Root\IddSampleDriver` |
| 模式列表只留需要的 | 只留 `1920×1080@60`（可加 30/120），避免布局基准有多个候选 | `Driver.cpp`：`s_SampleDefaultModes` |
| INF 里的 `TODO: edit hw-id` | 上游明确说这个 hw-id 是给 VS 远程调试用的 | `IddSampleDriver.inf` |
| 签名 | 上游是源码，产物必须自签或买签名 | 见下 |

## 构建与签名（诚实账）

| 步骤 | 本机状态 | 说明 |
|---|---|---|
| Visual Studio | **已具备**（`C:\Program Files\Microsoft Visual Studio\18`） | `cl.exe` 不在 PATH，需走 Developer Command Prompt 或 `vcvarsall` |
| WDK | **已具备**（`10.0.22621.0` / `10.0.26100.0`） | `IddCx.h` 在 `Include\10.0.26100.0\um\iddcx\{1.0,1.2,1.10}` |
| 安全启动 | **已关闭**（`UEFISecureBootEnabled = 0`，实测） | 自签驱动可以装载；**别的机器上不一定** |
| 管理员权限 | 装驱动必须提权 | `install-idd.ps1` 会自己申请 UAC |

### 两个曾经卡死整个流程的坑（2026-11-16 实测，务必先看）

**一、`UmdfLibraryVersion` 必须是 `2.23`。**

写 `2.15` / `2.25` / `2.35` 时设备一律报 `[Error]`、PnP 问题码 `0x1F`、
状态 `0xC0000001`，且**事件日志里没有任何原因**。真正的答案写在
`C:\Windows\inf\setupapi.dev.log`：

```
!  inf:  Using WDF schema version 2.23 when section requires version 2.25.
         Section = [MyDevice_Install.NT.Wdf]
!!! dvi:  Device not started: Device has problem: 0x1f (CM_PROB_FAILED_ADD)
```

改成 `2.23` 后设备立刻变成 `[OK]`。`stampinf -u` 参数要**三段式**（`2.23.0`），
`2.23` 和 `2.23.0.0` 都会报 `Error parsing UMDF version string`。

**二、`pnputil /add-driver` 不会覆盖已存在的同名文件。**

它会打印"已成功添加驱动程序包"，但 `FILE_QUEUE_COMMIT` 阶段写的是
`Existing file ... remains unchanged`，`C:\Windows\System32\drivers\UMDF\` 里
留着的是**第一次**装进去的那份。后果是：改了代码、重装、重测，跑的还是旧二进制，
每次修复都"无效"。实测差异 50 分钟 / 两个不同哈希。

因此安装前必须**先 `/delete-driver` 删干净**，装完必须**比对哈希**。
`install-idd.ps1` 两件事都做了。

### 这条路的硬约束

`IddSampleDriver.sys` 是**源码**，不是签好名的二进制。要交付自包含安装包，必须：

1. 在构建机编译；
2. 用证书签名（测试证书 + 目标机开启测试签名，或商业证书）；
3. 用户首次启动时提权 `pnputil /add-driver ... /install`。

**「双击就能用」做不到** —— 任何 IDD 驱动都绕不过一次管理员授权。

### 已验证通过的判定标准

```
device : IddSampleDriver Device [OK] ROOT\DISPLAY\000N        <- 必须是 OK，不是 Error
\\.\DISPLAY15x  IddSampleDriver Device  virtual               <- 必须出现在 -List 里
EnumDisplaySettings 每条只返回 1 个模式: 1920x1080@60          <- 唯一坐标基准
```

第三条是改造目标（上游样例给 10 个模式），实测已达成。

## 不进 payload

这个目录是**构建期源码**，不进运行时 payload（`build_payload.py` 不收）。
运行时只需要编译好的 `.sys` + `.inf` + 证书，那些放在
`payload/drivers/idd/`（尚未建立）。

## 怎么用

```powershell
# 1. 编译（需要 WDK + VS 的驱动开发组件）
msbuild tools\idd\IddSampleDriver.sln /p:Configuration=Release /p:Platform=x64

# 2. 签名（需要证书，见上）
# 3. 安装
pnputil /add-driver tools\idd\IddSampleDriver\Release\IddSampleDriver.inf /install

# 4. 验证：应当能看到一块新显示器，且能枚举到 1920x1080@60
powershell -NoProfile -ExecutionPolicy Bypass -File tools\setup_display.ps1 -List
```
