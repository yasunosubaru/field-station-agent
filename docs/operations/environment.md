# 环境与干净环境重跑（M7-3 的一部分）

状态：初版（2026-10-20）

这个仓库的核心卖点是可复现。这份文件记录两件事：**跑它需要什么**，以及**在一个干净
环境里真的跑过一遍**。真实样本相关部分受 #28/#33 阻塞，等样本到位后补。

## 依赖政策

- 测试、五项门禁、回放、审计、看板、脱敏守卫：**只用标准库**。
  `tools/env_snapshot.py` 会把入库 `.py` 的第三方 import 列出来（当前只有
  `matplotlib`），并记录 `tests_use_third_party=false`。
- `matplotlib` 只被 `tools/make_cli_figures.py`（说明书插图）可选使用；缺它时该工具
  以退出码 2 优雅中止，测试与门禁不受影响（`docs/known-issues.md` KI-09）。
- 模型通道（`config/providers.json`）：`fake`（测试与回放）+ `ollama`
  （`qwen3:8b`，`temperature=0`、`seed=42`、`think=false`）。API 通道选型与额度
  覆盖到 2027-08 的结论见 #71（未定）。

## 环境快照

```powershell
python tools/env_snapshot.py            # 默认写 logs/env_snapshot_<日期>.json
python tools/env_snapshot.py --out <路径>
```

记录：Python 版本/实现、操作系统（system/release/machine）、git commit 与工作区是否
干净（只统计已跟踪文件）、第三方 import、provider 名称与模型/确定性选项。

**不记录**：本机绝对路径、用户名、主机名、环境变量值（可能含密钥）、venv 路径。
输出可以直接进公开仓库；`tests/test_env_snapshot.py` 钉住「不含绝对路径」与
「两次生成逐字节相同」。

注意：快照里的 `git.commit` 是**生成时**的 HEAD；快照文件本身在下一个提交里。

## 干净环境重跑（2026-10-20 实测）

```powershell
python -m venv <tmp>/venv
<tmp>/venv/Scripts/python -m unittest discover -s tests -t .        # Linux: <tmp>/venv/bin/python
<tmp>/venv/Scripts/python harness/selftest.py
<tmp>/venv/Scripts/python tools/audit_claims.py
<tmp>/venv/Scripts/python harness/m5_pipeline_replay.py --fixture harness/fixtures/m5_pipeline_replay_20261020.json --log-dir <tmp>/replay
<tmp>/venv/Scripts/python harness/m5_pipeline_replay.py --verify-log logs/m5_pipeline_replay.json
<tmp>/venv/Scripts/python harness/m5_approval_audit.py --out <tmp>/audit.json
<tmp>/venv/Scripts/python tools/make_station_dashboard.py --page <tmp>/page.html --summary <tmp>/summary.json
<tmp>/venv/Scripts/python tools/check_desensitization.py
```

**结果**：8/8 退出码 0；完整输出存 `logs/clean_room_20261020.txt`（路径已脱敏为
`<repo>` / `<tmp>` / `<home>`）。逐字节基线不是这份记录（它含耗时），基线是
REPRODUCE §3.5–§3.7 的 fixture/日志/审计记录。

## 边界

- 这里的「干净」是**同一台机器上的全新 venv**，不是全新机器/操作系统；跨平台由
  CI（`ubuntu-latest`，Python 3.11）每次 PR 覆盖。真正的干净机器验证、以及
  「源 + 真实样本 + 全量重跑记录」是 #69 的收尾条件，等真实样本（#28/#33）到位。
- 全链基线当前是固定种子合成样本的替代口径（REPRODUCE §3.5）；这不影响「环境能不能
  跑起来」的结论，但意味着**业务数字**还不能当真实台站结果引用。
- 快照与重跑记录都**不是安全证明**：脱敏由 `tools/check_desensitization.py` 绊线 +
  人工复核共同覆盖（见该工具文件头与 README）。
