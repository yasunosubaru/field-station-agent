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
import { existsSync, readFileSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

import { CONVERT_FORMATS, convertCapture, FORMAT_LABELS, FORMAT_NOTES, isConvertFormat, type ConvertFormat } from './convert.ts';
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
  isConfigPage,
  primeEventsPage,
  readConfigAsset,
  refreshConfigPage,
} from './config-http.ts';
import { LiveLink, type LiveTarget } from './live.ts';
import type { SerialOpener } from '../../session/src/transport.ts';
import { readRecords, summarizeLogs } from './logs.ts';
import { playbackExport, playbackFrame, playbackFrames, playbackInfo } from './playback.ts';
import { GRAPH_CSV_DIR, graphData, listGraphCsv, readGraphCsv } from './graphcsv.ts';
import { graphPdfReport } from './pdf.ts';
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
const VERSION = '0.1.0';
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
      '/api/graph/files',
      '/api/graph/data',
      '/api/graph/pdf',
      '/api/live/status',
      '/api/live/logs',
      '/api/live/connect',
      '/api/live/disconnect',
      '/api/live/command',
    ],
  };
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

  const capture = resolveCapture(body.capture);
  const started = process.hrtime.bigint();
  const data = loadCapture(capture);
  const artifact = convertCapture(data, tables(), format, at);
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
  const messageId = integer(url.searchParams.get('msgId'), -1, 0, 0xffffffff, 'msgId');
  if (messageId < 0) throw new HttpError(400, '缺少 msgId');
  const offset = integer(url.searchParams.get('offset'), 0, 0, 10_000_000, 'offset');
  const limit = integer(url.searchParams.get('limit'), 1, 1, 25, 'limit');

  const data = loadCapture(capture);
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

function handleGraphFiles(res: ServerResponse, method: string): void {
  const files = listGraphCsv();
  sendJson(res, 200, {
    ok: true,
    directory: relative(REPO_DIR, GRAPH_CSV_DIR).split('\\').join('/'),
    count: files.length,
    files,
  }, method);
}

function handleGraphData(url: URL, res: ServerResponse, method: string): void {
  const column = url.searchParams.get('column');
  sendJson(res, 200, { ok: true, ...graphData(url.searchParams.get('file'), column) }, method);
}

/**
 * `GET /api/graph/pdf[?file=<one csv>]` — the document Graph's *Export → PDF* downloads.
 *
 * Built server-side from the CSVs the project already exported (all twelve by default, one with
 * `?file=`), so the bytes are a real PDF 1.4 rather than a print dialog: see `pdf.ts`. The panel
 * keeps its `window.print()` fallback for now, because `web/panels/graph.js` is owned by another
 * task; pointing its PDF entry at this URL is a one-line change.
 */
function handleGraphPdf(url: URL, res: ServerResponse, method: string): void {
  const only = url.searchParams.get('file');
  const names = only ? [only] : listGraphCsv().map((entry) => entry.name);
  if (names.length === 0) throw new HttpError(404, '没有可导出的 CSV');
  const sources = names.map((name) => {
    const data = readGraphCsv(name);
    return { name: data.name, text: data.text };
  });
  const report = graphPdfReport(sources);
  sendBytes(res, 200, report.bytes, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${report.fileName}"`,
    'X-PDF-Pages': String(report.pages),
    'X-PDF-Charts': String(report.charts),
    'X-PDF-Bytes': String(report.bytes.byteLength),
  }, method);
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

const server = createServer((req, res) => {
  void (async () => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      sendJson(res, 405, { ok: false, error: '不支持的请求方法' }, method);
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
      if (path === '/api/graph/files') {
        handleGraphFiles(res, method);
        return;
      }
      if (path === '/api/graph/data') {
        handleGraphData(url, res, method);
        return;
      }
      if (path === '/api/graph/pdf') {
        handleGraphPdf(url, res, method);
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
server.listen(port, HOST, () => {
  const address = server.address();
  const actual = typeof address === 'object' && address ? address.port : port;
  const line = `nas-reimpl app listening on http://${HOST}:${actual}`;
  console.log(line);
  console.log(`samples: ${SAMPLES_DIR}`);
  console.log(`assets: ${ASSETS_DIR}${existsSync(ASSETS_DIR) ? '' : '（缺失，图标与字体走 404）'}`);
  console.log(`READY ${actual}`);
});

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
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
