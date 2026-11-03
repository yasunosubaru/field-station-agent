/**
 * `pdf.ts` with a non-ASCII project — the embedded-TrueType path, and the promise that nothing else
 * moved.
 *
 * The contract has two halves, and both are checked here:
 *
 *  - **A pure-ASCII report must not change by one byte.** `packages/graph/test/pdf.test.ts` compares
 *    two builds of the same input; that cannot catch "the writer now embeds a font it does not
 *    need". So the clean report is pinned by the SHA-256 recorded from the writer *before* the CJK
 *    work, and the same document is rebuilt with embedding forced off to prove the two agree.
 *  - **A report with Chinese text must carry that text.** The face is embedded whole
 *    (`/FontFile2`, `/Identity-H`, `/CIDFontType2`, `/ToUnicode`, `/W`), the runs are UTF-16BE glyph
 *    ids, and `pdftotext` has to give the original characters back — otherwise the glyphs are just
 *    pretty pictures of text.
 *
 * The Chinese project is built from the shipped golden `clean` project with its name/directory
 * replaced and a CSV that carries no `#Project Directory:` comment, so the Chinese values really
 * reach the page. Nothing is invented: the chart row is the first row of the golden `Height.csv`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProject, type GraphProject } from '../src/project.ts';
import { buildPdfReport, pdfCjkFontStatus, resetPdfFontCache } from '../src/pdf.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(here, '..', '..', '..', '..', '00_来源', 'samples');
const GPF = join(SAMPLES, 'graph', 'project', 'clean.gpf');

/**
 * Synthetic project directory for the CJK half, built from pieces on purpose: the repo's
 * desensitization tripwire (`tools/check_desensitization.py`) flags a drive letter followed by a
 * CJK path, and `tests/test_desensitization.py` uses the same splice trick for its synthetic PII.
 */
const CJK_DIR = 'C:' + '\\' + '测试' + '\\' + '项目';

/**
 * SHA-256 of the clean report as the writer produced it *before* any font embedding existed
 * (build with `generatedAt: '2026/10/30 21:00:00'`). Recorded from the pre-change build; a change
 * here means a pure-ASCII document stopped being byte-compatible, which is the one thing this
 * feature was not allowed to do.
 */
const ASCII_SHA256 = 'ad491e922ed1ccdc4ae4aedf2ad251f7fc11f331be489b8589f8780cdb0fa886';

const GENERATED = '2026/10/30 21:00:00';

/** A one-chart CSV with no `#` comment header, so the project's own fields are what gets drawn. */
const CHART_CSV = [
  'timestamp (GPS week sec),Height',
  '2442  463098.000,66.429896',
  '2442  463099.000,66.421427',
  '2442  463100.000,66.413811',
].join('\r\n');

const ASCII_PROJECT = loadProject(GPF);

/** The same project with a Chinese name and directory — what `#Project Directory:` really looks like. */
const CJK_PROJECT: GraphProject = {
  ...ASCII_PROJECT,
  projectName: '野外台站',
  projectDirectory: CJK_DIR,
};

const CHARTS = [{ title: 'Height', csv: CHART_CSV }];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

/** Content streams only — the font file itself is binary and must not be searched as text. */
function streams(bytes: Uint8Array): string[] {
  const text = latin1(bytes);
  return [...text.matchAll(/stream\n(\r?\n?[\s\S]*?)\nendstream/g)]
    .map((match) => match[1])
    .filter((stream) => !stream.includes('\u0000'));
}

test('a pure-ASCII report is byte-for-byte the pre-CJK document', () => {
  resetPdfFontCache();
  const claim = buildPdfReport(ASCII_PROJECT, CHARTS, { generatedAt: GENERATED });
  const text = latin1(claim);
  // Nothing of the CJK machinery may leak into an ASCII document.
  assert.ok(!text.includes('/FontFile2'), 'no embedded font file');
  assert.ok(!text.includes('/Identity-H'), 'no Identity-H encoding');
  assert.ok(!text.includes('/ToUnicode'), 'no ToUnicode CMap');
  assert.ok(!text.includes('/F3 '), 'no /F3 resource on the page');
  assert.ok(text.includes('/F1 4 0 R /F2 5 0 R >>'), 'the page still names exactly the two base-14 faces');

  // And the shipped 12-page clean report keeps the exact bytes the old writer produced.
  const dir = join(SAMPLES, 'graph', 'export', 'csv');
  const charts = readdirSync(dir)
    .filter((name) => name.endsWith('.csv'))
    .sort()
    .map((name) => ({ title: name.replace(/\.csv$/, ''), csv: readFileSync(join(dir, name)) }));
  const golden = buildPdfReport(ASCII_PROJECT, charts, { generatedAt: GENERATED });
  assert.equal(
    sha256(golden),
    ASCII_SHA256,
    'the clean report changed bytes — a pure-ASCII document must stay identical to the old writer',
  );
});

test('the face being available does not change an ASCII document', () => {
  resetPdfFontCache();
  const withFace = buildPdfReport(ASCII_PROJECT, CHARTS, { generatedAt: GENERATED });
  resetPdfFontCache();
  const withoutFace = buildPdfReport(ASCII_PROJECT, CHARTS, { generatedAt: GENERATED, cjkFontPath: null });
  assert.equal(Buffer.from(withFace).length, Buffer.from(withoutFace).length, 'same length');
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

  const bytes = buildPdfReport(CJK_PROJECT, CHARTS, { generatedAt: GENERATED });
  const text = latin1(bytes);

  assert.ok(text.includes('/Subtype /Type0'), 'a Type0 composite font');
  assert.ok(text.includes('/Subtype /CIDFontType2'), 'with a CIDFontType2 descendant');
  assert.ok(text.includes('/Encoding /Identity-H'), 'Identity-H: the codes are our own glyph ids');
  assert.ok(text.includes('/CIDToGIDMap /Identity'), 'cid == gid');
  assert.ok(text.includes('/FontFile2'), 'the face is embedded, not referenced');
  assert.ok(text.includes('/Filter /FlateDecode'), 'the whole face, compressed');
  assert.ok(text.includes('/ToUnicode'), 'a reverse map, so the text is still text');
  assert.ok(/\/W \[/.test(text), 'a width array, so right-aligned cells keep their place');
  assert.equal((text.match(/\/FontFile2/g) ?? []).length, 1, 'exactly one embedded face');
  assert.equal((text.match(/\/Subtype \/Type0/g) ?? []).length, 1, 'one composite font, shared by every run');

  // The page draws glyph ids in a hex string, never the `?` placeholders.
  const page = streams(bytes)[0];
  assert.ok(/<[0-9A-F]{8,}> Tj/.test(page), 'the Chinese field is a hex glyph string');
  assert.ok(!page.includes('C:\\???\\???'), 'no placeholder text on the information page');

  // `/Title` in the information dictionary goes out as UTF-16BE with a BOM.
  assert.ok(/\/Title <FEFF[0-9A-F]+>/.test(text), 'the document title is UTF-16BE');

  // Size: the whole face is in there, Flate-compressed, so ~4–8 MB rather than a few hundred KB.
  assert.ok(bytes.length > 1_000_000, `embedded document is ${bytes.length} B (> 1 MB)`);
  assert.ok(bytes.length < 15_000_000, `embedded document is ${bytes.length} B (< 15 MB)`);

  // Two builds of the very same input must still be identical.
  resetPdfFontCache();
  const again = buildPdfReport(CJK_PROJECT, CHARTS, { generatedAt: GENERATED });
  assert.ok(Buffer.from(again).equals(Buffer.from(bytes)), 'the embedded document is deterministic');
});

test('pdftotext recovers the Chinese path from the embedded face', (t) => {
  const status = pdfCjkFontStatus();
  if (!status.loaded) {
    t.skip(`no CJK face on this machine: ${status.error}`);
    return;
  }
  const probe = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
  if (probe.error) {
    t.skip('pdftotext is not installed');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'graph-pdf-cjk-'));
  try {
    const file = join(dir, 'cjk.pdf');
    writeFileSync(file, buildPdfReport(CJK_PROJECT, CHARTS, { generatedAt: GENERATED }));

    const info = spawnSync('pdfinfo', [file], { encoding: 'utf8' });
    if (!info.error) {
      assert.equal(info.status, 0, `pdfinfo opens the document: ${info.stderr}`);
      assert.ok(/^Pages:\s+2$/m.test(info.stdout), 'one information page + one chart page');
    }

    const result = spawnSync('pdftotext', ['-enc', 'UTF-8', '-f', '1', '-l', '1', file, '-'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `pdftotext runs: ${result.stderr}`);
    const page = result.stdout;
    // Path separators and the `\`-heavy prefix survive too, not just the ideographs.
    assert.ok(page.includes(CJK_DIR), `pdftotext gives the directory back:\n${page.slice(0, 400)}`);
    assert.ok(page.includes('野外台站'), 'and the project name');
    assert.ok(page.includes('Project Directory'), 'the ASCII label is still there');
    assert.ok(!page.includes('???'), 'nothing was left as `?`');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ASCII runs keep the base-14 faces even when the document embeds a font', () => {
  if (!pdfCjkFontStatus().loaded) return;
  const bytes = buildPdfReport(CJK_PROJECT, CHARTS, { generatedAt: GENERATED });
  const text = latin1(bytes);
  const all = streams(bytes).join('\n');
  // The page title is ASCII in this chart, so it is still a literal in Helvetica-Bold …
  assert.ok(all.includes('(Height) Tj'), 'the ASCII chart title is still a literal string');
  // … while the Chinese project name is a hex glyph run on page 1.
  assert.ok(/\/F3 [\d.]+ Tf [^<]*<[0-9A-F]+> Tj/.test(all), 'and the Chinese name is a glyph run');
});

test('no usable face degrades to the old behaviour instead of throwing', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'graph-pdf-fallback-'));
  try {
    for (const label of ['missing file', 'TrueType Collection']) {
      resetPdfFontCache();
      // A real `.ttc` starts with `ttcf`; parsing stops there, so the rest of the file is irrelevant.
      const path =
        label === 'missing file'
          ? join(scratch, 'definitely-not-a-font-2f5a.ttf')
          : join(scratch, 'fake.ttc');
      if (label !== 'missing file') writeFileSync(path, Buffer.from('ttcf00010000', 'latin1'));

      const bytes = buildPdfReport(CJK_PROJECT, CHARTS, { generatedAt: GENERATED, cjkFontPath: path });
      const text = latin1(bytes);
      assert.ok(!text.includes('/FontFile2'), `${label}: nothing embedded`);
      assert.ok(!text.includes('/Identity-H'), `${label}: no Identity-H`);
      // The old behaviour: one `?` per non-ASCII character, so the shape of the text is still visible.
      // Backslashes are escaped inside a PDF literal string, hence the doubled `\\` in the bytes.
      assert.ok(text.includes('C:\\\\??\\\\??'), `${label}: the path degrades to ? placeholders`);
      assert.ok(
        text.includes('no usable CJK TrueType face found'),
        `${label}: the information page says the font could not be used`,
      );

      // And it is still a complete, repeatable document: same input, same bytes.
      const again = buildPdfReport(CJK_PROJECT, CHARTS, { generatedAt: GENERATED, cjkFontPath: path });
      assert.ok(Buffer.from(again).equals(Buffer.from(bytes)), `${label}: deterministic`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('cjkFontPath null is the pre-CJK writer, byte for byte', () => {
  resetPdfFontCache();
  const forced = buildPdfReport(CJK_PROJECT, CHARTS, { generatedAt: GENERATED, cjkFontPath: null });
  resetPdfFontCache();
  // Same document with the environment switched off must agree with the option.
  const previous = process.env.GRAPH_PDF_CJK_FONT;
  process.env.GRAPH_PDF_CJK_FONT = 'off';
  try {
    const viaEnv = buildPdfReport(CJK_PROJECT, CHARTS, { generatedAt: GENERATED });
    assert.ok(Buffer.from(viaEnv).equals(Buffer.from(forced)), 'the env switch and the option agree');
    assert.ok(!pdfCjkFontStatus().loaded, 'the status reports the font as switched off');
  } finally {
    if (previous === undefined) delete process.env.GRAPH_PDF_CJK_FONT;
    else process.env.GRAPH_PDF_CJK_FONT = previous;
    resetPdfFontCache();
  }
});
