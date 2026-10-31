/**
 * Preview server for the Configuration pages (A1, first half).
 *
 * `ConfigHost` renders a page into a minidom document and returns HTML; this server wraps that
 * HTML in a page that also serves the **shipped** stylesheets, so what the browser shows is the
 * original markup + the original CSS. It exists to look at the adapter's output without touching
 * `server.ts` (which owns the real API), and it is the place the `/api/config/*` handlers will be
 * lifted from once the menu is wired.
 *
 *   node packages/app/src/config-preview.ts --port 7793
 *   http://127.0.0.1:7793/            → index of the 14 pages
 *   http://127.0.0.1:7793/p/portConfig
 *
 * Read-only: it never talks to a receiver, so the rows stay empty (the shipped fragments are
 * skeletons; the controller fills them when configuration records arrive).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { ConfigHost, CONFIG_PAGE_NAMES, type ConfigCommand } from './config-host.ts';

const here = dirname(fileURLToPath(import.meta.url));
const IMPL_DIR = resolve(here, '..', '..', '..');
const REPO_DIR = resolve(IMPL_DIR, '..', '..');
const APP_ROOT = join(REPO_DIR, '逆向', '01_解包', 'app');
const DATA_DIR = resolve(here, '..', '..', 'protocol', 'data');
const VIEW_ROOT = join(APP_ROOT, 'view');

const STYLES = [
  'css/bootstrap.min.css',
  'css/pagination.css',
  'css/style.css',
];

const MIME: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.html': 'text/html; charset=utf-8',
};

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? String(process.argv[at + 1]) : fallback;
}

const PAGE_LABELS: Record<string, string> = {
  positionConfig: 'Positioning',
  portConfig: 'Ports',
  loggingConfig: 'Logging',
  alignConfig: 'Align',
  spanConfig: 'SPAN',
  radioConfig: 'Radio',
  gnssConfig: 'GNSS',
  spoofingConfiguration: 'Spoofing',
  networkingSettings: 'Networking',
  generalSettings: 'General',
  languageSettings: 'Language',
  spanInstallation: 'SPAN Installation',
  lghnPositionConfig: 'Longhorn Positioning',
  lghnLoggingConfig: 'Longhorn Logging',
};

/** One host per page request: the controller is stateful and the preview is read-only. */
function render(name: string): { html: string; commands: ConfigCommand[] } {
  const host = new ConfigHost({ appRoot: APP_ROOT, dataDir: DATA_DIR });
  const page = host.show(name);
  host.select(name);
  return { html: host.html(), commands: host.takeCommands() };
}

function wrap(title: string, body: string): string {
  const links = STYLES.map((href) => `<link rel="stylesheet" href="/view/${href}">`).join('\n');
  const nav = CONFIG_PAGE_NAMES.map(
    (name) => `<a href="/p/${name}"${name === title ? ' class="is-current"' : ''}>${PAGE_LABELS[name] ?? name}</a>`,
  ).join(' · ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
${links}
<style>
  body { margin: 0; background: #ffffff; }
  .preview-nav { padding: 8px 14px; background: #1f1f1f; color: #dcdcdc; font: 13px/1.5 "Segoe UI", sans-serif; }
  .preview-nav a { color: #cfcfcf; text-decoration: none; }
  .preview-nav a:hover { color: #ffffff; }
  .preview-nav a.is-current { color: #ffffff; font-weight: 600; }
  .preview-body { padding: 12px 18px 40px; }
</style></head>
<body><div class="preview-nav">${nav}</div><div class="preview-body">${body}</div></body></html>`;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(pathname: string, res: ServerResponse): void {
  const relative = pathname.replace(/^\/view\//, '');
  const file = join(VIEW_ROOT, relative);
  if (!file.startsWith(VIEW_ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    send(res, 404, 'not found', 'text/plain; charset=utf-8');
    return;
  }
  send(res, 200, readFileSync(file), MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
}

const port = Number(arg('port', '7793'));
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const path = url.pathname;
  if (path.startsWith('/view/')) {
    serveStatic(path, res);
    return;
  }
  if (path === '/' || path === '/index.html') {
    const list = CONFIG_PAGE_NAMES.map(
      (name) => `<li><a href="/p/${name}">${PAGE_LABELS[name] ?? name}</a> <code>${name}</code></li>`,
    ).join('');
    send(res, 200, wrap('Configuration preview', `<h3>Configuration pages (${CONFIG_PAGE_NAMES.length})</h3><ul>${list}</ul>`), 'text/html; charset=utf-8');
    return;
  }
  const match = /^\/p\/([A-Za-z]+)$/.exec(path);
  if (match) {
    const name = match[1];
    if (!CONFIG_PAGE_NAMES.includes(name as never)) {
      send(res, 404, `unknown page ${name}`, 'text/plain; charset=utf-8');
      return;
    }
    try {
      const { html } = render(name);
      send(res, 200, wrap(name, html), 'text/html; charset=utf-8');
    } catch (error) {
      send(res, 500, String(error instanceof Error ? error.stack : error), 'text/plain; charset=utf-8');
    }
    return;
  }
  send(res, 404, 'not found', 'text/plain; charset=utf-8');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`config preview on http://127.0.0.1:${port}/  (pages: ${CONFIG_PAGE_NAMES.length})`);
});
