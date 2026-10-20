# 设备侧合成场景：供电 / 网络 / 安防异常

状态：初版（2026-10-20）

X-1 第 5 项（spec §10.5）问的是「`synthetic.py` 的注入规则是否按台站场景扩展」。
结论是**扩展**：新增 `synthetic.device_readings(...)`，与观测侧的周跳注入平行。
它不是第二套判据 —— 健康度仍由 `agents/tools/station_tools.py::station_health`
统一计算。

## 三类异常

| 异常名 | 注入内容 | `station_health` 结果 | 典型用途 |
|---|---|---|---|
| `power_undervoltage` | 供电 10.2 V + `quality_flag="undervoltage"` | `degraded`（有质量标记） | 演示供电告警、工单 |
| `link_loss` | 链路 rssi 与上行包数都缺测（`value=None` + `"missing"`） | `critical`（缺测 2/3） | 演示链路中断、缺测容错 |
| `security_intrusion` | 追加 `security/door=1` + `"door_open"` | `degraded`（有质量标记） | 演示安防事件 |

基线（无异常）三条读数：`power/voltage=12.0 V`、`link/rssi=-88 dBm`、
`uplink/packets_5min=120 count` → `ok`。

## 用法

```python
from datetime import datetime, timezone
from fieldstation import synthetic

readings = synthetic.device_readings(
    station="BADG",
    observed_at=datetime(2026, 10, 19, 8, 10, tzinfo=timezone.utc),
    anomalies=["link_loss"],
    seed=42,          # 可选：给基线值加确定性抖动
)
```

异常名可组合（如 `("link_loss", "security_intrusion")`）；未知异常名直接
`ValueError`，不静默忽略。

## 设计边界

- **只造读数与质量标记**，不判健康度、不建工单：判据与动作仍走既有工具链。
- **一次快照，不是时间序列**：`observed_at` 由调用方给定；重复调用不会自己推进时间。
- **确定性**：`seed=None` 用固定基线值；给 seed 时抖动可复现（同一 seed 两次相同）。
- 真实台站读数到位后替换数据源即可，`station_health` 与看板的接口不变。

## 验证

```powershell
$env:PYTHONPATH="src"; python -m unittest tests.test_synthetic_device -v
```

7 条测试钉住：基线 `ok`、三类异常各自的状态（degraded/critical/degraded）、组合异常、
seed 可复现、未知异常与非法参数报错。
