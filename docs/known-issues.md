# 已知缺陷与覆盖缺口登记

*本文件登记**已实测确认**的缺陷、以及**已知但未覆盖**的行为。*

**为什么单独建这个文件**：`.superpowers/` 被 gitignore，任务报告会随归档消失或丢失。
缺陷条目只写在报告里，等于没有登记 —— 一年后没人知道 `rinex2.py` 为什么会崩。
所以凡是"知道有问题、但决定不修"的东西，都必须在这里留一条。

**规则**：写进本文件的每条技术论断，都要能指出证据出处（实测命令 / 构造性验证 /
规范条文）；**没有证据的猜测写在这里也要标明"未验证"**，不能混进已确认条目。

---

## 条目

### KI-01　RINEX 2 头段 `PRN / # OF OBS` 记录在**不合规行**上让解析抛未捕获异常【已解决 · 2026-10-14，见文末修复记录】

> **⚠️ 本条 2026-10-14 经 issue #4 第 1 轮实测更正**：原文断言「PRN 占据第 1-3 列
> 是 RINEX 2.11 规范规定的位置」「规范写法必崩」「现有样本不崩是侥幸」——**三个
> 论断全部为假**，规范原文与实测均已证伪（证据见下）。原文保留的问题（不合规行
> 未捕获崩溃）本身是真的，错的是触发条件的定性与影响面推断。

- **位置**：`src/fieldstation/ingest/rinex2.py:263-267`（原始行号，修复后该分支
  为 263-276，见文末修复记录）
- **归属**：搬运件既有行为，**非本项目引入**。源自 GNSS接收机TEC反演项目，
  本仓库逐字搬运（该文件与源文件的唯一差异是 L5 的 docstring 路径指向）。
- **触发条件（2026-10-14 更正）**：头段存在 `PRN / # OF OBS` 记录，**且该行第 1-3
  列非空 —— 这是不合规行**。RINEX 2.11 与 RINEX 2 原版（Gurtner, Rev. April 1993）
  Table A.1 对该记录的格式串均为 **`3X,A1,I2,9I6`**（续行 `6X,9I6`）——第 1-3 列按
  规范**必须空白**。规范行 `ln[0:3].strip()` 为空 → `if sid:` 为假 → 整行跳过，
  **不崩**。
- **症状**：不合规行在 `rinex2.py:267` 抛未捕获
  `ValueError: could not convert string to float: 'PRN'`。
- **机制**：第 1-3 列非空时 `sid` 非空、进入赋值分支；标签必出现在 `ln[40:]`
  （`_is` 判据），而 `rest = ln[3:].split()` 的切片从第 4 列开始，**必然**把第 61 列
  起的标签词 `PRN` / `/` / `#` / `OF` / `OBS` 一起切出来，`int(float('PRN'))` 直接
  抛错。即：**该分支一旦被真正执行就必崩**——规范行只是靠 `sid` 为空绕开了它。
- **规范行的实际行为（2026-10-14 更正）**：不崩，但 `sid == ''` 导致记录被**静默
  跳过**，`prn_obs` 恒为空。该副作用**当前无可观测影响**：`prn_obs` 全仓只写不读
  （仅 3 处命中：`Obs2Header.__slots__` 声明、`__init__` 初始化、L267 赋值），
  故本 issue 只修崩溃、不做"把规范行解析出来"（修了也没有行为变化，白改）。
- **证据（全部实测，2026-10-14，issue #4 第 1 轮）**：
  1. **规范原文**：RINEX 2.11 `rinex.format.pdf` Table A.1（63 页 / 114,389 字符
     全文抽取定位）与 1993 原版同一表格行格式串逐字相同：`3X,A1,I2,9I6`。
     旁证 §0.3 "A blank satellite identifier is allowed in pure GPS files only"
     ⇒ A1 在第 4 列，PRN 数字在第 5-6 列。
  2. **构造性复现**（复现命令：
     `$env:PYTHONPATH="src"; python -m unittest tests.test_rinex2_prn_header -v`
     —— 修复前该命令 RED、修复后 GREEN；探针脚本 `issue4_probe.py` 全文与输出
     原文存 issue #4 报告第 1 轮附录 §3.2）：

     | 行变体 | 结果 |
     |---|---|
     | 规范行 `3X,A1,I2,9I6`（含纯 GPS 系统标识空白变体） | `OK`，`prn_obs={}`，不崩 |
     | JPS2RIN 写法（PRN 在第 5 列，同 BADG） | `OK`（即规范行路径） |
     | **第 1-3 列非空的不合规行** | `EXC ValueError: could not convert string to float: 'PRN'` |
  3. **真实数据影响面**（源项目 `data/external/publicdata` 全树只读扫描——即
     `PROVENANCE.md` 源仓库列登记的那个数据集；输出原文存 issue #4 报告 §3.3）：
     **231 个**真实 RINEX 文件中 **66 个**含该
     记录，**第 1-3 列非空的：0 个**；`teqc` 产出 45 个、`gfzrnx` 产出 5 个文件
     **根本不含该记录**（不可能触发该分支）。原文「teqc/gfzrnx 接入前会崩」是
     依据生成器文档的**推断，实测 0 例支持**——原文的"⚠️ 未验证部分"本就写明
     该说法"不是实测"，此次真实扫描补上了实测，结论是**反向的**。
- **影响面（2026-10-14 更正）**：崩溃只对**第 1-3 列非空的不合规行**可达，全部可得
  真实样本 **0 例**；规范行被静默跳过无可观测行为（`prn_obs` 只写不读）。
  M0 不接任何真实数据，**M0 不受影响**。
- **为什么不修（M0 时点的原决定，保留）**：`rinex2.py` 是逐字搬运的承重件。改它会
  当场摧毁本项目赖以成立的"哪些行是一年成果、哪些是搬运"的可证性。
  **一个潜伏的解析崩溃，代价小于一份说不清的结题材料。**
  （该代价分析至今成立；但其前提"规范写法会崩"已被证伪——重新裁决见
  `docs/superpowers/m0-decisions.md` 裁决 14 的 2026-10-14 更正标注。）
- **已于 2026-10-14 修复，见 commit `185d5f0`（issue #4，分支
  `fix/rinex2-prn-header`）**：M0 已合并归档、搬运可证性已落袋
  （PROVENANCE + git history + 逐 blob 记录），此后改该文件是**被追踪、被记录的
  有意修改**，不再破坏已有可证性 —— 代价分析的适用前提消失，故修复。
  - **改动**：`rinex2.py:266-276` 的 `if sid:` 分支整体包 `try/except ValueError`，
    不合规行**整条记录跳过、不猜解析结果**；仅此一处，未动阈值与其他行。
  - **回归 a（夹具）**：`tests/test_rinex2_prn_header.py` 2 测 —— 修复前 RED
    （`ValueError: could not convert string to float: 'PRN'`，原文存 issue #4
    报告），修复后 GREEN。
  - **回归 b（真实样本逐字节一致，要害项）**：`badg0010.24o.gz` →
    `ObservationFile(...).observations(["GPS"])`，修复前后导出 4964 条、
    1,635,545 字节、SHA256 均为
    `bb3ea8c592bfc4e9219b8dcbc8cbe0348b2b248099faa4cb5a7934c2de32dc88`，
    首条 `station='BADG' … epoch_utc='2024-01-01T02:48:30.000Z'` —— **逐字节一致**。
  - **回归 c**：固定命令 118 OK skip 0；selftest 5/5 exit 0；audit 3/3 exit 0。

### KI-02　`ObservationFile.interval_s` 在头段无 `INTERVAL` 记录时返回 NaN【已解决 · 2026-10-16，见下】

- **位置**：`src/fieldstation/ingest/reader.py:296-304`（原始行号；修复后该属性为
  292-307，见文末修复记录）
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
- **为什么不修（该任务时点的原决定，保留）**：同上，搬运件既有行为，不在该任务改。
  **该前提现已消失**：M0 已于 2026-10-14 合并归档，搬运可证性由 `PROVENANCE.md`
  + git history 落袋，此后改搬运件是**被追踪、被记录的有意修改** —— KI-01 与
  KI-10 已按同一口径处理。

#### 已于 2026-10-16 修复，见 commit `748f8f8`（issue #35，分支 `fix/interval-s-fallback`）

- **改动**：`reader.py` 的 `interval_s` 属性体一处，删 6 行 / 增 9 行（净 +3）。
  判定改为 `if v == v and v > 0:`（`v == v` 是本文件 `approx_xyz` 用的同一个
  NaN 写法），末尾改为 `return 30.0`；同时删掉那段恒假死代码
  `ts = … if False else None`，**不补「由历元时间戳反推」的实现** ——
  本条登记的设计意图就是兜底 30.0。嗅探判据、能力报告其余字段、
  `observations()`、双频配对与两条回退链一字未动。
- **回归（先红后绿）**：`tests/test_reader_interval_s.py` 3 条。修复前两条 RED
  （`interval_s` 与 `capability_report()["interval_s"]` 实测都是 `nan`）；
  第三条用 `RINEX2_OBS` 的 `INTERVAL 15.00` 作对照，防止「干脆不看 `INTERVAL`、
  直接写死 30.0」也能蒙过测试。修复后 3/3 GREEN。
- **真实样本逐字节一致（要害项）**：`badg0010.24o.gz` 经
  `ObservationFile(path).observations(["GPS"])` 的产出，修复前后各 4964 条、
  1,635,545 字节、SHA256 同为
  `bb3ea8c592bfc4e9219b8dcbc8cbe0348b2b248099faa4cb5a7934c2de32dc88`
  —— 与 KI-01 / KI-10 记录值逐字符相同，说明前后两次用的是同一把尺子；
  首条字段一致。该样本修复前的 `interval_s` 就是 30.0（不是 nan），说明它自带
  `INTERVAL` 记录、不走兜底分支，故该值同样前后不变。
- **门禁**：236 tests OK（skipped 0）、`harness/selftest.py` 5/5、
  `tools/audit_claims.py` 退出码 0；`PROVENANCE.md` 的 reader 行已加改动列。

### KI-03　读取观测文件时泄漏文件句柄【已解决 · 2026-10-16，见下】

- **位置**：`rinex2._gzip_bytes`、`rinex3.Rinex3Obs.__init__`、`reader._read_text`
  —— 三处都是 `open(path, "rb").read()`，不关句柄。
- **症状**：每次打开观测文件抛一条
  `ResourceWarning: unclosed file <_io.BufferedReader …>`；
  长时间批量读取会积累未关闭的句柄。
- **证据**：Task 4 实现阶段在 `tests/test_ingest.py` 上直接观察到（见该文件顶部注释）。
- **当时的处置**：`tests/test_ingest.py::_open_observation_file` 用
  `warnings.catch_warnings()` 在**调用点**精确屏蔽（unittest 的 runner 会把模块级
  filter 覆盖回 `default`，所以必须包在调用点上）。**屏蔽不是修复。**
- **为什么不修（该任务时点的原决定，保留）**：搬运件既有行为，改了就不是搬运了。
  **该前提现已消失**：M0 已于 2026-10-14 归档，搬运可证性由 `PROVENANCE.md` +
  git history 落袋，此后改搬运件是**被追踪、被记录的有意修改** —— KI-01、KI-10、
  KI-02 已按同一口径处理。

#### 已于 2026-10-16 修复，见 commit `e23cd43`（issue #35，分支 `fix/ki03-close-handles`）

- **改动**：三处各删 1 行 / 增 2 行，统一改成 `with open(path, "rb") as fh:` ——
  与同包 `hatanaka.py` 原本就是的写法一致。**只变「怎么读」，不变「读什么」**，
  三处的返回值逐字节未变（见下）。
- **回归（先红后绿）**：`tests/test_ingest_handles.py` 4 条，修复前**全红**，且每条
  精确抓到一处：RINEX 2 路径（`rinex2._gzip_bytes`）、RINEX 3 路径
  （`rinex3.Rinex3Obs.__init__`）、CSV 路径（`reader._read_text`）、`.gz` 输入再走
  一遍。判据是 `ResourceWarning` + `"unclosed file"` **一条都不许有**，不是
  「少于几条」。CSV 那条是必需的：`_read_text` 只在 `ObservationFile._open` 的
  CSV 分支被走到，仓库原先没有任何夹具走它，故内联一份最小宽表。
- **顺手拆掉屏蔽**：`tests/test_ingest.py` 与 `tests/test_reader_interval_s.py` 里
 用来压这条告警的 `warnings.catch_warnings()` 已删除。拆掉后整套测试的输出里再无
  `unclosed file` 噪声 —— 这反过来证明没有第四处泄漏。
- **真实样本逐字节一致（要害项）**：同一探针在修复前后各跑一遍，输出逐行相同：

  | 探针 | 结果（前后一致） |
  |---|---|
  | `rinex2._gzip_bytes(badg0010.24o.gz)` | 15,299,992 字节，sha256 `27aa406d7e3556e85b1dfacaabd256e056b01b75fb122b5ce4efbaee69d38dfc` |
  | `Rinex3Obs(TWTF…30S_MO.rnx.gz).text` | 19,468,459 字符，sha256 `186a9918bc265b63360b81c79164515ee54a338ead62db5f61f37a6a894a3e6b` |
  | `reader._read_text`（两份样本） | 与上两行的 sha256 分别相同 |
  | 端到端 RINEX2 | 4964 条、1,635,545 字节，sha256 `bb3ea8c592bfc4e9219b8dcbc8cbe0348b2b248099faa4cb5a7934c2de32dc88` |
  | 端到端 RINEX3 | 115432 条、38,614,095 字节，sha256 `1c17eea8d7ae350f8d43a48f18eaf5e77a9b57a249e38c9bde9aa175587473c0` |
  | 端到端 CSV | 4 条，sha256 `61d5363d22c9bb5613040d5865ae7730ee48094f10c949fa0d3122a1fe441f15` |

  RINEX2 那条 `bb3ea8c5…dc88` 与 KI-01 / KI-10 / KI-02 记录的尺子逐字符相同；
  RINEX3 的 115432 条与 `tests/test_ingest.py` 文档里记的数吻合。
- **门禁**：240 tests OK（skipped 0）、`harness/selftest.py` 5/5、
  `tools/audit_claims.py` 退出码 0；`PROVENANCE.md` 的 rinex2 / rinex3 / reader
  三行已各加改动列。

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

### KI-05　三个搬运件没有测试覆盖；两个移植工具已补测【覆盖缺口，非缺陷，2026-10-14 更新】

| 未覆盖对象 | 行数 | 说明 |
|---|---|---|
| `ingest/hatanaka.py` | 240 | 全部公开函数（`decompress_hatanaka` / `read_hatanaka_rinex` / `self_check` / `split_sections` / `parse_header`）零测试。**源项目自己没有真实 Hatanaka 样本**，其 docstring 就写着"解码器未验证"。`reader.sniff` 对 CRINEX 一律报 `supported=False`，解压路径目前是死的。 |
| `ingest/registry.py` | 173 | `field_width_for` 是 brief 明确列出的 Produces 接口，目前**只被间接调用过一次**（`ObservationFile._open` 对 TESTSTN 查表落空返回 `None`），优先级逻辑（环境变量 > 站名 > 生产程序）无测试。 |
| `reader.sniff` 的 `RINEX3-NAV` 分支 | — | 变异测试确认：把 `if "OBSERVATION DATA" in lines[0]` 改成 `if True:` 不会被任何测试捕获。 |

**已补（2026-10-14，issue #5）**：两个移植工具不再是零覆盖 ——

- `tools/sync_code_counts.py` → `tests/test_sync_code_counts.py`（4 测）：
  **正例 + 负例**，整条链在**仓库外副本**（tempfile 里的独立小 git 仓库）上跑，
  不污染本仓库：负例先把 README 块写成错数（999），断言
  `audit_claims.py` 识别为 `FAIL` 且退出码 1；正例断言
  `sync_code_counts.py` 把错数改写为 `git ls-files` 实测值（含「现状」
  占位行的兑现）；闭环断言改写后 `audit_claims.py` 全过。
  另有真仓库上的 `--help` exit 0。**用例不往真 README 写**（同步脚本把
  README 位置写死，负例在真仓库上跑等于把错数写进真文件）。
- `tools/make_cli_figures.py` → `tests/test_make_cli_figures.py`（3 测）：
  `--help` 不碰渲染 exit 0；**matplotlib 缺席时优雅中止**（exit 2 +
  `[阻断]` 文案 + 零 Traceback + 不建输出目录，缺席用 PYTHONPATH 垫片在
  子进程里模拟，装了/没装 matplotlib 的机器都可复现）；渲染实测按环境
  分支断言（在位 → 真渲染 PNG 到临时目录）——**不用 `skip`**，本仓库
  skip==0 是门禁。降级实现见 KI-09。

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

### KI-08　spec §2 目录树的两个叶子在 M0 未落地【已于 2026-10-14 补建，见文末】

- **位置**：`src/fieldstation/cli.py`（spec §2「统一入口」；原文记第 143 行，
  2026-10-14 复核：spec §1.1 回填后行号漂移，现为 **168 行**）与
  `harness/REPRODUCE.md`（原文记第 147 行，现为 **172 行**）——
  两者本仓库 M0 均**不存在**（实测
  `git ls-files src/fieldstation/cli.py harness/REPRODUCE.md` 零命中，
  2026-10-13）。
- **性质**：**这是设计决定，不是缺陷**，但它在 M0 期间**静默掉落、从未登记**
  （终审 Important-4 指出）：计划 Task 5 的注释写着"`cli.py` … 本仓库的入口
  留到 Task 7/8 再建"，而 Task 7/8 的 brief 都没有包含它；`REPRODUCE.md`
  从未被任何任务承接。补登记即本条。
- **原延后落点**（2026-10-13 裁定，现均已执行完毕，保留原文供追溯）：
  - `cli.py` → **M3**（与真实模型通道、角色配置同批 —— 没有真 provider 与
    真数据，"统一入口"无物可统一，先建就是投机骨架）。
  - `harness/REPRODUCE.md` → **随 DoD-4「复现性文档化」**一并补
    （DoD-4 的实测输出 `logs/replay_20261013.json` 已入库，文档化步骤挂账）。
- **M0 的验收口径**：M0-1「目录与 spec §2 一致」字面不成立。spec §2 与实际
  树的全部差异（2026-10-13 逐叶子核对 `git ls-files src/fieldstation harness/`）：
  1. `cli.py`、`harness/REPRODUCE.md` —— **缺，本条登记**（原属静默掉落）
     → **2026-10-14（issue #5）已补建**，见本条末尾的落地说明；
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

#### 2026-10-14 落地说明（issue #5）

- **`harness/REPRODUCE.md` —— 已建**：DoD-4 的重跑步骤清单，五条命令
  （固定测试 / selftest 门禁 / replay 回放 / audit 回源 / sync 同步）
  **每条都附 2026-10-14 的实跑输出片段**，无实测证据的数字不写入。
- **`src/fieldstation/cli.py` —— 已建（M0 范围：工具分发）**，
  这是对原「延后 M3」裁定的**有范围的部分覆盖**，取舍如下：
  - **建的是什么**：五条纪律命令的统一转发入口
    （`selftest` / `replay` / `audit` / `sync` / `figures`），子进程转发、
    参数与退出码原样透传，零重实现；`tests/test_cli.py` 4 测钉住
    `--help`、未知子命令 exit 2、缺子命令 exit 2、真实转发。
  - **为什么 M0 可以建**：原裁定的理由是"无物可统一" —— 该理由对
    **智能体编排入口**（真 provider、角色配置、多轮任务）依然成立，
    但对**工具分发**这半边不成立：五个转发目标（harness 两件 + tools 三件）
    在 M0 已全部存在且实测通过，正是 `REPRODUCE.md` 要重跑的那五条命令，
    从一个门进比记五条路径更不容易漏（DoD-4 的可达性收益）。
    同时 issue #5 的主诉就是"spec §2 目录树字面不成立"—— 登记不改事实，
    建了才改。
  - **不建的是什么**：智能体编排入口**仍属 M3**，cli.py 里没有任何
    预铺的空子命令或 TODO —— 判据是 `COMMANDS` 表（cli.py）：**子命令
    必须有站着的转发目标**，M3 加子命令时随其背后实现一起加。
  - **代价（明知且接受）**：`harness/selftest.py` 的
    `ORIGINAL_SRC_PREFIXES` 豁免清单为它加了一项（cli.py 是本项目原创，
    PROVENANCE.md 按其自述口径不收原创行）—— 这是门禁的一次有意识口径
    扩展，注释已写明理由。
- 布局守卫：`tests/test_layout.py` 的 `REQUIRED` 已加入这两个叶子，
  再次静默掉落会有测试变红。

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
- **覆盖与降级（2026-10-14 补，issue #5）**：该工具已有测试
  （`tests/test_make_cli_figures.py` 3 测，见 KI-05）。同时 `main()` 增加
  渲染前置判断 `_has_matplotlib()`：**在建目录、跑命令之前**探测，
  缺席时打印 `[阻断] … 未安装 matplotlib` 并 **exit 2** —— 不崩
  `ImportError`、不留 `_raw` 半成品、不产假图。补测前实测过反面行为：
  无 matplotlib 子进程退出码 1 且未捕获 `ImportError` Traceback
  （先跑完采集命令再崩，留下无人认领的中间文件）。缺席环境由测试用
  `PYTHONPATH` 垫片（import 即 `ImportError`，与未安装等价）在子进程
  实测复现，装了/没装 matplotlib 的机器都能跑该用例。

---

### KI-10 `field_width_for` 遇空值环境变量抛未捕获 `ValueError`【已解决】

- **位置**：`src/fieldstation/ingest/registry.py` env 解析循环（修复前 `return int(v.strip())` 处）
- **触发条件**：运维手写 `GNSS_TEC_FIELD_WIDTH` 时出现**半截写法** `KEY=`（键在、值为空）
- **症状**：`ValueError: invalid literal for int() with base 10: ''`，数据接入链直接崩
- **归属**：搬运件既有行为，**非本项目引入**（源 `GNSS接收机TEC反演/code/gnsstec/io/obs_registry.py`）
- **与 KI-01 同类**（不合规输入 → 未捕获 ValueError），但本项在 M0 合并**之后**处理：
  此时搬运可证性已由 `PROVENANCE.md` + git history 落袋，修复是**被追踪的有意修改**
- **修法**（2026-10-14，PR #17）：跳过空值条，**不猜默认宽度**——猜值会静默吞掉配置错误；
  非数值（如 `15px`）**仍然抛出**，那是看得见的笔误，与空值半截写法应区别对待
- **回归证据**：
  - `tests/test_registry_field_width.py` 5 条：空值跳过、空值不遮蔽后续合法项、
    脏分隔符/垃圾项、全无效回落到登记表、空 env
  - 修复前该 5 条**有 3 条报错**（RED 已留档）
  - 真实样本 `badg0010.24o.gz` 修复**前后逐字节一致**（4964 条，首条字段相同）
- **影响面**：M0 不接真实数据故当时不紧急；M2 接入真实台站配置前必须处理（现已修）

## 维护约定

1. 新发现的缺陷**先登记在这里，再决定修不修**；"不修"的理由必须写出来。
2. 每条技术论断都要能指出证据出处；推断要标"未验证"。
3. 条目被修复后不要删，改为在条目下追加"已于 <日期> 修复，见 <commit>"。
4. `.superpowers/` 下的任务报告**不是**登记处 —— 那是过程记录，会被归档或丢失。
