/**
 * The 23-type live capture: every line of the suite's own Convert output, byte for byte.
 *
 * Fixture: `samples/live-20261031/remote-23types.sbf` (2 018 852 B) was recorded on the remote
 * receiver host (OEM729 on DESKTOP-9POIV0O) with the suite's Convert running afterwards:
 * `golden-remote-23types.ASCII` (3 845 232 B, 1208 records, 23 log types).
 *
 * This file pins the four protocol defects found on 2026-11-01 (see `03_分析/16_交接_下一步.md`
 * §16.5 and `17_协议缺陷修复.md`), which cost 189 of those 1208 lines:
 *
 *   1. `ITPSDFINAL` / `ITPSDDETECT` — the power samples are a `VARIABLE_LENGTH_ARRAY` in the
 *      dictionary, and printing it as one `%hu` scalar truncated 1024 numbers to a count;
 *   2. `LOGLIST` — `%m` prints a log id as a name, with the `1<<21` / `1<<22` flag bits selecting
 *      the `A` suffix and the suffix-less flavour;
 *   3. `ITDETECTSTATUS` — `%08X` prints lowercase, so `0000000f`, not `0000000F`;
 *   4. `RXCONFIG` — `%R` is an embedded binary message printed as its own ASCII line, and that
 *      line's CRC is the complement of the usual one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type SbfFrame } from '../src/framing.ts';
import { encodeAsciiLog, formatField } from '../src/ascii-log.ts';
import type { EdieScalar, EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));

const dir = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');
const capturePath = join(dir, 'remote-23types.sbf');
const goldenPath = join(dir, 'golden-remote-23types.ASCII');

function frames(): SbfFrame[] {
  return [...new SbfDeframer({ crcMode: 'mirror' }).push(new Uint8Array(readFileSync(capturePath)))]
    .filter((frame): frame is SbfFrame => frame.kind === 'sbf');
}

function lines(): string[] {
  return frames().map((frame) => {
    const layout = tables.messages[String(frame.header.messageId)];
    return layout ? encodeAsciiLog(frame, layout, tables) : '';
  }).filter((line) => line !== '');
}

test('every line of the 23-type golden is reproduced byte for byte', () => {
  const golden = readFileSync(goldenPath, 'utf8').split(/\r?\n/).filter((line) => line.startsWith('#'));
  const produced = lines();
  assert.equal(golden.length, 1208, '23 log types, 1208 records');
  assert.equal(produced.length, golden.length);
  const differences: string[] = [];
  for (let i = 0; i < golden.length && differences.length < 5; i++) {
    if (produced[i] === golden[i]) continue;
    let at = 0;
    while (at < golden[i].length && golden[i][at] === produced[i][at]) at += 1;
    differences.push(`#${i} at ${at}\n  golden: ${golden[i].slice(Math.max(0, at - 30), at + 40)}\n  ours  : ${produced[i].slice(Math.max(0, at - 30), at + 40)}`);
  }
  assert.deepEqual(differences, [], 'byte-identical');
});

test('ITPSDFINAL expands all 1024 samples of its variable-length array', () => {
  const layout = tables.messages['1968'];
  const samples = layout.fields[layout.fields.length - 1];
  assert.equal(samples.kind, 'array', 'the dictionary declares VARIABLE_LENGTH_ARRAY');
  assert.equal(samples.kind === 'array' ? samples.countSize : -1, 4, 'u32 element count in front');
  assert.equal(samples.kind === 'array' ? samples.stride : -1, 2, '2-byte samples');

  const line = lines().find((text) => text.startsWith('#ITPSDFINALA'))!;
  assert.equal(line.length, 6267, 'the length the suite prints');
  const body = line.slice(line.indexOf(';') + 1, line.lastIndexOf('*')).split(',');
  assert.equal(body.length, 4 + 1024, 'status, start, step, count, then 1024 samples');
  assert.equal(body[2], '97656.250', 'step size stays a `%9.3k` fixed value');
  assert.equal(body[3], '1024', 'the count itself');
  assert.equal(body[4], '23511', 'first power sample');
  assert.equal(body[1027], '23039', 'last power sample');
});

test('%m prints a log id as a name, with the flag bits choosing the suffix', () => {
  const segment: EdieScalar = { name: 'message_id', kind: 'scalar', offset: 0, size: 4, type: 'u32', format: '%m' };
  assert.equal(formatField(segment, 41, tables), 'RAWEPHEMB', 'a plain id is the binary log');
  assert.equal(formatField(segment, 2097246, tables), 'RXSTATUSEVENTA', '1<<21 + 94 is the ASCII log');
  assert.equal(formatField(segment, 4194796, tables), 'TIMESYNC', '1<<22 + 492 carries no suffix');
  assert.equal(formatField(segment, 2075, tables), 'UNKNOWNB', 'not in the dictionary');
  assert.equal(formatField(segment, 0x400000 + 2075, tables), 'UNKNOWN', 'the suffix-less flavour too');
});

test('hex prints lowercase whichever case the conversion string asks for', () => {
  const segment: EdieScalar = { name: 'severity', kind: 'scalar', offset: 0, size: 4, type: 'u32', format: '%08X' };
  assert.equal(formatField(segment, 15, tables), '0000000f', 'ITDETECTSTATUS severity words');
  assert.equal(formatField({ ...segment, format: '%08x' }, 15, tables), '0000000f');
  assert.equal(formatField({ ...segment, format: '%02XB', size: 1, type: 'u8' }, 0x0a, tables), '0a', 'BESTPOS masks');
});

test('RXCONFIG prints its embedded message as a finished ASCII line', () => {
  const line = lines().find((text) => text.startsWith('#RXCONFIGA'))!;
  const body = line.slice(line.indexOf(';') + 1);
  assert.ok(body.startsWith('#LOGA,SPECIAL_30,0,72.0,COARSESTEERING,2442,563598.156'), body.slice(0, 60));
  assert.ok(body.includes(';USB1,BESTPOSB,ONTIME,1.000000,0.000000,NOHOLD*'), 'the embedded LOG payload');
  // The embedded line's CRC is the complement of the NovAtel CRC, the outer one is not.
  assert.ok(body.includes('*8fbf58c8*'), 'embedded crc');
  assert.ok(line.endsWith('*18feb321'), 'outer crc');
});
