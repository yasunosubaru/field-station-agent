# RPA 目标基线校准（一条 diff 告诉你界面哪里变了）

- 日期：2026-11-04
- 关联：`docs/operations/rpa-click-engine.md`、`tools/rpa_calibrate.py`、`tools/rpa_targets.json`
- 一句话：**把"这一页能点什么"拍成基线，以后只跑一条 diff，就知道界面是没变、多东西、少东西，还是只是文字/尺寸漂了。**

---

## 0. 为什么需要它

流程 YAML 里写的是 `target:Playback` 这类 key，`ClickEngine.pick()` 找不到就抛
`ClickError("找不到目标 …")`。这句话能告诉你"这一步挂了"，但说不出：

- 是这一页整个没进去（导航挂了），
- 还是这一页在，但那个控件没了/改名了/被挪到下一页去了。

套件升级、切系统语言、分辨率变化之后，最贵的不是"修哪一行"，而是**搞清楚到底哪几个目标变了**。
本工具把"可点目标清单"变成可 diff 的基线：

```powershell
python tools/rpa_calibrate.py --diff home
```

退出码就是结论：`0` 结构没塌，`1` 有目标消失（流程最可能点空），`2` 环境/参数问题。

---

## 1. 什么时候跑

| 时机 | 跑什么 | 期望 |
|---|---|---|
| 套件升级 / 换语言 / 换分辨率之后 | `--diff all` | 有 `removed` 就先查，别急着改流程 |
| 流程报"找不到目标"，但页面看着没变 | `--diff <那一页>` | 定位是"没了"还是"改名了" |
| 改完 `workflows/**` 里的 target key | `--diff all` | 确认 key 在基线里还存在 |
| 基线本身过期（明知界面已改） | `--diff` → 人工确认 → `--write --yes` | 基线重新与界面一致 |
| 首次接手 / 新机器 | `--dump all` | 建基线 |

不建议放进"每次提交都跑"的 CI：它依赖一台开着套件、开着 CDP 9223 的机器，
属于**本地校准**，不是单元测试。没有套件时它只会以退出码 2 结束。

---

## 2. 三个动作

```powershell
# 建/重建基线（会覆盖同名页）
python tools/rpa_calibrate.py --dump all
python tools/rpa_calibrate.py --dump device-dialog

# 与基线比（默认会先把套件切到这一页再采）
python tools/rpa_calibrate.py --diff home
python tools/rpa_calibrate.py --pages home,manage --diff --json
python tools/rpa_calibrate.py --diff all --baseline tmp.json   # 用副本试，不动基线

# 确认后写回（缺 --yes 只打印差异，一个字节都不写）
python tools/rpa_calibrate.py --write manage --yes
```

| 参数 | 作用 |
|---|---|
| `--dump/--diff/--write [PAGES]` | 动作；不给页名时用 `--pages`，都没有就是全部 |
| `--pages home,manage,device-dialog` | 批量；`all` = 三页 |
| `--json` | 机读输出（`ok/removed/added/changed/pages`） |
| `--baseline PATH` | 换基线文件，默认 `tools/rpa_targets.json` |
| `--no-nav` | 不切页，直接采屏幕上现在这一页（套件正被手工操作时用） |
| `--port` | CDP 端口，默认 9223（或环境变量 `FSA_CDP_PORT`） |

三页的进入方式（工具自动做，顺序固定）：

```
先回首页（点 a.homemenu-title，顺带关掉遗留对话框/更新浮层）
home          → 就停在首页（#sm-welcome 可见）
manage        → 点 #sm-welcome        （判据：#add_device_btn 可见）
device-dialog → 点 #add_device_btn    （判据：#connection-cancelbtn 可见）
```

采完**一定恢复首页**，对话框用 Cancel 取消。工具不会把套件留在 Manage 页或弹窗上——
别人还要用这台机器。

---

## 3. 怎么读 diff

真实输出（把基线里加了一条不存在的目标，逼它报 removed）：

```
[home] 基线 48 个目标 → 当前 48 个   有差异
  - 消失 1 个（最危险：流程会点空）
      id:legacy-update-btn  「Legacy Update」  120x32
  + 新增 1 个（提示：流程暂时用不到）
      id:sm-welcome  「Manage 0 Active Connections」  184x240

有 1 个目标消失——先别改流程，先确认这是界面变更还是基线过期。
```

三类差异的处理方式完全不同：

| 类别 | 含义 | 怎么处理 |
|---|---|---|
| `removed`（`-`） | 基线里有、现在没有 | **先当坏事**。确认是套件删了这个控件，还是基线过期；改流程前必须查清 |
| `added`（`+`） | 现在多出来的 | 只提示。新功能多半用不到；但如果是"原本的按钮改名后变成两个"，配合 `removed` 一起看 |
| `changed`（`~`） | 同一身份，label 或尺寸变了 | 只提示。**注意：label 变了意味着流程里的 `target:旧名` 会点空**——即使退出码是 0 |

`changed` 里最容易被忽略的一条：**label 改名 = 退出码 0，但流程会挂**。
所以看到 `label 「Connect」→「Disconnect」` 这种，要去 `workflows/**` 里搜旧名，
而不是看退出码是 0 就放心。

尺寸变化（`372x48 → 400x48`）通常是布局/文案撑开，一般不影响点击；
但如果同时出现 `removed`，优先怀疑页面根本没进对（见 §5）。

退出码只有四个取值：

| 码 | 什么时候 | 该做什么 |
|---|---|---|
| 0 | 没有 `removed`；或者刚 `--dump` / `--write --yes` 完 | 看 `changed` 里的 label 有没有流程在用的名字 |
| 1 | `--diff` 发现 `removed` | 先查界面变更，别急着改流程 |
| 2 | CDP 连不上 / 页名拼错 / 基线里没这页 / 页面没稳定 / 没进对页 | 修环境或参数，不是界面问题 |
| 3 | `--write` 少了 `--yes` | 什么都没写；确认后再补 `--yes` |

---

## 4. 匹配规则：一条目标"是谁"是怎么定的

基线里每条是 `{key, id, tag, cls, label, w, h}`（`idx` 故意不存：它是文档顺序，
加一个目标就整体后移）。比较时按**身份**配对，规则：

| 顺序 | 身份 | 例子 |
|---|---|---|
| 1 | 有 `id` → `id:<id>`，其中 **10 位以上连续数字折叠成 `#`** | `id:#-device-tile`（原 `1793355488097-device-tile`） |
| 2 | 无 id 有 class → `tag:<tag>.<class>`，**剥掉状态词** | `tag:div.device-tile-footer` |
| 3 | 连 class 都没有 → `label:<数字折叠后的文字>` | `label:# Active Connections` |
| 4 | 都没有 → `tag:<tag>` | `tag:img` |

同一页里身份重复就追加 `@2`、`@3`（按文档顺序）。

两个刻意的设计：

- **时间戳 id 折叠**：设备卡 id 是 `Date.now()` 造的，重启套件就换一个。
  不折叠的话每次重启都是"两张卡消失、两张卡新增"，基线永远红。
- **状态 class 不参与比较**：连上设备，class 从 `device-disconnected` 变成
  `device-connected`。那属于运行时状态，不是界面变更，所以身份里剥掉、比较时也不看 `cls`。

---

## 5. 边界：它发现不了什么

这是校准工具，不是"界面正确性证明"。**必须知道的五条**：

1. **发现不了"同一个名字点到了别的东西"。** 它对目标只做身份 + 文字/尺寸比对。
   如果套件把 `Playback` 的位置换成了 `Convert`、而 key 没变，diff 可能只报尺寸变化，
   甚至什么都不报。**"点得对"要靠点击引擎的效果断言**（URL/文本/目标出现消失），
   不是靠基线。
2. **`target` 的唯一性不验。** 页面多了一个同名控件（`Connect` 从 5 个变 6 个）会以
   `added`/`@N` 出现，但"`target:Connect` 现在会不会变歧义"要跑 `ClickEngine.pick()` 才知道。
3. **只覆盖这三页。** `home` / `manage` / `device-dialog` 之外的页面（Playback、Convert、
   Graph、Perception Viewer、设置菜单）没有基线；需要时在 `PAGE_STEPS` 里加定义，
   同时给它一个**可见性判据**（`PAGE_LANDMARKS`），否则会拍成上一页。
4. **浮层噪音。** 更新检查浮层（"… is up to date"）、满意度调查、about 弹窗会不定时出现。
   工具每次采集前会关掉已知的两种（设备对话框 Cancel、`button.updateclosebtn`）；
   其它浮层冒出来会表现为 `added`（退出码 0）。**如果某个浮层在 dump 时正好开着，
   关掉之后就会报 `removed`** —— 这种 `removed` 是假警报，重跑一次 `--diff` 即可确认。
5. **尺寸与视口/DPI 绑定。** 同一个按钮在 2048×1218 和 1280×800 下宽度不同，
   也会因为 hover/滚动条差 1~2 像素。所以：**在固定的窗口尺寸下采基线**，
   换分辨率后重采；`changed` 里的 1px 抖动可以忽略，`removed` 不行。

另外，`--diff` 默认会把套件切到目标页再采（否则会拿 A 页和 B 页比）。
切页失败、或采完发现判据元素不可见，工具**直接以 2 退出**，不会拿错的页面去写基线。

---

## 6. `--write` 的纪律（最重要的一条）

`--write` 是**改写别人信赖的基线**。规矩只有一条：**先人工确认界面变更，再写。**

1. 先 `--diff`，把差异逐条看一遍；有 `removed` 就要能说出"这是哪个版本改的"。
2. 留证据：套件版本号、截图、变更说明（放进 PR/commit message 或本目录文档）。
3. 确认无误后才加 `--yes`：

   ```powershell
   python tools/rpa_calibrate.py --write all --yes
   ```

4. 基线文件进 git，**跟着那次变更一起提交**。基线 diff 本身就是"这次界面动了什么"的记录。

没有 `--yes` 时，`--write` 只打印差异并提示该跑什么命令，退出码 3，**一个字节都不写**。
这是故意的：少打一个 `--yes` 比误抹基线便宜太多。

不该 `--write` 的三种情况：

- `removed` 是你**没解释**的（很可能是页面没进对，或套件正在启动/卡住）；
- 你刚换过窗口大小 / DPI / 系统语言（先把环境固定，重采）；
- 你是为了让 CI 变绿而"顺手刷新一下"——那等于把校准器调成永远说没问题。
