/**
 * `/api/ports` — the list the Add Device dialog fills itself from.
 *
 * Two things matter and neither is cosmetic:
 *  - the route answers even when the native binding is missing (the Add Device dialog then says
 *    *why* nothing can be opened instead of failing silently), and
 *  - what it lists is the machine's real ports, never a made-up `COM10`.
 *
 * The test host may legitimately have no serial port; the assertions therefore check the contract
 * (shape, ordering, the reason when empty) rather than a fixed count.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { request } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listSerialPorts } from '../src/ports.ts';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((done, fail) => {
    const req = request(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => done({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', fail);
    req.end();
  });
}

test('listSerialPorts reports the machine as it is, with a reason when empty', async () => {
  const list = await listSerialPorts(true);
  assert.equal(typeof list.available, 'boolean', 'available says whether a serial open can work');
  assert.ok(Array.isArray(list.ports), 'ports is always an array');

  for (const port of list.ports) {
    assert.match(port.path, /^COM\d+$/, `a Windows port name is upper-case COM<n>, got ${port.path}`);
    assert.ok(port.friendlyName === null || typeof port.friendlyName === 'string');
    assert.ok(port.manufacturer === null || typeof port.manufacturer === 'string');
  }

  const numbers = list.ports.map((port) => Number(port.path.slice(3)));
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'ports come back in COM order');

  if (list.ports.length === 0) {
    assert.ok((list.reason ?? '').length > 0, 'an empty list always explains itself');
  } else {
    assert.equal(list.reason, null, 'a non-empty list needs no excuse');
  }
});

test('the cache is per-scan: force re-reads the machine', async () => {
  const first = await listSerialPorts(true);
  const second = await listSerialPorts(false);
  assert.equal(second.available, first.available);
  assert.deepEqual(second.ports.map((p) => p.path), first.ports.map((p) => p.path));
});

let child: ChildProcessWithoutNullStreams | null = null;
let base = '';
let stderr = '';

before(async () => {
  child = spawn(process.execPath, [serverPath, '--port', '0'], {
    cwd: resolve(here, '..', '..', '..'),
    stdio: 'pipe',
  });
  const port = await new Promise<number>((ready, fail) => {
    let stdout = '';
    const timer = setTimeout(() => fail(new Error(`server did not start\n${stderr}`)), 25_000);
    child!.stdout.setEncoding('utf8');
    child!.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        ready(Number(match[1]));
      }
    });
    child!.stderr.setEncoding('utf8');
    child!.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child!.on('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`server exited early (${code})\n${stderr}`));
    });
  });
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  child?.kill();
  child = null;
});

test('GET /api/ports serves the same list the module returns', async () => {
  const response = await get(`${base}/api/ports`);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body) as {
    ok: boolean;
    available: boolean;
    ports: Array<{ path: string }>;
    reason: string | null;
  };
  assert.equal(body.ok, true);
  const direct = await listSerialPorts(false);
  assert.equal(body.available, direct.available);
  assert.deepEqual(body.ports.map((port) => port.path), direct.ports.map((port) => port.path));
});
