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
import type { ConfigOperationsHost } from '../../view/src/config/index.ts';

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

/**
 * Pages that live outside the 14-pill template: `events.ts` mounts into the tab's
 * `#events-panel-<tab>` (step 1 of the sixteen containers), so it is served by the same
 * `/config/<name>` machinery but is not one of `ConfigBundle.pageNames()`.
 */
export const OPERATIONAL_PAGE_NAMES = ['events'] as const;
export type OperationalPageName = (typeof OPERATIONAL_PAGE_NAMES)[number];

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

/** `selectPage`'s `panelId` table, minus the tab suffix (`config/logging/index.ts:471-480`). */
const PANE_PREFIX: Record<string, string> = {
  positioning: 'pos',
  ports: 'ports',
  logging: 'log',
  align: 'align',
  span: 'span',
  radio: 'radio',
  gnss: 'gnss',
  spoofing: 'spoofing',
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
  /** File hooks (`ConfigPageContext.operations.files`); the `.cfg` drivers write through these. */
  operations?: ConfigOperationsHost;
  /** Mirror the 300/800 ms config reset timers (default false: a headless host renders on demand). */
  scheduleConfigResets?: boolean;
  /** Tab id the pages are mounted on; `tabs-2` matches the shipped index tooling. */
  tabIndex?: number;
}

/** Which pages `/config/<name>` accepts, in the order the drawer lists them. */
export const ALL_PAGE_NAMES = [...CONFIG_PAGE_NAMES, ...OPERATIONAL_PAGE_NAMES] as const;

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
      scheduleConfigResets: options.scheduleConfigResets === true,
      operations: options.operations as never,
    });

    this.tab = this.manage.openTab({
      index: options.tabIndex ?? 2,
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

  /** The tab every page of this host is mounted on (`tabs-2` unless overridden). */
  get tabId(): string {
    return this.tab;
  }

  /** Every page `/config/<name>` serves: the 14 pill pages plus the operational ones. */
  servedPageNames(): string[] {
    return [...ALL_PAGE_NAMES];
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
    this.resetPages();
    if (this.menuPanelId(name)) {
      // The Settings fragments are `data-lang-*` skeletons with no literal text, so without the
      // language pass the page would print blank labels. `mountOperationalPage` does the same for
      // the Device/Events pages (manage.ts#mountOperationalPage).
      this.manage.applyLanguage(this.tab as never);
    }
    return { html: this.html(), mounted };
  }

  /**
   * Mount a page that lives outside the 14-pill template (`events`). `manage.mountOperationalPage`
   * creates its shipped container (`#events-panel-<tab>`) when the sixteen steps did not, so the
   * page can be served even before the tab's panels exist.
   */
  showOperational(name: string): { html: string; mounted: boolean } {
    if (!OPERATIONAL_PAGE_NAMES.includes(name as OperationalPageName)) {
      throw new Error(`unknown config page: ${name}`);
    }
    const already = this.manage.configs.mountedPages(this.tab).includes(name);
    const mounted = already ? false : this.manage.mountOperationalPage(this.tab as never, name);
    // `events.js:showEventsMenu` slides the shipped drawer in by class; without it `.events-sidenav`
    // sits at `right:-330px` and the page looks empty.
    this.doc
      .querySelector(`#events-panel-${this.tab} .events-sidenav`)
      ?.classList.add('showEvents');
    this.resetPages();
    return { html: this.html(), mounted };
  }

  /** Either family of page, by name — what `/config/<name>` uses. */
  showAny(name: string): { html: string; mounted: boolean } {
    if (OPERATIONAL_PAGE_NAMES.includes(name as OperationalPageName)) return this.showOperational(name);
    return this.show(name);
  }

  /**
   * `resetPortConfigUI` → `dh_createDefaultData` + `v_loadDefaultData` of every mounted page.
   * Without it the shipped fragments stay skeletons: the port rows, the position fields and the
   * event lists are all created by each page's `render()`, which only runs on a reset.
   */
  private resetPages(): void {
    this.manage.configs.reset(this.tab as never, this.features);
  }

  /** The whole Manage tab as HTML (shipped ids preserved). */
  html(): string {
    return serializeNode(this.doc.body as never);
  }

  /**
   * Activate the page's tab pane, the way clicking the tab does (`ConfigBundle.selectPage`).
   * Without this the panes stay `hidden` and the browser shows an empty tab.
   *
   * A Settings page has no pill: it lives in the tab's menu layouts, which `mountNamedPage` already
   * made visible, so there is nothing to switch — and `true` is the honest answer.
   */
  select(name: string): boolean {
    const target = CONFIG_TAB_OF[name as ConfigPageName];
    if (!target) return this.menuPanelId(name) !== null;
    // Same two calls the menu performs: switch the tab from Status to Configuration, then pick
    // the page inside it. `statusConfigClick` refuses when `containers.build(tab)` has no build
    // for this tab — i.e. when `buildPanels` never ran — so the build is repaired and retried
    // rather than reported as "no such page".
    if (!this.manage.statusConfigClick('menuConfig', this.tab as never)) {
      this.manage.buildPanels(this.tab as never);
      if (!this.manage.statusConfigClick('menuConfig', this.tab as never)) return false;
    }
    return this.manage.selectConfigPage(this.tab as never, target);
  }

  /**
   * The menu-layout container a Settings page mounted into (`generalSettings-layout_tabs-2`), or
   * `null` for a Configuration pill page (those live in the tab's panes, not in the menu layouts).
   */
  menuPanelId(name: string): string | null {
    if (!this.manage.configs.isMenuPage(name)) return null;
    return this.manage.configs.containerIdOf(this.tab as never, name);
  }

  /** `select()` plus what actually ended up visible — used by the endpoint tests. */
  selectDetail(name: string): {
    selected: boolean;
    tab: string;
    paneId: string | null;
    configOpen: boolean;
    paneDisplay: string | null;
  } {
    const selected = this.select(name);
    const tab = CONFIG_TAB_OF[name as ConfigPageName];
    const paneId = tab ? `config-${PANE_PREFIX[tab]}-${this.tab}` : null;
    const pane = paneId ? (this.doc.getElementById(paneId) as unknown as Element | null) : null;
    const styled = pane as (Element & { style?: { display?: string } }) | null;
    return {
      selected,
      tab: this.tab,
      paneId,
      configOpen: this.manage.isConfigOpen(this.tab as never),
      paneDisplay: pane ? (styled?.style?.display || null) : null,
    };
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

  /**
   * Feed one **ASCII** line the receiver emitted. `RXSTATUSEVENT` (#94) is a text event: its one
   * interesting field is the quoted description, which is what `events.ts#rxStatusEvent` acts on.
   * Nothing is invented — a line without a quoted description is ignored.
   */
  feedAscii(messageId: number, ascii: string): string[] {
    if (messageId !== 94) return [];
    const description = rxStatusEventDescription(ascii);
    if (!description) return [];
    this.manage.configs.events.updateData(94, {
      description,
      tab: this.tab,
      time: new Date(),
    } as Record<string, unknown>);
    return ['events'];
  }

  /** How many events the page is holding (0 = the honest `--` state). */
  eventCount(): number {
    return this.manage.configs.events.getSMeventsCount(this.tab as never);
  }

  /**
   * The `LOG …` requests this page needs the receiver to answer before it can show real values.
   * The list is the shipped one (`view/src/config/index.ts#requiredLogs`), not a guess: the same
   * table the desktop controller uses when a configuration pill is opened.
   */
  requiredLogs(name?: string): Array<{ name: string; spec: string }> {
    return this.manage.configs.requiredLogs(this.features, name);
  }

  /**
   * Feed one configuration record the link decoded (`<INTERFACEMODE …`, `<LOGLIST …`, …) to the
   * pages that read its message id. `tab` is this host's own tab, exactly like `feedAscii`.
   */
  feedLog(messageId: number, data: Record<string, unknown>): string[] {
    return this.manage.configs.updateFromLog(messageId, { ...data, tab: this.tab });
  }

  /**
   * Re-render the page from the state the receiver's records just produced (`dh_createDefaultData`
   * + `v_loadDefaultData`). The headless host patches out the pages' own polling timer, so a page
   * that received its data *after* it was serialised would otherwise keep its "no data" note.
   */
  refreshPage(): void {
    this.manage.configs.reset(this.tab as never, this.features);
  }

  /** Raw ASCII from the link (Terminal, `.cfg` capture, load-config responses). */
  feedText(text: string): void {
    this.manage.handleSessionText(this.tab as never, text);
  }

  /** Start `saveConfiguration` (14 LOGs + SAVECONFIG + RESET); false when the model is GIII/LH. */
  startSaveConfiguration(): boolean {
    return this.manage.saveConfigurationFile(this.tab as never);
  }

  /** True while the save driver is still collecting the receiver's replies. */
  isSavingConfiguration(): boolean {
    return this.manage.configs.saveConfiguration.getSaveConfigActive(this.tab as never);
  }

  /** The `.cfg` file name the driver chose (`<PSN>_<date>.cfg`). */
  configurationFileName(): string | undefined {
    return this.manage.configs.saveConfiguration.getFileName(this.tab as never);
  }

  /** What the load driver has answered so far (command → `OK`/`ERROR…`). */
  loadReport(): Array<{ command: string; status?: string }> {
    return this.manage.configs.loadConfiguration.responseReport(this.tab as never);
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

/**
 * `RXSTATUSEVENTA` body: the receiver's own description is the first quoted token
 * (`#RXSTATUSEVENTA,COM1,0,53.5,FINESTEERING,2287,137888.000,02000020,4b5f,1682;"MODEL INVALID FOR
 * THIS RECEIVER",1,1,0,0*7c1c2f8e`). No quotes → nothing to report.
 */
export function rxStatusEventDescription(ascii: string): string {
  const match = /"([^"]*)"/.exec(ascii);
  return match ? match[1].trim() : '';
}

export { CONFIG_PAGE_NAMES };
