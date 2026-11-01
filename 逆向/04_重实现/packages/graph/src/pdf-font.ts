/**
 * **One TrueType face, embedded on demand** — the font half of the two hand-written PDF writers in
 * this repository (`packages/graph/src/pdf.ts` and `packages/app/src/pdf.ts`).
 *
 * Both writers draw ASCII with the base-14 `Helvetica` / `Helvetica-Bold` and must keep doing so
 * byte-for-byte; a run that contains anything outside ASCII is drawn with a real face instead, and
 * that face has to be parsed and embedded by hand because there is no PDF library here.
 *
 * What this module owns:
 *
 *  - **Parsing** a `.ttf`: `head` (unitsPerEm / bbox), `hhea` (ascender / descender /
 *    numberOfHMetrics), `maxp` (numGlyphs), `hmtx` (advances), `cmap` (format 12, else 4) and
 *    `OS/2` (fsType, typo metrics, cap height), plus `name` for the PostScript name. No `glyf` walk,
 *    no subsetting — the whole file goes in.
 *  - **The PDF font objects**: `/FontFile2` (Flate-compressed, `/Length1` = raw size),
 *    `FontDescriptor`, `CIDFontType2` with `/CIDToGIDMap /Identity`, `Type0` with `/Identity-H`, a
 *    `/W` width array for the glyphs actually used, and a `ToUnicode` CMap that maps those glyph ids
 *    back to their code points (so `pdftotext` still returns text, not pictures of text).
 *  - **Per-document state**: which face is in use, which glyphs were drawn, whether anything was
 *    embedded or degraded to `?`. A build is synchronous, so one module-level document at a time is
 *    enough; `beginPdfFont` / `endPdfFont` bracket it.
 *
 * Defaults: `simhei.ttf` from the system font directory (single weight — bold falls back to it
 * rather than faking a bold face), override with `cjkFontPath` or `GRAPH_PDF_CJK_FONT`, disable with
 * `null` / `off`. **No font is copied into this repository**; a machine without one degrades to the
 * old ASCII-only output and says so.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

/** The option both writers accept; `null` forces the pre-CJK behaviour. */
export interface PdfFontOptions {
  cjkFontPath?: string | null;
}

/**
 * A parsed TrueType face, reduced to what a PDF `CIDFontType2` and a text measurement need. Only
 * the tables the font dictionary and the layout have to agree on are kept.
 */
export interface TrueTypeFace {
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

/** One object for a writer's object table: a dictionary/ASCII stream, or a binary stream. */
export type CjkFontObject =
  | { number: number; body: string }
  | { number: number; dictionary: string; data: Uint8Array };

/** Objects {@link buildCjkFontObjects} writes: FontFile2, descriptor, descendant, Type0, ToUnicode. */
export const CJK_FONT_OBJECTS = 5;

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

/* ------------------------------------------------------------------------------------------------
 * Binary reading
 * ---------------------------------------------------------------------------------------------- */

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
      format === 12 && full ? 60
        : format === 12 && unicode ? 50
          : format === 4 && windowsBmp ? 40
            : format === 4 && unicode ? 30
              : format === 12 ? 20
                : format === 4 ? 10
                  : 0;
    if (score > 0) subtables.push({ offset, format, score });
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
    name: sanitizeFontName(postScriptName)
      ?? sanitizeFontName(path.replace(/^.*[\\/]/, '').replace(/\.ttf$/i, ''))
      ?? 'EmbeddedCJK',
    unitsPerEm,
    bbox: [
      be16s(bytes, head.offset + 36),
      be16s(bytes, head.offset + 38),
      be16s(bytes, head.offset + 40),
      be16s(bytes, head.offset + 42),
    ],
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

/* ------------------------------------------------------------------------------------------------
 * Locating and loading the face
 * ---------------------------------------------------------------------------------------------- */

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

/** Resolve the face a document should use; `null` means "stay ASCII-only". */
function resolveFace(options: PdfFontOptions): TrueTypeFace | null {
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

/* ------------------------------------------------------------------------------------------------
 * Per-document state
 * ---------------------------------------------------------------------------------------------- */

/**
 * Start a document: choose the face and clear the per-document glyph state. Pair with
 * {@link endPdfFont} in a `finally`, so a throw cannot leave a face attached to the next build.
 */
export function beginPdfFont(options: PdfFontOptions = {}): TrueTypeFace | null {
  activeFace = resolveFace(options);
  usedGlyphs = new Map();
  usedEmbeddedFace = false;
  degradedText = false;
  missingGlyph = false;
  return activeFace;
}

/** Drop the document's face; the glyph maps stay until the next `beginPdfFont`. */
export function endPdfFont(): void {
  activeFace = null;
}

/** The face a run may use right now, or `null`. */
export function embeddedFace(): TrueTypeFace | null {
  return activeFace;
}

/** True when a run needs the embedded face: anything outside 7-bit ASCII (control characters stay
 * on the old path, where they were already written as `?`). */
export function hasNonAscii(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 0x7f) return true;
  }
  return false;
}

/**
 * Rendered width of `text` with the embedded face, or `null` when the caller should use its own
 * ASCII metrics (no face, or nothing but ASCII in the run). Control characters are counted as the
 * space glyph, which is what {@link encodeCjkText} draws for them.
 */
export function cjkTextWidth(text: string, size: number): number | null {
  const face = activeFace;
  if (!face || !hasNonAscii(text)) return null;
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 63;
    units += glyphAdvance(face, code < 32 ? 32 : code);
  }
  return (units / face.unitsPerEm) * size;
}

/**
 * A run of glyph ids for the composite font: two bytes each, as uppercase hex. The glyphs used are
 * collected so the `ToUnicode` CMap of this document can be minimal; `.notdef` is recorded.
 */
export function encodeCjkText(value: string, face: TrueTypeFace): string {
  usedEmbeddedFace = true;
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0x3f;
    const glyph = face.cmap.get(code < 32 ? 32 : code) ?? 0;
    if (glyph === 0) missingGlyph = true;
    else if (!usedGlyphs.has(glyph)) usedGlyphs.set(glyph, code < 32 ? 32 : code);
    out += glyph.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** Note that a non-ASCII run was written as `?` — the document's footer says so. */
export function markCjkDegraded(): void {
  degradedText = true;
}

/** True when some run in this document was drawn with the embedded face. */
export function cjkUsedEmbedded(): boolean {
  return usedEmbeddedFace;
}

/** True when some run in this document fell back to `?`. */
export function cjkUsedDegraded(): boolean {
  return degradedText;
}

/* ------------------------------------------------------------------------------------------------
 * PDF strings
 * ---------------------------------------------------------------------------------------------- */

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
 * A text string for a document information dictionary: `null` while the text is ASCII (the caller
 * keeps its own literal, so a pure-ASCII document is unchanged), otherwise UTF-16BE with a `FEFF`
 * byte order mark, which every reader understands regardless of fonts or `/Encoding`.
 */
export function pdfUnicodeString(text: string): string | null {
  if (!hasNonAscii(text)) return null;
  let hex = 'FEFF';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0x3f;
    hex += code <= 0xffff ? hex4(code) : utf16beHex(code);
  }
  return `<${hex}>`;
}

/* ------------------------------------------------------------------------------------------------
 * The PDF font objects
 * ---------------------------------------------------------------------------------------------- */

/** Font units → PDF glyph space (1/1000 em). */
function pdfUnits(face: TrueTypeFace, value: number): number {
  return Math.round((value * 1000) / face.unitsPerEm);
}

/**
 * `/W` array for the glyphs a document actually draws: consecutive glyph ids share one array
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
 * used glyphs are listed — a full CJK table would be ~20 000 entries of dead weight.
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
  return `${[
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
  ].join('\n')}\n`;
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

/**
 * The five objects of the embedded font, numbered from `first` (callers reserve
 * {@link CJK_FONT_OBJECTS} numbers before the pages). `type0` is the number a page's `/F3` points at.
 */
export function buildCjkFontObjects(
  face: TrueTypeFace,
  first: number,
): { objects: CjkFontObject[]; type0: number } {
  const file = first;
  const descriptor = first + 1;
  const descendant = first + 2;
  const type0 = first + 3;
  const toUnicode = first + 4;

  // The whole face, Flate-compressed. Compressing is what keeps a report at ~5 MB instead of
  // ~10 MB; `/Length1` is the uncompressed size, which is what a reader needs.
  const packed = new Uint8Array(deflateSync(Buffer.from(face.bytes), { level: 9 }));
  const cmap = toUnicodeCMap(usedGlyphs, missingGlyph);

  return {
    type0,
    objects: [
      {
        number: file,
        dictionary: `<< /Length ${packed.length} /Length1 ${face.bytes.length} /Filter /FlateDecode >>`,
        data: packed,
      },
      { number: descriptor, body: fontDescriptorBody(face, file) },
      { number: descendant, body: descendantFontBody(face, descriptor, widthArray(face, usedGlyphs)) },
      {
        number: type0,
        body:
          `<< /Type /Font /Subtype /Type0 /BaseFont /${face.name} /Encoding /Identity-H `
          + `/DescendantFonts [${descendant} 0 R] /ToUnicode ${toUnicode} 0 R >>`,
      },
      { number: toUnicode, body: `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream` },
    ],
  };
}

/* ------------------------------------------------------------------------------------------------
 * Reporting
 * ---------------------------------------------------------------------------------------------- */

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
 * What a PDF writer would embed for non-ASCII text right now: the resolved path, whether it parsed,
 * and why not. `GRAPH_PDF_CJK_FONT=off` makes this report a disabled font.
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

/** Forget the parsed faces and the current document. Exported for the tests. */
export function resetPdfFontCache(): void {
  faceCache.clear();
  activeFace = null;
  usedGlyphs = new Map();
  usedEmbeddedFace = false;
  degradedText = false;
  missingGlyph = false;
}
