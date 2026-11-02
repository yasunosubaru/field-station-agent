/**
 * `packages/app/src/pdf.ts` and the `/api/graph/pdf` route.
 *
 * The container is checked byte-wise, because that is the part a reader cannot forgive:
 *
 *  - `%PDF-1.4` header, `%%EOF` trailer, and **every** `xref` entry's offset re-read from the file
 *    and matched against the `N 0 obj` it claims to point at (the `startxref` offset included);
 *  - the page count and the **charts on each page**, against the map measured from the original
 *    `逆向/00_来源/samples/graph/export/clean.pdf` (`pdftotext -layout`, one page at a time):
 *    page 1 information, page 2 `Trajectory Plot` alone, then two charts per page — PVT
 *    (Position Type + Position Status, Position SD + Solution Statistics, 2D Trajectory + Height),
 *    Tracking & Measurements (GNSS Signal Strength + Satellites and Signals, Tracking Time +
 *    Receiver Status) and Receiver Status (CPU Usage + HW Monitor Status). Eight pages, 13 charts;
 *  - the chart names and the project's six comment fields are findable in the uncompressed content
 *    streams (text is not encrypted or compressed, so a plain search must succeed);
 *  - a fixed `generatedAt` gives the same bytes twice, and the file stays well under 200 KB;
 *  - `pdftotext` on the file we write puts the same titles on the same page as `pdftotext` on the
 *    original (skipped when poppler is not installed);
 *  - the HTTP route returns the same document with `application/pdf` and a `.pdf` disposition.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GRAPH_CSV_DIR } from '../src/graphcsv.ts';
import { SAMPLES_DIR } from '../src/paths.ts';
import {
  buildGraphPdf,
  CHART_SPECS,
  graphPdfFileName,
  graphPdfOrder,
  graphPdfReport,
  PDF_CHARTS_PER_PAGE,
  PDF_PAGE,
} from '../src/pdf.ts';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');
const panelPath = resolve(here, '..', 'src', 'web', 'panels', 'graph.js');
/** The original Graph export this writer is measured against. */
const ORIGINAL_PDF = join(SAMPLES_DIR, 'graph', 'export', 'clean.pdf');

const SOURCES = readdirSync(GRAPH_CSV_DIR)
  .filter((name) => name.endsWith('.csv'))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(GRAPH_CSV_DIR, name), 'utf8') }));

/** The catalogue's order — the one the route serves, so page 3 starts with `Position Type`. */
const ORDERED = graphPdfOrder(SOURCES.map((source) => source.name))
  .map((name) => SOURCES.find((source) => source.name === name)!);

const GENERATED = '2026/10/30 21:00:00';

/**
 * The original's page map, page 1 first, measured page by page (`pdftotext -layout`). Page 2 holds
 * one chart; every page after it holds two, and a section heading can start between two cards
 * (`Receiver Status` does).
 */
const ORIGINAL_PAGES: ReadonlyArray<readonly string[]> = [
  [], // 1 — information page
  ['Trajectory Plot'], // 2 — the Overview track, alone
  ['Position Type', 'Position Status'], // 3 — PVT starts here
  ['Position SD', 'Solution Statistics'], // 4
  ['2D Trajectory', 'Height'], // 5
  ['GNSS Signal Strength', 'Satellites and Signals'], // 6 — Tracking & Measurements starts
  ['Tracking Time', 'Receiver Status'], // 7 — Receiver Status starts between the cards
  ['CPU Usage', 'HW Monitor Status'], // 8
];

/** The tab headings the original prints above a card, page by page (only where a tab starts). */
const ORIGINAL_SECTIONS: ReadonlyArray<readonly string[]> = [
  [],
  ['Trajectory Plot'],
  ['PVT'],
  [],
  [],
  ['Tracking & Measurements'],
  ['Receiver Status'],
  [],
];

function document_(options: Parameters<typeof buildGraphPdf>[1] = {}): Buffer {
  return Buffer.from(buildGraphPdf(SOURCES, { generatedAt: GENERATED, ...options }));
}

function latin1(bytes: Buffer): string {
  return bytes.toString('latin1');
}

test('the report is a valid PDF 1.4 with the original page map and exact xref offsets', () => {
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

  // 1 information page + 1 sheet for the Overview track + two charts per sheet afterwards.
  const twoPerPage = Math.ceil(SOURCES.length / PDF_CHARTS_PER_PAGE);
  const expected = 1 + 1 + twoPerPage;
  assert.equal(expected, ORIGINAL_PAGES.length, 'the clean CSVs cover the original 8 pages');

  const pages = (text.match(/\/Type \/Page\b/g) ?? []).length;
  assert.equal(pages, expected, 'one information page, then two charts per sheet');
  assert.match(text, new RegExp(`/Type /Pages /Kids \\[[^\\]]+\\] /Count ${expected} >>`), 'page tree count');

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
  assert.equal(PDF_CHARTS_PER_PAGE, 2, 'two charts per sheet, as the original prints them');
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

/* ---------------- the report's layout (read back from the content streams) ---------------- */

/** One string per page, in page order — the pages are the only objects with a `stream`. */
function pageStreams(bytes: Uint8Array): string[] {
  return [...Buffer.from(bytes).toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)]
    .map((match) => match[1]);
}

/** The card titles on a page: 13 pt bold runs (nothing else on a chart page is set that way). */
function titlesOf(page: string): string[] {
  return [...page.matchAll(/\/F2 13 Tf [\d.\- ]+Td \(([^)]*)\) Tj/g)].map((match) => match[1]);
}

/** The tab headings on a page: 9 pt bold runs (`PVT`, `Tracking & Measurements` …). */
function sectionsOf(page: string): string[] {
  return [...page.matchAll(/\/F2 9 Tf [\d.\- ]+Td \(([^)]*)\) Tj/g)].map((match) => match[1]);
}

/** The page whose chart carries `title`. */
function pageWith(title: string): string {
  const hit = PAGES.findIndex((page) => titlesOf(page).includes(title));
  assert.ok(hit > 0, `no page draws ${title}`);
  return PAGES[hit];
}

const REPORT = graphPdfReport(ORDERED, { generatedAt: GENERATED });
const PAGES = pageStreams(REPORT.bytes);

test('the catalogue order is the original tab order, and page 3 is its first PVT chart', () => {
  assert.deepEqual(graphPdfOrder(['Height.csv', '2D Trajectory.csv', 'Position Type.csv']), [
    'Position Type.csv', '2D Trajectory.csv', 'Height.csv',
  ]);
  assert.equal(ORDERED[0].name, 'Position Type.csv');
  assert.equal(ORDERED[ORDERED.length - 1].name, 'HW Monitor Status.csv');
  assert.equal(PAGES.length, REPORT.pages);
  assert.ok(PAGES[2].includes('(Position Type)'), 'page 3 is Position Type, right after the track');
});

test('every page carries the header the original prints, and the page number', () => {
  for (const [index, page] of PAGES.entries()) {
    assert.ok(page.includes('(Graph)'), `page ${index + 1} has the Graph wordmark`);
    assert.ok(
      page.includes('(clean  2026/10/30 21:00:00  GPS 2442,463097.350 .. 2442,463102.300)'),
      `page ${index + 1} has project / date / GNSS range`,
    );
    assert.ok(page.includes(`(${index + 1}/${REPORT.pages})`), `page ${index + 1} is numbered`);
  }
  assert.equal(REPORT.pages, 8, 'the original prints 1/8 … 8/8');
  assert.equal(REPORT.charts, SOURCES.length + 1, 'the Overview track plus one chart per CSV');
});

test('each page holds the charts the original puts there, in its order', () => {
  assert.equal(PAGES.length, ORIGINAL_PAGES.length, 'one page per page of the original');
  for (const [index, expected] of ORIGINAL_PAGES.entries()) {
    const titles = titlesOf(PAGES[index]);
    // Chart order, not just membership: the title runs are drawn top-down, so their stream order
    // is the page order.
    assert.deepEqual(titles, [...expected], `page ${index + 1}`);
  }
  // Page 2 is the one single-chart sheet; every later page holds two.
  assert.equal(ORIGINAL_PAGES[1].length, 1);
  for (const expected of ORIGINAL_PAGES.slice(2)) assert.equal(expected.length, PDF_CHARTS_PER_PAGE);
});

test('the section headings are printed once, where the original starts a tab', () => {
  // Page 1 is the cover; its 9 pt bold labels are field names, not tab headings.
  for (const index of ORIGINAL_PAGES.keys()) {
    if (index === 0) continue;
    assert.deepEqual(sectionsOf(PAGES[index]), [...ORIGINAL_SECTIONS[index]], `page ${index + 1}`);
  }
  // `Receiver Status` starts between two cards: its heading sits on page 7, above the second card.
  const page7 = PAGES[6];
  assert.ok(page7.indexOf('(Tracking Time)') < page7.indexOf('(Receiver Status)'), 'heading between the cards');
  // No tab heading is repeated on the next page.
  assert.equal(sectionsOf(PAGES[5]).includes('PVT'), false);
});

test('the cover is Report Information + Project Information + the chart summary table', () => {
  const cover = PAGES[0];
  for (const label of [
    '(clean Report)', '(Report Information)', '(Project Information)', '(Chart Summary)',
    '(Generated Date)', '(Project Name)', '(Data File Name)',
    '(Start Time \\(GPS\\))', '(End Time \\(GPS\\))',
  ]) {
    assert.ok(cover.includes(label), `cover prints ${label}`);
  }
  assert.ok(cover.includes('(13 charts - hand-written PDF 1.4'), 'the cover counts every chart');
  // One row per CSV, and the row's last column is the page its chart is drawn on.
  const pageOfTitle: Record<string, number> = {};
  for (const [index, expected] of ORIGINAL_PAGES.entries()) {
    for (const title of expected) pageOfTitle[title] = index + 1;
  }
  for (const source of ORDERED) {
    const title = source.name.replace(/\.csv$/, '');
    assert.ok(cover.includes(`(${title})`), `summary row for ${title}`);
  }
  // `Position Type` is the first card of page 3 and `Height` the second of page 5 — the numbers the
  // original's own page map gives.
  assert.ok(cover.includes('(3)'), 'the summary names page 3 for the first PVT charts');
  assert.ok(cover.includes('(5)'), 'and page 5 for 2D Trajectory + Height');
  assert.equal(pageOfTitle.Height, 5);
  assert.ok(cover.includes('(page 2: Trajectory Plot'), 'the cover says where the track went');
  // Real numbers, taken from the CSVs: Height is ~66.41 m, CPU Usage ~29 %.
  assert.ok(cover.includes('(66.41)') && cover.includes('(66.43)'), 'Height min / max from the CSV');
  assert.ok(cover.includes('(28.00)') && cover.includes('(29.50)'), 'CPU Usage min / max from the CSV');
});

test('each card has its title, axis labels, legend and y-axis unit', () => {
  const unitsOf = new Map(CHART_SPECS.filter((spec) => spec.units).map((spec) => [spec.file, spec.units!]));
  for (const [file, units] of unitsOf) {
    if (!ORDERED.some((source) => source.name === file)) continue;
    const page = pageWith(file.replace(/\.csv$/, ''));
    // An interval chart carries no y scale, so it prints no unit — the same as before this change.
    if (file === 'SPAN Filter Updates.csv') continue;
    const escaped = units.replace(/[()]/g, (char) => `\\${char}`);
    assert.ok(page.includes(`(${escaped})`), `${file} prints its y-axis unit ${units}`);
  }
  // The GPS week is spelled out once under the axis, and the ticks are seconds of that week.
  const heightPage = pageWith('Height');
  assert.ok(heightPage.includes('(GPS week 2442 - seconds of week 463098 .. 463102)'), 'x axis caption');
  assert.ok(heightPage.includes('(463100)'), 'a whole-second tick prints without decimals');
  // Legend chip for the plotted column.
  assert.ok(heightPage.includes('(Height)'));

  // The Overview track joins the fixes and says the original printed a map instead.
  const track = pageWith('Trajectory Plot');
  assert.match(track, /5 fixes joined into a track/, 'the track says what it is');
  assert.match(track, /no basemap is embedded/, 'and that there is no basemap');
  assert.ok((track.match(/ l /g) ?? []).length >= 4, 'the fixes are joined by a polyline');
});

test('a wide CSV keeps its card inside the point budget and says what it dropped', () => {
  const page = pageWith('GNSS Signal Strength');
  const vertices = (page.match(/ l /g) ?? []).length;
  assert.ok(vertices > 100, `the page draws polylines (${vertices} vertices)`);
  assert.ok(vertices < 4_000, `the page is decimated, not every one of the 7 326 samples (${vertices})`);
  assert.match(page, /every \d+th sample drawn/, 'the page says the stride it used');
  assert.match(page, /\(\+ \d+ more\)/, 'the legend counts the columns it could not name');
  assert.ok(REPORT.bytes.byteLength < 200_000, `the report is a download (${REPORT.bytes.byteLength} B)`);
});

/* ---------------- measured against the original PDF ---------------- */

/**
 * `pdftotext -layout` on a document, split into pages; `null` when poppler is not installed or the
 * original export is not on this machine.
 */
function layoutPages(file: string): string[] | null {
  if (spawnSync('pdftotext', ['-v'], { encoding: 'utf8' }).error) return null;
  const result = spawnSync('pdftotext', ['-layout', '-enc', 'UTF-8', file, '-'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.split('\f');
}

/** Every title of `expected` is on `page`, and in that order — by first occurrence. */
function assertPageOrder(page: string, expected: readonly string[], label: string): void {
  let previous = -1;
  for (const title of expected) {
    const at = page.indexOf(title);
    assert.ok(at >= 0, `${label}: ${title} is on the page`);
    assert.ok(at > previous, `${label}: ${title} comes after the previous chart`);
    previous = at;
  }
}

test('the page map above is what the original prints, and what this writer prints', (t) => {
  const original = layoutPages(ORIGINAL_PDF);
  if (!original) {
    t.skip('pdftotext or the original clean.pdf is not available');
    return;
  }
  assert.equal(original.length, ORIGINAL_PAGES.length + 1, 'the original has 8 pages (plus the trailing split)');
  for (const [index, expected] of ORIGINAL_PAGES.entries()) {
    if (!expected.length) continue;
    assertPageOrder(original[index], expected, `original page ${index + 1}`);
  }

  const dir = mkdtempSync(join(tmpdir(), 'app-pdf-layout-'));
  try {
    const file = join(dir, 'ours.pdf');
    writeFileSync(file, REPORT.bytes);
    const ours = layoutPages(file);
    assert.ok(ours, 'pdftotext reads the document we write');
    assert.equal(ours!.length, original.length, 'same number of pages as the original');

    const info = spawnSync('pdfinfo', [file], { encoding: 'utf8' });
    if (!info.error) {
      assert.equal(info.status, 0, `pdfinfo opens it: ${info.stderr}`);
      assert.match(info.stdout, /^Pages:\s+8$/m, 'pdfinfo counts eight pages');
    }
    for (const [index, expected] of ORIGINAL_PAGES.entries()) {
      if (!expected.length) continue;
      assertPageOrder(ours![index], expected, `page ${index + 1}`);
    }
    // Nothing extra: the 13 pt titles read back from our own content streams are exactly the
    // original's list (the text dump above cannot tell a legend chip from a title, the streams can).
    for (const [index, page] of PAGES.entries()) {
      assert.deepEqual(titlesOf(page), [...ORIGINAL_PAGES[index]], `our page ${index + 1}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.equal(pages, 8, 'the original page count');
  assert.equal(headers.get('x-pdf-pages'), '8');
  assert.equal(headers.get('x-pdf-charts'), String(SOURCES.length + 1));
  assert.equal(headers.get('x-pdf-bytes'), String(bytes.length));
});

test('GET /api/graph/pdf?file= has one chart page, and refuses a bad name', async () => {
  const one = await get(`/api/graph/pdf?file=${encodeURIComponent('Height.csv')}`);
  assert.equal(one.status, 200);
  assert.equal(one.headers.get('x-pdf-pages'), '2');
  assert.equal(one.headers.get('x-pdf-charts'), '1');

  const missing = await get(`/api/graph/pdf?file=${encodeURIComponent('Nope.csv')}`);
  assert.equal(missing.status, 404);

  const escape = await get(`/api/graph/pdf?file=${encodeURIComponent('../clean-9600.gps')}`);
  assert.equal(escape.status, 400);
});

test('GET /api/graph/pdf?project= narrows the document to that project', async () => {
  const clean = await get('/api/graph/pdf?project=clean');
  assert.equal(clean.status, 200);
  assert.equal(clean.headers.get('content-type'), 'application/pdf');
  assert.equal(clean.headers.get('content-disposition'), 'attachment; filename="clean.pdf"');
  assert.equal(clean.headers.get('x-pdf-project'), 'clean');
  assert.equal(clean.headers.get('x-pdf-pages'), '8');
  assert.equal(Buffer.from(clean.bytes).toString('latin1').slice(0, 8), '%PDF-1.4');

  // The project name in the CSVs is what matches, not the path; an unknown one is a 404 that names
  // the projects that do exist, so a typo cannot download somebody else's report.
  const unknown = await get('/api/graph/pdf?project=Nope');
  assert.equal(unknown.status, 404);
  const body = JSON.parse(Buffer.from(unknown.bytes).toString('utf8'));
  assert.match(body.error, /Nope/);
  assert.match(body.error, /clean/);

  const empty = await get('/api/graph/pdf?project=');
  assert.equal(empty.status, 400);
});

test('the panel downloads the route instead of opening the print dialog', () => {
  const panel = readFileSync(panelPath, 'utf8');
  assert.equal(/contentWindow\s*\.\s*print\(|\.print\(\)/.test(panel), false, 'no window.print() left');
  assert.match(panel, /\/api\/graph\/pdf\?project=/, 'the export asks the route for the project');
  assert.match(panel, /async function exportPdf\(/, 'and it is an async download, not a print');
  assert.match(panel, /else if \(kind === 'pdf'\) void exportPdf\(\)/, 'Export ▸ PDF is wired to it');
});
