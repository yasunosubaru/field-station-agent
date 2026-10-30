/**
 * Snippet export: turn a time range of the timeline back into bytes or ASCII.
 *
 * The original snippet writer locates a start and an end byte offset by scanning the file and then
 * copies `[startIndex, endIndex)` verbatim (`playback.js:1683-1762,1727-1734`) — it never re-encodes
 * or recomputes a CRC. Same rule here: `exportRange()` copies `frame.bytes`, so every CRC field is
 * the one the receiver wrote.
 *
 * Range semantics: both ends are **inclusive**, matching the original's "first record at or after
 * the start, last record with that timestamp" lookup. Frames whose offset was clamped because their
 * timestamp went backwards belong to the same instant as the frame before them, so they are included
 * by the range that includes that instant.
 */

import { encodeAsciiLog, type AsciiLogOptions } from '../../protocol/src/ascii-log.ts';
import type { EdieTables } from '../../protocol/src/edie.ts';
import type { TimedFrame } from './timeline.ts';

export interface ExportedRange {
  frames: TimedFrame[];
  /** Frames that were copied. */
  frameCount: number;
  /** Bytes of `exportRange()`. */
  byteLength: number;
}

function toMilliseconds(seconds: number, name: string): number {
  if (!Number.isFinite(seconds)) throw new RangeError(`${name} must be a finite number of seconds`);
  return Math.round(seconds * 1000);
}

/** Frames whose timeline offset falls in `[fromSeconds, toSeconds]` (inclusive). */
export function selectRange(frames: readonly TimedFrame[], fromSeconds: number, toSeconds: number): ExportedRange {
  const fromMs = Math.max(0, toMilliseconds(fromSeconds, 'fromSeconds'));
  const toMs = toMilliseconds(toSeconds, 'toSeconds');
  if (toMs < fromMs) return { frames: [], frameCount: 0, byteLength: 0 };
  const selected = frames.filter((frame) => frame.offsetMs >= fromMs && frame.offsetMs <= toMs);
  return {
    frames: selected,
    frameCount: selected.length,
    byteLength: selected.reduce((total, frame) => total + frame.frame.bytes.length, 0),
  };
}

/** Concatenate the selected records without touching a single byte. */
export function exportRangeBytes(frames: readonly TimedFrame[], fromSeconds: number, toSeconds: number): Uint8Array {
  const { frames: selected, byteLength } = selectRange(frames, fromSeconds, toSeconds);
  const out = new Uint8Array(byteLength);
  let at = 0;
  for (const frame of selected) {
    out.set(frame.frame.bytes, at);
    at += frame.frame.bytes.length;
  }
  return out;
}

/**
 * Encode the selected records as the suite's ASCII log lines.
 *
 * Lines are joined with CRLF and end with a trailing CRLF, exactly like `convert.ts --to ASCII`, so
 * one line is byte-identical to what `encodeAsciiLog()` returns for that frame. Records whose
 * message id has no layout in `tables` are skipped (the original has nothing to print for them
 * either), and `encodeAsciiLog`'s own CRC guard is passed through.
 */
export function exportAsciiText(
  frames: readonly TimedFrame[],
  fromSeconds: number,
  toSeconds: number,
  tables: EdieTables,
  options: AsciiLogOptions = {},
): string {
  const lines: string[] = [];
  for (const frame of selectRange(frames, fromSeconds, toSeconds).frames) {
    const layout = tables.messages[String(frame.messageId)];
    if (!layout) continue;
    const line = encodeAsciiLog(frame.frame, layout, tables, options);
    if (line) lines.push(line);
  }
  return lines.length ? `${lines.join('\r\n')}\r\n` : '';
}
