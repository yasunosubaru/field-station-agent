/**
 * Graph · Overview map. The original map is LuciadRIA (commercial, not in this repo), so the stage
 * draws its own basemap; that makes three things easy to get silently wrong, and all three are
 * pinned here:
 *
 *   1. the projection — one metre is the same number of pixels on both axes, otherwise the scale bar
 *      and the 1σ circle lie even though the picture looks fine,
 *   2. the data — the vertices must be the fixes of `2D Trajectory.csv` and the same coordinates
 *      `clean.kml` carries, not something rounded or invented,
 *   3. the honesty line — `本构建不是 Luciad 地图` has to be in the pane markup, not in a tooltip.
 *
 *   node --test --test-force-exit "packages/app/test/*.test.ts"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { graphData } from '../src/graphcsv.ts';

import {
  MAP_FILE,
  MAP_LAT_COLUMN,
  MAP_LON_COLUMN,
  MAP_MIN_FIT_SPAN_M,
  MAP_SD_FILE,
  MAP_SD_LAT_COLUMN,
  MAP_SD_LON_COLUMN,
  MAP_TRACK_COLOR,
  degreeStep,
  formatDegrees,
  formatDistance,
  indexForRatio,
  latLabel,
  lonLabel,
  mapFit,
  mapProjection,
  mapSvg,
  metersPerDegree,
  niceFloor,
  niceStep,
  paneBody,
  parseGpsStamp,
  parseKmlCoordinates,
  pointDistance,
  scaleBar,
  stepDecimals,
  tickValues,
  trackExtent,
  trackLength,
  trajectoryPoints,
} from '../src/web/panels/graph.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const graphCsvDir = join(repoRoot, '逆向', '00_来源', 'samples', 'graph', 'export', 'csv');
const kmlPath = join(graphCsvDir, '..', 'clean.kml');

/**
 * The panel reads through `/api/graph/data`, and the endpoint is just `{ok:true, ...graphData()}`
 * (`server.ts` `handleGraphData`). Calling `graphData()` here keeps this file free of a spawned
 * server — a child process plus `--test-force-exit` on Windows intermittently reports the whole test
 * file as crashed (0xC0000409) during teardown, which is a harness race, not a map bug. The HTTP
 * surface itself is pinned in `app.test.ts`.
 */
function getData(file: string, column?: string) {
  return graphData(file, column ?? null);
}

/* ---------------- 1. projection maths ---------------- */

test('经纬度 → 米：一个纬度约 111 km，一个经度按 cos φ 收窄', () => {
  const per = metersPerDegree(30.539975);
  assert.equal(per.lat, 111132.9);
  assert.ok(per.lon > 95_500 && per.lon < 96_500, `30.54°N 的经度米/度 = ${per.lon}`);
  // 赤道上两者相等，两极处经度被夹住不发散
  assert.ok(Math.abs(metersPerDegree(0).lon - 111320.3) < 1e-6);
  assert.ok(Math.abs(metersPerDegree(90).lon - 111320.3 * Math.cos(89.5 * Math.PI / 180)) < 1e-6);
  assert.ok(metersPerDegree(90).lon > 0);
});

test('刻度与比例尺都取 1-2-5 阶梯，不用「漂亮但算不出来」的数', () => {
  assert.equal(niceStep(4.2e-5), 5e-5);
  assert.equal(niceStep(0.3), 0.5);
  assert.equal(niceStep(7), 10);
  assert.equal(niceStep(1), 1);
  assert.equal(niceStep(0), 1);

  assert.equal(niceFloor(0.7), 0.5);
  assert.equal(niceFloor(3), 2);
  assert.equal(niceFloor(9), 5);
  assert.equal(niceFloor(0), 0);

  // 24 m 视野 → 6 条经线，间隔 5e-5°（约 4.8 m）
  assert.equal(degreeStep(2.5e-4), 5e-5);
  assert.equal(stepDecimals(2), 0);
  assert.equal(stepDecimals(0.02), 2);
  assert.equal(stepDecimals(0.0002), 4);
  assert.equal(formatDegrees(114.35285, 5e-5), '114.35285');
  assert.equal(formatDegrees(-0.0000001, 0.5), '0.0');

  // 900 px 宽、24 m 视野 → 37.5 px/m，132 px 的尺子只能放 2 m
  const bar = scaleBar(900 / 24, 132);
  assert.equal(bar.meters, 2);
  assert.equal(bar.px, 75);
  assert.equal(bar.label, '2 m');
  assert.ok(bar.px <= 132);

  const ticks = tickValues(114.352686, 114.352936, 5e-5);
  assert.equal(ticks.length, 5);
  assert.ok(Math.abs(ticks[0] - 114.3527) < 1e-9);
  assert.ok(Math.abs(ticks[4] - 114.3529) < 1e-9);
});

test('读数与距离的写法：带半球，自发单位', () => {
  assert.equal(latLabel(30.539975), '30.539975°N');
  assert.equal(latLabel(-33.8688), '33.868800°S');
  assert.equal(lonLabel(114.352811), '114.352811°E');
  assert.equal(lonLabel(-0.1276), '0.127600°W');

  assert.equal(formatDistance(0), '0 m');
  assert.equal(formatDistance(0.35), '35 cm');
  assert.equal(formatDistance(1.5), '1.50 m');
  assert.equal(formatDistance(12.34), '12.3 m');
  assert.equal(formatDistance(260), '260 m');
  assert.equal(formatDistance(1234), '1.2 km');
  assert.equal(formatDistance(20_000), '20 km');
});

test('一米两轴同尺度：投影可逆，横竖距离用同一把尺子', () => {
  const view = { centerLon: 114.352811, centerLat: 30.539975, spanM: 240 };
  const projection = mapProjection(view, 900, 400);
  assert.equal(projection.pxPerM, 3.75);
  assert.ok(Math.abs(projection.x(114.352811) - 450) < 1e-9);
  assert.ok(Math.abs(projection.y(30.539975) - 200) < 1e-9);

  // 往返
  for (const lon of [114.3525, 114.3531]) {
    assert.ok(Math.abs(projection.lonAt(projection.x(lon)) - lon) < 1e-12);
  }
  for (const lat of [30.5395, 30.5404]) {
    assert.ok(Math.abs(projection.latAt(projection.y(lat)) - lat) < 1e-12);
  }

  // 北在上：纬度大的点画得更靠上
  assert.ok(projection.y(30.54) < projection.y(30.539));

  // 水平 100 px 与垂直 100 px 都是 100 / 3.75 m —— 比例尺和 1σ 圆靠的就是这一条
  const a = { lon: projection.lonAt(100), lat: projection.latAt(200) };
  const b = { lon: projection.lonAt(200), lat: projection.latAt(200) };
  const c = { lon: projection.lonAt(100), lat: projection.latAt(300) };
  assert.ok(Math.abs(pointDistance(a, b) - 100 / 3.75) < 1e-6);
  assert.ok(Math.abs(pointDistance(a, c) - 100 / 3.75) < 1e-6);

  // spanM 是**宽度**：竖直方向按画布比例换算
  assert.ok(Math.abs(projection.degreesPerPixel.lon - 1 / (metersPerDegree(30.539975).lon * 3.75)) < 1e-15);
});

/* ---------------- 2. trajectory helpers ---------------- */

test('经纬两列按行配对；静止轨迹长度是 0，视野仍给得出 24 m', () => {
  const lon = { series: { points: [[0, 114.352811], [1, 114.352811]] } };
  const lat = { series: { points: [[0, 30.539975], [1, 30.539975]] } };
  const points = trajectoryPoints(lon, lat);
  assert.deepEqual(points, [
    { t: 0, lon: 114.352811, lat: 30.539975 },
    { t: 1, lon: 114.352811, lat: 30.539975 },
  ]);
  assert.equal(trackLength(points), 0);

  // 行数不一致时取短的，不配对出假点
  assert.equal(trajectoryPoints(lon, { series: { points: [] } }).length, 0);
  assert.equal(trajectoryPoints(null, lat).length, 0);

  const extent = trackExtent(points);
  assert.equal(extent?.eastM, 0);
  assert.equal(extent?.northM, 0);

  const fit = mapFit(points, 900, 400);
  assert.equal(fit.spanM, MAP_MIN_FIT_SPAN_M);
  assert.equal(fit.centerLon, 114.352811);
  assert.equal(fit.centerLat, 30.539975);

  // 一条 10 m 东西向的线比 24 m 下限还小 → 仍然给 24 m 的视野
  const line = [{ t: 0, lon: 114.352811, lat: 30.539975 }, { t: 1, lon: 114.352811 + 10 / 95977, lat: 30.539975 }];
  assert.ok(Math.abs(trackLength(line) - 10) < 0.05);
  assert.equal(mapFit(line, 900, 400).spanM, MAP_MIN_FIT_SPAN_M);

  // 40 m 的线 → 视野 40 × 1.15
  const wide = [{ t: 0, lon: 114.352811, lat: 30.539975 }, { t: 1, lon: 114.352811 + 40 / 95977, lat: 30.539975 }];
  const wideFit = mapFit(wide, 900, 400);
  assert.ok(Math.abs(wideFit.spanM - 46) < 0.1, `spanM=${wideFit.spanM}`);
  assert.equal(wideFit.centerLon, 114.352811 + 20 / 95977);
});

test('时间轴比例 → 第几个点', () => {
  const points = [
    { t: 0, lon: 0, lat: 0 },
    { t: 1, lon: 0, lat: 0 },
    { t: 2, lon: 0, lat: 0 },
    { t: 3, lon: 0, lat: 0 },
  ];
  assert.equal(indexForRatio(points, 0), 0);
  assert.equal(indexForRatio(points, 0.3), 0);
  assert.equal(indexForRatio(points, 0.4), 1);
  assert.equal(indexForRatio(points, 0.7), 2);
  assert.equal(indexForRatio(points, 1), 3);
  assert.equal(indexForRatio(points, 2), 3);
  assert.equal(indexForRatio(points, -1), 0);
  assert.equal(indexForRatio([], 0.5), -1);
  // 时间轴退化（全同一时刻）时退化为按序号
  const frozen = points.map((point) => ({ ...point, t: 5 }));
  assert.equal(indexForRatio(frozen, 1), 3);
});

/* ---------------- 3. the real data: CSV vs KML ---------------- */

test('clean.kml 的坐标与高程和导出的 CSV 是同一批点', () => {
  const kml = readFileSync(kmlPath, 'utf8');
  const coords = parseKmlCoordinates(kml);
  // 5 个 Placemark + 1 条 LineString 的 5 个顶点
  assert.equal(coords.length, 10);

  const unique = new Map(coords.map((point) => [`${point.lon},${point.lat}`, point]));
  assert.equal(unique.size, 1);
  const [only] = [...unique.values()];
  assert.equal(only.lon, 114.352811);
  assert.equal(only.lat, 30.539975);

  const csvRow = readFileSync(join(graphCsvDir, '2D Trajectory.csv'), 'utf8')
    .split(/\r?\n/)
    .find((line) => line.startsWith('2442'));
  assert.ok(csvRow);
  const [, latitude, longitude] = csvRow!.split(',');
  assert.equal(Number(longitude), only.lon);
  assert.equal(Number(latitude), only.lat);

  // 高程：KML 的三位小数就是 Height.csv 的四舍六入
  const heights = readFileSync(join(graphCsvDir, 'Height.csv'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('2442'))
    .map((line) => Number(line.split(',')[1]));
  assert.equal(heights.length, 5);
  const pathHeights = coords.slice(5).map((point) => point.alt);
  assert.deepEqual(pathHeights.map((alt) => Number(alt).toFixed(3)), heights.map((value) => value.toFixed(3)));

  assert.equal(parseKmlCoordinates('<kml></kml>').length, 0);
  assert.equal(parseKmlCoordinates(null).length, 0);
  assert.equal(parseGpsStamp('2442,463097.350'), 2442 * 604_800 + 463_097.35);
  assert.equal(parseGpsStamp(' 2442 463097.350 '), 2442 * 604_800 + 463_097.35);
  assert.equal(parseGpsStamp('nope'), null);
});

test('真实接口的 2D Trajectory.csv 画成地图：点位、数量、坐标与文件一致', async () => {
  const [lon, lat] = await Promise.all([
    getData(MAP_FILE, MAP_LON_COLUMN),
    getData(MAP_FILE, MAP_LAT_COLUMN),
  ]);
  assert.equal(lon.name, MAP_FILE);
  assert.equal(lon.series.points.length, 5);
  const points = trajectoryPoints(lon, lat);
  assert.equal(points.length, 5);
  for (const point of points) {
    assert.ok(Math.abs(point.lon - 114.352811) < 1e-9);
    assert.ok(Math.abs(point.lat - 30.539975) < 1e-9);
  }
  assert.deepEqual(points.map((point) => point.t), [0, 1, 2, 3, 4]);

  const sd = await getData(MAP_SD_FILE, MAP_SD_LAT_COLUMN);
  const sdLon = await getData(MAP_SD_FILE, MAP_SD_LON_COLUMN);
  const sigmaM = Math.max(sd.series.points[0][1], sdLon.series.points[0][1]);
  assert.ok(Math.abs(sigmaM - 1.343599) < 1e-9);

  const view = mapFit(points, 900, 400);
  const svg = mapSvg({ points, view, sigmaM }, 900, 400);

  assert.match(svg, /^<svg viewBox="0 0 900 400"/);
  assert.match(svg, /data-basemap="graticule"/);
  assert.match(svg, /data-points="5"/);
  assert.match(svg, /data-span-m="24\.000"/);

  // 5 个顶点，坐标原样带在 data-* 上，且都落在视野正中（轨迹退化为 1 点）
  const vertices = [...svg.matchAll(/<circle cx="([\d.-]+)" cy="([\d.-]+)" r="3\.2"[^>]*data-i="(\d+)" data-lon="([\d.-]+)" data-lat="([\d.-]+)"/g)];
  assert.equal(vertices.length, 5, '每个 CSV 点一个圆');
  assert.deepEqual(vertices.map((match) => Number(match[3])), [0, 1, 2, 3, 4]);
  for (const match of vertices) {
    assert.equal(Number(match[4]), 114.352811);
    assert.equal(Number(match[5]), 30.539975);
    assert.equal(match[1], '450.0');
    assert.equal(match[2], '200.0');
  }

  // 轨迹线存在（5 个同一点，所以是一条零长折线），颜色是 clean.kml 的 PathSINGLE
  const polyline = /<polyline points="([^"]+)"/.exec(svg);
  assert.ok(polyline, '轨迹折线');
  assert.equal(polyline![1].trim().split(/\s+/).length, 5);
  assert.ok(svg.includes(MAP_TRACK_COLOR));

  // 1σ 圆：1.343599 m × 3.75 px/m ≈ 5.0 px
  assert.match(svg, /data-sigma-m="1\.344"/);
  assert.match(svg, /1σ 1\.34 m/);

  // 经纬网刻度读得出来、比例尺是整数米
  assert.match(svg, /114\.35280°E/);
  assert.match(svg, /30\.53998°N/);
  assert.match(svg, /data-scale-m="2"/);
  assert.match(svg, /data-north="up"/);
  assert.match(svg, /5 点重合/);
});

test('没有点、只有 1 个点、或不是静止轨迹时都不崩', () => {
  const empty = mapSvg({ points: [], view: { centerLon: 114.35, centerLat: 30.54, spanM: 24 } }, 700, 300);
  assert.match(empty, /data-points="0"/);
  assert.ok(!empty.includes('<polyline'));

  const single = mapSvg({ points: [{ t: 0, lon: 114.35, lat: 30.54 }], view: null }, 700, 300);
  assert.match(single, /data-points="1"/);
  assert.ok(!single.includes('点重合'));

  const moving = mapSvg({
    points: [
      { t: 0, lon: 114.35, lat: 30.54 },
      { t: 1, lon: 114.3501, lat: 30.5401 },
    ],
    view: mapFit([{ t: 0, lon: 114.35, lat: 30.54 }, { t: 1, lon: 114.3501, lat: 30.5401 }], 700, 300),
    sigmaM: 0,
  }, 700, 300);
  assert.match(moving, /起点/);
  assert.match(moving, /终点/);
  assert.ok(!moving.includes('1σ'));

  // 尺寸下限：给 0 也不会生成非法 viewBox
  assert.match(mapSvg({ points: [] }, 0, 0), /^<svg viewBox="0 0 200 140"/);
});

/* ---------------- 4. markup ---------------- */

test('Overview 面板：地图 + 停靠折线图 + 明写不是 Luciad', () => {
  const overview = paneBody('overview');
  for (const fragment of [
    'class="gp-map"',
    'data-ref="mapSvg"',
    'data-ref="mapReadout"',
    'data-ref="mapMarker"',
    'class="gp-dock"',
    'data-act="dock"',
    'class="gp-chart"',
    'gp-playhead',
    '本构建不是 Luciad 地图',
  ]) {
    assert.ok(overview.includes(fragment), `Overview 缺少 ${fragment}`);
  }
  assert.ok(!overview.includes('gp-chart-card'));
  // 免责声明是可见文本，不是 title / aria-label
  assert.ok(!/title="[^"]*Luciad/.test(overview));

  // 其它页签不受影响
  assert.ok(paneBody('project').includes('data-chart="project/info"'));
  assert.ok(!paneBody('pvt').includes('gp-map'));
});
