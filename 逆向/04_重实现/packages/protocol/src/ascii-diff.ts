/**
 * Differential check: decode an SBF capture with the EDIE layouts and compare, field by field,
 * against the ASCII file the original suite produced from the same bytes.
 *
 * The comparison is the acceptance gate for the decode side of "1:1 还原": `samples/convert/
 * golden-broad-ascii` is the suite's own output for `broad-clean.gps`, so a mismatch is our bug.
 *
 * Rules (see `03_分析/06_Graph应用.md` and the `edie.ts` header for the layout model):
 *  - one ASCII line per log record, every repeated block flattened, count printed first — exactly
 *    what `decodeEdie` returns;
 *  - textual renderings (enum names, `%08x`, `%02XB`, `%UB`, `TRUE`/`FALSE`, `%s`, `%Z`) are compared
 *    as strings against the same tables the suite used;
 *  - floating point is compared at the printed precision (half a unit in the last printed place),
 *    because ASCII is a decimal rendering of a binary value.
 */

import { SbfDeframer } from './framing.ts';
import { decodeEdie, type EdieTables, type EdieValue } from './edie.ts';

export interface AsciiLine {
  name: string;
  week: number;
  ms: number;
  body: string[];
}

export interface MessageDiff {
  name: string;
  lines: number;
  fields: number;
  ok: number;
  bad: number;
  /** Lines whose field count differs from ours (wrong layout shape, not a value error). */
  shape: number;
  samples: string[];
}

export interface DiffResult {
  messages: MessageDiff[];
  fields: number;
  ok: number;
  bad: number;
  matches: boolean;
}

/** Split on commas, keeping quoted segments intact (NovAtel ASCII quotes strings). */
export function splitCsv(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) {
      out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

export function parseAsciiLog(text: string): AsciiLine[] {
  const lines: AsciiLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.startsWith('#')) continue;
    const noCrc = line.replace(/\*[0-9a-fA-F]{8}$/, '');
    const semicolon = noCrc.indexOf(';');
    if (semicolon === -1) continue;
    const head = splitCsv(noCrc.slice(1, semicolon));
    const name = (head[0] ?? '').replace(/A$/, '').toUpperCase();
    const week = Number(head[5]);
    const ms = Number(head[6]);
    if (!name || !Number.isFinite(ms)) continue;
    lines.push({ name, week, ms, body: splitCsv(noCrc.slice(semicolon + 1)) });
  }
  return lines;
}

const DECIMAL = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function numbersClose(a: number, b: number, tolerance: number): boolean {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff / scale <= tolerance || diff <= tolerance;
}

export function matchesAscii(asciiRaw: string, decoded: EdieValue | undefined, tolerance = 1e-9): boolean {
  if (!decoded) return false;
  const ascii = asciiRaw.trim().replace(/^"|"$/g, '');
  const { value, text } = decoded;
  if (text !== undefined) return ascii === text;
  if (typeof value !== 'number') return ascii === String(value);
  if (ascii === 'TRUE' || ascii === 'FALSE') return (ascii === 'TRUE') === (value !== 0);
  if (!DECIMAL.test(ascii)) return false;
  const decimals = (ascii.split('.')[1] ?? '').split(/[eE]/)[0].length;
  const printed = 0.5 * Math.pow(10, -decimals);
  return Math.abs(Number(ascii) - value) <= printed + Math.abs(value) * tolerance;
}

export interface DiffOptions {
  tolerance?: number;
  /** Include at most this many example differences per message. */
  sampleLimit?: number;
  /** Only these message names (upper case). */
  only?: Set<string>;
}

/** Compare every ASCII line against the capture that produced it. */
export function diffAscii(
  asciiText: string,
  capture: Uint8Array,
  tables: EdieTables,
  options: DiffOptions = {},
): DiffResult {
  const tolerance = options.tolerance ?? 1e-9;
  const sampleLimit = options.sampleLimit ?? 4;

  const idsByName = new Map<string, string[]>();
  for (const [id, layout] of Object.entries(tables.messages)) {
    const name = layout.name.toUpperCase();
    const list = idsByName.get(name) ?? [];
    list.push(id);
    idsByName.set(name, list);
  }

  // name@week:ms -> decoded records of that log name, in capture order. Several records can share a
  // key (one RAWEPHEM per satellite), and the ASCII file prints them in the same order, so records
  // are aligned by index within the key rather than by taking the first one.
  const decoded = new Map<string, Array<{ id: string; values: EdieValue[] }>>();
  for (const frame of new SbfDeframer({ crcMode: 'mirror' }).push(capture)) {
    if (frame.kind !== 'sbf') continue;
    const id = String(frame.header.messageId);
    const layout = tables.messages[id];
    if (!layout) continue;
    const key = `${layout.name.toUpperCase()}@${frame.header.week}:${(frame.header.milliseconds / 1000).toFixed(3)}`;
    const list = decoded.get(key) ?? [];
    list.push({ id, values: decodeEdie(frame.payload, layout, tables) });
    decoded.set(key, list);
  }

  const linesByKey = new Map<string, AsciiLine[]>();
  for (const line of parseAsciiLog(asciiText)) {
    if (options.only?.size && !options.only.has(line.name)) continue;
    const key = `${line.name}@${line.week}:${line.ms.toFixed(3)}`;
    const list = linesByKey.get(key) ?? [];
    list.push(line);
    linesByKey.set(key, list);
  }

  const byMessage = new Map<string, MessageDiff>();
  let totalFields = 0;
  let totalOk = 0;

  for (const [key, keyLines] of linesByKey) {
    const records = decoded.get(key) ?? [];
    let seen = 0;
    for (const line of keyLines) {
      const row = byMessage.get(line.name) ?? { name: line.name, lines: 0, fields: 0, ok: 0, bad: 0, shape: 0, samples: [] };
      byMessage.set(line.name, row);
      // Records of this log name, in capture order; the n-th ASCII line uses the n-th record.
      const candidates = records.filter((record) => tables.messages[record.id]?.name.toUpperCase() === line.name);
      let values = candidates[seen]?.values;
      seen += 1;
      if (!values) {
        if (row.samples.length < sampleLimit) row.samples.push(`${key}: capture has fewer frames of this log than ASCII lines`);
        continue;
      }
      // Same name, several layout variants: prefer the one whose printed field count matches.
      if (values.length !== line.body.length) {
        const alternative = candidates.find((record) => record.values.length === line.body.length);
        if (alternative) values = alternative.values;
      }
      row.lines += 1;
      if (values.length !== line.body.length) {
        row.shape += 1;
        if (row.samples.length < sampleLimit) row.samples.push(`${key}: ascii ${line.body.length} fields, we decode ${values.length}`);
      }
      const shared = Math.min(values.length, line.body.length);
      for (let i = 0; i < shared; i++) {
        row.fields += 1;
        totalFields += 1;
        if (matchesAscii(line.body[i], values[i], tolerance)) {
          row.ok += 1;
          totalOk += 1;
        } else {
          row.bad += 1;
          if (row.samples.length < sampleLimit) {
            row.samples.push(`#${i} ${values[i].path}: ascii="${line.body[i]}" ours="${values[i].text ?? String(values[i].value)}"`);
          }
        }
      }
    }
  }

  const messages = [...byMessage.values()].sort((a, b) => b.fields - a.fields);
  return { messages, fields: totalFields, ok: totalOk, bad: totalFields - totalOk, matches: totalOk === totalFields };
}
