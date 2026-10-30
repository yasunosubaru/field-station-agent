import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PlaybackEngine, PLAYBACK_SPEEDS, type PlaybackFrameEvent } from '../src/playback.ts';
import { GPS_WEEK_MS } from '../src/timeline.ts';
import { SbfDeframer, type SbfFrame } from '../../protocol/src/framing.ts';
import { encodeAsciiLog } from '../../protocol/src/ascii-log.ts';
import { buildLongHeader } from '../../protocol/src/header.ts';
import { appendCrcLe } from '../../protocol/src/crc.ts';
import type { EdieTables } from '../../protocol/src/edie.ts';

const SAMPLE = fileURLToPath(new URL('../../../../../逆向/00_来源/samples/convert/clean-9600.gps', import.meta.url));
const TABLES = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../protocol/data/edie-layouts.json', import.meta.url)), 'utf8'),
) as EdieTables;

const capture = new Uint8Array(readFileSync(SAMPLE));

/** Raw accepted records of the sample, in file order. */
function rawFrames(bytes: Uint8Array = capture): SbfFrame[] {
  return new SbfDeframer({ crcMode: 'mirror' })
    .push(bytes)
    .filter((frame): frame is SbfFrame => frame.kind === 'sbf' && frame.crcOk);
}

/**
 * Independent copy of the documented offset rule: offset 0 for the first record, then the
 * (never decreasing) difference from it.
 */
function expectedOffsets(frames: SbfFrame[]): number[] {
  const start = frames[0].header.week * GPS_WEEK_MS + frames[0].header.milliseconds;
  let offset = 0;
  return frames.map((frame, index) => {
    const absolute = frame.header.week * GPS_WEEK_MS + frame.header.milliseconds;
    if (index > 0) offset = Math.max(offset, absolute - start);
    return offset;
  });
}

function frameAt(week: number, milliseconds: number, messageId = 43, payload = [1, 2, 3, 4]): Uint8Array {
  const header = buildLongHeader({
    messageId,
    payloadLength: payload.length,
    week,
    milliseconds,
    timeStatus: 180,
    portAddress: 0xa0,
  });
  return appendCrcLe(concat(header, Uint8Array.from(payload)));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

test('clean-9600: 119 frames, a ~5 s timeline, first/last timestamp', () => {
  const engine = new PlaybackEngine();
  engine.load(capture);

  assert.equal(engine.frameCount, 119);
  assert.equal(engine.startWeek, 2442);
  assert.equal(engine.finishWeek, 2442);
  assert.equal(engine.startTime, 463097.35);
  assert.equal(engine.finishTime, 463102.3);
  // 20 Hz RANGE from 463097.350 to 463102.300.
  assert.equal(engine.duration, 4950);
  assert.ok(Math.abs(engine.duration - 5000) <= 100, `duration ${engine.duration} not ~5000 ms`);

  const first = engine.frames[0];
  const last = engine.frames[engine.frames.length - 1];
  assert.equal(first.messageId, 43);
  assert.equal(first.milliseconds, 463097350);
  assert.equal(first.offsetMs, 0);
  assert.equal(last.messageId, 43);
  assert.equal(last.milliseconds, 463102300);
  assert.equal(last.offsetMs, 4950);

  const info = engine.info();
  assert.equal(info.frameCount, 119);
  assert.equal(info.messageCounts[43], 100);
  assert.equal(info.messageCounts[41], 8);
  assert.equal(info.stats.badCrc, 0);
  assert.equal(info.stats.textFrames, 0);
});

test('the timeline never goes backwards (out-of-order RAWEPHEM is clamped)', () => {
  const engine = new PlaybackEngine();
  engine.load(capture);

  const offsets = engine.frames.map((frame) => frame.offsetMs);
  for (let i = 1; i < offsets.length; i++) {
    assert.ok(offsets[i] >= offsets[i - 1], `offset went backwards at ${i}`);
  }
  // Records 17 and 18 carry 463080000 (17.35 s before the first record) and share record 16's slot.
  assert.equal(engine.frames[16].milliseconds, 463098100);
  assert.equal(engine.frames[17].milliseconds, 463080000);
  assert.equal(engine.frames[17].offsetMs, engine.frames[16].offsetMs);
  assert.equal(engine.frames[18].offsetMs, engine.frames[16].offsetMs);
});

test('a record whose CRC does not match is dropped on load', () => {
  const good = frameAt(2442, 1000);
  const bad = Uint8Array.from(good);
  bad[28] ^= 0xff; // payload byte; the CRC field is untouched (non-zero), so 'mirror' accepts it

  const accepted = new SbfDeframer({ crcMode: 'mirror' }).push(bad);
  assert.equal(accepted.length, 1);
  assert.equal((accepted[0] as SbfFrame).crcOk, false);

  const engine = new PlaybackEngine();
  engine.load(bad);
  assert.equal(engine.frameCount, 0);
  assert.equal(engine.info().stats.badCrc, 1);
});

test('seek(2.5) starts at the first record at or after 2.5 s', () => {
  const engine = new PlaybackEngine();
  engine.load(capture);
  const start = engine.frames[0].milliseconds;

  engine.seek(2.5);
  assert.equal(engine.currentTime, 2.5);

  engine.play();
  const emitted = engine.tick(0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].offsetMs, 2500);
  assert.equal(emitted[0].milliseconds, start + 2500);
  assert.ok(Math.abs(emitted[0].time - 2.5) < 1e-9);

  // And playback really continues from there: the next step reaches the following 20 Hz record.
  const next = engine.tick(50);
  assert.equal(next.length, 1);
  assert.equal(next[0].offsetMs, 2550);
});

test('speed 4 with tick(250) advances 1000 ms', () => {
  const engine = new PlaybackEngine();
  engine.load(capture);
  engine.play();
  engine.speed = 4;

  const emitted = engine.tick(250);
  assert.equal(engine.currentTimeMs, 1000);
  assert.ok(emitted.length > 0);
  for (const event of emitted) assert.ok(event.offsetMs <= 1000);
  assert.equal(emitted[emitted.length - 1].offsetMs, 1000);

  assert.ok(PLAYBACK_SPEEDS.includes(4));
  assert.throws(() => {
    engine.speed = 3 as never;
  }, RangeError);
});

test('a tick only emits the records it reaches, not the whole capture', () => {
  const engine = new PlaybackEngine();
  engine.load(capture);
  const seen: PlaybackFrameEvent[] = [];
  engine.on('frame', (event) => seen.push(event));

  engine.play();
  const emitted = engine.tick(50);
  assert.equal(emitted.length, 2); // offsets 0 and 50
  assert.equal(seen.length, 2);
  assert.ok(seen.length < engine.frameCount);
  assert.deepEqual(
    emitted.map((event) => event.offsetMs),
    [0, 50],
  );
});

test('pause stops emission and seek backward continues from the new position', () => {
  const engine = new PlaybackEngine();
  engine.load(capture);

  engine.play();
  engine.tick(100);
  assert.equal(engine.currentTimeMs, 100);

  engine.pause();
  assert.equal(engine.state, 'paused');
  assert.equal(engine.tick(5000).length, 0);
  assert.equal(engine.currentTimeMs, 100);

  engine.seek(1.0);
  engine.play();
  const emitted = engine.tick(0);
  assert.ok(emitted.length >= 1);
  assert.equal(emitted[0].offsetMs, 1000);
  assert.equal(emitted[0].milliseconds, engine.frames[0].milliseconds + 1000);
});

test('reaching the end emits ended once and play() restarts', () => {
  const engine = new PlaybackEngine();
  engine.load(capture);
  const seen: string[] = [];
  engine.on('ended', () => seen.push('ended'));

  engine.play();
  engine.speed = 8;
  engine.tick(engine.duration / 8 + 10);
  assert.equal(engine.state, 'ended');
  assert.equal(seen.length, 1);
  assert.equal(engine.currentTimeMs, engine.duration);

  assert.equal(engine.tick(100).length, 0);
  assert.equal(seen.length, 1);

  engine.play();
  assert.equal(engine.state, 'playing');
  assert.equal(engine.currentTimeMs, 0);
});

test('an injected clock advances tick() without a delta', () => {
  let now = 1000;
  const engine = new PlaybackEngine({ clock: () => now });
  engine.load(capture);
  engine.play();

  assert.deepEqual(engine.tick(), []); // first call only establishes the baseline
  now += 250;
  const emitted = engine.tick();
  assert.equal(engine.currentTimeMs, 250);
  assert.deepEqual(
    emitted.map((event) => event.offsetMs),
    [0, 50, 100, 150, 200, 250],
  );
});

test('exportRange(1.0, 2.0) copies exactly the frames in the range, CRCs intact', () => {
  const engine = new PlaybackEngine();
  engine.load(capture);

  const frames = rawFrames();
  const offsets = expectedOffsets(frames);
  const expected = frames.filter((_, index) => offsets[index] >= 1000 && offsets[index] <= 2000);
  assert.ok(expected.length > 0);

  const bytes = engine.exportRange(1.0, 2.0);
  assert.equal(
    bytes.byteLength,
    expected.reduce((total, frame) => total + frame.bytes.length, 0),
  );
  assert.equal(engine.range(1.0, 2.0).frameCount, expected.length);

  const back = new SbfDeframer({ crcMode: 'mirror' })
    .push(bytes)
    .filter((frame): frame is SbfFrame => frame.kind === 'sbf');
  assert.equal(back.length, expected.length);
  for (let i = 0; i < back.length; i++) {
    // Byte-for-byte the captured record, and its CRC field is the original non-zero value.
    assert.deepEqual([...back[i].bytes], [...expected[i].bytes]);
    assert.notEqual(back[i].crcField, 0);
    assert.ok(back[i].crcOk);
  }
});

test('exportAscii(1.0, 2.0) is identical to encodeAsciiLog line for line', () => {
  const engine = new PlaybackEngine();
  engine.load(capture);

  const frames = rawFrames();
  const offsets = expectedOffsets(frames);
  const expectedLines: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    if (offsets[i] < 1000 || offsets[i] > 2000) continue;
    const layout = TABLES.messages[String(frames[i].header.messageId)];
    if (!layout) continue;
    const line = encodeAsciiLog(frames[i], layout, TABLES);
    if (line) expectedLines.push(line);
  }
  assert.ok(expectedLines.length > 0);

  const text = engine.exportAscii(1.0, 2.0, TABLES);
  assert.deepEqual(text.split('\r\n').slice(0, -1), expectedLines);
  assert.equal(text, `${expectedLines.join('\r\n')}\r\n`);
  for (const line of expectedLines) assert.ok(line.startsWith('#'));
});

test('a capture that crosses a GPS week boundary keeps a monotonic timeline', () => {
  const engine = new PlaybackEngine();
  engine.load(concat(frameAt(2442, GPS_WEEK_MS - 500), frameAt(2443, 600)));

  assert.equal(engine.frameCount, 2);
  assert.equal(engine.startWeek, 2442);
  assert.equal(engine.finishWeek, 2443);
  assert.equal(engine.startTime, 604799.5);
  assert.equal(engine.finishTime, 0.6);
  assert.equal(engine.duration, 1100);
  assert.deepEqual(
    engine.frames.map((frame) => frame.offsetMs),
    [0, 1100],
  );
});

test('seek clamps to the capture and rejects nonsense', () => {
  const engine = new PlaybackEngine();
  engine.load(capture);

  engine.seek(-10);
  assert.equal(engine.currentTimeMs, 0);
  engine.seek(999);
  assert.equal(engine.currentTimeMs, engine.duration);
  assert.throws(() => engine.seek(Number.NaN), RangeError);
  assert.throws(() => new PlaybackEngine().seek(1), /no capture loaded/);
});
