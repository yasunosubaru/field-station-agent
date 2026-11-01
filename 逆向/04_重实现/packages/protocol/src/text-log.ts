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
import { formatField, latin1Bytes, toBigInt } from './ascii-log.ts';
import type { EdieArray, EdieLayout, EdieScalar, EdieSegment, EdieString, EdieTables } from './edie.ts';
import type { Frame } from './framing.ts';

/** Command responses that must never be mistaken for a log body. */
const RESPONSE_WORDS = new Set(['OK', 'ERROR', 'IGNORED', 'INVALID']);

/** Eight lowercase hex digits — the ASCII log/command CRC form. */
const hex8 = (value: number): string => (value >>> 0).toString(16).padStart(8, '0');

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

/**
 * The message id a `%m` token stands for, or the token itself when the dictionary has no such name.
 *
 * `messageName` (`ascii-log.ts`) prints `name + suffix`, and the suffix says which id flavour the
 * value carries: `A` for the ASCII log (`id | 0x200000`), `B` for the binary one (`id` itself) and
 * nothing at all for `id | 0x400000`. This is the inverse, over the dictionary's own ids.
 */
function messageId(token: string, tables: EdieTables): number | string {
  const letter = /[AB]$/.test(token) ? token.slice(-1) : '';
  const name = letter ? token.slice(0, -1) : token;
  for (const [id, layout] of Object.entries(tables.messages)) {
    if (layout.name !== name) continue;
    const value = Number(id);
    if (letter === 'A') return value | 0x200000;
    if (letter === 'B') return value;
    return value | 0x400000;
  }
  return token;
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
    // An enum token is a **name**, never a number: `8` is `ALL` in `CommPort` and Convert still
    // prints `UNKNOWN` for it. Measured on a synthetic `#ECHOA,<head>;8,OFF` at top level *and*
    // embedded in `#RXCONFIGA` — both come back `UNKNOWN,OFF`, exactly like `3` (which is `COM3`) and
    // like a name the table has never heard of. `renderScalar` turns the returned token into
    // `UNKNOWN`.
    return token;
  }
  if (scalar.type === 'bool') return /^true$/i.test(token) ? 1 : 0;
  if (segment.kind === 'string' || spec === 's') return unquote(token);
  // `%m` prints a **message name** (`RXSTATUSEVENTA`), so a text token has to be mapped back to the
  // id `formatField` prints it from. `A` is the ASCII flavour, `B` the binary one and no letter the
  // suffixed-by-nothing flavour — the three cases `messageName` documents in `ascii-log.ts`. A name
  // the dictionary does not carry stays a string, and prints `UNKNOWNB` (measured: `NOTALOG`).
  if (spec === 'm') return messageId(token, tables);
  // `%T` prints `ms / 1000`, so a text token has to be scaled back before it is printed again.
  if (spec === 'T') return Math.round(Number(token) * 1000);
  // `%c` prints one raw character; its value is that character's code, not a number.
  if (spec === 'c') return token.length ? token.charCodeAt(0) : 0;
  if (spec !== undefined && HEX_SPECS.has(spec)) {
    const hex = parseInt(token, 16);
    return Number.isNaN(hex) ? token : hex;
  }
  // `%llu` / `%lld` keep all 64 bits: a decimal string is parsed as a `bigint`, not through a
  // double (2^53 + 1 would otherwise print as 2^53).
  if (/%l{2}[ud]$/.test(String(segment.format ?? ''))) return toBigInt(token);
  const value = Number(token);
  if (!Number.isFinite(value)) return token;
  if (spec !== undefined && !INT_SPECS.has(spec) && scalar.type === 'f32') return Math.fround(value);
  return value;
}

/**
 * Walk the layout in print order, consuming one body token per field.
 *
 * Returns false when the record ran out of tokens before the layout did — Convert drops such a
 * record entirely (measured: a `#BESTPOSA` whose body loses its last two tokens prints nothing,
 * while the same record with two **extra** tokens prints them away). `keepExtra` keeps the old
 * lenient behaviour for `<` records, where an unexplained token is more useful in the diff than
 * silently gone.
 */
function renderBody(
  segments: EdieSegment[],
  tokens: string[],
  tables: EdieTables,
  out: string[],
  keepExtra = false,
): boolean {
  let at = 0;
  let complete = true;
  const walk = (list: EdieSegment[]): void => {
    for (const segment of list) {
      if (at >= tokens.length) {
        complete = false;
        return;
      }
      if (segment.kind === 'array') {
        const array = segment as EdieArray;
        let count = array.fixedCount ?? 0;
        if (array.countSize) {
          count = Number(tokens[at++] ?? '0');
          out.push(String(count));
        }
        // A `%P` payload and a `%Z` byte array are one token each however many elements they hold.
        // `%Z` prints as lowercase hex, so it is normalised and cut back to `count` bytes.
        const format = String(array.format ?? '');
        if (format === '%P' || format === '%Z') {
          if (at >= tokens.length) {
            complete = false;
            return;
          }
          const token = tokens[at++] ?? '';
          out.push(format === '%Z' ? token.toLowerCase().slice(0, Math.max(0, count) * 2) : token);
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
      out.push(renderScalar(segment as EdieScalar, token, tables));
    }
  };
  walk(segments);
  // Tokens the layout does not explain: kept for a `<` record (a mismatch stays visible in the
  // diff) and dropped for a `#` record, because that is what Convert does with them.
  if (keepExtra) while (at < tokens.length) out.push(tokens[at++]);
  return complete;
}

/**
 * One scalar body token printed again, including the rule `formatField` cannot see on its own.
 *
 * `parseToken` hands back the token **as a string** when an enum field carries a name the table does
 * not list (`INTERFACEMODE`'s `LCOM1`, which this receiver writes and the dictionary spells
 * `UNKNOWN`), and a string reaching `formatField` would print as `NaN`. The suite prints `UNKNOWN`
 * for it — the same answer it gives for a number outside the table. Measured through Convert on a
 * synthetic `#RXCONFIGA` wrapping `#ECHOA,…;BOGUS,OFF` and `#ECHOA,…;8,OFF`, both `UNKNOWN,OFF`.
 */
function renderScalar(segment: EdieScalar, token: string, tables: EdieTables): string {
  const value = parseToken(segment, token, tables);
  if (typeof value === 'string' && segment.enum) return 'UNKNOWN';
  return formatField(segment, value, tables);
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
 *
 * A record may hold **more than one** `$`: the de-framer starts a text record at a `$` and a second
 * `$` inside it does not begin a new one (`framing.ts#textBoundary`), so `$A…*47$B…*7A\r\n` reaches
 * us as a single record. Convert resolves that record to the **last** sentence and validates *its*
 * checksum, printing it verbatim — the last sentence's bytes, checksum case included:
 *
 * | record                                  | the suite's line                        |
 * |-----------------------------------------|-----------------------------------------|
 * | `$A*47$B*7A`                            | `…$B…*7A` (the last one)                |
 * | `$A*47$B*00` (B's checksum broken)      | nothing — no fallback to `A`            |
 * | `$A*47$GPGGA,1,2` (B has no checksum)   | nothing                                 |
 * | `$A*47$B*7A$R*78` (three sentences)     | `…$R…*78`                               |
 * | `$A*47$B*7a` (lowercase checksum)       | `…$B…*7a` — echoed, not re-rendered     |
 *
 * So the sentence starts at the last `$`, not the first. (Reading the record as "first `$` up to
 * the last `*`, checksum over the first `*`" would print `A` and keep the record above that the
 * suite drops, which is exactly what this used to do.)
 */
export function passThroughNmea(text: string): string | undefined {
  if (!text.endsWith('\r\n')) return undefined;
  const all = text.slice(0, -2);
  const line = all.slice(all.lastIndexOf('$'));
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
  return `#${sentence}*${hex8(novatelCrc32(latin1Bytes(sentence)))}`;
}

/**
 * A `#NAME,…*crc` text record, gated; `undefined` when the suite would drop it before parsing.
 *
 * The gate is the CRC and the name, both measured: `#FOOBARA` with a perfect CRC and `#BESTPOSA`
 * with `*00000000` produce no line at all. What the record *says* is decided by `encodeHashLog`,
 * which re-renders it — this function only answers "would Convert look at it".
 */
export function passThroughAscii(text: string, names: ReadonlySet<string> = new Set()): string | undefined {
  const line = text.replace(/[\r\n]+$/, '');
  const match = /^#([A-Z][A-Z0-9_]*),[\s\S]*\*([0-9a-fA-F]{8})$/.exec(line);
  if (!match) return undefined;
  if (names.size > 0 && hashName(match[1], names) === undefined) return undefined;
  const sum = novatelCrc32(latin1Bytes(line.slice(1, line.lastIndexOf('*'))));
  return sum === parseInt(match[2], 16) ? line : undefined;
}

/** Dictionary name → layout. Every `#` and `<` path needs this lookup, so it is built once per table. */
const LAYOUT_INDEX = new WeakMap<EdieTables, Map<string, EdieLayout>>();

function layoutIndex(tables: EdieTables): Map<string, EdieLayout> {
  const cached = LAYOUT_INDEX.get(tables);
  if (cached) return cached;
  const byName = new Map<string, EdieLayout>();
  for (const layout of Object.values(tables.messages)) byName.set(layout.name, layout);
  LAYOUT_INDEX.set(tables, byName);
  return byName;
}

/** One `#NAME,…;…*crc` line as the same token list a `<` record assembles into. */
/**
 * A `#NAME,…;…*crc` line split into its parts, with the nine header tokens **re-rendered**.
 *
 * Convert parses these records exactly like binary ones and prints them again, so the head is not a
 * copy: a synthetic `#BESTPOSA` whose head reads `USB2,007,72.00,COARSESTEERING,02442,570228.0,
 * 3800800,CDBA,18278` comes back as `USB2,7,72.0,COARSESTEERING,2442,570228.000,03800800,cdba,18278`
 * — sequence and week as integers, idle time as `raw/2` with one decimal, milliseconds as
 * seconds with three, receiver status to eight lowercase hex digits, the message-definition CRC to
 * four. The port name and the time-status name are already names, so they stay as they came.
 */
function renderHead(tokens: string[]): string[] {
  const integerOf = (token: string): string => {
    const value = Number(token);
    return Number.isFinite(value) ? String(Math.trunc(value)) : token;
  };
  const hexOf = (token: string, width: number): string => {
    const value = parseInt(token, 16);
    return Number.isNaN(value) ? token : (value >>> 0).toString(16).padStart(width, '0');
  };
  const [port, sequence, idle, timeStatus, week, milliseconds, receiverStatus, msgDefCrc, softwareVersion] = tokens;
  const idleRaw = Math.round(Number(idle) * 2);
  const ms = Math.round(Number(milliseconds) * 1000);
  return [
    port ?? '',
    integerOf(sequence ?? ''),
    Number.isFinite(idleRaw) ? (idleRaw / 2).toFixed(1) : String(idle),
    timeStatus ?? '',
    integerOf(week ?? ''),
    Number.isFinite(ms) ? `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}` : String(milliseconds),
    hexOf(receiverStatus ?? '', 8),
    hexOf(msgDefCrc ?? '', 4),
    integerOf(softwareVersion ?? ''),
  ];
}

interface HashRecord {
  /** The name token exactly as it arrived (`BESTPOSA`), which is what Convert prints. */
  rawName: string;
  /** Dictionary name without the version letter (`BESTPOS`). */
  name: string;
  layout: EdieLayout | undefined;
  /** The nine header tokens, re-rendered. */
  head: string[];
  /** The body tokens, as the record carried them. */
  body: string[];
  /** The body exactly as it arrived, between the first `;` and the last `*`. */
  rawBody: string;
}

function parseHashLine(line: string, byName: Map<string, EdieLayout>): HashRecord | undefined {
  const semicolon = line.indexOf(';');
  const star = line.lastIndexOf('*');
  if (semicolon < 0 || star < semicolon) return undefined;
  const tokens = line.slice(1, semicolon).split(',');
  const rawName = tokens.shift() ?? '';
  if (tokens.length < 9) return undefined;
  const base = rawName.slice(0, -1);
  const name = /[A-Z]$/.test(rawName) && byName.has(base) ? base : rawName;
  return {
    rawName,
    name,
    layout: byName.get(name),
    head: renderHead(tokens.slice(0, 9)),
    body: line.slice(semicolon + 1, star).split(','),
    rawBody: line.slice(semicolon + 1, star),
  };
}

/**
 * A record whose whole body is one raw blob (`RXCONFIG` / `RXCONFIGUSER`: a single `%R` span).
 *
 * The blob is an embedded ASCII message, commas, semicolons and its own CRC included, so it is never
 * rendered token by token: `encodeEmbeddedAscii` parses it as a record of its own and re-renders that.
 */
function rawBodyLayout(layout: EdieLayout | undefined): boolean {
  if (!layout || layout.fields.length !== 1) return false;
  const only = layout.fields[0];
  return only.kind === 'array' && String(only.format ?? '') === '%R';
}

/** An embedded ASCII message, parsed and ready to be printed again. */
interface EmbeddedRecord {
  /** The name token as the capture spells it (`INTERFACEMODEA`) — what Convert prints. */
  rawName: string;
  /** Dictionary name without the version letter (`INTERFACEMODE`). */
  name: string;
  layout: EdieLayout;
  /** The nine header tokens, re-rendered. */
  head: string[];
  /** The body tokens, as the message wrote them. */
  body: string[];
}

/**
 * Parse the `%R` blob of a text `RXCONFIG`/`RXCONFIGUSER` record: `#NAME,<head>;<body>*<crc>`.
 *
 * `undefined` when the suite would drop the whole outer record, which it does for a blob the
 * dictionary cannot resolve — measured on `b7-20261101.sbf`, where 22 of the 269 `#RXCONFIGA` lines
 * embed a name this dictionary does not carry (`AGCMODEA`, `SETIONOMODELA`, …) and the suite writes
 * nothing for them, leaving 247 lines. The trailing `*<crc>` is dropped: see `embeddedCrc`.
 */
function parseEmbeddedRecord(blob: string, byName: Map<string, EdieLayout>): EmbeddedRecord | undefined {
  if (!blob.startsWith('#')) return undefined;
  const star = blob.lastIndexOf('*');
  const text = blob.slice(1, star > 0 ? star : undefined);
  const semicolon = text.indexOf(';');
  if (semicolon < 0) return undefined;
  const tokens = text.slice(0, semicolon).split(',');
  const rawName = tokens.shift() ?? '';
  if (tokens.length < 9) return undefined;
  const base = rawName.slice(0, -1);
  const name = /[A-Z]$/.test(rawName) && byName.has(base) ? base : rawName;
  const layout = byName.get(name);
  if (!layout) return undefined;
  return {
    rawName,
    name,
    layout,
    head: renderHead(tokens.slice(0, 9)),
    body: text.slice(semicolon + 1) === '' ? [] : text.slice(semicolon + 1).split(','),
  };
}

/**
 * The CRC the suite prints for an embedded ASCII message: the **one's complement** of the NovAtel
 * CRC over `NAME,<head>;<body>`.
 *
 * Measured on all 247 `#RXCONFIGA` lines of `golden-b7-20261101.ASCII`: the plain CRC over the
 * re-rendered sentence reproduces none of them, `~crc` reproduces every one — e.g. sequence 265's
 * `INTERFACEMODEA,USB2,265,…,7a68,18278;UNKNOWN,NOVATEL,NOVATEL,ON` is `5633f5d1`, and the plain
 * CRC of those bytes is `a9cc0a2e`. This is the same `invertCrc` rule the binary `%R` path uses
 * (`ascii-log.ts`, `AsciiLogOptions.invertCrc`), so both halves of `RXCONFIG` agree.
 *
 * The carried CRC is not even validated: a blob whose inner CRC reads `00000000`, the plain CRC or
 * `~crc` all print the same recomputed value (three synthetic captures through Convert).
 */
function embeddedCrc(sentence: string): string {
  return hex8((novatelCrc32(latin1Bytes(sentence)) ^ 0xffffffff) >>> 0);
}

/**
 * Re-render an embedded ASCII message as the `#NAME,…;…*crc` line that goes inside the outer record.
 *
 * The body is rendered the way the outer record's is, with one measured difference: a body that runs
 * out of tokens prints the fields it **has** instead of dropping the record (synthetic `#RXCONFIGA`
 * wrapping `#ECHOA,<head>;COM2` → `…#ECHOA,<head>;COM2*cb1e7741*…`), while an **empty** body prints
 * nothing at all and takes the outer record with it. Both are corners of a record a receiver never
 * writes; b7's 269 config lines all carry complete bodies.
 */
function encodeEmbeddedAscii(blob: string, byName: Map<string, EdieLayout>, tables: EdieTables): string | undefined {
  const inner = parseEmbeddedRecord(blob, byName);
  if (!inner || inner.body.length === 0) return undefined;
  const body: string[] = [];
  renderBody(inner.layout.fields, inner.body, tables, body);
  const sentence = `${inner.rawName},${inner.head.join(',')};${body.join(',')}`;
  return `#${sentence}*${embeddedCrc(sentence)}`;
}

/**
 * Re-render a gated `#NAME,…;…*crc` record as the ASCII line Convert writes; `undefined` when it
 * drops the record.
 *
 * Two shapes of drop are measured on synthetic records:
 *
 *  - the body runs **out** of tokens before the layout does (a `#BESTPOSA` whose body loses its last
 *    two fields prints nothing at all);
 *  - extra body tokens are simply not printed (the same record with two tokens appended prints the
 *    canonical line, unchanged).
 *
 * For every record a receiver writes the re-render is the input, byte for byte — that is what the
 * goldens show (13 such records in `b1`, 11 in `live-nav`, 10 in `live-nav2`, all `#BESTPOSA`).
 */
/**
 * A `#NAME,…;body*crc` record read back into `path → token` (the inverse of `renderBody`).
 *
 * The app needs this because some records only ever arrive as **ASCII**: on this receiver
 * `ITDETECTSTATUS` is configured as `ITDETECTSTATUSA`, so the capture holds 48 text lines and there is
 * no binary #2065 payload for `/api/records` to decode. Everything else in the app already reads the
 * dictionary's field vocabulary, so the text form is mapped onto the same paths here.
 */
export function textRecordFields(
  line: string,
  tables: EdieTables,
): { name: string; head: string[]; fields: Array<{ path: string; token: string; value: number | string }> } | undefined {
  const byName = layoutIndex(tables);
  const record = parseHashLine(line.trim(), byName);
  if (!record || !record.layout) return undefined;
  const fields: Array<{ path: string; token: string; value: number | string }> = [];
  let at = 0;
  const walk = (list: EdieSegment[], prefix: string): void => {
    for (const segment of list) {
      if (at >= record.body.length) return;
      const path = prefix ? `${prefix}.${segment.name}` : segment.name;
      if (segment.kind === 'array') {
        const array = segment as EdieArray;
        let count = array.fixedCount ?? 0;
        if (array.countSize) count = Number(record.body[at++] ?? '0');
        const format = String(array.format ?? '');
        if (format === '%P' || format === '%Z') {
          at += 1; // one token however many elements it stands for
          continue;
        }
        for (let i = 0; i < count && at < record.body.length; i++) walk(array.elements, `${path}[${i}]`);
        continue;
      }
      const token = record.body[at++] ?? '';
      if (segment.kind === 'string') {
        fields.push({ path, token, value: unquote(token) });
        continue;
      }
      fields.push({ path, token, value: parseToken(segment as EdieScalar, token, tables) });
    }
  };
  walk(record.layout.fields, '');
  return { name: record.name, head: record.head, fields };
}

export function encodeHashLog(record: HashRecord, tables: EdieTables): string | undefined {
  const body: string[] = [];
  // An embedded ASCII message (`RXCONFIG`'s payload) is parsed and printed again, `#` and its own
  // CRC included: the suite's line is `#RXCONFIGA,<head>;#LOGA,<head>;<body>*<inner crc>*<outer crc>`,
  // and a blob it cannot resolve drops the whole record.
  if (rawBodyLayout(record.layout)) {
    const inner = encodeEmbeddedAscii(record.rawBody, layoutIndex(tables), tables);
    if (inner === undefined) return undefined;
    body.push(inner);
  } else if (record.layout && !renderBody(record.layout.fields, record.body, tables, body)) return undefined;
  else if (!record.layout) body.push(...record.body);
  const sentence = `${record.rawName},${record.head.join(',')};${body.join(',')}`;
  return `#${sentence}*${hex8(novatelCrc32(latin1Bytes(sentence)))}`;
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
  const byName = layoutIndex(tables);
  const names = new Set(byName.keys());
  const lines = new Map<number, string[]>();

  for (const [index, record] of collectTextLogs(frames, tables)) {
    // A `<` record with only its header prints nothing (see `textLogLines`).
    if (record.tokens.length <= 9) continue;
    const layout = byName.get(record.name);
    if (layout) {
      const lines_ = abbrevFromTokens(record, layout, tables);
      if (lines_) lines.set(index, lines_);
    }
  }
  frames.forEach((frame, index) => {
    if (frame.kind !== 'text') return;
    if (frame.prefix === '#') {
      const line = passThroughAscii(frame.text, names);
      if (line === undefined) return;
      const record = parseHashLine(line, byName);
      if (record?.layout && rawBodyLayout(record.layout)) {
        const block = embeddedAbbrevBlock(record, byName, tables);
        if (block) lines.set(index, block);
        return;
      }
      if (record?.layout) {
        const blocks = abbrevFromTokens(
          { index, name: record.name, tokens: [...record.head, ...record.body] },
          record.layout,
          tables,
          true,
        );
        if (blocks) lines.set(index, blocks);
      }
      return;
    }
    if (frame.prefix === '$') {
      const line = passThroughNmea(frame.text);
      if (line !== undefined) lines.set(index, [line]);
    }
  });
  return lines;
}

/**
 * The ABBREV block for a record whose body is an embedded ASCII message (`RXCONFIG`'s payload).
 *
 * Measured on `b7-20261101.sbf` (247 blocks):
 *
 *   `<RXCONFIG USB2 10 76.5 COARSESTEERING 2442 553862.246 03809800 f702 18278`
 *   `<     LOG USB2 10 76.5 COARSESTEERING 2442 553862.246 03809800 92b2 18278 `
 *   `<     USB1_30 ITPSDDETECTB ONNEW 0.000000 0.000000 HOLD`
 *
 * — the outer header, then the embedded message's own header as a data line at the **five**-space
 * indent (its version letter dropped, like every other ABBREV name, and its header re-rendered), then
 * its values laid out exactly like any other ABBREV body: one line for the scalar fields and one
 * **nine**-space line per array element, which is why 244 of the 247 blocks are three lines and the
 * rest longer (`SETTIMESOURCE` prints `3` and three sources, `DNSCONFIG` one address).
 *
 * Every line but the block's last carries one trailing space, the same rule `formatAbbrev` follows.
 */
function embeddedAbbrevBlock(
  record: HashRecord,
  byName: Map<string, EdieLayout>,
  tables: EdieTables,
): string[] | undefined {
  const inner = parseEmbeddedRecord(record.rawBody, byName);
  if (!inner || inner.body.length === 0) return undefined;
  const first: string[] = [];
  const blocks: string[][] = [];
  walkAbbrev(inner.layout.fields, inner.body, tables, first, blocks);
  const lines = [
    `<${record.name} ${record.head.join(' ')}`,
    `<     ${inner.name} ${inner.head.join(' ')}`,
    `<    ${first.length ? ` ${first.join(' ')}` : ''}`,
    ...blocks.map((block) => `<         ${block.length ? ` ${block.join(' ')}` : ''}`),
  ];
  // The outer header ends the line; every line after it but the last carries one trailing space.
  return lines.map((line, index) => (index === 0 || index === lines.length - 1 ? line : `${line} `));
}

function abbrevFromTokens(
  record: TextLogRecord,
  layout: EdieLayout,
  tables: EdieTables,
  requireComplete = false,
): string[] | undefined {
  const head = record.tokens.slice(0, 9);
  const body = record.tokens.slice(9);
  const first: string[] = [];
  const blocks: string[][] = [];
  const complete = walkAbbrev(layout.fields, body, tables, first, blocks);
  // A `#` record whose body runs out of tokens is dropped whole, exactly as in ASCII output (the
  // suite prints nothing for it — see `encodeHashLog`). A `<` record keeps the lenient reading,
  // because no capture carries a truncated one.
  if (requireComplete && !complete) return undefined;
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
): boolean {
  let at = 0;
  let complete = true;
  for (const segment of segments) {
    if (segment.kind !== 'array') {
      if (at >= tokens.length) {
        complete = false;
        return complete;
      }
      at = walkElement([segment], tokens, at, tables, first);
      continue;
    }
    const array = segment as EdieArray;
    if (array.countSize) {
      if (at >= tokens.length) {
        complete = false;
        return complete;
      }
      const count = Number(tokens[at++] ?? '0');
      if (!Number.isFinite(count)) continue;
      first.push(String(count));
      // A `%P` payload or a `%Z` byte array is one token on this line, no element lines — the same
      // shape the binary writer produces (`USERCANDATA … 3 deadbe …`, and `… 0  7 …` for an empty
      // one, where the empty token leaves the two spaces around it).
      const format = String(array.format ?? '');
      if (format === '%P' || format === '%Z') {
        if (at < tokens.length) {
          const token = tokens[at++] ?? '';
          first.push(format === '%Z' ? token.toLowerCase().slice(0, Math.max(0, count) * 2) : token);
        } else complete = false;
        continue;
      }
      // Only a `FIELD_ARRAY` breaks after its count. A counted array of **scalars** stays on the
      // data line, exactly like the binary writer's `variable`/`fixed` kinds: measured on
      // `b7-20261101.sbf`, whose `#ITPSDFINALA` carries 1024 `samples` and whose suite ABBREV block
      // is one `<ITPSDFINAL ��` line plus one data line holding all 1024 values
      // (`golden-b7-20261101.ABBREV_ASCII`). One element line per sample would be 1024 lines.
      const arrayKind = array.arrayKind ?? 'field';
      if (arrayKind !== 'field') {
        for (let i = 0; i < count; i++) {
          if (at >= tokens.length) {
            complete = false;
            break;
          }
          at = walkElement(array.elements, tokens, at, tables, first);
        }
        continue;
      }
      // `max(1, count)`: a zero-element array still prints one (empty) element line.
      for (let i = 0; i < Math.max(1, count); i++) {
        const block: string[] = [];
        if (at < tokens.length) {
          at = walkElement(array.elements, tokens, at, tables, block);
        } else if (i < count) {
          // The count promises an element the record does not carry. (For `count === 0` the empty
          // line is the record's own shape, not a truncation.)
          complete = false;
          if (i > 0) break;
        }
        blocks.push(block);
      }
    } else {
      for (let i = 0; i < (array.fixedCount ?? 0) && at < tokens.length; i++) {
        at = walkElement(array.elements, tokens, at, tables, first);
      }
    }
  }
  return complete;
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
      // reversible, and a `%P` record in text input has never been observed. A `%Z` byte array is
      // one token too, printed lowercase like the binary writer's.
      const format = String(segment.format ?? '');
      out.push(format === '%Z' ? token.toLowerCase() : token);
      continue;
    }
    out.push(renderScalar(segment as EdieScalar, token, tables));
  }
  return at;
}
/**
 * The ASCII lines for a whole capture, in frame order: one entry per frame index that produces
 * output (binary frames are not included — `convert.ts` already handles those).
 *
 * A `<` record with nothing but its header prints nothing — no line, not even an empty body.
 * Measured: `<BESTPOS COM1 0 72.0 FINESTEERING 2402 577759.000 03800800 cdba 18278\r\n` followed by
 * another `<` header produced no output at all through the suite's Convert, where printing the
 * record would have written `#BESTPOSA,…;*crc`. (No capture we have carries such a record; the
 * receiver always follows a header with its data line.)
 */
export function textLogLines(frames: readonly Frame[], tables: EdieTables): Map<number, string> {
  const byName = layoutIndex(tables);
  const names = new Set(byName.keys());
  const lines = new Map<number, string>();
  for (const [index, record] of collectTextLogs(frames, tables)) {
    // Header only (`record.tokens` is exactly the nine header fields): nothing to print.
    if (record.tokens.length <= 9) continue;
    lines.set(index, encodeTextLog(record, byName.get(record.name), tables));
  }
  frames.forEach((frame, index) => {
    if (frame.kind !== 'text') return;
    if (frame.prefix === '#') {
      const line = passThroughAscii(frame.text, names);
      if (line === undefined) return;
      const record = parseHashLine(line, byName);
      const rendered = record ? encodeHashLog(record, tables) : undefined;
      if (rendered !== undefined) lines.set(index, rendered);
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
