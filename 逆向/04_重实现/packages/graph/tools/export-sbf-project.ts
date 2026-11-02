/**
 * `export-sbf-project.ts` — turn a raw capture into a **Graph export project** on disk.
 *
 * Graph's own workflow is `.gpf` + `DataSummary.json` → *Export → CSV*, which writes
 * `<project>/csv/<chart>.csv`. This build has no project engine (no `.gpf` reader for captures that
 * never had one), so a capture the receiver just wrote has no project to open. This tool fills that
 * gap without inventing data: it deframes/decodes the capture with the real `packages/graph` data
 * layer and runs the same `writeCsv()` the golden comparison uses, so every CSV below is a
 * conversion of the capture, never a hand-written fixture.
 *
 * The project metadata that a `.gpf` would have supplied (name, directory, data file, time window)
 * is derived here:
 *
 *   projectName         `--name`
 *   projectDirectory    the export directory itself (what `--out` resolves to)
 *   dataFileName        basename of `--capture`
 *   DataInfo.StartTime  first decoded record's GPS time
 *   DataInfo.EndTime    last decoded record's GPS time + 1 ms  (the CSV window is `[start, end)`)
 *   PlotSummary         one entry per chart **whose message actually occurs in the capture**,
 *                       counted from the capture — the same rule R17 applies to a real `.gpf`
 *                       (a `Heading & Attitude` chart counts every INS log that can feed it)
 *   meanOrder           only when `--mean-order=` is given (or a previous `project.json` in the
 *                       output directory already recorded one): the observed `_Mean` column order,
 *                       recorded verbatim so a re-export reproduces it (see `range-charts.ts`)
 *
 * A `project.json` sidecar records the derived metadata and the exact command, so the provenance
 * of the CSVs travels with them.
 *
 * Usage (from `逆向/04_重实现`):
 *
 *   node packages/graph/tools/export-sbf-project.ts \
 *     --capture ../00_来源/samples/live-20261031/b1-20261101.sbf \
 *     --out ../00_来源/samples/graph/export/b1 \
 *     --name b1
 *
 *   # broad: record the `_Mean` order that export actually showed
 *   node packages/graph/tools/export-sbf-project.ts --capture … --out … --name broad \
 *     --mean-order=0,17,16,9,14
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { field, loadCapture, type Capture, type CaptureRecord } from '../src/capture.ts';
import { CSV_CHARTS, writeCsv } from '../src/csv.ts';
import { formatDuration, formatGpsCommentTime } from '../src/format.ts';
import type { DataInfo, GraphProject, PlotSummary } from '../src/project.ts';

interface Args {
  capture: string;
  out: string;
  name: string;
  /** Explicit `_Mean` order recorded for this export (`GraphProject.meanOrder`), when given. */
  meanOrder?: number[];
}

/** `GraphProject.meanOrder` ids are `system * 32 + signal`, so 255 is the largest one. */
export const MEAN_ORDER_MAX = 255;

/**
 * `--mean-order=0,17,16,9,14` → `[0, 17, 16, 9, 14]`.
 *
 * The numbers are `system * 32 + signal` ids in **observed column order** (GPS is system 0, so a
 * GPS-only list reads as plain signal numbers). A stray `;`/space is accepted as a separator and a
 * repeated id is dropped rather than reordered, because the value is a recorded observation, not a
 * sort key the caller should have to normalise.
 */
export function parseMeanOrder(raw: string, source = '--mean-order'): number[] {
  const parts = String(raw).split(/[,;\s]+/).filter(Boolean);
  if (!parts.length) throw new Error(`${source} 为空；示例 --mean-order=0,17,16,9,14`);
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) throw new Error(`${source} 里的 “${part}” 不是非负整数`);
    const id = Number(part);
    if (id > MEAN_ORDER_MAX) throw new Error(`${source} 里的 ${id} 超出 0..${MEAN_ORDER_MAX}（system*32+signal）`);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** `meanOrder` already recorded in `<out>/project.json` (a previous export of the same project). */
function sidecarMeanOrder(outDir: string): number[] | undefined {
  const path = resolve(outDir, 'project.json');
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} 不是合法 JSON，无法读取其中的 meanOrder`);
  }
  const raw = (parsed as { meanOrder?: unknown } | null)?.meanOrder;
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${path} 的 meanOrder 必须是数字数组`);
  return parseMeanOrder(raw.join(','), `${path} 的 meanOrder`);
}

function parseArgs(argv: string[]): Args {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) values[arg.slice(2, eq)] = arg.slice(eq + 1);
    else values[arg.slice(2)] = argv[++i] ?? '';
  }
  const capture = values.capture;
  const out = values.out;
  if (!capture || !out) {
    throw new Error('用法：node packages/graph/tools/export-sbf-project.ts --capture <文件> --out <导出目录> [--name <工程名>] [--mean-order=0,17,16,9,14]');
  }
  const meanOrder = values['mean-order'] === undefined ? undefined : parseMeanOrder(values['mean-order']);
  return { capture, out, name: values.name || basename(out), meanOrder };
}

/** Chart message → the `PlotSummary` section Graph files it under, in the original's layout. */
function sectionOf(message: string): 'PVT' | 'Heading_Attitude' | 'Tracking_Measurements' | 'Receiver_Status' {
  if (message === 'RANGE') return 'Tracking_Measurements';
  if (message === 'RXSTATUS') return 'Receiver_Status';
  if (['INSPVAX', 'INSPVA', 'INSPVAS', 'INSATTX', 'INSATT', 'INSPVACMP'].includes(message)) return 'Heading_Attitude';
  return 'PVT';
}

/**
 * Build the `PlotSummary` a `.gpf` would carry, from the capture's own message counts: a chart is
 * present iff its message occurs. Nothing is hardcoded per project name.
 *
 * `Heading & Attitude` is the one group whose `PlotSummary` keys are not the CSV titles: Graph's own
 * native parser writes `INS Orientation Pitch` / `INS Orientation Azimuth` / `SPAN Filter Updates`
 * with the pseudo-messages `insattitude_pitch` / `insattitude_azimuth` / `insUpdatestatus`
 * (`graph-node-wrapper.node`, the `PlotSummary` string block after `HAEdieLogParser`), so those
 * names are reproduced rather than invented. `csv.ts` matches them back through `plotTitlesOf`.
 */
export function plotSummaryOf(capture: Capture): PlotSummary {
  const summary: PlotSummary = {};
  const tracking: Record<string, Record<string, number>> = {};
  for (const spec of CSV_CHARTS) {
    const sources = spec.sourceMessages ?? [spec.message];
    // A multi-source chart keeps one row per timestamp (`INSERT OR IGNORE` on the timestamp), so its
    // count is the number of **distinct timestamps**, not the number of frames.
    const count = sources.length > 1
      ? new Set(capture.records.filter((record) => sources.includes(record.name)).map((record) => record.gpsMs)).size
      : capture.byName(sources[0]).length;
    if (!count) continue;
    const section = sectionOf(spec.message);
    const title = spec.plot?.title ?? spec.title;
    const message = spec.plot?.message ?? spec.message;
    if (section === 'Tracking_Measurements') {
      tracking[title] = { [message]: count };
      continue;
    }
    const target = (summary[section] as Record<string, Record<string, number>> | undefined) ?? {};
    target[title] = { [message]: count };
    summary[section] = target;
  }
  if (Object.keys(tracking).length) summary.Tracking_Measurements = { Primary: tracking };
  return summary;
}

/**
 * Window of the capture in Graph's ms scale, half-open at the end so every record is exported.
 *
 * Only the messages the 13 CSV charts actually plot (`CSV_CHARTS`) define the window. Taking every
 * decoded frame instead is wrong on a real capture: `b1-20261101.sbf` carries `RXCONFIG` /
 * `SERIALCONFIG` frames with week `0`, and a few ephemeris frames stamped weeks 2235/2399/2402, which
 * stretch the window to 7100 days (the first run produced exactly that).
 */
export function dataInfoOf(records: CaptureRecord[]): DataInfo {
  const plotted = new Set(CSV_CHARTS.flatMap((spec) => spec.sourceMessages ?? [spec.message]));
  const window = records.filter((record) => plotted.has(record.name));
  const chosen = window.length ? window : records;
  if (!chosen.length) throw new Error('采集文件里没有任何可解码的记录');
  let start = chosen[0].gpsMs;
  let end = chosen[0].gpsMs;
  for (const record of chosen) {
    if (record.gpsMs < start) start = record.gpsMs;
    if (record.gpsMs > end) end = record.gpsMs;
  }
  const endTime = end + 1;
  return { StartTime: start, EndTime: endTime, Duration: endTime - start, FileSize: 0 };
}

export function projectFromCapture(
  capture: Capture,
  options: { name: string; outDir: string; capturePath: string; meanOrder?: number[] },
): GraphProject {
  const dataInfo = dataInfoOf(capture.records);
  const projectDirectory = resolve(options.outDir).replace(/\//g, '\\');
  const messages: Record<string, number> = {};
  for (const [name, count] of capture.counts) messages[name] = count;
  return {
    gpfPath: '',
    gpf: {},
    dataSummaryFile: null,
    merged: {},
    projectDirectory,
    projectName: options.name,
    dataFileName: basename(options.capturePath),
    capturePath: resolve(options.capturePath),
    dataInfo,
    plotSummary: plotSummaryOf(capture),
    messages,
    // Only stamped when the caller records one — `clean` / `b1` exports must stay byte-identical.
    ...(options.meanOrder && options.meanOrder.length ? { meanOrder: [...options.meanOrder] } : {}),
  };
}

/**
 * Frames the receiver itself wrote as corrupt.
 *
 * `b1-20261101.sbf` carries one `RANGE` frame (index 23 of 531) whose `obs[]` block decodes into
 * 16 impossible observations — PRN 2573 / 44671 / 43891, C/No 1e-39, a negative lock time. Those are
 * not satellites; the byte stream of that one frame is damaged, every other frame of the capture
 * decodes cleanly. Exporting them would put fictional satellites in every RANGE-fed chart, so the
 * frame is dropped and **counted** in `project.json` instead of being silently patched.
 */
export function isPlausibleRecord(record: CaptureRecord): boolean {
  if (record.name !== 'RANGE') return true;
  const count = field(record, 'obs.count');
  for (let i = 0; i < count; i += 1) {
    const prn = field(record, `obs[${i}].sv_prn`);
    const cno = field(record, `obs[${i}].C_No`);
    const lock = field(record, `obs[${i}].lock_time`);
    if (!Number.isInteger(prn) || prn < 1 || prn > 255) return false;
    if (!Number.isFinite(cno) || cno < 0 || cno > 100) return false;
    if (!Number.isFinite(lock) || lock < 0) return false;
  }
  return true;
}

/** A `Capture` with the corrupt frames removed (and its counts rebuilt from what is left). */
export function cleanCapture(capture: Capture): { capture: Capture; dropped: Array<{ name: string; gpsMs: number }> } {
  const kept: CaptureRecord[] = [];
  const dropped: Array<{ name: string; gpsMs: number }> = [];
  for (const record of capture.records) {
    if (isPlausibleRecord(record)) kept.push(record);
    else dropped.push({ name: record.name, gpsMs: record.gpsMs });
  }
  const counts = new Map<string, number>();
  for (const record of kept) counts.set(record.name, (counts.get(record.name) ?? 0) + 1);
  return {
    capture: { records: kept, counts, byName: (name: string) => kept.filter((record) => record.name === name) },
    dropped,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const capturePath = resolve(args.capture);
  const outDir = resolve(args.out);

  const raw = loadCapture(capturePath);
  if (!raw.records.length) throw new Error(`${capturePath} 没有解码出任何记录`);
  const { capture, dropped } = cleanCapture(raw);
  // A recorded order from this project's own sidecar is metadata of the project, not of this run.
  const meanOrder = args.meanOrder ?? sidecarMeanOrder(outDir);
  const project = projectFromCapture(capture, { name: args.name, outDir, capturePath, meanOrder });

  mkdirSync(outDir, { recursive: true });
  const written = writeCsv(project, capture, outDir);

  const command = `node packages/graph/tools/export-sbf-project.ts --capture ${args.capture} --out ${args.out} --name ${args.name}`
    + (meanOrder && meanOrder.length ? ` --mean-order=${meanOrder.join(',')}` : '');
  const sidecar = {
    projectName: project.projectName,
    projectDirectory: project.projectDirectory,
    dataFileName: project.dataFileName,
    capture: capturePath,
    startTime: formatGpsCommentTime(project.dataInfo.StartTime),
    endTime: formatGpsCommentTime(project.dataInfo.EndTime),
    duration: formatDuration(project.dataInfo.Duration),
    messages: project.messages,
    droppedFrames: dropped,
    chartTitles: CSV_CHARTS
      .filter((spec) => (spec.sourceMessages ?? [spec.message]).some((name) => capture.byName(name).length))
      .map((spec) => spec.title),
    csv: written.map((path) => basename(path)),
    command,
    ...(meanOrder && meanOrder.length ? { meanOrder } : {}),
  };
  writeFileSync(resolve(outDir, 'project.json'), JSON.stringify(sidecar, null, 2) + '\n', 'utf8');

  console.log(`${project.projectName}: ${written.length} 份 CSV → ${resolve(outDir, 'csv')}`);
  for (const path of written) console.log(`  ${basename(path)}`);
  console.log(`时间窗 ${sidecar.startTime} – ${sidecar.endTime}（${sidecar.duration}）`);
  if (meanOrder && meanOrder.length) console.log(`_Mean 列序按记录 ${meanOrder.join(',')}`);
  if (dropped.length) console.log(`跳过 ${dropped.length} 帧损坏记录：${dropped.map((item) => `${item.name}@${item.gpsMs}`).join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
