# RPA 点击处理方案（把剩余项一次解决）

- 日期：2026-11-04
- 关联：ADR-010、`docs/operations/rpa-completion.md`
- 一句话：**不再指望"元素有语义"——按人眼看到的样子找目标（有 pointer 光标、可见、有尺寸），发真实鼠标事件点它，再用效果断言确认点中了。**

---

## 0. 起因：实测数据说明语义选择器为什么不够

同一张首页、同一个套件实例：

| 找法 | 找到的可点击目标 |
|---|---|
| `querySelectorAll('a,button,input,select,textarea,[role=button]…')` | **4 个** |
| CDP Accessibility 树（18,157 节点）里 role 属于可交互且有名 | **1 个** |
| **`cursor:pointer` + 可见 + 尺寸 ≥8px** | **48 个（35 个有名字）** |

首页那排 Manage / Playback / Convert / GRIT / Graph 卡片是 `div.application-container`，
既不是 `button` 也没有 `role`，但**人一眼就知道能点**——它有 `cursor:pointer`。
这就是"点击处理"要抓的东西。

---

## 1. 统一目标模型

```
Target {
  key      : label（优先）或 id/class + 相对序号
  label    : 元素可见文字 / aria-label / title
  rect     : 中心点 (x, y) + 宽高
  source   : pointer | role | ax | uia
  danger   : 命中危险词表？（Add/Install/Update/Apply/Delete/Remove/Quit…）
}
```

### 三个采集器（合并去重，按 rect 与 label）

| 采集器 | 规则 | 覆盖 |
|---|---|---|
| `pointer` | `getComputedStyle(el).cursor === 'pointer'` 且可见、尺寸 ≥8px | **div 卡片、图标块**（主力） |
| `role` | 标签 ∈ {a, button, input, select, textarea} 或 `role` ∈ 可交互集合 | 原生表单控件 |
| `ax` | CDP `Accessibility.getFullAXTree` 中有名字的可交互节点 | 无 DOM 的覆盖层、Canvas 内元素 |
| `uia` | PowerShell UIA 读原生窗口控件树 | 原生文件对话框、Graph 窗口 |

每个目标都带 `key`，写进 `tools/rpa_targets.json`，作为流程里 locator 的**唯一来源**
（流程不再直接写"文字"，而是写 `target:key`）。

---

## 2. 怎么点

```
scrollIntoView(center)
  → Input.dispatchMouseEvent(mouseMoved)       # 触达 hover，弹出 hover 菜单
  → 80 ms
  → Input.dispatchMouseEvent(mousePressed,  左键, clickCount=1)
  → Input.dispatchMouseEvent(mouseReleased, 左键, clickCount=1)
  → wait_for(效果断言, 超时)
```

**为什么不用 `element.click()`**：

1. 不发 `pointerdown` / `mousedown`，很多框架把逻辑挂在这两个上；
2. 不触发 `:hover`，下拉菜单永远不出现；
3. 不更新焦点与 `:active`，后续键盘输入会打错地方；
4. 对 `pointer-events` 与层叠关系完全不敏感——**点不到被遮挡的东西也不报错**。

`Input.dispatchMouseEvent` 是真实输入事件，走浏览器命中测试，点不到会体现为"效果断言失败"。

---

## 3. 效果断言（点了没反应必须报错）

点完在 `wait_for` 里等下面任意一条成立，超时即 `click_no_effect`：

| # | 断言 | 适用 |
|---|---|---|
| 1 | URL / hash 变化 | 页面跳转 |
| 2 | 指定文本出现或消失 | 弹窗、状态文字 |
| 3 | 指定 target 出现或消失 | 新面板、对话框 |
| 4 | 目标自身属性变化（`aria-selected` / class / value） | 页签、单选、下拉 |
| 5 | 目标区域截图 hash 变化 | **兜底**：其余四条都不适用时 |

第 5 条只做兜底，因为它证明"画面变了"，不证明"变对了"——流程里必须再补一条语义断言。

---

## 4. 安全：能点 ≠ 该点

| 机制 | 规则 |
|---|---|
| 危险词表 | 目标 label 命中 `Add / Install / Update / Apply / Delete / Remove / Quit / Restart / Write` → **必须先过闸门**，不允许静默点击 |
| dry-run | `--dry-run` 只 hover + 高亮 + 记录，不按下；用于校准与评审 |
| 目标来源 | 坐标只能来自目标自身的 bounding box；UIA 取的 bounds 要记审计 |
| 盲坐标 | **禁止**；除非 `screen` 后端且 UIA 提供 bounds，且该次点击在台账里标 `blind:true` |
| 幂等 | 同一次 job 内，同一 target 连续点击间隔 <300 ms 视为异常，报 `double_click_guard` |

---

## 5. 四个后端与覆盖范围

| 后端 | 用于 | 实现 |
|---|---|---|
| `cdp-pointer` | 套件渲染进程内的 div/卡片/按钮 | `Input.dispatchMouseEvent` |
| `cdp-css` | 无文字纯图标（齿轮、帮助） | `querySelector` → `DOM.getBoxModel` → 同上 |
| `uia` | 原生文件对话框、Graph 独立窗口 | PowerShell UIA：优先 InvokePattern，退化为按 bounds 点 |

**实测（2026-11-04，套件 2.11.0）**：UIA 对 `NASRunner` 只能拿到**顶层 Window 一个节点**，
Control 视图与 Raw 视图都没有子节点 → **UIA 看不到 Chromium 渲染内容**，
所以"用 UIA 点套件里的控件"不成立；它只可能对**独立的系统对话框窗口**（文件对话框、
消息框）有效，这一条尚未在本机跑通，D5 验。

**推论**：Graph 也是 Chromium 窗口，UIA 大概率同样看不到 → 第 7 条（`graph.newproject`）
先从"UIA 自动"降级，优先找它的**工程文件格式或命令行入口**，找不到就如实标 `assisted`。
| `screen` | UIA 拿不到 bounds 的最后兜底 | `SendInput` + 强制审计 |

Graph 窗口的可行性前提：启动时带 `--force-renderer-accessibility`，
否则 Chromium 不为 UIA 暴露内部控件树；带了之后 UIA 能看到向导按钮。

---

## 6. 八条流程逐条落到"点哪里、用哪个后端"

| # | 流程 | 关键点击（按顺序） | 后端 | 剩余风险 |
|---|---|---|---|---|
| 1 | suite.autoupdate | 齿轮 `#settings-banner` → `Check For Updates` | cdp-css + cdp-pointer | 低：已跑通，改成点击引擎后重验 |
| 2 | graph.export | 无 GUI 点击（Node API） | — | 低 |
| 3 | device.add | `Manage` 卡片(div) → `+ Add Device` → `Serial` → 端口/波特下拉 → **Add（闸门）** | cdp-pointer | 中：下拉是自定义控件，用效果断言 4 校验 |
| 4 | app.install | `+ Add application` → 原生对话框：文件名框输入 ZIP 路径 → `打开` → **Add（闸门）** | cdp-pointer + uia | 中：对话框控件名随系统语言变，用 UIA 自动化 ID 兜底 |
| 5 | app.update | 更新横幅(div) → `Update application` → 选应用 → **Update（闸门）** | cdp-pointer | 中：需要先造"有更新"的场景 |
| 6 | device.update | 连接设备 → `Device` 菜单 → `Update` → `Browse`（原生）→ **Apply（闸门）** | cdp-pointer + uia | 高：缺真机，菜单不出现 |
| 7 | graph.newproject | Graph 窗口：`New Project` → 字段 → `Finish` → **Plot（闸门）** | 先查 CLI/工程文件格式；UIA 大概率无效（实测看不到 Chromium 内容） | 高：独立进程，可能只能 assisted |
| 8 | device.restart | 无 GUI（命令通道 + 审批） | — | 高：缺真机 |

**结论**：第 4、7 条从"人工"变成"可点"的关键就是这套引擎——
它们的共同点是"没有语义但有位置"，正好是代价最小、最稳的那一类。

---

## 7. 十天怎么排（更新版）

| 天 | 内容 | 当天验收 |
|---|---|---|
| D1 | 目标采集器 + `targets.json` 基线（首页已实测 48 个） | 六个页面都能 dump 出可读清单 |
| D2 | 点击执行（真实鼠标事件）+ 五条断言 + dry-run | 能点开 Manage 卡片并断言页面变化 |
| D3 | 把四条已验证流程改成"点击引擎 + 目标 key" | 4 条流程跑通，日志里有 before/after |
| D4 | fixture 采集 + 回放 + lint（禁盲坐标/禁裸 sleep） | 故意改坏目标，CI 能红 |
| D5 | UIA 文件对话框（app.install） | 自动选中 ZIP 到闸门 |
| D6 | Graph 窗口 UIA 探测 | 能读到 `New Project` 控件 |
| D7 | graph.newproject 到 `Plot` 闸门 | auto 或确认只能 assisted |
| D8 | 条件等待 + 八类错误分类 | 全仓无裸 `sleep` |
| D9 | app.update 造场景 + device.* 推到硬件边界 | 5 auto / 3 blocked |
| D10 | 回归 + 状态表 + 文档 | fixture 绿、状态表可核对 |

---

## 8. 验收口径

1. 每条流程**点击成功率 ≥ 98%**，且连续 3 次全绿；
2. 每次点击都有 `target + before/after 截图 hash + 断言结果`；
3. 点击日志可回放（fixture）；
4. **0 盲坐标**（UIA bounds 除外，且台账标 `blind:true`）；
5. 危险目标 100% 停在闸门前，拒绝有审计。

---

## 9. 坐标模式（固定视口 + 命中校验）

"记住按钮位置，直接点"这个思路是对的，但**必须钉住视口**，否则坐标会随窗口大小漂移。
实测（套件 2.11.0，DPR 1.25）：

| 视口 | `#settings-banner` 的 x | `#add_device_btn` 的 x |
|---|---|---|
| 2048×1218（最大化） | 1960 | 1496 |
| 1280×800 | 1192 | 1112 |
| 1024×768 | 928 | 1112 |

- **同一视口连续两次采样：逐像素一致**（布局是确定的）；
- **换视口就变**（右对齐元素跟着右边走）；
- 有意思的是 `#add_device_btn` 在 1280 和 1024 下都是 1112——它受最小宽度约束，不是简单的右对齐。

所以坐标模式的前提是：**先钉视口，再记坐标**。

### 9.1 钉视口

不是去改用户窗口大小，而是用 CDP：

```
Emulation.setDeviceMetricsOverride(width=1280, height=800, deviceScaleFactor=1, mobile=false)
```

好处：CSS 像素坐标与**窗口大小、窗口位置、系统 DPI** 全部解耦；
点击走 `Input.dispatchMouseEvent`，坐标系就是视口 CSS 像素，不需要换算屏幕坐标。

### 9.2 记录什么

```
{ key: "#settings-banner", x: 1197, y: 16, w: 26, h: 31,
  sig: { tag: "a", text: "" } }        # 命中签名
```

### 9.3 点之前先命中校验

落下之前，先在坐标上问浏览器 `document.elementFromPoint(x, y)`：

- 标签和文字前缀与 `sig` 一致 → 点；
- 不一致 → 抛 `坐标漂移 (coord_drift)`，**绝不盲点**。

实测：把 y 不变、x 故意挪 200px，命中到 `ul`，被拦住；正确坐标则点中并把设置菜单打开
（文本 hash `10d045a6 → 14e4e540`，断言 `Check For Updates` 通过）。

### 9.4 什么时候用坐标、什么时候不用

| 用 | 不用 |
|---|---|
| 元素没有语义、`cursor:pointer` 也抓不到的覆盖层 | 打开/关闭弹窗会改变下方布局时 |
| DOM 动态但布局稳定（表格行数固定） | 顶部出现/消失横幅会把下方整体推移 |
| 需要极简定位、不想维护长选择器 | 套件升级改了布局（要靠重标定） |

重标定：`record_coords()` 重新跑一遍并 diff，和选择器校准同一天做。

### 9.5 与 UIA 的分工

UIA 是**操作系统级**的辅助功能接口（读屏软件用的那套）。它擅长原生控件
（文件对话框、标准 Win32 窗口），**看不进 Chromium 页面**——实测对套件只返回顶层窗口。
所以分工是：**页面内容用 CDP（语义/坐标/命中校验），系统对话框才用 UIA**。

---

## 10. 能不能"完全解决"？—— 精确回答

点击解决的是**一类**问题：**目标找得到、点得准**。它不是万能钥匙，剩余项分三类：

| 类别 | 流程 | 点击够不够 |
|---|---|---|
| **点击就够** | `suite.autoupdate`、`graph.export`（无 GUI）、`device.add`（到闸门） | ✅ 够 |
| **点击 + 另一种机制** | `app.install`（原生对话框要 UIA 输路径 + 点确定）、`graph.newproject`（跨进程窗口要 UIA/SendInput） | ⚠️ 需要 UIA 后端，CDP 点击够不着 |
| **与环境/硬件耦合** | `app.update`（要先有可更新的应用）、`device.update` / `device.restart`（要先插接收机） | ❌ 再会点也没用 |

另外，点击只覆盖"**点**"这一个动作。一条流程还包含：

| 动作 | 谁负责 | 备注 |
|---|---|---|
| 输入文本 | `type`（CDP `Input.insertText` / 逐键） | 已有，需补"输入后校验值" |
| 选下拉 | 自定义下拉要"点开 → 点选项"，不能用 `select` | 靠点击引擎 + 断言 4 |
| 等待 | 条件等待，不是 sleep | 见补完方案 §2.4 |
| 读值 | `read` + 语义校验 | 已有 |
| 跨进程 | UIA / SendInput | 见 §5 |

**结论**：点击把"点不到"这一类彻底解决了（实测 48 个目标 vs 语义选择器 4 个），
但"完全自动"还取决于 UIA 能否驱动原生对话框与 Graph 窗口，以及**有没有硬件**。

---

## 10. 已实现与实测（D2 提前完成）

代码：`tools/click_engine.py`（约 250 行，只依赖标准库 + `cdp_driver`）；
单测：`tests/test_click_engine.py`（10 项，纯函数，不需要套件）。

实测（套件 2.11.0，CDP 9223，首页）：

| 项 | 结果 |
|---|---|
| 可点目标 | **48 个**（语义选择器只有 4 个） |
| 点击 `div.application-container`（Manage 卡片） | 成功，坐标 (504, 290) |
| 效果断言 `text="Add Device"` | 通过；文本 hash `48a0c3e2 → 9ccb5386` |
| 点击后页面 | 进入 Manage，两个设备卡可见 |
| 危险目标 `Add Device` | **被拦截**："必须先过闸门" |
| 单测 | 10/10 通过（含"Check For Updates 不算危险"的整词匹配修正） |

踩到的一个真问题：最初用子串匹配危险词，把只读的 `Check For Updates` 判成写操作。
改成「先放行读操作白名单，再按整词匹配」。

