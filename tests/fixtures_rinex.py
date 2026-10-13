"""RINEX 内联测试夹具。**不下载任何数据**，全部是手写的短文件。

## 为什么有两个版本的 RINEX 3 字符串

计划书（`.superpowers/sdd/2026-10-13-M0-地基与旧代码整合/task-4-brief.md` Step 1）
直接给了两段内联串作为夹具。实现者按搬运后的源码实测后发现：**那两段串的
列没有对齐，不是合法的 RINEX 文件**，直接用会得到"解析器坏了"的错误结论。
逐条实测记录（命令与输出见 `task-4-report.md`）：

- `RINEX3_OBS_PLAN_LITERAL`（计划书原文，**逐字保留**）
  - 首行写成 `3.04 OBSERVATION DATA    M`（版本右对齐到第 1-9 列是 **RINEX 2**
    的写法；RINEX 3 应为 `     3.04           OBSERVATION DATA    M`）。
    `reader._VER_RE` 要求 `^\\s{2,}`，因此 `sniff()` 判成 `UNKNOWN`，
    `ObservationFile` 直接抛 `UnsupportedFormat`。
  - 首行的标签 `RINEX VERSION / TYPE` 从第 46 列起，而 `_label()` 只看
    `line[60:]`，切出来只剩 `TYPE`；`rinex3._is()` 判否 ->
    `header.version` 停在空串。
  - `APPROX POSITION XYZ` 那行标签从第 66 列起，`line[60:]` 切成
    `PPROX POSITION XYZ`，`header.approx_xyz` 保持 NaN。
  - 历元行缺行首 `>`、nsat 写成 `10G01...`、观测行没有 F14.3 对齐、
    缺 `END OF HEADER` / `END OF FILE`。
  - 唯一恰好蒙对的是 `SYS / # / OBS TYPES` 那行（标签恰好落在第 61 列），
    所以 `header.obs_types` 仍能解析出来 —— 这很容易被误读成"整体可用"。
- `RINEX2_OBS_PLAN_LITERAL`（计划书原文）
  - **没有 `# / TYPES OF OBSERV` 记录**（RINEX 2 里的必填记录）。
    `rinex2.iter_observations()` 在 `n_code == 0` 时直接 return，
    于是 `ObservationFile` 能打开、却读到 **0 条**观测。
  - 写的是 `MARKER NUMBER`（值却是站名 `TESTSTN`），`header.marker` 为空。
  - 历元行的 nsat 写成 `10`，与只列出 4 颗星矛盾；观测行 6 个值对不上声明类型数。

因此本模块提供**两套**：`RINEX3_OBS` / `RINEX2_OBS` 是按搬运后解析器的列
偏移实测校准出来的合法夹具（内容与计划书的设定一致：站名 `TESTSTN`、
G 系统 8 个观测码、2023-01-01 00:00 四个 GPS 星），
`*_PLAN_LITERAL` 则**逐字保留**计划书的原始串作为负控制，
由 `test_ingest.py::TestPlanLiteralFixtures` 钉住"它们确实读不出东西"，
防止有人把它们悄悄换回主夹具。

## 校准依据（全部实测，不是推测）

- RINEX 3 头段：标签一律从第 61 列（0 基 60）起，`rinex3._label()` 就是
  `line[60:].strip()`；`SYS / # / OBS TYPES` 的系统名在第 1 列、
  观测码从第 8 列（0 基 7）起，对应 `_SYS_CODE_RE` 与 `body[7:60]`。
- RINEX 2 历元行的列偏移直接取自 `rinex2._read_epoch_head` 的切片：
  `body[0:3]=yy  [4:6]=mo  [7:9]=dd  [10:12]=hh  [13:15]=mi  [16:26]=ss  [26:29]=flag  [29:32]=nsat  [32:]=星号`。
  这与 `rinex2` 模块 docstring 记录的实测首行
  ` 24 01 01 00 00 00.0000000  0 18G01G02...` 完全吻合（注意年份是
  右对齐到 3 列的 ` 23`，不是 `  23`）。
- 观测值量级取自 `rinex3._RANGE` / `rinex2._class_ok`：
  伪距 1.5e7~3.0e7 m、相位 |x|<1e10 周、多普勒 |x|<1e4 Hz、C/N0 0~60 dB-Hz。
- RINEX 3 观测记录每格是 `F14.3 + 1 列标志`，对应 `rinex3._LAYOUTS` 的
  "C 全14+1"。标志列写 `0`（LLI=0：未失锁）而不是空格 —— 空格作为行尾
  会被编辑器/格式化工具悄悄吃掉，一吃就错位 1 列，整条记录全废。
- 观测码选 `C1 L1 S1 P2 L2` 是因为 `reader.CODE_FALLBACK["L2"]` 的第一条是
  `C2`，本夹具没有 C2，需要靠回退链落到 `P2` 才能走通 `_from_rinex2`。
  这也顺带钉住"缺 C2 就退到 P2"这条回退链是真的在跑。
"""

RINEX3_OBS = """     3.04           OBSERVATION DATA    M                   RINEX VERSION / TYPE
FIELDS        1.0                                           PGM / RUN BY / DATE
TESTSTN                                                     MARKER NAME
TESTSTN                                                     MARKER NUMBER
FTX1                1.01                                    OBSERVER / AGENCY
TRIG                NETRS               1.00                REC # / TYPE / VERS
TRIG                ANH                                     ANT # / TYPE
  -3456000.000   4653800.000   4049400.000      TESTSTN     APPROX POSITION XYZ
         0.000         0.000         0.000                  ANTENNA: DELTA H/E/N
 2023     1     1     0     0    0.0000000      GPS         TIME OF FIRST OBS
G    8 C1C L1C D1C S1C C2C L2C D2C S2C                      SYS / # / OBS TYPES
                                                            END OF HEADER
> 2023 01 01 00 00  0.0000000  0  4G01G02G03G04
G01   23040555.1230 123456789.1230     -1234.5670        41.0000  24000000.4560 130000000.9870      1875.6140        45.0000
G02   23040566.4560 123457012.3450     -1200.1110        42.0000  24000011.7890 130000105.4560      1900.2220        46.0000
G03   23040577.7890 123457235.5670     -1165.6540        40.0000  24000023.0120 130000210.1230      1925.3330        44.0000
G04   23040589.0120 123457458.7890     -1131.1970        39.0000  24000034.3450 130000315.6780      1950.4440        43.0000
                                                            END OF FILE
"""

RINEX2_OBS = """     2.00           OBSERVATION DATA    M                   RINEX VERSION / TYPE
     2.00           FIELDSTATION                            PGM / RUN BY / DATE
TESTSTN                                                     MARKER NAME
FTX1                1.01                                    OBSERVER / AGENCY
TRIG                NETRS                                   REC # / TYPE / VERS
TRIG                ANH                                     ANT # / TYPE
  -3456000.000   4653800.000   4049400.000                  APPROX POSITION XYZ
         0.000         0.000         0.000                  ANTENNA: DELTA H/E/N
    5 C1    L1    S1    P2    L2                            # / TYPES OF OBSERV
    30.00                                                   INTERVAL
    4                                                       # OF SATELLITES
  23     1     1     0     0    0.0000000       GPS         TIME OF FIRST OBS
                                                            END OF HEADER
 23 01 01 00 00 00.0000000  0  4G01G02G03G04
  23040555.123 123456789.123        41.000  24000000.456 130000000.987
  23040566.456 123457012.345        42.000  24000011.789 130000105.456
  23040577.789 123457235.567        40.000  24000023.012 130000210.123
  23040589.012 123457458.789        39.000  24000034.345 130000315.678
"""

BAD_OBS = "这不是观测文件\n"

# --- 计划书原文，逐字保留，仅作负控制；不要当夹具用 -------------------------
RINEX3_OBS_PLAN_LITERAL = """3.04 OBSERVATION DATA    M                   RINEX VERSION / TYPE
TESTSTN                                                       MARKER NAME
FTX1            1.01           OBSERVER / AGENCY
TRIG            1.00 REC       OBSERVER / NUMBER
TRIG            1.00 ANTENNA TYPE
    -3456000.0000  4653800.0000  4049400.0000      TRIG    APPROX POSITION XYZ
        0.0000        0.0000        0.0000                  ANTENNA: DELTA H/E/N
G    4 C1C L1C D1C S1C C2C L2C D2C S2C                         SYS / # / OBS TYPES
2023 01 01 00 00  0.0000000  0 10G01G02G03G04
  23040555  23679845  23679846       41   45   45.000
"""

RINEX2_OBS_PLAN_LITERAL = """     2.00           OBSERVATION DATA    M                   RINEX VERSION / TYPE
TESTSTN                                                      MARKER NUMBER
FTX1            1.01           OBSERVER / AGENCY
TRIG            1.00 REC       OBSERVER / NUMBER
TRIG            1.00 ANT       ANTENNA TYPE
      -3456000.0000  4653800.0000  4049400.0000              APPROX POSITION XYZ
        0.0000        0.0000        0.0000                  ANTENNA: DELTA H/E/N
     30.00                                                      INTERVAL
  23  1  1  0  0  0.0000000  0 10G01G02G03G04G05G06G07G08
   23040555 23679845  23679846  23679847  23679848  23679849
      23040555   41   45   45.000      41   45   45.000
"""
