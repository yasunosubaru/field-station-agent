/**
 * The LuciadRIA stage — the real engine, driven by the CSVs the Graph panel already reads.
 *
 * This file lives in an iframe (`luciad-stage.html`) for one reason: the shell page is served with
 * `script-src 'self'`, which blocks `WebAssembly.instantiate`, and LuciadRIA 2026.0 is a wasm+WebGPU
 * engine. A same-origin document we serve ourselves can carry its own CSP with
 * `'wasm-unsafe-eval'`, so the engine boots there.
 *
 * It imports the engine from `/geo/luciad-engine.js`, which is the **shipped Graph renderer bundle**
 * with its `ReactDOM.createRoot(...)` call cut off and `luciad-exports.js` appended — see
 * `server.ts handleLuciadEngine()`. Nothing of the Graph React app runs: only module-scope classes
 * the bundle already declared.
 *
 * The panel talks to this document with `postMessage` only:
 *
 *   panel → stage   {type:'track', points:[[lon,lat]], sigmaM, trackColor, fit}
 *                   {type:'cursor', index}      index < 0 hides the marker
 *                   {type:'zoom', factor}       1.6 zooms out, 1/1.6 zooms in
 *                   {type:'fit'} / {type:'recenter'}
 *   stage → panel   {type:'ready', engine, reference, webgpu}
 *                   {type:'error', message}
 *                   {type:'view', centerLon, centerLat, spanM, label}
 *                   {type:'hover', lon, lat}    lon === null → pointer left the map
 *                   {type:'cursor', x, y, visible}
 *
 * Everything drawn here is a Luciad feature: the graticule, the metric grid, the 1σ ring, the track,
 * its vertices, the start/end markers and the timeline cursor. The stage owns no data — the panel
 * sends the same `2D Trajectory.csv` / `Position SD.csv` rows the self-drawn map uses.
 */
import {
  MAP_TRACK_COLOR,
  MAP_MIN_FIT_SPAN_M,
  degreeStep,
  metersPerDegree,
  niceStep,
  scaleBar,
  tickValues,
  formatDegrees,
  formatDistance,
  latLabel,
  lonLabel,
} from '../panels/graph.js';

/**
 * The engine is imported **dynamically on purpose**: a static `import` that 404s (no `01_解包`, a
 * broken route) kills the whole module before a line of ours runs, and then the panel sits on
 * "正在启动 LuciadRIA…" until its timeout. This way the failure is caught here and reported at once.
 */
let engine = null;
try {
  engine = await import('./luciad-engine.js');
} catch (error) {
  const reason = `引擎模块加载失败：${(error && error.message) || error}`;
  const node = document.getElementById('status');
  if (node) {
    node.hidden = false;
    node.textContent = reason;
  }
  post({ type: 'error', message: reason });
}
const {
  RIAMap,
  getReference,
  createPoint,
  createPolyline,
  createCircleByCenterPoint,
  createBounds,
  createTransformation,
  Feature,
  FeatureModel,
  MemoryStore,
  FeatureLayer,
  FeaturePainter,
  LayerType,
  PointLabelPosition,
} = engine || {};

const CRS84 = getReference('CRS:84');
const STAGE = document.getElementById('stage');
const STATUS = document.getElementById('status');
const SCALE = document.getElementById('scale');
const SCALE_BAR = document.getElementById('scaleBar');
const SCALE_TEXT = document.getElementById('scaleText');

const state = {
  points: [],
  sigmaM: 0,
  trackColor: MAP_TRACK_COLOR,
  cursorIndex: -1,
  map: null,
  toMap: null,
  toGeo: null,
  ready: false,
  gridKey: '',
  fitted: false,
  layers: {},
};

function post(message) {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(message, window.location.origin);
    }
  } catch {
    /* the panel is gone; nothing to report to */
  }
}

function setStatus(text) {
  if (!STATUS) return;
  STATUS.hidden = !text;
  if (text) STATUS.textContent = text;
}

/* ---------------- stores ---------------- */

/**
 * Replace a store's contents by id. `put()` is add-or-update, so this is safe without relying on
 * `clear()`; the ids the stage wrote last time are tracked on the layer so a shrinking list (fewer
 * grid lines after a zoom) never leaves a stale feature behind.
 */
function setFeatures(entry, features) {
  const keep = new Set();
  for (const item of features) {
    entry.store.put(new Feature(item.shape, item.properties || {}, item.id));
    keep.add(item.id);
  }
  for (const id of entry.ids) {
    if (!keep.has(id)) entry.store.remove(id);
  }
  entry.ids = keep;
}

/* ---------------- layers ---------------- */

/**
 * One painter vocabulary for every layer: `properties.kind` picks the style, so the whole drawing
 * lives in one place and the colours are the self-drawn basemap's — switching engines does not
 * change what the picture means.
 */
function bodyPainter() {
  const painter = new FeaturePainter();
  painter.paintBody = (geoCanvas, feature, shape) => {
    const kind = (feature.properties && feature.properties.kind) || '';
    switch (kind) {
      case 'track':
        geoCanvas.drawShape(shape, { stroke: { width: 2.4, color: state.trackColor } });
        return;
      case 'grid':
        geoCanvas.drawShape(shape, { stroke: { width: 1, color: 'rgba(0,0,0,0.12)' } });
        return;
      case 'mgrid':
        geoCanvas.drawShape(shape, { stroke: { width: 1, color: 'rgba(0,0,0,0.08)' } });
        return;
      case 'sigma':
        geoCanvas.drawShape(shape, {
          stroke: { width: 1, color: 'rgba(0,81,111,0.55)' },
          fill: { color: 'rgba(0,81,111,0.07)' },
        });
        return;
      case 'start':
        geoCanvas.drawShape(shape, { stroke: { width: 2, color: '#2e8b57' }, fill: { color: '#ffffff' } });
        return;
      case 'end':
        geoCanvas.drawShape(shape, { stroke: { width: 1, color: '#d0021b' }, fill: { color: '#d0021b' } });
        return;
      case 'cursor':
        geoCanvas.drawShape(shape, { stroke: { width: 2, color: '#00516f' }, fill: { color: '#00abc8' } });
        return;
      default:
        geoCanvas.drawShape(shape, { stroke: { width: 1.6, color: state.trackColor }, fill: { color: '#ffffff' } });
    }
  };
  return painter;
}

function labelPainter() {
  const painter = new FeaturePainter();
  // A painter must implement `paintBody`; for this layer the body is the anchor point of a label and
  // is deliberately not drawn.
  painter.paintBody = () => {};
  painter.paintLabel = (labelCanvas, feature, shape) => {
    const properties = feature.properties || {};
    if (!properties.text) return;
    labelCanvas.drawLabel(properties.text, shape, {
      positions: properties.below ? PointLabelPosition.SOUTH : PointLabelPosition.EAST,
    });
  };
  return painter;
}

function addLayer(id, painter) {
  const store = new MemoryStore({ reference: CRS84 });
  const model = new FeatureModel(store, { reference: CRS84 });
  const layer = new FeatureLayer(model, { id, label: id, painter, layerType: LayerType.STATIC });
  state.map.layerTree.addChild(layer);
  return { store, layer, ids: new Set() };
}

/* ---------------- camera ---------------- */

function viewSize() {
  if (!state.map) return { width: 0, height: 0 };
  return { width: state.map.getViewWidth(), height: state.map.getViewHeight() };
}

/**
 * The visible rectangle in lon/lat, read back from the engine (`map.mapBounds` is the view rectangle
 * in the map's own reference, EPSG:32662 for a 2D CRS:84 map) — never assumed.
 */
function viewRect() {
  const map = state.map;
  if (!map) return null;
  const b = map.mapBounds;
  if (!b || !(b.width > 0) || !(b.height > 0)) return null;
  const low = state.toGeo.transform(createPoint(map.reference, [b.x, b.y, 0]));
  const high = state.toGeo.transform(createPoint(map.reference, [b.x + b.width, b.y + b.height, 0]));
  return {
    lonMin: Math.min(low.x, high.x),
    lonMax: Math.max(low.x, high.x),
    latMin: Math.min(low.y, high.y),
    latMax: Math.max(low.y, high.y),
  };
}

function describeView() {
  const rect = viewRect();
  const { width, height } = viewSize();
  if (!rect || !width || !height) return null;
  const centerLon = (rect.lonMin + rect.lonMax) / 2;
  const centerLat = (rect.latMin + rect.latMax) / 2;
  /* True ground metres: Plate Carrée's x is not shrunk by cos φ, so derive the span the way the
   * self-drawn basemap does — both engines then report the same number for the same picture. */
  const per = metersPerDegree(centerLat);
  const spanM = (rect.lonMax - rect.lonMin) * per.lon;
  return { centerLon, centerLat, spanM, width, height, rect, pxPerM: width / Math.max(1e-9, spanM) };
}

/**
 * Fit a lon/lat rectangle. The bounds are handed to the navigator **in the map's own reference**:
 * `mapNavigator.fit()` does not transform a CRS:84 bounds for us (it reads the numbers as map
 * coordinates), which is the one thing about this API that bites silently — a CRS:84 box puts the
 * camera somewhere plausible-looking and completely wrong.
 */
function fitLonLat(lonMin, latMin, lonMax, latMax) {
  if (!state.map) return;
  const low = state.toMap.transform(createPoint(CRS84, [lonMin, latMin], 0));
  const high = state.toMap.transform(createPoint(CRS84, [lonMax, latMax], 0));
  const minX = Math.min(low.x, high.x);
  const maxX = Math.max(low.x, high.x);
  const minY = Math.min(low.y, high.y);
  const maxY = Math.max(low.y, high.y);
  state.map.mapNavigator.fit({
    bounds: createBounds(state.map.reference, [minX, maxX - minX, minY, maxY - minY]),
    animate: false,
  });
}

function fitTrack(margin = 1.15) {
  const points = state.points;
  if (!points.length || !state.map) return;
  const { width, height } = viewSize();
  if (!width || !height) return;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const point of points) {
    if (point.lon < minLon) minLon = point.lon;
    if (point.lon > maxLon) maxLon = point.lon;
    if (point.lat < minLat) minLat = point.lat;
    if (point.lat > maxLat) maxLat = point.lat;
  }
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const per = metersPerDegree(centerLat);
  const eastM = (maxLon - minLon) * per.lon;
  const northM = (maxLat - minLat) * per.lat;
  const aspect = width / height;
  const spanM = Math.max(MAP_MIN_FIT_SPAN_M, eastM * margin, northM * aspect * margin);
  const lonHalf = spanM / per.lon / 2;
  const latHalf = spanM / aspect / per.lat / 2;
  fitLonLat(centerLon - lonHalf, centerLat - latHalf, centerLon + lonHalf, centerLat + latHalf);
  state.fitted = true;
}

/**
 * Fit as soon as the stage has a size. `boot()` resolves before the iframe's first layout, and a
 * `fit` computed from a 0×0 view is silently wrong, so retry on the next frames instead of giving up.
 */
function fitWhenSized(attempt = 0) {
  const { width, height } = viewSize();
  if (width > 0 && height > 0) {
    fitTrack();
    refresh();
    return;
  }
  if (attempt < 90) window.requestAnimationFrame(() => fitWhenSized(attempt + 1));
}

/* ---------------- drawing ---------------- */

function drawGraticule(view) {
  const rect = view.rect;
  const lonSpan = rect.lonMax - rect.lonMin;
  const latSpan = rect.latMax - rect.latMin;
  const stepLon = degreeStep(lonSpan);
  const stepLat = degreeStep(latSpan);
  const key = [
    stepLon, stepLat,
    rect.lonMin.toFixed(7), rect.latMin.toFixed(7),
    lonSpan.toFixed(7), latSpan.toFixed(7),
  ].join('|');
  if (key === state.gridKey) return;
  state.gridKey = key;

  const lines = [];
  const labels = [];
  const lonTicks = tickValues(rect.lonMin, rect.lonMax, stepLon).slice(0, 40);
  const latTicks = tickValues(rect.latMin, rect.latMax, stepLat).slice(0, 40);
  // Labels sit just inside the edge of the view, so a label on the boundary is still readable.
  const insetLon = lonSpan * 0.006;
  const insetLat = latSpan * 0.02;

  lonTicks.forEach((lon, index) => {
    lines.push({
      id: index,
      shape: createPolyline(CRS84, [
        createPoint(CRS84, [lon, rect.latMin], 0),
        createPoint(CRS84, [lon, rect.latMax], 0),
      ]),
      properties: { kind: 'grid' },
    });
    labels.push({
      id: index,
      shape: createPoint(CRS84, [lon, rect.latMax - insetLat], 0),
      properties: { text: `${formatDegrees(lon, stepLon)}°${lon >= 0 ? 'E' : 'W'}`, below: true },
    });
  });

  latTicks.forEach((lat, index) => {
    lines.push({
      id: 100 + index,
      shape: createPolyline(CRS84, [
        createPoint(CRS84, [rect.lonMin, lat], 0),
        createPoint(CRS84, [rect.lonMax, lat], 0),
      ]),
      properties: { kind: 'grid' },
    });
    labels.push({
      id: 100 + index,
      shape: createPoint(CRS84, [rect.lonMin + insetLon, lat], 0),
      properties: { text: `${formatDegrees(lat, stepLat)}°${lat >= 0 ? 'N' : 'S'}`, below: false },
    });
  });

  /* Metric grid: the layer that makes the interior of a 24 m box legible. 1-2-5 metres, only while
   * its spacing stays readable (36…200 px) — the same rule `mapSvg()` uses. */
  const meterStep = niceStep(72 / view.pxPerM);
  const meterPx = meterStep * view.pxPerM;
  if (meterPx >= 36 && meterPx <= 200) {
    const per = metersPerDegree(view.centerLat);
    const lonStep = meterStep / per.lon;
    const latStep = meterStep / per.lat;
    tickValues(rect.lonMin, rect.lonMax, lonStep).slice(0, 60).forEach((lon, index) => {
      lines.push({
        id: 200 + index,
        shape: createPolyline(CRS84, [
          createPoint(CRS84, [lon, rect.latMin], 0),
          createPoint(CRS84, [lon, rect.latMax], 0),
        ]),
        properties: { kind: 'mgrid' },
      });
    });
    tickValues(rect.latMin, rect.latMax, latStep).slice(0, 60).forEach((lat, index) => {
      lines.push({
        id: 300 + index,
        shape: createPolyline(CRS84, [
          createPoint(CRS84, [rect.lonMin, lat], 0),
          createPoint(CRS84, [rect.lonMax, lat], 0),
        ]),
        properties: { kind: 'mgrid' },
      });
    });
  }

  setFeatures(state.layers.grid, lines);
  setFeatures(state.layers.labels, labels);
}

function drawTrack() {
  const points = state.points;
  const bodies = [];
  const markers = [];
  if (!points.length) {
    setFeatures(state.layers.track, bodies);
    setFeatures(state.layers.markers, markers);
    return;
  }

  if (state.sigmaM > 0) {
    bodies.push({
      id: 'sigma',
      shape: createCircleByCenterPoint(
        CRS84,
        createPoint(CRS84, [points[0].lon, points[0].lat], 0),
        state.sigmaM / 111132.9,
      ),
      properties: { kind: 'sigma' },
    });
  }
  if (points.length > 1) {
    bodies.push({
      id: 'track',
      shape: createPolyline(CRS84, points.map((point) => createPoint(CRS84, [point.lon, point.lat], 0))),
      properties: { kind: 'track' },
    });
  }
  points.forEach((point, index) => {
    bodies.push({
      id: `v${index}`,
      shape: createPoint(CRS84, [point.lon, point.lat], 0),
      properties: { kind: 'vertex', index },
    });
  });

  markers.push({
    id: 'start',
    shape: createPoint(CRS84, [points[0].lon, points[0].lat], 0),
    properties: { kind: 'start' },
  });
  if (points.length > 1) {
    const last = points[points.length - 1];
    markers.push({
      id: 'end',
      shape: createPoint(CRS84, [last.lon, last.lat], 0),
      properties: { kind: 'end' },
    });
  }

  setFeatures(state.layers.track, bodies);
  setFeatures(state.layers.markers, markers);
}

/* ---------------- pixels ---------------- */

/** lon/lat → stage pixels, straight off the engine's own view rectangle. */
function toStagePx(lon, lat) {
  const map = state.map;
  if (!map) return null;
  const b = map.mapBounds;
  const { width, height } = viewSize();
  if (!b || !width || !height) return null;
  const p = state.toMap.transform(createPoint(CRS84, [lon, lat], 0));
  return {
    x: ((p.x - b.x) / b.width) * width,
    y: ((b.y + b.height - p.y) / b.height) * height,
  };
}

/** stage pixel → map-reference coordinates (the inverse of `toStagePx`). */
function toMapPoint(offsetX, offsetY) {
  const map = state.map;
  const b = map && map.mapBounds;
  const { width, height } = viewSize();
  if (!b || !width || !height) return null;
  return {
    x: b.x + (offsetX / width) * b.width,
    y: b.y + ((height - offsetY) / height) * b.height,
  };
}

function drawCursor() {
  const index = state.cursorIndex;
  if (index < 0 || index >= state.points.length) {
    setFeatures(state.layers.cursor, []);
    post({ type: 'cursor', x: 0, y: 0, visible: false });
    return;
  }
  const point = state.points[index];
  setFeatures(state.layers.cursor, [{
    id: 'cursor',
    shape: createPoint(CRS84, [point.lon, point.lat], 0),
    properties: { kind: 'cursor' },
  }]);
  const px = toStagePx(point.lon, point.lat);
  const { width, height } = viewSize();
  const visible = Boolean(px) && px.x > -20 && px.x < width + 20 && px.y > -20 && px.y < height + 20;
  post({ type: 'cursor', x: px ? px.x : 0, y: px ? px.y : 0, visible });
}

function paintScaleBar(view) {
  if (!SCALE || !SCALE_BAR) return;
  const bar = scaleBar(view.pxPerM, Math.min(150, Math.max(48, view.width * 0.26)));
  if (!(bar.px > 4)) {
    SCALE.hidden = true;
    return;
  }
  const half = bar.px / 2;
  SCALE.hidden = false;
  SCALE_BAR.style.width = `${bar.px.toFixed(1)}px`;
  const dark = SCALE_BAR.querySelector('.dark');
  const light = SCALE_BAR.querySelector('.light');
  if (dark) dark.style.width = `${half.toFixed(1)}px`;
  if (light) {
    light.style.width = `${half.toFixed(1)}px`;
    light.style.left = `${half.toFixed(1)}px`;
  }
  if (SCALE_TEXT) SCALE_TEXT.textContent = bar.label;
}

function refresh() {
  const view = describeView();
  if (!view) return;
  drawGraticule(view);
  paintScaleBar(view);
  drawCursor();
  post({
    type: 'view',
    centerLon: view.centerLon,
    centerLat: view.centerLat,
    spanM: view.spanM,
    label: `${latLabel(view.centerLat, 6)}  ${lonLabel(view.centerLon, 6)} · 视野 ${formatDistance(view.spanM)}`,
  });
}

/* ---------------- boot ---------------- */

async function boot() {
  state.map = new RIAMap(STAGE, { reference: CRS84 });
  await state.map.whenReady();

  const map = state.map;
  state.toMap = createTransformation(CRS84, map.reference);
  state.toGeo = createTransformation(map.reference, CRS84);

  /* Constraints: the whole world, and enough depth to see a 0.4 m box. `snapToZoomLevels` off —
   * these tracks are metres, and snapping to tile levels would hide them. Like `fit`, the navigator
   * reads `limitBounds` **in the map's reference**, so the world box is converted, not handed over
   * as CRS:84 degrees (that would clamp the camera to a 360 m × 165 m box at the origin). */
  const worldLow = state.toMap.transform(createPoint(CRS84, [-180, -80], 0));
  const worldHigh = state.toMap.transform(createPoint(CRS84, [180, 85], 0));
  map.mapNavigator.constraints = {
    limitBounds: {
      bounds: createBounds(map.reference, [
        Math.min(worldLow.x, worldHigh.x),
        Math.abs(worldHigh.x - worldLow.x),
        Math.min(worldLow.y, worldHigh.y),
        Math.abs(worldHigh.y - worldLow.y),
      ]),
    },
    minScale: 0.00005,
    maxScale: 20000000,
    snapToZoomLevels: false,
  };

  state.layers.grid = addLayer('graticule', bodyPainter());
  state.layers.labels = addLayer('graticule-labels', labelPainter());
  state.layers.track = addLayer('track', bodyPainter());
  state.layers.markers = addLayer('markers', bodyPainter());
  state.layers.cursor = addLayer('cursor', bodyPainter());

  map.on('MapChange', () => {
    window.requestAnimationFrame(() => {
      if (state.ready) refresh();
    });
  });

  map.domNode.addEventListener('pointermove', (event) => {
    const point = toMapPoint(event.offsetX, event.offsetY);
    if (!point) return;
    const geo = state.toGeo.transform(createPoint(map.reference, [point.x, point.y, 0]));
    post({ type: 'hover', lon: geo.x, lat: geo.y, x: event.offsetX, y: event.offsetY });
  });
  map.domNode.addEventListener('pointerleave', () => post({ type: 'hover', lon: null, lat: null }));

  state.ready = true;
  setStatus('');
  post({
    type: 'ready',
    engine: 'LuciadRIA',
    reference: map.reference.identifier,
    webgpu: typeof navigator !== 'undefined' && Boolean(navigator.gpu),
  });
  refresh();
}

/* ---------------- messages ---------------- */

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin) return;
  const data = event.data || {};
  if (data.type === 'track') {
    state.points = Array.isArray(data.points)
      ? data.points
        .map((point) => ({ lon: Number(point[0]), lat: Number(point[1]) }))
        .filter((point) => Number.isFinite(point.lon) && Number.isFinite(point.lat))
      : [];
    state.sigmaM = Number(data.sigmaM) || 0;
    state.trackColor = data.trackColor || MAP_TRACK_COLOR;
    drawTrack();
    if (data.fit || !state.fitted) fitWhenSized();
    else refresh();
    return;
  }
  if (data.type === 'cursor') {
    state.cursorIndex = Number.isInteger(data.index) ? data.index : -1;
    drawCursor();
    return;
  }
  if (data.type === 'zoom' && state.map) {
    const factor = Number(data.factor);
    if (Number.isFinite(factor) && factor > 0) {
      state.map.mapNavigator.zoom({ factor, animate: false });
      refresh();
    }
    return;
  }
  if ((data.type === 'fit' || data.type === 'recenter') && state.map) {
    fitWhenSized();
  }
});

window.addEventListener('resize', () => {
  if (!state.ready) return;
  window.requestAnimationFrame(() => refresh());
});

if (engine) {
  boot().catch((error) => {
    const reason = `Luciad 启动失败：${(error && error.message) || error}`;
    setStatus(reason);
    post({ type: 'error', message: String((error && (error.stack || error.message)) || error) });
  });
}

/**
 * Self-report for the browser check (`graph-map.test.ts` can only test the pure side of this).
 * Read-only, and the panel never calls it: it exists so a screenshot run can prove *which* engine
 * painted the stage instead of trusting the label.
 */
window.__luciadStage = {
  status() {
    const map = state.map;
    const bounds = map && map.mapBounds ? {
      x: map.mapBounds.x,
      y: map.mapBounds.y,
      width: map.mapBounds.width,
      height: map.mapBounds.height,
    } : null;
    return {
      engine: 'LuciadRIA',
      ready: state.ready,
      reference: map ? map.reference.identifier : null,
      webgpu: typeof navigator !== 'undefined' && Boolean(navigator.gpu),
      points: state.points.length,
      layers: Object.keys(state.layers),
      canvases: document.querySelectorAll('canvas').length,
      cursorIndex: state.cursorIndex,
      bounds,
      view: state.ready ? describeView() : null,
    };
  },
  storeSize(layer) {
    const entry = state.layers[layer];
    return entry ? entry.ids.size : -1;
  },
  /** Debug hooks for a browser check: drive the camera the same way the panel does. */
  fitTrack() { fitTrack(); refresh(); },
  fitLonLat(lonMin, latMin, lonMax, latMax) { fitLonLat(lonMin, latMin, lonMax, latMax); refresh(); },
  map() { return state.map; },
};
