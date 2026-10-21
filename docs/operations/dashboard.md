# 运行看板：口径与数据流（M5-3）

状态：初版（2026-10-19）

M5-3 的交付物是三类视图（台站健康度 / 告警 / 工单）+ 生成脚本。这份文件把口径
写死；可执行的版本是 `tools/make_station_dashboard.py` 与
`tests/test_m5_dashboard.py`（5 条）。

## 数据流：日志 → 黑板 → 页面

```text
logs/m5_pipeline_replay.json（M5-1 全链回放）
        │  按下面口径提取三类上下文
        ▼
Blackboard（M5-2：键 station/…、alert/…、order/…，upsert 装载）
        │  snapshot()
        ▼
figures/m5_dashboard.html（静态页） + logs/m5_dashboard.json（机读摘要）
```

看板不直接拿日志字段拼页面：这样「看板看到的就是黑板里的上下文」，M5-3 对 M5-2
的接口只有 `snapshot()`。装载用 `upsert`（单写者），页面渲染是只读。

## 三类视图的口径

### 1. 台站健康度

- 数据来自 `device_monitor` 阶段的 `station_health` 工具结果，**原样读取，不复算**。
  `health_score = 1 - missing/total` 与三档 `status` 的阈值都在
  `src/fieldstation/agents/tools/station_tools.py` 里 —— 看板再算一遍就是第二套口径，
  两边迟早分叉。
- 页面展示：台站、状态徽标、健康度（数值 + 条形）、缺测数/总数、最近读数时间，
  以及每个指标（sensor / metric / unit / count / missing / min / max / mean /
  quality_flags）的明细。
- 状态含义（阈值在 `station_tools.py`，看板只转述）：`ok` = 健康度 ≥ 0.95 且无质量
  标记（允许 ≤5% 缺测仍算 ok）；`degraded` = 健康度 < 0.95 或存在质量标记；
  `critical` = 健康度 ≤ 0.5。

### 2. 告警

两条**机械规则**，不做主观加权、不做静默抑制：

| 来源 | 触发 | 级别 | 证据 |
|---|---|---|---|
| `station_health` | 台站状态 `degraded` | `warn` | 该 `station_health` 调用（`device_monitor:t0001` 这种 `agent:call_id` 形式） |
| `station_health` | 台站状态 `critical` | `critical` | 同上 |
| `data_quality` | `qc` 阶段某次 `slip_detect` 的 `counts.union > 0` | `warn` | 该 `slip_detect` 调用（`agent:call_id`） |

- 数据质量告警的卫星组名用**输入消息** `groups[].tool_args` 与工具入参的规范 JSON
  匹配得到 —— `slip_detect` 的入参本身不带卫星号，不靠猜。
- 告警键：`alert/<台站>/station_health`、`alert/<台站>/data_quality/<卫星组>`；
  同键重复只保留最后一次（`upsert`），不同来源不合并 —— 一条告警对应一个可核对的
  证据调用。
- 研判结论（`fault_diagnosis`）不进告警级别：`confidence` 是模型自报，不适合当
  严重度依据；研判内容在页面之外由链路消息与结论契约承载。

### 3. 工单

- 数据来自 `operations_dispatch` 阶段的 `create_work_order` 结果（全量字段：
  `order_id`、`station_id`、`title`、`priority`、`risk`、`status`、`action`、
  `assigned_to`、`description`、`evidence_call_ids`）与 `execute_device_action`
  结果（`status` / `execution_mode` / `reason` / `confidence`）。
- 页面展示：工单号、优先级、状态、台站、标题、动作、执行（状态 / 模式）、说明。
- 看板**只展示不推进**工单状态：状态机在 `store/work_order.py`，改状态要走工具与
  审批门，不能在页面上点一下就算数。

## 样本口径

真实台站样本受 #28/#33 阻塞（成员侧脱敏样本未到）。当前页面由固定种子合成样本的
M5-1 全链回放日志生成 —— 与 M4-0 / M5-1 同款替代口径，页面顶部有显式标注。
真实样本到位后，先按 `harness/REPRODUCE.md` §3.5 重跑 M5-1 换基线，再用同一条
命令重新生成看板，口径与规则不用改。

## 生成与输出

```powershell
$env:PYTHONPATH="src"; python tools/make_station_dashboard.py
```

- `figures/m5_dashboard.html`：单文件静态页（内联 CSS + div 条形；无 JS、
  无外部资源、不引第三方 BI）；
- `logs/m5_dashboard.json`：机读摘要（计数、台站、告警、工单、源日志 sha、
  页面 sha），供数字回源。

**确定性**：输出不含**生成**时间戳与随机量（页面里的 `latest_observed_at` 是数据
时间，来自日志）；页面与摘要都钉 LF；同一份日志两次生成逐字节相同；入库产物必须
等于当前生成器的输出（`tests/test_m5_dashboard.py` 钉死，改口径后要重新生成并提交）。

退出码：`0` 生成完成；`1` 日志缺三类视图所需数据（没有 `device_monitor` 的
`station_health` 或 `create_work_order` 结果）、或周跳告警无法归属卫星组（不猜）；
`2` 用法错误、日志不可读 / 非 UTF-8 / 不是 M5 回放日志。

## 第二类输入：公开数据链路（#98）

看板也接受 `harness/public_data_chain.py` 的输出（`kind=fieldstation.public_data_chain.log`，
与 M5-1 日志同形）：设备侧是公开数据、观测侧是合成样本、模型被事实合成器替代。页面会
自动多出一行「数据来源」标注（设备侧样本路径 / 许可 / 署名；观测侧合成 + 原因），
并把 tokens 显示为 `0/0（无模型调用）`。

```powershell
$env:PYTHONPATH="src"
python tools/make_station_dashboard.py --log logs/public_data_chain_202401d01.json `
    --page figures/m5_public_chain_dashboard.html --summary logs/public_chain_dashboard.json
```

M5-1 的页面（`figures/m5_dashboard.html`）与这份页并存：前者是合成基线，后者是公开
数据链路的真实数值。

## 不做什么（边界）

- 不引第三方 BI / 图表库：一个静态 HTML 足够三人同步与对外演示，没有交互筛选需求。
- 不做常驻服务与自动刷新：页面是某次运行的快照；实时看板要等 M6 部署形态定了
  再决定（届时接 `Blackboard(on_event=...)`）。
- 不在页面上做任何写操作：看板只读，动作一律走工具 + 审批门。

## 怎么核对

```powershell
$env:PYTHONPATH="src"; python -m unittest tests.test_m5_dashboard -v
$env:PYTHONPATH="src"; python tools/make_station_dashboard.py
```

- 摘要里的 `source.log_sha256` 必须等于 `logs/m5_pipeline_replay.json` 的顶层
  `sha256`（当前 `04fa5d7c…`）；`page.sha256` 是页面内容的 sha。
- 台站 1（BADG，0.667，degraded）、告警 2（均 warn：`data_quality` GPS 01、
  `station_health`）、工单 1（WO-0001，P0，open，执行 accepted/simulated）。
