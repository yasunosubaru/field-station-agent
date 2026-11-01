/**
 * Ask the suite's own Convert what "unknown bytes" are, and keep its answer.
 *
 *   node 逆向/tools/suite-unknown.ts <capture.sbf> [--mode file|interleave|ignore|default]
 *                                    [--format abbrev|ascii|binary] [--keep <dir>] [--dump]
 *
 * `--unknown-bytes=file` (the CLI's spelling of the GUI's `SEPARATEFILE`, `cli.js:161-164`) makes
 * Convert write the bytes it could not attribute to a log into `<base>.UNKNOWN` next to the
 * converted file. `interleave` folds them into the output instead; anything else (`ignore`, or no
 * flag at all) is `SKIP`: they are counted and thrown away.
 *
 * The suite only converts when both the input and the output path are pure ASCII with no spaces
 * (see `oracle.ts`), so the capture is copied into the temp root first.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

export const SUITE = 'C:\\Program Files\\NovAtel Inc\\NovAtel Application Suite\\NovAtelApplicationSuite.exe';
export const TEMP_ROOT = 'C:\\Users\\SunCh\\AppData\\Local\\Temp\\opencode';

export type UnknownMode = 'file' | 'interleave' | 'ignore' | 'default';

export interface SuiteUnknownResult {
  /** `<base>.UNKNOWN`, or null when the suite wrote none. */
  unknown: Uint8Array | null;
  /** Every file name the suite wrote in the format directory. */
  files: string[];
  /** The converted file itself (the first non-`.UNKNOWN` file). */
  output: Uint8Array | null;
}

const FORMAT_FLAG: Record<string, string> = { abbrev: '--abbrev', ascii: '-a', binary: '-b' };

/** Run the suite on one capture and hand back what it wrote. */
export function suiteConvert(
  capture: string,
  mode: UnknownMode = 'default',
  format: keyof typeof FORMAT_FLAG = 'abbrev',
  keep?: string,
): SuiteUnknownResult {
  const dir = mkdtempSync(join(TEMP_ROOT, 'suite-unknown-'));
  try {
    const input = join(dir, basename(capture).replace(/[^A-Za-z0-9_.-]/g, '_'));
    copyFileSync(capture, input);
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    const args = [FORMAT_FLAG[format], '-o', out, input];
    if (mode !== 'default') args.push(`--unknown-bytes=${mode}`);
    execFileSync(SUITE, args, { stdio: 'pipe', timeout: 300_000 });
    const stem = readdirSync(out)[0];
    if (!stem) return { unknown: null, files: [], output: null };
    const stamp = readdirSync(join(out, stem))[0];
    const formatDir = join(out, stem, stamp, format === 'abbrev' ? 'ABBREV_ASCII' : format === 'ascii' ? 'ASCII' : 'BINARY');
    const files = readdirSync(formatDir);
    const unknownName = files.find((name) => name.toUpperCase().endsWith('.UNKNOWN'));
    const outputName = files.find((name) => !name.toUpperCase().endsWith('.UNKNOWN'));
    const unknown = unknownName ? new Uint8Array(readFileSync(join(formatDir, unknownName))) : null;
    const output = outputName ? new Uint8Array(readFileSync(join(formatDir, outputName))) : null;
    if (keep && unknown) writeFileSync(join(keep, `${basename(capture, extname(capture))}.UNKNOWN`), unknown);
    return { unknown, files, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  let mode: UnknownMode = 'file';
  let format: keyof typeof FORMAT_FLAG = 'abbrev';
  let keep: string | undefined;
  let dump = false;
  const inputs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--mode') mode = argv[++i] as UnknownMode;
    else if (token === '--format') format = argv[++i] as keyof typeof FORMAT_FLAG;
    else if (token === '--keep') keep = argv[++i];
    else if (token === '--dump') dump = true;
    else if (!token.startsWith('-')) inputs.push(token);
  }
  if (!inputs.length) {
    console.error('usage: suite-unknown.ts <capture...> [--mode file|interleave|ignore|default] [--format abbrev|ascii|binary] [--keep <dir>] [--dump]');
    process.exit(2);
  }
  for (const input of inputs) {
    const stem = basename(input, extname(input));
    const result = suiteConvert(input, mode, format, keep);
    console.log(`${stem}  mode=${mode} format=${format}  files=[${result.files.join(', ')}]  UNKNOWN=${result.unknown ? `${result.unknown.length} B` : 'none'}`);
    if (dump && result.unknown) {
      const text = Buffer.from(result.unknown).toString('latin1');
      console.log(JSON.stringify(text));
    }
  }
}

if (process.argv[1]?.endsWith('suite-unknown.ts')) main();
