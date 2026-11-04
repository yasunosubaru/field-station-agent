# v4 的 Python 依赖：装在哪、干什么、缺了怎么办

状态：初版（2026-11-05，本机实测）

v4 的 E2/E3/E4/E6 要用第三方库，而仓库原有的门禁（`unittest discover` / `harness/selftest.py` /
回放 / 审计 / 看板 / 脱敏）**一个都不依赖它们** —— `docs/operations/environment.md` 的
「只用标准库」政策不变，新增的只是引擎运行时的可选依赖。所以这份文件管两件事：
**怎么把这套装起来**，以及**缺了哪个引擎会退到哪**。

| 物 | 位置 | 入库 |
|---|---|---|
| 虚拟环境 | `.deps/venv`（Python 3.11.15） | 否（见末节） |
| 清单 | `requirements-v4.txt`（48 条钉版本） | 是 |
| 冒烟 | `tools/deps_smoke.py` | 是 |

## 1. 现场记录（2026-11-05 本机实测）

| 包 | 版本 | 自身占用 | 本项目里干什么 | 引擎 |
|---|---|---|---|---|
| `duckdb` | 2.0.0 | 43.5 MB | 直接读 Parquet 分区做聚合：批次、质控统计、20 条基准 SQL | E4；E5 的查询口 |
| `langgraph` | 1.2.19 | 2.2 MB | 五阶段 StateGraph、结论契约、闸门挂起/恢复、checkpointer | E3 |
| `pydantic-ai` | 2.66.0 | 0.1 MB（实体在 `pydantic-ai-slim` 19.3 MB） | Supervisor/worker 的 agent 抽象：结构化输出 + 工具调用 | E2 |
| `dbos` | 3.4.0 | 2.7 MB | 持久化执行：`bot.task.run` 的 workflow/step 表、队列、cron、崩溃续跑 | E2 |
| `llama-index-core` | 0.14.25 | 25.8 MB | 索引「元数据卡 + 手册 + 报告」，带出处的检索 | E6 |
| `llama-index-vector-stores-lancedb` | 0.6.0 | 0.1 MB（实体在 `lancedb` 235 MB / `pylance` 266 MB） | 上面的向量库后端 | E6 |
| `pandas` | 3.1.1 | 72.9 MB | **补偿项**，见 §3 坑 1；不是我们选的，是上游漏声明的 | E6 |

磁盘：`.deps/venv` 整目录 **1,143.4 MB / 37,528 个文件**；`site-packages` 记账口径
1,143.0 MB / 167 个发行版。

分批实测（各自从零建 venv 量出来的，不是估算）：

| 批次 | 内容 | 体积 | 文件数 |
|---|---|---|---|
| 第一批 | `duckdb` `langgraph` `pydantic-ai` `dbos` + 它们的依赖 | **328.8 MB** | 27,275 |
| 第二批 | 再加 `llama-index-core` `llama-index-vector-stores-lancedb` | **+814.6 MB** | +10,253 |

第二批贵在 `pylance` 266 MB、`lancedb` 235 MB、`pyarrow` 89 MB、`pandas` 73 MB、`numpy` 54 MB
—— 这五个加起来 717 MB，占整包 **63%**。只跑 E2/E3/E4 的话，第二批可以不装（见 §4）。

## 2. 重建

```powershell
# 用哪个 python 都行，要求 3.11+；本机实测用的是 uv 的独立 3.11
python -m venv .deps/venv

.deps/venv/Scripts/python.exe -m pip install --timeout 60 `
    -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements-v4.txt

# 验收：逐包打印版本，全 ok 退出 0
.deps/venv/Scripts/python.exe tools/deps_smoke.py
```

- **不设全局 pip 配置**，镜像只写在命令行上（`-i`），也不动用户 `site-packages`。
- 装完 ≈ 1.1 GB。想省一半以上就只装第一批：把 `requirements-v4.txt` 里「目标包」组的
  后两行和「补偿项」删掉再装，或者直接
  `pip install ... duckdb langgraph pydantic-ai dbos`（328.8 MB），
  然后 `deps_smoke.py --tier core` 验收。
- `deps_smoke.py` 可以钉版本：`--expect duckdb=2.0.0 --expect dbos=3.4.0`，
  版本不符算 fail。CI 上建议这么钉，否则"能 import"会掩盖"装的不是验过的那套"。

**可复现性验到什么程度**：把 `requirements-v4.txt` 拿到一个已装好的环境里
`pip install --dry-run --ignore-installed --report <json> -r requirements-v4.txt`，
解析结果是 **166 个包、版本与本机 `pip freeze` 逐个相等，0 处差异**。
也就是说这份清单不只是"装得上"，它当下解析出来的就是这台机器上那套。

## 3. 三个会让人误判「已经装好了」的坑

1. **`llama-index-vector-stores-lancedb` 漏声明 `pandas`。**
   它的 `base.py` 第 33 行写死 `from pandas import DataFrame`，但 `Requires-Dist` 里没有
   `pandas`。只装它声明的四个依赖（`lancedb`/`llama-index-core`/`pylance`/`tantivy`）后，
   `import llama_index.vector_stores.lancedb` 抛 `ModuleNotFoundError: pandas`。
   首次安装就是这样，冒烟当场报出来的。清单末尾的「运行期补偿」组就是为它留的。
2. **`requirements-v4.txt` 的第一行必须是 PEP 263 编码 cookie。**
   pip 读 requirements 文件时先找 BOM，找不到就按**本地代码页**解码（中文 Windows 是 GBK）。
   文件里有中文注释，没有 `# -*- coding: utf-8 -*-` 那行时
   `pip install -r` 直接 `UnicodeDecodeError: 'gbk' codec can't decode byte 0x84` 退出。
   加 BOM 也能解，但 BOM 会污染 diff 和别的工具，所以用注释形式。
3. **`pydantic-ai` 只占 0.1 MB，别以为装漏了。**
   它是个只拉 extras 的 meta 包，实体在 `pydantic-ai-slim`；同理
   `llama-index-vector-stores-lancedb` 0.1 MB、实体在 `lancedb`/`pylance`。
   看体积要看 freeze，不要看目标包自己。

## 4. 缺了怎么降级

降级梯度不是这张表临时编的：**ADR-009 已经写死了几条**。§2 的降级梯度直接给了 DBOS 与
LangGraph 两条（同一节第三条是 Letta，Letta 不在本次装的包里，故不列）；§3 那条
「引擎不可用必须明示、不许静默」是硬约束，DuckDB 一行照此办。
剩下三条（`pydantic-ai`、`llama-index-core`、向量库）ADR 没覆盖，是按 ADR 的口径推的，
标了「待确认」—— **不是已经拍板的决定**，动之前先找人确认。

| 缺的包 | 会丢什么 | 降级路径 | 依据 |
|---|---|---|---|
| `dbos` | 执行真相：崩溃续跑、exactly-once、cron | 退 APScheduler + 自己的队列表；**丢 exactly-once，必须明确告知**，不许假装还在 | ADR-009 §2 降级梯度第 2 条 |
| `langgraph` | 五阶段图、闸门挂起/恢复、checkpointer | 退 `pipeline.py`（本来就有）：判断变简单，**验收分数如实下降**，不粉饰 | ADR-009 §2 第 3 条；W6「未装 langgraph 时 `pipeline.py` 照跑」 |
| `duckdb` | E4 的默认查询引擎 | 只剩 ClickHouse 一条腿（还要它自己的二进制在场）或 pandas 扫 Parquet；W8 的「单站单日 ≤1.5 s」达不到，数据台顶部**必须明示**引擎不可用，不许静默 | ADR-009 §3（"不许静默"是硬约束） |
| `pydantic-ai` | E2 的 agent 抽象（结构化输出 + 工具调用） | 退成写死的确定性步骤 + `pydantic` 模型校验（`pydantic` 是它的依赖，仍在）；该类任务标 `runtime_missing`，LLM 只留在 E1 的两个运行时里 | **待确认** |
| `llama-index-core` | E6 的知识索引与「带出处」检索 | 退 E4 的 Text-to-SQL + SQLite FTS/台账全文检索；答案必须标「未建索引」，**不许编出处** | **待确认** |
| `llama-index-vector-stores-lancedb` | 向量后端 | 换 Chroma（E5 本来就带它，ADR 把 Chroma 列为向量库）；换库要重建索引，台账里的向量 id 全部失效 | ADR-009 §4（E5 含 Chroma）；具体切换流程**待确认** |
| `pandas` | 上一条根本 import 不进来 | 没有降级：等于整块向量库没有。装上即可 | 见 §3 坑 1 |

共同纪律（ADR-009 的原始要求，降级时不能破）：
**降级必须显式**——UI/日志要说清"哪个引擎退到了哪条路"，并把降级写进当次产物；
静默降级的结果是分数掉了没人知道为什么，比装不上更糟。

## 5. `.deps/` 与 `.gitignore`

`.deps/` 已经整体被忽略，依据是 `.gitignore` 第 57–58 行：

```text
# v4 本地依赖（venv / opencode / clickhouse，可达 1 GB 级）：绝不入库
.deps/

$ git check-ignore -v .deps/venv/Lib/site-packages/duckdb/__init__.py
.gitignore:58:.deps/    .deps/venv/Lib/site-packages/duckdb/__init__.py
```

这条**不是本次改动加的**（本次只写 `.deps/**`、`requirements-v4.txt`、`tools/deps_smoke.py`、
本文件）。装依赖时 `.gitignore` 里还只有第 9 行的 `venv/`，那时 `.deps/venv/` 属于
"碰巧被 `venv/` 规则吃掉"，而 `.deps/` 下放 `venv` 以外的东西就会冒出未跟踪文件；
装完依赖、收工之前，`.deps/` 这一条才由另一次改动补上。现在整棵目录都不入库，随便往里放本机产物
都不会污染 `git status`。

`.deps/` 是**共用**的本机目录（别的改动会往 `.deps/opencode` 放运行时二进制、
往 `.deps/clickhouse` 放高性能引擎），收工时整棵 `.deps/` 是 1,613 MB，其中本文件这套
venv 占 1,143 MB。所以本次没往里面丢 `venv` 之外的东西，全量快照放在本文件末尾。

## 6. 验收（本机实跑）

```text
$ .deps/venv/Scripts/python.exe tools/deps_smoke.py
python: 3.11.15  (...\.deps\venv\Scripts\python.exe)
tier:   all（6 个包）

package                                version        status purpose
----------------------------------------------------------------------------------------
duckdb                                 2.0.0          ok     E4/E5 数据查询
langgraph                              1.2.19         ok     E3 五阶段编排
pydantic-ai                            2.66.0         ok     E2 agent 运行时
dbos                                   3.4.0          ok     E2 持久化执行
llama-index-core                       0.14.25        ok     E6 知识索引
llama-index-vector-stores-lancedb      0.6.0          ok     E6 向量库
----------------------------------------------------------------------------------------
结果: 6/6 ok                                # 退出码 0

$ .deps/venv/Scripts/python.exe -c "import duckdb,langgraph,pydantic_ai,dbos; print('ok')"
ok

$ .deps/venv/Scripts/python.exe tools/deps_smoke.py --expect duckdb=9.9.9
... 结果: 5/6 ok，缺 1 个：duckdb 版本应为 9.9.9，实际 2.0.0     # 退出码 1（负例）

$ python tools/deps_smoke.py --tier core        # 不带这套依赖的系统 python
... 0/4 ok，缺 4 个：duckdb / langgraph / pydantic-ai / dbos       # 退出码 1，无 traceback
```

负例是故意跑的：只跑正例的话，"永远退出 0"和"真的检查了"看起来一模一样。

## 7. 没做的

- **`docs/operations/environment.md` 没登记**：门禁第 6 条要求「新增第三方依赖必须在
  `docs/operations/environment.md` 登记」，那份文件不在本次可写范围（别人在改），
  所以留在待办里，不是忘了。
- **CI 没接**：`deps_smoke.py --tier core` 还没有挂进 workflow；现在只有本机能跑。
- **没在第二台机器/干净系统上重建过**：本文的体积与版本都来自同一台机器，
  跨机器复现只经过 `--dry-run` 的解析比对（166 个包版本全等），没有实装比对。

---

## 附录：2026-11-05 全量快照（不作为约束）

`pip freeze --all` 的逐字输出，共 167 个发行版（含 venv 自带的 `pip`、`setuptools`）。它是**记录**，
不是钉法：真正的约束是 `requirements-v4.txt`，这份快照用来在将来对账
「当时那台机器到底装了哪些传递依赖」。

````text
aiofile==3.12.3
aiohappyeyeballs==2.7.1
aiohttp==3.14.5
aiosignal==1.4.0
aiosqlite==0.22.1
annotated-types==0.8.0
anthropic==2.4.0
anyio==4.16.0
argcomplete==3.7.2
attrs==26.1.0
Authlib==1.9.4
banks==2.5.1
beartype==0.23.1
cachetools==7.2.8
caio==0.12.10
certifi==2026.10.23
cffi==2.1.1
charset-normalizer==3.5.2
click==8.5.0
cloudpickle==3.1.2
colorama==0.4.6
croniter==6.2.4
cryptography==50.0.2
dataclasses-json==0.6.7
dbos==3.4.0
defusedxml==0.7.1
Deprecated==1.3.1
deprecation==2.1.0
dirtyjson==1.0.8
distro==1.9.0
dnspython==2.9.2
docstring_parser==0.18.0
duckdb==2.0.0
email-validator==2.3.0
exceptiongroup==1.3.1
executing==2.3.0
fastmcp-slim==4.1.6
filetype==1.2.0
frozenlist==1.8.0
fsspec==2026.9.0
genai-prices==0.2.1
google-auth==2.62.1
google-genai==2.34.0
googleapis-common-protos==1.76.0
greenlet==3.5.6
griffe==2.4.1
griffecli==2.4.1
griffelib==2.4.1
h11==0.16.0
httpcore==1.0.9
httpcore2==2.16.0
httpx==0.28.1
httpx2==2.16.0
idna==3.20
Jinja2==3.1.6
jiter==0.18.0
joblib==1.6.0
joserfc==1.8.0
jsonpatch==1.42
jsonpointer==3.8
jsonschema==4.26.0
jsonschema-specifications==2025.9.1
lance-namespace==0.13.0
lance-namespace-urllib3-client==0.13.0
lancedb==0.41.0
langchain-core==1.7.5
langchain-protocol==0.0.20
langgraph==1.2.19
langgraph-checkpoint==4.3.1
langgraph-prebuilt==1.1.1
langgraph-sdk==0.4.12
langsmith==0.14.17
llama-index-core==0.14.25
llama-index-instrumentation==0.6.0
llama-index-vector-stores-lancedb==0.6.0
llama-index-workflows==2.26.1
logfire==5.4.0
logfire-api==5.4.0
logfire-sdk==5.4.0
markdown-it-py==4.2.0
MarkupSafe==3.0.4
marshmallow==3.26.2
mcp==2.3.0
mcp-types==2.3.0
mdurl==0.1.2
multidict==7.2.1
mypy_extensions==1.2.0
nest-asyncio==1.6.0
networkx==3.6.1
nltk==3.10.4
numpy==2.4.6
openai==3.45.0
opentelemetry-api==1.45.2
opentelemetry-exporter-http-transport==0.66b2
opentelemetry-exporter-otlp-common==0.66b2
opentelemetry-exporter-otlp-proto-common==1.45.2
opentelemetry-exporter-otlp-proto-http==1.45.2
opentelemetry-instrumentation==0.66b2
opentelemetry-instrumentation-httpx==0.66b2
opentelemetry-proto==1.45.2
opentelemetry-sdk==1.45.2
opentelemetry-semantic-conventions==0.66b2
opentelemetry-util-http==0.66b2
orjson==3.13.0
ormsgpack==1.13.0
overrides==7.7.0
packaging==26.3
pandas==3.1.1
pillow==13.0.0
pip==24.0
platformdirs==4.14.5
prompt_toolkit==3.0.53
propcache==0.5.4
protobuf==7.36.2
psycopg==3.3.8
psycopg-binary==3.3.8
py-key-value-aio==0.4.6
pyarrow==26.0.1
pyasn1==0.6.5
pyasn1_modules==0.4.2
pycparser==3.12
pydantic==2.14.2
pydantic-ai==2.66.0
pydantic-ai-slim==2.66.0
pydantic-evals==2.66.0
pydantic-graph==2.66.0
pydantic-settings==2.16.2
pydantic_core==2.50.2
Pygments==2.21.0
PyJWT==2.15.1
pylance==14.0.2
pyperclip==1.11.0
python-dateutil==4.0.0
python-dotenv==1.2.4
python-multipart==0.0.33
pywin32==312
PyYAML==6.0.3
referencing==0.37.0
regex==2026.9.29
requests==2.34.2
requests-toolbelt==1.0.0
rich==15.0.0
rpds-py==2026.9.1
setuptools==84.2.1
sniffio==1.3.1
SQLAlchemy==2.1.8
sse-starlette==3.6.0
starlette==1.10.0
tantivy==0.27.0
tenacity==9.1.4
tiktoken==0.14.0
tinytag==2.3.2
tqdm==4.70.1
truststore==0.10.5
typing-inspect==0.9.0
typing-inspection==0.4.5
typing_extensions==4.16.0
tzdata==2026.6
urllib3==2.8.0
uuid_utils==0.19.0
uvicorn==0.54.0
wcwidth==0.9.4
websockets==17.4
wrapt==2.5.2
xxhash==4.0.2
yarl==1.25.1
zstandard==0.25.0
````
