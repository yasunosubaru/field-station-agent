# 真机清单：八条 RPA 流程

- 日期：2026-11-04
- 依据：`docs/operations/rpa-completion.md`（状态与结论以它为准）；本文件只把它落成"插上设备后照着跑"的表格
- 一句话：代码已经推到硬件边界；设备到位后每条流程只剩「通过 / 不通过」两个答案。

---

## 0. 跑之前

| 项 | 值 |
|---|---|
| 引擎 | `http://127.0.0.1:7803`，`/api/health` 返回 `ok: true` |
| 套件 | `python tools/suite_launcher.py --launch --cdp-port 9223`；`http://127.0.0.1:9223/json/list` 里有 `index.html` 页面 |
| 驱动 | `--driver cdp`（没有驱动时 `gui` / `verify_ui` / `wait_ui` 会变成 `waiting_operator`，不会假装成功） |
| job 目录 | 默认 `workflows/jobs/`；下面示例用 `%TEMP%\fsa-w1-jobs`，换成哪个都行，**跑完别删** |
| 证据位置 | 每个 job 一个目录 `<jobs-root>/<job_id>/`：`job.json`（状态）、`audit.jsonl`（逐步流水）、`artifacts/`（截图、产物、`failure.json`、`context.json`） |

命令统一写成（Windows / PowerShell）：

```powershell
python tools/workflow_cli.py run <flow> --root . --engine http://127.0.0.1:7803 `
  --jobs-root $env:TEMP\fsa-w1-jobs --driver cdp --json
```

失败分类看 `job.json` 的 `failure.class`（八类，含义见 `src/fieldstation/workflows/errors.py`）。
**它直接告诉你该谁动**：`environment` 起环境、`input` 改参数、`selector_drift` 跑校准、
`dialog_unavailable` 看弹窗、`gate_timeout` 加时间/查为什么慢、`hardware_missing` 插设备、
`policy` 走审批、`execution` 看截图。

### 0.1 八条流程的状态（与 rpa-completion 一致）

| # | 流程 | 状态 | 为什么 |
|---|---|---|---|
| 1 | `gui.suite.autoupdate` | 已自动 | 条件等待弹窗文本；末尾 `Close` 收尾（2026-11-04 实跑 14~15 次轮询 / 4.4~4.6 s 后成功，job `gui.suite.autoupdate-20261104T155451Z-44879e`） |
| 2 | `gui.graph.export` | 已自动 | 走 `/api/graph/*`，不碰 Electron |
| 3 | `gui.device.add` | **blocked: hardware** | 前 8 步到 `approve_add` 闸门已通；"添加后设备卡出现"要真端口 |
| 4 | `gui.app.install` | assisted | "Import from your computer" 是原生 Open 对话框，CDP 点不到；主路径见 rpa-completion §5.5（文件层） |
| 5 | `gui.app.update` | assisted | 本机没有可更新的应用；更新源是 AWS，需要装一个旧版造场景 |
| 6 | `gui.device.update` | **blocked: hardware** | 到 `approve_apply` 前全部自动；刷写与"回来"要设备 |
| 7 | `gui.graph.newproject` | 已自动 | 用 `C:\Program Files\NovAtel Inc\NovAtel Application Suite\Graph\Graph.exe --remote-debugging-port=9224` 启动后 CDP 可用（注意：流程默认连 9223，跑 `plot` 前要把驱动指到 9224） |
| 8 | `script.device.restart` | **blocked: hardware** | 命令通道已通；"重启后真的回来了"要设备 |

### 0.2 还不是条件等待的三处（本轮无权改那份 YAML）

| 文件 | 步骤 | 现状 | 判断 |
|---|---|---|---|
| `workflows/gui.device.add.yaml` | `settle_home` | `kind: sleep` 2.0 s | 等首页卡片重绘，**没有可读的完成标记**；固定等待目前合理。注意套件刚启动时要 ~9 s，刚开机跑要把它调到 10 以上 |
| `workflows/gui.app.install.yaml` | `settle_home` | `kind: sleep` 2.0 s | 同上（异步枚举非核心应用，期间卡片区显示 Loading） |
| `workflows/gui.app.install.yaml` | `wait_dialog` | `kind: sleep` 5.0 s | **可以改成 `wait_ui`**：紧跟其后的 `verify_modal` 用的 `Import from your computer` 就是现成条件。留给下一次改 |

---

## 1. `gui.suite.autoupdate` —— 读「检查更新」的真实结果（只读）

状态：**已自动**。不下载、不安装、不改设置。

| 项 | 内容 |
|---|---|
| 跑什么 | `python tools/workflow_cli.py run gui.suite.autoupdate --engine http://127.0.0.1:7803 --jobs-root $env:TEMP\fsa-w1-jobs --driver cdp --json`（可选 `--param expect_version=2.11.0` 断言版本） |
| 看什么 | ① `dismiss_stale` 的 `clicked`（残留弹窗有没有被关掉）；② `ensure_closed`（弹窗真的不在了）；③ `wait_popup` 的 `polls` / `waited_s`——它是**条件等待**，弹窗没出现会停在 `gate_timeout`，不会读旧文字；④ `read_result.value` 里要有 `Current Version: x.y.z` |
| 证据存哪 | `artifacts/autoupdate-setting.json`、`artifacts/context.json`、`artifacts/gui-*-open_check.png`；`audit.jsonl` 里的 `wait_ui.matched`、`step.ok` |
| 通过判据 | `job.json` 的 `status = succeeded`；`wait_popup` 有 `polls ≥ 1` 且值匹配 `Current Version: [0-9]+(\.[0-9]+)+`；流程结束后屏上没有更新弹窗 |

---

## 2. `gui.graph.export` —— 导出 Graph 工程为 PDF

状态：**已自动**。不需要 Electron，走引擎 API。

| 项 | 内容 |
|---|---|
| 跑什么 | `python tools/workflow_cli.py run gui.graph.export --engine http://127.0.0.1:7803 --jobs-root $env:TEMP\fsa-w1-jobs --driver cdp --json`（可选 `--param project=<key>`、`--param file=<csv>`、`--param min_pages=2`） |
| 看什么 | `projects` / `files` 的 `count` ≥ 1；`pdf` 步的 `bytes`、`sha256` 与响应头 `X-PDF-Pages` / `X-PDF-Charts`；`check_pages` 有没有被跳过 |
| 证据存哪 | `artifacts/graph-report.pdf`、`artifacts/graph-export.json`、`artifacts/context.json` |
| 通过判据 | `status = succeeded`；PDF 以 `%PDF-` 开头、≥ 1000 B；`steps.pdf.headers.X-PDF-Pages ≥ min_pages`（默认 1） |

> 没有工程时它会停在 `execution` 并在消息里说"没有可导出的工程"，不是 PDF 坏了。

---

## 3. `gui.device.add` —— 新增接收机连接（**blocked: hardware**）

状态：**blocked: hardware**。添加前的一切都自动；"设备卡真的出现"要真端口。

| 项 | 内容 |
|---|---|
| 跑什么 | ① 先确认端口：`Invoke-WebRequest http://127.0.0.1:7803/api/ports`（本机实测只有 COM3~COM6 四个蓝牙串口，**不是**接收机）；② `python tools/workflow_cli.py run gui.device.add --engine http://127.0.0.1:7803 --jobs-root $env:TEMP\fsa-w1-jobs --driver cdp --param name=OEM729-Site --param port=COM8 --param baud=115200 --json`（`COM8` 是占位，换成第 ① 步里真机实际出现的端口）；③ 停在 `approve_add` 时人工核对对话框三行，再 `python tools/workflow_cli.py gate <job_id> --decision approved --by <你> --note "现场确认"` |
| 看什么 | `verify_dialog.value` 含 `New Connection`；`verify_fields.value` 里 `Port <port> Baud Rate <baud>` 真的变成了选中值（没选上时按钮还写着 `Select`）；`click_add` 有没有报错；**`verify_tile.value` 含 Connection Name**（真机这一段才会走到）；若失败，看 `failure.class`：`hardware_missing` = 端口不存在，`selector_drift` = 界面文案变了 |
| 证据存哪 | `artifacts/device-add.json`（params + 对话框正文 + Add 动作）、`artifacts/context.json`、`artifacts/gui-*-open_dialog.png` / `gui-*-click_add.png`；失败时 `artifacts/failure.json` + `failure-*.png` |
| 通过判据 | `status = succeeded`；`artifacts/device-add.json` 里 `dialog.value` 匹配端口/波特率；`context.json` 的 `steps.verify_tile.value` 含该 Connection Name；Manage 页能看到同名设备卡片 |

---

## 4. `gui.app.install` —— 从本地 ZIP 导入并添加应用（assisted）

状态：**assisted**。`Import from your computer` 打开的是原生 Open 对话框，CDP 里没有可点的页面元素。
（首选路径不是 GUI：按 rpa-completion §5.5，非核心应用解压到 `%APPDATA%\NovAtelApplicationSuite\noncoreapps\<name>\`，随包预置 + 首次启动铺文件即可，确定、可校验、可回滚。）

| 项 | 内容 |
|---|---|
| 跑什么 | `python tools/workflow_cli.py run gui.app.install --engine http://127.0.0.1:7803 --jobs-root $env:TEMP\fsa-w1-jobs --driver cdp --param package=<zip 路径> --param expect_name=<应用名> --json`；到 `import_manual` 时人工在原生对话框里选 ZIP，`resume <job_id> --decision done`；核对卡片后 `gate <job_id> --decision approved` |
| 看什么 | `digest.sha256`（装的是哪一份）；`verify_modal.value` 含 `Import from your computer`（弹窗真开着）；`verify_imported.value` 含应用名；`install` 动作成功后 `verify_installed.value` 含应用名 |
| 证据存哪 | `artifacts/app-install.json`、`artifacts/context.json`、`artifacts/gui-*-open_add.png`；原生对话框那一步没有截图，人工动作记在 `audit.jsonl` 的 `gate.resolved` |
| 通过判据 | `status = succeeded`；`app-install.json` 里的包哈希与本地文件一致；`verify_installed` 读到应用卡片；My Applications 首页出现该应用 |

> 未验证：本机没有可导入的候选 ZIP，`verify_imported` / `verify_installed` 这两段没在真实包上跑过。

---

## 5. `gui.app.update` —— 更新已安装的非核心应用（assisted）

状态：**assisted**。本机没有可用更新，整页找不到 `Update application` 节点；更新源是 AWS。

| 项 | 内容 |
|---|---|
| 跑什么 | 需要**造场景**：先装一个旧版非核心应用，让首页横幅出现 "New noncore app version available"。然后 `python tools/workflow_cli.py run gui.app.update --engine http://127.0.0.1:7803 --jobs-root $env:TEMP\fsa-w1-jobs --driver cdp --param application=<应用名> --json`；`open_popup` 处人工点开更新弹窗并 `gate --decision approved`；选中卡片后再批准 `approve_update` |
| 看什么 | `verify_popup.value` 含 `Select the application(s) to update`（本机当前就是读不到，属预期）；`update` 动作有没有命中按钮；`verify_installed.value` 里应用还在 |
| 证据存哪 | `artifacts/app-update.json`、`artifacts/context.json`、`artifacts/gui-*-open_popup.png`；失败时 `failure.json` + 截图 |
| 通过判据 | `status = succeeded`；`app-update.json` 里 `application` 与参数一致；更新后首页该应用仍在且版本符合 `expect_version`（未验证：版本号显示位置还没核实） |

---

## 6. `gui.device.update` —— 刷写固件（**blocked: hardware**）

状态：**blocked: hardware**。准备段自动到 `approve_apply` 闸门；点 `Apply` 与"回来"要设备，且刷写不可逆。

| 项 | 内容 |
|---|---|
| 跑什么 | ① 备好一份**可回滚**的固件；② `python tools/workflow_cli.py run gui.device.update --engine http://127.0.0.1:7803 --jobs-root $env:TEMP\fsa-w1-jobs --driver cdp --param firmware=<fw 路径> --param model=OEM729 --param target=COM8@115200 --json`（`COM8@115200` 换成真机实际端口）；③ `open_update` 处人工完成"连设备 → Device ▸ Update → Browse 选固件"（CDP 到不了：设备菜单动态生成、Browse 是原生对话框），然后 `gate --decision approved`；④ 核对型号/文件/哈希后，`approve_apply` 再批一次，`apply` 才真正点 |
| 看什么 | `digest.sha256`（刷的是哪一份，事后唯一凭据）；`read_version.model` 与 `params.model` 一致（`assert_model` 不符立即停——刷错机型是不可逆事故）；`confirm_file.value` 含固件文件名；`after.saw_drop` / `after.waited_s`；`check_software` 是否被跳过（没给 `expect_software` 就跳过） |
| 证据存哪 | `artifacts/update.json`（型号、固件哈希、升级前后 VERSION、Apply 动作）、`artifacts/context.json`、`artifacts/gui-*-apply.png`；失败时 `failure.json` + 截图 |
| 通过判据 | `status = succeeded`；`update.json` 的 `before.model = after.model = params.model`；`after.software` 匹配 `expect_software`（给了才判）；两次闸门都在 `audit.jsonl` 里留了 `by` / `note` |

本机现状：`/api/ports` 只有 COM3~COM6 蓝牙串口，没有接收机，所以 `ensure_live` 会以 `environment`/`input` 停下——这是**预期**，不是流程坏了。

---

## 7. `gui.graph.newproject` —— 新建 Graph 工程

状态：**已自动**（rpa-completion §1 第 7 条：用 Program Files 下的 `Graph.exe` 加 `--remote-debugging-port=9224` 启动后 CDP 直接可用，页面里含 `New Project` / `Open Project`）。

| 项 | 内容 |
|---|---|
| 跑什么 | ① 先用 `C:\Program Files\NovAtel Inc\NovAtel Application Suite\Graph\Graph.exe --remote-debugging-port=9224` 启动 Graph，确认 `http://127.0.0.1:9224/json/list` 有页面；② `$env:FSA_CDP_PORT=9224` 后 `python tools/workflow_cli.py run gui.graph.newproject --engine http://127.0.0.1:7803 --jobs-root $env:TEMP\fsa-w1-jobs --driver cdp --param source=<gps/sbf/csv> --param project_dir=<目录> --param project_name=<名字> --json` |
| 看什么 | `digest.sha256`（工程是从哪份数据建的）；`launch_graph` 的动作；`approve_plot` 闸门（写盘在 Plot 之前）；`plot` 是否真的点到 |
| 证据存哪 | `artifacts/graph-project.json`、`artifacts/context.json`、`artifacts/gui-*-launch_graph.png`；失败时 `failure.json` |
| 通过判据 | `status = succeeded`；`graph-project.json` 里 `source` 哈希与本地文件一致；Graph 里出现该工程目录与名字 |

> 已知不一致：这份 YAML 的 `summary` 仍写着"CDP 到不了 Graph，只能人工"（v2 写作时的结论），与 rpa-completion 的实测打通结论相反。以本文与 rpa-completion 为准；YAML 文案待改。
> 另：`plot` 需要驱动连到 **9224**；用默认 9223 跑会在 `plot` 停下（`selector_drift` / `capability`），这是端口不对，不是流程错。

---

## 8. `script.device.restart` —— 重启接收机并确认它回来了（**blocked: hardware**）

状态：**blocked: hardware**。命令通道已通；"重启后真的回来"要设备。

| 项 | 内容 |
|---|---|
| 跑什么 | `python tools/workflow_cli.py run script.device.restart --engine http://127.0.0.1:7803 --jobs-root $env:TEMP\fsa-w1-jobs --driver cdp --param target=COM8@115200 --param expect_model=OEM729 --json`（`COM8@115200` 换成真机实际端口）；工作流级审批出现后 `gate <job_id> --decision approved --by <你> --note "现场确认"`（RESET 会中断观测） |
| 看什么 | `ensure_live.target`（连的是哪条链路）；`baseline`/`baseline_request`（重启前型号，读不到只记 warning 不阻断）；`reset` 回执；`come_back` 的 `saw_drop`（是否真的先断开）、`waited_s`、`model` / `software`；`audit.jsonl` 里的 `receiver.reconnected` |
| 证据存哪 | `artifacts/restart.json`（target、基线、RESET 回执、回来后的 VERSION）、`artifacts/context.json`；这个流程 `failure.screenshot: false`，失败现场只有 `failure.json` |
| 通过判据 | `status = succeeded`；`restart.json` 的 `after.model = expect_model`、`after.saw_drop = true`；`after.software` 匹配 `expect_software`（给了才判）；`job.json` 的 `gates[0]` 有批准人与理由 |

> 等不到设备回来时：`come_back` 超时会停，**不会**自动重发 RESET（没有 retry）。失败类别通常是 `hardware_missing`（设备没接/没回来）或 `gate_timeout`（预算不够），两者要分开看 `failure.message`。

---

## 9. 三条 hardware 流程的一次性验完顺序

1. `script.device.restart`（只发 RESET，不改配置，最快确认链路与"回来"）；
2. `gui.device.add`（写一条连接记录；可再删，闸门在 Add 前）；
3. `gui.device.update`（最不可逆，放最后；先备好可回滚固件）。

每条跑完都留一份 job 目录；`failure.class` 与 `artifacts/failure.json` 一起看，不要只看"成功了没有"。
