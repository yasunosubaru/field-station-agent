/**
 * HTTP surface for the Configuration pages (A1): one `ConfigHost` per page, kept between the
 * initial GET and the form events the browser posts back.
 *
 * The browser gets the shipped markup plus the shipped stylesheets; a small delegated script sends
 * `{selector, value|checked|click}` to `POST /api/config/:page/event` and swaps the `#shell` subtree
 * with whatever comes back. The controller itself keeps running here (see `config-host.ts`), so a
 * page's state, its validation and the commands it frames are exactly the tested view-layer code.
 *
 * Commands the controller queues are drained by `takeConfigCommands()` and written to the live
 * link by the caller — this module never talks to a receiver itself.
 */

import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { ConfigHost, CONFIG_PAGE_NAMES, type ConfigCommand } from './config-host.ts';

const here = dirname(fileURLToPath(import.meta.url));
const IMPL_DIR = resolve(here, '..', '..', '..');
const REPO_DIR = resolve(IMPL_DIR, '..', '..');
export const APP_VIEW_DIR = join(REPO_DIR, '逆向', '01_解包', 'app', 'view');
const APP_ROOT = join(REPO_DIR, '逆向', '01_解包', 'app');
const DATA_DIR = resolve(here, '..', '..', 'protocol', 'data');

const STYLES = ['css/bootstrap.min.css', 'css/pagination.css', 'css/style.css'];

export const CONFIG_LABELS: Record<string, string> = {
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

/** One host per page: each GET/event round-trip must see the state the previous one left. */
const hosts = new Map<string, ConfigHost>();

function host(name: string): ConfigHost {
  let existing = hosts.get(name);
  if (!existing) {
    existing = new ConfigHost({ appRoot: APP_ROOT, dataDir: DATA_DIR });
    existing.show(name);
    // Same two steps the menu performs (Status → Configuration, then pick the page); without them
    // the pane stays `display:none` and the iframe shows an empty document.
    existing.select(name);
    hosts.set(name, existing);
  }
  return existing;
}

export function isConfigPage(name: string): boolean {
  return (CONFIG_PAGE_NAMES as readonly string[]).includes(name);
}

export function configPageList(): Array<{ name: string; label: string }> {
  return CONFIG_PAGE_NAMES.map((name) => ({ name, label: CONFIG_LABELS[name] ?? name }));
}

/** The `#shell` subtree only: the browser swaps it in place, so delegated listeners survive. */
function shellOf(name: string): string {
  return host(name).elementHtml('#shell') ?? '';
}

const CLIENT_SCRIPT = `
(function () {
  var page = document.body.getAttribute('data-config-page');
  function selectorOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '#' + el.id;
    var path = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      var name = el.nodeName.toLowerCase();
      var parent = el.parentNode;
      if (!parent) break;
      var index = Array.prototype.indexOf.call(parent.children, el) + 1;
      path.unshift(name + ':nth-child(' + index + ')');
      el = parent;
    }
    return path.length ? 'body > ' + path.join(' > ') : null;
  }
  function post(payload, done) {
    fetch('/api/config/' + page + '/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (body) {
      if (body && body.shell) {
        var shell = document.getElementById('shell');
        if (shell) shell.outerHTML = body.shell;
      }
      if (body && body.error) console.warn('config:', body.error);
      if (done) done(body);
    }).catch(function (error) { console.warn('config:', error); });
  }
  document.addEventListener('click', function (event) {
    var el = event.target.closest('button, a, input[type=checkbox], input[type=radio], label');
    if (!el) return;
    var selector = selectorOf(el);
    if (!selector) return;
    post({ selector: selector, click: true });
  }, true);
  document.addEventListener('change', function (event) {
    var el = event.target;
    if (!el || !el.matches('input, select, textarea')) return;
    var selector = selectorOf(el);
    if (!selector) return;
    post({ selector: selector, value: el.value, checked: el.checked });
  }, true);
})();
`;

/** The standalone page the Configuration drawer embeds in an iframe. */
export function configPageDocument(name: string): string {
  const links = STYLES.map((href) => `<link rel="stylesheet" href="/view/${href}">`).join('\n');
  const title = CONFIG_LABELS[name] ?? name;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
${links}
<style>
  body { margin: 0; background: #ffffff; }
  .config-preview-only { padding: 10px 16px; font: 13px/1.5 "Segoe UI", sans-serif; color: #555; }
</style></head>
<body data-config-page="${name}">
${shellOf(name)}
<script>${CLIENT_SCRIPT}</script>
</body></html>`;
}

export interface ConfigEventResult {
  shell: string;
  applied: boolean;
  commands: ConfigCommand[];
}

/** Apply one browser event; the shell comes back so the client can swap it in. */
export function applyConfigEvent(
  name: string,
  selector: string,
  event: { value?: unknown; checked?: boolean; click?: boolean },
): ConfigEventResult {
  const target = host(name);
  const applied = target.applyEvent(selector, event);
  return { shell: shellOf(name), applied, commands: target.takeCommands() };
}

/** Commands queued by every page since the last call (the caller writes them to the live link). */
export function takeConfigCommands(): ConfigCommand[] {
  const out: ConfigCommand[] = [];
  for (const instance of hosts.values()) out.push(...instance.takeCommands());
  return out;
}

export function configStylesheet(relative: string): { file: string; type: string } | null {
  const file = join(APP_VIEW_DIR, relative);
  if (!file.startsWith(APP_VIEW_DIR) || !existsSync(file)) return null;
  const MIME: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
  };
  return { file, type: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' };
}

export function readConfigAsset(relative: string): Buffer | null {
  const found = configStylesheet(relative);
  return found ? readFileSync(found.file) : null;
}
