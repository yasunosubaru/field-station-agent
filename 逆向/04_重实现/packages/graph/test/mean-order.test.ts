/**
 * D4 — `GraphProject.meanOrder`: the `_Mean` column order as **recorded metadata**, not a rule.
 *
 * `GNSS Signal Strength`'s last block is the one part of the export that the capture does not
 * determine: the `clean` and `broad` samples are structurally identical (same `(system, signal)`
 * set, same first-appearance order, same in-record `obs[]` order) yet Graph 2.11.0 wrote
 * `0 9 17 16 14` for one and `0 17 16 9 14` for the other (`03_分析/13_Graph分析页.md §8.2.4`).
 * So this build offers a way to *record* what one export did:
 *
 *   `GraphProject.meanOrder?: number[]`   `(system, signal)` groups encoded as `system * 32 + signal`,
 *                                         in observed column order (GPS is system 0, so a GPS list
 *                                         reads as plain signal numbers);
 *   `--mean-order=0,17,16,9,14`           the same thing from the exporter CLI, written into the
 *                                         project's `project.json` sidecar and read back on re-export.
 *
 * What is pinned here:
 *
 *  1. encoding/parsing, and that an absent `meanOrder` really is absent (no accidental `[]`);
 *  2. it moves **only** the `_Mean` block of **only** `GNSS Signal Strength`, with every value
 *     unchanged — `Tracking Time` and `Satellites and Signals` are byte-identical;
 *  3. unlisted groups keep the built-in order, so a GPS-only list does not reshuffle BeiDou;
 *  4. the CLI writes the sidecar, a re-export without the flag reads it back, and a rejection of
 *     malformed values.
 *
 *   node --test --test-force-exit "packages/graph/test/mean-order.test.ts"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCapture } from '../src/capture.ts';
import { exportCsv } from '../src/csv.ts';
import { meanOrderId } from '../src/range-charts.ts';
import {
  MEAN_ORDER_MAX,
  cleanCapture,
  parseMeanOrder,
  projectFromCapture,
} from '../tools/export-sbf-project.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(here, '..', '..', '..', '..', '00_来源', 'samples');
/** The capture the shipped `clean` project was converted from — small and RANGE-fed. */
const CLEAN_CAPTURE = join(SAMPLES, 'convert', 'clean-9600.gps');
const CLEAN_GNSS = join(SAMPLES, 'graph', 'export', 'csv', 'GNSS Signal Strength.csv');
const TOOL = resolve(here, '..', 'tools', 'export-sbf-project.ts');

/* ---------------- 1. the encoding ---------------- */

test('meanOrderId：GPS 就是 signal 号，其他星座按 32 偏移', () => {
  assert.equal(meanOrderId(0, 0), 0);
  assert.equal(meanOrderId(0, 17), 17);
  assert.equal(meanOrderId(0, 14), 14);
  assert.equal(meanOrderId(4, 1), 129, 'BeiDou B2I_D1 = 4*32 + 1');
  assert.equal(meanOrderId(5, 24), 184);
  assert.ok(meanOrderId(7, 31) <= MEAN_ORDER_MAX, '255 是最大值');
});

test('parseMeanOrder 接受逗号/分号/空格，去重但保序，拒绝坏值', () => {
  assert.deepEqual(parseMeanOrder('0,17,16,9,14'), [0, 17, 16, 9, 14]);
  assert.deepEqual(parseMeanOrder(' 0 17;16, 9 ,14 '), [0, 17, 16, 9, 14]);
  assert.deepEqual(parseMeanOrder('0,0,17,17'), [0, 17], '重复的 id 不重复出现，顺序不变');
  assert.deepEqual(parseMeanOrder('14,9,16,17,0'), [14, 9, 16, 17, 0], '原样保留，不排序');

  assert.throws(() => parseMeanOrder(''), /为空/);
  assert.throws(() => parseMeanOrder('0,abc'), /不是非负整数/);
  assert.throws(() => parseMeanOrder('-1'), /不是非负整数/);
  assert.throws(() => parseMeanOrder('256'), /超出 0\.\.255/);
});

/* ---------------- 2. the project field ---------------- */

interface Render {
  header: string[];
  text: string;
}

function renderWith(meanOrder: number[] | undefined): Map<string, Render> {
  const out = mkdtempSync(join(tmpdir(), 'graph-mean-order-'));
  try {
    const { capture } = cleanCapture(loadCapture(CLEAN_CAPTURE));
    const project = projectFromCapture(capture, {
      name: 'clean', outDir: out, capturePath: CLEAN_CAPTURE, meanOrder,
    });
    const files = new Map<string, Render>();
    for (const result of exportCsv(project, capture)) {
      const text = result.buffer.toString('utf8').replace(/^\uFEFF/, '');
      files.set(result.fileName, { header: text.split('\r\n')[6].split(','), text });
    }
    return files;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const meansOf = (render: Map<string, Render>) =>
  render.get('GNSS Signal Strength.csv')!.header.filter((name) => name.endsWith('_Mean'));

/** From the column header down — the six comment lines carry the temp output directory. */
const bodyOf = (render: Map<string, Render>, name: string): string =>
  render.get(name)!.text.split('\r\n').slice(6).join('\r\n');

test('不传 meanOrder 时 GraphProject 上没有这个字段，列序就是 clean 的观测序', () => {
  const { capture } = cleanCapture(loadCapture(CLEAN_CAPTURE));
  const project = projectFromCapture(capture, { name: 'clean', outDir: tmpdir(), capturePath: CLEAN_CAPTURE });
  assert.equal('meanOrder' in project, false, '缺省不是 []，而是根本不写');

  const means = meansOf(renderWith(undefined));
  assert.deepEqual(means.slice(0, 5), [
    'GPS_L1_CA_Mean', 'GPS_L2_PY_Mean', 'GPS_L2_CM_Mean', 'GPS_L1_CP_Mean', 'GPS_L5_Q_Mean',
  ]);
  // …which is the shipped `clean` oracle's own order.
  const oracle = readFileSync(CLEAN_GNSS, 'utf8').replace(/^\uFEFF/, '').split('\r\n')[6].split(',');
  assert.deepEqual(means, oracle.filter((name) => name.endsWith('_Mean')));
});

test('记录 0,17,16,9,14 后只换 GPS 的 5 个 `_Mean` 列，值一格不动', () => {
  const plain = renderWith(undefined);
  const recorded = renderWith([0, 17, 16, 9, 14]);

  const order = meansOf(recorded);
  assert.deepEqual(order.slice(0, 5), [
    'GPS_L1_CA_Mean', 'GPS_L2_CM_Mean', 'GPS_L1_CP_Mean', 'GPS_L2_PY_Mean', 'GPS_L5_Q_Mean',
  ]);
  // 未列出的 BeiDou / QZSS 组保持内置顺序（没有被顺带重排）。
  assert.deepEqual(order.slice(5), [
    'BEIDOU_B2I_D1_Mean', 'BEIDOU_B1I_D2_Mean', 'BEIDOU_B3I_D2_Mean', 'BEIDOU_B1I_D1_Mean', 'BEIDOU_B3I_D1_Mean',
    'QZSS_L1_CA_Mean', 'QZSS_L2_CM_Mean', 'QZSS_L1_CP_Mean', 'QZSS_L5_Q_Mean',
  ]);
  assert.deepEqual([...order].sort(), [...meansOf(plain)].sort(), '还是同一批列');

  // `_Mean` 以外的图逐字节不变：只有 GNSS Signal Strength 这类图读 meanOrder。
  for (const name of ['Tracking Time.csv', 'Satellites and Signals.csv']) {
    assert.equal(bodyOf(recorded, name), bodyOf(plain, name), `${name} 不受 meanOrder 影响`);
  }
  // 逐卫星列也没动，只有 `_Mean` 区块的次序变了。
  assert.deepEqual(recorded.get('GNSS Signal Strength.csv')!.header.slice(0, 51),
    plain.get('GNSS Signal Strength.csv')!.header.slice(0, 51));

  const plainHeader = plain.get('GNSS Signal Strength.csv')!.header;
  const recordedHeader = recorded.get('GNSS Signal Strength.csv')!.header;
  const columnOf = plainHeader.map((name) => recordedHeader.indexOf(name));
  assert.ok(columnOf.every((index) => index >= 0));
  const plainRows = plain.get('GNSS Signal Strength.csv')!.text.split('\r\n').slice(7).filter(Boolean);
  const recordedRows = recorded.get('GNSS Signal Strength.csv')!.text.split('\r\n').slice(7).filter(Boolean);
  assert.equal(recordedRows.length, plainRows.length);
  for (let r = 0; r < plainRows.length; r += 1) {
    const a = recordedRows[r].split(',');
    const b = plainRows[r].split(',');
    for (let c = 0; c < b.length; c += 1) {
      assert.equal(a[columnOf[c]], b[c], `第 ${r + 1} 行 ${plainHeader[c]}`);
    }
  }
});

test('列出的顺序被逐字采用，不是只用来排序', () => {
  // 反着写：如果实现把它当"排序键"，GPS 又会回到升序；逐字采用则必须原样出现。
  const reversed = renderWith([14, 9, 16, 17, 0]);
  assert.deepEqual(meansOf(reversed).slice(0, 5), [
    'GPS_L5_Q_Mean', 'GPS_L2_PY_Mean', 'GPS_L1_CP_Mean', 'GPS_L2_CM_Mean', 'GPS_L1_CA_Mean',
  ]);
});

test('只列一个星座时，另一个星座的组排在后面且保持内置顺序', () => {
  const onlyOne = renderWith([16]);
  const order = meansOf(onlyOne);
  assert.equal(order[0], 'GPS_L1_CP_Mean', '列出的组在最前');
  assert.deepEqual(order.slice(1, 5), [
    'GPS_L1_CA_Mean', 'GPS_L2_PY_Mean', 'GPS_L2_CM_Mean', 'GPS_L5_Q_Mean',
  ], '同星座未列出的组按内置顺序跟在后面');
  assert.deepEqual(order.slice(5), [
    'BEIDOU_B2I_D1_Mean', 'BEIDOU_B1I_D2_Mean', 'BEIDOU_B3I_D2_Mean', 'BEIDOU_B1I_D1_Mean', 'BEIDOU_B3I_D1_Mean',
    'QZSS_L1_CA_Mean', 'QZSS_L2_CM_Mean', 'QZSS_L1_CP_Mean', 'QZSS_L5_Q_Mean',
  ]);
});

/* ---------------- 3. the CLI + the sidecar ---------------- */

function runTool(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const csvBody = (dir: string, name: string): string =>
  readFileSync(join(dir, 'csv', name), 'utf8').replace(/^\uFEFF/, '').split('\r\n').slice(6).join('\r\n');

test('CLI --mean-order：写进 project.json，重导时不带参数也能读回来', () => {
  const out = mkdtempSync(join(tmpdir(), 'graph-mean-cli-'));
  try {
    const first = runTool([
      '--capture', CLEAN_CAPTURE, '--out', out, '--name', 'clean', '--mean-order=0,17,16,9,14',
    ]);
    assert.equal(first.status, 0, first.stderr);

    const sidecar = JSON.parse(readFileSync(join(out, 'project.json'), 'utf8'));
    assert.deepEqual(sidecar.meanOrder, [0, 17, 16, 9, 14]);
    assert.match(sidecar.command, /--mean-order=0,17,16,9,14$/, '命令里带上记录值，便于复现');

    const header = csvBody(out, 'GNSS Signal Strength.csv').split('\r\n')[0].split(',');
    assert.deepEqual(header.filter((name) => name.endsWith('_Mean')).slice(0, 5), [
      'GPS_L1_CA_Mean', 'GPS_L2_CM_Mean', 'GPS_L1_CP_Mean', 'GPS_L2_PY_Mean', 'GPS_L5_Q_Mean',
    ]);

    // 记下所有 CSV（含 6 行注释），第二次重导必须逐字节相同。
    const names = ['GNSS Signal Strength.csv', 'Tracking Time.csv', 'Satellites and Signals.csv', 'Height.csv'];
    const before = new Map(names.map((name) => [name, readFileSync(join(out, 'csv', name))]));

    // 不再传 --mean-order：工程目录里的 project.json 就是这次导出的元数据。
    const second = runTool(['--capture', CLEAN_CAPTURE, '--out', out, '--name', 'clean']);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout + second.stderr, /0,17,16,9,14/, '日志说明这次用了记录的列序');
    for (const name of names) {
      assert.deepEqual(readFileSync(join(out, 'csv', name)), before.get(name), `${name} 重导后没变`);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'project.json'), 'utf8')).meanOrder, [0, 17, 16, 9, 14]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('CLI 拒绝坏的 --mean-order，且失败前不写任何 CSV', () => {
  const out = mkdtempSync(join(tmpdir(), 'graph-mean-bad-'));
  try {
    const bad = runTool(['--capture', CLEAN_CAPTURE, '--out', out, '--name', 'x', '--mean-order=0,nope']);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /不是非负整数/);
    assert.equal(existsSync(join(out, 'csv')), false, '参数错误时不出半套 CSV');

    const tooBig = runTool(['--capture', CLEAN_CAPTURE, '--out', out, '--name', 'x', '--mean-order=256']);
    assert.notEqual(tooBig.status, 0);
    assert.match(tooBig.stderr, /超出 0\.\.255/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
