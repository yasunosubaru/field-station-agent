/**
 * ITPSDFINAL / ITPSDDETECT in the live telemetry (GRIT's spectrum + waterfall source).
 *
 * Everything asserted here is measured on the replay of a real receiver capture
 * (`samples/live-20261031/b1-20261101.sbf`, 127 × 1968 and 50 × 2063), so the numbers below can be
 * re-derived from the wire:
 *
 *  - the field list and the `sample = raw/256 − 200` conversion are the manual's (ITPSDFINAL
 *    "Divide the sample by 256.0, Subtract 200"), and they must agree with the golden ASCII of the
 *    same capture (`golden-b1-20261101.ASCII`, `#ITPSDFINALA,…;04020920,1531.299,97656.250,1024,22587,22865,…`);
 *  - `sequence` is the **OEM7 header word at byte 10**, not the payload status word: the manual
 *    says the chunks of one sweep "can be grouped together through the sequence number of the log
 *    header", and the capture shows exactly that — one 1365-sample ITPSDDETECT sweep arrives as
 *    header sequence 1 (1024 samples) followed by header sequence 0 (341 samples), **both frames
 *    carrying the same status word** and the same millisecond. A sequence inside the status word
 *    could not distinguish the two chunks, so the payload word cannot be it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LiveLink, type LiveEntry, type LiveSpectrum } from '../src/live.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'protocol', 'data');
const capture = join(here, '..', '..', '..', '..', '00_来源', 'samples', 'live-20261031', 'b1-20261101.sbf');

/** A TCP server that pushes the whole capture once a client connects. */
function replayServer(): Promise<{ server: Server; port: number }> {
  const bytes = readFileSync(capture);
  return new Promise((resolve) => {
    const server = createServer((socket: Socket) => {
      socket.on('error', () => {});
      let at = 0;
      const pump = (): void => {
        if (at >= bytes.length) return;
        socket.write(bytes.subarray(at, at + 16384));
        at += 16384;
        setTimeout(pump, 1);
      };
      pump();
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

function spectra(entries: LiveEntry[], log?: 'final' | 'detect'): LiveSpectrum[] {
  const out: LiveSpectrum[] = [];
  for (const entry of entries) {
    const data = entry.data;
    if (!data || data.kind !== 'itpsd') continue;
    if (log && data.log !== log) continue;
    out.push(data);
  }
  return out;
}

async function withReplay(run: (link: LiveLink) => Promise<void>): Promise<void> {
  const { server, port } = await replayServer();
  const link = new LiveLink(dataDir);
  try {
    await link.connect({ kind: 'tcp', host: '127.0.0.1', port });
    await run(link);
  } finally {
    await link.disconnect();
    server.close();
  }
}

/** Wait until `ready(entries)` holds, then hand back the buffer. */
async function waitFor(link: LiveLink, ready: (entries: LiveEntry[]) => boolean): Promise<LiveEntry[]> {
  const deadline = Date.now() + 25_000;
  let entries = link.logs(0).entries;
  while (!ready(entries)) {
    if (Date.now() > deadline) {
      const kinds = new Map<string, number>();
      for (const entry of entries) {
        const key = entry.data ? `${entry.messageId}:${(entry.data as { log?: string }).log ?? 'data'}` : String(entry.messageId);
        kinds.set(key, (kinds.get(key) ?? 0) + 1);
      }
      throw new Error(`timed out; ${entries.length} entries: ${[...kinds].map(([k, n]) => `${k}=${n}`).join(', ')}`);
    }
    await new Promise((r) => setTimeout(r, 25));
    entries = link.logs(0).entries;
  }
  return entries;
}

test('ITPSDFINAL projects the header sequence, the status word and 1024 dBm samples', async () => {
  await withReplay(async (link) => {
    const entries = await waitFor(link, (list) => spectra(list, 'final').length > 0);
    const entry = entries.find((item) => item.data?.kind === 'itpsd');
    const final = spectra(entries, 'final')[0];
    assert.ok(final, 'the stream contains ITPSDFINAL');
    assert.ok(entry);

    /* Payload geometry, straight off the wire: 4 + 4 + 4 + 4 + 1024 × 2 bytes. */
    assert.equal(final!.log, 'final');
    assert.equal(final!.samples.length, 1024);
    assert.ok(Math.abs(final!.frequencyStart - 1531.298828125) < 1e-6, `frequencyStart ${final!.frequencyStart}`);
    assert.equal(final!.stepSize, 97656.25);

    /* Conversion: raw/256 − 200, on the first two samples the golden ASCII prints. */
    assert.ok(Math.abs(final!.samples[0] - (22587 / 256 - 200)) < 1e-9, `sample[0] ${final!.samples[0]}`);
    assert.ok(Math.abs(final!.samples[1] - (22865 / 256 - 200)) < 1e-9, `sample[1] ${final!.samples[1]}`);
    assert.ok(Math.abs(final!.samples[0] - -111.76953125) < 1e-9);

    /* The ASCII twin the suite already validates byte-for-byte: the projection must not drift. */
    assert.match(entry!.ascii, /^#ITPSDFINALA,/);
    assert.match(entry!.ascii, /;04020920,1531\.299,97656\.250,1024,22587,22865,/);

    /* Status word 0x04020920 decodes per the manual's bit table: GPSL1 · POSTDECIMATION · 2K · … */
    assert.equal(final!.status.word, 0x04020920);
    assert.equal(final!.status.frequency, 0);
    assert.equal(final!.status.dataSource, 2);
    assert.equal(final!.status.fftSize, 1);
    assert.equal(final!.status.integrationWindow, 1);
    assert.equal(final!.status.timeAverage, 2);

    /* A 1024-sample sweep fits one log, so the header sequence is 0 (last/only chunk). */
    assert.equal(final!.sequence, 0);
    assert.ok(spectra(entries, 'final').every((item) => item.sequence === 0), 'every ITPSDFINAL is a whole sweep');
  });
});

test('ITPSDDETECT splits one 1365-sample sweep over header sequence 1 → 0', async () => {
  await withReplay(async (link) => {
    const entries = await waitFor(link, (list) => spectra(list, 'detect').filter((item) => item.sequence === 0).length >= 3);
    const chunks = entries.filter((entry) => entry.data?.kind === 'itpsd');
    const detect = chunks
      .map((entry) => ({ entry, data: entry.data as LiveSpectrum }))
      .filter((item) => item.data.log === 'detect');

    /* Pair the chunks the way the manual groups them: consecutive frames of one sweep. */
    const pairs: Array<{ head: LiveSpectrum; tail: LiveSpectrum }> = [];
    for (let at = 0; at < detect.length - 1; at += 1) {
      const head = detect[at].data;
      const tail = detect[at + 1].data;
      if (head.sequence === 1 && tail.sequence === 0) pairs.push({ head, tail });
    }
    assert.ok(pairs.length >= 2, `found ${pairs.length} sequence 1 → 0 sweeps`);

    const { head, tail } = pairs[0];
    assert.equal(head.samples.length, 1024);
    assert.equal(tail.samples.length, 341);
    assert.equal(head.stepSize, tail.stepSize);
    assert.equal(head.stepSize, 73242.1875);

    /* One sweep: the tail starts exactly where the head's 1024 bins end (1024 × RBW later). */
    const expected = head.frequencyStart + (head.samples.length * head.stepSize) / 1e6;
    assert.ok(Math.abs(tail.frequencyStart - expected) < 1e-3, `tail ${tail.frequencyStart} vs ${expected}`);

    /* Consecutive chunks of one sweep are stamped with the same millisecond … */
    const headMs = detect.find((item) => item.data === head)!.entry.milliseconds;
    const tailMs = detect.find((item) => item.data === tail)!.entry.milliseconds;
    assert.equal(headMs, tailMs);

    /* … and they carry the **same status word**, so the sequence cannot live there; the header
     * word at byte 10 is the only thing that differs between the two chunks. */
    assert.equal(head.status.word, tail.status.word);
    assert.equal(head.status.word, 0x04021b22);
    assert.equal(head.status.frequency, 2);
    assert.equal(head.status.dataSource, 2);
    assert.equal(head.status.fftSize, 3);
    assert.notEqual(head.sequence, tail.sequence);

    /* The three sweeps the capture rotates through are the three `frequency` values 2 / 3 / 5. */
    const bands = new Set(spectra(entries, 'detect').map((item) => item.status.frequency));
    assert.deepEqual([...bands].sort(), [2, 3, 5]);
  });
});

test('a message with no ITPSD projection stays `data: null`', async () => {
  await withReplay(async (link) => {
    const entries = await waitFor(link, (list) => list.some((entry) => entry.messageId === 42));
    const bestpos = entries.find((entry) => entry.messageId === 42);
    assert.equal(bestpos?.data?.kind, 'bestpos', 'BESTPOS keeps its own projection');
    const other = entries.find((entry) => entry.messageId === 7);
    if (other) assert.equal(other.data, null, 'an unprojected message carries no data');
  });
});
