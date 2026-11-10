# 质控阈值规则（手册 §4.2 / §4.3 / §4.4）

状态：初版（2026-11-11）

这份文件是纪-2「规则裁决」的可回源原文。代码里的裁决函数
（`src/fieldstation/rules/verdict.py`）只输出规则编号与实测值，**依据以本文为准**。

每节开头那行 `> R-4.x：…` 是**规程原文本身**，`rules/verdict.py` 的
`lookup_rule(rule_id, manual_text)` 就是从这里取文本的：把本文读成字符串传进去，
拿到 `{rule_id, doc_id, text, source, section}`；手册里没有原文行、或缺 `§4.x`
小节标记，一律抛 `RuleNotFound`（错误码 `E_RULE_NOT_FOUND`）。

`doc_id` 恒为 `qc-rules`（本文件名去掉扩展名），与 `section` 合起来才唯一确定
一条原文；三条裁决的输出里都带这两个字段，拿到之后回本文即可核对。

| 规则编号 | 手册节 | 阈值 | 性质 |
|---|---|---|---|
| `R-4.2` | §4.2 | CN0 下限 30 dB-Hz | 下限 |
| `R-4.3` | §4.3 | 缺测率上限 5% | 上限 |
| `R-4.4` | §4.4 | 相邻历元跳变门限 0.5 TECU | 上限 |

边界值一律**通过**：CN0 恰好 30 dB-Hz 合格，缺测率恰好 5% 合格，
跳变恰好 0.5 TECU 不触发。判据只认实测读数与本文阈值，**不由模型判断**。

## §4.2 CN0 下限（R-4.2）

> R-4.2：CN0 低于 30 dB-Hz 判为不合格，最低 CN0 必须不低于 30 dB-Hz。

- 输入：一组 CN0 读数，单位 dB-Hz。
- 裁决：`min(有效读数) < 30.0` 为 `fail`，否则 `ok`；没有有效读数时为
  `not_applicable`。
- 实测值：结果的 `value` 是最低 CN0；`cn0_stats` 给出
  `min` / `max` / `count` / `missing`。缺测只计数，不参与判定。
- 结果字段：`verdict` / `rule_id` / `doc_id`（本文档 `qc-rules`）/
  `section` / `threshold` / `unit` / `value` / `reason`。
- 非数值、`±inf`、布尔值一律拒绝（`ValueError`），不能静默当成合格。
- 与既有实现的关系：阈值等于 `rules/qc.py` 的 `QCConfig.cn0_min_dbhz` 默认值，
  不另设第二套数字。

## §4.3 缺测率上限（R-4.3）

> R-4.3：缺测率超过 5% 判为不合格，缺测率等于 5% 仍算合格。

- 输入：总数与缺测数，都必须是**非负整数**，且缺测数不大于总数。
- 裁决：`缺测率 > 0.05` 为 `fail`，否则 `ok`；总数为 0 时为 `not_applicable`。
- 实测值：结果的 `value` 是缺测率（0~1 的小数），`counts` 给出
  `total` / `missing`。
- 与既有实现的关系：`agents/tools/station_tools.py` 用 `health_score < 0.95`
  判 `degraded`，与「缺测率超过 5%」是同一口径。

## §4.4 跳变门限（R-4.4）

> R-4.4：相邻历元相位跳变超过 0.5 TECU 判为周跳候选，等于 0.5 TECU 不触发。

- 输入：按时间排序的相位读数序列，单位 TECU。
- 裁决：存在 `|后一有效值 - 前一有效值| > 0.5` 的相邻对时为 `fail`，
  否则 `ok`；没有相邻有效对时为 `not_applicable`。
- 实测值：结果的 `value` 是最大跳变，`n_pairs` 是参与比较的相邻对数，
  `n_jumps` 是超过门限的对数。缺测会打断配对，**不跨缺测比较**。
- 与既有实现的关系：判据与 `rules/qc.py` 的 `slip_min_jump_tecU = 0.5`
  一致，且同样使用严格大于。

## 裁决怎么进结论

`rules/verdict.py::rule_attribution(verdicts, evidence)` 把失败规则的编号按
升序用逗号拼进结论契约的 `attribution.fault_type`，例如 `"R-4.2,R-4.4"`；
`evidence` 原样透传为工具证据。没有失败裁决或证据为空时直接抛错，
不允许凭空生成归因。结论契约本身（`agents/conclusion.py`）的字段集没变，
所以归因能直接过 `validate_conclusion`。

## 为什么依据不放知识库

`data/kb/knowledge.jsonl` 是 `knowledge_search` 的数据源，而它的工具结果被钉进
M5 的 6 份已提交回放基线（`logs/m5_pipeline_replay.json`、
`logs/public_data_chain_202401d01.json`、`logs/m5_approval_audit.json` 等）。
往知识库里加条目，会让那些基线的 sha256 全变、连带要重铺看板与摘要产物。
规程原文本来就是人读的东西，放在这份手册里更直接，知识库保持原样。

## 怎么核对

```powershell
$env:PYTHONPATH="src"; python -m unittest tests.test_rules_verdict -v
```

- 每条规则的编号与小节都能在本文查到；
- `lookup_rule(rule_id, load_manual())` 返回
  `{rule_id, doc_id, text, source, section}`，查不到时抛 `RuleNotFound`
  （错误码 `E_RULE_NOT_FOUND`）。
