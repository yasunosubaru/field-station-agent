import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildAsciiCommand, makePortNamePredicate } from '../src/ascii.ts';
import { novatelCrc32, crcHex } from '../src/crc.ts';

const here = dirname(fileURLToPath(import.meta.url));
const portNames: string[] = JSON.parse(
  readFileSync(join(here, '..', 'data', 'portnames.json'), 'utf8'),
);
const isPortName = makePortNamePredicate(portNames);

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function bodyOf(cmd: string): string {
  // strip the leading CRLF + '#' and the trailing '*' + 8 hex digits + CRLF
  return cmd.slice(3, -11);
}

test('port name list matches the application table size', () => {
  assert.equal(portNames.length, 1552);
  assert.ok(isPortName('COM1'));
  assert.ok(isPortName('THISPORT_30'));
  assert.ok(!isPortName('BESTPOSB'));
});

test('LOG without an explicit port gets the implicit `thisport`', () => {
  const cmd = buildAsciiCommand('log bestposb ontime 1', isPortName);
  assert.equal(
    bodyOf(cmd),
    'LOG,THISPORT_30,0,0,UNKNOWN,0,0,0,0,0;thisport,bestposb,ontime,1',
  );
  assert.ok(cmd.startsWith('\r\n#'));
  assert.ok(cmd.endsWith('\r\n'));
});

test('LOG with an explicit port keeps it', () => {
  assert.equal(
    bodyOf(buildAsciiCommand('log com1 bestposb ontime 1', isPortName)),
    'LOG,THISPORT_30,0,0,UNKNOWN,0,0,0,0,0;com1,bestposb,ontime,1',
  );
});

test('UNLOG is upper-cased and gets the implicit port too', () => {
  assert.equal(
    bodyOf(buildAsciiCommand('unlog bestposb', isPortName)),
    'UNLOG,THISPORT_30,0,0,UNKNOWN,0,0,0,0,0;thisport,bestposb',
  );
});

test('repeated spaces collapse to a single separator', () => {
  assert.equal(
    bodyOf(buildAsciiCommand('log   bestposb   ontime   1', isPortName)),
    'LOG,THISPORT_30,0,0,UNKNOWN,0,0,0,0,0;thisport,bestposb,ontime,1',
  );
});

test('commands other than LOG/UNLOG are passed through untouched', () => {
  assert.equal(
    bodyOf(buildAsciiCommand('version', isPortName)),
    'version,THISPORT_30,0,0,UNKNOWN,0,0,0,0,0;',
  );
});

test('the emitted CRC covers everything after \\r\\n#', () => {
  const cmd = buildAsciiCommand('log bestposb ontime 1', isPortName);
  const body = bodyOf(cmd);
  const crcInCommand = cmd.slice(-10, -2);
  assert.equal(crcInCommand, crcHex(novatelCrc32(latin1(body))));
  assert.equal(crcInCommand, crcInCommand.toLowerCase());
});
