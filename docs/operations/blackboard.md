# 共享黑板：数据形状、并发语义与受控访问（M5-2）

状态：初版（2026-10-19）

spec §4 对「上下文管理」的要求是两条：**共享黑板（台站 / 告警 / 工单上下文）读写受控**、
**并发访问语义明确**。这份文件把语义写死在文字里；可执行的版本是
`src/fieldstation/agents/blackboard.py` 与 `tests/test_m5_blackboard.py`（24 条，
其中并发用真线程）。

## 与消息总线怎么分工

- **消息（`agents/bus.py`）**：阶段之间的**数据流**。一次性的、有先后顺序的、要进
  trace 全序的，走消息。M5-1 钉死的是「阶段间的**数据**只经总线」；输入文本开头
  还有一行编译期常量 `PipelineStage.note`（进 `input_digest`，**不在 trace 里**，
  见 KI-11），所以「输入」不等于「消息」。
- **黑板（`agents/blackboard.py`）**：多阶段**都要看、会更新**的上下文。台站健康度、
  告警、工单是典型：设备监测写台站状态，研判写告警，调度写工单，运行看板（M5-3）
  要一次读全。
- 两者都不承载「隐藏状态」：黑板之外没有跨阶段共享容器；阶段自己的局部变量不跨阶段。

## 数据形状

- 键：`<命名空间>/<条目名>[/子路径...]`。命名空间固定三类 —— `station`（台站）、
  `alert`（告警）、`order`（工单），与 spec §4 的括号逐字对应。条目名不能为空，
  所以 `station` 只是**前缀/范围**，不是合法键；`station/BADG`、
  `station/BADG/health`、`alert/A-0001`、`order/WO-0001` 都是合法键。
- 值：**dict**，且必须可 JSON 序列化（与总线同一条纪律：非 JSON 类型与 NaN/Inf
  一律拒收）。**整值替换，不提供就地修改** —— 想改就给一个新 dict；没有「改一半」
  的口子，读者就不会看到写者改到一半的半个状态。
- 版本：每个键只增不减的整数，创建从 1 开始、每次写 +1，**删除后重建也不回退**
  （从上一版本继续，防止删除前拿到的 CAS token 命中新条目）；条目还记最近写入者
  `by`（阶段名，由视图的 `actor` 自动填）。

## 并发语义

- **进程内、线程安全**：所有操作在一把 `threading.RLock` 下原子完成；值进出都
  深拷贝 —— 读到的对象与黑板内部不共享引用，写进去之后再改原对象也不会污染黑板。
- **写分三种，默认路径是 CAS**：

  | 操作 | 语义 | 失败 |
  |---|---|---|
  | `create(key, value)` | 键必须不存在 | `BoardConflict` |
  | `update(key, value, expect_version=n)` | 版本必须等于 n | `BoardConflict`（带实际版本） |
  | `upsert(key, value)` | 无条件整值替换（显式 last-writer-wins），版本仍自增 | 键/值不合法时 `ValueError` |
  | `delete(key, expect_version=n)` | 版本必须等于 n，返回被删条目 | `BoardConflict` |

  为什么默认 CAS：两个写者各按 `version=3` 做决定、后写的赢，前一个的判断连同依据
  一起消失且没有痕迹。要无条件覆盖，必须**显式**写 `upsert`，读代码的人一眼能看见。
- **单键原子、多键不原子**：跨键一致性不在这里保证。要喂给下游的走消息；要在黑板里
  保持一致的，聚合成一个键。
- **读不阻塞**：`read` / `snapshot` 在锁内拷贝完即释放；不存在「读着一个正在被写的
  引用」这种状态。`snapshot(prefix)` 给一次一致视图（同一时刻的全部条目）。
- **变更事件**（`Blackboard(on_event=...)`）：create / update / upsert / delete 在
  锁内按**提交顺序**同步回调（带 `op` / `key` / `version` / `by`）；**读不发事件**
  —— 读的留痕由工具层的 `tool_call` 覆盖。回调要轻量：它挡着所有写者；同线程回调
  可重入（RLock）。当前没有常驻消费者：M5-3 的运行看板用 `upsert` 装载 +
  `snapshot()` 渲染，**不消费**事件流；实时看板要等 M6 部署形态定了再接。
- 没有后台线程、定时器、中间件；锁内不跑用户代码之外的东西。

## 受控访问

- **声明**：`PipelineStage(board_reads=(...), board_writes=(...))`。范围是一组前缀
  模式：`"station"`（该命名空间全部）、`"station/BADG"`（含子键）、`"*"`（全部）。
  键等于模式、或以 `模式 + "/"` 开头才算命中 —— `station/BADG` 不会命中
  `station/BADGX`。
- **视图**：`Pipeline` 按声明为每个阶段造 `BoardView`（越权抛
  `BoardPermissionError`，不静默返回空）；`snapshot` 只含读范围内的键。
- **工具**：`Pipeline` 把 `board_read`（有 `board_reads` 时）与 `board_write`
  （有 `board_writes` 时）注入该阶段**克隆出来的**注册表，并把工具描述追加到该
  agent 的工具列表。没声明就没有这两个工具；声明了读就没有写工具，反之亦然。
  黑板调用照常落 `tool_call` / `tool_result`（含参数与结果），**不需要新的 trace
  事件类型**，也不需要改 `runtime.py`。
- **失败语义分两层**：库层（`Blackboard` / `BoardView`）用异常，这是 API 契约；
  agent 层（`tools/board_tools.py`）把异常翻成 `ToolResult(ok=False, error=...)`，
  沿用「失败要报，不要抛」的既有约束。冲突错误里带当前实际版本，重读后可重试。
- **装配重复看得见**：如果调用方自己往阶段注册表里塞了 `board_read`/`board_write`，
  `Pipeline` 注入时按 `ToolRegistry.register` 的重名规则**直接报错**，不静默顶掉。

## 不做什么（边界）

- 不做跨进程/分布式黑板：M5 的链路是进程内串行，引入外部中间件没有对应需求。
- 不做就地修改、不做字段级合并：整值替换 + 版本号已经够回答「现在是什么」。
- 不做自动过期/清理：与归档策略同一条理由 —— 自动删除是最容易造成不可逆损失的
  一类动作，没有真实数据量与存储预算之前不写保留期。
- 不做黑板内容的全量 trace 快照：全链证据在 `tool_call`/`tool_result` 与消息里；
  看板要的是当前值（`snapshot`），不是历史重放。

## 怎么核对

```powershell
$env:PYTHONPATH="src"; python -m unittest tests.test_m5_blackboard -v
```

- 并发：`create` 竞争恰好一个赢家、CAS 竞争恰好一个赢家、读者不会读到自相矛盾的
  值（写者写 `{"n": i, "double": 2i}`，读者逐次断言 `double == 2n`）。
- 受控：越权读/写抛 `BoardPermissionError`；链路里越权调用在 trace 的 `tool_result`
  里是 `ok=false` 且带「超出视图范围」；换一块板就什么都看不到（没有隐藏状态）。
