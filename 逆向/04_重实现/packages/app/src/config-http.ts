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
 *
 * The Device menu's `.cfg` half lives here too (`deviceStatus`, `deviceImportPreview`,
 * `deviceImportApply`): it reuses `configurationFile.ts` and states plainly which half of the
 * export/import round trip this build can and cannot complete.
 */

import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  ALL_PAGE_NAMES,
  CONFIG_PAGE_NAMES,
  OPERATIONAL_PAGE_NAMES,
  ConfigHost,
  type ConfigCommand,
} from './config-host.ts';
import type { ConfigOperationsHost } from '../../view/src/config/index.ts';
import {
  filterLoadCommands,
  formatConfigurationFileName,
  chooseIOPortDetails,
  SAVE_LOG_COMMANDS,
  transformSavedConfigLines,
  versionMismatch,
  type ConfigLoadOptions,
} from '../../view/src/config/configurationFile.ts';

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
  events: 'Events',
};

/* ------------------------------------------------------------------ the `.cfg` file host */

/**
 * `ConfigPageContext.operations.files`, backed by memory: a browser page has no file dialogs, and
 * the `.cfg` drivers only need somewhere to write the file they assemble.
 */
export class ConfigFiles {
  readonly files = new Map<string, string>();

  defaultDocuments(): string {
    return '/NovAtelData/Download Configuration';
  }

  readText(path: string): string {
    return this.files.get(path) ?? '';
  }

  writeText(path: string, data: string, options?: { append?: boolean }): void {
    const previous = options?.append ? (this.files.get(path) ?? '') : '';
    this.files.set(path, previous + data);
  }

  exists(path: string): boolean {
    return this.files.has(path);
  }

  ensureDirectory(): void {
    // Flat map: no directories to create.
  }

  /** Newest `.cfg` this process wrote, with its text. */
  latestConfiguration(): { fileName: string; text: string } | undefined {
    let newest: { fileName: string; text: string } | undefined;
    for (const [path, text] of this.files) {
      if (!path.toLowerCase().endsWith('.cfg')) continue;
      const fileName = path.slice(path.lastIndexOf('/') + 1);
      newest = { fileName, text };
    }
    return newest;
  }

  reset(): void {
    this.files.clear();
  }
}

export const configFiles = new ConfigFiles();

const CONFIG_OPERATIONS: ConfigOperationsHost = { files: configFiles };

/* ------------------------------------------------------------------------- page registry */

/** One host per page: each GET/event round-trip must see the state the previous one left. */
const hosts = new Map<string, ConfigHost>();

function newHost(): ConfigHost {
  return new ConfigHost({
    appRoot: APP_ROOT,
    dataDir: DATA_DIR,
    operations: CONFIG_OPERATIONS,
  });
}

function host(name: string): ConfigHost {
  let existing = hosts.get(name);
  if (existing) return existing;
  existing = newHost();
  if (OPERATIONAL_PAGE_NAMES.includes(name as never)) {
    // `events` has no pill of its own: it mounts into `#events-panel-<tab>` and is the only page
    // on this document, so there is no tab to switch.
    existing.showOperational(name);
  } else {
    existing.show(name);
    // Same two steps the menu performs (Status → Configuration, then pick the page); without them
    // the pane stays `display:none` and the iframe shows an empty document.
    existing.select(name);
  }
  hosts.set(name, existing);
  return existing;
}

export function isConfigPage(name: string): boolean {
  return (ALL_PAGE_NAMES as readonly string[]).includes(name);
}

export function configPageList(): Array<{ name: string; label: string; operational: boolean }> {
  return ALL_PAGE_NAMES.map((name) => ({
    name,
    label: CONFIG_LABELS[name] ?? name,
    operational: (OPERATIONAL_PAGE_NAMES as readonly string[]).includes(name),
  }));
}

/* ------------------------------------------------------------------------- the document */

/** The `#shell` subtree only: the browser swaps it in place, so delegated listeners survive. */
function shellOf(name: string): string {
  return host(name).elementHtml('#shell') ?? '';
}

/** The Events drawer is a `position:fixed` panel: serve that panel instead of the whole shell. */
function eventsPanelOf(name: string): string {
  const instance = host(name);
  return instance.elementHtml(`#events-panel-${instance.tabId}`) ?? '';
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
    var el = event.target.closest('button, a, input[type=checkbox], input[type=radio], label, li');
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
  /* The Events drawer is fed by the live link; reload it when the server's real count changes. */
  if (page === 'events') {
    var shown = Number(document.body.getAttribute('data-event-count') || 0);
    setInterval(function () {
      fetch('/api/config/events/summary')
        .then(function (r) { return r.json(); })
        .then(function (body) {
          if (body && Number(body.count) !== shown) location.reload();
        })
        .catch(function () {});
    }, 2500);
  }
})();
`;

/** The standalone page the Configuration drawer embeds in an iframe. */
export function configPageDocument(name: string): string {
  const links = STYLES.map((href) => `<link rel="stylesheet" href="/view/${href}">`).join('\n');
  const title = CONFIG_LABELS[name] ?? name;
  const operational = (OPERATIONAL_PAGE_NAMES as readonly string[]).includes(name);
  const body = operational ? eventsPanelOf(name) : shellOf(name);
  const eventCount = operational ? eventsSummary().count : 0;
  const extra = operational
    ? '  body { margin: 0; background: #ffffff; }\n  .events-panel { display: block !important; }'
    : [
        '  body { margin: 0; background: #ffffff; }',
        /* The drawer shows one page, not the whole Manage tab: the tab strip (and its close
         * button) would otherwise print "Add device / Remove Tab" above every page. */
        '  #tabs > .tabs-view-data { display: none !important; }',
        '  #tabs-1, #grit-tabs-1 { display: none !important; }',
        '  .main-view { margin: 0 !important; }',
        /* The shipped `#main-panel` reserves the height of the status band and menu bar above it;
         * this document has no status band, so the reserve would print as a 223 px hole. */
        '  .main-panel { margin-top: 0 !important; }',
        '  .events-panel:empty, .menuBar-panel:empty, .status-panel:empty { margin: 0 !important; }',
      ].join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
${links}
<style>
${extra}
</style></head>
<body data-config-page="${name}" data-event-count="${eventCount}">
${body}
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
  return {
    shell: (OPERATIONAL_PAGE_NAMES as readonly string[]).includes(name)
      ? eventsPanelOf(name)
      : shellOf(name),
    applied,
    commands: target.takeCommands(),
  };
}

/** Commands queued by every page since the last call (the caller writes them to the live link). */
export function takeConfigCommands(): ConfigCommand[] {
  const out: ConfigCommand[] = [];
  for (const instance of hosts.values()) out.push(...instance.takeCommands());
  return out;
}

/* --------------------------------------------------------------- Events: real records only */
/**
 * Feed one live ASCII record into the Events page. `RXSTATUSEVENTA` is a *text* event whose
 * description is the quoted token; `events.ts` turns exactly two of them into entries
 * (`MODEL INVALID FOR THIS RECEIVER`, `INVALID AUTHORIZATION CODE`). Anything else is dropped here
 * rather than guessed at.
 */
export function feedEventsAscii(ascii: string): string[] {
  const instance = hosts.get('events');
  if (!instance) return [];
  return instance.feedAscii(94, ascii);
}

/** Highest live-link cursor already offered to the Events page (so a replay never doubles). */
let lastEventSeq = 0;

/**
 * Push records the live link already decoded (its `ascii` line is what the event carries).
 * Entries are consumed by their `seq`, so the panel's poll loop and the page's own replay can both
 * call this without creating the same event twice.
 */
export function feedEventsFromEntries(
  entries: Array<{ seq?: number; messageId: number; ascii?: string }>,
): number {
  if (!hosts.get('events')) return 0; // no page to feed; leave the cursor untouched
  let fed = 0;
  let highest = lastEventSeq;
  for (const entry of entries) {
    const seq = Number(entry.seq ?? 0);
    if (seq > 0 && seq <= lastEventSeq) continue;
    if (entry.messageId === 94 && entry.ascii && feedEventsAscii(entry.ascii).length) fed += 1;
    if (seq > highest) highest = seq;
  }
  lastEventSeq = highest;
  return fed;
}

/**
 * Before the Events document is serialised, replay the RXSTATUSEVENT records the live link is
 * still holding — otherwise the page would only show what arrives *after* it was opened. The
 * records are the receiver's own; nothing is synthesised when the buffer has none.
 */
export function primeEventsPage(
  entries: Array<{ seq?: number; messageId: number; ascii?: string }>,
): number {
  host('events');
  return feedEventsFromEntries(entries);
}

/** Live event count, so the Events drawer can tell when its document is stale. */
export function eventsSummary(): { ok: true; count: number } {
  const instance = hosts.get('events');
  return { ok: true, count: instance ? instance.eventCount() : 0 };
}

/* ------------------------------------------------------------------- Device ▸ .cfg */

export interface CfgCapability {
  /** Can the operation run in this session? */
  available: boolean;
  /** Plain-language reason, shown verbatim on the page (`--` state when not available). */
  reason: string;
}

export interface DeviceStatus {
  ok: true;
  connected: boolean;
  export: CfgCapability & { records: number };
  import: CfgCapability & { previewAvailable: boolean };
  /** The file name the suite would use for this model. */
  suggestedFileName: string;
}

/** Receiver records that can become `.cfg` lines (`LOG RXCONFIG` and friends). */
export function countConfigurationRecords(
  entries: Array<{ name?: string; ascii?: string }>,
): number {
  let count = 0;
  for (const entry of entries) {
    const name = saveLogNameOf(String(entry.name ?? ''));
    if (!name || !SAVE_LOG_NAMES.includes(name)) continue;
    if (!configurationLineOf(String(entry.ascii ?? ''))) continue;
    count += 1;
  }
  return count;
}

/**
 * What the two `.cfg` buttons may do right now.
 *
 * **Export** is a download whenever the link holds the receiver's own configuration records — the
 * file is generated with the same `transformSavedConfigLines` the desktop save flow uses.
 *
 * **Import** is refused, and the page says so. The task's order is "disconnect first, write, then
 * read back and verify": this app can frame the write, but the verification needs the receiver's
 * `<OK` / `<ERR` command responses, which the live link does not surface (`LiveEntry` carries
 * decoded logs only). Writing receiver settings that can never be checked is exactly the kind of
 * silent state change the rest of this build refuses to make, so the button stays disabled with
 * the reason instead of pretending.
 */
export function deviceStatus(
  connected: boolean,
  entries: Array<{ name?: string; ascii?: string }> = [],
): DeviceStatus {
  const suggestedFileName = formatConfigurationFileName('OEM729', new Date());
  const records = countConfigurationRecords(entries);
  const assembled = configFiles.latestConfiguration() !== undefined;

  let exportReason: string;
  if (assembled || records > 0) {
    exportReason = assembled
      ? 'A configuration file assembled by the save driver is ready to download.'
      : `${records} receiver configuration record(s) are on the link; the download is generated from them.`;
  } else if (!connected) {
    exportReason =
      'No live receiver session: a .cfg is the receiver’s own configuration, so there is nothing to ' +
      'read it from. Connect a receiver and let it answer LOG RXCONFIG / LOG SERIALCONFIG first.';
  } else {
    exportReason =
      'Connected, but the receiver has not answered the configuration logs yet (LOG RXCONFIG, ' +
      'LOG SERIALCONFIG, LOG VERSION, …). A .cfg is generated from those answers, never from ' +
      'assumptions, so the download stays disabled until the first one arrives.';
  }

  const importReason = !connected
    ? 'No live receiver session: the configuration would have nowhere to go.'
    : 'Refused on this link: the write could be framed, but the read-back verification cannot be ' +
      'performed — the live link exposes decoded logs only (packages/app/src/live.ts), not the ' +
      'receiver’s <OK/<ERR command responses. A configuration that cannot be verified is not written.';

  return {
    ok: true,
    connected,
    export: { available: assembled || records > 0, reason: exportReason, records },
    import: { available: false, reason: importReason, previewAvailable: true },
    suggestedFileName,
  };
}

export interface CfgParseResult {
  ok: boolean;
  /** Lines the loader would send, in file order. */
  commands: string[];
  /** Comment / RESET / SAVECONFIG / current-port lines `filterLoadCommands` drops. */
  skipped: number;
  /** Lines that are comments carrying a VERSION block. */
  comments: number;
  /** Differences `versionMismatch` would warn about before loading. */
  mismatches: string[];
  /** The port whose own CONFIG line the loader skips; `''` = not known (nothing is skipped for it). */
  currentPort: string;
  /** `Firmware version` and friends that made the list, for the confirmation dialog. */
  reason?: string;
  error?: string;
}

/**
 * Parse an OEM `.cfg` exactly as `LoadConfigurationDriver.start` does, without sending anything:
 * the same `filterLoadCommands` for the wire list and `versionMismatch` for the pre-flight warning.
 * This half needs no receiver, so it runs even when the Import button is disabled.
 */
export function deviceImportPreview(
  text: string,
  versions: ConfigLoadOptions['versions'] = {
    hardwareVersion: 'OEM729',
    model: 'OEM729',
    softwareVersion: '',
  },
  currentPort = '',
): CfgParseResult {
  if (typeof text !== 'string' || !text.trim()) {
    return {
      ok: false,
      commands: [],
      skipped: 0,
      comments: 0,
      mismatches: [],
      currentPort,
      error: 'the file is empty',
    };
  }
  const lines = text.split(/\r?\n/);
  /* `filterLoadCommands` drops the line of the port the receiver is connected on, because changing
   * that port's own SERIALCONFIG would cut the link mid-load. With no connected port that rule has
   * no subject, so a token no `.cfg` line can contain keeps those lines in the preview. */
  const port = currentPort || '\u0000no-connected-port';
  const commands = filterLoadCommands(text, port);
  const comments = lines.filter((line) => line.trim().startsWith('/*')).length;
  const mismatches: string[] = [];
  for (const line of lines) mismatches.push(...versionMismatch(line.trim(), versions));
  const unique = [...new Set(mismatches)];
  return {
    ok: commands.length > 0,
    commands,
    skipped: lines.filter((line) => line.trim()).length - commands.length,
    comments,
    mismatches: unique,
    currentPort,
    reason: commands.length
      ? undefined
      : 'Every line was a comment, RESET, SAVECONFIG or the current port’s own CONFIG line — nothing would be sent.',
    error: commands.length ? undefined : 'no loadable command in this file',
  };
}

export interface CfgApplyResult {
  ok: boolean;
  reason: string;
  sent: number;
  verified: boolean;
  preview: CfgParseResult;
}

/**
 * Apply a `.cfg`. The task's order is "disconnect first, write, then read back and verify" — the
 * last step is the one this build cannot do (see `deviceStatus`), and writing receiver settings
 * that can never be verified is exactly what an unverifiable operation must not do. So the call
 * refuses with the same reason the page shows, and never emits a half-applied configuration.
 */
export function deviceImportApply(
  text: string,
  connected: boolean,
  versions?: ConfigLoadOptions['versions'],
): CfgApplyResult {
  const preview = deviceImportPreview(text, versions);
  if (!preview.ok) {
    return { ok: false, reason: preview.error ?? 'nothing to load', sent: 0, verified: false, preview };
  }
  if (!connected) {
    return {
      ok: false,
      reason:
        'No live receiver session: the configuration would have nowhere to go. Import is disabled ' +
        'until a receiver is connected.',
      sent: 0,
      verified: false,
      preview,
    };
  }
  return {
    ok: false,
    reason:
      'Refused: the write can be framed, but the read-back verification cannot — the live link ' +
      'exposes decoded logs only (packages/app/src/live.ts), not the receiver’s command responses. ' +
      'A configuration that cannot be verified is not written.',
    sent: 0,
    verified: false,
    preview,
  };
}

/** The `.cfg` the Device menu downloads, built from what the app actually holds. */
export interface CfgExportResult {
  ok: boolean;
  fileName?: string;
  text?: string;
  reason?: string;
  /** Receiver records that contributed to the file. */
  records: number;
}

/** `LOG <name>` targets of the save flow, normalised (`'LOG RXCONFIG'` → `'RXCONFIG'`). */
const SAVE_LOG_NAMES = SAVE_LOG_COMMANDS.map((command) => command.replace(/^LOG\s+/, '').toUpperCase());

/** `<RXCONFIGA` / `<RXCONFIGB` → `RXCONFIG`: the receiver appends the ASCII/binary suffix. */
function saveLogNameOf(name: string): string {
  const upper = name.toUpperCase();
  return upper.replace(/[AB]$/, '');
}

/** The payload line `transformSavedConfigLines` can read, or `null` when the record is opaque. */
function configurationLineOf(ascii: string): string | null {
  const text = ascii.trim();
  if (!text) return null;
  /* Full ASCII is `<RXCONFIGA,<header>;<command …>*crc`: the command is the body after the last
   * `;`. Abbreviated ASCII (`<SERIALCONFIG COM1 …*crc`) is already the body. */
  const body = text.includes(';') ? text.slice(text.lastIndexOf(';') + 1) : text;
  const withoutCrc = body.replace(/\*[0-9a-fA-F]+\s*$/, '').trim();
  if (!withoutCrc || withoutCrc.startsWith('%')) return null;
  return withoutCrc.startsWith('<') ? withoutCrc : `<${withoutCrc}`;
}

/**
 * Build a `.cfg` from the receiver records a link is holding — the generating half of
 * `configurationFile.ts`, using the same `transformSavedConfigLines` the desktop save flow uses.
 *
 * Only records the receiver really emitted are considered (`LOG VERSION`, `LOG RXCONFIG`,
 * `LOG SERIALCONFIG`, …). A link that carries none of them yields no file at all rather than an
 * empty or invented one.
 */
export function buildCfgFromTranscript(
  entries: Array<{ name?: string; ascii?: string }>,
  portDetails: string[],
  fileName: string,
): CfgExportResult {
  const blocks = new Map<string, string[]>();
  let records = 0;
  for (const entry of entries) {
    const name = saveLogNameOf(String(entry.name ?? ''));
    if (!name || !SAVE_LOG_NAMES.includes(name)) continue;
    const line = configurationLineOf(String(entry.ascii ?? ''));
    if (!line) continue;
    if (!blocks.has(name)) blocks.set(name, []);
    blocks.get(name)!.push(line);
    records += 1;
  }
  if (!records) {
    return {
      ok: false,
      reason:
        'The live link is holding no configuration record: a .cfg is generated from the receiver’s ' +
        'answers to LOG RXCONFIG / LOG SERIALCONFIG / LOG VERSION, and none has arrived. Export ' +
        'becomes a download as soon as the receiver answers those logs.',
      records: 0,
    };
  }
  const lines: string[] = [];
  for (const [name, block] of blocks) {
    lines.push(...transformSavedConfigLines(block, name, portDetails));
  }
  const text = lines.length ? `${lines.join('\n')}\n` : '';
  if (!text) {
    return {
      ok: false,
      reason: `The ${records} record(s) on the link produced no configuration line (transformSavedConfigLines returned nothing).`,
      records,
    };
  }
  return { ok: true, fileName, text, records };
}

/**
 * The `.cfg` the Device menu offers, or why there is none.
 *
 * Two sources, in order: a file the save driver assembled in this process (when a link that
 * reports command responses makes that flow runnable), then a file generated from the receiver
 * records the link is holding right now.
 */
export function deviceExportFile(
  entries: Array<{ name?: string; ascii?: string }> = [],
): CfgExportResult {
  const assembled = configFiles.latestConfiguration();
  if (assembled) return { ok: true, fileName: assembled.fileName, text: assembled.text, records: -1 };
  return buildCfgFromTranscript(
    entries,
    chooseIOPortDetails('OEM729', 'OEM729', 'OEM729', false),
    formatConfigurationFileName('receiver', new Date()),
  );
}

/* --------------------------------------------------------------------------- assets */

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

export { CONFIG_PAGE_NAMES };
