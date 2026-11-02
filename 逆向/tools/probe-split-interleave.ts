/**
 * Gap B/E7-3: `--split` + `--unknown-bytes=interleave` on b2 / b5 / b7.
 *
 * The rule ("`--split` never splices: the junk goes to `<base>_UNKNOWN.<ext>`, byte-identical under
 * `file` and `interleave`, and `ignore` writes no sidecar at all") was measured on b1 only. It is a
 * mode-level rule, but "mode-level" is a claim, so this probe runs the suite on the other three
 * captures (b2 7 056 unknown bytes, b5 565, b7 3 935) and compares **every** file by name, size and
 * SHA-256, in all three formats.
 *
 *   node 逆向/tools/probe-split-interleave.ts [b2|b5|b7 …]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { convertFrames, type ConvertFormat } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import { SUITE, TEMP_ROOT } from './oracle.ts';

const tables = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'),
) as EdieTables;
const live = join(import.meta.dirname, '..', '00_来源', 'samples', 'live-20261031');

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

interface SuiteRun { name: string; bytes: Uint8Array }

function suite(inputPath: string, label: string, flags: string[], base: string): SuiteRun[] {
  const dir = mkdtempSync(join(TEMP_ROOT, `split-logs-${label}-`));
  try {
    // The suite names its output after the input file, so the copy keeps the capture's own name.
    const input = join(dir, `${base}.sbf`);
    writeFileSync(input, readFileSync(inputPath));
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    execFileSync(SUITE, [...flags, '-o', out, input], { stdio: 'pipe', timeout: 300_000 });
    const stem = readdirSync(out)[0];
    const stamp = readdirSync(join(out, stem))[0];
    const root = join(out, stem, stamp);
    const files: SuiteRun[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path)) {
        const full = join(path, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push({ name: entry, bytes: new Uint8Array(readFileSync(full)) });
      }
    };
    walk(root);
    return files
      .filter((file) => !file.name.startsWith('Summary_'))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function ours(inputPath: string, name: string, format: ConvertFormat, unknownBytes: 'file' | 'interleave' | 'ignore') {
  const source = new Uint8Array(readFileSync(inputPath));
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(source)];
  return convertFrames(frames, {
    format, at: new Date('2026-11-01T00:00:00Z'), tables, name: `${name}.sbf`, source,
    splitMode: 'logs', unknownBytes,
  }).files.sort((a, b) => a.name.localeCompare(b.name));
}

const FORMATS: Array<[ConvertFormat, string[]]> = [
  ['ASCII', ['-a']],
  ['ABBREV_ASCII', ['--abbrev']],
  ['BINARY', ['-b']],
];

const names = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const captures = names.length ? names : ['b2-20261101', 'b5-20261101', 'b7-20261101'];

let failures = 0;
for (const requested of captures) {
  const captureName = requested.includes('-') ? requested : `${requested}-20261101`;
  const inputPath = join(live, `${captureName}.sbf`);
  for (const [format, flags] of FORMATS) {
    const label = `${captureName}-${format}`;
    const theirs = suite(inputPath, label, [...flags, '--split', '--unknown-bytes=interleave'], captureName);
    const mine = ours(inputPath, captureName, format, 'interleave');
    const mineByName = new Map(mine.map((file) => [file.name, file.bytes]));
    const theirNames = theirs.map((file) => file.name);
    const sidecarName = `${captureName}_UNKNOWN.${format}`;
    const sidecar = theirs.find((file) => file.name === sidecarName);
    let same = theirNames.length === mine.length;
    const rows: string[] = [];
    for (const file of theirs) {
      const mineBytes = mineByName.get(file.name);
      const ok = mineBytes !== undefined && mineBytes.length === file.bytes.length && sha(mineBytes) === sha(file.bytes);
      if (!ok) same = false;
      rows.push(` ${ok ? '  ' : '!!'} ${file.name.padEnd(34)} ${String(file.bytes.length).padStart(8)} B ${sha(file.bytes).slice(0, 16)}`);
    }
    for (const name of mineByName.keys()) {
      if (!theirNames.includes(name)) { same = false; rows.push(` !! ${name.padEnd(34)} only ours`); }
    }
    if (!same) failures += 1;
    console.log(`\n=== ${captureName} ${format} --split --unknown-bytes=interleave  ${same ? 'SAME' : 'DIFF'}`
      + `  ${theirs.length} suite / ${mine.length} ours, sidecar ${sidecar ? `${sidecar.bytes.length} B` : '(none)'}`);
    for (const row of rows.slice(0, 6)) console.log(row);
    console.log(`  … ${rows.length} files, unknown stream ${sidecar ? sha(sidecar.bytes).slice(0, 16) : '-'}`);

    // `file` must write the same sidecar and never a combined file; `ignore` writes no sidecar.
    const fileRun = suite(inputPath, `${label}-file`, [...flags, '--split', '--unknown-bytes=file'], captureName);
    const fileSidecar = fileRun.find((file) => file.name === sidecarName);
    const ignoreRun = suite(inputPath, `${label}-ignore`, [...flags, '--split', '--unknown-bytes=ignore'], captureName);
    const ignoreSidecar = ignoreRun.some((file) => file.name.includes('_UNKNOWN.'));
    const sidecarSame = sidecar === undefined
      ? fileSidecar === undefined
      : fileSidecar !== undefined && fileSidecar.bytes.length === sidecar.bytes.length
        && sha(fileSidecar.bytes) === sha(sidecar.bytes);
    const plainLogs = suite(inputPath, `${label}-plain`, [...flags, '--split'], captureName);
    const fileLogs = fileRun.filter((file) => file.name !== sidecarName);
    const logsSame = plainLogs.length === fileLogs.length
      && plainLogs.every((file, index) => file.name === fileLogs[index].name && sha(file.bytes) === sha(fileLogs[index].bytes));
    if (!sidecarSame || ignoreSidecar || !logsSame) failures += 1;
    console.log(`  file: sidecar ${fileSidecar ? `${fileSidecar.bytes.length} B ${sha(fileSidecar.bytes).slice(0, 16)}` : '(none)'}`
      + ` same=${sidecarSame}  ignore: sidecar=${ignoreSidecar ? 'yes' : 'no'}  plain==file ${logsSame}`);
  }
}

console.log(failures === 0 ? '\nall split runs match the suite' : `\n${failures} run(s) differ`);
process.exitCode = failures === 0 ? 0 : 1;
