/**
 * `pc_cs` element geometry for `ANTENNATYPE` (#2281) and `USERANTENNA` (#2282).
 *
 * Both layouts end with a counted `FIELD_ARRAY pc_cs` whose element is
 *
 *   frequency  enum  4 B   off 0
 *   pco        f32[3]      off 4   (12 B, ends 16)
 *   pcv        f32[19]     off 16  (76 B, ends 92)
 *
 * `edie-layouts.json` stores `stride: 16` for the array (the dictionary's own `arrayLength`
 * metadata), while summing the members gives 92. With one element per record — and no capture has
 * ever carried either log — the two models read the first element identically, so only a synthetic
 * `count = 2` frame can tell them apart. This probe builds one: every member of every element gets
 * `1000 * (element + 1) + 10 * member`, so the suite's line says which offset it read each token
 * from. Element 1 starts at `base + 92` under the struct model and at `base + 16` under the
 * dictionary stride; the two lines cannot agree by accident.
 *
 * Three payload shapes per message:
 *
 *   count=1, exact        payload ends where the single element ends (28 + 92 / 24 + 92)
 *   count=2, exact        payload ends where the second element ends
 *   count=2, tail 0x51ab  four sentinel bytes behind the last element: `pc_cs` is the final field,
 *                         so the suite must ignore them and print the count=2 line unchanged
 *
 *   node 逆向/tools/oracle-pc-cs.ts        # exit code 0 = every case byte-identical
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { convertFrames } from '../04_重实现/packages/protocol/src/convert-pipeline.ts';
import { SbfDeframer } from '../04_重实现/packages/protocol/src/framing.ts';
import type { EdieTables } from '../04_重实现/packages/protocol/src/edie.ts';
import { Payload, frame, oracle } from './oracle.ts';

const tables: EdieTables = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '04_重实现', 'packages', 'protocol', 'data', 'edie-layouts.json'), 'utf8'),
) as EdieTables;

/** `pack(4)` struct size our reader uses: 4 + 3 * 4 + 19 * 4 = 92. */
const ELEMENT = 92;

function ours(input: Uint8Array): { ascii: string[]; abbrev: string[] } {
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(input)];
  const at = new Date('2026-11-01T00:00:00Z');
  const one = (format: 'ASCII' | 'ABBREV_ASCII'): string[] => {
    const text = convertFrames(frames, { format, at, tables, name: 'probe.sbf' }).files[0]?.text ?? '';
    return text.split('\r\n').filter(Boolean);
  };
  return { ascii: one('ASCII'), abbrev: one('ABBREV_ASCII') };
}

interface Case {
  label: string;
  id: number;
  payload: Uint8Array;
  note: string;
}

function pcCs(payload: Payload, base: number, count: number): void {
  payload.u32(base, count);
  for (let element = 0; element < count; element += 1) {
    const at = base + 4 + element * ELEMENT;
    const v = (member: number): number => 1000 * (element + 1) + 10 * member;
    payload.u32(at, element); // frequency: GPSL1 / GPSL2
    for (let member = 1; member <= 3; member += 1) payload.f32(at + 4 + (member - 1) * 4, v(member));
    for (let member = 4; member <= 22; member += 1) payload.f32(at + 16 + (member - 4) * 4, v(member));
  }
}

/** ANTENNATYPE: manage_user_defined_antenna, antenna, antenna_name(16), pc_cs[]. */
function antennaType(count: number, tail: boolean): Uint8Array {
  const payload = new Payload(28 + count * ELEMENT + (tail ? 4 : 0));
  payload.u32(0, 0); // ManageUserDefinedAntenna: ADD
  payload.u32(4, 1); // AntennaModel: USER
  payload.ascii(8, 'ANTENNA-ONE');
  pcCs(payload, 24, count);
  if (tail) payload.u32(28 + count * ELEMENT, 0x51ab);
  return payload.bytes;
}

/** USERANTENNA: antenna, antenna_name(16), pc_cs[]. */
function userAntenna(count: number, tail: boolean): Uint8Array {
  const payload = new Payload(24 + count * ELEMENT + (tail ? 4 : 0));
  payload.u32(0, 1); // AntennaModel: USER
  payload.ascii(4, 'USER-ANT-ONE');
  pcCs(payload, 20, count);
  if (tail) payload.u32(24 + count * ELEMENT, 0x51ab);
  return payload.bytes;
}

const cases: Case[] = [
  { label: 'ANTENNATYPE count=1', id: 2281, payload: antennaType(1, false), note: 'payload 120 B ends at 28 + 92' },
  { label: 'ANTENNATYPE count=2', id: 2281, payload: antennaType(2, false), note: 'element 1 must start at 120, not at 44' },
  { label: 'ANTENNATYPE count=2 tail', id: 2281, payload: antennaType(2, true), note: 'four sentinel bytes behind the last element' },
  { label: 'USERANTENNA count=1', id: 2282, payload: userAntenna(1, false), note: 'payload 116 B ends at 24 + 92' },
  { label: 'USERANTENNA count=2', id: 2282, payload: userAntenna(2, false), note: 'element 1 must start at 116' },
  { label: 'USERANTENNA count=2 tail', id: 2282, payload: userAntenna(2, true), note: 'four sentinel bytes behind the last element' },
];

let failures = 0;
for (const one of cases) {
  const input = frame(one.id, one.payload);
  const result = oracle(input, one.label.replace(/\s+/g, '-'));
  const mine = ours(input);
  const ok = result.ascii.join('\r\n') === mine.ascii.join('\r\n')
    && result.abbrev.join('\r\n') === mine.abbrev.join('\r\n');
  if (!ok) failures += 1;
  console.log(`\n${ok ? 'OK  ' : 'FAIL'} ${one.label}  (payload ${one.payload.length} B) — ${one.note}`);
  for (const line of result.ascii) console.log(`  suite       ${JSON.stringify(line)}`);
  for (const line of mine.ascii) console.log(`  ours        ${JSON.stringify(line)}`);
  for (const line of result.abbrev) console.log(`  suiteABBREV ${JSON.stringify(line)}`);
  if (!ok) {
    for (const line of mine.abbrev) console.log(`  oursABBREV  ${JSON.stringify(line)}`);
  }
}

console.log(failures === 0 ? '\nevery case is byte-identical to the suite' : `\n${failures} mismatch(es)`);
process.exitCode = failures === 0 ? 0 : 1;
