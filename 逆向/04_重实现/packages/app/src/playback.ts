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
import { GPS_WEEK_MS, type TimedFrame } from '../../playback/src/timeline.ts';
import { itkDetections } from '../../view/src/config/events.ts';
import { gpsAsUtc, loadCapture, tables } from './capture.ts';
import { readRecords, readTextRecords } from './logs.ts';
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

/* ------------------------------------------------------- event strip (Playback D1, §11.5) ---
 *
 * The original's strip under the scrub bar (`.playback-events`, `playbackcontrol.html:23`) holds
 * one marker per event *start*: `markEvents()` builds an element per entry of the Events engine with
 *
 *     element.className = state + "Event"                 // PoorEvent / ModerateEvent / GoodEvent
 *     element.setAttribute("data-message", description)   // the `data-lang-…` key
 *     element.setAttribute("data-event-freq", freqValue)  // MHz, ITK only
 *     element.setAttribute("time", getUTCTimeFormatOnly(start))
 *     element.style.left = "calc(" + per*100 + "% - 17px)"  // per = (start - startTime) / duration
 *
 * and a `per < 0` entry is dropped rather than clamped (`controller/playback.js:1013-1047`). Only
 * `state != "Good"` events are marked; the strip is append-only while a capture plays, so an ended
 * event keeps its marker. That is what this module reproduces: one entry per event *occurrence*,
 * positioned at its start, and its `endTime` when the receiver stopped reporting it.
 *
 * Sources, all the receiver's own records — nothing is synthesised:
 *
 *   ITK interference   `ITDETECTSTATUS` (#2065) through `events.ts#itkDetections`, i.e. only the
 *                      spectrum detector (`SPECTRUMANALYSIS`) raises an event; the statistical one
 *                      is the original's `data-lang-itk-detected-at` branch too (events.js:1516-1534,
 *                      severity `Moderate`). On the b7 capture the log is **text**, so it never
 *                      reaches the binary timeline — hence reading both forms here.
 *   Spoofing           `RXSTATUS` (#93) with a `spoofing` field of `DETECTED` (events.js:1536-1560).
 *   `RXSTATUSEVENT`    #94, but only the two descriptions the Events page turns into entries
 *                      (events.js:727-790): `MODEL INVALID FOR THIS RECEIVER`, `INVALID AUTHORIZATION
 *                      CODE`.
 */

export type PlaybackEventKind = 'itk' | 'spoofing' | 'rxstatusevent';

/** One marker of the strip. */
export interface PlaybackEvent {
  kind: PlaybackEventKind;
  /** `data-lang-…` key — the original's `data-message` (`controller/playback.js:1020`). */
  description: string;
  /** The tooltip sentence with `%1` already substituted (`playbackview.js:244-245`). */
  detail: string;
  /** `Poor` = red marker, `Moderate` = amber; the original's `PoorEvent` / `ModerateEvent`. */
  severity: 'Poor' | 'Moderate';
  /** The record behind it, printed under the sentence in the tooltip. */
  source: string;
  /** Receiver time of the record that started it (UTC, no leap seconds — `gpsAsUtc`). */
  utc: string;
  /** Seconds from the start of the timeline — the marker's position. */
  time: number;
  /** Seconds when the receiver stopped reporting it; `null` while it is still active at the end. */
  endTime: number | null;
  /** Centre frequency in MHz (ITK only). */
  frequency?: number;
}

export interface PlaybackEventsPayload {
  capture: string;
  durationMs: number;
  /** Markers the strip draws (the original's `.playback-events > div` count). */
  count: number;
  events: PlaybackEvent[];
  /** Records each source offered, so an empty strip can say which log is missing. */
  sources: { itk: number; spoofing: number; rxstatusevent: number };
  /** Records whose timestamp falls outside the timeline; the original drops them (`per < 0`). */
  outside: number;
}

/** `en.js` 's own wording, `%1` substituted the way `replace("%1", freqValue)` does. */
const EVENT_TEXT: Record<string, string> = {
  'data-lang-itk-detected-at': 'Interference is being detected at %1Mhz.',
  'data-lang-spoofing-detected': 'Spoofing is being detected',
  'data-lang-invalid-model': 'Invalid Model',
  'data-lang-invalid-authcode': 'Invalid Authcode',
};

const RXSTATUSEVENT_DESCRIPTIONS: Record<string, string> = {
  'MODEL INVALID FOR THIS RECEIVER': 'data-lang-invalid-model',
  'INVALID AUTHORIZATION CODE': 'data-lang-invalid-authcode',
};

const SOURCE_NAMES: Record<PlaybackEventKind, string> = {
  itk: 'ITDETECTSTATUS (#2065)',
  spoofing: 'RXSTATUS (#93)',
  rxstatusevent: 'RXSTATUSEVENT (#94)',
};

/** One record of any source, reduced to what the strip needs. */
interface EventRecord {
  absoluteMs: number;
  utc: string;
  fields: Record<string, unknown>;
}

function toFieldMap(values: EdieValue[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  // `text` is the **printed** token (`L2`, `SPECTRUMANALYSIS`), which is what a text record and a
  // decoded enum both carry; `value` alone would turn the band into a number.
  for (const value of values) fields[value.path] = value.text ?? value.value;
  return fields;
}

/**
 * Every record of `messageId`, **text and binary forms together**, in receiver-time order.
 *
 * `ITDETECTSTATUS` is logged as `ITDETECTSTATUSA` on the receiver behind these captures, so the
 * text form is the one the sample carries (b7: 47 text records, 0 binary). The binary form is read
 * as well because b1 has six of those — a capture may hold either.
 */
function eventRecords(capture: ResolvedCapture, messageId: number, textName: string): EventRecord[] {
  const data = loadCapture(capture);
  const table = tables();
  const records: EventRecord[] = [];

  const first = readTextRecords(data, table, textName, 0, 1);
  if (first.total > 0) {
    // One call for the whole log: `readTextRecords` slices the capture's own line list, so the
    // per-request limit that guards `/api/records` does not apply here.
    const all = readTextRecords(data, table, textName, 0, first.total);
    for (const record of all.records) {
      records.push({
        absoluteMs: record.header.week * GPS_WEEK_MS + Math.round(record.header.milliseconds),
        utc: record.header.utc,
        fields: toFieldMap(record.fields as EdieValue[]),
      });
    }
  }

  const layout = table.messages[String(messageId)];
  if (layout) {
    for (const frame of data.frames) {
      if (frame.header.messageId !== messageId || !frame.crcOk) continue;
      records.push({
        absoluteMs: frame.header.week * GPS_WEEK_MS + Math.round(frame.header.milliseconds),
        utc: gpsAsUtc(frame.header.week, frame.header.milliseconds),
        fields: toFieldMap(decodeEdie(frame.payload, layout, table)),
      });
    }
  }

  records.sort((a, b) => a.absoluteMs - b.absoluteMs);
  return records;
}

function detailOf(description: string, frequency?: number): string {
  const text = EVENT_TEXT[description] ?? description;
  return frequency === undefined ? text : text.replace('%1', String(frequency));
}

/**
 * The event strip of one capture.
 *
 * A *state machine* per source, exactly as the Events engine runs it: a frequency (or a spoofing
 * state) that was not reported by the previous record starts an event; one that the next record
 * stops reporting ends it. Re-detecting the same frequency later starts a **new** event — that is
 * the b7 capture's second `1270 MHz` entry, and the original's `createEventInHandlerObject` does the
 * same (`events.js:1719-1734`).
 */
export function playbackEvents(capture: ResolvedCapture): PlaybackEventsPayload {
  const engine = playbackFor(capture);
  const info = engine.info();
  const startAbsolute = info.startWeek * GPS_WEEK_MS + Math.round(info.startTime * 1000);
  const durationMs = info.durationMs;
  const sources = { itk: 0, spoofing: 0, rxstatusevent: 0 };
  const events: PlaybackEvent[] = [];
  let outside = 0;

  /** Timeline seconds of a record, or `null` when it sits outside the capture's own span. */
  const offsetOf = (record: EventRecord): number | null => {
    const seconds = (record.absoluteMs - startAbsolute) / 1000;
    if (seconds < 0 || seconds * 1000 > durationMs) {
      outside += 1;
      return null;
    }
    return seconds;
  };

  /* ---- ITK interference ---- */
  const itk = eventRecords(capture, 2065, 'ITDETECTSTATUS');
  sources.itk = itk.length;
  const open = new Map<number, PlaybackEvent>();
  let reporting = new Set<number>();
  for (const record of itk) {
    const detected = itkDetections(record.fields);
    const time = offsetOf(record);
    for (const frequency of detected) {
      if (reporting.has(frequency)) continue;
      const event: PlaybackEvent = {
        kind: 'itk',
        description: 'data-lang-itk-detected-at',
        detail: detailOf('data-lang-itk-detected-at', frequency),
        severity: 'Moderate',
        source: SOURCE_NAMES.itk,
        utc: record.utc,
        time: time ?? 0,
        endTime: null,
        frequency,
      };
      if (time !== null) {
        events.push(event);
        open.set(frequency, event);
      }
    }
    for (const frequency of reporting) {
      if (detected.has(frequency)) continue;
      const event = open.get(frequency);
      if (event && time !== null) event.endTime = time;
      open.delete(frequency);
    }
    reporting = detected;
  }

  /* ---- Spoofing (no sample carries it; the branch is the original's, not a guess) ---- */
  const rxStatus = eventRecords(capture, 93, 'RXSTATUS');
  sources.spoofing = rxStatus.length;
  let spoofed = false;
  let spoofingEvent: PlaybackEvent | null = null;
  for (const record of rxStatus) {
    const detected = String(record.fields.spoofing ?? '') === 'DETECTED';
    const time = offsetOf(record);
    if (detected && !spoofed && time !== null) {
      spoofingEvent = {
        kind: 'spoofing',
        description: 'data-lang-spoofing-detected',
        detail: detailOf('data-lang-spoofing-detected'),
        severity: 'Poor',
        source: SOURCE_NAMES.spoofing,
        utc: record.utc,
        time,
        endTime: null,
      };
      events.push(spoofingEvent);
    }
    if (!detected && spoofed && spoofingEvent && time !== null) {
      spoofingEvent.endTime = time;
      spoofingEvent = null;
    }
    spoofed = detected;
  }

  /* ---- RXSTATUSEVENT ---- */
  const statusEvents = eventRecords(capture, 94, 'RXSTATUSEVENT');
  sources.rxstatusevent = statusEvents.length;
  for (const record of statusEvents) {
    const printed = String(record.fields.description ?? '').toUpperCase();
    const description = RXSTATUSEVENT_DESCRIPTIONS[printed];
    if (!description) continue;
    const time = offsetOf(record);
    if (time === null) continue;
    events.push({
      kind: 'rxstatusevent',
      description,
      detail: detailOf(description),
      severity: 'Poor',
      source: SOURCE_NAMES.rxstatusevent,
      utc: record.utc,
      time,
      endTime: null,
    });
  }

  // Two records can report the same detection in the same instant (a text and a binary one, or a
  // duplicated log); the strip is keyed by (kind, frequency, time) — the original's
  // `isValidPlaybackEvent` refuses a second marker with the same `data-message` / `time` / freq.
  const seen = new Set<string>();
  const unique = events
    .sort((a, b) => a.time - b.time)
    .filter((event) => {
      const key = `${event.kind}|${event.frequency ?? ''}|${event.time.toFixed(3)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  return {
    capture: capture.relPath,
    durationMs,
    count: unique.length,
    events: unique,
    sources,
    outside,
  };
}
