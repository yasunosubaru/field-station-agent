/**
 * The B6 coverage capture: nine log types no earlier batch had, every line of the suite's own
 * Convert output byte for byte — in both ASCII and abbreviated ASCII.
 *
 * Fixture: `samples/live-20261031/b6-20261101.sbf` (2 001 033 B, 786 binary records + 57 text
 * records) was recorded on the remote receiver host with `tools/remote/b6-capture.ps1` (two phases,
 * bare `UNLOGALL` between and after).
 * `golden-b6-20261101.ASCII` (3 599 999 B, 786 lines) and
 * `golden-b6-20261101.ABBREV_ASCII` (4 179 807 B, 46 354 lines) came from
 * `NovAtelApplicationSuite.exe -a` / `--abbrev` on the same file.
 *
 * What was measured on this OEM729 with `b6-probe.ps1` (one `LOG <name>B ONCE` at a time, 1.5 s
 * reply window, ids 41/42/43 and 93/72/963 ignored because they fire on their own):
 *
 *  - converted (9 names, all in this capture): `LBANDTRACKSTAT` 1201, `LBANDBEAMTABLE` 1718,
 *    `TERRASTARSTATUS` 1729, `PPPSEEDAPPLICATIONSTATUS` 2250, `PPPSEEDSTORESTATUS` 2251,
 *    `SOURCETABLE` 1344, `OCEANIXSTATUS` 2160, `TECTONICSCOMPENSATION` 2291, `PASSCOM3` 235;
 *  - refused, `<ERROR:Message is invalid for this model`: the whole SPAN/IMU family and the RTK
 *    licence family (see §9.x.15 of `09_EDIE消息字典与ASCII一致性.md` for the full list);
 *  - refused, `<ERROR:Invalid Message. Field = 2` (no such log on this receiver): `RAWLBANDPACKET`,
 *    `SBAS32`..`SBAS35`, `GPGGARTK`, `BESTLEVERARM(2)`, `PASSXCOM1`..`PASSXCOM3`, `PASSETH1`, …
 *  - accepted and silent: the SBAS pages (this unit has no SBAS bird), `PPPDATUMINFO`,
 *    `REFSTATION`, `HEADINGSATS`, `ALIGN*`, `MARK4POS`, the `PASS*` ports with no traffic, …
 *
 * Two things this batch measured beyond coverage:
 *
 *  1. **`LOG <name>` without the trailing `B` is the ASCII log.** It answers `<OK` and never puts a
 *     binary record on the port, so a probe written with bare names reports "accepted and silent"
 *     for logs that do produce data. The first b6 probe run did exactly that: 100 names, zero data.
 *     The same 100 names with `B` produced nine logs. Every verdict above is from the `B` run.
 *  2. **`ETHSTATUS` reports one interface on this unit** — `count` is 1 in all 15 records and the
 *     payload is 32 bytes (4 + 26 + 2), so the 26-byte stride stays unproven: with a single block a
 *     28-byte stride fits the bytes just as well. `SAVEDSURVEYPOSITIONS` never fires because no
 *     survey position has been stored on this receiver, and `SBAS18` never fires because there is no
 *     SBAS satellite in view.
 *  3. **Three logs reject `ONTIME` outright** — `<ERROR:Trigger ONTIME not valid for this log` for
 *     `PPPSEEDAPPLICATIONSTATUS`, `PPPSEEDSTORESTATUS` and `TECTONICSCOMPENSATION`. They are
 *     change-triggered only, which is why each contributes exactly one record (the `ONCE` one)
 *     while the other six logs of the same phase contribute 15-17.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type Frame, type SbfFrame } from '../src/framing.ts';
import { encodeAsciiLog } from '../src/ascii-log.ts';
import { encodeAbbrevLines } from '../src/abbrev-log.ts';
import { textLogLines } from '../src/text-log.ts';
import { convertFrames } from '../src/convert-pipeline.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const dir = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

function capture(): Frame[] {
  return [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(join(dir, 'b6-20261101.sbf'))))];
}

/** Exactly what `convert.ts --to ASCII` writes (b6 carries no compressed-range record). */
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

const lineOf = (lines: string[], name: string): string => {
  const line = lines.find((candidate) => candidate.startsWith(`#${name}A`));
  assert.ok(line, `golden contains a #${name}A line`);
  return line;
};

/** The comma-separated body, CRC and header stripped. */
const body = (line: string): string => {
  const tail = line.slice(line.indexOf(';') + 1);
  return tail.slice(0, tail.lastIndexOf('*'));
};

test('b6: 786 lines, byte for byte, across nine log types no earlier batch had', () => {
  const frames = capture();
  const golden = readFileSync(join(dir, 'golden-b6-20261101.ASCII'), 'utf8').split(/\r?\n/).filter((line) => line.startsWith('#'));
  const produced = wholeFile(frames);
  assert.equal(golden.length, 786);
  assert.equal(produced.length, 786);
  assert.deepEqual(produced, golden);
});

test('b6 abbreviated: 46 354 lines, byte for byte', () => {
  const file = convertFrames(capture(), { format: 'ABBREV_ASCII', at: new Date('2026-11-01T00:00:00'), tables, name: 'b6-20261101.sbf' }).files[0];
  const golden = readFileSync(join(dir, 'golden-b6-20261101.ABBREV_ASCII'));
  assert.equal(file.bytes.length, 4_179_807);
  assert.equal(golden.length, 4_179_807);
  assert.deepEqual(Buffer.from(file.bytes), golden);
});

test('b6 carries 16 log ids: the nine new ones and seven that fire on their own', () => {
  const sbf = capture().filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  const ids = new Set(sbf.map((frame) => frame.header.messageId));

  const added = [235, 1201, 1344, 1718, 1729, 2160, 2250, 2251, 2291];
  assert.equal(added.length, 9);
  for (const id of added) assert.ok(ids.has(id), `capture contains log ${id}`);
  // RAWEPHEM, BESTPOS, RANGE, PORTSTATS, RXSTATUS, HWMONITOR, ETHSTATUS.
  for (const id of [41, 42, 43, 72, 93, 963, 1288]) assert.ok(ids.has(id), `capture contains log ${id}`);

  assert.equal(ids.size, 16);
  assert.equal(sbf.length, 786);
  // The two phases of the capture script: 11 ONCE records and then 15 s of 1 Hz records.
  assert.equal(sbf.filter((frame) => frame.header.messageId === 1201).length, 17);
  assert.equal(sbf.filter((frame) => frame.header.messageId === 1288).length, 15);
  assert.equal(sbf.filter((frame) => frame.header.messageId === 235).length, 1);
  assert.equal(sbf.filter((frame) => frame.header.messageId === 43).length, 635);
});

test('ETHSTATUS reports one interface, so the 26-byte stride stays unproven', () => {
  const sbf = capture().filter((frame): frame is SbfFrame => frame.kind === 'sbf' && frame.header.messageId === 1288);
  assert.equal(sbf.length, 15);
  // 32 bytes = 4 (count) + 26 (one interface block) + 2 that the layout does not name. With a single
  // block a 28-byte stride fits the payload just as well as the dictionary's 26, so this capture
  // cannot settle the stride - it needs a receiver with two ethernet interfaces.
  for (const frame of sbf) {
    assert.equal(frame.payload.length, 32);
    const count = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength).getUint32(0, true);
    assert.equal(count, 1);
  }
  const line = lineOf(wholeFile(capture()), 'ETHSTATUS');
  assert.equal(body(line), '1,ETHA,"00-21-66-08-6A-79",NOTCONNECT');
});

test('the two record-count gaps: SBAS18 and SAVEDSURVEYPOSITIONS never fire on this unit', () => {
  const frames = capture();
  const ids = new Set(frames.filter((f): f is SbfFrame => f.kind === 'sbf').map((f) => f.header.messageId));
  // Both were logged in the capture (phase A) and neither produced a record: no SBAS bird, and no
  // survey position has ever been stored. An absent line is the honest result here, not a decoder
  // defect - so the test pins the absence rather than inventing a sample.
  assert.ok(!ids.has(981), 'no SBAS18 record');
  assert.ok(!ids.has(1951), 'no SAVEDSURVEYPOSITIONS record');
  const lines = wholeFile(frames);
  assert.equal(lines.filter((line) => line.startsWith('#SBAS18A')).length, 0);
  assert.equal(lines.filter((line) => line.startsWith('#SAVEDSURVEYPOSITIONSA')).length, 0);
});

test('the new layouts print their declared field counts, not a shifted window', () => {
  const lines = wholeFile(capture());
  const count = (name: string) => body(lineOf(lines, name)).split(',').length;

  // LBANDTRACKSTAT: a count of 5 followed by five 16-field blocks, all zero because no LBand channel
  // is tracking.
  assert.equal(count('LBANDTRACKSTAT'), 81);
  assert.ok(body(lineOf(lines, 'LBANDTRACKSTAT')).startsWith('5,"",0,0,0000,0003,0,0.000,0.000,0.0000,0.000,0,0,0,0,0,0.0000,""'));
  // LBANDBEAMTABLE: six beams of six fields each.
  assert.equal(count('LBANDBEAMTABLE'), 37);
  assert.ok(body(lineOf(lines, 'LBANDBEAMTABLE')).startsWith('6,"AORW","B",1545845000,1200,-54.00,1,"IOR","C",'));
  assert.equal(count('TERRASTARSTATUS'), 5);
  assert.equal(count('OCEANIXSTATUS'), 3);
  assert.equal(count('PPPSEEDAPPLICATIONSTATUS'), 7);
  assert.equal(count('PPPSEEDSTORESTATUS'), 2);
  assert.equal(count('SOURCETABLE'), 4);
  assert.equal(count('TECTONICSCOMPENSATION'), 5);
});

test('PASSCOM3 escapes its four payload bytes with %P and never breaks the line', () => {
  const line = lineOf(wholeFile(capture()), 'PASSCOM3');
  const tail = body(line);
  assert.equal(tail, '4,\\xed\\xff\\xf7\\xb9');
  assert.equal(tail.split(',')[0], '4', 'the byte count comes first');
  assert.ok(!line.includes('\r') && !line.includes('\n'));
});

test('TECTONICSCOMPENSATION names the plate grid this receiver is configured for', () => {
  const tail = body(lineOf(wholeFile(capture()), 'TECTONICSCOMPENSATION'));
  assert.ok(tail.startsWith('AVAILABLE,"Yangtze",'), tail);
  // Three tidal-loading components as 3-decimal degrees of displacement.
  assert.equal(tail.split(',').length, 5);
});

test('the abbreviated form puts the five LBANDTRACKSTAT blocks one level under the count', () => {  const frame = capture().find((f): f is SbfFrame => f.kind === 'sbf' && f.header.messageId === 1201);
  assert.ok(frame);
  const lines = encodeAbbrevLines(frame, tables.messages['1201'], tables);
  assert.equal(lines.length, 7, 'header, count, five blocks');
  assert.ok(lines[0].startsWith('<LBANDTRACKSTAT SPECIAL 0 '), lines[0]);
  // `<` + 5 spaces for the count, 10 for a block's own values (one line per block, all 16 fields).
  assert.equal(lines[1], '<     5 ');
  assert.equal(lines.slice(2).filter((line) => line.startsWith('<          "" 0 0 0000 0003 ')).length, 5);
});

test('three logs reject ONTIME and contribute exactly one record each', () => {
  const frames = capture();
  const text = frames.filter((f): f is Extract<Frame, { kind: 'text' }> => f.kind === 'text').map((f) => f.text);
  // 29 port tags + 25 `<OK` + these three; the port tag shapes are asserted in framing.test.ts.
  assert.equal(text.filter((line) => line === '<ERROR:Trigger ONTIME not valid for this log\r\n').length, 3);
  assert.equal(text.filter((line) => line.startsWith('<OK')).length, 25);

  const sbf = frames.filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  // The three that rejected ONTIME carry only their `ONCE` record; the six that accepted it carry
  // 1 + one per second for 15 s. That is what identifies which three were rejected.
  for (const id of [2250, 2251, 2291]) {
    assert.equal(sbf.filter((frame) => frame.header.messageId === id).length, 1, `log ${id}`);
  }
  for (const id of [1201, 1718, 1729, 1344]) {
    assert.ok(sbf.filter((frame) => frame.header.messageId === id).length > 15, `log ${id}`);
  }
});
