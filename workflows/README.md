# workflows —— 原版 GUI 缺口的固定流程

这套目录回答一个具体问题：**原版套件 GUI 能做、而重实现引擎（B）还没有固定入口的操作，
怎样以可审计、可复现、不伪造证据的方式补上？**

答案是「流程是数据」：每个缺口一份 YAML（`workflows/<id>.yaml`），执行器只认
[`src/fieldstation/workflows/spec.py`](../src/fieldstation/workflows/spec.py) 里列出的步骤种类。
认不出的字段、拼错的键、缺失的必填项在**加载时**就报错，不会运行到一半才发现。

盘点依据是 [原版 GUI 覆盖矩阵](../逆向/03_分析/19_原版GUI覆盖矩阵.md)（由
`tools/gui_coverage.py` 从 A/B 两侧源码生成）。矩阵里只有 `a_only` / `partial` 的项才需要
流程；`covered` 的项不需要重做一遍。

## 目录

| 路径 | 是什么 |
|---|---|
| `*.yaml` | 流程规格（数据）。新增缺口 = 新增 YAML，不改执行器 |
| `jobs/` | 运行现场：`job.json`（状态）、`audit.jsonl`（只追加流水）、`artifacts/`（证据）——**不入库**，见 `.gitignore` |
| [`../src/fieldstation/workflows/`](../src/fieldstation/workflows/) | 执行器：YAML 子集解析、规格校验、状态机、锁、幂等索引、审计、证据 |
| [`../tools/workflow_cli.py`](../tools/workflow_cli.py) | 命令行入口（薄壳，语义都在 service/runner） |

## 现有流程

| id | 风险 | 人工闸门 | 做什么 | 依据 |
|---|---|---|---|---|
| `script.device.restart` | high | 工作流级审批 | 发 `RESET` → 等断线 → 按原 target 重连 → 用 `VERSION (#37)` 证明回来的是同一台机 | 原版 Device ▸ Restart；台账 §N |
| `gui.device.update` | high | 在 **Apply 之前** | 核对型号、算固件 SHA256、填文件、只读控件回读，批准后才点 Apply，升级后用 `VERSION` 回读 | 原版 Device ▸ Update；台账 §J6（B 只读） |
| `gui.graph.export` | low | 无 | 列工程/文件 → `GET /api/graph/pdf` → 校验 PDF 头与页数 → 落盘 PDF 与 manifest | 原版 Graph Export ▸ PDF；台账 §D6/§N |

## 用法

```powershell
$env:PYTHONPATH = "src"

# 1. 看目录与某一条的前置/参数/产物/失败分支
python tools/workflow_cli.py list
python tools/workflow_cli.py describe gui.device.update

# 2. 起一个 job（高风险流程会先停在审批门）
python tools/workflow_cli.py run script.device.restart `
    --param target=COM8@115200 --param expect_model=OEM729 --json

# 3. 看状态 / 批准或拒绝 / 报告人工任务完成
python tools/workflow_cli.py status <job_id>
python tools/workflow_cli.py gate <job_id> --decision approved --by sunch --note "现场确认"
python tools/workflow_cli.py resume <job_id> --decision done

# 4. 取证据
python tools/workflow_cli.py artifacts <job_id> --out .\out
```

也可以走统一入口：`python -m fieldstation.cli workflow ...`。

退出码：`0` 成功 / `1` 失败（终态非 succeeded）/ `2` 用法错误 / `3` 停在闸门
（`waiting_approval` 或 `waiting_operator`，不是失败）。

## 证据与状态

一个 job 一个目录（默认 `workflows/jobs/<job_id>/`）：

```
job.json        # 当前状态快照（原子替换）
audit.jsonl     # 只追加：job.created / step.begin / gate.opened / gate.resolved / job.failed…
artifacts/      # 流程产物 + context.json + failure.json（失败现场）
```

`artifacts` 里的每个文件都带 `sha256` 与来源步骤；`gui.graph.export` 落 PDF 与
`graph-export.json`，`script.device.restart` 落 `restart.json`（含基线、RESET 回执、
回来后的 VERSION），`gui.device.update` 落 `update.json`（固件哈希、前后 VERSION、Apply 回执）。

## 安全不变量

1. **不可逆动作必须人工闸门。** 含 `RESET` / `FRESET` 的流程在加载时强制
   `approval.required: true`；`gui.device.update` 的门放在 **Apply 之前**，准备步骤只读/可撤。
2. **不自动重试。** `on_fail` 只有 `stop` / `continue`，没有 `retry`：失败就停、截图、写
   `failure.json`，绝不自动重刷固件。
3. **不伪造证据。** 没有 GUI 驱动时，`gui` / `verify_ui` 步骤变成 `waiting_operator` 人工任务，
   把要做的事写成明确指令；人做完 `resume --decision done` 才继续。不会假装点过、不会写假截图。
4. **先验证再宣称成功。** `verify_ui` 读控件值（不靠「看起来点了」），`await_receiver` 用
   `VERSION` 回读；型号不符立即停（刷错机型是不可逆事故）。
5. **失败分类固定。** `environment / input / execution / artifact / capability`，
   每类决定 job 停在哪个分支（见 `spec.py` 的 `FAILURE_CLASSES`）。
6. **单飞与幂等。** 同一流程同时只允许一个未结束 job；`--idempotency-key` 命中运行中/成功的
   job 时直接复用，不重复执行不可逆动作；job 与流程各有一把文件锁，崩溃后按时间判 stale。

## GUI 驱动

`gui` 步骤不写鼠标坐标，只写控件/页面名。驱动由 `--driver` 选择：

- `assisted`（默认）：没有驱动，`gui`/`verify_ui` 转人工任务；
- `scripted`：**仅测试/演练**，读值来自预置表，截图是标记文件，不能当生产证据；
- 其它名字：按模块名导入，模块须提供 `create() -> GuiDriver`（真正的 UIA 驱动是可插拔的）。

## 新增一条流程

1. 先在覆盖矩阵里确认它是 `a_only` / `partial`，并写清处置；
2. 复制一份现有 YAML，改 `id` / `intent` / `params` / `steps` / `docs`；
3. `python tools/workflow_cli.py validate` —— 加载期校验不通过就不算写完；
4. 补测试：`tests/test_workflow_runner.py` 用假引擎/假时钟跑状态机与失败分支；
5. 更新 `tools/gui_coverage_map.json` 的 `workflow` 字段，再
   `python tools/gui_coverage.py` 重新生成矩阵。

扩展新页面/新机型/新套件版本时，只加 YAML + 选择器映射，不改 agent，也不改执行器。
