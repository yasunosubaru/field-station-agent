# 设备心跳与离线判定（M6-5，issue #109）

状态：初版（2026-11-03）

## 为什么要单列一条判据

设备掉线时最常见的样子是**没有读数**，而读数异常也可能是**在线设备**发出来的。
原来的 `station_health` 只看读数（缺测 / 质量标记 / 阈值），把这两种情况混在一起：

- 「设备已离线」→ 没有任何读数 → 看起来像「缺测」；
- 「设备在线但数据坏」→ 有读数、带质量标记 → 也是 `degraded`。

两者处置完全不同（一个要派人、一个要查数据），所以心跳与读数健康度是**两条正交判据**，
不合并成一个分数。

## 模型与判定

一行心跳 = 一台设备的最近一次报告：

| 字段 | 含义 |
|---|---|
| `device_id` | 设备 id（必填） |
| `station_id` | 所属台站（可选） |
| `last_seen_at` | 最近一次心跳时间（ISO 8601） |
| `interval_s` | 该设备的心跳周期（秒） |

判定规则（`src/fieldstation/agents/tools/heartbeat_tools.py`）：

| 条件 | 状态 |
|---|---|
| `age ≤ stale_after_intervals × interval_s` | `online` |
| `age ≤ offline_after_intervals × interval_s` | `stale` |
| 更久 | `offline` |
| `last_seen_at` 或 `interval_s` 缺失 / 不可解析 | `unknown`（**不判 offline**） |
| `last_seen_at` 晚于 `now` | `online`，`reason` 里注明时钟偏差 |

阈值在 **`config/heartbeat.json`**，不在代码里硬编码：

```json
{
  "stale_after_intervals": 2.0,
  "offline_after_intervals": 6.0
}
```

「几个周期算 stale」随设备的心跳周期变化，所以阈值按**周期**计而不是绝对秒数。
`unknown` 不进告警：不知道不等于出事。

## 告警

`device_heartbeat` 工具返回 `alerts`：`stale → warn`、`offline → critical`，
走看板现有的告警通道（黑板 `alert/...` 命名空间），与 `station_health`、
`data_quality` 并列，不合并。

## 回放（合成，不是真实设备）

公开数据源（Open-Meteo 等）**不带设备心跳**，真实台站样本又受 #28/#33 阻塞；
当前回放用 `synthetic.device_heartbeats` 造一条固定序列，逐行 `synthetic=True`：

```powershell
$env:PYTHONPATH="src"; python harness/heartbeat_replay.py
```

- 输入：4 台设备 × 73 个 5 分钟槽位（00:00 → 06:00），外加一台字段缺失的设备；
- 输出：`logs/heartbeat_replay.json`（完整 `series`、折叠后的 `devices`、告警、
  阈值、汇总、sha256）；
- 结果：online 1 / stale 1 / offline 1 / unknown 1，告警 2 条（warn + critical）。

看板展示（可选参数；不给就还是原来的三大视图）：

```powershell
$env:PYTHONPATH="src"
python tools/make_station_dashboard.py --heartbeat logs/heartbeat_replay.json `
    --page figures/heartbeat_dashboard.html --summary logs/heartbeat_dashboard.json
```

## 边界

- 心跳判定**不读墙钟**：`now` 由调用方给，回放才能逐字节复现；
- 心跳字段缺失按 `unknown`，不猜、不补默认周期；
- 真实设备到位后用同一工具与同一条回放口径续接，**不要**在回放脚本里另写阈值；
- 本页的 online / stale / offline 是**合成序列**的判定结果，不是真实台站状态。

## 怎么核对

```powershell
$env:PYTHONPATH="src"; python -m unittest tests.test_heartbeat -v
```
