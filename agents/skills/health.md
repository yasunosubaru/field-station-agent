# 技能：台站健康度

**什么时候用**：用户问台站在不在线、健康度多少、缺测率高不高、心跳多久没来。

## 先调哪个工具

| 问题 | 工具 | 必填入参 |
|---|---|---|
| 这几条读数健不健康 | `station_health` | `readings`（StationReading 数组） |
| 设备还有没有心跳 | `device_heartbeat` | `devices`（device 数组） |
| 串口被谁占着 | `native_ports` | 无 |

三条都是只读，不需要审批。

## 怎么读返回

`station_health` 的 `data`：

```
stations[] : station_id, total, missing, health_score, status, metrics[], quality_flags[]
summary    : total, missing, alerts[]
```

- `health_score` 是 0–1。**低于 0.9 就要在回答里点出来**，不要说「正常」。
- `missing` > 0 说明有 `value: null` 的读数。**缺测不是 0**，不许把它算进均值。
- `summary.alerts[]` 非空时，逐条引用它的原文，不要自己概括成「有些告警」。

`device_heartbeat` 的 `data`：

```
devices[] : device_id, state, last_seen_s, age_s
summary   : online, stale, offline, unknown
```

- `state` 四档：`online` / `stale` / `offline` / `unknown`。**`stale` 不等于 `offline`**：
  它表示「超过 `stale_after_s` 没更新」，可能只是采集中断，不要直接说设备坏了。
- `unknown` 表示这条设备从来没有心跳记录。这是「没数据」，不是「离线」。

## 常见错法

- 把 `missing` 当 0 算进平均：算出来的健康度会偏高，而且看不出错。
- 把 `stale` 说成 `offline`：会误导用户去现场重启一台其实还在跑的设备。
- 用户只给了一部分读数，却在回答里说「全台站健康」：`summary.total` 只统计你传进去的那些。

## 回答形状

```
结论：WUHN 健康度 0.87（degraded），3 条缺测。
证据：[t0001] station_health → health_score=0.87, missing=3
下一步：补一次读数再判；若持续 2 小时仍缺测，建议建单。
不确定项：没有 devices 数据，心跳状态未知。
```
