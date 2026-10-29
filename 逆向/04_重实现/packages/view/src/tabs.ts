/**
 * TabRegistry — the Manage tab strip (`#tabs` / `#tabs-list` / `#tabs-1`).
 *
 * Evidence (all line numbers refer to `01_解包/app`, authoritative over the doc when the two
 * disagree — disagreements are called out in the comments):
 *  - static "Add device" page + template + `addTab` + `enableTabs` + close logic:
 *    `view/html/setUpMonitor.html:1-17, 336-470, 855-1004`
 *  - entering Manage: `view/js/welcome.js:128-179`
 *  - `maxConnection = 10`: `model/NovatelIdConstants.js:9`
 *  - lifecycle / activation strategy: `03_分析/01_Manage主界面与视图层.md §3.1, §6.1`
 *  - fixed defects: `R10–R12` (768-770), `R45` (821), and the missing space of §3.1 (210-212).
 *
 * The DOM subset used is exactly the one `minidom.ts` shims, so the same file runs in Node
 * (tests, `render-static.ts`) and in a browser (the demo). Attributes — not `HTMLElement.hidden` —
 * carry the hidden/disabled state, because the shim exposes attributes only: `hidden` hides,
 * `aria-disabled` + `ui-state-disabled` *disable* (R12). The two axes are deliberately separate.
 */

import { cssEscape } from './minidom.ts';
import type {
  AppId,
  ConnType,
  CreateTabInput,
  DeviceTileId,
  TabHooks,
  TabId,
  TabRecord,
  TabStatus,
} from './types.ts';

/** `NovatelIdConstants.js:9` — simultaneous connections, GRIT side included. */
export const MAX_CONNECTION = 10;
/** `setUpMonitor.html:340` — `tabCounter = 2`; a closed number is never handed out again. */
export const INITIAL_TAB_COUNTER = 2;
/** The static first tab. It is *not* a device tab (`deviceTileId === ''`). */
export const STATIC_TAB: TabId = 'tabs-1';
/** `view/GRIT/html/gritLandingPage.html:131` — the GRIT-side static first tab. */
export const GRIT_STATIC_TAB: TabId = 'grit-tabs-1';
/** `connType='SM'` written on the `li` and on the panel (`setUpMonitor.html:339, 397`). */
export const CONN_TYPE_ATTR = 'connType';
/** jQuery-UI's disabled marker pair (`tabs("disable", index)`). */
export const DISABLED_ATTR = 'aria-disabled';
export const DISABLED_CLASS = 'ui-state-disabled';

/** The parts of entering Manage that live outside the tab strip. */
export interface ManageHost {
  hideNonCoreApp(): void;
  hideWelcome(): void;
  showSetUpMonitor(): void;
  hideLandingPages(): void;
  showSetupMonitorLanding(): void;
  setTitle(title: string): void;
  switchIcon(): void;
  applyLanguage(): void;
}

export interface TabRegistryOptions {
  hooks?: TabHooks;
  /** Overrides `MAX_CONNECTION` (tests only). */
  maxConnection?: number;
  /** Every registry-owned step of `enterManage`, in order (R11). */
  onStep?: (step: string) => void;
  /** `true` (default) queries the dead ids from 2.11.0; `false` uses the R45 fix. */
  mirrorOpenState?: boolean;
}

export interface ManageTabs extends TabRegistry {
  readonly staticTab: TabId;
  readonly gritStaticTab: TabId;
  /** True for `#tabs-1` / `#grit-tabs-1`: `list()` entries whose `deviceTileId` is `''`. */
  isStatic(tab: TabId): boolean;
  /** `scrollTopPosition[tab]` of `setUpMonitor.html:350-352`. */
  scrollTop(tab: TabId): number;
  status(tab: TabId): TabStatus | undefined;
  currentApp(): AppId;
  /** R45 fix: `#<tab>` present in the DOM, not the dead `#setupMonitorConn_*` lookup. */
  getOpenState(tab: TabId): boolean;
  /** Hiding axis; never touched by `enableTabs` (R12). */
  setHidden(tab: TabId, hidden: boolean): void;
  isHidden(tab: TabId): boolean;
  /** The exact steps taken by the last `enterManage`, in order. */
  enterSteps(): string[];
  /** The `li` (tab strip) of `tab`. */
  tabElement(tab: TabId): Element | undefined;
  /** The `.tab-view` panel of `tab`. */
  panel(tab: TabId): Element | undefined;
  /** R11: the ordered sequence `welcome.js:141-168` performs when Manage is entered. */
  enterManage(host: ManageHost): void;
}

interface TabEntry {
  record: TabRecord;
  li: Element;
  panel: Element;
}

/** `tabs-3` / `grit-tabs-3` (`setUpMonitor.html:438, 452-454, 2852-2855`). */
export function tabIdFor(connType: ConnType, index: number): TabId {
  return (connType === 'GRIT' ? 'grit-' : '') + 'tabs-' + index;
}

class ManageTabRegistry implements ManageTabs {
  readonly staticTab: TabId = STATIC_TAB;
  readonly gritStaticTab: TabId = GRIT_STATIC_TAB;

  private readonly hooks: TabHooks;
  private readonly maxConnection: number;
  private readonly onStep: ((step: string) => void) | undefined;
  private readonly mirrorOpenState: boolean;
  private readonly entries = new Map<TabId, TabEntry>();
  /** DOM order; static tabs first, then device tabs. */
  private readonly order: TabId[] = [];
  private readonly scrollPositions = new Map<TabId, number>();

  private nextIndex = INITIAL_TAB_COUNTER;
  private currentActive: TabId | '' = '';
  private app: AppId = 'HOME';
  private shellRoot: Element | null = null;
  private listElement: Element | null = null;
  private mainViewElement: Element | null = null;
  private lastEnterSteps: string[] = [];

  constructor(options: TabRegistryOptions = {}) {
    this.hooks = options.hooks ?? {};
    this.maxConnection = options.maxConnection ?? MAX_CONNECTION;
    this.onStep = options.onStep;
    this.mirrorOpenState = options.mirrorOpenState !== false;
  }

  get counter(): number {
    return this.nextIndex;
  }

  get active(): TabId | '' {
    return this.currentActive;
  }

  /* ------------------------------------------------------------------ shell */

  /**
   * Builds `#tabs` → `.tabs-view-data > #tabs-list` plus the `.main-view` holding the static
   * pages. **Nothing is shown and nothing is activated (R10):** after this call `active === ''`
   * and every panel carries `hidden`.
   */
  buildShell(root: Element): Element {
    const doc = this.document(root);

    const tabs = doc.createElement('div');
    tabs.id = 'tabs';

    const viewData = doc.createElement('div');
    viewData.className = 'tabs-view-data';
    const list = doc.createElement('ul');
    list.id = 'tabs-list';

    const staticPanel = this.createStaticTab(doc, list, STATIC_TAB, 'SM', 'Add device');
    const gritStaticPanel = this.createStaticTab(doc, list, GRIT_STATIC_TAB, 'GRIT', 'Add device');

    // `#add-newtab` sits inside the `<ul>` in the shipped markup (invalid HTML, kept as-is).
    const addNew = doc.createElement('div');
    addNew.id = 'add-newtab';
    addNew.className = 'addTab-btn';
    list.appendChild(addNew);

    viewData.appendChild(list);
    tabs.appendChild(viewData);

    const mainView = doc.createElement('div');
    mainView.className = 'row main-view';
    mainView.appendChild(staticPanel);
    mainView.appendChild(gritStaticPanel);
    tabs.appendChild(mainView);

    root.appendChild(tabs);

    this.shellRoot = root;
    this.listElement = list;
    this.mainViewElement = mainView;
    return tabs;
  }

  private document(root: Element): Document {
    return (root.ownerDocument ?? (root as unknown as Document)) as Document;
  }

  private requireDocument(): Document {
    const anchor = this.shellRoot ?? this.mainViewElement;
    if (!anchor) throw new Error('buildShell(root) must be called before create()');
    return this.document(anchor);
  }

  /** The static page: a real `li`/panel pair with `deviceTileId === ''`, so `list()` separates it. */
  private createStaticTab(doc: Document, list: Element, tab: TabId, connType: ConnType, title: string): Element {
    const li = doc.createElement('li');
    li.className = 'tab-title-list';
    li.setAttribute(CONN_TYPE_ATTR, connType);
    li.setAttribute('aria-controls', tab);

    const anchor = doc.createElement('a');
    anchor.className = 'sm-title elidedText';
    anchor.setAttribute('href', '#' + tab);
    anchor.textContent = title;
    li.appendChild(anchor);

    const verticalLine = doc.createElement('div');
    verticalLine.className = 'verticalline';
    li.appendChild(verticalLine);

    list.appendChild(li);

    const panel = doc.createElement('div');
    panel.setAttribute('id', tab);
    panel.setAttribute(CONN_TYPE_ATTR, connType);
    panel.className = 'tab-view addDevice' + (connType === 'GRIT' ? ' grit-connection' : '');
    panel.setAttribute('hidden', '');

    const record: TabRecord = {
      tab,
      index: 1,
      connType,
      deviceTileId: '',
      title,
      status: 'ready',
      details: { type: 'eth', name: title },
    };
    this.entries.set(tab, { record, li, panel });
    this.order.push(tab);
    return panel;
  }

  /* ------------------------------------------------------------------- reads */

  list(): TabRecord[] {
    const out: TabRecord[] = [];
    for (const tab of this.order) {
      const entry = this.entries.get(tab);
      if (entry) out.push(entry.record);
    }
    return out;
  }

  get(tab: TabId): TabRecord | undefined {
    return this.entries.get(tab)?.record;
  }

  /** The static `#tabs-1` / `#grit-tabs-1` are never device tabs. */
  isStatic(tab: TabId): boolean {
    return this.get(tab)?.deviceTileId === '';
  }

  byDevice(deviceTileId: DeviceTileId): TabRecord[] {
    return this.list().filter((record) => record.deviceTileId === deviceTileId);
  }

  /** Device tabs only: the original's `$("#tabs-list [connType='SM']")` never matched `#tabs-1`. */
  countFor(connType: ConnType): number {
    return this.list().filter((record) => record.deviceTileId !== '' && record.connType === connType).length;
  }

  /** R45: the original queried `#setupMonitorConn_*` / `#gritConn_*`, which the repo never creates,
   *  so it returned `false` unconditionally (`jarvisInterface.js:1436-1449`). Query the tab itself. */
  getOpenState(tab: TabId): boolean {
    if (this.mirrorOpenState) {
      const id = (tab.startsWith('grit') ? 'gritConn_' : 'setupMonitorConn_') + tab;
      return (this.shellRoot?.querySelector('#' + cssEscape(id))?.children.length ?? 0) > 0;
    }
    return this.shellRoot !== null && this.shellRoot.querySelector('#' + cssEscape(tab)) !== null;
  }

  scrollTop(tab: TabId): number {
    return this.scrollPositions.get(tab) ?? 0;
  }

  status(tab: TabId): TabStatus | undefined {
    return this.entries.get(tab)?.record.status;
  }

  currentApp(): AppId {
    return this.app;
  }

  tabElement(tab: TabId): Element | undefined {
    return this.entries.get(tab)?.li;
  }

  panel(tab: TabId): Element | undefined {
    return this.entries.get(tab)?.panel;
  }

  enterSteps(): string[] {
    return [...this.lastEnterSteps];
  }

  /* ------------------------------------------------------------------ writes */

  /** Next free index; `setUpMonitor.html:340, 464` — closed numbers are never reused. */
  allocIndex(): number {
    return this.nextIndex++;
  }

  create(input: CreateTabInput): TabRecord {
    if (this.deviceTabs().length >= this.maxConnection) {
      throw new Error(
        `cannot open more than ${this.maxConnection} simultaneous connections ` +
          '(NovatelIdConstants.maxConnection)',
      );
    }

    const doc = this.requireDocument();
    const index = typeof input.index === 'number' ? input.index : this.allocIndex();

    const tab = tabIdFor(input.connType, index);
    if (this.entries.has(tab)) throw new Error('tab already exists: ' + tab);
    // `tabCounter` advances after every tab (`setUpMonitor.html:464`); keep it ahead so a number
    // handed out here can never be reused either.
    if (index >= this.nextIndex) this.nextIndex = index + 1;

    const li = this.buildTabTitle(doc, tab, input.connType, input.title);
    const panel = this.buildPanel(doc, tab, input.connType);

    const list = this.listElement!;
    const addNew = list.querySelector('#add-newtab');
    if (addNew && addNew.parentNode) addNew.parentNode.insertBefore(li, addNew);
    else list.appendChild(li);
    this.mainViewElement!.appendChild(panel);

    const record: TabRecord = {
      tab,
      index,
      connType: input.connType,
      deviceTileId: input.deviceTileId,
      title: input.title,
      // `§6.1`: `[不存在] --addTab--> [connecting]`.
      status: 'connecting',
      details: { ...input.details },
    };
    this.entries.set(tab, { record, li, panel });
    this.order.push(tab);
    // `addTab` sets `tabs("option","active", index)` (`setUpMonitor.html:403`).
    this.activate(tab);
    return record;
  }

  /** `tabTemplate` of `setUpMonitor.html:339`: `li[connType] > a[href=#tab] + span.ui-icon-close`. */
  private buildTabTitle(doc: Document, tab: TabId, connType: ConnType, title: string): Element {
    const li = doc.createElement('li');
    li.setAttribute(CONN_TYPE_ATTR, connType);
    li.setAttribute('aria-controls', tab);
    li.classList.add(tab); // `li.addClass(id)` — `$(".<tab>")` selectors depend on it.

    const anchor = doc.createElement('a');
    anchor.setAttribute('href', '#' + tab);
    const name = doc.createElement('span');
    name.className = 'conn-name-title elidedText';
    name.textContent = title;
    const events = doc.createElement('span');
    events.className = 'events-count';
    events.textContent = '(0)';
    anchor.appendChild(name);
    anchor.appendChild(events);
    li.appendChild(anchor);

    const close = doc.createElement('span');
    close.className = 'ui-icon ui-icon-close';
    close.setAttribute('role', 'presentation');
    close.textContent = 'Remove Tab';
    li.appendChild(close);
    return li;
  }

  /**
   * The panel. The original string-concatenates and drops the space between `id` and `connType`
   * (`"<div id='"+id+"'connType='…'"`, `setUpMonitor.html:397`); §3.1 asks for well-formed HTML,
   * so the two attributes are written separately and serialise with a space.
   */
  private buildPanel(doc: Document, tab: TabId, connType: ConnType): Element {
    const panel = doc.createElement('div');
    panel.setAttribute('id', tab);
    panel.setAttribute(CONN_TYPE_ATTR, connType);
    panel.className = 'tab-view' + (connType === 'GRIT' ? ' grit-connection' : '');
    panel.setAttribute('hidden', '');
    return panel;
  }

  activate(tab: TabId): void {
    const entry = this.entries.get(tab);
    if (!entry) return;
    this.currentActive = tab;
    for (const [id, other] of this.entries) {
      if (id === tab) other.panel.removeAttribute('hidden');
      else other.panel.setAttribute('hidden', '');
    }
    this.hooks.onActivate?.(tab);
  }

  setStatus(tab: TabId, status: TabStatus): void {
    const entry = this.entries.get(tab);
    if (entry) entry.record.status = status;
  }

  setCurrentApp(app: AppId): void {
    this.app = app;
  }

  rememberScroll(tab: TabId, top: number): void {
    this.scrollPositions.set(tab, top);
  }

  /** R12: non-matching tabs are *disabled*, never hidden (`welcome.js:128-139`). */
  enableTabs(connType: ConnType): void {
    for (const tab of this.order) {
      const entry = this.entries.get(tab);
      if (!entry) continue;
      const type = entry.li.getAttribute(CONN_TYPE_ATTR);
      if (type === null) continue;
      this.applyDisabled(entry.li, type !== connType);
    }
  }

  private applyDisabled(li: Element, disabled: boolean): void {
    if (disabled) {
      li.setAttribute(DISABLED_ATTR, 'true');
      li.classList.add(DISABLED_CLASS);
    } else {
      li.removeAttribute(DISABLED_ATTR);
      li.classList.remove(DISABLED_CLASS);
    }
  }

  isEnabled(tab: TabId): boolean {
    const entry = this.entries.get(tab);
    if (!entry) return false;
    return entry.li.getAttribute(DISABLED_ATTR) !== 'true' && !entry.li.classList.contains(DISABLED_CLASS);
  }

  setHidden(tab: TabId, hidden: boolean): void {
    const entry = this.entries.get(tab);
    if (!entry) return;
    if (hidden) entry.li.setAttribute('hidden', '');
    else entry.li.removeAttribute('hidden');
  }

  isHidden(tab: TabId): boolean {
    return this.entries.get(tab)?.li.hasAttribute('hidden') ?? false;
  }

  close(
    tab: TabId,
    opts: { loggingConfirmed?: boolean; deviceToggleClicked?: boolean } = {},
  ): { activated: TabId | ''; removed?: TabRecord } {
    const entry = this.entries.get(tab);
    if (!entry) return { activated: this.currentActive };

    // R49: a device tab with a running log/recording asks first — unless already confirmed, or
    // the close came from the device-tile toggle (`setUpMonitor.html:871-921`).
    const skipQuestion = opts.deviceToggleClicked === true || opts.loggingConfirmed === true;
    if (!skipQuestion && entry.record.deviceTileId !== '' && this.hooks.beforeClose) {
      if (this.hooks.beforeClose(entry.record) === false) {
        return { activated: this.currentActive, removed: undefined };
      }
    }

    const record = entry.record;
    const wasActive = this.currentActive === tab;
    const position = this.order.indexOf(tab);

    entry.li.remove();
    entry.panel.remove();
    this.entries.delete(tab);
    this.order.splice(position, 1);
    this.hooks.onClosed?.(record);

    // Activation strategy of `setUpMonitor.html:944-951`.
    let activated: TabId | '' = this.currentActive;
    if (opts.deviceToggleClicked === true) {
      activated = STATIC_TAB;
    } else if (wasActive) {
      activated = this.neighbourOf(position) ?? STATIC_TAB;
    }

    if (wasActive || opts.deviceToggleClicked === true) {
      if (this.entries.has(activated)) this.activate(activated);
      else this.currentActive = '';
    }
    return { activated, removed: record };
  }

  /** Nearest remaining *device* tab to the right of `position`, then to the left. */
  private neighbourOf(position: number): TabId | undefined {
    const usable = (tab: TabId): boolean => !this.isStatic(tab) && this.isEnabled(tab);
    for (let i = position; i < this.order.length; i++) if (usable(this.order[i])) return this.order[i];
    for (let i = position - 1; i >= 0; i--) if (usable(this.order[i])) return this.order[i];
    return undefined;
  }

  /* -------------------------------------------------------------- enterManage */

  /** R11: `welcome.js:141-168`, in the doc's order. Visibility is triggered here, never by the shell. */
  enterManage(host: ManageHost): void {
    this.lastEnterSteps = [];

    host.hideNonCoreApp();
    host.hideWelcome();
    host.showSetUpMonitor();
    host.hideLandingPages();
    host.showSetupMonitorLanding();
    host.setTitle('Manage');
    host.switchIcon();

    // `$("#tabs-list li").show()` then hide PI/GRIT (`welcome.js:152-154`).
    this.step('hideTabs:PI|GRIT');
    for (const tab of this.order) {
      const type = this.entries.get(tab)?.li.getAttribute(CONN_TYPE_ATTR);
      this.setHidden(tab, type === 'PI' || type === 'GRIT');
    }

    host.applyLanguage();

    this.step('enableTabs:SM');
    this.enableTabs('SM');

    this.step('activate:' + STATIC_TAB);
    this.activate(STATIC_TAB);
  }

  private step(name: string): void {
    this.lastEnterSteps.push(name);
    this.onStep?.(name);
  }

  private deviceTabs(): TabRecord[] {
    return this.list().filter((record) => record.deviceTileId !== '');
  }
}

export function createTabRegistry(options: TabRegistryOptions = {}): ManageTabs {
  return new ManageTabRegistry(options);
}
