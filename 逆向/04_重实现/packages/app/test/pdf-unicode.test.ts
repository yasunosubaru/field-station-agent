/**
 * `packages/app/src/pdf.ts` with a non-ASCII project — the embedded-TrueType path of the **Web**
 * writer, and the promise that nothing else moved.
 *
 * The graph package's writer got this first (`packages/graph/test/pdf-unicode.test.ts`); this one
 * checks the app's own layout (header/footer chrome, chart-summary cover) with the same face from
 * the same shared module (`packages/graph/src/pdf-font.ts`).
 *
 * Two halves, as before:
 *
 *  - **A pure-ASCII report must embed nothing.** The clean report is checked for the absence of a
 *    font file at all, and its *shape* — 8 pages, 13 charts, two cards per sheet, `Trajectory Plot`
 *    alone on page 2 — is checked against the original's own page map. (The old writer pinned a
 *    SHA-256 of the bytes; page-per-CSV gave that up: the document is now laid out like the
 *    original, so its bytes are expected to differ, and the layout is the thing worth asserting.)
 *  - **A report with Chinese text must carry that text.** `/FontFile2` + `/Identity-H` +
 *    `/CIDFontType2` + `/ToUnicode` + `/W`, and `pdftotext` must give the characters back.
 *
 * A third half is app-only: both header-bound values (`Content-Disposition`'s file name and
 * `X-PDF-Project`) are built from the project name, and an HTTP header value is ASCII-only — Node
 * throws `ERR_INVALID_CHAR` otherwise, which used to turn a Chinese project into a 500.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GRAPH_CSV_DIR } from '../src/graphcsv.ts';
import { buildGraphPdf, graphPdfFileName, graphPdfReport, type GraphPdfSource } from '../src/pdf.ts';
import { pdfCjkFontStatus, resetPdfFontCache } from '../../graph/src/pdf-font.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The clean report's shape, taken from the original `clean.pdf` (`pdftotext -layout`, page by
 * page): one information page, `Trajectory Plot` alone, then two charts per sheet — 8 pages, 13
 * charts for the 12 CSVs. Recorded here because the earlier pin was a SHA-256, and a layout that
 * copies the original cannot keep one.
 */
const PAGE_COUNT = 8;
const CHART_COUNT = 13;

const GENERATED = '2026/10/30 21:00:00';

const SOURCES: GraphPdfSource[] = readdirSync(GRAPH_CSV_DIR)
  .filter((name) => name.endsWith('.csv'))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(GRAPH_CSV_DIR, name), 'utf8') }));

/** The same CSVs with the two project comment fields replaced — nothing on disk is touched. */
const CJK_SOURCES: GraphPdfSource[] = SOURCES.map((source) => ({
  name: source.name,
  text: source.text
    .replace(/^\uFEFF?#Project Name: .*$/m, '#Project Name:          野外台站')
    .replace(/^#Project Directory: .*$/m, '#Project Directory:    C:\\测试\\项目'),
}));

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

/** Content streams only — they begin with `BT`; basemap tiles are JPEG and must not be searched. */
function streams(bytes: Uint8Array): string[] {
  return [...latin1(bytes).matchAll(/stream\n(BT [\s\S]*?)\nendstream/g)].map((match) => match[1]);
}

test('a pure-ASCII report embeds no font and keeps the original page map', () => {
  resetPdfFontCache();
  const bytes = buildGraphPdf(SOURCES, { generatedAt: GENERATED });
  const text = latin1(bytes);

  assert.ok(!text.includes('/FontFile2'), 'no embedded font file');
  assert.ok(!text.includes('/Identity-H'), 'no Identity-H encoding');
  assert.ok(!text.includes('/ToUnicode'), 'no ToUnicode CMap');
  assert.ok(!text.includes('/F3 '), 'no /F3 resource on any page');
  assert.ok(text.includes('/Resources << /Font << /F1 4 0 R /F2 5 0 R >> /ProcSet [/PDF /Text] >>'), 'page resources untouched');

  // The layout the original prints: 8 pages, two charts per sheet, the track alone on page 2.
  assert.equal((text.match(/\/Type \/Page\b/g) ?? []).length, PAGE_COUNT, `${PAGE_COUNT} pages`);
  assert.match(text, new RegExp(`/Count ${PAGE_COUNT} >>`), 'page tree agrees');
  const report = graphPdfReport(SOURCES, { generatedAt: GENERATED });
  assert.equal(report.pages, PAGE_COUNT);
  assert.equal(report.charts, CHART_COUNT, 'the Overview track plus one chart per CSV');
  assert.ok(text.includes('(13 charts - hand-written PDF 1.4'), 'the cover counts the charts');
  // The card titles live in the content streams as plain literals, page by page.
  const pages = [...text.matchAll(/stream\n(BT [\s\S]*?)\nendstream/g)].map((match) => match[1]);
  assert.equal(pages.length, PAGE_COUNT, 'one stream per page');
  assert.match(pages[1], /\(Trajectory Plot\)/, 'page 2 is the Overview track');
  // The CSVs here are in file-name order, so name no title: every sheet after page 2 holds two.
  assert.equal((pages[2].match(/\/F2 13 Tf/g) ?? []).length, 2, 'page 3 holds two chart cards');

  // The cover's Message Summary is the original's table — read from `DataSummary.json`, never guessed.
  for (const literal of ['(Message Summary)', '(Message Name)', '(Message Count)', '(BESTPOS)', '(RANGE)',
    '(HWMONITOR)', '(RXSTATUS)']) {
    assert.ok(pages[0].includes(literal), `cover prints ${literal}`);
  }
  assert.equal(pages[0].includes('PORTSTATS'), false, 'only the plotted messages are listed');

  // Page 2's basemap is embedded JPEG tiles, or the card says why there is none.
  if (report.basemap) {
    assert.ok(text.includes('/Filter /DCTDecode'), 'tiles are JPEG XObjects');
    assert.match(pages[1], /\/Im1 Do/, 'page 2 draws them under the track');
    assert.ok(pages[1].includes('Imagery \\251 Esri, Maxar, Earthstar Geographics'), 'with the attribution');
  } else {
    assert.ok(report.basemapNote.length > 0, 'a reason is recorded');
    assert.ok(pages[1].replace(/\\([()\\])/g, '$1').includes(report.basemapNote), 'and printed on the card');
    assert.equal(text.includes('/DCTDecode'), false, 'nothing embedded');
  }
});

test('the face being available does not change an ASCII document', () => {
  resetPdfFontCache();
  const withFace = buildGraphPdf(SOURCES, { generatedAt: GENERATED });
  resetPdfFontCache();
  const withoutFace = buildGraphPdf(SOURCES, { generatedAt: GENERATED, cjkFontPath: null });
  assert.ok(Buffer.from(withFace).equals(Buffer.from(withoutFace)), 'same bytes');
});

test('a non-ASCII run embeds one TrueType face: FontFile2, Identity-H, ToUnicode, W', () => {
  const status = pdfCjkFontStatus();
  if (!status.loaded) {
    // Recorded rather than hidden: the assertions below need a real face on this machine.
    console.log(`跳过字体断言：${status.path || '(none)'} — ${status.error}`);
    assert.ok(status.error.length > 0, 'a missing face explains itself');
    return;
  }

  const bytes = buildGraphPdf(CJK_SOURCES, { generatedAt: GENERATED });
  const text = latin1(bytes);

  assert.ok(text.includes('/Subtype /Type0'), 'a Type0 composite font');
  assert.ok(text.includes('/Subtype /CIDFontType2'), 'with a CIDFontType2 descendant');
  assert.ok(text.includes('/Encoding /Identity-H'), 'Identity-H: the codes are our own glyph ids');
  assert.ok(text.includes('/CIDToGIDMap /Identity'), 'cid == gid');
  assert.ok(text.includes('/FontFile2'), 'the face is embedded, not referenced');
  assert.ok(/\/W \[/.test(text), 'a width array, so right-aligned cells keep their place');
  assert.equal((text.match(/\/FontFile2/g) ?? []).length, 1, 'exactly one embedded face');
  assert.ok(/\/F3 \d+ 0 R/.test(text), 'the Type0 font is the /F3 resource');

  // The cover draws glyph ids in a hex string, never `?` placeholders.
  const cover = streams(bytes)[0];
  assert.ok(/\/F3 [\d.]+ Tf [^<]*<[0-9A-F]{8,}> Tj/.test(cover), 'the Chinese field is a hex glyph run on F3');
  assert.ok(!cover.includes('C:\\???\\???'), 'no placeholder text on the cover');

  // `/Title` in the information dictionary goes out as UTF-16BE with a BOM.
  assert.ok(/\/Title <FEFF[0-9A-F]+>/.test(text), 'the document title is UTF-16BE');

  assert.ok(bytes.length > 1_000_000, `embedded document is ${bytes.length} B (> 1 MB)`);
  assert.ok(bytes.length < 15_000_000, `embedded document is ${bytes.length} B (< 15 MB)`);

  resetPdfFontCache();
  const again = buildGraphPdf(CJK_SOURCES, { generatedAt: GENERATED });
  assert.ok(Buffer.from(again).equals(Buffer.from(bytes)), 'the embedded document is deterministic');
});

test('pdftotext recovers the Chinese path from the embedded face', (t) => {
  const status = pdfCjkFontStatus();
  if (!status.loaded) {
    t.skip(`no CJK face on this machine: ${status.error}`);
    return;
  }
  if (spawnSync('pdftotext', ['-v'], { encoding: 'utf8' }).error) {
    t.skip('pdftotext is not installed');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'app-pdf-cjk-'));
  try {
    const file = join(dir, 'cjk.pdf');
    writeFileSync(file, buildGraphPdf(CJK_SOURCES, { generatedAt: GENERATED }));

    const info = spawnSync('pdfinfo', [file], { encoding: 'utf8' });
    if (!info.error) {
      assert.equal(info.status, 0, `pdfinfo opens the document: ${info.stderr}`);
      assert.ok(new RegExp(`^Pages:\\s+${PAGE_COUNT}$`, 'm').test(info.stdout), 'one cover, the track, then two charts per sheet');
    }

    const result = spawnSync('pdftotext', ['-enc', 'UTF-8', '-f', '1', '-l', '1', file, '-'], { encoding: 'utf8' });
    assert.equal(result.status, 0, `pdftotext runs: ${result.stderr}`);
    const page = result.stdout;
    assert.ok(page.includes('野外台站'), 'the project name comes back');
    assert.ok(page.includes('C:\\测试\\项目'), 'and the directory');
    assert.ok(page.includes('Project Directory'), 'the ASCII label is still there');
    assert.ok(!page.includes('???'), 'nothing was left as `?`');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ASCII runs keep the base-14 faces even when the document embeds a font', () => {
  if (!pdfCjkFontStatus().loaded) return;
  const bytes = buildGraphPdf(CJK_SOURCES, { generatedAt: GENERATED });
  const all = streams(bytes).join('\n');
  // Chart titles are ASCII, so they stay literal strings on the base-14 faces …
  assert.ok(all.includes('(Height)') && all.includes('(Position Type)'), 'chart titles are still literals');
  // … while the project name is a glyph run.
  assert.ok(/\/F3 [\d.]+ Tf [^<]*<[0-9A-F]+> Tj/.test(all), 'and the Chinese name is a glyph run');
});

test('no usable face degrades to the old behaviour instead of throwing', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'app-pdf-fallback-'));
  try {
    for (const label of ['missing file', 'TrueType Collection']) {
      resetPdfFontCache();
      // A real `.ttc` starts with `ttcf`; parsing stops there, so the rest of the file is irrelevant.
      const path = label === 'missing file' ? join(scratch, 'definitely-not-a-font-2f5a.ttf') : join(scratch, 'fake.ttc');
      if (label !== 'missing file') writeFileSync(path, Buffer.from('ttcf00010000', 'latin1'));

      const bytes = buildGraphPdf(CJK_SOURCES, { generatedAt: GENERATED, cjkFontPath: path });
      const text = latin1(bytes);
      assert.ok(!text.includes('/FontFile2'), `${label}: nothing embedded`);
      assert.ok(!text.includes('/Identity-H'), `${label}: no Identity-H`);
      // The old behaviour: one `?` per non-ASCII character, so the shape of the text is still visible.
      // Backslashes are escaped inside a PDF literal string, hence the doubled `\\` in the bytes.
      assert.ok(text.includes('C:\\\\??\\\\??'), `${label}: the path degrades to ? placeholders`);
      assert.ok(text.includes('no usable CJK TrueType face found'), `${label}: the cover footer says so`);

      const again = buildGraphPdf(CJK_SOURCES, { generatedAt: GENERATED, cjkFontPath: path });
      assert.ok(Buffer.from(again).equals(Buffer.from(bytes)), `${label}: deterministic`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the download name and X-PDF-Project stay ASCII, so the route cannot 500', () => {
  // These two go straight into HTTP headers, and Node rejects a non-ASCII header value outright.
  const report = graphPdfReport(CJK_SOURCES, { generatedAt: GENERATED });
  assert.match(report.fileName, /^[\x20-\x7e]+$/, `file name is header-safe: ${report.fileName}`);
  assert.match(report.project, /^[\x20-\x7e]+$/, `project header is header-safe: ${report.project}`);
  assert.equal(report.fileName, '%E9%87%8E%E5%A4%96%E5%8F%B0%E7%AB%99.pdf', 'UTF-8 escaped, reversible');
  assert.equal(report.project, '%E9%87%8E%E5%A4%96%E5%8F%B0%E7%AB%99');

  // ASCII names are untouched, and the document itself still names the project.
  assert.equal(graphPdfFileName('clean'), 'clean.pdf');
  assert.equal(graphPdfFileName('a/b:c'), 'a_b_c.pdf');
  assert.ok(latin1(report.bytes).includes('<FEFF'), 'the PDF title keeps the real name, in UTF-16BE');

  // The panel reads `filename="…"`; a header value with a quote in it would break the match.
  assert.equal(report.fileName.includes('"'), false);
});
