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
  READ_ONLY_PAGES,
  TOOLS_PAGE_NAMES,
  ConfigHost,
  type ConfigCommand,
} from './config-host.ts';
import { MENU_PAGE_NAMES, type ConfigOperationsHost } from '../../view/src/config/index.ts';
import {
  ITK_RECORDS,
  itkRowsOf,
  type ItkCaptureSummary,
  type ItkRow,
} from '../../view/src/config/index.ts';
import { loadCapture, tables } from './capture.ts';
import { resolveCapture } from './paths.ts';
import { readRecords, readTextRecords } from './logs.ts';
import type { LiveCommandReply } from './live.ts';
import {
  CONFIG_MESSAGE_ID_SET,
  configSliceOf,
  createAccumulator,
  type ConfigAccumulator,
} from './config-feed.ts';
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
  deviceDetails: 'Device Details',
  /** §2.2.11: the shipped module is `deviceExport`, the window it draws is **Storage**. */
  deviceExport: 'Storage',
  /** §2.2.12: `deviceUpdate`, served read-only (see `config-host.ts#READ_ONLY_PAGES`). */
  deviceUpdate: 'Update',
  /** §2.2.7: the `spanInstallation` fragment under its own menu entry. */
  vehicleSetup: 'Vehicle Setup',
  /** §2.2.9: `View ▸ Tools ▸ Interference Toolkit` — detections from a capture, settings read and written over the link. */
  interferenceToolkit: 'Interference Toolkit',
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

/**
 * The six records Tools ▸ Interference Toolkit reads back (`ITDETECTCONFIG`, `ITWARNINGCONFIG`,
 * `ITSPECTRALANALYSIS`, `ITFRONTENDMODE`, `ITBANDPASSCONFIG`, `ITPROGFILTCONFIG`).
 *
 * Derived from the page's own table (`interferenceToolkit.ts#ITK_RECORDS`), not listed again here:
 * a record the page can write and read is the one it names, and this file must not be able to fall
 * behind it.
 */
const ITK_CONFIG_MESSAGE_IDS: ReadonlySet<number> = new Set(
  ITK_RECORDS.map((record) => record.messageId),
);

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

/**
 * Every page `/config/<name>` serves, in drawer order. `settings` marks the pages that live in the
 * tab's menu layouts (`Settings ▸ …`) rather than in the Configuration pill strip — the drawer
 * groups them apart so a reader can tell which menu a page belongs to.
 */
export function configPageList(): Array<{
  name: string;
  label: string;
  operational: boolean;
  settings: boolean;
  tools: boolean;
}> {
  return ALL_PAGE_NAMES.map((name) => ({
    name,
    label: CONFIG_LABELS[name] ?? name,
    operational: (OPERATIONAL_PAGE_NAMES as readonly string[]).includes(name),
    settings: (MENU_PAGE_NAMES as readonly string[]).includes(name),
    tools: (TOOLS_PAGE_NAMES as readonly string[]).includes(name),
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

/**
 * A Settings page is one `.menu-layouts` container inside the Manage tab (`Settings ▸ General…`),
 * so that container is what the drawer's document holds — wrapped in the `#shell` element the
 * client script swaps, so a form event can replace it in place. `null` for the pill pages, which
 * are served as the whole shell.
 */
function menuPanelOf(name: string): string | null {
  const instance = host(name);
  const id = instance.menuPanelId(name);
  if (!id) return null;
  const panel = instance.elementHtml(`#${id}`);
  return panel === null ? null : `<div id="shell">${panel}</div>`;
}

/** Whatever the drawer shows for `name`: the Events panel, a Settings layout, or the whole shell. */
function bodyOf(name: string): string {
  if ((OPERATIONAL_PAGE_NAMES as readonly string[]).includes(name)) return eventsPanelOf(name);
  return menuPanelOf(name) ?? shellOf(name);
}

const CLIENT_SCRIPT = `
(function () {
  var page = document.body.getAttribute('data-config-page');
  function pathOf(el) {
    /* Position inside #shell, which is exactly the subtree the server keeps: an id-less control
     * (a step's "Next", a dropdown item) has no CSS selector the server's small selector engine can
     * resolve, so the click would never reach the controller. The server reads the same indices
     * (ConfigHost.applyEvent, the '@i/j/k' form). */
    var shell = document.getElementById('shell');
    if (!shell || !el || !shell.contains(el)) return null;
    var path = [];
    while (el && el !== shell) {
      var parent = el.parentNode;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.children, el));
      el = parent;
    }
    return path;
  }
  /** '#id' when the element has one (stable across re-renders), otherwise the '#shell' index path. */
  function targetOf(el) {
    if (el.id) return '#' + el.id;
    var path = pathOf(el);
    return path && path.length ? '@' + path.join('/') : null;
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
      if (body && typeof body.note === 'string') setSessionNote(body.note);
      if (body && body.error) console.warn('config:', body.error);
      if (done) done(body);
    }).catch(function (error) { console.warn('config:', error); });
  }
  function setSessionNote(text) {
    var note = document.getElementById('config-session-note');
    if (!note) {
      note = document.createElement('p');
      note.id = 'config-session-note';
      note.className = 'config-session-note';
      document.body.insertBefore(note, document.body.firstChild);
    }
    note.textContent = text;
    note.hidden = !text;
  }
  document.addEventListener('click', function (event) {
    var el = event.target.closest('button, a, input[type=checkbox], input[type=radio], label, li');
    if (!el) return;
    var target = targetOf(el);
    if (!target) return;
    post({ selector: target, click: true });
  }, true);
  document.addEventListener('change', function (event) {
    var el = event.target;
    if (!el || !el.matches('input, select, textarea')) return;
    var target = targetOf(el);
    if (!target) return;
    post({ selector: target, value: el.value, checked: el.checked });
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
  /* Tools ▸ Interference Toolkit is read from a capture; the drawer names it in the page's URL.
   * The page cannot read a capture itself — it names it through the #itk-capture control and the
   * server does the read — and it prints its own summary, so nothing is written over the session
   * note here. The comparison is against the capture the page last read, because the drawer reuses
   * this iframe when the shell's capture changes. */
  if (page === 'interferenceToolkit') {
    var wanted = new URLSearchParams(location.search).get('capture') || '';
    var read = document.querySelector('#itk-detections[data-itk-capture]');
    var current = read ? read.getAttribute('data-itk-capture') : '';
    if (wanted !== current) post({ selector: '#itk-capture', value: wanted });

    /* The read-back and the receiver's answer, both from the live link's own endpoints:
     *  - /api/live/logs carries the rendered IT*CONFIG records the page asks for after a write
     *    (feeding them server-side is what re-renders the page; this poll only asks for the fresh
     *    panel);
     *  - /api/live/status carries the <OK / <ERROR:... each framed line was answered with, because
     *    LiveLink credits a reply to the line waiting for it. A line that starts with LOG is the
     *    read-back request, so it never masks the write's own answer. */
    var itkIds = ${JSON.stringify(ITK_RECORDS.map((record) => record.messageId))};
    var cursor = 0;
    var shownCommandId = -1;
    var shownReadback = '';
    setInterval(function () {
      fetch('/api/live/logs?after=' + cursor)
        .then(function (r) { return r.json(); })
        .then(function (body) {
          if (!body || !Array.isArray(body.entries)) return;
          if (body.cursor) cursor = Number(body.cursor);
          var fresh = body.entries.filter(function (entry) {
            return itkIds.indexOf(Number(entry.messageId)) >= 0;
          });
          if (!fresh.length) return;
          var stamp = fresh.map(function (entry) { return entry.seq + ':' + (entry.ascii || ''); }).join('|');
          if (stamp === shownReadback) return;
          shownReadback = stamp;
          post({ selector: '#itk-refresh' });
        })
        .catch(function () {});
      fetch('/api/live/status')
        .then(function (r) { return r.json(); })
        .then(function (body) {
          var commands = (body && body.commands) || [];
          for (var i = commands.length - 1; i >= 0; i--) {
            var entry = commands[i];
            var line = String((entry && entry.line) || '');
            if (!/^IT[A-Z]/i.test(line)) continue;
            var reply = entry && entry.reply;
            var id = Number((entry && entry.id) || 0);
            /* One post per answered line: the receiver says the same <OK to every command, so the
               command's own id — not its text — is what tells the page it is a new answer. */
            if (!reply || id <= shownCommandId) return;
            shownCommandId = id;
            post({ selector: '#itk-command-reply', value: reply });
            return;
          }
        })
        .catch(function () {});
    }, 1500);
  }
})();
`;

/** The standalone page the Configuration drawer embeds in an iframe. */
export function configPageDocument(name: string, options: { connected?: boolean } = {}): string {
  const links = STYLES.map((href) => `<link rel="stylesheet" href="/view/${href}">`).join('\n');
  const title = CONFIG_LABELS[name] ?? name;
  const operational = (OPERATIONAL_PAGE_NAMES as readonly string[]).includes(name);
  const body = bodyOf(name);
  const eventCount = operational ? eventsSummary().count : 0;
  // A page can be read without a receiver; it cannot send anything without one. The note says so
  // in the page rather than leaving an Apply button that would silently do nothing.
  const sessionNote = options.connected === false ? NO_SESSION_NOTE : '';
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
        /* `.menu-layouts` ships as `display:none` until its menu entry is clicked; this document
         * *is* the page, so the layout it holds is the visible one. */
        '  .menu-layouts { display: block !important; }',
        '  .config-session-note { margin: 0 0 8px; padding: 8px 12px; background: #fff4e5;',
        '    border-left: 3px solid #d98500; font: 13px/1.4 sans-serif; color: #4a3200; }',
        '  .config-readonly-note { margin: 0 0 10px; padding: 8px 12px; background: #fff4e5;',
        '    border-left: 3px solid #a00214; font: 13px/1.4 sans-serif; color: #4a3200; }',
        '  .config-page-note { margin: 0 0 10px; padding: 8px 12px; background: #fff4e5;',
        '    border-left: 3px solid #d98500; font: 13px/1.4 sans-serif; color: #4a3200;',
        /* The shipped stylesheet pins `body` to 1280 px inside a narrower window (style.css:2492),
         * so a full-width paragraph is clipped at the drawer's right edge. A reading note should not
         * be: it wraps inside the visible part of the drawer instead. */
        '    max-width: 660px; }',
        '  #deviceUpdateBrowseBtn[disabled], #deviceUpdateApplyBtn[disabled],',
        '  .download-image-btn[disabled], .usb-image-btn[disabled], .delete-image-btn[disabled]',
        '    { opacity: .55; cursor: not-allowed; }',
        /* Tools ▸ Interference Toolkit: the two read-only sections the page appends to the shipped
         * fragment. The stylesheet has no rules for them (the original drew a Plotly canvas there),
         * so they are sized here rather than borrowing a class that means something else. */
        /* The shipped stylesheet pins `body` to 1280 px below a 1279 px window (style.css:2492,
         * the width the desktop app is designed at); the drawer's iframe is ~1000 px, so the page
         * would be clipped at the right edge. This page has no 1280 px canvas left (the plot is not
         * drawn), so it is allowed to use the drawer's own width. */
        '  body[data-config-page="interferenceToolkit"] { width: auto !important;',
        '    max-width: 100% !important; }',
        '  .itk-readonly-note { clear: both; margin: 4px 24px 8px; padding: 8px 12px;',
        '    background: #fff4e5; border-left: 3px solid #d98500; font: 13px/1.45 sans-serif;',
        '    color: #4a3200; }',
        '  .itk-readonly-section { margin: 14px 24px 22px; }',
        /* The shipped title is `float: left`; with the Settings button and the plot gone the float
         * would push the note beside it instead of below. */
        '  body[data-config-page="interferenceToolkit"] .itk-title { float: none;',
        '    display: block; margin: 0 24px 4px; }',
        '  .itk-readonly-section h3 { margin: 0 0 6px; font: 600 15px/1.3 sans-serif; color: #115c7c; }',
        '  .itk-detection-summary, .itk-config-missing { margin: 0 0 8px; font: 13px/1.45 sans-serif;',
        '    color: #333; }',
        '  .itk-table-wrap { overflow-x: auto; }',
        '  .itk-table { width: 100%; border-collapse: collapse; font: 13px/1.35 sans-serif; }',
        '  .itk-table th, .itk-table td { border-bottom: 1px solid #e3e3e3; padding: 5px 8px;',
        '    text-align: left; white-space: nowrap; }',
        '  .itk-table th { background: #f4f8fb; color: #115c7c; font-weight: 600; }',
        '  .itk-table .itk-config-item { white-space: normal; }',
        '  .itk-table .itk-config-source { color: #666; }',
        '  .itk-not-detected { color: #666; font-style: italic; }',
        '  .itk-no-detections { margin: 6px 0 0; font: 13px/1.4 sans-serif; color: #666;',
        '    font-style: italic; }',
        '  #itk-capture { display: none; }',
        /* The six write groups. The shipped stylesheet has no rule for them (the original drew a
         * Settings sidenav over the plot), so the grid is laid out here: two columns on the
         * drawer's ~1000 px width, one on a narrow window. */
        '  .itk-write-grid { display: flex; flex-wrap: wrap; gap: 10px 14px; }',
        '  .itk-write-group { flex: 1 1 300px; min-width: 260px; margin: 0; padding: 8px 10px 10px;',
        '    border: 1px solid #d7e3ea; border-radius: 4px; background: #fbfdfe; }',
        '  .itk-write-group legend { padding: 0 4px; font: 600 13px/1.3 sans-serif; color: #115c7c; }',
        '  .itk-write-field { display: flex; align-items: center; justify-content: space-between;',
        '    gap: 8px; margin: 4px 0; font: 12px/1.4 sans-serif; color: #333; }',
        '  .itk-write-field > input, .itk-write-field > select { flex: 0 0 52%; min-width: 0;',
        '    height: 24px; padding: 0 4px; border: 1px solid #b9c9d3; border-radius: 3px;',
        '    background: #fff; font: 12px/1.2 sans-serif; }',
        '  .itk-write-group .itk-apply { margin-top: 6px; padding: 4px 14px; border: 0;',
        '    border-radius: 3px; background: #115c7c; color: #fff; font: 600 12px/1.4 sans-serif;',
        '    cursor: pointer; }',
        '  .itk-write-group .itk-apply:hover { background: #0d4a63; }',
        '  .itk-write-help { margin: 2px 0 6px; font: 11px/1.4 sans-serif; color: #5b6b75; }',
        '  .itk-last-command { margin: 10px 0 0; font: 12px/1.5 ui-monospace, Consolas, monospace;',
        '    color: #123; word-break: break-all; }',
        '  .itk-command-reply { margin: 4px 0 0; padding: 6px 10px; border-left: 3px solid #115c7c;',
        '    background: #eef6fa; font: 12px/1.5 ui-monospace, Consolas, monospace; color: #123;',
        '    word-break: break-all; }',
        '  .itk-command-reply[data-itk-reply-error] { border-left-color: #a00214;',
        '    background: #fdeef0; color: #6b0010; }',
        '  .itk-write-refused { border-left-color: #d98500; background: #fff4e5; color: #4a3200; }',
      ].join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
${links}
<style>
${extra}
</style></head>
<body data-config-page="${name}" data-event-count="${eventCount}" data-session="${options.connected === false ? 'none' : 'live'}">
${sessionNote}${body}
<script>${CLIENT_SCRIPT}</script>
</body></html>`;
}

/** Shown inside a page served without a receiver session. */
export const NO_SESSION_NOTE =
  '<p id="config-session-note" class="config-session-note">No live receiver session: this page ' +
  'reads what the receiver last reported, and nothing you change here can be sent until a session ' +
  'is open (Manage ▸ Connect live…).</p>';

const NO_SESSION_NOTE_TEXT =
  'there is no live receiver session, so nothing was written and nothing is claimed to be.';

export interface ConfigEventResult {
  shell: string;
  applied: boolean;
  commands: ConfigCommand[];
  /** A sentence for the page when what was clicked cannot reach a receiver (`null` when it can). */
  note: string | null;
}

/** Apply one browser event; the shell comes back so the client can swap it in. */
export function applyConfigEvent(
  name: string,
  selector: string,
  event: { value?: unknown; checked?: boolean; click?: boolean },
  options: { connected?: boolean; sent?: number } = {},
): ConfigEventResult {
  const target = host(name);
  /**
   * Tools ▸ Interference Toolkit (§2.2.9) is filled from a **capture**, and only the drawer knows
   * which one is open. The page document names it through `#itk-capture`, the one control on that
   * page that is not a receiver setting; the read happens here, on the server, with the same
   * `readTextRecords` the `/api/records` endpoint serves, and the re-rendered panel comes back in
   * `shell` like every other form event.
   */
  if (name === 'interferenceToolkit' && typeof event.value === 'string') {
    if (selector === '#itk-capture') feedItkCapture(event.value);
    /* The receiver's own `<OK` / `<ERROR:…`. The page cannot hear it: `LiveLink` credits a reply to
     * the command that is waiting for it, and a configuration page's Apply is fire-and-forget
     * (`server.ts` writes the framed lines and returns). So the page's own script reads the answer
     * off `/api/live/status` and posts it here, and this is where it becomes the page's text. */
    else if (selector === '#itk-command-reply') host(name).feedItkReply(event.value);
    /* A refresh ping: the poll saw new `IT*CONFIG` records, `feedConfigFromEntries` already fed
     * them, and the answer to this event carries the re-rendered panel. */
  }
  const applied = target.applyEvent(selector, event);
  const commands = target.takeCommands();
  /* A read-only page (§2.2.12 Update) dropped whatever it framed; say that in the page rather than
   * letting the click look like a no-op. */
  const readOnly = READ_ONLY_PAGES[name];
  const note = readOnly
    ? `Nothing was sent: ${readOnly}`
    : options.sent === 0 && commands.length > 0
      ? `${commands.length} command(s) were framed by this page but not sent: ${NO_SESSION_NOTE_TEXT}`
      : null;
  return {
    shell: bodyOf(name),
    applied,
    commands,
    note,
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
let lastEventSeq = 0;/**
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

/* ---------------------------------------------------- configuration pages: receiver logs */
/**
 * Feed the configuration records the live link decoded (INTERFACEMODE, LOGLIST, SERIALCONFIG,
 * ELEVATIONCUTOFF, PPSCONTROL, IPCONFIG, VERSION, …) into every open configuration page.
 *
 * Which ids are accepted is the pages' own list (`config-feed.ts#CONFIG_MESSAGE_ID_SET`, the union
 * of `CONFIG_SUBSCRIPTIONS`), so a page that reads a record always gets it.
 *
 * The pages read a per-port dictionary, so the two tables that arrive one port per record
 * (`SERIALCONFIG`, `LOGLIST`) are accumulated per page and handed over whole each time. Entries are
 * consumed by `seq`, so a Terminal backfill and this poll cannot feed the same record twice.
 */
const configAccumulators = new Map<string, ConfigAccumulator>();
let lastConfigSeq = 0;

export function feedConfigFromEntries(
  entries: Array<{ seq?: number; messageId: number; ascii?: string }>,
): number {
  if (hosts.size === 0) return 0; // no configuration page is open
  let fed = 0;
  let highest = lastConfigSeq;
  for (const entry of entries) {
    const seq = Number(entry.seq ?? 0);
    if (seq > 0 && seq <= lastConfigSeq) continue;
    if (seq > highest) highest = seq;
    /**
     * Tools ▸ Interference Toolkit reads its six `IT*CONFIG` records off their **rendered line**:
     * they are commands, not logs any page's slice describes, so `configSliceOf` below has no
     * branch for them. The page parses the record itself (`itkRecordOf`) and re-renders.
     */
    if (ITK_CONFIG_MESSAGE_IDS.has(entry.messageId) && entry.ascii) {
      const itk = hosts.get('interferenceToolkit');
      if (itk?.feedItkRecord(entry.messageId, entry.ascii)) fed += 1;
    }
    if (!CONFIG_MESSAGE_ID_SET.has(entry.messageId)) continue;
    if (!entry.ascii) continue;
    for (const [page, instance] of hosts) {
      const key = `${page}:${entry.messageId}`;
      let accumulator = configAccumulators.get(key);
      if (!accumulator) {
        accumulator = createAccumulator();
        configAccumulators.set(key, accumulator);
      }
      const slice = configSliceOf(entry.messageId, entry.ascii, accumulator);
      if (!slice) continue;
      if (instance.feedLog(slice.name, slice.data).length) fed += 1;
    }
  }
  lastConfigSeq = highest;
  return fed;
}

/**
 * The `LOG <NAME>B ONCE` lines a configuration page needs. The names are the shipped controller's
 * own request table (`requiredLogs`), asked for as **binary** records (`B`) because that is the form
 * `decodeEdie` reads; `ONCE` keeps a page visit from leaving a stream running on the receiver.
 */
export function configLogRequests(page: string): string[] {
  const instance = hosts.get(page) ?? host(page);
  const requests = instance.requiredLogs(page);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const request of requests) {
    const name = request.name.toUpperCase();
    if (seen.has(name)) continue;
    seen.add(name);
    lines.push(`LOG ${name}B ONCE`);
  }
  return lines;
}

/** Re-render a page from the state its receiver records just produced. */
export function refreshConfigPage(page: string): void {
  hosts.get(page)?.refreshPage();
}

/**
 * Feed one `ITDETECTSTATUS` record (a capture's text form) into the Events page.
 *
 * The Events page normally listens to the live link; a capture's interference records never reach it,
 * so opening `Events` with a capture has to prime it here. Field names are the flat
 * `interference_statuses[i].*` paths the page's `itkDetections()` groups.
 */
export function feedEventsItk(fields: Record<string, unknown>): boolean {
  const instance = hosts.get('events') ?? host('events');
  const before = instance.eventCount();
  instance.feedLog(2065, fields);
  return instance.eventCount() > before;
}

/* ------------------------------------------------- Tools ▸ Interference Toolkit (§2.2.9) */

/** What one read of a capture gave the Interference Toolkit page. */
export interface ItkCaptureFeed {
  ok: boolean;
  capture: string;
  /** Why nothing could be read, when `ok` is false. */
  reason?: string;
  /** `ITDETECTSTATUS` records in the capture (`47` on b7). */
  total: number;
  /** Records handed to the page — the `/api/records` per-request limit, 25. */
  shown: number;
  /** How many of those carry a detection. */
  detected: number;
}

/** `#ITDETECTSTATUSA,…;1,L2,SPECTRUMANALYSIS,1270.432,…` → the flat field map the page groups. */
function fieldMapOf(record: { fields: Array<{ path: string; value: unknown; text?: string }> }): Record<
  string,
  unknown
> {
  const fields: Record<string, unknown> = {};
  // `text` is the **printed** token (`L2`, `SPECTRUMANALYSIS`, `00000400`), which is what the page
  // shows; `value` would turn the band into `3` and the severity into `0`. Text records always carry
  // it, and so does a decoded enum in a binary record (`ALL`, `HDR`, `2K`).
  for (const field of record.fields) fields[field.path] = field.text ?? field.value;
  return fields;
}

/** One field of a binary record, by layout name, as its printed form. */
function fieldTextOf(
  record: { fields: Array<{ name: string; value: unknown; text?: string }> } | undefined,
  name: string,
): string | undefined {
  const field = record?.fields.find((candidate) => candidate.name === name);
  return field ? String(field.text ?? field.value) : undefined;
}

/**
 * Read one capture into the Interference Toolkit page.
 *
 * The page's detections are `ITDETECTSTATUS` (#2065) — a **text** record on this receiver, so it is
 * read with the same `readTextRecords` the `/api/records?name=…` endpoint uses, at the same per
 * request limit (25). Its settings come from the receiver's immutable-in-this-build records:
 * `ITDETECTCONFIG` (#2143), `ITWARNINGCONFIG` (#2289), `ITFRONTENDMODE` (#2039) and
 * `ITSPECTRALANALYSIS` (#1967); whatever the capture does not hold is reported as missing so the
 * page can print `--` with a reason instead of a zero.
 *
 * Nothing in a capture is sent anywhere: this only reads files the app already has.
 */
export function feedItkCapture(capture: unknown): ItkCaptureFeed {
  const wanted = String(capture ?? '').trim();
  const fail = (reason: string): ItkCaptureFeed => ({
    ok: false,
    capture: wanted,
    reason,
    total: 0,
    shown: 0,
    detected: 0,
  });
  if (!wanted) {
    // Nothing to read: clear whatever the page was showing, so it cannot keep a previous capture's
    // rows while its own URL names none.
    host('interferenceToolkit').feedItk(undefined);
    return fail('no capture was named, so nothing could be read');
  }
  let data;
  try {
    data = loadCapture(resolveCapture(wanted));
  } catch (error) {
    host('interferenceToolkit').feedItk(undefined);
    return fail(error instanceof Error ? error.message : String(error));
  }
  const table = tables();
  const PAGE = 25;
  const first = readTextRecords(data, table, 'ITDETECTSTATUS', 0, PAGE);

  // Every record, not just the first page: the page states the capture-wide count ("38 of 47 carry
  // a detection"), and a count it could not see would be a guess.
  const allRows: ItkRow[] = [];
  let detectedTotal = 0;
  const methods: Record<string, number> = {};
  const bands: string[] = [];
  for (let offset = 0; offset < first.total; offset += PAGE) {
    const page = readTextRecords(data, table, 'ITDETECTSTATUS', offset, PAGE);
    for (const record of page.records) {
      for (const row of itkRowsOf(fieldMapOf(record))) {
        allRows.push(row);
        if (!row.detected) continue;
        detectedTotal += 1;
        methods[row.method] = (methods[row.method] ?? 0) + 1;
        if (!bands.includes(row.band)) bands.push(row.band);
      }
    }
  }

  const shownRows = allRows.slice(0, first.records.length);
  const config: ItkCaptureSummary['config'] = {};
  const missing: string[] = [];
  const readOne = (messageId: number) => readRecords(data, table, messageId, 0, 1).records[0];

  const itdetect = readOne(2143);
  if (itdetect) config.itkSwitch = fieldTextOf(itdetect, 'frequency');
  else missing.push('ITDETECTCONFIG (#2143) — the Interference Toolkit switch');

  const warning = readOne(2289);
  if (warning) config.warningLevel = fieldTextOf(warning, 'level');
  else missing.push('ITWARNINGCONFIG (#2289) — the warning level');

  const frontend = readOne(2039);
  if (frontend) config.hdrMode = fieldTextOf(frontend, 'mode');
  else missing.push('ITFRONTENDMODE (#2039) — Enable HDR Mode');

  const spectral = readOne(1967);
  if (spectral) {
    config.dataSource = fieldTextOf(spectral, 'data_source');
    config.analysisBand = fieldTextOf(spectral, 'frequency');
    config.updatePeriodMs = fieldTextOf(spectral, 'psd_update_period_ms');
    config.fftSize = fieldTextOf(spectral, 'fft_size');
    config.timeAveragingSec = fieldTextOf(spectral, 'psd_time_ave_window_sec');
    config.detectionSensitivity = fieldTextOf(spectral, 'psd_subcarrier_ave_window');
  } else {
    missing.push('ITSPECTRALANALYSIS (#1967) — the Advanced Settings');
  }

  const hasFilters = [1991, 2022, 2023].some(
    (messageId) => readRecords(data, table, messageId, 0, 1).total > 0,
  );
  if (!hasFilters) {
    missing.push(
      'ITFILTTABLE (#1991) / ITPROGFILTBANK (#2023) / ITBANDPASSBANK (#2022) — the filter list',
    );
  } else {
    config.filters = 'Present in the capture (see ITFILTTABLE)';
  }

  const summary: ItkCaptureSummary = {
    capture: data.relPath,
    total: first.total,
    shown: first.records.length,
    detectedShown: shownRows.filter((row) => row.detected).length,
    detectedTotal,
    methods,
    bands,
    rows: shownRows,
    config,
    missing,
  };
  // A capture with no ITDETECTSTATUS at all still renders the page's own empty state; `feedItk`
  // ignores a page that is not mounted, and the drawer always mounts before it asks.
  host('interferenceToolkit').feedItk(summary);
  return {
    ok: true,
    capture: data.relPath,
    total: first.total,
    shown: first.records.length,
    detected: summary.detectedShown,
  };
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
 * **Import** needs the receiver's own `<OK` / `<ERR…` answers to every line, then a read-back:
 * `LiveLink` now carries that channel (`live.ts#command`, `live.ts#collect`), so the write is
 * offered exactly while a session is open. Without one there is nowhere to write to, and the page
 * says so instead of pretending.
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
    ? 'No live receiver session: the configuration would have nowhere to go. Nothing is written ' +
      'until a receiver is connected — the write and the read-back both need it.'
    : 'Ready: each line is sent on its own and must be answered <OK by the receiver; only when every ' +
      'line is acknowledged is LOG RXCONFIG read back to confirm what the receiver now holds. A line ' +
      'that is refused, or not answered at all, stops the import at that line.';

  return {
    ok: true,
    connected,
    export: { available: assembled || records > 0, reason: exportReason, records },
    import: { available: connected, reason: importReason, previewAvailable: true },
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

/**
 * The command-response channel a real import needs. `LiveLink` is one (`live.ts`); a test can pass
 * any object with these two methods, which keeps the flow verifiable without a receiver.
 */
export interface ImportChannel {
  /** Send one line and wait for the receiver's own `<OK` / `<ERR…`. */
  command(line: string, options?: { timeoutMs?: number }): Promise<LiveCommandReply>;
  /**
   * Send a read-back request and collect the receiver's data lines.
   *
   * `records: true` also returns the **decoded records** the request produced (`LiveLink` keeps
   * their rendered ASCII lines): this receiver answers `LOG RXCONFIGB ONCE` with SBF records rather
   * than text, so a text-only collector would see nothing at all.
   */
  collect(
    line: string,
    options?: {
      timeoutMs?: number;
      quietMs?: number;
      until?: (lines: string[]) => boolean;
      records?: boolean;
    },
  ): Promise<{ ok: boolean; lines: string[]; reason: string }>;
}

/** What the read-back said about one applied line. */
export type CfgStepVerification = 'matched' | 'mismatch' | 'absent';

export interface CfgApplyStep {
  /** 1-based position in the file's loadable command list. */
  index: number;
  line: string;
  ok: boolean;
  /** `ok` · `err` · `timeout` · `not-connected` · `send-failed` · `closed`. */
  status: string;
  /** The receiver's own words for this line, `null` when it never answered. */
  reply: string | null;
  elapsedMs: number;
  /** The read-back verdict, `null` when no read-back was attempted. */
  verified: CfgStepVerification | null;
  /** The receiver's read-back line(s) for this command, verbatim. */
  readback: string[];
}

export interface CfgApplyVerification {
  attempted: boolean;
  ok: boolean;
  /** The request that produced the read-back (`LOG RXCONFIG ONCE`). */
  request: string;
  reason: string;
  /** Configuration lines the receiver answered with. */
  lines: number;
  matched: number;
  /** Commands the read-back echoed with a different value (a real failure). */
  mismatched: string[];
  /**
   * Commands `LOG RXCONFIG` does not report at all (a `LOG …` line, for instance). They were
   * acknowledged by the receiver but cannot be confirmed from the read-back — reported, never
   * counted as verified.
   */
  absent: string[];
}

export interface CfgApplyResult {
  ok: boolean;
  reason: string;
  /** Lines actually written to the receiver (the failing one included). */
  sent: number;
  /** Every line acknowledged by the receiver **and** confirmed by the read-back. */
  verified: boolean;
  preview: CfgParseResult;
  steps: CfgApplyStep[];
  verification: CfgApplyVerification | null;
  /** 1-based index of the line the import stopped at. */
  failedAt?: number;
  failedLine?: string;
}

/**
 * The read-back request: the receiver's own configuration dump, asked for once.
 *
 * Measured on the desk OEM729 (2026-11-01, USB2/COM10 at 115200, RANGE streaming):
 *
 *  - `LOG RXCONFIG ONCE` answers **abbreviated ASCII** as a three-line group per statement
 *    (`<RXCONFIG USB2 270 …` / `<     ELEVATIONCUTOFF USB2 270 …` / `<     GLONASS 5.0 0`) — the
 *    statement name is on the second line, so it cannot be split per statement;
 *  - `LOG RXCONFIGA ONCE` was silent on this port (no record arrived within 20 s);
 *  - `LOG RXCONFIGB ONCE` answers **271 records of message 128 (RXCONFIG)** in one burst, each one
 *    a whole statement with its name and arguments — the shape this verifier parses.
 *
 * So the request is the `B` form, and the answer comes back as *decoded records* rather than text:
 * `LiveLink.collect` has to be asked for those (`records: true`).
 */
export const READBACK_REQUEST = 'LOG RXCONFIGB ONCE';
/** One configuration line takes milliseconds on a receiver; a minute of silence means it is gone. */
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_READBACK_TIMEOUT_MS = 8_000;

/** Upper-case, whitespace-collapsed tokens of a command or read-back line (CRC suffix removed). */
function tokensOf(line: string): string[] {
  return line
    .replace(/\*[0-9a-fA-F]+\s*$/, '')
    .replace(/^\s*[<#]/, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.toUpperCase());
}

interface ReadbackLine {
  /** The line as the receiver sent it, for the report. */
  raw: string;
  name: string;
  tokens: string[];
}

/**
 * Turn the receiver's read-back text into one entry per configuration statement. `RXCONFIG`
 * answers either abbreviated (`<SERIALCONFIG COM2 …*crc`) or full ASCII
 * (`<RXCONFIGA,…,1682;SERIALCONFIG COM2 …*crc`); `configurationLineOf` is the same unwrapping the
 * `.cfg` generator uses, so the two halves agree about what a configuration line is.
 */
function parseReadback(lines: string[]): ReadbackLine[] {
  const out: ReadbackLine[] = [];
  for (const line of lines) {
    const body = configurationLineOf(line);
    if (!body) continue;
    const tokens = tokensOf(body);
    if (!tokens.length) continue;
    out.push({ raw: line.trim(), name: tokens[0], tokens });
  }
  return out;
}

/** Which read-back verdict a command gets: echoed unchanged, echoed differently, or not at all. */
function classifyStep(line: string, readback: ReadbackLine[]): { state: CfgStepVerification; lines: string[] } {
  const wanted = tokensOf(line);
  const name = wanted[0] ?? '';
  const candidates = readback.filter((entry) => entry.name === name);
  if (candidates.length === 0) return { state: 'absent', lines: [] };
  const match = candidates.find((entry) => wanted.every((token) => entry.tokens.includes(token)));
  if (match) return { state: 'matched', lines: [match.raw] };
  return { state: 'mismatch', lines: candidates.map((entry) => entry.raw) };
}

function refusalReason(
  step: number,
  total: number,
  line: string,
  reply: LiveCommandReply,
  timeoutMs: number,
): string {
  const where = `Stopped at command ${step} of ${total} (“${line}”)`;
  switch (reply.status) {
    case 'timeout':
      return (
        `${where}: the receiver did not answer within ${timeoutMs} ms. Nothing after this line was ` +
        'sent, no read-back was attempted, and no reply is invented for it.'
      );
    case 'not-connected':
    case 'closed':
      return `${where}: the session closed before the receiver answered, so the rest of the file was not sent.`;
    case 'send-failed':
      return `${where}: the line could not be written to the link.`;
    default:
      return `${where}: the receiver answered ${reply.reply ?? '<ERR'} — its own words. The lines before it were ` +
        'acknowledged; the ones after it were not sent, and no read-back was attempted.';
  }
}

/**
 * Apply a `.cfg` — the flow the task's order describes, over the channel `LiveLink` now carries:
 *
 *   1. parse with the shipped loader (`deviceImportPreview`, nothing is sent);
 *   2. send **one line at a time** and wait for the receiver's own answer to that line;
 *   3. stop at the first line that is refused or not answered, naming it and quoting the receiver;
 *   4. only when every line was acknowledged, read the configuration back (`LOG RXCONFIG ONCE`)
 *      and report, per line, whether the receiver now echoes it unchanged.
 *
 * Nothing here sends `SAVECONFIG` or `RESET` — a configuration is written and read back, not made
 * permanent behind the user's back (`filterLoadCommands` drops both from the file). Without a
 * channel, or without a session, the call still refuses: a write that cannot be checked is not made.
 */
export async function deviceImportApply(
  text: string,
  connected: boolean,
  versions?: ConfigLoadOptions['versions'],
  channel?: ImportChannel,
  options: { commandTimeoutMs?: number; readbackTimeoutMs?: number } = {},
): Promise<CfgApplyResult> {
  const preview = deviceImportPreview(text, versions);
  const refuse = (reason: string): CfgApplyResult => ({
    ok: false,
    reason,
    sent: 0,
    verified: false,
    preview,
    steps: [],
    verification: null,
  });
  if (!preview.ok) return refuse(preview.error ?? 'nothing to load');
  if (!connected) {
    return refuse(
      'No live receiver session: the configuration would have nowhere to go. Import is disabled ' +
        'until a receiver is connected.',
    );
  }
  if (!channel) {
    return refuse(
      'Refused: this link exposes no command-response channel, so neither the receiver’s <OK/<ERR ' +
        'answers nor the read-back could be observed. A configuration that cannot be verified is not written.',
    );
  }

  const commands = preview.commands;
  const timeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const steps: CfgApplyStep[] = [];
  for (let index = 0; index < commands.length; index += 1) {
    const line = commands[index];
    const reply = await channel.command(line, { timeoutMs });
    steps.push({
      index: index + 1,
      line,
      ok: reply.ok,
      status: reply.status,
      reply: reply.reply,
      elapsedMs: reply.elapsedMs,
      verified: null,
      readback: [],
    });
    if (!reply.ok) {
      return {
        ok: false,
        reason: refusalReason(index + 1, commands.length, line, reply, timeoutMs),
        sent: index + 1,
        verified: false,
        preview,
        steps,
        verification: null,
        failedAt: index + 1,
        failedLine: line,
      };
    }
  }

  const readback = await channel.collect(READBACK_REQUEST, {
    timeoutMs: options.readbackTimeoutMs ?? DEFAULT_READBACK_TIMEOUT_MS,
    // This receiver answers `LOG RXCONFIGB ONCE` with 271 *decoded records*, not text lines: the
    // channel has to hand those over too or the read-back looks silent and every step is "absent".
    records: true,
  });
  const parsed = parseReadback(readback.lines);
  const verification: CfgApplyVerification = {
    attempted: true,
    ok: false,
    request: READBACK_REQUEST,
    reason: '',
    lines: parsed.length,
    matched: 0,
    mismatched: [],
    absent: [],
  };
  for (const step of steps) {
    const verdict = classifyStep(step.line, parsed);
    step.verified = verdict.state;
    step.readback = verdict.lines;
    if (verdict.state === 'matched') verification.matched += 1;
    else if (verdict.state === 'mismatch') verification.mismatched.push(step.line);
    else verification.absent.push(step.line);
  }

  const acknowledged = `${steps.length} command(s) acknowledged by the receiver`;
  if (!readback.ok) {
    verification.reason = readback.reason;
    return {
      ok: false,
      reason:
        `${acknowledged}, but ${READBACK_REQUEST} produced no line (${readback.reason}), so nothing is ` +
        'verified: the settings may or may not be in force. Re-open the link and read the configuration again.',
      sent: steps.length,
      verified: false,
      preview,
      steps,
      verification,
    };
  }
  if (verification.mismatched.length) {
    verification.reason = `${verification.matched} of ${steps.length} read back unchanged`;
    return {
      ok: false,
      reason:
        `${acknowledged}, but the read-back disagrees with ${verification.mismatched.length} of them ` +
        `(${verification.mismatched.join('; ')}). The receiver’s own RXCONFIG lines are in each step’s ` +
        '`readback`.',
      sent: steps.length,
      verified: false,
      preview,
      steps,
      verification,
    };
  }

  verification.ok = verification.absent.length === 0;
  verification.reason =
    `${verification.matched} of ${steps.length} read back unchanged` +
    (verification.absent.length
      ? `; ${verification.absent.length} not reported by LOG RXCONFIG (${verification.absent.join('; ')}), ` +
        'so they rest on the receiver’s <OK alone'
      : '');
  return {
    ok: true,
    reason:
      `${acknowledged}; ${verification.reason}. Nothing was made permanent (no SAVECONFIG, no RESET).`,
    sent: steps.length,
    verified: verification.ok,
    preview,
    steps,
    verification,
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

/**
 * The payload line `transformSavedConfigLines` can read, or `null` when the record is opaque.
 *
 * Three shapes are in the wild, and the desk OEM729 emits the third one:
 *
 *  1. abbreviated ASCII, already a command — `<SERIALCONFIG COM1 9600 N 8 1 N ON*0b6e…`;
 *  2. full ASCII with the command spelled out in the body —
 *     `<RXCONFIGA,COM1,0,53.5,…;INTERFACEMODE COM1 NOVATEL NOVATEL ON*11…` (the shape the shipped
 *     save flow and the tests use);
 *  3. full ASCII whose body is **another full ASCII record**, comma-separated —
 *     `#RXCONFIGA,SPECIAL,268,…;NAVIC,5.0,0*…` for a single statement, and for a nested one
 *     `#RXCONFIGA,SPECIAL,270,…;#ELEVATIONCUTOFFA,SPECIAL,270,…;GLONASS,5.0,0*…*…`.
 *     Measured on the desk OEM729 on 2026-11-01: `LOG RXCONFIGB ONCE` answers 271 records in this
 *     shape, and `LOG SERIALCONFIGB ONCE` answers `#SERIALCONFIGA,SPECIAL,2,…;COM1,9600,N,8,1,N,ON*…`.
 *     The statement name lives in the *header* and the arguments are comma-separated, so shape 3
 *     has to be rebuilt as `<NAME arg arg …`; taking the body alone (what this function did before
 *     the hardware run) yields `COM1 9600 …` with no command name and the `.cfg` came out empty.
 */
function configurationLineOf(ascii: string): string | null {
  return statementOf(ascii.trim(), 0);
}

/** `configurationLineOf`'s recursion step; `depth` stops a malformed record from looping. */
function statementOf(text: string, depth: number): string | null {
  if (!text || text.startsWith('%') || depth > 3) return null;
  const semicolon = text.indexOf(';');
  if (semicolon < 0) {
    /* Abbreviated ASCII (`<SERIALCONFIG COM1 …`) or a bare command: strip the CRC and hand it on. */
    const withoutCrc = text
      .replace(/^[<#%](?=\S)/, '<')
      .replace(/\*[0-9a-fA-F]+\s*$/, '')
      .trim();
    if (!withoutCrc) return null;
    return withoutCrc.startsWith('<') ? withoutCrc : `<${withoutCrc}`;
  }
  const header = text.slice(0, semicolon).replace(/^[<#%]/, '');
  const headerName = header.split(',')[0].trim();
  const body = text.slice(semicolon + 1);
  /* Body of another full ASCII record: its own header names the statement. */
  if (/^[#<]/.test(body)) return statementOf(body, depth + 1);
  const withoutCrc = body.replace(/(\*[0-9a-fA-F]+)+(\s*\*\S*)?\s*$/, '').trim();
  if (!withoutCrc) return null;
  /* The `RXCONFIGA` wrapper whose body already reads as one command (the shape the shipped save
   * flow produces): keep it verbatim. Any other header name is the statement itself — its body is
   * only the arguments, comma-separated on the wire (`COM1,9600,N,8,1,N,ON`) or single
   * (`LOCKOUTSYSTEMA,…;NAVIC`), so the name has to come from the header. */
  const stripped = headerName.replace(/[AB]$/, '');
  if (/^RXCONFIG$/i.test(stripped)) return withoutCrc.startsWith('<') ? withoutCrc : `<${withoutCrc}`;
  if (!stripped) return null;
  const args = withoutCrc
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);
  return `<${[stripped, ...args].join(' ')}`;
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
    if (name === 'PROFILEINFO') {
      // PROFILEINFO is one record made of many lines; `transformProfileInfo` needs them together.
      lines.push(...transformSavedConfigLines(block, name, portDetails));
      continue;
    }
    /* Every entry here is one **whole** statement (the name was unwrapped from the header), while
     * `transformSavedConfigLines` still carries the original's two-line lookahead for
     * ASSIGNLBANDBEAM and ICOMCONFIG — which assumed the receiver's abbreviated layout, where the
     * arguments sit on a following line. Handed a block, the lookahead reads the *next statement*
     * instead: measured on the desk OEM729, `ICOMCONFIG ICOM1 TCP ":2000" ALL` came out as
     * `ICOMCONFIG <INTERFACEMODE COM3 NOVATEL NOVATEL ON`. One statement per call keeps the
     * lookahead from having a neighbour to swallow. */
    for (const line of block) lines.push(...transformSavedConfigLines([line], name, portDetails));
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
