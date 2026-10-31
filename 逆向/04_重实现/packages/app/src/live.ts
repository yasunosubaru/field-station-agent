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
  | LiveSatvis;

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
  /** Commands sent from the Terminal page, newest last. */
  commands: Array<{ at: string; line: string; ok: boolean }>;
}

const BUFFER = 400;
const COMMAND_LOG = 50;
const SERIAL_OPEN_DELAY_MS = 200;
/** A RANGE with 84 observations in a capture; 256 leaves room for a bigger constellation set. */
const OBSERVATION_LIMIT = 256;
const SATELLITE_LIMIT = 256;

/** Message ids whose payload `decodeEdie` turns into a `LiveData` projection. */
const TELEMETRY_IDS = new Set([37, 42, 43, 963, 1043, 2065]);

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
      commands: this.commands.slice(-COMMAND_LOG),
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
    if (!this.isOpen()) {
      this.lastError = 'not connected';
      this.commands.push({ at: new Date().toISOString(), line: text, ok: false });
      return this.status();
    }
    try {
      this.session!.sendRaw(`${text}\r`);
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

  private markClosed(): void {
    this.connectedAt = undefined;
    if (!this.disconnectedAt) this.disconnectedAt = new Date();
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
