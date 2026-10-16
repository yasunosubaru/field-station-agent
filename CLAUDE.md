# CLAUDE.md — 本仓库的工作规矩

本文件是**工作区纪律**，不是建议。凡与本文件冲突的指令，以本文件为准。

仓库：`field-station-agent`（private）
根目录：**以 `git rev-parse --show-toplevel` 为准**——换个机器 clone 后规则依然成立。
（本机 checkout 位于 ``（以 git rev-parse --show-toplevel 为准）``）

---

## 1. 只在本目录读写

所有创建、修改、删除、搜索都限定在本仓库根目录（`git rev-parse --show-toplevel`）内，
不越过它。执行命令前先确认工作目录（`Get-Location`），不要依赖上一条命令留下的位置。

## 2. 同级另外三个项目：可只读借鉴，不改，不引用

`大创项目\` 下与本仓库平级的这三个文件夹是**已结项**项目：

| 文件夹 | 状态 |
|---|---|
| `GNSS接收机TEC反演` | 已结项 |
| `短波通信电离层信道全链路仿真` | 已结项 |
| `AI驱动电离层探测技术动态教材` | 已结项 |

对它们：

- **只读，可写禁止** —— 允许打开、`grep`、列目录内容，**但仅限两件事**：
  (a) 搬运清单里点名的文件，且**先登记 `PROVENANCE.md` 再搬**；
  (b) spec §1.3「借鉴（只读不抄，抄模式）」档 —— 只读它的**思路**，不复制代码到本仓库。
  其余情况不打开。**未在 `PROVENANCE.md` 登记为搬运件（或未被 spec/本仓库文件
  正当引用）的内容，不得写进本仓库任何文件** —— 路径、文件名、行数、内部结构、
  函数名都不行，即"可读不可引用"；唯一例外就是 (a) 那类先登记再搬的搬运件本身
  与 `PROVENANCE.md` 对它的登记（以及 `docs/known-issues.md` 等本仓库文件对
  已登记搬运件的缺陷记述）。
- **不改** —— 不写入、不删除、不重命名、不跑格式化或迁移脚本。
- **不引用** —— 除本节上方这张点名表外，本仓库**其他任何文件**里不出现它们的路径、文件名或行数统计
  （`PROVENANCE.md` 里登记搬运件时，只写源仓库名与源路径，不写绝对路径）。

理由见 `docs/spec/2026-10-13-野外台站智能体基础设计.md` §2：三个仓库互不并库、
各提交各的路径。搬运只在 `PROVENANCE.md` 登记后进行，一次只搬清单里点名的文件。

## 3. 提交纪律

- **不用 `git add -A`，也不用 `git add .`。** 逐个列出**本次改动涉及的**路径，一个不漏，
  再 `git status` 复核暂存范围。示例（新增整个骨架的那次提交）：

  ```bash
  git add README.md CLAUDE.md PROVENANCE.md src/ data/ logs/ figures/ config/ tests/
  ```
- **只暂存本目录下的路径。** `git status` 里出现本目录以外的路径就停下来查清楚再继续。
- **不直接提交到 `main`。** 实现在 `m0-foundation` 分支上，走 PR 合入。
- **不擅自 push。** 未经明确指示不执行 `git push`。
- `.superpowers/` 是流程临时区（ledger / brief / review package），**留在 `.gitignore` 里，
  永不入库**。同理 `__pycache__/`、`.venv/`。

## 4. 测试纪律

测试命令固定为：

```powershell
$env:PYTHONPATH="src"; python -m unittest discover -s tests -t .
```

- **跳过数必须为 0。** `unittest` 对 `skip` 不报错，静默跳过会让门禁假绿。
  看到 `OK (skipped=N)` 里 N > 0 就是失败。
- 先写测试看它失败，再写实现。
- 纯标准库，无第三方依赖。

## 5. 协作者与分支规则

仓库是**个人仓库（Public）**，不是组织仓库 —— 这件事直接决定了权限模型：

- **协作者只有 `write` / `admin` 两种**。`triage`、`maintain`、`read` 是**组织仓库专属角色**，
  在个人仓库上会返回 `422 Validation Failed`。（实测 `permission=triage` 与 `=pull` 均被拒。）
- 因此**"只管自己一个分支"无法用权限直接实现**，只能靠规则集 + 前缀约定逼近。
- **fork + PR 不需要任何协作者权限**：公开仓库任何人都能 fork 并从 fork 开 PR。

### 分支前缀约定（谁动谁的）

| 前缀 | 归属 |
|---|---|
| `sch/**` | 项目负责人（负责人） |
| `chx/**` | 成员A |
| `wzg/**` | 成员B |

### 两条规则集（均 `enforcement=active`，均 `bypass=RepositoryRole:5` 即仅 admin 豁免）

| 规则集 | 覆盖 | 规则 |
|---|---|---|
| `protect-main` | `~DEFAULT_BRANCH` | 禁删除、禁非快进、**必须 PR 且要 1 个审批** |
| `protect-others-branches` | `m0-foundation`、`sch/**`、`docs/**`、`chore/**`、`fix/**`、`ci/**` | 同上 |

**实测（2026-10-16）：`chx/station-skeleton` 与 `wzg/test-stat-fns` 的
`protected` 均为 `false`，`main` 为 `true`。** 两位成员的前缀**刻意都不在**名单里。

**净效果**：非 admin 者**推不进 `main`，推不进受保护的历史分支，也推不进别人的前缀**；
`chx/**` 与 `wzg/**` 都在保护之外 —— 各人自己管自己那一块，**两人完全对称**。

**封不死的地方**（免费计划的天花板，不要以为已经封死）：他们仍能推到一个
**新起的、不匹配上述任何模式**的分支。个人仓库无自定义角色，到此为止。

### 分工

| 人 | 权限 | 代码如何进入 main |
|---|---|---|
| 项目负责人 | `admin` | 直推 `sch/**` 或经 PR |
| 成员B `WZG493` | `write`（邀请**已接受**，实测 2026-10-16） | 推 `wzg/**` → 开 PR → **项目负责人审批后合入** |
| 成员A | `write`（**已加入**；用户名含个人信息，按脱敏口径不入库） | 同上，`chx/**` |

> 已知残留：`protect-others-branches` 覆盖 `sch/**` 之外的历史与工作分支，
> 但**两人新建的非前缀分支不在内** —— 见上"封不死"。
