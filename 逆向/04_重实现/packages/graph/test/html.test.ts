/**
 * `buildHtmlReport` — the self-contained HTML report, checked on the **shipped golden CSVs**
 * (`00_来源/samples/graph/export/csv/`) rather than on freshly rendered data, so a CSV regression and
 * a report regression fail in different places.
 *
 * What is asserted is the acceptance list of `03_分析/06_Graph应用.md §12`:
 *  - one complete document, zero external references (no `http://` / `https://`, no `<script>`);
 *  - all 12 chart titles present, one `<article>` each;
 *  - every chart holds exactly one inline `<svg>`, whose polylines carry **one point per CSV row**;
 *  - the project info header repeats the CSV comment values (start / end / duration);
 *  - the document stays under 1.5 MB because only the first 20 rows are tabulated.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProject } from '../src/project.ts';
import { loadCapture } from '../src/capture.ts';
import { exportCsv } from '../src/csv.ts';
import { DEFAULT_TABLE_ROWS, buildHtmlReport, parseReportCsv } from '../src/html.ts';

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

/** Built once: rendering 12 charts (two of them 75 columns × 99 rows) is not free. */
let cached: string | null = null;
function report(): string {
  cached ??= buildHtmlReport(project, GOLDEN, { generatedAt: '2026/10/30 21:00:00' });
  return cached;
}

/** `{title, html}` of every `<article class="card">` in document order. */
function cards(html: string): { title: string; body: string }[] {
  return [...html.matchAll(/<article class="card"><h3>(.*?)<\/h3>([\s\S]*?)<\/article>/g)].map((match) => ({
    title: match[1],
    body: match[2],
  }));
}

function pointCount(points: string): number {
  const trimmed = points.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

test('report is one complete self-contained document', () => {
  const html = report();
  assert.ok(html.startsWith('<!DOCTYPE html>\n'), 'starts with the doctype');
  assert.ok(html.trimEnd().endsWith('</html>'), 'ends with </html>');
  assert.ok(html.includes('<html lang="zh-CN">') && html.includes('<meta charset="utf-8">'));
  // Offline: no scheme whatsoever (an inline SVG needs no xmlns, which is the usual http:// leak).
  assert.equal(html.match(/https?:\/\//gi), null, 'no http:// or https:// anywhere');
  assert.ok(!/<script/i.test(html), 'no <script>');
  assert.ok(!/<link\b/i.test(html), 'no external <link>');
  assert.ok(!/\b(?:src|href)=/.test(html), 'no src/href attributes at all');
  assert.ok(html.includes('<style>'), 'CSS is inlined');
});

test('all 12 golden CSVs are present and each becomes one chart section', () => {
  assert.equal(GOLDEN.length, 12);
  const html = report();
  const sections = cards(html);
  assert.equal(sections.length, 12, 'one <article> per chart');
  for (const { title } of GOLDEN) {
    assert.ok(html.includes(`<h3>${title}</h3>`), `chart title ${JSON.stringify(title)} is in the report`);
  }
  // The original's section headings, in its order.
  const headings = html.slice(html.indexOf('<h2>')).match(/<h2>(.*?)<\/h2>/g) ?? [];
  assert.deepEqual(headings, ['<h2>PVT</h2>', '<h2>Tracking &amp; Measurements</h2>', '<h2>Receiver Status</h2>']);
});

test('each chart has one inline SVG whose polylines have one point per CSV row', () => {
  const html = report();
  let svgTotal = 0;
  for (const card of cards(html)) {
    const golden = GOLDEN.find((entry) => entry.title === card.title);
    assert.ok(golden, `${card.title} has a source CSV`);
    const rows = parseReportCsv(golden.csv).rows;

    assert.equal(card.body.match(/<svg\b/g)?.length ?? 0, 1, `${card.title}: exactly one <svg>`);
    svgTotal += 1;

    const polylines = [...card.body.matchAll(/<polyline[^>]*\spoints="([^"]*)"/g)];
    assert.ok(polylines.length >= 1, `${card.title}: at least one polyline`);
    for (const [, points] of polylines) {
      assert.equal(pointCount(points), rows.length, `${card.title}: polyline point count == ${rows.length} CSV rows`);
    }
  }
  assert.equal(svgTotal, 12, '12 inline SVG charts');
});

test('the info header repeats the CSV comment lines (start / end / duration)', () => {
  const html = report();
  // Every golden CSV carries the same six comment lines; they must all agree with the report.
  for (const { csv } of GOLDEN) {
    const { meta } = parseReportCsv(csv);
    assert.deepEqual(Object.keys(meta), [
      'Project Name',
      'Project Directory',
      'Data File Name',
      'Start Time(GPS)',
      'End Time(GPS)',
      'Duration',
    ]);
    assert.equal(meta['Start Time(GPS)'], '2442,463097.350');
    assert.equal(meta['End Time(GPS)'], '2442,463102.300');
    assert.equal(meta['Duration'], '00:00:04');
    for (const [label, value] of [
      ['Project Name', meta['Project Name']],
      ['Project Directory', meta['Project Directory']],
      ['Data File Name', meta['Data File Name']],
      ['Start Time (GPS)', meta['Start Time(GPS)']],
      ['End Time (GPS)', meta['End Time(GPS)']],
      ['Duration', meta['Duration']],
    ]) {
      assert.ok(
        html.includes(`<span class="label">${label}</span><span class="value">${value}</span>`),
        `header row ${label} = ${value}`,
      );
    }
  }
  // Message summary: the four messages that feed the reported charts, with the project's counts.
  for (const [name, count] of [
    ['BESTPOS', '5'],
    ['RANGE', '100'],
    ['HWMONITOR', '1'],
    ['RXSTATUS', '4'],
  ]) {
    assert.ok(html.includes(`<span class="label">${name}</span><span class="value">${count}</span>`), `${name} ${count}`);
  }
});

test('only the first 20 rows are tabulated, so the file stays small', () => {
  const html = report();
  assert.ok(Buffer.byteLength(html, 'utf8') < 1.5 * 1024 * 1024, `size ${Buffer.byteLength(html, 'utf8')} B < 1.5 MB`);

  const tracking = cards(html).find((card) => card.title === 'Tracking Time');
  assert.ok(tracking, 'Tracking Time card');
  const rows = parseReportCsv(GOLDEN.find((entry) => entry.title === 'Tracking Time')!.csv).rows;
  assert.equal(rows.length, 99);
  const cells = (tracking!.body.match(/<td>/g) ?? []).length;
  assert.equal(cells, DEFAULT_TABLE_ROWS * 61, 'table holds 20 of the 99 rows × 61 columns');
  assert.equal(tracking!.body.match(/<tr>/g)?.length, 1 + DEFAULT_TABLE_ROWS);
  // A timestamp from row 21 is in the CSV but must not be in the HTML.
  assert.ok(!html.includes(parseReportCsv(GOLDEN.find((e) => e.title === 'Tracking Time')!.csv).rows[20][0]));
});

test('the report is built from the CSVs the exporter produces today', () => {
  const capture = loadCapture(CAPTURE);
  const charts = exportCsv(project, capture).map((result) => ({
    title: result.fileName.replace(/\.csv$/, ''),
    csv: result.buffer,
  }));
  const html = buildHtmlReport(project, charts, { generatedAt: 'fixed' });
  assert.equal(cards(html).length, 12);
  // Same bytes as the golden-sourced report apart from the timestamp.
  assert.equal(html, report().replace('2026/10/30 21:00:00', 'fixed'));
});

test('fixed generatedAt makes the output reproducible; tableRows is honoured', () => {
  const a = buildHtmlReport(project, GOLDEN.slice(0, 2), { generatedAt: 'fixed', title: 'T' });
  const b = buildHtmlReport(project, GOLDEN.slice(0, 2), { generatedAt: 'fixed', title: 'T' });
  assert.equal(a, b);
  assert.ok(a.includes('<title>T</title>'));
  assert.equal(cards(a).length, 2);

  const small = buildHtmlReport(project, GOLDEN, { generatedAt: 'fixed', tableRows: 3 });
  const height = cards(small).find((card) => card.title === 'Height')!;
  assert.equal(height.body.match(/<tr>/g)?.length, 1 + 3);
  assert.ok(small.length < report().length);
});

test('parseReportCsv keeps cells verbatim and separates the six comment lines', () => {
  const parsed = parseReportCsv(GOLDEN[0].csv);
  assert.equal(parsed.header.join(','), 'timestamp (GPS week sec),Latitude,Longitude');
  assert.equal(parsed.rows.length, 5);
  assert.equal(parsed.rows[0][1], '30.539975'); // six decimals, trailing zeros trimmed
  // Per-column decimals survive side by side (`1.19761` next to `2.639151`, `0.000000`).
  const sd = parseReportCsv(GOLDEN.find((entry) => entry.title === 'Position SD')!.csv);
  assert.deepEqual(sd.rows[0].slice(1), ['1.343599', '1.19761', '2.639151']);
  const stats = parseReportCsv(GOLDEN.find((entry) => entry.title === 'Solution Statistics')!.csv);
  assert.deepEqual(stats.rows[0].slice(1), ['0.000000', '0.000000', '23', '12']);
});
