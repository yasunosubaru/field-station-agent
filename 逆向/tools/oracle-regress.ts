/**
 * The byte-level regression: for a capture and a Convert format, run the installed suite and our own
 * pipeline on the same file and compare the two outputs byte for byte.
 *
 * The eight ASCII goldens and the b1–b3 ABBREV goldens are in the tree and `node --test` already
 * compares them, so this tool exists for the two ABBREV conversions that are not stored
 * (`golden-live-nav.ABBREV_ASCII`, `golden-live-nav2.ABBREV_ASCII`) and for spot-checks:
 *
 *   node 逆向/tools/oracle-regress.ts ../00_来源/samples/live-20261031/live-nav.sbf ABBREV_ASCII
 *   node 逆向/tools/oracle-regress.ts ../00_来源/samples/live-20261031/live-nav.sbf ASCII
 *
 * Output: one `OK`/`FAIL` line with both byte counts and SHA-256 digests.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { convertFrames, type ConvertFormat } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';
import { oracle } from './oracle.ts';

const tables: EdieTables = JSON.parse(readFileSync(join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'));
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const captures = process.argv.slice(2).filter((arg) => !/^[A-Z]/.test(arg) || arg.includes('.'));
const formats = (process.argv.slice(2).filter((arg) => /^[A-Z]/.test(arg) && !arg.includes('.')) as ConvertFormat[]);
if (captures.length === 0 || formats.length === 0) {
  console.log('usage: node oracle-regress.ts <capture.sbf…> <ASCII|ABBREV_ASCII|BINARY…>');
  process.exitCode = 2;
} else {
  let failures = 0;
  for (const capture of captures) {
    const raw = new Uint8Array(readFileSync(capture));
    const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(raw)];
    const name = basename(capture);
    for (const format of formats) {
      const outcome = convertFrames(frames, { format, at: new Date('2026-11-01T00:00:00Z'), tables, name });
      const ours = outcome.files[0]?.bytes ?? new Uint8Array(0);
      const suite = oracle(raw, basename(capture).replace(/\W/g, ''));
      const theirs = format === 'ASCII' ? suite.asciiBytes : format === 'ABBREV_ASCII' ? suite.abbrevBytes : undefined;
      if (!theirs) {
        console.log(`SKIP ${name} ${format}`);
        continue;
      }
      const same = ours.length === theirs.length && sha(ours) === sha(theirs);
      if (!same) failures += 1;
      console.log(`${same ? 'OK  ' : 'FAIL'} ${name.padEnd(24)} ${format.padEnd(13)} suite ${String(theirs.length).padStart(8)} B ${sha(theirs).slice(0, 16)}   ours ${String(ours.length).padStart(8)} B ${sha(ours).slice(0, 16)}`);
    }
  }
  console.log(failures === 0 ? '\nbyte-identical' : `\n${failures} file(s) differ`);
  process.exitCode = failures === 0 ? 0 : 1;
}
