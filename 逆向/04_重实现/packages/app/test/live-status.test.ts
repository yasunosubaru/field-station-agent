/**
 * The telemetry projections the Manage Status dashboard reads from a live session.
 *
 * A receiver is not on this machine, so the stream is the real capture
 * `samples/live-20261031/b1-20261101.sbf` replayed over TCP — the same bytes a connected OEM729
 * emitted, and the same path `live.test.ts` uses. The interesting part is not "a record arrived"
 * but that `LiveLink` decodes `BESTPOS` / `HWMONITOR` / `RANGE` / `SATVIS2` / `VERSION` /
 * `ITDETECTSTATUS` into the field vocabulary the capture path already speaks, because the panel
 * treats both sources through the same readers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LiveLink, type LiveData, type LiveEntry } from '../src/live.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'protocol', 'data');
const capture = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031', 'b1-20261101.sbf');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replays the capture in 16 KB chunks; `close` ends the socket once the file is through. */
function replayServer(options: { close: boolean }): Promise<{ server: Server; port: number }> {
  const bytes = readFileSync(capture);
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      socket.on('error', () => {
        /* the client may finish first */
      });
      let at = 0;
      const pump = (): void => {
        if (at >= bytes.length) {
          if (options.close) socket.end();
          return;
        }
        socket.write(bytes.subarray(at, at + 16384));
        at += 16384;
        setTimeout(pump, 1);
      };
      pump();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

/**
 * Follows the cursor exactly like the panel does, keeping the newest projection per message id —
 * the ring buffer is 400 entries and `VERSION` arrives early, so a single `logs(0)` at the end
 * would miss it.
 */
async function collect(
  link: LiveLink,
  until: (latest: Map<number, LiveEntry>) => boolean,
  timeoutMs = 20_000,
): Promise<{ latest: Map<number, LiveEntry>; cursor: number }> {
  const latest = new Map<number, LiveEntry>();
  let cursor = 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = link.logs(cursor);
    cursor = page.cursor;
    for (const entry of page.entries) if (entry.data) latest.set(entry.messageId, entry);
    if (until(latest)) break;
    await sleep(20);
  }
  return { latest, cursor };
}

function dataOf<T extends LiveData['kind']>(latest: Map<number, LiveEntry>, id: number, kind: T): Extract<LiveData, { kind: T }> {
  const entry = latest.get(id);
  assert.ok(entry, `message ${id} was not decoded`);
  assert.ok(entry!.data, `message ${id} carries no telemetry projection`);
  assert.equal(entry!.data!.kind, kind);
  return entry!.data as Extract<LiveData, { kind: T }>;
}

test('a live stream decodes every message the Status cards read', async () => {
  const { server, port } = await replayServer({ close: false });
  const link = new LiveLink(dataDir);
  try {
    await link.connect({ kind: 'tcp', host: '127.0.0.1', port });
    const wanted = [37, 42, 43, 963, 1043, 2065];
    const { latest, cursor } = await collect(link, (seen) => wanted.every((id) => seen.has(id)));
    assert.deepEqual(
      wanted.filter((id) => !latest.has(id)),
      [],
      `missing projections: ${wanted.filter((id) => !latest.has(id)).join(', ')}`,
    );

    /* BESTPOS #42 → Positioning tile */
    const position = dataOf(latest, 42, 'bestpos');
    assert.equal(position.solutionStatus, 'SOL_COMPUTED');
    assert.equal(position.positionType, 'SINGLE');
    assert.ok(Math.abs((position.latitude ?? 0) - 30.5399) < 0.01, `latitude ${position.latitude}`);
    assert.ok(Math.abs((position.longitude ?? 0) - 114.3528) < 0.01, `longitude ${position.longitude}`);
    assert.ok(Math.abs((position.height ?? 0) - 64.8) < 1, `height ${position.height}`);
    assert.equal(position.datumId, 'WGS84');
    assert.ok((position.satellitesUsed ?? 0) > 0);
    assert.ok((position.satellitesTracked ?? 0) >= (position.satellitesUsed ?? 0));

    /* HWMONITOR #963 → Device tile; the status word's high byte picks the sensor. */
    const device = dataOf(latest, 963, 'hwmonitor');
    const type = (wantedType: number) => device.sensors.find((sensor) => sensor.type === wantedType);
    const temperature = type(1);
    const current = type(2);
    const voltage = type(7);
    assert.ok(temperature, 'type 1 (temperature) is decoded');
    assert.ok(current, 'type 2 (antenna current) is decoded');
    assert.ok(voltage, 'type 7 (antenna voltage) is decoded');
    assert.ok(Math.abs(temperature!.value - 39.87) < 1, `temperature ${temperature!.value}`);
    assert.ok(Math.abs(voltage!.value - 5.12) < 0.1, `antenna voltage ${voltage!.value}`);
    assert.ok(Math.abs(current!.value * 1000 - 52.6) < 5, `antenna current ${current!.value * 1000} mA`);
    assert.equal(temperature!.limit, 0, 'no boundary flag on a healthy reading');
    assert.ok(device.idleTime !== null && device.idleTime >= 0 && device.idleTime <= 100, `idleTime ${device.idleTime}`);

    /* RANGE #43 → constellation counts */
    const range = dataOf(latest, 43, 'range');
    assert.ok(range.observations.length > 20, `observations ${range.observations.length}`);
    assert.ok(range.observations.some((observation) => observation.system === 0), 'GPS observations');
    assert.ok(range.observations.every((observation) => observation.prn > 0 && observation.prn < 512));
    assert.ok(range.observations.some((observation) => (observation.cno ?? 0) > 20), 'C/N0 survives');

    /* SATVIS2 #1043 → real sky positions */
    const satvis = dataOf(latest, 1043, 'satvis');
    assert.ok(['GPS', 'GLONASS', 'GALILEO', 'BEIDOU', 'SBAS', 'QZSS', 'NAVIC'].includes(satvis.system), satvis.system);
    assert.ok(satvis.satellites.length > 0);
    assert.ok(satvis.satellites.every((satellite) => satellite.elevation >= -90 && satellite.elevation <= 90));
    assert.ok(satvis.satellites.every((satellite) => satellite.azimuth >= 0 && satellite.azimuth <= 360));

    /* VERSION #37 → Model */
    const version = dataOf(latest, 37, 'version');
    assert.ok(version.model.length > 0, 'model_name is decoded');
    assert.equal(version.hardwareVersion, 'OEM729-2.03');

    /* ITDETECTSTATUS #2065 → Interference */
    const interference = dataOf(latest, 2065, 'itdetect');
    assert.ok(interference.entries.length > 0);
    const first = interference.entries[0];
    assert.ok(['L1', 'L2', 'L5'].includes(first.rfPath), first.rfPath);
    assert.equal(first.severity.length, 2, 'both severity words are read');

    /* Cursor semantics still hold while projections are attached. */
    assert.deepEqual(link.logs(cursor).entries, []);
    const status = link.status();
    assert.equal(status.connected, true);
    assert.ok(status.lastRecordAt, 'the newest record time is reported');
    assert.ok(status.records > 0);
  } finally {
    await link.disconnect();
    server.close();
  }
});

test('a transport that closes reports disconnected but keeps what it decoded', async () => {
  const { server, port } = await replayServer({ close: true });
  const link = new LiveLink(dataDir);
  try {
    await link.connect({ kind: 'tcp', host: '127.0.0.1', port });
    const deadline = Date.now() + 20_000;
    while (link.status().connected && Date.now() < deadline) await sleep(25);
    const status = link.status();
    assert.equal(status.connected, false, 'a closed socket is not a live session');
    assert.ok(status.disconnectedAt, 'the close time is reported');
    assert.ok(link.logs(0).entries.length > 0, 'the buffer survives for a final render');
    assert.equal(link.send('LOG COM1 BESTPOSB ONTIME 1').commands.at(-1)?.ok, false, 'sending fails after close');
  } finally {
    await link.disconnect();
    server.close();
  }
});
