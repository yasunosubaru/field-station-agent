# REPRODUCE.md —— 重跑任一对外数字的步骤清单

*spec §2 的 harness 叶子，M0 DoD 第 4 条（`logs/` 下每个对外数字可用
`tools/audit_claims.py` 回源复核）的操作面：**每个数字怎么来、怎么再跑一遍、
怎么算过**。本文件所有输出片段均为 **2026-10-14 实跑粘贴**；仓库在增长，
代码量类的数字会随你的运行变化 —— 片段是「这条命令真的跑过」的证据，
不是需要逐字对上的期望值；**判据**才是对上的对象。*

## 环境

- Windows / PowerShell；Python 3.11（本机实测 3.11.15）；**纯标准库**
  （唯一可选豁免：`tools/make_cli_figures.py` 的 matplotlib，登记见
  `docs/known-issues.md` KI-09 —— 缺它只影响出图，命令以 exit 2 优雅中止）
- 需要 `git`：代码量两件工具的权威口径是 `git ls-files`
- 全部在**仓库根目录**下执行；带 `PYTHONPATH="src"` 的命令必须先设它
- 本机把 `PYTHONIOENCODING=utf-8` 一起设上可避免管道里中文输出被 GBK 拆散
  （下面片段即如此捕获；不设也能跑，只是重定向到文件时可能乱码）

## 0. 统一入口（可选）

五条纪律命令（除固定测试命令外）都可经 `src/fieldstation/cli.py` 转发，
参数与退出码原样透传（KI-08 落地说明）：

```powershell
$env:PYTHONPATH="src"; python -m fieldstation.cli --help
$env:PYTHONPATH="src"; python -m fieldstation.cli selftest
$env:PYTHONPATH="src"; python -m fieldstation.cli replay --fixture harness/fixtures/replay_20261013.json
$env:PYTHONPATH="src"; python -m fieldstation.cli audit
```

```text
usage: python -m fieldstation.cli [-h]
                                  [{audit,figures,replay,selftest,sync}] ...

仓库统一入口：转发到 harness/ 与 tools/ 的纪律命令（只转发，不重实现）。

positional arguments:
  {audit,figures,replay,selftest,sync}
                        要跑的子命令
  args                  原样转发给目标脚本的参数

options:
  -h, --help            show this help message and exit

子命令对照表：
  selftest  -> harness/selftest.py
  replay    -> harness/replay.py
  audit     -> tools/audit_claims.py
  sync      -> tools/sync_code_counts.py
  figures   -> tools/make_cli_figures.py
各命令自己的参数原样透传，用 <子命令> --help 查看。
```

以下五条是各自脚本的直接用法（入口转发的正是它们，证据即下方各节）。

## 1. 固定测试命令

```powershell
$env:PYTHONPATH="src"; python -m unittest discover -s tests -t .
```

**判据**：`Ran <N> tests` 后是 `OK`，且**没有 `skipped`**
（本仓库 skip==0 是硬门禁：unittest 不把 skip 当失败，静默跳过会让门禁假绿，
见 `harness/selftest.py` 第 1 项）。退出码 0。

```text
....................................................................................................................
----------------------------------------------------------------------
Ran 116 tests in 5.718s

OK
```

## 2. 五项发布门禁

```powershell
$env:PYTHONPATH="src"; python harness/selftest.py
# 只跑其中几项：python harness/selftest.py --item 1,3
```

**判据**：末行 `合计 5/5 PASS`，退出码 0。五项分别是 tests 全绿且
skip==0（读 `result.skipped`，不靠眼看）、无源项目包名残留、
PROVENANCE 与 `src/` 双向一致、同 seed 两次 `config_hash` 相同、
`audit_claims.py` 退出码 0。

**额外（不在五项内）**：`python tools/check_desensitization.py` —— 脱敏守卫，扫入库
文本里的用户目录路径 / 手机号 / 邮箱 / 13 位学号形状 / 私钥 / token；本机词表
`tools/desensitization.local.txt`（gitignored）补姓名等无法公开列词的类别。命中退出 1，
只打印 `文件:行 [类别]`、**不回显内容**（公开 CI 日志不能二次泄露）。它是绊线不是
证明 —— M0 决策第 24 条：两版正则扫描器都给过假的「0 命中」。
**新文件先 `git add` 再跑**：它只扫入库文件，未跟踪的新文件不在扫描范围。

```text
==============================================================================
harness 自检（发布门禁）  ——  2026-10-14 11:05:11
==============================================================================

[1] tests/ 全绿且 skipped == 0（读 result.skipped）
  发现并运行 116 个测试
  失败 0  错误 0  跳过 0
  => PASS

[2] 无源项目包名残留（src/tests/harness/tools 的 .py）
  扫描 src/tests/harness/tools 下 47 个 .py，命中 0 处
  => PASS

[3] PROVENANCE.md 与 src/ 双向一致
  登记 17 行，src/ 下 23 个 .py（其中原创豁免 13 个）
  双向一致：行行有文件，src/ 无漏账
  => PASS

[4] 同 seed 两次 config_hash 相同
  default_cfg 两次   770c10e60b39bd21cbf9e1e101918b38a52f602c3ced5bfbee9932d608673f38
                     770c10e60b39bd21cbf9e1e101918b38a52f602c3ced5bfbee9932d608673f38
  generate 生效配置   770c10e60b39bd21cbf9e1e101918b38a52f602c3ced5bfbee9932d608673f38
                     770c10e60b39bd21cbf9e1e101918b38a52f602c3ced5bfbee9932d608673f38
  换 seed=1          ffe21d35051b909e49e3af71916ac43c63b5b1ab92a49843e8e610541d2cce0b
  => PASS

[5] tools/audit_claims.py 退出码 0
  退出码 0
    声明项            文档中        实测         结论
    ---------------------------------------------------
    入库 Python 文件数  42         42         PASS
    入库 Python 行数   6458       6458       PASS
    入库测试文件数        19         19         PASS

    核对 3 项：PASS 3，FAIL 0，SKIP 0，UNVERIFIED 0

    注：本脚本只判断『文档写的数字是否等于仓库实际状态』，不判断数字背后的业务内容。
  => PASS

==============================================================================
  [1] tests/ 全绿且 skipped == 0（读 result.skipped）        PASS
  [2] 无源项目包名残留（src/tests/harness/tools 的 .py）          PASS
  [3] PROVENANCE.md 与 src/ 双向一致                        PASS
  [4] 同 seed 两次 config_hash 相同                         PASS
  [5] tools/audit_claims.py 退出码 0                      PASS
------------------------------------------------------------------------------
  合计 5/5 PASS
==============================================================================
```

## 3. 回放对拍

```powershell
$env:PYTHONPATH="src"; python harness/replay.py --fixture harness/fixtures/replay_20261013.json
```

真实参数签名（`harness/replay.py`）：`--fixture`（**必填**）、
`--log-dir <dir>`（缺省写仓库 `logs/`）、`--bless`（按当前代码重建期望 ——
有意变更基线的唯一入口，非日常重跑）。

**判据**：`PASS 归因输出与 fixture 期望一致`，退出码 0（1=哈希或
config_hash 漂移，2=用法/IO 错误）。日志重写 `logs/replay_<seed>.json`，
**同种子同代码重跑应与入库版本逐字节相同**（`git status logs/` 干净即证）。

```text
  seed        20261013
  config_hash 770c10e60b39bd21cbf9e1e101918b38a52f602c3ced5bfbee9932d608673f38
  观测        3600 条 / 1800 个历元
  user_input  台站 SYNTH：3600 条观测 / 1800 个历元，注入异常 1 处；GPS 1 L1 历元 400 二阶差分 -1.9734 cycle。请给出归因结论。
sha256: 775435d08a5da1cc1539326fbef750c3f635f1098951d98d484356a124bbd14a
  日志        <仓库根>\logs\replay_20261013.json
  sha256       期望 775435d08a5da1cc1539326fbef750c3f635f1098951d98d484356a124bbd14a 实测 775435d08a5da1cc1539326fbef750c3f635f1098951d98d484356a124bbd14a  -> PASS
  config_hash  期望 770c10e60b39bd21cbf9e1e101918b38a52f602c3ced5bfbee9932d608673f38 实测 770c10e60b39bd21cbf9e1e101918b38a52f602c3ced5bfbee9932d608673f38  -> PASS
PASS 归因输出与 fixture 期望一致
```

（唯一改动：`日志` 行的本机绝对路径按脱敏纪律替换为 `<仓库根>` ——
仓库在公开前已移除本机绝对路径，见 commit `71f7e6d`；其余逐字未动。
重跑时该行显示你的仓库路径、时间戳与耗时会不同，判定看 `PASS` 与退出码。）

### 3.1 M3 结构化结论与工具证据回放

```powershell
$env:PYTHONPATH="src"; python harness/qc_agent_replay.py --fixture harness/fixtures/qc_agent_replay_20261018.json
$env:PYTHONPATH="src"; python harness/qc_agent_replay.py --verify-log logs/qc_agent_replay.json
```

**判据**：第一次命令输出 `PASS 结构化结论、证据引用与 trace 基线一致`；
第二次命令输出 `PASS 证据引用有效：t0001`。两次退出码均为 0。

这条链路用 `config/agents/qc.json` 的真实装配路径，先调用
`magnitude_verdict`，再要求模型给出 `attribution / recommendation / confidence`
结构化结论。证据必须引用成功工具调用的 `call_id`；编造引用会在 replay 时被拒。
决策 trace 与结论保持确定性；token/耗时另写 `logs/qc_agent_metrics.jsonl`，
该旁路文件每次运行会变化，不参与 sha256 基线。

```text
  config_hash 7ab489aca3e740477bb3f6f1c64f0fa84d68fa397a05a16d09b72ee6e1c4b963
  evidence    ['t0001']
  trace       7 events
  metrics     3 events
sha256: a13504d66064d31198eb1f0e2018a419cf19857dd9fcb739a403915c718a4cb4
  expected    a13504d66064d31198eb1f0e2018a419cf19857dd9fcb739a403915c718a4cb4
PASS 结构化结论、证据引用与 trace 基线一致
PASS 证据引用有效：t0001
```

### 3.2 本地模型通道与 5 次复现性探针

```powershell
$env:PYTHONPATH="src"; python tools/probe_provider_live.py --runs 5
```

**判据**：Ollama 可访问；smoke 返回工具调用；5 次回答逐字一致时退出码 0。
记录写 `logs/probe_provider_YYYYMMDD.json`。该探针依赖本机模型服务，不进入
固定测试门禁；入库记录 `logs/probe_provider_20261018.json` 是 2026-10-18 的实测证据。

### 3.3 M4 四类 Agent 回放与验收分数

```powershell
$env:PYTHONPATH="src"; python harness/m4_agents_replay.py --fixture harness/fixtures/m4_agents_replay_20261019.json
$env:PYTHONPATH="src"; python harness/m4_agents_replay.py --verify-log logs/m4_agents_replay.json
```

**判据**：第一次命令输出 `PASS M4 回放基线与 fixture 一致`（5 条场景的
`config_hash` 与 `sha256` 全对）；第二次命令逐场景复校结论证据引用，输出
5 行 `PASS` 加末行 `PASS 5 个场景的证据引用与 checks 全部有效`。两次退出码均为 0。

覆盖哪五条：`device_monitor`（读数含 1 条缺测的空值负例）、`fault_diagnosis`
（证据同时挂 `magnitude_verdict` / `knowledge_search` / `station_health` 三条
工具输出）、`operations_dispatch+`（高风险动作过审批门并放行）、
`operations_dispatch-`（同一动作被驳回、不执行；两条路径的审批 verdict 与
动作是否执行都进 trace）、`archive`（`synthetic=true` 强制进 `synthetic/`
子目录 + `SYNTHETIC_` 前缀，落盘文件名核对）。

M4-2 的「回放分数不劣于 M3 基线」对照第 3.1 节 M3 基线（结论契约 valid、
证据引用有效）：本回放 summary 为 `scenarios 5/5 valid, checks 14/14,
evidence 9/9, not_worse_than_m3=True`。token/耗时同样另写
`logs/m4_agents_metrics.jsonl` 旁路文件，不参与 sha256 基线。

```text
  device_monitor           checks 2/2  sha256 9c233ac2fc7f…  PASS
  fault_diagnosis          checks 2/2  sha256 99ec58d5a29c…  PASS
  operations_dispatch+     checks 4/4  sha256 d88684f45619…  PASS
  operations_dispatch-     checks 4/4  sha256 015cac7829a5…  PASS
  archive                  checks 2/2  sha256 d53db74eb657…  PASS
  summary scenarios 5/5 valid, checks 14/14, evidence 9/9, not_worse_than_m3=True
  expected    37ba8911cb089e6aa41d05c82b324bf1924e0952a8e437221f1863e4342cdcf9
sha256: 37ba8911cb089e6aa41d05c82b324bf1924e0952a8e437221f1863e4342cdcf9
PASS M4 回放基线与 fixture 一致
PASS device_monitor: 证据引用 t0001；checks 全过
PASS fault_diagnosis: 证据引用 t0001, t0002, t0003；checks 全过
PASS operations_dispatch+: 证据引用 t0001, t0002；checks 全过
PASS operations_dispatch-: 证据引用 t0001；checks 全过
PASS archive: 证据引用 t0001, t0002；checks 全过
PASS 5 个场景的证据引用与 checks 全部有效
```

（以上片段为 2026-10-19 实跑粘贴。同日二跑：`store/product.py::write_json` 钉 LF
（PROVENANCE.md 有登记，起因是 M5-1 发现归档 sha 进 trace 会让回放成为宿主机函数）
——`archive` 场景 sha 与 log sha 随之变更（`e7f1890c…` → `d53db74e…`、
`1a2e7ef1…` → `37ba8911…`），其余四场景 sha 未变。）

### 3.4 知识库抽查（构造问题 + 开放探针）

```powershell
$env:PYTHONPATH="src"; python tools/build_knowledge_base.py
```

**判据**：退出码 0；输出 `in_scope=10 hits=10 hit_rate=1.000`；重建
`data/kb/knowledge.sqlite3` 并重写 `logs/kb_smoke_20261019.json`。

怎么读这份记录（**别把 10/10 当成「已解决知识检索」**）：`in_scope` 的 10 条
问题按库内 10 条规程**逐条反推措辞**，问题与条目一一对应，命中率只证明检索
通路与切词在工作，不代表开放查询的泛化命中率；`probes` 是库内没有对应条目的
开放问题，记录不命中/弱命中的实际行为——空结果表示正确报告无覆盖，非空只是
词面相近的弱命中（见 `top3`），**不构成知识覆盖**。

```text
documents=10 in_scope=10 hits=10 hit_rate=1.000
probes=3 empty=1
db=<仓库根>\data\kb\knowledge.sqlite3
log=<仓库根>\logs\kb_smoke_20261019.json
```

（`db`/`log` 行重跑时显示你的仓库路径。探针实测：2 条词面相近弱命中
`qc-nonphysical-rmse` / `network-loss`，1 条空——见记录文件 `probes` 节，
`empty=true` 表示无覆盖。）

### 3.5 M5 全链回放（观测数据进，工单与归档出）

```powershell
$env:PYTHONPATH="src"; python harness/m5_pipeline_replay.py --fixture harness/fixtures/m5_pipeline_replay_20261020.json
$env:PYTHONPATH="src"; python harness/m5_pipeline_replay.py --verify-log logs/m5_pipeline_replay.json
```

**判据**：第一条命令输出 5 行阶段 `PASS` 加末行 `PASS M5 回放基线与 fixture 一致`；
第二条逐阶段复校结论证据引用（含**结论正文里**的证据列表）与 checks，末行
`PASS 5 个阶段、7 条消息、checks 10/10 全部有效`。两次退出码均为 0。

链路：`intake` 发两条消息（观测批次 + BADG 设备读数）→ `qc` → `device_monitor`
→ `fault_diagnosis` → `operations_dispatch`（高风险动作过审批门）→ `archive`，
共 7 条消息；每条消息以 `message` 事件**全量**落同一条 trace（M5-4 的核对
建立在这条上）。每个阶段在 `run_start` 之前另有一条 `stage_input` 事件
（`note` + 消费的 `msg_ids` + `input_digest`），所以只看日志也能还原「模型被交代了
什么任务、读了哪几条消息」（KI-11）。

**样本口径（替代口径，不是真实台站样本）**：真实样本受 #28/#33 阻塞（成员侧
脱敏样本未到）。本基线用固定种子合成样本：`seed=20261013`、`station=BADG`、
`n_epochs=60`、`systems=["GPS"]`、`sats={"GPS":[1,2]}`、生成器 `slips=[]`；
后处理把 GPS 01 的 L1 相位自第 30 个历元起整体 +5.0 cycles（持续阶跃）。
实测该步长在 `slip_detect` 的 gf/mw 双通道均命中（counts 全 1、
`slip_indices=[30]`），GPS 02 全 0。真实样本到位后：换样本、同一条命令加
`--bless` 复跑，场景与 checks 不用改。

```text
  qc                   sha256 be282c14faf8…  PASS
  device_monitor       sha256 3b1f8cce9b6e…  PASS
  fault_diagnosis      sha256 f8d76d3e7313…  PASS
  operations_dispatch  sha256 e53fe3e61676…  PASS
  archive              sha256 599ac6ff9fdf…  PASS
  summary 5 阶段, checks 10/10, 7 条消息, tokens 2140/412
  expected    04fa5d7ce63405cd4aab478ae90ef79433229529680195dfbc30ffd87a335ded
sha256: 04fa5d7ce63405cd4aab478ae90ef79433229529680195dfbc30ffd87a335ded
PASS M5 回放基线与 fixture 一致
```

（以上片段为 2026-10-19 实跑粘贴；单次回放约 0.3 s。逐次耗时另写
`logs/m5_pipeline_metrics.jsonl` —— **耗时等非确定性量不进 sha256 基线**，
token 用量是脚本化响应算出的确定性量，进基线。）

这一段同时是「归档字节跨平台一致」的守卫：归档产物的 sha256 会进入回放
trace，若 `store/product.py::write_json` 按平台写换行（Windows CRLF / Linux
LF），同一基线在两平台就会算出不同的顶层 sha。2026-10-19 已钉 LF
（PROVENANCE.md 有登记；本机回归测试 `tests/test_pipeline.py::
test_write_json_pins_lf_line_endings`），且 `tests/test_m5_pipeline_replay.py`
会在 CI（Linux）上重跑已提交 fixture 与 log。

同一守卫也覆盖本 harness 自己写的 fixture 与日志：`_write_json` 钉 LF
（2026-10-19 修复 —— Windows 默认写 CRLF，会让「照本节跑一遍」后工作区里的
fixture/日志与入库版本字节不同，而 `.gitattributes` 的归一化让 `git status`
看不出来；回归测试 `tests/test_m5_pipeline_replay.py::
test_written_fixture_and_log_pin_lf` 钉死）。

### 3.6 运行看板（M5-3）

```powershell
$env:PYTHONPATH="src"; python tools/make_station_dashboard.py
```

从已提交的 M5-1 日志生成三类视图（台站健康度 / 告警 / 工单）：

- `figures/m5_dashboard.html` —— 单文件静态页（内联 CSS，无 JS、无外部资源）；
- `logs/m5_dashboard.json` —— 机读摘要（计数、健康度、告警、工单、源日志 sha、
  页面 sha），供数字回源。

实跑输出（2026-10-19）：

```text
[OK] 页面 figures/m5_dashboard.html（4905 B，sha256 849ff2031b4a5f5b…）
[OK] 摘要 logs/m5_dashboard.json：台站 1 / 告警 2 {'warn': 2} / 工单 1
```

口径（健康度只读 `station_health` 的结果、不复算阈值；告警两条机械规则；工单字段）
见 `docs/operations/dashboard.md`。数据流是「日志 → 黑板（M5-2）→ `snapshot()`」；
页面不含生成时间戳（只含数据时间），同一份日志两次生成逐字节相同（`tests/test_m5_dashboard.py` 钉死）。
样本口径同 §3.5：真实样本受 #28/#33 阻塞，当前用固定种子合成样本的替代口径。

### 3.7 审批门端到端联调（M5-4）

```powershell
$env:PYTHONPATH="src"; python harness/m5_approval_audit.py
```

与 M5-1 **同一装配**跑两条完整链，只换审批者：放行（`ApproveAll`）与拒绝
（`RejectAll`）。实跑输出（2026-10-19）：

```text
放行路径：7 条消息，trace sha256 65055e44a6567418…
拒绝路径：停在审批门（5 条消息），trace sha256 a92df577498cabe9…
checks 13/13：全部通过
[OK] 审计记录 logs/m5_approval_audit.json
```

核对项（13 条，任一条失败退出码 1）：放行 trace 的规范 sha 等于 M5-1 基线
（`logs/m5_pipeline_replay.json` 的 `trace_sha256`）；消息 ↔ trace 双射（msg_id 与
payload 规范 JSON 一致）；payload 全量（不是 digest）；refs 闭合；放行路径恰一条
`approved` 审批记录且动作 accepted/simulated；拒绝路径恰一条 `rejected` 记录、
动作 `tool_call.approved=false` / `tool_result.ok=false`（「未获人工批准，未执行」）、
没有 `dispatch.work_order` / `archive.done` 消息、阶段结论被 `ConclusionRejected`
拒绝（`t0002 不存在于成功的工具调用中`）。

审计记录确定性（无时间戳/耗时、钉 LF、两次生成逐字节相同）；
`tests/test_m5_approval_audit.py`（4 条）含一条**负例**：把「拒绝」换成放行，
审计必须失败 —— 防止这个审计只是在自证「跑完了」。

### 3.8 环境快照与干净环境重跑（M7-3 的一部分）

```powershell
python tools/env_snapshot.py            # → logs/env_snapshot_<日期>.json
```

快照记录 Python / OS / git commit / 第三方 import / 模型通道；**不含**本机路径、
用户名、环境变量值（`tests/test_env_snapshot.py` 钉住）。`third_party_imports`
当前只有 `matplotlib`（仅 `tools/make_cli_figures.py` 可选使用）；测试与门禁只用标准库。

干净环境（同一台机器全新 venv）重跑记录：`logs/clean_room_20261020.txt`
（8 条命令全部退出 0：unittest / selftest / audit_claims / M5 回放对拍 /
`--verify-log` / 审批审计 / 看板 / 脱敏守卫）。跨平台由 CI（ubuntu-latest）覆盖；
真正的干净机器验证与真实样本一起等 #69 的收尾条件。详见
`docs/operations/environment.md`。

## 4. 数字回源核对

```powershell
python tools/audit_claims.py          # 缺省核对 README.md 机维护块
python tools/audit_claims.py --doc PATH   # 核对任意交付文档
```

**判据**：`核对 3 项：PASS 3，FAIL 0，SKIP 0，UNVERIFIED 0`，退出码 0
（1=存在不符或无法回源，2=找不到文档/空口径）。它回源的三个数字
（入库 Python 文件数/行数/测试文件数）与第 5 节的同步工具**共用同一口径**。

```text
声明项            文档中        实测         结论
---------------------------------------------------
入库 Python 文件数  88         88         PASS
入库 Python 行数   14659      14659      PASS
入库测试文件数        48         48         PASS

核对 3 项：PASS 3，FAIL 0，SKIP 0，UNVERIFIED 0

注：本脚本只判断『文档写的数字是否等于仓库实际状态』，不判断数字背后的业务内容。
```

## 5. 同步 README 机维护块（数字过时后才需要）

```powershell
python tools/sync_code_counts.py
```

**判据**：`[OK] 已同步 README.md`，退出码 0；随后**必须回跑第 4 节**
确认全 PASS（同步与核对是一对，只同步不核对等于没人验收）。

**口径注意**：计数走 `git ls-files` —— **新文件要先 `git add` 才计数**，
未入库文件一律不计（这正是"入库代码量"的定义，不是缺陷）。

```text
  src/+tests/ 入库 .py：42 文件，6,458 行，其中测试 19 个
[OK] 已同步 README.md
```

## 6.（可选）出图

```powershell
python tools/make_cli_figures.py                    # 缺省渲染 audit_claims 的真实输出
python tools/make_cli_figures.py --command "..." --out figures
```

**判据**：退出码 0 且 `figures/` 出现 PNG。matplotlib 缺席时 **exit 2 +
`[阻断]` 文案**，不采集、不建目录、不产假图（实测证据见
`tests/test_make_cli_figures.py` 与 KI-09）。图里每个字来自真实运行输出。

## 数字 → 复现路径对照

| 对外数字 | 在哪 | 重跑 |
|---|---|---|
| 入库文件数 / 行数 / 测试文件数 | README 机维护块 | 第 5 节同步 + 第 4 节回源 |
| 测试总数、skip==0 | README「现状」行 / 各报告 | 第 1 节（判据含 skipped==0） |
| 五项门禁 5/5 | README「现状」行 | 第 2 节 |
| 归因回放 sha256 | `logs/replay_20261013.json` | 第 3 节（与 fixture 对拍） |
| M3 结构化结论回放 sha256 | `logs/qc_agent_replay.json` | 第 3.1 节（并与证据引用复校） |
| M4 四类 Agent 回放 sha256 | `logs/m4_agents_replay.json` | 第 3.3 节（与 fixture 对拍 + 证据复校） |
| M5 全链回放 sha256 | `logs/m5_pipeline_replay.json` | 第 3.5 节（与 fixture 对拍 + 证据复校） |
| 运行看板（台站 / 告警 / 工单）与页面 sha | `logs/m5_dashboard.json` | 第 3.6 节（重跑生成器，输出与入库逐字节一致） |
| 审批门联调与消息 trace 核对 | `logs/m5_approval_audit.json` | 第 3.7 节（重跑审计，13/13） |
| 环境快照（Python / OS / 依赖 / 模型） | `logs/env_snapshot_<日期>.json` | 第 3.8 节（重跑快照工具） |
| 知识库抽查命中率与探针行为 | `logs/kb_smoke_20261019.json` | 第 3.4 节（重建索引后重跑） |
| CLI 插图内容 | `figures/`（如已出图） | 第 6 节（重跑命令即重取输出） |

## 退出码速查

| 命令 | 0 | 非 0 |
|---|---|---|
| unittest 固定命令 | 全绿且 skip 0 | 1=失败/错误；出现 `skipped=N` 视为失败 |
| `harness/selftest.py` | 被选项全 PASS | 1=任一 FAIL；2=用法错误 |
| `harness/replay.py` | 与 fixture 期望一致 | 1=漂移；2=用法/IO 错误 |
| `harness/qc_agent_replay.py` | 基线一致或日志证据有效 | 1=漂移/证据无效；2=用法/IO 错误 |
| `harness/m4_agents_replay.py` | 基线一致或日志证据有效 | 1=漂移/证据无效；2=用法/IO 错误 |
| `harness/m5_pipeline_replay.py` | 基线一致或日志证据有效 | 1=漂移/证据无效；2=用法/IO 错误 |
| `tools/make_station_dashboard.py` | 页面与摘要生成完成 | 1=日志缺数据或告警无法归属；2=用法/日志不可读/非 UTF-8 |
| `tools/check_desensitization.py` | 命中 0 处 | 1=有命中；2=用法/非 git 仓库/词表被跟踪 |
| `tools/env_snapshot.py` | 快照写入 | 2=用法/非 git 仓库 |
| `harness/m5_approval_audit.py` | 13 项核对全过 | 1=有核对项失败；2=用法/IO 错误 |
| `tools/audit_claims.py` | 全部核对项通过 | 1=FAIL/UNVERIFIED；2=文档缺失/空口径 |
| `tools/sync_code_counts.py` | 已同步 | 2=找不到 README 锚点/空口径 |
| `tools/make_cli_figures.py` | 采集并渲染完成 | 2=matplotlib 缺席/用法错误 |
| `src/fieldstation.cli` | 透传目标的 0 | 2=未知/缺子命令；其余透传目标退出码 |
