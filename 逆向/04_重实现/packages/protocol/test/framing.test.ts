import test from 'node:test';
import assert from 'node:assert/strict';

import { SbfDeframer } from '../src/framing.ts';
import { buildLongHeader, LONG_HEADER_LENGTH } from '../src/header.ts';
import { appendCrcLe } from '../src/crc.ts';

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function longFrame(messageId: number, payload: number[]): Uint8Array {
  const header = buildLongHeader({ messageId, payloadLength: payload.length });
  return appendCrcLe(concat(header, Uint8Array.from(payload)));
}

function shortFrame(messageId: number, payload: number[], week = 2200, ms = 123456): Uint8Array {
  const head = new Uint8Array(12);
  head[0] = 0xaa;
  head[1] = 0x44;
  head[2] = 0x13;
  head[3] = payload.length;
  new DataView(head.buffer).setUint16(4, messageId, true);
  new DataView(head.buffer).setUint16(6, week, true);
  new DataView(head.buffer).setUint32(8, ms, true);
  return appendCrcLe(concat(head, Uint8Array.from(payload)));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

test('a complete long frame produces one SBF frame with a verified CRC', () => {
  const deframer = new SbfDeframer();
  const frames = deframer.push(longFrame(42, [1, 2, 3, 4]));
  assert.equal(frames.length, 1);
  const f = frames[0];
  assert.equal(f.kind, 'sbf');
  if (f.kind !== 'sbf') return;
  assert.equal(f.header.kind, 'long');
  assert.equal(f.header.messageId, 42);
  assert.equal(f.header.payloadLength, 4);
  assert.deepEqual([...f.payload], [1, 2, 3, 4]);
  assert.equal(f.bytes.length, LONG_HEADER_LENGTH + 4 + 4);
  assert.ok(f.crcOk);
});

test('a frame split across chunks is buffered, not dropped', () => {
  const frame = longFrame(42, [9, 9, 9, 9]);
  const deframer = new SbfDeframer();
  assert.deepEqual(deframer.push(frame.subarray(0, 5)), []);
  assert.equal(deframer.buffered, 5);
  assert.deepEqual(deframer.push(frame.subarray(5, 20)), []);
  assert.equal(deframer.buffered, 20);
  const frames = deframer.push(frame.subarray(20));
  assert.equal(frames.length, 1);
  assert.equal(deframer.buffered, 0);
});

test('several frames in one chunk are all returned', () => {
  const chunk = concat(longFrame(42, [1, 2, 3, 4]), longFrame(963, [5, 6, 7, 8]));
  const frames = new SbfDeframer().push(chunk);
  assert.equal(frames.length, 2);
  assert.deepEqual(
    frames.map((f) => (f.kind === 'sbf' ? f.header.messageId : -1)),
    [42, 963],
  );
});

test('garbage before a frame is dropped and reported', () => {
  const dropped: Array<[number, string]> = [];
  const deframer = new SbfDeframer({ onDrop: (n, reason) => dropped.push([n, reason]) });
  const chunk = concat(latin1('noise'), longFrame(42, [1, 2, 3, 4]));
  const frames = deframer.push(chunk);
  assert.equal(frames.length, 1);
  assert.deepEqual(dropped, [[5, 'garbage-before-record']]);
});

test('a 0xAA that is not a NovAtel sync is skipped byte by byte', () => {
  const deframer = new SbfDeframer();
  // Only two bytes: the de-framer cannot tell yet, so it holds them (original does the same).
  assert.deepEqual(deframer.push(Uint8Array.from([0xaa, 0x00])), []);
  assert.equal(deframer.buffered, 2);
  // A third byte that is neither 0x12 nor 0x13 rejects the candidate; the rest is scanned and dropped.
  assert.deepEqual(deframer.push(Uint8Array.from([0x11])), []);
  assert.equal(deframer.buffered, 0);
});

test('short frames are de-framed and carry week/ms at the short offsets', () => {
  const frames = new SbfDeframer().push(shortFrame(4093, [1, 2, 3, 4], 2200, 987654));
  assert.equal(frames.length, 1);
  const f = frames[0];
  if (f.kind !== 'sbf') throw new Error('expected sbf');
  assert.equal(f.header.kind, 'short');
  assert.equal(f.header.messageId, 4093);
  assert.equal(f.header.payloadLength, 4);
  assert.equal(f.header.week, 2200);
  assert.equal(f.header.milliseconds, 987654);
  assert.deepEqual([...f.payload], [1, 2, 3, 4]);
});

test('ASCII lines end at LF, port-prefixed lines end at ]', () => {
  const frames = new SbfDeframer().push(
    concat(latin1('#BESTPOSA,COM1,0,78.0,FINESTEERING;*9c9a92bb\r\n'), latin1('[COM1] version\r\n')),
  );
  assert.equal(frames.length, 2);
  if (frames[0].kind !== 'text' || frames[1].kind !== 'text') throw new Error('expected text frames');
  assert.equal(frames[0].prefix, '#');
  assert.ok(frames[0].text.endsWith('\r\n'));
  assert.equal(frames[1].prefix, '[text]');
  assert.equal(frames[1].text, '[COM1]');
});

test('an unterminated ASCII line is buffered until the newline arrives', () => {
  const deframer = new SbfDeframer();
  assert.deepEqual(deframer.push(latin1('#BESTPOSA,COM1')), []);
  assert.equal(deframer.buffered, 14);
  const frames = deframer.push(latin1(',0\r\n'));
  assert.equal(frames.length, 1);
  if (frames[0].kind !== 'text') throw new Error('expected text');
  assert.equal(frames[0].text, '#BESTPOSA,COM1,0\r\n');
});

test('a zero CRC field is dropped in mirror mode but accepted in ignore mode', () => {
  const frame = longFrame(42, [1, 2, 3, 4]);
  frame.fill(0, frame.length - 4);

  const mirrorDrops: string[] = [];
  const mirror = new SbfDeframer({ onDrop: (_n, reason) => mirrorDrops.push(reason) });
  assert.deepEqual(mirror.push(frame), []);
  assert.deepEqual(mirrorDrops, ['zero-crc-field']);

  const ignoring = new SbfDeframer({ crcMode: 'ignore' });
  const frames = ignoring.push(frame);
  assert.equal(frames.length, 1);
  if (frames[0].kind !== 'sbf') throw new Error('expected sbf');
  assert.equal(frames[0].crcOk, false);
});

test('a wrong CRC is still accepted in mirror mode (the original never verifies it)', () => {
  const frame = longFrame(42, [1, 2, 3, 4]);
  frame[frame.length - 1] ^= 0xff;
  const frames = new SbfDeframer().push(frame);
  assert.equal(frames.length, 1);
  if (frames[0].kind !== 'sbf') throw new Error('expected sbf');
  assert.equal(frames[0].crcOk, false);
  assert.notEqual(frames[0].crcField, 0);
});

test('validate mode rejects a wrong CRC', () => {
  const frame = longFrame(42, [1, 2, 3, 4]);
  frame[frame.length - 1] ^= 0xff;
  const reasons: string[] = [];
  const deframer = new SbfDeframer({ crcMode: 'validate', onDrop: (_n, r) => reasons.push(r) });
  assert.deepEqual(deframer.push(frame), []);
  assert.deepEqual(reasons, ['crc-mismatch']);
});

test('trailing garbage after a valid frame is reported, not silently kept', () => {
  const reasons: string[] = [];
  const deframer = new SbfDeframer({ onDrop: (_n, r) => reasons.push(r) });
  const frames = deframer.push(concat(longFrame(42, [1, 2, 3, 4]), latin1('junk')));
  assert.equal(frames.length, 1);
  assert.deepEqual(reasons, ['no-record-start']);
});
