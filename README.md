# 野外台站智能体管理系统

武汉大学地球与空间科学技术学院 · 2026 年大学生创新创业训练计划项目
「利用AI智能体构建野外台站管理系统」

- 设计文档：[`docs/spec/2026-10-13-野外台站智能体基础设计.md`](docs/spec/2026-10-13-野外台站智能体基础设计.md)
- 工作区规矩：[`CLAUDE.md`](CLAUDE.md)
- 搬运件登记：[`PROVENANCE.md`](PROVENANCE.md)

---

## 一分钟上手

仓库根目录下执行：

```powershell
$env:PYTHONPATH="src"; python -m unittest discover -s tests -t .
```

这是跑全部测试的固定命令（实测 **118 个测试**，skip 必须为 0 —— `unittest`
不把 `skip` 当失败，静默跳过会让门禁假绿）。配套的三道验证命令：

```powershell
$env:PYTHONPATH="src"; python harness/selftest.py    # 五项门禁，退出码 0 才算过
python tools/audit_claims.py                         # README 数字回源核对，全过才 exit 0
python harness/replay.py --fixture harness/fixtures/replay_20261013.json
```

**重跑任一对外数字的完整步骤**（含每条命令的实测输出与通过判据）见
[`harness/REPRODUCE.md`](harness/REPRODUCE.md)。五条纪律命令
（`selftest` / `replay` / `audit` / `sync` / `figures`）另有统一入口转发：
`$env:PYTHONPATH="src"; python -m fieldstation.cli --help`
（固定测试命令不经转发，直接跑即可 —— 它本身就是要转发的门禁之一）。

## 现状

**M0「地基与旧代码整合」已实现。** 下表是实测结论（实测日期 2026-10-14，
命令即上面三条 + `python tools/sync_code_counts.py` 的口径）：

| 项 | 状态 |
|---|---|
| 目录骨架 | 已建（`src/fieldstation/{rules,ingest,store,agents}` + `data/ logs/ figures/ config/`） |
| 代码量表 | 见下方「代码量（机维护）」节 |
| 搬运件 | 17 件（10 src + 7 tests），逐件登记在 `PROVENANCE.md` |
| 测试 | 20 个测试文件、118 个测试，skip 0；`harness/selftest.py` 五项门禁实测 5/5 exit 0 |
| 评测底座 | `harness/replay.py` + 合成 fixture（种子 `synthetic.FIXTURE_SEED=20261013`），同输入两跑 SHA256 相同 |
| 智能体运行时 | 最小核：provider 抽象（仅 `fake`）、trace 留痕、单轮循环；**不接真实模型、不联网** |
| 数据 | 只有合成 fixture，**无真实台站数据**（`data/` 仅 `.gitkeep`） |
| CLI 入口 | **已建** `src/fieldstation/cli.py`：五条纪律命令的统一分发（`selftest`/`replay`/`audit`/`sync`/`figures`，只转发不重实现）；智能体编排入口仍留 M3（`docs/known-issues.md` KI-08） |

阶段顺序按 spec §3：**先骨架 → 再整合旧代码 → 再立框架 → 最后接真实数据**。
M0 全程不碰真实台站数据、不调真实 LLM。

<!-- CODE_COUNTS:BEGIN -->
## 代码量（机维护，请勿手改）

- 入库 Python 文件数：**44** 个
- 入库 Python 行数：**6,691** 行
- 入库测试文件数：**21** 个

> 口径：`git ls-files` 下 `src/` 与 `tests/` 内的 `.py` 文件；未入库文件不计。
> 本块由 `tools/sync_code_counts.py` 生成，由 `tools/audit_claims.py` 回源核对，
> 共用同一口径。
<!-- CODE_COUNTS:END -->

## 设计文档

完整方案（旧代码整合清单、目录树、阶段划分、DoD）在
[`docs/spec/2026-10-13-野外台站智能体基础设计.md`](docs/spec/2026-10-13-野外台站智能体基础设计.md)。

`docs/superpowers/plans/` 下是分任务的实施计划。
