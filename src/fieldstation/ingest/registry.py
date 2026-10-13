#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""观测文件接入登记表：把"这份文件该怎么读"固化成可复现的配置。

## 为什么需要这张表

RINEX 2 的数据字段宽度在同一批真实文件里就有多种
（实测：hkws=15 宽、daej/kmnm/irkj=16 宽），而**自动探测不可靠** ——
三版判据（解出数最多 / 交叉码 IF 吻合 / 逐字段 MAD 稳定）都会把
15 宽的 hkws 误判成 16 宽，让 vTEC 的 r 从 0.806 掉到 0.541。
错宽时每个字段仍能解成"合法数字"，现有物理闸门拦不住。

所以：宽度**不猜**，登记在这里，由 `reader.ObservationFile` 读取。
每条记录都写明**实测依据**，不是推测。

## 怎么给一个新文件定宽度（可复现流程）

1. 先按默认（空白切分）跑一遍，记 `records / dropped / n_sat`
2. 若 `dropped` 占比很高（>30%），说明空白折叠导致块错位，需要定宽
3. 逐个试 `_WIDTH_CANDIDATES`，**以「端到端 vTEC 的 r」为准**，
   不是以「记录数」为准 —— 记录数在错宽时反而更高
4. 把胜出宽度连同实测 r 写进本文件

## 覆盖方式

- 环境变量 `GNSS_TEC_FIELD_WIDTH=<站名>=<宽度>;...`（临时试验）
- 或直接在本文件登记（长期，可随代码提交）
环境变量优先级更高，便于不改代码就做 A/B。
"""
from __future__ import annotations

import os

# 实测登记：RINEX 2 数据字段宽度（字符/观测）
# width = None 表示默认走空白切分（已验证可用，不要动）
RINEX2_FIELD_WIDTH: dict[str, int | None] = {
    # ==========================================================================
    # 2026-10-02 更新：**块感知定宽解析器已验证可用**，默认值改为按
    # **生产程序**选取（见 PROGRAM_FIELD_WIDTH），不再全 None。
    #
    # ## 本轮修掉的根因（MTKA 弧段爆炸 + 5 站读不出）
    #
    # 旧代码按「已写了几个**非空**字段」决定要不要读下一行：
    #     while got_f < n_code: 读一行，数其中非空字段，加进 got_f
    # RINEX 2 规定尾部全空的观测**用空格填充、不省略行**，所以「非空计数」
    # 与实际占行数无关。MTKA（8 个观测码 = 2 行/星）第 1 行实测只有 3 个
    # 非空字段，got_f 只到 3 < 8 -> **多读第 3 行**，把下一颗星的数据当成本星
    # 第 3 行吞掉，**块边界逐星漂移**。后果：18 条序列切出 773 个弧段
    # （正常 16~30），771 段过短无法定平，vTEC 输出 n=0。
    #
    # 修法：固定消费 `ceil(n_obs_types / 5)` 行。
    #
    # ## 宽度判据换成「自校验零丢弃」（前 4 版判据为何全败）
    #
    # 旧判据依次为「解出数最多」「交叉码 IF 吻合」「逐字段 MAD 稳定」
    # 「显式指定后直接采用」，全部失败，共同原因是：
    # **错宽时每个字段仍能解成「合法数字」**，而当时的物理闸门区间太宽
    # （C ∈ (1e6,5e7)、L ∈ (1e7,1.5e9)），载波相位错位落到伪距位恰好落在区间内被放行。
    # 现在 `_class_ok` 收紧到互不重叠的窄区间（伪距 1.5e7~3.0e7、
    # 相位 5.0e7~2.0e8、多普勒 ±1e4、SNR 0~60），实测**正确宽度给出 0 丢弃**，
    # 错误宽度丢弃率 >90%。判据由此与数据无关。
    #
    # ## 本站特例（2026-10-02 更正：此前记为「文件损坏」是**错的**）
    #
    # 旧注释说 CHAN / KAZA「相位字段是负数 -> 文件本身损坏，全部宽度无法
    # 解析，不要再尝试调宽度」。**该结论已被推翻**：
    #   - 载波相位绝对值没有物理意义（rho = lambda*L1 + N*lambda，N 未解），
    #     负值是合法的；真正可靠的判据是相邻历元变化率（见
    #     `rinex2.phase_rate_report`）。
    #   - 按 16 宽定长解析，**实测 KAZA 9 天 / CHAN 10 天全部 n_dropped=0**，
    #     29212 条记录全部解出，L1/L2/C1/P2 的量级与物理闸门逐项通过。
    #   - 卫星号取自历元行尾部 3 字符块（实测与 SP3 几何一致：首块 -> G10、
    #     次块 -> G08 …，仰角全部为正）。
    #
    # KAZA / CHAN 的真实问题**不是读取**：KAZA 的接收机差分码偏差
    # 见 `qc.code_ionosphere_sign_verdict` 与 docs/19。
    #
    # 这里把宽度**显式写成 16**，而不是留 `None`：留 `None` 时
    # `field_width_for` 会把它当成「未登记」而回落到 PROGRAM_FIELD_WIDTH，
    # 恰好也得到 16 —— 行为相同但意图不明，且一旦将来改了
    # PROGRAM_FIELD_WIDTH 就会静默改掉这两站的解析方式。
    # ==========================================================================
    "HKWS": 15,
    "DAEJ": 16,
    "KMNM": 16,
    "IRKJ": 16,
    "NVSK": 16,
    "MTKA": 16,
    "USUD": 16,
    "CKSV": 16,
    "BADG": 16,
    "TWTF": 16,
    "SMST": 16,
    "HYDE": 16,
    "POL2": 16,
    "CHAN": 16,     # teqc，16 宽；**不是**文件损坏（见上）
    "KAZA": 16,     # teqc，16 宽；**不是**文件损坏（见上）
}

# 生产程序 -> 字段宽度。实测 147 个文件里只有两种格式：
#   Spider v7.5   -> 15 宽（值 13 位 + LLI 1 位 + 填充 1 位），历元行补零
#   teqc/CCRINEXO -> 16 宽（值 14 位 + LLI 1 位 + 空格 1 位），历元行不补零
# 这是实测强相关且**可解释**的信号，用来在登记表缺项时兜底。
PROGRAM_FIELD_WIDTH: dict[str, int] = {
    "spider": 15,
    "jps2rin": 16,
    "teqc": 16,
    "ccrinexo": 16,
    "gfzrnx": 16,
    "rtklib": 16,
}

# 站名 -> 已知问题。经纬度一律从文件自身 APPROX POSITION XYZ 正算，不查表。
STATION_NOTES: dict[str, str] = {
    "HKWS": "香港 22.43N/114.34E。唯一双基准全通站（vs SEPC r=+0.898）。",
    "IRKJ": "伊尔库茨克 52.22N/104.32E。首行 `     2` 无小数点，早期被误判 UNKNOWN。",
    "DAEJ": "韩国大田 36.40N/127.37E。10 种观测码，无 C2（L2 的码是 P2）。",
    "KMNM": "金门 24.46N/118.39E。7 种观测码，无 C2。",
    "KAZA": "中亚 41.38N/73.94E（吉尔吉斯斯坦天山，UNAVCO）。7 个观测码 "
            "`L1 L2 C1 P2 P1 S1 S2`，**无 C2**；P1 槽位在全文件里恒为空。"
            "teqc 2020Oct7 生成，16 宽定长，**实测 n_dropped=0**。"
            "**不是文件损坏**（旧注释的「相位为负 = 损坏」已推翻，见上）。"
            "真实问题：该站 TRIMBLE NETRS 的 C1C-P2 差分码偏差实测 "
            "+5.30~+10.53 m（+17.7~+35.1 ns，31/31 颗全为正），"
            "压过电离层延迟差（1~4 m），几何无关码组合整体反号 -> "
            "六算法全负 TEC。由 qc.code_ionosphere_sign_verdict 拦截。",
    "CHAN": "长春 43.79N/125.44E。7 个观测码 `L1 L2 P1 P2 C1 S1 S2`，"
            "7 个字段全部有值，teqc 2018Dec12，16 宽，n_dropped=0。"
            "**不是文件损坏**（旧注释已推翻）。相位为负是合法的"
            "（整周模糊度 N 未解）。",
    "CKSV": "3 天缺测（DOY004 仅 1102 历元），非下载问题。"
            "teqc 2019Feb25，16 宽，7 个观测码。",
    "MTKA": "约 51N。**本轮由「弧段爆炸 773/18」修好**：根因是旧代码按"
            "非空字段数决定读几行，块边界逐星漂移（详见 RINEX2_FIELD_WIDTH 注释）。"
            "修后 w=16 丢弃 0，S1 多普勒不再错位到 C2。",
    "BADG": "JPS2RIN v.2.0.178，16 宽，**20 个观测码 = 4 行/星**。"
            "丢弃率仍偏高（约 91%），需后续确认是否可再降。",
}


def field_width_for(station: str, program: str | None = None) -> int | None:
    """查一个站该用多宽。优先级：环境变量 > 站名登记表 > 生产程序。

    环境变量格式：`GNSS_TEC_FIELD_WIDTH=HKWS=15;DAEJ=16`
    """
    env = os.environ.get("GNSS_TEC_FIELD_WIDTH", "")
    for item in env.replace(",", ";").split(";"):
        if "=" not in item:
            continue
        k, v = item.split("=", 1)
        if k.strip().upper() == station.strip().upper():
            return int(v.strip())
    # 键统一大写；**查找也必须大写** —— 曾经表里写小写、查的时候 .upper()，
    # 导致永远查不到、登记表形同虚设（踩过，daej/kmnm 仍 0 记录）。
    w = RINEX2_FIELD_WIDTH.get(station.strip().upper())
    if w is not None:
        return w
    # 登记表缺项时按生产程序兜底。
    if program:
        key = program.strip().lower().split()[0] if program.strip() else ""
        for pref, width in PROGRAM_FIELD_WIDTH.items():
            if key.startswith(pref):
                return width
    return None


if __name__ == "__main__":
    print("已登记的 RINEX 2 字段宽度（键=大写站名）：")
    for k, v in sorted(RINEX2_FIELD_WIDTH.items()):
        print(f"  {k:<6} width={str(v):<5} {STATION_NOTES.get(k, '')}")
    print("\n生产程序兜底：" + "  ".join(
        f"{k}->{v}" for k, v in PROGRAM_FIELD_WIDTH.items()))
    print("\n环境变量覆盖：GNSS_TEC_FIELD_WIDTH=HKWS=15;DAEJ=16")
