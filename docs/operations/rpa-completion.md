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
| 4 | `gui.app.install` | 卡在原生对话框 | **auto（到闸门）** | 用 **UIA 驱动原生 Open 对话框**：从 `NASRunner` 的窗口子树里找到对话框 → 文件名编辑框输入路径 → 点"打开"。**机制已实测**（可控 OpenFileDialog 能被 UIA 读到并操作），剩接线 |
| 5 | `gui.app.update` | 到闸门（本机没更新） | auto（到闸门） | 需要**造场景**：装一个旧版非核心应用，才有横幅可点；场景脚本进 `examples/` |
| 6 | `gui.device.update` | 卡在 `ensure_link` | assisted + `blocked: hardware` | 代码推进到 `Apply` 闸门前；真机清单写清"插上接收机后跑什么、看什么" |
| 7 | `gui.graph.newproject` | 人工 | **✅ auto（实测打通）** | 套件启动的是 `C:\Program Files\NovAtel Inc\NovAtel Application Suite\Graph\Graph.exe`（不是 payload 副本）。用该 exe 加 `--remote-debugging-port=9224` 启动，CDP 直接可用（1 个页面）；点击引擎在其页面找到 14 个目标，含 `New Project` / `Open Project`。**注意**：payload 自带的那份 Graph 缺 `jszip`，直接启动会崩，不能用来做自动化 |
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

## 6. 开工前置

| 需要 | 用途 | 谁提供 |
|---|---|---|
| 原版套件可启动（`NASRunner.exe`） | D1 的 dump 与全程验证 | 仓库已带便携副本，我直接起 |
| 一个可安装的 ZIP 应用 | `app.install` 走完 | 需要一个样本，或我用现有测试包 |
| 一个旧版非核心应用 | `app.update` 造场景 | 同上 |
| 一台接收机 | 三条 hardware 流程收尾 | 只能等设备 |
