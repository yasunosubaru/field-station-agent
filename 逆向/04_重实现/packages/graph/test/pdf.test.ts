/**
 * `buildPdfReport` — the hand-written PDF, checked on the **shipped golden CSVs**
 * (`00_来源/samples/graph/export/csv/`), the same inputs `html.test.ts` uses.
 *
 * The container is checked byte-wise because that is the only part a reader cannot forgive:
 *
 *  - header `%PDF-1.4`, trailer `%%EOF`, and **every** `xref` entry's offset re-read from the file
 *    and matched against the `N 0 obj` it claims to point at (the `startxref` offset included);
 *  - `1 + 12` pages — one information page, then one page per chart;
 *  - text is searchable in the uncompressed content streams: all 12 chart titles, the project name,
 *    the start/end times and the duration;
 *  - under 1.5 MB, and the same input with a fixed `generatedAt` gives the same bytes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProject } from '../src/project.ts';
import { loadCapture } from '../src/capture.ts';
import { exportCsv } from '../src/csv.ts';
import { parseReportCsv } from '../src/html.ts';
import { PDF_PAGE, PDF_TABLE_ROWS, buildPdfReport, writePdfReport } from '../src/pdf.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(here, '..', '..', '..', '..', '00_来源', 'samples');
const GPF = join(SAMPLES, 'graph', 'project', 'clean.gpf');
const CAPTURE = join(SAMPLES, 'convert', 'clean-9600.gps');
const CSV_GOLDEN = join(SAMPLES, 'graph', 'export', 'csv');

/** The 12 golden CSVs, by chart title. */
const GOLDEN = readdirSync(CSV_GOLDEN)
  .filter((name) => name.endsWith('.csv'))
  .sort()
  .map((name) => ({ title: name.replace(/\.csv$/, ''), csv: readFileSync(join(CSV_GOLDEN, name)) }));

const project = loadProject(GPF);
const GENERATED = '2026/10/30 21:00:00';

/** Built once: 12 chart pages of text and vector paths. */
let cached: Buffer | null = null;
function pdf(): Buffer {
  cached ??= Buffer.from(buildPdfReport(project, GOLDEN, { generatedAt: GENERATED }));
  return cached;
}

/** The document as bytes-as-latin1 text — every non-ASCII byte is inside our own `%âãÏÓ` comment. */
function latin1(): string {
  return pdf().toString('latin1');
}

/** Content streams are uncompressed, so the text is literally there. */
function streams(): string[] {
  return [...latin1().matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((match) => match[1]);
}

interface Xref {
  /** Byte offset the trailer's `startxref` points at. */
  start: number;
  /** `0 N` from the `xref` subsection header. */
  count: number;
  /** `[offset, generation, type]` per object number, in file order. */
  entries: { offset: number; generation: number; type: string }[];
  size: number;
}

/** Parse the `xref` table back out of the bytes, without trusting anything we wrote. */
function readXref(text: string): Xref {
  const tail = /startxref\n(\d+)\n%%EOF\n$/.exec(text);
  assert.ok(tail, 'document ends with startxref / <offset> / %%EOF');
  const start = Number(tail![1]);
  assert.equal(text.slice(start, start + 4), 'xref', `startxref ${start} points at the xref keyword`);

  const rest = text.slice(start + 5); // past "xref\n"
  const trailerAt = rest.indexOf('trailer');
  assert.ok(trailerAt > 0, 'xref is followed by a trailer');
  const block = rest.slice(0, trailerAt).split('\n').filter((line) => line !== '');
  const [first, count] = block[0].trim().split(/\s+/).map(Number);
  assert.equal(first, 0, 'the subsection starts at object 0');
  const entries = block.slice(1).map((line) => {
    // A xref entry is exactly 20 bytes: "0000000000 65535 f \n" (19 printable + the newline).
    assert.equal(line.length, 19, `xref entry has the fixed 20-byte record: ${JSON.stringify(line)}`);
    const offset = Number(line.slice(0, 10));
    const generation = Number(line.slice(11, 16));
    const type = line[17];
    return { offset, generation, type };
  });
  assert.equal(entries.length, count, 'one entry per object number');

  const size = Number(/\/Size (\d+)/.exec(rest)![1]);
  assert.ok(/\/Root 1 0 R/.test(rest), 'trailer links the catalog');
  assert.ok(/\/Info 3 0 R/.test(rest), 'trailer links the info dictionary');
  return { start, count, entries, size };
}

/** Bytes equal? Never `assert.deepEqual` on two big Buffers: its failure diff is unbounded. */
function sameBytes(actual: Uint8Array, expected: Uint8Array, message: string): void {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length === b.length && a.equals(b)) return;
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at++;
  assert.fail(`${message} (${a.length} vs ${b.length} bytes, first difference at byte ${at})`);
}

test('output is a complete PDF 1.4 whose xref offsets are all correct', () => {
  const text = latin1();
  assert.ok(text.startsWith('%PDF-1.4\n'), 'starts with the version header');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'ends with %%EOF');

  const xref = readXref(text);
  // Objects are numbered 0…count-1, so /Size (one past the highest object number) is exactly count.
  assert.equal(xref.size, xref.count, '/Size is one past the last object number');

  // Every in-use entry must point at "<n> 0 obj" for its own number, and the free entry must be the
  // conventional head of the list.
  assert.deepEqual(xref.entries[0], { offset: 0, generation: 65535, type: 'f' });
  for (let number = 1; number < xref.count; number++) {
    const entry = xref.entries[number];
    assert.equal(entry.type, 'n', `object ${number} is in use`);
    assert.equal(entry.generation, 0, `object ${number} has generation 0`);
    assert.ok(
      text.startsWith(`${number} 0 obj`, entry.offset),
      `xref offset ${entry.offset} for object ${number} lands on "${text.slice(entry.offset, entry.offset + 12)}"`,
    );
    // The object must terminate too, otherwise two entries would overlap.
    const body = text.slice(entry.offset);
    assert.ok(body.includes('endobj'), `object ${number} has an endobj`);
  }

  // startxref must agree with where "xref" actually is, and be inside the file.
  assert.ok(xref.start > 0 && xref.start < text.length);
  assert.equal(text.split('\nxref\n').length - 1, 1, 'exactly one xref table');
});

test('one information page plus one page per chart', () => {
  const text = latin1();
  assert.equal(Number(/\/Type \/Pages[^>]*\/Count (\d+)/.exec(text)![1]), 1 + GOLDEN.length);
  assert.equal((text.match(/\/Type \/Page[^s]/g) ?? []).length, 1 + GOLDEN.length, '13 page objects');
  assert.equal(streams().length, 1 + GOLDEN.length, 'one content stream per page');
  for (const stream of streams()) {
    assert.ok(stream.includes('/F1'), 'every page names a font');
  }
  // A4 landscape, the box the original was printed at.
  assert.ok(text.includes(`/MediaBox [0 0 ${PDF_PAGE.width} ${PDF_PAGE.height}]`));
});

test('text is findable in the uncompressed streams: 12 titles, project name, start/end, duration', () => {
  const all = streams().join('\n');
  assert.equal(GOLDEN.length, 12);
  for (const { title } of GOLDEN) {
    assert.ok(all.includes(`(${title}) Tj`), `chart title ${JSON.stringify(title)} is drawn as text`);
  }
  for (const literal of ['Project Name', 'clean', '2442,463097.350', '2442,463102.300', '00:00:04', 'Report Information']) {
    assert.ok(all.includes(literal), `${literal} is in the report text`);
  }
  // The information page is page 1 and holds the fields; the chart pages hold the titles.
  const [info, ...charts] = streams();
  assert.ok(info.includes('Project Information'));
  assert.ok(!info.includes(`(${GOLDEN[0].title}) Tj`), 'chart titles live on their own pages');
  assert.equal(charts.length, 12);
});

test('each chart page draws one vector path per column and a 20-row table', () => {
  const texts = streams().slice(1);
  GOLDEN.forEach((golden, index) => {
    const stream = texts[index];
    const parsed = parseReportCsv(golden.csv);
    assert.ok(stream.includes(`(${golden.title}) Tj`), `${golden.title} has its own page`);
    // One `m … l … S` path per series; constant series collapse to a stroked horizontal rule but
    // are still counted by the legend entry below.
    const moves = (stream.match(/ m /g) ?? []).length;
    assert.ok(moves >= 1, `${golden.title}: at least one line path`);
    // Every legend entry is a text run carrying the column name.
    for (const name of parsed.header.slice(1, 4)) {
      assert.ok(stream.includes(name), `${golden.title}: column ${name} appears`);
    }
    // First 20 rows are tabulated, the 21st is not (when the CSV is long enough).
    if (parsed.rows.length > PDF_TABLE_ROWS) {
      const hidden = parsed.rows[PDF_TABLE_ROWS][0];
      assert.ok(!stream.includes(`(${hidden}) Tj`), `${golden.title}: row 21 (${hidden}) is not tabulated`);
    }
    // The table states how much it shows: "first 20 of 99 rows" or "5 rows" when the CSV is short.
    const note = parsed.rows.length > PDF_TABLE_ROWS ? `first ${PDF_TABLE_ROWS}` : `${parsed.rows.length} row`;
    assert.ok(stream.includes(note), `${golden.title}: table note states the row count`);
  });
});

test('the file stays under 1.5 MB and repeats the CSV it was built from', () => {
  const bytes = pdf().length;
  assert.ok(bytes < 1.5 * 1024 * 1024, `size ${bytes} B < 1.5 MB`);
});

test('the same input produces byte-identical output', () => {
  const a = buildPdfReport(project, GOLDEN, { generatedAt: GENERATED });
  const b = buildPdfReport(project, GOLDEN, { generatedAt: GENERATED });
  sameBytes(a, b, 'two builds of the same input differ');
  sameBytes(a, pdf(), 'cached build differs from a fresh one');
  // A different timestamp is the one thing that may change the bytes.
  const other = buildPdfReport(project, GOLDEN, { generatedAt: '2026/10/31 08:00:00' });
  assert.ok(!Buffer.from(other).equals(Buffer.from(a)), 'a different Generated Date changes the document');
});

test('selectedPlots and tableRows are honoured', () => {
  const text = Buffer.from(
    buildPdfReport(project, GOLDEN, { generatedAt: 'fixed', selectedPlots: ['Height', 'CPU Usage'] }),
  ).toString('latin1');
  assert.equal(Number(/\/Type \/Pages[^>]*\/Count (\d+)/.exec(text)![1]), 3, 'info page + two charts');
  assert.ok(text.includes('(Height) Tj'));
  assert.ok(text.includes('(CPU Usage) Tj'));
  assert.ok(!text.includes(`(${GOLDEN[0].title}) Tj`), 'an unselected chart is not drawn');

  const three = buildPdfReport(project, GOLDEN, { generatedAt: 'fixed', tableRows: 3 });
  assert.ok(three.length < pdf().length, 'fewer table rows make a smaller file');
  assert.ok(Buffer.from(three).toString('latin1').includes('first 3 of 99 rows'));
});

test('a large chart is decimated, stays under 1.5 MB and builds in seconds', () => {
  const rows = ['timestamp (GPS week sec),a,b,c,d,e'];
  for (let index = 0; index < 20_000; index++) {
    rows.push(`2442  ${(463098 + index * 0.001).toFixed(3)},${index},${(index % 997) / 10},${index % 7},${index / 3},${-index}`);
  }
  const big = Buffer.from(buildPdfReport(project, [{ title: 'Stress', csv: rows.join('\r\n') }], { generatedAt: 'fixed' }));
  const stream = big.toString('latin1');
  // 20 000 rows / 1200 points per series → stride 17, and the caption must say so. Parentheses are
  // escaped in the PDF literal string, so the raw stream shows `\(1/17 points\)`.
  assert.ok(stream.includes('decimated \\(1/17 points\\)'), 'the caption states the decimation stride');
  assert.ok(stream.includes('first 20 of 20000 rows'), 'the table is capped at 20 rows');
  assert.ok(big.length < 1.5 * 1024 * 1024, `size ${big.length} B < 1.5 MB`);

  const started = performance.now();
  buildPdfReport(project, [{ title: 'Stress', csv: rows.join('\r\n') }], { generatedAt: 'fixed' });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 5000, `build took ${elapsed.toFixed(0)} ms (< 5000 ms)`);
});

test('builds from the CSVs the exporter produces today and writes <out>/<project>.pdf', () => {
  const capture = loadCapture(CAPTURE);
  // Same order as `GOLDEN` (file name order), so this compares content, not caller ordering.
  const charts = exportCsv(project, capture)
    .map((result) => ({ title: result.fileName.replace(/\.csv$/, ''), csv: result.buffer }))
    .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  const exported = Buffer.from(buildPdfReport(project, charts, { generatedAt: GENERATED }));
  sameBytes(exported, pdf(), 'exportCsv output differs from the golden-CSV document');

  const dir = mkdtempSync(join(tmpdir(), 'graph-pdf-'));
  try {
    const { path, bytes } = writePdfReport(project, charts, dir, { generatedAt: GENERATED });
    assert.equal(path, join(dir, 'clean.pdf'), 'writes <out>/<project>.pdf');
    assert.equal(readFileSync(path).length, bytes);
    assert.equal(bytes, exported.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
