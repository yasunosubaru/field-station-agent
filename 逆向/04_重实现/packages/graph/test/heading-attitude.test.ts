/**
 * `Heading & Attitude` — the three Graph plots this build used to have no tab, no tile and no CSV
 * for (`Azimuth`, `Roll and Pitch`, `SPAN Filter Updates`).
 *
 * **No receiver produced any of this.** The machine that drove Graph 2.11.0 has `ANTENNA=SINGLE`,
 * no IMU and IMU/INS `UNAUTHORIZED`, so no export with an INS solution exists and there is no
 * original CSV to compare against. Two kinds of evidence are used instead, and they are not mixed:
 *
 *  1. **The shipped original program** decides the wiring. `C_图表目录.json` (extracted from
 *     `01_解包/Graph/out/renderer/assets/index-B86bHcCD.js`) names the group, the three titles, the
 *     chart types and the y-axis units; `graph-node-wrapper.node` decides the CSV titles
 *     (`DbToCsvBaseNames`), the table columns (`INSATTITUDE`/`INSUPDATE` constructors) and which log
 *     feeds which plot (the per-chart `Priority` table). All of that is asserted verbatim below.
 *  2. **A synthetic capture** decides the numbers. `make-heading-capture.ts` writes INSPVAX frames
 *     whose roll/pitch/azimuth are `1.5…6.5` / `-0.75…-5.75` / `100.125…105.125`, plus HEADING2
 *     frames whose heading is `45…47` and a `DUALANTENNAALIGN` text command. The test asserts the
 *     exported cells are *those* fields (a wrong column mapping would show 45/46/47 or a swapped
 *     pitch/roll) and that the HEADING2 decoy reaches no CSV at all.
 *
 * The span rule of `SPAN Filter Updates` is the one thing that is **inferred**: no original export
 * of it exists anywhere here, so it reuses the rule proven for the sibling span table
 * `Receiver Status.csv`. The test pins what the code does; it does not claim byte-parity with
 * Graph. See `03_分析/13_Graph分析页.md`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { field, loadCapture } from '../src/capture.ts';
import { CSV_CHARTS, csvChartSpec, exportCsv, renderChartCsv } from '../src/csv.ts';
import { cleanCapture, plotSummaryOf, projectFromCapture } from '../tools/export-sbf-project.ts';
import { headingCapture, headingOnlyCapture } from '../tools/make-heading-capture.ts';
import { CHART_GROUPS, chartsOf, paneBody } from '../../app/src/web/panels/graph.js';

const here = dirname(fileURLToPath(import.meta.url));
const REVERSE = join(here, '..', '..', '..', '..');
const CATALOG = join(REVERSE, '03_分析', '06_Graph应用-附录', 'C_图表目录.json');
const SYNTH_CAPTURE = join(REVERSE, '00_来源', 'samples', 'graph', 'synthetic', 'heading.sbf');
const SYNTH_EXPORT = join(REVERSE, '00_来源', 'samples', 'graph', 'export', 'heading', 'csv');

/** The synthetic capture, written once per run into a throw-away directory. */
function syntheticProject(): {
  capture: ReturnType<typeof loadCapture>;
  project: ReturnType<typeof projectFromCapture>;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'graph-heading-'));
  const path = join(dir, 'heading.sbf');
  writeFileSync(path, headingCapture());
  const capture = cleanCapture(loadCapture(path)).capture;
  const project = projectFromCapture(capture, { name: 'heading', outDir: dir, capturePath: path });
  return { capture, project, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One exported CSV as its lines, BOM stripped, trailing CRLF dropped. */
function csvLines(buffer: Buffer): string[] {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  assert.ok(text.includes('\r\n'), 'Graph 写 CRLF');
  assert.ok(text.endsWith('\r\n'), '最后一行后面也有 CRLF');
  return text.split('\r\n').slice(0, -1);
}

/* ---------------- 1. the original program's catalog decides the wiring ---------------- */

test('目录证据：Heading & Attitude 的页签名 / 三张图 / 类型 / 单位逐字来自 C_图表目录.json', () => {
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8')) as {
    groups: Record<string, { legend: string; plots: Array<{ title: string; chartType: string; yAxisUnits: string }> }>;
  };
  const original = catalog.groups['Heading & Attitude'];
  assert.ok(original, '原始目录里有 Heading & Attitude 组');
  assert.equal(original.legend, 'Heading & Attitude');
  assert.deepEqual(original.plots.map((plot) => plot.title), ['Azimuth', 'Roll and Pitch', 'SPAN Filter Updates']);
  assert.deepEqual(original.plots.map((plot) => plot.chartType), ['line', 'line', 'bar']);
  assert.deepEqual(original.plots.map((plot) => plot.yAxisUnits), ['(degrees)', '(degrees)', '']);

  const group = CHART_GROUPS.find((item) => item.id === 'heading');
  assert.ok(group, '面板里必须有 heading 页签');
  assert.equal(group.label, 'Heading & Attitude');
  assert.deepEqual(group.catalog, original.plots.map((plot) => plot.title));
  assert.equal(group.charts.length, 3, '三张图各一块图块 —— 目录里没有「没有图块」的图了');

  const byTitle = new Map(group.charts.map((chart) => [chart.title, chart]));
  assert.equal(byTitle.get('Azimuth').kind, 'line');
  assert.equal(byTitle.get('Azimuth').units, '(degrees)');
  assert.equal(byTitle.get('Roll and Pitch').kind, 'line');
  assert.equal(byTitle.get('Roll and Pitch').units, '(degrees)');
  assert.equal(byTitle.get('SPAN Filter Updates').kind, 'bar');

  // CSV 文件名是原生模块 `DbToCsvConverter` 的 `kDbBaseNames`：`Azimuth` / `Roll and Pitch` /
  // `SPAN Filter Updates`，与标题同名。
  assert.deepEqual(group.charts.map((chart) => chart.file), [
    'Azimuth.csv', 'Roll and Pitch.csv', 'SPAN Filter Updates.csv',
  ]);
});

test('页签顺序与原版一致：Overview → PVT → Heading & Attitude → Tracking → Receiver Status', () => {
  assert.deepEqual(CHART_GROUPS.map((group) => group.id), ['pvt', 'heading', 'tracking', 'receiver']);
  assert.deepEqual(CHART_GROUPS.map((group) => group.label), [
    'PVT', 'Heading & Attitude', 'Tracking & Measurements', 'Receiver Status',
  ]);
  assert.equal(chartsOf('heading').length, 3);
  for (const id of ['azimuth', 'roll-pitch', 'span-updates']) {
    assert.ok(paneBody('heading').includes(`data-chart="heading/${id}"`), `缺少 ${id} 的图块`);
  }
  assert.ok(paneBody('heading').includes('data-foot="heading"'));
});

test('CSV 图表定义：列名与原生模块的 CREATE TABLE 一致（INS Pitch 在 INS Roll 之前）', () => {
  const azimuth = csvChartSpec('Azimuth')!;
  const pitch = csvChartSpec('Roll and Pitch')!;
  const span = csvChartSpec('SPAN Filter Updates')!;
  assert.ok(azimuth && pitch && span, '三张图都在 CSV_CHARTS 里');

  assert.deepEqual(azimuth.columns.map((column) => column.header), ['INS Azimuth']);
  assert.deepEqual(pitch.columns.map((column) => column.header), ['INS Pitch', 'INS Roll']);
  assert.deepEqual(azimuth.columns.map((column) => column.format), ['fixed6']);

  // PlotSummary 的键是原版 HA 解析器写的「INS Orientation …」，与 CSV 标题不同；靠 plot 别名对上。
  assert.deepEqual(azimuth.plot, { title: 'INS Orientation Azimuth', message: 'insattitude_azimuth' });
  assert.deepEqual(pitch.plot, { title: 'INS Orientation Pitch', message: 'insattitude_pitch' });
  assert.deepEqual(span.plot, { title: 'SPAN Filter Updates', message: 'insUpdatestatus' });

  // 消息优先级：INSPVAX(1465) → INSPVA(507) → INSPVAS(508) → INSATTX(1457) → INSATT(263) → INSPVACMP(1889)。
  const sources = ['INSPVAX', 'INSPVA', 'INSPVAS', 'INSATTX', 'INSATT', 'INSPVACMP'];
  assert.deepEqual(azimuth.sourceMessages, sources);
  assert.deepEqual(pitch.sourceMessages, sources);
  // HEADING2 / DUALANTENNAALIGN 不在原版这张表里，因此不能作为数据源。
  for (const spec of [azimuth, pitch, span]) {
    assert.ok(!spec.sourceMessages!.includes('HEADING2'));
    assert.ok(!spec.sourceMessages!.includes('DUALANTENNAALIGN'));
  }
});

/* ---------------- 2. the synthetic capture decides the numbers ---------------- */

test('合成抓包：导出三份 CSV，表头与列序逐字对得上', () => {
  const { capture, project, cleanup } = syntheticProject();
  try {
    assert.equal(capture.byName('INSPVAX').length, 6, '6 帧 INSPVAX');
    assert.equal(capture.byName('HEADING2').length, 3, '3 帧 HEADING2（诱饵）');
    const written = exportCsv(project, capture).map((result) => result.fileName);
    assert.deepEqual(written, ['Azimuth.csv', 'Roll and Pitch.csv', 'SPAN Filter Updates.csv']);

    const azimuth = csvLines(renderChartCsv(project, capture, csvChartSpec('Azimuth')!));
    const pitch = csvLines(renderChartCsv(project, capture, csvChartSpec('Roll and Pitch')!));
    const span = csvLines(renderChartCsv(project, capture, csvChartSpec('SPAN Filter Updates')!));

    assert.equal(azimuth[6], 'timestamp (GPS week sec),INS Azimuth');
    assert.equal(pitch[6], 'timestamp (GPS week sec),INS Pitch,INS Roll');
    assert.equal(span[6], 'name,start,end,value,min_diff');
    assert.equal(azimuth.length, 6 + 1 + 6, '6 行项目信息 + 表头 + 6 行数据');
  } finally {
    cleanup();
  }
});

test('数值来自正确的字段：azimuth / pitch / roll，六位小数，不是别的列顶替', () => {
  const { capture, project, cleanup } = syntheticProject();
  try {
    const records = capture.byName('INSPVAX');
    assert.deepEqual(records.map((record) => field(record, 'azimuth')), [100.125, 101.125, 102.125, 103.125, 104.125, 105.125]);
    assert.deepEqual(records.map((record) => field(record, 'pitch')), [-0.75, -1.75, -2.75, -3.75, -4.75, -5.75]);
    assert.deepEqual(records.map((record) => field(record, 'roll')), [1.5, 2.5, 3.5, 4.5, 5.5, 6.5]);

    const azimuth = csvLines(renderChartCsv(project, capture, csvChartSpec('Azimuth')!)).slice(7);
    assert.deepEqual(azimuth, [
      '2442  470000.000,100.125000',
      '2442  470001.000,101.125000',
      '2442  470002.000,102.125000',
      '2442  470003.000,103.125000',
      '2442  470004.000,104.125000',
      '2442  470005.000,105.125000',
    ]);

    const pitch = csvLines(renderChartCsv(project, capture, csvChartSpec('Roll and Pitch')!)).slice(7);
    assert.deepEqual(pitch, [
      '2442  470000.000,-0.750000,1.500000',
      '2442  470001.000,-1.750000,2.500000',
      '2442  470002.000,-2.750000,3.500000',
      '2442  470003.000,-3.750000,4.500000',
      '2442  470004.000,-4.750000,5.500000',
      '2442  470005.000,-5.750000,6.500000',
    ]);
  } finally {
    cleanup();
  }
});

test('HEADING2 是诱饵：它的 heading 45/46/47 不出现在任何一份 Heading & Attitude CSV 里', () => {
  const { capture, project, cleanup } = syntheticProject();
  try {
    const headings = capture.byName('HEADING2').map((record) => field(record, 'heading'));
    assert.deepEqual(headings, [45, 46, 47]);
    for (const title of ['Azimuth', 'Roll and Pitch', 'SPAN Filter Updates']) {
      const text = renderChartCsv(project, capture, csvChartSpec(title)!).toString('utf8');
      for (const value of ['45.000000', '46.000000', '47.000000', '135.000000']) {
        assert.ok(!text.includes(value), `${title}.csv 不该含 HEADING2 的 ${value}`);
      }
    }
    // DUALANTENNAALIGN 是 ASCII 命令，解码器不认识它，因此连消息计数里都没有。
    assert.equal(capture.byName('DUALANTENNAALIGN').length, 0);
  } finally {
    cleanup();
  }
});

test('SPAN Filter Updates：INS 状态位 → 条件名，区间与 min_diff（推断规则，未实机验证）', () => {
  const { capture, project, cleanup } = syntheticProject();
  try {
    // 位 0 每帧都置（Position update）；位 4 只在第 3、4 帧（ALIGN (heading) update）；
    // 位 25 从第 5 帧起（Alignment direction verified）。
    const lines = csvLines(renderChartCsv(project, capture, csvChartSpec('SPAN Filter Updates')!)).slice(7);
    assert.deepEqual(lines, [
      'ALIGN (heading) update,1477391602000.000000,1477391604000.000000,1,1.000000',
      'Alignment direction verified,1477391604000.000000,1477391605000.000000,1,1.000000',
      'Position update,1477391600000.000000,1477391605000.000000,1,1.000000',
    ]);
    // `min_diff` 写的是**秒**（渲染器乘 1000 后按它步进）；这里是 1 Hz 的采样间隔。
    assert.ok(lines.every((line) => line.endsWith(',1,1.000000')));
  } finally {
    cleanup();
  }
});

/* ---------------- 3. the project summary the exporter writes ---------------- */

test('PlotSummary：Heading_Attitude 段用原版那三个键与伪消息名，计数来自抓包', () => {
  const { capture, cleanup } = syntheticProject();
  try {
    const summary = plotSummaryOf(capture) as Record<string, Record<string, Record<string, number>>>;
    assert.ok(!summary.PVT, '合成抓包里没有 BESTPOS，PVT 段不该出现');
    const heading = summary.Heading_Attitude;
    assert.ok(heading, '有 INSPVAX 就必须有 Heading_Attitude 段');
    assert.deepEqual(Object.keys(heading).sort(), [
      'INS Orientation Azimuth', 'INS Orientation Pitch', 'SPAN Filter Updates',
    ]);
    // 一次 INS 帧同时计入 pitch 与 azimuth（`INSATTITUDE::addPoint` 两个计数一起加）。
    assert.deepEqual(heading['INS Orientation Azimuth'], { insattitude_azimuth: 6 });
    assert.deepEqual(heading['INS Orientation Pitch'], { insattitude_pitch: 6 });
    assert.deepEqual(heading['SPAN Filter Updates'], { insUpdatestatus: 6 });
  } finally {
    cleanup();
  }
});

test('只有 HEADING2 / DUALANTENNAALIGN 的抓包不产出任何 Heading & Attitude CSV（与原版一致）', () => {
  // 原版的 per-chart Priority 表里没有 1335 / 1761 —— 双天线航向不喂任何一张图。
  const dir = mkdtempSync(join(tmpdir(), 'graph-heading-only-'));
  try {
    const path = join(dir, 'heading2.sbf');
    writeFileSync(path, headingOnlyCapture());
    const capture = cleanCapture(loadCapture(path)).capture;
    assert.equal(capture.byName('INSPVAX').length, 0);
    assert.equal(capture.byName('HEADING2').length, 3, '诱饵确实在抓包里');

    const summary = plotSummaryOf(capture) as Record<string, unknown>;
    assert.ok(!summary.Heading_Attitude, '没有 INS 帧就没有 Heading_Attitude 段');

    const project = projectFromCapture(capture, { name: 'heading2', outDir: dir, capturePath: path });
    assert.deepEqual(exportCsv(project, capture).map((result) => result.fileName), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- 4. the checked-in sample matches the tool ---------------- */

test('仓库里的样本工程就是这份合成抓包的产物（未实机验证）', () => {
  const onDisk = readFileSync(join(SYNTH_EXPORT, 'Azimuth.csv'), 'utf8');
  assert.ok(onDisk.includes('timestamp (GPS week sec),INS Azimuth'));
  assert.ok(readFileSync(join(SYNTH_EXPORT, 'Roll and Pitch.csv'), 'utf8').includes(
    'timestamp (GPS week sec),INS Pitch,INS Roll',
  ));
  assert.ok(readFileSync(join(SYNTH_EXPORT, 'SPAN Filter Updates.csv'), 'utf8').includes(
    'name,start,end,value,min_diff',
  ));
  // 抓包本身也在仓库里，两个文件对得上：抓包能解码出 6 帧 INSPVAX。
  const capture = loadCapture(SYNTH_CAPTURE);
  assert.equal(capture.byName('INSPVAX').length, 6);
  assert.equal(capture.byName('HEADING2').length, 3);
});
