/**
 * The command-response channel (`LiveLink.command` / `LiveLink.collect`).
 *
 * A receiver answers abbreviated-ASCII commands in order, one `<OK`/`<ERR…` per line, and the reply
 * carries no command name. Everything here is driven by a **fake receiver**: a TCP loopback that
 * answers each received line with whatever the test told it to answer — including nothing at all,
 * which is the case that has to time out rather than be reported as success.
 *
 * No receiver is used (COM10 is owned by another session); the wire is the same one a TCP
 * connection to an OEM729 uses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LiveLink } from '../src/live.ts';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'protocol', 'data');

/** What the fake receiver does with one line: the bytes to answer with, or `null` to stay silent. */
type Answer = (line: string) => string | string[] | null;

interface FakeReceiver {
  server: Server;
  port: number;
  /** Every line the client wrote, in order (`\r` stripped). */
  received: () => string[];
  close: () => Promise<void>;
}

async function fakeReceiver(answer: Answer): Promise<FakeReceiver> {
  const lines: string[] = [];
  let pending = '';
  const server = createServer((socket: Socket) => {
    socket.setEncoding('latin1');
    socket.on('error', () => {});
    socket.on('data', (chunk: string) => {
      pending += chunk;
      let cut = pending.indexOf('\n');
      while (cut >= 0) {
        const line = pending.slice(0, cut).replace(/\r$/, '');
        pending = pending.slice(cut + 1);
        cut = pending.indexOf('\n');
        if (!line) continue;
        lines.push(line);
        const reply = answer(line);
        if (reply === null) continue;
        for (const one of Array.isArray(reply) ? reply : [reply]) socket.write(`${one}\r\n`);
      }
    });
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  return {
    server,
    port,
    received: () => [...lines],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function withLink(
  answer: Answer,
  body: (link: LiveLink, receiver: FakeReceiver) => Promise<void>,
): Promise<void> {
  const receiver = await fakeReceiver(answer);
  const link = new LiveLink(dataDir);
  try {
    await link.connect({ kind: 'tcp', host: '127.0.0.1', port: receiver.port });
    await body(link, receiver);
  } finally {
    await link.disconnect();
    await receiver.close();
  }
}

test('every line waits for its own reply and the status carries it', async () => {
  await withLink(
    () => '<OK',
    async (link, receiver) => {
      const first = await link.command('SERIALCONFIG COM2 9600 N 8 1 N ON');
      const second = await link.command('INTERFACEMODE COM2 NONE NONE OFF');
      assert.equal(first.ok, true);
      assert.equal(first.status, 'ok');
      assert.equal(first.reply, '<OK');
      assert.equal(first.id, 0, 'commands are numbered from 0 inside the session');
      assert.equal(second.id, 1);
      assert.ok(first.elapsedMs >= 0);
      assert.deepEqual(receiver.received(), [
        'SERIALCONFIG COM2 9600 N 8 1 N ON',
        'INTERFACEMODE COM2 NONE NONE OFF',
      ]);
      const commands = link.status().commands;
      assert.equal(commands.length, 2);
      assert.equal(commands[0].line, 'SERIALCONFIG COM2 9600 N 8 1 N ON');
      assert.equal(commands[0].ok, true);
      assert.equal(commands[0].reply, '<OK');
      assert.equal(commands[1].reply, '<OK');
      assert.equal(link.status().unsolicitedReplies, 0);
    },
  );
});

test('an <ERR is a failure that quotes the receiver and does not stop the channel', async () => {
  await withLink(
    (line) => (line.startsWith('SERIALCONFIG') ? '<ERROR:Invalid port' : '<OK'),
    async (link) => {
      const bad = await link.command('SERIALCONFIG COM99 9600 N 8 1 N ON');
      assert.equal(bad.ok, false);
      assert.equal(bad.status, 'err');
      assert.equal(bad.reply, '<ERROR:Invalid port');
      const good = await link.command('LOG RXCONFIG ONCE');
      assert.equal(good.ok, true, 'the next command still gets its own reply');
      const entries = link.status().commands;
      assert.equal(entries[0].ok, false);
      assert.equal(entries[0].status, 'err');
      assert.equal(entries[0].reply, '<ERROR:Invalid port');
    },
  );
});

test('silence is a timeout, never a success', async () => {
  await withLink(
    () => null,
    async (link) => {
      const reply = await link.command('SERIALCONFIG COM2 9600 N 8 1 N ON', { timeoutMs: 150 });
      assert.equal(reply.ok, false);
      assert.equal(reply.status, 'timeout');
      assert.equal(reply.reply, null);
      assert.ok(reply.elapsedMs >= 140, `waited ${reply.elapsedMs} ms`);
      assert.equal(link.status().commands.at(-1)?.status, 'timeout');
      assert.match(String(link.status().lastError), /no reply/i);
    },
  );
});

test('replies are matched in the order the receiver emits them, and a surplus reply is counted', async () => {
  await withLink(
    (line) => (line === 'A' ? '<ERR,first' : line === 'B' ? '<OK' : null),
    async (link) => {
      // Both lines are on the wire before either answer arrives: the receiver answers A then B.
      const [a, b] = await Promise.all([link.command('A'), link.command('B')]);
      assert.equal(a.ok, false, 'the first reply belongs to the first line');
      assert.equal(a.reply, '<ERR,first');
      assert.equal(b.ok, true);
      assert.equal(b.reply, '<OK');
      const before = link.status().unsolicitedReplies;
      // A third reply with nothing outstanding must not be credited to anything.
      await link.command('C', { timeoutMs: 150 });
      assert.equal(link.status().unsolicitedReplies, before, 'C never answered, so nothing was counted');
    },
  );
});

test('a reply with no command outstanding is counted, not used as success', async () => {
  const receiver = await fakeReceiver((line) => (line === 'LOG RXCONFIG ONCE' ? ['<RXCONFIGA,COM1;SERIALCONFIG COM2 9600', '<OK'] : '<OK'));
  const link = new LiveLink(dataDir);
  try {
    await link.connect({ kind: 'tcp', host: '127.0.0.1', port: receiver.port });
    const collected = await link.collect('LOG RXCONFIG ONCE', { timeoutMs: 1500, quietMs: 200 });
    assert.equal(collected.ok, true);
    assert.deepEqual(collected.lines, ['<RXCONFIGA,COM1;SERIALCONFIG COM2 9600']);
    // The `<OK` the receiver tacked on had nothing outstanding: it is counted, not applied.
    assert.equal(link.status().unsolicitedReplies, 1);
    assert.deepEqual(link.status().commands, []);
    assert.deepEqual(link.inboundLines(), ['<RXCONFIGA,COM1;SERIALCONFIG COM2 9600']);
  } finally {
    await link.disconnect();
    await receiver.close();
  }
});

test('a read-back request that is never answered says so', async () => {
  await withLink(
    () => null,
    async (link) => {
      const collected = await link.collect('LOG RXCONFIG ONCE', { timeoutMs: 200, quietMs: 100 });
      assert.equal(collected.ok, false);
      assert.deepEqual(collected.lines, []);
      assert.match(collected.reason, /no line answered/i);
    },
  );
});

test('a Terminal line keeps its place in the queue, so an awaited command is not credited with it', async () => {
  await withLink(
    (line) => (line.startsWith('LOG') ? '<ERROR:Profile Active.' : '<OK'),
    async (link) => {
      // The Terminal writes a line it does not await; its <ERR belongs to *that* line.
      link.send('LOG COM1 BESTPOSB ONTIME 1');
      const reply = await link.command('SERIALCONFIG COM2 9600 N 8 1 N ON');
      assert.equal(reply.ok, true, 'the second reply is the one for the awaited command');
      assert.equal(reply.reply, '<OK');
      const commands = link.status().commands;
      assert.equal(commands.length, 2);
      assert.equal(commands[0].line, 'LOG COM1 BESTPOSB ONTIME 1');
      assert.equal(commands[0].reply, '<ERROR:Profile Active.', 'the Terminal line owns its own answer');
      assert.equal(link.status().unsolicitedReplies, 0);
    },
  );
});

test('a command outstanding when the session closes ends as closed, without hanging', async () => {
  const receiver = await fakeReceiver(() => null);
  const link = new LiveLink(dataDir);
  try {
    await link.connect({ kind: 'tcp', host: '127.0.0.1', port: receiver.port });
    const pending = link.command('SERIALCONFIG COM2 9600 N 8 1 N ON', { timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await link.disconnect();
    const reply = await pending;
    assert.equal(reply.ok, false);
    assert.equal(reply.status, 'closed');
  } finally {
    await link.disconnect();
    await receiver.close();
  }
});

test('a command with no session is refused with the reason', async () => {
  const link = new LiveLink(dataDir);
  const reply = await link.command('SERIALCONFIG COM2 9600 N 8 1 N ON');
  assert.equal(reply.ok, false);
  assert.equal(reply.status, 'not-connected');
  assert.equal(reply.reply, null);
  const collected = await link.collect('LOG RXCONFIG ONCE');
  assert.equal(collected.ok, false);
  assert.match(collected.reason, /not connected/i);
});
