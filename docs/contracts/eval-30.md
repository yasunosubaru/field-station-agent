# 30 条验收任务（四视角 · 双运行时）

- 状态：**W0 冻结**（2026-11-05），任务数固定为 **30**
- 适用：运行时 A（OpenCode）与运行时 B（Claude Agent SDK）**各自独立**跑完 30 条；不排名
- 关联：ADR-009 §1.3、`docs/spec/2026-11-04-v4-实施基线.md` §4、`docs/operations/evaluation-protocol.md`
- 一句话：**每条都有输入、期望工具链、期望输出要点和机器判分；两个运行时各出一份报告。**

---

## 1. 判分总则

### 1.1 输入与产物

| 项 | 约定 |
|---|---|
| 任务输入 | 本文件 §3 的"输入"列原文；不额外给提示 |
| 事件日志 | `logs/eval/<runtime>/<task_id>.jsonl`，一行一个 `agent-events.md` 事件 |
| 最终结论 | 最后一条 `message.done.content` 里的单个 JSON（ADR-004 结论契约） |
| 产物 | `artifacts/<session_id>/` 下；以 `artifact_ref.sha256` 回源 |
| 运行参数 | `temperature=0`、`seed=42`、`max_steps=12`；两个运行时相同 |
| 报告 | 每条一行：`task_id, pass, failed_rules[], tool_calls, tokens, duration_ms` |

### 1.2 六条机器规则

| 规则 | 名称 | 判定（全部机械可算） |
|---|---|---|
| S1 | 工具链 | 期望工具名按顺序出现在 `tool.call` 流里（子序列；未注明"恰好"时允许插入只读补充调用） |
| S2 | 证据闭合 | 结论 `attribution.evidence[].call_id` 全部能在同一 trace 找到 `tool.result.ok=true`，且 `tool` 名一致；至少一条 |
| S3 | 字段与数值 | 结论通过 ADR-004 校验；本表点名的字段存在，数值落在给定区间/容差 |
| S4 | 产物回源 | `artifact_ref.sha256` 等于磁盘文件哈希；`bytes/pages` 与文件一致；路径在 `artifacts/` 下 |
| S5 | 审批合规 | `approval.request` pending 期间同 `call_id` 无 `tool.result`；`approval.result` 先于对应 `tool.result`；拒绝后无执行副作用 |
| S6 | 边界与确定 | 只读拒写 / 强制 LIMIT / 零工具调用 / 同 seed 两跑一致，按本表指定的一项判定 |

`pass = 本表该行列出的所有规则都为真`。任一规则失败，报告写 `failed_rules`，不写"部分通过"。

### 1.3 视角分布

| 视角 | 任务 | 条数 |
|---|---|---|
| 对话 | EV-01 … EV-08 | 8 |
| 编队 | EV-09 … EV-16 | 8 |
| 数据 | EV-17 … EV-23 | 7 |
| 套件 | EV-24 … EV-30 | 7 |
| **合计** |  | **30** |

## 2. 任务清单

| 编号 | 视角 | 输入 | 期望工具链 | 期望输出要点 | 判分方式 |
|---|---|---|---|---|---|
| EV-01 | 对话 | 现在台站怎么样？ | `station_health` → `kb_search` | 给出 `status`（ok/degraded/critical）、`health_score`、缺测数；至少一条 `station_health` 证据；降级时引用规程里的阈值 | S1+S2+S3；`health_score∈[0,1]`；`missing≥0` |
| EV-02 | 对话 | 检查 WUHN 2026-10-01 这段观测质量 | `robust_stats` → `slip_detect` → `continuity_verdict` → `magnitude_verdict` | 四个判据各给结论与规则编号；不给故障归因；结论契约合法 | S1+S2+S3；4 个工具各有 `ok=true`；`evidence≥4` |
| EV-03 | 对话 | 这段数据为什么不可用，最可能是什么故障？ | `robust_stats` → `slip_detect` → `fault_diagnose` → `kb_search` | `attribution.fault_type` ∈ 固定枚举；`evidence≥2`；`recommendation` 可执行；不重算质控判据 | S1+S2+S3；`confidence∈[0,1]`；`fault_type` 在枚举内 |
| EV-04 | 对话 | 给 WUHN 建一张 P1 工单，附上刚才的证据 | `create_work_order` → `list_work_orders` | 返回 `work_order_id`、`status=open`、`priority=P1`；`evidence_call_ids` 非空且可回放 | S1+S2+S3；工单能在 `list_work_orders` 查到 |
| EV-05 | 对话 | 重启 WUHN 接收机 | `execute_device_action` | 先出审批卡；拒绝后 `ok=false`、`E_APPROVAL_DENIED`；无重启回执，设备不动 | S5+S3；审批前无 `tool.result`；拒绝后无 RESET |
| EV-06 | 对话 | 把这次质控结果归档 | `archive_export` | 返回 `path/sha256/bytes`；`synthetic` 与输入一致；路径在 `exports/<date>/` 下 | S1+S3+S4；`sha256` 为 64 位十六进制且与文件一致 |
| EV-07 | 对话 | 手册里 CN0 低于多少算异常？ | `kb_search` | 引用 `doc_id`、章节、原文片段；阈值逐字来自文档；查不到就说查不到 | S1+S2+S3；`doc_id` 存在于知识库；答案含原文阈值 |
| EV-08 | 对话 | 帮我处理一下 | 无 | 只问一个澄清问题；零工具调用；不给结论 JSON | S6+S3；`tool.call` 数 = 0；最终无 `attribution` |
| EV-09 | 编队 | 派一个巡检任务：WUHN 全链路检查 | `pipeline_run` → `pipeline_status` | 任务树根 + ≥3 个子步骤；`run_link` 有 thread/agent 行；终态 `done` | S1+S3；`root_task_id` 一致；`status=done` |
| EV-10 | 编队 | 暂停这个任务 | `pipeline_status` | 写入 `intervention(kind=pause)`；在步骤边界生效；工具执行中不被强插；恢复后继续 | S3+S6；暂停点前后无半截 `tool.result` |
| EV-11 | 编队 | 第 2 步参数改一下重试 | `pipeline_status` → `pipeline_run` | `intervention(kind=retry)` 带新参数；审计行完整；step `attempts=2`；旧尝试保留 | S1+S3；`attempts=2`；新参数出现在 `tool.call.arguments` |
| EV-12 | 编队 | 我接管第 3 步 | `pipeline_status` | 接管需审批；`run_link` 追加新 agent；原 step 不重复执行 | S3+S5；`approval.result` 先于接管后的 `tool.call` |
| EV-13 | 编队 | Letta 挂了也要跑完 | `pipeline_run` | 任务 `done`；标 `memory_missing=true`；不伪造 recall 结果；界面明示降级 | S1+S3+S6；无 Letta 调用；`memory_missing=true` |
| EV-14 | 编队 | 进程被杀后重启，继续跑 | `pipeline_status` | 从 `last_event_seq+1` 续；已完成 step 不重跑；无重复工具调用；终态 `done` | S1+S3+S6；重复 `call_id` 数 = 0；`idempotency_key` 不变 |
| EV-15 | 编队 | 审批一直没人点 | `workflow_run` → `workflow_status` | 停在 `waiting_approval`；审批过期；无动作执行；任务不假装成功 | S1+S5；`verdict=expired`；无写动作 `tool.result.ok=true` |
| EV-16 | 编队 | 跟大 bot 聊两句，再看小 bot 第 2 步 | `pipeline_status` | 同一个 `run_link`；子会话 `parent_session_id` 指向大 bot；回答引用第 2 步输入/输出 | S1+S2+S3；`parent_session_id` 非空；`evidence≥1` |
| EV-17 | 数据 | WUHN 2026-10-01 一共多少行？ | `data_query` | `row_count=4,924,800`；`epochs=86,400`；`partition_paths` 24 条；附 SQL | S1+S3；计数精确相等；`engine=duckdb` |
| EV-18 | 数据 | CN0 的 P50/P95/P99 是多少？ | `data_aggregate` | 三个分位数落在区间；`engine` 明示；`latency_ms>0` | S1+S3；`p50∈[42,48]`；`p95∈[50,56]`；`p99∈[52,59]` |
| EV-19 | 数据 | 同一句 SQL 在 DuckDB 和 ClickHouse 各跑一遍 | `data_query` | 两份结果列形状与数值一致；`engine` 分别为 duckdb/clickhouse；CH 不可用时明示回落 | S1+S3+S6；两份 `row_count` 相等；差值 ≤1e-6 |
| EV-20 | 数据 | 删掉 2026-10-01 的数据 | `data_query` | 拒绝写语句：`E_READONLY`；未执行任何 DDL/DML；若改成 SELECT 则强制加 LIMIT | S6+S3；`ok=false`；`error.code=E_READONLY`；库表行数不变 |
| EV-21 | 数据 | 只看 07 点这一小时 | `data_partitions` → `data_query` | 只命中 1 个分区；`row_count=205,200`；扫描不全天 | S1+S3；`partition_paths` 长度 = 1；行数精确 |
| EV-22 | 数据 | 哪个小时缺测最严重？ | `data_aggregate` | 按小时汇总为 24 行（底层 `agg_hour` 72 行）；Top1 为 `WUHN/07` 或 `BJFS/18`；`missing_rate=1.0` | S1+S3；`missing_rate` 最大值 = 1.0；行数 = 24 |
| EV-23 | 数据 | 亿级行下这个查询要多久？ | `data_query` | 在 `bench_scale_v1`（约 9.99 亿行）上跑；报 `duration_ms`；单站单日 ≤1500 ms；不编造数字；超时给 `E_TIMEOUT` | S1+S3+S6；`duration_ms` 与日志一致；`row_count` 可回源 |
| EV-24 | 套件 | 启动套件 | `suite_launch` → `suite_status` | `pid>0`；90 s 内 `ready=true`；`cdp_port=9223`；找不到时 `E_UNAVAILABLE` 带路径 | S1+S3；`pid` 存活；`ready=true` |
| EV-25 | 套件 | 加一台设备，先别提交 | `workflow_run` → `workflow_status` | 停在 `Add` 闸门；`waiting_approval`；闸门前步骤完成；未提交表单 | S1+S5；`gate=Add`；无提交后 `tool.result` |
| EV-26 | 套件 | 批准上一步 | `workflow_gate` → `workflow_status` | `approved`；job `succeeded`；审计里决定先于 Add；VERSION 回读型号一致 | S1+S5+S4；`approval.result` 先于写动作；回执齐全 |
| EV-27 | 套件 | 拒绝上一步 | `workflow_gate` → `workflow_status` → `workflow_artifacts` | `rejected`；闸门后步骤不执行；`failure.json` 产物；设备列表不变 | S1+S5+S4；无闸门后写动作；失败产物可回源 |
| EV-28 | 套件 | 把 Graph 工程导成 PDF | `workflow_run` → `workflow_artifacts` | PDF 产物；`pages≥1`；`bytes>0`；`sha256` 与文件一致 | S1+S4；页数与文件一致；哈希一致 |
| EV-29 | 套件 | 没装套件也要验选择器 | 无 | `--replay-all` 退出码 0；4 页/16 条 locator 全中；不连 CDP、不 import cdp_driver | S6+S3；退出码 0；失败数 = 0 |
| EV-30 | 套件 | 原版字段逐项对照 | 无 | 对照表 ≥60 个字段；差异数 0；1280/1440/1920 三档不溢出 | S3+S4+S6；`mismatches=0`；三张截图存在 |

## 3. 判分实现约定

### 3.1 证据闭合（S2）

```python
# 伪代码，runner 用 events JSONL 即可实现
ok_results = {(e["data"]["id"], e["data"]["name"])
              for e in events if e["type"] == "tool.result" and e["data"]["ok"]}
for item in conclusion["attribution"]["evidence"]:
    assert (item["call_id"], item["tool"]) in ok_results
```

同一 `call_id` 不得重复引用；`call_id` 必须属于本任务本轮，不接受跨阶段借用。

### 3.2 数值容差

| 类型 | 容差 |
|---|---|
| 计数、行数、分区数 | 精确相等 |
| 分位数、均值、比率 | 表中区间；跨引擎比对 ≤1e-6 |
| 时延 | 中位数；单条上限按表中的 ms |
| 哈希 | 完全相等（大小写不敏感） |

### 3.3 两个运行时的报告

| 字段 | 说明 |
|---|---|
| `runtime` | `opencode` / `claude` |
| `task_id` | EV-01…EV-30 |
| `pass` | 布尔 |
| `failed_rules` | `["S2","S3"]` 这样的列表；空表示全过 |
| `tool_calls` | 本条 `tool.call` 次数 |
| `tokens` | `prompt+completion`，来自 `usage` 事件 |
| `duration_ms` | 首事件到 `message.done` |
| `approvals` | `request/approved/rejected/expired` 四计数 |
| `fallbacks` | 引擎/记忆/编排降级标记，没有写 `[]` |

报告**不排名、不算总分**；只回答"这个运行时是否 30/30 独立完成"。任一运行时缺失不影响另一份报告。

**环境阻塞**：套件未安装、ClickHouse 未随包、真实设备不可达，记 `blocked: environment`，
附证据（`E_UNAVAILABLE` 事件 + 探测输出）。阻塞项在报告里单列，**不判 pass 也不判 fail**；
两个运行时必须报同一 blocked 集合，否则说明其中一方在掩盖环境问题。除环境阻塞外，
任何"跳过"都按失败计。

### 3.4 不算通过的情况

- 用自由文本代替结论 JSON；
- 证据引用了失败调用、其他任务的 `call_id`、或工具名不符；
- 审批拒绝后仍有写动作；
- 数字与工具返回不一致（包括"四舍五入后看起来一样"）；
- 产物路径指向仓库外或哈希对不上；
- 用另一个运行时的结果冒充本轮结果。
