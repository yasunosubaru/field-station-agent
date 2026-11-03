# NovAtelReverse GUI 打包源

一个 WinForms + WebView2 外壳：启动时把嵌入的 `payload.zip` 解压到
`%LOCALAPPDATA%\NovAtelReverse\app-<version>`，用自带的 `runtime/node.exe` 启动
`逆向/04_重实现/packages/app/src/server.ts --port 0`，再把 WebView2 指向 `READY` 的端口。

产物是一个单文件 `NovAtelReverse.exe`：**不需要装 Node.js**，只需要 Windows 10/11 x64 与
WebView2 Runtime（一般随 Edge 已装）。

| 文件 | 作用 |
|---|---|
| `MainForm.cs` | 主窗口：解压 payload、拉起内置 Node、等 `READY <port>`、导航 WebView2；关窗时 `Kill(entireProcessTree)` |
| `Program.cs` | 入口：DPI 感知（`PerMonitorV2`）、单实例、`NAS_DEBUG_PORT` 调试钩子 |
| `NasGui.csproj` | 版本号（`<Version>`）、图标、单文件发布参数 |
| `app.ico` / `app-inverted.ico` | 原版图标与反相版 |

## 重新生成 payload.zip

payload 目录结构：

```
payload/
  runtime/node.exe
  逆向/04_重实现/...
  逆向/00_来源/samples/...        # 只放 .sbf/.gps/.bin 与 graph/convert/grit/raw
  逆向/01_解包/app/{view,model,assets,controller}
  逆向/01_解包/Graph/out/renderer/assets
```

把该目录压成 `payload.zip`，放到本目录，然后：

```powershell
# 版本号在 NasGui.csproj 的 <Version>，改版本会换解压目录
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true -p:DebugType=None -o ..\..\dist\NovAtelReverse
```

> `serialport` 必须打进 payload（`packages/app/node_modules/`），否则 Add Device 列不出真实串口。

## 发布流程

一次发布要动四处，缺一处就会出现「README 说 0.1.10、Release 里是 0.1.9」这种对不上的状态：

| 步骤 | 做什么 |
|---|---|
| 1 | 改 `NasGui.csproj` 的 `<Version>`，构建，记下 exe 的字节数与 SHA256 |
| 2 | 产物拷到 `dist/NovAtelReverse-<版本>-win-x64/`（`dist/` 不入库），更新该目录的说明文件 |
| 3 | 在 [`Releases`](../../../releases) 建 tag 与发布说明，附 `NovAtelReverse.exe`、说明文件与校验值 |
| 4 | 更新 [`CHANGELOG.md`](../../../CHANGELOG.md) 的版本表 |

本机网络的实测记录（下次发布不用重新排查）：`api.github.com` 与 `uploads.github.com` 在这个网络下会
被解析到不可达地址（`20.205.243.x`）；`api.github.com` 用 `curl --resolve` 钉到 `140.82.112.6`
可以直连，而**资产上传必须走本地代理**（`http://127.0.0.1:7897`），钉 IP 会返回 404。
`gh` 的 keyring token 可能报 invalid，但 git 凭据里的同一 token 可用（`repo` scope）。

## 限制

- 关闭窗口会 `Kill(entireProcessTree)` 结束内置 Node。
- 改版本会换解压目录，旧目录不会自动删除（外壳启动时会清理更早的 `app-*` 目录）。
- 固件 Update 与套件级 RPA 项不在这个壳里，原因见[覆盖边界](../../README.md#覆盖边界)。
