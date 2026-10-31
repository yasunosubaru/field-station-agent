/**
 * The B3 coverage capture: 30 log types, every line of the suite's own Convert output byte for byte.
 *
 * Fixture: `samples/live-20261031/b3-20261101.sbf` (3 375 904 B, 1726 records) was recorded on the
 * remote receiver host with `tools/remote/b3-capture.ps1` — it logs the families the first two
 * batches never had (the GLO/GAL/BDS clocks and almanacs, the raw-page logs, the DOP/velocity
 * status logs, the filesystem/platform status logs), then `UNLOGALL`s that port again.
 * `golden-b3-20261101.ASCII` (6 137 463 B, 1726 lines) came from `NovAtelApplicationSuite.exe -a`
 * on the same file.
 *
 * Two defects were measured here and fixed in `ascii-log.ts` / `edie.ts`:
 *
 *  - the dictionary spells its integers `UCHAR`, `USHORT`, `SHORT`, `ULONG`, `INT`, `UINT`,
 *    `ULONG64`, `LONGLONG`, and the reader only knew `u8`/`u16`/`u32`/`i32`. Anything else fell
 *    through to a one-byte read, so `GALINAVEPHEMERIS`'s `toe` printed `192` (the low byte) where
 *    the suite prints `81600`;
 *  - the offsets in `edie-layouts.json` are dense, but SBF packs with `pack(4)`: `GLOCLOCK`'s
 *    `DOUBLE` moves 22 → 24 and 32 → 36 (payload 57 → 61), and `RAWGPSSUBFRAME`'s `ULONG` after the
 *    30-byte `%Z` blob moves 42 → 44 (46 → 48). `wireFields` applies the padding only when the
 *    record's payload is exactly the aligned size, so no layout without evidence moves.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type Frame, type SbfFrame } from '../src/framing.ts';
import { encodeAsciiLog } from '../src/ascii-log.ts';
import { textLogLines } from '../src/text-log.ts';
import type { LongHeader } from '../src/header.ts';
import type { EdieLayout, EdieSegment, EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const dir = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

function capture(): Frame[] {
  return [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(join(dir, 'b3-20261101.sbf'))))];
}

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

test('b3: 1726 lines, byte for byte, across 30 log types', () => {
  const frames = capture();
  const golden = readFileSync(join(dir, 'golden-b3-20261101.ASCII'), 'utf8').split(/\r?\n/).filter((line) => line.startsWith('#'));
  const produced = wholeFile(frames);
  assert.equal(golden.length, 1726);
  assert.equal(produced.length, 1726);
  assert.deepEqual(produced, golden);
});

test('b3 carries the types the earlier captures never had', () => {
  const frames = capture().filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  const ids = new Set(frames.map((frame) => frame.header.messageId));
  // The 24 log types this batch added, plus six that keep arriving from the receiver on their own.
  const added = [
    1777, 1669, 1907, 2060, 492, 719, 1607, 1120, 1584, 1127, 1590, // platform / clocks / almanacs
    792, 1695, 25, 407, // raw pages (%Z, %T)
    1163, 881, 1162, 2230, 100, 161, 1451, 1309, 2372, // DOP, velocity, satellite and ephemeris
  ];
  for (const id of added) assert.ok(ids.has(id), `capture contains log ${id}`);
  // 1782 records in the file: 1726 binary (one ASCII line each) and 56 text records — the receiver
  // echoing `[USB2]<OK` for the LOG commands. Neither Convert nor we print the echoes.
  assert.equal(frames.length, 1726);
});

/** A synthetic frame with a real long header, so the ASCII encoder can run on any layout. */
function frameWith(payload: Uint8Array): SbfFrame {
  const header: LongHeader = {
    kind: 'long',
    headerLength: 28,
    messageId: 9999,
    messageTypeByte: 0,
    format: 'binary',
    isResponse: false,
    secondaryAntenna: false,
    portAddress: 160,
    payloadLength: payload.length,
    sequence: 0,
    idleTimeRaw: 141,
    timeStatus: 180,
    week: 2402,
    milliseconds: 0,
    receiverStatus: 0x03801800,
    reserved: 0x1234,
    softwareVersion: 18278,
  };
  return { kind: 'sbf', header, bytes: payload, payload, crcField: 0, crcOk: true };
}

function bodyOf(layout: EdieLayout, payload: Uint8Array): string {
  const line = encodeAsciiLog(frameWith(payload), layout, tables);
  const body = line.slice(line.indexOf(';') + 1);
  return body.slice(0, body.lastIndexOf('*'));
}

test('an integer field is read at its declared width, whatever the dictionary calls it', () => {
  // `SHORT`/`UINT`/`INT`/`ULONG64` are the spellings GALINAVEPHEMERIS, BDSCLOCK and INSPVACMP use.
  // Dense offsets here (dense 18, aligned 20) so the payload length picks the stored layout and the
  // test is about the reader alone.
  const layout: EdieLayout = {
    name: 'WIDTHS',
    style: 'OEM4_MESSAGE_STYLE',
    type: 'LOG',
    fields: [
      { name: 's16', kind: 'scalar', offset: 0, size: 2, type: 'short', format: '%hd' },
      { name: 'u32v', kind: 'scalar', offset: 2, size: 4, type: 'uint', format: '%u' },
      { name: 'i32v', kind: 'scalar', offset: 6, size: 4, type: 'int', format: '%d' },
      { name: 'u64v', kind: 'scalar', offset: 10, size: 8, type: 'ulonglong', format: '%llu' },
    ],
  } as EdieLayout;
  const payload = new Uint8Array(18);
  const view = new DataView(payload.buffer);
  view.setInt16(0, -2, true);
  view.setUint32(2, 0x12345678, true);
  view.setInt32(6, -100000, true);
  view.setBigUint64(10, 0x0000000100000002n, true);
  assert.equal(bodyOf(layout, payload), '-2,305419896,-100000,4294967298');
});

test('pack(4) padding is used only when the payload length proves it', () => {
  // RAWGPSSUBFRAME's shape: a 30-byte `%Z` blob ends at 34, so the ULONG below it sits at 36 on the
  // wire (payload 40) but at 34 in the dense layout (payload 38).
  const layout: EdieLayout = {
    name: 'PADDED',
    style: 'OEM4_MESSAGE_STYLE',
    type: 'LOG',
    fields: [
      { name: 'a', kind: 'scalar', offset: 0, size: 4, type: 'u32', format: '%u' },
      { name: 'blob', kind: 'string', offset: 4, size: 30, format: '%Z' },
      { name: 'n', kind: 'scalar', offset: 34, size: 4, type: 'u32', format: '%u' },
    ] as EdieSegment[],
  } as EdieLayout;

  const aligned = new Uint8Array(40);
  new DataView(aligned.buffer).setUint32(0, 1, true);
  new DataView(aligned.buffer).setUint16(34, 0xbbaa, true); // the two padding bytes, ignored
  new DataView(aligned.buffer).setUint32(36, 7, true);
  const alignedBody = bodyOf(layout, aligned);
  assert.ok(alignedBody.endsWith(',7'), alignedBody.slice(-12));
  assert.equal(alignedBody.split(',')[1], '00'.repeat(30), 'the blob prints as 30 hex bytes');

  const dense = new Uint8Array(38);
  new DataView(dense.buffer).setUint32(0, 1, true);
  new DataView(dense.buffer).setUint32(34, 9, true);
  assert.ok(bodyOf(layout, dense).endsWith(',9'), 'a payload that is not the aligned size keeps the stored offsets');
});

test('the two alignment cases the capture proves: GLOCLOCK 61 bytes, RAWGPSSUBFRAME 48', () => {
  for (const id of [719, 25]) {
    const frame = capture().find((f): f is SbfFrame => f.kind === 'sbf' && f.header.messageId === id);
    assert.ok(frame, `capture contains log ${id}`);
    assert.equal(frame.payload.length, id === 719 ? 61 : 48);
  }
  // GLOCLOCK's last field is the `kp` byte at 60; the dense layout would read it at 56.
  const gloclock = capture().find((f): f is SbfFrame => f.kind === 'sbf' && f.header.messageId === 719) as SbfFrame;
  const line = encodeAsciiLog(gloclock, tables.messages['719'], tables);
  assert.ok(line.includes(',3.725290298e-09,'), 'tau_gps is read at 24, not 22');
});
