/**
 * Number / time formatting for the Graph export layer.
 *
 * Every format below is read off the shipped golden exports
 * (`00_来源/samples/graph/export/`, produced by Graph 2.11.0's native `ExportCSV` / `ExportKML`),
 * not guessed:
 *
 *  - GPS timestamps: `2442  463097.350` in CSV data rows (week, **two** spaces, seconds with
 *    exactly three decimals) and `2442,463097.350` in the CSV comments / KML balloons.
 *  - Durations: `HH:MM:SS` truncated to whole seconds (`4950 ms` → `00:00:04`).
 *  - Position coordinates and standard deviations: six decimals, **trailing zeros trimmed**
 *    (`1.19761` for 1.1976104974…, `30.539975`). Confirmed by `Position SD.csv` row
 *    `2442  463098.000` whose longitude SD is the only value in the file whose 6-decimal
 *    rendering ends in `0`, and it is printed without it.
 *  - Heights in the KML balloon / coordinates: three decimals, **not** trimmed (`66.430`).
 *
 * The GPS epoch used by Graph is `week * 604800000 + msOfWeek` (no 18 s / no 315 964 800 000
 * offset) — i.e. `DataInfo.StartTime = 1477384697350` *is* `2442,463097.350`.
 */

export const MS_PER_WEEK = 604_800_000;

/** `week * 604800000 + msOfWeek` — Graph's own millisecond scale (the one stored in `.gpf`). */
export function gpsWeekSeconds(gpsMs: number): { week: number; seconds: number } {
  const week = Math.floor(gpsMs / MS_PER_WEEK);
  return { week, seconds: (gpsMs - week * MS_PER_WEEK) / 1000 };
}

/** `2442,463097.350` — CSV comment lines and KML balloon text. */
export function formatGpsCommentTime(gpsMs: number): string {
  const { week, seconds } = gpsWeekSeconds(gpsMs);
  return `${week},${seconds.toFixed(3)}`;
}

/** `2442  463097.350` — the CSV `timestamp (GPS week sec)` column. */
export function formatGpsColumn(gpsMs: number): string {
  const { week, seconds } = gpsWeekSeconds(gpsMs);
  return `${week}  ${seconds.toFixed(3)}`;
}

/** `00:00:04`; `2 Days 03:04:05` past one day (singular `Day`). */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hh = Math.floor((total % 86400) / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  if (days === 0) return clock;
  return `${days} ${days === 1 ? 'Day' : 'Days'} ${clock}`;
}

/** Six decimals with trailing zeros (and a trailing `.`) removed. */
export function formatTrimmed(value: number, decimals = 6): string {
  let text = value.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text;
}

/** Six decimals, always padded. */
export function formatFixed(value: number, decimals = 6): string {
  return value.toFixed(decimals);
}

/**
 * BMI `solution_status` → the name Graph writes into `Position Status.csv`
 * (`01_解包/app/model/NovatelIdConstants.js` → `solutionStatus`).
 */
export const SOLUTION_STATUS: Record<number, string> = {
  0: 'SOL_COMPUTED',
  1: 'INSUFFICIENT_OBS',
  2: 'NO_CONVERGENCE',
  3: 'SINGULARITY',
  4: 'COV_TRACE',
  5: 'TEST_DIST',
  6: 'COLD_START',
  7: 'V_H_LIMIT',
  8: 'VARIANCE',
  9: 'RESIDUALS',
  13: 'INTEGRITY_WARNING',
  18: 'PENDING',
  19: 'INVALID_FIX',
  20: 'UNAUTHORIZED',
  22: 'INVALID_RATE',
};

/**
 * `position_type` → `Position Type.csv` cell and the KML folder / style id.
 * Source: `NovatelIdConstants.js` → `positionType`.
 */
export const POSITION_TYPE: Record<number, string> = {
  0: 'NONE',
  1: 'FIXEDPOS',
  2: 'FIXEDHEIGHT',
  4: 'FLOATCONV',
  5: 'WIDELANE',
  6: 'NARROWLANE',
  8: 'DOPPLER_VELOCITY',
  16: 'SINGLE',
  17: 'PSRDIFF',
  18: 'WAAS',
  19: 'PROPAGATED',
  20: 'OMNISTAR',
  32: 'L1_FLOAT',
  33: 'IONOFREE_FLOAT',
  34: 'NARROW_FLOAT',
  48: 'L1_INT',
  49: 'WIDE_INT',
  50: 'NARROW_INT',
  51: 'RTK_DIRECT_INS',
  52: 'INS_SBAS',
  53: 'INS_PSRSP',
  54: 'INS_PSRDIFF',
  55: 'INS_RTKFLOAT',
  56: 'INS_RTKFIXED',
  68: 'PPP_CONVERGING',
  69: 'PPP',
  70: 'OPERATIONAL',
  71: 'WARNING',
  72: 'OUT_OF_BOUNDS',
  73: 'INS_PPP_CONVERGING',
  74: 'INS_PPP',
  77: 'PPP_BASIC_CONVERGING',
  78: 'PPP_BASIC',
  79: 'INS_PPP_BASIC_CONVERGING',
  80: 'INS_PPP_BASIC',
};
