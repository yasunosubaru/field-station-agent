/**
 * Segments the dictionary cannot place statically: everything behind a counted array.
 *
 * `IPSTATUS` (1289) is the case that forced it. Its `ip_status` is a `FIELD_ARRAY` of four-field
 * elements whose three strings are `variable` — `arrayLength` is a maximum, the wire carries the
 * text plus NUL padding — so the array is 48 bytes for b2's record while the sum of declared widths
 * says 212. Until 2026-11-01 the table put `dns_server` at offset 4 (the count prefix alone) and
 * `#IPSTATUSA` came out as `…,1,ETHA,"192.168.5.10","255.255.255.0","192.168.5.1",2,"192.168.5.10",
 * "255.255.255.0"` where the suite prints `…,1,ETHA,"192.168.5.10","255.255.255.0","192.168.5.1",1,
 * "192.168.5.1"` — the one remaining line of `golden-b2-20261101.ASCII`.
 *
 * The three layouts that were already byte-identical (`ICOMCONFIG`, `SETNAV`, `DNSCONFIG`) carry
 * their variable strings at the *top level*, where the stored offset plus the measured drift still
 * lands correctly, so they must not be marked dynamic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { SbfDeframer, type SbfFrame } from '../src/framing.ts';
import { encodeAsciiLog } from '../src/ascii-log.ts';
import { decodeEdie, type EdieTables } from '../src/edie.ts';

const here = dirname(fileURLToPath(import.meta.url));
const tables: EdieTables = JSON.parse(readFileSync(join(here, '..', 'data', 'edie-layouts.json'), 'utf8'));
const live = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031');

function dynamicSegments(fields: ReadonlyArray<{ dynamicOffset?: boolean; elements?: unknown }>): number {
  let count = 0;
  for (const field of fields) {
    if (field.dynamicOffset) count += 1;
    const nested = (field as { elements?: Array<{ dynamicOffset?: boolean }> }).elements;
    if (nested) count += dynamicSegments(nested);
  }
  return count;
}

test('the table marks what follows a counted array, and nothing else', () => {
  assert.equal(tables.messages['1289']?.name, 'IPSTATUS');
  const dns = tables.messages['1289']?.fields[1];
  assert.equal(dns?.name, 'dns_server');
  assert.equal(dns?.dynamicOffset, true, 'dns_server follows a variable-length array');
  assert.equal(dns?.kind, 'array');
  assert.equal((dns as { arrayKind?: string }).arrayKind, 'field');

  // The three that were byte-exact before the change read their variable strings from a stored
  // offset plus the drift; marking them dynamic would move them.
  for (const id of ['1248', '162', '1244']) {
    assert.equal(dynamicSegments(tables.messages[id]?.fields ?? []), 0, `${tables.messages[id]?.name} has no dynamic offset`);
  }
});

test('b2 IPSTATUSA is byte-identical to the golden', () => {
  const golden = readFileSync(join(live, 'golden-b2-20261101.ASCII'), 'latin1')
    .split('\r\n')
    .find((line) => line.startsWith('#IPSTATUSA,'));
  assert.ok(golden, 'the golden carries the record');
  const frames = new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(join(live, 'b2-20261101.sbf'))));
  const frame = frames.find((candidate): candidate is SbfFrame => candidate.kind === 'sbf' && candidate.header.messageId === 1289);
  assert.ok(frame, 'b2 carries IPSTATUS');
  const line = encodeAsciiLog(frame, tables.messages['1289']!, tables);
  assert.equal(line, golden);
  assert.ok(line.endsWith(';1,ETHA,"192.168.5.10","255.255.255.0","192.168.5.1",1,"192.168.5.1"*a1639585'), line.slice(-70));
});

test('the field decoder follows the same placement', () => {
  const frames = new SbfDeframer({ crcMode: 'validate' }).push(new Uint8Array(readFileSync(join(live, 'b2-20261101.sbf'))));
  const frame = frames.find((candidate): candidate is SbfFrame => candidate.kind === 'sbf' && candidate.header.messageId === 1289);
  assert.ok(frame, 'b2 carries IPSTATUS');
  const values = decodeEdie(frame.payload, tables.messages['1289']!, tables);
  const at = (path: string): string | number | undefined => values.find((value) => value.path === path)?.value;
  assert.equal(values.find((value) => value.path === 'dns_server.count')?.value, 1);
  assert.equal(at('ip_status[0].ip_address'), '192.168.5.10');
  assert.equal(at('ip_status[0].netmask'), '255.255.255.0');
  assert.equal(at('ip_status[0].gateway'), '192.168.5.1');
  assert.equal(at('dns_server[0].ip_address_6'), '192.168.5.1', 'read at 52, not at 4');
});
