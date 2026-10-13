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

这是**目前唯一**的命令。跳过数必须为 0（`unittest` 不把 `skip` 当失败，静默跳过会让门禁假绿）。

**当前仓库只有骨架，尚无可运行的业务命令** —— 没有 CLI、没有 `harness/selftest.py`、
没有数据管道。跑测试只会检查目录布局是否与 spec §2 一致（`tests/test_layout.py`）。

## 现状

| 项 | 状态 |
|---|---|
| 目录骨架 | 已建（`src/fieldstation/{rules,ingest,store,agents}` + `data/ logs/ figures/ config/`） |
| 代码量表 | **待 `tools/sync_code_counts.py` 机维护**（该脚本尚未移植；届时本节表格由脚本改写，不手写） |
| 搬运件 | 0 件，见 `PROVENANCE.md` |
| 测试 | `tests/test_layout.py` |

阶段顺序按 spec §3：**先骨架 → 再整合旧代码 → 再立框架 → 最后接真实数据**。
M0 全程不碰真实台站数据、不调真实 LLM。

## 设计文档

完整方案（旧代码整合清单、目录树、阶段划分、DoD）在
[`docs/spec/2026-10-13-野外台站智能体基础设计.md`](docs/spec/2026-10-13-野外台站智能体基础设计.md)。

`docs/superpowers/plans/` 下是分任务的实施计划。
