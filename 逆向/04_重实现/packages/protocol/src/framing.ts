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
  /** Byte offset of the frame's first sync byte in the stream, when the deframer made it. */
  offset?: number;
}

export interface TextFrame {
  kind: 'text';
  prefix: TextPrefix;
  /** Decoded with latin1 so byte values survive round-tripping. */
  text: string;
  /** Byte offset of the record's first byte in the stream, when the deframer made it. */
  offset?: number;
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
  /**
   * The same event with the bytes themselves. Convert's `--unknown-bytes=file` writes them out
   * (`<base>.UNKNOWN`), so a reimplementation needs the payload, not only the length. Reasons:
   * `no-record-start`, `garbage-before-record`, `record-start-inside-text`, `crc-mismatch`,
   * `zero-crc-field`, `truncated-tail`.
   */
  onDropBytes?: (bytes: Uint8Array, reason: string) => void;
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
  private readonly onDropBytes?: (bytes: Uint8Array, reason: string) => void;
  /** Bytes handed to `push` so far, so frames can carry their stream offset. */
  private received = 0;

  constructor(options: DeframerOptions = {}) {
    this.crcMode = options.crcMode ?? 'mirror';
    this.resync = options.resync ?? 'header';
    this.onDrop = options.onDrop;
    this.onDropBytes = options.onDropBytes;
  }

  /** Bytes held back because the record is incomplete. */
  get buffered(): number {
    return this.pending.length;
  }

  /**
   * End of stream: whatever is still buffered can never become a record, so it is dropped like the
   * rest. Convert counts those trailing bytes too (`b1` ends with a half-received record).
   */
  end(): void {
    const rest = this.pending;
    this.pending = new Uint8Array(0);
    this.drop(rest.length, 'truncated-tail', rest);
  }

  reset(): void {
    this.pending = new Uint8Array(0);
  }

  push(chunk: Uint8Array): Frame[] {
    // Stream position of `buf[0]`: everything already consumed, minus what was held back.
    const base = this.received - this.pending.length;
    const buf = this.pending.length ? concat(this.pending, chunk) : chunk;
    this.received += chunk.length;
    this.pending = new Uint8Array(0);
    const frames: Frame[] = [];
    let i = 0;

    while (i < buf.length) {
      const found = earliestCandidate(buf, i);
      if (found < 0) {
        this.drop(buf.length - i, 'no-record-start', buf.subarray(i));
        return frames;
      }
      if (found > i) {
        this.drop(found - i, 'garbage-before-record', buf.subarray(i, found));
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
        // A text record may not swallow a record that starts inside it. Measured on synthetic
        // captures through the suite's own Convert: a `$GPGGA,…*47` with no CRLF directly in front
        // of a binary frame loses the sentence and keeps the frame, and a `#BESTPOSA,…*crc` behind
        // it is kept too; the reverse (text terminated by LF before the frame) is the normal case.
        // The suite therefore begins a new record at the first **binary sync** or `#` inside the
        // span — and at nothing else: `$…$…\r\n` is printed as one (merged) NMEA line, and a `<`
        // inside an unterminated `$` is not recovered either.
        const boundary = textBoundary(buf, i, end < 0 ? buf.length : end);
        if (boundary >= 0) {
          // Unterminated as far as the record is concerned: drop the bytes it had claimed. The
          // suite prints nothing for them (measured), so this is a drop, not a frame.
          this.drop(boundary - i, 'record-start-inside-text', buf.subarray(i, boundary));
          i = boundary;
          continue;
        }
        if (end < 0) {
          this.pending = buf.slice(i);
          return frames;
        }
        const slice = buf.slice(i, end + 1);
        frames.push({ kind: 'text', prefix: prefixOf(buf[i]), text: latin1(slice), offset: base + i });
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
          offset: base + i,
        });
        i += total;
      } else {
        this.drop(total, this.crcMode === 'validate' ? 'crc-mismatch' : 'zero-crc-field', bytes);
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

  private drop(byteCount: number, reason: string, bytes?: Uint8Array): void {
    if (byteCount <= 0) return;
    this.onDrop?.(byteCount, reason);
    if (bytes) this.onDropBytes?.(bytes, reason);
  }
}

/**
 * First position in `[from + 1, limit)` where a record the suite keeps can start inside a text
 * record: a binary sync (`AA 44 12` / `AA 03 13`) or a `#` record.
 *
 * Measured with synthetic captures through the suite's Convert (see the call site):
 *  - `$GPGGA,…*47` with no CRLF, followed by two BESTPOS frames → both frames come out;
 *  - the same with a `#BESTPOSA,…*crc` behind it → that record comes out, the sentence does not;
 *  - `$GPGGA,…*47` + `$GPGGA,…*47\r\n` → one merged NMEA line (a `$` is not a boundary);
 *  - `$GPGGA,…*47` + `<BESTPOS …\r\n` → nothing for either (a `<` is not a boundary either).
 */
function textBoundary(buf: Uint8Array, from: number, limit: number): number {
  // Except when the text *is* a complete record that merely quotes another one: an RXCONFIG dump
  // arrives as `#RXCONFIGA,<head>;#LOGA,<head>;<body>*<inner crc>*<outer crc>`, and the suite keeps
  // that whole line (247 of them in `b7-20261101.sbf`, each printed as one `#RXCONFIGA,��` line).
  // A line whose own CRC checks out cannot be the truncated fragment the rule below is about.
  if (completeHashLine(buf, from, limit)) return -1;
  for (let j = from + 1; j < limit; j++) {
    if (buf[j] === 0x23 /* # */) return j;
    if (buf[j] === SYNC_1 && j + 2 < buf.length) {
      const kind = buf[j + 2];
      if (kind === SYNC_BINARY_FULL || kind === SYNC_BINARY_SHORT) return j;
    }
  }
  return -1;
}

/**
 * `#NAME,<nine header tokens>;��*<8 hex>` whose CRC is right? `limit` is the line's terminator, so
 * the check is exactly the gate `passThroughAscii` applies later.
 */
function completeHashLine(buf: Uint8Array, from: number, limit: number): boolean {
  if (buf[from] !== 0x23 /* # */) return false;
  let end = limit;
  while (end > from && (buf[end - 1] === 0x0d || buf[end - 1] === 0x0a)) end -= 1;
  if (end - from < 12 || buf[end - 9] !== 0x2a /* * */) return false;
  let crc = 0;
  for (let i = end - 8; i < end; i += 1) {
    const c = buf[i];
    const digit =
      c >= 0x30 && c <= 0x39 ? c - 0x30
        : c >= 0x61 && c <= 0x66 ? c - 0x57
          : c >= 0x41 && c <= 0x46 ? c - 0x37
            : -1;
    if (digit < 0) return false;
    crc = crc * 16 + digit;
  }
  return novatelCrc32(buf.subarray(from + 1, end - 9)) === crc;
}

function earliestCandidate(buf: Uint8Array, from: number): number {  let best = -1;
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
