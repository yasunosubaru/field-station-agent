/**
 * `Tools ▸ Device ▸ Import Configuration…` — the write flow over a command-response channel.
 *
 * The channel is scripted here (`ImportChannel`), so every path is drivable without a receiver:
 * all lines accepted and read back, a line refused in the middle, a line never answered, a read-back
 * that disagrees, and a read-back that stays silent. The end-to-end version with a TCP fake
 * receiver is `cfg-import-e2e.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  READBACK_REQUEST,
  deviceImportApply,
  type ImportChannel,
} from '../src/config-http.ts';
import type { LiveCommandStatus, LiveCommandReply } from '../src/live.ts';

type Verdict = { reply: string | null; status?: LiveCommandStatus };

/** A receiver whose answers are written out by the test, in order. */
class ScriptedChannel implements ImportChannel {
  readonly sent: string[] = [];
  readonly requests: string[] = [];
  private readonly verdicts: Verdict[];
  private readonly readback: string[] | null;

  constructor(verdicts: Verdict[], readback: string[] | null) {
    this.verdicts = [...verdicts];
    this.readback = readback;
  }

  async command(line: string): Promise<LiveCommandReply> {
    this.sent.push(line);
    const verdict = this.verdicts.shift() ?? { reply: '<OK' };
    const status: LiveCommandStatus = verdict.status ?? (verdict.reply === null ? 'timeout' : verdict.reply.startsWith('<OK') ? 'ok' : 'err');
    return {
      id: this.sent.length - 1,
      at: new Date().toISOString(),
      line,
      ok: status === 'ok',
      status,
      reply: verdict.reply,
      elapsedMs: status === 'timeout' ? 15_000 : 7,
    };
  }

  async collect(line: string): Promise<{ ok: boolean; lines: string[]; reason: string }> {
    this.requests.push(line);
    if (this.readback === null) {
      return { ok: false, lines: [], reason: `no line answered “${line}” within 8000 ms (the receiver stayed silent)` };
    }
    return { ok: this.readback.length > 0, lines: [...this.readback], reason: `${this.readback.length} line(s) answered “${line}”` };
  }
}

/** Full-ASCII RXCONFIG answers, the shape the suite's own save flow consumes. */
const rxconfig = (...bodies: string[]): string[] =>
  bodies.map(
    (body, index) =>
      `<RXCONFIGA,COM1,0,53.5,FINESTEERING,2287,13788${index}.000,02000020,4b5f,168${index};${body}*1122334${index}`,
  );

const CFG = [
  '/* VERSION 1 OEM729 R4.10 */',
  'SERIALCONFIG COM2 9600 N 8 1 N ON',
  'INTERFACEMODE COM2 NONE NOVATEL OFF',
  'SAVECONFIG',
  'RESET',
].join('\n');

test('every line is acknowledged and the read-back confirms each one', async () => {
  const channel = new ScriptedChannel(
    [{ reply: '<OK' }, { reply: '<OK' }],
    rxconfig(
      'SERIALCONFIG COM2 9600 N 8 1 N ON',
      'INTERFACEMODE COM2 NONE NOVATEL OFF',
    ),
  );
  const result = await deviceImportApply(CFG, true, undefined, channel);

  assert.equal(result.ok, true, result.reason);
  assert.equal(result.sent, 2);
  assert.equal(result.verified, true);
  assert.deepEqual(channel.sent, [
    'SERIALCONFIG COM2 9600 N 8 1 N ON',
    'INTERFACEMODE COM2 NONE NOVATEL OFF',
  ]);
  assert.deepEqual(channel.requests, [READBACK_REQUEST], 'the read-back is the shipped RXCONFIG dump');
  assert.equal(result.steps.length, 2);
  assert.deepEqual(result.steps.map((step) => step.reply), ['<OK', '<OK']);
  assert.deepEqual(result.steps.map((step) => step.verified), ['matched', 'matched']);
  assert.match(result.steps[0].readback[0], /^<RXCONFIGA,.*SERIALCONFIG COM2 9600 N 8 1 N ON\*/, 'the receiver’s own line');
  assert.equal(result.verification?.matched, 2);
  assert.equal(result.verification?.lines, 2);
  assert.deepEqual(result.verification?.mismatched, []);
  assert.match(result.reason, /no SAVECONFIG, no RESET/);
});

test('a refused line stops the import there and quotes the receiver', async () => {
  const channel = new ScriptedChannel(
    [{ reply: '<OK' }, { reply: '<ERROR:Invalid parameter', status: 'err' }],
    rxconfig('SERIALCONFIG COM2 9600 N 8 1 N ON'),
  );
  const result = await deviceImportApply(CFG, true, undefined, channel);

  assert.equal(result.ok, false);
  assert.equal(result.sent, 2, 'the refused line was sent; the lines after it were not');
  assert.equal(result.failedAt, 2);
  assert.equal(result.failedLine, 'INTERFACEMODE COM2 NONE NOVATEL OFF');
  assert.equal(result.verified, false);
  assert.equal(result.verification, null, 'no read-back after a failed write');
  assert.deepEqual(channel.requests, [], 'the read-back request was never sent');
  assert.deepEqual(result.steps.map((step) => step.status), ['ok', 'err']);
  assert.equal(result.steps[1].reply, '<ERROR:Invalid parameter');
  assert.match(result.reason, /command 2 of 2/);
  assert.match(result.reason, /<ERROR:Invalid parameter/, 'the receiver’s own words are quoted');
  assert.match(result.reason, /no read-back was attempted/i);
});

test('a line that is never answered is a timeout, not a success', async () => {
  const channel = new ScriptedChannel([{ reply: null, status: 'timeout' }], null);
  const result = await deviceImportApply(CFG, true, undefined, channel, { commandTimeoutMs: 15_000 });

  assert.equal(result.ok, false);
  assert.equal(result.failedAt, 1);
  assert.equal(result.steps[0].status, 'timeout');
  assert.equal(result.steps[0].reply, null);
  assert.equal(channel.sent.length, 1, 'only the first line was written');
  assert.match(result.reason, /did not answer within 15000 ms/);
  assert.match(result.reason, /no reply is invented/i);
});

test('a read-back that echoes a different value fails the import and shows both sides', async () => {
  const channel = new ScriptedChannel(
    [{ reply: '<OK' }, { reply: '<OK' }],
    rxconfig('SERIALCONFIG COM2 115200 N 8 1 N ON', 'INTERFACEMODE COM2 NONE NOVATEL OFF'),
  );
  const result = await deviceImportApply(CFG, true, undefined, channel);

  assert.equal(result.ok, false);
  assert.equal(result.sent, 2);
  assert.equal(result.steps[0].verified, 'mismatch');
  assert.equal(result.steps[1].verified, 'matched');
  assert.deepEqual(result.verification?.mismatched, ['SERIALCONFIG COM2 9600 N 8 1 N ON']);
  assert.equal(result.verification?.matched, 1);
  assert.match(result.steps[0].readback[0], /SERIALCONFIG COM2 115200/, 'the receiver’s actual value is reported');
  assert.match(result.reason, /read-back disagrees/i);
});

test('a line RXCONFIG does not report is said so, not counted as verified', async () => {
  const channel = new ScriptedChannel(
    [{ reply: '<OK' }, { reply: '<OK' }],
    rxconfig('SERIALCONFIG COM2 9600 N 8 1 N ON'),
  );
  const result = await deviceImportApply(CFG, true, undefined, channel);

  assert.equal(result.ok, true, 'every line was acknowledged and nothing disagreed');
  assert.equal(result.verified, false, 'but one line was not read back');
  assert.equal(result.steps[0].verified, 'matched');
  assert.equal(result.steps[1].verified, 'absent');
  assert.deepEqual(result.verification?.absent, ['INTERFACEMODE COM2 NONE NOVATEL OFF']);
  assert.match(result.reason, /not reported by LOG RXCONFIG/);
  assert.match(result.reason, /<OK alone/);
});

test('a silent read-back leaves the write unverified and reports why', async () => {
  const channel = new ScriptedChannel([{ reply: '<OK' }, { reply: '<OK' }], null);
  const result = await deviceImportApply(CFG, true, undefined, channel);

  assert.equal(result.ok, false);
  assert.equal(result.sent, 2, 'both lines were written and acknowledged');
  assert.equal(result.verified, false);
  assert.equal(result.verification?.attempted, true);
  assert.equal(result.verification?.lines, 0);
  assert.match(result.reason, /produced no line/);
  assert.match(result.reason, /nothing is verified/);
});

test('a .cfg with nothing loadable is refused before anything is sent', async () => {
  const channel = new ScriptedChannel([], []);
  const result = await deviceImportApply('/* only a comment */\nSAVECONFIG\nRESET\n', true, undefined, channel);
  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  assert.deepEqual(channel.sent, []);
  assert.match(result.reason, /no loadable command/i);
});
