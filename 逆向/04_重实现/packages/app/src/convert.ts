/**
 * The Convert panel's wrapper around the shared pipeline.
 *
 * The conversion itself — which records are written, `PASSTHROUGH`, the RANGECMP2/4 unpacking, text
 * records, and the latin1 byte encoding — is `protocol/src/convert-pipeline.ts`, the same code
 * `packages/cli/src/convert.ts` writes to disk with. This file only turns the run into something the
 * browser can preview and download: a label, a content type, a 200-line preview or a hex dump, the
 * byte count, and the list of files the run produced.
 *
 * The five Output Settings controls reach the pipeline through `ConvertSettings`: Sample Rate is the
 * suite's `decimationFilter` (`1 / Hz` seconds), Unknown Data its `unconvertedBytes` (`--unknown-bytes`),
 * Time Interval its `timeInterval` (`--start-time`/`--finish-time`), Prefix/Suffix its
 * `outputFileName` (`affix`). Destination is not a pipeline option — it is where the caller writes the
 * files, so `server.ts` owns it.
 *
 * Nothing here touches the filesystem; the caller owns the bytes.
 */

import type { EdieTables } from '../../protocol/src/edie.ts';
import {
  CONVERT_FORMATS,
  convertFrames,
  isConvertFormat,
  type ConvertFormat,
  type ConvertOutputAffix,
  type ConvertTimePoint,
  type UnknownBytesMode,
} from '../../protocol/src/convert-pipeline.ts';
import type { CaptureData } from './capture.ts';

export { CONVERT_FORMATS, isConvertFormat };
export type { ConvertFormat };

export const FORMAT_LABELS: Record<ConvertFormat, string> = {
  ASCII: 'ASCII 日志',
  ABBREV_ASCII: '缩略 ASCII',
  BINARY: '二进制抓包',
  KML: 'KML 轨迹',
  RINEX21: 'RINEX 2.1 观测',
  RINEX301: 'RINEX 3.01 观测',
  RINEX302: 'RINEX 3.02 观测',
  RINEX303: 'RINEX 3.03 观测',
  RINEX304: 'RINEX 3.04 观测',
};

export const FORMAT_NOTES: Record<ConvertFormat, string> = {
  ASCII: '与套件逐字节一致，CRLF 行尾',
  ABBREV_ASCII: '每字段一行，与 golden-abbrev 一致',
  BINARY: '仅保留 CRC 通过的原记录',
  KML: '按 BESTPOS 位置点绘制，按解类型分组',
  RINEX21: '观测值文件，时间戳取转换时刻',
  RINEX301: '多系统观测码，仅观测文件（导航由 CLI 导出）',
  RINEX302: '多系统观测码，仅观测文件（导航由 CLI 导出）',
  RINEX303: '多系统观测码，仅观测文件（导航由 CLI 导出）',
  RINEX304: '多系统观测码，仅观测文件（导航由 CLI 导出）',
};

export interface ConvertArtifact {
  format: ConvertFormat;
  label: string;
  /** Directory name the suite uses, e.g. RINEXv2_1. */
  formatDirectory: string;
  /** `<input base>.<ext>` — KML appends `_BESTPOS`, RINEX uses `<yy>O`. */
  fileName: string;
  extension: string;
  bytes: Buffer;
  /** null for BINARY. */
  text: string | null;
  lineTotal: number;
  binary: boolean;
  contentType: string;
  preview: string;
  shownLines: number;
  truncated: boolean;
  /**
   * Every file this run produced, in the order the CLI writes them — RINEX writes four or more,
   * `--unknown-bytes=file` adds `<base>.UNKNOWN`. `fileName`/`bytes` above are the first one.
   * `data` is what goes on disk; it is not part of the JSON answer.
   */
  files: Array<{ fileName: string; bytes: number; data: Buffer }>;
  /** The input name with its last extension removed (`b2-20261101`). */
  base: string;
  /** `<base>.UNKNOWN`'s name and length, when the run wrote one (null otherwise). */
  unknownFileName: string | null;
  unknownBytes: number;
  /** `N bytes could not be converted.` — records of a type this format cannot express. */
  unConvertedBytes: number;
  /**
   * Filled in by whoever wrote the files: `server.ts` sets them when the request carried a
   * Destination, and leaves them null when the artifact only lives in memory.
   */
  directory: string | null;
  /** Absolute path of `fileName`, when it was written. */
  path: string | null;
}

/** The Output Settings that reach the pipeline: Sample Rate, Unknown Data, Prefix/Suffix, interval. */
export interface ConvertSettings {
  /** `--decimate=<SECONDS>`: the GUI's Sample Rate is `1 / decimate` (see the panel). */
  decimate?: number;
  unknownBytes?: UnknownBytesMode;
  startTime?: ConvertTimePoint;
  finishTime?: ConvertTimePoint;
  limitDuration?: number;
  affix?: ConvertOutputAffix;
  /**
   * The raw capture. Unknown bytes are, by definition, in no frame, so only the caller that holds
   * the file's bytes can supply them; without it no `.UNKNOWN` is written and the count is 0.
   */
  source?: Uint8Array;
}

const PREVIEW_LINES = 200;
const HEX_BYTES_PER_LINE = 16;

function hexDump(bytes: Uint8Array, lines: number): string {
  const out: string[] = [];
  const limit = Math.min(bytes.length, lines * HEX_BYTES_PER_LINE);
  for (let offset = 0; offset < limit; offset += HEX_BYTES_PER_LINE) {
    const chunk = bytes.subarray(offset, Math.min(offset + HEX_BYTES_PER_LINE, limit));
    const hex = [...chunk].map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    out.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(HEX_BYTES_PER_LINE * 3 - 1, ' ')}  |${ascii}|`);
  }
  return out.join('\n');
}

function textPreview(text: string): { preview: string; shownLines: number; truncated: boolean } {
  const lines = text.split(/\r\n|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const shown = lines.slice(0, PREVIEW_LINES);
  return { preview: shown.join('\n'), shownLines: shown.length, truncated: lines.length > PREVIEW_LINES };
}

/**
 * Convert one capture and describe the file for the browser.
 *
 * Only the first output file is previewed: for every format except RINEX that is the only file, and
 * for RINEX it is the observation file — the navigation files the CLI also writes are not offered
 * for download here (see `FORMAT_NOTES`). The bytes are the pipeline's, untouched, so the download
 * is byte-for-byte the file `convert.ts` would have written.
 */
export function convertCapture(
  data: CaptureData,
  tables: EdieTables,
  format: ConvertFormat,
  at: Date,
  settings: ConvertSettings = {},
): ConvertArtifact {
  const outcome = convertFrames(data.allFrames ?? data.frames, {
    format,
    at,
    tables,
    name: data.name,
    // The GUI's Output Settings: Sample Rate (`--decimate`), Unknown Data
    // (`--unknown-bytes`), Time Interval (`startTime`/`finishTime`), Prefix/Suffix (`affix`).
    ...(settings.decimate !== undefined ? { decimate: settings.decimate } : {}),
    ...(settings.unknownBytes ? { unknownBytes: settings.unknownBytes } : {}),
    ...(settings.startTime ? { startTime: settings.startTime } : {}),
    ...(settings.finishTime ? { finishTime: settings.finishTime } : {}),
    ...(settings.affix ? { affix: settings.affix } : {}),
    ...(settings.limitDuration !== undefined ? { limitDuration: settings.limitDuration } : {}),
    // Unknown bytes are not in any frame, so they can only be summed from the raw capture.
    ...(settings.source ? { source: settings.source } : {}),
  });
  const file = outcome.files[0];
  if (!file) throw new Error(`convert: ${format} produced no file`);

  const text = file.text;
  const bytes = Buffer.from(file.bytes);
  const dot = file.name.lastIndexOf('.');
  const extension = dot > 0 ? file.name.slice(dot + 1) : format;
  const lineTotal = text ? Math.max(0, (text.match(/\n/g) ?? []).length) : Math.ceil(bytes.length / HEX_BYTES_PER_LINE);

  let preview: string;
  let shownLines: number;
  let truncated: boolean;
  if (text) {
    ({ preview, shownLines, truncated } = textPreview(text));
  } else {
    preview = hexDump(bytes, PREVIEW_LINES);
    shownLines = Math.min(PREVIEW_LINES, lineTotal);
    truncated = lineTotal > PREVIEW_LINES;
  }

  const unknownFile = outcome.files.find((item) => item.name.endsWith('.UNKNOWN'));

  return {
    format,
    label: FORMAT_LABELS[format],
    formatDirectory: outcome.formatDirectory,
    fileName: file.name,
    extension,
    bytes,
    text,
    lineTotal,
    binary: text === null,
    contentType: format === 'BINARY'
      ? 'application/octet-stream'
      : format === 'KML'
        ? 'application/vnd.google-earth.kml+xml; charset=utf-8'
        : 'text/plain; charset=utf-8',
    preview,
    shownLines,
    truncated,
    files: outcome.files.map((item) => ({
      fileName: item.name,
      bytes: item.bytes.byteLength,
      data: Buffer.from(item.bytes),
    })),
    base: outcome.base,
    unknownFileName: unknownFile ? unknownFile.name : null,
    // The bytes Convert could not attribute to a log — what `--unknown-bytes=file` dumps, whether
    // or not this run asked for the file (the summary counts them either way).
    unknownBytes: outcome.unknown.length,
    unConvertedBytes: outcome.unConvertedBytes,
    directory: null,
    path: null,
  };
}
