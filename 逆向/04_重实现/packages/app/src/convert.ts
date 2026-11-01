/**
 * The Convert panel's wrapper around the shared pipeline.
 *
 * The conversion itself — which records are written, `PASSTHROUGH`, the RANGECMP2/4 unpacking, text
 * records, and the latin1 byte encoding — is `protocol/src/convert-pipeline.ts`, the same code
 * `packages/cli/src/convert.ts` writes to disk with. This file only turns one output file into
 * something the browser can preview and download: a label, a content type, a 200-line preview or a
 * hex dump, and the byte count.
 *
 * Nothing here touches the filesystem; the caller owns the bytes.
 */

import type { EdieTables } from '../../protocol/src/edie.ts';
import {
  CONVERT_FORMATS,
  convertFrames,
  isConvertFormat,
  type ConvertFormat,
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
): ConvertArtifact {
  const outcome = convertFrames(data.allFrames ?? data.frames, { format, at, tables, name: data.name });
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
  };
}
