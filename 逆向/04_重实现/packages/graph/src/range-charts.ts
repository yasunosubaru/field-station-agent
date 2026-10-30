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
 */

import type { Capture, CaptureRecord } from './capture.ts';
import { field } from './capture.ts';
import type { GraphProject } from './project.ts';
import type { CsvColumn } from './csv.ts';
import { formatGpsColumn } from './format.ts';

/** `(system, 5-bit signal type)` → column name and flat-enum rank. */
export const RANGE_SIGNALS: Record<number, Record<number, { name: string; rank: number }>> = {
  // system 0 — GPS
  0: {
    0: { name: 'GPS_L1_CA', rank: 0 },
    16: { name: 'GPS_L1_CP', rank: 2 },
    9: { name: 'GPS_L2_PY', rank: 8 },
    17: { name: 'GPS_L2_CM', rank: 9 },
    14: { name: 'GPS_L5_Q', rank: 12 },
  },
  // system 4 — BEIDOU
  4: {
    0: { name: 'BEIDOU_B1I_D1', rank: 32 },
    4: { name: 'BEIDOU_B1I_D2', rank: 33 },
    1: { name: 'BEIDOU_B2I_D1', rank: 40 },
    2: { name: 'BEIDOU_B3I_D1', rank: 43 },
    6: { name: 'BEIDOU_B3I_D2', rank: 44 },
  },
  // system 5 — QZSS
  5: {
    0: { name: 'QZSS_L1_CA', rank: 45 },
    16: { name: 'QZSS_L1_CP', rank: 47 },
    17: { name: 'QZSS_L2_CM', rank: 49 },
    14: { name: 'QZSS_L5_Q', rank: 53 },
  },
};

/** Constellation display name per system id (the prefix the goldens use). */
const SYSTEM_NAME: Record<number, string> = { 0: 'GPS', 1: 'GLONASS', 2: 'SBAS', 3: 'GALILEO', 4: 'BEIDOU', 5: 'QZSS', 6: 'NAVIC' };

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

function signalInfo(obs: Obs): { name: string; rank: number } {
  const table = RANGE_SIGNALS[obs.system];
  const info = table?.[obs.signal];
  if (!info) throw new Error(`unknown RANGE signal system=${obs.system} signal=${obs.signal}`);
  return info;
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
function signalGroups(project: GraphProject, capture: Capture, order: Record<string, string[]>): { system: number; signal: number; name: string }[] {
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
  return groups.map(({ system, signal, name }) => ({ system, signal, name }));
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
        if (!obs) throw new Error(`RANGE record has no ${column.name}_${column.prn}`);
        return obs.lockTime;
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
        if (!obs) throw new Error(`RANGE record has no ${column.name}_${column.prn}`);
        return obs.cno;
      },
    };
  });
  for (const group of signalGroups(project, capture, MEAN_ORDER)) {
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
