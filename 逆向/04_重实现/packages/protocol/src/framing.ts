/**
 * Stateful byte-stream de-framer.
 *
 * Mirrors `01_解包/app/controller/genericparser.js:13-274` (`GenericParser.processMessage_` +
 * `getIndexes` + `processText`). The observable rules reproduced here:
 *
 *  - Six possible record starts are scanned for at once and the **earliest** one wins:
 *      0xAA binary, '#' full ASCII, '%' short ASCII, '<' abbreviated ASCII, '[' port text, '$' NMEA.
 *  - A binary record is only consumed when header + payload + 4 CRC bytes are all present;
 *    otherwise the whole tail from the sync byte is buffered until the next chunk.
 *  - Text records end at 0x0A, except '[' prefixed ones which end at 0x5D (']').
 *  - Bytes before the earliest candidate are discarded (the original simply returns).
 *  - A binary record whose CRC **field** is zero is dropped; the CRC value itself is not verified
 *    (`genericparser.js:139-141`). This is the `crcMode: 'mirror'` default. Use `'validate'` to
 *    additionally require a correct CRC.
 */

import {
  SYNC_1,
  parseHeader,
  frameLength,
  type SbfHeader,
  SYNC_BINARY_FULL,
  SYNC_BINARY_SHORT,
} from './header.ts';
import { novatelCrc32, readCrcLe } from './crc.ts';

export type TextPrefix = '#' | '%' | '<' | '$' | '[text]';

export interface SbfFrame {
  kind: 'sbf';
  header: SbfHeader;
  /** Header + payload + CRC, exactly as received. */
  bytes: Uint8Array;
  /** Payload only (what the log parsers consume). */
  payload: Uint8Array;
  crcField: number;
  crcOk: boolean;
}

export interface TextFrame {
  kind: 'text';
  prefix: TextPrefix;
  /** Decoded with latin1 so byte values survive round-tripping. */
  text: string;
}

export type Frame = SbfFrame | TextFrame;

export type CrcMode = 'mirror' | 'validate' | 'ignore';

export interface DeframerOptions {
  /** Default 'mirror' = reproduce the original (drop only when the CRC field is zero). */
  crcMode?: CrcMode;
  /**
   * Where to continue after a **rejected** record in `validate` mode. Convert does not trust a
   * record it rejects and never advances by the length field; the measured default (`'header'`,
   * i.e. just past the 28-byte header) reproduces both captures:
   *
   *  - `b1-20261101.sbf`: a RANGE with a bad CRC claims 3700 payload bytes and hides five RAWEPHEM
   *    frames; the suite prints four of them, exactly what this offset finds;
   *  - `broad-clean.gps`: the same rule keeps all 40 SATVIS2 records (stepping one byte instead
   *    lands on a false frame and loses four).
   */
  resync?: 'header' | 'byte' | 'sync';
  /** Called when bytes are thrown away, so a reimplementation can log what the original hides. */
  onDrop?: (byteCount: number, reason: string) => void;
}

const CANDIDATES: ReadonlyArray<number> = [SYNC_1, 0x23 /* # */, 0x25 /* % */, 0x3c /* < */, 0x5b /* [ */, 0x24 /* $ */];

function prefixOf(byte: number): TextPrefix {
  switch (byte) {
    case 0x23:
      return '#';
    case 0x25:
      return '%';
    case 0x3c:
      return '<';
    case 0x5b:
      return '[text]';
    case 0x24:
      return '$';
    default:
      throw new Error('not a text prefix: ' + byte);
  }
}

export class SbfDeframer {
  private pending: Uint8Array = new Uint8Array(0);
  private readonly crcMode: CrcMode;
  private resync: 'header' | 'byte' | 'sync';
  private recovering = false;
  private readonly onDrop?: (byteCount: number, reason: string) => void;

  constructor(options: DeframerOptions = {}) {
    this.crcMode = options.crcMode ?? 'mirror';
    this.resync = options.resync ?? 'header';
    this.onDrop = options.onDrop;
  }

  /** Bytes held back because the record is incomplete. */
  get buffered(): number {
    return this.pending.length;
  }

  reset(): void {
    this.pending = new Uint8Array(0);
  }

  push(chunk: Uint8Array): Frame[] {
    const buf = this.pending.length ? concat(this.pending, chunk) : chunk;
    this.pending = new Uint8Array(0);
    const frames: Frame[] = [];
    let i = 0;

    while (i < buf.length) {
      const found = earliestCandidate(buf, i);
      if (found < 0) {
        this.drop(buf.length - i, 'no-record-start');
        return frames;
      }
      if (found > i) {
        this.drop(found - i, 'garbage-before-record');
        i = found;
      }

      // While recovering from a rejected record, only a binary sync may end the search: a stray
      // '<'/'#'/'$' byte inside the rejected payload would otherwise start a "text record" that
      // runs to the next newline and swallows the real frames behind it (four SATVIS2 records in
      // `broad-clean.gps`).
      if (this.recovering && buf[i] !== SYNC_1) {
        i += 1;
        continue;
      }

      if (buf[i] !== SYNC_1) {
        const isPort = buf[i] === 0x5b;
        const terminator = isPort ? 0x5d : 0x0a;
        const end = buf.indexOf(terminator, i);
        if (end < 0) {
          this.pending = buf.slice(i);
          return frames;
        }
        const slice = buf.slice(i, end + 1);
        frames.push({ kind: 'text', prefix: prefixOf(buf[i]), text: latin1(slice) });
        i = end + 1;
        continue;
      }

      // Binary: need at least 3 bytes to know which header variant this is.
      if (buf.length - i < 3) {
        this.pending = buf.slice(i);
        return frames;
      }
      const sync3 = buf[i + 2];
      if (sync3 !== SYNC_BINARY_FULL && sync3 !== SYNC_BINARY_SHORT) {
        // 0xAA that is not a NovAtel sync: step one byte and rescan (original: `i = index`, then i++).
        i += 1;
        continue;
      }

      const header = parseHeader(buf, i);
      if (header === null) {
        i += 1;
        continue;
      }
      if (header === 'need-more') {
        this.pending = buf.slice(i);
        return frames;
      }
      const total = frameLength(header);
      if (buf.length - i < total) {
        this.pending = buf.slice(i);
        return frames;
      }

      const bytes = buf.slice(i, i + total);
      const crcField = readCrcLe(bytes, total - 4);
      const computed = novatelCrc32(bytes.subarray(0, total - 4));
      const crcOk = computed === crcField;

      let accept = true;
      if (this.crcMode === 'mirror') accept = crcField !== 0;
      else if (this.crcMode === 'validate') accept = crcField !== 0 && crcOk;

      if (accept) {
        this.recovering = false;
        frames.push({
          kind: 'sbf',
          header,
          bytes,
          payload: bytes.subarray(header.headerLength, total - 4),
          crcField,
          crcOk,
        });
        i += total;
      } else {
        this.drop(total, this.crcMode === 'validate' ? 'crc-mismatch' : 'zero-crc-field');
        // Convert does not trust the length field of a record it rejects: it never advances by
        // `total`. Where it resumes is measured — see `DeframerOptions.resync`.
        if (this.crcMode === 'validate') {
          this.recovering = true;
          i += this.resync === 'byte' ? 1 : this.resync === 'sync' ? 3 : header.headerLength;
        } else {
          i += total;
        }
      }
    }
    return frames;
  }

  private drop(byteCount: number, reason: string): void {
    if (byteCount > 0 && this.onDrop) this.onDrop(byteCount, reason);
  }
}

function earliestCandidate(buf: Uint8Array, from: number): number {
  let best = -1;
  for (const byte of CANDIDATES) {
    const at = buf.indexOf(byte, from);
    if (at >= 0 && (best < 0 || at < best)) best = at;
    if (best === from) break;
  }
  return best;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}
