/**
 * Turn one capture into a playable timeline.
 *
 * The original suite never builds a time index: it re-scans the file on every seek and groups
 * records into "epochs" by timestamp (`01_解包/app/controller/playback.js:671-767`). Here the
 * capture is de-framed once, in file order, and every accepted record gets a monotonic offset from
 * the first record. That single pass is the whole index.
 *
 * Time base: the SBF long header carries GPS **week** (`+14`, u16 LE) and **milliseconds of week**
 * (`+16`, u32 LE) — see `packages/protocol/src/header.ts`. The absolute time is
 * `week * 604800000 + milliseconds`, so a capture that crosses a week boundary needs no special
 * case: the week field already moved on. Only a record whose millisecond field wrapped without its
 * week field advancing is repaired (`+604800000`).
 *
 * Out-of-order records: `clean-9600.gps` repeats eight RAWEPHEM records stamped 17.35 s *before*
 * the first RANGE record (the receiver logged them with an older Z-count). The original silently
 * drops anything whose timestamp went backwards (R44 in `04_Playback组件.md` §8). Dropping them
 * would lose data that a reimplementation can legitimately keep, so the offset is instead clamped
 * to the previous record: they play in the same instant as the record before them, which is how the
 * original emits a whole same-timestamp epoch in one go. The result is a strictly non-decreasing
 * timeline, which is what `tick()` relies on.
 */

import { SbfDeframer, type SbfFrame } from '../../protocol/src/framing.ts';

/** GPS week in milliseconds. */
export const GPS_WEEK_MS = 604_800_000;

export interface TimedFrame {
  /** Position in the timeline (file order, accepted records only). */
  index: number;
  /** The record exactly as captured; `bytes` is never rebuilt. */
  frame: SbfFrame;
  messageId: number;
  week: number;
  milliseconds: number;
  /** `week * GPS_WEEK_MS + milliseconds`, with a stale week field repaired. */
  absoluteMs: number;
  /** Milliseconds since the first accepted record; never decreases. */
  offsetMs: number;
}

export interface TimelineStats {
  /** Text records (ASCII/NMEA) — playback is binary only, they are counted and skipped. */
  textFrames: number;
  /** SBF records dropped because the CRC field did not match (`crcOk === false`). */
  badCrc: number;
  /** Bytes left over at the end of the capture (an incomplete trailing record). */
  bufferedBytes: number;
}

export interface Timeline {
  frames: TimedFrame[];
  /** Absolute GPS time of the first record. */
  startAbsoluteMs: number;
  /** Absolute GPS time of the last record. */
  finishAbsoluteMs: number;
  /** Week of the first record. */
  startWeek: number;
  /** Seconds of week of the first record. */
  startTime: number;
  /** Week of the last record (differs from `startWeek` when the capture crosses a week). */
  finishWeek: number;
  /** Seconds of week of the last record. */
  finishTime: number;
  /** Length of the timeline in ms (`offsetMs` of the last record). */
  durationMs: number;
  messageCounts: Map<number, number>;
  stats: TimelineStats;
}

/** De-frame a capture into a timeline. `crcOk === false` records are dropped, text records skipped. */
export function buildTimeline(capture: Uint8Array): Timeline {
  const deframer = new SbfDeframer({ crcMode: 'mirror' });
  const decoded = deframer.push(capture);

  const frames: TimedFrame[] = [];
  const messageCounts = new Map<number, number>();
  const stats: TimelineStats = { textFrames: 0, badCrc: 0, bufferedBytes: deframer.buffered };

  let startAbsoluteMs = 0;
  let previousAbsolute = 0;
  let offsetMs = 0;

  for (const frame of decoded) {
    if (frame.kind !== 'sbf') {
      stats.textFrames += 1;
      continue;
    }
    if (!frame.crcOk) {
      stats.badCrc += 1;
      continue;
    }

    const { week, milliseconds } = frame.header;
    let absoluteMs = week * GPS_WEEK_MS + milliseconds;
    if (frames.length > 0 && absoluteMs < previousAbsolute - GPS_WEEK_MS / 2) {
      // Milliseconds of week wrapped but the header's week field did not.
      absoluteMs += GPS_WEEK_MS;
    }
    if (frames.length === 0) startAbsoluteMs = absoluteMs;
    offsetMs = frames.length === 0 ? 0 : Math.max(offsetMs, absoluteMs - startAbsoluteMs);
    previousAbsolute = absoluteMs;

    frames.push({
      index: frames.length,
      frame,
      messageId: frame.header.messageId,
      week,
      milliseconds,
      absoluteMs,
      offsetMs,
    });
    messageCounts.set(frame.header.messageId, (messageCounts.get(frame.header.messageId) ?? 0) + 1);
  }

  const first = frames[0];
  const last = frames[frames.length - 1];

  return {
    frames,
    startAbsoluteMs,
    finishAbsoluteMs: last ? last.absoluteMs : startAbsoluteMs,
    startWeek: first ? first.week : 0,
    startTime: first ? first.milliseconds / 1000 : 0,
    finishWeek: last ? last.week : 0,
    finishTime: last ? last.milliseconds / 1000 : 0,
    durationMs: last ? last.offsetMs : 0,
    messageCounts,
    stats,
  };
}
