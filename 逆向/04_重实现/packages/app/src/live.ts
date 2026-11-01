/**
 * The app's live connection to a receiver — the foundation A1's Configuration / Terminal / Events
 * pages all need, and the source the Status dashboard prefers over a capture once a real session
 * is open.
 *
 * Everything below the socket already exists and is tested: `packages/session` owns the transports
 * (TCP/UDP, serial via an injected opener), the `ReceiverSession` state machine, ASCII/binary
 * command framing, heartbeats and per-log decoding. What the web app was missing is one owner for
 * that session: open it, keep a short ring buffer of what came in, let the UI send commands.
 *
 * Two decoders run on every record, deliberately:
 *  - `ReceiverSession` already produced the view-model fields (that is what the ring buffer's
 *    `ascii` line is rendered from and where `HWMONITOR.idleTime` survives);
 *  - `decodeEdie` reads the same payload through the EDIE dictionary, the reader `/api/records`
 *    uses for a capture. That is the only place `RANGE.obs[i].sv_prn/c_status` exist, so reusing it
 *    keeps the live cards and the capture cards on one field vocabulary (`obs[0].sv_prn`,
 *    `measurements[3].value`, …).
 *
 * Polling rather than a WebSocket: the app server is a dependency-free `node:http` server and the
 * panels already poll `/api/...`; a cursor (`GET /api/live/logs?after=<n>`) keeps that style and is
 * testable without a browser.
 *
 * The link also carries the **command-response channel** the `.cfg` import needs: `command()` sends
 * one line and resolves with the receiver's own `<OK` / `<ERR…` (or says it timed out), and
 * `collect()` reads the data lines a log request answers with. Replies carry no command name, so
 * they are matched in the order the receiver emits them — the only evidence the wire offers.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { connectSerial, connectTcp, connectUdp, type SerialOpener, type Transport } from '../../session/src/transport.ts';
import { ReceiverSession, loadCatalog, type DecodedLog } from '../../session/src/session.ts';
import { decodeEdie, type EdieTables, type EdieValue } from '../../protocol/src/edie.ts';
import { encodeAsciiLog } from '../../protocol/src/ascii-log.ts';

export interface LiveTarget {
  /** `serial` needs a port name; `tcp`/`udp` need host and port. */
  kind: 'serial' | 'tcp' | 'udp';
  path?: string;
  baud?: number;
  host?: string;
  port?: number;
}

/* ---------------------------------------------------------------------------------------------
 * Telemetry projections — what the Status cards read.
 *
 * Only messages the dashboard actually renders are decoded; every other record keeps its ASCII
 * line and nothing else, so a 400-record buffer stays small even while RANGE arrives at 1 Hz.
 * ------------------------------------------------------------------------------------------- */

/** BESTPOS #42 — the band's left half and the Positioning tile. */
export interface LivePosition {
  kind: 'bestpos';
  solutionStatus: string;
  positionType: string;
  latitude: number | null;
  longitude: number | null;
  height: number | null;
  undulation: number | null;
  datumId: string;
  latitudeDeviation: number | null;
  longitudeDeviation: number | null;
  heightDeviation: number | null;
  satellitesTracked: number | null;
  satellitesUsed: number | null;
}

/** HWMONITOR #963 — the Device tile. `type`/`limit` come from the status word, as in a capture. */
export interface LiveSensor {
  type: number;
  value: number;
  limit: number;
}

export interface LiveDevice {
  kind: 'hwmonitor';
  sensors: LiveSensor[];
  /** `HWMONITOR.idleTime`; the original prints CPU Usage as `100 − raw / 2` (see GRIT §5.6). */
  idleTime: number | null;
}

/** RANGE #43 — Satellite View counts and the symbolic sky dots. */
export interface LiveObservation {
  prn: number;
  /** `(c_status >> 16) & 7`: 0 GPS · 1 GLO · 2 SBAS · 3 GAL · 4 BDS · 5 QZSS · 6 NAVIC. */
  system: number;
  cno: number | null;
}

export interface LiveRange {
  kind: 'range';
  observations: LiveObservation[];
}

/** ITDETECTSTATUS #2065 — the Interference tile when the receiver logs it. */
export interface LiveInterferenceEntry {
  rfPath: string;
  detectionType: string;
  centerFrequency: number | null;
  bandwidth: number | null;
  power: number | null;
  estimatedPower: number | null;
  severity: number[];
}

export interface LiveInterference {
  kind: 'itdetect';
  entries: LiveInterferenceEntry[];
}

/**
 * The `status word` of ITPSDFINAL / ITPSDDETECT — OEM7 Commands and Logs Reference Manual,
 * ITPSDFINAL §"Spectral analysis status word". It describes the *configuration* of the sweep; it
 * carries no sequence number (that lives in the binary header, see `LiveSpectrum.sequence`).
 */
export interface LiveSpectrumStatus {
  /** The word verbatim, so nothing below can be mistaken for the wire value. */
  word: number;
  /** Bits 0-3 — `ITSPECTRALANALYSIS` frequency index (0 GPSL1 · 5 GPSL5 · 6 LBAND · …). */
  frequency: number;
  /** Bits 4-7 — data source (0 OFF · 1 PREDECIMATION · 2 POSTDECIMATION · 3 POSTFILTER). */
  dataSource: number;
  /** Bits 8-10 — FFT size index (0 = 1K … 6 = 64K). */
  fftSize: number;
  /** Bits 11-15 — integration window. */
  integrationWindow: number;
  /** Bits 16-19 — time-averaging window, seconds. */
  timeAverage: number;
}

/**
 * ITPSDFINAL #1968 / ITPSDDETECT #2063 — one chunk of a PSD sweep, in dBm.
 *
 * The manual caps one log at 1024 samples: "if the number of samples is larger than 1024, more
 * than one ITPSDFINAL log is needed … The output logs can be grouped together through the sequence
 * number of the log header." Measured in `samples/live-20261031/b1-20261101.sbf`: every
 * ITPSDDETECT sweep is two frames — header sequence 1 with 1024 samples at 1531.2866 MHz, then
 * header sequence 0 with the remaining 341 samples at 1606.2866 MHz (= start + 1024 × RBW), both
 * stamped with the same millisecond and the same status word. So `sequence` here is the **header**
 * field at byte 10 (`header.sequence`), and it counts down to 0 on the last chunk.
 */
export interface LiveSpectrum {
  kind: 'itpsd';
  /** `final` = ITPSDFINAL (1968), `detect` = ITPSDDETECT (2063). Both share this shape. */
  log: 'final' | 'detect';
  /** Header word at byte 10; `0` marks the last chunk of a sweep. */
  sequence: number;
  status: LiveSpectrumStatus;
  /** MHz — frequency of sample 0. */
  frequencyStart: number;
  /** Hz — resolution bandwidth, i.e. the spacing of one bin. */
  stepSize: number;
  /** dBm — `raw / 256 − 200`, the manual's two conversion steps, applied per sample. */
  samples: number[];
}

/** VERSION #37 — the Device tile's Model. */
export interface LiveVersion {
  kind: 'version';
  model: string;
  hardwareVersion: string;
  softwareVersion: string;
}

/** SATVIS2 #1043 — real azimuth/elevation, so the sky plot stops being symbolic. */
export interface LiveSatvis {
  kind: 'satvis';
  system: string;
  satellites: Array<{ id: number; elevation: number; azimuth: number; health: number }>;
}

export type LiveData =
  | LivePosition
  | LiveDevice
  | LiveRange
  | LiveInterference
  | LiveVersion
  | LiveSatvis
  | LiveSpectrum;

export interface LiveEntry {
  /** Monotonic cursor; the UI passes the last one back as `after`. */
  seq: number;
  messageId: number;
  name: string;
  /** The record rendered exactly like Convert's ASCII line, when a layout exists. */
  ascii: string;
  /** Decoded projection for the Status cards, `null` for messages nothing reads. */
  data: LiveData | null;
  week: number;
  milliseconds: number;
  time: string;
  crcOk: boolean;
}

/**
 * How a command line ended. `ok` / `err` are the receiver's own two answers (`<OK`, `<ERR…`);
 * the rest are this link's, and they are never reported as success.
 */
export type LiveCommandStatus =
  | 'ok'
  | 'err'
  | 'pending'
  | 'timeout'
  | 'not-connected'
  | 'send-failed'
  | 'closed';

/**
 * One command line and the receiver's answer to it — the channel the `.cfg` import needs and the
 * Terminal never had.
 *
 * A receiver answers abbreviated-ASCII commands **in order**, one `<OK`/`<ERR…` per line, and the
 * reply carries no command name (`<OK` is all it says). So a line is matched to the reply the
 * receiver emits next: that is the only ordering evidence the wire offers, and a reply that arrives
 * with nothing outstanding is counted as unsolicited rather than used to mark a command OK.
 */
export interface LiveCommandReply {
  /** Monotonic inside this session; the first command sent is `0`. */
  id: number;
  /** When the line went out (ISO 8601). */
  at: string;
  line: string;
  ok: boolean;
  status: LiveCommandStatus;
  /** The receiver's own words, verbatim (`<OK`, `<ERR,Invalid port`), `null` when none arrived. */
  reply: string | null;
  /** Milliseconds between the write and the answer (or the timeout). */
  elapsedMs: number;
}

/** What one read-back request produced: the receiver's data lines, in arrival order. */
export interface LiveCollectResult {
  ok: boolean;
  lines: string[];
  reason: string;
}

export interface LiveStatus {
  connected: boolean;
  target: string | null;
  connectedAt: string | null;
  /** When the transport last closed under us (the receiver was unplugged or the socket dropped). */
  disconnectedAt: string | null;
  records: number;
  crcFailures: number;
  droppedBytes: number;
  lastError: string | null;
  /** UTC of the newest decoded record, `null` before the first one. */
  lastRecordAt: string | null;
  /**
   * Commands sent from the Terminal page, newest last. A line sent through `command()` carries the
   * receiver's own answer (`reply`), how it ended (`status`) and how long it took.
   */
  commands: Array<{
    at: string;
    line: string;
    ok: boolean;
    id?: number;
    reply?: string | null;
    status?: LiveCommandStatus;
    elapsedMs?: number;
  }>;
  /** `<OK`/`<ERR…` lines that arrived with no command outstanding (never used as success). */
  unsolicitedReplies: number;
}

/**
 * Is this text line an answer to the log request for `asked`?
 *
 * A text answer carries the log's own name in its first field — `<RXCONFIG USB2 270 …` (abbreviated)
 * or `#RXCONFIGA,SPECIAL,270,…` (full ASCII) — while the stream's own records carry theirs. With no
 * name asked for, everything is kept, and so is a line that carries no record prefix at all (a
 * banner, a note), because nothing says it is not the answer.
 */
function answeredBy(line: string, asked: string | undefined): boolean {
  if (!asked) return true;
  if (!/^[<#%]/.test(line)) return true;
  const match = /^[<#%]\s*([A-Za-z0-9_]+)/.exec(line);
  /* A record prefix with no name is a continuation of the record above (`<     GLONASS 5.0 0`),
   * never an answer of its own. */
  if (!match) return false;
  return match[1].toUpperCase().replace(/[AB]$/, '') === asked;
}

const BUFFER = 400;
const COMMAND_LOG = 50;
/** A receiver answers a configuration line in milliseconds; a minute of silence means it is gone. */
const COMMAND_TIMEOUT_MS = 15_000;
/** Read-back is a log request: the answer arrives as a burst, then the line goes quiet. */
const COLLECT_TIMEOUT_MS = 8_000;
const COLLECT_QUIET_MS = 1_200;
/** Text lines kept for later inspection (`<RXCONFIGA,…` and friends). */
const INBOUND_LINES = 200;

/** `<OK`, `<ERR…`, `<ERROR:…` — the receiver's own command responses, not data records. */
const REPLY_PATTERN = /^<(OK|ERR|ERROR)([,\s:;]|$)/i;
const SERIAL_OPEN_DELAY_MS = 200;
/** A RANGE with 84 observations in a capture; 256 leaves room for a bigger constellation set. */
const OBSERVATION_LIMIT = 256;
const SATELLITE_LIMIT = 256;
/** One ITPSDFINAL log is capped at 1024 samples, but a 64K FFT can ask for far more per sweep. */
const SAMPLE_LIMIT = 65536;

/** Message ids whose payload `decodeEdie` turns into a `LiveData` projection. */
const TELEMETRY_IDS = new Set([37, 42, 43, 963, 1043, 1968, 2063, 2065]);

/** A command line waiting for the receiver's next `<OK`/`<ERR…`. */
interface PendingCommand {
  id: number;
  line: string;
  /** The entry already in `LiveStatus.commands`; updated in place when the reply lands. */
  entry: LiveStatus['commands'][number];
  sentAt: number;
  timeoutMs: number;
  /** A Terminal line: kept in the queue for order, but its `ok` means "the write went out". */
  placeholder?: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  resolve: (reply: LiveCommandReply) => void;
}

export class LiveLink {
  private session?: ReceiverSession;
  private transport?: Transport;
  private target?: LiveTarget;
  private connectedAt?: Date;
  private disconnectedAt?: Date;
  private lastRecordAt?: Date;
  private buffer: LiveEntry[] = [];
  private seq = 0;
  private records = 0;
  private crcFailures = 0;
  private droppedBytes = 0;
  private lastError: string | null = null;
  private commands: LiveStatus['commands'] = [];
  /** Commands waiting for the next `<OK`/`<ERR…`, oldest first (the receiver answers in order). */
  private outstanding: PendingCommand[] = [];
  private commandSeq = 0;
  private unsolicitedReplies = 0;
  /** Text lines the receiver emitted that are not command responses (read-back answers, NMEA…). */
  private inbound: Array<{ at: number; text: string }> = [];
  /** Read-back requests currently waiting for their data lines. */
  private collectors: Array<{ lines: string[] }> = [];
  private tables?: EdieTables;
  private tablesFailed = false;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  status(): LiveStatus {
    return {
      connected: this.isOpen(),
      target: this.target ? describe(this.target) : null,
      connectedAt: this.connectedAt ? this.connectedAt.toISOString() : null,
      disconnectedAt: this.disconnectedAt ? this.disconnectedAt.toISOString() : null,
      records: this.records,
      crcFailures: this.crcFailures,
      droppedBytes: this.droppedBytes,
      lastError: this.lastError,
      lastRecordAt: this.lastRecordAt ? this.lastRecordAt.toISOString() : null,
      commands: this.commands.slice(-COMMAND_LOG).map((command) => ({ ...command })),
      unsolicitedReplies: this.unsolicitedReplies,
    };
  }

  /**
   * A session is only "connected" while its transport is still open: a receiver unplugged mid-run
   * must stop the dashboard claiming to be live. `serialport` fakes in tests omit `isOpen`, so an
   * unknown answer counts as open rather than silently reporting a dead link.
   */
  private isOpen(): boolean {
    if (!this.session) return false;
    return this.transport ? this.transport.isOpen !== false : false;
  }

  /**
   * Open the session. `opener` is the serial factory (`serialport`), injected so the module stays
   * dependency-free and the tests can drive a loopback instead.
   */
  async connect(target: LiveTarget, opener?: SerialOpener): Promise<LiveStatus> {
    await this.disconnect();
    this.lastError = null;
    this.disconnectedAt = undefined;
    this.lastRecordAt = undefined;
    this.records = 0;
    this.crcFailures = 0;
    this.droppedBytes = 0;
    this.buffer = [];
    this.commands = [];
    this.outstanding = [];
    this.commandSeq = 0;
    this.unsolicitedReplies = 0;
    this.inbound = [];
    this.collectors = [];

    const handlers = {
      onData: (bytes: Uint8Array) => this.session?.feed(bytes),
      onClose: () => this.markClosed(),
      onError: (error: Error) => {
        this.markClosed();
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
        /* `allowHalfOpen: false`: a receiver that closes its side must end this session, otherwise
         * the dashboard would keep saying Live over a socket that can never deliver another record. */
        const transport = await connectTcp(
          { host: target.host ?? '127.0.0.1', port: target.port ?? 3001, allowHalfOpen: false },
          handlers,
        );
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
      this.session = undefined;
      this.transport = undefined;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    return this.status();
  }

  async disconnect(): Promise<LiveStatus> {
    const session = this.session;
    this.session = undefined;
    this.transport = undefined;
    this.connectedAt = undefined;
    this.target = undefined;
    // Anything still waiting for a `<OK` must end now: a caller awaiting a reply would otherwise
    // hang until its own timeout and report a mystery.
    this.failPending('closed');
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
   *
   * The line takes a place in the reply queue even though nothing here awaits it: a receiver
   * answers in order, so without that place the `<OK` meant for this line could be credited to the
   * next awaited command.
   */
  send(line: string): LiveStatus {
    const text = line.replace(/[\r\n]+$/, '');
    if (!text) return this.status();
    const entry: LiveStatus['commands'][number] = {
      at: new Date().toISOString(),
      line: text,
      ok: false,
      id: this.commandSeq++,
      reply: null,
      status: 'pending',
      elapsedMs: 0,
    };
    this.pushCommand(entry);
    if (!this.isOpen()) {
      this.lastError = 'not connected';
      entry.status = 'not-connected';
      return this.status();
    }
    try {
      this.session!.sendRaw(`${text}\r`);
      entry.ok = true;
      this.lastError = null;
      this.armPlaceholder(entry);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      entry.status = 'send-failed';
    }
    return this.status();
  }

  /** Send raw framed bytes (a binary command the configuration pages built). */
  sendBinary(bytes: Uint8Array): LiveStatus {
    if (!this.session) {
      this.lastError = 'not connected';
      return this.status();
    }
    try {
      this.session.sendBytes(bytes);
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    return this.status();
  }

  /** Entries newer than `after` (0 = everything currently buffered). */
  logs(after = 0): { cursor: number; entries: LiveEntry[] } {
    const entries = after > 0 ? this.buffer.filter((entry) => entry.seq > after) : [...this.buffer];
    return { cursor: this.seq, entries };
  }

  private markClosed(): void {
    this.connectedAt = undefined;
    if (!this.disconnectedAt) this.disconnectedAt = new Date();
    this.failPending('closed');
  }

  private attach(transport: Transport): void {
    const session = new ReceiverSession(transport, {
      catalog: loadCatalog(this.dataDir),
      heartbeat: { enabled: false },
      requestVersionOnOpen: false,
    });
    this.session = session;
    this.transport = transport;
    session.on('log', (log: DecodedLog) => this.record(log));
    // The receiver's own words: `<OK` / `<ERR…` answer a command, everything else is data (a
    // read-back `RXCONFIG` line, an NMEA sentence). This is the channel the decoded-log stream
    // cannot carry, and the reason a `.cfg` can now be verified.
    session.on('text', (prefix: string, text: string) => this.onText(prefix, text));
    session.on('drop', (count: number) => {
      this.droppedBytes += count;
    });
    session.on('error', (error: Error) => {
      this.lastError = error.message;
    });
    session.start();
    this.connectedAt = new Date();
  }

  /* ------------------------------------------------------------- command / reply channel */

  /**
   * Send one command line and wait for the receiver's answer to **that** line.
   *
   * The bytes are the ones the Terminal writes (`line` + CRLF, no CRC framing): abbreviated ASCII
   * is what a receiver's parser accepts on a terminal port, and it is what the shipped Terminal
   * sends. `ok` is true only for `<OK`; `<ERR…`, a timeout and a closed session are all failures,
   * and each of them says which it was.
   */
  async command(line: string, options: { timeoutMs?: number } = {}): Promise<LiveCommandReply> {
    const text = line.replace(/[\r\n]+$/, '');
    const at = new Date();
    const id = this.commandSeq++;
    const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const entry: LiveStatus['commands'][number] = {
      at: at.toISOString(),
      line: text,
      ok: false,
      id,
      reply: null,
      status: 'pending',
      elapsedMs: 0,
    };
    this.pushCommand(entry);
    const settled = (over: Partial<LiveCommandReply>): LiveCommandReply => {
      Object.assign(entry, over);
      return { id, at: at.toISOString(), line: text, ok: false, status: 'pending', reply: null, elapsedMs: 0, ...over };
    };
    if (!text) return settled({ status: 'send-failed', elapsedMs: 0 });
    if (!this.isOpen() || !this.session) {
      this.lastError = 'not connected';
      return settled({ status: 'not-connected' });
    }
    try {
      this.session.sendRaw(`${text}\r`);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return settled({ status: 'send-failed' });
    }
    this.lastError = null;
    return new Promise<LiveCommandReply>((resolve) => {
      const waiter: PendingCommand = {
        id,
        line: text,
        entry,
        sentAt: Date.now(),
        timeoutMs,
        resolve: (reply) => resolve(reply),
        timer: undefined,
      };
      waiter.timer = setTimeout(() => this.settleWaiter(waiter, null, 'timeout'), timeoutMs);
      (waiter.timer as unknown as { unref?: () => void }).unref?.();
      this.outstanding.push(waiter);
    });
  }

  /**
   * Send a request whose answer is **data**, not `<OK` — `LOG RXCONFIGB ONCE` and its kind.
   * Collects the receiver's text lines until it has been quiet for `quietMs`, `until` is satisfied,
   * or `timeoutMs` elapses; the lines are returned verbatim so the caller can quote them.
   *
   * `records: true` also returns the **decoded records** that arrived while the request was in
   * flight, as their rendered ASCII lines. This receiver answers `LOG RXCONFIGB ONCE` with 271 SBF
   * records of message 128 rather than with text (measured 2026-11-01 on the desk OEM729), so a
   * text-only collector would report silence over an answer that was complete.
   */
  async collect(
    line: string,
    options: {
      timeoutMs?: number;
      quietMs?: number;
      until?: (lines: string[]) => boolean;
      records?: boolean;
    } = {},
  ): Promise<LiveCollectResult> {
    const text = line.replace(/[\r\n]+$/, '');
    if (!text) return { ok: false, lines: [], reason: 'empty request' };
    if (!this.isOpen() || !this.session) return { ok: false, lines: [], reason: 'not connected' };
    const timeoutMs = options.timeoutMs ?? COLLECT_TIMEOUT_MS;
    const quietMs = options.quietMs ?? COLLECT_QUIET_MS;
    const collector = { lines: [] as string[] };
    /** Records already in the ring are not answers to *this* request. */
    const mark = this.seq;
    /* Only the records the request itself asks for count as an answer: a receiver streaming RANGE
     * at 20 Hz puts ~110 RANGE records in the ring during one read-back, and counting them would
     * report "382 configuration lines" for a 271-statement dump. */
    const asked = /^LOG\s+([A-Za-z0-9_]+)/i.exec(text)?.[1]?.toUpperCase().replace(/[AB]$/, '');
    const recordsSoFar = (): LiveEntry[] =>
      options.records
        ? this.buffer.filter(
            (entry) => entry.seq > mark && (!asked || entry.name.toUpperCase().replace(/[AB]$/, '') === asked),
          )
        : [];
    this.collectors.push(collector);
    try {
      this.session.sendRaw(`${text}\r`);
      const deadline = Date.now() + timeoutMs;
      let lastCount = 0;
      let quietSince = Date.now();
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 40));
        const arrived = collector.lines.length + recordsSoFar().length;
        if (arrived !== lastCount) {
          lastCount = arrived;
          quietSince = Date.now();
        }
        if (options.until?.(collector.lines)) break;
        // A record-only answer never fills `collector.lines`; without counting the records here the
        // loop would sit out the whole timeout after the burst had already finished.
        if (arrived > 0 && Date.now() - quietSince >= quietMs) break;
        if (Date.now() >= deadline) break;
      }
      const lines = [
        ...collector.lines.filter((line) => answeredBy(line, asked)),
        ...recordsSoFar().map((entry) => entry.ascii).filter(Boolean),
      ];
      return {
        ok: lines.length > 0,
        lines,
        reason: lines.length
          ? `${lines.length} line(s) answered “${text}”`
          : `no line answered “${text}” within ${timeoutMs} ms (the receiver stayed silent)`,
      };
    } finally {
      const index = this.collectors.indexOf(collector);
      if (index >= 0) this.collectors.splice(index, 1);
    }
  }

  /** Text the receiver emitted that is not a command response, newest last. */
  inboundLines(): string[] {
    return this.inbound.map((line) => line.text);
  }

  private pushCommand(entry: LiveStatus['commands'][number]): void {
    this.commands.push(entry);
    if (this.commands.length > COMMAND_LOG) this.commands.splice(0, this.commands.length - COMMAND_LOG);
  }

  /** One text record from the receiver: a command response, or data. */
  private onText(prefix: string, text: string): void {
    /* `[USB2]` and friends are the deframer's port-text prefix, not a log record and not an answer
     * to anything: the desk OEM729 emits them continuously, and counting them would both fill a
     * read-back with noise and keep it from ever going quiet. */
    if (prefix === '[text]') return;
    const line = text.replace(/[\r\n]+$/, '');
    if (!line.trim()) return;
    if (REPLY_PATTERN.test(line.trim())) {
      this.settleNext(line.trim());
      return;
    }
    this.inbound.push({ at: Date.now(), text: line });
    if (this.inbound.length > INBOUND_LINES) this.inbound.splice(0, this.inbound.length - INBOUND_LINES);
    for (const collector of this.collectors) collector.lines.push(line);
  }

  /**
   * Match a reply to the oldest outstanding command — the order the receiver answers in. With
   * nothing outstanding the reply is *counted*, never used to turn a command into a success.
   */
  private settleNext(line: string): void {
    const waiter = this.outstanding.shift();
    if (!waiter) {
      this.unsolicitedReplies += 1;
      return;
    }
    this.settleWaiter(waiter, line, /^<OK/i.test(line) ? 'ok' : 'err');
  }

  private settleWaiter(waiter: PendingCommand, reply: string | null, status: LiveCommandStatus): void {
    const index = this.outstanding.indexOf(waiter);
    if (index >= 0) this.outstanding.splice(index, 1);
    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    const elapsedMs = Date.now() - waiter.sentAt;
    // A placeholder's `ok` is "the write went out"; an awaited command's `ok` is the receiver's
    // `<OK` and nothing else.
    const ok = waiter.placeholder ? waiter.entry.ok : status === 'ok';
    Object.assign(waiter.entry, { reply, status, elapsedMs });
    if (!waiter.placeholder) waiter.entry.ok = ok;
    if (!ok && status === 'timeout') {
      this.lastError = `no reply to “${waiter.line}” within ${waiter.timeoutMs} ms`;
    }
    waiter.resolve({ id: waiter.id, at: waiter.entry.at, line: waiter.line, ok, status, reply, elapsedMs });
  }

  /** Give a Terminal line its place in the reply queue (see `send`). */
  private armPlaceholder(entry: LiveStatus['commands'][number]): void {
    const placeholder: PendingCommand = {
      id: Number(entry.id ?? 0),
      line: entry.line,
      entry,
      sentAt: Date.now(),
      timeoutMs: COMMAND_TIMEOUT_MS,
      placeholder: true,
      resolve: () => {},
      timer: undefined,
    };
    placeholder.timer = setTimeout(() => this.settleWaiter(placeholder, null, 'timeout'), COMMAND_TIMEOUT_MS);
    (placeholder.timer as unknown as { unref?: () => void }).unref?.();
    this.outstanding.push(placeholder);
  }

  /** End every outstanding command (the session closed under it). */
  private failPending(status: LiveCommandStatus): void {
    const outstanding = this.outstanding;
    this.outstanding = [];
    for (const waiter of outstanding) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      const elapsedMs = Date.now() - waiter.sentAt;
      const ok = waiter.placeholder ? waiter.entry.ok : false;
      Object.assign(waiter.entry, { reply: null, status, elapsedMs });
      if (!waiter.placeholder) waiter.entry.ok = false;
      waiter.resolve({ id: waiter.id, at: waiter.entry.at, line: waiter.line, ok, status, reply: null, elapsedMs });
    }
  }

  private record(log: DecodedLog): void {
    this.records += 1;
    this.lastRecordAt = new Date();
    if (!log.crcOk) this.crcFailures += 1;
    this.seq += 1;
    this.buffer.push({
      seq: this.seq,
      messageId: log.messageId,
      name: log.name,
      ascii: this.renderAscii(log),
      data: TELEMETRY_IDS.has(log.messageId) ? this.telemetry(log) : null,
      week: log.header.week,
      milliseconds: log.header.milliseconds,
      time: log.time.toISOString(),
      crcOk: log.crcOk,
    });
    if (this.buffer.length > BUFFER) this.buffer.splice(0, this.buffer.length - BUFFER);
  }

  private loadTables(): EdieTables | null {
    if (this.tables) return this.tables;
    if (this.tablesFailed) return null;
    try {
      this.tables = JSON.parse(readFileSync(join(this.dataDir, 'edie-layouts.json'), 'utf8')) as EdieTables;
      return this.tables;
    } catch {
      this.tablesFailed = true;
      return null;
    }
  }

  /** Same line Convert writes, from the decoded record the session already produced. */
  private renderAscii(log: DecodedLog): string {
    const tables = this.loadTables();
    if (!tables) return '';
    const layout = tables.messages[String(log.messageId)];
    if (!layout) return '';
    try {
      return encodeAsciiLog(
        { kind: 'sbf', header: log.header, bytes: log.payload, payload: log.payload, crcField: 0, crcOk: log.crcOk },
        layout,
        tables,
        { requireValidCrc: false },
      );
    } catch {
      return '';
    }
  }

  /** Path → value map, exactly the vocabulary `/api/records` returns for a capture. */
  private fieldsOf(log: DecodedLog): Map<string, EdieValue> | null {
    const tables = this.loadTables();
    if (!tables) return null;
    const layout = tables.messages[String(log.messageId)];
    if (!layout) return null;
    try {
      const values = new Map<string, EdieValue>();
      for (const value of decodeEdie(log.payload, layout, tables)) values.set(value.path, value);
      return values;
    } catch {
      return null;
    }
  }

  private telemetry(log: DecodedLog): LiveData | null {
    const fields = this.fieldsOf(log);
    if (!fields) return null;
    const number = (path: string): number | null => {
      const value = fields.get(path);
      if (!value) return null;
      const parsed = Number(value.value);
      return Number.isFinite(parsed) ? parsed : null;
    };
    const text = (path: string): string => {
      const value = fields.get(path);
      if (!value) return '';
      if (value.text !== undefined && value.text !== '') return value.text;
      return typeof value.value === 'string' ? value.value : String(value.value);
    };
    const count = (path: string, limit: number): number => {
      const declared = number(path);
      if (declared === null) return 0;
      return Math.max(0, Math.min(Math.trunc(declared), limit));
    };

    switch (log.messageId) {
      case 42:
        return {
          kind: 'bestpos',
          solutionStatus: text('solution_status'),
          positionType: text('position_type'),
          latitude: number('latitude'),
          longitude: number('longitude'),
          height: number('orthometric_height'),
          undulation: number('undulation'),
          datumId: text('datum_id'),
          latitudeDeviation: number('latitude_std_dev'),
          longitudeDeviation: number('longitude_std_dev'),
          heightDeviation: number('height_std_dev'),
          satellitesTracked: number('num_svs'),
          satellitesUsed: number('num_soln_svs'),
        };

      case 963: {
        const sensors: LiveSensor[] = [];
        const total = count('measurements.count', 64);
        for (let index = 0; index < total; index += 1) {
          const status = number(`measurements[${index}].status`);
          const value = number(`measurements[${index}].value`);
          if (status === null || value === null) continue;
          sensors.push({ type: (status >> 8) & 0xff, value, limit: status & 0xff });
        }
        const idle = Number((log.fields as Record<string, unknown>).idleTime);
        return { kind: 'hwmonitor', sensors, idleTime: Number.isFinite(idle) ? idle : null };
      }

      case 43: {
        const observations: LiveObservation[] = [];
        const total = count('obs.count', OBSERVATION_LIMIT);
        for (let index = 0; index < total; index += 1) {
          const prn = number(`obs[${index}].sv_prn`);
          const status = number(`obs[${index}].c_status`);
          if (prn === null || status === null) continue;
          observations.push({ prn, system: (status >>> 16) & 7, cno: number(`obs[${index}].C_No`) });
        }
        return { kind: 'range', observations };
      }

      case 1043: {
        const satellites: LiveSatvis['satellites'] = [];
        const total = count('sat_vis_list.count', SATELLITE_LIMIT);
        for (let index = 0; index < total; index += 1) {
          const id = number(`sat_vis_list[${index}].id`);
          const elevation = number(`sat_vis_list[${index}].elevation`);
          const azimuth = number(`sat_vis_list[${index}].azimuth`);
          if (id === null || elevation === null || azimuth === null) continue;
          satellites.push({ id, elevation, azimuth, health: number(`sat_vis_list[${index}].sat_health`) ?? 0 });
        }
        return { kind: 'satvis', system: text('system_type'), satellites };
      }

      case 1968:
      case 2063: {
        /* Both logs share the layout: status word, frequency start (MHz), resolution bandwidth
         * (Hz), sample count, then that many little-endian u16 samples at H+16. The ASCII twin of
         * this decoding is in the golden file, e.g.
         * `04020920,1531.299,97656.250,1024,22587,22865,…` → status 0x04020920, 1531.2988 MHz,
         * 97.656 kHz RBW, 1024 samples, the first one 22587/256−200 = −111.7695 dBm. */
        const word = number('status_word') ?? 0;
        const declared = count('samples.count', SAMPLE_LIMIT);
        const samples: number[] = [];
        for (let index = 0; index < declared; index += 1) {
          const raw = number(`samples[${index}].samples`);
          if (raw === null) continue;
          samples.push(raw / 256 - 200);
        }
        return {
          kind: 'itpsd',
          log: log.messageId === 1968 ? 'final' : 'detect',
          sequence: log.header.kind === 'long' ? log.header.sequence : 0,
          status: {
            word,
            frequency: word & 0xf,
            dataSource: (word >>> 4) & 0xf,
            fftSize: (word >>> 8) & 0x7,
            integrationWindow: (word >>> 11) & 0x1f,
            timeAverage: (word >>> 16) & 0xf,
          },
          frequencyStart: number('frequency_start_m_hz') ?? 0,
          stepSize: number('step_size_hz') ?? 0,
          samples,
        };
      }

      case 2065: {
        const entries: LiveInterferenceEntry[] = [];
        const total = count('interference_statuses.count', 64);
        for (let index = 0; index < total; index += 1) {
          const base = `interference_statuses[${index}]`;
          const severity: number[] = [];
          for (const key of ['severity1', 'severity2']) {
            const value = number(`${base}.${key}`);
            if (value !== null) severity.push(value);
          }
          entries.push({
            rfPath: text(`${base}.frequency`),
            detectionType: text(`${base}.int_detect_method`),
            centerFrequency: number(`${base}.parameter1`),
            bandwidth: number(`${base}.parameter2`),
            power: number(`${base}.parameter3`),
            estimatedPower: number(`${base}.parameter4`),
            severity,
          });
        }
        return { kind: 'itdetect', entries };
      }

      case 37: {
        const total = count('versions.count', 16);
        let model = '';
        let hardwareVersion = '';
        let softwareVersion = '';
        let fallback: { model: string; hardwareVersion: string; softwareVersion: string } | null = null;
        for (let index = 0; index < total; index += 1) {
          const base = `versions[${index}]`;
          const candidate = {
            model: text(`${base}.model_name`),
            hardwareVersion: text(`${base}.hardware_version`),
            softwareVersion: text(`${base}.software_version`),
          };
          if (!fallback && candidate.model) fallback = candidate;
          const component = text(`${base}.component_type`);
          if (!model && (component === 'GPSCARD' || component === 'GPSCARD2') && (candidate.model || candidate.hardwareVersion)) {
            model = candidate.model;
            hardwareVersion = candidate.hardwareVersion;
            softwareVersion = candidate.softwareVersion;
          }
        }
        if (!model && fallback) {
          model = fallback.model;
          hardwareVersion = fallback.hardwareVersion;
          softwareVersion = fallback.softwareVersion;
        }
        return { kind: 'version', model, hardwareVersion, softwareVersion };
      }

      default:
        return null;
    }
  }
}

function describe(target: LiveTarget): string {
  if (target.kind === 'serial') return `${target.path ?? '?'} @ ${target.baud ?? 115200}`;
  return `${target.kind}://${target.host ?? '127.0.0.1'}:${target.port ?? 3001}`;
}
