# 公开数据通路：第一版（M5-4 之后新增）

状态：初版（2026-10-20）

真实台站样本受 #28/#33 阻塞（成员侧脱敏样本未到）。**不等它**：先用**公开数据**
把「取数 → 读数 → 判据 → 记录」这条链路跑通一版，等真实样本到位后用同一套接口替换
数据源即可。

## 现状：设备侧已落地，观测侧卡在 CRINEX

| 侧 | 状态 | 说明 |
|---|---|---|
| **设备侧** | ✅ 已落地 | Open-Meteo 公开归档：八达岭（BADG 同址）逐小时气象 → 设备读数 → `station_health` |
| **观测侧**（GNSS 相位/伪距） | ❌ 未落地 | IGS 公开归档（BKG 镜像、NOAA CORS）**自 1999 年起都是 CRINEX**（gfzrnx 私有紧缩，`3&` 记录）；本仓库按既有决定**不解码**（无公开规范，逆向风险高） |

观测侧的候选路径与代价（已实测，见「为什么不是观测侧」）：CDDIS 的 Hatanaka 归档
（需 Earthdata 账号）、`gfzrnx -r 3` 外部转换（无 pip 包）、`.Z`/UNIX compress 解压
（解出来仍是 CRINEX）。已登记为待办 issue，不在本版里硬啃。

## 数据源登记

`data/public/manifest.json` 是唯一的登记处，每条包含：

| 字段 | 含义 |
|---|---|
| `id` / `title` | 源标识与说明 |
| `url` | 取数地址（可直接重取） |
| `license` / `attribution` | 许可与署名要求 |
| `retrieved` | 取回日期 |
| `sha256` / `bytes` | **内容校验和** —— 数据源变了必须显式改基线，不能默默换数 |
| `cache` | 本地缓存路径（**不入库**） |
| `committed_sample` | 入库的小样本路径（可离线复算） |
| `used_for` / `caveat` | 用途与口径边界 |

**原始数据不入库**（体积与许可），仓库里只留小样本、校验和与摘要。

## 落地的一条链路

```text
data/public/manifest.json
   │  tools/fetch_public_data.py            （下载 → 校验 sha256 → 落本地缓存）
   ▼
data/public/cache/<id>.json
   │  harness/public_data_replay.py          （逐小时 → 设备读数 → station_health）
   ▼
logs/public_data_device_202401d01.json      （确定性：无时间戳，两次运行逐字节相同）
```

复算命令：

```powershell
$env:PYTHONPATH="src"
python tools/fetch_public_data.py                       # 取数（需要网络）
python harness/public_data_replay.py \
    --input data/public/samples/openmeteo_badg_202401_d01.json \
    --out logs/public_data_device_202401d01.json       # 离线复算（CI 用这个）
```

## 接进 M5 链路与看板（#98）

`harness/public_data_chain.py` 把**公开设备读数**接进完整五阶段链：

```text
公开气象样本（data/public/samples/openmeteo_badg_202401_d01.json）
   │  readings_from_open_meteo + apply_low_temp_rule（演示规则）
   ▼
data.device ──► device_monitor ──► … ──► archive      （五阶段 / 7 消息）
data.observations（合成，M5-1 同款）──► qc ──┘
```

- **模型层**换成 `harness/fact_provider.py` 的「事实合成器」：按上游消息选工具与参数，
  结论按工具返回的真实数字拼 —— 结论里的每个数字都能在 trace 里对上；
- **为什么没改 `m5_pipeline_replay.py`**：那是 M5-1 的**基线**（fixture/log 的 sha 钉死），
  给它加分支只会让基线变脆。集成放在新 harness 里，基线不动（回归测试守住）；
- 输出 `logs/public_data_chain_202401d01.json` 与 M5-1 日志**同形**（trace / messages /
  stages / artifacts / checks / summary），看板可直接消费。

**看板（真实数值）**：

```powershell
$env:PYTHONPATH="src"
python tools/make_station_dashboard.py --log logs/public_data_chain_202401d01.json `
    --page figures/m5_public_chain_dashboard.html --summary logs/public_chain_dashboard.json
```

页面顶部会标出**数据来源与许可**（设备侧 Open-Meteo / CC BY 4.0，观测侧合成 + 原因），
以及「环境读数 ≠ 供电/链路/安防」的口径提示。当前这版渲染出的真实数值：

| 视图 | 值 |
|---|---|
| 台站健康度 | BADG，健康度 **1.0**（**degraded**），缺测 0/96，`low_temp` 标记 |
| 告警 | 2 条（均 warn）：`data_quality`（GPS 01 周跳，证据 `qc:t0001`）、`station_health`（证据 `device_monitor:t0001`） |
| 工单 | **WO-0001**，P1，open，动作 restart_receiver（accepted / simulated） |

M5-1 的看板页（`figures/m5_dashboard.html`）保持不变（逐字节），两页并存：一页是合成
基线，一页是公开数据链路。

## 校验口径：活响应的字节逐次不同

实测：Open-Meteo 的 archive 响应**每次取回的字节数都不一样**（28471 / 28472）——
响应里含 API 自己的 `generationtime_ms`。按原始字节算的 sha256 对活取数**不成立**，
「校验」会变成永远失败的摆设。

因此清单里分开登记两种摘要：

| 字段 | 口径 | 适用 |
|---|---|---|
| `sha256` | 原始字节 | 固定文件（入库样本） |
| `sha256_normalized` | 去掉 `VOLATILE_FIELDS`（逐次变化字段）后的规范 JSON | 活取数的 JSON 源 |

取数时按清单里**有哪个字段**决定用哪种口径（`tools/fetch_public_data.py`）。
台账每行记的是当次用于校验的那个摘要（见 `docs/operations/trial-ledger.md`）。

## 口径

**映射**（Open-Meteo 的 hourly 变量 → 本仓读数口径）：

| Open-Meteo | sensor / metric | unit |
|---|---|---|
| `temperature_2m` | `env` / `temperature_c` | degC |
| `relative_humidity_2m` | `env` / `relative_humidity_percent` | % |
| `surface_pressure` | `env` / `surface_pressure_hpa` | hPa |
| `wind_speed_10m` | `env` / `wind_speed_mps` | m/s |

- 时间戳按 UTC 解析（请求里 `timezone=UTC`）。
- 缺测（`null`）→ `value=None` + `quality_flag="missing"`，由 `station_health` 统一
  计入缺测率；映射层不自己判健康。
- 判据只有一套：`station_health`（`health_score = 1 - missing/total`，三档状态）。
  映射层不引入第二套阈值。

**当前这一版的实测结果**（2024-01-01 24 小时，样本）：

| 项 | 值 |
|---|---|
| 读数 | 96 条（24 小时 × 4 指标） |
| 缺测 | 0 |
| 健康度 | 1.0（`ok`） |
| 源 | Open-Meteo（CC BY 4.0，署名 Open-Meteo / ERA5） |

## 边界（务必一起读）

- **环境读数 ≠ 设备读数全集**：公开数据给的是**环境**量（气温/湿度/气压/风速）；
  本仓链路的设备侧模型是供电/链路/安防，那三类**没有公开对应物**，仍用
  `synthetic` 的设备异常场景（见 `docs/operations/synthetic-device-scenarios.md`）。
- **同名不同物**：坐标与本仓合成样本台站 `BADG` 同址，但**不是同一台设备** ——
  公开再分析数据不能当台站实测。
- **再分析 ≠ 观测**：Open-Meteo 给的是 ERA5 再分析的气象，不是台站仪器实测。
- 公开数据只解决「链路能不能在真实来源的数据上跑通」，**不解决** M6-2 的指标评估
  （口径见 `docs/operations/evaluation-protocol.md`）：基线、标注、试运行仍要真实数据。

## 为什么不是观测侧（实测记录）

- BKG 的 IGS 镜像（`igs.bkg.bund.de/root_ftp/IGS/obs/...`）2010/2015/2024 的观测
  文件都是 `.crx.gz`；`obs_v3/` 下的老文件是 `.Z`（UNIX compress）。
- 解开 2010 年的 `.Z`（`gzip -dc` 可解）得到的是 **CRINEX 4.0.3**（文件首行
  `1.0 COMPACT RINEX FORMAT`），不是经典 RINEX2。
- 2005 年的 `.gz` 同为 CRINEX；1999 年的 `.Z` 也是（`RNX2CRX ver.u.2.1beta`）。
- NOAA CORS 归档的 `.24d.gz` 同样是 CRINEX。
- 本仓库的 `ingest/reader.py` 按既有决定**不解码 CRINEX**（无公开规范，逆向风险高），
  它的报错信息里给出的官方出路是 `gfzrnx -r 3`（外部工具，无 pip 包）。

## 怎么核对

```powershell
$env:PYTHONPATH="src"; python -m unittest tests.test_public_data -v
```

9 条测试钉住：清单条目完整（许可/校验和/取回日期/用途）、入库样本与登记的 sha256
一致、取数工具的匹配/不匹配/清单缺失三种出口、映射与缺测标记、记录两次运行逐字节
相同且与入库版本一致。
