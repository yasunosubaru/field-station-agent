/**
 * The app's live connection to a receiver — the foundation A1's Configuration / Terminal / Events
 * pages all need.
 *
 * Everything below the socket already exists and is tested: `packages/session` owns the transports
 * (TCP/UDP, serial via an injected opener), the `ReceiverSession` state machine, ASCII/binary
 * command framing, heartbeats and per-log decoding. What the web app was missing is one owner for
 * that session: open it, keep a short ring buffer of what came in, let the UI send commands.
 *
 * Polling rather than a WebSocket: the app server is a dependency-free `node:http` server and the
 * panels already poll `/api/...`; a cursor (`GET /api/live/logs?after=<n>`) keeps that style and is
 * testable without a browser.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { connectSerial, connectTcp, connectUdp, type SerialOpener, type Transport } from '../../session/src/transport.ts';
import { ReceiverSession, loadCatalog, type DecodedLog } from '../../session/src/session.ts';
import { encodeAsciiLog } from '../../protocol/src/ascii-log.ts';
import type { EdieTables } from '../../protocol/src/edie.ts';

export interface LiveTarget {
  /** `serial` needs a port name; `tcp`/`udp` need host and port. */
  kind: 'serial' | 'tcp' | 'udp';
  path?: string;
  baud?: number;
  host?: string;
  port?: number;
}

export interface LiveEntry {
  /** Monotonic cursor; the UI passes the last one back as `after`. */
  seq: number;
  messageId: number;
  name: string;
  /** The record rendered exactly like Convert's ASCII line, when a layout exists. */
  ascii: string;
  week: number;
  milliseconds: number;
  time: string;
  crcOk: boolean;
}

export interface LiveStatus {
  connected: boolean;
  target: string | null;
  connectedAt: string | null;
  records: number;
  crcFailures: number;
  droppedBytes: number;
  lastError: string | null;
  /** Commands sent from the Terminal page, newest last. */
  commands: Array<{ at: string; line: string; ok: boolean }>;
}

const BUFFER = 400;
const COMMAND_LOG = 50;
const SERIAL_OPEN_DELAY_MS = 200;

export class LiveLink {
  private session?: ReceiverSession;
  private target?: LiveTarget;
  private connectedAt?: Date;
  private buffer: LiveEntry[] = [];
  private seq = 0;
  private records = 0;
  private crcFailures = 0;
  private droppedBytes = 0;
  private lastError: string | null = null;
  private commands: LiveStatus['commands'] = [];
  private tables?: EdieTables;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  status(): LiveStatus {
    return {
      connected: this.session !== undefined,
      target: this.target ? describe(this.target) : null,
      connectedAt: this.connectedAt ? this.connectedAt.toISOString() : null,
      records: this.records,
      crcFailures: this.crcFailures,
      droppedBytes: this.droppedBytes,
      lastError: this.lastError,
      commands: this.commands.slice(-COMMAND_LOG),
    };
  }

  /**
   * Open the session. `opener` is the serial factory (`serialport`), injected so the module stays
   * dependency-free and the tests can drive a loopback instead.
   */
  async connect(target: LiveTarget, opener?: SerialOpener): Promise<LiveStatus> {
    await this.disconnect();
    this.lastError = null;
    this.records = 0;
    this.crcFailures = 0;
    this.droppedBytes = 0;
    this.buffer = [];
    this.commands = [];

    const handlers = {
      onData: (bytes: Uint8Array) => this.session?.feed(bytes),
      onClose: () => {
        this.connectedAt = undefined;
      },
      onError: (error: Error) => {
        this.lastError = error.message;
      },
    };

    try {
      if (target.kind === 'serial') {
        if (!target.path) throw new Error('serial target needs a port name');
        if (!opener) throw new Error('serial needs the optional `serialport` package (npm i serialport)');
        const transport = await connectSerial(
          opener,
          { path: target.path, baudRate: target.baud ?? 115200, openDelayMs: SERIAL_OPEN_DELAY_MS },
          handlers,
        );
        this.target = target;
        this.attach(transport);
        return this.status();
      } else if (target.kind === 'tcp') {
        const transport = await connectTcp({ host: target.host ?? '127.0.0.1', port: target.port ?? 3001 }, handlers);
        this.target = target;
        this.attach(transport);
        return this.status();
      } else {
        const transport = await connectUdp({ host: target.host ?? '127.0.0.1', port: target.port ?? 3001 }, handlers);
        this.target = target;
        this.attach(transport);
        return this.status();
      }
    } catch (error) {
      this.target = undefined;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    return this.status();
  }

  async disconnect(): Promise<LiveStatus> {
    const session = this.session;
    this.session = undefined;
    this.connectedAt = undefined;
    this.target = undefined;
    if (session) {
      try {
        session.stop();
      } catch {}
    }
    return this.status();
  }

  /**
   * Send one command line from the Terminal page. The bytes are exactly what was typed plus CRLF —
   * that is what the original Terminal writes, and what a receiver's command parser expects.
   * (`sendAscii` would convert it into the `#LOG,…*crc` full-ASCII form instead.)
   */
  send(line: string): LiveStatus {
    const text = line.replace(/[\r\n]+$/, '');
    if (!text) return this.status();
    if (!this.session) {
      this.lastError = 'not connected';
      this.commands.push({ at: new Date().toISOString(), line: text, ok: false });
      return this.status();
    }
    try {
      this.session.sendRaw(`${text}\r`);
      this.commands.push({ at: new Date().toISOString(), line: text, ok: true });
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.commands.push({ at: new Date().toISOString(), line: text, ok: false });
    }
    return this.status();
  }

  /** Entries newer than `after` (0 = everything currently buffered). */
  logs(after = 0): { cursor: number; entries: LiveEntry[] } {
    const entries = after > 0 ? this.buffer.filter((entry) => entry.seq > after) : [...this.buffer];
    return { cursor: this.seq, entries };
  }

  private attach(transport: Transport): void {
    const session = new ReceiverSession(transport, {
      catalog: loadCatalog(this.dataDir),
      heartbeat: { enabled: false },
      requestVersionOnOpen: false,
    });
    this.session = session;
    session.on('log', (log: DecodedLog) => this.record(log));
    session.on('drop', (count: number) => {
      this.droppedBytes += count;
    });
    session.on('error', (error: Error) => {
      this.lastError = error.message;
    });
    session.start();
    this.connectedAt = new Date();
  }

  private record(log: DecodedLog): void {
    this.records += 1;
    if (!log.crcOk) this.crcFailures += 1;
    this.seq += 1;
    this.buffer.push({
      seq: this.seq,
      messageId: log.messageId,
      name: log.name,
      ascii: this.renderAscii(log),
      week: log.header.week,
      milliseconds: log.header.milliseconds,
      time: log.time.toISOString(),
      crcOk: log.crcOk,
    });
    if (this.buffer.length > BUFFER) this.buffer.splice(0, this.buffer.length - BUFFER);
  }

  /** Same line Convert writes, from the decoded record the session already produced. */
  private renderAscii(log: DecodedLog): string {
    if (!this.tables) {
      try {
        this.tables = JSON.parse(readFileSync(join(this.dataDir, 'edie-layouts.json'), 'utf8')) as EdieTables;
      } catch {
        return '';
      }
    }
    const layout = this.tables.messages[String(log.messageId)];
    if (!layout) return '';
    try {
      return encodeAsciiLog(
        { kind: 'sbf', header: log.header, bytes: log.payload, payload: log.payload, crcField: 0, crcOk: log.crcOk },
        layout,
        this.tables,
        { requireValidCrc: false },
      );
    } catch {
      return '';
    }
  }
}

function describe(target: LiveTarget): string {
  if (target.kind === 'serial') return `${target.path ?? '?'} @ ${target.baud ?? 115200}`;
  return `${target.kind}://${target.host ?? '127.0.0.1'}:${target.port ?? 3001}`;
}
