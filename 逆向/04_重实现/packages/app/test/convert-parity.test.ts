/**
 * The GUI's Convert and the CLI's Convert must produce the **same bytes**.
 *
 * `app/src/convert.ts` used to carry its own copy of the pipeline and had drifted from the CLI:
 * it wrote UTF-8 instead of latin1 (every `%c` byte >= 0x80 gained a byte), kept `PASSTHROUGH`,
 * dropped text records and never expanded RANGECMP2/4. Both now call
 * `protocol/src/convert-pipeline.ts`, so the only thing left to prove is that the wrappers do not
 * add anything of their own — the comparison is `sha256`, not a length, and it runs on the two
 * captures where the old GUI differed most from the CLI:
 *
 *  - `b1`: 99 text records and a damaged frame (the view's `mirror` pass splits it differently);
 *  - `b2`: 61 RANGECMP2/4 blocks that have to be unpacked into RANGE rows;
 *  - plus the synthetic BESTUTM capture whose `zone_letter` is 0xC8 / 0xFF / 'A', where UTF-8
 *    would write 656 bytes instead of the suite's 654 and the checksums would be wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SbfDeframer, type SbfFrame } from '../../protocol/src/framing.ts';
import { novatelCrc32 } from '../../protocol/src/crc.ts';
import { formatDirectory } from '../../protocol/src/summary.ts';
import { loadCapture, tables, type CaptureData } from '../src/capture.ts';
import { convertCapture, type ConvertFormat } from '../src/convert.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const samplesDir = join(repoRoot, '逆向', '00_来源', 'samples');
const live = join(samplesDir, 'live-20261031');
const cli = resolve(here, '..', '..', 'cli', 'src', 'convert.ts');
const AT = new Date('2026-11-01T00:00:00');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The app's own capture cache, as `/api/convert` builds it. */
function captureData(path: string): CaptureData {
  const stat = statSync(path);
  return loadCapture({
    absolutePath: path,
    relPath: path.split('\\').join('/'),
    name: path.split(/[\\/]/).pop() ?? '',
    bytes: stat.size,
    mtimeMs: stat.mtimeMs,
  });
}

/** Run the CLI and hand back the one file it wrote. */
function cliOutput(input: string, format: ConvertFormat): Buffer {
  const out = mkdtempSync(join(tmpdir(), 'convert-parity-'));
  try {
    execFileSync(process.execPath, [cli, input, '--to', format, '--out', out, '--at', AT.toISOString()], { stdio: 'pipe' });
    const stem = input.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
    const converted = readdirSync(join(out, stem)).find((name) => name.startsWith('Converted_On_'));
    assert.ok(converted, `${format}: a Converted_On_<stamp> directory`);
    const dir = join(out, stem, converted, formatDirectory(format));
    const files = readdirSync(dir);
    assert.equal(files.length, 1, `${format}: exactly one output file`);
    return readFileSync(join(dir, files[0]));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

for (const name of ['b1-20261101', 'b2-20261101']) {
  const path = join(live, `${name}.sbf`);
  for (const format of ['ASCII', 'ABBREV_ASCII'] as const) {
    test(`GUI and CLI write the same ${format} bytes for ${name}`, () => {
      const artifact = convertCapture(captureData(path), tables(), format, AT);
      const file = cliOutput(path, format);
      assert.equal(artifact.fileName, `${name}.${format}`);
      assert.equal(artifact.bytes.length, file.length, 'same length');
      assert.equal(sha256(artifact.bytes), sha256(file), 'same sha256');
      assert.ok(artifact.bytes.equals(file), 'and the same bytes');
    });
  }
}

test('GUI and CLI agree on the raw `%c` bytes, and on the suite\'s 654-byte file', () => {
  // b2's BESTUTM with `zone_letter` (payload offset 12, payload starts after the 28-byte header)
  // set to 0xC8 and 0xFF, plus a plain `A` record so a printable letter is covered too.
  const utm = [...new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(join(live, 'b2-20261101.sbf'))))]
    .find((frame): frame is SbfFrame => frame.kind === 'sbf' && frame.header.messageId === 726);
  assert.ok(utm, 'b2 carries BESTUTM');
  const reseal = (frame: Buffer): Buffer => {
    frame.writeUInt32LE(novatelCrc32(new Uint8Array(frame.subarray(0, frame.length - 4))), frame.length - 4);
    return frame;
  };
  const records = [0xc8, 0xff, 0x41].map((letter) => {
    const frame = Buffer.from(utm.bytes);
    new DataView(frame.buffer, frame.byteOffset, frame.byteLength).setUint32(28 + 12, letter, true);
    return reseal(frame);
  });

  const dir = mkdtempSync(join(tmpdir(), 'zone-parity-'));
  try {
    const capture = join(dir, 'zone.sbf');
    writeFileSync(capture, Buffer.concat(records));

    const artifact = convertCapture(captureData(capture), tables(), 'ASCII', AT);
    // The suite writes 654 bytes for this capture (`-a`, 2.11.0); UTF-8 would write two more.
    assert.equal(artifact.bytes.length, 654);
    assert.deepEqual([...artifact.bytes].filter((byte) => byte >= 0x80), [0xc8, 0xff]);
    const lines = artifact.text!.split('\r\n').filter((line) => line.length > 0);
    assert.deepEqual(
      lines.map((line) => line.slice(line.lastIndexOf('*') + 1)),
      ['a59003d5', '375f19a2', 'c4355cf5'],
      'the checksums are taken over the record bytes',
    );

    const file = cliOutput(capture, 'ASCII');
    assert.equal(file.length, 654);
    assert.equal(sha256(artifact.bytes), sha256(file), 'GUI and CLI, byte for byte');

    // Abbreviated ASCII embeds the same two raw bytes; the suite writes 645 bytes.
    const abbrev = convertCapture(captureData(capture), tables(), 'ABBREV_ASCII', AT);
    assert.equal(abbrev.bytes.length, 645);
    assert.equal(sha256(abbrev.bytes), sha256(cliOutput(capture, 'ABBREV_ASCII')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
