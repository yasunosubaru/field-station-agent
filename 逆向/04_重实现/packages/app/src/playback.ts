/**
 * Playback glue: the `packages/playback` engine, one instance per capture, plus the projections
 * the Playback page needs.
 *
 * The engine is used read-only — `packages/playback` is never modified, and nothing here writes a
 * file. The page drives the clock in the browser (a `requestAnimationFrame` loop over the frame
 * list this module returns); the server keeps the authoritative timeline for `info()` and for
 * `exportRange()`, so a seek in the browser can never invent a frame that is not in the capture.
 *
 * Caching mirrors `capture.ts`: keyed by (absolute path, size, mtime), so switching pages and
 * dragging the timeline never re-deframes 3 MB.
 */

import { readFileSync } from 'node:fs';

import { decodeEdie, type EdieValue } from '../../protocol/src/edie.ts';
import { PLAYBACK_SPEEDS, PlaybackEngine } from '../../playback/src/playback.ts';
import type { TimedFrame } from '../../playback/src/timeline.ts';
import { gpsAsUtc, tables } from './capture.ts';
import { HttpError, type ResolvedCapture } from './paths.ts';

const MAX_CACHED_ENGINES = 3;
const engines = new Map<string, PlaybackEngine>();

function cacheKey(capture: ResolvedCapture): string {
  return `${capture.absolutePath}::${capture.bytes}::${Math.trunc(capture.mtimeMs)}`;
}

/** The playback engine for a capture, de-framed once and cached. */
export function playbackFor(capture: ResolvedCapture): PlaybackEngine {
  const key = cacheKey(capture);
  const hit = engines.get(key);
  if (hit) {
    // Refresh recency (Map keeps insertion order).
    engines.delete(key);
    engines.set(key, hit);
    return hit;
  }

  const input = readFileSync(capture.absolutePath);
  const engine = new PlaybackEngine();
  engine.load(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));

  engines.set(key, engine);
  while (engines.size > MAX_CACHED_ENGINES) {
    const oldest = engines.keys().next().value;
    if (oldest === undefined) break;
    engines.delete(oldest);
  }
  return engine;
}

export interface PlaybackMessageCount {
  id: number;
  name: string;
  known: boolean;
  count: number;
}

export interface PlaybackInfoPayload {
  capture: string;
  bytes: number;
  frameCount: number;
  durationMs: number;
  durationSeconds: number;
  startWeek: number;
  startTime: number;
  finishWeek: number;
  finishTime: number;
  /** UTC of the first / last record, read the same (mirror-defect) way as the rest of the shell. */
  startUtc: string;
  finishUtc: string;
  messageCounts: PlaybackMessageCount[];
  stats: { textFrames: number; badCrc: number; bufferedBytes: number };
  speeds: number[];
}

export function playbackInfo(capture: ResolvedCapture): PlaybackInfoPayload {
  const engine = playbackFor(capture);
  const info = engine.info();
  const messageCounts = info.messageIds.map((id) => ({
    id,
    name: tables().messages[String(id)]?.name ?? `未知消息 ${id}`,
    known: Boolean(tables().messages[String(id)]),
    count: info.messageCounts[id],
  }));

  return {
    capture: capture.relPath,
    bytes: capture.bytes,
    frameCount: info.frameCount,
    durationMs: info.durationMs,
    durationSeconds: info.durationMs / 1000,
    startWeek: info.startWeek,
    startTime: info.startTime,
    finishWeek: info.finishWeek,
    finishTime: info.finishTime,
    startUtc: info.frameCount ? gpsAsUtc(info.startWeek, Math.round(info.startTime * 1000)) : '',
    finishUtc: info.frameCount ? gpsAsUtc(info.finishWeek, Math.round(info.finishTime * 1000)) : '',
    messageCounts,
    stats: info.stats,
    speeds: [...PLAYBACK_SPEEDS],
  };
}

export interface PlaybackFrameSummary {
  index: number;
  messageId: number;
  name: string;
  known: boolean;
  week: number;
  milliseconds: number;
  offsetMs: number;
  time: number;
  /** Bytes of the captured record (what `exportRange` copies). */
  bytes: number;
}

export interface PlaybackFramesPayload {
  capture: string;
  total: number;
  from: number;
  to: number;
  count: number;
  frames: PlaybackFrameSummary[];
}

function summarize(record: TimedFrame, layoutName: string | undefined, known: boolean): PlaybackFrameSummary {
  return {
    index: record.index,
    messageId: record.messageId,
    name: layoutName ?? `未知消息 ${record.messageId}`,
    known,
    week: record.week,
    milliseconds: record.milliseconds,
    offsetMs: record.offsetMs,
    time: record.offsetMs / 1000,
    bytes: record.frame.bytes.byteLength,
  };
}

/**
 * Frames whose timeline offset falls in `[fromSeconds, toSeconds]`, both bounds clamped to the
 * capture. The whole capture is returned when neither bound is given.
 */
export function playbackFrames(
  capture: ResolvedCapture,
  fromSeconds?: number,
  toSeconds?: number,
): PlaybackFramesPayload {
  const engine = playbackFor(capture);
  const frames = engine.frames;
  const durationSeconds = engine.duration / 1000;
  const from = Math.max(0, Math.min(fromSeconds ?? 0, durationSeconds));
  const to = Math.max(from, Math.min(toSeconds ?? durationSeconds, durationSeconds));
  const fromMs = Math.round(from * 1000);
  const toMs = Math.round(to * 1000);

  const selected: PlaybackFrameSummary[] = [];
  const layoutTable = tables().messages;
  for (const record of frames) {
    if (record.offsetMs < fromMs) continue;
    if (record.offsetMs > toMs) break;
    const layout = layoutTable[String(record.messageId)];
    selected.push(summarize(record, layout?.name, Boolean(layout)));
  }

  return {
    capture: capture.relPath,
    total: frames.length,
    from,
    to,
    count: selected.length,
    frames: selected,
  };
}

export interface PlaybackField {
  name: string;
  path: string;
  value: number | string;
  text?: string;
  isCount?: boolean;
}

export interface PlaybackFrameDetail {
  capture: string;
  index: number;
  total: number;
  frame: PlaybackFrameSummary;
  utc: string;
  layoutKnown: boolean;
  fields: PlaybackField[];
  fieldTotal: number;
  fieldsTruncated: boolean;
}

const FIELD_LIMIT = 400;

function toField(value: EdieValue): PlaybackField {
  return {
    name: value.name,
    path: value.path,
    value: typeof value.value === 'number' && !Number.isFinite(value.value) ? String(value.value) : value.value,
    ...(value.text === undefined ? {} : { text: value.text }),
    ...(value.isCount ? { isCount: true } : {}),
  };
}

/** One frame of the timeline with its decoded field table (the "current frame" panel). */
export function playbackFrame(capture: ResolvedCapture, index: number): PlaybackFrameDetail {
  const engine = playbackFor(capture);
  const frames = engine.frames;
  if (!Number.isInteger(index) || index < 0 || index >= frames.length) {
    throw new HttpError(404, `帧序号超出范围：${index}（共 ${frames.length} 帧）`);
  }
  const record = frames[index];
  const layout = tables().messages[String(record.messageId)];
  const values = layout ? decodeEdie(record.frame.payload, layout, tables()) : [];
  return {
    capture: capture.relPath,
    index,
    total: frames.length,
    frame: summarize(record, layout?.name, Boolean(layout)),
    utc: gpsAsUtc(record.week, record.milliseconds),
    layoutKnown: Boolean(layout),
    fields: values.slice(0, FIELD_LIMIT).map(toField),
    fieldTotal: values.length,
    fieldsTruncated: values.length > FIELD_LIMIT,
  };
}

export interface PlaybackExport {
  bytes: Uint8Array;
  frameCount: number;
  from: number;
  to: number;
}

/** Copy the records of `[from, to]` verbatim — CRCs are never recomputed (`exportRange`). */
export function playbackExport(capture: ResolvedCapture, fromSeconds: number, toSeconds: number): PlaybackExport {
  const engine = playbackFor(capture);
  const durationSeconds = engine.duration / 1000;
  if (!Number.isFinite(fromSeconds) || !Number.isFinite(toSeconds)) {
    throw new HttpError(400, 'from / to 必须是有限秒数');
  }
  if (fromSeconds < 0 || toSeconds < 0) throw new HttpError(400, 'from / to 不能为负');
  if (fromSeconds > toSeconds) throw new HttpError(400, 'from 必须不大于 to');
  if (fromSeconds > durationSeconds) {
    throw new HttpError(400, `from 超出抓包时长（${durationSeconds} s）`);
  }
  const to = Math.min(toSeconds, durationSeconds);
  const range = engine.range(fromSeconds, to);
  return {
    bytes: engine.exportRange(fromSeconds, to),
    frameCount: range.frameCount,
    from: fromSeconds,
    to,
  };
}
