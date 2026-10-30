/**
 * Playback engine — a capture treated as a playable timeline.
 *
 * The original `controller/playback.js` couples three things in one object: file I/O, a `Timer`
 * that reproduces the recorded inter-record gap, and the jQuery player widget. This engine keeps
 * only the observable playback behaviour and is **free of real time**: either call
 * `tick(deltaMs)` with an explicit step, or inject a clock (`new PlaybackEngine({ clock })`) and
 * call `tick()` to advance by however much that clock moved. Tests drive it without waiting.
 *
 * What it reproduces (`04_Playback组件.md` §6):
 *
 *  - a seek positions the cursor at the first record whose offset is `>= target`, and playback
 *    continues from there (the original pauses, re-scans and resumes at the found record);
 *  - speed multiplies the timeline advance, so `speed = 4` and `tick(250)` advance 1000 ms;
 *  - records are delivered in timeline order, only those the current step reaches — never the whole
 *    capture at once (the original emits one same-timestamp epoch per timer tick);
 *  - reaching the end emits `ended` once (the original's completion signal is the progress bar
 *    hitting 100 %, R39/R40).
 *
 * What it deliberately does not reproduce: the GUI, the `speed > 10` per-message throttle (R19),
 * the smoothed progress-bar interval (R20/R21), and the 18 s UTC correction (the timeline is
 * relative, so no UTC conversion ever happens).
 */

import { buildTimeline, type TimedFrame, type Timeline, type TimelineStats } from './timeline.ts';
import { exportAsciiText, exportRangeBytes, selectRange, type ExportedRange } from './export.ts';
import type { AsciiLogOptions } from '../../protocol/src/ascii-log.ts';
import type { EdieTables } from '../../protocol/src/edie.ts';
import type { SbfFrame } from '../../protocol/src/framing.ts';

/** Multipliers the original offers (`playbackcontrol.html:79-83`: 1/2/5/10/20). */
export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4, 8] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export type PlaybackState = 'idle' | 'playing' | 'paused' | 'ended';

export interface PlaybackFrameEvent {
  /** Position in the timeline (0-based, accepted records only). */
  index: number;
  /** The captured record, bytes verbatim — feed this to the same parser the live path uses. */
  frame: SbfFrame;
  messageId: number;
  week: number;
  milliseconds: number;
  /** Milliseconds since the first record. */
  offsetMs: number;
  /** `offsetMs / 1000`. */
  time: number;
}

export interface PlaybackOptions {
  /** Real-time source, e.g. `() => Date.now()`. Used by `tick()` without an argument. */
  clock?: () => number;
  speed?: PlaybackSpeed;
}

export interface PlaybackEventMap {
  frame: PlaybackFrameEvent;
  ended: void;
}

type Handler<T> = (payload: T) => void;

export interface PlaybackInfo {
  frameCount: number;
  durationMs: number;
  startWeek: number;
  startTime: number;
  finishWeek: number;
  finishTime: number;
  messageCounts: Record<number, number>;
  messageIds: number[];
  stats: TimelineStats;
}

export class PlaybackEngine {
  private timeline: Timeline | null = null;
  private readonly clock?: () => number;

  /** Index of the next record to emit. */
  private cursor = 0;
  private currentMs = 0;
  private playbackState: PlaybackState = 'idle';
  private playbackSpeed: PlaybackSpeed = 1;
  private endedEmitted = false;
  private lastClockMs: number | null = null;

  private readonly handlers = new Map<keyof PlaybackEventMap, Set<Handler<never>>>();

  constructor(options: PlaybackOptions = {}) {
    this.clock = options.clock;
    if (options.speed !== undefined) this.speed = options.speed;
  }

  // ---- loading ------------------------------------------------------------------------------

  /** De-frame a capture and make it playable. Resets position, state and speed stays as set. */
  load(capture: Uint8Array): void {
    this.timeline = buildTimeline(capture);
    this.cursor = 0;
    this.currentMs = 0;
    this.playbackState = 'idle';
    this.endedEmitted = false;
    this.lastClockMs = null;
  }

  get loaded(): boolean {
    return this.timeline !== null;
  }

  /** Accepted records, in timeline order. */
  get frames(): readonly TimedFrame[] {
    return this.requireTimeline().frames;
  }

  /** Whole-capture length in milliseconds. */
  get duration(): number {
    return this.requireTimeline().durationMs;
  }

  get durationSeconds(): number {
    return this.duration / 1000;
  }

  get frameCount(): number {
    return this.requireTimeline().frames.length;
  }

  /** Seconds of week of the first record. */
  get startTime(): number {
    return this.requireTimeline().startTime;
  }

  /** Seconds of week of the last record (smaller than `startTime` across a week boundary). */
  get finishTime(): number {
    return this.requireTimeline().finishTime;
  }

  get startWeek(): number {
    return this.requireTimeline().startWeek;
  }

  get finishWeek(): number {
    return this.requireTimeline().finishWeek;
  }

  get startAbsoluteMs(): number {
    return this.requireTimeline().startAbsoluteMs;
  }

  get finishAbsoluteMs(): number {
    return this.requireTimeline().finishAbsoluteMs;
  }

  /** Everything `--info` prints. */
  info(): PlaybackInfo {
    const timeline = this.requireTimeline();
    const messageCounts: Record<number, number> = {};
    for (const [id, count] of timeline.messageCounts) messageCounts[id] = count;
    return {
      frameCount: timeline.frames.length,
      durationMs: timeline.durationMs,
      startWeek: timeline.startWeek,
      startTime: timeline.startTime,
      finishWeek: timeline.finishWeek,
      finishTime: timeline.finishTime,
      messageCounts,
      messageIds: [...timeline.messageCounts.keys()].sort((a, b) => a - b),
      stats: timeline.stats,
    };
  }

  // ---- transport ----------------------------------------------------------------------------

  get state(): PlaybackState {
    return this.playbackState;
  }

  /** Position in seconds from the start of the capture. */
  get currentTime(): number {
    return this.currentMs / 1000;
  }

  get currentTimeMs(): number {
    return this.currentMs;
  }

  get speed(): PlaybackSpeed {
    return this.playbackSpeed;
  }

  set speed(value: PlaybackSpeed) {
    if (!PLAYBACK_SPEEDS.includes(value)) {
      throw new RangeError(`speed must be one of ${PLAYBACK_SPEEDS.join(', ')} (got ${value})`);
    }
    this.playbackSpeed = value;
  }

  /** Start (or resume) playing. A finished capture restarts from the beginning. */
  play(): void {
    this.requireTimeline();
    if (this.playbackState === 'ended') this.seek(0);
    this.playbackState = 'playing';
    this.lastClockMs = null;
  }

  pause(): void {
    if (this.playbackState === 'playing') this.playbackState = 'paused';
  }

  /**
   * Move the playhead to `seconds` (clamped to `[0, duration]`). The next emitted record is the
   * first one at or after the new position, so playback continues from there.
   */
  seek(seconds: number): void {
    const timeline = this.requireTimeline();
    if (!Number.isFinite(seconds)) throw new RangeError('seek position must be a finite number of seconds');
    const target = Math.min(Math.max(seconds * 1000, 0), timeline.durationMs);
    this.currentMs = target;
    this.cursor = lowerBound(timeline.frames, target);
    this.endedEmitted = false;
    if (this.playbackState === 'ended') this.playbackState = 'paused';
    this.lastClockMs = null;
  }

  /**
   * Advance the timeline and emit every record the step reaches, in order.
   *
   * @param deltaMs wall-clock milliseconds elapsed; scaled by `speed`. Omit to take the step from
   *                the injected clock (the first call only establishes the baseline).
   * @returns the records emitted by this step.
   */
  tick(deltaMs?: number): PlaybackFrameEvent[] {
    const timeline = this.requireTimeline();
    if (this.playbackState !== 'playing') return [];

    let elapsed: number;
    if (deltaMs === undefined) {
      if (!this.clock) throw new Error('tick() without a delta needs an injected clock option');
      const now = this.clock();
      if (this.lastClockMs === null) {
        this.lastClockMs = now;
        return [];
      }
      elapsed = now - this.lastClockMs;
      this.lastClockMs = now;
    } else {
      if (!Number.isFinite(deltaMs)) throw new RangeError('deltaMs must be a finite number');
      elapsed = deltaMs;
    }
    if (elapsed < 0) elapsed = 0;

    const targetMs = Math.min(timeline.durationMs, this.currentMs + elapsed * this.playbackSpeed);
    const emitted: PlaybackFrameEvent[] = [];

    while (this.cursor < timeline.frames.length) {
      const record = timeline.frames[this.cursor];
      if (record.offsetMs > targetMs) break;
      this.cursor += 1;
      emitted.push(this.emitFrame(record));
    }
    this.currentMs = targetMs;

    if (this.cursor >= timeline.frames.length && this.currentMs >= timeline.durationMs && !this.endedEmitted) {
      this.endedEmitted = true;
      this.playbackState = 'ended';
      this.emit('ended', undefined as never);
    }
    return emitted;
  }

  // ---- export -------------------------------------------------------------------------------

  /** Frames in `[fromSeconds, toSeconds]` (inclusive) with their byte total. */
  range(fromSeconds: number, toSeconds: number): ExportedRange {
    return selectRange(this.requireTimeline().frames, fromSeconds, toSeconds);
  }

  /** The records of a range concatenated verbatim — CRCs are never recomputed. */
  exportRange(fromSeconds: number, toSeconds: number): Uint8Array {
    return exportRangeBytes(this.requireTimeline().frames, fromSeconds, toSeconds);
  }

  /** The records of a range as the suite's ASCII log lines (CRLF separated, trailing CRLF). */
  exportAscii(fromSeconds: number, toSeconds: number, tables: EdieTables, options: AsciiLogOptions = {}): string {
    return exportAsciiText(this.requireTimeline().frames, fromSeconds, toSeconds, tables, options);
  }

  // ---- events -------------------------------------------------------------------------------

  /** Subscribe. Returns an unsubscribe function, like `EventEmitter.on()` users expect. */
  on<K extends keyof PlaybackEventMap>(event: K, handler: Handler<PlaybackEventMap[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => this.off(event, handler);
  }

  off<K extends keyof PlaybackEventMap>(event: K, handler: Handler<PlaybackEventMap[K]>): void {
    this.handlers.get(event)?.delete(handler as Handler<never>);
  }

  private emit<K extends keyof PlaybackEventMap>(event: K, payload: PlaybackEventMap[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) (handler as Handler<PlaybackEventMap[K]>)(payload);
  }

  private emitFrame(record: TimedFrame): PlaybackFrameEvent {
    const event: PlaybackFrameEvent = {
      index: record.index,
      frame: record.frame,
      messageId: record.messageId,
      week: record.week,
      milliseconds: record.milliseconds,
      offsetMs: record.offsetMs,
      time: record.offsetMs / 1000,
    };
    this.emit('frame', event);
    return event;
  }

  private requireTimeline(): Timeline {
    if (!this.timeline) throw new Error('no capture loaded — call load(capture) first');
    return this.timeline;
  }
}

/** First index whose `offsetMs` is `>= target`. */
function lowerBound(frames: readonly TimedFrame[], target: number): number {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (frames[mid].offsetMs < target) low = mid + 1;
    else high = mid;
  }
  return low;
}
