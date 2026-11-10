# `shell/electron/smoke/` —— 外壳真机验收

这里的文件**不是产品代码**，是「在真机上把外壳跑起来看一眼」的一次性验证件。
它们留在仓库里有两个理由：

1. 单测（`../test/*.test.js`）证明不了 Electron 真的能拉起 Python 服务、真的能解压；
2. 下次动了 `payload.js` / `pyserver.js`，得有东西能重跑一遍再确认。

## 文件

| 文件 | 作用 |
|---|---|
| `make-payload.py` | 造一个 400 文件 / 约 1.8 MB 的 `payload.zip`，内容按序号确定（可复现） |
| `verify-shell1.ps1` | 壳-1 验收：首次启动应 `extract`、二次应 `skip`；自动判结果并打摘要 |
| `payload.zip` | `make-payload.py` 的产物。**可随时重造，不必依赖它存在** |

验收步骤与实测结论写在 `docs/operations/shell-smoke.md`。

## 注意

- `verify-shell1.ps1` 必须保持**纯 ASCII**：PowerShell 5.1 把无 BOM 的 `.ps1`
  按 ANSI 读，中文字面量会把引号配对打破，报 `TerminatorExpectedAtEndOfString`。
- 脚本会把你 `%APPDATA%\nas-reimpl-shell\payload` **移入回收站**（不是直接删），
  为的是测「首次解压」。跑之前确认那里面没有你要留的东西。
- 两次启动用不同 `--port`：同一个 userData 目录连开两次，Electron 的 GPU/disk cache
  会报 `Unable to move the cache: 拒绝访问 (0x5)`。这是已知现象，不影响功能。
