# 试运行台账（M6-1 骨架）

状态：初版（2026-10-21）｜对应 issue #97

M6-1 要的是「试运行台账：数据源可用性、异常与失败原因」。真实试运行要等现场条件，
但**台账骨架现在就能立**：字段、失败分类、记录方式与汇总口径先定死，等真跑的时候
只管往里写。

## 一行记什么（JSONL，一行 = 一个源的一次尝试）

| 字段 | 含义 | 怎么来的 |
|---|---|---|
| `ts` | ISO 8601（UTC） | 尝试开始时间 |
| `run_id` | 本轮运行的标识 | 调用方给（默认 `local`） |
| `source_id` | 数据源 id | 清单里的 id；探针用 `probe:<名字>` |
| `url` | 实际请求的地址 | 家目录已替换成 `<home>`（台账要入库，不带本机路径） |
| `status` | `ok` / `failed` | 自动判定 |
| `failure_class` | 失败分类（见下） | 自动分类；`ok` 时为 null |
| `bytes` | 取到的字节数 | 自动；失败为 null |
| `sha256` | **校验用摘要** | 固定文件记原始字节 sha；活取数的 JSON 源记规范化摘要（见下） |
| `n_records` | 记录条数 | 自动；判不出为 null（不猜） |
| `duration_ms` | 本次尝试耗时 | 自动 |
| `notes` | 人看的备注 | 失败时带异常原文 |

## 失败分类：固定六类

| 分类 | 判据 | 典型原因 |
|---|---|---|
| `连接失败` | DNS / 连接层就失败 | 域名不存在、TLS 握手失败、对方拒连 |
| `超时` | 读或连超时 | 对方太慢、网络受限 |
| `校验不符` | 拿到了内容但摘要与登记的不符 | **数据源变了**（或登记写错） |
| `格式不支持` | 内容拿到了但不是登记的格式 | 对方改了响应格式、返回了错误页 |
| `字段缺失` | 格式对但必需字段没有 | 接口改了字段名、返回了残缺对象 |
| `未知` | 以上都不是 | **要查，不要装懂** |

分类由 `tools/trial_ledger.py::classify` / `check_payload` 自动给出，不允许手写
（手写的分类没法复核）。

## 怎么记

```powershell
# 跑清单里的全部源，逐个记行
python tools/trial_ledger.py --append logs/trial_ledger_20261021.jsonl --run-id 20261021-public-data

# 单独探一个地址（用来验证分类）
python tools/trial_ledger.py --probe-url <url> --probe-id probe:xxx \
    --expect-sha256 <sha> --require-field hourly \
    --append logs/trial_ledger_20261021.jsonl --run-id 20261021-public-data

# 汇总
python tools/trial_ledger.py --summarize logs/trial_ledger_20261021.jsonl \
    --summary logs/trial_ledger_summary_20261021.json
```

**台账里有失败行不是错误** —— 失败行正是台账的价值（报告里要写「哪些源不好使」）。

## 第一版台账（2026-10-21，公开数据源）

| 源 | 结果 | 分类 | 说明 |
|---|---|---|---|
| `openmeteo_badg_202401` | ok | — | 活取数，744 条记录，规范化摘要 `ebe38d4d…` |
| `openmeteo_badg_202401_d01` | ok | — | 取自入库样本，24 条记录 |
| `probe:dns` | failed | 连接失败 | 不存在的域名（TLS 握手失败） |
| `probe:sha` | failed | 校验不符 | 故意写错的期望摘要 |
| `probe:format` | failed | 格式不支持 | 拿 LICENSE（纯文本）当 JSON 源 |
| `probe:field` | failed | 字段缺失 | JSON 缺 `hourly` 字段 |

汇总：6 行 / 2 成功 / 4 失败，四类失败各 1 次。`超时` 与 `未知` 两类本轮没有真实
事件，由单测覆盖（`tests/test_trial_ledger.py`）。

## 记录时发现的真问题：活响应的字节逐次不同

第一轮跑清单时，Open-Meteo 的 archive 源**每次取回的字节数都不一样**（28471 /
28472）—— 响应里有 API 自己的 `generationtime_ms`。也就是说：**按原始字节算的
sha256 对活取数不成立**，校验会变成永远失败的摆设。

处理办法（已落进代码）：

- `tools/fetch_public_data.py::normalized_digest` —— JSON 载荷去掉逐次变化的字段
  （`VOLATILE_FIELDS`）后按规范形式算摘要；清单里用 `sha256_normalized` 登记；
  固定文件（入库样本）仍用原始字节 sha。两种口径在清单里**分开登记**，不混用。
- 台账行的 `sha256` 记的是**当次用于校验的那个摘要**。

## 与 M6-1 验收的对应

| M6-1 验收 | 本文件提供 |
|---|---|
| 台账覆盖整个试运行期，无断档 | 台账是**追加式**的：一行一次尝试，不覆盖历史；每轮 `run_id` 区分 |
| 失败原因有分类，不是「偶尔失败」 | 固定六类 + 自动分类 + 汇总分布 |
| 所有数字可回源 | 每行带 `url` / `sha256` / `bytes` / `n_records` / `duration_ms`，可回查取数与清单 |

## 边界

- 这版台账只覆盖**公开数据源**。真实台站样本（#28/#33）与现场数据源到位后，用
  同一套字段与分类续记即可（`run_id` 分轮）。
- 台账**不判定数据对不对**，只判定「取到了没有、校验过没过、失败在哪一步」。
  业务正确性由 M6-2 的评估协议管（`docs/operations/evaluation-protocol.md`）。

## 怎么核对

```powershell
$env:PYTHONPATH="src"; python -m unittest tests.test_trial_ledger -v
```

6 条：规范化摘要只忽略逐次变化字段、失败分类映射、行字段齐全、汇总算得对、
入库台账与入库汇总互相对得上。
