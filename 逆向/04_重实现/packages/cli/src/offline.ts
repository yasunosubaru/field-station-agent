/**
 * Decode a raw capture (serial/USB/TCP bytes) with the reimplemented protocol layer.
 *
 *   node packages/cli/src/offline.ts <capture.bin> [--limit 5] [--crc validate|mirror|ignore] [--json]
 *
 * Why it exists: the Playback component and the real-machine verification both need "bytes on
 * disk → frames → decoded logs", and neither should have to spin up a transport. Point it at a
 * file captured from COM7/COM8/COM9 (NovAtel USB virtual ports) or at a `.gps` log to see exactly
 * what the receiver sent.
 *
 * Fidelity: the deframer is the same `SbfDeframer` the session uses, so `crcMode` keeps the
 * original's "CRC field is 0 → drop, otherwise trust it" behaviour by default (`mirror`).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SbfDeframer } from '../../protocol/src/framing.ts';
import { decodeMessage, decodeRepeated, type RichSpec } from '../../protocol/src/decode.ts';
import type { CrcMode } from '../../protocol/src/framing.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '..', '..', 'protocol', 'data');

interface Args {
  file: string;
  limit: number;
  crc: CrcMode;
  json: boolean;
  fields: string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { file: '', limit: 5, crc: 'mirror', json: false, fields: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--limit') out.limit = Number(argv[++i]);
    else if (token === '--crc') out.crc = argv[++i] as CrcMode;
    else if (token === '--json') out.json = true;
    else if (token === '--fields') out.fields = String(argv[++i]).split(',');
    else if (!token.startsWith('--')) out.file = token;
  }
  return out;
}

function readJson<T>(name: string): T | undefined {
  try {
    return JSON.parse(readFileSync(join(DATA, name), 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error('usage: offline.ts <capture.bin> [--limit N] [--crc mirror|validate|ignore] [--json]');
    process.exit(2);
  }

  const bytes = readFileSync(args.file);
  const specs = readJson<Record<string, RichSpec>>('message-specs.json') ?? {};
  const layouts = readJson<Record<string, unknown>>('repeat-layouts.json') ?? {};
  const names = readJson<Record<string, { Name?: string }>>('msgids.json') ?? {};

  let dropped = 0;
  let droppedBytes = 0;
  const deframer = new SbfDeframer({
    crcMode: args.crc,
    onDrop: (count, reason) => {
      dropped += 1;
      droppedBytes += count;
      if (dropped <= 3) console.error(`drop ${count} B: ${reason}`);
    },
  });

  const frames = deframer.push(new Uint8Array(bytes));
  const histogram = new Map<string, { count: number; bytes: number }>();
  const samples: unknown[] = [];
  let crcBad = 0;

  for (const frame of frames) {
    if (frame.kind === 'text') {
      const key = `text:${frame.prefix}`;
      const hit = histogram.get(key) ?? { count: 0, bytes: 0 };
      hit.count += 1;
      hit.bytes += frame.text.length;
      histogram.set(key, hit);
      continue;
    }
    const id = frame.header.messageId;
    const spec = specs[String(id)];
    const layout = layouts[String(id)] as never;
    const name =
      spec?.name ??
      (names as Record<string, Record<string, { Name?: string }>>)[
        (names as unknown as { aliases?: Record<string, string> }).aliases?.OEM7 ?? 'OEM7'
      ]?.[String(id)]?.Name ??
      `msg${id}`;
    const hit = histogram.get(name) ?? { count: 0, bytes: 0 };
    hit.count += 1;
    hit.bytes += frame.payload.length;
    histogram.set(name, hit);
    if (!frame.crcOk) crcBad += 1;

    if (samples.length < args.limit) {
      const fields = spec && layout ? decodeRepeated(frame.payload, spec, layout).header : spec ? decodeMessage(frame.payload, spec) : {};
      const picked = args.fields.length
        ? Object.fromEntries(args.fields.filter((f) => f in fields || f in (spec ?? {})).map((f) => [f, (fields as never)[f]]))
        : fields;
      samples.push({
        id,
        name,
        bytes: frame.payload.length,
        week: frame.header.week,
        ms: frame.header.milliseconds,
        crcOk: frame.crcOk,
        fields: args.fields.length ? picked : Object.fromEntries(Object.entries(picked).slice(0, 12)),
      });
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ file: args.file, bytes: bytes.length, frames: frames.length, dropped, droppedBytes, crcBad, histogram: [...histogram], samples }, null, 2));
    return;
  }

  console.log(`file      ${args.file}`);
  console.log(`bytes     ${bytes.length}`);
  console.log(`frames    ${frames.length}  (dropped ${dropped} runs / ${droppedBytes} B, crcBad ${crcBad})`);
  console.log('messages  ' + [...histogram.entries()].sort((a, b) => b[1].count - a[1].count)
    .map(([name, hit]) => `${name}×${hit.count}`).join('  '));
  for (const sample of samples as Array<Record<string, unknown>>) {
    console.log(JSON.stringify(sample));
  }
}

main();
