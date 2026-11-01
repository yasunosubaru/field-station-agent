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
import {
  wifiSupportedFromVersion,
  type ConfigOperationsHost,
  type ItkCaptureSummary,
} from '../../view/src/config/index.ts';

/**
 * Pages `/config/<name>` serves, in drawer order.
 *
 * The fourteen pill/settings pages of the shipped Configuration template, plus the four pages the
 * suite mounts from a menu rather than from the pill strip:
 *
 *   `deviceDetails`  **Device ▸ Device Details** (§2.2.8) — built by the same controller
 *                    (`ConfigBundle.pagesByName.deviceDetails`) and its subscription list is
 *                    already declared, but the shipped app mounts it from a menu rather than from
 *                    the Configuration pills, so it is not one of `CONFIG_PAGE_NAMES` in the view
 *                    layer. Serving it here is what makes `/config/deviceDetails` answer with the
 *                    page instead of `未知配置页：deviceDetails`.
 *   `deviceExport`   **Device ▸ Storage** (§2.2.11) — `deviceExport.html` *is* the Storage window:
 *                    "Device / Storage" breadcrumb, the active log file, the available log files
 *                    and Download / Copy to USB / Remove. The module keeps its component name; the
 *                    page it draws is Storage.
 *   `deviceUpdate`   **Device ▸ Update** (§2.2.12) — firmware read-out plus the flash controls.
 *                    **Served read-only in this build** (`READ_ONLY_PAGES`): a firmware write can
 *                    strand a receiver, so the page is here for its version display and its
 *                    controls are disabled in the served document.
 *   `vehicleSetup`   **Settings ▸ Vehicle Setup** (§2.2.7) — the `spanInstallation` fragment in a
 *                    container of its own (§2.2.7's screen *is* that template; the suite has no
 *                    separate `vehicleSetup` component).
 *   `interferenceToolkit` **Tools ▸ Interference Toolkit** (§2.2.9) — the shipped ITK component:
 *                    its detection list comes from a capture's `ITDETECTSTATUS` text records
 *                    (`feedItk`), its six settings are read from the receiver's own
 *                    `ITDETECTCONFIG` / `ITWARNINGCONFIG` / `ITSPECTRALANALYSIS` /
 *                    `ITFRONTENDMODE` / `ITBANDPASSCONFIG` / `ITPROGFILTCONFIG` records
 *                    (`feedItkRecord`, the read-back a write asks for) and written back through the
 *                    page's six Apply buttons. The spectrum plot needs the live `ITPSDFINAL`
 *                    stream and is not drawn.
 */
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
  'vehicleSetup',
  'interferenceToolkit',
  'lghnPositionConfig',
  'lghnLoggingConfig',
  'deviceDetails',
  'deviceExport',
  'deviceUpdate',
] as const;

export type ConfigPageName = (typeof CONFIG_PAGE_NAMES)[number];

/**
 * The pages that belong to a **Tools** menu entry rather than to Settings or Device.
 *
 * `Tools ▸ Interference Toolkit` is the manual's own wording (§2.2.9: "click the Tools menu and
 * then click Interference Toolkit"), and the shipped suite mounts the ITK component from that menu
 * (`view/interferenceToolKit/*` is not part of the Configuration pill strip). The HTTP layer marks
 * these pages apart so the drawer can group them; everything else about them is a menu page.
 */
export const TOOLS_PAGE_NAMES = ['interferenceToolkit'] as const;

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

/**
 * Pages this build serves **read-only**, with the sentence the page prints instead.
 *
 * `deviceUpdate` (§2.2.12) is here on purpose. Flashing firmware over a link that cannot be power
 * cycled under supervision can strand a receiver, and nothing in this build can verify an image
 * before it runs, so the page keeps its *read* half — Current Firmware Version / Current Manage
 * (Web) Version, filled from VERSION (#37) — and its Browse/Apply controls are disabled in the
 * served document. `takeCommands()` drops anything a read-only page still manages to queue, so a
 * hand-crafted POST cannot get a SOFTLOAD frame onto the link either.
 */
export const READ_ONLY_PAGES: Record<string, string> = {
  deviceUpdate:
    'Read-only in this build: the firmware version above comes from the receiver (VERSION #37), ' +
    'but a firmware write cannot be undone here, so Browse and Apply are disabled and no SOFTLOAD ' +
    'frame is ever queued.',
};

/** Elements a read-only page must not start from. */
const READ_ONLY_DISABLED = ['#deviceUpdateBrowseBtn', '#deviceUpdateApplyBtn'];

/**
 * Pages whose subject the model does not have, with the sentence the page prints above its own
 * empty state.
 *
 * `deviceExport` is the **Storage** window (§2.2.11). The desk receiver this build was measured
 * against answers `LOG FILESTATUS ONCE` with `<ERROR:Message is invalid for this model` and emits
 * no `FILESTATUS (#2127)` record at all (`03_分析/17_A1_连接层与Terminal.md` §17.8.6), so the page
 * can only ever show its own "No log files found" line. Without this note that line reads as "the
 * disk happens to be empty today", which is a different claim from "this model has no file log".
 * The controls above it (Download / Copy to USB / Remove) need a receiver and a mounted storage
 * device, so they are disabled here as well.
 */
export const UNSUPPORTED_PAGES: Record<string, string> = {
  deviceExport:
    'No storage on this model: `FILESTATUS (#2127)` answers <ERROR:Message is invalid for this ' +
    'model`, so no log file can be listed, downloaded, copied or removed here. The empty list ' +
    'below is the shipped page’s own state, not a reading of a disk.',
};

/**
 * What `Settings ▸ Networking` prints while the Wi-Fi half is hidden.
 *
 * The suite's own test is the enclosure PSN (`featuresList.js:1077`), and this receiver fails it on
 * both counts: its `VERSION` (#37, b1-20261101.sbf) carries a `GPSCARD` and two database
 * components and no `ENCLOSURE` at all, and the card it does report has PSN `BMGX21030301G`, whose
 * three-character prefix after the first character (`MGX`) is not in `wifiSupportedPSNList`. The
 * link agrees: `LOG WIFIMODE` answers `<ERROR:Message is invalid for this model` (measured
 * 2026-11-01), which is why this page never asks for the Wi-Fi records either.
 */
export const WIFI_HIDDEN_NOTE =
  'The Wi-Fi and Wi-Fi hotspot panels are hidden, exactly as the suite hides them: the receiver ' +
  'reports no Wi-Fi. `VERSION` (#37) carries no ENCLOSURE component, the card’s PSN prefix (MGX) ' +
  'is not in the suite’s Wi-Fi list (MND, MNE, MPL, MPM, MUS, MUR, MUT, MPX, MSR, MUH, MRT), and ' +
  '`LOG WIFIMODE` answers <ERROR:Message is invalid for this model. Nothing about Wi-Fi is ' +
  'assumed here.';

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
  /** Set while a `READ_ONLY_PAGES` entry is on screen; `takeCommands` then refuses its frames. */
  private readOnlyPage = '';
  private droppedByReadOnly = 0;

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
      /**
       * Measured on the desk OEM729 (2026-11-01): `VERSION` (#37) reports a `GPSCARD` and two
       * database components and **no `ENCLOSURE`**, so the suite's Wi-Fi test
       * (`featuresList.js:1077`) never runs for it; `LOG WIFIMODE` answers
       * `<ERROR:Message is invalid for this model`. `Settings ▸ Networking` therefore keeps
       * `.wifi-comp` / `.wifi-hotspot-comp` hidden, exactly as the shipped stylesheet leaves them.
       * A receiver that does report Wi-Fi flips this through `feedLog(37, …)`.
       */
      wifiSupported: false,
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

  /** Module names this host serves: the view's fourteen pill pages plus the four menu pages. */
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
    const readOnlyNote = READ_ONLY_PAGES[name];
    if (readOnlyNote) {
      this.readOnlyPage = name;
      this.applyPageNote(name, readOnlyNote, { disable: READ_ONLY_DISABLED, id: 'config-readonly-note' });
    } else {
      this.readOnlyPage = '';
      const unsupported = UNSUPPORTED_PAGES[name];
      if (unsupported) {
        this.applyPageNote(name, unsupported, {
          disable: ['.download-image-btn', '.usb-image-btn', '.delete-image-btn'],
          id: 'config-unsupported-note',
        });
      }
    }
    /* `Settings ▸ Networking` ships `.wifi-comp` and `.wifi-hotspot-comp` hidden, and the page only
     * writes `display: block` when the receiver reports Wi-Fi. A hidden panel with no sentence above
     * it reads as "this build forgot the Wi-Fi half", so the reason is printed there — and withdrawn
     * the moment a `VERSION` record says the receiver does have Wi-Fi. */
    if (name === 'networkingSettings') this.syncWifiNote();
    return { html: this.html(), mounted };
  }

  /** Keep `#config-wifi-note` in step with `features.wifiSupported` (see `WIFI_HIDDEN_NOTE`). */
  private syncWifiNote(): void {
    if (this.features.wifiSupported) {
      this.doc.getElementById('config-wifi-note')?.remove();
      return;
    }
    if (this.doc.getElementById('config-wifi-note')) return;
    this.applyPageNote('networkingSettings', WIFI_HIDDEN_NOTE, { disable: [], id: 'config-wifi-note' });
  }

  /**
   * Put a note at the top of a menu page and, optionally, disable the controls listed.
   *
   * The controls are disabled by **attribute** (what the browser honours and what `serializeNode`
   * emits), and the note is a `<p>` with the page's own class so the drawer's stylesheet picks it up
   * without a new rule. Nothing here inspects the controller: the page is still built, still fed
   * its records and still shows its own rows — only the doors that would write are closed.
   */
  private applyPageNote(
    name: string,
    note: string,
    options: { disable: readonly string[]; id: string },
  ): void {
    const panelId = this.menuPanelId(name);
    const container = panelId ? this.doc.getElementById(panelId) : null;
    if (!container) return;
    const root = container as unknown as {
      querySelectorAll(selector: string): Element[];
      querySelector(selector: string): Element | null;
      appendChild(node: unknown): void;
      insertBefore(node: unknown, reference: unknown): void;
      firstChild: unknown;
    };
    for (const selector of options.disable) {
      for (const node of root.querySelectorAll(selector)) {
        (node as unknown as { setAttribute(a: string, b: string): void }).setAttribute('disabled', '');
      }
    }
    if (root.querySelector(`#${options.id}`)) return;
    const paragraph = this.doc.createElement('p') as unknown as {
      className: string;
      id: string;
      textContent: string;
    };
    paragraph.className = 'config-page-note';
    paragraph.id = options.id;
    paragraph.textContent = note;
    if (root.firstChild) root.insertBefore(paragraph, root.firstChild);
    else root.appendChild(paragraph);
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
    this.syncFormState();
    return serializeNode(this.doc.body as never);
  }

  /**
   * Reflect live form state into attributes before anything is serialised.
   *
   * `minidom` keeps `.value` / `.checked` as **properties**, exactly as a browser does, and
   * `serializeNode` prints **attributes** only. A page fills its fields by writing
   * `element.value = '192.168.5.10'` (that is what `base.ts#setValue` does), so without this step
   * every value the controller computed is dropped on the way out and the browser shows an empty
   * box — the page reads as "no data" while its state holds the receiver's answer. Measured on the
   * desk OEM729: `alignConfig`, `gnssConfig` and `networkingSettings` were empty for exactly this
   * reason, not because their records never arrived.
   *
   * A blank value removes a stale `value` attribute instead of writing `value=""`, so a field the
   * receiver never reported stays blank rather than showing an empty string.
   */
  private syncFormState(): void {
    for (const node of this.doc.querySelectorAll('input, textarea, select')) {
      const control = node as unknown as {
        tagName: string;
        value?: unknown;
        checked?: boolean;
        getAttribute(name: string): string | null;
        setAttribute(name: string, value: string): void;
        removeAttribute(name: string): void;
        textContent: string;
      };
      const tag = String(control.tagName ?? '').toLowerCase();
      const value = control.value === undefined || control.value === null ? '' : String(control.value);
      if (tag === 'textarea') {
        // A textarea has no `value` attribute: its content is the value.
        if (value !== '') control.textContent = value;
        continue;
      }
      if (tag === 'select') {
        const wanted = value;
        for (const option of (node as unknown as { querySelectorAll(selector: string): Element[] })
          .querySelectorAll('option')) {
          const candidate = option as unknown as {
            getAttribute(name: string): string | null;
            setAttribute(name: string, value: string): void;
            removeAttribute(name: string): void;
          };
          const optionValue = candidate.getAttribute('value') ?? (option as unknown as { textContent: string }).textContent.trim();
          if (wanted !== '' && optionValue === wanted) candidate.setAttribute('selected', '');
          else candidate.removeAttribute('selected');
        }
        continue;
      }
      if (value !== '') control.setAttribute('value', value);
      else if (control.getAttribute('value') !== null) control.removeAttribute('value');
      const type = (control.getAttribute('type') ?? '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') {
        if (control.checked) control.setAttribute('checked', '');
        else control.removeAttribute('checked');
      }
    }
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
    this.syncFormState();
    const node = this.doc.querySelector(selector);
    return node ? serializeNode(node as never) : null;
  }

  /** Feed one decoded log record (same shape `manage.handleDecodedLog` expects). */
  feed(messageId: number, fields: Record<string, unknown>): string[] {
    this.applyVersion(messageId, fields);
    return this.manage.configs.updateFromLog(messageId, fields);
  }

  /**
   * Hand the Interference Toolkit page a capture's records (§2.2.9).
   *
   * The page cannot be fed from the link: `ITDETECTSTATUS` is a text record on this receiver and the
   * live decoder never sees it, so the capture — mapped by `config-http.ts#feedItkCapture` with the
   * same `readTextRecords` the `/api/records` endpoint uses — is what fills it.
   */
  feedItk(summary: ItkCaptureSummary | undefined): string[] {
    return this.manage.configs.setItkCapture(this.tab as never, summary)
      ? ['interferenceToolkit']
      : [];
  }

  /**
   * Hand the Interference Toolkit page one configuration record the link read back
   * (`<ITWARNINGCONFIGA,…,;3,0*…`), so its controls and its table show what the receiver now holds.
   *
   * The record arrives as the **rendered line** rather than as decoded fields: the entry the live
   * link keeps carries exactly that string (`live.ts#renderAscii`), and the page parses it here
   * (`interferenceToolkit.ts#itkRecordOf`) instead of through `config-feed.ts#configSliceOf`, whose
   * branches are other pages' field names. `false` when the page is not mounted or the line is not
   * one of the six records — never a silent no-op for a record that was asked for.
   */
  feedItkRecord(messageId: number, ascii: string): boolean {
    if (!this.manage.configs.mountedPages(this.tab).includes('interferenceToolkit')) return false;
    return this.manage.configs.interferenceToolkit.feedRecord(this.tab as never, messageId, ascii);
  }

  /** The receiver's own answer to the last line the page framed (`<OK`, `<ERROR:…`), verbatim. */
  feedItkReply(reply: string): boolean {
    if (!this.manage.configs.mountedPages(this.tab).includes('interferenceToolkit')) return false;
    this.manage.configs.interferenceToolkit.noteReply(this.tab as never, reply);
    return true;
  }

  /**
   * The one feature bit a record can change: whether the receiver has Wi-Fi.
   *
   * `featuresList.js` derives it from `VERSION` (#37) alone (`wifiSupportedFromVersion`), so the same
   * record flips the flag here and `Settings ▸ Networking` re-reads it on its next render. Nothing
   * else about a model is guessed: every other flag stays whatever the host was constructed with.
   */
  private applyVersion(messageId: number, fields: Record<string, unknown> | undefined): void {
    if (messageId !== 37 || !fields) return;
    const verdict = wifiSupportedFromVersion(fields);
    if (this.features.wifiSupported === verdict.supported) return;
    this.features.wifiSupported = verdict.supported;
    this.manage.configs.page('networkingSettings')?.reset(this.tab as never);
    this.syncWifiNote();
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
    this.applyVersion(messageId, data);
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
    const element = this.eventTarget(selector) as
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

  /**
   * The `@i/j/k` address of the element `selector` names — the form the drawer's script posts for a
   * control that has no id (see `eventTarget`). Exposed so a test can address the same element the
   * browser does instead of hand-counting children.
   */
  pathOf(selector: string): string | null {
    const shell = this.doc.getElementById('shell');
    const target = this.doc.querySelector(selector);
    if (!shell || !target || !(shell as unknown as { contains(node: unknown): boolean }).contains(target)) {
      return null;
    }
    const indices: number[] = [];
    let node = target as unknown as { parentElement: unknown };
    while (node && (node as unknown) !== (shell as unknown)) {
      const parent = node.parentElement as
        | { children: unknown[]; parentElement: unknown }
        | null;
      if (!parent) return null;
      indices.unshift(parent.children.indexOf(node));
      node = parent;
    }
    return '@' + indices.join('/');
  }

  /**
   * The element a browser event names: `#id` for anything with an id, or `@i/j/k` — the child-index
   * path inside `#shell` that the drawer's script posts for a control without one.
   *
   * The path form exists because the shipped markup has id-less buttons (the Positioning wizard's
   * "Next", dropdown items) and the server's selector engine has no `:nth-child`: a positional CSS
   * selector never resolved, so those clicks were silently dropped.
   */
  private eventTarget(selector: string): unknown {
    if (!selector.startsWith('@')) return this.doc.querySelector(selector);
    let node = this.doc.getElementById('shell') as unknown as
      | { children?: ArrayLike<unknown> }
      | null;
    const indices = selector
      .slice(1)
      .split('/')
      .map((part) => Number(part));
    for (const index of indices) {
      if (!node || !Number.isInteger(index) || index < 0) return null;
      node = (node.children?.[index] ?? null) as { children?: ArrayLike<unknown> } | null;
    }
    return node;
  }

  /** Commands the controller queued since the last call (framed bytes / raw text). */
  takeCommands(): ConfigCommand[] {
    const queued = this.commands;
    this.commands = [];
    // A read-only page (§2.2.12 Update) must never reach the link, even if a hand-written POST
    // managed to trigger its Apply handler: the frames are dropped here, not just hidden.
    if (this.readOnlyPage) {
      this.droppedByReadOnly += queued.length;
      return [];
    }
    return queued;
  }

  /** Commands a read-only page tried to frame and this host refused (`0` in a normal session). */
  readOnlyRefusals(): number {
    return this.droppedByReadOnly;
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
