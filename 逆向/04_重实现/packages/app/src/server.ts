/**
 * Zero-dependency HTTP shell for the reimplementation.
 *
 *   node packages/app/src/server.ts [--port 7788]
 *
 * Listens on 127.0.0.1 only. Serves one inline-CSS/JS page and a small JSON API over the samples
 * tree; the page never writes a file, and every capture lookup is confined to
 * `逆向/00_来源/samples/` (see paths.ts).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CONVERT_FORMATS,
  convertCapture,
  FORMAT_LABELS,
  FORMAT_NOTES,
  isConvertFormat,
  type ConvertArtifact,
  type ConvertFormat,
} from './convert.ts';
import type { ConvertOutputAffix, ConvertTimePoint, UnknownBytesMode } from '../../protocol/src/convert-pipeline.ts';
import { utcDateToGps } from '../../protocol/src/time.ts';
import { loadCapture, tables } from './capture.ts';
import {
  applyConfigEvent,
  configLogRequests,
  configPageDocument,
  configPageList,
  configStylesheet,
  deviceExportFile,
  deviceImportApply,
  deviceImportPreview,
  deviceStatus,
  eventsSummary,
  feedConfigFromEntries,
  feedEventsFromEntries,
  feedEventsItk,
  isConfigPage,
  primeEventsPage,
  readConfigAsset,
  refreshConfigPage,
} from './config-http.ts';
import { LiveLink, type LiveTarget } from './live.ts';
import { listSerialPorts } from './ports.ts';
import type { SerialOpener } from '../../session/src/transport.ts';
import { readRecords, readTextRecords, summarizeLogs } from './logs.ts';
import { playbackEvents, playbackExport, playbackFrame, playbackFrames, playbackInfo } from './playback.ts';
import { GRAPH_CSV_DIR, graphData, listGraphCsv } from './graphcsv.ts';
import {
  GraphCsvError,
  listExportProjects,
  listProjectCsv,
  projectCsvText,
  projectGraphData,
  readProjectFlags,
  resolveExportProject,
  writeProjectFlags,
  type ExportProject,
} from '../../graph/src/export-projects.ts';
import { graphPdfOrder, graphPdfReport } from './pdf.ts';
import { WorkflowBridge, assertJobId, assertWorkflowId } from './workflows.ts';
import { AgentBridge, handleAgentRoute } from './agent-bridge.ts';
import {
  GRIT_TILE_ATTRIBUTION,
  GRIT_TILE_DEFAULT_URL,
  gritTileTemplate,
  gritTileUrl,
} from './web/panels/grit.js';
import {
  HttpError,
  SAMPLES_DIR,
  REPO_DIR,
  WEB_DIR,
  PROTOCOL_DATA_DIR,
  listCaptures,
  resolveCapture,
} from './paths.ts';

const SERVICE = 'nas-reimpl-app';
const VERSION = '0.2.0';
const HOST = '127.0.0.1';
const DEFAULT_PORT = 7788;
const JSON_LIMIT = 1_000_000;

interface CachedArtifact {
  token: string;
  fileName: string;
  contentType: string;
  bytes: Buffer;
  format: ConvertFormat;
  createdAt: number;
}

/** Last converted artifacts, kept in memory so the download link does not re-run the pipeline. */
const artifacts = new Map<string, CachedArtifact>();
const ARTIFACT_LIMIT = 40;
/** One bridge for the process; the executor itself is spawned per call. */
const workflowBridge = new WorkflowBridge();
/**
 * The Python agent server is spawned lazily on the first `/api/agent/*` request, so the bridge
 * needs the port only at that moment — hence a getter rather than a value.
 */
let listeningPort = 0;
const agentBridge = new AgentBridge({ nodePort: () => listeningPort });

function rememberArtifact(artifact: CachedArtifact): void {
  artifacts.set(artifact.token, artifact);
  while (artifacts.size > ARTIFACT_LIMIT) {
    const oldest = artifacts.keys().next().value;
    if (oldest === undefined) break;
    artifacts.delete(oldest);
  }
}

function parsePort(argv: string[]): number {
  let value = process.env.PORT ?? String(DEFAULT_PORT);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--port' || token === '-p') value = argv[++i] ?? value;
    else if (token.startsWith('--port=')) value = token.slice('--port='.length);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`端口不合法：${value}`);
  }
  return port;
}

function sendJson(res: ServerResponse, status: number, payload: unknown, method = 'GET'): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function sendBytes(
  res: ServerResponse,
  status: number,
  bytes: Uint8Array,
  headers: Record<string, string>,
  method = 'GET',
): void {
  res.writeHead(status, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': bytes.byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  if (method === 'HEAD') res.end();
  else res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.byteLength;
    if (size > JSON_LIMIT) throw new HttpError(413, '请求体过大');
    chunks.push(buf);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ask a configuration page's receiver for the logs it needs, feed the answers into the page, and
 * rebuild it — then the caller serialises a document that already holds the real values.
 *
 * The requests are spaced out: the receiver's command buffer drops lines that arrive back-to-back
 * while a log stream is running (measured on the desk OEM729, 2026-11-01 — ten `LOG … ONCE` in one
 * burst lost INTERFACEMODE/LOGLIST/SERIALCONFIG, the same lines 150 ms apart were all answered).
 * The loop ends early once nothing new arrives for ~1.5 s, so an offline receiver costs nothing.
 */
async function primeConfigurationPage(name: string): Promise<void> {
  const lines = configLogRequests(name);
  if (!lines.length) return;
  const link = liveLink();
  if (!link.status().connected) return;
  for (const line of lines) {
    link.send(line);
    await delay(150);
  }
  let quiet = 0;
  for (let round = 0; round < 24 && quiet < 6; round++) {
    await delay(250);
    const fed = feedConfigFromEntries(link.logs(0).entries);
    quiet = fed > 0 ? 0 : quiet + 1;
  }
  refreshConfigPage(name);
}

function integer(value: string | null, fallback: number, min: number, max: number, label: string): number {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${label} 必须是 ${min}..${max} 的整数`);
  }
  return parsed;
}

/** Seconds as a decimal; `undefined` when the value is absent. */
function seconds(value: unknown, label: string): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(parsed) || parsed < 0) throw new HttpError(400, `${label} 必须是 ≥ 0 的秒数`);
  return parsed;
}

function formatOptions() {
  return CONVERT_FORMATS.map((format) => ({
    id: format,
    label: FORMAT_LABELS[format],
    note: FORMAT_NOTES[format],
  }));
}

/** One live session for the whole server process; the UI opens it from the Terminal page. */
let liveInstance: LiveLink | undefined;
function liveLink(): LiveLink {
  if (!liveInstance) liveInstance = new LiveLink(PROTOCOL_DATA_DIR);
  return liveInstance;
}

/**
 * `serialport` is optional (the repo installs nothing by default), so the opener is resolved at
 * connect time and its absence is reported as a plain error instead of a crash.
 */
async function serialOpener(): Promise<SerialOpener | undefined> {
  try {
    const name = 'serialport';
    const loaded = (await import(name)) as {
      SerialPort?: new (options: Record<string, unknown>) => never;
      default?: { SerialPort?: new (options: Record<string, unknown>) => never };
    };
    const Port = loaded.SerialPort ?? loaded.default?.SerialPort;
    if (!Port) return undefined;
    return async (path, options) => new Port({ path, autoOpen: true, ...options }) as never;
  } catch {
    return undefined;
  }
}

async function handleLiveConnect(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'POST') throw new HttpError(405, '/api/live/connect 只接受 POST');
  const body = await readJsonBody(req);
  const kind = String(body.kind ?? 'tcp').toLowerCase();
  if (kind !== 'serial' && kind !== 'tcp' && kind !== 'udp') {
    throw new HttpError(400, 'kind 必须是 serial / tcp / udp');
  }
  const target: LiveTarget = { kind };
  if (kind === 'serial') {
    if (typeof body.path !== 'string' || body.path.trim() === '') throw new HttpError(400, '串口需要 path（COM8）');
    target.path = body.path.trim();
    if (body.baud !== undefined) target.baud = integer(String(body.baud), 115200, 300, 4_000_000, 'baud');
  } else {
    target.host = typeof body.host === 'string' && body.host ? body.host : '127.0.0.1';
    target.port = integer(body.port === undefined ? 3001 : String(body.port), 3001, 1, 65535, 'port');
  }
  try {
    const status = await liveLink().connect(target, await serialOpener());
    sendJson(res, 200, { ok: true, ...status }, method);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
}

async function handleLiveCommand(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'POST') throw new HttpError(405, '/api/live/command 只接受 POST');
  const body = await readJsonBody(req);
  const line = typeof body.line === 'string' ? body.line : '';
  if (!line.trim()) throw new HttpError(400, 'line 不能为空');
  // 200 with `ok: false` for "not connected": the Terminal page shows the error, it is not a
  // malformed request.
  sendJson(res, 200, { ok: true, ...liveLink().send(line) }, method);
}

function health() {
  return {
    ok: true,
    service: SERVICE,
    version: VERSION,
    node: process.version,
    host: HOST,
    samples: relative(REPO_DIR, SAMPLES_DIR).split('\\').join('/'),
    formats: formatOptions(),
    limits: { previewLines: 200, jsonBodyBytes: JSON_LIMIT, artifactsKept: ARTIFACT_LIMIT },
    endpoints: [
      '/api/health',
      '/api/captures',
      '/api/convert',
      '/api/download',
      '/api/logs',
      '/api/records',
      '/api/playback/info',
      '/api/playback/frames',
      '/api/playback/frame',
      '/api/playback/export',
      '/api/playback/events',
      '/api/graph/projects',
      '/api/graph/files',
      '/api/graph/data',
      '/api/graph/flags',
      '/api/graph/pdf',
      '/api/live/status',
      '/api/ports',
      '/api/live/logs',
      '/api/live/connect',
      '/api/live/disconnect',
      '/api/live/command',
      '/api/grit/tiles/config',
      '/api/grit/tiles/{z}/{x}/{y}',
    ],
  };
}

/* ---------------------------------------------------------------------------------------------
 * GRIT Position Overview · Satellite imagery — tile proxy + disk cache
 *
 * The Satellite tab asks for `{z}/{x}/{y}` and gets bytes back. The browser never talks to the
 * imagery host and never sees a key; a second look (or a session with no network) is answered
 * from `GRIT_TILE_DIR`.
 *
 *   GRIT_TILE_URL   XYZ template — `{z}/{x}/{y}`, `{-y}` (TMS), `{s}`, `{key}`. `off` disables
 *                   imagery. Default: Esri World Imagery, a **public** source. The original draws
 *                   Google Maps with a key from the installed app's `configurationfile.node`
 *                   (`03_分析/05_GRIT-Monitor.md` §2.3), which this build neither has nor may reuse,
 *                   so the tile is a substitute and says so on the map.
 *   GRIT_TILE_KEY   substituted into `{key}`; env only, never the repo.
 *   GRIT_TILE_DIR   cache directory; default `<OS temp>/nas-grit-tiles` (kept out of the repo).
 *
 * A tile is cached only when it really is an image (content-type + non-empty + size cap), written
 * through a temp file so a half-written tile can never be served. `?src=` lets the operator point
 * one browser at another public source; it is validated (http(s), `{z}/{x}/{y}`, no loopback or
 * private host) because fetching an arbitrary URL is the one thing a proxy must not do quietly.
 * ------------------------------------------------------------------------------------------- */

const GRIT_TILE_TIMEOUT_MS = 8000;
const GRIT_TILE_MAX_BYTES = 2 * 1024 * 1024;
/* Default cache: the OS temp tree, NOT the repo — `04_重实现` is a git checkout and a tile cache
 * would otherwise show up as untracked files. `GRIT_TILE_DIR` moves it anywhere writable. */
const GRIT_TILE_CACHE_DIR = process.env.GRIT_TILE_DIR && process.env.GRIT_TILE_DIR.trim()
  ? resolve(process.env.GRIT_TILE_DIR.trim())
  : join(tmpdir(), 'nas-grit-tiles');
const GRIT_TILE_RAW = (process.env.GRIT_TILE_URL ?? '').trim();
const GRIT_TILE_KEY = (process.env.GRIT_TILE_KEY ?? '').trim();
/** `off` in the env means "no imagery", not "fall back to the default". */
const GRIT_TILE_OFF = ['off', 'none', '0', 'false', 'disabled'].includes(GRIT_TILE_RAW.toLowerCase());
const GRIT_TILE_UPSTREAM = GRIT_TILE_OFF
  ? ''
  : gritTileTemplate(GRIT_TILE_RAW) || GRIT_TILE_DEFAULT_URL;
const TILE_EXTENSION_TYPE: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};
const TILE_TYPE_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};
/** Only the label is guessed from the host; anything unknown is printed as its hostname. */
const TILE_HOST_LABELS: Record<string, string> = {
  'server.arcgisonline.com': 'Esri World Imagery',
  'services.arcgisonline.com': 'Esri World Imagery',
  'tile.openstreetmap.org': 'OpenStreetMap',
  'a.tile.openstreetmap.org': 'OpenStreetMap',
  'basemaps.cartocdn.com': 'CARTO',
  'tiles.stadiamaps.com': 'Stadia Maps',
};

function tileHost(template: string): string {
  if (!template) return '';
  try {
    return new URL(template.replace(/\{[^}]*\}/g, '0')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function tileLabel(template: string): string {
  const host = tileHost(template);
  return TILE_HOST_LABELS[host] || host || 'XYZ 瓦片';
}

/** The cache lives in one folder, or one per overridden template — two sources never mix tiles. */
function tileCacheDir(template: string | null): string {
  if (!template) return GRIT_TILE_CACHE_DIR;
  const hash = createHash('sha1').update(template).digest('hex').slice(0, 12);
  return join(GRIT_TILE_CACHE_DIR, `src-${hash}`);
}

function readCachedTile(dir: string, z: number, x: number, y: number): { bytes: Buffer; type: string } | null {
  for (const [ext, type] of Object.entries(TILE_EXTENSION_TYPE)) {
    const file = join(dir, String(z), String(x), `${y}.${ext}`);
    try {
      if (!existsSync(file)) continue;
      const info = statSync(file);
      if (!info.isFile() || info.size === 0) continue;
      return { bytes: readFileSync(file), type };
    } catch {
      /* an unreadable entry is a miss, not a reason to fail the request */
    }
  }
  return null;
}

function writeCachedTile(dir: string, z: number, x: number, y: number, ext: string, bytes: Buffer): boolean {
  try {
    const folder = join(dir, String(z), String(x));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${y}.${ext}`);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, bytes);
    renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}

/** `?src=` — an alternate public template, or a 400. Loopback and private hosts are refused. */
function tileSourceOverride(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  const template = gritTileTemplate(raw);
  if (!template || template === 'off') {
    throw new HttpError(400, '瓦片模板不合法：需要 http(s) 地址与 {z}/{x}/{y} 占位符');
  }
  const host = tileHost(template);
  const blocked = host === ''
    || host === 'localhost'
    || host === '0.0.0.0'
    || host === '::1'
    || host === '[::1]'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || /^127\./.test(host)
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (blocked) throw new HttpError(400, `瓦片模板不能指向本机或内网（${host || '无法解析'}）`);
  return template;
}

/** What the panel needs to label the layer: on/off, whose pixels, where the cache is. */
function gritTileConfig() {
  const template = GRIT_TILE_UPSTREAM;
  return {
    ok: true,
    enabled: Boolean(template),
    label: tileLabel(template),
    host: tileHost(template),
    attribution: GRIT_TILE_ATTRIBUTION,
    publicSource: true,
    proxy: '/api/grit/tiles/{z}/{x}/{y}',
    cache: 'disk',
    cacheRoot: GRIT_TILE_CACHE_DIR.split('\\').join('/'),
    reason: template ? '' : 'GRIT_TILE_URL=off：影像已关闭',
  };
}

/** One tile's bytes, from the cache or the upstream. Throws with the reason when there is none. */
interface TileResult {
  bytes: Buffer;
  type: string;
  source: 'cache' | 'upstream';
  stored: boolean;
}

async function fetchTileBytes(template: string, dir: string, z: number, x: number, y: number): Promise<TileResult> {
  const cached = readCachedTile(dir, z, x, y);
  if (cached) return { ...cached, source: 'cache', stored: false };

  const remote = gritTileUrl(template, { z, x, y }, { key: GRIT_TILE_KEY });
  if (!remote) throw new Error('瓦片 URL 无法构造（模板里的 {key} 没有配置）');

  let upstream: Response;
  try {
    upstream = await fetch(remote, {
      signal: AbortSignal.timeout(GRIT_TILE_TIMEOUT_MS),
      headers: { Accept: 'image/*', 'User-Agent': `nas-reimpl/${VERSION} (GRIT tile cache)` },
    });
  } catch (error) {
    throw new Error(`取瓦片失败：${(error as Error)?.message || String(error)}`);
  }
  if (!upstream.ok) throw new Error(`上游返回 HTTP ${upstream.status}`);
  const type = String(upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = TILE_TYPE_EXTENSION[type];
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (!ext) throw new Error(`上游返回的不是影像（${type || 'unknown'}）`);
  if (!bytes.byteLength) throw new Error('上游返回了空瓦片');
  if (bytes.byteLength > GRIT_TILE_MAX_BYTES) throw new Error(`瓦片过大（${bytes.byteLength} B）`);
  const stored = writeCachedTile(dir, z, x, y, ext, bytes);
  return { bytes, type, source: 'upstream', stored };
}

async function handleGritTiles(url: URL, res: ServerResponse, method: string): Promise<void> {
  const match = /^\/api\/grit\/tiles\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})$/.exec(url.pathname);
  if (!match) throw new HttpError(400, '瓦片路径应为 /api/grit/tiles/{z}/{x}/{y}');
  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (z > 22) throw new HttpError(400, 'z 超出 0..22');
  const span = 2 ** z;
  if (x >= span || y >= span) throw new HttpError(400, `x/y 超出 z=${z} 的范围`);

  const override = tileSourceOverride(url.searchParams.get('src'));
  const template = override || GRIT_TILE_UPSTREAM;
  const dir = tileCacheDir(override);

  /**
   * `?probe=1` — "would this tile work?" as a 200 JSON answer.
   *
   * Without it, an offline build paints ten `<img>`-less fetches that each fail, and Chromium logs
   * every failed subresource as a console error even when the JS handles it. The panel therefore
   * asks first: this request is a *report*, it always succeeds, and only a positive answer is
   * followed by the tile batch.
   */
  if (url.searchParams.get('probe') === '1') {
    if (!template) {
      sendJson(res, 200, { ok: false, source: 'off', error: '影像瓦片已关闭（GRIT_TILE_URL=off）' }, method);
      return;
    }
    try {
      const result = await fetchTileBytes(template, dir, z, x, y);
      sendJson(res, 200, {
        ok: true,
        source: result.source,
        type: result.type,
        bytes: result.bytes.byteLength,
      }, method);
    } catch (error) {
      sendJson(res, 200, { ok: false, error: (error as Error)?.message || String(error) }, method);
    }
    return;
  }

  if (!template) throw new HttpError(503, '影像瓦片已关闭（GRIT_TILE_URL=off）');

  let result: TileResult;
  try {
    result = await fetchTileBytes(template, dir, z, x, y);
  } catch (error) {
    throw new HttpError(502, (error as Error)?.message || String(error));
  }
  sendBytes(res, 200, result.bytes, {
    'Content-Type': result.type,
    'Cache-Control': 'public, max-age=86400',
    'X-Grit-Tile-Source': result.source,
    ...(result.source === 'upstream' ? { 'X-Grit-Tile-Cache': result.stored ? 'stored' : 'unwritable' } : {}),
  }, method);
}

/* ---------------------------------------------------------------------------------------------
 * /api/convert — the Convert wizard's Output Settings
 *
 * The five controls map onto the suite's own request (`01_解包/app/view/convert/convert.js`):
 *
 *   Sample Rate (Hz)  → `decimationFilter = 1 / rate` seconds        (:1922)
 *   Unknown Data      → `unconvertedBytes` SEPARATEFILE|INTERLEAVE   (:1923, cli.js:161-164)
 *   Destination       → `outputPath` (a folder, created if missing)  (:1924-1934)
 *   Prefix/Suffix     → `outputFileName = {valid, name, type}`        (:1937-1941)
 *   Time Interval     → `timeInterval = {startTime, endTime}`          (:1889-1893)
 *
 * The page posts the wire spellings `decimate` (seconds), `unknown`, `destination`, `prefix` /
 * `suffix` and `start` / `finish`; the time points are ISO instants because the browser has no GPS
 * week to send, and `utcDateToGps` is the documented inverse of what `/api/playback/info` prints.
 * ------------------------------------------------------------------------------------------- */

function optionalNumber(raw: unknown, label: string): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : Number(String(raw));
  if (!Number.isFinite(value)) throw new HttpError(400, `${label} 必须是数字`);
  return value;
}

/**
 * Sample Rate is the GUI's unit; the pipeline's `decimate` is a period in seconds. The page sends
 * the period (`1 / Hz`), and this only refuses what cannot be a period.
 */
function decimationField(raw: unknown): number | undefined {
  const value = optionalNumber(raw, 'decimate');
  if (value === undefined) return undefined;
  if (value <= 0) throw new HttpError(400, 'decimate 必须是大于 0 的秒数（= 1 / Sample Rate）');
  if (value > 604_800) throw new HttpError(400, 'decimate 不能超过一个 GPS 周（604800 秒）');
  return value;
}

/** `--unknown-bytes=[file|interleave|ignore]`, and the GUI's `SEPARATE` / `INTERLEAVE` spellings. */
function unknownModeField(raw: unknown): UnknownBytesMode | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const text = String(raw).trim().toUpperCase();
  if (text === 'SEPARATE' || text === 'SEPARATEFILE' || text === 'FILE') return 'file';
  if (text === 'INTERLEAVE') return 'interleave';
  if (text === 'IGNORE' || text === 'SKIP') return 'ignore';
  throw new HttpError(400, 'unknown 必须是 SEPARATE / INTERLEAVE / ignore');
}

/**
 * Prefix/Suffix: the suite rejects `/ : * ? " < > | \` in the box and caps it at 18 characters
 * (`convert.html`'s `maxlength="18"`, `convert.js:1862-1873`); the same rule runs here because the
 * value ends up in a file name.
 */
const AFFIX_FORBIDDEN = /[\\/:*?"<>|]/;
const AFFIX_MAX = 18;

function affixField(body: Record<string, unknown>): ConvertOutputAffix | undefined {
  const prefix = typeof body.prefix === 'string' ? body.prefix : '';
  const suffix = typeof body.suffix === 'string' ? body.suffix : '';
  if (prefix !== '' && suffix !== '') throw new HttpError(400, 'prefix 与 suffix 只能给一个');
  const name = prefix || suffix;
  if (!name) return undefined;
  if (name.length > AFFIX_MAX) throw new HttpError(400, `Prefix/Suffix 最多 ${AFFIX_MAX} 个字符`);
  if (AFFIX_FORBIDDEN.test(name)) throw new HttpError(400, 'Prefix/Suffix 不能包含 \\ / : * ? " < > |');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) throw new HttpError(400, 'Prefix/Suffix 含控制字符');
  return { valid: true, name, type: suffix ? 'SUFFIX' : 'PREFIX' };
}

/**
 * Time Interval: `{week, seconds}` directly (what `--start-time` takes), or an ISO instant, which
 * is converted the way `/api/playback/info` converts the other direction.
 */
function timePointField(raw: unknown, label: string): ConvertTimePoint | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'object') {
    const point = raw as { week?: unknown; seconds?: unknown };
    const week = Number(point.week);
    const seconds = Number(point.seconds);
    if (!Number.isFinite(week) || !Number.isFinite(seconds) || week < 0 || seconds < 0 || seconds >= 604_800) {
      throw new HttpError(400, `${label} 必须是 {week, seconds}`);
    }
    return { week, seconds };
  }
  // A number would be read as "milliseconds since the epoch" by `new Date` — 1970, not the capture.
  if (typeof raw !== 'string') throw new HttpError(400, `${label} 必须是 ISO 时间或 {week, seconds}`);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new HttpError(400, `${label} 不是合法时间`);
  const gps = utcDateToGps(date);
  return { week: gps.week, seconds: gps.milliseconds / 1000 };
}

/**
 * Destination: an absolute folder, created when it does not exist (the suite does the same with
 * `mkdirp`, `convert.js:1929-1933`). `..` is refused rather than normalised away so the request
 * cannot name a folder it did not spell out, and every written path is re-checked for containment.
 */
function destinationField(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new HttpError(400, 'destination 必须是字符串');
  const text = raw.trim();
  if (!text) return null;
  if (text.includes('\0')) throw new HttpError(400, 'destination 含非法字符');
  if (!isAbsolute(text)) throw new HttpError(400, 'destination 必须是绝对路径');
  if (text.split(/[\\/]+/).some((part) => part === '..')) throw new HttpError(400, 'destination 不允许包含 ..');
  const absolute = resolve(text);
  if (existsSync(absolute)) {
    if (!statSync(absolute).isDirectory()) throw new HttpError(400, 'destination 已存在但不是目录');
    return absolute;
  }
  try {
    mkdirSync(absolute, { recursive: true });
  } catch (error) {
    throw new HttpError(400, `destination 无法创建：${error instanceof Error ? error.message : String(error)}`);
  }
  return absolute;
}

/** The suite's `Converted_On_YYYYMMDD_THHMM`, in UTC so the page's label is the folder that exists. */
function convertedStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `Converted_On_${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`
    + `_T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;
}

/**
 * Write the run into `destination` with the suite's layout
 * (`SelectedFolder/Source/TimeStamp/Format/FileName`, manual 4.3.2.5), the same tree the CLI writes
 * under `--out`. Every file of the run goes there — RINEX's nav files and `<base>.UNKNOWN` included.
 */
function writeConvertFiles(artifact: ConvertArtifact, destination: string, at: Date): void {
  const directory = join(destination, artifact.base, convertedStamp(at), artifact.formatDirectory);
  const guard = destination.endsWith(sep) ? destination : `${destination}${sep}`;
  if (!`${directory}${sep}`.startsWith(guard)) throw new HttpError(400, 'destination 越界');
  mkdirSync(directory, { recursive: true });
  for (const file of artifact.files) {
    const target = join(directory, file.fileName);
    if (!target.startsWith(guard)) throw new HttpError(400, 'destination 越界');
    writeFileSync(target, file.data);
  }
  artifact.directory = directory;
  artifact.path = join(directory, artifact.fileName);
}

async function handleConvert(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'POST') throw new HttpError(405, '/api/convert 只接受 POST');
  const body = await readJsonBody(req);
  const rawFormat = typeof body.format === 'string' ? body.format.toUpperCase() : 'ASCII';
  if (!isConvertFormat(rawFormat)) {
    throw new HttpError(400, `format 必须是 ${CONVERT_FORMATS.join(' / ')}`);
  }
  const format = rawFormat as ConvertFormat;

  let at = new Date();
  if (body.at !== undefined) {
    const parsed = new Date(String(body.at));
    if (Number.isNaN(parsed.getTime())) throw new HttpError(400, 'at 不是合法时间');
    at = parsed;
  }

  // The Output Settings, parsed before the capture is read so a bad field costs nothing.
  const decimate = decimationField(body.decimate);
  const unknownBytes = unknownModeField(body.unknown);
  const affix = affixField(body);
  const startTime = timePointField(body.start, 'start');
  const finishTime = timePointField(body.finish, 'finish');
  if (startTime && finishTime) {
    const from = startTime.week * 604_800_000 + startTime.seconds * 1000;
    const to = finishTime.week * 604_800_000 + finishTime.seconds * 1000;
    if (to < from) throw new HttpError(400, 'finish 早于 start');
  }
  const destination = destinationField(body.destination);

  const capture = resolveCapture(body.capture);
  const started = process.hrtime.bigint();
  const data = loadCapture(capture);
  // The raw bytes again: unknown bytes are in no frame, so the pipeline can only count them from
  // the capture itself (`--unknown-bytes=file`, `interleave`, and the summary's UNKNOWN row).
  const source = new Uint8Array(readFileSync(capture.absolutePath));
  const artifact = convertCapture(data, tables(), format, at, {
    ...(decimate !== undefined ? { decimate } : {}),
    ...(unknownBytes ? { unknownBytes } : {}),
    ...(startTime ? { startTime } : {}),
    ...(finishTime ? { finishTime } : {}),
    ...(affix ? { affix } : {}),
    source,
  });
  // Destination has a value: the files really land there, in the suite's layout.
  if (destination) writeConvertFiles(artifact, destination, at);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const token = randomBytes(9).toString('hex');
  rememberArtifact({
    token,
    fileName: artifact.fileName,
    contentType: artifact.contentType,
    bytes: artifact.bytes,
    format,
    createdAt: Date.now(),
  });

  sendJson(res, 200, {
    ok: true,
    capture: data.relPath,
    format,
    label: artifact.label,
    formatDirectory: artifact.formatDirectory,
    fileName: artifact.fileName,
    extension: artifact.extension,
    bytes: artifact.bytes.byteLength,
    lineTotal: artifact.lineTotal,
    shownLines: artifact.shownLines,
    truncated: artifact.truncated,
    binary: artifact.binary,
    // Exactly one of text/preview carries the body: the full text when it fits in 200 lines,
    // otherwise only the clipped preview — no point shipping 489 KB twice.
    text: artifact.binary || artifact.truncated ? null : artifact.text,
    preview: artifact.binary || artifact.truncated ? artifact.preview : null,
    downloadUrl: `/api/download?token=${token}`,
    elapsedMs: Math.round(elapsedMs * 10) / 10,
    at: at.toISOString(),
    // What the run produced, where it went, and what the Output Settings did.
    base: artifact.base,
    files: artifact.files.map((file) => ({ fileName: file.fileName, bytes: file.bytes })),
    directory: artifact.directory,
    path: artifact.path,
    unknownBytes: artifact.unknownBytes,
    unknownFileName: artifact.unknownFileName,
    unConvertedBytes: artifact.unConvertedBytes,
    decimate: decimate ?? null,
    unknown: unknownBytes ?? 'ignore',
    prefix: affix && affix.type === 'PREFIX' ? affix.name : null,
    suffix: affix && affix.type === 'SUFFIX' ? affix.name : null,
    start: startTime ?? null,
    finish: finishTime ?? null,
    records: { total: data.totalRecords, accepted: data.accepted, dropped: data.dropped, textRecords: data.textRecords },
  }, method);
}

function handleDownload(url: URL, res: ServerResponse, method: string): void {
  const token = url.searchParams.get('token') ?? '';
  const artifact = artifacts.get(token);
  if (!artifact) throw new HttpError(404, '下载链接已失效，请重新转换');
  const ascii = artifact.fileName.replace(/[^\x20-\x7e]/g, '_');
  res.writeHead(200, {
    'Content-Type': artifact.contentType,
    'Content-Length': artifact.bytes.byteLength,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (method === 'HEAD') res.end();
  else res.end(artifact.bytes);
}

function handleLogs(url: URL, res: ServerResponse, method: string): void {
  const capture = resolveCapture(url.searchParams.get('capture'));
  const started = process.hrtime.bigint();
  const data = loadCapture(capture);
  const summary = summarizeLogs(data, tables());
  sendJson(res, 200, {
    ok: true,
    ...summary,
    elapsedMs: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10,
    // One capture-level span the Playback placeholder can quote later.
    spanUtc: summary.span?.utc ?? null,
    spanGps: summary.span ? { week: summary.span.week, milliseconds: summary.span.milliseconds } : null,
  }, method);
}

function handleRecords(url: URL, res: ServerResponse, method: string): void {
  const capture = resolveCapture(url.searchParams.get('capture'));
  const offset = integer(url.searchParams.get('offset'), 0, 0, 10_000_000, 'offset');
  const limit = integer(url.searchParams.get('limit'), 1, 1, 25, 'limit');
  const data = loadCapture(capture);
  // `name=` reads the capture's **text** records (`#ITDETECTSTATUSA` and friends), which have no
  // message id at all; `msgId=` stays the binary path.
  const name = url.searchParams.get('name');
  if (name) {
    const result = readTextRecords(data, tables(), name, offset, limit);
    sendJson(res, 200, { ok: true, ...result }, method);
    return;
  }
  const messageId = integer(url.searchParams.get('msgId'), -1, 0, 0xffffffff, 'msgId');
  if (messageId < 0) throw new HttpError(400, '缺少 msgId 或 name');
  const result = readRecords(data, tables(), messageId, offset, limit);
  sendJson(res, 200, { ok: true, ...result }, method);
}

function handlePlaybackInfo(url: URL, res: ServerResponse, method: string): void {
  const capture = resolveCapture(url.searchParams.get('capture'));
  sendJson(res, 200, { ok: true, ...playbackInfo(capture) }, method);
}

async function handlePlaybackFrames(req: IncomingMessage, res: ServerResponse, method: string, url: URL): Promise<void> {
  let captureName: unknown = url.searchParams.get('capture');
  let from: number | undefined;
  let to: number | undefined;
  if (method === 'POST') {
    const body = await readJsonBody(req);
    captureName = body.capture ?? captureName;
    from = seconds(body.from, 'from');
    to = seconds(body.to, 'to');
  } else {
    from = seconds(url.searchParams.get('from'), 'from');
    to = seconds(url.searchParams.get('to'), 'to');
  }
  if (from !== undefined && to !== undefined && from > to) throw new HttpError(400, 'from 必须不大于 to');

  const capture = resolveCapture(captureName);
  sendJson(res, 200, { ok: true, ...playbackFrames(capture, from, to) }, method);
}

function handlePlaybackFrame(url: URL, res: ServerResponse, method: string): void {
  const capture = resolveCapture(url.searchParams.get('capture'));
  const index = integer(url.searchParams.get('index'), -1, 0, 10_000_000, 'index');
  if (index < 0) throw new HttpError(400, '缺少 index');
  sendJson(res, 200, { ok: true, ...playbackFrame(capture, index) }, method);
}

async function handlePlaybackExport(req: IncomingMessage, res: ServerResponse, method: string, url: URL): Promise<void> {
  let captureName: unknown = url.searchParams.get('capture');
  let from: number | undefined;
  let to: number | undefined;
  if (method === 'POST') {
    const body = await readJsonBody(req);
    captureName = body.capture ?? captureName;
    from = seconds(body.from, 'from');
    to = seconds(body.to, 'to');
  } else {
    from = seconds(url.searchParams.get('from'), 'from');
    to = seconds(url.searchParams.get('to'), 'to');
  }
  if (from === undefined || to === undefined) throw new HttpError(400, '需要 from 与 to（秒）');

  const capture = resolveCapture(captureName);
  const exported = playbackExport(capture, from, to);
  const stem = capture.name.replace(/\.[^.]+$/, '');
  const ascii = `${stem}_${exported.from.toFixed(3)}-${exported.to.toFixed(3)}.sbf`;
  sendBytes(res, 200, exported.bytes, {
    'Content-Disposition': `attachment; filename="${ascii}"`,
    'X-Playback-Frames': String(exported.frameCount),
    'X-Playback-From': String(exported.from),
    'X-Playback-To': String(exported.to),
  }, method);
}

function handlePlaybackEvents(url: URL, res: ServerResponse, method: string): void {
  const capture = resolveCapture(url.searchParams.get('capture'));
  sendJson(res, 200, { ok: true, ...playbackEvents(capture) }, method);
}

/* ---------------- Graph projects (one export directory per project) ----------------
 *
 * Graph's landing page ("Recent Projects") lists the projects it has processed; this build's
 * projects are the export directories under `samples/graph/export/`, discovered by
 * `packages/graph/src/export-projects.ts` (no project name is hardcoded).
 *
 *   GET /api/graph/projects                 every project + CSV count + GPS time range + path
 *   GET /api/graph/files[?project=<key>]    the CSVs of one project (no param: the shipped `csv/`)
 *   GET /api/graph/data?file=…[&project=…]  one CSV of one project
 *   GET /api/graph/pdf[?project=…][&file=…] same, as a PDF
 *
 * `project` accepts the export directory name (`csv`, `b1`) **or** the CSV's `#Project Name:`
 * (`clean`, `b1`). Without it the routes keep their historical single-project behaviour, which is
 * the shipped `export/csv/` directory — every pre-existing test keeps its contract.
 */

/** `<repo>/逆向/00_来源/samples/graph/export` */
const GRAPH_EXPORT_DIR = resolve(SAMPLES_DIR, 'graph', 'export');

function relativeToRepo(path: string): string {
  return relative(REPO_DIR, path).split('\\').join('/');
}

/** `GraphCsvError` already carries the HTTP status; anything else keeps the 500 path. */
function rethrowGraphError(error: unknown): never {
  if (error instanceof GraphCsvError) throw new HttpError(error.status, error.message);
  throw error;
}

/** `?project=clean|b1|csv` → that project; a null param means "the default one". */
function graphProjectOrThrow(raw: string | null): ExportProject {
  const { project, available } = resolveExportProject(GRAPH_EXPORT_DIR, raw);
  if (!project) {
    const wanted = raw === null ? '默认工程' : raw.trim();
    throw new HttpError(404, `没有工程 ${wanted}（现有：${available.join('、') || '无'}）`);
  }
  return project;
}

function graphProjectJson(project: ExportProject): Record<string, unknown> {
  return {
    key: project.key,
    name: project.name,
    directory: relativeToRepo(project.directory),
    csvDirectory: relativeToRepo(project.csvDirectory),
    csvCount: project.csvCount,
  };
}

/**
 * Fixed workflows over HTTP — the "hybrid" surface.
 *
 * The catalog and the job views are the executor's own JSON, passed through unchanged; this layer
 * only validates ids and maps exit codes (0 done / 1 failed job / 2 bad input / 3 waiting). `run`
 * waits because a high-risk job stops at its gate immediately; `gate` / `resume` may continue into
 * a long flash or reboot, so they return 202 and the caller polls `/api/workflows/job`.
 */
async function handleWorkflowRun(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'POST') throw new HttpError(405, '/api/workflows/run 只接受 POST');
  const body = await readJsonBody(req);
  const id = assertWorkflowId(body.id);
  const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params)
    ? (body.params as Record<string, unknown>)
    : {};
  const result = await workflowBridge.run(id, params);
  sendJson(res, result.code === 3 ? 202 : 200, {
    ok: result.code !== 1,
    exit_code: result.code,
    ...(result.data ?? {}),
  }, method);
}

async function handleWorkflowGate(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'POST') throw new HttpError(405, '/api/workflows/job/gate 只接受 POST');
  const body = await readJsonBody(req);
  const id = assertJobId(body.id);
  const decision = String(body.decision ?? '');
  const by = String(body.by ?? 'operator');
  const note = String(body.note ?? '');
  workflowBridge.gate(id, decision, by, note);
  sendJson(res, 202, { ok: true, detached: true, job_id: id, decision }, method);
}

async function handleWorkflowResume(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'POST') throw new HttpError(405, '/api/workflows/job/resume 只接受 POST');
  const body = await readJsonBody(req);
  const id = assertJobId(body.id);
  const decision = String(body.decision ?? '');
  const by = String(body.by ?? 'operator');
  const note = String(body.note ?? '');
  workflowBridge.resume(id, decision, by, note);
  sendJson(res, 202, { ok: true, detached: true, job_id: id, decision }, method);
}

async function handleWorkflowCancel(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'POST') throw new HttpError(405, '/api/workflows/job/cancel 只接受 POST');
  const body = await readJsonBody(req);
  const id = assertJobId(body.id);
  const view = await workflowBridge.cancel(id, String(body.reason ?? ''), String(body.by ?? 'operator'));
  sendJson(res, 200, { ok: true, ...view }, method);
}

function handleWorkflowArtifact(url: URL, res: ServerResponse, method: string): void {
  const id = assertJobId(url.searchParams.get('id'));
  const name = url.searchParams.get('name') ?? '';
  const bytes = workflowBridge.artifactBytes(id, name);
  const type = name.toLowerCase().endsWith('.pdf') ? 'application/pdf'
    : name.toLowerCase().endsWith('.png') ? 'image/png'
      : name.toLowerCase().endsWith('.json') ? 'application/json; charset=utf-8'
        : 'application/octet-stream';
  sendBytes(res, 200, bytes, {
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
  }, method);
}

function handleGraphProjects(res: ServerResponse, method: string): void {  try {
    const projects = listExportProjects(GRAPH_EXPORT_DIR).map((project) => ({
      ...graphProjectJson(project),
      bytes: project.bytes,
      startTime: project.startTime,
      endTime: project.endTime,
      duration: project.duration,
      dataFileName: project.dataFileName,
      modified: project.modified,
    }));
    const { project: fallback } = resolveExportProject(GRAPH_EXPORT_DIR, null);
    sendJson(res, 200, {
      ok: true,
      root: relativeToRepo(GRAPH_EXPORT_DIR),
      count: projects.length,
      default: fallback?.key ?? '',
      projects,
    }, method);
  } catch (error) {
    rethrowGraphError(error);
  }
}

function handleGraphFiles(url: URL, res: ServerResponse, method: string): void {
  const wanted = url.searchParams.get('project');
  try {
    if (wanted === null) {
      const files = listGraphCsv();
      const fallback = graphProjectOrThrow(null);
      sendJson(res, 200, {
        ok: true,
        project: graphProjectJson(fallback),
        directory: relative(REPO_DIR, GRAPH_CSV_DIR).split('\\').join('/'),
        count: files.length,
        files,
      }, method);
      return;
    }
    const project = graphProjectOrThrow(wanted);
    const files = listProjectCsv(project);
    sendJson(res, 200, {
      ok: true,
      project: graphProjectJson(project),
      directory: relativeToRepo(project.csvDirectory),
      count: files.length,
      files,
    }, method);
  } catch (error) {
    rethrowGraphError(error);
  }
}

function handleGraphData(url: URL, res: ServerResponse, method: string): void {
  const column = url.searchParams.get('column');
  const wanted = url.searchParams.get('project');
  try {
    if (wanted === null) {
      sendJson(res, 200, { ok: true, ...graphData(url.searchParams.get('file'), column) }, method);
      return;
    }
    const project = graphProjectOrThrow(wanted);
    sendJson(res, 200, { ok: true, ...projectGraphData(project, url.searchParams.get('file'), column) }, method);
  } catch (error) {
    rethrowGraphError(error);
  }
}

/**
 * `GET /api/graph/flags?project=<key|name>` and `POST /api/graph/flags` `{project, flags}`.
 *
 * The original Graph keeps its markers in the project's `.gpf` (`FlagsInitialState`), not in
 * browser storage. This route is the server half of `graph.js#createFlagStore`: `gpf:false` means
 * the project has no `.gpf` **and one could not be created**, so the panel stays on `localStorage`;
 * `gpf:true` with `flags:null` means the file exists but has no `FlagsInitialState` yet (an empty
 * store, not a fallback).
 *
 * A write never overwrites an unreadable `.gpf`, and a project that has none gets one created from
 * its own measurements (`writeProjectFlags(..., {create: true})` — see `export-projects.ts`). The
 * created file is re-signed (`resign: true`) because Graph rejects a project whose checksum no
 * longer matches (`INVALID_GPF_FILE`, `index-B86bHcCD.js` @549299).
 */
async function handleGraphFlags(req: IncomingMessage, res: ServerResponse, method: string): Promise<void> {
  if (method !== 'GET' && method !== 'POST') throw new HttpError(405, '/api/graph/flags 只接受 GET / POST');
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (method === 'GET') {
      // An empty/missing `?project=` is "the panel has no project selected yet", not "give me the
      // default project": reading flags is cheap, but answering with `clean`'s markers while the
      // panel shows another project is exactly the cross-project leak this route must not have.
      const wanted = normaliseFlagProject(url.searchParams.get('project'));
      if (wanted === null) {
        sendJson(res, 200, { ok: true, gpf: false }, method);
        return;
      }
      const read = readProjectFlags(graphProjectOrThrow(wanted));
      if (!read) {
        sendJson(res, 200, { ok: true, gpf: false }, method);
        return;
      }
      sendJson(res, 200, { ok: true, gpf: true, flags: read.flags, ...(read.error ? { error: read.error } : {}) }, method);
      return;
    }

    const body = await readJsonBody(req);
    // The panel cannot put a query string on a POST (`api.post(path, body)` in `web/index.html`), so
    // the project named in the body is what the write is for — reading only `?project=` would silently
    // write every project's markers into the **default** project's `.gpf`. `?project=` still wins.
    const wanted = normaliseFlagProject(
      url.searchParams.get('project') ?? (typeof body.project === 'string' ? body.project : null),
    );
    if (wanted === null) throw new HttpError(400, 'project 不能为空');
    const project = graphProjectOrThrow(wanted);
    const write = writeProjectFlags(project, body.flags as never, { create: true, resign: true });
    sendJson(res, 200, {
      ok: write.ok,
      // `no-gpf` / `no-data`: there is no project file and none was created — the panel must keep its
      // own `localStorage` store. Everything else means "a `.gpf` owns this project's flags".
      gpf: write.reason !== 'no-gpf' && write.reason !== 'no-data',
      ...(write.created ? { created: true } : {}),
      ...(write.path ? { path: write.path } : {}),
      ...(write.reason ? { reason: write.reason } : {}),
      ...(write.error ? { error: write.error } : {}),
    }, method);
  } catch (error) {
    rethrowGraphError(error);
  }
}

/** `?project=` / `body.project` → the name to resolve, or `null` when the caller named none. */
function normaliseFlagProject(raw: string | null | undefined): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value ? value : null;
}

/**
 * `GET /api/graph/pdf[?project=<key|name>][?file=<one csv>]` — what Graph's *Export → PDF* downloads.
 *
 * Built server-side from the CSVs that project already exported, so the bytes are a real PDF 1.4
 * rather than a print dialog: see `pdf.ts`.
 *
 *   (nothing)   the default project, every one of its CSVs in the catalogue's tab order
 *   ?project=   that project's CSVs — 404 (naming the projects that do exist) when no such
 *               directory/name exists, so a typo cannot silently download somebody else's report
 *   ?file=      one chart, exactly as the panel's single-graph export wants it
 *
 * `file` wins over `project` because it is the narrower request. Page order comes from
 * `graphPdfOrder`, so page 2 is `Position Type` (the original's first PVT chart) rather than the
 * alphabetically-first `2D Trajectory`.
 */
function handleGraphPdf(url: URL, res: ServerResponse, method: string): void {
  const only = url.searchParams.get('file');
  try {
    const project = graphProjectOrThrow(url.searchParams.get('project'));
    const known = listProjectCsv(project);
    if (known.length === 0) throw new HttpError(404, '没有可导出的 CSV');

    const names = only ? [only] : known.map((entry) => entry.name);
    const sources = graphPdfOrder(names).map((name) => ({ name, text: projectCsvText(project, name) }));
    const report = graphPdfReport(sources);
    sendBytes(res, 200, report.bytes, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${report.fileName}"`,
      'X-PDF-Pages': String(report.pages),
      'X-PDF-Charts': String(report.charts),
      'X-PDF-Bytes': String(report.bytes.byteLength),
      'X-PDF-Project': report.project,
    }, method);
  } catch (error) {
    rethrowGraphError(error);
  }
}

/* ---------------- Luciad 引擎模块（唯一的动态静态资源） ---------------------
 *
 * `GET /geo/luciad-engine.js` → 原版 Graph 渲染包 `逆向/01_解包/Graph/out/renderer/assets/
 * index-B86bHcCD.js`，砍掉最后那句 `ReactDOM.createRoot(...)`（那就是原版 Graph 的 React 应用
 * 挂载），再接上仓库里的 `web/geo/luciad-exports.js`。产物是一个**只暴露 LuciadRIA 类**的 ESM
 * 模块：类名在打包时保留了（`RIAMap` / `FeatureLayer` / `createPolyline` …），所以不需要跑原版
 * 应用也能拿到引擎。Luciad 本体不进仓库，始终从 01_解包 现读；读不到就 404，面板据此退回自绘地图。
 *
 * 只此一条动态路由；`/geo/*` 其余文件（stage 的 html/js）走下面已有的静态分支。
 */

const GRAPH_BUNDLE = resolve(
  REPO_DIR, '逆向', '01_解包', 'Graph', 'out', 'renderer', 'assets', 'index-B86bHcCD.js',
);
const GRAPH_BUNDLE_TAIL = 'ReactDOM.createRoot(';

let luciadEngine: { text: string; source: 'unpacked' | 'raw' } | null = null;

function buildLuciadEngine(): { text: string; source: 'unpacked' | 'raw' } | null {
  if (luciadEngine) return luciadEngine;
  let bundle: string;
  try {
    bundle = readFileSync(GRAPH_BUNDLE, 'utf8');
  } catch {
    return null;
  }
  const exportsTail = readFileSync(join(WEB_DIR, 'geo', 'luciad-exports.js'), 'utf8');
  const cut = bundle.lastIndexOf(GRAPH_BUNDLE_TAIL);
  // Without the mount call the bundle would boot the Graph app inside our iframe; with the marker
  // missing we serve it whole and say so, so the stage can fail loudly instead of half-working.
  const head = cut > 0 ? bundle.slice(0, cut) : bundle;
  luciadEngine = { text: `${head}\n${exportsTail}`, source: cut > 0 ? 'unpacked' : 'raw' };
  return luciadEngine;
}

function handleLuciadEngine(res: ServerResponse, method: string): void {
  const engine = buildLuciadEngine();
  if (!engine) throw new HttpError(404, `读不到原版 Graph 引擎包：${GRAPH_BUNDLE}`);
  const body = Buffer.from(engine.text, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/javascript; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Luciad-Source': engine.source,
    'X-Luciad-Bytes': String(body.byteLength),
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
}

/* ---------------- 原版外观资源（只读） --------------------------------
 *
 * 外壳要的图标、渐变条与字体都留在解包出来的原版前端里，不复制进仓库：
 *   /assets/<images|fonts|css>/<file>  →  FIELD_STATION_VIEW_ASSETS
 * 默认 `<仓库根>/逆向/01_解包/app/view`。只开放 images/ fonts/ css/ 三个子目录，
 * 路径穿越（..、反斜杠、盘符、NUL）一律 400。
 */

const ASSETS_DIR = process.env.FIELD_STATION_VIEW_ASSETS
  ? resolve(process.env.FIELD_STATION_VIEW_ASSETS)
  : resolve(REPO_DIR, '逆向', '01_解包', 'app', 'view');

/** 允许从原版目录暴露出去的子目录。 */
const ASSET_GROUPS = new Set(['images', 'fonts', 'css']);

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

let assetsWarned = false;

function warnMissingAssets(): void {
  if (assetsWarned) return;
  assetsWarned = true;
  console.warn(
    `[app] 未找到原版资源目录：${ASSETS_DIR}\n` +
      '[app] 用 FIELD_STATION_VIEW_ASSETS 指向 逆向/01_解包/app/view，图标与字体才有内容',
  );
}

/** 拆段 + 逐段解码；任何 `..`、反斜杠、盘符、NUL 都当越界。 */
function safeSegments(rawPath: string): string[] {
  const segments: string[] = [];
  for (const raw of rawPath.split('/')) {
    if (raw === '' || raw === '.') continue;
    let part: string;
    try {
      part = decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, `资源路径无法解码：${raw}`);
    }
    if (part === '..') throw new HttpError(400, '资源路径不允许包含 ..');
    if (part.includes('\\')) throw new HttpError(400, '资源路径不允许反斜杠');
    if (part.includes('\0')) throw new HttpError(400, '资源路径含非法字符');
    if (/^[a-zA-Z]:/.test(part)) throw new HttpError(400, '资源路径不允许盘符');
    segments.push(part);
  }
  if (!segments.length) throw new HttpError(400, '缺少资源路径');
  return segments;
}

/** 拼绝对路径，并再核一次确实落在 root 下。 */
function resolveUnder(root: string, segments: string[], label: string): string {
  const target = resolve(root, ...segments);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new HttpError(400, `${label}路径越界`);
  }
  return target;
}

function sendFile(res: ServerResponse, absolutePath: string, method: string, cacheControl: string): void {
  let bytes: Buffer;
  try {
    bytes = readFileSync(absolutePath);
  } catch {
    throw new HttpError(404, `读不到文件：${absolutePath}`);
  }
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[extname(absolutePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': bytes.byteLength,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  });
  if (method === 'HEAD') res.end();
  else res.end(bytes);
}

/** /assets/<group>/<file> → 原版 view 目录（只读） */
function handleAsset(rawPath: string, res: ServerResponse, method: string): void {
  if (!existsSync(ASSETS_DIR)) {
    warnMissingAssets();
    throw new HttpError(404, `未找到原版资源目录：${ASSETS_DIR}`);
  }
  const segments = safeSegments(rawPath);
  const group = segments[0].toLowerCase();
  if (!ASSET_GROUPS.has(group)) {
    throw new HttpError(404, `未开放的原版资源目录：${segments[0]}（只开放 images / fonts / css）`);
  }
  const target = resolveUnder(ASSETS_DIR, segments, '原版资源');
  if (!statSync(target, { throwIfNoEntry: false })?.isFile()) {
    throw new HttpError(404, `没有这个资源：${segments.join('/')}`);
  }
  sendFile(res, target, method, 'public, max-age=3600');
}

/** 外壳自己的静态文件：/shell.css 与 /panels/*.js（页面按需 import） */
function handleWebFile(rawPath: string, res: ServerResponse, method: string): void {
  const segments = safeSegments(rawPath);
  const target = resolveUnder(WEB_DIR, segments, '页面资源');
  if (!statSync(target, { throwIfNoEntry: false })?.isFile()) {
    throw new HttpError(404, `没有这个文件：/${segments.join('/')}`);
  }
  sendFile(res, target, method, 'no-store');
}

function handlePage(res: ServerResponse): void {
  let html: string;
  try {
    html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
  } catch (error) {
    throw new HttpError(500, `页面文件读取失败：${(error as Error).message}`);
  }
  const body = Buffer.from(html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  });
  res.end(body);
}

function loopbackHostAllowed(hostValue: string | undefined, port: number): boolean {
  if (!hostValue) return false;
  const host = hostValue.trim().toLowerCase();
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  return names.some((name) => host === name || host === `${name}:${port}`);
}

function loopbackOriginAllowed(origin: string | undefined, port: number): boolean {
  if (!origin) return true; // 非浏览器（Python/native）没有 Origin
  const value = origin.trim().toLowerCase();
  return value === `http://127.0.0.1:${port}`
    || value === `http://localhost:${port}`
    || value === `http://[::1]:${port}`;
}

/** 只接受本机回环 Host/Origin：防 DNS rebinding 与跨站页面调用本机 API。 */
function loopbackRequest(
  req: { headers: { host?: string; origin?: string } },
  port: number,
): boolean {
  return loopbackHostAllowed(req.headers.host, port)
    && loopbackOriginAllowed(req.headers.origin, port);
}

const server = createServer((req, res) => {
  void (async () => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      sendJson(res, 405, { ok: false, error: '不支持的请求方法' }, method);
      return;
    }
    if (listeningPort > 0 && !loopbackRequest(req, listeningPort)) {
      sendJson(res, 403, { ok: false, error: '只接受本机回环同源请求' }, method);
      return;
    }
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const path = url.pathname;

    try {
      // WHATWG URL 会把 `../` 规范化掉，规范化之后的 pathname 已经看不出原始意图；
      // 所以先看原始串（问号之前）：里面带字面的 `..` 或反斜杠一律 400。
      const rawPathname = (req.url ?? '').split('?')[0];
      if (rawPathname.includes('..') || rawPathname.includes('\\')) {
        throw new HttpError(400, '资源路径越界');
      }
      if (path === '/' || path === '/index.html') {
        handlePage(res);
        return;
      }
      if (path.startsWith('/assets/')) {
        handleAsset(path.slice('/assets/'.length), res, method);
        return;
      }
      if (path === '/geo/luciad-engine.js') {
        handleLuciadEngine(res, method);
        return;
      }
      if (path === '/shell.css' || path === '/icons.css' || path === '/theme.css' || path === '/theme.js'
        || path === '/home.css'
        || path === '/agent.css'
        || path === '/config-dark.css'
        || path.startsWith('/home/')
        || path.startsWith('/agent/')
        || path.startsWith('/panels/') || path.startsWith('/icons/') || path.startsWith('/fonts/')
        || path.startsWith('/geo/')) {
        handleWebFile(path.slice(1), res, method);
        return;
      }
      if (path === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'public, max-age=86400' });
        res.end();
        return;
      }
      if (path === '/api/health') {
        sendJson(res, 200, health(), method);
        return;
      }
      if (path === '/api/captures') {
        const captures = listCaptures();
        sendJson(res, 200, {
          ok: true,
          samples: relative(REPO_DIR, SAMPLES_DIR).split('\\').join('/'),
          // The samples tree's absolute path: the Convert panel's Destination field is a text box
          // (the suite opens a folder picker instead), so it needs something absolute to prefill.
          samplesAbsolute: SAMPLES_DIR,
          captures,
          formats: formatOptions(),
        }, method);
        return;
      }
      if (path === '/api/convert') {
        await handleConvert(req, res, method);
        return;
      }
      if (path === '/api/download') {
        handleDownload(url, res, method);
        return;
      }
      if (path === '/api/logs') {
        handleLogs(url, res, method);
        return;
      }
      if (path === '/api/records') {
        handleRecords(url, res, method);
        return;
      }
      if (path === '/api/ports') {
    /* The Add Device dialog's list: real ports on this machine, with the name Device Manager
     * shows. `refresh=1` skips the short cache so a cable plugged in a second ago appears. */
    const force = url.searchParams.get('refresh') === '1';
    sendJson(res, 200, { ok: true, ...(await listSerialPorts(force)) }, method);
    return;
  }
  if (path === '/api/live/status') {
        sendJson(res, 200, { ok: true, ...liveLink().status() }, method);
        return;
      }
      if (path === '/api/live/logs') {
        const after = integer(url.searchParams.get('after'), 0, 0, 10_000_000, 'after');
        /* `limit` keeps the newest N entries of the page (0 = all). The Terminal's backfill asks
         * for a slice because 400 RANGE records carry ~1.3 MB of ASCII plus their decoded rows. */
        const limit = integer(url.searchParams.get('limit'), 0, 0, 10_000, 'limit');
        const page = liveLink().logs(after);
        if (limit > 0 && page.entries.length > limit) page.entries = page.entries.slice(-limit);
        // RXSTATUSEVENT (#94) is a text event; the Events page is fed the same records the
        // Terminal sees, so the two can never disagree about what the receiver said.
        feedEventsFromEntries(page.entries);
        // The configuration pages read the receiver's own configuration logs (INTERFACEMODE,
        // LOGLIST, SERIALCONFIG, …); they are fed from the same entry stream.
        feedConfigFromEntries(page.entries);
        sendJson(res, 200, { ok: true, ...page }, method);
        return;
      }
      if (path === '/api/live/connect') {
        await handleLiveConnect(req, res, method);
        return;
      }
      if (path === '/api/live/disconnect') {
        if (method !== 'POST') throw new HttpError(405, '/api/live/disconnect 只接受 POST');
        const status = await liveLink().disconnect();
        sendJson(res, 200, { ok: true, ...status }, method);
        return;
      }
      if (path === '/api/live/command') {
        await handleLiveCommand(req, res, method);
        return;
      }
      if (path === '/api/config/pages') {
        sendJson(res, 200, { ok: true, pages: configPageList() }, method);
        return;
      }
      if (path === '/api/config/events/summary') {
        sendJson(res, 200, eventsSummary(), method);
        return;
      }
      if (path === '/api/config/device/status') {
        const live = liveLink();
        sendJson(res, 200, deviceStatus(live.status().connected, live.logs(0).entries), method);
        return;
      }
      if (path === '/api/config/device/export' && method === 'GET') {
        // A `.cfg` built from the receiver records this link is holding is a plain download;
        // without any the response says exactly which records are missing.
        const file = deviceExportFile(liveLink().logs(0).entries);
        if (!file.ok) {
          sendJson(res, 409, { ok: false, reason: file.reason, records: file.records }, method);
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="${file.fileName}"`,
          'Cache-Control': 'no-store',
        });
        res.end(file.text);
        return;
      }
      if (path === '/api/config/device/import/preview') {
        if (method !== 'POST') throw new HttpError(405, '/api/config/device/import/preview 只接受 POST');
        const body = await readJsonBody(req);
        const text = typeof body.text === 'string' ? body.text : '';
        const versions =
          body.versions && typeof body.versions === 'object'
            ? (body.versions as { hardwareVersion: string; model: string; softwareVersion: string })
            : undefined;
        sendJson(res, 200, deviceImportPreview(text, versions), method);
        return;
      }
      if (path === '/api/config/device/import') {
        if (method !== 'POST') throw new HttpError(405, '/api/config/device/import 只接受 POST');
        const body = await readJsonBody(req);
        const text = typeof body.text === 'string' ? body.text : '';
        const link = liveLink();
        // One line at a time, each waiting for the receiver's own <OK/<ERR…, then LOG RXCONFIG as
        // the read-back. The channel is the live link itself: it is the only thing holding the
        // socket. Nothing is claimed as applied unless the receiver said so *and* the read-back
        // agrees.
        const result = await deviceImportApply(text, link.status().connected, undefined, link);
        // 409 is kept for "nothing could even be attempted" (no session, no command channel, no
        // loadable line). Once the write starts, the receiver's own answer *is* the result of a
        // well-formed request, so it comes back 200 with `ok:false` — the page prints the reason
        // and the browser's console stays free of a spurious "409" entry.
        const blocked = !result.ok && result.steps.length === 0;
        sendJson(res, blocked ? 409 : 200, result, method);
        return;
      }
      if (path.startsWith('/config/')) {
        const name = path.slice('/config/'.length);
        if (!isConfigPage(name)) throw new HttpError(404, `未知配置页：${name}`);
        // Events replays whatever RXSTATUSEVENT records the link still holds before serialising,
        // so the page shows the session's real events rather than only the ones arriving next.
        if (name === 'events') primeEventsPage(liveLink().logs(0).entries);
        // A capture's events can only come from the capture: `ITDETECTSTATUS` arrives as text on this
        // receiver and the live link never sees it. `Events` is opened with `?capture=…` by the shell.
        const eventsCapture = url.searchParams.get('capture');
        if (name === 'events' && eventsCapture) {
          try {
            const data = loadCapture(resolveCapture(eventsCapture));
            const text = readTextRecords(data, tables(), 'ITDETECTSTATUS', 0, 25);
            for (const record of text.records) {
              const fields: Record<string, unknown> = {};
              for (const field of record.fields) fields[field.path] = field.text ?? field.value;
              feedEventsItk(fields);
            }
          } catch {
            // A capture that is not there just leaves the honest empty page; nothing is invented.
          }
        }
        // A configuration page can only show what the receiver told it. Ask for that page's own log
        // set (`LOG <NAME>B ONCE`, the shipped request table), feed the answers, re-render, then
        // serialise: the headless host has no polling timer, so the data has to be in before the
        // document is built. Offline the lines are simply not sent and the page says so.
        await primeConfigurationPage(name);
        sendText(
          res,
          200,
          configPageDocument(name, { connected: liveLink().status().connected }),
          'text/html; charset=utf-8',
        );
        return;
      }
      if (path.startsWith('/view/')) {
        const relative = decodeURIComponent(path.slice('/view/'.length));
        const asset = readConfigAsset(relative);
        if (!asset) throw new HttpError(404, `无此文件：/view/${relative}`);
        const type = configStylesheet(relative)?.type ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
        res.end(asset);
        return;
      }
      if (path.startsWith('/images/') || path.startsWith('/media/')) {
        // The shipped fragments reference these absolutely (`<img src="/images/…">`), so serve
        // them from the unpacked view tree as well.
        const relative = decodeURIComponent(path.slice(1));
        const asset = readConfigAsset(relative);
        if (!asset) throw new HttpError(404, `无此文件：${path}`);
        const type = configStylesheet(relative)?.type ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
        res.end(asset);
        return;
      }
      if (path.startsWith('/api/config/') && path.endsWith('/event')) {
        if (method !== 'POST') throw new HttpError(405, '/api/config/:page/event 只接受 POST');
        const name = path.slice('/api/config/'.length, -'/event'.length);
        if (!isConfigPage(name)) throw new HttpError(404, `未知配置页：${name}`);
        const body = await readJsonBody(req);
        const selector = typeof body.selector === 'string' ? body.selector : '';
        if (!selector) throw new HttpError(400, 'selector 不能为空');
        // Anything the controller framed goes out over the live session, exactly as a menu click
        // would; without a session the commands are dropped and the page says so.
        const status = liveLink().status();
        const result = applyConfigEvent(
          name,
          selector,
          {
            value: body.value,
            checked: typeof body.checked === 'boolean' ? body.checked : undefined,
            click: body.click === true ? true : undefined,
          },
          {
            connected: status.connected,
            // The note and the `sent` count come from the same answer, so the page cannot show
            // "applied" next to a dropped command.
            sent: status.connected ? undefined : 0,
          },
        );
        for (const command of result.commands) {
          if (!status.connected) break;
          if (command.kind === 'raw' && command.text) liveLink().send(command.text);
          else if (command.kind === 'ascii' && command.text) liveLink().send(command.text);
          else if (command.kind === 'binary' && command.bytes) liveLink().sendBinary(command.bytes);
        }
        sendJson(res, 200, {
          ok: true,
          shell: result.shell,
          applied: result.applied,
          commands: result.commands.length,
          sent: status.connected ? result.commands.length : 0,
          note: result.note,
        }, method);
        return;
      }
      if (path === '/api/playback/info') {
        handlePlaybackInfo(url, res, method);
        return;
      }
      if (path === '/api/playback/frames') {
        await handlePlaybackFrames(req, res, method, url);
        return;
      }
      if (path === '/api/playback/frame') {
        handlePlaybackFrame(url, res, method);
        return;
      }
      if (path === '/api/playback/export') {
        await handlePlaybackExport(req, res, method, url);
        return;
      }
      if (path === '/api/playback/events') {
        handlePlaybackEvents(url, res, method);
        return;
      }
      if (path === '/api/workflows') {
        sendJson(res, 200, { ok: true, ...(await workflowBridge.catalog()) }, method);
        return;
      }
      if (path === '/api/workflows/describe') {
        const id = assertWorkflowId(url.searchParams.get('id'));
        sendJson(res, 200, { ok: true, ...(await workflowBridge.describe(id)) }, method);
        return;
      }
      if (path === '/api/workflows/run') {
        await handleWorkflowRun(req, res, method);
        return;
      }
      if (path === '/api/workflows/job') {
        const id = assertJobId(url.searchParams.get('id'));
        sendJson(res, 200, { ok: true, ...(await workflowBridge.status(id)) }, method);
        return;
      }
      if (path === '/api/workflows/job/gate') {
        await handleWorkflowGate(req, res, method);
        return;
      }
      if (path === '/api/workflows/job/resume') {
        await handleWorkflowResume(req, res, method);
        return;
      }
      if (path === '/api/workflows/job/cancel') {
        await handleWorkflowCancel(req, res, method);
        return;
      }
      if (path === '/api/workflows/job/artifacts') {
        const id = assertJobId(url.searchParams.get('id'));
        sendJson(res, 200, { ok: true, artifacts: await workflowBridge.artifacts(id) }, method);
        return;
      }
      if (path === '/api/workflows/artifact') {
        handleWorkflowArtifact(url, res, method);
        return;
      }
      if (path === '/api/graph/projects') {
        handleGraphProjects(res, method);
        return;
      }
      if (path === '/api/graph/files') {
        handleGraphFiles(url, res, method);
        return;
      }
      if (path === '/api/graph/data') {
        handleGraphData(url, res, method);
        return;
      }
      if (path === '/api/graph/flags') {
        await handleGraphFlags(req, res, method);
        return;
      }
      if (path === '/api/graph/pdf') {
        handleGraphPdf(url, res, method);
        return;
      }
      if (path === '/api/grit/tiles/config') {
        sendJson(res, 200, gritTileConfig(), method);
        return;
      }
      if (path.startsWith('/api/grit/tiles/')) {
        await handleGritTiles(url, res, method);
        return;
      }
      // The agent surface is mounted here, ahead of the generic `/api/` fallback: a wrong
      // `/api/agent/...` path must be its own 404, not "unknown endpoint" from the shell.
      if (path === '/api/agent' || path.startsWith('/api/agent/')) {
        await handleAgentRoute({ bridge: agentBridge, req, res, url, method });
        return;
      }
      if (path.startsWith('/api/')) {
        throw new HttpError(404, `未知接口：${path}`);
      }
      sendText(res, 404, `404 ${path}`);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { ok: false, error: error.message }, method);
      } else {
        const message = (error as Error)?.message ?? String(error);
        console.error(`[app] ${method} ${path} 失败：`, error);
        sendJson(res, 500, { ok: false, error: `服务端错误：${message}` }, method);
      }
    }
  })();
});

const port = parsePort(process.argv.slice(2));
/** Chromium/WebView2 refuses to navigate to these ports (`ERR_UNSAFE_PORT`). */
const CHROME_BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720,
  1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6697, 10080,
]);

const onReady = (): void => {
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  if (CHROME_BLOCKED_PORTS.has(actual)) {
    // WebView2/Chromium 会直接报 ERR_UNSAFE_PORT；换一个临时端口重来。
    console.log(`[app] 端口 ${actual} 被 Chromium 禁用，换一个`);
    server.close(() => server.listen(0, HOST, onReady));
    return;
  }
  listeningPort = actual;
  const line = `nas-reimpl app listening on http://${HOST}:${actual}`;
  console.log(line);
  console.log(`samples: ${SAMPLES_DIR}`);
  console.log(`assets: ${ASSETS_DIR}${existsSync(ASSETS_DIR) ? '' : '（缺失，图标与字体走 404）'}`);
  console.log(`READY ${actual}`);
};
server.listen(port, HOST, onReady);

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用，换一个：node packages/app/src/server.ts --port 7789`);
  } else {
    console.error('[app] 监听失败：', error);
  }
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // The agent server is a child of this process; it must not outlive the shell.
    agentBridge.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}

// `server.close()` is the other way this process stops (tests, an embedder): same rule.
server.on('close', () => agentBridge.stop());
