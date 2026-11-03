# 任务调度与失败分类（M6-4，issue #111）

状态：初版（2026-11-03）

## 为什么要调度器

真机要无人值守：定时采集、轮询、到点跑分析。此前所有入口都是按需脚本
（`python harness/...`），没有调度器，台账六类失败里也没有「任务没跑」这一维。
结果是数据没进来时分不清：设备坏了、数据源挂了、还是任务压根没触发。

调度器只负责**什么时候跑**，不碰链路内部逻辑。

## 三种情形

| 情形 | 判据 | 台账 `failure_class` |
|---|---|---|
| 到点触发 | `now` 落在 `[due, due + grace]` | `status=ok` |
| 错过触发 | `now > due + grace`（被上一个任务拖住） | `任务未执行` |
| 超时 | 单次执行耗时 `> timeout_s` | `任务超时` |

- 错过的不逐个补跑：记**一行**「错过 N 个周期」，把下一站推到 `now` 之后；
- 超时判定看**注入时钟**，不看墙钟；单线程模型下无法强杀卡住的 runner，
  所以超时在 runner 返回后判定（这是已知边界，见下）；
- 任务失败**不抛未捕获异常**：记一行台账，继续跑下一个任务。

## 台账行（与试运行台账同形）

`harness/station_loop.py` 写 JSONL，行字段与 `tools/trial_ledger.py` 一致
（`ts` / `run_id` / `source_id` / `url` / `status` / `failure_class` / `bytes` /
`sha256` / `n_records` / `duration_ms` / `notes`），另加任务专有字段：

| 字段 | 含义 |
|---|---|
| `task_id` | 任务 id |
| `source_id` | 固定 `task:<task_id>` |
| `scheduled_at` | 应执行时刻 |
| `started_at` / `finished_at` | 实际起止（错过时 `started_at=null`） |
| `interval_s` | 任务周期 |

因此同一份台账能被 `tools/trial_ledger.py --summarize` 直接汇总，并且汇总里
**分开计数**：

```json
"by_failure_kind": {"data_source": 4, "task": 0}
```

`data_source` 只数六类源失败；`task` 只数「任务未执行 / 任务超时」。
`by_failure_kind` 就是「今天没数据，是设备/数据源，还是任务」的答案。

## 运行

```powershell
$env:PYTHONPATH="src"
python harness/station_loop.py                    # 确定性演示
python harness/station_loop.py --out logs/station_loop_demo.jsonl `
    --summary-out logs/station_loop_demo_summary.json
```

演示覆盖四类行：到点 `ok`、任务异常 `未知`、拖过窗口 `任务未执行`、
超时 `任务超时`。时钟是 `ManualClock`（`sleep_until` 直接拨指针），
同一时钟序列两次运行写出的 JSONL 与摘要**逐字节相同**。

真实接入时把 `SystemClock` 与真实 runner 传进 `StationLoop` 即可；
高风险动作仍然走 `workflows/*.yaml` 的人工闸门，调度器不绕过审批。

## 看板

看板可选多一块「数据源 / 任务失败」面板：

```powershell
$env:PYTHONPATH="src"
python tools/make_station_dashboard.py --trial-ledger logs/trial_ledger_20261021.jsonl `
    --heartbeat logs/heartbeat_replay.json `
    --page figures/heartbeat_dashboard.html --summary logs/heartbeat_dashboard.json
```

## 边界

- **单线程、同步**：不引 APScheduler / cron；
- 不持久化任务状态（台账只追加，重启后按配置重新排程）；
- 超时是「事后判定」，不能强杀已经卡死的 runner；真要硬超时，用独立进程 +
  外部看门狗（本阶段不做）；
- 时间只从注入时钟取；trace / 台账里不出现墙钟。

## 怎么核对

```powershell
$env:PYTHONPATH="src"; python -m unittest tests.test_station_loop -v
```
