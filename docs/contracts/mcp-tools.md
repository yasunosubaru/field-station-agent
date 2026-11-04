# MCP 工具表（E1 工具面）

- 状态：**W0 冻结**（2026-11-05），工具数固定为 **30**
- 适用：运行时 A（OpenCode）与运行时 B（Claude Agent SDK）共用同一个 MCP 服务
- 代码锚点：`ToolRegistry.describe()`、`src/fieldstation/agents/tools/*`、`tools/agent_server.py`
- 关联：ADR-009 §1、`docs/product/architecture.md` §3、`docs/operations/high-risk-actions.md`
- 一句话：**30 条工具、一处注册、两个运行时都直连；风险级来自登记，模型不能降级。**

---

## 0. 约定

1. **工具名全局唯一**，`^[a-z][a-z0-9_]*$`，重名注册直接报错（`ToolRegistry.register`）。
2. **入参只写模型可传的字段**。`*` = 必填；`=值` 是默认值；`array<T>` / `object` 是 JSON 类型。
3. **返回是成功时的 `data`**；失败一律走 `{ok:false, error:{code,message,retryable}}`，不靠字段缺失猜失败。
4. **风险级** `low / medium / high` 由服务端登记，模型改不了；`high` 恒过审批门。
5. **审批列**只允许三种值：`否`、`是`、`条件（…）`；`条件` 必须写明触发条件。
6. **只读工具不许写盘**；写工具必须返回回执（id、前后状态、时间），并落 trace。
7. 工具描述与 `config/agents/*.json` 白名单同源；新增工具先改本表，再改注册处，CI 校验数量为 30。

## 1. 30 条工具

| 编号 | 名称 | 分组 | 入参（* 必填） | 返回（成功 data） | 错误码 | 审批 | 风险 |
|---|---|---|---|---|---|---|---|
| T01 | `station_health` | 台站 | `readings:array<object>*`；`station_id:string` | `stations[]`：`station_id,total,missing,health_score,status,metrics[],quality_flags[]`；`summary{total,missing,alerts[]}` | E_ARG, E_LIMIT, E_INTERNAL | 否 | low |
| T02 | `device_heartbeat` | 台站 | `devices:array<object>*`；`now:string`；`stale_after_s:number=300` | `devices[]`：`device_id,state,last_seen_s,age_s`；`summary{online,stale,offline,unknown}` | E_ARG, E_STALE, E_INTERNAL | 否 | low |
| T03 | `native_ports` | 台站 | `include_busy:boolean=false` | `ports[]`：`port,device,description,busy`；`count:integer` | E_UNAVAILABLE, E_TIMEOUT, E_INTERNAL | 否 | low |
| T04 | `execute_device_action` | 台站 | `station_id:string*`；`action:string*`；`reason:string*`；`confidence:number=1.0` | `receipt{status,execution_mode,station_id,action,reason,confidence,approval_id}` | E_ARG, E_APPROVAL_REQUIRED, E_APPROVAL_DENIED, E_PRECOND, E_UNAVAILABLE | 是 | high |
| T05 | `robust_stats` | 质控 | `values:array<number>*`；`sigma_k:number=3.0` | `n,median,mad,sigma_robust,threshold,outliers[]` | E_ARG, E_LIMIT, E_INTERNAL | 否 | low |
| T06 | `slip_detect` | 质控 | `series:array<object>*`；`system:string*`；`signal_1:string*`；`signal_2:string*`；`sign:number*` | `slip_indices[]`；`n_epochs,n_slips`；`summary{method,threshold,max_jump}` | E_ARG, E_LIMIT, E_INTERNAL | 否 | low |
| T07 | `continuity_verdict` | 质控 | `algorithm:string*`；`n_arcs:integer*`；`n_series:integer*`；`rejected_short_arcs:integer=0`；`n_rows:integer`；`arc_ratio_guard:number`；`short_arc_guard:number=0` | `applicable,n_arcs,n_series,arc_ratio,short_arc_rate,rejected,reason,criterion` | E_ARG, E_PRECOND, E_INTERNAL | 否 | low |
| T08 | `magnitude_verdict` | 质控 | `rmse:number*`；`limit:number*`；`n:integer`；`unit:string` | `accepted,rmse,limit,ratio,criterion,reason` | E_ARG, E_PRECOND, E_INTERNAL | 否 | low |
| T09 | `fault_diagnose` | 研判 | `station_id:string*`；`window_start:string*`；`window_end:string*`；`evidence_call_ids:array<string>*`；`max_causes:integer=3` | `attribution{fault_type,evidence[]}`；`recommendation:string`；`confidence:number`；`causes[]` | E_ARG, E_NOT_FOUND, E_PRECOND, E_INTERNAL | 否 | medium |
| T10 | `create_work_order` | 工单 | `station_id:string*`；`title:string*`；`priority:string*`；`risk:string=medium`；`description:string`；`action:string`；`evidence_call_ids:array<string>` | `order{work_order_id,status,priority,risk,created_at,evidence_call_ids[]}` | E_ARG, E_CONFLICT, E_NOT_FOUND | 否 | medium |
| T11 | `list_work_orders` | 工单 | `status:string`；`station_id:string`；`limit:integer=50`；`cursor:string` | `items[]`：`work_order_id,station_id,title,status,priority,created_at`；`next_cursor:string` | E_ARG, E_LIMIT, E_INTERNAL | 否 | low |
| T12 | `update_work_order` | 工单 | `work_order_id:string*`；`status:string*`；`note:string`；`by:string` | `order{work_order_id,status,updated_at,history[]}` | E_ARG, E_NOT_FOUND, E_CONFLICT, E_PRECOND | 条件（转为 done 且工单 action 属高风险动作） | medium |
| T13 | `archive_export` | 工单 | `relative_path:string*`；`payload:object*`；`synthetic:boolean*` | `artifact{path,sha256,bytes,synthetic}` | E_ARG, E_READONLY, E_ARTIFACT, E_CONFLICT | 否 | low |
| T14 | `kb_search` | 知识 | `query:string*`；`limit:integer=5`；`tags:array<string>` | `hits[]`：`doc_id,title,score,snippet,source`；`query:string` | E_ARG, E_LIMIT, E_UNAVAILABLE | 否 | low |
| T15 | `workflow_list` | 工作流 | `intent:string`；`limit:integer=50` | `workflows[]`：`id,title,risk,gates[],requires_operator`；`count:integer` | E_UNAVAILABLE, E_INTERNAL | 否 | low |
| T16 | `workflow_run` | 工作流 | `workflow:string*`；`params:object`；`idempotency_key:string`；`allow_concurrent:boolean=false`；`force_lock:boolean=false` | `job{job_id,workflow,status,gate,created_at}`；`status` ∈ `running/waiting_approval/waiting_operator/succeeded/failed` | E_ARG, E_NOT_FOUND, E_CONFLICT, E_PRECOND, E_UNAVAILABLE, E_TIMEOUT | 条件（流程定义含写动作，或参数改变了设备状态） | medium |
| T17 | `workflow_status` | 工作流 | `job_id:string*`；`include_steps:boolean=true` | `job{job_id,status,current_step,steps[],gate,started_at,ended_at}`；`artifacts[]` | E_ARG, E_NOT_FOUND, E_UNAVAILABLE | 否 | low |
| T18 | `workflow_gate` | 工作流 | `job_id:string*`；`decision:string*`；`by:string`；`note:string` | `job{job_id,status,gate{decision,by,decided_at}}` | E_ARG, E_NOT_FOUND, E_CONFLICT, E_APPROVAL_DENIED, E_PRECOND | 是 | high |
| T19 | `workflow_resume` | 工作流 | `job_id:string*`；`decision:string*`；`by:string`；`note:string` | `job{job_id,status,resumed_at}` | E_ARG, E_NOT_FOUND, E_CONFLICT, E_PRECOND | 否 | medium |
| T20 | `workflow_cancel` | 工作流 | `job_id:string*`；`reason:string`；`by:string` | `job{job_id,status,cancelled_at}` | E_ARG, E_NOT_FOUND, E_CONFLICT | 否 | medium |
| T21 | `workflow_artifacts` | 工作流 | `job_id:string*`；`out:string` | `artifacts[]`：`name,kind,bytes,sha256,path`；`job_id` | E_ARG, E_NOT_FOUND, E_ARTIFACT | 否 | low |
| T22 | `suite_launch` | 套件 | `wait_ready:boolean=true`；`timeout_s:integer=90`；`port:integer=9223` | `suite{pid,version,cdp_port,ready,started_at}` | E_UNAVAILABLE, E_TIMEOUT, E_CONFLICT, E_INTERNAL | 否 | medium |
| T23 | `suite_status` | 套件 | `pid:integer`；`port:integer=9223` | `suite{pid,running,version,cdp_port,page,uptime_s}` | E_NOT_FOUND, E_UNAVAILABLE, E_TIMEOUT | 否 | low |
| T24 | `suite_stop` | 套件 | `pid:integer*`；`force:boolean=false`；`timeout_s:integer=5` | `suite{pid,stopped,forced,exit_code}` | E_ARG, E_NOT_FOUND, E_TIMEOUT, E_PRECOND | 否 | medium |
| T25 | `suite_graph_export` | 套件 | `project:string*`；`format:string=png`；`out:string`；`wait_ui_ms:integer=10000` | `artifact{path,sha256,bytes,format,pages}` | E_ARG, E_NOT_FOUND, E_UNAVAILABLE, E_TIMEOUT, E_ARTIFACT | 否 | medium |
| T26 | `data_partitions` | 数据 | `dataset:string*`；`station:string`；`date_from:string`；`date_to:string` | `partitions[]`：`path,station,date,hour,rows,bytes`；`total_rows:integer` | E_ARG, E_NOT_FOUND, E_UNAVAILABLE | 否 | low |
| T27 | `data_query` | 数据 | `sql:string*`；`engine:string=duckdb`；`max_rows:integer=10000`；`timeout_ms:integer=30000` | `columns[],rows[][],row_count,truncated,engine,partition_paths[],duration_ms` | E_ARG, E_READONLY, E_LIMIT, E_TIMEOUT, E_UNAVAILABLE | 否 | low |
| T28 | `data_aggregate` | 数据 | `metric:string*`；`station:string*`；`date:string*`；`group_by:array<string>`；`agg:array<string>`；`engine:string=duckdb` | `series[]`：`bucket,metric,count,min,max,mean,p50,p95`；`engine,latency_ms` | E_ARG, E_NOT_FOUND, E_LIMIT, E_UNAVAILABLE | 否 | low |
| T29 | `pipeline_run` | 管线 | `stages:array<string>*`；`input:object*`；`seed:integer=42`；`dry_run:boolean=false` | `run{run_id,status,stages[],conclusions[],evidence[],duration_ms}` | E_ARG, E_PRECOND, E_APPROVAL_REQUIRED, E_TIMEOUT, E_INTERNAL | 条件（任一阶段白名单含 `execute_device_action`） | medium |
| T30 | `pipeline_status` | 管线 | `run_id:string*` | `run{run_id,status,current_stage,stages[],started_at,ended_at,error}` | E_ARG, E_NOT_FOUND, E_UNAVAILABLE | 否 | low |

## 2. 错误码

| 错误码 | 类别 | 可否重试 | 含义 | 典型处理 |
|---|---|---|---|---|
| E_ARG | input | 否 | 参数缺失/类型错/越界 | 把 `message` 原文给模型，让它改参数 |
| E_NOT_FOUND | input | 否 | 目标 id/路径/分区不存在 | 先列可用项，再重试一次 |
| E_CONFLICT | execution | 否 | 幂等键冲突、状态不允许 | 查当前状态，不重复提交 |
| E_PRECOND | execution | 否 | 前置条件不满足（未启动、未审批、缺证据） | 补前置步骤；不可跳过 |
| E_UNAVAILABLE | environment | 是 | 套件/引擎/运行时/服务未起 | 明示"不可用"，不静默回落 |
| E_TIMEOUT | environment | 是 | 超过 `timeout_ms/timeout_s` | 限一次重试；不可逆动作不重试 |
| E_APPROVAL_REQUIRED | approval | 否 | 该动作必须先发审批卡 | 发 `approval.request`，等决定 |
| E_APPROVAL_DENIED | approval | 否 | 人拒绝了，或审批过期 | 停止该动作，改建议或建单 |
| E_READONLY | capability | 否 | 只读通道收到写语句 | 拒绝并说明只允许 SELECT |
| E_LIMIT | capability | 否 | 行数/字节/数组超上限 | 缩小范围或分页 |
| E_ARTIFACT | artifact | 否 | 产物缺失/哈希不符/页数为 0 | 重跑生成步骤；保留旧产物 |
| E_STALE | execution | 是 | 心跳/数据超过 `stale_after_s` | 标注"过期"，不当作当前状态 |
| E_INTERNAL | execution | 是 | 未预期异常 | 落 `error` 事件，保留 trace，不吞栈 |

MCP 传输层错误另有一套 JSON-RPC 码：`-32602`（参数）映射 `E_ARG`，`-32601`（方法不存在）映射 `E_NOT_FOUND`，
`-32603`（内部）映射 `E_INTERNAL`；**领域错误一律放在 `tool.result.error.code`，不只靠 JSON-RPC 码。**

## 3. 审批规则

| 条件 | 结果 |
|---|---|
| `risk=high` | 必须审批；未批准前不得产生 `tool.result` |
| `risk=medium` 且 `confidence < 0.9` | 必须审批（ADR-004 的置信度门） |
| `risk=low` | 自动放行，`approval.result.by="auto"` |
| 审批过期 | 按 `rejected` 处理（`verdict=expired`），**不默认放行** |
| 人拒绝 | 对应 `tool.result.ok=false`，`error.code=E_APPROVAL_DENIED`；设备不动 |

审批记录进 trace 时不含时间戳随机量（时间走 metrics 旁路），保证回放可逐字节比对。

## 4. 与现有工具名的对应

本表是 v4 的 MCP 契约面。W4 切换前，现有 30 条注册名仍然有效；对应关系如下（未列出的保持不变）：

| 本表 | 现有实现/入口 | 处理 |
|---|---|---|
| `kb_search` | `knowledge_search`（`agents/knowledge.py`） | 改名 + 保留别名 `knowledge_search` 一个版本 |
| `suite_launch` / `suite_status` / `suite_stop` | `tools/suite_launcher.py` 的 `launch/status/stop` | 包成 MCP 工具，不复制逻辑 |
| `suite_graph_export` | `native_graph_pdf` + `workflow_run gui.graph.export` | 收敛成一条；旧名保留别名 |
| `native_ports` | `native_ports`（`native_bridge.py`） | 不变 |
| `data_partitions` / `data_query` / `data_aggregate` | 新增（W8） | 只读 Parquet；见 `bench-sql.md` |
| `pipeline_run` / `pipeline_status` | `agents/pipeline.py` + E3 五阶段图 | 包成工具；`dry_run` 走降级链 |
| `fault_diagnose` | `fault_diagnosis` agent 的研判步骤 | 只做归因，不重算质控判据 |
| `update_work_order` | `WorkOrderService.transition` | 新增显式状态机入口 |

`config/agents/ops.json` 里的旧白名单有 30 条，与本表**不是同一组 30 条**：旧表按"通道"铺开 11 条 native_*，
本表按"能力"收敛。CI 校验的是**本表恰好 30 条**；旧白名单在 W4 迁移时按 §4 映射替换。

## 5. 新增/修改工具的门禁

1. 先改本表（编号、入参、返回、错误码、审批、风险），再改代码；
2. `ToolRegistry.describe()` 的键集合必须仍是 `name/description/params/risk`；
3. 参数名、类型、必填与 `params` 完全一致；
4. 失败返回 `ok=False` + `error`，不抛异常穿到运行循环；
5. 高风险工具必须有 `approval.request` 测试；只读工具必须有"拒写"测试；
6. 本表行数与 `tests/test_contracts.py` 的断言同源，改数量必须同步改测试。
