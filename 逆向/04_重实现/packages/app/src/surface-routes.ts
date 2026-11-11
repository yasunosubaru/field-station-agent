/**
 * 编队 / 数据 / 套件三个视角的 HTTP 出口（视-2 / 视-3 / 视-4 的后端）。
 *
 * ## 为什么是「一条通道」而不是三条
 *
 * `agent-bridge.ts` 已经负责「拉起 `tools/agent_server.py` 并用 Bearer token 走
 * HTTP」。编队（botd）、数据（Parquet 批次 + Text-to-SQL）、套件（字段对照表）三者
 * 的业务实现**全在 Python 侧**（`src/fieldstation/botd/**`、`src/fieldstation/data/**`、
 * `tools/eval30_judge.py`）。为它们各起一个新进程，就会得到三条各自维护启动参数、
 * token、端口与失败语义的通道 —— 那正是 `agent-bridge.ts` 头顶那段注释要避免的事。
 *
 * 所以这里只做**转发**：`/api/botd/*` `/api/data/*` `/api/suite/*` 各自映射到
 * agent server 的 `/board/*` `/data/*` `/suite/*`，一条桥、一份 token、一套 503 语义。
 *
 * ## 为什么路径要重写
 *
 * 前端写死的是 `/api/botd/forest`、`/api/data/batches`、`/api/suite/field-parity`
 * （见 `web/views/fleet.js::BOTD_ENDPOINTS` / `data.js::DATA_ENDPOINTS` /
 * `suite.js::INSPECTOR_ENDPOINT`）。Python 侧不叫 `botd` 是因为那张看板的后端叫
 * `InteractionBoard`，不是 `botd`；`/board/` 与 `/data/` 在 agent server 里是同一个
 * 命名空间下的一级段，重写表集中在下面这一处 `FORWARD`，改口径只改一行。
 *
 * ## 只读的边界
 *
 * 三个视角里只有 `/api/botd/intervene` 是写操作（写 `intervention` 表）；其余全是
 * 读。写操作也走同一条桥，但**不做**任何重试：一条干预被重复写两次就是两条审计
 * 记录，而审计记录不允许改写（`interaction.py::resolve` 的注释）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { AgentBridge, AgentUnavailableError } from './agent-bridge.ts';
import { HttpError } from './paths.ts';

/** 转发的一对：本服务路径前缀 → agent server 路径前缀。 */
interface Forward {
  /** `/api/botd` */
  readonly mount: string;
  /** `/board` */
  readonly upstream: string;
  /** 允许的方法；不是这里列出的就是 405。 */
  readonly methods: readonly string[];
}

/**
 * 三张转发表。**顺序无关**（前缀互不包含），但每条的 `upstream` 必须与
 * `tools/agent_server.py::AgentHandler._route` 认得的段一致。
 */
const FORWARD: readonly Forward[] = [
  { mount: '/api/botd', upstream: '/board', methods: ['GET', 'POST'] },
  { mount: '/api/data', upstream: '/data', methods: ['GET'] },
  { mount: '/api/suite', upstream: '/suite', methods: ['GET'] },
];

/** 这条路径归哪个视角管；不归任何一个就返回 `null`（交给后面的 `/api/` 兜底）。 */
function forwardFor(pathname: string): Forward | null {
  for (const entry of FORWARD) {
    if (pathname === entry.mount || pathname.startsWith(`${entry.mount}/`)) return entry;
  }
  return null;
}

/** 请求体上限：与 `agent-bridge.ts` 的 `BODY_LIMIT` 同源，避免两边不一致。 */
const BODY_LIMIT = 1_000_000;

export interface SurfaceContext {
  bridge: AgentBridge;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  method: string;
}

function sendJson(res: ServerResponse, status: number, payload: unknown, method = 'GET'): void {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.byteLength;
    if (size > BODY_LIMIT) throw new HttpError(413, '请求体过大');
    chunks.push(buf);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/**
 * 这条路径的上游回答是不是**不是 JSON 对象**。
 *
 * 只有 `/suite/field-parity` 一处：它是 markdown（`suite.js` 直接 `response.text()`
 * 再交给 `parseParityMarkdown`）。`/board/events` 现在是对象（`{ok, events, task_id}`），
 * 走 `requestJson` 就能被 Node 侧校验一次形状 —— 这一条判断集中在这里，不散在调用点。
 */
function isRawResponse(upstreamPath: string): boolean {
  return upstreamPath.split('?')[0] === '/suite/field-parity';
}

/**
 * 转发一条请求。`/api/botd/forest` → 上游 `/board/forest`，查询串原样带过去
 * （`task_id` / `batch` / `q` 都由 Python 侧校验，Node 不重复实现一遍口径）。
 *
 * 上游的非 2xx **原样返回**：`404 任务不存在`、`400 takeover 需要审批` 都是这个
 * 接口的正常回答，改写成 500 会把「请求不合法」说成「服务坏了」。
 */
async function relay(context: SurfaceContext, entry: Forward): Promise<void> {
  const { bridge, req, res, url, method } = context;
  const tail = url.pathname.slice(entry.mount.length);
  const upstreamPath = `${entry.upstream}${tail}${url.search}`;

  if (!entry.methods.includes(method)) {
    throw new HttpError(405, `${url.pathname} 只接受 ${entry.methods.join(' / ')}`);
  }

  let body: Record<string, unknown> | undefined;
  if (method === 'POST') body = await readJsonObject(req);

  if (isRawResponse(upstreamPath) && method === 'GET') {
    // 裸数组 / markdown：字节原样过去，不经过 JSON 解一轮再序列化一轮。
    const raw = await bridge.requestRaw('GET', upstreamPath);
    res.writeHead(raw.status, {
      'Content-Type': raw.contentType,
      'Content-Length': raw.body.byteLength,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(raw.body);
    return;
  }

  const result = await bridge.requestJson(method, upstreamPath, body);
  sendJson(res, result.status, result.data, method);
}

/**
 * 挂载点：`server.ts` 在 `/api/` 的 404 兜底**之前**调用它，并且只在
 * `forwardFor(path) !== null` 时调用 —— 这样 `/api/agent/*` 与其余既有接口
 * 一个字节都不受影响。
 */
export async function handleSurfaceRoute(context: SurfaceContext): Promise<void> {
  const entry = forwardFor(context.url.pathname);
  if (!entry) {
    // 调用方本该先判断；走到这里说明路由顺序变了，按未知道歉比静默 404 好。
    throw new HttpError(404, `未知接口：${context.url.pathname}`);
  }
  const { bridge, res, method } = context;
  try {
    await relay(context, entry);
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    if (error instanceof AgentUnavailableError) {
      sendJson(res, 503, {
        ok: false,
        error: `agent server unavailable: ${bridge.redact(error.reason)}`,
      }, method);
      return;
    }
    if (error instanceof HttpError) {
      sendJson(res, error.status, { ok: false, error: error.message }, method);
      return;
    }
    throw error;
  }
}

/** `/api/health.endpoints` 要列出来的路径；顺序即文档顺序。 */
export const SURFACE_ENDPOINTS: readonly string[] = [
  '/api/botd/forest',
  '/api/botd/tree',
  '/api/botd/events',
  '/api/botd/pending',
  '/api/botd/intervene',
  '/api/data/batches',
  '/api/data/quality',
  '/api/data/search',
  '/api/data/eval',
  '/api/suite/field-parity',
];

/** 这条路径是不是本模块管的（`server.ts` 用它决定是否交给这里）。 */
export function isSurfacePath(pathname: string): boolean {
  return forwardFor(pathname) !== null;
}
