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
入库 Python 文件数  42         42         PASS
入库 Python 行数   6458       6458       PASS
入库测试文件数        19         19         PASS

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
| CLI 插图内容 | `figures/`（如已出图） | 第 6 节（重跑命令即重取输出） |

## 退出码速查

| 命令 | 0 | 非 0 |
|---|---|---|
| unittest 固定命令 | 全绿且 skip 0 | 1=失败/错误；出现 `skipped=N` 视为失败 |
| `harness/selftest.py` | 被选项全 PASS | 1=任一 FAIL；2=用法错误 |
| `harness/replay.py` | 与 fixture 期望一致 | 1=漂移；2=用法/IO 错误 |
| `harness/qc_agent_replay.py` | 基线一致或日志证据有效 | 1=漂移/证据无效；2=用法/IO 错误 |
| `tools/audit_claims.py` | 全部核对项通过 | 1=FAIL/UNVERIFIED；2=文档缺失/空口径 |
| `tools/sync_code_counts.py` | 已同步 | 2=找不到 README 锚点/空口径 |
| `tools/make_cli_figures.py` | 采集并渲染完成 | 2=matplotlib 缺席/用法错误 |
| `src/fieldstation.cli` | 透传目标的 0 | 2=未知/缺子命令；其余透传目标退出码 |
