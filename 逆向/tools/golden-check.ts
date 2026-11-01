/**
 * The eight ASCII goldens and every stored ABBREV golden, re-converted and compared byte for byte,
 * with the byte counts and SHA-256 digests printed so the numbers can go straight into a report.
 *
 *   node 逆向/tools/golden-check.ts
 *
 * Everything here is a capture the suite itself converted (`NovAtelApplicationSuite.exe -a` /
 * `--abbrev`); the two ABBREV files that are not stored in the tree (`live-nav`, `live-nav2`) are
 * covered by `oracle-regress.ts`, which runs the suite fresh.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { convertFrames } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';

const root = join(import.meta.dirname, '..');
const samples = join(root, '00_来源', 'samples');
const convert = join(samples, 'convert');
const live = join(samples, 'live-20261031');
const tables: EdieTables = JSON.parse(readFileSync(join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'));

interface Row { capture: string; format: 'ASCII' | 'ABBREV_ASCII'; golden: string; }

const rows: Row[] = [
  { capture: join(convert, 'broad-clean.gps'), format: 'ASCII', golden: join(convert, 'golden-broad-ascii', 'broad-clean', 'Converted_On_20261030_T1800', 'ASCII', 'broad-clean.ASCII') },
  { capture: join(convert, 'clean-9600.gps'), format: 'ASCII', golden: join(convert, 'golden-ascii', 'clean-9600', 'Converted_On_20261030_T1710', 'ASCII', 'clean-9600.ASCII') },
  { capture: join(live, 'live-nav.sbf'), format: 'ASCII', golden: join(live, 'golden-live-nav.ASCII') },
  { capture: join(live, 'live-nav2.sbf'), format: 'ASCII', golden: join(live, 'golden-live-nav2.ASCII') },
  { capture: join(live, 'remote-23types.sbf'), format: 'ASCII', golden: join(live, 'golden-remote-23types.ASCII') },
  { capture: join(live, 'b1-20261101.sbf'), format: 'ASCII', golden: join(live, 'golden-b1-20261101.ASCII') },
  { capture: join(live, 'b2-20261101.sbf'), format: 'ASCII', golden: join(live, 'golden-b2-20261101.ASCII') },
  { capture: join(live, 'b3-20261101.sbf'), format: 'ASCII', golden: join(live, 'golden-b3-20261101.ASCII') },
  { capture: join(live, 'b1-20261101.sbf'), format: 'ABBREV_ASCII', golden: join(live, 'golden-b1-20261101.ABBREV_ASCII') },
  { capture: join(live, 'b2-20261101.sbf'), format: 'ABBREV_ASCII', golden: join(live, 'golden-b2-20261101.ABBREV_ASCII') },
  { capture: join(live, 'b3-20261101.sbf'), format: 'ABBREV_ASCII', golden: join(live, 'golden-b3-20261101.ABBREV_ASCII') },
  { capture: join(live, 'b4-20261101.sbf'), format: 'ABBREV_ASCII', golden: join(live, 'golden-b4-20261101.ABBREV_ASCII') },
  { capture: join(live, 'b5-20261101.sbf'), format: 'ABBREV_ASCII', golden: join(live, 'golden-b5-20261101.ABBREV_ASCII') },
  { capture: join(convert, 'clean-9600.gps'), format: 'ABBREV_ASCII', golden: join(convert, 'golden-abbrev', 'clean-9600', 'Converted_On_20261030_T1710', 'ABBREV_ASCII', 'clean-9600.ABBREV_ASCII') },
];

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
let failures = 0;
for (const row of rows) {
  const capture = new Uint8Array(readFileSync(row.capture));
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(capture)];
  const ours = convertFrames(frames, { format: row.format, at: new Date('2026-11-01T00:00:00Z'), tables, name: row.capture.split(/[\\/]/).pop()! }).files[0]?.bytes ?? new Uint8Array(0);
  const golden = new Uint8Array(readFileSync(row.golden));
  const same = sha(ours) === sha(golden) && ours.length === golden.length;
  if (!same) failures += 1;
  console.log(`${same ? 'OK  ' : 'FAIL'} ${row.format.padEnd(13)} ${row.golden.split(/[\\/]/).slice(-1)[0].padEnd(36)} ${String(golden.length).padStart(8)} B  sha ${sha(golden).slice(0, 16)}`);
}
console.log(failures === 0 ? `\nall ${rows.length} golden files byte-identical` : `\n${failures} golden file(s) differ`);
process.exitCode = failures === 0 ? 0 : 1;
