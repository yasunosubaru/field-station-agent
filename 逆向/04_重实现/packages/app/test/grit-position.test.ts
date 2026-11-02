/**
 * GRIT · Position Overview — the shared LuciadRIA stage, fed by the Graph CSVs.
 *
 * The tile used to be a blank canvas. It now boots `web/geo/luciad-stage.html` (the same iframe
 * Graph's Overview uses) and falls back to `mapSvg()` when the engine cannot start, printing the
 * reason. Three things are pinned here, because all three are easy to get silently wrong:
 *
 *   1. the **data path** — the fixes are `2D Trajectory.csv`'s rows and the 1σ is `Position SD.csv`'s
 *      first epoch, through `/api/graph/data` (i.e. `graphData()` server-side);
 *   2. the **live path** — BESTPOS #42 entries become the track, the last fix's deviation the ring,
 *      and an entry without a finite fix is skipped rather than drawn at 0°/0°;
 *   3. the **honesty line** — every non-ready state returns a reason (no engine, no CSV, no columns),
 *      and only a stage that answered `ready` leaves it empty. A blank tile with "everything is
 *      fine" on it is the exact bug this file exists to stop.
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
  LUCIAD_READY_TIMEOUT_MS,
  LUCIAD_STAGE_URL,
  MAP_FILE,
  MAP_LAT_COLUMN,
  MAP_LON_COLUMN,
  MAP_SD_FILE,
  MAP_SD_LAT_COLUMN,
  MAP_SD_LON_COLUMN,
} from '../src/web/panels/graph.js';
import {
  gritPositionReason,
  gritTileNote,
  gritTrackFromBestpos,
  gritTrackFromCsv,
  gritTrackSummary,
} from '../src/web/panels/grit.js';
import { STAGE_PROFILES, profileMessage, stageChrome } from '../src/web/geo/luciad-panel.js';

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, '..', 'src', 'web');
const gritJs = readFileSync(join(webDir, 'panels', 'grit.js'), 'utf8');
const gritCss = readFileSync(join(webDir, 'panels', 'grit.css'), 'utf8');
const stageJs = readFileSync(join(webDir, 'geo', 'luciad-stage.js'), 'utf8');
const stageHtml = readFileSync(join(webDir, 'geo', 'luciad-stage.html'), 'utf8');

/** `/api/graph/data` is `{ok:true, ...graphData()}`, so the endpoint and this call agree. */
const csv = (file: string, column?: string) => graphData(file, column ?? null);

/* ---------------- 1. capture: the Graph CSVs ---------------- */

test('抓包轨迹 = 2D Trajectory.csv 的经纬度行，1σ = Position SD.csv 首个历元', () => {
  const lon = csv(MAP_FILE, MAP_LON_COLUMN);
  const lat = csv(MAP_FILE, MAP_LAT_COLUMN);
  const track = gritTrackFromCsv(
    lon,
    lat,
    csv(MAP_SD_FILE, MAP_SD_LAT_COLUMN),
    csv(MAP_SD_FILE, MAP_SD_LON_COLUMN),
  );

  assert.equal(track.points.length, lon.rows, '每个 CSV 行就是一个定位点');
  assert.ok(track.points.length >= 2, '样本里至少两点，才画得出轨迹');
  for (const point of track.points) {
    assert.ok(Number.isFinite(point.lon) && Number.isFinite(point.lat), '经纬度必须都是有限数');
  }
  // 样本 clean.kml / Graph 导出的第一个点
  assert.ok(Math.abs(track.points[0].lon - 114.352811) < 1e-9);
  assert.ok(Math.abs(track.points[0].lat - 30.539975) < 1e-9);

  // Position SD.csv 的第一历元：纬度 1.343599 m、经度 1.19761 m，取较大者（与 Graph 一致）
  assert.ok(Math.abs(track.sigmaM - 1.343599) < 1e-9, `1σ = ${track.sigmaM}`);
});

test('缺 SD 文件时 1σ 退化为 0，轨迹本身不受影响', () => {
  const track = gritTrackFromCsv(
    csv(MAP_FILE, MAP_LON_COLUMN),
    csv(MAP_FILE, MAP_LAT_COLUMN),
    null,
    null,
  );
  assert.equal(track.points.length, csv(MAP_FILE).rows);
  assert.equal(track.sigmaM, 0);
});

/* ---------------- 2. live: BESTPOS #42 ---------------- */

function bestpos(latitude: number | null, longitude: number | null, latSd = 0.4, lonSd = 0.3) {
  return {
    seq: 1,
    time: '2026-11-01T00:00:00.000Z',
    data: {
      kind: 'bestpos',
      latitude,
      longitude,
      latitudeDeviation: latSd,
      longitudeDeviation: lonSd,
    },
  };
}

test('实时轨迹 = BESTPOS 的定位点，1σ 取最后一个有效点的纬/经 std dev', () => {
  const entries = [
    bestpos(30.539975, 114.352811, 0.9, 0.8),
    { seq: 2, time: '', data: { kind: 'range', observations: [] } }, // 别的报文：忽略
    bestpos(null, 114.35), // 无纬度：跳过，不画到 0°
    bestpos(30.540001, 114.352822, 0.25, 0.31),
  ];
  const track = gritTrackFromBestpos(entries);
  assert.equal(track.points.length, 2, '只有两个有效 BESTPOS');
  assert.deepEqual(
    track.points.map((point) => [point.lon, point.lat]),
    [[114.352811, 30.539975], [114.352822, 30.540001]],
  );
  assert.equal(track.sigmaM, 0.31, '最后一个点的 1σ = max(0.25, 0.31)');
  assert.equal(track.lastTime, '2026-11-01T00:00:00.000Z');
});

test('实时轨迹只保留最新 N 点（长时间会话会一直增长）', () => {
  const entries = Array.from({ length: 12 }, (_, index) => bestpos(30.5 + index * 1e-6, 114.3));
  const track = gritTrackFromBestpos(entries, 5);
  assert.equal(track.points.length, 5);
  assert.ok(Math.abs(track.points[4].lat - (30.5 + 11e-6)) < 1e-12, '留下的是最后五点');
});

test('轨迹摘要：点数、长度、1σ —— 页脚那一行就是它', () => {
  const summary = gritTrackSummary({
    points: [
      { t: 0, lon: 114.352811, lat: 30.539975 },
      { t: 1, lon: 114.352811, lat: 30.540075 },
    ],
    sigmaM: 0.75,
  });
  assert.equal(summary.points, 2);
  assert.equal(summary.sigmaM, 0.75);
  // 0.0001° 纬度 ≈ 11.11 m
  assert.ok(Math.abs(summary.lengthM - 11.11) < 0.05, `长度 = ${summary.lengthM}`);
  assert.deepEqual(gritTrackSummary(null), { points: 0, lengthM: 0, sigmaM: 0 });
});

/* ---------------- 3. the honesty line ---------------- */

test('每种非就绪状态都写明原因，绝不返回空白', () => {
  const loading = gritPositionReason({ status: 'loading' });
  assert.match(loading, /2D Trajectory\.csv/);
  assert.match(loading, /读取/);

  // 无数据 / 读不到 CSV：原因带出来，并且点名缺的是哪份文件
  const error = gritPositionReason({ status: 'error', error: 'HTTP 404 未找到 CSV：2D Trajectory.csv' });
  assert.match(error, /读不到轨迹/);
  assert.match(error, /HTTP 404/);
  assert.match(error, /2D Trajectory\.csv/);

  const empty = gritPositionReason({ status: 'empty' });
  assert.match(empty, /没有可配对的经纬度列/);

  // 引擎失败（无 WebGPU / 超时 / 读不到 01_解包）：和 Graph 的 failLuciad 同一句话
  const failed = gritPositionReason({
    status: 'ready',
    engine: 'failed',
    engineError: "Can't get WebGPU adapter",
    points: 5,
    lengthM: 12.3,
  });
  assert.match(failed, /LuciadRIA 不可用/);
  assert.match(failed, /Can't get WebGPU adapter/);
  assert.match(failed, /退回自绘经纬网/);

  const booting = gritPositionReason({ status: 'ready', engine: 'booting' });
  assert.match(booting, /正在启动 LuciadRIA/);

  // 只有舞台自报 ready 才允许没有说明
  assert.equal(gritPositionReason({ status: 'ready', engine: 'ready' }), '');
});

test('Satellite 页签的画面交给瓦片层：引擎好坏不再决定这句话', () => {
  /* 原来这里断言"本构建没有影像层"。D2 加了可配置 XYZ 瓦片后，页签的画面由 `gritTileNote()`
   * 负责，`gritPositionReason()` 对 Satellite 只报数据状态，不再把引擎失败算到它头上。 */
  assert.equal(gritPositionReason({ tab: 'satellite', status: 'ready', engine: 'ready' }), '');
  assert.equal(
    gritPositionReason({ tab: 'satellite', status: 'ready', engine: 'failed', engineError: 'no WebGPU' }),
    '',
    'Satellite 不用 Luciad，引擎失败与它无关',
  );
  assert.match(gritPositionReason({ tab: 'satellite', status: 'loading' }), /2D Trajectory\.csv/);

  const offline = gritTileNote({ enabled: true, status: 'offline', error: 'HTTP 502 取瓦片失败' });
  assert.match(offline, /影像瓦片不可用/);
  assert.match(offline, /回退矢量网格/);
  assert.match(gritTileNote({ enabled: false, status: 'idle' }), /矢量网格/);
  assert.equal(gritTileNote({ enabled: true, status: 'ready' }), '');
});

/* ---------------- 4. the shared stage contract ---------------- */

test('GRIT 与 Graph 共用同一个舞台文档，只是装饰不同', () => {
  assert.match(LUCIAD_STAGE_URL, /\/geo\/luciad-stage\.html$/);
  assert.ok(LUCIAD_READY_TIMEOUT_MS >= 10_000, '16 MB 模块 + wasm 冷启动，别给太短');

  const grit = stageChrome('grit');
  assert.equal(grit.labels, false, 'GRIT 不要 Graph 的经纬度标注');
  assert.equal(grit.metric, true, '米制网格留着，24 m 的小轨迹要靠它读');
  assert.equal(grit.scale, true);
  const graph = stageChrome('graph');
  assert.equal(graph.labels, true);
  assert.deepEqual(STAGE_PROFILES.grit, grit);
  assert.deepEqual(stageChrome('nonsense'), graph, '认不出的 profile 走默认，不猜');

  const message = profileMessage('grit', { scale: false });
  assert.equal(message.type, 'profile');
  assert.equal(message.profile, 'grit');
  assert.deepEqual(message.chrome, { ...grit, scale: false });
  // 表本身不能被调用方改到
  message.chrome.labels = true;
  assert.equal(STAGE_PROFILES.grit.labels, false);
});

test('舞台实现了 profile / chrome 消息，并在自报里带上装饰集', () => {
  assert.match(stageJs, /const STAGE_PROFILES = \{/);
  assert.match(stageJs, /if \(data\.type === 'profile'\)/);
  assert.match(stageJs, /if \(data\.type === 'chrome'\)/);
  assert.match(stageJs, /profile: state\.profile,/);
  assert.match(stageJs, /chrome: \{ \.\.\.state\.chrome \}/);
  // 面板要的 iframe 和服务端要的 CSP 都还在
  assert.match(stageHtml, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(stageJs, /RIAMap/);
});

test('1σ 环画成经纬度折线；引擎加载失败时舞台自己不再抛异常', () => {
  // `createCircleByCenterPoint` 在这版引擎里“图元在、像素不在”（1.34 m 的圆完全不可见），
  // 所以环改成和 mapSvg() 同一条几何的折线 —— 两个渲染器必须画出同一个圈。
  assert.match(stageJs, /function ringPolyline\(/);
  assert.ok(!stageJs.includes('shape: createCircleByCenterPoint'), '1σ 环又回到不可见的圆形图元');
  assert.match(stageJs, /ringPolyline\(points\[0\]\.lon, points\[0\]\.lat, state\.sigmaM\)/);
  // 引擎模块 404 时 `getReference` 是 undefined：舞台必须安静地只报 error，不能抛 pageerror
  assert.match(stageJs, /const CRS84 = engine \? getReference\('CRS:84'\) : null;/);
  assert.match(stageJs, /if \(!engine\) return;/);
});

test('Position Overview 接的是共享舞台，不是又一份引擎加载逻辑', () => {
  // 旧实现的"空白画布"说明必须已经不存在
  assert.ok(!/Position Overview\s*→\s*blank canvas/.test(gritJs), 'grit.js 里还留着 blank canvas');
  assert.ok(!gritJs.includes('no basemap renderer here'));
  // 复用：舞台 URL 与客户端都来自 graph.js / geo/
  assert.match(gritJs, /from '\.\/graph\.js'/);
  assert.match(gritJs, /from '\.\.\/geo\/luciad-panel\.js'/);
  assert.match(gritJs, /LUCIAD_STAGE_URL/);
  assert.match(gritJs, /createStageClient\(/);
  assert.match(gritJs, /profile: 'grit'/);
  // 数据：CSV 两列 + SD，实时是 BESTPOS
  assert.match(gritJs, /\/graph\/data/);
  assert.match(gritJs, /BESTPOS/);
  assert.match(gritJs, /mapSvg\(/);
  // 舞台自报（浏览器检查用）
  assert.match(gritJs, /window\.__gritPos/);
  assert.match(gritJs, /__luciadStage/);

  // 标记里三块都在：SVG 回退、Luciad iframe、说明行
  assert.match(gritJs, /data-el="posMap"/);
  assert.match(gritJs, /data-el="posFrame"/);
  assert.match(gritJs, /data-el="posNote"/);
  assert.match(gritJs, /data-el="posFoot"/);

  // CSS 让舞台铺满瓦片，说明文字压在上面
  assert.match(gritCss, /\.grit-pos-frame\b/);
  assert.match(gritCss, /\.grit-pos-map\b/);
  assert.match(gritCss, /\.grit-pos-foot\b/);
});
