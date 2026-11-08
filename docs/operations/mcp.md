# MCP 工具面服务（`fieldstation.mcp_server`）

- 状态：**W4 落地**（2026-11-08）
- 适用：运行时 A（OpenCode）与运行时 B（Claude Agent SDK）共用同一个服务
- 代码锚点：`src/fieldstation/mcp_server.py`、`tests/test_mcp_server.py`
- 契约：`docs/contracts/mcp-tools.md`（**唯一权威，只读不改**）
- 一句话：**30 条工具从契约现解析、一处注册、两侧直连；风险级来自登记，模型不能降级。**

---

## 1. 起服务

```powershell
python -m fieldstation.mcp_server                 # 127.0.0.1:7804/mcp
python -m fieldstation.mcp_server --port 7805
python -m fieldstation.mcp_server --check         # 只体检契约解析，不起服务
```

启动打印一行 `MCP_TOOLS_READY http://127.0.0.1:7804/mcp (30 tools)`。
**端口 7804 不与既有服务冲突**：9223/9224 套件 CDP、8788 运行时网关、4096 opencode、
18123/19001 是 ClickHouse 测试专用。

## 2. 两条硬规矩

### 2.1 工具清单从契约现解析，绝不硬编码

唯一权威是 `docs/contracts/mcp-tools.md` 的 30 行表格。代码里另抄一份，契约改了
代码不知道，两边会各自「自洽」——这和 `tools/audit_claims.py`（数字回源）是同一条纪律。

`tests/test_mcp_server.py::TestNotHardcoded` 有两条防回归：

- 把契约里的 `` `station_health` `` 改名为 `` `station_health_v2` ``，解析结果必须跟着变；
- 删掉一行 `| T30 | …`，解析出的条数必须变成 29。

**硬编码的版本过不了这两条。**

### 2.2 解析出 0 个就硬失败（退出码 2）

静默返回空列表会让服务正常启动、一个工具都没有、所有调用都报「工具不存在」，
而没人知道根因是契约格式变了。这叫**失明即硬失败**：看不见就说看不见。

```powershell
python -m fieldstation.mcp_server --check
# 契约坏了 -> [阻断] ... -> exit 2
```

## 3. `mcp` 2.x 的 API（照老教程写必错）

本机是 **mcp 2.3.0**。网上教程的名字在 2.x 里已被删除或改名，报错信息会提示新名字。

| 旧名（1.x 教程） | 2.x 正确写法 | 症状 |
|---|---|---|
| `mcp.server.fastmcp.FastMCP` | `mcp.server.mcpserver.MCPServer` | `ModuleNotFoundError` |
| `tool.inputSchema` | `tool.input_schema` | `AttributeError` |
| `result.isError` | `result.is_error` | `AttributeError` |
| `mcp.client.streamable_http.streamablehttp_client` | `...streamable_http_client` | `ImportError` |

**不要 `pin mcp<2`。** 契约没锁版本，没有理由降级。

### 3.1 客户端连法（2.x）

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

async with streamable_http_client("http://127.0.0.1:7804/mcp") as streams:
    read, write = streams[0], streams[1]      # 2.x 只给两条流，不是三条
    async with ClientSession(read, write) as session:
        await session.initialize()
        print(len((await session.list_tools()).tools))   # 30
```

### 3.2 入参 Schema 怎么来的

MCP 的入参 Schema **由函数签名推导**（`FuncMetadata` 用 `inspect.signature`）。
所以 `make_handler()` 真正设了 `__signature__`，而不是只标 `**kwargs`——
只标 `**kwargs` 会让 Schema 变成空对象，模型永远不知道要传什么参数。

`tests/test_mcp_server.py::TestRegistration` 钉住了这一点：`station_health` 的
Schema 里必须有 `readings`、`station_id`，且 `readings` 在 `required` 里。

## 4. 审批守卫（在服务里，不在调用方）

契约 §3 的两条规则：

| 条件 | 结果 |
|---|---|
| 审批列 = `是` | 必须带 `approval_id` |
| `risk=high` | 同上 |
| `条件（…）` | **本服务不猜条件**，按工具实际风险处理 |

不带或带伪造的 id：

```json
{"ok": false, "error": {"code": "E_APPROVAL_REQUIRED", "retryable": false, ...}}
{"ok": false, "error": {"code": "E_APPROVAL_DENIED",   "retryable": false, ...}}
```

**`approval_id` 是额外的调用约定参数**，不在契约的入参列里。它只出现在
需要审批的工具的 Schema 里（低风险工具的 Schema 没有这个字段——
否则模型会以为随便传一个就能过）。

### 4.1 默认一律不批

`DenyAllLedger` 是默认台账：任何 `approval_id` 都返回 `False`。
宁可让高风险工具不可用，也不默认放行——与 `agents/approval.py`
「没有审批者时不给默认放行」是同一条纪律。

要放行必须显式注入台账：

```python
from fieldstation.mcp_server import build_server, load_tools, DispatchContext, InMemoryLedger

ledger = InMemoryLedger()
ledger.grant("ap-01")
server = build_server(load_tools(), DispatchContext(ledger=ledger))
```

`InMemoryLedger` **只用于测试与本地演示**。生产要接 `intervention` 表。

## 5. 30 条工具的落地状态

不是所有工具都能立刻可用。**没接的必须明说 `E_UNAVAILABLE`，不许伪造成功**
（`tests/test_mcp_server.py::TestDispatch::test_unimplemented_tool_reports_unavailable_not_success`）。

| 状态 | 工具 | 说明 |
|---|---|---|
| 已接（包既有实现） | `station_health`、`device_heartbeat`、`robust_stats`、`slip_detect`、`continuity_verdict`、`magnitude_verdict`、`execute_device_action`、`create_work_order`、`list_work_orders`、`update_work_order`、`archive_export`、`kb_search`、7 个 `workflow_*`、3 个 `suite_*`、3 个 `data_*` | 一律**只包装，不重写**；统计口径仍在 `rules/` |
| 缺外部端点 | `native_ports`、`suite_graph_export` | 需要 Node 服务地址（`node_url`） |
| 需要 `agent` 推理 | `fault_diagnose` | 归因是五阶段链路的 `fault_diagnosis` 阶段，不是确定性函数；本服务不伪造归因 |
| 等 A 线接运行登记表 | `pipeline_status` | DBOS `run_link` |
| 需要编排决定 | `pipeline_run` | 阶段顺序由调用方给，本服务不替它决定 |

**`kb_search` 与 `knowledge_search`**：契约 §4 要求 `kb_search` 为正式名、
`knowledge_search` 保留一个版本的别名。本服务注册的是 `kb_search`。

## 6. 一个必须知道的坑：`build_registry()` 会改已入库文件

`agents/orchestrator.py::build_registry()` 内部会

```python
kb = KnowledgeBase(data/kb/knowledge.sqlite3)
kb.index(load_documents(data/kb/knowledge.jsonl))   # ← 全量重建
```

而 `data/kb/knowledge.sqlite3` **是入库的**。所以任何「只是想看一下有哪些工具」的
调用都会改变一个受版本控制的二进制文件（实测 159744 → 217088 B）。

本服务**刻意不调用 `build_registry()`**，`kb_search` 的索引写到 `ctx.data_dir`，
不碰仓库内那份。跑完探测记得：

```powershell
git checkout -- data/kb/knowledge.sqlite3
git status --porcelain     # 应当只剩你自己的改动
```

## 7. 验收

```powershell
# 1) 工具数
python -m fieldstation.mcp_server --check        # exit 0，30 条

# 2) 单元测试
python -m unittest tests.test_mcp_server -v      # 25 条全过

# 3) 两侧独立能连（A 用 opencode，B 用 SDK 自带 MCP 客户端）
#    关键判据：关掉 A 后 B 照常——两侧不共享进程，只共享契约
```

对照 `docs/contracts/mcp-tools.md` §1 的 30 行逐条核对名字，
`asyncio.run(server.list_tools())` 的 `{t.name}` 必须与之**集合相等**。

## 8. 新增/修改工具

1. **先改契约**（编号、入参、返回、错误码、审批、风险），再改代码；
2. 契约条数变了，`EXPECTED_TOOLS` 与 `tests/test_contracts.py` 同步改；
3. 在 `_register_default_implementations()` 里加一条分发——**包既有实现，不复制逻辑**；
4. 高风险工具必须补「无审批 → `E_APPROVAL_REQUIRED`」的测试。
