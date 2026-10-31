/**
 * The B1 coverage capture: 25 log types enabled on a free port, converted and compared byte for
 * byte against the suite's own CLI.
 *
 * Fixture: `samples/live-20261031/b1-20261101.sbf` (2 758 111 B, 1325 records) was recorded on the
 * remote receiver host with `tools/remote/b1-capture.ps1` — it logs VERSION, MODELFEATURES,
 * SERIALCONFIG, IONUTC, GPSEPHEM, GALEPHEMERIS, BDSEPHEMERIS, GLOEPHEMERIS, RAWEPHEM, RXCONFIG,
 * LOGLIST, BESTPOS, BESTVEL, BESTXYZ, PSRDOP, BESTSATS, TRACKSTAT, SATVIS2, PORTSTATS, HWMONITOR,
 * TIME, ITPSDFINAL, ITPSDDETECT and ITDETECTSTATUS, then `UNLOGALL`s that port again.
 * `golden-b1-20261101.ASCII` (5 088 882 B, 1402 lines) came from
 * `NovAtelApplicationSuite.exe -a` on the same file.
 *
 * Four rules beyond the 23-type capture were measured here (they cost 66 lines):
 *
 *  - a hex field's declared width is a **minimum**: `%02X` on a ULONG fills 8 digits (J1939CONFIG);
 *  - `%B` (a CHAR as hex) has **no** zero padding (BESTXYZ's `char_as_int` prints `0`, not `00`);
 *  - a `STRING` field is NUL-terminated and padded to 4 bytes, and its `arrayLength` is only a
 *    maximum (SETNAV's 6-byte `"FROM"` takes 8 on the wire; ICOMCONFIG's 80-byte `endpoint` takes 8);
 *  - an `%R` whose embedded message the dictionary cannot resolve drops the whole record, and a
 *    record rejected for a bad CRC is *not* skipped by its length field — the suite resyncs and
 *    recovers whatever real records were nested inside that span (five RAWEPHEM frames here).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type Frame, type SbfFrame } from '../src/framing.ts';
import { encodeAsciiLog, formatField } from '../src/ascii-log.ts';
import { textLogLines } from '../src/text-log.ts';
import type { EdieScalar, EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const dir = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

/** Exactly what `convert.ts --to ASCII` writes. */
function wholeFile(frames: Frame[]): string[] {
  const text = textLogLines(frames, tables);
  const out: string[] = [];
  frames.forEach((frame, index) => {
    const line = text.get(index);
    if (line !== undefined) {
      out.push(line);
      return;
    }
    if (frame.kind !== 'sbf' || !frame.crcOk) return;
    const layout = tables.messages[String(frame.header.messageId)];
    if (!layout) return;
    const encoded = encodeAsciiLog(frame, layout, tables);
    if (encoded) out.push(encoded);
  });
  return out;
}

test('b1: 1402 lines, byte for byte, across 25 log types', () => {
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(join(dir, 'b1-20261101.sbf'))))];
  const golden = readFileSync(join(dir, 'golden-b1-20261101.ASCII'), 'utf8').split(/\r?\n/).filter((line) => line.startsWith('#'));
  const produced = wholeFile(frames);
  assert.equal(golden.length, 1402);
  assert.equal(produced.length, 1402);
  assert.deepEqual(produced, golden);
});

test('b1 carries the types the earlier captures never had', () => {
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(join(dir, 'b1-20261101.sbf'))))]
    .filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  const ids = new Set(frames.map((frame) => frame.header.messageId));
  // VERSION 37, GPSEPHEM 7, GALEPHEMERIS 1122, BESTVEL 99, BESTXYZ 241, PSRDOP 174,
  // SERIALCONFIG 1246, MODELFEATURES 1329, IONUTC 8.
  for (const id of [37, 7, 1122, 99, 241, 174, 1246, 1329, 8]) {
    assert.ok(ids.has(id), `capture contains log ${id}`);
  }
  assert.equal(frames.length, 1325, '1322 records plus 3 recovered from inside a bad-CRC record');
});

test('a hex width is a minimum, `%02X` on a ULONG still fills 8 digits', () => {
  const segment: EdieScalar = { name: 'preferred_address', kind: 'scalar', offset: 0, size: 4, type: 'u32', format: '%02X' };
  assert.equal(formatField(segment, 0x1c, tables), '0000001c', 'J1939CONFIG');
  assert.equal(formatField(segment, 0, tables), '00000000');
  const byte: EdieScalar = { name: 'mask', kind: 'scalar', offset: 0, size: 1, type: 'u8', format: '%02XB' };
  assert.equal(formatField(byte, 0x06, tables), '06', 'a u8 keeps its two digits');
  const char: EdieScalar = { name: 'char_as_int', kind: 'scalar', offset: 0, size: 1, type: 'char', format: '%B' };
  assert.equal(formatField(char, 0, tables), '0', 'BESTXYZ prints 0, not 00');
});

test('a record the CRC rejects is not trusted for its length: nested records survive', () => {
  // `broad-clean.gps` opens with a RANGE whose CRC is wrong; four SATVIS2 and one RANGE follow at
  // offsets that a length-based skip would swallow.
  const clean = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'convert', 'broad-clean.gps');
  const frames = [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(clean)))]
    .filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  assert.equal(frames.length, 1721, '1722 records, the corrupt one dropped, nothing else lost');
  assert.equal(frames.filter((frame) => frame.header.messageId === 1043).length, 40, 'every SATVIS2');
  assert.equal(frames[0].header.messageId, 1043, 'the frame right after the corrupt one');
});
