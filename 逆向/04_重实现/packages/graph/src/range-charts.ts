/**
 * The three `RANGE`-fed charts: `Tracking Time`, `GNSS Signal Strength`, `Satellites and Signals`.
 *
 * Everything here is read off the shipped goldens (`00_来源/samples/graph/export/csv/`).
 *
 * ## Reading a RANGE record
 *
 * `RANGE` carries one `obs[]` entry per satellite-signal, and each entry's `c_status` holds the
 * satellite system and the signal type:
 *
 * ```
 * system = (c_status >> 16) & 7      // 0 GPS, 4 BEIDOU, 5 QZSS (only these three in the sample)
 * signal = (c_status >> 21) & 0x1f   // 5-bit "signal type", numbered **per system**
 * ```
 *
 * That split is verified empirically: the 60 `(system, signal)` pairs of the sample map onto the 60
 * golden columns one-to-one, with `C_No` / `lock_time` matching cell for cell. The names for the 12
 * distinct pairs come from the same match; the 5-bit numbering is *not* the 72-name flat enum in
 * `graph-node-wrapper.node` (there GPS signal 9 is `L2_CM` while the receiver reports `L2_PY`).
 *
 * ## Column order
 *
 * - **Per-satellite columns** (all three charts): `(system asc, PRN asc, flat-enum rank asc)`. The
 *   rank is the signal's position in the 72-name enum extracted from `graph-node-wrapper.node`
 *   (`GPS_L1_CA` 0 … `GPS_L1_CP` 2 … `GPS_L2_PY` 8 … `GPS_L2_CM` 9), which reproduces the golden
 *   order in every PRN group. `GPS_L5_Q` has no literal in that enum; it sorts after the L2 signals,
 *   which is where the golden puts it.
 * - **`_Mean` and `Signals_*` groups**: order is **not derived** — it is the observed order of the
 *   golden, stored as data (`MEAN_ORDER` / `SIGNALS_ORDER`). It is grouped by constellation but
 *   inside a constellation it is neither enum order, PRN order, first-appearance order nor any
 *   `std::unordered_map` model that was tested (FNV-1a / libstdc++ hashing, bucket counts 2..97,
 *   both bucket-iteration conventions); see `03_分析/06_Graph应用.md §11.6`. A signal that is not in
 *   these tables is appended in enum-rank order.
 * - **One export may override the `_Mean` order explicitly.** Because the sample proves the order
 *   is *not* a function of the capture (`clean` `0 9 17 16 14` vs `broad` `0 17 16 9 14` on
 *   structurally identical input — `03_分析/13_Graph分析页.md §8.2.4`), a `GraphProject` may carry
 *   `meanOrder` (`system * 32 + signal` ids, in observed order). When present those groups come
 *   first in exactly that order and every other group keeps the built-in order behind them; when
 *   absent nothing changes. This records *one export's observation*, it is not a general rule.
 */

import type { Capture, CaptureRecord } from './capture.ts';
import { field } from './capture.ts';
import type { GraphProject } from './project.ts';
import type { CsvColumn } from './csv.ts';
import { formatGpsColumn } from './format.ts';

/**
 * `(system, 5-bit signal type)` → column name and flat-enum rank.
 *
 * The 12 pairs the golden happens to contain were matched empirically (§11.3). The rest come from
 * OEM7 *Commands and Logs Reference Manual* Table 182 ("Channel tracking status", bits 21-25), whose
 * per-system numbering matches those 12 exactly — e.g. GPS 0 = L1 C/A, 16 = L1C (P), 9 = L2P (Y),
 * 17 = L2C (M), 14 = L5 (Q); BeiDou 4 = B1 (I) D2; QZSS 16 = L1C (P). The rank is the position in
 * the 72-name signal enum extracted from `graph-node-wrapper.node` (GPS_L1_CA 0 … QZSS_L1_CD 46 …
 * B3I_D2 44), so a constellation's columns keep the original's order.
 *
 * Without the manual's pairs a **real** receiver capture cannot be exported at all: `b1-20261101.sbf`
 * tracks QZSS L1C/B (5/24), BeiDou B2a (4/9) and B2b (4/11), and the first export threw
 * `unknown RANGE signal system=5 signal=24`.
 */
export const RANGE_SIGNALS: Record<number, Record<number, { name: string; rank: number }>> = {
  // system 0 — GPS (0 L1C/A, 5 L2P, 9 L2P(Y), 14 L5(Q), 16 L1C(P), 17 L2C(M))
  0: {
    0: { name: 'GPS_L1_CA', rank: 0 },
    5: { name: 'GPS_L2_P', rank: 7 },
    16: { name: 'GPS_L1_CP', rank: 2 },
    9: { name: 'GPS_L2_PY', rank: 8 },
    17: { name: 'GPS_L2_CM', rank: 9 },
    14: { name: 'GPS_L5_Q', rank: 12 },
  },
  // system 1 — GLONASS (0 L1C/A, 1 L2C/A, 5 L2P, 6 L3(Q))
  1: {
    0: { name: 'GLONASS_L1_CA', rank: 12 },
    1: { name: 'GLONASS_L2_CA', rank: 14 },
    5: { name: 'GLONASS_L2_P', rank: 15 },
    6: { name: 'GLONASS_L3_Q', rank: 16 },
  },
  // system 2 — SBAS (0 L1C/A, 6 L5(I))
  2: {
    0: { name: 'SBAS_L1_CA', rank: 58 },
    6: { name: 'SBAS_L5_I', rank: 59 },
  },
  // system 3 — Galileo (2 E1(C), 6 E6B, 7 E6C, 12 E5a(Q), 17 E5b(Q), 20 E5AltBOC(Q))
  3: {
    2: { name: 'GALILEO_E1_C', rank: 18 },
    6: { name: 'GALILEO_E6_B', rank: 30 },
    7: { name: 'GALILEO_E6_C', rank: 29 },
    12: { name: 'GALILEO_E5A_Q', rank: 21 },
    17: { name: 'GALILEO_E5B_Q', rank: 24 },
    20: { name: 'GALILEO_E5ALTBOC_Q', rank: 27 },
  },
  // system 4 — BEIDOU (0/4 B1I, 1/5 B2I, 2/6 B3I, 7 B1C(P), 9 B2a(P), 11 B2b(I))
  4: {
    0: { name: 'BEIDOU_B1I_D1', rank: 32 },
    4: { name: 'BEIDOU_B1I_D2', rank: 33 },
    7: { name: 'BEIDOU_B1C_P', rank: 34 },
    9: { name: 'BEIDOU_B2A_P', rank: 37 },
    1: { name: 'BEIDOU_B2I_D1', rank: 40 },
    5: { name: 'BEIDOU_B2I_D2', rank: 41 },
    11: { name: 'BEIDOU_B2B_I', rank: 42 },
    2: { name: 'BEIDOU_B3I_D1', rank: 43 },
    6: { name: 'BEIDOU_B3I_D2', rank: 44 },
  },
  // system 5 — QZSS (0 L1C/A, 14 L5(Q), 16 L1C(P), 17 L2C(M), 24 L1C/B, 27 L6P, 28 L6D)
  5: {
    0: { name: 'QZSS_L1_CA', rank: 45 },
    24: { name: 'QZSS_L1_CD', rank: 46 },
    16: { name: 'QZSS_L1_CP', rank: 47 },
    17: { name: 'QZSS_L2_CM', rank: 49 },
    14: { name: 'QZSS_L5_Q', rank: 53 },
    27: { name: 'QZSS_L6_P', rank: 55 },
    28: { name: 'QZSS_L6_D', rank: 56 },
  },
  // system 6 — NavIC (0 L5 SPS)
  6: {
    0: { name: 'NAVIC_L5_SPS', rank: 64 },
  },
  // system 7 — Other (19 L-band)
  7: {
    19: { name: 'LBAND_LBAND', rank: 80 },
  },
};

/** Constellation display name per system id (the prefix the goldens use). */
const SYSTEM_NAME: Record<number, string> = { 0: 'GPS', 1: 'GLONASS', 2: 'SBAS', 3: 'GALILEO', 4: 'BEIDOU', 5: 'QZSS', 6: 'NAVIC', 7: 'OTHER' };

/** Observed `_Mean` column order inside each constellation (see the module comment). */
const MEAN_ORDER: Record<string, string[]> = {
  GPS: ['GPS_L1_CA', 'GPS_L2_PY', 'GPS_L2_CM', 'GPS_L1_CP', 'GPS_L5_Q'],
  BEIDOU: ['BEIDOU_B2I_D1', 'BEIDOU_B1I_D2', 'BEIDOU_B3I_D2', 'BEIDOU_B1I_D1', 'BEIDOU_B3I_D1'],
  QZSS: ['QZSS_L1_CA', 'QZSS_L2_CM', 'QZSS_L1_CP', 'QZSS_L5_Q'],
};

/** Observed `Signals_*` column order inside each constellation (different from `MEAN_ORDER`). */
const SIGNALS_ORDER: Record<string, string[]> = {
  GPS: ['GPS_L2_PY', 'GPS_L1_CA', 'GPS_L1_CP', 'GPS_L2_CM', 'GPS_L5_Q'],
  BEIDOU: ['BEIDOU_B1I_D2', 'BEIDOU_B3I_D2', 'BEIDOU_B2I_D1', 'BEIDOU_B1I_D1', 'BEIDOU_B3I_D1'],
  QZSS: ['QZSS_L5_Q', 'QZSS_L1_CA', 'QZSS_L1_CP', 'QZSS_L2_CM'],
};

interface Obs {
  system: number;
  signal: number;
  prn: number;
  cno: number;
  lockTime: number;
}

function obsOf(record: CaptureRecord): Obs[] {
  const count = field(record, 'obs.count');
  const list: Obs[] = [];
  for (let i = 0; i < count; i++) {
    const cStatus = field(record, `obs[${i}].c_status`);
    const system = (cStatus >> 16) & 7;
    list.push({
      system,
      signal: (cStatus >> 21) & 0x1f,
      prn: field(record, `obs[${i}].sv_prn`),
      cno: field(record, `obs[${i}].C_No`),
      lockTime: field(record, `obs[${i}].lock_time`),
    });
  }
  return list;
}

/**
 * Signal name/rank for one observation.
 *
 * A pair the tables do not know (a firmware older/newer than Table 182, or a system-7 "Other"
 * signal) is **not** fatal any more: it degrades to `<SYSTEM>_S<type>` ranked last, which the module
 * comment above already describes as the fallback ordering. Throwing here meant one unknown signal
 * aborted the export of every RANGE-fed chart.
 */
function signalInfo(obs: Obs): { name: string; rank: number } {
  const table = RANGE_SIGNALS[obs.system];
  const info = table?.[obs.signal];
  if (info) return info;
  return { name: `${SYSTEM_NAME[obs.system] ?? `SYS${obs.system}`}_S${obs.signal}`, rank: 900 + obs.signal };
}

/** RANGE records inside the project window, in log order. */
function rangeRecords(project: GraphProject, capture: Capture): CaptureRecord[] {
  const { StartTime, EndTime } = project.dataInfo;
  return capture.byName('RANGE').filter((record) => record.gpsMs >= StartTime && record.gpsMs < EndTime);
}

interface SatelliteColumn {
  key: string;
  system: number;
  prn: number;
  name: string;
  rank: number;
}

/** The per-satellite columns of the window, in `(system, PRN, rank)` order. */
export function satelliteColumns(project: GraphProject, capture: Capture): SatelliteColumn[] {
  const seen = new Map<string, SatelliteColumn>();
  for (const record of rangeRecords(project, capture)) {
    for (const obs of obsOf(record)) {
      const info = signalInfo(obs);
      const key = `${obs.system}:${obs.signal}:${obs.prn}`;
      if (!seen.has(key)) seen.set(key, { key, system: obs.system, prn: obs.prn, name: info.name, rank: info.rank });
    }
  }
  return [...seen.values()].sort((a, b) => a.system - b.system || a.prn - b.prn || a.rank - b.rank);
}

/** `(system, signal)` groups present in the window, in the given observed order. */
function signalGroups(
  project: GraphProject,
  capture: Capture,
  order: Record<string, string[]>,
  meanOrder?: number[],
): { system: number; signal: number; name: string }[] {
  const present = new Map<string, { system: number; signal: number; name: string; rank: number }>();
  for (const record of rangeRecords(project, capture)) {
    for (const obs of obsOf(record)) {
      const info = signalInfo(obs);
      const key = `${obs.system}:${obs.signal}`;
      if (!present.has(key)) present.set(key, { system: obs.system, signal: obs.signal, name: info.name, rank: info.rank });
    }
  }
  const groups = [...present.values()];
  const position = (name: string, system: number): [number, number] => {
    const list = order[SYSTEM_NAME[system] ?? String(system)];
    const index = list ? list.indexOf(name) : -1;
    return [index === -1 ? Number.MAX_SAFE_INTEGER : index, 0];
  };
  groups.sort((a, b) => {
    if (a.system !== b.system) return a.system - b.system;
    const [ia] = position(a.name, a.system);
    const [ib] = position(b.name, b.system);
    return ia - ib || a.rank - b.rank;
  });

  // `meanOrder` is a **recorded observation** of one export, so it is applied as a stable partition
  // on top of the table order above: the listed groups come first, in the listed order, and every
  // unlisted group keeps the row it already had.
  if (!meanOrder || meanOrder.length === 0) {
    return groups.map(({ system, signal, name }) => ({ system, signal, name }));
  }
  const explicit = new Map<number, number>();
  meanOrder.forEach((id, index) => {
    if (Number.isInteger(id) && !explicit.has(id)) explicit.set(id, index);
  });
  const explicitRank = (group: { system: number; signal: number }) => {
    const index = explicit.get(meanOrderId(group.system, group.signal));
    return index === undefined ? Number.MAX_SAFE_INTEGER : index;
  };
  groups.sort((a, b) => explicitRank(a) - explicitRank(b));
  return groups.map(({ system, signal, name }) => ({ system, signal, name }));
}

/**
 * `(system, signal)` → the id a `GraphProject.meanOrder` entry uses.
 *
 * GPS is system 0, so a GPS-only list reads as ordinary signal-type numbers (`0 17 16 9 14`); the
 * other constellations are offset by 32 per system. 255 is the largest value (system 7, signal 31).
 */
export function meanOrderId(system: number, signal: number): number {
  return system * 32 + signal;
}

/** `Tracking Time` columns: `lock_time` per satellite-signal, six fixed decimals. */
export function trackingTimeColumns(project: GraphProject, capture: Capture): CsvColumn[] {
  return satelliteColumns(project, capture).map((column) => {
    const [system, signal] = column.key.split(':').map(Number);
    return {
      header: `${column.name}_${column.prn}`,
      format: 'fixed6' as const,
      value: (record: CaptureRecord) => {
        const obs = obsOf(record).find((o) => o.system === system && o.signal === signal && o.prn === column.prn);
        // Satellite not in this epoch's `obs[]` (not yet risen / already set): empty cell, not an error.
        return obs ? obs.lockTime : null;
      },
    };
  });
}

/** `GNSS Signal Strength` columns: `C_No` per satellite, then one mean per `(system, signal)`. */
export function gnssSignalStrengthColumns(project: GraphProject, capture: Capture): CsvColumn[] {
  const columns: CsvColumn[] = satelliteColumns(project, capture).map((column) => {
    const [system, signal] = column.key.split(':').map(Number);
    return {
      header: `${column.name}_${column.prn}`,
      format: 'fixed6' as const,
      value: (record: CaptureRecord) => {
        const obs = obsOf(record).find((o) => o.system === system && o.signal === signal && o.prn === column.prn);
        // Same rule as `Tracking Time`: an epoch without the satellite leaves the cell empty.
        return obs ? obs.cno : null;
      },
    };
  });
  for (const group of signalGroups(project, capture, MEAN_ORDER, project.meanOrder)) {
    columns.push({
      header: `${group.name}_Mean`,
      format: 'fixed6',
      value: (record) => {
        const values = obsOf(record)
          .filter((obs) => obs.system === group.system && obs.signal === group.signal)
          .map((obs) => obs.cno);
        if (values.length === 0) return 0;
        return values.reduce((sum, value) => sum + value, 0) / values.length;
      },
    });
  }
  return columns;
}

/**
 * `Satellites and Signals` — one column per `(constellation, signal)` count, then the constellation's
 * satellite count, repeated per constellation, then the two totals. Its own renderer because the
 * columns are grouped (`Signals_* … Satellites_*` per constellation), not one block of satellites.
 */
export function renderSatellitesAndSignals(project: GraphProject, capture: Capture): string {
  const groups = signalGroups(project, capture, SIGNALS_ORDER);
  const systems = [...new Set(groups.map((group) => group.system))].sort((a, b) => a - b);
  const header: string[] = ['timestamp (GPS week sec)'];
  for (const system of systems) {
    const name = SYSTEM_NAME[system] ?? String(system);
    for (const group of groups.filter((g) => g.system === system)) header.push(`Signals_${group.name}`);
    header.push(`Satellites_${name}`);
  }
  header.push('Signals_Total', 'Satellites_Total');

  const rows = rangeRecords(project, capture).map((record) => {
    const obs = obsOf(record);
    const cells: string[] = [formatGpsColumn(record.gpsMs)];
    for (const system of systems) {
      for (const group of groups.filter((g) => g.system === system)) {
        cells.push(String(obs.filter((o) => o.system === group.system && o.signal === group.signal).length));
      }
      cells.push(String(new Set(obs.filter((o) => o.system === system).map((o) => o.prn)).size));
    }
    cells.push(String(obs.length), String(new Set(obs.map((o) => `${o.system}:${o.prn}`)).size));
    return cells.join(',');
  });

  return [header.join(','), ...rows].map((line) => line + '\r\n').join('');
}
