# RPA 补完方案（W1）

- 日期：2026-11-04
- 关联：ADR-010、`docs/spec/2026-11-04-v4-实施计划.md` W1
- 一句话：**每条流程都必须落到三种状态之一，并带证据；不允许"半自动不明不白"。**

---

## 0. "补完"的定义

| 状态 | 含义 | 证据 |
|---|---|---|
| `auto` | 无人值守跑完，只有不可逆动作前停一次闸门 | job 记录 + 每步截图 + DOM 指纹 |
| `assisted` | 自动走到一个**写清楚的**人工点，人做完后**自动接着验证** | 人工点前后的自动证据 |
| `blocked: hardware` | 代码到硬件边界为止；真机到位后按清单一次验完 | 边界前的全部证据 + 真机清单 |

现在的 8 条是：2 条 `auto`、3 条到闸门、3 条卡在环境和进程模型上。下面逐条说怎么补。

---

## 1. 八条流程怎么补

| # | 流程 | 现在 | 补完后 | 具体怎么补 |
|---|---|---|---|---|
| 1 | `gui.suite.autoupdate` | auto | auto | 加固：去掉 `sleep`，改**条件等待**（轮询弹窗文本）；选择器进 fixture |
| 2 | `gui.graph.export` | auto | auto | 同上；补失败分类（文件被占用 / 导出超时） |
| 3 | `gui.device.add` | 到闸门 | auto（到闸门）+ 添加后校验 | 前半已通；"添加后设备卡出现"要真机，标 `blocked: hardware` 到那一步 |
| 4 | `gui.app.install` | 卡在原生对话框 | **GUI 路径可自动；但优先改走文件层** | 实测：非核心应用装在 `%APPDATA%\NovAtelApplicationSuite\noncoreapps\<name>\`（Perception Viewer 已就位，含 `perceptionViewer.zip` 12 MB），目录旁有 `NonCoreAppsData.zip` 作登记表。**首选**：打包预置 + 首次启动铺文件（无需 GUI）；GUI 路径保留作通用能力 |
| 5 | `gui.app.update` | 到闸门（本机没更新） | auto（到闸门） | 需要**造场景**：装一个旧版非核心应用，才有横幅可点；场景脚本进 `examples/` |
| 6 | `gui.device.update` | 卡在 `ensure_link` | assisted + `blocked: hardware` | 代码推进到 `Apply` 闸门前；真机清单写清"插上接收机后跑什么、看什么" |
| 7 | `gui.graph.newproject` | 人工 | **✅ auto 到两个原生对话框** | 流程已按 9224 改写（17 步，逐步骤 `port`）；实测自动跑完 New Project → Next → 填 Project Name/Description，停在 `Project Folder` 的原生对话框前。`Select Folder` 与 Receiver Data 的 `Open` 仍人工（`human_gate`），其余自动。前提：Graph 必须以 `--remote-debugging-port=9224` 启动 |
| 8 | `script.device.restart` | 未验 | `blocked: hardware` | 命令通道已通；重启后"真的回来了"要真机 |

**关键判断**：第 4 条和第 7 条不是"做不到"，是"之前只试了 CDP 一条路"。原生对话框和 Graph 窗口都是 Windows 窗口，UIA 能看见——这正是仓库里 `uia_driver` 存在的理由，之前一直没让它上主战场。

---

## 2. 四件机器（补完靠它们，不靠人肉）

### 2.1 校准工具 `tools/rpa_calibrate.py`

```
python tools/rpa_calibrate.py --port 9223 --page manage --out tools/uia_selectors.json
```

- dump 页面上所有**可交互元素**：文本、role、层级、可见性、bounding box、`id`/`class`；
- 与现有选择器表比对，输出 **diff**（新增 / 消失 / 改名）；
- 人工确认后回写，流程文件里的 locator 一并更新；
- 目的：套件升级后改映射从"翻页面猜"变成"跑一次看 diff"。

### 2.2 Fixture 回放（没有套件也能测）

- `tools/rpa_fixture.py --capture <job>` 把每一步的 DOM（去动态值）+ 元素快照存进 `tests/fixtures/rpa/<flow>/`；
- `tests/test_rpa_fixture.py` 用无头浏览器回放定位逻辑：**只要选择器还能在该 DOM 上命中，就算过**；
- CI 门禁：8 条流程 fixture 全绿，否则不许合；
- 价值：选择器被人改坏、或套件升级换文案，**不用装套件就能发现**。

### 2.3 UIA 通道（之前没用起来的那条）

- 原生文件对话框（Open/Save）：UIA 定位编辑框 → 输入 → 回车；
- Graph 窗口：`--force-renderer-accessibility` + UIA 读 Chromium 可访问性树；
- 与 CDP 统一成一套"定位器"语义：`cdp:文字` / `css:选择器` / `uia:名字/自动化 ID`；
- 失败必须报 `selector_drift` 或 `dialog_unavailable`，不许静默重试到超时。

### 2.4 条件等待 + 失败分类

- 删掉所有 `sleep N`，改成 `wait_for(条件, 超时)`（文本出现 / 元素可点 / 文件生成 / 进程退出）；
- 失败分类扩到八类：`environment` / `input` / `execution` / `policy` / `selector_drift` / `dialog_unavailable` / `gate_timeout` / `hardware_missing`；
- 每类都要能回答"下一步该谁动"：换环境、改参数、修选择器、叫人批、插设备。

---

## 3. 十天怎么拆

| 天 | 做什么 | 当天能验的 |
|---|---|---|
| D1 | 起套件，dump 六个页面的可交互元素，落基线 | 元素清单能被人读懂 |
| D2 | 校准工具 + diff + 回写；8 条流程跑一遍校准 | 选择器与真实界面对齐 |
| D3 | fixture 采集（每步 DOM + 元素 + 版本指纹） | 8 条流程都有 fixture |
| D4 | fixture 回放测试 + CI 门禁 + lint（禁坐标 / 禁盲等） | 故意改坏一个选择器，CI 能红 |
| D5 | UIA 驱动原生文件对话框（`app.install`） | 能自动选中 ZIP 并回到闸门 |
| D6 | Graph 窗口 UIA：启动带 accessibility、读控件树 | 能读到 `New Project` 向导的控件 |
| D7 | `graph.newproject` 走 UIA 到 `Plot` 闸门 | 第 7 条从人工变 auto 或确认只能 assisted |
| D8 | 条件等待重构 + 八类错误分类 | 8 条流程不再有裸 `sleep` |
| D9 | `app.update` 造场景（装旧版） + `device.*` 推到硬件边界 | 5 条 auto / 3 条 blocked |
| D10 | 全量回归 + 文档 + 状态表进 README | fixture 绿、状态表可核对 |

---

## 4. 怎么算过

1. `workflow_cli validate` 8/8；
2. fixture 回放 8/8（无套件环境）；
3. `rpa_lint` 0 违规（无坐标、无裸 sleep、无未登记选择器）；
4. 每条流程有明确状态：`auto` / `assisted` / `blocked: hardware`，并写进 README 状态表；
5. 每条 `blocked` 都有一份"插上真机后怎么验"的清单（跑什么、看什么、证据存哪）。

---

## 5. 补不了的部分（如实写）

| 项 | 为什么 | 什么时候能验 |
|---|---|---|
| `device.add` 添加后设备卡 | 接收机已有，但当前不在手边 | 设备到位当场 |
| `device.update` 刷写固件 | 同上；且刷写不可逆，必须留闸门 | 设备到位 + 一份可回滚固件 |
| `device.restart` 重启后回来 | 同上 | 设备到位 |

**代码不等硬件**：这三条的点击路径、闸门、截图、失败分类现在就能写完并验到硬件边界；
设备到位后按清单一次跑完即可。若同时需要"没有设备也能回归"，再补一个本地 TCP 假接收机
（`tools/fake_receiver.py`，零驱动、零管理员权限），但它只是回归手段，不替代真机验收。
| `app.update` 的后半段 | 本机没有可更新的应用 | 装一个旧版非核心应用 |
| Graph 的 CDP | 它的 argv 被改写，调试端口传不进去 | 不再依赖；改走 UIA |

**这四条不是"没做完"，是"边界在这里"。** 把它们写清楚，比假装全自动诚实，也比留一堆"跑到一半"强。

---

## 5.5 可选应用：优先文件层，不走 GUI

实测套件的非核心应用是**解压到用户目录**，不是系统安装：

```
%APPDATA%\NovAtelApplicationSuite\noncoreapps\
├─ NonCoreAppsData.zip + NonCoreAppsData\   ← 登记表（2 KB）
└─ perceptionViewer\                        ← 已安装的应用
   ├─ perceptionViewer.zip（12 MB，原始包）
   ├─ view\ · node_modules\ · package.json
   └─ perceptionViewer_prerequisites.json
```

所以"自带 Perception Viewer"根本不需要 RPA：**打包时放进 payload，首次启动复制到该目录并合并登记表**即可，确定、可校验、可回滚。

`gui.app.install` 因此降级为**通用能力**（用户自己拿到别的 ZIP 时才用），不再是我们的必经路径。
GUI 路径的自动方案仍然保留（UIA 定位对话框 + 剪贴板填路径），但不再是主路径。

> 许可提醒：把厂商的可选应用一起打包，与打包套件本身是同一类再分发问题，仍按"仅随包演示"处理。

## 5.6 四条流程已切到点击引擎（2026-11-04 实测）

| 流程 | 改了什么 | 结果 |
|---|---|---|
| `gui.suite.autoupdate` | `Check For Updates` 改 `target:`；末尾加 `Close` 收尾 | **succeeded**（7 步），弹窗关掉后不再挡住后续流程 |
| `gui.device.add` | 首页→Manage 用 `#sm-welcome`、`+ Add Device` 用 `#add_device_btn`、`Serial` 用 `target:` | 到 `approve_add` 闸门；**rejected → cancelled**，未新增连接 |
| `gui.app.update` | 更新按钮改 `target:Update` | 到闸门（本机无可用更新）；rejected |
| `gui.graph.export` | 走 API，未改 | **succeeded** |

踩到的三个坑（都写进流程注释）：

1. **上一条流程没关弹窗会挡住下一条**：更新弹窗还在时，点 Manage 卡片会落在遮罩上。现在 autoupdate 末尾强制 `Close`。
2. **只收 `cursor:pointer` 会漏按钮**：`#add_device_btn` 是原生 `button`，光标是 `default`。采集器改成"pointer **或** 语义可交互"。
3. **`li` 不能一律跳过**：`Type` 的 Serial/Network/USB 是 `<li>`，之前被过滤掉。

新增两个定位语法：`#id`（按 id 精确匹配）、`label@2`（同名元素取第 2 个）。
危险词默认拦截；要点"只是打开对话框"的按钮时写 `target!:`，可被 lint 检出。

## 5.7 四条并行线（2026-11-04 完成）

| 线 | 交付 | 验收 |
|---|---|---|
| fixture 回放 | `tools/rpa_fixture.py` + `tests/fixtures/rpa/**`（4 页 / 16 条 locator） | 回放不加载 `cdp_driver`；改名/多义能报错并 exit 1 |
| 校准工具 | `tools/rpa_calibrate.py` + `tools/rpa_targets.json`（3 页基线） | `--diff` 无变化 exit 0；注入一条不存在目标 → 报"消失" exit 1 |
| 条件等待 | `wait_ui`（轮询读值，默认 200 ms / 10 s）+ `click_optional` | autoupdate 的 6 秒死等已替换；残留弹窗场景也能正确重查 |
| 错误分类 | `src/fieldstation/workflows/errors.py` 八类 + 27 项单测 | 分类落到 `job.json` 的 `failure.class` |
| 真机清单 | `docs/operations/rpa-checklist.md` | 三条 `blocked: hardware` 各写跑什么/看什么/证据 |

集成后实跑：`gui.suite.autoupdate` → **succeeded**（9 步）；全仓 949 项 OK、selftest 5/5。

## 6. 开工前置
| 需要 | 用途 | 谁提供 |
|---|---|---|
| 原版套件可启动（`NASRunner.exe`） | D1 的 dump 与全程验证 | 仓库已带便携副本，我直接起 |
| 一个可安装的 ZIP 应用 | `app.install` 走完 | 需要一个样本，或我用现有测试包 |
| 一个旧版非核心应用 | `app.update` 造场景 | 同上 |
| 一台接收机 | 三条 hardware 流程收尾 | 只能等设备 |
