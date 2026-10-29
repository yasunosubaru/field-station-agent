/**
 * Container layer — `jarvisInterface.createMainPanel` (`01_解包/app/jarvisInterface.js:893-1141`).
 *
 * The contract is `03_分析/01_Manage主界面与视图层.md §2.7`: **sixteen append steps per tab, in a
 * fixed order**, plus R13-R16. Three facts drive everything below:
 *
 *  - steps 5-9 are appended to `#main-panel-<tab>`, so the *append* order and the *document* order
 *    stop being the same thing at step 11 (`#status-config-<tab>`, step 6, receives step 11 later):
 *    `#fetch-loader-<tab>` and `#status-components-<tab>` must be **descendants** of
 *    `#main-panel-<tab>` (R13) — that is asserted structurally, never by position;
 *  - steps 12-16 are appended to `#<tab>`, so `#popupModal`, `#helpModal`, `#connection-loader`,
 *    `#loader-text-id` … exist **once per tab** (R14). Every lookup has to be `#<tab> <selector>`,
 *    which is what `scopedSelector()` is for;
 *  - the config page (step 10) is one of three templates — standard 8 pills / GIII single Logging /
 *    Longhorn two pages (R15) — selected by the *feature flags*, never by the generation string:
 *    `createMainPanel`'s own `if/else if` chain (`:970-1004`) tests `getIsLongHorn` and `getIsGIII`
 *    first, and so does `configPageKind()`.
 *
 * Text is never written here: every label ships as a `data-lang-*` marker with an empty element, as
 * R35 requires (the original inlined `Language[...]` strings *and* the marker; the reimplementation
 * keeps only the marker, and `language.ts` fills the text in).
 *
 * Two id details are deliberately *not* taken from `ids.ts`:
 *  - `#connection-loader` is a **plain** id in the original (`:1129`, `id='connection-loader'`), not
 *    `connectionLoaderId(tab)`. It is therefore duplicated once per tab, exactly as R14 describes,
 *    and only the `#<tab> ` prefix makes it unambiguous. Fidelity wins over the helper.
 *  - the inner connection-loader div keeps the hard-coded `id="fetch-loader-tabs-1"` (`:1130`), so
 *    for tab `tabs-1` the document really does contain that id twice. Kept verbatim; noted in the
 *    tests.
 */

import {
  configComponentsId,
  eventsPanelId,
  fetchLoaderId,
  mainPanelId,
  menuBarPanelId,
  statusComponentsId,
  statusComponentsPage2Id,
  statusConfigId,
  statusPanelId,
} from './ids.ts';
import { DEFAULT_FEATURES, type FeatureFlags, type TabId, type TilePage } from './types.ts';

/* ------------------------------------------------------------------ DOM shim surface */

interface Dom {
  createElement(tagName: string): DomElement;
}

interface DomElement {
  id: string;
  className: string;
  innerHTML: string;
  readonly firstElementChild: DomElement | null;
  readonly children: DomElement[];
  readonly classList: {
    add(...tokens: string[]): void;
    remove(...tokens: string[]): void;
    toggle(token: string, force?: boolean): boolean;
    contains(token: string): boolean;
  };
  readonly style: { display: string; visibility: string };
  readonly ownerDocument: Dom;
  appendChild(node: unknown): unknown;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  remove(): void;
}

function documentOf(node: DomElement): Dom {
  return node.ownerDocument ?? (node as unknown as Dom);
}

function createDiv(dom: Dom, className: string, id: string): DomElement {
  const element = dom.createElement('div');
  element.className = className;
  element.id = id;
  return element;
}

/** Parse a template that must yield exactly one root element (as `$('#id').append(html)` did). */
function parseOne(dom: Dom, html: string): DomElement {
  const holder = dom.createElement('div');
  holder.innerHTML = html;
  const first = holder.firstElementChild;
  if (!first) throw new Error('containers: template produced no element');
  return first;
}

/** Parse a template that yields several sibling roots (the step 11 page tabs). */
function parseMany(dom: Dom, html: string): DomElement[] {
  const holder = dom.createElement('div');
  holder.innerHTML = html;
  return [...holder.children];
}

function setHidden(element: DomElement, hidden: boolean): void {
  // `$(el).hide()` / `.show()`: keep the inline display *and* the attribute, since both are read.
  if (hidden) {
    element.setAttribute('hidden', '');
    element.style.display = 'none';
  } else {
    element.removeAttribute('hidden');
    element.style.display = '';
  }
}

/* --------------------------------------------------- pure step description (§2.7 / R13-R16) */

export type ConfigPageKind = 'standard' | 'giii' | 'longhorn';

/**
 * R15's three-way choice, mirroring `:970-1004` verbatim: standard only when *neither* flag is set,
 * GIII before Longhorn when both are set (the original's `else if` order).
 */
export function configPageKind(features: FeatureFlags): ConfigPageKind {
  if (!features.isLongHorn && !features.isGIII) return 'standard';
  if (features.isGIII) return 'giii';
  return 'longhorn';
}

/** R14: the only safe way to name a per-tab duplicate id (`#popupModal` → `#tabs-3 #popupModal`). */
export function scopedSelector(tab: TabId, selector: string): string {
  return `#${tab} ${selector}`;
}

export interface PanelStep {
  /** 1-based step number of §2.7. */
  step: number;
  label: string;
  /** tab-scoped selectors of the element(s) this step appends, in append order. */
  selectors: string[];
  /**
   * Id of each root this step appends, in append order (`null` for the roots that ship without one:
   * the GIII config row, the overlay/help/translucent wrappers and the Longhorn config panel).
   * Only the *roots* — steps 5-9 are descendants of step 4, so flattening whole subtrees would
   * report every container twice.
   */
  ids: Array<string | null>;
}

/**
 * The sixteen steps of §2.7 as data: it is what `buildPanels` must produce, and it is what the
 * tests compare the real DOM against (`PanelBuild.stepIds()`), so a template typo cannot slip by.
 */
export function panelSteps(tab: TabId, features: FeatureFlags = DEFAULT_FEATURES): PanelStep[] {
  const kind = configPageKind(features);
  const scoped = (selector: string): string => scopedSelector(tab, selector);

  const steps: PanelStep[] = [
    { step: 1, label: 'events-panel', selectors: [scoped('#' + eventsPanelId(tab))], ids: [eventsPanelId(tab)] },
    { step: 2, label: 'menuBar-panel', selectors: [scoped('#' + menuBarPanelId(tab))], ids: [menuBarPanelId(tab)] },
    { step: 3, label: 'status-panel', selectors: [scoped('#' + statusPanelId(tab))], ids: [statusPanelId(tab)] },
    { step: 4, label: 'main-panel', selectors: [scoped('#' + mainPanelId(tab))], ids: [mainPanelId(tab)] },
    { step: 5, label: 'fetch-loader', selectors: [scoped('#' + fetchLoaderId(tab))], ids: [fetchLoaderId(tab)] },
    { step: 6, label: 'status-config', selectors: [scoped('#' + statusConfigId(tab))], ids: [statusConfigId(tab)] },
    {
      step: 7,
      label: 'status-components (page 1, Packery container)',
      selectors: [scoped('#' + statusComponentsId(tab))],
      ids: [statusComponentsId(tab)],
    },
    {
      step: 8,
      label: 'status-components-page2',
      selectors: [scoped('#' + statusComponentsPage2Id(tab))],
      ids: [statusComponentsPage2Id(tab)],
    },
    { step: 9, label: 'config-components', selectors: [scoped('#' + configComponentsId(tab))], ids: [configComponentsId(tab)] },
  ];

  if (kind === 'standard') {
    steps.push({
      step: 10,
      label: 'config page — standard 8 pills',
      selectors: [scoped('#config-tabs')],
      ids: ['config-tabs'],
    });
  } else if (kind === 'giii') {
    steps.push({
      step: 10,
      label: 'config page — GIII single Logging tab + restart notice',
      selectors: [scoped(`#${configComponentsId(tab)} > .row`)],
      ids: [null],
    });
  } else {
    steps.push({
      step: 10,
      label: 'config page — Longhorn two pages',
      selectors: [scoped(`#longhorn-config-${tab}`), scoped(`#${configComponentsId(tab)} .longhorn-config-panel`)],
      ids: [`longhorn-config-${tab}`, null],
    });
  }

  steps.push({
    step: 11,
    label: 'status page tabs + reset layout',
    selectors: [scoped('#statusPage1'), scoped('#statusPage2'), scoped('#resetDefault')],
    ids: ['statusPage1', 'statusPage2', 'resetDefault'],
  });
  steps.push({
    step: 12,
    label: 'popup-modal #tabs-popup',
    selectors: [scoped('#tabs-popup')],
    ids: ['tabs-popup'],
  });
  steps.push({
    step: 13,
    label: 'cancel-modal [data-popup=overlay-popup]',
    selectors: [scoped('[data-popup="overlay-popup"]')],
    ids: [null],
  });
  steps.push({ step: 14, label: 'help-modal', selectors: [scoped('.help-modal')], ids: [null] });
  steps.push({ step: 15, label: 'translucent-layout', selectors: [scoped('.translucent-layout')], ids: [null] });
  steps.push({
    step: 16,
    label: 'connection-loader',
    selectors: [scoped('#connection-loader')],
    ids: ['connection-loader'],
  });

  return steps;
}

/** Every id the sixteen steps introduce, flattened in append order. */
export function panelIdsInOrder(tab: TabId, features: FeatureFlags = DEFAULT_FEATURES): string[] {
  return panelSteps(tab, features)
    .flatMap((step) => step.ids)
    .filter((id): id is string => id !== null);
}

/* --------------------------------------------------------------------- templates */

function standardConfigHtml(tab: TabId): string {
  const pill = (id: string, marker: string, target: string, extra = ''): string =>
    `<li id="${id}" class="nav-item configtabs"><a${extra} data-lang-${marker} href="#${target}" data-toggle="pill"></a></li>`;
  const panel = (id: string, extra = ''): string => `<div id="${id}" class="totaldata${extra}"></div>`;
  return `<div class="row" id="config-tabs">
  <div class="config-tabs">
    <ul class="nav nav-pills tabbing">
      <li id="positionTab" class="nav-item configtabs active"><a class="elidedText" data-lang-positioning href="#config-pos-${tab}" data-toggle="pill"></a></li>
      ${pill('portConfig', 'ports', `config-ports-${tab}`)}
      ${pill('loggingConfig', 'logging', `config-log-${tab}`, ' class="elidedText"')}
      ${pill('alignConfig', 'align', `config-align-${tab}`)}
      ${pill('spanTab', 'span', `config-span-${tab}`)}
      ${pill('radioConfig', 'radio', `config-radio-${tab}`, ' class="elidedText"')}
      ${pill('gnssConfig', 'gnss', `config-gnss-${tab}`, ' class="elidedText"')}
      ${pill('spoofingConfig', 'spoofing-title', `config-spoofing-${tab}`, ' class="elidedText"')}
    </ul>
  </div>
  <div class="tab-content">
    ${panel(`config-pos-${tab}`, ' active active-config')}
    ${panel(`config-ports-${tab}`)}
    ${panel(`config-log-${tab}`)}
    ${panel(`config-align-${tab}`)}
    ${panel(`config-span-${tab}`)}
    ${panel(`config-radio-${tab}`)}
    ${panel(`config-gnss-${tab}`)}
    ${panel(`config-spoofing-${tab}`)}
  </div>
  <div class="configtab-bottom-gap"></div>
</div>`;
}

function giiiConfigHtml(tab: TabId): string {
  return `<div class="row">
  <div class="giii-logging-restart-container" style="display: block;">
    <div class="giii-logging-restart-worning">
      <span class="giii-restart-alert-icon">&#33;</span>
    </div>
    <div class="giii-logging-restart-text">
      <span class="giii-logging-restart-txt" style="display: block;" data-lang-receiver-operational-state></span>
      <span class="giii-logging-restart-data" style="display: block;" data-lang-receiver-operational-contnet></span>
    </div>
    <div class="giii-logging-restart-btns">
      <div class="row">
        <div class="col-12">
          <button id="giii-loggingDismiss-btn" type="button" class="btn btn-default whiteBtn" data-lang-dismiss></button>
          <button id="giii-loggingRestart-btn" type="button" class="btn btn-default darkBtn" data-lang-restart-giii></button>
        </div>
      </div>
    </div>
  </div>
  <div class="config-tabs giii-config-tabs">
    <ul class="nav nav-pills tabbing giii-logging-tab">
      <li id="loggingConfig" class="nav-item configtabs giii-configtabs"><a class="giii-logging-title elidedText" id="giii-file-path" data-lang-logging href="#config-log-${tab}" data-toggle="pill"></a></li>
    </ul>
  </div>
  <div class="tab-content giii-tab-content">
    <div id="config-log-${tab}" class="totaldata">Log component</div>
  </div>
  <div class="configtab-bottom-gap"></div>
</div>`;
}

function longhornTabsHtml(): string {
  return `<div class="longhorn-config-tabs col-xs-6 active-tab" id="lghn-positioningPage">
  <a data-lang-page1 id="lghn-positioning-pages"></a>
</div>
<div class="status-page-tabs col-xs-6" id="lghn-loggingPage">
  <a data-lang-logging id="lghn-logging-pages"></a>
</div>`;
}

function longhornPanelHtml(tab: TabId): string {
  return `<div class="longhorn-config-panel">
  <div id="config-pos-${tab}" class="longhorn-position-config lghn-panel"></div>
  <div id="config-align-${tab}" class="lghn-panel"></div>
  <div id="config-span-${tab}" class="lghn-panel"></div>
  <div id="config-ports-${tab}" class="lghn-panel"></div>
  <div id="config-log-${tab}" class="lghn-panel"></div>
  <div id="config-radio-${tab}" class="lghn-panel"></div>
</div>`;
}

/** Step 11 (`:1035-1044`). R16 needs all three of its ids inside `#status-config-<tab>`. */
function statusPageTabsHtml(): string {
  return `<div class="status-page-tabs col-xs-6 active-tab" id="statusPage1">
  <a data-lang-page1 id="status-pages"></a>
</div>
<div class="status-page-tabs col-xs-6" id="statusPage2">
  <a data-lang-page2 id="status-pages2"></a>
</div>
<div class="reset-default-layout col-xs-6" id="resetDefault">
  <a data-lang-reset-default-layout id="status-default"></a>
</div>`;
}

/** Step 12 (`:1046-1069`). */
function tabsPopupHtml(): string {
  return `<div class="popup-modal" id="tabs-popup" data-popup>
  <div class="modal" id="popupModal" role="dialog" data-backdrop="static">
    <div class="modal-dialog modal-md">
      <div class="modal-content">
        <div class="modal-header">
          <button type="button" tabIndex="5" class="close-btn" data-dismiss="modal"></button>
          <h4 class="modal-title"></h4>
        </div>
        <div class="modal-body"><p></p></div>
        <div class="modal-footer"></div>
        <div id="btn-template" class="Template" style="display:none">
          <button type="button" class="btn btn-default whiteBtn"></button>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

/** Step 13 (`:1073-1096`). */
function overlayPopupHtml(): string {
  return `<div class="cancel-modal container" data-popup="overlay-popup">
  <div class="modal fade" id="overlayPopupModal" role="dialog">
    <div class="modal-dialog modal-md">
      <div class="modal-content">
        <div class="modal-header">
          <button type="button" tabIndex="6" class="close-btn" data-dismiss="modal"></button>
          <h4 class="modal-title"></h4>
        </div>
        <div class="modal-body"><p></p></div>
        <div class="modal-footer"></div>
        <div id="overlay-btn-template" class="Template" style="display:none">
          <button type="button" class="btn btn-default whiteBtn"></button>
        </div>
      </div>
    </div>
  </div>
</div>`;
}

/** Step 14 (`:1100-1116`). The `help.helpContent()` payload is the help layer's business. */
function helpModalHtml(): string {
  return `<div class="help-modal container">
  <div class="modal fade" id="helpModal" role="dialog">
    <div class="modal-dialog modal-md">
      <div class="modal-content">
        <div class="modal-header">
          <button type="button" tabIndex="7" class="close-btn" data-dismiss="modal"></button>
          <h4 class="modal-title" data-lang-help></h4>
        </div>
        <div class="modal-body"></div>
        <div class="modal-footer"></div>
      </div>
    </div>
  </div>
</div>`;
}

/** Step 15 (`:1123-1127`); `.counter-val` starts at 30. */
function translucentLayoutHtml(): string {
  return `<div class="translucent-layout">
  <div class="applying-spinner"></div>
  <div class="apply-label"></div>
  <div class="counter-val">30</div>
</div>`;
}

/**
 * Step 16 (`:1129-1138`). Note the hard-coded `fetch-loader-tabs-1` and the `data-lang-connecting`
 * marker that `hideApplicationLoader` resets to CONNECTING (R43).
 */
function connectionLoaderHtml(): string {
  return `<div id="connection-loader" style="display: none;">
  <div class="fetch-loader" id="fetch-loader-tabs-1" style="display: block;">
    <div class="load-screen inset connection-loader" id="load-screen">
      <div class="loader-class" id="loader-class" style="display: block;">
        <div class="applying-spinner" id="loader-img"></div>
        <p class="loader-text" id="loader-text-id" data-lang-connecting></p>
      </div>
    </div>
  </div>
</div>`;
}

/* ------------------------------------------------------------------------ the build */

export interface PanelBuild {
  tab: TabId;
  host: Element;
  kind: ConfigPageKind;
  /** roots appended by each of the sixteen steps, in step order (a step may append several). */
  steps: Element[][];
  eventsPanel: Element;
  menuBarPanel: Element;
  statusPanel: Element;
  mainPanel: Element;
  fetchLoader: Element;
  statusConfig: Element;
  statusComponents: Element;
  statusComponentsPage2: Element;
  configComponents: Element;
  /** step 10's root (Longhorn appends the tabbing row first, then the panel). */
  configPage: Element;
  page1Tab: Element;
  page2Tab: Element;
  resetDefault: Element;
  tabsPopup: Element;
  overlayPopup: Element;
  helpModal: Element;
  translucentLayout: Element;
  connectionLoader: Element;
  /**
   * The id of each root the sixteen steps appended, in append order (`null` where a root has no
   * id) — the assertable §2.7 order, to be compared with `panelSteps(...).flatMap(s => s.ids)`.
   */
  stepIds(): Array<string | null>;
}

export interface ContainerOptions {
  /** R15 reads the flags, never a global. Defaults to `DEFAULT_FEATURES` (standard). */
  features?: () => FeatureFlags;
  /** R27/R28's side effect: `satelliteTracking.resetTrackingUI(tab)` (GIII: the giii twin). */
  onPageChange?: (tab: TabId, page: TilePage) => void;
}

export interface ContainerKit {
  /** §2.7 steps 1-16, in order, appended to `host` (the `#<tab>` panel). */
  buildPanels(tab: TabId, host: Element): PanelBuild;
  /** R27/R28: the page1/page2 switch; returns the page now current (for `devicedetails.menu`). */
  setPage(tab: TabId, page: TilePage): TilePage;
  currentPage(tab: TabId): TilePage;
  build(tab: TabId): PanelBuild | undefined;
  /** Tab close: drop the sixteen steps of that tab from the DOM. */
  unmount(tab: TabId): void;
}

function normalizePage(page: TilePage): TilePage {
  return page === 'page2' ? 'page2' : '';
}

export function createContainers(options: ContainerOptions = {}): ContainerKit {
  const featuresOf = options.features ?? ((): FeatureFlags => DEFAULT_FEATURES);
  const builds = new Map<TabId, PanelBuild>();
  const pages = new Map<TabId, TilePage>();

  function buildPanels(tab: TabId, host: Element): PanelBuild {
    const features = featuresOf();
    const kind = configPageKind(features);
    const domHost = host as unknown as DomElement;
    const dom = documentOf(domHost);
    const steps: DomElement[][] = [];

    // 1-4: the four top-level panels of each tab (`:895-913`).
    const eventsPanel = createDiv(dom, 'events-panel complete-panel', eventsPanelId(tab));
    domHost.appendChild(eventsPanel);
    steps.push([eventsPanel]);

    const menuBarPanel = createDiv(dom, 'menuBar-panel complete-panel', menuBarPanelId(tab));
    domHost.appendChild(menuBarPanel);
    steps.push([menuBarPanel]);

    const statusPanel = createDiv(dom, 'status-panel complete-panel', statusPanelId(tab));
    domHost.appendChild(statusPanel);
    steps.push([statusPanel]);

    const mainPanel = createDiv(dom, 'main-panel complete-panel', mainPanelId(tab));
    domHost.appendChild(mainPanel);
    steps.push([mainPanel]);

    // 5-9: children of `#main-panel-<tab>` (R13).
    const fetchLoader = createDiv(dom, 'fetch-loader', fetchLoaderId(tab));
    mainPanel.appendChild(fetchLoader);
    steps.push([fetchLoader]);

    const statusConfig = createDiv(dom, 'row status-config', statusConfigId(tab));
    mainPanel.appendChild(statusConfig);
    steps.push([statusConfig]);

    const statusComponents = createDiv(dom, 'status-components manage-status-components', statusComponentsId(tab));
    mainPanel.appendChild(statusComponents);
    steps.push([statusComponents]);

    const statusComponentsPage2 = createDiv(dom, 'status-components-page2', statusComponentsPage2Id(tab));
    mainPanel.appendChild(statusComponentsPage2);
    steps.push([statusComponentsPage2]);

    const configComponents = createDiv(dom, 'config-components', configComponentsId(tab));
    mainPanel.appendChild(configComponents);
    steps.push([configComponents]);

    // 10: one of the three config page templates (R15).
    let configRoots: DomElement[];
    if (kind === 'standard') {
      configRoots = [parseOne(dom, standardConfigHtml(tab))];
    } else if (kind === 'giii') {
      configRoots = [parseOne(dom, giiiConfigHtml(tab))];
    } else {
      const tabbing = createDiv(dom, 'row longhorn-config-tabbing', `longhorn-config-${tab}`);
      for (const element of parseMany(dom, longhornTabsHtml())) tabbing.appendChild(element);
      configComponents.classList.add('longhorn-config');
      configRoots = [tabbing, parseOne(dom, longhornPanelHtml(tab))];
    }
    for (const root of configRoots) configComponents.appendChild(root);
    steps.push(configRoots);

    // 11: into `#status-config-<tab>` — i.e. *before* steps 7-9 in document order (R16).
    const pageTabs = parseMany(dom, statusPageTabsHtml());
    for (const element of pageTabs) statusConfig.appendChild(element);
    steps.push(pageTabs);
    const [page1Tab, page2Tab, resetDefault] = pageTabs;

    // 12-16: appended to `#<tab>`, hence one copy per tab (R14).
    const tabsPopup = parseOne(dom, tabsPopupHtml());
    domHost.appendChild(tabsPopup);
    steps.push([tabsPopup]);

    const overlayPopup = parseOne(dom, overlayPopupHtml());
    domHost.appendChild(overlayPopup);
    steps.push([overlayPopup]);

    const helpModal = parseOne(dom, helpModalHtml());
    domHost.appendChild(helpModal);
    steps.push([helpModal]);

    const translucentLayout = parseOne(dom, translucentLayoutHtml());
    domHost.appendChild(translucentLayout);
    steps.push([translucentLayout]);

    const connectionLoader = parseOne(dom, connectionLoaderHtml());
    domHost.appendChild(connectionLoader);
    steps.push([connectionLoader]);

    const built: PanelBuild = {
      tab,
      host,
      kind,
      steps: steps as unknown as Element[][],
      eventsPanel,
      menuBarPanel,
      statusPanel,
      mainPanel,
      fetchLoader,
      statusConfig,
      statusComponents,
      statusComponentsPage2,
      configComponents,
      configPage: configRoots[0],
      page1Tab,
      page2Tab,
      resetDefault,
      tabsPopup,
      overlayPopup,
      helpModal,
      translucentLayout,
      connectionLoader,
      stepIds(): Array<string | null> {
        const out: Array<string | null> = [];
        for (const roots of steps) for (const root of roots) out.push(root.id || null);
        return out;
      },
    } as PanelBuild;

    builds.set(tab, built);
    pages.set(tab, '');
    return built;
  }

  function setPage(tab: TabId, page: TilePage): TilePage {
    const wanted = normalizePage(page);
    const built = builds.get(tab);
    if (!built) return wanted;
    const domEl = (element: Element): DomElement => element as unknown as DomElement;

    const showPage1 = wanted !== 'page2';
    setHidden(domEl(built.statusComponents), !showPage1);
    setHidden(domEl(built.statusComponentsPage2), showPage1);
    // `:356-359`: leaving the config view shows the status view again.
    setHidden(domEl(built.configComponents), true);
    setHidden(domEl(built.statusConfig), false);

    domEl(built.page1Tab).classList.toggle('active-tab', showPage1);
    domEl(built.page2Tab).classList.toggle('active-tab', !showPage1);
    domEl(built.resetDefault).style.visibility = showPage1 ? 'visible' : 'hidden';

    pages.set(tab, wanted);
    options.onPageChange?.(tab, wanted);
    return wanted;
  }

  return {
    buildPanels,
    setPage,
    currentPage: (tab) => pages.get(tab) ?? '',
    build: (tab) => builds.get(tab),
    unmount(tab: TabId): void {
      const built = builds.get(tab);
      if (!built) return;
      const domEl = (element: Element): DomElement => element as unknown as DomElement;
      for (const roots of built.steps) for (const root of roots) domEl(root).remove();
      builds.delete(tab);
      pages.delete(tab);
    },
  };
}

/* ------------------------------------------------------------------ module-level default */

let defaultKit: ContainerKit | null = null;

/**
 * The literal `buildPanels(tab, host)` of the task, backed by a lazily created default kit: the
 * standard model, one registry for the whole page like the original's `connectionDetailsMap`.
 * Use `createContainers()` when a GIII/Longhorn page or an isolated registry is needed.
 */
export function buildPanels(tab: TabId, host: Element): PanelBuild {
  defaultKit ??= createContainers();
  return defaultKit.buildPanels(tab, host);
}

/** `setPage` on the same default kit as `buildPanels` above. */
export function setPage(tab: TabId, page: TilePage): TilePage {
  defaultKit ??= createContainers();
  return defaultKit.setPage(tab, page);
}

export function currentPage(tab: TabId): TilePage {
  return defaultKit ? defaultKit.currentPage(tab) : '';
}
