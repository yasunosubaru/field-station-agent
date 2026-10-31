/**
 * The Convert pipeline, lifted out of `packages/cli/src/convert.ts` so the HTTP shell and the CLI
 * cannot drift. Same rules: mirror-mode de-framing, only CRC-good records are written, ASCII and
 * abbreviated ASCII end every line with CRLF, BINARY is the verbatim accepted records.
 *
 * Nothing here touches the filesystem; the caller owns the bytes.
 */

import { decodeEdie } from '../../protocol/src/edie.ts';
import type { EdieTables } from '../../protocol/src/edie.ts';
import { encodeAbbrevLines, encodeBinaryCapture } from '../../protocol/src/abbrev-log.ts';
import { encodeAsciiLog } from '../../protocol/src/ascii-log.ts';
import { buildKml, type KmlPoint } from '../../protocol/src/kml.ts';
import { buildRinex21Obs } from '../../protocol/src/rinex21.ts';
import { buildRinex3Obs, type Rinex3Version } from '../../protocol/src/rinex3.ts';
import { formatDirectory } from '../../protocol/src/summary.ts';
import type { CaptureData } from './capture.ts';

export const CONVERT_FORMATS = ['ASCII', 'ABBREV_ASCII', 'BINARY', 'KML', 'RINEX21', 'RINEX301', 'RINEX302', 'RINEX303', 'RINEX304'] as const;
export type ConvertFormat = (typeof CONVERT_FORMATS)[number];

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

export function isConvertFormat(value: unknown): value is ConvertFormat {
  return typeof value === 'string' && (CONVERT_FORMATS as readonly string[]).includes(value.toUpperCase());
}

export function convertCapture(
  data: CaptureData,
  tables: EdieTables,
  format: ConvertFormat,
  at: Date,
): ConvertArtifact {
  const accepted = data.frames.filter((frame) => frame.crcOk);
  const base = data.name.replace(/\.[^.]+$/, '');
  let payload: string | Uint8Array;

  if (format === 'ASCII') {
    const lines: string[] = [];
    for (const frame of accepted) {
      const layout = tables.messages[String(frame.header.messageId)];
      if (!layout) continue;
      const line = encodeAsciiLog(frame, layout, tables);
      if (line) lines.push(line);
    }
    payload = `${lines.join('\r\n')}\r\n`;
  } else if (format === 'ABBREV_ASCII') {
    const lines: string[] = [];
    for (const frame of accepted) {
      const layout = tables.messages[String(frame.header.messageId)];
      if (!layout) continue;
      lines.push(...encodeAbbrevLines(frame, layout, tables));
    }
    payload = `${lines.join('\r\n')}\r\n`;
  } else if (format === 'KML') {
    const points: KmlPoint[] = [];
    for (const frame of accepted) {
      if (frame.header.messageId !== 42) continue; // BESTPOS is the only position log Convert maps
      const layout = tables.messages['42'];
      if (!layout) continue;
      const values = decodeEdie(frame.payload, layout, tables);
      const get = (path: string) => values.find((value) => value.path === path);
      points.push({
        week: frame.header.week,
        milliseconds: frame.header.milliseconds,
        latitude: Number(get('latitude')?.value),
        longitude: Number(get('longitude')?.value),
        height: Number(get('orthometric_height')?.value),
        latitudeDeviation: Number(get('latitude_std_dev')?.value),
        longitudeDeviation: Number(get('longitude_std_dev')?.value),
        heightDeviation: Number(get('height_std_dev')?.value),
        positionType: String(get('position_type')?.text ?? ''),
      });
    }
    payload = buildKml(points, { name: `${base}_BESTPOS` });
  } else if (format === 'RINEX21') {
    payload = buildRinex21Obs(accepted, tables, { builtAt: at });
  } else if (format.startsWith('RINEX30')) {
    const version = `${format.slice(5, 6)}.${format.slice(6)}` as Rinex3Version;
    payload = buildRinex3Obs(accepted, tables, version, { builtAt: at });
  } else {
    payload = encodeBinaryCapture(accepted).bytes;
  }

  const isText = typeof payload === 'string';
  // convert.ts writes the payload as a UTF-8 string; ASCII/KML/RINEX are pure ASCII so the bytes
  // are identical either way, and BINARY arrives as a Uint8Array.
  const bytes = isText ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const text = isText ? payload : null;
  const outputBase = format === 'KML' ? `${base}_BESTPOS` : base;
  const extension = format === 'RINEX21' || format.startsWith('RINEX30')
    ? `${String(at.getFullYear() % 100).padStart(2, '0')}O`
    : format;
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
    formatDirectory: formatDirectory(format),
    fileName: `${outputBase}.${extension}`,
    extension,
    bytes,
    text,
    lineTotal,
    binary: !isText,
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
