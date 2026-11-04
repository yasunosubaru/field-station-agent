# RPA fixture 规范（套件台 / E7）

- 状态：**W0 冻结**（2026-11-05），与 `tools/rpa_fixture.py` 的实际格式一致
- 工具：`tools/rpa_fixture.py`、`tools/click_engine.py`、`tools/check_desensitization.py`
- 数据：`tests/fixtures/rpa/<page>/`
- 关联：ADR-010、`docs/operations/rpa-fixture.md`、`docs/operations/rpa-checklist.md`
- 一句话：**把"采集时页面上有哪些可点目标"冻成 JSON；回放只跑 `pick()`，不连套件。**

---

## 1. fixture 证明什么、不证明什么

| 证明 | 不证明 |
|---|---|
| locator（`#id` / `label` / `label@N`）还能在采集时那份目标列表里唯一命中 | 页面 DOM 还长这样（改版必须重采） |
| 流程 YAML 里的 `target:` key 没过期、没二义 | 点下去真有反应（那要 `ClickEngine.click` 的效果断言） |
| 提交进仓库的 fixture 没被改坏（单测每次重放） | 目标还可见、没被遮挡（只记录采集时可见的） |
| 无套件的 CI 能抓出失效选择器 | 坐标模式/原生对话框也能离线验（那要 UIA/CDP） |

采集只收 `cursor:pointer` + 语义可交互 + 可见 + 尺寸 ≥8 px 的元素（`click_engine.collect`）。
所以"定位解析"能离线验，"DOM 提取/点击效果"仍要真机。

## 2. 目录与文件

```
tests/fixtures/rpa/<page>/
  targets.json    # collect() 的原始结果，必需
  locators.json   # 这一页流程会用的 key，必需（回放时）
  meta.json       # 采集元数据，必需
  page.html       # 可选（--html），≤2 MB，默认不入库
```

`<page>` 只允许 `home` / `manage` / `device-dialog` / `update-popup`（与 `GOTO_ACTIONS` 一致）；
新增页必须先加 `--goto` 动作，再采 fixture，否则回放无法复现页面状态。

### 2.1 `targets.json`

顶层是数组，一项一个可点目标。**七个键全部必需**（`parse_targets` 直接按 key 取，缺一个就 `KeyError`）：

| 字段 | 类型 | 必填 | 含义 | 约束 |
|---|---|---|---|---|
| `idx` | integer | 是 | 采集顺序下标，从 0 起 | 页内唯一；只用于排障与稳定排序 |
| `tag` | string | 是 | 元素标签名（`a` / `button` / `div` …） | 小写；不写命名空间 |
| `id` | string | 是 | 元素 `id` | 可为 `""`；非空时 `#id` 可命中 |
| `cls` | string | 是 | `className` 原样 | 可为 `""`；不拆分、不排序 |
| `label` | string | 是 | 可读文本（`innerText`/`aria-label`/`title` 归一） | 可为 `""`；不含换行 |
| `w` | integer | 是 | 采集时宽度（CSS px） | ≥0；圆整 |
| `h` | integer | 是 | 采集时高度（CSS px） | ≥0；圆整 |

示例（真实 fixture 的第一项）：

```json
{"idx": 1, "tag": "a", "id": "settings-banner",
 "cls": "sidebar-nav-subitem-title dropdown-toggl",
 "label": "settings-banner", "w": 26, "h": 31}
```

### 2.2 `locators.json`

```json
{"page": "home", "locators": ["#sm-welcome", "Add application", "Playback", "#settings-banner"]}
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `page` | string | 是 | 必须等于目录名；回放时校验 |
| `locators` | array<string> | 是 | 该页流程会用到的 key；允许空数组，但空数组回放判失败 |

`load_locators` 也接受裸数组 `["#id", "label"]`；**写盘一律用对象形式**，便于带 `page` 自检。

locator 语法（`click_engine.pick`）：

| 写法 | 匹配规则 | 何时用 |
|---|---|---|
| `#id` | `target.id == key[1:]`，精确 | 有稳定 id 的按钮/卡片（最稳） |
| `label` | 先 `target.key` 精确，再唯一包含匹配（大小写不敏感） | 文本按钮 |
| `label@N` | 同名池里第 N 个（**1 起**） | 页面有多个同名 `Select` |

`target.key` 的定义：`label` 非空取 `label`，否则取 `id`，再否则取 `cls` 的首段。
同名父子元素（`div` 包 `span`）会取面积最大的外层，点击冒泡等效。

### 2.3 `meta.json`

| 字段 | 类型 | 必填 | 含义 | 脱敏 |
|---|---|---|---|---|
| `page` | string | 是 | 页面名，等于目录名 | — |
| `url` | string | 是 | 采集时 `location.href` | 用户名替换为 `<user>` |
| `viewport.width` | integer | 是 | 视口宽（CSS px） | — |
| `viewport.height` | integer | 是 | 视口高（CSS px） | — |
| `viewport.device_pixel_ratio` | number | 是 | DPR | — |
| `captured_at` | string | 是 | UTC ISO 8601（秒） | — |
| `suite_version` | string 或 null | 是 | 从 UA 抓的 `NovAtelApplicationSuite/x.y.z` | — |
| `target_count` | integer | 是 | 本次采集目标数 | — |
| `html_truncated` | boolean | 否 | `page.html` 是否被截断 | — |
| `html` | string | 否 | 固定 `"page.html"` | — |
| `html_bytes` | integer | 否 | 实际写入字节数 | — |

示例：

```json
{"page":"home",
 "url":"file:///C:/Users/<user>/AppData/Local/AllPoweredFSA/app-0.2.0.0/original/resources/app.asar/view/html/index.html#",
 "viewport":{"width":2048,"height":1218,"device_pixel_ratio":1.25},
 "captured_at":"2026-11-04T15:41:42+00:00",
 "suite_version":"2.11.0","target_count":48}
```

### 2.4 `page.html`（可选）

- 只在 `--html` 时生成；上限 **2 MiB**，超出截断并写 `html_truncated=true`；
- 含本机路径与页面全文，**默认不提交**；确需提交时先过 §3 的脱敏检查；
- 回放**不读** `page.html`，它只用于人工排障。

## 3. 脱敏

fixture 进仓库前必须过 `python tools/check_desensitization.py`。规则与处置：

| 规则 | 命中示例 | 处置 |
|---|---|---|
| `home_path_win` | `C:\Users\Alice\...` | 用户名替换为 `<user>`；保留盘符与其余路径 |
| `home_path_unix` | `/home/alice/...`、`/Users/alice/...` | 同上；URL 用 `sanitize_url` |
| `private_key` | `-----BEGIN ... PRIVATE KEY-----` | 禁止入库，整段删除 |
| `github_token` | `ghp_…` / `gho_…` | 禁止入库，换占位符并轮换 |
| API key / token / 密码 | `sk-…`、`Authorization: Bearer …` | 禁止入库；fixture 不需要任何密钥 |
| 设备序列号 / 账户名 | `SN123456`、`DOMAIN\user` | 用 `<serial>` / `<user>` 替换；保留结构 |

`sanitize_url` 的两条正则（与代码一致）：

1. `(file:///[A-Za-z]:/Users/)[^/]+/` → `\1<user>/`；
2. `([A-Za-z]:\\Users\\)[^\\]+` → `\1<user>`。

硬约束：

- `targets.json` / `locators.json` / `meta.json` **不得出现**上表任何真实值；
- `locators` 只用结构性文字或 `#id`，**不写日期、计数、版本号、用户名**；
- 同一页的 `url` 只保留到 `#` 前，查询串里若有 token 一律删掉；
- `page.html` 若提交，必须与 `meta.html_bytes` 对得上且过脱敏检查。

## 4. 采集与登记

```powershell
# 1) 切页面并采集（会先 --goto，再 collect）
python tools/rpa_fixture.py --goto home --capture home --html

# 2) 登记 locator：先在当前页逐条 pick()，全中才写盘
python tools/rpa_fixture.py --capture-locators home `
  --locator "#sm-welcome" --locator "Add application" `
  --locator "Playback" --locator "#settings-banner"

# 3) 收尾：关弹窗 + 回首页
python tools/rpa_fixture.py --restore-home
```

四条硬规则：

1. `--capture-locators` 有一条不中就不写盘（避免"当初就没录对"混进 CI）；
2. 采集前必须 `--goto` 到目标状态，否则采到的是上一页的目标；
3. 对话框类页面只切到"提交之前"（如 `device-dialog` 停在 Type=Serial，不点 Add）；
4. 采完 `--restore-home`，不留弹窗给下一个人。

## 5. 回放

```powershell
python tools/rpa_fixture.py --replay home       # 单页
python tools/rpa_fixture.py --replay-all        # 所有页；退出码 0 = 全中
```

| 项 | 约定 |
|---|---|
| 输入 | 只读 `targets.json` / `locators.json`；不连 CDP、不建 socket、不 import `cdp_driver` |
| 输出 | 每条 `{locator, ok, kind, detail}`；`kind ∈ ok/找不到/不唯一/越界/空清单` |
| 退出码 | 0 = 全部命中；1 = 有失败；2 = 参数错/没有可回放页 |
| 确定性 | 同一 fixture 同一次运行结果逐字节相同；不含时间戳 |
| 失败分类 | `找不到`（无池）、`不唯一`（多个不同 key）、`越界`（`label@N` 的 N 超池）、`空清单`（locators 为空） |

CI 门禁（不需要套件）：

```powershell
python tools/rpa_fixture.py --replay-all
python -m unittest tests.test_rpa_fixture
```

## 6. 失效判据

满足任一条即判 fixture **失效**，必须重采或修规则，不许"先放着"：

| 编号 | 判据 | 阈值/条件 | 处置 |
|---|---|---|---|
| INV-01 | `suite_version` 变了 | 与上次采集不同 | 全套重采（选择器可能整体变） |
| INV-02 | locator 回放失败 | 任一条 `kind != ok` | 重采该页；确认是改版还是录错 |
| INV-03 | 目标数漂移 | `target_count` 相对基线变化 >10%，或绝对差 >5 | 重采并人工看新目标 |
| INV-04 | 同名二义 | 新增同名 key 导致 `不唯一` | 改用 `label@N` 或 `#id`，重采 |
| INV-05 | locator 清单为空 | `locators=[]` 或文件缺失 | 补登记；空清单不算通过 |
| INV-06 | 匹配规则变了 | 改了 `collect` / `pick` 的规则 | 全套重采（fixture 是规则的输出） |
| INV-07 | 页面状态漂移 | `GOTO_ACTIONS` 改了步骤，旧 meta 无法复现 | 重采受影响页 |
| INV-08 | 元数据不一致 | `meta.page != 目录名`，或 `url` 指向别的页 | 修正或重采 |
| INV-09 | 脱敏门禁红 | `check_desensitization` 命中 | 先脱敏再入库；不得豁免 |
| INV-10 | 元素不再可点 | 人工看页面上有，但回放找不到 | 修 `collect` 规则，不是改 fixture |

**不触发失效的情况**：页面文字变化但不进 locator（如 "0 Active Connections"）；采集时间变；DPR/视口变但目标集不变。
这些只更新 `meta.json`，不重登记 locator。

## 7. 提交检查单

- [ ] `targets.json` 七键齐全，`idx` 连续无重复；
- [ ] `locators.json` 的 `page` 与目录名一致，key 不含日期/计数/版本；
- [ ] `meta.json` 的 `url` 已把用户名换成 `<user>`；
- [ ] `check_desensitization.py` 通过；
- [ ] `--replay-all` 退出码 0，4 页/16 条 locator 全中；
- [ ] `python -m unittest tests.test_rpa_fixture` 通过；
- [ ] 若提交 `page.html`，`html_bytes` 与实际一致且 ≤2 MiB；
- [ ] 新增页同步更新 `GOTO_ACTIONS` 与本文件 §2 的页面表。
