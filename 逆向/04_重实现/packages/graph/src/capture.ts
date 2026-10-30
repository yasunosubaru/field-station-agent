/**
 * Reading a capture the way Graph's importer does for the charts we export.
 *
 * Framing and payload decoding are **not** reimplemented here: `SbfDeframer` reproduces the
 * shipped `genericparser.js` and `decodeEdie` reads the EDIE dictionary, exactly as
 * `packages/cli/src/convert.ts` does. This module only turns frames into the handful of
 * per-message records the CSV/KML writers consume.
 *
 * Timestamps: Graph's ms scale is `week * 604800000 + milliseconds` (see `format.ts`).
 */

import { readFileSync } from 'node:fs';
import { SbfDeframer, type Frame, type SbfFrame } from '../../protocol/src/framing.ts';
import { decodeEdie, type EdieTables, type EdieValue } from '../../protocol/src/edie.ts';
import { MS_PER_WEEK } from './format.ts';

export const MESSAGE_ID = {
  BESTPOS: 42,
  RANGE: 43,
  HWMONITOR: 963,
  RXSTATUS: 93,
} as const;

/** One decoded log record. `fields` is keyed by EDIE path (`latitude`, `obs[3].C_No`, …). */
export interface CaptureRecord {
  name: string;
  messageId: number;
  week: number;
  milliseconds: number;
  /** `week * 604800000 + milliseconds`. */
  gpsMs: number;
  values: EdieValue[];
  byPath: Map<string, EdieValue>;
  frame: SbfFrame;
}

export interface Capture {
  records: CaptureRecord[];
  /** Count per message name, in first-seen order (what `PlotSummary` counts come from). */
  counts: Map<string, number>;
  byName(name: string): CaptureRecord[];
}

export interface CaptureOptions {
  /** Default `data/edie-layouts.json` of the protocol package. */
  tables?: EdieTables;
  /** Default: every frame the deframer yields. */
  filter?: (frame: SbfFrame) => boolean;
}

let cachedTables: EdieTables | null = null;

/** The shipped EDIE dictionary (`packages/protocol/data/edie-layouts.json`). */
export function defaultTables(): EdieTables {
  if (!cachedTables) {
    const path = new URL('../../protocol/data/edie-layouts.json', import.meta.url);
    cachedTables = JSON.parse(readFileSync(path, 'utf8')) as EdieTables;
  }
  return cachedTables;
}

export function gpsMsOf(week: number, milliseconds: number): number {
  return week * MS_PER_WEEK + milliseconds;
}

/** Deframe + decode a capture file. */
export function loadCapture(capturePath: string, options: CaptureOptions = {}): Capture {
  const tables = options.tables ?? defaultTables();
  const bytes = new Uint8Array(readFileSync(capturePath));
  const deframer = new SbfDeframer();
  const frames: Frame[] = deframer.push(bytes);

  const records: CaptureRecord[] = [];
  const counts = new Map<string, number>();
  for (const frame of frames) {
    if (frame.kind !== 'sbf') continue;
    if (options.filter && !options.filter(frame)) continue;
    const layout = tables.messages[String(frame.header.messageId)];
    if (!layout) continue;
    const values = decodeEdie(frame.payload, layout, tables);
    const byPath = new Map(values.map((value) => [value.path, value]));
    records.push({
      name: layout.name,
      messageId: frame.header.messageId,
      week: frame.header.week,
      milliseconds: frame.header.milliseconds,
      gpsMs: gpsMsOf(frame.header.week, frame.header.milliseconds),
      values,
      byPath,
      frame,
    });
    counts.set(layout.name, (counts.get(layout.name) ?? 0) + 1);
  }

  const byName = (name: string) => records.filter((record) => record.name === name);
  return { records, counts, byName };
}

/** Typed accessor for one field of a record. */
export function field(record: CaptureRecord, path: string): number {
  const value = record.byPath.get(path);
  if (!value) throw new Error(`${record.name} has no field ${path}`);
  return Number(value.value);
}

export function textField(record: CaptureRecord, path: string): string {
  const value = record.byPath.get(path);
  if (!value) throw new Error(`${record.name} has no field ${path}`);
  return String(value.value);
}
