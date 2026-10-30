# RINEX 输出规格（从 golden 反推）

> RINEX 由**闭源原生程序**写出（`03_Convert组件.md`：`tosrec.exe` / `datablk.exe`），应用里没有
> 对应 JS，所以只能拿 `00_来源/samples/convert/golden-rinex*` 反推格式。本文件记录**已测出**的
> 部分，作为写 RINEX 编码器的规格。

## 1. golden 清单（输入 `clean-9600.gps`，5.0 s，OEM729）

| 版本 | 目录 | 文件 |
|---|---|---|
| 2.1 | `golden-rinex2_1` | `.26O` 128 640 B、`.26N` 5 512 B、`.26G` 328 B（只有头） |
| 3.01 | `golden-rinex3_01` | `.26O` 300 350 B、`.26N` 5 576 B、`.26G`/`.26L` 各 328 B（只有头） |
| 3.02 / 3.03 / 3.04 | `golden-rinex3_02/03/04` | 3.04：`.26O` 589 934 B，`.26N` 5 576 B，`.26F/.26G/.26H/.26I/.26L/.26Q` 各 328 B |

`.26G` 等"只有头"的文件说明：**没有对应星座的星历就只写头**（328 B 的固定 4 行头）。

## 2. RINEX 2.1 头（20 行，实测）

```
     2.10           OBSERVATION DATA    G (GPS)             RINEX VERSION / TYPE
NAS Convert 2.11.0  NovAtel             30-Oct-26 17:10     PGM / RUN BY / DATE 
Rinex Version 2.10 Observation File                         COMMENT              
Signal Strength values S1,S2 are in dBHz                    COMMENT              
                                                            MARKER NAME          
                                                            MARKER NUMBER        
                                                            OBSERVER / AGENCY    
                    NovAtel GPSCard                         REC # / TYPE / VERS  
                                                            ANT # / TYPE         
 -2267176.2633  5008923.9294  3222098.6385                  APPROX POSITION XYZ 
        0.0000        0.0000        0.0000                  ANTENNA: DELTA H/E/N
     1     1                                                WAVELENGTH FACT L1/2
     1     1     7   G02   G04   G07   G08   G09   G16   G26WAVELENGTH FACT L1/2
     1     1     2   G27   G31                              WAVELENGTH FACT L1/2
     8    C1    L1    D1    S1    P2    L2    D2    S2      # / TYPES OF OBSERV  
     0.050                                                  INTERVAL             
  2026    10    30    08    38   17.3500000     GPS         TIME OF FIRST OBS    
  2026    10    30    08    38   22.3000000     GPS         TIME OF LAST OBS     
Leap Seconds Unknown                                        COMMENT              
                                                            END OF HEADER        
```

要点：

- `APPROX POSITION XYZ` 是 ECEF（由 BESTPOS 的经纬高换算），列宽 `%14.4f`×3 + 18 空格；
- `WAVELENGTH FACT L1/2` 按**波长因子分组**列出卫星：每组一行，前缀 `     1     1` 再 `%6d` 个数
  + 每颗 `   G%02d`；样例是 7 颗一组 + 2 颗一组（12 颗一行放不下时的换行规则需再验）；
- `INTERVAL` = 观测间隔（50 ms）；
- `TIME OF FIRST/LAST OBS` 用 `%6d%6d%6d%6d%6d%11.7f` + 空格 + `GPS`；
- `Leap Seconds Unknown` 是固定 COMMENT（原版不写闰秒）。

## 3. RINEX 2.1 观测记录（实测列宽）

历元行（补空格到 80 列）：

```
 26 10 30 08 38 17.3500000  0  9G07G16G26G02G08G09G27G04G31                     
%3d%3d%3d%3d%3d%11.7f%3d%3d  + 每颗 3 字符 "G%02d"
```

- 秒是 `%11.7f`；flag=`%3d`（0）；卫星数=`%3d`；
- 卫星顺序 = RANGE 里首次出现的顺序（不是 PRN 升序）；
- 超过 12 颗时续行（32 空格 + 卫星列表，补到 80 列）。

每颗卫星 8 个观测量，按 `C1 L1 D1 S1 P2 L2 D2 S2`，每行 5 个、续行 3 个，每个字段 16 字符：

```
%14.3f + LLI(1) + SNR(1)
```

- `C1/P2/D1/D2` 的 LLI **恒为 `4`**（整份文件 900/900 都是 4），`L1/L2/S1/S2` 的 LLI 为空格；
- `S1/S2` 的 SNR 位为空格；`C1/L1/P2/L2` 的 SNR 位是 1 位数字码；
- 数值来源：C1/P2 = 该卫星 L1/L2 观测的伪距，L1/L2 = 载波相位，D1/D2 = 多普勒，S1/S2 = C/N0
  （与 ASCII 的 psr/adr/dop/CNo 同源）。

### SNR 码与 C/N0 的实测阶梯（803 个样本）

| 码 | C/N0 范围 (dBHz) |
|---:|---|
| 3 | 35.330 – 36.562 |
| 4 | 36.790 – 38.888 |
| 5 | 39.021 – 40.964 |
| 6 | 41.210 – 43.332 |
| 7 | 43.334 – 45.550 |
| 8 | 45.563 – 47.775 |
| 9 | 47.857 – 53.365 |

阶梯宽度约 **2.2335 dB**，第一个台阶边界在 **29.93 + 6×2.2335 = 43.33**，即

```
code = clamp(floor((cnr - 29.93) / 2.2335) + 1, 1, 9)
```

（`cnr = 43.333 → 7`、`47.800 → 9`、`36.670 → 4`，与实测边界一致；1/2 码的边界本次数据没覆盖。）

## 4. 还没做的部分

1. **L1/L2 观测的挑选规则**：RANGE 里同一颗星有多条（L1 CA / L2 P / L2C / L5 …），要按频道跟踪
   状态（`chan_status` 高位）挑出 L1 与 L2 各一条。本次已确认样例：PRN 7 的 `18109c04` 是 L1、
   `11303c0b` 是 L2（`02309c0b` 是另一路 L2），但位段含义还没定死。
2. **导航文件**：`.26N` 的 8 行记录来自 `RAWEPHEM` 的 3 个子帧，需要按 GPS ICD 解位（周、精度、
   健康、TGD、IODC、toc、IODE、轨道六参数、改正数）。`.26G/.26L/...` 在没有对应星历时是纯头。
3. **RINEX 3.x**：同一批观测换成 3.0x 的观测码（`C1C/L1C/D1C/S1C/...`）与 3.04 的多系统头；
   3.02/03/04 的差异主要集中在头与观测码表。
4. **UTC/闰秒**：原版写 `Leap Seconds Unknown`，第一/最后观测时间用 GPS 时间。

## 5. 结论

RINEX 是目前唯一还没做到逐字节一致的格式。观测部分（列宽、LLI、SNR 阶梯、历元行、头）已经测清，
剩余工作集中在：**频道→频点的挑选规则** 与 **星历解位**，两者都是纯计算、可用 golden 逐字节验证。
