/**
 * Text logs: a capture can carry the receiver's **ASCII** output next to the binary frames, and the
 * suite's Convert accepts both. This module reproduces that half.
 *
 * Three shapes reach us from the de-framer (`framing.ts` already emits every text line as its own
 * frame, one per 0x0A):
 *
 *  1. `<NAME port seq idle timeStatus week ms rxStatus msgDefCrc swVersion` — the *header* of an
 *     abbreviated-ASCII log. The body follows on the next lines, one per repeated block.
 *  2. `<` + fields — continuation lines: `<     73 `, `<               4 0 20229880.713 …`,
 *     `<     SOL_COMPUTED SINGLE …`, `<     GPS TRUE TRUE 32`. Only the leading `<` marks them.
 *  3. `#NAME,…;…*crc` — a **complete** ASCII log, CRC included. The suite copies it out untouched
 *     (all 11 such lines in `samples/live-20261031/live-nav.sbf` appear verbatim in the golden).
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
 *  - `%` short ASCII and `$` NMEA records: no sample exists, and the suite's handling is unmeasured.
 *  - `<OK`, `<ERROR`, `<` (empty) are command *responses*, not logs; they close the current record
 *    and produce no line. `<OK` appears 8× in `remote-23types.sbf` and the golden has 0 lines for it.
 */

import { novatelCrc32 } from './crc.ts';
import { formatField } from './ascii-log.ts';
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
        for (let i = 0; i < count && at < tokens.length; i++) walk(array.elements);
        continue;
      }
      const token = tokens[at++];
      if (segment.kind === 'string') {
        out.push(`"${unquote(token)}"`);
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
  const crc = novatelCrc32(new TextEncoder().encode(sentence)).toString(16).padStart(8, '0');
  return `#${sentence}*${crc}`;
}

/** A `#NAME,…*crc` text record, ready to copy out; `undefined` when the line is not a whole log. */
export function passThroughAscii(text: string): string | undefined {
  const line = text.replace(/[\r\n]+$/, '');
  return /^#[A-Z][A-Z0-9_]*,.*\*[0-9a-fA-F]{8}$/.test(line) ? line : undefined;
}

/**
 * The ASCII lines for a whole capture, in frame order: one entry per frame index that produces
 * output (binary frames are not included — `convert.ts` already handles those).
 */
export function textLogLines(frames: readonly Frame[], tables: EdieTables): Map<number, string> {
  const byName = new Map<string, EdieLayout>();
  for (const layout of Object.values(tables.messages)) byName.set(layout.name, layout);
  const lines = new Map<number, string>();
  for (const [index, record] of collectTextLogs(frames, tables)) {
    lines.set(index, encodeTextLog(record, byName.get(record.name), tables));
  }
  frames.forEach((frame, index) => {
    if (frame.kind !== 'text' || frame.prefix !== '#') return;
    const line = passThroughAscii(frame.text);
    if (line !== undefined) lines.set(index, line);
  });
  return lines;
}
