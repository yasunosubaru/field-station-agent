/**
 * Oracle harness: build a synthetic SBF capture, hand it to the installed NovAtel Application
 * Suite's own Convert (2.11.0), and hand back the file it wrote.
 *
 * Every remaining protocol question in this package is a question about bytes the suite prints for
 * a record we have never seen from a receiver. The suite itself is the only authority, and it
 * converts whatever binary frames it is given — the payload does not have to have come off a real
 * receiver. So: lay the payload out per `data/edie-layouts.json`, seal the CRC, run
 * `NovAtelApplicationSuite.exe`, read the line.
 *
 * The suite needs a **pure ASCII path with no spaces** for both input and output (it silently
 * converts nothing otherwise), hence `C:\Users\SunCh\AppData\Local\Temp\opencode\oracle-*`.
 *
 * Run one of the probe scripts in this directory directly:
 *   node --experimental-strip-types 逆向/tools/oracle-useri2c.ts
 * (Node 24 strips the types without the flag.)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendCrcLe } from '../04_重实现/packages/protocol/src/crc.ts';
import { buildLongHeader } from '../04_重实现/packages/protocol/src/header.ts';

export const SUITE = 'C:\\Program Files\\NovAtel Inc\\NovAtel Application Suite\\NovAtelApplicationSuite.exe';
export const TEMP_ROOT = 'C:\\Users\\SunCh\\AppData\\Local\\Temp\\opencode';

/** A binary log frame: long header + payload + CRC. */
export function frame(
  messageId: number,
  payload: Uint8Array,
  header: Partial<Parameters<typeof buildLongHeader>[0]> = {},
): Uint8Array {
  const head = buildLongHeader({
    messageId,
    payloadLength: payload.length,
    // Convert prints the header verbatim, so pin the fields we do not vary.
    portAddress: 32, // COM1
    sequence: 1,
    idleTimeRaw: 0,
    timeStatus: 180, // FINESTEERING
    week: 2402,
    milliseconds: 577759000,
    receiverStatus: 0x03800800,
    reserved: 0xcdba,
    softwareVersion: 18278,
    ...header,
  });
  const body = new Uint8Array(head.length + payload.length);
  body.set(head, 0);
  body.set(payload, head.length);
  return appendCrcLe(body);
}

export interface OracleResult {
  /** `ASCII` output lines (no trailing empty entry), and the raw bytes. */
  ascii: string[];
  asciiBytes: Uint8Array;
  /** `ABBREV_ASCII` output lines and raw bytes. */
  abbrev: string[];
  abbrevBytes: Uint8Array;
}

function findConverted(root: string, format: string): Uint8Array {
  const stem = readdirSync(root)[0];
  const stamp = readdirSync(join(root, stem))[0];
  const dir = join(root, stem, stamp, format);
  const files = readdirSync(dir);
  return new Uint8Array(readFileSync(join(dir, files[0])));
}

/**
 * Convert `capture` (raw bytes, already concatenated) through the suite and return what it wrote.
 * `label` only names the temporary directory.
 */
export function oracle(capture: Uint8Array, label: string): OracleResult {
  const dir = mkdtempSync(join(TEMP_ROOT, `oracle-${label.replace(/[^A-Za-z0-9_-]/g, '')}-`));
  try {
    const input = join(dir, 'probe.sbf');
    writeFileSync(input, capture);
    const runs: Record<string, Uint8Array> = {};
    for (const [format, flag] of [['ASCII', '-a'], ['ABBREV_ASCII', '--abbrev']] as const) {
      const out = join(dir, format);
      mkdirSync(out, { recursive: true });
      try {
        execFileSync(SUITE, [flag, '-o', out, input], { stdio: 'pipe', timeout: 120_000 });
      } catch (error) {
        throw new Error(`${flag} failed: ${(error as Error).message}`);
      }
      runs[format] = findConverted(out, format);
    }
    const split = (bytes: Uint8Array): string[] => {
      let text = '';
      for (const byte of bytes) text += String.fromCharCode(byte);
      return text.split('\r\n').filter((line) => line.length > 0);
    };
    return {
      ascii: split(runs.ASCII), asciiBytes: runs.ASCII,
      abbrev: split(runs.ABBREV_ASCII), abbrevBytes: runs.ABBREV_ASCII,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A payload buffer with the little-endian writers the probes need. */
export class Payload {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }
  u8(at: number, value: number): this { this.view.setUint8(at, value); return this; }
  u16(at: number, value: number): this { this.view.setUint16(at, value, true); return this; }
  u32(at: number, value: number): this { this.view.setUint32(at, value, true); return this; }
  u64(at: number, value: bigint): this { this.view.setBigUint64(at, value, true); return this; }
  i64(at: number, value: bigint): this { this.view.setBigInt64(at, value, true); return this; }
  f32(at: number, value: number): this { this.view.setFloat32(at, value, true); return this; }
  f64(at: number, value: number): this { this.view.setFloat64(at, value, true); return this; }
  /** Raw bytes, `text` written latin-1. */
  ascii(at: number, text: string): this {
    for (let i = 0; i < text.length; i++) this.view.setUint8(at + i, text.charCodeAt(i) & 0xff);
    return this;
  }
}

/** Concatenate frames and text records into one capture. */
export function capture(...parts: Array<Uint8Array | string>): Uint8Array {
  const chunks = parts.map((part) => {
    if (typeof part !== 'string') return part;
    const out = new Uint8Array(part.length);
    for (let i = 0; i < part.length; i++) out[i] = part.charCodeAt(i) & 0xff;
    return out;
  });
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/** Print a diff of the suite's line(s) against ours, and return them. */
export function show(label: string, lines: readonly string[]): void {
  console.log(`--- ${label} (${lines.length} line${lines.length === 1 ? '' : 's'})`);
  for (const line of lines) console.log(`  ${JSON.stringify(line)}`);
}
