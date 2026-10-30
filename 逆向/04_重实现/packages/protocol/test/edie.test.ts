/**
 * The EDIE path: layouts generated from the suite's own message dictionary, plus the acceptance
 * gate that compares a full decode against the ASCII the suite produced from the same bytes.
 *
 * `samples/convert/golden-broad-ascii/…/broad-clean.ASCII` is `NovAtelApplicationSuite.exe -a`
 * output for `samples/convert/broad-clean.gps`. Every line and every field of it has to come back
 * identical from `decodeEdie`, including the repeated blocks the old `logparsers.js` table never
 * declared (RANGE 45–50 observations per line, TRACKSTAT 177 channels, …).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decodeEdie, edieFixedSize, type EdieTables } from '../src/edie.ts';
import { diffAscii, parseAsciiLog } from '../src/ascii-diff.ts';
import { SbfDeframer } from '../src/framing.ts';

const here = dirname(fileURLToPath(import.meta.url));
const data = (name: string) => JSON.parse(readFileSync(join(here, '..', 'data', name), 'utf8'));
const tables: EdieTables = data('edie-layouts.json');

const samples = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'convert');
const capturePath = join(samples, 'broad-clean.gps');
const asciiPath = join(samples, 'golden-broad-ascii', 'broad-clean', 'Converted_On_20261030_T1800', 'ASCII', 'broad-clean.ASCII');

/** Decode frame `index` of message `id` from the capture. */
function framePayloads(capture: Uint8Array, id: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const frame of new SbfDeframer({ crcMode: 'mirror' }).push(capture)) {
    if (frame.kind === 'sbf' && frame.header.messageId === id) out.push(frame.payload);
  }
  return out;
}

test('the dictionary covers every log in the golden capture', () => {
  const capture = new Uint8Array(readFileSync(capturePath));
  const ids = new Set<number>();
  for (const frame of new SbfDeframer({ crcMode: 'mirror' }).push(capture)) {
    if (frame.kind === 'sbf') ids.add(frame.header.messageId);
  }
  const missing = [...ids].filter((id) => !tables.messages[String(id)]);
  assert.deepEqual(missing, [], 'every message id on the wire has a layout');
});

test('fixed-size layouts match the payload lengths measured on the wire', () => {
  // Sizes from `samples/convert/broad-clean.gps`: payload length per message id.
  assert.equal(edieFixedSize(tables.messages['101']), 44, 'TIME');
  assert.equal(edieFixedSize(tables.messages['99']), 44, 'BESTVEL (z is a DOUBLE, so 44 not 40)');
  assert.equal(edieFixedSize(tables.messages['42']), 72, 'BESTPOS (base_id is a 4-byte string, not an array)');
});

test('repeated logs use a 4-byte count prefix and a wire stride', () => {
  const rxstatus = tables.messages['93'].fields[1];
  assert.equal(rxstatus.kind, 'array');
  assert.equal(rxstatus.countSize, 4);
  assert.equal(rxstatus.stride, 16, 'status, priority mask, event set mask, event clear mask');
  assert.equal(tables.messages['43'].fields[0].stride, 44, 'RANGE observation');
  assert.equal(tables.messages['1043'].fields[3].stride, 40, 'SATVIS2 satellite');
  assert.equal(tables.messages['1194'].fields[0].stride, 16, 'BESTSATS satellite');
});

test('RANGE: 50 observations, ASCII precision on pseudorange and carrier phase', () => {
  const capture = new Uint8Array(readFileSync(capturePath));
  const payload = framePayloads(capture, 43)[0];
  assert.equal(payload.byteLength, 4 + 50 * 44);
  const values = decodeEdie(payload, tables.messages['43'], tables);
  assert.equal(values[0].text, '50', 'the element count is printed first');
  const psr = values.find((value) => value.path === 'obs[0].psr');
  assert.ok(Math.abs(Number(psr?.value) - 21844881.448560562) < 1e-6);
  const adr = values.find((value) => value.path === 'obs[49].adr');
  assert.ok(adr, 'the last observation is decoded too, not only the first block');
});

test('BESTPOS: the ASCII masks are the payload bytes, in print order', () => {
  const capture = new Uint8Array(readFileSync(capturePath));
  const values = decodeEdie(framePayloads(capture, 42)[0], tables.messages['42'], tables);
  const tail = values.slice(-4).map((value) => value.text);
  assert.deepEqual(tail, ['00', '06', '30', '03'], 'extended status + Galileo/BDS + GPS/GLO masks, byte-wise hex');
});

test('RAWEPHEM subframes print as lowercase hex of the raw bytes', () => {
  const capture = new Uint8Array(readFileSync(capturePath));
  const values = decodeEdie(framePayloads(capture, 41)[0], tables.messages['41'], tables);
  const subframe = values.find((value) => value.path === 'subframe1');
  assert.equal(subframe?.text?.length, 60, '30 bytes → 60 hex characters');
  assert.match(String(subframe?.text), /^[0-9a-f]{60}$/);
});

test('every field of the suite ASCII output decodes identically', () => {
  const ascii = readFileSync(asciiPath, 'utf8');
  const capture = new Uint8Array(readFileSync(capturePath));
  const result = diffAscii(ascii, capture, tables, { sampleLimit: 3 });
  const lines = parseAsciiLog(ascii).length;
  assert.equal(result.messages.reduce((n, row) => n + row.shape, 0), 0, 'no layout shape mismatches');
  assert.equal(result.fields, 722761, `all ${lines} ASCII lines compared`);
  assert.equal(result.bad, 0, result.messages.flatMap((row) => row.samples.map((s) => `${row.name} ${s}`)).slice(0, 10).join('\n'));
});
