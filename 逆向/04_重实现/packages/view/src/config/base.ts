import type { TabId } from '../types.ts';
import type {
  CommandResponse,
  ConfigPage,
  ConfigPageContext,
  ConfigPageRuntime,
} from './types.ts';
import { COMMAND_RESPONSE } from './types.ts';
import { ConfigPageState, TripleStateStore } from './state.ts';

export interface ConfigPageDefinition {
  name: string;
  fragmentPath: string;
  containerId(tab: TabId): string;
}

export function scopedQuery(
  context: ConfigPageContext,
  tab: TabId,
  selector: string,
): Element | null {
  const root = context.document.getElementById(tab);
  if (!root) return context.document.querySelector(selector);
  const own = root.querySelector(selector);
  if (own) return own;
  if (selector.startsWith('#')) {
    const id = selector.slice(1);
    const direct = context.document.getElementById(id);
    if (direct && root.contains(direct)) return direct;
  }
  return null;
}

export function scopedQueryAll(
  context: ConfigPageContext,
  tab: TabId,
  selector: string,
): Element[] {
  const root = context.document.getElementById(tab);
  if (!root) return [...context.document.querySelectorAll(selector)];
  return [...root.querySelectorAll(selector)];
}

export function setVisible(element: Element | null, visible: boolean): void {
  if (!element) return;
  const styled = element as Element & { style?: CSSStyleDeclaration };
  if (styled.style) styled.style.display = visible ? 'block' : 'none';
  else if (visible) element.removeAttribute('hidden');
  else element.setAttribute('hidden', '');
}

export function setValue(context: ConfigPageContext, tab: TabId, selector: string, value: unknown): boolean {
  const element = scopedQuery(context, tab, selector) as
    | (Element & { value?: string; checked?: boolean })
    | null;
  if (!element) return false;
  const text = value === undefined || value === null ? '' : String(value);
  // `minidom` carries a `value` field on **every** element (`minidom.ts:732`), so `'value' in
  // element` is true for a `<span>` too — writing `.value` on a span puts the text nowhere the
  // serialiser or the browser can see it. The tag decides, exactly like a browser's form controls.
  const tag = String(element.tagName ?? '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'option') {
    element.value = text;
  } else {
    element.textContent = text;
  }
  return true;
}

export function setChecked(context: ConfigPageContext, tab: TabId, selector: string, checked: boolean): boolean {
  const element = scopedQuery(context, tab, selector) as
    | (Element & { checked?: boolean })
    | null;
  if (!element) return false;
  if ('checked' in element) element.checked = checked;
  else if (checked) element.setAttribute('checked', '');
  else element.removeAttribute('checked');
  return true;
}

export function setActive(
  context: ConfigPageContext,
  tab: TabId,
  groupSelector: string,
  itemIdOrText: string,
): boolean {
  const items = scopedQueryAll(context, tab, `${groupSelector} li`);
  const wanted = itemIdOrText.toLowerCase();
  let hit = false;
  for (const item of items) {
    const match =
      item.id.toLowerCase() === wanted || (item.textContent ?? '').trim().toLowerCase() === wanted;
    item.classList.toggle('active', match);
    if (match) hit = true;
  }
  return hit;
}

export function activeText(context: ConfigPageContext, tab: TabId, selector: string): string {
  const element = scopedQuery(context, tab, `${selector} li.active`) ?? scopedQuery(context, tab, selector);
  return (element?.textContent ?? '').trim();
}

export function addError(
  context: ConfigPageContext,
  tab: TabId,
  containerSelector: string,
  marker = 'data-lang-enter-valid',
): void {
  const container = scopedQuery(context, tab, containerSelector);
  if (!container) return;
  container.classList.add('error-text');
  if (!container.querySelector('.error-info')) {
    const node = context.document.createElement('div');
    node.className = 'error-info';
    const span = context.document.createElement('span');
    span.setAttribute(marker, '');
    span.textContent = context.translate(marker.slice('data-lang-'.length).toUpperCase().replace(/-/g, '_'));
    node.appendChild(span);
    container.appendChild(node);
  }
}

export function clearErrors(context: ConfigPageContext, tab: TabId): number {
  let count = 0;
  for (const node of scopedQueryAll(context, tab, '.error-info')) {
    node.remove();
    count += 1;
  }
  for (const node of scopedQueryAll(context, tab, '.error-text, .error-border')) {
    node.classList.remove('error-text', 'error-border');
    count += 1;
  }
  return count;
}

export function elementText(context: ConfigPageContext, tab: TabId, selector: string): string {
  return (scopedQuery(context, tab, selector)?.textContent ?? '').trim();
}

export function elementValue(context: ConfigPageContext, tab: TabId, selector: string): string {
  const element = scopedQuery(context, tab, selector) as
    | (Element & { value?: string; checked?: boolean })
    | null;
  if (!element) return '';
  if (element.tagName.toLowerCase() === 'input' && element.getAttribute('type') === 'checkbox') {
    return element.checked ? 'true' : 'false';
  }
  return element.value ?? element.textContent ?? '';
}

export function suffixId(element: Element | null, tab: TabId): string | undefined {
  if (!element || !tab || tab === 'webui') return undefined;
  const id = element.id;
  if (!id) return undefined;
  const next = id.endsWith(`-${tab}`) ? id : `${id}-${tab}`;
  element.id = next;
  return next;
}

/** The shared half of R4: every collapse target and its heading href get the tab suffix. */
export function namespaceCollapsePanels(container: Element, tab: TabId): void {
  if (!tab || tab === 'webui') return;
  for (const panel of [...container.querySelectorAll('.panel-default .panel-collapse[id]')]) {
    const oldId = panel.id;
    const next = suffixId(panel, tab)!;
    const parent = panel.parentElement;
    const heading = parent?.querySelector(`[href="#${oldId}"]`);
    if (heading) heading.setAttribute('href', `#${next}`);
  }
}

/** Span/align/logging toggle labels and their checkbox/radio inputs. */
export function namespaceToggleSwitch(container: Element, tab: TabId): void {
  if (!tab || tab === 'webui') return;
  for (const label of [...container.querySelectorAll('.toggle-switch label[for]')]) {
    const oldFor = label.getAttribute('for') ?? '';
    const input = container.querySelector(`input#${oldFor}`);
    const next = suffixId(input, tab) ?? `${oldFor}-${tab}`;
    label.setAttribute('for', next);
  }
}

export function namespaceRadioInputs(container: Element, tab: TabId): void {
  if (!tab || tab === 'webui') return;
  for (const label of [...container.querySelectorAll('.radio-input-container[for]')]) {
    const oldFor = label.getAttribute('for') ?? '';
    const input = container.querySelector(`input#${oldFor}`);
    const next = suffixId(input, tab) ?? `${oldFor}-${tab}`;
    label.setAttribute('for', next);
  }
}

export function applyPageMarkers(
  context: ConfigPageContext,
  tab: TabId,
  rootSelector?: string,
): number {
  const root =
    (rootSelector ? scopedQuery(context, tab, rootSelector) : context.document.getElementById(tab)) ??
    context.document;
  let written = 0;
  for (const element of [...root.querySelectorAll('*')]) {
    for (const name of element.getAttributeNames()) {
      if (name !== 'data-lang' && !name.startsWith('data-lang-')) continue;
      const suffix = name === 'data-lang' ? '' : name.slice('data-lang-'.length);
      if (!suffix) continue;
      const candidates = [suffix.toUpperCase(), suffix.toUpperCase().replace(/-/g, '_')];
      const key = candidates.find((candidate) => context.translate(candidate) !== candidate);
      if (!key) continue;
      element.innerHTML = context.translate(key);
      written += 1;
      break;
    }
  }
  return written;
}

export abstract class BaseConfigPage implements ConfigPage {
  readonly runtime: ConfigPageRuntime;
  readonly state = new TripleStateStore();
  readonly definition: ConfigPageDefinition;

  protected constructor(runtime: ConfigPageRuntime, definition: ConfigPageDefinition) {
    this.runtime = runtime;
    this.definition = definition;
  }

  get name(): string {
    return this.definition.name;
  }

  get fragmentPath(): string {
    return this.definition.fragmentPath;
  }

  protected get context(): ConfigPageContext {
    return this.runtime.context;
  }

  protected get commands() {
    return this.runtime.commands;
  }

  mount(tab: TabId, containerId = this.definition.containerId(tab)): boolean {
    const container = this.context.document.getElementById(containerId);
    if (!container) return false;
    container.innerHTML = this.context.fragments.load(this.fragmentPath);
    this.namespace(tab, container);
    this.bindActions(tab, container);
    return true;
  }

  /**
   * The shipped fragments already contain the Apply/Cancel buttons; attach them to the same
   * page methods the original delegated handlers call. Dynamic lists inside each page remain the
   * responsibility of that page's state API.
   */
  protected bindActions(tab: TabId, container: Element): void {
    const applySelectors = [
      '#posConfig-apply',
      '#portConfig-apply',
      '#spanConfig-apply',
      '#gnssConfigApply',
      '#radioConfig-apply',
      '.applyButtonAlign',
      '.applyButtonRadio',
      '.applyButtonLogging',
      '#loggingConfig-start',
      '#giii-loggingConfig-start',
      '.general-settings-apply',
      '#hotspot-applyBtn',
      '.ethernet-applyBtn',
      '#languatesettings-apply',
      '#spanInstall-apply',
    ];
    const applied = new Set<Element>();
    for (const selector of applySelectors) {
      for (const button of container.querySelectorAll(selector)) {
        if (applied.has(button)) continue;
        applied.add(button);
        button.addEventListener('click', () => this.apply(tab));
      }
    }
    const cancelSelectors = [
      '#gnssConfigCancel',
      '#spanConfig-cancel',
      '#radioConfig-cancel',
      '#loggingConfig-cancel',
      '#giii-loggingConfig-cancel',
      '.cancelButtonAlign',
      '.cancelButtonReceive',
      '.cancelPortButtonReceive',
      '.general-settings-cancel',
      '.ethernet-cancelBtn',
      '#hotspot-cancelBtn',
      '#spanInstallCancel',
      '#add-logs-cancel',
      '#giii-add-logs-cancel',
    ];
    const cancelled = new Set<Element>();
    for (const selector of cancelSelectors) {
      for (const button of container.querySelectorAll(selector)) {
        if (cancelled.has(button)) continue;
        cancelled.add(button);
        button.addEventListener('click', () => this.confirmDiscard(tab));
      }
    }
  }

  protected confirmDiscard(tab: TabId): void {
    if (!this.isDirty(tab)) {
      this.discard(tab);
      return;
    }
    this.context.createDialog(
      {
        title: this.context.translate('CANCEL'),
        titledataLangAttr: 'data-lang-cancel',
        content: this.context.translate('UNSAVED_POPUP_MSG'),
        buttons: [
          {
            text: this.context.translate('YES'),
            dataLang: 'data-lang-yes',
            callback: () => {
              this.discard(tab);
              this.context.closeDialog(tab);
            },
          },
          {
            text: this.context.translate('NO'),
            dataLang: 'data-lang-no',
            class: 'darkBtn',
            callback: () => this.context.closeDialog(tab),
          },
        ],
      },
      { tab },
    );
  }

  protected namespace(_tab: TabId, _container: Element): void {
    // Most shipped config pages are deliberately not namespaced; the three pages that need the
    // original selective suffixing override this.
  }

  unmount(tab: TabId): void {
    const root = this.context.document.getElementById(tab);
    if (!root) return;
    const container = root.querySelector(`#${this.definition.containerId(tab)}`);
    if (container) container.innerHTML = '';
    this.state.clear(tab);
  }

  updateData(msgId: number, data: Record<string, unknown>): void {
    const tab = String(data.tab ?? '');
    if (!tab) return;
    this.state.updateCurrent(tab, msgId, data);
  }

  dc_updateData(msgId: number, data: Record<string, unknown>): void {
    this.updateData(msgId, data);
  }

  reset(tab: TabId): void {
    this.state.snapshot(tab);
    this.render(tab);
  }

  dh_createDefaultData(tab: TabId): void {
    this.state.snapshot(tab);
  }

  v_loadDefaultData(tab: TabId): void {
    this.render(tab);
  }

  discard(tab: TabId): void {
    this.state.discard(tab);
    this.render(tab);
  }

  commit(tab: TabId): void {
    this.state.commit(tab);
  }

  isDirty(tab: TabId): boolean {
    return this.state.isDirty(tab);
  }

  isDataChanged(tab: TabId): boolean {
    return this.isDirty(tab);
  }

  resetDataObject(tab: TabId): void {
    this.state.clear(tab);
  }

  apply(tab: TabId): CommandResponse | undefined {
    if (!this.isDirty(tab) || !this.validateApply(tab)) return undefined;
    this.commands.setCurrentFeature(this.name);
    this.context.showLoadingScreen(tab, this.loaderDuration(tab), 'APPLYING');
    return this.runApply(tab);
  }

  protected validateApply(_tab: TabId): boolean {
    return true;
  }

  protected loaderDuration(_tab: TabId): number {
    return 6000;
  }

  protected abstract runApply(tab: TabId): CommandResponse | undefined;

  handleCommandResponse(
    response: CommandResponse,
    tab: TabId,
    _msgId?: number,
    _error?: string,
  ): void {
    this.commands.removeFeature(this.name, tab);
    this.context.clock.setTimeout(() => {
      this.context.closeApplyingScreen(tab, response);
      if (response === COMMAND_RESPONSE.OK) this.commit(tab);
      this.render(tab);
    }, this.responseDelay());
  }

  protected responseDelay(): number {
    return 2000;
  }

  processLanguage(tab?: TabId): number {
    if (tab) return applyPageMarkers(this.context, tab);
    return 0;
  }

  defaultData(tab: TabId): Record<string, unknown> {
    return this.state.baseline(tab);
  }

  currentData(tab: TabId): Record<string, unknown> {
    return this.state.current(tab);
  }

  changedData(tab: TabId): Record<string, unknown> {
    return this.state.pending(tab);
  }

  protected abstract render(tab: TabId): void;
}

export abstract class DictionaryConfigPage extends BaseConfigPage {
  readonly dictionaries = new ConfigPageState();
}
