/**
 * Server-side host for the suite's Configuration pages — the "HTML over the wire" half of A1.
 *
 * Why this file exists: `packages/view/src/config/*` is the tested controller layer for the 14
 * configuration pages, but it is TypeScript that drives a DOM, and this repo ships no bundler
 * (zero npm dependencies). The controller only needs a *document* and a handful of hooks
 * (`ConfigPageContext`, see `packages/view/src/types.ts:126`), so the adapter runs it here on the
 * server against `minidom`, serialises the result, and lets the browser send form events back:
 *
 *   GET  /api/config/:page          → `ConfigHost.show(name).html`
 *   POST /api/config/:page/event    → `ConfigHost.applyEvent(...)` then `html()`
 *   LiveLink record                 → `ConfigHost.feed(msgId, fields)` (config pages refresh)
 *   command hooks                   → `ConfigHost.takeCommands()` (framed bytes, sent by the caller)
 *
 * The shipped fragments come from `01_解包/app/view/<component>/<component>.html`, i.e. the same
 * files the view tests mount (`packages/view/test/helpers.ts#realFragmentLoader`), so what the
 * browser gets is the original markup with the original ids, not a re-drawn form.
 *
 * Scope: this file is the host only. The HTTP endpoints and the menu wiring are separate steps —
 * the endpoints belong in `server.ts`, which another piece of work owns this round.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import { createDocument, createEvent, serializeNode, trigger, type MiniDocument } from '../../view/src/minidom.ts';
import { createManage } from '../../view/src/manage.ts';
import { createTabRegistry } from '../../view/src/tabs.ts';
import { createTileSystem } from '../../view/src/tiles.ts';
import { MemoryStorage, UserStore } from '../../view/src/userStore.ts';
import { DEFAULT_FEATURES, type FeatureFlags } from '../../view/src/types.ts';

const CONFIG_PAGE_NAMES = [
  'positionConfig',
  'portConfig',
  'loggingConfig',
  'alignConfig',
  'spanConfig',
  'radioConfig',
  'gnssConfig',
  'spoofingConfiguration',
  'networkingSettings',
  'generalSettings',
  'languageSettings',
  'spanInstallation',
  'lghnPositionConfig',
  'lghnLoggingConfig',
] as const;

export type ConfigPageName = (typeof CONFIG_PAGE_NAMES)[number];

/** Which configuration tab a page lives in (`ConfigTabName`); the settings pages have none. */
const CONFIG_TAB_OF: Partial<Record<ConfigPageName, 'positioning' | 'ports' | 'logging' | 'align' | 'span' | 'radio' | 'gnss' | 'spoofing'>> = {
  positionConfig: 'positioning',
  portConfig: 'ports',
  loggingConfig: 'logging',
  alignConfig: 'align',
  spanConfig: 'span',
  radioConfig: 'radio',
  gnssConfig: 'gnss',
  spoofingConfiguration: 'spoofing',
};

export interface ConfigCommand {
  kind: 'binary' | 'raw' | 'ascii';
  /** Tab the controller addressed (`main-panel-tabs-3`), kept for logging. */
  tab: string;
  bytes?: Uint8Array;
  text?: string;
}

export interface ConfigHostOptions {
  /** `01_解包/app` — shipped fragments live under `view/`. */
  appRoot: string;
  /** `packages/protocol/data`. */
  dataDir: string;
  /** Model and capability flags (from VERSION); defaults to an OEM729 profile. */
  features?: Partial<FeatureFlags>;
  /** Hard cap on queued commands, so a runaway page cannot grow without bound. */
  commandLimit?: number;
}

/** The minimal clock the controller needs; the suite only reads `now()` during a page build. */
function hostClock() {
  const now = (): number => Date.now();
  return {
    now,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as never),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as never),
  } as never;
}

export class ConfigHost {
  private readonly doc: MiniDocument;
  private readonly manage: ReturnType<typeof createManage>;
  private readonly tab: string;
  private readonly registry: { setHidden(tab: string, hidden: boolean): void };
  private readonly features: FeatureFlags;
  private commands: ConfigCommand[] = [];
  private readonly commandLimit: number;

  constructor(options: ConfigHostOptions) {
    const appRoot = options.appRoot;
    const dataDir = options.dataDir;
    const viewRoot = join(appRoot, 'view');
    if (!existsSync(viewRoot)) throw new Error(`config host: no shipped view at ${viewRoot}`);

    this.commandLimit = options.commandLimit ?? 200;
    this.features = {
      ...DEFAULT_FEATURES,
      model: 'OEM729',
      alignSupported: true,
      spanSupported: true,
      radioTxSupported: true,
      dualAntennaSupported: true,
      spoofingSupported: true,
      loggingComponent: true,
      fileSupported: true,
      ...options.features,
    } as FeatureFlags;

    const readJson = (name: string): never =>
      JSON.parse(readFileSync(join(dataDir, name), 'utf8')) as never;

    this.doc = createDocument();
    const shell = this.doc.createElement('div');
    shell.id = 'shell';
    this.doc.body.appendChild(shell);

    const fragments = {
      load(path: string): string {
        const relative = path.replace(/^\.\//, '').replace(/^\.\.\//, '');
        const file = join(viewRoot, relative);
        if (!existsSync(file)) throw new Error(`fragment not found: ${path}`);
        return readFileSync(file, 'utf8');
      },
    };

    const features = () => this.features;
    const registry = createTabRegistry({});
    registry.buildShell(shell as never);
    this.registry = registry as never;
    const tiles = createTileSystem({ root: () => this.doc.body as never, loader: fragments, features });

    const transport = {
      sendBinary: (tab: string, bytes: Uint8Array) => this.record({ kind: 'binary', tab, bytes }),
      sendRaw: (tab: string, text: string) => this.record({ kind: 'raw', tab, text }),
      sendAsciiFrame: (tab: string, text: string) => this.record({ kind: 'ascii', tab, text }),
    };

    this.manage = createManage({
      document: this.doc as unknown as Document,
      clock: hostClock(),
      store: new UserStore(new MemoryStorage()),
      fragments,
      tiles,
      register: readJson('components.json').compRegister as never,
      tabShell: registry as never,
      features,
      commands: readJson('commands.json') as never,
      portNames: readJson('portnames.json') as never,
      translate: loadDictionary(appRoot),
      configTransport: transport as never,
      connectedPortName: () => undefined,
      viewportHeight: 900,
      scheduleConfigResets: false,
    });

    this.tab = this.manage.openTab({
      index: 2,
      deviceTileId: 'device-config',
      title: 'Configuration',
      details: { type: 'eth' },
    });
    this.manage.buildPanels(this.tab);
    // `buildPanels` builds the status dashboard; the configuration template is a separate call in
    // the original (entering Configuration). Mount it here so the host always has both.
    this.manage.configs.mount(this.tab as never, { features: this.features });
    // `openTab` leaves every panel `hidden` (the shell activates one on click); a headless host
    // always wants its panel visible, otherwise the serialised HTML renders as an empty page.
    this.registry.setHidden(this.tab, false);
  }

  /** Module names the controller knows (14 pages, `ConfigBundle.pageNames()`). */
  pageNames(): string[] {
    return [...CONFIG_PAGE_NAMES];
  }

  /** Mount one page (if needed) and return the serialised document. */
  show(name: string): { html: string; mounted: boolean } {
    if (!CONFIG_PAGE_NAMES.includes(name as ConfigPageName)) {
      throw new Error(`unknown config page: ${name}`);
    }
    // `page.mount()` always re-sets the container's innerHTML, which would wipe the rows the
    // receiver already filled; the bundle tracks what is mounted, so ask it first.
    const already = this.manage.configs.mountedPages(this.tab).includes(name);
    const mounted = already ? false : this.manage.configs.mountNamedPage(this.tab, name);
    return { html: this.html(), mounted };
  }

  /** The whole Manage tab as HTML (shipped ids preserved). */
  html(): string {
    return serializeNode(this.doc.body as never);
  }

  /**
   * Activate the page's tab pane, the way clicking the tab does (`ConfigBundle.selectPage`).
   * Without this the panes stay `hidden` and the browser shows an empty tab.
   */
  select(name: string): boolean {
    const target = CONFIG_TAB_OF[name as ConfigPageName];
    if (!target) return false;
    // Same two calls the menu performs: switch the tab from Status to Configuration, then pick
    // the page inside it.
    this.manage.statusConfigClick('menuConfig', this.tab as never);
    return this.manage.selectConfigPage(this.tab as never, target);
  }

  /** Every id in the current document — used by tests to prove the shipped markup came through. */
  ids(): string[] {
    const out: string[] = [];
    for (const node of this.doc.querySelectorAll('[id]')) out.push((node as unknown as Element).id);
    return out;
  }

  /** Serialised markup of one element, or `null` when the selector matches nothing. */
  elementHtml(selector: string): string | null {
    const node = this.doc.querySelector(selector);
    return node ? serializeNode(node as never) : null;
  }

  /** Feed one decoded log record (same shape `manage.handleDecodedLog` expects). */
  feed(messageId: number, fields: Record<string, unknown>): string[] {
    return this.manage.configs.updateFromLog(messageId, fields);
  }

  /** Apply a form event the browser reported: set a value, a checkbox, or click. */
  applyEvent(selector: string, event: { value?: unknown; checked?: boolean; click?: boolean }): boolean {
    const element = this.doc.querySelector(selector) as
      | (Element & { value?: unknown; checked?: boolean })
      | null;
    if (!element) return false;
    if (event.value !== undefined) {
      element.value = event.value;
      trigger(element as never, 'input');
      trigger(element as never, 'change');
    }
    if (event.checked !== undefined) {
      element.checked = event.checked;
      trigger(element as never, 'change');
    }
    if (event.click) trigger(element as never, 'click');
    return true;
  }

  /** Commands the controller queued since the last call (framed bytes / raw text). */
  takeCommands(): ConfigCommand[] {
    const queued = this.commands;
    this.commands = [];
    return queued;
  }

  private record(command: ConfigCommand): void {
    if (this.commands.length >= this.commandLimit) this.commands.shift();
    this.commands.push(command);
  }
}

/**
 * The English dictionary the controller looks strings up in (`view/languageSupport/en.js`).
 * Loaded the same way the view tests do it: the file assigns `Language.EN` on a sandbox object.
 */
function loadDictionary(appRoot: string): (key: string) => string {
  const file = join(appRoot, 'view', 'languageSupport', 'en.js');
  const sandbox: { Language: Record<string, Record<string, string>>; jsIn: { addDict(): void } } = {
    Language: {},
    jsIn: { addDict() {} },
  };
  try {
    runInNewContext(readFileSync(file, 'utf8'), sandbox, { timeout: 2000 });
  } catch {
    return (key) => key;
  }
  const dictionary = sandbox.Language.EN ?? {};
  return (key) => dictionary[key] ?? key;
}

export { CONFIG_PAGE_NAMES };
