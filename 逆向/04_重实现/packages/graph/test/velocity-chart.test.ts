/**
 * `Velocity.csv` — the 13th Graph chart, driven by **BESTVEL**.
 *
 * Ground truth is a real Graph 2.11.0 export, not a fixture of ours:
 * `00_来源/samples/graph/export-broad/csv/Velocity.csv` (project `broad`, 60 rows,
 * `2442 467950.000` – `2442 468009.000`, 4193 B). Its data source
 * `00_来源/samples/convert/broad-clean.gps` is a **binary SBF** capture that happens to carry a
 * `.gps` name; it holds exactly 60 `BESTVEL` records, which is what makes the comparison a full
 * 60-row check rather than a sample.
 *
 * What is pinned here:
 *  - the column derivation (`horizontal_speed` + `ground_track` in degrees → north/east, `z` → up,
 *    `hypot` for the two totals) against every row of the golden;
 *  - the project with no BESTVEL (`clean`, `b1`) gains **no** `Velocity.csv` — an empty file would be
 *    a fabrication, and Graph writes nothing there either.
 *
 * The six `#` comment lines carry project metadata (`#Project Directory:` is the export directory,
 * `#Data File Name:` the capture's basename, the time window comes from the `.gpf`), so the
 * comparison starts at the column header — everything from there down must be byte-identical.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { field, loadCapture } from '../src/capture.ts';
import { CSV_CHARTS, csvChartSpec, exportCsv, renderChartCsv } from '../src/csv.ts';
import { formatFixedHalfEven } from '../src/format.ts';
import { loadProject } from '../src/project.ts';
import { cleanCapture, projectFromCapture } from '../tools/export-sbf-project.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(here, '..', '..', '..', '..', '00_来源', 'samples');

/** Binary SBF despite the name; the 60 BESTVEL records the golden was produced from. */
const BROAD_CAPTURE = join(SAMPLES, 'convert', 'broad-clean.gps');
const BROAD_GOLDEN = join(SAMPLES, 'graph', 'export-broad', 'csv', 'Velocity.csv');
const CLEAN_GPF = join(SAMPLES, 'graph', 'project', 'clean.gpf');
const CLEAN_CAPTURE = join(SAMPLES, 'convert', 'clean-9600.gps');
const B1_CAPTURE = join(SAMPLES, 'live-20261031', 'b1-20261101.sbf');

/** The golden with its BOM stripped and split into CRLF lines (the trailing empty one dropped). */
function goldenLines(): string[] {
  const text = readFileSync(BROAD_GOLDEN, 'utf8').replace(/^\uFEFF/, '');
  assert.ok(text.includes('\r\n'), 'Graph 写的是 CRLF');
  assert.ok(text.endsWith('\r\n'), '最后一行后面也有 CRLF');
  return text.split('\r\n').slice(0, -1);
}

/** `broad`'s Velocity.csv, rendered by this build into a throw-away project directory. */
function renderBroadVelocity(): { buffer: Buffer; lines: string[] } {
  const capture = loadCapture(BROAD_CAPTURE);
  const out = mkdtempSync(join(tmpdir(), 'graph-velocity-'));
  try {
    const project = projectFromCapture(capture, { name: 'broad', outDir: out, capturePath: BROAD_CAPTURE });
    const spec = csvChartSpec('Velocity');
    assert.ok(spec, 'Velocity 必须在 CSV_CHARTS 里');
    const buffer = renderChartCsv(project, capture, spec);
    return { buffer, lines: buffer.toString('utf8').replace(/^\uFEFF/, '').split('\r\n').slice(0, -1) };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

test('Velocity is the 13th chart, fed by BESTVEL, with the catalog\'s five columns', () => {
  assert.equal(CSV_CHARTS.length, 13, '12 张旧图 + Velocity');
  const spec = csvChartSpec('Velocity');
  assert.ok(spec);
  assert.equal(spec.message, 'BESTVEL');
  assert.deepEqual(spec.columns.map((column) => column.header), [
    'North Vel',
    'East Vel',
    'Up Vel',
    'Horizontal Speed',
    '3D Speed',
  ]);
  // 每一列都是 %.6f —— 这份 golden 里 300 个数字格全是六位小数，没有一格被裁掉尾零。
  assert.deepEqual(spec.columns.map((column) => column.format), ['fixed6', 'fixed6', 'fixed6', 'fixed6', 'fixed6']);
});

test('broad 的 Velocity.csv 与 Graph 2.11.0 的导出逐字节相同（除项目信息头）', () => {
  const golden = goldenLines();
  const ours = renderBroadVelocity().lines;

  assert.equal(golden.length, 67, '6 行项目信息 + 表头 + 60 行数据');
  assert.equal(ours.length, golden.length, '行数一致');
  // 0…5 是 `#` 项目信息，随导出目录 / 数据文件名 / .gpf 时间窗变化；从表头开始必须一模一样。
  assert.equal(ours[6], golden[6], '表头逐字一致');
  assert.equal(ours[6], 'timestamp (GPS week sec),North Vel,East Vel,Up Vel,Horizontal Speed,3D Speed');
  for (let i = 6; i < golden.length; i += 1) {
    assert.equal(ours[i], golden[i], `第 ${i - 5} 行与 golden 不一致`);
  }
  const body = ours.slice(7).join('\n');
  assert.equal(body, golden.slice(7).join('\n'), '60 行数据整段一致');
});

test('正负号不同的几行逐字节一致：首行、末行、以及 N/E 异号的两行', () => {
  const golden = goldenLines();
  const ours = renderBroadVelocity().lines;
  const at = (lines: string[], index: number) => lines[index];

  const firstData = 7;
  const lastData = golden.length - 1;
  assert.equal(at(ours, firstData), '2442  467950.000,0.010496,-0.006693,0.015072,0.012449,0.019549');
  assert.equal(at(ours, firstData), at(golden, firstData), '首行');

  assert.equal(at(ours, lastData), '2442  468009.000,0.009776,-0.011415,-0.032999,0.015029,0.036261');
  assert.equal(at(ours, lastData), at(golden, lastData), '末行');

  // 南北与东西方向相反的样本都在 golden 里，两头各取一条（一条北正东负、一条北负东正）。
  const opposite: number[] = [];
  for (let index = firstData; index <= lastData; index += 1) {
    const cells = at(golden, index).split(',').slice(1).map(Number);
    assert.equal(cells.length, 5);
    if (Math.sign(cells[0]) !== Math.sign(cells[1]) && cells[0] !== 0 && cells[1] !== 0) opposite.push(index);
  }
  assert.ok(opposite.length >= 2, 'golden 里至少有两条 N/E 异号的行');
  for (const index of [opposite[0], opposite[opposite.length - 1]]) {
    assert.equal(at(ours, index), at(golden, index), `第 ${index - 6} 行（N/E 异号）`);
  }

  // 还有一行三项全负：负的南北、东西和垂直速度都是真的量，不能被 abs() 吃掉。
  const allNegative = Array.from({ length: lastData - firstData + 1 }, (_, offset) => firstData + offset)
    .find((index) => at(golden, index).split(',').slice(1, 4).every((cell) => Number(cell) < 0));
  assert.ok(allNegative !== undefined, 'golden 里有一行 N/E/U 全负');
  assert.equal(at(ours, allNegative!), at(golden, allNegative!), `第 ${allNegative! - 6} 行（全负）`);
});

test('列换算：North/East 由 speed·cos/sin(track°) 得出，Horizontal/3D 是 hypot', () => {
  const capture = loadCapture(BROAD_CAPTURE);
  const records = capture.byName('BESTVEL');
  assert.equal(records.length, 60, 'broad-clean.gps 里 60 条 BESTVEL');
  // 数据源自己的窗口：golden 的第一行就是第一条 BESTVEL，最后一行的秒数也一致。
  assert.equal(records[0].milliseconds, 467_950_000);
  assert.equal(records[records.length - 1].milliseconds, 468_009_000);

  const golden = goldenLines().slice(7);
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const speed = field(record, 'horizontal_speed');
    const track = (field(record, 'ground_track') * Math.PI) / 180;
    const north = speed * Math.cos(track);
    const east = speed * Math.sin(track);
    const up = field(record, 'z');
    const horizontal = Math.hypot(north, east);
    const three = Math.hypot(horizontal, up);
    const cells = golden[i].split(',');
    assert.equal(cells[1], formatFixedHalfEven(north, 6), `第 ${i + 1} 行 North Vel`);
    assert.equal(cells[2], formatFixedHalfEven(east, 6), `第 ${i + 1} 行 East Vel`);
    assert.equal(cells[3], formatFixedHalfEven(up, 6), `第 ${i + 1} 行 Up Vel`);
    assert.equal(cells[4], formatFixedHalfEven(horizontal, 6), `第 ${i + 1} 行 Horizontal Speed`);
    assert.equal(cells[5], formatFixedHalfEven(three, 6), `第 ${i + 1} 行 3D Speed`);
  }
});

test('HTML / PDF 报告不用改调用方：多一份 Velocity.csv 就自动多一段', async () => {
  const { buildHtmlReport } = await import('../src/html.ts');
  const { buildPdfReport } = await import('../src/pdf.ts');
  const capture = loadCapture(BROAD_CAPTURE);
  const project = projectFromCapture(capture, { name: 'broad', outDir: tmpdir(), capturePath: BROAD_CAPTURE });
  const spec = csvChartSpec('Velocity')!;
  const csv = renderChartCsv(project, capture, spec).toString('utf8');

  const html = buildHtmlReport(project, [{ title: 'Velocity', csv }]);
  assert.ok(html.includes('<h3>Velocity</h3>'), 'HTML 里有 Velocity 的图');
  assert.ok(html.includes('<h2>PVT</h2>'), 'Velocity 归在 PVT 段，不是一份无名报告');

  const pdf = Buffer.from(buildPdfReport(project, [{ title: 'Velocity', csv }])).toString('latin1');
  assert.ok(pdf.includes('(Velocity)'), 'PDF 里有 Velocity 这一页');
});

test('没有 BESTVEL 的 clean 不产出 Velocity.csv；有 BESTVEL 的 b1 产出的是真数据，不是空壳', () => {
  const clean = loadProject(CLEAN_GPF);
  const cleanRecords = loadCapture(CLEAN_CAPTURE);
  assert.equal(cleanRecords.byName('BESTVEL').length, 0);
  const cleanTitles = exportCsv(clean, cleanRecords).map((result) => result.fileName);
  assert.equal(cleanTitles.length, 12, 'clean 仍然是 12 份');
  assert.ok(!cleanTitles.includes('Velocity.csv'), 'clean 不该多出空的 Velocity.csv');

  // `b1-20261101.sbf` 里**有** 25 条 BESTVEL（570231–570255，全在工程的时间窗内），所以重导之后
  // b1 是 13 份 —— 多出来的那份是真曲线，25 行，不是「空文件」。
  const b1Raw = loadCapture(B1_CAPTURE);
  const b1 = cleanCapture(b1Raw).capture;
  assert.equal(b1.byName('BESTVEL').length, 25);
  const b1Project = projectFromCapture(b1, { name: 'b1', outDir: tmpdir(), capturePath: B1_CAPTURE });
  const b1Exports = exportCsv(b1Project, b1);
  assert.equal(b1Exports.length, 13, 'b1 是 13 份');
  const b1Velocity = b1Exports.find((result) => result.fileName === 'Velocity.csv');
  assert.ok(b1Velocity, 'b1 有 BESTVEL，Velocity.csv 必须出现');
  const rows = b1Velocity!.buffer.toString('utf8').split('\r\n').filter((line) => /^\d/.test(line));
  assert.equal(rows.length, 25, '25 行数据，不是空文件');
  assert.equal(rows[0].split(',')[0], '2442  570231.000');
  assert.equal(rows[24].split(',')[0], '2442  570255.000');

  // 盘上的样本与工具输出一致：clean 没有这个文件，b1 有。
  assert.ok(!existsSync(join(SAMPLES, 'graph', 'export', 'csv', 'Velocity.csv')), 'clean 的 golden 里不该有');
  assert.ok(existsSync(join(SAMPLES, 'graph', 'export', 'b1', 'csv', 'Velocity.csv')), 'b1 的样本里有');
});
