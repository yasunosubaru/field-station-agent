/**
 * `packages/app/src/pdf.ts` and the `/api/graph/pdf` route.
 *
 * The container is checked byte-wise, because that is the part a reader cannot forgive:
 *
 *  - `%PDF-1.4` header, `%%EOF` trailer, and **every** `xref` entry's offset re-read from the file
 *    and matched against the `N 0 obj` it claims to point at (the `startxref` offset included);
 *  - one page per CSV plus the information page, counted both as `/Type /Page` objects and as the
 *    page tree's `/Count`;
 *  - the chart names and the project's six comment fields are findable in the uncompressed content
 *    streams (text is not encrypted or compressed, so a plain search must succeed);
 *  - a fixed `generatedAt` gives the same bytes twice, and the file stays well under 200 KB;
 *  - the HTTP route returns the same document with `application/pdf` and a `.pdf` disposition.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GRAPH_CSV_DIR } from '../src/graphcsv.ts';
import { buildGraphPdf, graphPdfFileName, graphPdfReport, PDF_PAGE } from '../src/pdf.ts';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');

const SOURCES = readdirSync(GRAPH_CSV_DIR)
  .filter((name) => name.endsWith('.csv'))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(GRAPH_CSV_DIR, name), 'utf8') }));

const GENERATED = '2026/10/30 21:00:00';

function document_(options: Parameters<typeof buildGraphPdf>[1] = {}): Buffer {
  return Buffer.from(buildGraphPdf(SOURCES, { generatedAt: GENERATED, ...options }));
}

function latin1(bytes: Buffer): string {
  return bytes.toString('latin1');
}

test('the report is a valid PDF 1.4 with one page per CSV and exact xref offsets', () => {
  const bytes = document_();
  const text = latin1(bytes);

  assert.equal(text.slice(0, 8), '%PDF-1.4', 'header');
  assert.ok(text.endsWith('%%EOF\n'), 'trailer');

  const tail = /startxref\n(\d+)\n%%EOF\n$/.exec(text);
  assert.ok(tail, 'document ends with startxref / <offset> / %%EOF');
  const start = Number(tail![1]);
  assert.equal(text.slice(start, start + 4), 'xref', 'startxref points at the xref keyword');

  const rest = text.slice(start + 5);
  const trailerAt = rest.indexOf('trailer');
  const block = rest.slice(0, trailerAt).split('\n').filter((line) => line !== '');
  const count = Number(block[0].split(' ')[1]);
  assert.equal(count, block.length - 1, 'xref header agrees with its entry count');

  for (let number = 1; number < count; number++) {
    const entry = block[number + 1] ?? block[number];
    const offset = Number(entry.slice(0, 10));
    assert.equal(
      text.slice(offset, offset + `${number} 0 obj`.length),
      `${number} 0 obj`,
      `entry ${number} points at its own object`,
    );
  }

  const pages = (text.match(/\/Type \/Page\b/g) ?? []).length;
  assert.equal(pages, SOURCES.length + 1, 'one information page plus one per chart');
  assert.match(text, new RegExp(`/Type /Pages /Kids \\[[^\\]]+\\] /Count ${SOURCES.length + 1} >>`), 'page tree count');

  const streams = [...text.matchAll(/stream\n([\s\S]*?)\nendstream/g)];
  assert.equal(streams.length, pages, 'every page has one content stream');
  const all = streams.map((match) => match[1]).join('\n');
  for (const source of SOURCES) {
    assert.ok(all.includes(`(${source.name.replace(/\.csv$/, '')})`), `chart title ${source.name}`);
  }
  for (const field of ['Project Name', 'Project Directory', 'Data File Name', 'Start Time \\(GPS\\)', 'End Time \\(GPS\\)', 'Duration']) {
    assert.ok(all.includes(`(${field})`), `information field ${field.replace(/\\/g, '')}`);
  }
  assert.ok(all.includes('(clean.gps)'), 'the data file name comes from the CSV comments');

  assert.ok(bytes.length < 200_000, `document is small enough to download (${bytes.length} B)`);
  assert.equal(PDF_PAGE.width, 842, 'A4 landscape, the same page box the suite used');
  assert.equal(text.includes(`/MediaBox [0 0 ${PDF_PAGE.width} ${PDF_PAGE.height}]`), true);
});

test('the same input and the same clock give the same bytes', () => {
  assert.deepEqual(document_(), document_());
  assert.notDeepEqual(document_(), document_({ generatedAt: '2026/10/31 09:00:00' }));
});

test('one chart still gets its own information page, and the file name is the project', () => {
  const one = SOURCES.filter((source) => source.name === 'Height.csv');
  const report = graphPdfReport(one, { generatedAt: GENERATED });
  const text = latin1(Buffer.from(report.bytes));
  assert.equal(report.pages, 2);
  assert.equal(report.charts, 1);
  assert.equal((text.match(/\/Type \/Page\b/g) ?? []).length, 2);
  assert.equal(report.fileName, 'clean.pdf');
  assert.equal(graphPdfFileName('a/b:c'), 'a_b_c.pdf');
});

/* ---------------- the HTTP route ---------------- */

let child: ChildProcessWithoutNullStreams | null = null;
let base = '';

function waitForReady(proc: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((ready, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error('server did not start in 20 s')), 20_000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        ready(Number(match[1]));
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', () => { /* drain: an unread pipe keeps the child from exiting cleanly */ });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code})`));
    });
  });
}

before(async () => {
  child = spawn(process.execPath, [serverPath, '--port', '0'], {
    cwd: resolve(here, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const port = await waitForReady(child);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (!child || child.killed) return;
  // `close` (not `exit`): the child's stdout/stderr pipes are gone too. The extra turn lets libuv
  // reap the process handle before `--test-force-exit` ends this one — without it the runner
  // occasionally aborts on `uv_async_send` while a handle is still closing.
  const closed = new Promise((done) => child!.once('close', done));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child?.kill('SIGKILL'), 2000);
  timer.unref();
  await closed;
  clearTimeout(timer);
  await new Promise((done) => setTimeout(done, 150));
});

/**
 * One request, with `connection: close` so undici leaves no idle socket behind: `--test-force-exit`
 * ends the process as soon as the tests do, and a keep-alive socket closing at that moment is what
 * makes the runner abort intermittently on Windows.
 */
async function get(path: string): Promise<{ status: number; headers: Headers; bytes: Buffer }> {
  const response = await fetch(base + path, { headers: { connection: 'close' } });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, headers: response.headers, bytes };
}

test('GET /api/graph/pdf downloads a real PDF named after the project', async () => {
  const { status, headers, bytes } = await get('/api/graph/pdf');
  assert.equal(status, 200);
  assert.equal(headers.get('content-type'), 'application/pdf');
  assert.equal(headers.get('content-disposition'), 'attachment; filename="clean.pdf"');
  const text = latin1(bytes);

  assert.equal(text.slice(0, 8), '%PDF-1.4');
  assert.ok(text.endsWith('%%EOF\n'));
  const pages = (text.match(/\/Type \/Page\b/g) ?? []).length;
  assert.equal(pages, SOURCES.length + 1);
  assert.equal(headers.get('x-pdf-pages'), String(SOURCES.length + 1));
  assert.equal(headers.get('x-pdf-charts'), String(SOURCES.length));
  assert.equal(headers.get('x-pdf-bytes'), String(bytes.length));
});

test('GET /api/graph/pdf?file= has one chart page, and refuses a bad name', async () => {
  const one = await get(`/api/graph/pdf?file=${encodeURIComponent('Height.csv')}`);
  assert.equal(one.status, 200);
  assert.equal(one.headers.get('x-pdf-pages'), '2');

  const missing = await get(`/api/graph/pdf?file=${encodeURIComponent('Nope.csv')}`);
  assert.equal(missing.status, 404);

  const escape = await get(`/api/graph/pdf?file=${encodeURIComponent('../clean-9600.gps')}`);
  assert.equal(escape.status, 400);
});
