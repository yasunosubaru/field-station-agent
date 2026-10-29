/**
 * Transport abstraction + TCP/UDP drivers.
 *
 * Mirrors the connection handling in `01_解包/app/controller/communication.js:31-157`:
 *  - TCP: `new net.Socket({ allowHalfOpen: true })`
 *  - UDP: `dgram.createSocket('udp4')`, connected to the target address
 *
 * Serial is deliberately an injected factory: the original links `serialport` (a native module) and
 * the reimplementation must not take that dependency in the protocol core.
 */

import net from 'node:net';
import dgram from 'node:dgram';

export interface Transport {
  write(bytes: Uint8Array): void;
  close(): void;
  readonly isOpen: boolean;
}

export interface TransportHandlers {
  onData: (bytes: Uint8Array) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

export interface TcpOptions {
  host: string;
  port: number;
  allowHalfOpen?: boolean;
  connectTimeoutMs?: number;
}

export async function connectTcp(options: TcpOptions, handlers: TransportHandlers): Promise<Transport> {
  const socket = new net.Socket({ allowHalfOpen: options.allowHalfOpen ?? true });
  let open = false;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP connect timeout after ${options.connectTimeoutMs ?? 10000} ms`));
    }, options.connectTimeoutMs ?? 10000);
    socket.once('connect', () => {
      clearTimeout(timer);
      open = true;
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.connect(options.port, options.host);
  });

  socket.on('data', (chunk: Buffer) => handlers.onData(new Uint8Array(chunk)));
  socket.on('error', (error) => handlers.onError?.(error));
  socket.on('close', () => {
    open = false;
    handlers.onClose?.();
  });

  return {
    get isOpen() {
      return open && !socket.destroyed;
    },
    write(bytes: Uint8Array) {
      if (!socket.destroyed) socket.write(Buffer.from(bytes));
    },
    close() {
      open = false;
      socket.destroy();
    },
  };
}

export interface UdpOptions {
  host: string;
  port: number;
  /** Bind to this local port instead of an ephemeral one. */
  localPort?: number;
}

export async function connectUdp(options: UdpOptions, handlers: TransportHandlers): Promise<Transport> {
  const socket = dgram.createSocket('udp4');
  let open = false;
  socket.on('message', (message: Buffer) => handlers.onData(new Uint8Array(message)));
  socket.on('error', (error) => handlers.onError?.(error));

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.once('error', onError);
    const afterBind = () => {
      socket.off('error', onError);
      try {
        socket.connect(options.port, options.host);
        open = true;
        resolve();
      } catch (error) {
        reject(error as Error);
      }
    };
    if (options.localPort !== undefined) socket.bind(options.localPort, afterBind);
    else socket.bind(afterBind);
  });

  return {
    get isOpen() {
      return open;
    },
    write(bytes: Uint8Array) {
      if (!open) return;
      socket.send(bytes, (error) => {
        if (error) handlers.onError?.(error);
      });
    },
    close() {
      open = false;
      socket.close();
    },
  };
}

/** The subset of a `serialport`-style object the session needs. */
export interface SerialPortLike {
  readonly isOpen: boolean;
  write(bytes: Uint8Array, cb?: (error?: Error | null) => void): void;
  close(cb?: (error?: Error | null) => void): void;
  update(options: { baudRate: number }, cb: (error?: Error | null) => void): void;
  on(event: 'data', cb: (chunk: Uint8Array) => void): void;
  on(event: 'open' | 'close' | 'error', cb: (arg?: unknown) => void): void;
}

export type SerialOpener = (
  path: string,
  options: { baudRate: number; rtscts?: boolean },
) => Promise<SerialPortLike>;

export interface SerialOptions {
  path: string;
  baudRate: number;
  hardwareHandshake?: boolean;
  /** The application opens serial links 500 ms late (`communication.js:163`). */
  openDelayMs?: number;
}

export async function connectSerial(
  opener: SerialOpener,
  options: SerialOptions,
  handlers: TransportHandlers,
): Promise<Transport & { port: SerialPortLike }> {
  await new Promise((resolve) => setTimeout(resolve, options.openDelayMs ?? 500));
  const port = await opener(options.path, {
    baudRate: options.baudRate,
    rtscts: options.hardwareHandshake,
  });
  port.on('data', (chunk) => handlers.onData(new Uint8Array(chunk)));
  port.on('error', (error) => handlers.onError?.(error as Error));
  port.on('close', () => handlers.onClose?.());
  return {
    port,
    get isOpen() {
      return port.isOpen;
    },
    write(bytes: Uint8Array) {
      port.write(bytes);
    },
    close() {
      port.close();
    },
  };
}

/**
 * The factory byte sequence used to wake a receiver stuck at its factory default baud rate
 * (`communication.js:573-582`). Repeated for 250 ms, twice, with a 1501 ms gap.
 */
export const BREAK_SEQUENCE: Uint8Array = Uint8Array.from([0x55, 0x01, 0x01, 0x00, 0x40, 0x00, 0x05, 0x9b]);

export interface BreakTiming {
  burstMs: number;
  gapMs: number;
  settleMs: number;
}

export const DEFAULT_BREAK_TIMING: BreakTiming = { burstMs: 250, gapMs: 1501, settleMs: 300 };

/** Send the break sequence exactly as the original does (two bursts, then settle). */
export async function sendBreak(
  transport: Transport,
  timing: BreakTiming = DEFAULT_BREAK_TIMING,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const burst = async () => {
    const deadline = Date.now() + timing.burstMs;
    while (Date.now() < deadline) transport.write(BREAK_SEQUENCE);
    // The original uses setInterval(fn, 0) for burstMs, i.e. as fast as the event loop allows.
  };
  await burst();
  await sleep(timing.gapMs);
  await burst();
  await sleep(timing.settleMs);
}
