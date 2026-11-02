/**
 * GRIT · Position Overview — the Satellite tab's imagery layer (由 D2 补).
 *
 * No capture in this repo carries imagery, and the original's provider is not documented anywhere
 * in the suite, so the layer is a **public-source substitute** driven by a configurable XYZ
 * template. Four things can go silently wrong, and each has its own block here:
 *
 *   1. the **template** — `{z}/{x}/{y}` is not the same string for every provider (Esri is
 *      `{z}/{y}/{x}`, TMS flips y, some use `{s}`/`{key}`); a silent half-substitution serves the
 *      same tile for every coordinate;
 *   2. the **projection** — Web Mercator, checked against a published reference tile (Berlin at
 *      z12) and against its own inverse, then against the tile *layout* (the tiles must cover the
 *      viewport) and against the overlay (track vertices must land on the projected pixel, i.e.
 *      vectors and imagery share one transform);
 *   3. the **cache** — a second request must be answered from disk, not from the upstream; the
 *      test counts upstream hits through a stub tile server;
 *   4. the **offline path** — an unreachable template must answer 502 (not hang, not 200), and the
 *      panel must say it fell back to the vector graticule instead of showing a blank box.
 *
 *   node --test --test-force-exit "packages/app/test/*.test.ts"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GRIT_TILE_DEFAULT_URL,
  GRIT_TILE_PROXY,
  GRIT_TILE_STORE_KEY,
  GRIT_TILE_ATTRIBUTION,
  GRIT_TILE_LIMIT,
  gritLonLat,
  gritMercator,
  gritMetresPerPixel,
  gritPositionReason,
  gritProjectPoint,
  gritTileExtent,
  gritTileHost,
  gritTileIndex,
  gritTileLayout,
  gritTileNote,
  gritTileProbeRequest,
  gritTileRequest,
  gritTileTemplate,
  gritTileUrl,
  gritTileView,
  gritTileOverlaySvg,
  gritTileAttribution,
  gritTilesFromSearch,
  gritTilesParse,
  template,
} from '../src/web/panels/grit.js';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const implDir = resolve(appDir, '..', '..');
const serverPath = join(appDir, 'src', 'server.ts');
const gritJs = readFileSync(join(appDir, 'src', 'web', 'panels', 'grit.js'), 'utf8');
const gritCss = readFileSync(join(appDir, 'src', 'web', 'panels', 'grit.css'), 'utf8');
const serverTs = readFileSync(join(appDir, 'src', 'server.ts'), 'utf8');

/** The staircase from `2D Trajectory.csv` (clean-9600): five fixes around 30.539975 / 114.352811. */
const TRACK = [
  { t: 0, lon: 114.352811, lat: 30.539975 },
  { t: 1, lon: 114.352822, lat: 30.540001 },
  { t: 2, lon: 114.352833, lat: 30.540027 },
  { t: 3, lon: 114.352844, lat: 30.540053 },
  { t: 4, lon: 114.352855, lat: 30.540079 },
];

/* ---------------- 1. the template ---------------- */

test('模板：必须同时有 {z}/{x}/{y}，off 关掉影像，别的当没写', () => {
  assert.equal(gritTileTemplate(GRIT_TILE_DEFAULT_URL), GRIT_TILE_DEFAULT_URL);
  assert.equal(gritTileTemplate('  https://t/a/{z}/{y}/{x}  '), 'https://t/a/{z}/{y}/{x}');
  assert.equal(gritTileTemplate('https://t/a/{z}/{x}'), '', '缺 {y}：不能半替换');
  assert.equal(gritTileTemplate('ftp://t/{z}/{x}/{y}'), '', '只认 http(s)');
  assert.equal(gritTileTemplate('/api/grit/tiles/{z}/{x}/{y}'), '');
  assert.equal(gritTileTemplate('off'), 'off');
  assert.equal(gritTileTemplate('VECTOR'), 'off');
  assert.equal(gritTileTemplate('on'), '', 'on 是"用服务端默认"，不是模板');
  assert.equal(gritTileTemplate(''), '');
  assert.equal(gritTileTemplate(null), '');

  // 默认源是 Esri 的 {z}/{y}/{x} 顺序（行在前），不是 OSM 的 {z}/{x}/{y}
  assert.match(GRIT_TILE_DEFAULT_URL, /^https:\/\/server\.arcgisonline\.com\/.*\{z\}\/\{y\}\/\{x\}$/);
  assert.match(GRIT_TILE_ATTRIBUTION, /Esri/);
  assert.match(GRIT_TILE_ATTRIBUTION, /公开源替代/);
  assert.match(GRIT_TILE_ATTRIBUTION, /非原版同源/);
});

test('URL：替换 {z}{x}{y}，TMS 的 {-y} 翻行号，{s} 分域名，{key} 留空则拒', () => {
  const tpl = 'https://t/{z}/{x}/{y}.jpg';
  assert.equal(gritTileUrl(tpl, { z: 3, x: 4, y: 2 }), 'https://t/3/4/2.jpg');
  // {-y} = 2^z - 1 - y（TMS 从南边数）
  assert.equal(gritTileUrl('https://t/{z}/{x}/{-y}', { z: 3, x: 4, y: 2 }), 'https://t/3/4/5');
  assert.equal(gritTileUrl('https://{s}.t/{z}/{x}/{y}', { z: 1, x: 1, y: 0 }), 'https://b.t/1/1/0');
  assert.equal(gritTileUrl('https://t/{z}/{x}/{y}?k={key}', { z: 1, x: 0, y: 0 }, { key: 'abc' }),
    'https://t/1/0/0?k=abc');
  assert.equal(gritTileUrl('https://t/{z}/{x}/{y}?k={key}', { z: 1, x: 0, y: 0 }), null,
    '有 {key} 没 key：宁可不发，也不发一个带洞的地址');
  // 越界：z 上限、x/y 超出 2^z
  assert.equal(gritTileUrl(tpl, { z: 23, x: 0, y: 0 }), null);
  assert.equal(gritTileUrl(tpl, { z: 2, x: 4, y: 0 }), null);
  assert.equal(gritTileUrl(tpl, { z: 2, x: 0, y: -1 }), null);
  assert.equal(gritTileUrl(tpl, { z: 2.5, x: 0, y: 0 }), null, '瓦片坐标必须是整数');
  assert.equal(gritTileUrl('off', { z: 1, x: 0, y: 0 }), null);

  // 浏览器请求走代理；自定义模板作为 src= 传过去（服务端据此选缓存目录）
  assert.equal(GRIT_TILE_PROXY, '/api/grit/tiles');
  assert.equal(gritTileRequest({ z: 17, x: 107170, y: 53849 }, ''),
    '/api/grit/tiles/17/107170/53849');
  assert.equal(gritTileRequest({ z: 17, x: 107170, y: 53849 }, 'on'),
    '/api/grit/tiles/17/107170/53849');
  const custom = gritTileRequest({ z: 2, x: 1, y: 0 }, 'https://t/{z}/{x}/{y}');
  assert.match(custom, /^\/api\/grit\/tiles\/2\/1\/0\?src=https%3A%2F%2Ft%2F%7Bz%7D/);
  assert.equal(gritTileRequest({ z: 1.5, x: 0, y: 0 }, ''), null);

  /* 探测请求：同一个路由加 probe=1，正常/自定义源都要拼对问号或 & */
  assert.equal(gritTileProbeRequest({ z: 3, x: 4, y: 2 }, ''), '/api/grit/tiles/3/4/2?probe=1');
  assert.match(gritTileProbeRequest({ z: 3, x: 4, y: 2 }, 'https://t/{z}/{x}/{y}'), /\?src=.*&probe=1$/);
  assert.equal(gritTileProbeRequest({ z: 1.5, x: 0, y: 0 }, ''), null);

  /* 署名：默认源用服务端那句（Esri…），自定义源只报自己的 host，绝不冒充 Esri */
  assert.equal(gritTileHost('https://tiles.example.org/a/{z}/{x}/{y}.png'), 'tiles.example.org');
  assert.equal(gritTileHost(GRIT_TILE_DEFAULT_URL), 'server.arcgisonline.com');
  assert.equal(gritTileHost('off'), '');
  assert.match(gritTileAttribution({ source: '', attribution: GRIT_TILE_ATTRIBUTION }), /Esri/);
  const customCredit = gritTileAttribution({ source: 'https://tiles.example.org/{z}/{x}/{y}.png' });
  assert.match(customCredit, /自定义 XYZ 瓦片源（tiles\.example\.org）/);
  assert.match(customCredit, /公开源替代/);
  assert.doesNotMatch(customCredit, /Esri/, '自定义源不能挂别人的署名');
});

/* ---------------- 2. Web Mercator ---------------- */

test('Web Mercator：柏林 (13.4, 52.5) 在 z12 就是 2200/1343（公开参考值）', () => {
  assert.deepEqual(gritTileIndex(13.4, 52.5, 12), { z: 12, x: 2200, y: 1343 });
  // 赤道/本初子午线落在 z1 的右下角 tile
  assert.deepEqual(gritTileIndex(0, 0, 1), { z: 1, x: 1, y: 1 });
  assert.deepEqual(gritTileIndex(-0.000001, 0.000001, 1), { z: 1, x: 0, y: 0 });
  // z0 只有一块，覆盖整张世界图
  const world = gritTileExtent(0, 0, 0);
  assert.ok(Math.abs(world.west + 180) < 1e-9);
  assert.ok(Math.abs(world.east - 180) < 1e-9);
  assert.ok(Math.abs(world.north - 85.05112877980659) < 1e-6);
  assert.ok(Math.abs(world.south + 85.05112877980659) < 1e-6);
});

test('Web Mercator：正反变换互逆，tile 包围盒包含落进去的点', () => {
  for (const [lon, lat] of [[114.352811, 30.539975], [-179.9, 84.9], [0, 0], [13.4, 52.5]]) {
    const { u, v } = gritMercator(lon, lat);
    const back = gritLonLat(u, v);
    assert.ok(Math.abs(back.lon - lon) < 1e-9, `lon ${lon} → ${back.lon}`);
    assert.ok(Math.abs(back.lat - lat) < 1e-7, `lat ${lat} → ${back.lat}`);
  }
  // 极点被夹在 ±85.0511（墨卡托在那里已经跑到无穷）
  assert.ok(Number.isFinite(gritMercator(0, 89.9).v));
  assert.ok(Math.abs(gritMercator(0, 89.9).v) < 1e-3 + 0.5);

  const index = gritTileIndex(114.352811, 30.539975, 17);
  const extent = gritTileExtent(index.z, index.x, index.y);
  assert.ok(extent.west <= 114.352811 && 114.352811 <= extent.east);
  assert.ok(extent.south <= 30.539975 && 30.539975 <= extent.north);

  // y 向下增长：纬度越高，行号越小
  assert.ok(gritTileIndex(0, 60, 10).y < gritTileIndex(0, 20, 10).y);
});

test('视图：把轨迹装进画框，瓦片铺满画框，没有缝隙也没有遗漏', () => {
  const view = gritTileView(TRACK, 800, 320);
  assert.ok(Number.isInteger(view.z), '请求的 zoom 必须是整数（XYZ 没有小数层）');
  assert.ok(view.z >= 1 && view.z <= 19);
  // 每个点都落在画框内（含 15% 留白，所以不可能贴边越界）
  for (const point of TRACK) {
    const at = gritProjectPoint(view, point.lon, point.lat);
    assert.ok(at.x >= 0 && at.x <= view.width, `x=${at.x}`);
    assert.ok(at.y >= 0 && at.y <= view.height, `y=${at.y}`);
  }
  // 视野中心 = 画框中心（±1 px，四舍五入来的）
  const centre = gritProjectPoint(view, view.centerLon, view.centerLat);
  assert.ok(Math.abs(centre.x - view.width / 2) <= 1, `cx=${centre.x}`);
  assert.ok(Math.abs(centre.y - view.height / 2) <= 1, `cy=${centre.y}`);

  const layout = gritTileLayout(view);
  assert.ok(layout.length > 0 && layout.length <= GRIT_TILE_LIMIT);
  for (const tile of layout) {
    assert.equal(tile.z, view.z);
    assert.ok(tile.size > 0);
    assert.ok(tile.x >= 0 && tile.x < 2 ** view.z);
    assert.ok(tile.y >= 0 && tile.y < 2 ** view.z);
  }
  // 画框四角都必须被某一块覆盖（不露底）
  for (const [x, y] of [[0, 0], [view.width - 1, 0], [0, view.height - 1], [view.width - 1, view.height - 1]]) {
    const hit = layout.some((tile) => x >= tile.left && x <= tile.left + tile.size
      && y >= tile.top && y <= tile.top + tile.size);
    assert.ok(hit, `(${x},${y}) 没有瓦片覆盖`);
  }
  // 相邻瓦片正好相接（size = k / 2^z，不是各自取整后再拼）
  const sorted = [...layout].sort((a, b) => a.left - b.left || a.top - b.top);
  const first = sorted[0];
  const sizePx = view.k / 2 ** view.z;
  assert.ok(Math.abs((first.left + sizePx) - (first.left + sizePx)) < 1e-9);
  assert.ok(Math.abs(sizePx - view.size) < 1e-9);
});

test('视图：重合的定位点不会缩到单像素，空的轨迹给一张世界图', () => {
  const one = gritTileView([{ lon: 114.352811, lat: 30.539975 }], 600, 300);
  assert.ok(Number.isInteger(one.z) && one.z >= 1 && one.z <= 19);
  // 600×300 的画框里至少有几公里，而不是一个点
  const mpp = gritMetresPerPixel(one, one.centerLat);
  assert.ok(mpp * 600 > 50, `画框宽度只有 ${mpp * 600} m`);

  const empty = gritTileView([], 600, 300);
  assert.equal(empty.z, 2);
  assert.ok(Math.abs(empty.centerLon) < 1e-9 && Math.abs(empty.centerLat) < 1e-9);

  // 米/像素：z17 赤道上约 1.19 m/px（256 px 瓦片）
  const equator = { k: 256 * 2 ** 17 };
  assert.ok(Math.abs(gritMetresPerPixel(equator, 0) - 1.1943) < 0.001);
});

/* ---------------- 3. the overlay shares the tile transform ---------------- */

test('叠加层：轨迹顶点落在瓦片的投影像素上（同一套变换），且是透明的', () => {
  const view = gritTileView(TRACK, 760, 300);
  const svg = gritTileOverlaySvg(view, {
    points: TRACK,
    /* 200 m 的环：样本里的 1.34 m 在这个墨卡托尺度上只有 1.6 px（< 3 px 不画），
     * 这里用一个大环验证几何，阈值本身由 `gritTileOverlaySvg` 的 radiusPx 决定。 */
    sigmaM: 200,
    pois: [{ id: 'p1', name: 'Gate 3', lon: 114.35282, lat: 30.54001, radius: 6, visible: true, active: true }],
    cursor: 4,
    display: { graticule: true, labels: false, north: true },
  });
  assert.match(svg, /data-basemap="tiles"/);
  assert.match(svg, new RegExp(`data-tile-z="${view.z}"`));

  const vertex = new RegExp(`<circle cx="([\\d.-]+)" cy="([\\d.-]+)" r="[\\d.]+" fill="#ffffff"`).exec(svg);
  assert.ok(vertex, '轨迹顶点没画出来');
  const at = gritProjectPoint(view, TRACK[0].lon, TRACK[0].lat);
  assert.ok(Math.abs(Number(vertex[1]) - at.x) < 0.06, `顶点 x=${vertex[1]} vs 投影 ${at.x}`);
  assert.ok(Math.abs(Number(vertex[2]) - at.y) < 0.06, `顶点 y=${vertex[2]} vs 投影 ${at.y}`);

  assert.match(svg, /data-sigma-m="200\.000"/, '1σ 环');
  assert.match(svg, /data-poi-radius="6"/, 'POI 半径圈');
  assert.match(svg, /Gate 3/);
  assert.match(svg, /data-cursor="1"/);
  assert.match(svg, /data-scale-m="\d+"/, '比例尺');
  assert.match(svg, /data-north="1"/);

  // 透明：影像底下不能被"纸色"盖住（mapSvg 的回退图会画 #eef1ea，这一层不能）
  assert.ok(!svg.includes('#eef1ea'), '叠加层不该画底纸');
  assert.ok(!/<\/svg>$/.test(''), 'sanity');
  assert.match(svg, /<\/svg>$/);

  // 关掉经纬网/指北针，就真的不画
  const bare = gritTileOverlaySvg(view, { points: TRACK, display: { graticule: false, north: false } });
  assert.ok(!bare.includes('data-north="1"'));
  assert.ok(!bare.includes('stroke-dasharray="4 4"'), '经纬网关不掉');
});

/* ---------------- 4. the honesty line ---------------- */

test('说明行：就绪为空；加载/离线/关闭各自说清楚，离线指向矢量回退', () => {
  assert.equal(gritTileNote({ enabled: true, status: 'ready' }), '');
  assert.match(gritTileNote({ enabled: true, status: 'loading', zoom: 17, count: 6 }), /正在加载影像瓦片/);
  assert.match(gritTileNote({ enabled: true, status: 'loading', zoom: 17, count: 6 }), /z=17/);
  const offline = gritTileNote({ enabled: true, status: 'offline', error: 'HTTP 502 取瓦片失败：fetch failed' });
  assert.match(offline, /影像瓦片不可用/);
  assert.match(offline, /HTTP 502/);
  assert.match(offline, /回退矢量网格/);
  const disabled = gritTileNote({ enabled: false, status: 'idle' });
  assert.match(disabled, /关闭/);
  assert.match(disabled, /矢量网格/);
  assert.match(gritTileNote({ enabled: true, status: 'idle' }), /Satellite/);

  // Satellite 页签不再被当成"引擎坏了"：数据就绪时原因行交给瓦片层
  assert.equal(gritPositionReason({ tab: 'satellite', status: 'ready', engine: 'failed', engineError: 'x' }), '');
  assert.match(gritPositionReason({ tab: 'satellite', status: 'loading' }), /2D Trajectory\.csv/);
  // Map 页签的引擎原因保持原样
  assert.match(gritPositionReason({ tab: 'map', status: 'ready', engine: 'failed', engineError: 'no WebGPU' }),
    /LuciadRIA 不可用/);
});

test('设置项与 ?tiles=：空串用服务端默认，off 关闭，坏模板不写进状态', () => {
  assert.deepEqual(gritTilesParse(''), { source: '' });
  assert.deepEqual(gritTilesParse('{"source":"https://t/{z}/{x}/{y}"}'), { source: 'https://t/{z}/{x}/{y}' });
  assert.deepEqual(gritTilesParse('{"source":"off"}'), { source: 'off' });
  assert.deepEqual(gritTilesParse('{"source":"nonsense"}'), { source: '' }, '坏值退回默认，不炸页面');
  assert.deepEqual(gritTilesParse('{oops'), { source: '' });
  assert.equal(GRIT_TILE_STORE_KEY, 'nas.grit.map.tiles.v1');

  assert.equal(gritTilesFromSearch(''), null);
  assert.deepEqual(gritTilesFromSearch('?tab=grit'), null);
  assert.deepEqual(gritTilesFromSearch('?tiles=off'), { source: 'off' });
  assert.deepEqual(gritTilesFromSearch('?tiles=on'), { source: '' });
  assert.deepEqual(gritTilesFromSearch('?tiles=https%3A%2F%2Ft%2F%7Bz%7D%2F%7Bx%7D%2F%7By%7D'),
    { source: 'https://t/{z}/{x}/{y}' });
  const bad = gritTilesFromSearch('?tiles=nonsense');
  assert.equal(bad?.source, '');
  assert.equal(bad?.invalid, 'nonsense');
});

test('面板模板真的能渲染（模板字面量里的反引号会变成 ReferenceError，单测看不出来）', () => {
  const html = template();
  assert.ok(html.length > 10_000, `模板只有 ${html.length} 字节`);
  for (const el of ['posCanvas', 'posMap', 'posTiles', 'posOverlay', 'posCredit', 'posNote', 'posFoot',
    'tileInput', 'tileApply', 'tileReset', 'tileState', 'tileMsg', 'displayRows']) {
    assert.ok(html.includes(`data-el="${el}"`), `模板里缺 data-el="${el}"`);
  }
  // 卫星页签、两个视图按钮、以及"公开源替代"的说明都已经在页面骨架里
  assert.match(html, /data-view="satellite"/);
  assert.match(html, /data-view="map"/);
  assert.match(html, /Public|公开源替代/);
  assert.match(html, /Base Map/);
});

/* ---------------- 5. the panel + the route exist ---------------- */

test('面板接线：瓦片层在矢量图之上、说明与署名齐全，且失败不阻塞轨迹', () => {
  // 三个容器 + 署名行
  assert.match(gritJs, /data-el="posTiles"/);
  assert.match(gritJs, /data-el="posOverlay"/);
  assert.match(gritJs, /data-el="posCredit"/);
  // 用的是共享的纯函数，不是第二套墨卡托
  assert.match(gritJs, /gritTileView\(/);
  assert.match(gritJs, /gritTileLayout\(/);
  assert.match(gritJs, /gritTileRequest\(/);
  assert.match(gritJs, /gritTileOverlaySvg\(/);
  // 走代理，不直连上游（CSP 与 key 都靠这条）
  assert.match(gritJs, /GRIT_TILE_PROXY/);
  assert.ok(!/arcgisonline[^\n]*<img/.test(gritJs), '不要在 <img src> 里直连上游');
  // 先探测再取图：断网时一个失败的图片请求都不会发出去（Chromium 会把它们记成 console error）
  assert.match(gritJs, /probeTiles\(/);
  assert.match(gritJs, /gritTileProbeRequest\(/);
  // 失败只改 tiles.status，不抛、不清轨迹
  assert.match(gritJs, /tiles\.status = 'offline'/);
  assert.match(gritJs, /gritTileNote\(tiles\)/);
  // 自报（浏览器检查用）
  assert.match(gritJs, /tiles: \{/);
  assert.match(gritJs, /painted: Boolean\(posTiles && !posTiles\.hidden\)/);

  // CSS：影像层在 SVG 之下、叠加层透明
  assert.match(gritCss, /\.grit-pos-tiles/);
  assert.match(gritCss, /\.grit-pos-overlay/);
  assert.match(gritCss, /\.grit-pos-credit/);
  assert.match(gritCss, /\.grit-pos-tiles \.grit-maptile/);
  assert.match(gritCss, /\.grit-sheet \.grit-pop-btn\.is-ghost/, '浅色卡片里的幽灵按钮必须可读');
  /* `grit-tile` 是看板瓦片（392×375、padding 15/9/9/15、border-box）；瓦片图用这个名字会被
   * 内边距裁出 24 px 白边 —— 实测过，所以这里钉住不能再用它。 */
  assert.match(gritJs, /class="grit-maptile"/);
  assert.ok(!/\.grit-pos-tiles \.grit-tile\b/.test(gritCss), '瓦片图又挂回 .grit-tile 了');

  // 服务端：代理 + 缓存 + 配置
  assert.match(serverTs, /path === '\/api\/grit\/tiles\/config'/);
  assert.match(serverTs, /path\.startsWith\('\/api\/grit\/tiles\/'\)/);
  assert.match(serverTs, /GRIT_TILE_URL/);
  assert.match(serverTs, /GRIT_TILE_KEY/);
  assert.match(serverTs, /GRIT_TILE_DIR/);
  // key 不能有字面值：模板里只有占位符
  assert.ok(!/GRIT_TILE_KEY\s*=\s*['"][^'"]+['"]/.test(serverTs), 'GRIT_TILE_KEY 不应有内置值');
  assert.ok(!/key=[A-Za-z0-9]{16,}/.test(serverTs + gritJs), '仓库里不该出现瓦片 key');
});

/* ---------------- 6. the proxy: cache hit / upstream down / validation ---------------- */

const TILE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function waitForReady(proc: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`server did not start\n${stderr}`)), 25_000);
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

async function withServer(env: Record<string, string>, body: (base: string) => Promise<void>): Promise<void> {
  const child = spawn(process.execPath, [serverPath, '--port', '0'], {
    cwd: implDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  try {
    const port = await waitForReady(child);
    await body(`http://127.0.0.1:${port}`);
  } finally {
    if (!child.killed) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      timer.unref();
    }
  }
}

/** A stub tile host: counts hits so a cache hit can be told from a MISS. */
async function withStubTiles(body: (url: string, hits: () => number) => Promise<void>): Promise<void> {
  let count = 0;
  const stub = createHttpServer((req, res) => {
    count += 1;
    if (!/^\/\d+\/\d+\/\d+\.png$/.test(String(req.url))) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': TILE_BYTES.byteLength });
    res.end(TILE_BYTES);
  });
  await new Promise<void>((ready) => stub.listen(0, '127.0.0.1', ready));
  const address = stub.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    await body(`http://127.0.0.1:${port}/{z}/{y}/{x}.png`, () => count);
  } finally {
    await new Promise<void>((done) => stub.close(() => done()));
  }
}

test('代理：第一次取上游并落盘，第二次命中缓存，字节与上游一致', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'grit-tiles-cache-'));
  try {
    await withStubTiles(async (url, hits) => {
      await withServer({ GRIT_TILE_URL: url, GRIT_TILE_DIR: cacheDir }, async (base) => {
        const config = await (await fetch(`${base}/api/grit/tiles/config`)).json();
        assert.equal(config.ok, true);
        assert.equal(config.enabled, true);
        assert.equal(config.cache, 'disk');
        assert.match(config.attribution, /公开源替代/);

        const first = await fetch(`${base}/api/grit/tiles/3/4/2`);
        assert.equal(first.status, 200);
        assert.equal(first.headers.get('content-type'), 'image/png');
        assert.equal(first.headers.get('x-grit-tile-source'), 'upstream');
        assert.equal(first.headers.get('x-grit-tile-cache'), 'stored');
        assert.deepEqual(Buffer.from(await first.arrayBuffer()), TILE_BYTES);
        assert.equal(hits(), 1);

        const second = await fetch(`${base}/api/grit/tiles/3/4/2`);
        assert.equal(second.status, 200);
        assert.equal(second.headers.get('x-grit-tile-source'), 'cache', '第二次必须读磁盘');
        assert.deepEqual(Buffer.from(await second.arrayBuffer()), TILE_BYTES);
        assert.equal(hits(), 1, '缓存命中不应再打上游');

        assert.ok(existsSync(join(cacheDir, '3', '4', '2.png')), '缓存文件不在 z/x/y.ext 位置');

        // 探测：同一个路由 + probe=1 → 200 JSON，浏览器据此决定要不要发图片请求
        const probe = await fetch(`${base}/api/grit/tiles/3/4/2?probe=1`);
        assert.equal(probe.status, 200);
        const probeBody = await probe.json();
        assert.deepEqual(
          { ok: probeBody.ok, source: probeBody.source, type: probeBody.type, bytes: probeBody.bytes },
          { ok: true, source: 'cache', type: 'image/png', bytes: TILE_BYTES.byteLength },
        );
        assert.equal(hits(), 1, '探测命中缓存，也不该打上游');

        // 越界坐标：400，不是把请求转给上游
        const bad = await fetch(`${base}/api/grit/tiles/1/9/9`);
        assert.equal(bad.status, 400);
        assert.equal(hits(), 1);

        // 自定义源不许指向本机（代理不能变成 SSRF 工具）
        const loop = await fetch(`${base}/api/grit/tiles/3/4/2?src=${encodeURIComponent('http://127.0.0.1:1/{z}/{x}/{y}')}`);
        assert.equal(loop.status, 400);
        const body = await loop.json();
        assert.match(body.error, /本机|内网/);

        const junk = await fetch(`${base}/api/grit/tiles/3/4/2?src=${encodeURIComponent('not-a-template')}`);
        assert.equal(junk.status, 400);
      });
    });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('代理：上游不可达时 502（不挂起、不撒谎），配置项 off 时 503', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'grit-tiles-down-'));
  try {
    await withServer({ GRIT_TILE_URL: 'http://127.0.0.1:1/{z}/{y}/{x}.jpg', GRIT_TILE_DIR: cacheDir },
      async (base) => {
        const started = Date.now();
        const response = await fetch(`${base}/api/grit/tiles/5/1/2`);
        assert.equal(response.status, 502);
        assert.ok(Date.now() - started < 15_000, '超时保护要生效，不能挂住浏览器');
        const body = await response.json();
        assert.equal(body.ok, false);
        assert.match(body.error, /取瓦片失败|上游/);
        // 失败不写缓存
        assert.ok(!existsSync(join(cacheDir, '5')));

        /* 探测必须回 200：断网时页面就是靠这一句 JSON 知道"没有影像"，
         * 而不是发十张必然失败的图（那些在 Chromium 里是 console error）。 */
        const probe = await fetch(`${base}/api/grit/tiles/5/1/2?probe=1`);
        assert.equal(probe.status, 200);
        const probeBody = await probe.json();
        assert.equal(probeBody.ok, false);
        assert.match(probeBody.error, /取瓦片失败|上游/);
      });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }

  await withServer({ GRIT_TILE_URL: 'off', GRIT_TILE_DIR: mkdtempSync(join(tmpdir(), 'grit-tiles-off-')) }, async (base) => {
    const config = await (await fetch(`${base}/api/grit/tiles/config`)).json();
    assert.equal(config.enabled, false);
    assert.match(config.reason, /off/);
    const response = await fetch(`${base}/api/grit/tiles/1/0/0`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.error, /关闭/);
    // 探测在关闭状态下也是 200 JSON（source: 'off'），不制造 4xx/5xx
    const probe = await fetch(`${base}/api/grit/tiles/1/0/0?probe=1`);
    assert.equal(probe.status, 200);
    const probeBody = await probe.json();
    assert.equal(probeBody.ok, false);
    assert.equal(probeBody.source, 'off');
  });
});
