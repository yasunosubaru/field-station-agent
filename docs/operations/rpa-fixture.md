# RPA 目标 fixture（没装套件也能核对 locator）

- 日期：2026-11-04
- 工具：`tools/rpa_fixture.py`、单测 `tests/test_rpa_fixture.py`、数据 `tests/fixtures/rpa/`
- 一句话：**把"当时页面上有哪些可点目标"存成 JSON；回放时只跑 `click_engine.pick()`，不连 CDP。**

---

## 0. 它证明什么、不证明什么

| 证明 | 不证明 |
|---|---|
| `#id` / `label` / `label@2` 这些 locator 还能在**采集时的那份目标列表**里唯一命中 | 页面 DOM 还长这样（改版必须重新采） |
| 流程 YAML 里写的 `target:` key 没过期、没被同名目标弄成二义 | 点下去真有反应（那要 `ClickEngine.click` 的效果断言） |
| 仓库提交的 fixture 没被谁顺手改坏（单测每次重放一遍） | 目标还可见、还没被遮挡（fixture 只记录当时可见的） |

采集只收 `cursor:pointer` + 语义可交互 + 可见 + 尺寸 ≥8px 的元素（`click_engine.collect`）。
所以"定位解析"能离线验，"DOM 提取/点击效果"仍然要真机。

---

## 1. fixture 长什么样

```
tests/fixtures/rpa/<page>/
  targets.json    # collect() 的原始结果：idx/tag/id/cls/label/w/h
  locators.json   # 这一页流程会用到的 key：{"page": "...", "locators": [...]}
  meta.json       # url（用户名已替换成 <user>）、viewport、采集时间、套件版本、目标数
  page.html       # 可选（--html），本地排查用；≤2 MB，默认不入库
```

当前四页：

| page | 状态 | 目标数 | locator 数 |
|---|---|---|---|
| `home` | My Applications 首页 | 48 | 4 |
| `manage` | Manage 设备页 | 50 | 4 |
| `device-dialog` | New Connection 对话框（Type 已选 Serial） | 71 | 5 |
| `update-popup` | Check For Updates 弹窗 | 50 | 3 |

`locators.json` 里的 key 只用结构性文字/`#id`，**不写日期、计数、版本号**——
首页那排卡片带 "0 Active Connections"、回放列表带 "Last Viewed 03 Nov 2026"，
这些会变，进 locator 就会让回放天天红。

`update-popup` 这一页是叠在首页上的小窗：弹窗本身只多出 2 个可点目标（`Close`
和右上角的 X），流程在这一页只会点 `Close`；另外两条 `#settings-banner`
（打开弹窗的齿轮）和 `#sm-welcome`（关掉弹窗后回 Manage 的入口）也登记，
是为了确认弹窗出现后首页锚点仍然命得中——它们和 `Close` 一样属于"这一页上看得到、
流程里会用到"的 key。

---

## 2. 采集 / 登记

```powershell
# 首页
python tools/rpa_fixture.py --goto home --capture home `
  --capture-locators home --locator "#sm-welcome" --locator "Add application" `
  --locator "Playback" --locator "#settings-banner"

# Manage 设备页
python tools/rpa_fixture.py --goto manage --capture manage `
  --capture-locators manage --locator "#add_device_btn" --locator "Add Device" `
  --locator "Manage" --locator "Help"

# New Connection 对话框（只切到 Type=Serial，不点 Add）
python tools/rpa_fixture.py --goto device-dialog --capture device-dialog `
  --capture-locators device-dialog --locator "#connection-name" --locator "Serial" `
  --locator "Select@1" --locator "Cancel" --locator "Add"

# 检查更新弹窗（会联网查一次，只读；采完关掉）
python tools/rpa_fixture.py --goto update-popup --capture update-popup `
  --capture-locators update-popup --locator "Close" --locator "#settings-banner" `
  --locator "#sm-welcome"

# 收尾：关掉残留弹窗 + 回首页
python tools/rpa_fixture.py --restore-home
```

`--goto` 的动作与手工步骤一致：

| 状态 | 动作 |
|---|---|
| `home` | 点 `a.homemenu-title`（左上标题，纯图标 0×0，只能 `el.click()`） |
| `manage` | 回首页 → 点 `#sm-welcome` |
| `device-dialog` | 回首页 → `#sm-welcome` → `#add_device_btn` → `Serial` |
| `update-popup` | 回首页 → `#settings-banner` → `Check For Updates`（等正文出现 `Current Version`） |

首页卡片是异步绑定点击的（刚启动约 9 秒才稳），`--goto` 每一步都验一句页面文字，
没到就补点一次再报错——不会"点空了还继续采"。

`--capture-locators` 会先在当前页把每条 locator 过一遍 `pick()`，全中才写盘；
这样不会把一条本来就不存在的 key 记进 fixture。`--html` 是排障开关，
`page.html` 含本机路径，**不要提交**。

---

## 3. 回放（不需要套件）

```powershell
python tools/rpa_fixture.py --replay home
python tools/rpa_fixture.py --replay-all        # 退出码 0 = 所有页所有 locator 都命中
```

输出逐条带结果，失败时写明是"找不到"还是"不唯一"：

```
[home] OK    #sm-welcome      -> div#sm-welcome 'Manage 0 Active Connections'
[manage] 找不到   Apply Update    -> 找不到目标 'Apply Update'（当前页 50 个可点目标）
[home] 不唯一   a       -> 目标 'a' 不唯一：['menu-home-banner', 'settings-banner', ...]
```

回放路径**不 import `cdp_driver`、不建 socket**：`targets.json` 就是唯一输入，
所以 CI 机器上没套件、没 9223 也能跑。

---

## 4. 单测

```powershell
python -m unittest tests.test_rpa_fixture
```

覆盖：全命中 → 0；改名一条 → 1 且指名；同名多义 → "不唯一"；`label@N` 越界 → "越界"；
空 `locators.json` 不算通过；`replay_page(..., targets=...)` 可注入目标（不碰文件系统）；
`capture()` 的 HTML 截断与 URL 脱敏；以及**仓库里这四页 fixture 每次都被重放一遍**。

---

## 5. 什么时候要重采

- 套件升级（`meta.json` 的 `suite_version` 变了）或页面改版；
- 流程新增了 `target:` key —— 先确认它能在对应页 `--capture-locators` 通过；
- 回放报"找不到"但人工看页面上明明有 —— 说明目标从 `cursor:pointer` 变了
  （例如不再是可点元素），这时要修的是 `collect` 规则，不是 fixture。

改了 `collect`/`pick` 的匹配规则也要重采：fixture 记的是"规则跑出来的结果"，
规则一变，旧 fixture 的含义就变了。
