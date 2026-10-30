/**
 * Playback engine CLI.
 *
 *   node packages/cli/src/playback.ts <capture> --info
 *   node packages/cli/src/playback.ts <capture> --export <out.bin> --from 1.0 --to 2.5
 *   node packages/cli/src/playback.ts <capture> --export-ascii <out.log> [--from 1.0] [--to 2.5]
 *
 * `--info` reports the timeline (`PlaybackEngine.info()`): frame count, start/finish in seconds of
 * week, duration and the message distribution. `--export` writes the selected records verbatim
 * (the original snippet writer copies bytes; CRCs are never recomputed). `--from` defaults to 0 and
 * `--to` to the end of the capture; both ends are inclusive.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PlaybackEngine } from '../../playback/src/playback.ts';
import type { EdieTables } from '../../protocol/src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(here, '..', '..', 'protocol', 'data');
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6);
const GPS_WEEK_MS = 604_800_000;
/** Same fixed 18 s leap-second correction the suite applies (`NovatelIdConstants.GPStoUTCcorrection`). */
const GPS_UTC_CORRECTION_MS = 18_000;

interface Args {
  input: string;
  info: boolean;
  exportBinary: string;
  exportAscii: string;
  from: number;
  to: number | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { input: '', info: false, exportBinary: '', exportAscii: '', from: 0, to: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--info' || token === '-i') args.info = true;
    else if (token === '--export' || token === '-e') args.exportBinary = argv[++i] ?? '';
    else if (token === '--export-ascii') args.exportAscii = argv[++i] ?? '';
    else if (token === '--from') args.from = Number(argv[++i]);
    else if (token === '--to') args.to = Number(argv[++i]);
    else if (!token.startsWith('-')) args.input = token;
  }
  return args;
}

function usage(): void {
  console.error('usage: playback.ts <capture> --info');
  console.error('       playback.ts <capture> --export <out.bin> [--from 1.0] [--to 2.5]');
  console.error('       playback.ts <capture> --export-ascii <out.log> [--from 1.0] [--to 2.5]');
}

function utcStamp(week: number, milliseconds: number, offsetMs = 0): string {
  const date = new Date(GPS_EPOCH_MS + week * GPS_WEEK_MS + milliseconds + offsetMs - GPS_UTC_CORRECTION_MS);
  return `${date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')} UTC`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || (!args.info && !args.exportBinary && !args.exportAscii)) {
    usage();
    process.exit(2);
  }
  if (!args.exportBinary && !args.exportAscii && (args.from !== 0 || args.to !== null)) {
    console.error('note: --from/--to only apply to --export / --export-ascii, ignored with --info');
  }

  const inputPath = resolve(args.input);
  const bytes = new Uint8Array(readFileSync(inputPath));
  const tables = JSON.parse(readFileSync(resolve(DATA, 'edie-layouts.json'), 'utf8')) as EdieTables;

  const engine = new PlaybackEngine();
  engine.load(bytes);
  const info = engine.info();
  const from = args.from;
  const to = args.to ?? info.durationMs / 1000;

  if (args.info) {
    const pad = (label: string) => `${label.padEnd(9)}:`;
    console.log(`${pad('file')} ${inputPath} (${bytes.byteLength} bytes)`);
    console.log(
      `${pad('frames')} ${info.frameCount} (dropped ${info.stats.badCrc} bad CRC, ${info.stats.textFrames} text` +
        `${info.stats.bufferedBytes ? `, ${info.stats.bufferedBytes} trailing bytes` : ''})`,
    );
    console.log(
      `${pad('start')} week ${info.startWeek}, ${info.startTime.toFixed(3)} s of week (${utcStamp(info.startWeek, Math.round(info.startTime * 1000))})`,
    );
    console.log(
      `${pad('finish')} week ${info.finishWeek}, ${info.finishTime.toFixed(3)} s of week (${utcStamp(info.finishWeek, Math.round(info.finishTime * 1000))})`,
    );
    console.log(`${pad('duration')} ${(info.durationMs / 1000).toFixed(3)} s (${info.durationMs} ms)`);

    const rows = Object.entries(info.messageCounts)
      .map(([id, count]) => ({ id: Number(id), count, name: tables.messages[id]?.name }))
      .sort((a, b) => b.count - a.count || a.id - b.id);
    const width = Math.max(6, ...rows.map((row) => (row.name ?? '').length));
    console.log(`${pad('messages')} ${rows.length} distinct`);
    for (const row of rows) {
      const name = (row.name ?? 'UNKNOWN').padEnd(width);
      console.log(`         ${String(row.id).padStart(5)}  ${name}  x${row.count}`);
    }
  }

  if (args.exportBinary) {
    const exported = engine.exportRange(from, to);
    const outPath = resolve(args.exportBinary);
    writeFileSync(outPath, exported);
    const selected = engine.range(from, to);
    console.log(
      `exported : ${outPath} (${statSync(outPath).size} bytes, ${selected.frameCount} frames, ` +
        `${from.toFixed(3)}–${to.toFixed(3)} s)`,
    );
  }

  if (args.exportAscii) {
    const text = engine.exportAscii(from, to, tables);
    const outPath = resolve(args.exportAscii);
    writeFileSync(outPath, text);
    const selected = engine.range(from, to);
    const lines = text ? text.split('\r\n').length - 1 : 0;
    console.log(
      `ascii    : ${outPath} (${statSync(outPath).size} bytes, ${lines} lines, ${selected.frameCount} frames in range, ` +
        `${from.toFixed(3)}–${to.toFixed(3)} s)`,
    );
  }
}

main();
