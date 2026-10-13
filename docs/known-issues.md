# 已知缺陷与覆盖缺口登记

*本文件登记**已实测确认**的缺陷、以及**已知但未覆盖**的行为。*

**为什么单独建这个文件**：`.superpowers/` 被 gitignore，任务报告会随归档消失或丢失。
缺陷条目只写在报告里，等于没有登记 —— 一年后没人知道 `rinex2.py` 为什么会崩。
所以凡是"知道有问题、但决定不修"的东西，都必须在这里留一条。

**规则**：写进本文件的每条技术论断，都要能指出证据出处（实测命令 / 构造性验证 /
规范条文）；**没有证据的猜测写在这里也要标明"未验证"**，不能混进已确认条目。

---

## 条目

### KI-01　RINEX 2 头段的 `PRN / # OF OBS` 记录会让解析抛未捕获异常【已确认】

- **位置**：`src/fieldstation/ingest/rinex2.py:263-267`
- **归属**：搬运件既有行为，**非本项目引入**。源自 GNSS接收机TEC反演项目，
  本仓库逐字搬运（该文件与源文件的唯一差异是 L5 的 docstring 路径指向）。
- **触发条件**：RINEX 2 观测文件的头段存在 `PRN / # OF OBS` 记录，且该行的
  **PRN 占据第 1-3 列**（这正是 RINEX 2.11 规范规定的位置）。
- **症状**：`rinex2.py:267` 抛未捕获
  `ValueError: could not convert string to float: 'PRN'`。
- **机制**：`sid = ln[0:3].strip().upper()` 在规范写法下非空，于是进入该分支；
  `rest = ln[3:].split()` 把第 61 列起的标签词 `PRN` / `/` / `#` / `OF` / `OBS`
  也切了出来，`int(float('PRN'))` 直接抛错。
- **为什么现有真实样本不崩**：`BADG` 文件的头段确实含 `PRN / # OF OBS` 记录，
  但它是 `JPS2RIN` 生成的，**PRN 写在第 5 列**，于是 `ln[0:3]` 是空白、
  `if sid:` 为假、整行被跳过。**这是侥幸，不是安全。**
- **证据**：构造性验证（评审者，2026-10-13）——
  | 写法 | 结果 |
  |---|---|
  | 规范位置（PRN 在第 1-3 列） | `EXC ValueError: could not convert string to float: 'PRN'` |
  | 规范 PRN + 续行 | `EXC ValueError: …` |
  | JPS2RIN 写法（PRN 在第 5 列，同 BADG） | `OK`，`n_codes=5` |
- **⚠️ 未验证部分**：`teqc` / `gfzrnx` 生成的 RINEX 2 文件**没有**真实样本可比对。
  "它们输出的是规范写法"是**依据生成器文档的推断，不是实测**。
  触发面比"teqc/gfzrnx 一定崩"更稳妥的说法是：**任何把 PRN 写在第 1-3 列的
  RINEX 2 文件都会崩**，范围待接真实数据时确认。
- **影响面**：M0 不接任何真实数据，**M0 不受影响**。
  **M2 接入真实数据之前必须处理**（要么改 `rinex2.py`，要么在调用前预处理头段）。
- **为什么不修**：`rinex2.py` 是逐字搬运的承重件。改它会当场摧毁本项目赖以成立的
  "哪些行是一年成果、哪些是搬运"的可证性。**一个潜伏的解析崩溃，代价小于一份
  说不清的结题材料。**

### KI-02　`ObservationFile.interval_s` 在头段无 `INTERVAL` 记录时返回 NaN【已确认】

- **位置**：`src/fieldstation/ingest/reader.py:296-304`
- **归属**：搬运件既有行为。
- **症状**：返回 `nan` 而不是设计意图里的兜底值 `30.0`。
- **机制**：L301-303 那段"由历元时间戳反推"的代码是
  `ts = … if False else None`（**恒假，死代码**），末尾 `return v or 30.0`；
  而 `v` 是 `float(nan)`，`NaN or 30.0` 在 Python 里为真（NaN 是 truthy），
  于是返回 NaN。
- **实测**：`RINEX 3` 头段通常只有 `TIME OF FIRST OBS`、没有 `INTERVAL`，
  所以走 RINEX 3 的 `ObservationFile` 必然拿到 NaN，并原样进
  `capability_report()["interval_s"]`。
- **影响面**：M0 不受影响（本仓库测试夹具的 RINEX 2 头段写了 `INTERVAL`）。
  接真实数据时若对 `interval_s` 做数值运算，需先处理 NaN。
- **为什么不修**：同上，搬运件既有行为，不在本任务改。

### KI-03　读取观测文件时泄漏文件句柄【已确认】

- **位置**：`rinex2._gzip_bytes`、`rinex3.Rinex3Obs.__init__`、`reader._read_text`
  —— 三处都是 `open(path, "rb").read()`，不关句柄。
- **症状**：每次打开观测文件抛一条
  `ResourceWarning: unclosed file <_io.BufferedReader …>`；
  长时间批量读取会积累未关闭的句柄。
- **证据**：Task 4 实现阶段在 `tests/test_ingest.py` 上直接观察到（见该文件顶部注释）。
- **当前处置**：`tests/test_ingest.py::_open_observation_file` 用
  `warnings.catch_warnings()` 在**调用点**精确屏蔽（unittest 的 runner 会把模块级
  filter 覆盖回 `default`，所以必须包在调用点上）。**屏蔽不是修复。**
- **为什么不修**：搬运件既有行为，改了就不是搬运了。

### KI-04　"逐字节搬运"的可证性依赖 index blob，而不是工作区文件【已处理】

- **问题**：本机的 `core.autocrlf` 是 **Git for Windows 的系统级默认**
  （`git config --show-origin core.autocrlf` →
  `file:C:/Program Files/Git/etc/gitconfig  true`），
  **不是**本仓库 `.git/config` 的私有设置。所以**任何人、任何 CI 在任何 Windows 上
  clone 这个仓**，工作区文件都会从 LF 变成 CRLF。
- **实测危害**：加 `.gitattributes` 之前，全新 clone 出来的
  `src/fieldstation/ingest/hatanaka.py` 是 **8646 B / 240 处 CRLF**，
  与源项目的 8405 B **不再逐字节相同**。
  committed blob 本身一直是纯 LF（逐个 `git cat-file -p HEAD:<path>` 验证，
  33 个文件 CRLF 计数全为 0），所以**不影响正确性、不影响测试、不影响 index**，
  只影响**验收手段** —— 我们反复使用的"逐字节搬运证明"在新 clone 上**静默失效**，
  检查命令不再报错，只是从此不再成立。
- **处理**：仓库根加 `.gitattributes`：

  ```
  * text=auto eol=lf
  *.py text diff=python
  *.md text
  ```

  加完之后全新 clone 的工作区文件与 index blob 重新逐字节一致。
- **由此确立的验收纪律**：**搬运保真以 `git cat-file` 取出的 index blob 为准，
  不以工作区文件为准。** 需要与源项目逐字节比对时，
  先 `git cat-file -p HEAD:<path>`，不要直接 diff 工作区文件。

### KI-05　三个搬运件与两个移植工具没有测试覆盖【覆盖缺口，非缺陷】

| 未覆盖对象 | 行数 | 说明 |
|---|---|---|
| `ingest/hatanaka.py` | 240 | 全部公开函数（`decompress_hatanaka` / `read_hatanaka_rinex` / `self_check` / `split_sections` / `parse_header`）零测试。**源项目自己没有真实 Hatanaka 样本**，其 docstring 就写着"解码器未验证"。`reader.sniff` 对 CRINEX 一律报 `supported=False`，解压路径目前是死的。 |
| `ingest/registry.py` | 173 | `field_width_for` 是 brief 明确列出的 Produces 接口，目前**只被间接调用过一次**（`ObservationFile._open` 对 TESTSTN 查表落空返回 `None`），优先级逻辑（环境变量 > 站名 > 生产程序）无测试。 |
| `reader.sniff` 的 `RINEX3-NAV` 分支 | — | 变异测试确认：把 `if "OBSERVATION DATA" in lines[0]` 改成 `if True:` 不会被任何测试捕获。 |
| `tools/sync_code_counts.py` | 137 | **无测试**（Task 6 brief 未要求）。靠实跑验证：`python tools/sync_code_counts.py` 后生成块与 `tools/audit_claims.py` 回源结果逐字一致（Task 6 复评实测）。行数为本仓库文件实际行数（实测 2026-10-13）。 |
| `tools/make_cli_figures.py` | 186 | **无测试**（Task 6 brief 未要求）。靠 `--help` 实跑 exit 0 验证；PNG 渲染另见 KI-09（第三方依赖）。行数为本仓库文件实际行数（实测 2026-10-13）。 |

**待办**：接真实数据前，至少给 `registry.field_width_for` 补一组参数化测试
（站名大小写、环境变量覆盖、生产程序兜底、未登记站返回 `None`），
并给 `sniff` 的 NAV / RINEX4 / CRINEX 三个"识别得出但不支持"分支补测试 ——
这三条是 `UnsupportedFormat` 的 `how_to_fix` 文案的唯一来源，
智能体将来要靠它们给用户指路。

**附带**：`reader.approx_xyz` 的 NaN 守卫（`if not v or any(x != x for x in v)`）
无覆盖；把 `if False:` 不会被捕获。

### KI-06　`registry` 的站名表与 `GNSS_TEC_FIELD_WIDTH` 属源项目口径【口径提醒】

- `RINEX2_FIELD_WIDTH`（15 站）、`STATION_NOTES`（9 站，含 KAZA 的差分码偏差
  +5.30~+10.53 m、MTKA 的弧段爆炸 773/18 等实测结论）、`GNSS_TEC_FIELD_WIDTH`
  环境变量名，全部是**源项目数据集**的实测结论，对应源项目
  `data/external/publicdata/` 下的文件。
- **本项目尚未接入任何观测数据**，这些登记目前是"别人的记忆"。
- **待办**：一旦本项目接自己的数据，`RINEX2_FIELD_WIDTH` **需要重新实测**，
  不能直接沿用。

### KI-07　`synthetic.generate` 的 `slips` 注入是单历元扰动，不是持续周跳【已确认】

- **位置**：`src/fieldstation/synthetic.py:81-87`（`DEFAULT_SLIP` 的语义声明）+
  `:194-200`（`generate()` 里的注入循环）
- **归属**：搬运件既有行为，**非本项目引入**（源 `gnsstec/synthetic.py` 同款循环，
  本仓库逐字搬运）。
- **触发条件**：拿 M0 fixture 去标定周跳检测器的检出率（M2 及以后；源项目
  `test_qc.py::TestJumpDetectionRate` 正是这么用的，那条测试本仓库未迁）。
- **症状**：注入的异常只加在 `index` 指定的那**一个**历元上，后续历元不跟随；
  把它当"持续周跳"来算检出率，会得到无意义的数。
- **机制**：`for s in slips.get(key, []): if int(s["index"]) == i:` —— 只在
  `i == index` 的那一行给 `q1`/`q2` 加 `jump_cycles`，没有对后续历元的累加。
- **证据**：`tests/test_pipeline.py::TestFixtureContent` 构造性验证 —— 二阶差分
  `q[i+1] - 2*q[i] + q[i-1]` 在注入点读到 `-2.0 cycle`（= `-2 * jump_cycles`）；
  去掉 `slips` 配置扰动即消失（`test_perturbation_is_traceable_to_config`）。
- **影响面**：M0 不受影响（评测集只需要"自带可判分的已知异常"，单历元扰动够用）。
- **为什么不修**：改注入语义等于改搬运件；Task 5 实现时已按源实现如实记录，
  未"修正"源语义。`PROVENANCE.md` 对应行只留指向本条的指引，细节以此处为准。

### KI-08　spec §2 目录树的两个叶子在 M0 未落地【设计决定：登记延后，非缺陷】

- **位置**：`src/fieldstation/cli.py`（spec §2 第 143 行「统一入口」）与
  `harness/REPRODUCE.md`（spec §2 第 147 行）—— 两者本仓库 M0 均**不存在**
  （实测 `git ls-files src/fieldstation/cli.py harness/REPRODUCE.md` 零命中，
  2026-10-13）。
- **性质**：**这是设计决定，不是缺陷**，但它在 M0 期间**静默掉落、从未登记**
  （终审 Important-4 指出）：计划 Task 5 的注释写着"`cli.py` … 本仓库的入口
  留到 Task 7/8 再建"，而 Task 7/8 的 brief 都没有包含它；`REPRODUCE.md`
  从未被任何任务承接。补登记即本条。
- **延后落点**：
  - `cli.py` → **M3**（与真实模型通道、角色配置同批 —— 没有真 provider 与
    真数据，"统一入口"无物可统一，先建就是投机骨架）。
  - `harness/REPRODUCE.md` → **随 DoD-4「复现性文档化」**一并补
    （DoD-4 的实测输出 `logs/replay_20261013.json` 已入库，文档化步骤挂账）。
- **M0 的验收口径**：M0-1「目录与 spec §2 一致」字面不成立。spec §2 与实际
  树的全部差异（2026-10-13 逐叶子核对 `git ls-files src/fieldstation harness/`）：
  1. `cli.py`、`harness/REPRODUCE.md` —— **缺，本条登记**（原属静默掉落）；
  2. `agents/runtime/`（目录）落成 `agents/runtime.py` 单文件 —— M0 只做最小
     运行循环，一个文件够用；
  3. `agents/tools/`、`agents/memory/` 两目录不存在 —— 随 spec §4 三项能力
     （工具注册、消息路由/共享黑板、角色配置）整体推迟 M3，此为**已有裁定**
     （终审 §4「已知 open item #2，defer 正确」），非本条新登记；
  4. `constants.py` / `schema.py`（→`model.py`）不在 `ingest/` 下而在包根 ——
     为避免包级循环，计划开头「对 spec §2 目录树的一处偏离」已声明。
  除上述各项外，spec §2 其余叶子（README/CLAUDE/PROVENANCE、ingest/rules/store、
  harness 两件、tools 三件、tests、data/logs/figures/config/docs）均在位
  （`git ls-files` 逐项核对，2026-10-13）。

### KI-09　`tools/make_cli_figures.py` 依赖第三方库 matplotlib【设计决定：点名豁免】

- **位置**：`tools/make_cli_figures.py:72-74`（函数级 `import matplotlib`）。
- **冲突点**：计划 Global Constraints 与 `CLAUDE.md` §4 都写「纯标准库，
  无第三方依赖」，而 spec §1.2 又点名要移植该工具 —— **PNG 渲染本质上做不了
  纯标准库**（标准库无位图字体栅格化/绘图后端），约束与任务书在这一点上打架。
  终审 Important-5 指出：全链路原本**没有任何裁决**，本条即补上的裁决登记。
- **裁决（设计决定）**：**`tools/make_cli_figures.py` 是可选工具，豁免
  「纯标准库」约束；仓库核心（`src/` `tests/` `harness/`）必须保持纯标准库。**
  计划 Global Constraints 已同步加同名点名豁免。
- **影响面（实测）**：matplotlib 是**函数级** import，只在 `render()` 被调用时
  才加载 —— `tests/`、`harness/` 均不 import 该模块（全仓 grep 确认），
  所以无 matplotlib 的机器上测试与五项门禁照常全绿，只是跑不了出图。
  本机 matplotlib 3.11.1 在位（终审实测 `--help` exit 0）。
- **无覆盖**：该工具无测试（Task 6 brief 未要求），见 KI-05 表。

---

## 维护约定

1. 新发现的缺陷**先登记在这里，再决定修不修**；"不修"的理由必须写出来。
2. 每条技术论断都要能指出证据出处；推断要标"未验证"。
3. 条目被修复后不要删，改为在条目下追加"已于 <日期> 修复，见 <commit>"。
4. `.superpowers/` 下的任务报告**不是**登记处 —— 那是过程记录，会被归档或丢失。
