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
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative } from 'node:path';

import { CONVERT_FORMATS, convertCapture, FORMAT_LABELS, FORMAT_NOTES, isConvertFormat, type ConvertFormat } from './convert.ts';
import { loadCapture, tables } from './capture.ts';
import { readRecords, summarizeLogs } from './logs.ts';
import {
  HttpError,
  SAMPLES_DIR,
  REPO_DIR,
  WEB_DIR,
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

function integer(value: string | null, fallback: number, min: number, max: number, label: string): number {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, `${label} 必须是 ${min}..${max} 的整数`);
  }
  return parsed;
}

function formatOptions() {
  return CONVERT_FORMATS.map((format) => ({
    id: format,
    label: FORMAT_LABELS[format],
    note: FORMAT_NOTES[format],
  }));
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
      if (path === '/' || path === '/index.html') {
        handlePage(res);
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
