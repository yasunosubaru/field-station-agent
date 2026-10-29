/**
 * Headless receiver session: transport + de-framing + log dispatch + heartbeat.
 *
 * This is the piece the whole suite hangs off; the Electron UI code never touches a socket.
 * Behaviour mirrored from `01_解包/app/controller/communication.js` and
 * `01_解包/app/jarvisInterface.js` (see 03_分析/00_通信协议与调度核心.md §6).
 *
 * Deliberate differences, all opt-in or observable:
 *  - emits `drop` events for bytes the original discards silently;
 *  - reports CRC mismatches (`crcOk: false`) instead of ignoring them;
 *  - the heartbeat payload is configurable because the original's value is unverified (see doc §9.1).
 */

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SbfDeframer, type Frame, type SbfFrame } from '../../protocol/src/framing.ts';
import { buildAsciiCommand, makePortNamePredicate } from '../../protocol/src/ascii.ts';
import { buildLogCommand, buildUnlogCommand, buildBinaryCommand } from '../../protocol/src/command.ts';
import {
  decodeMessage,
  decodeRepeated,
  type ParserTables,
  type RepeatLayout,
  type RichSpec,
} from '../../protocol/src/decode.ts';
import { gpsToUtcDate } from '../../protocol/src/time.ts';
import { deriveStatusFields } from '../../protocol/src/status-fields.ts';
import { PORT_ADDRESS_THISPORT_30, type SbfHeader } from '../../protocol/src/header.ts';
import type { Transport } from './transport.ts';

export type Generation = 'OEM6' | 'OEM7' | 'OEMSTAR' | 'SMART2' | 'GIII';

export interface MessageInfo {
  Name: string;
  Type?: string;
  Category?: string;
  CorrectionType?: string;
}

export interface Catalog {
  msgids: Record<string, Record<string, MessageInfo> | Record<string, string>>;
  commands: Record<string, { messageId: number; enums: Record<string, Record<string, number>> }>;
  parserTables: ParserTables;
  portNames: string[];
  /** msgId -> self-contained field spec (data/message-specs.json). */
  specByMessage?: Record<string, RichSpec>;
  /** msgId -> repeated-block layout (data/repeat-layouts.json). */
  repeatLayouts?: Record<string, RepeatLayout>;
}

export function loadCatalog(dataDir: string): Catalog {
  const read = (name: string) => JSON.parse(readFileSync(join(dataDir, name), 'utf8'));
  return {
    msgids: read('msgids.json'),
    commands: read('commands.json'),
    parserTables: read('parser-tables.json'),
    portNames: read('portnames.json'),
    specByMessage: safeRead(join(dataDir, 'message-specs.json')),
    repeatLayouts: safeRead(join(dataDir, 'repeat-layouts.json')),
  };
}

function safeRead(path: string): Record<string, RichSpec> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export interface HeartbeatOptions {
  enabled?: boolean;
  intervalMs?: number;
  maxMisses?: number;
  /** SENDHEX payload. The original sends the string `Sendhxdt` (see doc §9.1). */
  payload?: Uint8Array;
}

export interface SessionOptions {
  catalog: Catalog;
  generation?: Generation;
  portAddress?: number;
  heartbeat?: HeartbeatOptions;
  /** Ask for `VERSIONB` right after the transport opens. */
  requestVersionOnOpen?: boolean;
  /** Called on each VERSION log to decide the receiver generation. */
  resolveGeneration?: (model: string) => Generation | undefined;
}

export interface DecodedLog {
  messageId: number;
  name: string;
  header: SbfHeader;
  payload: Uint8Array;
  fields: Record<string, unknown>;
  /** True when the message has a repeated block (whether or not a layout is known). */
  hasRepeatedBlock: boolean;
  /** Decoded blocks for any message with an entry in repeat-layouts.json. */
  blocks?: Array<Record<string, unknown>>;
  /** Blocks declared by the payload but not present in it. */
  truncated?: boolean;
  time: Date;
  crcOk: boolean;
}

export interface SessionEvents {
  open: () => void;
  close: () => void;
  log: (log: DecodedLog) => void;
  response: (frame: SbfFrame) => void;
  text: (prefix: string, text: string) => void;
  drop: (byteCount: number, reason: string) => void;
  ready: (generation: Generation) => void;
  'heartbeat-miss': (misses: number) => void;
  error: (error: Error) => void;
}

const DEFAULT_HEARTBEAT: Required<Pick<HeartbeatOptions, 'intervalMs' | 'maxMisses'>> = {
  intervalMs: 5000,
  maxMisses: 2,
};

export class ReceiverSession extends EventEmitter {
  private readonly deframer: SbfDeframer;
  private readonly transport: Transport;
  private readonly options: SessionOptions;
  private misses = 0;
  private heartbeatTimer?: NodeJS.Timeout;
  private closed = false;
  private ready = false;

  constructor(transport: Transport, options: SessionOptions) {
    super();
    this.transport = transport;
    this.options = options;
    this.deframer = new SbfDeframer({
      onDrop: (n, reason) => this.emit('drop', n, reason),
    });
  }

  get generation(): Generation | undefined {
    return this.options.generation;
  }

  get isReady(): boolean {
    return this.ready;
  }

  start(): void {
    this.closed = false;
    this.emit('open');
    if (this.options.requestVersionOnOpen !== false) {
      // `jarvisInterface.js:2895` — sent as a raw abbreviated-ASCII line, not through the
      // CRC-framed ASCII builder: `controller.requestlog(tab, 'log thisport_30 versionb once\n')`.
      this.sendRaw('log thisport_30 versionb once');
    }
    this.startHeartbeat();
  }

  /** Write an abbreviated-ASCII command exactly as typed (no CRC framing). */
  sendRaw(line: string): void {
    const text = line.endsWith('\n') ? line : line + '\n';
    this.transport.write(latin1(text));
  }

  stop(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.transport.close();
    this.emit('close');
  }

  /** Feed bytes as they arrive from the transport. */
  feed(bytes: Uint8Array): void {
    this.misses = 0;
    for (const frame of this.deframer.push(bytes)) this.dispatch(frame);
  }

  sendAscii(line: string): void {
    const command = buildAsciiCommand(line, makePortNamePredicate(this.options.catalog.portNames));
    this.transport.write(latin1(command));
  }

  sendBytes(bytes: Uint8Array): void {
    this.transport.write(bytes);
  }

  log(
    message: string | number,
    options: { ascii?: boolean; trigger?: string; periodSeconds?: number } = {},
  ): void {
    const messageId = typeof message === 'number' ? message : this.resolveMessageId(message);
    const enums = this.options.catalog.commands.log.enums;
    const bytes = buildLogCommand({
      portAddress: this.options.portAddress ?? PORT_ADDRESS_THISPORT_30,
      messageId,
      ascii: options.ascii ?? false,
      trigger: options.trigger ?? 'ONTIME',
      periodSeconds: options.periodSeconds ?? 1,
      triggerValues: enums.trigger,
      holdValues: enums.hold,
    });
    this.transport.write(bytes);
  }

  unlog(message: string | number, ascii = false): void {
    const messageId = typeof message === 'number' ? message : this.resolveMessageId(message);
    this.transport.write(
      buildUnlogCommand({
        portAddress: this.options.portAddress ?? PORT_ADDRESS_THISPORT_30,
        messageId,
        ascii,
      }),
    );
  }

  /** Raw value of the application's heartbeat command (SENDHEX). */
  sendHeartbeat(): void {
    const payload = this.options.heartbeat?.payload ?? latin1('Sendhxdt');
    this.transport.write(
      buildBinaryCommand({
        messageId: this.options.catalog.commands.sendhex.messageId,
        params: [
          { type: 'enum', value: this.options.portAddress ?? PORT_ADDRESS_THISPORT_30, length: 4 },
          { type: 'ulong', value: payload.length, length: 4 },
          { type: 'string', value: text(payload), length: payload.length },
        ],
      }),
    );
  }

  resolveMessageId(name: string): number {
    const catalog = this.options.catalog.msgids;
    const generation = this.options.generation ?? 'OEM7';
    const key = (catalog.aliases as Record<string, string> | undefined)?.[generation] ?? generation;
    const table = catalog[key] as Record<string, MessageInfo> | undefined;
    const wanted = name.toUpperCase();
    if (table) {
      for (const [id, info] of Object.entries(table)) {
        if (typeof info === 'object' && info && info.Name?.toUpperCase() === wanted) return Number(id);
      }
    }
    throw new Error(`message not in the ${generation} catalog: ${name}`);
  }

  private dispatch(frame: Frame): void {
    if (frame.kind === 'text') {
      this.emit('text', frame.prefix, frame.text);
      return;
    }
    const header = frame.header;
    if (header.kind === 'long' && header.messageTypeByte !== 0) {
      this.emit('response', frame);
      // logparsers.js handles message type 1 as the secondary-antenna copy of
      // TRACKSTAT/ITDETECTSTATUS after commandResponseHandler sees it. Other
      // response types do not continue through the log path.
      if (header.messageTypeByte !== 1) return;
    }
    const decoded = this.decode(frame);
    if (decoded.name === 'VERSION' && !this.ready) {
      const model = String(decoded.fields.model ?? decoded.blocks?.[0]?.model ?? '');
      const generation = this.options.resolveGeneration?.(model) ?? guessGeneration(model);
      if (generation) {
        this.options.generation = generation;
        this.ready = true;
        this.emit('ready', generation);
      }
    }
    this.emit('log', decoded);
  }

  private decode(frame: SbfFrame): DecodedLog {
    const messageId = frame.header.messageId;
    const entry = this.options.catalog.specByMessage?.[String(messageId)];
    const layout = this.options.catalog.repeatLayouts?.[String(messageId)];
    const name = entry?.name ?? this.messageName(messageId);

    if (entry && layout) {
      const repeated = decodeRepeated(frame.payload, entry, layout);
      const derived = deriveStatusFields(
        messageId,
        frame.payload,
        repeated.header,
        repeated.blocks,
        this.options.generation,
        frame.header.idleTimeRaw,
        frame.header.secondaryAntenna,
      );
      return {
        messageId,
        name,
        header: frame.header,
        payload: frame.payload,
        fields: { ...derived.fields, sequence: frame.header.sequence },
        hasRepeatedBlock: true,
        blocks: derived.blocks,
        truncated: repeated.truncated,
        time: gpsToUtcDate(frame.header.week, frame.header.milliseconds),
        crcOk: frame.crcOk,
      };
    }

    const fields = entry ? decodeMessage(frame.payload, entry) : {};
    const derived = deriveStatusFields(
      messageId,
      frame.payload,
      fields,
      undefined,
      this.options.generation,
      frame.header.idleTimeRaw,
      frame.header.secondaryAntenna,
    );
    return {
      messageId,
      name,
      header: frame.header,
      payload: frame.payload,
      fields: { ...derived.fields, sequence: frame.header.sequence },
      hasRepeatedBlock: entry?.repeat === true,
      time: gpsToUtcDate(frame.header.week, frame.header.milliseconds),
      crcOk: frame.crcOk,
    };
  }

  private messageName(messageId: number): string {
    const catalog = this.options.catalog.msgids;
    const generation = this.options.generation ?? 'OEM7';
    const key = (catalog.aliases as Record<string, string> | undefined)?.[generation] ?? generation;
    const table = catalog[key] as Record<string, MessageInfo> | undefined;
    return table?.[String(messageId)]?.Name ?? '';
  }

  private startHeartbeat(): void {
    const settings = { ...DEFAULT_HEARTBEAT, ...this.options.heartbeat };
    if (this.options.heartbeat?.enabled === false) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      this.sendHeartbeat();
      this.misses += 1;
      if (this.misses >= settings.maxMisses) {
        this.emit('heartbeat-miss', this.misses);
      }
    }, settings.intervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}

/** Rough model → generation mapping; the real decision table lives in `featuresList.js`. */
export function guessGeneration(model: string): Generation | undefined {
  const upper = model.toUpperCase();
  if (upper.startsWith('OEM7') || upper.startsWith('PWRPAK7') || upper.startsWith('SPAN')) return 'OEM7';
  if (upper.startsWith('OEM6') || upper.startsWith('PP6') || upper.startsWith('SPAN6')) return 'OEM6';
  if (upper.startsWith('OEMSTAR') || upper.startsWith('SMART6')) return 'OEMSTAR';
  if (upper.startsWith('SMART7')) return 'SMART2';
  if (upper.includes('G-III') || upper.includes('GIII')) return 'GIII';
  return undefined;
}

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function text(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
