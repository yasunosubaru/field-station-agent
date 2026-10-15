<a id="readme-top"></a>

<div align="center">
<br />
<h1>野外台站智能体管理系统</h1>

[![CI](https://github.com/yasunosubaru/field-station-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/yasunosubaru/field-station-agent/actions/workflows/ci.yml)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?style=flat&logo=python&logoColor=white)](https://www.python.org/)
[![deps](https://img.shields.io/badge/deps-0-brightgreen?style=flat)](#built-with)
[![license](https://img.shields.io/badge/license-TBD-lightgrey?style=flat)](#license)

<p>
  武汉大学地球与空间科学技术学院 · 2026 年大学生创新创业训练计划<br />
  用一组智能体接管野外台站的监测、质控、研判、派单、归档
</p>

<a href="docs/spec/2026-10-13-野外台站智能体基础设计.md">设计文档</a>
·
<a href="docs/decisions/2026-10-14-智能体运行时选型.md">技术选型</a>
·
<a href="../../issues/new">汇报缺陷</a>
·
<a href="docs/team/分工与后续工作.md">团队分工</a>

</div>

<!-- 目录 -->
<details>
  <summary>目录</summary>
  <ol>
    <li><a href="#about-the-project">项目概况</a></li>
    <li><a href="#built-with">技术构成</a></li>
    <li>
      <a href="#getting-started">开始使用</a>
      <ul>
        <li><a href="#prerequisites">前置条件</a></li>
        <li><a href="#installation">安装与运行</a></li>
      </ul>
    </li>
    <li><a href="#usage">用法</a></li>
    <li><a href="#roadmap">路线图</a></li>
    <li><a href="#contributing">参与贡献</a></li>
    <li><a href="#license">许可证</a></li>
    <li><a href="#contact">联系方式</a></li>
    <li><a href="#acknowledgments">致谢</a></li>
  </ol>
</details>

<!-- 项目概况 -->
<a id="about-the-project"></a>
## 项目概况

野外台站没人守着。供电、蓄电池、设备在线率、网络时延、探头温度，这些量分散在不同
系统里，出问题要等下次巡检才发现，时滞能拖到几周甚至几个月。观测数据也得靠有经验
的人按时段一份份看。

这个仓库想做的事，是让一组智能体把这条链路接过去。系统形态是一个管理平台，不改动
台站硬件，通过互联网远程接入传感器、供电、网络与安防。

五类智能体的分工：

| 智能体 | 负责什么 |
|---|---|
| 设备状态监测 | 供电、蓄电池、在线率、网络时延、探头温度的统一观测面 |
| 数据质量校验 | 周跳、量级越限、多传感器交叉不一致，逐条判定可用性 |
| 异常故障研判 | 分清设备故障和环境真实变化，给成因排序和置信度 |
| 运维任务调度 | 派单、定优先级和时限，超时升级 |
| 数据管理归档 | 入库、版本管理、预处理、元数据登记 |

**规则裁决，模型归因。** 低置信度和高风险判断一律落到人工审批门，不让模型自己下
结论。一次错误的停机建议可能造成不可逆的数据损失，所以「不动」必须始终是个选项。

<a href="#readme-top">回到顶部</a>

<!-- 技术构成 -->
<a id="built-with"></a>
## 技术构成

* [![Python](https://img.shields.io/badge/Python-3.11-3776AB?style=flat&logo=python&logoColor=white)](https://www.python.org/)
* [![LangGraph](https://img.shields.io/badge/LangGraph-拟采用-1C3C3C?style=flat)](docs/decisions/2026-10-14-智能体运行时选型.md)
* [![MCP](https://img.shields.io/badge/MCP-工具接口协议-5A45FF?style=flat)](docs/decisions/2026-10-14-智能体运行时选型.md)
* [![Langfuse](https://img.shields.io/badge/Langfuse-trace%20格式参考-E2472E?style=flat)](docs/decisions/2026-10-14-智能体运行时选型.md)

现阶段不引入第三方依赖，全部用标准库。运行时的框架选型写成了单独的架构决策记录
[ADR-001](docs/decisions/2026-10-14-智能体运行时选型.md)，结论是 LangGraph 打底、
Pydantic AI 兜底，平台型产品（Dify、FastGPT）只用于告警看板。AutoGen 已停止维护，
n8n 的许可证不是 OSI 开源，两个都排除。

<a href="#readme-top">回到顶部</a>

<!-- 开始使用 -->
<a id="getting-started"></a>
## 开始使用

<a id="prerequisites"></a>
### 前置条件

* Python 3.11 或更高版本
* git
* 无第三方依赖，不需要 venv 之外的任何安装步骤

代码用 `src` 布局，所以 `PYTHONPATH` 要显式指向 `src/`，否则 import 不到包。

<a id="installation"></a>
### 安装与运行

1. 克隆仓库
   ```sh
   git clone https://github.com/yasunosubaru/field-station-agent.git
   cd field-station-agent
   ```
2. 跑全部测试
   ```powershell
   $env:PYTHONPATH="src"; python -m unittest discover -s tests -t .
   ```
3. 跑五项一致性门禁
   ```powershell
   $env:PYTHONPATH="src"; python harness/selftest.py
   ```
4. 核对文档里的数字与仓库实际状态
   ```powershell
   python tools/audit_claims.py
   ```

第二步的 skip 必须为零。`unittest` 不把 skip 当失败，静默跳过会让门禁看起来是绿的。

<a href="#readme-top">回到顶部</a>

<!-- 用法 -->
<a id="usage"></a>
## 用法

### 系统怎么流转

```
        台站现场（传感器 / 供电 / 网络 / 安防）
                            │
                            ▼
        ┌───────────────────────────────────────────┐
        │  摄取层  reader → rinex2 / rinex3 /        │
        │           hatanaka（CRINEX）               │
        └───────────────────────────────────────────┘
                            │
                            ▼
                    Observation / EpochPair
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   ① 设备状态监测      ② 数据质量校验       ⑤ 数据管理归档
   统一观测面          可用性逐条判定        入库 / 版本 / 元数据
        │                   │                   ▲
        │                   │ 可用               │
        │                   ▼                   │
        │            ③ 异常故障研判              │
        │            成因排序 + 置信度            │
        │                   │                   │
        └─── 高置信度 ──────┼── 低置信度 ──┐     │
                            ▼             ▼     │
                     ④ 运维任务调度   人工审批门 │
                     派单 / 升级 / 时限     │     │
                            │             └─────┘ 批准后放行
                            └─────────────────────┘
                                          │
                                          ▼
                                告警看板（平台层）
```

### 智能体怎么编排

纪律命令有统一入口，只转发、不重实现，避免两套逻辑各自漂移：

```powershell
$env:PYTHONPATH="src"; python -m fieldstation.cli --help
```

| 命令 | 作用 |
|---|---|
| `selftest` | 五项一致性硬门禁，任一 FAIL 即非零退出 |
| `replay` | 确定性回放评测，可离线、不联网 |
| `audit` | 文档数字逐条回源核对 |
| `datadict` | 数据字典完整性门禁（M1 交付物，草稿态不算失败） |
| `sync` | 重新生成本文件的代码量区块 |
| `figures` | 生成论文可用的图表 |

固定测试命令不走这个入口，直接跑。它本身就是被转发的门禁之一。

### 数据现在是什么情况

`data/` 目录是空的，没有真实台站数据。当前所有观测都来自
[`src/fieldstation/synthetic.py`](src/fieldstation/synthetic.py)，固定种子生成，
同一次输入跑两遍字节一致。M0 阶段刻意不接真实数据、不调真实模型：先把评测底座做实，
再接就有东西可以对。

<a href="#readme-top">回到顶部</a>

<!-- 路线图 -->
<a id="roadmap"></a>
## 路线图

阶段顺序：骨架 → 旧代码整合 → 框架 → 真实数据。评测底座在接真数据之前先做实。

- [x] **M0** 仓库骨架、旧代码整合、运行时最小核、评测底座
- [ ] **M1** 需求调研与接口梳理
- [ ] **M2** 真实数据接入层
- [ ] **M3** 数据质量校验智能体，接入选定的运行时框架
- [ ] **M4** 研判、调度、归档智能体与知识库
- [ ] **M5** 集成联调与告警看板
- [ ] **M6** 试运行与指标评估
- [ ] **M7** 成果整理与结题验收

[开放议题](../../issues) 里能看到全部提案和已知问题。

<a href="#readme-top">回到顶部</a>

<!-- 参与贡献 -->
<a id="contributing"></a>
## 参与贡献

有想法就提 [issue](../../issues/new)，也可以 fork 后直接发 PR。

团队成员在这个仓库里有写权限，工作流和外部贡献者略有不同：

1. 建自己的前缀分支，不直接推 `main`
2. 提交，且逐个列路径（不要 `git add -A`）
3. 推送分支
4. 发 PR，`main` 需要一次审批
   ```sh
   git checkout -b sch/your-task
   git commit -m 'feat: 做了什么'
   git push origin sch/your-task
   ```
5. 等审批合入

### 搬运件的纪律

[`PROVENANCE.md`](PROVENANCE.md) 表里的文件来自一个历史项目，逐字搬运，登记了源路径、
commit 和逐条改动说明。它们一律只读。确需改动时：

1. 先立 issue 说清楚动机
2. 先写一条让测试变红的回归
3. PR 里更新 PROVENANCE 的改动列
4. 证明既有真实样本的行为逐字节没变

少一步都不合。这些文件是项目唯一的历史证据，改坏了查不回来。

### 提交时的自检

```powershell
$env:PYTHONPATH="src"; python -m unittest discover -s tests -t .
$env:PYTHONPATH="src"; python harness/selftest.py
python tools/audit_claims.py
```

**写本文档的人注意**：`tools/audit_claims.py` 会把文档里「一个词、冒号、紧跟一个数字」
这种形状的句子记为无法回源，而无法回源的条目会让它返回退出码 1。所以本文档里的数字
一律放进表格，表格里的竖线会被它的正则排除。正文里别出现那个形状，门禁会红。
代码量区块由 `tools/sync_code_counts.py` 生成，别手改。

<!-- CODE_COUNTS:BEGIN -->
## 代码量（机维护，请勿手改）

- 入库 Python 文件数：**48** 个
- 入库 Python 行数：**7,509** 行
- 入库测试文件数：**24** 个

> 口径：`git ls-files` 下 `src/` 与 `tests/` 内的 `.py` 文件；未入库文件不计。
> 本块由 `tools/sync_code_counts.py` 生成，由 `tools/audit_claims.py` 回源核对，
> 共用同一口径。
<!-- CODE_COUNTS:END -->

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

<!-- 许可证 -->
<a id="license"></a>
## 许可证

还没有定。这个仓库是公开的，但没放 LICENSE 文件，默认状态下保留所有权利。

这不是漏了。[ADR-001](docs/decisions/2026-10-14-智能体运行时选型.md) 把定 LICENSE
列为引入 LangGraph 和 Langfuse 的前置条件，在那之前不会往 `src/` 和 `harness/` 里加
第三方依赖。参考过的开源项目、用到的协议都会登记在案。

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

<!-- 联系方式 -->
<a id="contact"></a>
## 联系方式

个人姓名、学号、电话、邮箱不进这个仓库，它是公开的。

协作走这两个地方就行：

* 缺陷和需求：[开放议题](../../issues)
* 任务看板：[Project 看板](https://github.com/users/yasunosubaru/projects/1/views/1)

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>

<!-- 致谢 -->
<a id="acknowledgments"></a>
## 致谢

* [GNSS接收机TEC反演项目](PROVENANCE.md)：`src/fieldstation/` 里大半代码的来源，
  逐件登记在 PROVENANCE 中。没有它，这个仓库现在只是一份方案
* [Best-README-Template](https://github.com/othneildrew/Best-README-Template)：本页的结构
* [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)：本页的措辞参考
* [Img Shields](https://shields.io/) · [Choose an Open Source License](https://choosealicense.com/)

<p align="right">(<a href="#readme-top">回到顶部</a>)</p>
