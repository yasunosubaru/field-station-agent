"""合成数据生成器：正演伪距/相位，可注入噪声、周跳、缺测、粗差。

重要声明：合成数据仅用于验证“流程与代码自洽性”，**不是真实观测，
不得作为实验结论**。所有输出文件与返回值都带 SYNTHETIC 标记。

正演模型（与 T4/inversion 的符号约定一致）：
  STEC_SI = sTEC_true * 1e16
  P_i = R + K * STEC_SI / f_i^2 + eps_P          （码被电离层延迟，取正）
  L_i = R - K * STEC_SI / f_i^2 + lambda_i * N_i  （相位被电离层超前，取负）
  q_i = meas_cycle_sign(adr_sign) * L_i / lambda_i  （写进 adr_cycles 列）

本模块只用标准库。
"""
from __future__ import annotations

import csv
import math
import random
from dataclasses import dataclass
from pathlib import Path

from . import constants as C
from .model import Observation, epoch_utc_str, gps_to_utc, GPS_WEEK_S

SYNTHETIC_MARKER = "合成数据，非真实观测，不得作为实验结论"
SYNTHETIC_TAG = "SYNTHETIC"


# ---------------------------------------------------------------- 真值结构
@dataclass
class Truth:
    station: str
    system: str
    sv: int
    gps_week: int
    gps_tow_s: float
    stec_true_TECU: float
    elev_deg: float
    azim_deg: float


DEFAULT_SYNTH_CFG = {
    "seed": 42,
    "n_epochs": 600,
    "dt_s": 1.0,
    "start_week": 2300,
    "start_tow_s": 0.0,
    "station": "SYNTH",
    "receiver_id": "SIM001",
    "systems": ["GPS", "BDS"],
    "sats": {"GPS": [1, 2], "BDS": [3]},
    "stec_base_tecu": 15.0,
    "stec_amp_tecu": 10.0,
    "stec_period_s": 43200.0,
    "sigma_psr_m": 0.3,
    "sigma_phase_cyc": 0.01,
    "sigma_cn0_db": 0.5,
    "elev_start_deg": 25.0,
    "elev_end_deg": 75.0,
    "azim_deg": 135.0,
    "range_start_m": 22000000.0,
    "range_rate_mps": -150.0,
    "cn0_base_dbhz": 45.0,
    "ambig_cycles": 1.0e6,
    "adr_sign": "adr",
    "slips": [],
    "gaps": [],
    "outliers": [],
}


# ---------------------------------------------------------------- M0 评测 fixture
#: M0 评测 fixture 的固定种子（= 本项目 M0 的批次日期 2026-10-13）。
#:
#: **评测 fixture 必须由种子决定，否则回放基线不成立**：基线一旦发布，别人拿着
#: 同一份 cfg 就必须能逐字节重建出同一份合成观测；种子一变，历史基线的数字
#: 无从对照，回归测试也就失去了参照物。
FIXTURE_SEED = 20261013

#: 默认注入的已知异常。信号名取 `constants.DEFAULT_PAIR["GPS"]` 的第一个（L1）。
#:
#: 注入语义按源实现如实记录：`generate()` 只在 `index == i` 的**那一个**历元上
#: 加 jump_cycles，其后的历元不跟随 —— 即**单历元相位扰动**，不是持续跳变。
#: 不要把它当成真实观测里的周跳建模来用。
DEFAULT_SLIP = {"system": "GPS", "sv": 1, "signal": "L1",
                "index": 400, "jump_cycles": 1.0}


def default_cfg(**overrides) -> dict:
    """M0 评测 fixture 的默认合成配置（**本项目新增，源项目没有此函数**）。

    以 `DEFAULT_SYNTH_CFG` 为唯一底稿，只改两处：种子钉成 `FIXTURE_SEED`、
    默认注入一个已知异常（M0 尚无真实数据，评测集必须自带可判分的异常）。
    其余参数沿用源文件的默认值，不另立一套口径。

    **不照抄任务书 Step 3 给的字典体**：那批键在 `generate()` 里全是死键。实测
    （2026-10-13，只读导入源项目后跑 generate）：
      `elev_cutoff_deg` 取 0.0 / 90.0，`inject_slip_at`/`inject_gap_at`/
      `inject_psr_outlier_at`/`inject_adr_outlier_at`/`noise_psr_m`/
      `noise_adr_cycles` 全取 99.0，三种取值的观测条数（3600）与逐行 SHA256
      （6304a6d235ede6a26eab291f909d21f7bd766776354242065c5cb74499fcc1a5）完全相同
      —— 这些键根本不参与正演。照抄等于凭空多出一个配置入口，外加一串不生效的键，
      后人改它们会以为改了 fixture，其实什么都没变。
    """
    cfg = dict(DEFAULT_SYNTH_CFG)
    cfg["seed"] = FIXTURE_SEED
    cfg["slips"] = [dict(DEFAULT_SLIP)]
    cfg.update(overrides)
    return cfg


def _stec_true_tecu(t: float, cfg: dict, sv: int) -> float:
    period = float(cfg["stec_period_s"]) or 1.0
    phase = 2.0 * math.pi * sv / 7.0
    base = float(cfg["stec_base_tecu"])
    amp = float(cfg["stec_amp_tecu"])
    return base + amp * math.sin(2.0 * math.pi * t / period + phase)


def _ambig(cfg: dict, system: str, signal: str, sv: int) -> float:
    base = float(cfg.get("ambig_cycles", 1.0e6))
    return base + 1000.0 * sv + (17.0 if signal.endswith("2") or signal == "L2" else 0.0)


def generate(cfg: dict | None = None) -> tuple[list[Observation], list[Truth], dict]:
    """返回 (观测列表, 真值列表, 生效配置)。"""
    merged = dict(DEFAULT_SYNTH_CFG)
    if cfg:
        merged.update(cfg)
    rnd = random.Random(int(merged["seed"]))
    adr_sign = str(merged["adr_sign"])
    sign = C.meas_cycle_sign(adr_sign)
    n = int(merged["n_epochs"])
    dt = float(merged["dt_s"])
    week = int(merged["start_week"])
    tow0 = float(merged["start_tow_s"])
    sigma_p = float(merged["sigma_psr_m"])
    sigma_ph = float(merged["sigma_phase_cyc"])
    sigma_cn0 = float(merged["sigma_cn0_db"])

    # 注入索引表：key=(system,sv) -> dict
    slips: dict[tuple, list[dict]] = {}
    for s in merged.get("slips", []) or []:
        slips.setdefault((s["system"], s["sv"]), []).append(s)
    gaps: dict[tuple, list[dict]] = {}
    for g in merged.get("gaps", []) or []:
        gaps.setdefault((g["system"], g["sv"]), []).append(g)
    outliers: dict[tuple, list[dict]] = {}
    for o in merged.get("outliers", []) or []:
        outliers.setdefault((o["system"], o["sv"]), []).append(o)

    obs: list[Observation] = []
    truth: list[Truth] = []
    for system in merged["systems"]:
        s1, s2 = C.DEFAULT_PAIR[system]
        f1 = C.get_freq(system, s1)
        f2 = C.get_freq(system, s2)
        lam1 = C.WAVELENGTH_M[(system, s1)]
        lam2 = C.WAVELENGTH_M[(system, s2)]
        n1 = _ambig(merged, system, s1, 0)
        n2 = _ambig(merged, system, s2, 0)
        for sv in merged["sats"].get(system, []):
            key = (system, sv)
            skip = set()
            for g in gaps.get(key, []):
                skip.update(range(int(g["start"]), int(g["end"])))
            for i in range(n):
                if i in skip:
                    continue
                t = i * dt
                stec = _stec_true_tecu(t, merged, sv)
                stec_si = stec * C.TECU
                elev = float(merged["elev_start_deg"]) + (
                    float(merged["elev_end_deg"]) - float(merged["elev_start_deg"])
                ) * (i / max(1, n - 1))
                azim = float(merged["azim_deg"])
                rng = float(merged["range_start_m"]) + float(merged["range_rate_mps"]) * t
                p1 = rng + C.K * stec_si / (f1 * f1) + rnd.gauss(0.0, sigma_p)
                p2 = rng + C.K * stec_si / (f2 * f2) + rnd.gauss(0.0, sigma_p)
                l1 = rng - C.K * stec_si / (f1 * f1) + lam1 * n1
                l2 = rng - C.K * stec_si / (f2 * f2) + lam2 * n2
                q1 = sign * l1 / lam1 + rnd.gauss(0.0, sigma_ph)
                q2 = sign * l2 / lam2 + rnd.gauss(0.0, sigma_ph)
                # 周跳注入
                for s in slips.get(key, []):
                    if int(s["index"]) == i:
                        if s.get("signal") == s1:
                            q1 += float(s.get("jump_cycles", 1.0))
                        elif s.get("signal") == s2:
                            q2 += float(s.get("jump_cycles", 1.0))
                # 粗差注入
                for o in outliers.get(key, []):
                    if int(o["index"]) == i:
                        d = float(o.get("delta_m", 0.0))
                        if o.get("signal") == s1:
                            p1 += d
                        elif o.get("signal") == s2:
                            p2 += d
                tow = (tow0 + t) % GPS_WEEK_S
                wk = week + int((tow0 + t) // GPS_WEEK_S)
                utc = epoch_utc_str(gps_to_utc(wk, tow))
                cn0 = float(merged["cn0_base_dbhz"]) + rnd.gauss(0.0, sigma_cn0)
                for sig, f, p, q in ((s1, f1, p1, q1), (s2, f2, p2, q2)):
                    obs.append(
                        Observation(
                            station=str(merged["station"]),
                            receiver_id=str(merged["receiver_id"]),
                            gps_week=wk,
                            gps_tow_s=tow,
                            system=system,
                            sv=int(sv),
                            signal=sig,
                            freq_hz=f,
                            psr_m=p,
                            adr_cycles=q,
                            doppler_hz=-float(merged["range_rate_mps"]) / (C.C_LIGHT / f),
                            cn0_dbhz=cn0,
                            elev_deg=elev,
                            azim_deg=azim,
                            epoch_utc=utc,
                        )
                    )
                truth.append(
                    Truth(
                        station=str(merged["station"]),
                        system=system,
                        sv=int(sv),
                        gps_week=wk,
                        gps_tow_s=tow,
                        stec_true_TECU=stec,
                        elev_deg=elev,
                        azim_deg=azim,
                    )
                )
    return obs, truth, merged


# ---------------------------------------------------------------- 落盘
def write_observations_csv(obs: list[Observation], path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = list(obs[0].to_row().keys()) if obs else []
    with path.open("w", newline="", encoding="utf-8") as fh:
        fh.write(f"# {SYNTHETIC_MARKER}\n")
        fh.write(f"# {SYNTHETIC_TAG}\n")
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        for ob in obs:
            writer.writerow(ob.to_row())
    return path


def write_truth_csv(truth: list[Truth], path: str | Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        fh.write(f"# {SYNTHETIC_MARKER}\n")
        fh.write(f"# {SYNTHETIC_TAG}\n")
        fields = ["station", "system", "sv", "gps_week", "gps_tow_s", "stec_true_TECU", "elev_deg", "azim_deg"]
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        for tr in truth:
            writer.writerow({
                "station": tr.station, "system": tr.system, "sv": tr.sv,
                "gps_week": tr.gps_week, "gps_tow_s": tr.gps_tow_s,
                "stec_true_TECU": tr.stec_true_TECU,
                "elev_deg": tr.elev_deg, "azim_deg": tr.azim_deg,
            })
    return path


def read_observations_csv(path: str | Path) -> list[Observation]:
    """读回合成/中间观测 CSV（跳过 '#' 标记行）。"""
    path = Path(path)
    out: list[Observation] = []
    with path.open("r", newline="", encoding="utf-8") as fh:
        lines = [ln for ln in fh if not ln.startswith("#")]
    import io
    reader = csv.DictReader(io.StringIO("".join(lines)))
    for row in reader:
        def num(k):
            v = row.get(k, "")
            return float(v) if v not in ("", None) else float("nan")
        def it(k):
            v = row.get(k, "")
            return int(float(v)) if v not in ("", None) else 0
        out.append(Observation(
            station=row["station"], receiver_id=row["receiver_id"],
            gps_week=it("gps_week"), gps_tow_s=num("gps_tow_s"),
            system=row["system"], sv=it("sv"), signal=row["signal"],
            freq_hz=num("freq_hz"), psr_m=num("psr_m"), adr_cycles=num("adr_cycles"),
            doppler_hz=num("doppler_hz"), cn0_dbhz=num("cn0_dbhz"),
            elev_deg=num("elev_deg"), azim_deg=num("azim_deg"),
            sys_code=it("sys_code"), sig_code=it("sig_code"), grouped=it("grouped"),
            quality_flag=it("quality_flag"), epoch_utc=row.get("epoch_utc", ""),
        ))
    return out
