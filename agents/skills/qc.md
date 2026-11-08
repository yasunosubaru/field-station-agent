# 技能：数据质量（QC）

**什么时候用**：用户问数据能不能用、有没有周跳、相位连不连续、幅度是不是超了。

## 四个判据工具，别互相替代

| 工具 | 判什么 | 不能判什么 |
|---|---|---|
| `robust_stats` | 一条数值序列里谁是离群点 | 不能说「数据质量不合格」 |
| `slip_detect` | 两条信号的差分序列在哪个历元跳变（周跳） | 不能判相位是否连续 |
| `continuity_verdict` | 按弧段/序列比例判相位是否连续 | 不能定位周跳 |
| `magnitude_verdict` | 按 RMSE 与上限判幅度是否可接受 | 不能判连续性 |

**这四条是分开的判据，不要用一个的结论去回答另一个的问题。**

## 各自的入参与读法

### `robust_stats`

`values`（数字数组）+ `sigma_k`（默认 3.0）。

返回：`n, median, mad, sigma_robust, threshold, outliers[]`

- 用的是**中位数与 MAD**，不是均值与标准差。所以 `sigma_robust` 与 `mad` 不是同一个数，
  别混用。
- `outliers[]` 是**下标**，不是值。引用时要说「第 N 个」。

### `slip_detect`

`series`（历元数组）、`system`（系统名）、`signal_1`、`signal_2`、`sign`（±1）。

返回：`slip_indices[], n_epochs, n_slips, summary{method, threshold, max_jump}`

- `sign` 是几何无关组合的符号约定，**必须由调用方给**，不要猜。
- `n_slips=0` 是有效结论，不是「没检测到所以不知道」。

### `continuity_verdict`

`algorithm`、`n_arcs`、`n_series`、`rejected_short_arcs`、`n_rows`、`arc_ratio_guard`、`short_arc_guard`。

返回：`applicable, n_arcs, n_series, arc_ratio, short_arc_rate, rejected, reason, criterion`

- `applicable=false` 时**其余字段没有判决意义**。这时正确回答是「该判据不适用，原因：<reason>」，
  不是「连续」也不是「不连续」。

### `magnitude_verdict`

`rmse`、`limit`（都是调用方给的，不猜）+ 可选 `n`、`unit`。

返回：`accepted, rmse, limit, ratio, criterion, reason`

- `accepted=false` 只说「超过本次给的上限」，不等于「数据不可用」——上限是谁给的要说清。

## 常见错法

- **拿 `robust_stats` 的 `outliers` 当周跳**：离群点可能是真实的电离层扰动，不是周跳。
- **`applicable=false` 时仍然报「通过」**：这是最坏的一种，用户会以为已经验过了。
- **自己算一遍 RMSE 去「核对」`magnitude_verdict`**：口径一旦和 `rules/qc.py` 分叉，
  两边永远不一致且没人发现。引用工具给的数。

## 回答形状

```
结论：该批次相位不连续（arc_ratio=0.61，低于守卫 0.8）。
证据：[t0002] continuity_verdict → applicable=true, arc_ratio=0.61, reason="弧段过短"
下一步：先查周跳（slip_detect），确认是真实中断还是检测阈值问题。
不确定项：n_rows 未提供，无法判断样本量是否足够。
```
