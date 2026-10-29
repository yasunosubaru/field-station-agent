import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBinaryCommand,
  buildLogCommand,
  buildUnlogCommand,
  padStringValue,
} from '../src/command.ts';
import { parseHeader, LONG_HEADER_LENGTH, PORT_ADDRESS_THISPORT_30 } from '../src/header.ts';
import { novatelCrc32, readCrcLe } from '../src/crc.ts';

const TRIGGERS = { ONNEW: 0, ONCHANGED: 1, ONTIME: 2, ONNEXT: 3, ONCE: 4, ONMARK: 5, ONALL: 6 };
const HOLDS = { NOHOLD: 0, HOLD: 1 };

test('binary command header matches toem4header defaults', () => {
  const cmd = buildBinaryCommand({ messageId: 1, params: [{ type: 'ulong', value: 7, length: 4 }] });
  assert.equal(cmd.length, LONG_HEADER_LENGTH + 4 + 4);
  const header = parseHeader(cmd);
  assert.ok(header && header !== 'need-more');
  if (!header || header === 'need-more' || header.kind !== 'long') throw new Error('unexpected header');
  assert.equal(header.messageId, 1);
  assert.equal(header.messageTypeByte, 0);
  assert.equal(header.portAddress, PORT_ADDRESS_THISPORT_30);
  assert.equal(header.payloadLength, 4);
  assert.equal(header.sequence, 0);
  assert.equal(header.idleTimeRaw, 0);
  assert.equal(header.timeStatus, 0);
  assert.equal(header.week, 0);
  assert.equal(header.milliseconds, 0);
  assert.equal(header.receiverStatus, 0);
  assert.equal(header.reserved, 0);
  assert.equal(header.softwareVersion, 0);
});

test('every binary command appends a little-endian CRC over header+payload', () => {
  const cmd = buildBinaryCommand({ messageId: 1, params: [{ type: 'ulong', value: 0xdeadbeef, length: 4 }] });
  const body = cmd.subarray(0, cmd.length - 4);
  assert.equal(readCrcLe(cmd, cmd.length - 4), novatelCrc32(body));
});

test('LOG payload is 32 bytes with the documented field order', () => {
  const cmd = buildLogCommand({
    portAddress: PORT_ADDRESS_THISPORT_30,
    messageId: 42,
    ascii: false,
    trigger: 'ONTIME',
    periodSeconds: 1,
    triggerValues: TRIGGERS,
    holdValues: HOLDS,
  });
  assert.equal(cmd.length, LONG_HEADER_LENGTH + 32 + 4);
  const dv = new DataView(cmd.buffer, cmd.byteOffset + LONG_HEADER_LENGTH, 32);
  assert.equal(dv.getUint32(0, true), 222); // port
  assert.equal(dv.getUint16(4, true), 42); // message id
  assert.equal(dv.getUint8(6), 0); // message type: binary
  assert.equal(dv.getUint8(7), 0); // reserved
  assert.equal(dv.getUint32(8, true), 2); // ONTIME
  assert.equal(dv.getFloat64(12, true), 1); // period
  assert.equal(dv.getFloat64(20, true), 0); // offset
  assert.equal(dv.getUint32(28, true), 1); // HOLD
});

test('non-ONTIME triggers force period to zero', () => {
  const cmd = buildLogCommand({
    portAddress: 222,
    messageId: 42,
    ascii: true,
    trigger: 'ONNEW',
    periodSeconds: 5,
    triggerValues: TRIGGERS,
    holdValues: HOLDS,
  });
  const dv = new DataView(cmd.buffer, cmd.byteOffset + LONG_HEADER_LENGTH, 32);
  assert.equal(dv.getUint8(6), 32); // ASCII message type
  assert.equal(dv.getUint32(8, true), 0); // ONNEW
  assert.equal(dv.getFloat64(12, true), 0); // period forced to 0
});

test('UNLOG payload is 8 bytes and uses message id 36', () => {
  const cmd = buildUnlogCommand({ portAddress: 222, messageId: 42 });
  assert.equal(cmd.length, LONG_HEADER_LENGTH + 8 + 4);
  const header = parseHeader(cmd);
  if (!header || header === 'need-more' || header.kind !== 'long') throw new Error('unexpected header');
  assert.equal(header.messageId, 36);
  assert.equal(header.payloadLength, 8);
});

test('string padding follows the original two-rule logic', () => {
  assert.deepEqual(padStringValue('abc'), { value: 'abc\0', length: 4 });
  assert.deepEqual(padStringValue('abcd'), { value: 'abcd\0\0\0\0', length: 8 });
  assert.deepEqual(padStringValue('abcd\0'), { value: 'abcd\0\0\0\0', length: 8 });
  assert.deepEqual(padStringValue('ab\0\0'), { value: 'ab\0\0', length: 4 });
});

test('string parameters are written NUL padded', () => {
  const cmd = buildBinaryCommand({
    messageId: 178,
    params: [{ type: 'string', value: 'abc', length: 3 }],
  });
  const payload = cmd.subarray(LONG_HEADER_LENGTH, cmd.length - 4);
  assert.deepEqual([...payload], [0x61, 0x62, 0x63, 0x00]);
});
