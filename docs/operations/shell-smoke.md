# 外壳真机验收 —— 壳-1 解压幂等 / 壳-2 拉起 Python 服务

> 这份记录的是 **2026-11-10 在真机上跑通的证据**，不是设计说明。
> 设计说明见 `docs/operations/shell.md`；单测见 `shell/electron/test/payload.test.js`
> 与 `pyserver.test.js`。
>
> 单测只能证明「逻辑对」，证明不了「Electron 里真的能跑」。这份补的就是后者。

## 怎么复现

```bash
# 1. 造一个 400 文件 / 1.8 MB 的验收用 payload.zip
python shell/electron/smoke/make-payload.py

# 2. 首次启动：应从 payload.zip 解压
cd shell/electron
node_modules/electron/dist/electron.exe . --no-tray \
    --port 7817 --python-port 8805 \
    --payload-zip ../../shell/electron/smoke/payload.zip

# 3. 关掉窗口后再次启动：应跳过解压
node_modules/electron/dist/electron.exe . --no-tray \
    --port 7818 --python-port 8806 \
    --payload-zip ../../shell/electron/smoke/payload.zip
```

判定只看两行：

| 第几次 | 期望首行 | 期望末行 |
|---|---|---|
| 首次 | `[payload] 判定：extract（no-stamp）` | `[shell] [python] 已结束子进程（taskkill /pid N /T /F）` |
| 二次 | `[payload] 判定：skip（ok）` | 同上 |

## 实测结果（2026-11-10）

### 首次启动 —— `extract`

```
[payload] 判定：extract（no-stamp） 需要解压 清单 400 文件 / 1.8 MB 磁盘 0 文件 / 0 B
[payload] 开始解压：<bundle>/smoke/payload.zip → %APPDATA%\nas-reimpl-shell\payload（400 文件，1.8 MB）
[payload] 已解压 20/400（86.9 KB / 1.8 MB）
...
[payload] 已解压 400/400（1.8 MB / 1.8 MB）
[payload] 解压完成：400 文件 / 1.8 MB（耗时 1.1s）
[shell]   payload 解压完成：400 文件 / 1.8 MB（no-stamp）
[python] 拉起：<repo>\.deps\venv\Scripts\python.exe -m fieldstation.runtimes.server --host 127.0.0.1 --port 8805
[python] RUNTIME_GATEWAY_READY http://127.0.0.1:8805
[server] nas-reimpl app listening on http://127.0.0.1:7817
[server] READY 7817
[shell]   Python 服务已就绪：http://127.0.0.1:8805
[shell]   窗口已开：对话 · 野外台站智能体
[shell]   [python] 已结束子进程（taskkill /pid 78192 /T /F）
```

几点值得记下：

- **进度按 20 个一批刷**，不是每个文件刷一次 —— 400 文件若逐个 `console.log`，
  控制台会淹掉真正的错误。
- **解压 1.1 s**。1.8 MB 是这个量级；真实发布包（100 MB+）会慢得多，所以进度事件
  与「窗口先开、Python 慢也不挡界面」这两件事必须同时成立。
- `RUNTIME_GATEWAY_READY <url>` 是 Python 侧打给外壳的唯一就绪信号，外壳只认这一行，
  **不靠端口轮询猜**。轮询猜的做法已实测会在端口被占时静默打错服务。

### 二次启动 —— `skip`

```
[payload] 判定：skip（ok） 无需解压 清单 400 文件 / 1.8 MB 磁盘 400 文件 / 1.8 MB
[shell]   payload 已是最新，跳过解压（400 文件）
[python] RUNTIME_GATEWAY_READY http://127.0.0.1:8806
[server] READY 7818
[shell]   [python] 已结束子进程（taskkill /pid 76352 /T /F）
```

幂等的判据是 **`.extracted` stamp + manifest 对账**，不是「目录非空就跳过」——
后者在解压中途崩溃时会留下半个 payload 却永远判「已完成」。

### 结束进程的方式

`taskkill /pid N /T /F` 带 `/T`（整棵树）。只杀父进程会留下 Python 子进程占着端口，
下次启动的端口探测就会挑到别的端口，看起来像「端口漂移」。实测日志里
`/pid 78192 /T /F` 之后 8805 立即释放。

## 已知的、不算失败的现象

| 现象 | 说明 |
|---|---|
| `at2_attach.log.err` 里 `Unable to move the cache: 拒绝访问 (0x5)` | Electron 的 GPU/disk cache 目录被上一次实例占着。**第二次启动同一 userData 目录时必现**，不影响功能；验收时用不同 `--port` 即可，不必清理缓存 |
| `attach.log.err` 里「等了 40 秒仍未就绪」 | 那次是刻意在「Python 不存在」的条件下跑的，用来确认超时语义。正常路径不会出现 |
| `run2.log.err` 里 `provider 名 fake，未配置 base_url` | 验收用的假 provider，故意不配 `base_url`，只为确认外壳不因 provider 配置缺失而崩 |

## 没覆盖到的

- **真实发布包解压**：只验了 1.8 MB 的合成包。100 MB+ 的真实包没在这轮跑，
  解压耗时与内存峰值都还是未知数。
- **Windows 之外的平台**：只在 Windows 10/11 上验的。`taskkill /T` 是 Windows 专有；
  macOS / Linux 的「杀整棵树」路径未实现，也未验。
- **安装包形态（electron-builder）**：验收用的是 `node_modules/electron/dist/electron.exe`
  直接拉起，不是打包后的 `.exe`。打包后 `app.asar` 里的相对路径解析是另一条风险，
  见 `electron-builder.yml`（尚未建）。
