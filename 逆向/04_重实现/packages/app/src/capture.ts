/**
 * Deframing + caching shared by every endpoint.
 *
 * A 3 MB capture takes on the order of 100 ms to split into records; Manage asks for the stats and
 * then for one message's fields, Convert asks again for the same file. The cache keeps the parsed
 * frames keyed by (path, size, mtime), so repeated clicks do not re-parse. Nothing is written to disk.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SbfDeframer, type Frame, type SbfFrame } from '../../protocol/src/framing.ts';
import type { EdieTables } from '../../protocol/src/edie.ts';
import { PROTOCOL_DATA_DIR, type ResolvedCapture } from './paths.ts';

export interface CaptureData {
  relPath: string;
  name: string;
  bytes: number;
  mtimeMs: number;
  /** Every binary record the de-framer emitted (mirror mode already dropped zero-CRC fields). */
  frames: SbfFrame[];
  /** Records the samples tree contains, including text records. */
  totalRecords: number;
  accepted: number;
  dropped: number;
  /** `#` / `%` / `<` / `$` / `[` frames, which Convert does not map. */
  textRecords: number;
  parsedAt: number;
}

const MAX_CACHE = 4;
const cache = new Map<string, CaptureData>();

function cacheKey(capture: ResolvedCapture): string {
  return `${capture.absolutePath}::${capture.bytes}::${Math.trunc(capture.mtimeMs)}`;
}

export function loadCapture(capture: ResolvedCapture): CaptureData {
  const key = cacheKey(capture);
  const hit = cache.get(key);
  if (hit) {
    // Refresh recency (Map keeps insertion order).
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const input = readFileSync(capture.absolutePath);
  const deframer = new SbfDeframer({ crcMode: 'mirror' });
  const frames: SbfFrame[] = [];
  let totalRecords = 0;
  let textRecords = 0;
  for (const frame of deframer.push(new Uint8Array(input.buffer, input.byteOffset, input.byteLength)) as Frame[]) {
    totalRecords += 1;
    if (frame.kind === 'sbf') frames.push(frame);
    else textRecords += 1;
  }

  const accepted = frames.filter((frame) => frame.crcOk).length;
  const data: CaptureData = {
    relPath: capture.relPath,
    name: capture.name,
    bytes: capture.bytes,
    mtimeMs: capture.mtimeMs,
    frames,
    totalRecords,
    accepted,
    dropped: frames.length - accepted,
    textRecords,
    parsedAt: Date.now(),
  };

  cache.set(key, data);
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return data;
}

let tablesCache: EdieTables | null = null;

/** `edie-layouts.json` (496 KB) is parsed once per process. */
export function tables(): EdieTables {
  if (!tablesCache) {
    tablesCache = JSON.parse(readFileSync(join(PROTOCOL_DATA_DIR, 'edie-layouts.json'), 'utf8')) as EdieTables;
  }
  return tablesCache;
}

/** GPS week + milliseconds-of-week read as UTC — the suite's documented no-leap-seconds defect. */
export function gpsAsUtc(week: number, milliseconds: number): string {
  return new Date(Date.UTC(1980, 0, 6) + week * 7 * 86400000 + Math.round(milliseconds)).toISOString();
}

export function stamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_T${pad(date.getHours())}${pad(date.getMinutes())}`;
}
