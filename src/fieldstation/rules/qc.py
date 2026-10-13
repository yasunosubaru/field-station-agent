"""质量控制：高度角/CN0 门槛、周跳检测（两法取“或”）、MAD 稳健 z 粗差、弧段切分。

周跳策略 = 检测 + 重分段，不做模糊度修复（T4 决策）。
两法互补：A 几何无关相位残差（对窄巷敏感），B Melbourne-Wubbena（对宽巷敏感）。

本模块只用标准库。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from .. import constants as C
from ..model import EpochPair

MISSING = float("nan")


@dataclass
class QCConfig:
    elev_cutoff_deg: float = 15.0
    cn0_min_dbhz: float = 30.0
    slip_gf_k: float = 4.0
    slip_gf_poly_window_s: float = 60.0
    slip_mw_k: float = 4.0
    slip_min_jump_tecU: float = 0.5
    # sigma 的**物理下限**（TECU）。用于 mad() 退化为 0 的情形。
    #
    # 依据（换算走 constants.dcb_ns_to_tecu，全项目唯一权威，别在这里另写一套）：
    #   1 ns 的等效距离误差 = c * 1ns = 0.29979 m
    #   几何无关码组合的 TECU 换算系数 k_P(GPS) = 9.519643 TECU/m
    #   => 1 ns  ==>  9.519643 * 0.29979 = **2.8539 TECU**（实测，见 dcb_ns_to_tecu）
    #   （旧注释写 0.55 TECU，**错 5.2 倍**；已按实测 k_P 更正）
    #
    # 取 1.0 TECU 作地板，比 1 ns 门槛**更低**，是刻意保守的选择：
    #   - 挡得住真实周跳（实测阈 slip_min_jump_tecU = 0.5 TECU，
    #     乘 slip_gf_k = 4 后需残差 > 4.0 TECU 才触发，地板 1.0 不构成瓶颈）
    #   - 又不像「sigma==0 就无条件成立」那样把整条弧段判成周跳
    #     （KAZA 站 sigma_mw 实测全为 0.0，正是该情形）
    slip_sigma_floor_tecu: float = 1.0
    gap_threshold_s: float = 1.5
    psr_stec_max_TECU: float = 1.0e4
    adr_resid_max_TECU: float = 1.0e3
    # 两路周跳检测结果的合成方式。
    #   "auto"（默认）：并集，但当 **MW 路的稳健标准差退化**（退化为物理地板、
    #                   即阈值失去数据依据）时改为合取，抑制 MW 独自造成的误切
    #   "intersect"：强制合取（仅用于对照实验，洁净数据上检出率 95%->60%）
    #   "union"：强制并集（2026-10-02 前的行为）
    #
    # 设计依据见 `_detect_slips` 内注释的实测证据。
    slip_combine: str = "auto"


def default_qc_config(cfg: dict) -> QCConfig:
    algo = cfg.get("algo", {}) if isinstance(cfg, dict) else {}

    def pick(key, default):
        if key in algo:
            return algo[key]
        return cfg.get(key, default) if isinstance(cfg, dict) else default

    gap = algo.get("leveling_gap_threshold_s")
    if gap in (None, "[DATA]"):
        gap = 1.5
    return QCConfig(
        elev_cutoff_deg=float(pick("elev_cutoff_deg", 15.0)),
        cn0_min_dbhz=float(pick("cn0_min_dbhz", 30.0)),
        slip_gf_k=float(algo.get("slip_gf_k", 4.0)),
        slip_gf_poly_window_s=float(algo.get("slip_gf_poly_window_s", 60.0)),
        slip_mw_k=float(algo.get("slip_mw_k", 4.0)),
        slip_min_jump_tecU=float(algo.get("slip_min_jump_tecU", 0.5)),
        slip_sigma_floor_tecu=float(algo.get("slip_sigma_floor_tecu", 1.0)),
        gap_threshold_s=float(gap),
        psr_stec_max_TECU=float(algo.get("psr_stec_max_TECU", 1.0e4)),
        adr_resid_max_TECU=float(algo.get("adr_resid_max_TECU", 1.0e3)),
        slip_combine=str(algo.get("slip_combine", "auto")),
    )


# ---------------------------------------------------------------- 稳健统计
def median(values: list[float]) -> float:
    vals = sorted(v for v in values if math.isfinite(v))
    if not vals:
        return MISSING
    n = len(vals)
    mid = n // 2
    return vals[mid] if n % 2 else 0.5 * (vals[mid - 1] + vals[mid])


def mad(values: list[float], med: float | None = None) -> float:
    if med is None:
        med = median(values)
    if not math.isfinite(med):
        return MISSING
    devs = [abs(v - med) for v in values if math.isfinite(v)]
    return median(devs)


def robust_z(values: list[float]) -> list[float]:
    med = median(values)
    md = mad(values, med)
    scale = 1.4826 * md
    if not math.isfinite(scale) or scale == 0.0:
        return [MISSING] * len(values)
    return [(v - med) / scale if math.isfinite(v) else MISSING for v in values]


def _polyfit(xs: list[float], ys: list[float], deg: int) -> list[float]:
    """最小二乘多项式拟合，返回系数（升幂）。高斯消元，标准库实现。"""
    m = deg + 1
    a = [[0.0] * (m + 1) for _ in range(m)]
    for i in range(m):
        for j in range(m):
            a[i][j] = sum(x ** (i + j) for x in xs)
        a[i][m] = sum(y * x ** i for x, y in zip(xs, ys))
    for col in range(m):
        piv = max(range(col, m), key=lambda r: abs(a[r][col]))
        if abs(a[piv][col]) < 1e-300:
            continue
        a[col], a[piv] = a[piv], a[col]
        pv = a[col][col]
        for j in range(col, m + 1):
            a[col][j] /= pv
        for r in range(m):
            if r == col:
                continue
            fac = a[r][col]
            for j in range(col, m + 1):
                a[r][j] -= fac * a[col][j]
    return [a[i][m] for i in range(m)]


def _polyval(coef: list[float], x: float) -> float:
    return sum(c * x ** i for i, c in enumerate(coef))


# ---------------------------------------------------------------- 组合序列
def _sign(system: str) -> float:
    return 1.0  # 由调用方传入 adr_sign 的真实符号


def ilr_series(series: list[EpochPair], system: str, s1: str, s2: str, sign: float) -> list[float]:
    """几何无关相位电离层残差 I_r = k_P * (X1 - X2)，单位 TECU。缺失为 NaN。"""
    kp = C.k_P(system)
    lam1 = C.WAVELENGTH_M[(system, s1)]
    lam2 = C.WAVELENGTH_M[(system, s2)]
    out = []
    for ep in series:
        o1, o2 = ep.get(s1), ep.get(s2)
        if o1 is None or o2 is None:
            out.append(MISSING)
            continue
        x1 = sign * o1.adr_cycles * lam1
        x2 = sign * o2.adr_cycles * lam2
        out.append(kp * (x1 - x2))
    return out


def mw_series(series: list[EpochPair], system: str, s1: str, s2: str, sign: float) -> list[float]:
    """Melbourne-Wubbena 组合（米）。缺失为 NaN。"""
    f1 = C.get_freq(system, s1)
    f2 = C.get_freq(system, s2)
    lam1 = C.WAVELENGTH_M[(system, s1)]
    lam2 = C.WAVELENGTH_M[(system, s2)]
    out = []
    for ep in series:
        o1, o2 = ep.get(s1), ep.get(s2)
        if o1 is None or o2 is None:
            out.append(MISSING)
            continue
        ph1 = sign * o1.adr_cycles  # 教科书相位（周）
        ph2 = sign * o2.adr_cycles
        term1 = (f1 * ph1 * lam1 - f2 * ph2 * lam2) / (f1 - f2)
        term2 = (f1 * o1.psr_m + f2 * o2.psr_m) / (f1 + f2)
        out.append(term1 - term2)
    return out


def _median_dt(series: list[EpochPair]) -> float:
    diffs = []
    for i in range(1, len(series)):
        d = (series[i].gps_week - series[i - 1].gps_week) * 604800.0 + (
            series[i].gps_tow_s - series[i - 1].gps_tow_s
        )
        diffs.append(d)
    m = median(diffs)
    return m if math.isfinite(m) and m > 0 else 1.0


def detect_slips(
    series: list[EpochPair], system: str, s1: str, s2: str, sign: float, qc: QCConfig
) -> tuple[set[int], dict]:
    """两法取或。返回 (周跳历元索引集合, 诊断信息)。"""
    n = len(series)
    ir = ilr_series(series, system, s1, s2, sign)
    mw = mw_series(series, system, s1, s2, sign)
    # 只用**码**粗差位排除：码尖峰不是周跳，且会污染 M-W 组合。
    # 不能用 BIT_PHASE_BAD 排除——相位粗差正是周跳本身；而 flag_epochs 的
    # 全局 robust_z 会把一次阶跃之后的整段都标成 phase_bad，若在此排除，
    # 阶跃历元会被自己刚打上的标志遮蔽，检出率掉到约 55%（实测）。
    bad_mask = C.BIT_PSR_BAD
    for i, ep in enumerate(series):
        if ep.quality_flag & bad_mask:
            ir[i] = MISSING
            mw[i] = MISSING
    dt = _median_dt(series)
    win = max(5, int(round(qc.slip_gf_poly_window_s / dt)))
    slip_a: set[int] = set()
    slip_b: set[int] = set()

    def _collapse(raw_idx):
        """把连续/相邻的报警索引折叠为一个切点。"""
        out: list[int] = []
        for s in sorted(raw_idx):
            if out and s - out[-1] <= 1:
                continue
            out.append(s)
        return out

    # 方法 A：滑动窗口低阶多项式外推残差。
    # (1) 拟合历史只取**当前弧段**（上一次检出周跳之后）：一次真实阶跃会让
    #     阶跃前的点把多项式拖偏，若仍用它们外推，阶跃后连续若干历元都会被误判
    #     为新的周跳（实测单阶跃在 [600,602,604] 处重复切分）。
    # (2) 拟合前先剔除历史窗口内的离群点，避免单历元相位尖峰污染外推。
    # (3) 候选点须通过「持续性确认」：真实周跳是模糊度阶跃（后续历元保持新
    #     电平）；单历元相位尖峰（相位粗差，T-10）会立刻回到基线，不判为周跳。
    last_slip = -1
    gf_sigmas: list[float] = []      # 实际参与判定的 sigma 样本（诊断用）
    n_sigma_zero = 0
    for i in range(n):
        if not math.isfinite(ir[i]):
            continue
        lo = max(0, i - win)
        if last_slip >= 0:
            lo = max(lo, last_slip)
        hist_idx = [j for j in range(lo, i) if math.isfinite(ir[j])]
        if len(hist_idx) < 5:
            continue
        ys_all = [ir[j] for j in hist_idx]
        med_y = median(ys_all)
        md_y = mad(ys_all, med_y)
        if math.isfinite(md_y) and md_y > 0:
            lim = 6.0 * 1.4826 * md_y
            keep = [k for k in range(len(hist_idx)) if abs(ys_all[k] - med_y) <= lim]
            if len(keep) >= 5:
                hist_idx = [hist_idx[k] for k in keep]
                ys_all = [ys_all[k] for k in keep]
        xs = [j - hist_idx[0] for j in hist_idx]
        coef = _polyfit(xs, ys_all, 1)
        sigma = 1.4826 * mad([ys_all[k] - _polyval(coef, xs[k]) for k in range(len(xs))])
        gf_sigmas.append(sigma if math.isfinite(sigma) else 0.0)
        # **sigma 退化为 0 时不再无条件成立**。
        # 原写法是 `... or sigma == 0`：历史窗口去趋势后完全平直时
        # sigma 恰为 0，于是任何 |r| > slip_min_jump_tecU 的历元都被判成周跳 ——
        # 那等于把「除零」写成了一个显式旁路。实测 KAZA 站 sigma_mw 全为 0.0，
        # 正是这个情形。现在改用物理地板 slip_sigma_floor_tecu。
        sig_eff = sigma if (math.isfinite(sigma) and sigma > 0) \
            else qc.slip_sigma_floor_tecu
        if not (math.isfinite(sigma) and sigma > 0):
            n_sigma_zero += 1
        r = ir[i] - _polyval(coef, i - hist_idx[0])
        fired = abs(r) > qc.slip_min_jump_tecU and abs(r) > qc.slip_gf_k * sig_eff
        if not fired:
            continue
        conf = [ir[j] - _polyval(coef, j - hist_idx[0])
                for j in range(i, min(n, i + 4)) if math.isfinite(ir[j])]
        cm = median(conf)
        if len(conf) < 3:
            # 弧段末尾样本不足，无法区分持续/尖峰，保守接受
            slip_a.add(i)
            last_slip = i
        elif math.isfinite(cm) and abs(cm) > qc.slip_min_jump_tecU and cm * r > 0:
            slip_a.add(i)
            last_slip = i

    # 方法 B：M-W 历元差（候选）+ 窗口电平位移（持续性确认）。
    # 宽巷跳变是持久阶跃：跳变历元有唯一大差分，且阶跃前后窗口中位数不同。
    # 单历元尖峰会在 i 与 i+1 各产生一个符号相反的大差分，但窗口电平不变。
    diffs = [mw[i] - mw[i - 1] for i in range(1, n)
             if math.isfinite(mw[i]) and math.isfinite(mw[i - 1])]
    md_mw = mad(diffs)
    sigma_mw = 1.4826 * md_mw if math.isfinite(md_mw) else MISSING
    # sigma_mw 退化为 0 时（实测 KAZA 全部 25 条序列都是 0.0），**不再退化成
    # 硬编码的 |d| > 10 TECU 绝对阈值** —— 那是个与数据无关的魔数，且会让
    # 「周跳检出率」在不同站之间不可比。同样改用物理地板。
    #
    # ---- 但固定地板本身也偏松，故再加一层由数据导出的回退（2026-10-02）----
    #
    # `mad(diffs)` 恰为 0 通常是因为**观测量被量化**：过半的差分完全相同
    # （例如 MW 序列以固定的宽巷波长为步长量化），此时中位绝对偏差取 0，
    # 但差分分布的**上尾仍反映真实噪声**。
    # 直接落到 1.0 TECU 固定地板等于宣称"噪声 1 TECU"，该宣称无数据依据；
    # 实测该情形下 MW 路是误报主因（MTKA：mw 143 对 gf 63，而其 GF 路同时也在触发）。
    #
    # 故退化时改用差分绝对值的**上分位数**估计噪声尺度：
    #     sigma ≈ p75(|d|) / 0.6745
    # （0.6745 是正态分布的 0.75 分位点，对应系数；用上分位数而非中位数
    #   是为了避开量化造成的 0，但仍保持稳健——不取最大值。）
    # 该估计仍**设上限**，防止个别粗差把门限抬到永不触发。
    sigma_big = math.isfinite(sigma_mw) and sigma_mw > 0.0
    sigma_mw_src = "mad"
    if not sigma_big:
        ad = sorted(abs(x) for x in diffs)
        if len(ad) >= 8:
            p75 = ad[int(0.75 * (len(ad) - 1))]
            if math.isfinite(p75) and p75 > 0:
                cand = p75 / 0.6745
                hi = 3.0 * qc.slip_sigma_floor_tecu
                sigma_mw = min(max(cand, qc.slip_sigma_floor_tecu), hi)
                sigma_big = True
                sigma_mw_src = "p75"
    sig_mw_eff = sigma_mw if sigma_big else qc.slip_sigma_floor_tecu
    for i in range(1, n):
        if not (math.isfinite(mw[i]) and math.isfinite(mw[i - 1])):
            continue
        d = mw[i] - mw[i - 1]
        if abs(d) <= max(qc.slip_mw_k * sig_mw_eff, qc.slip_min_jump_tecU):
            continue
        pre = [mw[j] for j in range(max(0, i - 3), i) if math.isfinite(mw[j])]
        post = [mw[j] for j in range(i, min(n, i + 3)) if math.isfinite(mw[j])]
        shift = median(post) - median(pre)
        if not math.isfinite(shift):
            continue
        if abs(shift) > max(qc.slip_mw_k * sig_mw_eff, qc.slip_min_jump_tecU) \
                and shift * d > 0:
            slip_b.add(i)

    # ---- 两路检测结果的合成 ----
    #
    # 真实周跳的物理后果是**两个观测量同时移动**：
    #   几何无关相位组合  ir = k_P*(lam1*L1 - lam2*L2)   -> 移动整周
    #   Melbourne-Wubena mw = 宽巷相位 - 宽巷伪距       -> 移动整周
    # 而**只有一路动**的多为观测量自身的问题，不是周跳：
    #   - 只有 mw 动：伪距多径（城市峡谷、遮挡物附近最严重）
    #   - 只有 ir 动：相位周跳但幅度落在宽巷整数倍以下，已被 slip_min_jump 吸收
    #
    # ## 实测依据（2026-10-02）
    #
    # MTKA（东京，ECEF 解算 lat 35.67952 / lon 139.56139）是最能说明问题的样本。
    # 该站 L1 载波相位的「粗降率」（dL1 < -20 x 中位|dL1|）为 **2.2~3.3%**，
    # 而 IRKJ / HKWS / NVSK 三个对照站仅 **0.10~0.21%**，高 10~30 倍；
    # MTKA 最大降幅达 -21~-26 M 周，对照站为 -2.5~-9 M 周。
    # 即该站**确有大量真实周跳**（东京密集高楼峡谷，遮挡与多径严重）。
    #
    # 但合成取并集时 MTKA 仍切出 1148 个弧段 / 23 条序列（每星约 50 段），
    # 远多于其粗降数（每星约 15），且主导项是 MW 路（G26：mw 143 vs gf 63）。
    # 差额来自**只有 MW 触发的伪报**，其成因即上面的伪距多径。
    #
    # ## 三条实测证据决定了合成规则
    #
    # (1) 合成洁净数据（tests/test_qc.py，注入 20 个真实模糊度阶跃）：
    #     GF 路检出 20/20，MW 路检出 12/20。
    #     => **MW 是弱检测器**。若取合取，检出率由 95% 掉到 60%，
    #        即「强制合取」会漏掉四成真实周跳。
    #     这直接否定了「一律取合取」的做法（我先实现过，随即被这条测试推翻）。
    #
    # (2) MTKA（东京）：L1 载波相位粗降率 2.2~3.3%，三个对照站仅 0.10~0.21%，
    #     高 10~30 倍 => 该站**确有大量真实周跳**（密集高楼峡谷，遮挡与多径）。
    #     但取并集时仍切出 1148 弧段 / 23 序列（每星约 50 段），
    #     远多于粗降数（每星约 15），差额即 MW 路误报。
    #
    # (3) MW 路误报的成因是**阈值失去数据依据**：该站 `sigma_mw` 实测退化为 0
    #     （历史窗口去趋势后完全平直），于是 `sig_mw_eff` 落到 1.0 TECU 物理地板，
    #     判据退化为「跳变 > 4 TECU 即判」，而 4 TECU 在城市环境下毫无约束力。
    #
    # 由 (1) 不能一律合取；由 (2)(3) 误报集中在「MW 阈值已无数据依据」的序列上。
    # 故采用条件规则：**仅当 MW 稳健标准差退化时才要求两路一致**，
    # 此时 MW 的「触发」不含信息，不应单独造成切分；
    # MW 标准差健康时保持并集，避免 (1) 的漏检。
    _inter = slip_a & slip_b
    _mw_uninformative = not sigma_big
    if qc.slip_combine == "intersect":
        raw = sorted(_inter)
    elif qc.slip_combine == "union":
        raw = sorted(slip_a | slip_b)
    elif _mw_uninformative:
        # MW 阈值退化为固定地板 -> 其报警不作为独立切分依据
        raw = sorted(_inter)
    else:
        raw = sorted(slip_a | slip_b)
    slips = _collapse(raw)
    gs = sorted(x for x in gf_sigmas if x == x)
    diag = {
        "n_epochs": n,
        "n_slip_gf": len(_collapse(slip_a)),
        "n_slip_mw": len(_collapse(slip_b)),
        "n_slip_union": len(raw),
        "n_slip_split_points": len(slips),
        "slip_indices": slips,
        "slip_indices_raw": raw,
        # 原来这里是硬编码的 None —— 第 224 行真正算出的 sigma 从没被记录，
        # 于是「sigma_gf=None」看起来像算失败，其实只是**没实现**。
        # 现在给出真实分布，外加 sigma 退化为 0 的次数（决定检出率可不可信）。
        "sigma_gf_window": (None if not gs else {
            "n": len(gs), "median": median(gs),
            "p10": gs[max(0, int(0.10 * (len(gs) - 1)))],
            "p90": gs[max(0, int(0.90 * (len(gs) - 1)))],
            "n_zero": n_sigma_zero,
            "floor_used": qc.slip_sigma_floor_tecu}),
        "sigma_mw": None if not math.isfinite(sigma_mw) else sigma_mw,
        "sigma_mw_degenerate": bool(not sigma_big),
        "gf_window_samples": win,
    }
    return set(slips), diag


def flag_epochs(
    series: list[EpochPair], system: str, s1: str, s2: str, sign: float, qc: QCConfig
) -> dict:
    """按高度角/CN0/配对/粗差给历元置 quality_flag 位。返回统计。"""
    stats = {"low_elev": 0, "low_cn0": 0, "no_pair": 0, "psr_bad": 0, "phase_bad": 0}
    kp = C.k_P(system)
    lam1 = C.WAVELENGTH_M[(system, s1)]
    lam2 = C.WAVELENGTH_M[(system, s2)]
    teca, tecr = [], []
    for ep in series:
        o1, o2 = ep.get(s1), ep.get(s2)
        if o1 is None or o2 is None:
            teca.append(MISSING)
            tecr.append(MISSING)
            continue
        teca.append(kp * (o2.psr_m - o1.psr_m))
        x1 = sign * o1.adr_cycles * lam1
        x2 = sign * o2.adr_cycles * lam2
        tecr.append(kp * (x1 - x2))
    z_psr = robust_z(teca)
    z_ph = robust_z(tecr)
    for i, ep in enumerate(series):
        o1, o2 = ep.get(s1), ep.get(s2)
        if o1 is None or o2 is None:
            ep.quality_flag |= C.BIT_NO_PAIR
            stats["no_pair"] += 1
        elev = ep.elev_deg
        if math.isfinite(elev) and elev < qc.elev_cutoff_deg:
            ep.quality_flag |= C.BIT_LOW_ELEV
            stats["low_elev"] += 1
        cn0 = o1.cn0_dbhz if o1 else MISSING
        if math.isfinite(cn0) and cn0 < qc.cn0_min_dbhz:
            ep.quality_flag |= C.BIT_LOW_CN0
            stats["low_cn0"] += 1
        if math.isfinite(z_psr[i]) and abs(z_psr[i]) > 8.0:
            ep.quality_flag |= C.BIT_PSR_BAD
            stats["psr_bad"] += 1
        if math.isfinite(z_ph[i]) and abs(z_ph[i]) > 8.0:
            ep.quality_flag |= C.BIT_PHASE_BAD
            stats["phase_bad"] += 1
    return stats


def segment_arcs(series: list[EpochPair], slip_indices: set[int], gap_threshold_s: float) -> int:
    """按周跳与采样断点切分连续弧段，写回 arc_id。返回弧段数。"""
    if not series:
        return 0
    arc = 0
    prev_t = None
    prev_week = None
    # **gap_threshold_s 是「采样间隔的倍数」，不是绝对秒数。**
    # 实测踩坑（2024-01-03 真实数据）：曾写成 `dt > gap_threshold_s * 1.0`，
    # 于是 30 s 采样时判据变成 dt > 1.5 s —— 每个历元都被当成采样断点，
    # 全线静默失效（1 Hz 合成数据恰好躲过，只有换采样率才暴露）。
    dt_nominal = _median_dt(series)
    for i, ep in enumerate(series):
        t = (ep.gps_week - series[0].gps_week) * 604800.0 + ep.gps_tow_s
        if prev_t is None:
            arc = 0
        else:
            dt = t - prev_t
            if i in slip_indices:
                arc += 1
                # 周跳历元同时打 slip 位：下游据此区分「周跳」与「采样断点」
                # （断点只置 BIT_GAP）。两者都作为弧段边界递增 arc_id。
                ep.quality_flag |= C.BIT_SLIP
            elif dt > gap_threshold_s * dt_nominal + 1e-9 and dt > 0:
                # 缺测/断点：dt 不是采样间隔的普通倍数切段
                arc += 1
                ep.quality_flag |= C.BIT_GAP
        ep.arc_id = arc
        prev_t = t
        prev_week = ep.gps_week
    return arc + 1


def run_qc(pairs_by_key: dict, cfg: dict) -> dict:
    """对每个 (station, system, sv) 序列跑 QC。返回报告。"""
    qc = default_qc_config(cfg)
    sign = C.meas_cycle_sign(cfg.get("algo", {}).get("adr_sign", cfg.get("adr_sign", "adr")))
    report = {"config": qc.__dict__, "series": []}
    for key, series in pairs_by_key.items():
        station, system, sv = key
        if system not in C.DEFAULT_PAIR:
            continue
        s1, s2 = C.DEFAULT_PAIR[system]
        flags = flag_epochs(series, system, s1, s2, sign, qc)
        slips, diag = detect_slips(series, system, s1, s2, sign, qc)
        n_arc = segment_arcs(series, slips, qc.gap_threshold_s)
        report["series"].append({
            "station": station, "system": system, "sv": sv,
            "n_epochs": len(series), "n_arcs": n_arc,
            "flags": flags, "slips": diag,
        })
    return report


# ============================================================================
# 相位定平可用性守卫（2026-10-02 抽出，供 run.py 与 harness/batch.py 共用）
# ============================================================================
#
# ## 为什么要抽成共享函数
#
# 原先这套判据只写在 run.py 的分析流程里，而 harness/batch.py 的 worker
# **自己**跑反演、自己算基准、自己写 payload，从不调用 run.py，
# 于是守卫在批量模式下**完全没生效**：实测 MTKA 的 10 天全部以 status=ok
# 进入汇总表，其中 8 天 RMSE 在 43~126922 TECU 之间。
# 守卫写在一条路径上、另一条路径绕过 —— 这类分歧是必然的，
# 因此判据必须是**一个可import 的纯函数**，由两条路径共同调用。

#: 依赖相位连续性的算法（其余算法不看弧段）
PHASE_DEPENDENT_ALGOS = ("phase_leveled", "ppp_tec", "hatch_code", "iono_free")

#: 实测标定（当前代码，200 历元批次，见 docs/16）——
#:   MTKA（坏，RMSE 43.1~126922.1）  弧段/序列比 8.6 ~ 20.5
#:   USUD（正常，RMSE 11.2）         13.4 ~ 13.6
#:   CKSV 8.8 / BADG 5.0 / POL2 3.8 / HYDE 1.3 / SMST 1.1
#: 故门限取 15：拦下 MTKA 多数日，不误伤 USUD。
DEFAULT_ARC_RATIO_GUARD = 15.0

#: 短弧丢弃率**无区分力**（MTKA 5.6%~12.6% 与输出正常的 USUD 7.5% 重叠），
#: 默认关闭；仅保留为可复算的诊断量。详见 docs/16 第 3 节。
DEFAULT_SHORT_ARC_GUARD = 0.0


def phase_continuity_verdict(algorithm, n_arcs, n_series,
                             rejected_short_arcs=0, n_rows=0,
                             arc_ratio_guard=DEFAULT_ARC_RATIO_GUARD,
                             short_arc_guard=DEFAULT_SHORT_ARC_GUARD):
    """判断某个算法的相位定平输出是否可用。**纯函数，无副作用。**

    返回 dict::

        {
          "applicable": bool,   # 该算法是否受守卫约束
          "n_arcs": int, "n_series": int,
          "arc_ratio": float|None,
          "short_arc_rate": float|None,
          "rejected": bool,      # True = 不可作为有效输出
          "reason": str,         # 触发的判据与实测值（人可读）
          "criterion": str|None, # 触发的判据名（机器可读）
        }

    ## 判据的实测依据与已知局限

    唯一的拒绝判据是**弧段数 / 卫星序列数**。它与输出质量不严格一一对应：
    USUD 比值 13.6 却输出正常（假阳），MTKA 比值 8.6 放行但 RMSE 43.1（假阴），
    10 天里拦下 5 天。标定样本是 200 历元（约占单日1/7）的批次，
    全历元下的分布未单独标定。

    试过并**否决**的三条替代判据（不要重走）：

    1. 定平偏移量级 —— 实测 275 个卫星序列 max|偏移| 在 0.6~719.4 TECU，
       MTKA 为 343.6，与健康站（HKWS 195.8、CKSV 719.4）同量级。
    2. 短弧丢弃率 —— 与输出正常的 USUD 分布重叠，见 DEFAULT_SHORT_ARC_GUARD。
    3. 反演 RMSE / 基准互校 RMSE —— 门限取 2.0 会误杀 HYDE/IRKJ/POL2/
       SMST/USUD 五个可用站；而 MTKA 因无 SEPC 覆盖根本不进该样本。

    守卫是**内部代理**，不是判决。对无外部参考覆盖的站（如 MTKA 的 5 天）
    它是唯一防线，这也是门限必须保守的原因。
    """
    ratio = (float(n_arcs) / float(n_series)) if n_series else None
    short_rate = None
    if n_rows:
        short_rate = (float(rejected_short_arcs) / float(n_rows)
                      if n_rows else None)

    out = {
        "applicable": algorithm in PHASE_DEPENDENT_ALGOS,
        "n_arcs": int(n_arcs or 0),
        "n_series": int(n_series or 0),
        "arc_ratio": ratio,
        "short_arc_rate": short_rate,
        "rejected": False,
        "reason": "",
        "criterion": None,
    }
    if not out["applicable"] or not n_series:
        return out

    # 短弧率判据默认关闭（实测无区分力）；保留以便复现那次实验。
    if (short_arc_guard > 0 and short_rate is not None
            and short_rate > short_arc_guard):
        out.update(rejected=True, criterion="short_arc_rate",
                   reason=("短弧丢弃率 %.1f%% > 门限 %.0f%%（%d/%d 段"
                           "长度不足以定平）"
                           % (short_rate * 100.0, short_arc_guard * 100.0,
                              rejected_short_arcs, n_rows)))
        return out
    if arc_ratio_guard > 0 and ratio is not None and ratio > arc_ratio_guard:
        out.update(rejected=True, criterion="arc_ratio",
                   reason="弧段/序列比 %.1f > 门限 %g" % (ratio, arc_ratio_guard))
    return out


# ============================================================================
# 输出物理量级守卫（2026-10-02）
# ============================================================================
#
# ## 为什么这条比弧段比更有原则
#
# 弧段/序列比是**内部代理**：它与输出质量不严格一一对应，既有假阳
# （USUD 13.6 却输出正常）也有假阴（MTKA 8.6 放行但 RMSE 43.1）。
#
# 而"垂直总电子含量不可能达到某个量级"是**物理边界**，不是代理。
# 实测中MTKA 的 DOY006 在弧段比 12.33（低于门限 15）的情况下给出
# RMSE **126922.1 TECU** —— 这不是"精度差"，而是**非物理值**：
# 电离层壳层（450 km 高）的垂TEC 实测量级为个位到 200 TECU，
# 12.7 万 TECU 在物理上不可能出现。
#
# 这条判据因此是**硬边界**：低于它就一定不是有效反演，
# 不存在"好数据被误杀"的风险，只要门限取得足够宽松。

#: 垂 TEC 的物理上限。取 500 TECU —— 约为实测健康台站最大值
#: （SMST 33.7、USUD 16.5、HYDE 25.4）的 10 倍以上，
#: 因此对任何真实数据都不构成误杀，同时能拦下 MTKA 的 43~126922。
DEFAULT_RMSE_CAP_TECU = 500.0


def physical_rmse_verdict(rmse, cap_tecu=DEFAULT_RMSE_CAP_TECU):
    """判断某个反演相对参考解的均方根误差是否**非物理**。

    这是一条**物理边界**守卫，与 `phase_continuity_verdict`（内部代理）
    性质不同：它只在误差**大到不可能是 TEC** 时触发。

    参数
    ----
    rmse
        反演相对参考解的 RMSE，单位 TECU。None / NaN / 非有限值一律放行
        —— 没有可比数字时不能据此下结论。
    cap_tecu
        上限，默认 500 TECU。

    返回 dict::

        {"applicable": bool, "rmse": float|None, "cap_tecu": float,
         "rejected": bool, "reason": str, "criterion": str|None}
    """
    import math as _m
    out = {"applicable": False, "rmse": None, "cap_tecu": float(cap_tecu),
           "rejected": False, "reason": "", "criterion": None}
    if rmse is None:
        return out
    try:
        v = float(rmse)
    except (TypeError, ValueError):
        return out
    if not _m.isfinite(v):
        # NaN / inf 本身就不该进入统计表，但这里不据此拒绝输出
        # —— 由调用方决定如何处理无效数字。
        return out
    out["rmse"] = v
    if cap_tecu <= 0:
        return out
    out["applicable"] = True
    if v > cap_tecu:
        out.update(rejected=True, criterion="nonphysical_rmse",
                   reason="RMSE %.1f TECU 超过物理上限 %.0f TECU（非物理值）"
                          % (v, cap_tecu))
    return out


# ============================================================================
# 几何无关码**符号**守卫（2026-10-02，KAZA 归因）
# ============================================================================
#
# ## 物理依据（不是代理判据）
#
# 等离子体的**群折射率 n > 1**，所以电离层对**群延迟**只做**正**延迟，
# 且延迟 ~ 1/f^2。于是 L2 频点的码必然比 L1 频点的码**更长**：
#
#     P_L2 - P_L1 = 0.105 * TEC_slant(TECU) - DCB_receiver   [m]
#
# 接收机的 L1/L2 差分码偏差 (DCB) 本项目**不建模**（--dcb 默认 none，
# 见 run.py；docs/17 已记录施加卫星端 DCB 反而更差）。因此在 DCB 未建模时
#
#     k_P * (P_L2 - P_L1) = TEC_slant - k_P * DCB
#
# 的中位数**必须为正** —— 否则说明这个组合里已经没有电离层信号，
# 整个反演读到的是接收机码偏差而不是电离层。
#
# ## 触发实例：KAZA（2026-10-02）
#
# KAZA 的 `# / TYPES OF OBSERV` 是 `L1 L2 C1 P2 P1 S1 S2`，**没有 C2**，
# 于是 L2 的码只能取 P2（老式 L2 P 码）。该站 TRIMBLE NETRS 的
# C1C-P2 差分码偏差实测 **+5.30 ~ +10.53 m（+17.7 ~ +35.1 ns，31/31 颗
# 全为正）**，比电离层延迟差（0.105*TEC_slant，实测 1~4 m）大 2~5 倍，
# 于是几何无关码组合整体**反号**：9 天全部 31~32 条序列的中位码电平都是
# 负的（−15.9 ~ −80.2 TECU），每文件中位 −47.4 ~ −54.9 TECU。
# 结果：六个算法**全部**给出负 TEC（实测 vs SEPC vTEC 均值 −39 ~ −44 TECU，
# bias −46.6 ~ −55.6、RMSE 48.8 ~ 57.5、r +0.16 ~ +0.30）——
# `code_only` 与 `phase_leveled` 逐项几乎相同，因为绝对电平均由码决定。
#
# ## 门限标定（实测 147 文件，2026-10-02）
#
#   门限 -25 TECU 时（实测 147 文件）：
#     命中 KAZA 9/9 天（每文件中位 -47.4 ~ -54.9，31~32/32 条序列全负）
#     **全 147 个文件里只命中 KAZA 这一个站**，其余 12 站 138 个站-天全部放行，
#       最小值 USUD +4.51 TECU、BADG -8.95（BADG 是 JPS2RIN 20 观测码、
#       记录丢弃率 91% 的已知噪声问题，该站本就因精度 r +0.11 不计统计）
#
#   余量：健康站最小 +4.51，门限 -25 => 5.5 倍余量；
#         KAZA 最大 -47.4，门限 -25 => 1.9 倍余量。
#
# ## 与 `physical_rmse_verdict` 的分工
#
# 那条判的是**上界**（误差大到不可能），这条判的是**符号**
# （组合里根本没有电离层信号）。两者互补，都不需要外部基准。
DEFAULT_NEG_CODE_FLOOR_TECU = -25.0


def code_ionosphere_sign_verdict(median_code_tecu,
                                 floor_tecu=DEFAULT_NEG_CODE_FLOOR_TECU):
    """判断几何无关码组合的中位电平是否已**反号**（物理上不可能）。

    参数
    ----
    median_code_tecu
        `run_inversion` 统计里的 `median_series_code_TECU`（TECU）：
        各卫星序列码中位电平 `k_P*(P_L2-P_L1)` 的中位数。
        None / NaN / 非有限值一律放行 —— 没有可比数字时不能据此下结论。
    floor_tecu
        下限，默认 −25 TECU。传 0（�� >=0）可关闭。

    返回 dict::

        {"applicable": bool, "median_code_tecu": float|None,
         "floor_tecu": float, "rejected": bool, "reason": str,
         "criterion": str|None}

    **对全部六个算法都适用**（与相位连续性无关）：绝对电平一律由码决定 ——
    `code_only` 直接用；`phase_leveled` / `ppp_tec` / `hatch_code` 以它为定平锚；
    `kalman` / `iono_free` 以它为初值。实测六者在 KAZA 上的输出逐项相同。
    """
    out = {"applicable": False, "median_code_tecu": None,
           "floor_tecu": float(floor_tecu), "rejected": False,
           "reason": "", "criterion": None}
    if median_code_tecu is None:
        return out
    try:
        v = float(median_code_tecu)
    except (TypeError, ValueError):
        return out
    if not math.isfinite(v):
        return out
    out["median_code_tecu"] = v
    if floor_tecu >= 0:
        return out
    out["applicable"] = True
    if v < floor_tecu:
        out.update(
            rejected=True, criterion="negative_code_tecu",
            reason=("几何无关码中位电平 %.2f TECU < 门限 %.0f TECU："
                    "组合已反号，读到的是接收机 L1/L2 差分码偏差而非电离层"
                    "（DCB 未建模时 sTEC 恒为正）"
                    % (v, floor_tecu)))
    return out
