/**
 * The four Graph tabs under Overview — PVT / Tracking & Measurements / Receiver Status / Project
 * Information — are real charts, not placeholders. Three things here can rot silently, so all three
 * are pinned:
 *
 *   1. the catalog wiring (`C_图表目录.json` → `CHART_GROUPS` → pane markup),
 *   2. the `/api/graph/data` contract each tile depends on (one numeric column per call, and the
 *      exact column counts the CSVs have),
 *   3. the SVG a tile produces from a real CSV column — axis labels, series count, and the numbers
 *      themselves, read back out of the markup and compared with the file.
 *
 *   node --test --test-force-exit "packages/app/test/*.test.ts"
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHART_GROUPS,
  chartSvgFor,
  chartTicks,
  chartsOf,
  constellationOf,
  formatTick,
  gpsWeekLabel,
  paneBody,
  parseGpsCell,
  seriesColor,
} from '../src/web/panels/graph.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const graphCsvDir = join(repoRoot, '逆向', '00_来源', 'samples', 'graph', 'export', 'csv');
/** Graph 2.11.0 对 `broad` 工程的真实导出（13 份，含 `Velocity.csv`；clean 没有 BESTVEL）。 */
const broadCsvDir = join(repoRoot, '逆向', '00_来源', 'samples', 'graph', 'export-broad', 'csv');

/* ---------------- the real server ---------------- */

let child: ChildProcessWithoutNullStreams | null = null;
let base = '';
let stderr = '';

function waitForReady(proc: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let stdout = '';
    const timer = setTimeout(
      () => reject(new Error(`server did not start in 20s\nstderr:\n${stderr}`)),
      20_000,
    );
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolveReady(Number(match[1]));
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})\n${stderr}`));
    });
  });
}

interface GraphPayload {
  name: string;
  rows: number;
  columns: string[];
  numericColumns: Array<{ index: number; name: string }>;
  column: string | null;
  series: {
    label: string | null;
    xLabel: string;
    xKind: 'time' | 'index';
    points: Array<[number, number]>;
    xStartLabel: string;
    xEndLabel: string;
    spanSeconds: number | null;
  };
  table: { columns: string[]; rows: string[][] };
  comments: Record<string, string>;
}

async function getData(file: string, column?: string): Promise<GraphPayload> {
  const search = new URLSearchParams({ file });
  if (column) search.set('column', column);
  const response = await fetch(`${base}/api/graph/data?${search.toString()}`);
  assert.equal(response.status, 200, `GET /api/graph/data?file=${file}`);
  return (await response.json()) as GraphPayload;
}

before(async () => {
  child = spawn(process.execPath, [serverPath, '--port', '0'], { stdio: 'pipe' });
  const port = await waitForReady(child);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  if (child && !child.killed) child.kill();
});

/* ---------------- 1. catalog wiring ---------------- */

test('每个页签的图块与附录 C 的目录一致，且都有 CSV', () => {
  assert.deepEqual(CHART_GROUPS.map((group) => group.id), ['pvt', 'tracking', 'receiver']);
  assert.equal(CHART_GROUPS[0].label, 'PVT');
  assert.equal(CHART_GROUPS[1].label, 'Tracking & Measurements');
  assert.equal(CHART_GROUPS[2].label, 'Receiver Status');

  // 附录 C：PVT 7 张、Tracking 3 张、Receiver Status 3 张。每一张都有一块图块 —— 工程没导出
  // `Velocity.csv` 时那块图块留空（脚注写明），而不是把图块删掉。
  assert.equal(CHART_GROUPS[0].catalog.length, 7);
  assert.equal(CHART_GROUPS[1].catalog.length, 3);
  assert.equal(CHART_GROUPS[2].catalog.length, 3);
  assert.equal(CHART_GROUPS[0].charts.length, 7);
  assert.equal(CHART_GROUPS[1].charts.length, 3);
  assert.equal(CHART_GROUPS[2].charts.length, 3);

  const titles = CHART_GROUPS.flatMap((group) => group.charts.map((chart) => chart.title));
  // catalog 里出现的每一张图，要么画了，要么在"没有 CSV"的名单里 —— 不能凭空消失
  for (const group of CHART_GROUPS) {
    const drawn = group.charts.map((chart) => chart.title);
    for (const title of drawn) assert.ok(group.catalog.includes(title), `${title} 不在目录里`);
  }
  assert.deepEqual(titles.slice(0, 3), ['Position Type', 'Position Status', 'Position SD']);

  // 每块图盯住一份真实存在的 CSV。`Velocity.csv` 只在 broad 导出里（clean / b1 没有 BESTVEL），
  // 所以两个目录都看。
  for (const chart of CHART_GROUPS.flatMap((group) => group.charts)) {
    const dir = existsSync(join(graphCsvDir, chart.file)) ? graphCsvDir : broadCsvDir;
    const header = readFileSync(join(dir, chart.file), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    const columns = (header.find((line) => line.trim() && !line.startsWith('#')) ?? '').split(',');
    assert.ok(columns.length > 1, `${chart.file} 读得出表头`);
  }

  // 单位与类型逐字来自目录
  const byTitle = new Map(CHART_GROUPS.flatMap((group) => group.charts).map((chart) => [chart.title, chart]));
  assert.equal(byTitle.get('Position SD')!.units, '(m)');
  assert.equal(byTitle.get('Height')!.units, '(m)');
  assert.equal(byTitle.get('Position Type')!.kind, 'category');
  assert.equal(byTitle.get('Position Status')!.kind, 'category');
  assert.equal(byTitle.get('2D Trajectory')!.kind, 'geomap');
  assert.equal(byTitle.get('Velocity')!.kind, 'line');
  assert.equal(byTitle.get('Velocity')!.units, '(m/s)');
  assert.equal(byTitle.get('Velocity')!.file, 'Velocity.csv');
  assert.equal(byTitle.get('Velocity')!.minYZero, undefined, '目录里 Velocity 没有 minYZero');
  assert.equal(byTitle.get('GNSS Signal Strength')!.units, 'C/No (dB-Hz)');
  assert.equal(byTitle.get('Tracking Time')!.units, '(s)');
  assert.equal(byTitle.get('Tracking Time')!.minYZero, true);
  assert.equal(byTitle.get('Satellites and Signals')!.minYZero, true);
  assert.equal(byTitle.get('CPU Usage')!.units, '(%)');
  assert.equal(byTitle.get('CPU Usage')!.minYZero, true);
  assert.equal(byTitle.get('HW Monitor Status')!.minYZero, true);
  assert.equal(byTitle.get('Receiver Status')!.kind, 'bar');
});

test('页签标记：三页各一块图块，Project Information 是信息卡，没有占位文案', () => {
  assert.equal(chartsOf('pvt').length, 7);
  assert.equal(chartsOf('tracking').length, 3);
  assert.equal(chartsOf('receiver').length, 3);
  assert.deepEqual(chartsOf('project'), []);

  for (const group of CHART_GROUPS) {
    const markup = paneBody(group.id);
    for (const chart of group.charts) {
      assert.ok(
        markup.includes(`data-chart="${group.id}/${chart.id}"`),
        `${group.id} 缺少 ${chart.id} 的图块`,
      );
    }
    assert.ok(markup.includes(`data-foot="${group.id}"`), `${group.id} 缺少目录脚注`);
    assert.ok(!markup.includes('gp-placeholder'), `${group.id} 不该再有占位块`);
  }

  const project = paneBody('project');
  assert.ok(project.includes('data-chart="project/info"'));
  assert.ok(!project.includes('gp-placeholder'));

  const overview = paneBody('overview');
  assert.ok(overview.includes('class="gp-chart"'));
  assert.ok(overview.includes('gp-playhead'));
  assert.ok(!overview.includes('gp-chart-card'));
});

/* ---------------- 2. the /api/graph/data contract each tile needs ---------------- */

test('每块图要的列数：/api/graph/data 的 numericColumns 与 CSV 表头一致', async () => {
  const expected: Record<string, number> = {
    'Position SD.csv': 3,
    'Solution Statistics.csv': 4,
    '2D Trajectory.csv': 2,
    'Height.csv': 1,
    'GNSS Signal Strength.csv': 74,
    'Satellites and Signals.csv': 19,
    'Tracking Time.csv': 60,
    'CPU Usage.csv': 1,
    'HW Monitor Status.csv': 10,
    // `start` / `end` 也是数字（GPS 毫秒刻度），所以是 3 列 —— 图块只画 `value`
    'Receiver Status.csv': 3,
  };

  for (const [file, count] of Object.entries(expected)) {
    const body = await getData(file);
    assert.equal(body.name, file);
    assert.equal(body.numericColumns.length, count, `${file} 的数值列数`);
    assert.ok(body.series.points.length > 0, `${file} 至少要有一列能画`);
    // 时间列不进数值列（Receiver Status 没有时间列，所以 xKind 是 index）
    if (!file.startsWith('Receiver Status')) {
      assert.equal(body.series.xKind, 'time', `${file} 的 x 轴是时间`);
      assert.equal(typeof body.series.spanSeconds, 'number');
      if (body.rows > 1) assert.ok(body.series.spanSeconds! > 0, `${file} 的时长`);
    } else {
      assert.equal(body.series.xKind, 'index');
    }
  }
});

test('分类图（Position Type / Position Status）整份表都在前 20 行里，且只有一列标签', async () => {
  for (const file of ['Position Type.csv', 'Position Status.csv']) {
    const body = await getData(file);
    assert.equal(body.numericColumns.length, 0, `${file} 没有数值列`);
    assert.equal(body.series.points.length, 0);
    assert.equal(body.table.rows.length, body.rows, `${file} 的全部 ${body.rows} 行都在 table 里`);
    const labels = new Set(body.table.rows.map((row) => row[1]));
    assert.equal(labels.size, 1, `${file} 只有一个标签`);
    assert.equal([...labels][0], file.startsWith('Position Type') ? 'SINGLE' : 'SOL_COMPUTED');
  }
});

/* ---------------- 3. axis helpers + the SVG a tile produces ---------------- */

test('时间轴换算与 graphcsv.ts 一致：首帧 GPS 周/秒', () => {
  assert.equal(parseGpsCell('2442  463098.000'), 2442 * 604_800 + 463_098);
  assert.equal(parseGpsCell('  2442 463098.000 '), 2442 * 604_800 + 463_098);
  assert.equal(parseGpsCell('nope'), null);
  assert.equal(parseGpsCell(''), null);
  assert.equal(gpsWeekLabel(2442 * 604_800 + 463_098), 'W2442 463098.000');

  const first = readFileSync(join(graphCsvDir, 'Height.csv'), 'utf8')
    .split(/\r?\n/)
    .find((line) => /^\d/.test(line))!;
  assert.equal(parseGpsCell(first.split(',')[0]), 2442 * 604_800 + 463_098);
});

test('刻度均匀、首尾贴边，小数位跟着步长走', () => {
  const ticks = chartTicks(0, 4, 4);
  assert.deepEqual(ticks.values.map((value) => Number(value.toFixed(6))), [0, 1, 2, 3, 4]);
  assert.equal(ticks.step, 1);

  const span = chartTicks(66.407706, 66.429896, 4);
  assert.equal(span.values.length, 5);
  assert.equal(span.values[0], 66.407706);
  assert.equal(span.values[4], 66.429896);

  assert.equal(formatTick(66.407706, span.step), '66.40771');
  assert.equal(formatTick(4.95, 1.2375), '4.95');
  assert.equal(formatTick(2500, 175), '2500');
  assert.equal(formatTick(0, 1), '0');
  assert.equal(formatTick(1, 1), '1');
  // 退化区间不会返回空刻度
  assert.equal(chartTicks(5, 5, 4).values.length, 1);
});

test('配色与星座分组是确定性的', () => {
  assert.equal(seriesColor(0), '#00516f');
  assert.equal(seriesColor(1), '#00abc8');
  assert.equal(seriesColor(10), seriesColor(0));
  assert.equal(seriesColor(-1), '#00abc8');
  assert.equal(constellationOf('GPS_L1_CA_2'), 'GPS');
  assert.equal(constellationOf('BEIDOU_B1I_D2_1'), 'BEIDOU');
  assert.equal(constellationOf('Signals_QZSS_L5_Q'), 'QZSS');
  assert.equal(constellationOf('Satellites_Total'), '');
  assert.equal(constellationOf('Differential Lag'), '');
});

test('Height 图：SVG 的折线点数、首末值、纵轴刻度都对得上 CSV', async () => {
  const body = await getData('Height.csv', 'Height');
  const values = body.series.points.map((point) => point[1]);
  assert.equal(values.length, 5);

  const model = {
    kind: 'line',
    title: 'Height',
    units: '(m)',
    xLabel: body.series.xLabel,
    xStartLabel: body.series.xStartLabel,
    xEndLabel: body.series.xEndLabel,
    series: [{ name: 'Height', color: seriesColor(0), points: body.series.points }],
  };
  const svg = chartSvgFor(model, 800, 240);

  assert.match(svg, /^<svg viewBox="0 0 800 240"/);
  assert.match(svg, /<polyline /);
  const points = /points="([^"]+)"/.exec(svg)![1].trim().split(/\s+/);
  assert.equal(points.length, 5, '每个样本一个点');
  // 首点在左轴内，末点在右轴内
  for (const point of points) {
    const [x, y] = point.split(',').map(Number);
    assert.ok(x >= 72 && x <= 800 - 26, `x=${x} 在绘图区内`);
    assert.ok(y >= 34 && y <= 34 + 240 - 34 - 48, `y=${y} 在绘图区内`);
  }

  // 纵轴 5 个刻度，第一个是 yMin、最后一个是 yMax
  const yLabels = [...svg.matchAll(/text-anchor="end" font-family="Consolas, monospace">([^<]+)</g)]
    .map((match) => match[1]);
  assert.equal(yLabels.length, 5);
  const min = Math.min(...values);
  const max = Math.max(...values);
  assert.equal(yLabels[0], formatTick(min, (max - min) / 4));
  assert.equal(yLabels[4], formatTick(max, (max - min) / 4));
  // 序列的极值确实落在最上/最下的刻度上：max 在 plot 顶，min 在 plot 底
  const ys = points.map((point) => Number(point.split(',')[1]));
  assert.ok(Math.abs(Math.min(...ys) - 34) < 0.11, '最大值贴顶');
  assert.ok(Math.abs(Math.max(...ys) - (34 + 240 - 34 - 48)) < 0.11, '最小值贴底');

  // x 轴脚注是时间轴标签，不是"行序号"
  assert.match(svg, /时间（相对首帧，s）/);
  assert.match(svg, /W2442 463098\.000/);
});

test('多序列：Position SD 三条线用三个颜色，图例关掉一条后只剩两条', async () => {
  const body = await getData('Position SD.csv');
  const names = body.numericColumns.map((column) => column.name);
  assert.deepEqual(names, ['Latitude SD', 'Longitude SD', 'Height SD']);

  const series = [];
  for (let index = 0; index < names.length; index += 1) {
    const payload = await getData('Position SD.csv', names[index]);
    assert.equal(payload.column, names[index]);
    series.push({ name: names[index], color: seriesColor(index), points: payload.series.points });
  }
  assert.equal(new Set(series.map((item) => item.color)).size, 3);

  const model = { kind: 'line', title: 'Position SD', units: '(m)', xLabel: body.series.xLabel, series };
  const full = chartSvgFor(model, 800, 240);
  assert.equal((full.match(/<polyline /g) ?? []).length, 3);

  const hidden = { ...model, series: series.map((item, index) => ({ ...item, hidden: index === 1 })) };
  assert.equal((chartSvgFor(hidden, 800, 240).match(/<polyline /g) ?? []).length, 2);
});

test('柱状图（Receiver Status）画方框不画折线；分类图（Position Type）画色带', async () => {
  const body = await getData('Receiver Status.csv', 'value');
  assert.equal(body.series.label, 'value');
  assert.equal(body.rows, 5);
  assert.deepEqual(body.table.columns, ['name', 'start', 'end', 'value']);
  assert.ok(body.series.points.every((point) => point[1] === 1), '五条条件都记为 1');

  const bar = chartSvgFor({
    kind: 'bar',
    title: 'Receiver Status',
    xLabel: body.series.xLabel,
    series: [{ name: 'value', color: seriesColor(0), points: body.series.points }],
  }, 800, 240);
  assert.match(bar, /<rect /);
  assert.ok(!bar.includes('<polyline'));
  assert.equal((bar.match(/<rect /g) ?? []).length, 5, '五个条件各一根柱');
  // 柱状图的纵轴隐藏（原版 `show: chartType !== "bar"`），所以没有 y 刻度文字
  assert.equal([...bar.matchAll(/text-anchor="end"/g)].length, 0);

  const type = await getData('Position Type.csv');
  const base = parseGpsCell(type.table.rows[0][0])!;
  const samples = type.table.rows.map((row, index) => ({
    x: Math.round(((parseGpsCell(row[0]) ?? 0) - base) * 1000) / 1000,
    label: row[1],
  }));
  const category = chartSvgFor({
    kind: 'category',
    title: 'Position Type',
    xLabel: '时间（相对首帧，s）',
    xStartLabel: gpsWeekLabel(base),
    series: [{ name: 'SINGLE', color: seriesColor(0), points: samples.map((sample) => [sample.x, 1]) }],
  }, 800, 240);
  assert.equal((category.match(/<rect /g) ?? []).length, 5);
  assert.ok(!category.includes('<polyline'));
  assert.match(category, /W2442 463098\.000/);
});

test('2D Trajectory 按经纬度配对；只有 5 个同点样本时给出说明而非假轨迹', async () => {
  const lon = await getData('2D Trajectory.csv', 'Longitude');
  const lat = await getData('2D Trajectory.csv', 'Latitude');
  assert.equal(lon.series.points.length, lat.series.points.length);
  const points = lon.series.points.map((point, index) => [point[1], lat.series.points[index][1]]);
  assert.equal(points.length, 5);
  for (const point of points) {
    assert.ok(Math.abs(point[0] - 114.352811) < 1e-9);
    assert.ok(Math.abs(point[1] - 30.539975) < 1e-9);
  }

  const svg = chartSvgFor({
    kind: 'geomap',
    title: '2D Trajectory',
    xLabel: 'Longitude (degrees) · Latitude (degrees)',
    xStartLabel: '114.35281',
    xEndLabel: '114.35281',
    series: [{ name: 'Longitude / Latitude', color: '#5464f8', points }],
  }, 800, 240);
  assert.equal((svg.match(/<circle /g) ?? []).length, 5);
  assert.ok(!svg.includes('<polyline'), '经纬度全相同的样本不该被连成轨迹线');
  assert.match(svg, /Longitude \(degrees\)/);
});

test('没有可画的数据时给出空状态而不是空 SVG', () => {
  assert.equal(chartSvgFor({ kind: 'line', series: [] }, 800, 240),
    '<div class="gp-chart-empty">没有可绘制的数据点。</div>');
  assert.equal(
    chartSvgFor({ kind: 'line', series: [{ name: 'a', points: [] }] }, 800, 240),
    '<div class="gp-chart-empty">没有可绘制的数据点。</div>',
  );
  assert.equal(chartSvgFor(null, 800, 240), '');
});
