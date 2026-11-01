/**
 * The B4 coverage capture: 31 log types no earlier batch had, every line of the suite's own Convert
 * output byte for byte - in both ASCII and abbreviated ASCII.
 *
 * Fixture: `samples/live-20261031/b4-20261101.sbf` (4 140 243 B, 4 210 records: 4 119 binary and
 * 91 text records) was recorded on the remote receiver host with `tools/remote/b4-capture.ps1`
 * (35 s, four phases of at most ten logs each, bare `UNLOGALL` between and after).
 * `golden-b4-20261101.ASCII` (7 646 463 B, 4 100 lines) and
 * `golden-b4-20261101.ABBREV_ASCII` (8 725 124 B, 92 397 lines) came from
 * `NovAtelApplicationSuite.exe -a` / `--abbrev` on the same file.
 *
 * **This batch found no defect.** 4 100 of 4 100 lines and 92 397 of 92 397 lines are identical on
 * the first run, which is the point of the batch: the machinery the earlier batches repaired -
 * `pack(4)` alignment, the eight integer spellings, the three array forms, `%Z` blobs, `%T`
 * milliseconds - generalises to 31 new layouts without another fix. What it adds is evidence.
 *
 * What was measured on this OEM729 with `b4-probe.ps1` (one `LOG ... ONCE` at a time, 1.5 s reply
 * window; ids 41/42/43 ignored because the port carries a permanent ~20 Hz RANGE stream that no
 * `UNLOGALL` / `UNLOG RANGEB` / `UNLOGALL USB2` clears, and 93/72/963 watched because they fire in
 * every window too - the first pass labelled 13 silent types as `DATA` for exactly that reason):
 *
 *  - refused, `<ERROR:Message is invalid for this model` (model-gated firmware options this unit
 *    does not have): `RTKPOSB`, `RTKVELB`, `MATCHEDPOSB`, `RTKXYZB`, `RTKDOPB`, `RTKSATSB`,
 *    `RTKASSISTSTATUSB`, `MARK1PVAB`, `TILTSTATUSB`;
 *  - refused, `<ERROR:Invalid Message. Field = 2` (the name is not a log at all): `GPSEPHEMERISB`,
 *    `SBASRAWB`, `NAVSSATBITSB`, `ABSSATEPHEMERISB`, `SBAS45B`, `LBANDINFOB`, `RAWLBANDFRAMEB`.
 *    Four names from the batch brief are not log names here - the dictionary spells the first two
 *    `GPSEPHEM` and `RAWSBASFRAME`, and the other two appear nowhere in it;
 *  - accepted and silent for 30 s (41 names): `GALFNAVEPHEMERISB`, `BDSBCNAV1EPHEMERISB`,
 *    `USERDATUMB`, `THISANTENNATYPEB`, `BASEANTENNATYPEB`, `ANTENNATYPEB`, `MATCHEDXYZB`,
 *    `MASTERPOSB`, `ROVERPOSB`, `HEADINGB`, `HEADING2B`, `HEADINGEXTB`, `HEADINGRATEB`,
 *    `MARK2TIMEB`, `MARK3TIMEB`, `MARK4TIMEB`, `MARK2POSB`, `MARK3POSB`, `SBAS17B`, `SBAS25B`,
 *    `SBAS26B`, `SBAS27B`, `SBAS3B`, `RAWSBASFRAMEB`, `RAWSBASFRAME2B`, `GPSCNAVRAWMESSAGEB`,
 *    `QZSSCNAVRAWMESSAGEB`, `GALINAVRAWWORDB`, `GALFNAVRAWPAGEB`, `GALFNAVRAWEPHEMERISB`,
 *    `GALFNAVRAWALMANACB`, `GALCNAVRAWPAGEB`, `NAVICALMANACB`, `NAVICSYSCLOCKB`,
 *    `NAVICEPHEMERISB`, `SAVEDSURVEYPOSITIONSB`, `SURVEYPOSITIONB`, `PROFILEB`, `PROFILEINFOB`,
 *    `BDSBCNAV1RAWMESSAGEB`, `RAWCNAVFRAMEB`.
 *
 * Two shapes here had no coverage at all before this batch:
 *
 *  - `%R` (`RXCONFIGUSER`, id 2474): the payload is a `VARIABLE_LENGTH_ARRAY` that carries a whole
 *    `#...*crc` command record. 225 of the 244 records expand into one `#RXCONFIGUSERA,...,#LOGA,
 *    ...*inner*outer` line whose **outer CRC covers the expansion**; the other 19 carry a binary
 *    record (their first bytes are `AA 44 12`) and are dropped - the suite drops them too, which is
 *    why its own summary reads `244 in / 225 out`, and that drop is what makes the byte match hold;
 *  - `VARIABLE_LENGTH_ARRAY` of 1024 chars (`LOGLIST`, id 5): one 3 174-character line that lists
 *    every port's active logs, including the receiver's instantaneous log set.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type Frame, type SbfFrame } from '../src/framing.ts';
import { encodeAsciiLog } from '../src/ascii-log.ts';
import { textLogLines } from '../src/text-log.ts';
import { convertFrames } from '../src/convert-pipeline.ts';
import type { EdieLayout, EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const dir = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

function capture(): Frame[] {
  return [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(join(dir, 'b4-20261101.sbf'))))];
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

test('b4: 4100 lines, byte for byte, across 31 log types no earlier batch had', () => {
  const frames = capture();
  const golden = readFileSync(join(dir, 'golden-b4-20261101.ASCII'), 'utf8').split(/\r?\n/).filter((line) => line.startsWith('#'));
  const produced = wholeFile(frames);
  assert.equal(golden.length, 4100);
  assert.equal(produced.length, 4100);
  assert.deepEqual(produced, golden);
});

test('b4 abbreviated: 92 397 lines, byte for byte', () => {
  const file = convertFrames(capture(), { format: 'ABBREV_ASCII', at: new Date('2026-11-01T00:00:00'), tables, name: 'b4-20261101.sbf' }).files[0];
  const golden = readFileSync(join(dir, 'golden-b4-20261101.ABBREV_ASCII'));
  assert.equal(file.bytes.length, 8_725_124);
  assert.equal(golden.length, 8_725_124);
  assert.deepEqual(Buffer.from(file.bytes), golden);
});

test('b4 carries the 31 new types and the same six the earlier captures already had', () => {
  const frames = capture();
  const sbf = frames.filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  const ids = new Set(sbf.map((frame) => frame.header.messageId));

  const added = [
    5, 48, 160, 172, 180, 214, 231, 718, 1125, 1130, 1326, 1330, 1331, 1336, 1345, 1346,
    1347, 1348, 1538, 1541, 1546, 1719, 1728, 1877, 1997, 2159, 2374, 2411, 2412, 2465, 2474,
  ];
  assert.equal(added.length, 31);
  for (const id of added) assert.ok(ids.has(id), `capture contains log ${id}`);
  // The six that arrive on their own whatever is logged: RANGE, BESTPOS, RANGECMP, PORTSTATS,
  // HWMONITOR, RAWEPHEM.
  for (const id of [41, 42, 43, 72, 93, 963]) assert.ok(ids.has(id), `capture contains log ${id}`);

  assert.equal(ids.size, 37);
  assert.equal(sbf.length, 4119);
  // 4 210 records: 4 119 binary and 91 text. `#` records become lines; the `<OK` / `<ERROR` echoes
  // of the LOG commands do not (neither Convert nor we print them), and 19 binary records are
  // dropped by the writer itself - see the RXCONFIGUSER test below. 4119 - 19 = 4100.
  assert.equal(frames.length, 4210);
});

test('%R: RXCONFIGUSER expands 225 of 244 records and drops the 19 that embed a binary log', () => {
  const frames = capture().filter((frame): frame is SbfFrame => frame.kind === 'sbf' && frame.header.messageId === 2474);
  const layout = tables.messages['2474'];
  assert.ok(layout, 'the dictionary carries RXCONFIGUSER');
  assert.equal(frames.length, 244);

  const printed = frames.filter((frame) => encodeAsciiLog(frame, layout, tables) !== '');
  const dropped = frames.filter((frame) => encodeAsciiLog(frame, layout, tables) === '');
  assert.equal(printed.length, 225, 'the suite summary reads 244 in / 225 out');
  assert.equal(dropped.length, 19);
  for (const frame of dropped) {
    // A nested long header: the payload is a binary record, not the `#...*crc` text the writer can
    // splice in, so `%R` has nothing to print and the whole record goes.
    assert.deepEqual([...frame.payload.slice(0, 4)], [0xaa, 0x44, 0x12, 0x1c]);
  }

  // The expansion keeps the inner record verbatim and the outer checksum covers it.
  const line = encodeAsciiLog(printed[0], layout, tables);
  assert.match(line, /^#RXCONFIGUSERA,SPECIAL,\d+,[\d.]+,COARSESTEERING,\d+,[\d.]+,03801800,[0-9a-f]{4},18278;/);
  assert.match(line, /;#LOGA,.*\*[0-9a-f]{8}\*[0-9a-f]{8}$/);
});

test('the new layouts print their declared field counts, not a shifted window', () => {
  const frames = capture();
  const body = (id: number): string => {
    const frame = frames.find((f): f is SbfFrame => f.kind === 'sbf' && f.header.messageId === id);
    assert.ok(frame, `capture contains log ${id}`);
    const line = encodeAsciiLog(frame, tables.messages[String(id)], tables);
    const tail = line.slice(line.indexOf(';') + 1);
    return tail.slice(0, tail.lastIndexOf('*'));
  };
  const count = (id: number) => body(id).split(',').length;

  // PTPDELTATIME is the widest new record (18 fields, INT / ULONG / SHORT / DOUBLE / ENUM mixed).
  assert.equal(count(2465), 18);
  assert.equal(count(214), 2); // UNDULATION: ENUM + FLOAT
  assert.equal(count(180), 3); // MAGVAR: ENUM + 2 DOUBLE
  assert.equal(count(160), 1); // DATUM: one STRING
  assert.equal(count(1538), 21); // PPPPOS: 21 declared fields
  // AUTHCODES is 4 fields; the STRING is quoted, so its six comma-separated codes stay one value.
  assert.equal(count(1348), 10);
  assert.ok(body(1348).includes('"R35JCN,BTG98D,R4DD6P,5PCR7N,9WPP25,PFNLYNTBN"'));

  // MARKTIME and MARK1TIME carry the same payload here, so the values match and only the name and
  // the checksum differ - a cheap check that the two layouts are not offset from each other.
  assert.equal(body(231), body(1130));

  // A `%Z` blob of 30 bytes stays lowercase hex without separators, as `QZSSRAWSUBFRAME` prints it.
  const subframe = body(1330).split(',');
  assert.equal(subframe.length, 4);
  assert.match(subframe[2], /^[0-9a-f]{60}$/);
});

test('a layout in the dictionary but never seen on the wire still has no line to print', () => {
  // GALFNAVEPHEMERIS and BDSBCNAV1EPHEMERIS were accepted by the receiver and stayed silent for
  // 30 s, so neither appears in the capture; the file proves it rather than asserting a shape.
  const ids = new Set(capture().filter((f): f is SbfFrame => f.kind === 'sbf').map((f) => f.header.messageId));
  for (const id of [1310, 2371]) assert.ok(!ids.has(id), `log ${id} never fired`);
  const layout: EdieLayout | undefined = tables.messages['1310'];
  assert.ok(layout, 'the dictionary still describes it');
  assert.ok(layout.fields.length > 20);
});
