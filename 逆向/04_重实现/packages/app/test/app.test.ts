/**
 * End-to-end checks for the shell. Starts the real server on an ephemeral port (`--port 0`) and
 * talks to it over HTTP, so these tests exercise routing, path guards and the protocol pipeline
 * exactly as the browser does.
 *
 *   node --test --test-force-exit "packages/app/test/*.test.ts"
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const samplesDir = join(repoRoot, '逆向', '00_来源', 'samples');
const goldenRoot = join(samplesDir, 'convert');

let child: ChildProcessWithoutNullStreams | null = null;
let base = '';
let stderr = '';

function waitForReady(proc: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`server did not start in 20s\nstderr:\n${stderr}`)), 20_000);
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

async function getJson(path: string) {
  const response = await fetch(base + path);
  const body = await response.json();
  return { response, body };
}

interface ConvertBody {
  ok: boolean;
  format: string;
  fileName: string;
  bytes: number;
  lineTotal: number;
  shownLines: number;
  truncated: boolean;
  binary: boolean;
  text: string | null;
  preview: string | null;
  downloadUrl: string;
  records: { total: number; accepted: number; dropped: number; textRecords: number };
  elapsedMs: number;
}

async function convert(capture: string, format: string): Promise<{ body: ConvertBody; bytes: Buffer }> {
  const response = await fetch(base + '/api/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ capture, format }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as ConvertBody;
  assert.equal(body.ok, true);
  const download = await fetch(base + body.downloadUrl);
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.byteLength, body.bytes, '下载字节数与响应声明一致');
  return { body, bytes };
}

function golden(...segments: string[]): Buffer {
  return readFileSync(join(goldenRoot, ...segments));
}

before(async () => {
  child = spawn(process.execPath, [serverPath, '--port', '0'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const port = await waitForReady(child);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child?.kill('SIGKILL'), 2000);
    timer.unref();
  }
});

test('首页返回 200 且含页面标题与三个工作页', async () => {
  const response = await fetch(base + '/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const html = await response.text();
  assert.match(html, /<title>野外台站智能体/);
  assert.match(html, /id="panel-convert"/);
  assert.match(html, /id="panel-manage"/);
  assert.match(html, /id="panel-playback"/);
  assert.match(html, /Playback/);
  // Offline shell: no CDN scripts or stylesheets.
  assert.doesNotMatch(html, /<(script|link)[^>]+(src|href)="https?:/i);
});

test('POST /api/convert 的 ASCII 产物与 golden 逐字节一致', async () => {
  const { body, bytes } = await convert('clean-9600.gps', 'ASCII');
  assert.equal(body.format, 'ASCII');
  assert.equal(body.fileName, 'clean-9600.ASCII');
  assert.equal(body.lineTotal, 119);
  assert.equal(body.shownLines, body.lineTotal);
  assert.equal(body.truncated, false);
  assert.equal(body.preview, null, '未截断时正文放在 text，不重复发送');
  assert.equal(typeof body.text, 'string');
  assert.equal(body.text!.split('\r\n').length - 1, body.lineTotal);
  assert.match(body.text!.split('\r\n')[0], /^#RANGEA,/);
  assert.ok(body.text!.endsWith('\r\n'));
  assert.deepEqual(body.records, { total: 119, accepted: 119, dropped: 0, textRecords: 0 });

  const expected = golden('golden-ascii', 'clean-9600', 'Converted_On_20261030_T1710', 'ASCII', 'clean-9600.ASCII');
  assert.ok(Buffer.from(body.text!, 'utf8').equals(expected), '响应里的 text 也应与 golden 一致');
  assert.equal(bytes.byteLength, expected.byteLength);
  assert.ok(bytes.equals(expected), 'ASCII 产物必须与 golden 逐字节一致');
});

test('其余确定性格式也与 golden 逐字节一致（ABBREV / BINARY / KML）', async () => {
  const abbrev = await convert('clean-9600.gps', 'ABBREV_ASCII');
  assert.ok(abbrev.body.truncated, '6294 行应触发 200 行截断');
  assert.equal(abbrev.body.shownLines, 200);
  assert.equal(abbrev.body.text, null);
  assert.equal(abbrev.body.preview!.split('\n').length, 200);
  assert.ok(abbrev.bytes.equals(golden('golden-abbrev', 'clean-9600', 'Converted_On_20261030_T1710', 'ABBREV_ASCII', 'clean-9600.ABBREV_ASCII')));

  const binary = await convert('clean-9600.gps', 'BINARY');
  assert.equal(binary.body.binary, true);
  assert.ok(binary.bytes.equals(golden('golden-binary', 'clean-9600', 'Converted_On_20261030_T1710', 'BINARY', 'clean-9600.BINARY')));

  const kmlPath = join(goldenRoot, 'golden-kml', 'clean-9600', 'Converted_On_20261030_T1710', 'KML', 'clean-9600_BESTPOS.KML');
  if (existsSync(kmlPath)) {
    const kml = await convert('clean-9600.gps', 'KML');
    assert.equal(kml.body.fileName, 'clean-9600_BESTPOS.KML');
    assert.ok(kml.bytes.equals(readFileSync(kmlPath)));
  }
});

test('GET /api/logs 的 RANGE / BESTPOS / RXSTATUS 条数正确', async () => {
  const { response, body } = await getJson('/api/logs?capture=clean-9600.gps');
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.totalRecords, 119);
  assert.equal(body.accepted, 119);
  assert.equal(body.dropped, 0);
  assert.equal(body.types, 6);

  const counts = new Map<number, number>(body.groups.map((group: { id: number; count: number }) => [group.id, group.count]));
  assert.equal(counts.get(43), 100, 'RANGE');
  assert.equal(counts.get(42), 5, 'BESTPOS');
  assert.equal(counts.get(93), 4, 'RXSTATUS');

  const range = body.groups.find((group: { id: number }) => group.id === 43);
  assert.equal(range.name, 'RANGE');
  assert.ok(range.sample.startsWith('#RANGEA,'));
  assert.ok(range.firstMilliseconds <= range.lastMilliseconds);
  assert.ok(range.firstWeek >= 2000);
  assert.match(range.firstUtc, /^2026-10-30T/);
});

test('GET /api/records 返回解析后的字段表', async () => {
  const { response, body } = await getJson('/api/records?capture=clean-9600.gps&msgId=42&limit=1');
  assert.equal(response.status, 200);
  assert.equal(body.name, 'BESTPOS');
  assert.equal(body.total, 5);
  assert.equal(body.records.length, 1);
  const record = body.records[0];
  assert.equal(record.header.week, 2442);
  const latitude = record.fields.find((field: { path: string }) => field.path === 'latitude');
  assert.ok(latitude, '字段表应包含 latitude');
  assert.equal(typeof latitude.value, 'number');
  assert.ok(Math.abs(latitude.value) <= 90);
});

test('抓包路径不能逃出 samples 目录', async () => {
  for (const capture of ['../../../package.json', 'C:\\Windows\\win.ini', 'convert/../../package.json']) {
    const response = await fetch(base + '/api/logs?capture=' + encodeURIComponent(capture));
    assert.equal(response.status, 400, capture);
    const body = await response.json();
    assert.equal(body.ok, false);
  }
});

test('未知抓包与未知接口返回 404', async () => {
  const missing = await fetch(base + '/api/logs?capture=' + encodeURIComponent('convert/nope.gps'));
  assert.equal(missing.status, 404);
  const unknown = await fetch(base + '/api/nothing');
  assert.equal(unknown.status, 404);
});
