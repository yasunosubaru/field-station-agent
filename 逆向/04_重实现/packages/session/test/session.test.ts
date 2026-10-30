import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { connectTcp } from '../src/transport.ts';
import { ReceiverSession, loadCatalog, DOCUMENTED_HEARTBEAT, MIRROR_HEARTBEAT, type Catalog, type DecodedLog } from '../src/session.ts';
import { buildLongHeader } from '../../protocol/src/header.ts';
import { appendCrcLe } from '../../protocol/src/crc.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'protocol', 'data');

function makeFrame(messageId: number, payload: Uint8Array, messageType = 0): Uint8Array {
  const header = buildLongHeader({
    messageId,
    payloadLength: payload.length,
    messageType,
    week: 2440,
    milliseconds: 123456789,
  });
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return appendCrcLe(out);
}

function testCatalog(): Catalog {
  return loadCatalog(dataDir);
}

interface Harness {
  server: net.Server;
  port: number;
  session: ReceiverSession;
  received: Buffer[];
  socket: () => net.Socket;
  close: () => Promise<void>;
}

async function startHarness(overrides: Partial<Parameters<typeof ReceiverSession.prototype.constructor>[1]> = {}): Promise<Harness> {
  let socketRef: net.Socket | undefined;
  const server = net.createServer((socket) => {
    socketRef = socket;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  const received: Buffer[] = [];
  const transport = await connectTcp(
    { host: '127.0.0.1', port },
    {
      onData: (bytes) => session.feed(bytes),
    },
  );
  // capture what the session writes
  const originalWrite = transport.write.bind(transport);
  transport.write = (bytes: Uint8Array) => {
    received.push(Buffer.from(bytes));
    originalWrite(bytes);
  };
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (socketRef) {
    socketRef.on('data', (chunk: Buffer) => {
      // echo nothing; the server only records
      void chunk;
    });
  }

  const session = new ReceiverSession(transport, {
    catalog: testCatalog(),
    heartbeat: { enabled: false },
    ...overrides,
  });

  return {
    server,
    port,
    session,
    received,
    socket: () => {
      if (!socketRef) throw new Error('client not connected');
      return socketRef;
    },
    close: async () => {
      session.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('session requests VERSIONB as a raw abbreviated-ASCII line on start', async () => {
  const h = await startHarness();
  h.session.start();
  await new Promise((r) => setTimeout(r, 30));
  const sent = Buffer.concat(h.received).toString('latin1');
  assert.equal(sent, 'log thisport_30 versionb once\n');
  await h.close();
});

test('a VERSION log flips the session to ready and exposes its component blocks', async () => {
  const h = await startHarness();
  const logs: DecodedLog[] = [];
  const ready: string[] = [];
  h.session.on('log', (log) => logs.push(log));
  h.session.on('ready', (generation) => ready.push(generation));
  h.session.start();

  // Real VERSION layout: u32 component count, then 108-byte component blocks.
  const payload = new Uint8Array(4 + 108);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 1, true);
  dv.setUint32(4, 2, true); // component type
  payload.set(Buffer.from('OEM729-1.00'), 4 + 4);
  h.socket().write(Buffer.from(makeFrame(37, payload)));
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(logs.length, 1);
  assert.equal(logs[0].name, 'VERSION');
  assert.equal(logs[0].fields.noOfComponents, 1);
  assert.equal(logs[0].blocks?.length, 1);
  assert.equal(logs[0].blocks?.[0].model, 'OEM729-1.00');
  assert.deepEqual(ready, ['OEM7']);
  assert.equal(h.session.isReady, true);
  await h.close();
});

test('a BESTPOS binary log decodes at its documented offsets', async () => {
  const h = await startHarness();
  const logs: DecodedLog[] = [];
  h.session.on('log', (log) => logs.push(log));
  h.session.start();

  const payload = new Uint8Array(104);
  const dv = new DataView(payload.buffer);
  dv.setFloat64(8, 51.11678928753, true);
  dv.setFloat64(16, -114.03886216575, true);
  dv.setFloat64(24, 1064.347, true);
  dv.setUint8(65, 9);

  h.socket().write(Buffer.from(makeFrame(42, payload)));
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(logs.length, 1);
  assert.equal(logs[0].messageId, 42);
  assert.equal(logs[0].name, 'BESTPOS');
  assert.ok(Math.abs((logs[0].fields.latitude as number) - 51.11678928753) < 1e-9);
  assert.equal(logs[0].fields.satellitesUsed, 9);
  assert.equal(logs[0].time.toISOString(), new Date(Date.UTC(1980, 0, 6) + 2440 * 7 * 86400e3 + 123456789 - 18000).toISOString());
  await h.close();
});

test('TRACKSTAT message-type bit 0 selects the secondary antenna and header sequence is exposed', async () => {
  const h = await startHarness();
  const logs: DecodedLog[] = [];
  h.session.on('log', (log) => logs.push(log));
  h.session.start();

  const payload = new Uint8Array(16 + 40);
  const dv = new DataView(payload.buffer);
  dv.setUint32(12, 1, true);
  dv.setUint16(16, 5, true);
  dv.setUint32(20, 0x04, true);
  h.socket().write(Buffer.from(makeFrame(83, payload, 0x01)));
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(logs.length, 1);
  assert.equal(logs[0].header.kind, 'long');
  assert.equal(logs[0].header.kind === 'long' && logs[0].header.secondaryAntenna, true);
  assert.equal(logs[0].fields.antenna, 'SECONDARY');
  assert.equal(logs[0].fields.sequence, 0);
  await h.close();
});

test('ReceiverSession uses extracted repeat layouts and propagates truncated counts', async () => {
  const h = await startHarness();
  const logs: DecodedLog[] = [];
  h.session.on('log', (log) => logs.push(log));
  h.session.start();

  // GGAQUALITY: declared three 8-byte records, only two are present.
  const payload = new Uint8Array(4 + 2 * 8);
  const dv = new DataView(payload.buffer);
  dv.setUint32(0, 3, true);
  dv.setUint32(4, 17, true); // PSRDIFF
  dv.setUint32(8, 1, true);
  dv.setUint32(12, 50, true); // NARROW_INT
  dv.setUint32(16, 2, true);
  h.socket().write(Buffer.from(makeFrame(691, payload)));
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(logs.length, 1);
  assert.equal(logs[0].name, 'GGAQUALITY');
  assert.equal(logs[0].hasRepeatedBlock, true);
  assert.equal(logs[0].truncated, true);
  assert.equal(logs[0].fields.data && (logs[0].fields.data as unknown[]).length, 2);
  assert.equal(logs[0].blocks?.length, 2);
  assert.equal(logs[0].blocks?.[0].posType, 'PSRDIFF');
  assert.equal(logs[0].blocks?.[1].quality, 2);
  await h.close();
});

test('command responses (message type != 0) are routed separately from logs', async () => {
  const h = await startHarness();
  const responses: number[] = [];
  h.session.on('response', (frame) => responses.push(frame.header.messageId));
  h.session.on('log', () => {
    throw new Error('a response must not be emitted as a log');
  });
  h.session.start();

  // message type 1 = ASCII response? use 0x80 (response bit) over binary
  h.socket().write(Buffer.from(makeFrame(1, new Uint8Array(4), 0x80)));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(responses, [1]);
  await h.close();
});

test('text frames are surfaced verbatim', async () => {
  const h = await startHarness();
  const texts: Array<[string, string]> = [];
  h.session.on('text', (prefix, text) => texts.push([prefix, text]));
  h.session.start();

  h.socket().write(Buffer.from('#VERSIONA,COM1,0,50.0,FINESTEERING,2440,1,0,0,1;OEM729\r\n', 'latin1'));
  h.socket().write(Buffer.from('[COM1] ok\r\n', 'latin1'));
  await new Promise((r) => setTimeout(r, 40));

  assert.equal(texts.length, 2);
  assert.equal(texts[0][0], '#');
  assert.ok(texts[0][1].startsWith('#VERSIONA'));
  assert.deepEqual(texts[1], ['[text]', '[COM1]']);
  await h.close();
});

test('heartbeat counts misses and any inbound data resets the counter', async () => {
  const h = await startHarness({ heartbeat: { intervalMs: 20, maxMisses: 2 } });
  const misses: number[] = [];
  h.session.on('heartbeat-miss', (n) => misses.push(n));
  h.session.start();

  await new Promise((r) => setTimeout(r, 250));
  assert.ok(misses.length >= 1, 'expected at least one heartbeat miss');
  assert.equal(misses[0], 2, 'the first miss fires when the counter reaches maxMisses');

  const before = misses.length;
  h.socket().write(Buffer.from(makeFrame(42, new Uint8Array(104))));
  await new Promise((r) => setTimeout(r, 120));

  const afterReset = misses.slice(before);
  assert.ok(afterReset.length >= 1, 'the heartbeat must fire again after the stream goes quiet');
  assert.equal(afterReset[0], 2, 'the counter restarts at 1, so the next report is 2 again');
  await h.close();
});

test('sendLog writes a binary LOG command with the expected payload', async () => {
  const h = await startHarness();
  h.session.start();
  h.received.length = 0;
  h.session.log('BESTPOS', { trigger: 'ONTIME', periodSeconds: 1 });
  await new Promise((r) => setTimeout(r, 30));

  const sent = Buffer.concat(h.received);
  assert.equal(sent[0], 0xaa);
  assert.equal(sent.readUInt16LE(4), 1); // LOG
  assert.equal(sent.readUInt16LE(8), 32); // payload length
  assert.equal(sent.readUInt32LE(28), 222); // port
  assert.equal(sent.readUInt16LE(32), 42); // BESTPOS id
  assert.equal(sent.readUInt32LE(36), 2); // ONTIME
  assert.equal(sent.readDoubleLE(40), 1); // period
  await h.close();
});

test('unknown message names are rejected rather than silently mistyped', async () => {
  const h = await startHarness();
  h.session.start();
  assert.throws(() => h.session.log('NOT_A_LOG'), /not in the OEM7 catalog/);
  await h.close();
});

/**
 * `pingpong.js:12-27` sends `"Sendhxdt"` with `length: 6`; on a real OEM729 (2026-10-30) the
 * receiver answers `ERROR:Invalid Message. Field = 2` because `SENDHEX` wants a hex payload.
 * The mirror stays the default; the hardware-valid six bytes are one option away.
 */
test('the heartbeat mirrors the shipped payload and offers the hardware-valid hex payload', async () => {
  assert.equal(MIRROR_HEARTBEAT.length, 6);
  assert.equal(Buffer.from(MIRROR_HEARTBEAT).toString('latin1'), 'Sendhx');
  assert.deepEqual([...DOCUMENTED_HEARTBEAT], [0x14, 0x3a, 0xb5, 0x90, 0x0d, 0x0a]);

  const mirror = await startHarness();
  const mark = mirror.received.length;
  mirror.session.sendHeartbeat();
  const mirrored = Buffer.concat(mirror.received.slice(mark));
  assert.ok(mirrored.includes(Buffer.from('Sendhx', 'latin1')), 'mirror payload reaches the wire');
  assert.ok(!mirrored.includes(Buffer.from('Sendhxdt', 'latin1')), 'the shipped length is 6, not 8');

  const documented = await startHarness({ heartbeat: { payload: DOCUMENTED_HEARTBEAT } });
  const start = documented.received.length;
  documented.session.sendHeartbeat();
  const sent = Buffer.concat(documented.received.slice(start));
  assert.ok(sent.includes(Buffer.from(DOCUMENTED_HEARTBEAT)), 'documented payload reaches the wire');

  await mirror.close();
  await documented.close();
});
