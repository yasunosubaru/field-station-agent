/**
 * The B5 coverage capture: 20 log types no earlier batch had, plus the three compressed-range
 * versions that print as `RANGE`, every line of the suite's own Convert output byte for byte — in
 * both ASCII and abbreviated ASCII.
 *
 * Fixture: `samples/live-20261031/b5-20261101.sbf` (3 357 697 B, 1 565 records: 1 478 binary and
 * 87 text records) was recorded on the remote receiver host with `tools/remote/b5-capture.ps1`
 * (five phases, bare `UNLOGALL` between and after).
 * `golden-b5-20261101.ASCII` (6 354 933 B, 1 478 lines) and
 * `golden-b5-20261101.ABBREV_ASCII` (7 372 489 B, 81 561 lines) came from
 * `NovAtelApplicationSuite.exe -a` / `--abbrev` on the same file.
 *
 * What was measured on this OEM729 with `b5-probe.ps1` (one `LOG … ONCE` at a time, 1.5 s reply
 * window, ids 41/42/43 and 93/72/963 ignored because they fire on their own):
 *
 *  - converted (25 names, all in this capture): `VALIDMODELS` 206, `COMCONFIG` 317,
 *    `CHANCONFIGLIST` 1148, `BESTDATUMINFO` 2305, `PSRDATUMINFO` 2300, `BESTGNSSDATUMINFO` 2302,
 *    `GEODETICDATUMS` 2296, `DATUMTRANSFORMATIONS` 2298, `CLOCKSTEERING` 26,
 *    `SOFTLOADSTATUS` 1235, `VERIPOSSTATUS` 1730, `PASSTHROUGH` 1342, `PDPPOS` 469, `PDPXYZ` 471,
 *    `PDPVEL` 470, `PDPSATS` 1234, `RXSTATUSEVENT` 94, `RANGECMP` 140, `RANGECMP2` 1273,
 *    `RANGECMP3` 1734, `RANGECMP4` 2050, `RANGECMP5` 2537, `RANGEGPSL1` 631,
 *    `GALINAVRAWEPHEMERIS` 1126, `BDSBCNAV3RAWMESSAGE2` 2520;
 *  - refused, `<ERROR:Message is invalid for this model` (firmware option absent): `SATELSTATUSB`,
 *    `SATEL4INFOB`, `SATEL9INFOB`, `FILELISTB`, `FILESTATUSB`, `FILESYSTEMSTATUSB`,
 *    `FILESYSTEMCAPACITYB`, `FILETRANSFERSTATUSB`, `LUASTATUSB`, `LUAFILELISTB`,
 *    `LUAFILESYSTEMSTATUSB`, `INSDATUMINFOB`, `ITFILTTABLEB`, `ITBANDPASSBANKB`, `ITPROGFILTBANKB`,
 *    `TSS1B`, `INSVELXB`, `INSPVAXB`, `INSCONFIGB`, `INSSTDEVB`, `HEAVEB`, `TILTDATAB`,
 *    `WIFISTATUSB`, `WIFINETLISTB`, `EXTERNALPVASB`;
 *  - refused, `<ERROR:Invalid Message. Field = 2` (no such log): `LBANDINFOB`;
 *  - accepted and silent: `MODELB`, `AUTHB`, `PDPDATUMINFOB`, `RTKDATUMINFOB`, `USERANTENNAB`,
 *    `USERDATUMB`, `GALCLOCKB`, `GLORAWFRAMEB`, `GLORAWSTRINGB`, `REFSTATIONINFOB`,
 *    `SAVEDSURVEYPOSITIONSB`, `USERCANSTATUSB`, `USERCANDATAB`, `QZSSCNAVRAWMESSAGEB`,
 *    `GPSCNAVRAWMESSAGEB`, `GALCNAVRAWPAGEB`, `GALHASRAWMTB`, `PDPDOPB`, `PDPDOP2B`,
 *    `PROFILERESPONSEB`, `HEADINGB`.
 *
 * Three things this batch added beyond coverage (all measured, all in `rangecmp.ts` /
 * `convert-pipeline.ts`):
 *
 *  1. **`RANGECMP` (v1), `RANGECMP3` and `RANGECMP5` also print as `RANGE`.** Convert unpacks all
 *     five compression versions; their own summary rows read `N in → 0` and RANGE's output grows
 *     from 1 050 to 1 112. RANGECMP3 has no table in the OEM7 manual, but its payload is the
 *     RANGECMP4 payload **byte for byte** (12/12 records here), so it decodes with that reader.
 *  2. **`PASSTHROUGH` (1342) is converted, not dropped** — b5 carries the first real passthrough
 *     record this project has. The suite prints `#PASSTHROUGHA,…;COM3,80,_\x9f…`, counts it in the
 *     summary and copies it in BINARY; the earlier rule said it wrote nothing.
 *  3. **abbreviated ASCII indents a nested `FIELD_ARRAY` by five more columns** —
 *     `CHANCONFIGLIST` has an array inside an array element and its inner values sit at column 14.
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
import { buildRangePayload, decodeRangeCmp1, decodeRangeCmp2, decodeRangeCmp4, decodeRangeCmp5, lockTimeCarry } from '../src/rangecmp.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const dir = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

function capture(): Frame[] {
  return [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(join(dir, 'b5-20261101.sbf'))))];
}

/** Exactly what `convert.ts --to ASCII` writes, including the compressed-range expansion. */
function wholeFile(frames: Frame[]): string[] {
  const text = textLogLines(frames, tables);
  const out: string[] = [];
  const carries = new Map<number, ReturnType<typeof lockTimeCarry>>();
  frames.forEach((frame, index) => {
    const line = text.get(index);
    if (line !== undefined) {
      out.push(line);
      return;
    }
    if (frame.kind !== 'sbf' || !frame.crcOk) return;
    const id = frame.header.messageId;
    if ([140, 1273, 1734, 2050, 2537].includes(id)) {
      let carry = carries.get(id);
      if (!carry) {
        carry = lockTimeCarry();
        carries.set(id, carry);
      }
      const options = { epochMs: frame.header.milliseconds, lockCarry: carry };
      const observations = id === 140
        ? decodeRangeCmp1(frame.payload, options)
        : id === 1273
          ? decodeRangeCmp2(frame.payload, options)
          : id === 2537
            ? decodeRangeCmp5(frame.payload, options)
            : decodeRangeCmp4(frame.payload, options);
      const encoded = encodeAsciiLog(
        { ...frame, payload: buildRangePayload(observations) },
        tables.messages['43'],
        tables,
      );
      if (encoded) out.push(encoded);
      return;
    }
    const layout = tables.messages[String(id)];
    if (!layout) return;
    const encoded = encodeAsciiLog(frame, layout, tables);
    if (encoded) out.push(encoded);
  });
  return out;
}

test('b5: 1478 lines, byte for byte, across 20 log types no earlier batch had', () => {
  const frames = capture();
  const golden = readFileSync(join(dir, 'golden-b5-20261101.ASCII'), 'utf8').split(/\r?\n/).filter((line) => line.startsWith('#'));
  const produced = wholeFile(frames);
  assert.equal(golden.length, 1478);
  assert.equal(produced.length, 1478);
  assert.deepEqual(produced, golden);
});

test('b5 abbreviated: 81 561 lines, byte for byte', () => {
  const file = convertFrames(capture(), { format: 'ABBREV_ASCII', at: new Date('2026-11-01T00:00:00'), tables, name: 'b5-20261101.sbf' }).files[0];
  const golden = readFileSync(join(dir, 'golden-b5-20261101.ABBREV_ASCII'));
  assert.equal(file.bytes.length, 7_372_489);
  assert.equal(golden.length, 7_372_489);
  assert.deepEqual(Buffer.from(file.bytes), golden);
});

test('b5 carries 31 log ids: the 20 new ones, the five RANGECMP versions and six that fire on their own', () => {
  const sbf = capture().filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  const ids = new Set(sbf.map((frame) => frame.header.messageId));

  const added = [
    26, 94, 206, 317, 469, 470, 471, 631, 1126, 1148, 1234, 1235, 1342, 1730, 2296, 2298, 2300,
    2302, 2305, 2520,
  ];
  assert.equal(added.length, 20);
  for (const id of added) assert.ok(ids.has(id), `capture contains log ${id}`);
  // The five compression versions: all unpack into RANGE and print no row of their own.
  for (const id of [140, 1273, 1734, 2050, 2537]) assert.ok(ids.has(id), `capture contains log ${id}`);
  // The six that arrive on their own whatever is logged: RAWEPHEM, BESTPOS, RANGE, PORTSTATS,
  // RXSTATUS, HWMONITOR.
  for (const id of [41, 42, 43, 72, 93, 963]) assert.ok(ids.has(id), `capture contains log ${id}`);

  assert.equal(ids.size, 31);
  assert.equal(sbf.length, 1478);
  assert.equal(sbf.filter((frame) => frame.header.messageId === 2537).length, 12);
  assert.equal(sbf.filter((frame) => frame.header.messageId === 1126).length, 216);
});

test('all five RANGECMP versions print as RANGE: 1 050 records become 1 112 lines', () => {
  const frames = capture();
  const sbf = frames.filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  const compressed = sbf.filter((frame) => [140, 1273, 1734, 2050, 2537].includes(frame.header.messageId));
  assert.equal(compressed.length, 62);

  const lines = wholeFile(frames);
  assert.equal(lines.filter((line) => line.startsWith('#RANGECMP')).length, 0);
  assert.equal(lines.filter((line) => line.startsWith('#RANGEA,')).length, 1112);
  // RANGEGPSL1 is a different log whose name starts with `RANGE`; it keeps its own lines.
  assert.equal(lines.filter((line) => line.startsWith('#RANGEGPSL1A,')).length, 12);
});

test('RANGECMP3 carries the RANGECMP4 payload byte for byte (that is why it decodes as v4)', () => {
  const sbf = capture().filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  const v3 = sbf.filter((frame) => frame.header.messageId === 1734);
  const v4 = sbf.filter((frame) => frame.header.messageId === 2050);
  assert.equal(v3.length, 12);
  assert.equal(v4.length, 12);
  for (let i = 0; i < v3.length; i++) {
    assert.equal(v3[i].header.milliseconds, v4[i].header.milliseconds, 'same epochs');
    assert.deepEqual(Buffer.from(v3[i].payload), Buffer.from(v4[i].payload), `record ${i}`);
  }
  // Only the echoed header field differs, which is why the two logs' RANGE lines differ in that
  // one word and nowhere else.
  assert.notEqual(v3[0].header.reserved, v4[0].header.reserved);
});

test('RANGECMP5 needs its own reader: 828 observations, 5-bit standard deviations, m/s Doppler', () => {
  const sbf = capture().filter((f): f is SbfFrame => f.kind === 'sbf');
  const frames = sbf.filter((f) => f.header.messageId === 2537);
  assert.equal(frames.length, 12);
  assert.equal(frames.reduce((total, f) => total + decodeRangeCmp5(f.payload, {}).length, 0), 828);

  const frame = frames[0];
  const observations = decodeRangeCmp5(frame.payload, { epochMs: frame.header.milliseconds });
  assert.equal(observations.length, 69);
  assert.equal(observations[0].sv_prn, 3);
  // Table 212 index 9 → 0.01622 cycles, index 8 → 0.01385: the RANGECMP4 record of the same epoch
  // prints `0.016` for its own index 5 (Table 203). Two logs, two scales — the golden proves which.
  assert.equal(observations[0].sd_adr.toFixed(3), '0.016');
  assert.equal(observations[2].sd_adr.toFixed(3), '0.009');
  // Table 213's own five bits: 0.099 and 0.220.
  assert.equal(observations[0].sd_psr.toFixed(3), '0.099');
  assert.equal(observations[1].sd_psr.toFixed(3), '0.220');
  // Secondary blocks are differential and their Doppler step is 0.0001 m/s, not the 0.0002 the
  // table prints (measured over 460 secondary rows): 1354.733 and 1298.359 are what the golden says.
  assert.ok(Math.abs(observations[1].dop - 1354.7332763671875) < 1e-9);
  assert.ok(Math.abs(observations[2].dop - 1298.3590087890625) < 1e-9);
});

test('PASSTHROUGH prints one line: port name, byte count, escaped payload', () => {
  const lines = wholeFile(capture()).filter((line) => line.startsWith('#PASSTHROUGH'));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('#PASSTHROUGHA,SPECIAL,0,73.5,COARSESTEERING,2443,17024.106,03801800,5fa3,18278;COM3,80,_'), lines[0].slice(0, 96));
  // `%P`: printable bytes stay, the rest becomes `\xnn`, and a payload CR/LF can never break a line.
  assert.match(lines[0], /;COM3,80,_\\x9f\\xef\\xff\\xac/);
  assert.ok(!lines[0].includes('\r') && !lines[0].includes('\n'));
  const summary = convertFrames(capture(), { format: 'ASCII', at: new Date('2026-11-01T00:00:00'), tables, name: 'b5-20261101.sbf' }).counts.get(1342);
  assert.deepEqual(summary, { name: 'PASSTHROUGH', source: 1, output: 1 });
});

test('abbreviated ASCII indents CHANCONFIGLIST’s inner array five columns deeper', () => {
  const frame = capture().find((f): f is SbfFrame => f.kind === 'sbf' && f.header.messageId === 1148);
  assert.ok(frame);
  const lines = encodeAbbrevLines(frame, tables.messages['1148'], tables);
  // `<` + 4 spaces for the data line, 9 for one array level, 14 for the level inside an element.
  assert.ok(lines.some((line) => line === '<     1 5 '), JSON.stringify(lines.slice(0, 3)));
  assert.ok(lines.some((line) => line === '<          5 '), 'per-system count at indent 9');
  assert.ok(lines.some((line) => line === '<               16 GPSL1L2PL5 '), 'values at indent 14');
  assert.equal(lines.filter((line) => line.startsWith('<              ')).length, 25);
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

  assert.equal(count(206), 5); // VALIDMODELS: count + QUOTED string + 3
  assert.equal(count(26), 8); // CLOCKSTEERING
  assert.equal(count(1235), 1); // SOFTLOADSTATUS: one ENUM
  assert.equal(count(1730), 2); // VERIPOSSTATUS
  assert.equal(count(2305), 4); // BESTDATUMINFO
  assert.equal(count(469), 21); // PDPPOS, the widest new position log
  assert.equal(count(471), 28); // PDPXYZ
  assert.equal(count(470), 8); // PDPVEL
  // GEODETICDATUMS is a 16-element VARIABLE_LENGTH_ARRAY of five-field structures: 1 + 16*5 fields.
  assert.equal(count(2296), 81);
  assert.ok(body(2296).includes('"WGS84",6326,EARTH_FIXED,6378137.00,298.2572235630'));
  // COMCONFIG lists three ports of eleven fields each: 1 + 3*11.
  assert.equal(count(317), 34);
  assert.equal(body(317).split(',')[1], 'COM1');
});
