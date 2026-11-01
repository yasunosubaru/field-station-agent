/**
 * `--daily-utc` on every capture in the tree: the suite's parts against ours, by name and byte.
 *
 *   node 逆向/tools/probe-daily-regress.ts [--only b7] [--format ascii|abbrev]
 *
 * The suite is run fresh each time (it is the oracle); the parts are compared byte for byte, so a
 * part count that agrees but a cut in the wrong place still fails. Every capture except b7 is a
 * regression guard: the rule that fixes b7's three parts must not move the others.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { convertFrames, type ConvertSplitMode } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';
import { SUITE, TEMP_ROOT } from './oracle.ts';

const tables: EdieTables = JSON.parse(readFileSync(
  join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'),
  'utf8',
));

const SAMPLES = join(import.meta.dirname, '..', '00_来源', 'samples');
const captures = [
  'live-20261031/b1-20261101.sbf', 'live-20261031/b2-20261101.sbf', 'live-20261031/b3-20261101.sbf',
  'live-20261031/b4-20261101.sbf', 'live-20261031/b5-20261101.sbf', 'live-20261031/b6-20261101.sbf',
  'live-20261031/b7-20261101.sbf', 'live-20261031/live-nav.sbf', 'live-20261031/live-nav2.sbf',
  'live-20261031/remote-23types.sbf',
].map((name) => join(SAMPLES, ...name.split('/')));

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '';
const format = argv.includes('--format') ? argv[argv.indexOf('--format') + 1] : 'ascii';
const FORMAT = format === 'abbrev' ? 'ABBREV_ASCII' : 'ASCII';
const FLAG = format === 'abbrev' ? '--abbrev' : '-a';

function suiteParts(capture: string): Map<string, Uint8Array> {
  const dir = mkdtempSync(join(TEMP_ROOT, 'daily-regress-'));
  try {
    const input = join(dir, basename(capture));
    copyFileSync(capture, input);
    const out = join(dir, 'out');
    mkdirSync(out, { recursive: true });
    execFileSync(SUITE, [FLAG, '-o', out, '--daily-utc', input], { stdio: 'pipe', timeout: 900_000 });
    const stem = readdirSync(out)[0];
    const stamp = readdirSync(join(out, stem))[0];
    const formatDir = join(out, stem, stamp, FORMAT);
    const map = new Map<string, Uint8Array>();
    for (const name of readdirSync(formatDir)) map.set(name, new Uint8Array(readFileSync(join(formatDir, name))));
    return map;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let failures = 0;
for (const capture of captures) {
  if (only && !basename(capture).includes(only)) continue;
  const bytes = new Uint8Array(readFileSync(capture));
  const deframer = new SbfDeframer({ crcMode: 'validate' });
  const frames = [...deframer.push(bytes)];
  deframer.end();
  const suite = suiteParts(capture);
  const ours = convertFrames(frames, {
    format: FORMAT as 'ASCII' | 'ABBREV_ASCII',
    at: new Date('2026-11-01T00:00:00Z'),
    tables,
    name: basename(capture),
    splitMode: 'daily' as ConvertSplitMode,
  }).files;
  const names = [...new Set([...suite.keys(), ...ours.map((file) => file.name)])].sort();
  const rows: string[] = [];
  let same = true;
  for (const name of names) {
    const theirs = suite.get(name);
    const mine = ours.find((file) => file.name === name)?.bytes;
    const equal = theirs !== undefined && mine !== undefined
      && theirs.length === mine.length && theirs.every((byte, index) => byte === mine![index]);
    if (!equal) same = false;
    rows.push(`${equal ? 'OK  ' : 'FAIL'} ${name.padEnd(40)} suite ${theirs ? theirs.length : '-'} B  ours ${mine ? mine.length : '-'} B`);
  }
  if (!same) failures += 1;
  console.log(`\n${basename(capture)}  ${names.length} part(s)  ${same ? 'identical' : 'DIFFERS'}`);
  for (const row of rows) console.log(`  ${row}`);
}
console.log(failures === 0 ? '\nall captures identical' : `\n${failures} capture(s) differ`);
process.exitCode = failures === 0 ? 0 : 1;
