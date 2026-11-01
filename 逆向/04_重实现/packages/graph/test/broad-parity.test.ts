/**
 * `export-broad` parity — the 13 CSVs of a **real Graph 2.11.0.3656 export**, byte for byte.
 *
 * Oracle: `00_来源/samples/graph/export-broad/csv/` (project `broad`, driven from
 * `broad-clean.gps`, 13 files / 1 559 291 B). Our side is the same conversion the tool and the app
 * use: `cleanCapture(loadCapture(broad-clean.gps))` → `projectFromCapture` → `exportCsv`.
 *
 * The six `#` comment lines carry `.gpf` metadata this build does not have (project directory, the
 * original `broad.gps` file name, and the session window `467940.000–468009.000` that starts 9.1 s
 * before the first decoded frame), so exactly those five values are normalised on both sides —
 * `#Project Name:` is compared, and everything from the column header down is compared verbatim.
 *
 * What this file pins:
 *
 *  1. **13/13** files. Today 12 of them are byte-identical; `GNSS Signal Strength` is identical in
 *     all 60 satellite columns and in every *value*, but the last 3 `_Mean` columns are in a
 *     different order — see the dedicated test at the bottom, which states exactly which 3 names and
 *     why the order cannot be derived from the capture.
 *  2. `HW Monitor Status`: **59** rows, not 65. The capture carries 65 HWMONITOR frames but only 59
 *     timestamps — the 6 extras are the same payload logged on a second port at every 10 s boundary
 *     (`portAddress` 189 vs 188), and Graph's table is keyed by `timestamp` (`CREATE TABLE … .
 *     (timestamp INTEGER PRIMARY KEY)` + `INSERT OR IGNORE` in `graph-node-wrapper.node`).
 *  3. `Height`: six decimals with the zeros **kept** (`65.931110`, not `65.93111`); 12 of the 60
 *     rows differ under a trailing-zero trim.
 *  4. `Receiver Status`: a span ends at the record that **clears** the condition, so 5 of the 7 rows
 *     used to print `end == start`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCapture } from '../src/capture.ts';
import { exportCsv } from '../src/csv.ts';
import { cleanCapture, projectFromCapture } from '../tools/export-sbf-project.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(here, '..', '..', '..', '..', '00_来源', 'samples');
const BROAD_CAPTURE = join(SAMPLES, 'convert', 'broad-clean.gps');
const ORACLE_DIR = join(SAMPLES, 'graph', 'export-broad', 'csv');

/** The five `.gpf`-derived comment lines; `#Project Name:` deliberately stays in the comparison. */
const NORMALISE = /^#(Project Directory|Data File Name|Start Time\(GPS\)|End Time\(GPS\)|Duration):.*$/gm;
const normalise = (text: string): string =>
  text.replace(/^\uFEFF/, '').replace(NORMALISE, (line) => line.slice(0, line.indexOf(':') + 1));

interface Rendered {
  /** file name → normalised text (BOM stripped, five project lines blanked). */
  files: Map<string, string>;
}

let cached: Rendered | null = null;

/** Every CSV this build produces for the `broad` capture, rendered once. */
function renderBroad(): Rendered {
  if (cached) return cached;
  const out = mkdtempSync(join(tmpdir(), 'graph-broad-parity-'));
  try {
    const { capture } = cleanCapture(loadCapture(BROAD_CAPTURE));
    const project = projectFromCapture(capture, { name: 'broad', outDir: out, capturePath: BROAD_CAPTURE });
    const files = new Map<string, string>();
    for (const result of exportCsv(project, capture)) files.set(result.fileName, normalise(result.buffer.toString('utf8')));
    cached = { files };
    return cached;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function oracle(fileName: string): string {
  return normalise(readFileSync(join(ORACLE_DIR, fileName), 'utf8'));
}

const dataRows = (text: string): string[] => text.split('\r\n').slice(7).filter((line) => line.length);
const headerOf = (text: string): string[] => text.split('\r\n')[6].split(',');

/* ---------------- 1. the 13 files ---------------- */

test('broad 的 13 份 CSV 全部产出，12 份与 Graph 2.11.0 的导出逐字节相同', () => {
  const ours = renderBroad().files;
  const oracleNames = readdirSync(ORACLE_DIR).filter((name) => name.endsWith('.csv')).sort();
  assert.equal(oracleNames.length, 13, 'export-broad/csv 是 13 份');
  assert.deepEqual([...ours.keys()].sort(), oracleNames, '同样的 13 份，文件名也一致');

  const differing: string[] = [];
  for (const name of oracleNames) {
    if (ours.get(name) !== oracle(name)) differing.push(name);
  }
  assert.deepEqual(differing, ['GNSS Signal Strength.csv'], '只剩 `_Mean` 列序这一处差异（见文件末尾的用例）');

  // 逐字节的那 12 份，连行数也逐份点名，避免以后悄悄少一行。
  const rows = (name: string) => dataRows(oracle(name)).length;
  assert.equal(rows('2D Trajectory.csv'), 60);
  assert.equal(rows('CPU Usage.csv'), 60);
  assert.equal(rows('Height.csv'), 60);
  assert.equal(rows('Position SD.csv'), 60);
  assert.equal(rows('Position Status.csv'), 60);
  assert.equal(rows('Position Type.csv'), 60);
  assert.equal(rows('Solution Statistics.csv'), 60);
  assert.equal(rows('Velocity.csv'), 60);
  assert.equal(rows('HW Monitor Status.csv'), 59);
  assert.equal(rows('Receiver Status.csv'), 7);
  assert.equal(rows('Tracking Time.csv'), 1199);
  assert.equal(rows('Satellites and Signals.csv'), 1199);
});

/* ---------------- 2. HW Monitor Status: one row per timestamp ---------------- */

test('HW Monitor Status：65 帧 / 59 个时间戳 —— 多出的 6 行是双端口同 payload 的重复帧', () => {
  const text = oracle('HW Monitor Status.csv');
  const rows = dataRows(text);
  assert.equal(rows.length, 59, '原版是 59 行，不是采集里的 65 帧');

  const stamps = rows.map((line) => line.split(',')[0]);
  assert.equal(new Set(stamps).size, 59, '每个时间戳只出现一次');
  assert.equal(rows[0].split(',')[0], '2442  467950.000');
  assert.equal(rows[58].split(',')[0], '2442  468008.000');

  // 采集里那 6 对重复：同一 payload，两个 portAddress，时间戳 10 s 的整数倍。
  const capture = cleanCapture(loadCapture(BROAD_CAPTURE)).capture;
  const frames = capture.byName('HWMONITOR');
  assert.equal(frames.length, 65, '采集文件里 65 条 HWMONITOR');
  const duplicates = frames.filter((record, index) => index > 0 && record.gpsMs === frames[index - 1].gpsMs);
  assert.equal(duplicates.length, 6, '6 对同时间戳的帧');
  for (const record of duplicates) {
    const partner = frames[frames.indexOf(record) - 1];
    assert.deepEqual(record.frame.payload, partner.frame.payload, '两帧的 payload 相同');
    assert.notEqual(record.frame.header.portAddress, partner.frame.header.portAddress, '但来自不同端口');
  }

  // 被丢掉的那 6 个时间戳正是 10 s 边界，而不是随机 6 行。
  const droppedStamps = duplicates.map((record) => record.gpsMs % 10_000 === 0);
  assert.ok(droppedStamps.every(Boolean), '6 对都落在 10 s 边界');

  assert.equal(renderBroad().files.get('HW Monitor Status.csv'), text, '与 oracle 逐字节一致');
});

/* ---------------- 3. Height: fixed six decimals ---------------- */

test('Height：六位小数不裁尾零（65.931110），60 行里 12 行因此不同于 trim', () => {
  const text = oracle('Height.csv');
  const rows = dataRows(text);
  assert.equal(rows.length, 60);
  assert.equal(rows[2], '2442  467952.000,65.931110', '尾部那个 0 必须保留');
  assert.equal(rows[3], '2442  467953.000,65.922480');

  const cells = rows.map((line) => line.split(',')[1]);
  assert.ok(cells.every((cell) => /^-?\d+\.\d{6}$/.test(cell)), '60 格全是六位小数');
  const trailingZero = cells.filter((cell) => cell.endsWith('0'));
  assert.equal(trailingZero.length, 12, '12 格第六位是 0 —— 裁尾零的写法会在这 12 行上不同');

  assert.equal(renderBroad().files.get('Height.csv'), text, '与 oracle 逐字节一致');
});

/* ---------------- 4. Receiver Status: span end ---------------- */

test('Receiver Status：span 的 end 是“条件转假的那条记录”，不是最后一条仍为真的记录', () => {
  const text = oracle('Receiver Status.csv');
  const rows = dataRows(text);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows, [
    'Antenna 1 Gain High,1477389562896.000000,1477389564995.000000,1',
    'Antenna 1 Gain High,1477389603896.000000,1477389604996.000000,1',
    'Ethernet Not Connected,1477389549994.000000,1477389604996.000000,1',
    'Jamming Detected,1477389552895.000000,1477389556995.000000,1',
    'Jamming Detected,1477389575910.000000,1477389582009.000000,1',
    'Jamming Detected,1477389583896.000000,1477389588995.000000,1',
    'RF Calibration Data Present,1477389549994.000000,1477389604996.000000,1',
  ]);

  // 每条 span 的 end 都与 RXSTATUS 时间轴对得上：要么是下一条（转假）记录，要么是窗口内最后一条。
  const rxTimes = [...new Set(cleanCapture(loadCapture(BROAD_CAPTURE)).capture.byName('RXSTATUS').map((record) => record.gpsMs))].sort((a, b) => a - b);
  assert.deepEqual(rxTimes, [
    1477389549994, 1477389552895, 1477389556995, 1477389562896, 1477389564995, 1477389575910,
    1477389582009, 1477389583896, 1477389588995, 1477389603896, 1477389604996,
  ]);
  const last = rxTimes[rxTimes.length - 1];
  for (const row of rows) {
    const [, startText, endText] = row.split(',');
    const start = Number(startText);
    const end = Number(endText);
    assert.ok(rxTimes.includes(start), `${row.split(',')[0]} 的 start 是真实的 RXSTATUS 时间戳`);
    assert.ok(rxTimes.includes(end), `${row.split(',')[0]} 的 end 也是真实的 RXSTATUS 时间戳`);
    assert.ok(end >= start);
    if (end !== last) {
      const next = rxTimes[rxTimes.indexOf(end)];
      assert.ok(next > start, 'end 必须晚于 start（转假记录在后）');
    }
  }
  // 曾经全部写成 end == start 的 5 行，现在都有真实的跨度。
  const zeroLength = rows.filter((row) => { const c = row.split(','); return c[1] === c[2]; });
  assert.equal(zeroLength.length, 0, 'broad 没有零长 span');

  assert.equal(renderBroad().files.get('Receiver Status.csv'), text, '与 oracle 逐字节一致');
});

/* ---------------- 5. GNSS Signal Strength: the one residual difference ---------------- */

test('GNSS Signal Strength：60 个逐卫星列与全部数值逐字节一致，只剩 3 个 `_Mean` 列的排列', () => {
  const text = oracle('GNSS Signal Strength.csv');
  const ours = renderBroad().files.get('GNSS Signal Strength.csv')!;
  const oracleHeader = headerOf(text);
  const ourHeader = headerOf(ours);
  assert.equal(oracleHeader.length, 61, 'timestamp + 50 卫星列 + 10 `_Mean`');
  assert.equal(ourHeader.length, 61);

  // 前 51 列（时间戳 + 50 个逐卫星列）逐字一致。
  assert.deepEqual(ourHeader.slice(0, 51), oracleHeader.slice(0, 51));

  // 后 10 个 `_Mean` 列同名同集合，只是顺序不同。
  const oracleMeans = oracleHeader.slice(51);
  const ourMeans = ourHeader.slice(51);
  assert.deepEqual([...ourMeans].sort(), [...oracleMeans].sort(), '同一批 `_Mean` 列');
  assert.deepEqual(oracleMeans, [
    'GPS_L1_CA_Mean', 'GPS_L2_CM_Mean', 'GPS_L1_CP_Mean', 'GPS_L2_PY_Mean', 'GPS_L5_Q_Mean',
    'BEIDOU_B2I_D1_Mean', 'BEIDOU_B1I_D2_Mean', 'BEIDOU_B3I_D2_Mean', 'BEIDOU_B1I_D1_Mean', 'BEIDOU_B3I_D1_Mean',
  ]);
  assert.deepEqual(ourMeans, [
    'GPS_L1_CA_Mean', 'GPS_L2_PY_Mean', 'GPS_L2_CM_Mean', 'GPS_L1_CP_Mean', 'GPS_L5_Q_Mean',
    'BEIDOU_B2I_D1_Mean', 'BEIDOU_B1I_D2_Mean', 'BEIDOU_B3I_D2_Mean', 'BEIDOU_B1I_D1_Mean', 'BEIDOU_B3I_D1_Mean',
  ]);
  // 差的就是 GPS 中间这 3 列（clean 的排列也是这一组）。
  assert.deepEqual(
    oracleMeans.filter((name, index) => name !== ourMeans[index]),
    ['GPS_L2_CM_Mean', 'GPS_L1_CP_Mean', 'GPS_L2_PY_Mean'],
  );

  // 按列名对齐后，1199 行 × 61 格全部相同 —— 数值没有错，只是排列不同。
  const oracleRows = dataRows(text);
  const ourRows = dataRows(ours);
  assert.equal(ourRows.length, 1199);
  assert.equal(oracleRows.length, 1199);
  const order = oracleHeader.map((name) => ourHeader.indexOf(name));
  assert.ok(order.every((index) => index >= 0));
  for (let r = 0; r < oracleRows.length; r += 1) {
    const oracleCells = oracleRows[r].split(',');
    const ourCells = ourRows[r].split(',');
    assert.equal(ourCells[0], oracleCells[0], `第 ${r + 1} 行时间戳`);
    for (let c = 1; c < oracleCells.length; c += 1) {
      assert.equal(ourCells[order[c]], oracleCells[c], `第 ${r + 1} 行 ${oracleHeader[c]}`);
    }
  }
});

test('clean 的 GNSS Signal Strength 列序没有被这次改动动过', () => {
  // 第一份 oracle 的 GPS `_Mean` 顺序是 L1_CA, L2_PY, L2_CM, L1_CP, L5_Q；`range-charts.ts` 的
  // MEAN_ORDER 就是抄的它。改 broad 时必须保持它不变，否则 clean 的 12 份 oracle 会红。
  const clean = readFileSync(join(SAMPLES, 'graph', 'export', 'csv', 'GNSS Signal Strength.csv'), 'utf8');
  const means = headerOf(clean.replace(/^\uFEFF/, '')).filter((name) => name.endsWith('_Mean'));
  assert.deepEqual(means, [
    'GPS_L1_CA_Mean', 'GPS_L2_PY_Mean', 'GPS_L2_CM_Mean', 'GPS_L1_CP_Mean', 'GPS_L5_Q_Mean',
    'BEIDOU_B2I_D1_Mean', 'BEIDOU_B1I_D2_Mean', 'BEIDOU_B3I_D2_Mean', 'BEIDOU_B1I_D1_Mean', 'BEIDOU_B3I_D1_Mean',
    'QZSS_L1_CA_Mean', 'QZSS_L2_CM_Mean', 'QZSS_L1_CP_Mean', 'QZSS_L5_Q_Mean',
  ]);
});
