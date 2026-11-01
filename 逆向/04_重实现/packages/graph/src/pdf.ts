/**
 * `ExportPDFReport` — a **hand-written PDF 1.4** report, one page per chart.
 *
 * The original Graph prints `clean.pdf` (348 419 B) through Chromium/Skia: same information as
 * `clean.html` (project information + one chart per page + a first-rows table), vectorised by the
 * browser. There is no PDF library to link against here — the npm registry is unreachable — so this
 * file writes the container itself: a 31-object table, an `xref` with exact byte offsets and a
 * `trailer`. Nothing is compressed, so every string in the document can be found by a plain text
 * search and the tests can check the offsets rather than trusting them.
 *
 * Layout (A4 landscape, 842 × 595 pt, the same page box Chromium used):
 *
 * ```
 * page 1   <project> Report
 *          Report Information   Generated Date / Charts / Pages
 *          Project Information  the six CSV comment fields (same spellings)
 *          Message Summary      message → count
 * page 2+  one chart page:  title / caption
 *                           legend (colour swatch + column + last value [+ "constant"])
 *                           plot: shared Y axis, 5 ticks, one `m`/`l`/`S` path per column
 *                           table: the first 20 CSV rows
 * ```
 *
 * Design decisions worth knowing:
 *
 *  - **Fonts**: an ASCII run is drawn with the base-14 `Helvetica` / `Helvetica-Bold`, referenced by
 *    name and not embedded (`/Encoding /WinAnsiEncoding`) — exactly as the first version of this
 *    file did, so a purely ASCII report is byte-for-byte what it always was. A run that contains
 *    anything outside ASCII is drawn with **one TrueType face embedded on demand** instead:
 *    `simhei.ttf` from the system font directory (override with `options.cjkFontPath` or
 *    `GRAPH_PDF_CJK_FONT`, disable with `null` / `off`). The face is parsed here — `head`,
 *    `hhea`, `maxp`, `hmtx`, `cmap` (format 4/12), `OS/2`, `name` — embedded whole as
 *    `/FontFile2` (Flate-compressed, **no subsetting**, so the file grows by ~5 MB), and exposed
 *    as `Type0` + `CIDFontType2` with `/Identity-H`, `/CIDToGIDMap /Identity`, a `/W` width array
 *    and a `ToUnicode` CMap. Such a run is written as UTF-16BE **glyph ids** in a hex string and
 *    measured with the TTF's own advances, so right-aligned cells still line up. SimHei has a
 *    single weight: bold runs fall back to it rather than faking a bold face. The two families
 *    are mixed per string, so `H:\Archive\中文\b1` keeps Helvetica for the ASCII parts.
 *  - **Degradation**: with no usable face (file missing, unparseable, a `.ttc` collection) nothing
 *    is embedded and non-ASCII characters become `?` exactly as before. The information page's
 *    footer then says so, and {@link pdfCjkFontStatus} reports the reason.
 *  - **One shared Y axis per page**, as asked for this report: min/max over the columns first, then
 *    one projection. A column whose values are all equal cannot be scaled, so it is drawn as a
 *    horizontal line at its own value and its legend entry says `constant` — nothing disappears
 *    silently the way a shared axis would make it.
 *  - **The table is truncated by columns, never by rows**: `Tracking Time` has 61 columns and
 *    `GNSS Signal Strength` 75, which cannot fit 762 pt at a readable size. Column 0 (the timestamp)
 *    plus as many whole columns as fit are printed, and the caption states `showing X of Y columns`.
 *  - Coordinates and labels are rounded with `toFixed`, the object table is built in a fixed order
 *    and the only clock is `options.generatedAt`, so the same input gives the same bytes.
 *
 * What this is *not*: a pixel copy of `clean.pdf`. The rasterised map, Chromium's font subsets and
 * its own object ordering are gone; the structure (information page, then one page per chart) and
 * the extracted text are what we reproduce. `03_分析/06_Graph应用.md §13` records that difference.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import type { GraphProject } from './project.ts';
import { chartMessages } from './project.ts';
import { formatDuration, formatGpsCommentTime } from './format.ts';
import { parseReportCsv, type ParsedReportCsv } from './html.ts';

/** One chart's CSV, exactly the shape `buildHtmlReport` takes. */
export interface PdfChartSource {
  /** Chart title — also the CSV file name without `.csv`. */
  title: string;
  /** CSV bytes or already-decoded text. */
  csv: string | Uint8Array;
}

export interface PdfReportOptions {
  /** Data rows tabulated under each chart (default {@link PDF_TABLE_ROWS}). */
  tableRows?: number;
  /**
   * *Generated Date* value, and the source of the document `CreationDate`. Fixed value ⇒ reproducible
   * bytes; the default is the current local time, spelled the original's way.
   */
  generatedAt?: string;
  /** Keep only these chart titles (Graph's `selectedPlots`). */
  selectedPlots?: string[];
  /** Document heading; default `<projectName> Report`. */
  title?: string;
  /**
   * TrueType face used for runs that contain non-ASCII text (see the file header).
   *
   * `undefined` → `GRAPH_PDF_CJK_FONT`, else `%WINDIR%\Fonts\simhei.ttf` and a few fallbacks;
   * a path → that file only; `null` → never embed (forced old behaviour: non-ASCII becomes `?`).
   * Only whole `.ttf` files are understood — a `.ttc` collection degrades like a missing file.
   */
  cjkFontPath?: string | null;
}

/** Rows of the per-chart data table. The CSV itself is never embedded in full. */
export const PDF_TABLE_ROWS = 20;

/**
 * Points drawn per series. `GNSS Signal Strength` on a full-day capture is hundreds of thousands of
 * rows; a vector path that long is both unreadable and megabytes of content stream, so beyond this
 * count every n-th row is drawn (the last row always included) and the caption says so.
 */
export const PDF_MAX_POINTS = 1200;

/** A4 landscape, in points — the page box `clean.pdf` was printed at. */
export const PDF_PAGE = { width: 842, height: 595 } as const;

/** Series colours (the same palette `html.ts` uses, as 0–1 RGB for the content stream). */
const PALETTE: [number, number, number][] = [
  [0.122, 0.467, 0.706],
  [0.839, 0.153, 0.157],
  [0.173, 0.627, 0.173],
  [0.58, 0.404, 0.741],
  [1, 0.498, 0.055],
  [0.549, 0.337, 0.294],
  [0.89, 0.467, 0.761],
  [0.09, 0.745, 0.812],
  [0.737, 0.741, 0.133],
  [0.498, 0.498, 0.498],
];

const INK = [0.12, 0.13, 0.15] as const;
const MUTED = [0.42, 0.46, 0.5] as const;
const GRID = [0.9, 0.91, 0.93] as const;
const AXIS = [0.6, 0.64, 0.69] as const;
const RULE = [0.0, 0.32, 0.44] as const;

const MARGIN = 40;
const CONTENT_WIDTH = PDF_PAGE.width - 2 * MARGIN;
const TABLE_SIZE = 6.4;
const TABLE_ROW = 9.2;
const TABLE_HEAD = 11;
const LEGEND_SIZE = 7;

/* ------------------------------------------------------------------------------------------------
 * Text metrics — Helvetica AFM advance widths (1/1000 em) for ASCII, and the embedded face's own
 * `hmtx` advances for everything else, so right-aligned table cells and legend wrapping land where
 * they should whether or not a font file is available.
 * ---------------------------------------------------------------------------------------------- */

const HELVETICA_WIDTHS = new Map<number, number>([
  [32, 278], [33, 278], [34, 355], [35, 556], [36, 556], [37, 889], [38, 667], [39, 191],
  [40, 333], [41, 333], [42, 389], [43, 584], [44, 278], [45, 333], [46, 278], [47, 278],
  [48, 556], [49, 556], [50, 556], [51, 556], [52, 556], [53, 556], [54, 556], [55, 556],
  [56, 556], [57, 556], [58, 278], [59, 278], [60, 584], [61, 584], [62, 584], [63, 556],
  [64, 1015], [65, 667], [66, 667], [67, 722], [68, 722], [69, 667], [70, 611], [71, 778],
  [72, 722], [73, 278], [74, 500], [75, 667], [76, 556], [77, 833], [78, 722], [79, 778],
  [80, 667], [81, 778], [82, 722], [83, 667], [84, 611], [85, 722], [86, 667], [87, 944],
  [88, 667], [89, 667], [90, 611], [91, 278], [92, 278], [93, 278], [94, 469], [95, 556],
  [96, 333], [97, 556], [98, 556], [99, 500], [100, 556], [101, 556], [102, 278], [103, 556],
  [104, 556], [105, 222], [106, 222], [107, 500], [108, 222], [109, 833], [110, 556], [111, 556],
  [112, 556], [113, 556], [114, 333], [115, 500], [116, 278], [117, 556], [118, 500], [119, 722],
  [120, 500], [121, 500], [122, 500], [123, 334], [124, 260], [125, 334], [126, 584],
]);

/**
 * True when a run needs the embedded face: anything outside 7-bit ASCII (control characters stay
 * on the old path, where they were already written as `?`).
 */
function hasNonAscii(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7f) return true;
  }
  return false;
}

/** Rendered width of `text` in points at `size`, with the same face `text()` will use. */
function textWidth(text: string, size: number): number {
  if (activeFace && hasNonAscii(text)) {
    let units = 0;
    for (const char of text) {
      const code = char.codePointAt(0) ?? 63;
      // Control characters are drawn as a space glyph (see `encodeGlyphs`).
      units += glyphAdvance(activeFace, code < 32 ? 32 : code);
    }
    return (units / activeFace.unitsPerEm) * size;
  }
  let units = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    units += HELVETICA_WIDTHS.get(code) ?? (code < 32 || code > 126 ? 556 : 556);
  }
  return (units / 1000) * size;
}

/**
 * Cut `text` so it fits `width`, ending in `...` when anything was dropped.
 *
 * Iterates by code point, not by UTF-16 unit: slicing a surrogate pair in half would put a lone
 * half in the file, which the embedded-face path would then draw as `.notdef`.
 */
function fitText(text: string, width: number, size: number): string {
  if (textWidth(text, size) <= width) return text;
  const points = [...text];
  let cut = points;
  while (cut.length > 1 && textWidth(`${cut.join('')}...`, size) > width) cut = cut.slice(0, -1);
  return `${cut.join('')}...`;
}

/* ------------------------------------------------------------------------------------------------
 * Embedded TrueType face (CJK) — parsed here, embedded whole, used only when the text needs it
 * ---------------------------------------------------------------------------------------------- */

/**
 * A parsed TrueType face, reduced to what a PDF `CIDFontType2` needs. Only the tables the PDF font
 * dictionary and the layout have to agree on are kept: no `glyf`/`loca` walk, no subsetting.
 */
interface TrueTypeFace {
  path: string;
  bytes: Uint8Array;
  /** PostScript name for `/BaseFont`, from `name` id 6 (fallback: the file name). */
  name: string;
  unitsPerEm: number;
  /** `head` bounding box, in font units. */
  bbox: [number, number, number, number];
  ascender: number;
  descender: number;
  capHeight: number;
  numGlyphs: number;
  /** Advance width in font units, indexed by glyph id (`hmtx`, last entry repeated). */
  advances: Uint16Array;
  /** Unicode code point → glyph id, from the best `cmap` subtable (format 12 or 4). */
  cmap: Map<number, number>;
  /** `OS/2` `fsType`; 8 is "editable embedding", 0 is installable. Recorded, not enforced. */
  fsType: number;
}

/** The face in use for one build, or `null` when non-ASCII text has to degrade to `?`. */
let activeFace: TrueTypeFace | null = null;
/** Glyph id → code point, collected while the content streams are written (`ToUnicode`). */
let usedGlyphs = new Map<number, number>();
/** True when at least one run was drawn with the embedded face. */
let usedEmbeddedFace = false;
/** True when a non-ASCII run had to be written as `?` because no face was available. */
let degradedText = false;
/** True when some code point had no glyph in the face (drawn as `.notdef`). */
let missingGlyph = false;

function be16(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function be16s(bytes: Uint8Array, at: number): number {
  const value = be16(bytes, at);
  return value & 0x8000 ? value - 0x10000 : value;
}

function be32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function tagAt(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

interface TrueTypeTable {
  offset: number;
  length: number;
}

/** The table directory, or a thrown `Error` describing why the file is not a usable `.ttf`. */
function readTableDirectory(bytes: Uint8Array): Map<string, TrueTypeTable> {
  if (bytes.length < 12) throw new Error('文件只有 ' + bytes.length + ' B，不是 TrueType');
  const version = tagAt(bytes, 0);
  if (version === 'ttcf') throw new Error('TrueType Collection (.ttc) 不支持，请指定单体 .ttf');
  if (version === 'OTTO') throw new Error('CFF 轮廓 (OTTO) 需要 FontFile3，这里只支持 glyf 轮廓');
  if (be32(bytes, 0) !== 0x00010000 && version !== 'true') {
    throw new Error(`未知的 sfnt 版本 ${JSON.stringify(version)}`);
  }
  const count = be16(bytes, 4);
  const tables = new Map<string, TrueTypeTable>();
  for (let index = 0; index < count; index++) {
    const at = 12 + index * 16;
    if (at + 16 > bytes.length) throw new Error('表目录被截断');
    tables.set(tagAt(bytes, at), { offset: be32(bytes, at + 8), length: be32(bytes, at + 12) });
  }
  return tables;
}

/** Decode a `name` record: Windows records are UTF-16BE, Macintosh ones are single-byte. */
function decodeNameRecord(bytes: Uint8Array, platform: number, at: number, length: number): string {
  let out = '';
  if (platform === 3 || platform === 0) {
    for (let index = 0; index + 1 < length; index += 2) out += String.fromCharCode(be16(bytes, at + index));
  } else {
    for (let index = 0; index < length; index++) out += String.fromCharCode(bytes[at + index]);
  }
  return out;
}

/** PostScript name (`name` id 6), preferring the Windows/Unicode record; `null` when absent. */
function readPostScriptName(bytes: Uint8Array, table: TrueTypeTable): string | null {
  const base = table.offset;
  const count = be16(bytes, base + 2);
  const strings = base + be16(bytes, base + 4);
  let fallback: string | null = null;
  for (let index = 0; index < count; index++) {
    const at = base + 6 + index * 12;
    if (at + 12 > bytes.length) break;
    const platform = be16(bytes, at);
    const encoding = be16(bytes, at + 2);
    const language = be16(bytes, at + 4);
    const nameId = be16(bytes, at + 6);
    if (nameId !== 6) continue;
    const length = be16(bytes, at + 8);
    const value = decodeNameRecord(bytes, platform, strings + be16(bytes, at + 10), length);
    if (platform === 3 && encoding === 1 && language === 0x0409) return value;
    fallback ??= value;
  }
  return fallback;
}

/** The best `cmap` subtable (format 12 preferred: it reaches beyond the BMP), as code point → gid. */
function readCmap(bytes: Uint8Array, table: TrueTypeTable): Map<number, number> {
  const base = table.offset;
  const count = be16(bytes, base + 2);
  interface Subtable {
    platform: number;
    encoding: number;
    offset: number;
    format: number;
    score: number;
  }
  const subtables: Subtable[] = [];
  for (let index = 0; index < count; index++) {
    const at = base + 4 + index * 8;
    const offset = base + be32(bytes, at + 4);
    const platform = be16(bytes, at);
    const encoding = be16(bytes, at + 2);
    const format = be16(bytes, offset);
    const full = platform === 3 && encoding === 10;
    const unicode = platform === 0;
    const windowsBmp = platform === 3 && encoding === 1;
    const score =
      format === 12 && full ? 60 : format === 12 && unicode ? 50 : format === 4 && windowsBmp ? 40 : format === 4 && unicode ? 30 : format === 12 ? 20 : format === 4 ? 10 : 0;
    if (score > 0) subtables.push({ platform, encoding, offset, format, score });
  }
  subtables.sort((a, b) => b.score - a.score || a.offset - b.offset);
  const cmap = new Map<number, number>();

  for (const subtable of subtables) {
    const at = subtable.offset;
    if (subtable.format === 12) {
      const groups = be32(bytes, at + 12);
      for (let group = 0; group < groups; group++) {
        const record = at + 16 + group * 12;
        if (record + 12 > bytes.length) break;
        const start = be32(bytes, record);
        const end = be32(bytes, record + 4);
        const startGlyph = be32(bytes, record + 8);
        if (end < start || end - start > 0x20000) continue;
        for (let code = start; code <= end; code++) {
          const glyph = startGlyph + (code - start);
          if (glyph !== 0) cmap.set(code, glyph);
        }
      }
    } else if (subtable.format === 4) {
      const segments = be16(bytes, at + 6) / 2;
      const endAt = at + 14;
      const startAt = endAt + segments * 2 + 2;
      const deltaAt = startAt + segments * 2;
      const rangeAt = deltaAt + segments * 2;
      for (let segment = 0; segment < segments; segment++) {
        const end = be16(bytes, endAt + segment * 2);
        const start = be16(bytes, startAt + segment * 2);
        const delta = be16s(bytes, deltaAt + segment * 2);
        const rangeOffset = be16(bytes, rangeAt + segment * 2);
        if (start === 0xffff && end === 0xffff) continue;
        for (let code = start; code <= end && code !== 0xffff; code++) {
          let glyph: number;
          if (rangeOffset === 0) {
            glyph = (code + delta) & 0xffff;
          } else {
            // `idRangeOffset` counts bytes from the entry itself, not from the table start.
            const cell = rangeAt + segment * 2 + rangeOffset + (code - start) * 2;
            if (cell + 2 > bytes.length) continue;
            glyph = be16(bytes, cell);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) cmap.set(code, glyph);
        }
      }
    }
    if (cmap.size > 0) return cmap; // the best-scoring subtable that yielded anything wins
  }
  if (cmap.size === 0) throw new Error('cmap 里没有可用的 format 4 / 12 子表');
  return cmap;
}

/** Parse a whole `.ttf`. Throws with a human-readable reason; the caller degrades. */
function parseTrueType(bytes: Uint8Array, path: string): TrueTypeFace {
  const tables = readTableDirectory(bytes);
  for (const required of ['head', 'hhea', 'maxp', 'hmtx', 'cmap']) {
    if (!tables.has(required)) throw new Error(`缺少 ${required} 表`);
  }
  const head = tables.get('head')!;
  const hhea = tables.get('hhea')!;
  const maxp = tables.get('maxp')!;
  const hmtx = tables.get('hmtx')!;

  const unitsPerEm = be16(bytes, head.offset + 18);
  if (unitsPerEm === 0) throw new Error('head.unitsPerEm = 0');
  const numGlyphs = be16(bytes, maxp.offset + 4);
  if (numGlyphs === 0) throw new Error('maxp.numGlyphs = 0');
  const metrics = be16(bytes, hhea.offset + 34);
  if (metrics === 0 || metrics > numGlyphs) throw new Error(`hhea.numberOfHMetrics = ${metrics} 不合理`);

  const advances = new Uint16Array(numGlyphs);
  let last = 0;
  for (let glyph = 0; glyph < numGlyphs; glyph++) {
    if (glyph < metrics && hmtx.offset + glyph * 4 + 2 <= bytes.length) {
      last = be16(bytes, hmtx.offset + glyph * 4);
    }
    advances[glyph] = last;
  }

  let ascender = be16s(bytes, hhea.offset + 4);
  let descender = be16s(bytes, hhea.offset + 6);
  let capHeight = Math.round(ascender * 0.7);
  let fsType = 0;
  const os2 = tables.get('OS/2');
  if (os2) {
    fsType = be16(bytes, os2.offset + 8);
    const typoAscender = be16s(bytes, os2.offset + 68);
    const typoDescender = be16s(bytes, os2.offset + 70);
    if (typoAscender > 0) ascender = typoAscender;
    if (typoDescender < 0) descender = typoDescender;
    const version = be16(bytes, os2.offset);
    if (version >= 2 && os2.offset + 90 <= bytes.length) {
      const cap = be16s(bytes, os2.offset + 88);
      if (cap > 0) capHeight = cap;
    }
  }

  const nameTable = tables.get('name');
  const postScriptName = nameTable ? readPostScriptName(bytes, nameTable) : null;

  return {
    path,
    bytes,
    name: sanitizeFontName(postScriptName) ?? sanitizeFontName(path.replace(/^.*[\\/]/, '').replace(/\.ttf$/i, '')) ?? 'EmbeddedCJK',
    unitsPerEm,
    bbox: [be16s(bytes, head.offset + 36), be16s(bytes, head.offset + 38), be16s(bytes, head.offset + 40), be16s(bytes, head.offset + 42)],
    ascender,
    descender,
    capHeight,
    numGlyphs,
    advances,
    cmap: readCmap(bytes, tables.get('cmap')!),
    fsType,
  };
}

/** A PDF name may not contain delimiters, whitespace or `#`; drop anything that does. */
function sanitizeFontName(name: string | null): string | null {
  if (!name) return null;
  const cleaned = name.replace(/[^A-Za-z0-9._+-]/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

/** `hmtx` advance of a code point, in font units (missing → `.notdef`). */
function glyphAdvance(face: TrueTypeFace, codePoint: number): number {
  const glyph = face.cmap.get(codePoint) ?? 0;
  return face.advances[glyph] ?? face.advances[0] ?? 0;
}

const faceCache = new Map<string, { face: TrueTypeFace | null; error: string }>();

/** Load and parse one face, cached. A failure is cached too — a broken path is not retried. */
function loadFace(path: string): { face: TrueTypeFace | null; error: string } {
  const cached = faceCache.get(path);
  if (cached) return cached;
  let entry: { face: TrueTypeFace | null; error: string };
  try {
    entry = { face: parseTrueType(readFileSync(path), path), error: '' };
  } catch (error) {
    entry = { face: null, error: (error as Error).message };
  }
  faceCache.set(path, entry);
  return entry;
}

/** Where a CJK face is looked for when neither the option nor the environment names one. */
function defaultFaceCandidates(): string[] {
  const windows = process.env.WINDIR ?? process.env.SystemRoot;
  const candidates: string[] = [];
  if (windows) candidates.push(join(windows, 'Fonts', 'simhei.ttf'), join(windows, 'Fonts', 'Deng.ttf'));
  // Non-Windows checkouts (CI, WSL) get the usual single-file CJK faces. `.ttc` collections are
  // deliberately absent: they need a collection header this parser does not read, so naming one
  // would only turn "not found" into "found but unusable" for no gain.
  candidates.push(
    '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
    '/usr/share/fonts/truetype/arphic/uming.ttf',
  );
  return candidates;
}

/** Resolve the face one build should use; `null` means "stay ASCII-only". */
function resolveFace(options: PdfReportOptions): TrueTypeFace | null {
  if (options.cjkFontPath === null) return null;
  let path: string | null = options.cjkFontPath ?? null;
  if (!path) {
    const env = process.env.GRAPH_PDF_CJK_FONT;
    if (env === 'off' || env === 'none' || env === '0') return null;
    if (env) path = env;
  }
  if (!path) {
    const candidates = defaultFaceCandidates();
    path = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? null;
  }
  if (!path) return null;
  return loadFace(path).face;
}

/** Reset the per-build text state. Called by `buildPdfReport`; exported for the tests. */
export function resetPdfFontCache(): void {
  faceCache.clear();
  activeFace = null;
  usedGlyphs = new Map();
  usedEmbeddedFace = false;
  degradedText = false;
  missingGlyph = false;
}

export interface PdfCjkFontStatus {
  /** The path that would be used (the first candidate when none exists). */
  path: string;
  /** True when the file parsed and non-ASCII runs will be embedded. */
  loaded: boolean;
  /** Why not, when `loaded` is false. */
  error: string;
  /** PostScript name of the loaded face, for the report. */
  name: string;
  /** Bytes of the font file — the size a report grows by (before Flate, which is roughly half). */
  bytes: number;
}

/**
 * What the PDF writer would embed for non-ASCII text right now: the resolved path, whether it
 * parsed, and why not. `GRAPH_PDF_CJK_FONT=off` makes this report a disabled font.
 */
export function pdfCjkFontStatus(): PdfCjkFontStatus {
  const env = process.env.GRAPH_PDF_CJK_FONT;
  if (env === 'off' || env === 'none' || env === '0') {
    return { path: '', loaded: false, error: 'GRAPH_PDF_CJK_FONT 已关闭嵌入', name: '', bytes: 0 };
  }
  const candidates = defaultFaceCandidates();
  const path = env || candidates.find((candidate) => existsSync(candidate)) || candidates[0] || '';
  if (!path) return { path: '', loaded: false, error: '没有候选字体', name: '', bytes: 0 };
  const { face, error } = loadFace(path);
  return face
    ? { path, loaded: true, error: '', name: face.name, bytes: face.bytes.length }
    : { path, loaded: false, error, name: '', bytes: 0 };
}

/* ------------------------------------------------------------------------------------------------
 * Content stream primitives
 * ---------------------------------------------------------------------------------------------- */

/**
 * A PDF literal string. Everything outside printable ASCII becomes `?`: the base-14 faces are not
 * embedded and are used with `/WinAnsiEncoding`, so a CJK path could not be drawn with them — and
 * a run like that is routed to the embedded face instead (see `text`), so `?` here only happens in
 * the degraded case.
 */
function pdfString(text: string): string {
  let out = '(';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    if (code === 0x28) out += '\\(';
    else if (code === 0x29) out += '\\)';
    else if (code === 0x5c) out += '\\\\';
    else if (code < 32 || code > 126) out += '?';
    else out += String.fromCharCode(code);
  }
  return `${out})`;
}

/**
 * A text string for the document information dictionary: a plain literal while the text is ASCII
 * (so a pure-ASCII document keeps its old bytes), otherwise UTF-16BE with a `FEFF` byte order mark,
 * which every reader understands regardless of fonts or `/Encoding`.
 */
function pdfTextString(text: string): string {
  if (!hasNonAscii(text)) return pdfString(text);
  let hex = 'FEFF';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0x3f;
    hex += code <= 0xffff ? hex4(code) : utf16beHex(code);
  }
  return `<${hex}>`;
}

/** Four uppercase hex digits (`0041`), the unit of an `Identity-H` code and a `ToUnicode` target. */
function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/** UTF-16BE hex for a code point, surrogate pair included (`D83DDE00` for a non-BMP emoji). */
function utf16beHex(code: number): string {
  if (code <= 0xffff) return hex4(code);
  const value = code - 0x10000;
  return hex4(0xd800 + (value >> 10)) + hex4(0xdc00 + (value & 0x3ff));
}

/**
 * A run of glyph ids for `/F3`: two bytes each, as uppercase hex. The glyphs used are collected so
 * the `ToUnicode` CMap of this document can be minimal; `.notdef` is recorded as such.
 */
function encodeGlyphs(value: string, face: TrueTypeFace): string {
  usedEmbeddedFace = true;
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0x3f;
    const glyph = face.cmap.get(code < 32 ? 32 : code) ?? 0;
    if (glyph === 0) missingGlyph = true;
    else if (!usedGlyphs.has(glyph)) usedGlyphs.set(glyph, code < 32 ? 32 : code);
    out += hex4(glyph);
  }
  return out;
}

/** `0.122 0.467 0.706` — a colour operator body. */
function rgb(colour: readonly [number, number, number]): string {
  return colour.map((value) => round(value, 3).toString()).join(' ');
}

/** Fixed-point number with at most `digits` decimals and no trailing zeros (`40`, `2442.5`). */
function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function moveTo(x: number, y: number): string {
  return `${round(x)} ${round(y)} m`;
}

function lineTo(x: number, y: number): string {
  return `${round(x)} ${round(y)} l`;
}

function rect(x: number, y: number, width: number, height: number, fill: readonly [number, number, number]): string {
  return `${rgb(fill)} rg ${round(x)} ${round(y)} ${round(width)} ${round(height)} re f`;
}

function stroke(colour: readonly [number, number, number], width: number): string {
  return `${rgb(colour)} RG ${round(width, 2)} w`;
}

function rule(x1: number, y1: number, x2: number, y2: number, colour: readonly [number, number, number], width = 0.5): string {
  return `${stroke(colour, width)} ${moveTo(x1, y1)} ${lineTo(x2, y2)} S`;
}

type FontName = 'F1' | 'F2';
type Align = 'start' | 'middle' | 'end';

/**
 * One text run, absolutely positioned (`Tm`), so no graphics state leaks between runs.
 *
 * The face is chosen per string: pure ASCII keeps the requested base-14 face (`F1` regular, `F2`
 * bold) and is written exactly as before; a string containing anything outside ASCII is drawn with
 * the embedded `F3` face as glyph ids, and bold falls back to the same face (SimHei has one weight).
 */
function text(
  value: string,
  x: number,
  y: number,
  size: number,
  font: FontName = 'F1',
  colour: readonly [number, number, number] = INK,
  align: Align = 'start',
): string {
  const width = textWidth(value, size);
  const left = align === 'start' ? x : align === 'end' ? x - width : x - width / 2;
  // `/F1 9.5 Tf … Tm <text> Tj` — the operator order is fixed, and identical to the pre-CJK writer,
  // because a pure-ASCII document has to keep its exact bytes.
  const body = `${rgb(colour)} rg 1 0 0 1 ${round(left)} ${round(y)} Tm`;
  if (hasNonAscii(value)) {
    if (activeFace) {
      return `BT /F3 ${round(size, 2)} Tf ${body} <${encodeGlyphs(value, activeFace)}> Tj ET`;
    }
    // No usable face: the old behaviour, a visible `?` per non-ASCII character.
    degradedText = true;
  }
  return `BT /${font} ${round(size, 2)} Tf ${body} ${pdfString(value)} Tj ET`;
}

/** `1.19761` stays `1.19761`; axis ticks share the precision the tick step calls for. */
function axisLabel(value: number, step: number): string {
  if (!Number.isFinite(value)) return '';
  const magnitude = Math.abs(step);
  const decimals = magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : magnitude >= 0.1 ? 3 : 4;
  if (Math.abs(value) >= 1e7 || (value !== 0 && Math.abs(value) < 1e-4)) return value.toExponential(2);
  return value.toFixed(decimals);
}

function localTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

/* ------------------------------------------------------------------------------------------------
 * Chart data → series
 * ---------------------------------------------------------------------------------------------- */

interface Series {
  name: string;
  values: number[];
  /** Set when the column is not numeric: ordinals back to their names (`Position Status`). */
  categories?: string[];
  /** Last cell exactly as the CSV prints it. */
  last: string;
}

function seriesOf(header: string[], rows: string[][], column: number): Series {
  const cells = rows.map((row) => row[column] ?? '');
  const numeric = cells.length > 0 && cells.every((cell) => cell !== '' && Number.isFinite(Number(cell)));
  if (numeric) {
    return { name: header[column] ?? '', values: cells.map(Number), last: cells[cells.length - 1] ?? '' };
  }
  const categories: string[] = [];
  const values = cells.map((cell) => {
    let index = categories.indexOf(cell);
    if (index === -1) index = categories.push(cell) - 1;
    return index;
  });
  return { name: header[column] ?? '', values, categories, last: cells[cells.length - 1] ?? '' };
}

function isConstant(series: Series): boolean {
  return series.values.length > 0 && series.values.every((value) => value === series.values[0]);
}

/* ------------------------------------------------------------------------------------------------
 * Page layout
 * ---------------------------------------------------------------------------------------------- */

interface PageGeometry {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Legend above the plot, wrapped to the content width. Returns the stream lines and the `y` the plot
 * may start below. Items past `maxLines` are dropped with an `+N more` marker rather than overflowing.
 */
function legend(lines: string[], series: Series[], top: number): { lines: string[]; bottom: number } {
  const maxLines = 8;
  const lineHeight = 9;
  let x = MARGIN;
  let y = top;
  let row = 0;
  let shown = 0;

  for (let index = 0; index < series.length; index++) {
    const entry = series[index];
    const label = isConstant(entry) ? `${entry.name} = ${entry.last} (constant)` : `${entry.name} ${entry.last}`;
    const labelText = fitText(label, CONTENT_WIDTH * 0.45, LEGEND_SIZE);
    const itemWidth = 7 + 3 + textWidth(labelText, LEGEND_SIZE) + 14;
    if (row >= maxLines) break;
    if (x + itemWidth > PDF_PAGE.width - MARGIN && x > MARGIN) {
      row += 1;
      if (row >= maxLines) break;
      x = MARGIN;
      y -= lineHeight;
    }
    const colour = PALETTE[index % PALETTE.length];
    lines.push(rect(x, y - 1.5, 6, 6, colour));
    lines.push(text(labelText, x + 9, y, LEGEND_SIZE, 'F1', MUTED));
    x += itemWidth;
    shown += 1;
  }
  if (shown < series.length) {
    if (x + textWidth(`+${series.length - shown} more`, LEGEND_SIZE) + 20 > PDF_PAGE.width - MARGIN) {
      row += 1;
      y -= lineHeight;
      x = MARGIN;
    }
    lines.push(text(`+${series.length - shown} more`, x, y, LEGEND_SIZE, 'F1', MUTED));
  }
  return { lines, bottom: y };
}

/** Column selection + the first `tableRows` rows, drawn from `tableTop` downwards. */
function renderTable(chart: ParsedReportCsv, tableRows: number, tableTop: number, lines: string[]): number {
  if (chart.header.length === 0) return 0;
  const shown = chart.rows.slice(0, tableRows);
  const rows = shown.length;

  // Column widths from the content that will actually be printed, then a greedy fit.
  const widths = chart.header.map((name, column) => {
    const cells = shown.map((row) => row[column] ?? '');
    const widest = Math.max(textWidth(name, TABLE_SIZE), ...cells.map((cell) => textWidth(cell, TABLE_SIZE)));
    return Math.min(112, Math.max(18, widest + 7));
  });

  const chosen: number[] = [];
  let used = 0;
  for (let column = 0; column < chart.header.length; column++) {
    const next = used + widths[column];
    if (chosen.length > 0 && next > CONTENT_WIDTH) break;
    chosen.push(column);
    used = next;
  }

  const headerTop = tableTop;
  const headerBottom = headerTop - TABLE_HEAD;
  lines.push(rect(MARGIN, headerBottom, used, TABLE_HEAD, [0.93, 0.95, 0.97]));
  let x = MARGIN;
  for (const column of chosen) {
    const width = widths[column];
    const label = fitText(chart.header[column] ?? '', width - 6, TABLE_SIZE);
    lines.push(text(label, column === 0 ? x + 3 : x + width - 3, headerBottom + 3.2, TABLE_SIZE, 'F2', RULE, column === 0 ? 'start' : 'end'));
    x += width;
  }

  let y = headerBottom;
  for (let index = 0; index < rows; index++) {
    y -= TABLE_ROW;
    if (index % 2 === 1) lines.push(rect(MARGIN, y, used, TABLE_ROW, [0.975, 0.98, 0.985]));
    let cellX = MARGIN;
    for (const column of chosen) {
      const width = widths[column];
      const raw = shown[index][column] ?? '';
      const cell = fitText(raw, width - 6, TABLE_SIZE);
      lines.push(text(cell, column === 0 ? cellX + 3 : cellX + width - 3, y + 2.4, TABLE_SIZE, 'F1', INK, column === 0 ? 'start' : 'end'));
      cellX += width;
    }
  }

  const note =
    rows < chart.rows.length
      ? `first ${rows} of ${chart.rows.length} rows (full data in the matching CSV)`
      : `${rows} row${rows === 1 ? '' : 's'}`;
  const columns = chosen.length < chart.header.length ? ` - showing ${chosen.length} of ${chart.header.length} columns` : '';
  lines.push(text(`${note}${columns}`, MARGIN, y - 9, 6.5, 'F1', MUTED));

  // Grid around the table, so a truncated row of cells still reads as a table.
  lines.push(rule(MARGIN, headerTop, MARGIN + used, headerTop, AXIS, 0.4));
  lines.push(rule(MARGIN, headerBottom, MARGIN + used, headerBottom, AXIS, 0.4));
  lines.push(rule(MARGIN, y, MARGIN + used, y, AXIS, 0.4));
  lines.push(rule(MARGIN, headerTop, MARGIN, y, AXIS, 0.4));
  lines.push(rule(MARGIN + used, headerTop, MARGIN + used, y, AXIS, 0.4));

  return headerTop - y;
}

/** One chart page: title, caption, legend, plot, table, footer. */
function chartPage(chart: ParsedReportCsv, title: string, tableRows: number, page: number, pages: number): string[] {
  const lines: string[] = [];
  const rows = chart.rows;
  const rowCount = rows.length;
  // Hard bounds: a page never holds more than PDF_TABLE_ROWS table rows, and a series never more
  // than PDF_MAX_POINTS vertices.
  const shownRows = Math.max(1, Math.min(tableRows, rowCount, PDF_TABLE_ROWS));
  const step = decimationStep(rowCount);

  lines.push(text(title, MARGIN, PDF_PAGE.height - 46, 15, 'F2', INK));
  lines.push(rule(MARGIN, PDF_PAGE.height - 52, PDF_PAGE.width - MARGIN, PDF_PAGE.height - 52, RULE, 1));

  const allSeries = chart.header.slice(1).map((_, index) => seriesOf(chart.header, rows, index + 1));
  // Subsample once, before layout: the hard bound applies to what is drawn, not only to the path.
  const plotted = step > 1 ? allSeries.map((entry) => decimate(entry, step)) : allSeries;
  const fitted = allSeries.filter((entry) => isConstant(entry));
  const caption =
    `${rowCount} row${rowCount === 1 ? '' : 's'} - ${allSeries.length} column${allSeries.length === 1 ? '' : 's'}` +
    (step > 1 ? ` - decimated (1/${step} points)` : '') +
    (fitted.length > 0 ? ` - ${fitted.length} constant (drawn flat, labelled constant)` : '') +
    ' - shared Y axis';
  lines.push(text(caption, MARGIN, PDF_PAGE.height - 64, 7.5, 'F1', MUTED));

  const box = legend(lines, plotted, PDF_PAGE.height - 78);

  // The table band is sized by the rows it will actually print (at most PDF_TABLE_ROWS), so a short
  // chart gets a taller plot instead of leaving half the page empty. The plot takes what is left
  // between the band and the legend, never less than 90 pt.
  const tableTop = MARGIN + TABLE_HEAD + shownRows * TABLE_ROW + 30;
  const geometry: PageGeometry = {
    left: MARGIN + 34,
    right: PDF_PAGE.width - MARGIN - 6,
    bottom: tableTop + 24,
    top: Math.max(tableTop + 24 + 90, box.bottom - 14),
  };
  if (geometry.top > PDF_PAGE.height - 90) geometry.top = PDF_PAGE.height - 90;

  if (rowCount === 0 || allSeries.length === 0) {
    lines.push(text('no rows in this chart', (MARGIN + PDF_PAGE.width - MARGIN) / 2, (geometry.top + geometry.bottom) / 2, 9, 'F1', MUTED, 'middle'));
  } else {
    renderPlot(lines, chart, plotted, geometry, step);
  }

  renderTable(chart, shownRows, tableTop, lines);
  lines.push(footer(page, pages));
  return lines;
}

/** 1 unless the chart has more rows than {@link PDF_MAX_POINTS}, then the stride that fits them. */
function decimationStep(rowCount: number): number {
  return rowCount <= PDF_MAX_POINTS ? 1 : Math.ceil(rowCount / PDF_MAX_POINTS);
}

/** Every `step`-th row, last row included, so the drawn series still ends at the final value. */
function decimate(series: Series, step: number): Series {
  const indices: number[] = [];
  for (let row = 0; row < series.values.length; row += step) indices.push(row);
  if (indices.length === 0 || indices[indices.length - 1] !== series.values.length - 1) {
    indices.push(Math.max(0, series.values.length - 1));
  }
  return { ...series, values: indices.map((row) => series.values[row]) };
}

/** Shared-axis plot: grid, ticks, one path per column, x labels from column 0. */
function renderPlot(lines: string[], chart: ParsedReportCsv, series: Series[], geometry: PageGeometry, step: number): void {
  const rowCount = chart.rows.length;
  const width = geometry.right - geometry.left;
  const height = geometry.top - geometry.bottom;
  // No spread: a full-day capture is far past the argument-list limit. Series are already decimated.
  let lo = Infinity;
  let hi = -Infinity;
  for (const entry of series) {
    for (const value of entry.values) {
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (lo === hi) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.01 : 1;
    lo -= pad;
    hi += pad;
  }

  const xOf = (index: number) =>
    rowCount === 1 ? geometry.left + width / 2 : geometry.left + (width * index) / (rowCount - 1);
  // PDF y grows upwards: the minimum sits on the bottom axis, the maximum at the top of the plot.
  const yOf = (value: number) => geometry.bottom + height * ((value - lo) / (hi - lo));

  const ticks = 5;
  const tickStep = (hi - lo) / (ticks - 1);
  for (let index = 0; index < ticks; index++) {
    const value = lo + tickStep * index;
    const y = yOf(value);
    lines.push(rule(geometry.left, y, geometry.right, y, GRID, 0.4));
    lines.push(text(axisLabel(value, tickStep), geometry.left - 6, y - 2.2, 7, 'F1', MUTED, 'end'));
  }
  lines.push(rule(geometry.left, geometry.top, geometry.left, geometry.bottom, AXIS, 0.6));
  lines.push(rule(geometry.left, geometry.bottom, geometry.right, geometry.bottom, AXIS, 0.6));

  series.forEach((entry, index) => {
    const colour = PALETTE[index % PALETTE.length];
    if (isConstant(entry)) {
      const y = yOf(entry.values[0] ?? 0);
      lines.push(rule(geometry.left, y, geometry.right, y, colour, 0.8));
      return;
    }
    const path: string[] = [stroke(colour, rowCount > 40 ? 0.7 : 0.9)];
    entry.values.forEach((value, position) => {
      // `position` counts decimated points; map it back to the row index the x axis is laid out on.
      const row = Math.min(rowCount - 1, position * step);
      path.push(position === 0 ? moveTo(xOf(row), yOf(value)) : lineTo(xOf(row), yOf(value)));
    });
    if (rowCount === 1) {
      lines.push(rect(xOf(0) - 1.4, yOf(entry.values[0]) - 1.4, 2.8, 2.8, colour));
      return;
    }
    path.push('S');
    lines.push(path.join(' '));
  });

  // X labels: the CSV's first column (GPS time, or the condition name for `Receiver Status`).
  const labelCount = rowCount <= 6 ? rowCount : 5;
  const labelRows =
    rowCount <= 6
      ? chart.rows.map((_, index) => index)
      : [...new Set([0, Math.floor((rowCount - 1) / 4), Math.floor((rowCount - 1) / 2), Math.floor((3 * (rowCount - 1)) / 4), rowCount - 1])];
  const labelMax = labelCount <= 6 ? 22 : 18;
  for (const index of labelRows) {
    const anchor: Align = index === 0 ? 'start' : index === rowCount - 1 ? 'end' : 'middle';
    const label = fitText(chart.rows[index]?.[0] ?? '', textWidth('0'.repeat(labelMax), 7), 7);
    lines.push(text(label, xOf(index), geometry.bottom - 10, 7, 'F1', MUTED, anchor));
  }
}

function footer(page: number, pages: number): string {
  return text(`page ${page} / ${pages}`, PDF_PAGE.width / 2, MARGIN - 18, 7, 'F1', MUTED, 'middle');
}

/* ------------------------------------------------------------------------------------------------
 * The information page
 * ---------------------------------------------------------------------------------------------- */

interface InfoField {
  label: string;
  value: string;
}

/**
 * Footer of the information page. This is the exact sentence the ASCII-only writer always printed;
 * it is kept verbatim so a pure-ASCII report stays byte-identical.
 */
const FONT_NOTE_ASCII =
  'Hand-written PDF 1.4 - base-14 Helvetica, no embedded fonts - charts read from the exported CSV data';

/** Footer when a TrueType face was embedded for the non-ASCII runs. */
function embeddedFontNote(face: TrueTypeFace): string {
  return `Hand-written PDF 1.4 - Helvetica for ASCII, embedded ${face.name} TrueType for non-ASCII text - charts read from the exported CSV data`;
}

/** Footer when non-ASCII text occurred but no usable face was found: says so instead of hiding it. */
const FONT_NOTE_DEGRADED =
  'Hand-written PDF 1.4 - base-14 Helvetica, no usable CJK TrueType face found: non-ASCII text is drawn as ?';

function infoPage(
  project: GraphProject,
  fields: InfoField[],
  charts: { title: string }[],
  generated: string,
  pages: number,
  fontNote: string = FONT_NOTE_ASCII,
): string[] {
  const lines: string[] = [];
  const title = `${project.projectName} Report`;
  lines.push(text(title, MARGIN, PDF_PAGE.height - 72, 22, 'F2', INK));
  lines.push(rule(MARGIN, PDF_PAGE.height - 82, PDF_PAGE.width - MARGIN, PDF_PAGE.height - 82, RULE, 1.2));

  let y = PDF_PAGE.height - 110;
  lines.push(text('Report Information', MARGIN, y, 12, 'F2', RULE));
  y -= 20;
  for (const field of [
    { label: 'Generated Date', value: generated },
    { label: 'Charts', value: String(charts.length) },
    { label: 'Pages', value: String(pages) },
  ]) {
    lines.push(text(field.label, MARGIN + 6, y, 9.5, 'F2', INK));
    lines.push(text(field.value, MARGIN + 180, y, 9.5, 'F1', INK));
    y -= 15;
  }

  y -= 14;
  lines.push(text('Project Information', MARGIN, y, 12, 'F2', RULE));
  y -= 20;
  for (const field of fields) {
    lines.push(text(field.label, MARGIN + 6, y, 9.5, 'F2', INK));
    lines.push(text(field.value, MARGIN + 180, y, 9.5, 'F1', INK));
    y -= 15;
  }

  const summary = messageSummary(project, charts.map((chart) => chart.title));
  if (summary.length > 0) {
    y -= 14;
    lines.push(text('Message Summary', MARGIN, y, 12, 'F2', RULE));
    y -= 18;
    lines.push(text('Message Name', MARGIN + 6, y, 8, 'F2', MUTED));
    lines.push(text('Message Count', MARGIN + 180, y, 8, 'F2', MUTED));
    y -= 12;
    for (const entry of summary) {
      if (y < MARGIN + 40) break;
      lines.push(text(entry.name, MARGIN + 6, y, 9, 'F1', INK));
      lines.push(text(String(entry.count), MARGIN + 180, y, 9, 'F1', INK));
      y -= 13;
    }
  }

  lines.push(text(fontNote, MARGIN, MARGIN + 4, 7.5, 'F1', MUTED));
  lines.push(text(`page 1 / ${pages}`, PDF_PAGE.width / 2, MARGIN - 18, 7, 'F1', MUTED, 'middle'));
  return lines;
}

/* ------------------------------------------------------------------------------------------------
 * Info fields — the six CSV comment lines, same spellings as the HTML report
 * ---------------------------------------------------------------------------------------------- */

function reportFields(project: GraphProject, charts: PdfChartSource[]): InfoField[] {
  const fromCsv = charts.length > 0 ? parseReportCsv(charts[0].csv).meta : {};
  const fallback = {
    'Project Name': project.projectName,
    'Project Directory': project.projectDirectory,
    'Data File Name': project.dataFileName,
    'Start Time(GPS)': formatGpsCommentTime(project.dataInfo.StartTime),
    'End Time(GPS)': formatGpsCommentTime(project.dataInfo.EndTime),
    Duration: formatDuration(project.dataInfo.Duration),
  };
  return [
    { label: 'Project Name', value: fromCsv['Project Name'] ?? fallback['Project Name'] },
    { label: 'Project Directory', value: fromCsv['Project Directory'] ?? fallback['Project Directory'] },
    { label: 'Data File Name', value: fromCsv['Data File Name'] ?? fallback['Data File Name'] },
    { label: 'Start Time (GPS)', value: fromCsv['Start Time(GPS)'] ?? fallback['Start Time(GPS)'] },
    { label: 'End Time (GPS)', value: fromCsv['End Time(GPS)'] ?? fallback['End Time(GPS)'] },
    { label: 'Duration', value: fromCsv['Duration'] ?? fallback.Duration },
  ];
}

function messageSummary(project: GraphProject, titles: string[]): { name: string; count: number | string }[] {
  const names: string[] = [];
  for (const title of titles) {
    for (const name of Object.keys(chartMessages(project.plotSummary, title))) {
      if (!names.includes(name)) names.push(name);
    }
  }
  return names.map((name) => ({ name, count: project.messages[name] ?? '' }));
}

/* ------------------------------------------------------------------------------------------------
 * PDF object graph
 * ---------------------------------------------------------------------------------------------- */

interface PdfObject {
  /** Object number, 1-based, in the order they are written. */
  number: number;
  /** Dictionary / ASCII stream body. */
  body?: string;
  /** A stream whose payload is binary (the embedded font file), written verbatim. */
  stream?: { dictionary: string; data: Uint8Array };
}

/** Font units → PDF glyph space (1/1000 em). */
function pdfUnits(face: TrueTypeFace, value: number): number {
  return Math.round((value * 1000) / face.unitsPerEm);
}

/**
 * `/W` array for the glyphs this document actually draws: consecutive glyph ids share one array
 * entry (`3 [600 620 640]`), which is what `W` means — start code, then one advance per following
 * code. Values are 1/1000 em, the same scale the layout used.
 */
function widthArray(face: TrueTypeFace, glyphs: Map<number, number>): string {
  const ids = [...glyphs.keys()].sort((a, b) => a - b);
  const parts: string[] = [];
  let index = 0;
  while (index < ids.length) {
    let end = index;
    while (end + 1 < ids.length && ids[end + 1] === ids[end] + 1) end++;
    const runs = ids.slice(index, end + 1).map((glyph) => pdfUnits(face, face.advances[glyph] ?? 0));
    parts.push(`${ids[index]} [${runs.join(' ')}]`);
    index = end + 1;
  }
  return `[${parts.join(' ')}]`;
}

/**
 * `ToUnicode` CMap for an `Identity-H` font: every glyph id this document used, mapped back to the
 * code point it was drawn for, so `pdftotext` (and copy/paste) recovers the original text. Only the
 * used glyphs are listed — a full SimHei table would be ~20 000 entries of dead weight.
 */
function toUnicodeCMap(glyphs: Map<number, number>, fallback: boolean): string {
  const entries = [...glyphs.entries()].sort((a, b) => a[0] - b[0]);
  const table = entries.map(([glyph, code]) => `<${hex4(glyph)}> <${utf16beHex(code)}>`);
  // `.notdef` has no code point of its own; a replacement character is the honest answer for text
  // that the face simply does not contain.
  if (fallback) table.push('<0000> <FFFD>');
  const blocks: string[] = [];
  for (let index = 0; index < table.length; index += 100) {
    const chunk = table.slice(index, index + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n') + '\n';
}

/** `FontDescriptor` for the embedded face — no synthetic bold, no synthetic italic. */
function fontDescriptorBody(face: TrueTypeFace, fontFile: number): string {
  const [x0, y0, x1, y1] = face.bbox;
  const capHeight = face.capHeight > 0 ? face.capHeight : face.ascender;
  return [
    '<< /Type /FontDescriptor',
    `/FontName /${face.name}`,
    '/Flags 4', // Symbolic: the codes are ours (`Identity-H`), not a standard Latin encoding.
    `/FontBBox [${pdfUnits(face, x0)} ${pdfUnits(face, y0)} ${pdfUnits(face, x1)} ${pdfUnits(face, y1)}]`,
    '/ItalicAngle 0',
    `/Ascent ${pdfUnits(face, face.ascender)}`,
    `/Descent ${pdfUnits(face, face.descender)}`,
    `/CapHeight ${pdfUnits(face, capHeight)}`,
    '/StemV 80',
    `/FontFile2 ${fontFile} 0 R`,
    '>>',
  ].join(' ');
}

/** `CIDFontType2` descendant: glyph ids are CIDs as-is (`/CIDToGIDMap /Identity`). */
function descendantFontBody(face: TrueTypeFace, descriptor: number, widths: string): string {
  return [
    '<< /Type /Font /Subtype /CIDFontType2',
    `/BaseFont /${face.name}`,
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>',
    `/FontDescriptor ${descriptor} 0 R`,
    '/DW 1000',
    `/W ${widths}`,
    '/CIDToGIDMap /Identity',
    '>>',
  ].join(' ');
}

/** Build the byte array: header, objects, xref table (exact offsets), trailer, `%%EOF`. */
function assemble(infoDictionary: string, pages: string[], face: TrueTypeFace | null): Uint8Array {
  const objects: PdfObject[] = [];
  const pageNumbers: number[] = [];
  const contentNumbers: number[] = [];

  // 1 catalog, 2 page tree, 3 info, 4/5 fonts — fixed so every build has the same numbering.
  let next = 6;
  for (let index = 0; index < pages.length; index++) {
    pageNumbers.push(next++);
    contentNumbers.push(next++);
  }
  // The embedded font is appended after the pages, so an ASCII-only document has exactly the
  // object numbers (and bytes) it had before this feature existed.
  let fontNumbers: { file: number; descriptor: number; descendant: number; type0: number; toUnicode: number } | null = null;
  if (face) {
    fontNumbers = { file: next++, descriptor: next++, descendant: next++, type0: next++, toUnicode: next++ };
  }

  objects.push({
    number: 1,
    body: '<< /Type /Catalog /Pages 2 0 R >>',
  });
  objects.push({
    number: 2,
    body: `<< /Type /Pages /Kids [${pageNumbers.map((number) => `${number} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  });
  objects.push({ number: 3, body: infoDictionary });
  objects.push({
    number: 4,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  });
  objects.push({
    number: 5,
    body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  });

  const fontResources = fontNumbers ? `/F1 4 0 R /F2 5 0 R /F3 ${fontNumbers.type0} 0 R` : '/F1 4 0 R /F2 5 0 R';
  pages.forEach((content, index) => {
    objects.push({
      number: pageNumbers[index],
      body:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE.width} ${PDF_PAGE.height}] ` +
        `/Resources << /Font << ${fontResources} >> /ProcSet [/PDF /Text] >> ` +
        `/Contents ${contentNumbers[index]} 0 R >>`,
    });
    objects.push({
      number: contentNumbers[index],
      body: `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    });
  });

  if (face && fontNumbers) {
    // The whole face, Flate-compressed. Compressing is the one thing that keeps a report at ~5 MB
    // instead of ~10 MB; `/Length1` is the uncompressed size, which is what a reader needs.
    const packed = new Uint8Array(deflateSync(Buffer.from(face.bytes), { level: 9 }));
    objects.push({
      number: fontNumbers.file,
      stream: {
        dictionary: `<< /Length ${packed.length} /Length1 ${face.bytes.length} /Filter /FlateDecode >>`,
        data: packed,
      },
    });
    objects.push({
      number: fontNumbers.descriptor,
      body: fontDescriptorBody(face, fontNumbers.file),
    });
    objects.push({
      number: fontNumbers.descendant,
      body: descendantFontBody(face, fontNumbers.descriptor, widthArray(face, usedGlyphs)),
    });
    objects.push({
      number: fontNumbers.type0,
      body:
        `<< /Type /Font /Subtype /Type0 /BaseFont /${face.name} /Encoding /Identity-H ` +
        `/DescendantFonts [${fontNumbers.descendant} 0 R] /ToUnicode ${fontNumbers.toUnicode} 0 R >>`,
    });
    const cmap = toUnicodeCMap(usedGlyphs, missingGlyph);
    objects.push({
      number: fontNumbers.toUnicode,
      body: `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`,
    });
  }

  const header = '%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n';
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (textValue: string) => {
    const buffer = Buffer.from(textValue, 'latin1');
    chunks.push(buffer);
    length += buffer.length;
  };
  const pushBytes = (data: Uint8Array) => {
    const buffer = Buffer.from(data);
    chunks.push(buffer);
    length += buffer.length;
  };

  push(header);
  for (const object of objects) {
    offsets[object.number] = length;
    if (object.stream) {
      push(`${object.number} 0 obj\n${object.stream.dictionary}\nstream\n`);
      pushBytes(object.stream.data);
      push('\nendstream\nendobj\n');
      continue;
    }
    push(`${object.number} 0 obj\n${object.body ?? ''}\nendobj\n`);
  }

  const xrefOffset = length;
  const size = objects.length + 1;
  push(`xref\n0 ${size}\n`);
  push('0000000000 65535 f \n');
  for (let number = 1; number < size; number++) {
    push(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  }
  push(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Uint8Array(Buffer.concat(chunks));
}

/* ------------------------------------------------------------------------------------------------
 * Entry points
 * ---------------------------------------------------------------------------------------------- */

/**
 * Build the whole PDF. Pure apart from the clock: pass `options.generatedAt` for byte-reproducible
 * output. Page 1 is the information page, then one page per chart, in the caller's order.
 */
export function buildPdfReport(project: GraphProject, charts: PdfChartSource[], options: PdfReportOptions = {}): Uint8Array {
  const tableRows = options.tableRows ?? PDF_TABLE_ROWS;
  const selected = options.selectedPlots ? charts.filter((chart) => options.selectedPlots!.includes(chart.title)) : charts;
  const generated = options.generatedAt ?? localTimestamp(new Date());
  const pages = 1 + selected.length;
  const fields = reportFields(project, selected);

  // One face for the whole build, chosen before any string is measured: `textWidth` and `text` have
  // to agree, and both read the module-level state set here. Restored on the way out.
  const face = resolveFace(options);
  activeFace = face;
  usedGlyphs = new Map();
  usedEmbeddedFace = false;
  degradedText = false;
  missingGlyph = false;

  try {
    const chartStreams = selected.map((chart, index) => {
      return chartPage(parseReportCsv(chart.csv), chart.title, tableRows, index + 2, pages).join('\n');
    });

    // The information page may be the only page with non-ASCII text (project name, directory), so it
    // is rendered once to learn what the footer must say, then again with that sentence. The probe
    // only adds glyphs to the same maps, so the second render is the one that is kept.
    infoPage(project, fields, selected, generated, pages, FONT_NOTE_ASCII);
    const fontNote = usedEmbeddedFace && face ? embeddedFontNote(face) : degradedText ? FONT_NOTE_DEGRADED : FONT_NOTE_ASCII;
    const infoStream = infoPage(project, fields, selected, generated, pages, fontNote).join('\n');
    const streams = [infoStream, ...chartStreams];

    const title = options.title ?? `${project.projectName} Report`;
    const info = [
      `<< /Title ${pdfTextString(title)}`,
      '/Creator (packages/graph)',
      `/Producer ${pdfTextString(
        usedEmbeddedFace && face
          ? `packages/graph hand-written PDF 1.4, embedded ${face.name} for non-ASCII text`
          : 'packages/graph hand-written PDF 1.4',
      )}`,
      `/CreationDate ${pdfTextString(pdfDate(generated))}`,
      '>>',
    ].join('\n');

    return assemble(info, streams, usedEmbeddedFace ? face : null);
  } finally {
    activeFace = null;
  }
}

/** `2026/10/30 21:00:00` → `D:20261030210000`; anything unparseable is passed through as text. */
function pdfDate(generatedAt: string): string {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(generatedAt);
  if (!match) return `D:${generatedAt.replace(/[^0-9]/g, '').slice(0, 14)}`;
  const [, year, month, day, hour, minute, second] = match;
  return `D:${year}${month}${day}${hour}${minute}${second}`;
}

/** Write `<outDir>/<projectName>.pdf` (Graph's destination for `clean.pdf`) and return its size. */
export function writePdfReport(
  project: GraphProject,
  charts: PdfChartSource[],
  outDir: string,
  options: PdfReportOptions = {},
): { path: string; bytes: number } {
  mkdirSync(outDir, { recursive: true });
  const bytes = buildPdfReport(project, charts, options);
  const path = join(outDir, `${project.projectName}.pdf`);
  writeFileSync(path, bytes);
  return { path, bytes: bytes.length };
}
