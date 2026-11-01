/**
 * Text logs: a capture can carry the receiver's **ASCII** output next to the binary frames, and the
 * suite's Convert accepts both. This module reproduces that half.
 *
 * Four shapes reach us from the de-framer (`framing.ts` already emits every text line as its own
 * frame, one per 0x0A):
 *
 *  1. `<NAME port seq idle timeStatus week ms rxStatus msgDefCrc swVersion` — the *header* of an
 *     abbreviated-ASCII log. The body follows on the next lines, one per repeated block.
 *  2. `<` + fields — continuation lines: `<     73 `, `<               4 0 20229880.713 …`,
 *     `<     SOL_COMPUTED SINGLE …`, `<     GPS TRUE TRUE 32`. Only the leading `<` marks them.
 *  3. `#NAME,…;…*crc` — a **complete** ASCII log, CRC included. The line the suite writes is the
 *     line the capture carried (all 11 such lines in `samples/live-20261031/live-nav.sbf` appear
 *     verbatim in the golden) — it re-renders them from the parsed fields, which for a record a
 *     receiver wrote is the same bytes; see `passThroughAscii`.
 *  4. `$GPGGA,…*hh` — an NMEA 0183 sentence, copied out untouched (see `NMEA_SENTENCES` below).
 *     The abbreviated-ASCII form of all four shapes is `abbrevTextLogLines`, further down.
 *
 * What the suite prints for shape 1+2 is the same line shape as for a binary record: the header
 * tokens joined by commas, the name with an `A`, then the body, and a **recomputed** NovAtel CRC
 * (the text carries none). Measured against `golden-live-nav.ASCII` / `golden-live-nav2.ASCII`.
 *
 * Two facts the golden forces, both counter-intuitive:
 *
 *  - The body is **not** a string copy. The tokens are read back into the layout's typed fields and
 *    printed through the same conversion strings as a binary record, so
 *    `HWMONITOR`'s `%x` status `100` comes out `00000100` and `f00` comes out `00000f00`;
 *  - a `f32` field is rounded to single precision before printing, so RANGE's `%7.3k` lock time
 *    `75947.813` prints as `75947.812` (the nearest float32 is 75947.8125, and `printf` rounds
 *    that half to even). This is the only per-token difference in 740 RANGE tokens, and it is the
 *    reason a pure text copy is not good enough.
 *
 * Not handled, stated rather than guessed:
 *  - `%` short ASCII: the suite drops it. Six shapes were fed to Convert — a `%` copy of a `#`
 *    record that does pass through, the same with a CRC, the CRC taken over `%`+sentence, a short
 *    header, a body without the header, and a letter-less name — and none produced a line: the
 *    bytes land in Convert's "UNKNOWN" bucket, not in a log count. So `%` lines stay unimplemented
 *    here, which is the same thing as being dropped.
 *  - `<OK`, `<ERROR`, `<` (empty), `[USB2]` port banners and any other text: no output (verified —
 *    a 1 122-byte mixed capture produced only the binary records and the `$GPGGA` line).
 *
 * Two measured details the `#`/`$` paths follow:
 *  - a `#` record is dropped unless its NovAtel CRC matches and its name is one the dictionary
 *    knows (`#FOOBARA` with a correct CRC → dropped; `#BESTPOSA` with `*00000000` → dropped);
 *  - a `$` record needs a **CRLF** terminator, its checksum is the NMEA XOR of the bytes between
 *    `$` and `*` (either hex case), its 5-letter sentence id must be one of the 29 built-in NMEA
 *    logs, and the id must be uppercase (`$gpgga,…*67` is dropped). The line is echoed verbatim,
 *    checksum and all.
 */

import { novatelCrc32 } from './crc.ts';
import { formatField, latin1Bytes } from './ascii-log.ts';
import type { EdieArray, EdieLayout, EdieScalar, EdieSegment, EdieString, EdieTables } from './edie.ts';
import type { Frame } from './framing.ts';

/** Command responses that must never be mistaken for a log body. */
const RESPONSE_WORDS = new Set(['OK', 'ERROR', 'IGNORED', 'INVALID']);

const HEX_SPECS = new Set(['x', 'X', 'XB', 'B']);
const INT_SPECS = new Set(['u', 'hu', 'lu', 'llu', 'd', 'hd', 'ld', 'lld', 'id', 'UB']);

export interface TextLogRecord {
  /** Frame index of the header line — the converted line is emitted there, in capture order. */
  index: number;
  /** Dictionary name without the version letter (`RANGE`). */
  name: string;
  /** The nine header tokens after the name (kept verbatim), then every body token. */
  tokens: string[];
}

function unquote(token: string): string {
  return token.length >= 2 && token.startsWith('"') && token.endsWith('"') ? token.slice(1, -1) : token;
}

function specOf(format: string | null | undefined): string | undefined {
  return /^%\d*(?:\.\d+)?l{0,2}([A-Za-z]{1,2})$/.exec(format ?? '')?.[1];
}

/** Read one printed token back into the field the layout declares. */
function parseToken(segment: EdieScalar | EdieString, token: string, tables: EdieTables): number | string {
  const scalar = segment as EdieScalar;
  const spec = specOf(segment.format);
  if (scalar.enum) {
    const table = tables.enums[scalar.enum];
    if (table) {
      for (const [value, name] of Object.entries(table.values)) if (name === token) return Number(value);
    }
    const numeric = Number(token);
    return Number.isFinite(numeric) ? numeric : token;
  }
  if (scalar.type === 'bool') return /^true$/i.test(token) ? 1 : 0;
  if (segment.kind === 'string' || spec === 's') return unquote(token);
  // `%T` prints `ms / 1000`, so a text token has to be scaled back before it is printed again.
  if (spec === 'T') return Math.round(Number(token) * 1000);
  // `%c` prints one raw character; its value is that character's code, not a number.
  if (spec === 'c') return token.length ? token.charCodeAt(0) : 0;
  if (spec !== undefined && HEX_SPECS.has(spec)) {
    const hex = parseInt(token, 16);
    return Number.isNaN(hex) ? token : hex;
  }
  const value = Number(token);
  if (!Number.isFinite(value)) return token;
  if (spec !== undefined && !INT_SPECS.has(spec) && scalar.type === 'f32') return Math.fround(value);
  return value;
}

/** Walk the layout in print order, consuming one body token per field. */
function renderBody(segments: EdieSegment[], tokens: string[], tables: EdieTables, out: string[]): void {
  let at = 0;
  const walk = (list: EdieSegment[]): void => {
    for (const segment of list) {
      if (at >= tokens.length) return;
      if (segment.kind === 'array') {
        const array = segment as EdieArray;
        let count = array.fixedCount ?? 0;
        if (array.countSize) {
          count = Number(tokens[at++] ?? '0');
          out.push(String(count));
        }
        // A `%P` payload is a single escaped token however many elements it holds.
        if (String(array.format ?? '') === '%P') {
          if (at < tokens.length) out.push(tokens[at++]);
          continue;
        }
        for (let i = 0; i < count && at < tokens.length; i++) walk(array.elements);
        continue;
      }
      const token = tokens[at++];
      if (segment.kind === 'string') {
        // `%Z` is raw hex and never quoted; a plain string is always quoted.
        out.push(String(segment.format ?? '').endsWith('Z') ? unquote(token) : `"${unquote(token)}"`);
        continue;
      }
      out.push(formatField(segment as EdieScalar, parseToken(segment, token, tables), tables));
    }
  };
  walk(segments);
  // Tokens the layout does not explain are kept rather than dropped, so a mismatch is visible in
  // the diff instead of silently shortening the line.
  while (at < tokens.length) out.push(tokens[at++]);
}

/** `<NAME tok …>` header? The first token must be a message the dictionary knows. */
function headerName(tokens: string[], names: ReadonlySet<string>): string | undefined {
  const first = tokens[0];
  return first !== undefined && names.has(first) ? first : undefined;
}

/**
 * The NMEA 0183 sentences Convert recognises, read out of the suite's own binaries
 * (`resources/app.asar.unpacked/Edie/windows/edie-node-wrappers.node`, the whole table) and
 * confirmed one by one through Convert: the twelve `GP*` ones round-trip, and `$GNGGA` — which is
 * *not* in the table — is dropped even with a correct checksum. Talker and sentence are both part
 * of the key, so `$GLGLL` and `$GNVTG` are accepted while a `$GPGGA` body behind a `GN` talker is
 * not. Convert assigns them the fixed ids 217 `GPALM`, 218 `GPGGA`, 219 `GPGLL`, 220 `GPGRS`,
 * 221 `GPGSA`, 222 `GPGST`, 223 `GPGSV`, 224 `GPRMB`/`GPRMC`, 226 `GPVTG`, 227 `GPZDA`, 1045
 * `GPHDT` — ids the Edie dictionary does not carry, which is why they never appear as layouts.
 */
const NMEA_SENTENCES = new Set([
  'GPALM', 'GPGGA', 'GPGLL', 'GPGRS', 'GPGSA', 'GPGST', 'GPGSV', 'GPHDT',
  'GPRMB', 'GPRMC', 'GPVTG', 'GPZDA',
  'GLGLL', 'GLGRS', 'GLGSA', 'GLGST', 'GLGSV', 'GLMLA', 'GLRMB', 'GLRMC', 'GLVTG',
  'GNGLL', 'GNGRS', 'GNGSA', 'GNGST', 'GNHDT', 'GNRMB', 'GNRMC', 'GNVTG',
]);

/**
 * A `$…*hh` sentence, ready to copy out; `undefined` when the suite would drop it.
 *
 * Measured boundaries: the terminator must be CRLF (a lone LF, a lone CR and a final sentence with
 * no terminator at all are all dropped); nothing may follow the two checksum digits (`*47garbage`
 * is dropped); the payload is not validated at all (`$GPGST,123519.00` and `$GPHDT,` are kept), so
 * the checksum and the sentence id are the only gates.
 */
export function passThroughNmea(text: string): string | undefined {
  if (!text.endsWith('\r\n')) return undefined;
  const line = text.slice(0, -2);
  const match = /^\$([A-Z]{5}),(.*)\*([0-9a-fA-F]{2})$/.exec(line);
  if (!match) return undefined;
  if (!NMEA_SENTENCES.has(match[1])) return undefined;
  let sum = 0;
  const body = `${match[1]},${match[2]}`;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i) & 0xff;
  return sum === parseInt(match[3], 16) ? line : undefined;
}

/** The dictionary name a `#NAME…` token stands for: one trailing version letter, then a known name. */
function hashName(token: string, names: ReadonlySet<string>): string | undefined {
  const base = token.slice(0, -1);
  if (/[A-Z]$/.test(token) && names.has(base)) return base;
  return names.has(token) ? token : undefined;
}

/**
 * Group the `<` frames of a capture into records, keyed by the frame index that opens them.
 * Records are only *assembled* here; call `encodeTextLog` to render one.
 */
export function collectTextLogs(frames: readonly Frame[], tables: EdieTables): Map<number, TextLogRecord> {
  const names = new Set(Object.values(tables.messages).map((message) => message.name));
  const records = new Map<number, TextLogRecord>();
  let open: TextLogRecord | undefined;

  frames.forEach((frame, index) => {
    if (frame.kind !== 'text' || frame.prefix !== '<') return;
    const tokens = frame.text.slice(1).trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return; // a bare `<`, seen 4× per capture
    const name = headerName(tokens, names);
    if (name !== undefined) {
      open = { index, name, tokens: tokens.slice(1) };
      records.set(index, open);
      return;
    }
    if (RESPONSE_WORDS.has(tokens[0]) || tokens[0].startsWith('?')) {
      open = undefined;
      return;
    }
    // A continuation line: `<     73`, `<   SOL_COMPUTED SINGLE …`, `<   GPS TRUE TRUE 32`.
    // Records can be interrupted by frames from another port, so this stays open until the next
    // header (or a response) rather than requiring the lines to be adjacent.
    if (open) open.tokens.push(...tokens);
  });
  return records;
}

/** Render one assembled `<` record as the ASCII line the suite writes. */
export function encodeTextLog(
  record: TextLogRecord,
  layout: EdieLayout | undefined,
  tables: EdieTables,
  options: { versionLetter?: string } = {},
): string {
  const head = record.tokens.slice(0, 9);
  const body = record.tokens.slice(9);
  const rendered: string[] = [];
  if (layout) renderBody(layout.fields, body, tables, rendered);
  else rendered.push(...body);
  const sentence = `${record.name}${options.versionLetter ?? 'A'},${head.join(',')};${rendered.join(',')}`;
  const crc = novatelCrc32(latin1Bytes(sentence)).toString(16).padStart(8, '0');
  return `#${sentence}*${crc}`;
}

/**
 * A `#NAME,…*crc` text record, ready to copy out; `undefined` when the suite would drop it.
 *
 * Convert does not merely copy these: it parses the fields and re-renders them (a synthetic
 * `#BESTPOSA` whose idle time reads `72.00` comes back as `72.0`, `64.82390` as `64.8239`). For
 * every record a receiver writes the re-render is identical to the input — same layout, same
 * conversion strings — so copying the line is byte-exact, and that is what the six goldens show.
 * The gates it shares with the re-render are enforced here: the CRC must match and the name must
 * be one the dictionary knows, otherwise the record is dropped (`#FOOBARA` with a correct CRC and
 * `#BESTPOSA` with `*00000000` both produce no line).
 */
export function passThroughAscii(text: string, names: ReadonlySet<string> = new Set()): string | undefined {
  const line = text.replace(/[\r\n]+$/, '');
  const match = /^#([A-Z][A-Z0-9_]*),[\s\S]*\*([0-9a-fA-F]{8})$/.exec(line);
  if (!match) return undefined;
  if (names.size > 0 && hashName(match[1], names) === undefined) return undefined;
  const sum = novatelCrc32(latin1Bytes(line.slice(1, line.lastIndexOf('*'))));
  return sum === parseInt(match[2], 16) ? line : undefined;
}

/** One `#NAME,…;…*crc` line as the same token list a `<` record assembles into. */
function parseHashRecord(index: number, line: string): TextLogRecord | undefined {
  const semicolon = line.indexOf(';');
  const star = line.lastIndexOf('*');
  if (semicolon < 0 || star < semicolon) return undefined;
  const head = line.slice(1, semicolon).split(',');
  const name = head.shift() ?? '';
  // The trailing `*crc` belongs to the record, not to the last field.
  const tokens = [...head, ...line.slice(semicolon + 1, star).split(',')];
  return tokens.length >= 9 ? { index, name: name.slice(0, -1), tokens } : undefined;
}

/**
 * The abbreviated-ASCII lines a capture's text records produce, keyed by frame index.
 *
 * This is the ABBREV form of the same records `textLogLines` renders as `#…` lines. Convert does
 * not copy a text record into ABBREV output either — it parses the fields and prints them again:
 *
 *   `#RAWALMA,…,91818.000,2,1,<60 hex>,2,<60 hex>*…`
 *     → `<RAWALM USB 0 75.0 FINESTEERING 2402 91818.000 03801800 cdba 18278`
 *       `<     2402 91818.000 2 `
 *       `<          1 <60 hex> `
 *       `<          2 <60 hex>`
 *
 * (measured on a synthetic capture; `#RANGEA` behaves the same way, 73 array elements becoming 73
 * lines). A `$` sentence is the exception: it is copied out verbatim, exactly as in ASCII output.
 * `%` records, `[port]` banners, `<OK` and stray text produce nothing.
 *
 * Line shape, measured on `golden-abbrev/clean-9600` and on synthetic records:
 *  - header: `<NAME` + the nine header tokens, space separated, no trailing space;
 *  - data line: `<` + **four** spaces, then one space **only when a value follows**, so a line with
 *    no values at all is `<    ` (`abbrev-log.ts` writes five spaces unconditionally);
 *  - one element line per array element: `<` + **nine** spaces, the separator space, the values;
 *  - every line but the record's last carries one trailing space.
 *
 * Two behaviours of the suite's writer that a binary-frame renderer never meets:
 *  - a **fixed-length** array prints no count and no line break (CLOCKMODEL's `par`/`data` arrays
 *    stay on the data line);
 *  - a **counted** array always prints `max(1, count)` element lines, so a zero-element array
 *    leaves an empty `<         ` line behind — measured with `SATVIS2 …,SBAS,TRUE,FALSE,0`,
 *    `RAWALM …,2402,91818.000,0` and the four such SATVIS2 records in `live-nav.sbf`.
 */
export function abbrevTextLogLines(frames: readonly Frame[], tables: EdieTables): Map<number, string[]> {
  const byName = new Map<string, EdieLayout>();
  for (const layout of Object.values(tables.messages)) byName.set(layout.name, layout);
  const names = new Set(byName.keys());
  const lines = new Map<number, string[]>();

  for (const [index, record] of collectTextLogs(frames, tables)) {
    const layout = byName.get(record.name);
    if (layout) lines.set(index, abbrevFromTokens(record, layout, tables));
  }
  frames.forEach((frame, index) => {
    if (frame.kind !== 'text') return;
    if (frame.prefix === '#') {
      const line = passThroughAscii(frame.text, names);
      if (line === undefined) return;
      const record = parseHashRecord(index, line);
      const layout = record && byName.get(record.name);
      if (record && layout) lines.set(index, abbrevFromTokens(record, layout, tables));
      return;
    }
    if (frame.prefix === '$') {
      const line = passThroughNmea(frame.text);
      if (line !== undefined) lines.set(index, [line]);
    }
  });
  return lines;
}

function abbrevFromTokens(record: TextLogRecord, layout: EdieLayout, tables: EdieTables): string[] {
  const head = record.tokens.slice(0, 9);
  const body = record.tokens.slice(9);
  const first: string[] = [];
  const blocks: string[][] = [];
  walkAbbrev(layout.fields, body, tables, first, blocks);
  return formatAbbrev(`${record.name} ${head.join(' ')}`, first, blocks);
}

/**
 * Join the pieces. The indent is four spaces for the data line and nine for an element line, and
 * the space before the values is part of the *separator*, not the indent — that is why an empty
 * line is one space shorter (`<    ` / `<         `) instead of the naive `<     ` / `<          `.
 */
function formatAbbrev(header: string, first: string[], blocks: string[][]): string[] {
  const data = [`<    ${first.length ? ` ${first.join(' ')}` : ''}`];
  for (const block of blocks) data.push(`<         ${block.length ? ` ${block.join(' ')}` : ''}`);
  const lines = [`<${header}`];
  data.forEach((line, index) => lines.push(index === data.length - 1 ? line : `${line} `));
  return lines;
}

/** Consume body tokens in print order, filling the data line and one block per array element. */
function walkAbbrev(
  segments: EdieSegment[],
  tokens: string[],
  tables: EdieTables,
  first: string[],
  blocks: string[][],
): void {
  let at = 0;
  for (const segment of segments) {
    if (segment.kind !== 'array') {
      if (at >= tokens.length) return;
      at = walkElement([segment], tokens, at, tables, first);
      continue;
    }
    const array = segment as EdieArray;
    if (array.countSize) {
      const count = Number(tokens[at++] ?? '0');
      if (!Number.isFinite(count)) continue;
      first.push(String(count));
      // `max(1, count)`: a zero-element array still prints one (empty) element line.
      for (let i = 0; i < Math.max(1, count); i++) {
        const block: string[] = [];
        if (at < tokens.length) at = walkElement(array.elements, tokens, at, tables, block);
        else if (i > 0) break; // truncated record: stop instead of inventing empty lines
        blocks.push(block);
      }
    } else {
      for (let i = 0; i < (array.fixedCount ?? 0) && at < tokens.length; i++) {
        at = walkElement(array.elements, tokens, at, tables, first);
      }
    }
  }
}

function walkElement(
  segments: EdieSegment[],
  tokens: string[],
  start: number,
  tables: EdieTables,
  out: string[],
): number {
  let at = start;
  for (const segment of segments) {
    if (at >= tokens.length) return at;
    const token = tokens[at++];
    if (segment.kind === 'string') {
      // `%Z` is raw hex, never quoted (RAWALM's page data); every other string is quoted.
      out.push(String(segment.format ?? '').endsWith('Z') ? unquote(token) : `"${unquote(token)}"`);
      continue;
    }
    if (segment.kind === 'array') {
      // A `%P` payload arrives as one escaped token and goes out unchanged: the escaping is
      // reversible, and a `%P` record in text input has never been observed.
      out.push(token);
      continue;
    }
    out.push(formatField(segment as EdieScalar, parseToken(segment, token, tables), tables));
  }
  return at;
}
/**
 * The ASCII lines for a whole capture, in frame order: one entry per frame index that produces
 * output (binary frames are not included — `convert.ts` already handles those).
 */
export function textLogLines(frames: readonly Frame[], tables: EdieTables): Map<number, string> {
  const byName = new Map<string, EdieLayout>();
  for (const layout of Object.values(tables.messages)) byName.set(layout.name, layout);
  const names = new Set(byName.keys());
  const lines = new Map<number, string>();
  for (const [index, record] of collectTextLogs(frames, tables)) {
    lines.set(index, encodeTextLog(record, byName.get(record.name), tables));
  }
  frames.forEach((frame, index) => {
    if (frame.kind !== 'text') return;
    if (frame.prefix === '#') {
      const line = passThroughAscii(frame.text, names);
      if (line !== undefined) lines.set(index, line);
      return;
    }
    if (frame.prefix === '$') {
      const line = passThroughNmea(frame.text);
      if (line !== undefined) lines.set(index, line);
    }
    // `%` short ASCII, `[port]` banners, `<OK`/`<ERROR` and stray text produce nothing at all.
  });
  return lines;
}
