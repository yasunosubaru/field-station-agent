# NovAtelReverse GUI 打包源

这是一个 WinForms + WebView2 外壳：启动时把嵌入的 `payload.zip` 解压到
`%LOCALAPPDATA%\NovAtelReverse\app-<version>`，用自带的 `runtime/node.exe` 启动
`逆向/04_重实现/packages/app/src/server.ts --port 0`，再把 WebView2 指向 `READY` 的端口。

## 重新生成 payload.zip

payload 目录结构：

```
payload/
  runtime/node.exe
  逆向/04_重实现/...
  逆向/00_来源/samples/...        # 只放 .sbf/.gps/.bin 与 graph/convert/grit/raw，golden 不必带
  逆向/01_解包/app/{view,model,assets,controller}
  逆向/01_解包/Graph/out/renderer/assets
```

把该目录压成 `payload.zip`，放到本目录，然后：

```
dotnet publish -c Release -r win-x64 --self-contained true ^
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true ^
  -p:EnableCompressionInSingleFile=true -p:DebugType=None -o ..\..\dist\NovAtelReverse
```

产物是一个 `NovAtelReverse.exe`（约 130 MB），不需要安装 Node.js；系统需要 WebView2 Runtime
（Windows 10/11 一般自带）。

## 限制

- 关闭窗口会 `Kill(entireProcessTree)` 结束内置 Node。
- 版本号在 `NasGui.csproj` 的 `<Version>`；改版本会换解压目录，旧目录不会自动删除。
- 固件 Update / 套件级 RPA 项不在这个壳里。
