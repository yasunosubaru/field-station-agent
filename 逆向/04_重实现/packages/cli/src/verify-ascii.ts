/**
 * Field-level differential test: our decoder vs the original suite's ASCII output.
 *
 *   node packages/cli/src/verify-ascii.ts <golden.ASCII> <capture.bin> [--repeat] [--tolerance 1e-9]
 *
 * Both sides come from the same bytes: the ASCII file is what `NovAtelApplicationSuite.exe -a`
 * produced from the capture, so any difference is our decoding, not the data.
 *
 * Comparison rules:
 *  - numbers: relative tolerance (default 1e-9); the ASCII side is a decimal rendering, so exact
 *    equality is not meaningful;
 *  - enumerations: compared by name (`SOL_COMPUTED`), which is what both sides print;
 *  - strings: compared after stripping the surrounding quotes;
 *  - repeated-block messages (RANGE / TRACKSTAT / SATVIS2) need `--repeat`: the ASCII file prints
 *    one line per block, so blocks are aligned by index.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SbfDeframer } from '../../protocol/src/framing.ts';
import { decodeMessage, decodeRepeated, type RichSpec } from '../../protocol/src/decode.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '..', '..', 'protocol', 'data');

interface Args {
  ascii: string;
  capture: string;
  tolerance: number;
  repeat: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { ascii: '', capture: '', tolerance: 1e-9, repeat: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--tolerance') out.tolerance = Number(argv[++i]);
    else if (token === '--repeat') out.repeat = true;
    else if (token === '--verbose') out.verbose = true;
    else if (!token.startsWith('--')) {
      if (!out.ascii) out.ascii = token;
      else out.capture = token;
    }
  }
  return out;
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(DATA, name), 'utf8')) as T;
}

/** Split on commas, keeping quoted segments intact (NovAtel ASCII quotes strings). */
function splitCsv(text: string): string[] {
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

interface AsciiLine {
  name: string;
  week: number;
  ms: number;
  body: string[];
}

function parseAscii(text: string): Map<string, AsciiLine[]> {
  const groups = new Map<string, AsciiLine[]>();
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
    const key = `${name}@${week}:${ms.toFixed(3)}`;
    const list = groups.get(key) ?? [];
    list.push({ name, week, ms, body: splitCsv(noCrc.slice(semicolon + 1)) });
    groups.set(key, list);
  }
  return groups;
}

function isNumberText(value: string): boolean {
  return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value.trim());
}

function numbersClose(a: number, b: number, tolerance: number): boolean {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return diff / scale <= tolerance || diff <= tolerance;
}

function compareValue(asciiRaw: string, ours: unknown, tolerance: number): { ok: boolean; a: string; b: string } {
  const ascii = asciiRaw.trim().replace(/^"|"$/g, '');
  if (ours === undefined || ours === null) return { ok: false, a: ascii, b: 'undefined' };
  if (typeof ours === 'number') {
    if (ascii === 'TRUE' || ascii === 'FALSE') return { ok: (ascii === 'TRUE') === (ours !== 0), a: ascii, b: String(ours) };
    if (!isNumberText(ascii)) return { ok: false, a: ascii, b: String(ours) };
    // The ASCII file prints the log's native precision (e.g. 75.6 for a 0.1° field), so the only
    // fair comparison is "rounds to the same text": half a unit in the last printed place.
    const decimals = (ascii.split('.')[1] ?? '').length;
    const printed = 0.5 * Math.pow(10, -decimals);
    const diff = Math.abs(Number(ascii) - ours);
    const ok = diff <= printed + Math.abs(ours) * tolerance;
    return { ok, a: ascii, b: String(ours) };
  }
  if (typeof ours === 'boolean') return { ok: (ascii === 'TRUE') === ours, a: ascii, b: String(ours) };
  const expected = String(ours).replace(/^"|"$/g, '');
  if (isNumberText(ascii) && /^[-+]?\d+(\.\d+)?$/.test(expected)) {
    return { ok: numbersClose(Number(ascii), Number(expected), tolerance), a: ascii, b: expected };
  }
  return { ok: ascii === expected, a: ascii, b: expected };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ascii || !args.capture) {
    console.error('usage: verify-ascii.ts <golden.ASCII> <capture.bin> [--repeat] [--tolerance N] [--verbose]');
    process.exit(2);
  }

  const specs = readJson<Record<string, RichSpec>>('message-specs.json');
  const messageIdByName = new Map<string, number>();
  for (const [id, spec] of Object.entries(specs)) messageIdByName.set(spec.name.toUpperCase(), Number(id));

  const asciiGroups = parseAscii(readFileSync(args.ascii, 'utf8'));

  const bytes = readFileSync(args.capture);
  const deframer = new SbfDeframer({ crcMode: 'mirror' });
  const ourGroups = new Map<string, Array<{ fields: Record<string, unknown>; blocks?: Array<Record<string, unknown>> }>>();
  for (const frame of deframer.push(new Uint8Array(bytes))) {
    if (frame.kind !== 'sbf') continue;
    const id = frame.header.messageId;
    const spec = specs[String(id)];
    if (!spec) continue;
    const name = spec.name.toUpperCase();
    // SBF stores milliseconds of week; the ASCII header prints seconds with three decimals.
    const key = `${name}@${frame.header.week}:${(frame.header.milliseconds / 1000).toFixed(3)}`;
    const entry = spec.repeat && args.repeat
      ? (() => {
          const layouts = readJson<Record<string, unknown>>('repeat-layouts.json');
          const layout = layouts[String(id)];
          if (!layout) return { fields: decodeMessage(frame.payload, spec), blocks: undefined };
          const repeated = decodeRepeated(frame.payload, spec, layout as never);
          return { fields: repeated.header, blocks: repeated.blocks };
        })()
      : { fields: decodeMessage(frame.payload, spec), blocks: undefined };
    const list = ourGroups.get(key) ?? [];
    list.push(entry);
    ourGroups.set(key, list);
  }

  const perMessage = new Map<string, { fields: number; ok: number; lines: number; missing: number }>();
  const failures: string[] = [];
  let comparedLines = 0;
  let missingLines = 0;

  for (const [key, lines] of asciiGroups) {
    const name = lines[0].name;
    const stats = perMessage.get(name) ?? { fields: 0, ok: 0, lines: 0, missing: 0 };
    const ours = ourGroups.get(key) ?? [];
    const blocks = ours[0]?.blocks;
    for (let i = 0; i < lines.length; i++) {
      const id = messageIdByName.get(name);
      const spec = id === undefined ? undefined : specs[String(id)];
      if (!spec) continue;
      const values = blocks?.[i] ?? (i === 0 ? ours[0]?.fields : undefined);
      if (!values) {
        stats.missing += 1;
        missingLines += 1;
        if (args.verbose) failures.push(`${name} ${key}: ASCII 侧有第 ${i} 行，我们这边没有对应块`);
        continue;
      }
      const fieldNames = Object.keys(spec.fields);
      let lineOk = 0;
      for (let f = 0; f < Math.min(fieldNames.length, lines[i].body.length); f++) {
        const field = fieldNames[f];
        const spec2 = spec.fields[field] as { type?: string } | undefined;
        const asciiText = lines[i].body[f];
        // HEX fields print as zero-padded hex in ASCII while we keep the integer.
        const hexCompare = spec2?.type === 'HEX' && /^[0-9a-fA-F]+$/.test(asciiText.trim()) && typeof values[field] === 'number'
          ? { ok: parseInt(asciiText.trim(), 16) === values[field], a: asciiText, b: String(values[field]) }
          : null;
        const result = hexCompare ?? compareValue(asciiText, values[field], args.tolerance);
        stats.fields += 1;
        if (result.ok) { stats.ok += 1; lineOk += 1; }
        else {
          failures.push(`${name} ${key} #${i} ${field}: ascii="${result.a}" ours="${result.b}"`);
        }
      }
      stats.lines += 1;
      comparedLines += 1;
      void lineOk;
    }
    perMessage.set(name, stats);
  }

  const totalFields = [...perMessage.values()].reduce((n, s) => n + s.fields, 0);
  const totalOk = [...perMessage.values()].reduce((n, s) => n + s.ok, 0);
  console.log('message            lines  fields     ok   miss   ok%');
  for (const [name, s] of [...perMessage.entries()].sort((a, b) => b[1].lines - a[1].lines)) {
    const pct = s.fields ? ((s.ok / s.fields) * 100).toFixed(2) : '  -  ';
    console.log(`${name.padEnd(18)} ${String(s.lines).padStart(6)} ${String(s.fields).padStart(7)} ${String(s.ok).padStart(6)} ${String(s.missing).padStart(6)} ${pct.padStart(7)}`);
  }
  console.log('-'.repeat(58));
  console.log(`compared lines: ${comparedLines}   missing blocks: ${missingLines}`);
  console.log(`fields: ${totalOk}/${totalFields} matched  (${totalFields ? ((totalOk / totalFields) * 100).toFixed(2) : '0'}%)`);
  if (failures.length) {
    console.log(`\nfirst ${Math.min(failures.length, 25)} differences:`);
    for (const line of failures.slice(0, 25)) console.log('  ' + line);
  }
  process.exit(totalOk === totalFields ? 0 : 1);
}

main();
