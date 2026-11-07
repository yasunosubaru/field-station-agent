# 30 条验收任务的判分：怎么跑、怎么读

- 状态：**判分器已落地（2026-11-07）；30 条报告本身还没有**（缺的是两个运行时的真实日志，不是判分能力）
- 契约：`docs/contracts/eval-30.md`（任务清单与 S1–S6 规则，权威）
- 工具：`tools/eval30_judge.py`；覆盖：`tests/test_eval30_judge.py`（47 项）
- 一句话：**判分机械、口径从契约现取**；能机判的只有一部分，剩下的人判项**单列，不算通过**。

---

## 1. 为什么要有独立的判分器

契约 §3.3 要求「两个运行时各出一份每条一行的报告」。如果判分靠人读日志填表：

- 两份报告出自两次不同的主观判断，**没有可比性**；
- 而契约的初衷恰恰是「各自独立跑完 30 条、不排名」—— 主观判分让这句话落空；
- 更糟的是判分器自己太宽容这种错法**不会报错**，只会让结论变好看。

所以判分必须机械。`tools/eval30_judge.py` 只做一件事：**读事件 JSONL，输出报告行**。

## 2. 口径从契约现取，不在脚本里另写一份

30 条任务的 id、期望工具链、判分规则、数值区间与精确值**全部当场从
`docs/contracts/eval-30.md` 的 §2 表里解析**。

硬编码一份副本的唯一结局是：契约改了、脚本没改，然后两边各自"自洽"。这与
`tools/audit_claims.py` 的纪律同源（期望值从文档取）。

解析器**失明即硬失败**：解析出 0 条任务时退出码 2，绝不会"0 条全部通过"。

## 3. 六条规则里，哪些真的能机判

| 规则 | 能否机判 | 判据 |
|---|---|---|
| **S1** 工具链 | ✅ | 期望工具名按顺序作为**子序列**出现。子序列而非全等，因为契约 §1.2 写明「未注明『恰好』时允许插入只读补充调用」 |
| **S2** 证据闭合 | ✅ | 结论 `attribution.evidence[].call_id` 逐个回查 `tool.result(ok=true)`；工具名必须一致；不得重复引用；至少一条 |
| **S3** 字段与数值 | ⚠️ 部分 | 结论走 ADR-004 校验（复用 `fieldstation.agents.conclusion`）；契约写成 `字段∈[a,b]` 或 `字段=数字` 的自动核对。**散文里的数值不猜** |
| **S4** 产物回源 | ✅ | `artifact_ref.sha256` 等于磁盘哈希；`bytes` 一致；路径必须在 `artifacts/` 下；文件必须存在 |
| **S5** 审批合规 | ✅ | pending 期间同 `call_id` 无 `tool.result`；`approval.result` 先于 `tool.result`；拒绝后不得有 `ok=true` 的副作用；请求不得悬空 |
| **S6** 边界与确定 | ⚠️ 部分 | 只有 **EV-08**（零工具调用）与 **EV-20**（`E_READONLY` 且 `ok=false`）可机判 |

### S3 的一个关键设计：数值要查两处

契约 §3.4 把「数字与工具返回不一致（包括四舍五入后看起来一样）」列为**不算通过**。
所以 S3 的数值同时从两处取：

1. 结论 JSON 里模型复述的数；
2. `tool.result.data` 里工具真正返回的数。

只查一处会得出两种相反的错误结论：只查结论会漏掉「工具给了 45、模型写了 47」，
只查工具会放过「模型自己编了个数」。**两处不一致时判失败，且把两处的值都打出来**，
而不是挑一个"看起来对的"。

### S6 的纪律：不能机判 ≠ 通过

这是这类脚本最容易也最贵的错法。本判分器的处理：

- 能机判的两条（EV-08 / EV-20）走实际判定；
- 其余 S6 一律落进 `manual_rules`，该行 `pass=false`；
- 汇总里单列「含人判项 N 条」，并在退出码上体现（有 manual 项就不是 0）。

`tests/test_eval30_judge.py::test_unmachine_checkable_s6_goes_manual_not_pass`
把这条钉死——它比任何一个正例都重要。

## 4. 三种结局，三档退出码

| 情形 | 报告写什么 | 退出码 |
|---|---|---|
| 全部判出的都通过、无 manual、无阻塞 | `PASS` | 0 |
| 跑完了但有 FAIL 或 manual 项 | `FAIL` + `failed_rules` / `manual_rules` | 1 |
| 输入不可用（坏行、契约解析失败、任务 id 不存在） | `[阻断] …` | 2 |

**退出码 1 和 2 必须分开**：1 表示"跑完了、有结论"；2 表示"根本没跑成"。
混在一个码里时，CI 上一句 `exit 1` 会让人去查任务，而实际是日志坏了。

另：**缺日志不是 FAIL，是阻塞**。契约 §3.3 明写「套件未安装、ClickHouse 未随包、
真实设备不可达，记 `blocked: environment`，既不判 pass 也不判 fail」。所以
`--events-dir` 遇到缺文件时写 `BLOCK` 并单列计数。

## 5. 怎么跑

```powershell
$p  = "<repo>"
$py = "$p\.deps\venv\Scripts\python.exe"
$env:PYTHONPATH = "src"
$env:PYTHONIOENCODING = "utf-8"

# 看契约解析结果（30 条、工具链、区间、精确值）
& $py tools/eval30_judge.py --list-tasks

# 单条
& $py tools/eval30_judge.py --events logs/eval/opencode/EV-01.jsonl --task EV-01

# 整轮（缺的日志记 BLOCK）
& $py tools/eval30_judge.py --events-dir logs/eval/opencode --runtime opencode `
    --artifacts-root logs/eval/opencode/artifacts

# 机读
& $py tools/eval30_judge.py --events-dir logs/eval/claude --runtime claude --json
```

日志形状按契约 §1.1：`logs/eval/<runtime>/<task_id>.jsonl`，一行一个 `agent-events.md` 事件。

## 6. 现在的真实状态

| 项 | 状态 |
|---|---|
| 判分器 | ✅ 47 项测试全过 |
| 契约解析 | ✅ 30 条全解析（`--list-tasks` 可复核） |
| 两个运行时的真实日志 | ❌ **没有**。`logs/eval/` 不存在 |
| 30 条报告 | ❌ 没有 |

所以 W9 这条**只完成了一半**：判分能力到位，待判的数据没有。这不是判分器的问题，
是把两个运行时真正跑起来的问题（W4 的 OpenCode 装配、W5 的 Claude SDK 安装）。

**不要**拿合成日志跑一遍然后宣称"30 条通过"——那等于用自己造的数据证明自己的判分器，
契约 §3.4 明确把「用另一个运行时的结果冒充本轮结果」列为不算通过，同理。

## 7. 与五项门禁的关系

判分器**不进** `harness/selftest.py` 的五项门禁：它需要真实事件日志，而门禁必须能在
干净 clone 上离线全绿。

它自己的行为由 `tests/test_eval30_judge.py` 钉住（47 项，随主测试套件跑），
所以「判分器坏了」会被门禁发现，「判分结果如何」不会影响门禁。
