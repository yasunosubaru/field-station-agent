# ClickHouse 单机版（E4 高性能引擎）

- 日期：2026-11-05（本机实测）
- 状态：**跑通了**——服务起得来、表建得出、200,000 行灌得进、20 条聚合跑得完
- 工具：`tools/ch_bench.py`（只走 HTTP、只用标准库）；测试：`tests/test_ch_bench.py`
- 一句话：**没有 Windows 原生构建，所以二进制是 Linux 单文件、由 WSL 2 执行；端口仍是 `127.0.0.1:8123`，Windows 侧照常用 HTTP 打它。**

---

## 0. 现在是什么样（现场记录）

| 项 | 值 |
|---|---|
| 版本 | `ClickHouse 26.11.1.1344 (official build)`（master 构建） |
| 下载件 | `.deps/clickhouse/clickhouse`，**228,666,158 字节（218.1 MiB）** |
| sha256 | `48c8dbed7358e9ba95b3a4b019be6e711340db7bf54ad451c501d2dee472b361` |
| 来源 | `https://builds.clickhouse.com/master/amd64/clickhouse`（HTTP 200，Last-Modified 2026-11-04 16:38 UTC） |
| 下载耗时 | **≈75 s**，单线程 `curl --retry 10 --continue-at -`，≈2.9 MB/s |
| 执行副本 | WSL ext4 上 `~/.local/share/fsa-clickhouse/clickhouse`，**903,259,760 字节**（自解压后） |
| HTTP 端口 | `127.0.0.1:8123`（native 9000；mysql/postgres 端口已关） |
| 数据目录 | `.deps/clickhouse/data`（= WSL 里 `/mnt/h/…/.deps/clickhouse/data`） |
| pid / 日志 | `.deps/clickhouse/run/`（`server.json`、`clickhouse.pid`、`server*.log`） |
| 启动方式 | `clickhouse server --daemon`，SIGTERM 优雅停止 |
| 命令行 | `.deps\clickhouse\clickhouse.cmd --version`（**WSL 外壳，不是原生 exe**，见 §1） |

---

## 1. 为什么是 WSL：没有 Windows 原生构建

任务原本想下载 `clickhouse.exe`，实测这条路**不存在**，证据三条：

| 尝试 | 结果 |
|---|---|
| `HEAD https://builds.clickhouse.com/master/amd64/clickhouse.exe` | **403**，S3 正文是 `AccessDenied`（对象不存在；同目录的 Linux `clickhouse` 是 206/200 正常） |
| `winget search clickhouse` | 只有 `ClickHouse Client by SQLPro`（商店客户端）等，**没有服务端包** |
| 官方文档「Install ClickHouse on Windows 10」 | 给的方案就是 **WSL 2** |

所以：二进制用官方的 **Linux 单文件**（就是这个项目 `docs/operations/deps.md` 里
「随包」那一份），由 WSL 2 执行；WSL 的 localhost 转发让 Windows 侧 `127.0.0.1:8123`
直接可用，`tools/ch_bench.py` 和 `src/fieldstation/data/engines.py` 的
`ClickHouseEngine`（HTTP，默认 `127.0.0.1:8123`）都不用知道底下是 Linux。

**两个执行细节**，不知道会浪费时间：

1. **ELF 不能放在 `/mnt/h` 上直接跑**：`Unable to obtain inode for exe '…'`（9p 上
   `/proc/self/exe` 解析不到）。所以下载件留在仓库、执行前拷一份到 ext4。
2. **218 MB 的下载件一跑就变大 4 倍**（903 MB，`Decompressing the binary.......`）。
   判断"副本是不是同一版"要看 `.srcsize` 标记里的**下载件大小**，比解压后的文件大小
   会永远不等、每次都白拷 900 MB。

想要一个"像 exe 一样敲"的入口，用 `.deps\clickhouse\clickhouse.cmd`（ASCII 的
cmd 外壳，转给 WSL 上那份副本）：

```powershell
.deps\clickhouse\clickhouse.cmd --version
.deps\clickhouse\clickhouse.cmd local --query "SELECT 1+1"
```

它**不是** `clickhouse.exe`，也别改名叫 `.exe`——名字一改，下一个人就会以为这是原生构建。

---

## 2. 取二进制（可复现）

```powershell
$dst = ".deps\clickhouse\clickhouse"
New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
curl.exe -sS -L --retry 10 --retry-delay 5 --retry-all-errors `
    --continue-at - --output $dst `
    https://builds.clickhouse.com/master/amd64/clickhouse
(Get-FileHash -Algorithm SHA256 $dst).Hash   # 必须等于 §0 那个 sha256
```

`--continue-at -` 让中断后重跑能续传；**别用多线程下载器**，对方的 S3 对任意 Range
没问题，但单线程已经 3 MB/s，省不下多少又多了校验麻烦。

备选来源（本次没用，因为更慢）：GitHub release 的
`clickhouse-common-static-<ver>-amd64.tgz`（解压出 `usr/bin/clickhouse`，同样是 ELF）。

---

## 3. 起 / 停 / 看状态

```powershell
python tools/ch_bench.py --start     # 起服务并等就绪（约 2–4 s）
python tools/ch_bench.py --status    # 版本 + uptime + 各表行数
python tools/ch_bench.py --stop      # SIGTERM，等到 8123 释放才算成功
```

`--start` 做四件事：把下载件拷到 ext4（已是最新则跳过）→ `clickhouse server --daemon`
→ 把 pid/日志/数据目录写进 `.deps/clickhouse/run/server.json` → 轮询 `SELECT 1` 直到
就绪（默认最多 90 s，失败时把日志尾巴打出来）。

`--stop` 的顺序是"先认 pid、再按 cmdline 兜底"：读 `server.json` 里的 pid 发
SIGTERM；pid 已经不在时用 `pgrep -af 'clickhouse server'` 找 **cmdline 含本数据目录**的
进程再杀一次。这样 pidfile 丢了也能收干净，同时不会误杀机器上别人的 ClickHouse。
**杀完必须验**：轮询端口直到 `connect` 失败；还在监听就先 KILL，再报"仍在监听"。
（脚本自己不会在 `--start` 之后自动停——跑完基准请务必 `--stop`，别把 8123 留着。）

手工等价命令（排查用）：

```bash
# WSL 内
~/.local/share/fsa-clickhouse/clickhouse server --daemon \
  --pidfile=/mnt/h/…/.deps/clickhouse/run/clickhouse.pid \
  -- --path=/mnt/h/…/.deps/clickhouse/data \
     --http_port=8123 --tcp_port=9000 --mysql_port=0 --postgresql_port=0 \
     --listen_host=0.0.0.0
curl -sS 'http://127.0.0.1:8123/?query=SELECT%20version()'
```

`--listen_host=0.0.0.0` 是 **WSL2 NAT 模式的必要条件**（只绑 127.0.0.1 的话 Windows 的
localhost 转发过不来）。它暴露的范围仅限 WSL 内部网段 + 宿主机回环，局域网里的机器
连不到；`--mysql_port=0 --postgresql_port=0` 顺手关掉两个用不上的监听端口
（默认 9004/9005，起第二个实例时还会互相顶端口）。

---

## 4. 表结构

```sql
CREATE DATABASE IF NOT EXISTS fsa;

CREATE TABLE IF NOT EXISTS fsa.obs (
  station   LowCardinality(String),
  ts        DateTime,
  obs_type  LowCardinality(String),
  value     Float64
) ENGINE = MergeTree ORDER BY (station, ts);

CREATE TABLE IF NOT EXISTS fsa.obs_1m (
  station   LowCardinality(String),
  bucket    DateTime,
  obs_type  LowCardinality(String),
  samples   UInt64,
  v_min Float64, v_max Float64, v_avg Float64, v_sum Float64
) ENGINE = MergeTree ORDER BY (station, bucket);
```

合成数据（`--load N`，seed 固定 = `20261105`，逐字节可复现）：8 站 × 4 类型，**15 s 采样**，
时间从 2026-01-01 00:00:00 UTC 起算；值 = 基线 + 日周期 + 高斯噪声（气温可负，其余截到 0）。
15 s 的好处是"1 分钟聚合表"真有多条采样可取 min/max/avg（4 条/分钟/站/类型），
200,000 行约覆盖 26 小时。灌完自动 `INSERT … SELECT … toStartOfMinute(ts) … GROUP BY`
回填 `obs_1m`。

实测：`--load 200000` **0.94 s ≈ 213,400 行/s**（4 批 × 50,000 行，HTTP TSV），
`obs_1m` 得 50,016 行。

---

## 5. 20 条聚合基准（`--bench`）

覆盖面：单站单日、1 分钟/1 小时时间桶、多站对比、去重计数（`uniqExact`）、
分位数（`quantile`/`quantiles`）、`argMax`、窗口函数（`lagInFrame`）、`countIf` 交叉矩阵、
聚合表回放。每条**预热 1 次**再计 `--reps`（默认 5）次，报 p50/p95。

### 5.1 验收跑（Windows 侧，数据在 `.deps`=NTFS/9p，200,000 行）

| # | 查询 | p50(ms) | p95(ms) | 行数 |
|---|---|---|---|---|
| 1 | 全表行数 | 6.33 | 28.16 | 1 |
| 2 | 单站单日 均/极值 | 21.32 | 53.71 | 1 |
| 3 | 单站 1 分钟时间桶 | 31.50 | 56.70 | 500 |
| 4 | 单站 1 小时桶 p95 | 30.35 | 37.04 | 27 |
| 5 | 八站对比 均值 | 17.37 | 28.96 | 8 |

20 条 p50 中位数 **26.98 ms**，最慢 `聚合表单日回放` 50.70 ms；往返基线
`SELECT 1` p50 **9.92 ms**。灌数 `--load 200000` 1.08 s ≈ 184,441 行/s。

**同一配置换个时间再跑，绝对值会变不少**：另一次是 14.78 / 32.06 / 25.41 / 14.41 / 29.79，
中位数 28.77 ms，基线 8.03 ms。也就是说这个量级的绝对值被**传输抖动**主导（3–15 ms/请求），
几次之间的差别不能当成引擎性能差异去解读。

> 所以结论只认两件事：**基线扣掉之后还剩多少**，以及 §5.2 的对照实验。

### 5.2 分离实验：传输 vs 数据目录（同样 20 条，`--reps 5`）

| 在哪跑 | 数据目录 | `SELECT 1` 基线 p50 | 20 条 p50 中位数 | 最慢 |
|---|---|---|---|---|
| Windows | `.deps/clickhouse/data`（NTFS，9p） | 8.03–9.92 ms | **26.98–28.77 ms** | 36–51 ms |
| WSL 内 | 同上（9p） | 1.35 ms | **14.18 ms** | 27.44 ms |
| WSL 内 | `~/.local/share/fsa-clickhouse/data`（ext4） | 1.31 ms | **3.41 ms** | 5.68 ms |
| Windows | ext4 | 15.03 ms | 16.78 ms | 31.25 ms |

结论两条：

1. **9p 是主要成本**：数据放 `/mnt/h` 比放 ext4 慢 **≈4.2 倍**（14.18 → 3.41 ms）。
2. **要量引擎就在 WSL 内跑**：`wsl -d Ubuntu-24.04 -- python3 /mnt/h/…/tools/ch_bench.py --bench`
   （脚本是纯标准库，WSL 的 python3 直接能跑；只有 `--start/--stop` 需要 Windows 侧的
   `wsl.exe`）。

想又快又不动默认行为：`--data-dir '~/.local/share/fsa-clickhouse/data'`
（第一次要先 `--init --load`，数据不会自动搬）。默认仍按约定放 `.deps/clickhouse/data`。

---

## 6. 与 DuckDB 的分工

两个引擎走**同一份逻辑视图**，上层只写 DuckDB 兼容 SQL（ADR-009 §3、
`docs/contracts/bench-sql.md`）。分工按"数据在哪、要不要常驻"来分：

| 场景 | 用谁 | 为什么 |
|---|---|---|
| 单机临时分析、直接读 Parquet/CSV（`read_parquet`） | **DuckDB**（默认） | 零服务、零导入，一条 SQL 就能扫分区目录 |
| 已有常驻服务、多客户端并发查、要物化视图/后台合并 | **ClickHouse** | 服务化 + MergeTree 持续写入 + 预聚合表 |
| 门禁 / CI / 回放（不能依赖外部服务） | 都不要，走 `pipeline.py` 与合成 fixture | 基准与门禁不许依赖常驻进程 |
| 台站数据台顶部的"单站单日 ≤1.5 s" | 先 DuckDB；ClickHouse 在有二进制+服务时做对照 | 见 `docs/operations/deps.md` |

**两套 20 条不是同一套，别混**：

- `docs/contracts/bench-sql.md` 的 20 条是**项目级契约**（`obs`/`tec`/`agg_hour`/`agg_daily`，
  9,849,600 行 Parquet 分区，两站同构），由 E4 适配层翻译后双引擎跑。
- `tools/ch_bench.py` 的 20 条是**本机冒烟**（`fsa.obs`/`fsa.obs_1m`，合成数据），
  只为回答"这台机器上的单机版到底跑不跑得动、有多快"。

---

## 7. 失败时怎么回落

`ch_bench.py` 的退出码：`0` 成功、`1` 运行失败（带原因）、`2` 用法错误。
**不静默**：所有失败都打印实际错误（HTTP 正文 / 日志尾巴 / WSL 的 stderr）。

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `[失败] 找不到 ClickHouse 二进制` | `.deps/clickhouse/` 里没有文件 | 按 §2 下载；或 `--binary <路径>` |
| `连不上 http://127.0.0.1:8123` | 服务没起 / 已停 | `--start`；仍不行看 `run/server.err.log` |
| `Address already in use: 9000` | 机器上已有 ClickHouse | `--http-port/--tcp-port` 换端口，或先 `--stop` |
| `Unable to obtain inode for exe` | 直接从 `/mnt/*` 执行 ELF | 让脚本自己拷（`~/.local/share/fsa-clickhouse/`），别手改路径 |
| `Text file busy` | 服务正在跑时想覆盖执行副本 | 先 `--stop` 再 `--start` |
| `Database fsa does not exist` | 没跑 `--init` 就 `--bench` | `--init`（`--load` 会顺带建） |
| WSL 命令失败 / 找不到 `wsl.exe` | 本机没 WSL 或发行版名不对 | `wsl -l -q`，必要时 `--distro <名字>` 或 `FSA_CLICKHOUSE_DISTRO` |

**降级纪律（ADR-009 §3「不许静默」）**：ClickHouse 不可用时，E4 只剩 DuckDB 一条腿，
数据台顶部必须**明示**"引擎不可用"，把降级写进当次产物，不许把 DuckDB 的结果冒充双引擎跑过。
`src/fieldstation/data/engines.py` 的 `ClickHouseEngine.available()` 只认
`clickhouse_connect`——**这是目前真正的阻塞点**，见 §9。

---

## 8. 踩过的坑（改之前先看）

1. **`shquote('~/x')` 不会展开 `~`**：单引号里 `~` 是字面量。用 `shell_path()`（`~` 交给
   `$HOME` 展开）。第一次就是这么把 900 MB 拷到 `/mnt/h/…/~/` 下面去的。
2. **`str(Path('~/.local/x'))` 在 Windows 上变成 `~\.local\x`**：判断"是不是 WSL 路径"必须先
   `replace("\\", "/")` 再 `startswith("~/")`。不修的话数据会被写进仓库里一个叫 `~` 的目录。
3. **脚本别拼进 `wsl.exe` 的命令行**：`wsl.exe` 会让客户机的 shell 再解析一遍 argv，
   带空格/中文/嵌套引号的路径直接报 `unexpected EOF`。一律 `wsl.exe -d <distro> -- bash -s`
   把脚本喂 **stdin**。
4. **`wsl -l -q` 的输出是 UTF-16LE**（每个字符后跟一个 NUL），按 UTF-8 解是乱码；
   `parse_wsl_distros()` 两种来源都收。
5. **p95 在 5 个样本上不等于最大值**：秩 = 4×0.95 = 3.8，线性插值落在次大与最大之间
   （`[1,2,3,4,10] → 8.8`）。想报"最差值"就加大 `--reps`，或直接看表里的 p95/最大值。
6. **`entry["n"]` 与 `summarize()` 的 `n` 撞过名**：结果表 20 行序号全印成"重复次数 5"。
   现在序号是 `idx`，`tests/test_ch_bench.py` 有一条回归用例钉着它。
7. **`--load` 会先 TRUNCATE**（`--no-truncate` 可追加）。基准数据必须可复现，追加会让两次
   读数不可比。
8. **数据目录在 9p 上的日志会带一堆 9p 警告**（不影响正确性，影响速度，见 §5.2）。
9. **`wsl.exe … -- bash -lc 'cmd' bash %*` 会静默丢掉参数**（实测 `$@` 是空的），
   所以 `.cmd` 外壳只能走"直接 exec 绝对路径"的形式；同理 `_run_wsl()` 用
   `bash -s` + stdin，不用 `-c`。会丢参数比报错更危险：命令看起来执行成功了，只是参数没了。

---

## 9. 没做的 / 待办

- **`clickhouse_connect` 没装**：`requirements-v4.txt`（别人维护）里没有它，所以
  `src/fieldstation/data/engines.py::ClickHouseEngine.available()` 现在返回 False
  （原因文案会写"未安装 clickhouse-connect"）。**服务端已经能跑通**，缺的只是那个 HTTP
  客户端模块。补一行 `clickhouse-connect` 装进 `.deps/venv` 即可，不属于本次可写范围。
- **没有 Windows 原生二进制**：如果将来官方出了 `clickhouse.exe`，`resolve_binary()` 已经
  优先找它、`start_server()` 会自动走 native 分支（Popen + `taskkill`），不用改脚本。
- **没接进 CI**：`ch_bench.py` 需要 WSL + 900 MB 磁盘，不适合放进门禁；集成测试
  （`tests/test_ch_bench.py::ClickHouseIntegrationTest`）只在二进制存在时跑，自己找
  `18123/19001` 端口、自己收尾，不会碰用户开着的 8123。
- **没做持久化压测**：200,000 行只够验证"跑得通 + 量级合理"；百万级、连续写入、
  多客户端并发都没测。
