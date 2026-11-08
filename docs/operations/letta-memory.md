# Letta 记忆：为什么不是进程内库

- 状态：**W0 的 Letta spike 有结论了（2026-11-07）**；W7 的适配器已落地
- 结论一句话：**Letta 走「外部服务 + 轻客户端」，不作为进程内库嵌入。**
- 代码：`src/fieldstation/botd/letta.py`；测试 `tests/test_botd_letta.py`（29 项）；冒烟 `tools/letta_smoke.py`

---

## 1. spike 的问题与答案

计划 W0 的第一个 spike 原话是：

> Letta 内嵌验证 | spike 脚本 + 结论 | **单进程内能 recall/remember**；不行则记降级方案

答案在把两个包拆开看之后就很清楚：

| 包 | 体积 | 依赖 | 能不能进 `.deps/venv` |
|---|---|---|---|
| `letta`（服务端） | **78.4 MB** wheel | FastAPI + SQLAlchemy + Postgres 方言 + 向量库 | **不能**：与已钉住的 duckdb / langgraph / pydantic-ai / dbos / llama-index 争 pydantic 与 httpx 的版本 |
| `letta-client`（HTTP 客户端） | **418 KB** wheel | anyio / distro / httpx / pydantic / sniffio / typing-extensions | 能：这些全在现有 venv 里 |

所以「单进程内嵌」这条路**不走**：把 78 MB 服务端塞进交付物的解释器，等于给一个门禁
必须离线全绿的项目引入一套要 Postgres 方言与向量库的运行时。

**采用「外部服务 + 轻客户端」**，这正是 ADR-009 的降级梯度所预设的形状
（Letta 不可用 → `bot_memory` + Chroma，任务照跑并标 `memory_missing`）。

> 顺带纠正一个容易混的说法：`docs/operations/suite-embed.md` 讲的是 **W3 的窗口嵌入**
> （`user32.SetParent`），和本文件毫无关系。两个"嵌入"不是一件事。

---

## 2. 映射：我们的概念 → Letta 的概念

按 ADR-009 §2「Letta 拥有记忆真相：bot 是谁、记得什么、经验是什么，只写 memory blocks / archival」：

| 本项目 | Letta | 说明 |
|---|---|---|
| bot 的长期记忆 | agent 的 **core memory block** | 按 `bot_id` 找 agent，block 标签 `fsa_bot_memory` |
| 一条记忆 | **archival passage** | `agents.passages.create` 写入；`agents.passages.search` 召回 |
| 记忆的 `key` | passage 的 **tags**（`key:<value>`） | **不进正文** |

`key` 不放正文是有原因的：正文必须就是内容本身。塞成 `key: power\n内容…` 之后，
召回时要再剥一次前缀，而内容里天然含 `key:` 字样时那一步会切错位置。

### 调用链里的位置

ADR-009 定的调用链是「Letta 只出现在首尾」：

```
DBOS workflow bot.task.run(task_id)
 1  letta.recall(agent_id, task)      → 记忆块     ← 本文件
 2  langgraph.invoke(plan_graph)      → 结构化计划
 3  每步 enqueue 子 workflow
 4  写动作 → interrupt → durable sleep → 人批 → 恢复
 5  letta.remember(agent_id, 结果/失败原因/证据号)   ← 本文件
 6  写台账 + 通知
```

`letta.py` 只做第 1 与第 5 步，不参与判断、不参与调度。

---

## 3. 三条必须分清的失败

降级梯度只有一条是对的写法：**分清楚是哪一个环节坏了**。混成一个"记忆不可用"，
排查时会花掉几小时。

| 情形 | 表现 | 处理 |
|---|---|---|
| 没装 `letta_client` | `available()` 假，reason 说「未安装 letta_client」 | 走纯本地，不报错 |
| 装了但服务没起 | `available()` 假，reason 带地址与异常 | 走纯本地，不报错 |
| 服务在、agent 不存在 | `recall()` 返回**空列表**，不算故障 | 首次查询不该被记成故障 |
| 服务挂了（已运行中） | `remember`/`recall` 抛异常 | `BotMemory` 降级、标 `local-fallback`、留 reason |

第 3 条是刻意区分的：一个从没说过话的 bot 查询时，如果按"服务故障"处理，
日志里会凭空多出一次故障记录，而真相只是"它还没有记忆"。

### 惰性创建

`recall()` **不会**顺手建 agent。召回路径上创建外部对象，会让 Letta 侧的 agent
数量与本项目的 bot 表对不上，排查时很难解释"这个 agent 是哪来的"。
只有 `remember()`（真的要有地方写）才建。

---

## 4. 跑

### 单测（不需要服务、不需要装 client）

```powershell
$env:PYTHONPATH = "src"
.deps\venv\Scripts\python.exe -m unittest tests.test_botd_letta
# 29 tests OK；用假客户端，方法签名与 letta-client 1.12.1 的真实形状一致
```

### 真机冒烟（要服务）

先装客户端：

```powershell
.deps\venv\Scripts\python.exe -m pip install letta-client `
    -i https://pypi.tuna.tsinghua.edu.cn/simple
```

再起一个 Letta 服务（服务端**不进** `.deps/venv`，用容器或独立环境），然后：

```powershell
$env:PYTHONPATH = "src"
.deps\venv\Scripts\python.exe tools\letta_smoke.py
# PASS 服务可达 / PASS 写入 archival passage / PASS 召回刚写的记忆 / PASS key 从 tags 还原
```

环境变量：`FSA_LETTA_URL`（默认 `http://127.0.0.1:8283`）、`FSA_LETTA_TOKEN`。

冒烟会建一个 `fsa-smoke-<随机>` 的 agent 与一条 passage，**跑完不删**——
删除是不可逆动作，不该由一个冒烟脚本替人决定。

---

## 5. 现在的真实状态

| 项 | 状态 |
|---|---|
| 结论（spike 的问题） | ✅ 有：不内嵌，走外部服务 |
| 适配器实现 | ✅ `botd/letta.py` |
| 单测 | ✅ 40 项（29 原有 + 11 针对记忆块），不需要服务 |
| 接进 Supervisor | ✅ `botd/executors.py` 的 `MemoryExecutor`（11 项测试，含端到端） |
| `letta-client` | ✅ 已装（1.12.1，只装它一个，没有动任何既有依赖） |
| 记忆块读写 | ✅ 实现了 `read_block` / `write_block` |
| 真机往返 | ❌ **没跑过**：本机没有 Letta 服务在跑 |

**这条仍然不能算"W7 做完了"**：适配器、记忆块、执行器与降级语义是实做且有
测试的，但"真的对一个 Letta 服务读写过"这件事**仍然没有证据**。
`tests/test_botd_letta_blocks.py` 里"有真服务"那一半用的是假客户端 ——
它验的是适配器的逻辑（调用形状取自 `letta-client` 1.12.1 的真实签名），
不是网络的连通性。后者只能等真服务到位再验，这里不冒充。

### 5.0 「只在首尾」怎么落地（Bot-5）

`BotMemory` 加了两个入口，**中间过程完全不碰 Letta**：

| 时机 | 调什么 | 做什么 |
|---|---|---|
| 任务开头 | `recall_at_start(bot_id, query)` | 语义召回 + 读核心记忆块 |
| 任务结尾 | `remember_at_end(bot_id, content, block_value=…)` | 写一条归档 + 覆盖核心块 |
| 中间过程 | **不调** | —— |

这不是性能优化：中间频繁读写会让记忆变脏，而且每次都多一次跨进程往返。
把"首"和"尾"各成一个方法，比在每个调用点靠人工记得"别在中间调"可靠得多。

### 5.0.1 降级必须留痕

两个入口的返回里都带 `memory_missing`：

| 情形 | `memory_missing` | 本地表 |
|---|---|---|
| 有服务、写入成功 | `False` | 照样写（SQLite 是事实来源） |
| 没有外部后端 | `True` + `reason` | 照样写 |
| 服务在但写块失败 | `True` + `reason` | 照样写 |

不写标记的话，以后没人知道这份记忆是真从 Letta 来的还是本地兜底的 ——
那正是仓库纪律里"装完了、门禁全绿、实际能力却缺失"那条。

---

## 5.1 执行器：`memory.recall` / `memory.remember` 怎么接到 Supervisor 上

`Supervisor` 的 `StepSpec.tools` 是**白名单字符串**，执行器是**注入**的
（`run(executor=...)`）。所以记忆能力长成一个"执行器工厂"而不是构造参数——
后者会让拆步与工具实现耦合，而 ADR-009 的分工恰好是反过来的。

```python
from fieldstation.botd.executors import MemoryExecutor
from fieldstation.botd.letta import build_default_backend
from fieldstation.botd.memory import BotMemory
from fieldstation.botd.supervisor import Supervisor

memory = BotMemory(store, backend=build_default_backend())   # 没配 Letta 时返回 None
sup = Supervisor(store)
result = sup.run(task, executor=MemoryExecutor(memory).as_executor(fallback=other_tools))
```

**踩过的一个坑（已修，但要知道）**：`Supervisor` 造子任务时把父 payload 包在
`task` 键下面（`"payload": {"task": dict(payload), ...}`）。执行器如果直接
`dict(child["payload"])`，拿到的是 `task` / `step` / `acceptance` / `tools` 四个键，
`query` 在下一层 —— 于是 `memory.recall` 收到空查询、召回为空，**而且不报错**。
`_flatten_child_payload()` 负责摊平那一层，`test_botd_executors.py` 里有一条断言
专门钉住这个形状。

### `memory_missing` 的语义

ADR-009 与契约 EV-13 都要求"记忆不可用时任务照跑并标 `memory_missing`"。
这条标记的意思是「**这次运行的结论没有外部记忆支撑**」，不是「记忆写失败了」：

| 情形 | `ok` | `memory_missing` | 任务 |
|---|---|---|---|
| 记忆正常且有内容 | true | false | 继续 |
| 全新 bot，召回为空 | true | **true** | 继续（EV-13：「不伪造 recall 结果」） |
| 后端降级 | true | **true** | 继续 |
| 外部写入失败 | true | **true** | 继续（本地已写成功） |
| 参数错（bot_id 空等） | — | — | 抛异常，判失败 |

**记忆挂了不许把任务判失败**：那会让"记忆服务挂了"变成"任务挂了"，
与降级梯度的意思正好相反。


## 6. `letta-client` 与 `requirements-v4.txt` 的关系

**它仍然不进 `requirements-v4.txt` 的主清单**，理由不变：主清单是
**v4 引擎依赖**，而记忆是可降级的那一层。写进清单会让"装齐依赖"变成
"必须装一个只在 W7 才用到的客户端"，与 `docs/operations/environment.md`
的依赖政策（门禁不依赖可选包）冲突。

**但本机已经装上了**（2026-11-08，`letta-client==1.12.1`）。这两件事不矛盾：

| | 状态 | 谁负责 |
|---|---|---|
| 主清单里有没有 | ❌ 没有（可选依赖） | 依赖政策 |
| 本机 venv 里有没有 | ✅ 有 1.12.1 | Bot-5 落地时装的 |
| 没装时能不能跑 | ✅ 能，`available()` 返回假 → 降级 + `memory_missing` | 适配器 |
| 装完清单、门禁全绿、能力却缺失？ | 不会：`deps_smoke.py` 有探针 | 见 §6.1 |

### 6.1 装包的三件事必须一次做完

Bot-5 装包时同时改了 `tools/deps_smoke.py`，加了两条探针。理由：
`letta-client` 的 `import` 一定成功（纯 Python 客户端），真实能力在
**服务端答不答得上话**。只查"包在不在"会得出"装了就算接上了"的错误结论，
而服务没起时那是一次必然超时 —— 正是仓库纪律里点名的错法。

探针有两条，分开报：

| 探针 | 验什么 | 失败时说明 |
|---|---|---|
| `letta-client` | 包能 import | 没装（可选，但本机装了） |
| `letta-service` | 真连一次服务 | 服务没起 → 明确写"不可达"，不是"记忆写入失败" |
