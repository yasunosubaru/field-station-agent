/**
 * Workflow bridge — the hybrid half of the app.
 *
 * The reimplementation (B) covers the screens it has rebuilt; the original suite (A) still owns a
 * few operations B does not perform (firmware Update, the suite-level install/update pages). Those
 * gaps are fixed workflows under `workflows/`, run by the Python executor
 * (`tools/workflow_cli.py`, stdlib only). This module is the **only** thing in the Node app that
 * starts that executor, so the HTTP surface, the UI and the CLI all describe the same catalog.
 *
 * Why a subprocess and not a port: the executor is shared with the agent-facing CLI and with the
 * gate/receipt format already committed (`job.json`, `audit.jsonl`, sha256 artifacts). Re-porting
 * it to TypeScript would create a second implementation that drifts — exactly what the coverage
 * matrix exists to prevent. The Python runtime is the same one the deliverable already requires.
 *
 * Contract:
 *
 *   catalog()        capabilities + every workflow summary (no receiver contact)
 *   describe(id)     full spec (params, gates, steps)
 *   run(id, params)  starts a job; returns when it finishes or stops at a gate
 *   status(jobId)    job view (status, gate, failure, artifacts)
 *   gate/resume/cancel/artifacts/artifactBytes
 *
 * `run` is synchronous because the executor is: a high-risk workflow stops at its approval gate in
 * milliseconds, a Graph export finishes in seconds. `gate` and `resume` may continue into a long
 * step (firmware flash, receiver reboot), so those two are **detached**: the HTTP call returns as
 * soon as the worker is spawned and the UI polls `status`, which reads `job.json` from disk.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_DIR, HttpError } from './paths.ts';

export interface WorkflowCall {
  code: number;
  /** Parsed `--json` payload (null when the CLI printed nothing). */
  data: Record<string, unknown> | null;
  stderr: string;
}

export interface WorkflowBridgeOptions {
  python?: string;
  cli?: string;
  jobsRoot?: string;
  repo?: string;
  timeoutMs?: number;
}

const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{2,120}$/;
const WORKFLOW_ID_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const ARTIFACT_RE = /^[^\\/]+$/;

export class WorkflowBridge {
  readonly repo: string;
  readonly python: string;
  readonly cli: string;
  readonly jobsRoot: string;
  readonly timeoutMs: number;

  constructor(options: WorkflowBridgeOptions = {}) {
    this.repo = options.repo ?? REPO_DIR;
    this.python = options.python ?? process.env.NAS_PYTHON ?? 'python';
    this.cli = options.cli ?? process.env.NAS_WORKFLOW_CLI ?? join(this.repo, 'tools', 'workflow_cli.py');
    this.jobsRoot = options.jobsRoot ?? process.env.NAS_WORKFLOW_JOBS ?? join(this.repo, 'workflows', 'jobs');
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  /**
   * Can this build run workflows at all? Only filesystem facts — no spawn, so `/api/workflows` is
   * cheap even when Python is missing. The real error (if any) surfaces on the first call.
   */
  probe(): { available: boolean; reason: string; python: string; cli: string; jobsRoot: string } {
    const missing: string[] = [];
    if (!existsSync(this.cli)) missing.push(`找不到执行器入口 ${this.cli}`);
    if (missing.length) {
      return {
        available: false,
        reason: missing.join('；'),
        python: this.python,
        cli: this.cli,
        jobsRoot: this.jobsRoot,
      };
    }
    return { available: true, reason: '', python: this.python, cli: this.cli, jobsRoot: this.jobsRoot };
  }

  async catalog(): Promise<Record<string, unknown>> {
    const [capabilities, workflows] = await Promise.all([
      this.call(['capabilities']),
      this.call(['list']),
    ]);
    return {
      ...this.probe(),
      capabilities: capabilities.data,
      workflows: workflows.data,
    };
  }

  async describe(id: string): Promise<Record<string, unknown>> {
    return (await this.call(['describe', assertWorkflowId(id)])).data ?? {};
  }

  async run(id: string, params: Record<string, unknown> = {}): Promise<WorkflowCall> {
    return this.call(['run', assertWorkflowId(id), '--params-json', JSON.stringify(params)]);
  }

  async status(jobId: string): Promise<Record<string, unknown>> {
    return (await this.call(['status', assertJobId(jobId)])).data ?? {};
  }

  gate(jobId: string, decision: string, by: string, note: string): WorkflowCall & { detached: boolean } {
    return this.detach(['gate', assertJobId(jobId), '--decision', assertDecision(decision, ['approved', 'rejected']), '--by', safeActor(by), '--note', safeNote(note)]);
  }

  resume(jobId: string, decision: string, by: string, note: string): WorkflowCall & { detached: boolean } {
    return this.detach(['resume', assertJobId(jobId), '--decision', assertDecision(decision, ['done', 'failed']), '--by', safeActor(by), '--note', safeNote(note)]);
  }

  async cancel(jobId: string, reason: string, by: string): Promise<Record<string, unknown>> {
    const result = await this.call(['cancel', assertJobId(jobId), '--reason', safeNote(reason), '--by', safeActor(by)]);
    return result.data ?? {};
  }

  async artifacts(jobId: string): Promise<Record<string, unknown>[]> {
    const data = (await this.call(['artifacts', assertJobId(jobId)])).data;
    return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  }

  /**
   * 最近跑过的作业。
   *
   * 为什么要这一条：三条固定流程（gui.app.install / gui.app.update /
   * gui.suite.autoupdate）的结果以 `kind: artifact` 落盘，但 UI 上没有任何入口
   * 能列出它们——只有知道 job id 才看得到，等于「跑完了但结果不属于任何人」。
   * Python 侧已有 `list_jobs(limit, status)`，这里只是把它透出来。
   */
  async jobs(limit = 20, status?: string): Promise<Record<string, unknown>[]> {
    const args = ['jobs', '--limit', String(Math.max(1, Math.min(200, Number(limit) || 20)))];
    if (status) {
      // 只允许作业状态词，不让任意字符串进命令行参数。
      const ok = /^[a-z_]{1,24}$/.test(status);
      if (!ok) throw new HttpError(400, `不合法的作业状态：${status}`);
      args.push('--status', status);
    }
    const data = (await this.call(args)).data;
    return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  }

  /** Raw bytes of one artifact, resolved through the executor's own artifacts directory. */
  artifactBytes(jobId: string, name: string): Buffer {
    assertJobId(jobId);
    if (typeof name !== 'string' || !ARTIFACT_RE.test(name) || name === '.' || name === '..') {
      throw new HttpError(400, `产物名不合法：${String(name)}`);
    }
    const path = join(this.jobsRoot, jobId, 'artifacts', name);
    if (!existsSync(path)) throw new HttpError(404, `没有产物 ${name}`);
    return readFileSync(path);
  }

  // ------------------------------------------------------------------ internals
  private async call(args: string[]): Promise<WorkflowCall> {
    const probe = this.probe();
    if (!probe.available) throw new HttpError(503, probe.reason);
    const full = [...args, '--json', '--jobs-root', this.jobsRoot];
    return new Promise((resolve, reject) => {
      execFile(
        this.python,
        [this.cli, ...full],
        {
          cwd: this.repo,
          timeout: this.timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          encoding: 'utf8',
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONPATH: join(this.repo, 'src') + pathSep() + (process.env.PYTHONPATH ?? '') },
        },
        (error, stdout, stderr) => {
          const code = typeof (error as { code?: unknown })?.code === 'number'
            ? ((error as { code: number }).code)
            : 0;
          let data: Record<string, unknown> | null = null;
          const text = (stdout ?? '').trim();
          if (text) {
            try {
              data = JSON.parse(text) as Record<string, unknown>;
            } catch {
              return reject(new HttpError(502, `执行器输出不是 JSON：${text.slice(0, 300)}`));
            }
          }
          const message = (stderr ?? '').trim();
          if (error && code !== 0 && code !== 3) {
            if (code === 2) return reject(new HttpError(400, message || (data?.error as string) || '参数不合法'));
            if (code === 1) return resolve({ code, data, stderr: message }); // failed job: the view is the answer
            if (code === 127 || (error as NodeJS.ErrnoException).code === 'ENOENT') {
              return reject(new HttpError(503, `找不到 Python（${this.python}）；设 NAS_PYTHON 指向解释器`));
            }
            return reject(new HttpError(500, message || `执行器退出码 ${code}`));
          }
          resolve({ code, data, stderr: message });
        },
      );
    });
  }

  private detach(args: string[]): WorkflowCall & { detached: boolean } {
    const probe = this.probe();
    if (!probe.available) throw new HttpError(503, probe.reason);
    const child = spawn(this.python, [this.cli, ...args, '--json', '--jobs-root', this.jobsRoot], {
      cwd: this.repo,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONPATH: join(this.repo, 'src') + pathSep() + (process.env.PYTHONPATH ?? '') },
    });
    child.unref();
    return { code: 0, data: null, stderr: '', detached: true };
  }
}

function pathSep(): string {
  return process.platform === 'win32' ? ';' : ':';
}

export function assertWorkflowId(id: unknown): string {
  if (typeof id !== 'string' || !WORKFLOW_ID_RE.test(id)) {
    throw new HttpError(400, `工作流 id 不合法：${String(id)}`);
  }
  return id;
}

export function assertJobId(id: unknown): string {
  if (typeof id !== 'string' || !JOB_ID_RE.test(id)) {
    throw new HttpError(400, `job_id 不合法：${String(id)}`);
  }
  return id;
}

function assertDecision(value: unknown, allowed: string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new HttpError(400, `decision 必须是 ${allowed.join(' / ')} 之一`);
  }
  return value;
}

function safeActor(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, 80) || 'operator';
}

function safeNote(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, 500);
}
