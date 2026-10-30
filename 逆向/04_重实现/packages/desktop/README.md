# packages/desktop —— 野外台站智能体桌面壳

两套入口，互不冲突：

| 入口 | 需要什么 | 现在能用吗 |
|---|---|---|
| `Start-FieldStation.cmd` | 一个 Node ≥ 22.6 | **能**。双击 → 起服务 → 开默认浏览器 |
| `Start-FieldStation-GUI.cmd` | 上面这些 + 任意一份 Electron 运行时 | **能**。本机用 DaVinci Resolve 自带的 Electron 8.0.1 |

两者都只是薄壳：它们启动的是 `packages/app/src/server.ts`，不 import、不修改 `packages/app/**`。

```
Start-FieldStation.cmd          双击入口（纯批处理，只负责找 node 并转发参数）
Start-FieldStation-GUI.cmd      双击入口（同一件事，但用 Electron 窗口而不是浏览器标签）
src/
  launcher.ts                   全部逻辑：单实例复用、端口顺延、子进程、日志、优雅退出
  cli.ts                        批处理转发的目标，接 Ctrl+C / 关窗口
test/
  launcher.test.ts              node:test，6 项（真起服务、真杀进程、真连端口）
electron/                       独立的 Electron app 目录（自己的 package.json）
  package.json                  main: main.cjs
  main.cjs                      spawn 服务端 → 轮询端口 → BrowserWindow
  preload.cjs                   contextBridge，只暴露只读信息与显式 quit
  README.md                     运行时探测顺序、Electron 8 兼容性、联网后怎么升级
```

## 现在就能跑

```powershell
# 浏览器版
.\Start-FieldStation.cmd                 # 也可以在资源管理器里双击
.\Start-FieldStation.cmd -NoBrowser      # 只起服务
.\Start-FieldStation.cmd -Port 7790

# Electron 版
.\Start-FieldStation-GUI.cmd

# 测试
node --test --test-force-exit "test/*.test.ts"
```

日志：`%LOCALAPPDATA%\FieldStation\launcher.log`（浏览器版）、
`%LOCALAPPDATA%\FieldStation\electron.log`（Electron 版）。两者都只保留最近 200 KB。

退出：关掉控制台窗口，或按 Ctrl+C；两种都会先杀掉自己起的 node 子进程，端口随后释放。

详细规则（端口、单实例、日志截断、Electron 切换步骤、Chromium 80 兼容性实测）见
`逆向/03_分析/12_桌面启动器.md`。
