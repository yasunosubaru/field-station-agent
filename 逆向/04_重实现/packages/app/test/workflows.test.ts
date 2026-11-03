/**
 * Workflows over HTTP — the hybrid surface.
 *
 * These tests spawn the real server with the executor pointed at a stub script (`NAS_PYTHON=node`,
 * `NAS_WORKFLOW_CLI=<stub.js>`), so routing, exit-code mapping and artifact serving are exercised
 * without Python or a receiver. The stub prints exactly the JSON `workflow_cli.py --json` prints;
 * the real executor is covered by the Python suite (`tests/test_workflow_*.py`).
 *
 * What must stay true:
 *   - a high-risk run stops at `waiting_approval` (202, gate present) instead of pretending to run;
 *   - `gate`/`resume` return 202 because the executor may continue into a long flash;
 *   - ids and artifact names are validated before touching the filesystem;
 *   - a missing executor is reported as 503, not as "no workflows".
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'src', 'server.ts');

const STUB = `#!/usr/bin/env node
const args = process.argv.slice(2);
const cmd = args[0];
const send = (value, code = 0) => {
  process.stdout.write(JSON.stringify(value));
  process.exit(code);
};
if (cmd === 'capabilities') {
  send({ api_version: '1.0', workflow_count: 1, engine: { reachable: false }, methods: ['run_workflow'] });
} else if (cmd === 'list') {
  send([{ id: 'demo.flow', title: 'Demo', summary: 'stub', intent: 'demo.run',
          risk: 'high', params: {}, approval: { required: true }, steps: 2, artifacts: [], path: 'x' }]);
} else if (cmd === 'describe') {
  send({ id: 'demo.flow', title: 'Demo', params: {}, gate_steps: ['gate'] });
} else if (cmd === 'run') {
  send({ job_id: 'demo.flow-1', status: 'waiting_approval',
         gate: { kind: 'approval', step: '(workflow)', prompt: 'approve me',
                 options: ['approved', 'rejected'] } }, 3);
} else if (cmd === 'status') {
  send({ job_id: 'demo.flow-1', status: 'succeeded', artifacts: [] });
} else if (cmd === 'artifacts') {
  send([{ name: 'restart.json', kind: 'json', bytes: 2 }]);
} else if (cmd === 'gate' || cmd === 'resume') {
  send({ ok: true, status: 'running' });
} else if (cmd === 'cancel') {
  send({ ok: true, status: 'cancelled' });
} else {
  send({ ok: true });
}
`;

let child: ChildProcessWithoutNullStreams | null = null;
let base = '';
let stderr = '';
let jobsRoot = '';
let cliPath = '';

function waitForReady(proc: ChildProcessWithoutNullStreams): Promise<number> {
  return new Promise((resolveReady, reject) => {
    let stdout = '';
    const timer = setTimeout(() => reject(new Error(`server did not start in 20s\n${stderr}`)), 20_000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const match = /READY (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolveReady(Number(match[1]));
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => { stderr += chunk; });
  });
}

function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolveCall, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request(`${base}${path}`, {
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.byteLength) }
        : {},
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolveCall({
        status: res.statusCode ?? 0,
        text: Buffer.concat(chunks).toString('utf8'),
        headers: res.headers,
      }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nas-workflows-'));
  jobsRoot = join(dir, 'jobs');
  mkdirSync(join(jobsRoot, 'demo.flow-1', 'artifacts'), { recursive: true });
  writeFileSync(join(jobsRoot, 'demo.flow-1', 'artifacts', 'restart.json'), '{}');
  cliPath = join(dir, 'stub-cli.js');
  writeFileSync(cliPath, STUB, 'utf8');

  child = spawn(process.execPath, [serverPath, '--port', '0'], {
    cwd: resolve(here, '..', '..', '..', '..', '..'),
    env: {
      ...process.env,
      NAS_PYTHON: process.execPath,
      NAS_WORKFLOW_CLI: cliPath,
      NAS_WORKFLOW_JOBS: jobsRoot,
    },
    stdio: 'pipe',
  });
  const port = await waitForReady(child);
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  if (child) {
    child.kill('SIGKILL');
    child = null;
  }
});

test('the catalog comes from the executor, not from a hard-coded list', async () => {
  const { status, text } = await call('GET', '/api/workflows');
  assert.equal(status, 200);
  const body = JSON.parse(text) as { available: boolean; workflows: Array<{ id: string }>; capabilities: { api_version: string } };
  assert.equal(body.available, true);
  assert.deepEqual(body.workflows.map((row) => row.id), ['demo.flow']);
  assert.equal(body.capabilities.api_version, '1.0');
});

test('describe passes the spec through', async () => {
  const { status, text } = await call('GET', '/api/workflows/describe?id=demo.flow');
  assert.equal(status, 200);
  const body = JSON.parse(text) as { id: string; gate_steps: string[] };
  assert.equal(body.id, 'demo.flow');
  assert.deepEqual(body.gate_steps, ['gate']);
});

test('a bad workflow id is refused before spawning anything', async () => {
  const { status, text } = await call('GET', '/api/workflows/describe?id=../../evil');
  assert.equal(status, 400);
  assert.match(text, /id 不合法/);
});

test('a high-risk run returns 202 with the gate, never a fake success', async () => {
  const { status, text } = await call('POST', '/api/workflows/run', { id: 'demo.flow', params: {} });
  assert.equal(status, 202);
  const body = JSON.parse(text) as { job_id: string; status: string; gate: { kind: string; options: string[] } };
  assert.equal(body.status, 'waiting_approval');
  assert.equal(body.gate.kind, 'approval');
  assert.deepEqual(body.gate.options, ['approved', 'rejected']);
  assert.equal(body.job_id, 'demo.flow-1');
});

test('gate and resume answer 202 because the executor continues in the background', async () => {
  const gate = await call('POST', '/api/workflows/job/gate', {
    id: 'demo.flow-1', decision: 'approved', by: 'tester', note: 'ok',
  });
  assert.equal(gate.status, 202);
  assert.equal((JSON.parse(gate.text) as { detached: boolean }).detached, true);

  const resume = await call('POST', '/api/workflows/job/resume', {
    id: 'demo.flow-1', decision: 'done', by: 'tester', note: '',
  });
  assert.equal(resume.status, 202);
});

test('an invalid gate decision is a 400', async () => {
  const { status } = await call('POST', '/api/workflows/job/gate', {
    id: 'demo.flow-1', decision: 'maybe',
  });
  assert.equal(status, 400);
});

test('job status and artifacts are served from the executor', async () => {
  const status = await call('GET', '/api/workflows/job?id=demo.flow-1');
  assert.equal(status.status, 200);
  assert.equal((JSON.parse(status.text) as { status: string }).status, 'succeeded');

  const artifacts = await call('GET', '/api/workflows/job/artifacts?id=demo.flow-1');
  assert.equal(artifacts.status, 200);
  const list = (JSON.parse(artifacts.text) as { artifacts: Array<{ name: string }> }).artifacts;
  assert.deepEqual(list.map((row) => row.name), ['restart.json']);
});

test('artifact bytes are downloadable and traversal is refused', async () => {
  const ok = await call('GET', '/api/workflows/artifact?id=demo.flow-1&name=restart.json');
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '{}');

  const bad = await call('GET', '/api/workflows/artifact?id=demo.flow-1&name=..%2Fjob.json');
  assert.equal(bad.status, 400);
});

test('a missing executor is reported as unavailable, not as an empty catalog', async () => {
  const { WorkflowBridge } = await import('../src/workflows.ts');
  const bridge = new WorkflowBridge({ cli: join(tmpdir(), 'definitely-not-here.py') });
  const probe = bridge.probe();
  assert.equal(probe.available, false);
  assert.match(probe.reason, /找不到执行器入口/);
});
