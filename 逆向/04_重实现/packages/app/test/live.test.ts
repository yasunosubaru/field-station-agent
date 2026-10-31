/**
 * The live link (A1's foundation): open a session, decode what arrives, send commands.
 *
 * The receiver is not on this machine, so the test drives `LiveLink` from a **TCP loopback** that
 * replays real capture bytes (`samples/live-20261031/b1-20261101.sbf`) — the same path a TCP
 * connection to a receiver uses. Serial is exercised through the injected opener, which is how
 * `packages/session` is tested too (`npm i serialport` is optional).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LiveLink } from '../src/live.ts';
import type { SerialOpener } from '../../session/src/transport.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'protocol', 'data');
const capture = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031', 'b1-20261101.sbf');

/** A TCP server that replays the capture once a client connects, and records what it receives. */
function replayServer(): Promise<{ server: Server; port: number; received: () => string }> {
  const bytes = readFileSync(capture);
  let buffer = '';
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      socket.on('error', () => {
        // The client closing mid-replay is expected when a test ends.
      });
      socket.on('data', (chunk) => {
        buffer += chunk.toString('latin1');
      });
      // Push in 16 KB chunks so the session sees a realistic stream, not one giant packet.
      let at = 0;
      const pump = (): void => {
        if (at >= bytes.length) return;
        socket.write(bytes.subarray(at, at + 16384));
        at += 16384;
        setTimeout(pump, 2);
      };
      pump();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port, received: () => buffer });
    });
  });
}

test('a live session decodes a replayed capture and renders Convert-style lines', async () => {
  const { server, port } = await replayServer();
  const link = new LiveLink(dataDir);
  try {
    const status = await link.connect({ kind: 'tcp', host: '127.0.0.1', port });
    assert.equal(status.connected, true);
    assert.equal(status.target, `tcp://127.0.0.1:${port}`);

    // Wait for the replay to finish decoding.
    const deadline = Date.now() + 8000;
    while (link.status().records < 100 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));

    const live = link.status();
    assert.ok(live.records > 100, `decoded ${live.records} records`);
    const { entries, cursor } = link.logs(0);
    assert.equal(cursor, live.records);
    const bestpos = entries.find((entry) => entry.messageId === 42);
    assert.ok(bestpos, 'the stream contains BESTPOS');
    assert.match(bestpos!.ascii, /^#BESTPOSA,/, 'rendered like Convert');
    assert.match(bestpos!.ascii, /SOL_COMPUTED,SINGLE/, 'with the normal body');
    assert.ok(entries.every((entry) => entry.seq > 0), 'every entry has a cursor');
    // Cursor semantics: asking for `after=<cursor>` returns nothing new.
    assert.deepEqual(link.logs(cursor).entries, []);
  } finally {
    await link.disconnect();
    server.close();
  }
});

test('a command typed in the Terminal reaches the socket as ASCII + CRLF', async () => {
  const { server, port, received } = await replayServer();
  const link = new LiveLink(dataDir);
  try {
    await link.connect({ kind: 'tcp', host: '127.0.0.1', port });
    const status = link.send('LOG COM1 BESTPOSB ONTIME 1');
    assert.equal(status.commands.at(-1)?.line, 'LOG COM1 BESTPOSB ONTIME 1');
    assert.equal(status.commands.at(-1)?.ok, true);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(received().includes('LOG COM1 BESTPOSB ONTIME 1\r\n'), received().slice(-80));
  } finally {
    await link.disconnect();
    server.close();
  }
});

test('sending without a session reports the error instead of throwing', () => {
  const link = new LiveLink(dataDir);
  const status = link.send('LOG COM1 BESTPOSB ONTIME 1');
  assert.equal(status.connected, false);
  assert.equal(status.lastError, 'not connected');
  assert.equal(status.commands.at(-1)?.ok, false);
});

test('a serial target uses the injected opener and feeds bytes the same way', async () => {
  const bytes = readFileSync(capture);
  const written: string[] = [];
  let emit: ((chunk: Uint8Array) => void) | undefined;
  const opener: SerialOpener = async () => {
    const listeners = new Map<string, (arg: never) => void>();
    const port = {
      on(event: string, listener: (arg: never) => void) {
        listeners.set(event, listener);
        return port;
      },
      write(data: string | Uint8Array, callback?: (error?: Error | null) => void) {
        written.push(typeof data === 'string' ? data : Buffer.from(data).toString('latin1'));
        callback?.(null);
        return true;
      },
      close() {},
      drain() {},
      flush() {},
      set() {},
    };
    emit = (chunk: Uint8Array) => listeners.get('data')?.(chunk as never);
    return port as never;
  };
  const link = new LiveLink(dataDir);
  try {
    const status = await link.connect({ kind: 'serial', path: 'COM9', baud: 115200 }, opener);
    assert.equal(status.connected, true);
    assert.equal(status.target, 'COM9 @ 115200');
    assert.ok(emit, 'the opener was used');
    // Feed one frame's worth of bytes and check it decodes.
    for (let at = 0; at < Math.min(bytes.length, 400_000); at += 16384) {
      emit!(new Uint8Array(bytes.subarray(at, at + 16384)));
    }
    assert.ok(link.status().records > 0, 'records arrive through the serial path');
    link.send('LOG COM1 TIMEB ONTIME 1');
    assert.ok(written.some((line) => line.includes('LOG COM1 TIMEB ONTIME 1')));
  } finally {
    await link.disconnect();
  }
});

test('an unreachable target fails with a message, and leaves the link disconnected', async () => {
  const link = new LiveLink(dataDir);
  await assert.rejects(
    () => link.connect({ kind: 'tcp', host: '127.0.0.1', port: 1 }),
    /ECONNREFUSED|connect/i,
  );
  assert.equal(link.status().connected, false);
  assert.ok(link.status().lastError);
});
