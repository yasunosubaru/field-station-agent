/**
 * The byte-level rules the CLI itself owns, tested through the executable (not the library
 * functions it calls), because they only become visible in the **file** it writes:
 *
 *  1. **`%c` is one raw byte.** BESTUTM's `zone_letter` (ULONG, `%c`) prints as a single character.
 *     `writeFileSync(file, string)` encodes it as UTF-8 and turns 0xC8 into `C3 88`, one extra byte
 *     per record. Measured with the suite on a synthetic capture built from b2's BESTUTM frame
 *     (3 records, zone letters C8 FF 41): the suite writes **654 bytes** holding the raw C8 and FF
 *     (645 in abbreviated ASCII), and we now write the same, where UTF-8 would have written two
 *     bytes more. (`NovAtelApplicationSuite.exe -a` / `--abbrev`, run on the remote host 2026-11-01.)
 *
 *  2. **`PASSTHROUGH` (1342) never reaches an output.** The suite parses the port-forwarding record
 *     and writes it nowhere — not even in BINARY, where every other accepted record is copied
 *     verbatim — so `convert.ts` filters it before any format and before the summary's counts.
 *
 * The third and fourth tests cover the abbreviated-ASCII wiring: text records (`<` / `#` / `$`
 * frames) and the expanded RANGECMP records are records like any other, so `ABBREV_ASCII` walks the
 * capture in frame order instead of over the accepted binary frames alone.
 *
 *  - `golden-b2-20261101.ABBREV_ASCII` (`--abbrev`) is reproduced **byte for byte**: 905 records,
 *    62 930 lines. Its summary shows the unpacking rule — RANGE 638 in / 699 out, RANGECMP2 (31) and
 *    RANGECMP4 (30) at zero output — the same expansion the ASCII branch performs;
 *  - `golden-b1-20261101.ABBREV_ASCII` carries exactly 99 more records than the capture has binary
 *    frames, one per text header: 39 BESTPOS, 26 RANGE, 24 SATVIS2, 6 RXSTATUS, 2 TIMESYNC,
 *    2 HWMONITOR. The whole 53 417-line file is the suite's own bytes.
 *
 * The checksum is taken over the record's own bytes (`ascii-log.ts#latin1Bytes`), not over their
 * UTF-8 encoding: the suite's `#BESTUTMA` for zone letter 0xC8 ends `*a59003d5`, and hashing `C3 88`
 * gives `4d302fbb`. Measured on the same synthetic capture against the local suite (`-a`, 3 records,
 * 654 bytes, byte-identical): checksums a59003d5 / 375f19a2 / c4355cf5.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SbfDeframer, type Frame, type SbfFrame } from '../src/framing.ts';
import { novatelCrc32 } from '../src/crc.ts';
import { formatDirectory } from '../src/summary.ts';
import { abbrevTextLogLines } from '../src/text-log.ts';
import type { EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const cli = join(here, '..', '..', 'cli', 'src', 'convert.ts');
const live = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

/** Run the CLI the way the user does and hand back the one file it wrote, plus its summary. */
function runConvert(input: string, format: string): { bytes: Buffer; summary: string } {
  const out = mkdtempSync(join(tmpdir(), 'convert-'));
  try {
    execFileSync(process.execPath, [cli, input, '--to', format, '--out', out, '--at', '2026-11-01T00:00:00'], { stdio: 'pipe' });
    const stem = basename(input).replace(/\.[^.]+$/, '');
    const root = join(out, stem);
    const converted = readdirSync(root).find((name) => name.startsWith('Converted_On_'));
    assert.ok(converted, `${format}: a Converted_On_<stamp> directory`);
    const dir = join(root, converted, formatDirectory(format));
    const files = readdirSync(dir);
    assert.equal(files.length, 1, `${format}: exactly one output file`);
    return {
      bytes: readFileSync(join(dir, files[0])),
      summary: readFileSync(join(root, converted, `Summary_${stem}.txt`), 'utf8'),
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function framesOf(capture: Buffer): Frame[] {
  return [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(capture))];
}

function b2Frame(messageId: number): Buffer {
  const frame = framesOf(readFileSync(join(live, 'b2-20261101.sbf')))
    .find((candidate): candidate is SbfFrame => candidate.kind === 'sbf' && candidate.header.messageId === messageId);
  assert.ok(frame, `b2 carries log ${messageId}`);
  return Buffer.from(frame.bytes);
}

/** Re-seal a patched frame so the de-framer still accepts it. */
function reseal(frame: Buffer): Buffer {
  frame.writeUInt32LE(novatelCrc32(new Uint8Array(frame.subarray(0, frame.length - 4))), frame.length - 4);
  return frame;
}

test('%c above 0x7f is written as one raw byte, as the suite writes it', () => {
  // b2's BESTUTM with `zone_letter` (payload offset 12, payload starts after the 28-byte header)
  // set to 0xC8 and 0xFF, plus a plain `A` record so a printable letter is covered too.
  const utm = b2Frame(726);
  const records = [0xc8, 0xff, 0x41].map((letter) => {
    const frame = Buffer.from(utm);
    new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(28 + 12, letter, true);
    return reseal(frame);
  });
  const dir = mkdtempSync(join(tmpdir(), 'zone-'));
  try {
    const capture = join(dir, 'zone.sbf');
    writeFileSync(capture, Buffer.concat(records));

    const { bytes } = runConvert(capture, 'ASCII');
    const lines = bytes.toString('latin1').split('\r\n').filter((line) => line.length > 0);
    assert.equal(lines.length, 3);
    // One raw byte per letter, never the two of U+00C8 / U+00FF in UTF-8.
    assert.deepEqual([...bytes].filter((byte) => byte >= 0x80), [0xc8, 0xff]);
    assert.equal(bytes.includes(Buffer.from([0xc3, 0x88])), false, 'not the UTF-8 pair C3 88');
    assert.deepEqual(
      lines.map((line) => line.split(';')[1].split(',')[3]),
      ['\u00c8', '\u00ff', 'A'],
      'the zone letter field is the raw character',
    );
    // The regression this guards: the same text written as UTF-8 is exactly two bytes longer.
    assert.equal(Buffer.from(bytes.toString('latin1'), 'utf8').length, bytes.length + 2);

    // And the checksum covers those bytes, not their UTF-8 form: the suite's own values for this
    // capture (654 bytes, `-a` locally). Hashing `C3 88` would give `4d302fbb` on the first line.
    assert.deepEqual(
      lines.map((line) => line.slice(line.lastIndexOf('*') + 1)),
      ['a59003d5', '375f19a2', 'c4355cf5'],
      'the `#…*crc` checksum is the CRC of the record bytes',
    );

    // The abbreviated form embeds the same character and the suite writes 645 bytes for it.
    const abbrev = runConvert(capture, 'ABBREV_ASCII');
    assert.equal(abbrev.bytes.length, 645);
    assert.deepEqual([...abbrev.bytes].filter((byte) => byte >= 0x80), [0xc8, 0xff]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PASSTHROUGH never reaches an output, not even BINARY', () => {
  const bestpos = b2Frame(42);
  const pass = Buffer.from(bestpos);
  pass.writeUInt16LE(1342, 4); // messageId is the u16 at offset 4 of the long header
  reseal(pass);
  const dir = mkdtempSync(join(tmpdir(), 'pass-'));
  try {
    const capture = join(dir, 'pass.sbf');
    writeFileSync(capture, Buffer.concat([bestpos, pass]));

    const ascii = runConvert(capture, 'ASCII');
    const asciiLines = ascii.bytes.toString('latin1').split('\r\n').filter((line) => line.length > 0);
    assert.equal(asciiLines.length, 1, 'the BESTPOS record only');
    assert.ok(asciiLines[0].startsWith('#BESTPOSA,'), asciiLines[0].slice(0, 40));
    assert.equal(ascii.summary.includes('PASSTHROUGH'), false, 'the summary does not count it');

    const abbrev = runConvert(capture, 'ABBREV_ASCII');
    assert.equal(abbrev.bytes.toString('latin1').includes('PASSTHROUGH'), false);

    // BINARY copies the accepted records verbatim, which would have included the passthrough.
    const binary = runConvert(capture, 'BINARY');
    assert.deepEqual(binary.bytes, bestpos, 'only the BESTPOS frame is copied');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ABBREV_ASCII reproduces the suite byte for byte when the capture is all binary records', () => {
  // b2: 905 records, no text records, and the RANGECMP2/4 expansion (638 RANGE in, 699 out).
  const { bytes } = runConvert(join(live, 'b2-20261101.sbf'), 'ABBREV_ASCII');
  const golden = readFileSync(join(live, 'golden-b2-20261101.ABBREV_ASCII'));
  assert.equal(bytes.length, 5_723_813);
  assert.deepEqual(bytes, golden);
});

test('ABBREV_ASCII matches the suite on b3 too (GLOCLOCK and RAWGPSSUBFRAME widths)', () => {
  // b3 is where the two abbreviated-reader defects showed: `GLOCLOCK` printed `toe` as `192` (the
  // low byte of 0x81600) and `RAWGPSSUBFRAME` read its `ULONG` two bytes early. Both records are
  // now read with the same width table and the same `pack(4)` rule as ASCII, so the file is the
  // suite's own bytes: 79 143 lines, 7 116 268 B (`--abbrev` on the installed 2.11.0).
  const { bytes } = runConvert(join(live, 'b3-20261101.sbf'), 'ABBREV_ASCII');
  const golden = readFileSync(join(live, 'golden-b3-20261101.ABBREV_ASCII'));
  assert.equal(bytes.length, 7_116_268);
  assert.deepEqual(bytes, golden);
});

test("ABBREV_ASCII converts the capture's text records, byte for byte", () => {
  const capture = readFileSync(join(live, 'b1-20261101.sbf'));
  const frames = framesOf(capture);
  const blocks = [...abbrevTextLogLines(frames, tables).values()];

  // Anchored on the capture, not on the function: these are the 99 records the suite's ABBREV
  // output has beyond b1's 1325 binary frames.
  const byName = new Map<string, number>();
  for (const block of blocks) {
    const name = /^<([A-Z][A-Z0-9_]*) /.exec(block[0])?.[1] ?? '(other)';
    byName.set(name, (byName.get(name) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...byName].sort()), {
    BESTPOS: 39, HWMONITOR: 2, RANGE: 26, RXSTATUS: 6, SATVIS2: 24, TIMESYNC: 2,
  });

  const found = (lines: readonly string[], produced: readonly string[]): boolean => {
    for (let start = 0; start + lines.length <= produced.length; start++) {
      if (lines.every((line, offset) => produced[start + offset] === line)) return true;
    }
    return false;
  };

  // The oracle first: every text record is a contiguous run of lines in the suite's own output.
  const golden = readFileSync(join(live, 'golden-b1-20261101.ABBREV_ASCII'), 'latin1').split('\r\n').filter((line) => line.length > 0);
  for (const block of blocks) assert.ok(found(block, golden), `in the suite's golden: ${block[0].slice(0, 80)}`);

  // Then the CLI's file: all 99 blocks are there, so the wiring cannot silently drop them.
  const { bytes } = runConvert(join(live, 'b1-20261101.sbf'), 'ABBREV_ASCII');
  const produced = bytes.toString('latin1').split('\r\n').filter((line) => line.length > 0);
  for (const block of blocks) assert.ok(found(block, produced), `in convert's ABBREV output: ${block[0].slice(0, 80)}`);

  // 1325 binary frames + 99 text records, minus the 22 RXCONFIG records whose embedded message the
  // dictionary does not have: `abbrev-log.ts` drops those exactly as the suite does, so the record
  // count is the golden's own.
  const records = produced.filter((line) => /^<[A-Z][A-Z0-9_]* /.test(line)).length;
  const goldenRecords = golden.filter((line) => /^<[A-Z][A-Z0-9_]* /.test(line)).length;
  assert.equal(records, 1325 + 99 - 22);
  assert.equal(records, goldenRecords, "the same records the suite's golden carries");

  // The whole 53 417-line file, text records and all, is the suite's own bytes.
  assert.deepEqual(bytes, readFileSync(join(live, 'golden-b1-20261101.ABBREV_ASCII')));
});
