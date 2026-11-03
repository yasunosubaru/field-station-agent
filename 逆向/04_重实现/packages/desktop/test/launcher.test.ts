/**
 * Launcher behaviour, tested against the real HTTP shell.
 *
 * The `.cmd` is only a `node` locator, so these tests drive `src/launcher.ts` directly — that is
 * the logic that has to be right. Every test picks its own high port and its own log file, so a
 * developer's own instance on 7788 never interferes.
 *
 *   node --test --test-force-exit "packages/desktop/test/*.test.ts"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendLog,
  candidatePorts,
  isPortListening,
  launch,
  parseArgs,
  readLogTail,
  type LaunchResult,
} from '../src/launcher.ts';

const TITLE = 'All powered-FSA · 野外台站智能体';

/** A port nothing currently listens on, in a range the app never defaults to. */
async function freePortBase(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const port = 20_000 + Math.floor(Math.random() * 30_000);
    if (!(await isPortListening(port))) return port;
  }
  throw new Error('could not find a free port');
}

function workDir(): string {
  return mkdtempSync(join(tmpdir(), 'fieldstation-test-'));
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  assert.equal(response.status, 200, `${url} should answer 200`);
  return (await response.json()) as Record<string, unknown>;
}

test('the launcher serves the console, then releases its port on stop', async () => {
  const port = await freePortBase();
  const logFile = join(workDir(), 'launcher.log');
  const result: LaunchResult = await launch({ preferredPort: port, openBrowser: false, logFile, quiet: true });

  try {
    assert.equal(result.reused, false, 'nothing was running, so a child must have been spawned');
    assert.equal(result.port, port, 'the preferred port was free, it must be used as-is');
    assert.ok(result.child, 'a spawned instance reports its child');
    assert.equal(result.openedBrowser, false, '-NoBrowser means no browser');

    const page = await fetch(result.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), new RegExp(`<title>${TITLE}</title>`));

    const health = await getJson(new URL('/api/health', result.url).href);
    assert.equal(health.service, 'nas-reimpl-app');
    assert.equal(health.ok, true);

    const tail = readLogTail(logFile);
    assert.match(tail, new RegExp(`ready http://127\\.0\\.0\\.1:${port}/`), 'the log records the URL it is serving');
    assert.match(tail, /\[server\] nas-reimpl app listening on/, 'server stdout is mirrored into the log');
  } finally {
    await result.stop();
    await result.stop(); // idempotent: a second stop must not throw or double-kill
  }

  assert.equal(await isPortListening(port), false, 'the port must be free again');
  assert.ok(
    result.child.exitCode !== null || result.child.signalCode !== null,
    'the child process itself is gone, not merely out of the port',
  );
  assert.match(readLogTail(logFile), new RegExp(`stopped, port ${port} released`));
});

test('a second launch reuses the running instance instead of starting one', async () => {
  const port = await freePortBase();
  const dir = workDir();
  const first = await launch({ preferredPort: port, openBrowser: false, logFile: join(dir, 'first.log'), quiet: true });
  try {
    const second = await launch({
      preferredPort: port,
      openBrowser: false,
      logFile: join(dir, 'second.log'),
      quiet: true,
    });

    assert.equal(second.reused, true, 'the existing instance must be adopted');
    assert.equal(second.child, null, 'adopting a running instance starts no process');
    assert.equal(second.port, port);
    assert.equal(second.url, first.url);

    const tail = readLogTail(join(dir, 'second.log'));
    assert.match(tail, /reuse http:\/\/127\.0\.0\.1:\d+\//);
    assert.match(tail, /already running, no new process/);

    // The instance the first launch started is still the one answering.
    const health = await getJson(new URL('/api/health', first.url).href);
    assert.equal(health.service, 'nas-reimpl-app');
    assert.equal(await isPortListening(port), true);
  } finally {
    await first.stop();
  }
  assert.equal(await isPortListening(port), false);
});

test('the browser opens once by default and not at all with -NoBrowser', async () => {
  const port = await freePortBase();
  const dir = workDir();
  const opened: string[] = [];

  const first = await launch({
    preferredPort: port,
    browserOpener: (url) => opened.push(url),
    logFile: join(dir, 'open.log'),
    quiet: true,
  });
  try {
    assert.deepEqual(opened, [first.url], 'exactly one browser open, with the served URL');
    assert.equal(first.openedBrowser, true);

    // A -NoBrowser launch still reuses, but must leave the browser alone.
    const second = await launch({
      preferredPort: port,
      openBrowser: false,
      browserOpener: (url) => opened.push(url),
      logFile: join(dir, 'nobrowser.log'),
      quiet: true,
    });
    assert.equal(second.reused, true);
    assert.equal(opened.length, 1, '-NoBrowser opened nothing');
    assert.match(readLogTail(join(dir, 'nobrowser.log')), /browser skipped .*--no-browser/);
  } finally {
    await first.stop();
  }
});

test('a busy preferred port falls through to the next candidate', async () => {
  const base = await freePortBase();
  const blocker = createServer();
  // Drop probe connections immediately: `server.close()` waits for open sockets, and a socket the
  // launcher aborted would otherwise keep it alive (that hang is exactly what these tests catch).
  blocker.on('connection', (socket) => socket.destroy());
  await new Promise<void>((done) => blocker.listen(base, '127.0.0.1', () => done()));
  const logFile = join(workDir(), 'fallback.log');

  let result: LaunchResult | null = null;
  try {
    result = await launch({ preferredPort: base, attempts: 2, openBrowser: false, logFile, quiet: true });
    assert.equal(result.port, base + 1, 'the occupied port is skipped, not stolen');
    assert.equal((await getJson(new URL('/api/health', result.url).href)).service, 'nas-reimpl-app');
    assert.match(readLogTail(logFile), new RegExp(`port ${base} unusable`));
  } finally {
    await result?.stop();
    await new Promise<void>((done) => blocker.close(() => done()));
  }
});

test('argv and environment both configure the launcher', () => {
  assert.equal(parseArgs(['-NoBrowser'], {}).openBrowser, false);
  assert.equal(parseArgs(['--no-browser'], {}).openBrowser, false);
  assert.equal(parseArgs([], { FIELD_STATION_NO_BROWSER: '1' }).openBrowser, false);
  assert.equal(parseArgs([], { FIELD_STATION_NO_BROWSER: '0' }).openBrowser, true);
  assert.equal(parseArgs([], { FIELD_STATION_PORT: '7790' }).port, 7790);
  assert.equal(parseArgs(['-Port', '7791'], {}).port, 7791);
  assert.equal(parseArgs(['--port=7792'], {}).port, 7792);
  assert.equal(parseArgs(['-Minimize'], {}).minimize, true);
  assert.equal(parseArgs(['-Minimize', '-NoMinimize'], {}).minimize, false);
  assert.equal(parseArgs(['-h'], {}).help, true);

  assert.throws(() => parseArgs(['-Bogus'], {}), /未知参数/);
  assert.throws(() => parseArgs(['-Port', 'abc'], {}), /端口不合法/);

  assert.deepEqual(candidatePorts(7788), [7788, 7789, 7790, 7791, 7792], 'five attempts, consecutive');
  assert.deepEqual(candidatePorts(65534, 5), [65534, 65535], 'never past 65535');
});

test('the log keeps only its most recent bytes', () => {
  const logFile = join(workDir(), 'rotating.log');
  const limit = 2_048;
  for (let i = 0; i < 200; i++) appendLog(logFile, `line ${i} ${'x'.repeat(40)}`, limit);
  assert.ok(existsSync(logFile));
  assert.ok(statSync(logFile).size <= limit, 'the log never grows past the cap');

  const text = readFileSync(logFile, 'utf8');
  assert.match(text, /line 199 /, 'the newest line survives');
  assert.doesNotMatch(text, /line 0 /, 'the oldest lines are the ones dropped');
  assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /, 'every line is timestamped');
});
