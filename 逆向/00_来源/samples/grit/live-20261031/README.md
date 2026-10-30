# GRIT 真机一轮（2026-10-31 12:05 UTC）

接收机：OEM729-2.03，固件 `OM7MR1002RN0000`，USB 虚拟串口 COM10/11/12（COM12 给套件）。
套件 2.11.0 → 应用启动器 → **GRIT Monitor** → Connect（COM12）→ Open。

## 抓到的界面

`grit-dashboard.png`（整屏 2560×1600）：

| 区域 | 实测显示 |
|---|---|
| 状态栏 Positioning | Good / `Single`，纬度 30.5399718°，经度 114.3528004°，Height (MSL) 63.79 m，Satellite Tracked **25**，Satellite Used **15** |
| 状态栏 Device | **Warning**（黄色），OEM729-2.03，CPU Usage 24%，Interference **Jamming**，Time (UTC) 12:05:33 |
| 警告横幅 | `Interference is being detected at 1270Mhz.` / `Began today at 12:05:32 UTC` |
| Mitigation Assistant | 同一句 + `This is potentially affecting your ability to receive signals.` |
| Spectrum Viewer | 双窗（L5/L2/BDS B2B + L1），纵轴 −40…−130 dB，1270 MHz 处有竖直标记与干扰图标；右侧星座轴 GPS/BDS/QZSS/SBAS |
| Signal Matrix | 行 GPS/BDS/QZSS/LBAND/SBAS × 列 L5 Band/L2 Band/L1 Band；绿=Good、橙=Warning、红=Poor、空心=No signals visible |
| Position Overview | Map / Satellite 两个页签，`Add Point of Interest`，底部 Timeline 折叠条 |
| 右上角 | 事件徽标 `1` |

## 同一时刻用我们自己的解码器读回（`com11-live-8s.bin`，8 秒 / 487 830 B）

```
消息计数: RANGE:168  BESTPOS:9  RXSTATUS:3
BESTPOS : solution_status=SOL_COMPUTED  position_type=SINGLE  num_svs=25  num_soln_svs=15
          latitude=30.539972065253295  longitude=114.35280103772466
RXSTATUS: rx_error=00000000  status_words.count=5
```

逐项对上：`num_svs` = 界面的 Satellite Tracked 25，`num_soln_svs` = Satellite Used 15，
`SOL_COMPUTED/SINGLE` = Positioning Good / Single，经纬度与界面一致（末位是刷新时刻差异），
`rx_error = 0` 与 Device 的 Good（警告只来自干扰）一致。

**未包含**：`ITDETECTSTATUS` —— 该端口没有订阅这条日志，所以干扰 1270 MHz 这个数值来自
GRIT 自己的频谱采集通道，不在这次抓包里。要复现干扰判定，需要同时录 `ITDETECTSTATUS` 与
频谱数据（`05_GRIT-Monitor.md §3.3` 的 `gritMandatoryLogs`）。

## 复现

```
# 套件 GUI：启动器 → GRIT Monitor → Connect → Open（COM12）
# 抓同一时刻的日志（USB2 空闲口）
node packages/cli/src/probe.ts --serial COM11
```
