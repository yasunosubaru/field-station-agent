/**
 * `genericView` — the rendering contract between the data pipeline and the DOM.
 *
 * Only the parts the Manage shell needs are implemented here (`updateView`, the RAG helper,
 * the formatters, and the element-id cache). The popup/loader half of `genericView` lives in
 * `manage.ts`, because those need the per-tab containers `containers.ts` builds.
 *
 * Acceptance criteria: R39, R42 of `03_分析/01_Manage主界面与视图层.md §8`, plus the rules of
 * §5.1 (selector composition), §5.3 (RAG classes) and §5.4 (formatting).
 */

import { viewSelector, elementIdFor } from './ids.ts';
import type { TabId, ViewLayer } from './types.ts';

export interface StatusRagState {
  state: 'good' | 'warning' | 'bad' | 'idle' | string;
}

/** `genericView.js:13-18`. */
export const RAG_CLASSES: Record<string, string> = {
  good: 'green-status',
  warning: 'yellow-status',
  bad: 'red-status',
  idle: 'grey-status',
};

/**
 * The 27 locales whose decimal separator is a comma (`genericView.js:1052-1074`).
 * `getCommaLocale` returns the locale itself for these and the default locale otherwise.
 */
export const COMMA_LOCALES = [
  'cs-CZ',
  'da-DK',
  'de-AT',
  'de-CH',
  'de-DE',
  'de-LI',
  'de-LU',
  'el-GR',
  'es-ES',
  'fr-BE',
  'fr-CA',
  'fr-CH',
  'fr-FR',
  'fr-LU',
  'it-CH',
  'it-IT',
  'nl-BE',
  'nl-NL',
  'pl-PL',
  'pt-BR',
  'pt-PT',
  'ru-RU',
  'sk-SK',
  'sv-SE',
  'tr-TR',
  'uk-UA',
  'vi-VN',
];

/** Fields that must never be cached: their elements are replaced wholesale (`genericView.js:84`). */
export const UNCACHED_FIELDS = ['solStatus', 'headingTitle'];

export interface ViewOptions {
  /** The active tab, i.e. `NovatelIdConstants.tabName`. */
  activeTab?: () => TabId;
  /** Default locale used when the tab's locale is not a comma locale. */
  defaultLocale?: string;
  /** Per-tab locale override, mirroring `getCommaLocale(tab)`. */
  localeOf?: (tab: TabId) => string;
  userAgent?: string;
  innerWidth?: number;
  /**
   * `true` (default) reproduces observable 2.11.0 defects. `false` enables the documented
   * corrected behaviour. This replaces the previous always-on fixes.
   */
  mirrorDefects?: boolean;
  /** `$(window).height()` for `popupPositionCalculation`; tests pin it. */
  viewportHeight?: number;
  /** `Common.getKeyByValue(Language[userLanguage], text)`. */
  keyForText?: (text: string) => string | undefined;
  /** `Language[userLanguage][key]`. */
  translate?: (key: string) => string;
}

export interface DialogButton {
  text: string;
  callback?: (event?: unknown) => void;
  class?: string;
  dataLang?: string;
  'data-dismiss'?: string;
}

export interface DialogOptions {
  title?: string;
  content?: string;
  titledataLangAttr?: string;
  closeCallback?: (event?: unknown) => void;
  buttons?: DialogButton[];
}

export interface DialogDisplayOptions {
  tab?: TabId;
  isOverlayPopup?: boolean;
  isPOIPopup?: boolean;
  isErrorPopup?: boolean;
}

export interface PopupPosition {
  viewHeight: number;
  contentHeight: number;
  popupTop: string;
  dialogTop: number;
  overflowY: 'auto' | '';
  maxBodyHeight: number;
  maxDialogHeight: number;
}

interface CachedElement {
  [field: string]: Element | null;
}

/**
 * `genericView` replacement. One instance per application (the original is a module singleton).
 *
 * By default this mirrors the original's observable quirks, including raw `undefined`/`null`
 * DOM coercion and the detached element cache. `mirrorDefects:false` opts into the documented
 * corrected behaviour after explicit call-site review.
 */
export class View implements ViewLayer {
  private readonly doc: Document;
  private readonly options: ViewOptions;
  /** `elementIds[tab + featureName][field]` — the original's cache key (`genericView.js:81`). */
  private readonly elementIds: Record<string, CachedElement> = {};
  private readonly closeConfirm = new Map<TabId, boolean>();
  private readonly dirtyDialogs = new Map<TabId, Set<string>>();

  constructor(doc: Document, options: ViewOptions = {}) {
    this.doc = doc;
    this.options = options;
  }

  private activeTab(): TabId {
    return this.options.activeTab ? this.options.activeTab() : '';
  }

  /** `genericView.js:25-77`. */
  selectorFor(featureName: string, field: string, tab: TabId = this.activeTab()): string {
    const mobile = this.isMobile();
    return viewSelector(featureName, field, tab, { mobile });
  }

  private isMobile(): boolean {
    if (this.options.userAgent !== undefined || this.options.innerWidth !== undefined) {
      const ua = this.options.userAgent ?? '';
      const width = this.options.innerWidth ?? 1024;
      return /iPhone|Android|blackberry|mini|windows\sce/i.test(ua) || width < 768;
    }
    const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
    const width = typeof window === 'undefined' ? 1024 : window.innerWidth;
    return /iPhone|Android|blackberry|mini|windows\sce/i.test(ua) || width < 768;
  }

  /**
   * `updateView(jsonData, fields, featureName)`.
   * Returns the number of fields actually written, which makes the throttle visible to tests.
   */
  updateView(
    jsonData: Record<string, unknown>,
    fields: string,
    featureName: string,
    tabOverride?: TabId,
  ): number {
    let tab = (jsonData.tab as TabId | undefined) ?? tabOverride ?? '';
    // R39: the second gate of §6.4 — a non-active tab is dropped here even if it reached us.
    if (tab !== this.activeTab()) return 0;
    if (tab === 'webui') tab = '';

    const names = fields.split(',');
    let written = 0;
    for (const field of names) {
      if (!Object.prototype.hasOwnProperty.call(jsonData, field)) continue;
      let id = this.selectorFor(featureName, field, tab);

      if (tab === '') {
        // The original deletes the wrong cache key here (`genericView.js:59`); no cache is used
        // for `tab === ''` at all, so the intent is preserved by not caching.
        const isStatusLike = featureName.indexOf('Status') !== -1 || featureName === 'satelliteView';
        if (isStatusLike) {
          id = this.isMobile()
            ? `.for-mobiles #${elementIdFor(featureName, field)}`
            : `.for-desktop #${elementIdFor(featureName, field)}`;
        } else {
          id = `#${elementIdFor(featureName, field)}`;
        }
        if (featureName === 'splashScreen' || featureName === 'statusBar' || featureName === 'gritStatusBar') {
          id = `#${elementIdFor(featureName, field)}`;
        }
        const direct = this.doc.querySelector(id);
        if (direct) {
          direct.textContent = this.toText(jsonData[field]);
          written += 1;
        }
        continue;
      }

      const element = this.resolve(tab, featureName, field, id);
      if (element) {
        element.textContent = this.toText(jsonData[field]);
        written += 1;
      }
    }
    return written;
  }

  /** `elementIds` lookup with the original's "query when absent or null" rule (§5.2). */
  private resolve(tab: TabId, featureName: string, field: string, selector: string): Element | null {
    // `solStatus` / `headingTitle` point at elements that get replaced wholesale: never cache them.
    if (UNCACHED_FIELDS.includes(field)) return this.doc.querySelector(selector);

    const key = tab + featureName;
    let bucket = this.elementIds[key];
    if (!bucket) {
      bucket = {};
      this.elementIds[key] = bucket;
    }
    const cached = bucket[field];
    if (cached) {
      if (this.options.mirrorDefects !== false) return cached;
      if (cached.isConnected !== false) return cached;
    }
    const found = this.doc.querySelector(selector);
    bucket[field] = found;
    return found;
  }

  private toText(value: unknown): string {
    if (this.options.mirrorDefects !== false) return String(value);
    if (value === undefined || value === null) return '';
    return String(value);
  }

  /** §5.3 — RAG state to status class. */
  ragClass(state: string): string {
    return RAG_CLASSES[state] ?? '';
  }

  /** `genericView.js:188-192`: hide every traffic light of the tile, then show the matching one. */
  updateStatusIndicatorClrAndText(parent: string, state: string, tab: TabId): void {
    const scope = `#${tab} .${parent}.statustiles-traffic span`;
    for (const node of this.doc.querySelectorAll(scope)) this.setVisible(node, false);
    const clr = this.ragClass(state);
    if (!clr) return;
    for (const node of this.doc.querySelectorAll(`${scope}.${clr}`)) this.setVisible(node, true);
  }

  private setVisible(element: Element, visible: boolean): void {
    const style = (element as { style?: { display: string } }).style;
    if (style) style.display = visible ? 'block' : 'none';
    else if (visible) (element as Element).removeAttribute('hidden');
    else (element as Element).setAttribute('hidden', '');
  }

  /** `formatToSystemLocale` — `useGrouping:false`, fraction digits pinned (§5.4). */
  formatToSystemLocale(value: unknown, fractionDigits: number, tab?: TabId): string {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return String(value ?? '');
    const locale = this.getCommaLocale(tab);
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
      useGrouping: false,
    }).format(numeric);
  }

  getCommaLocale(tab?: TabId): string {
    const locale = this.options.localeOf
      ? this.options.localeOf(tab ?? this.activeTab())
      : this.localeOfSystem();
    const normalised = locale.replace('_', '-');
    const hit = COMMA_LOCALES.find((entry) => entry.toLowerCase() === normalised.toLowerCase());
    return hit ?? (this.options.defaultLocale ?? locale);
  }

  private localeOfSystem(): string {
    if (this.options.defaultLocale) return this.options.defaultLocale;
    if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
    return 'en-US';
  }

  /** `satelliteView.js:39`: `vdop = sqrt(pdop² − hdop²)`, with 9999 passing through. */
  verticalDop(pdop: number, hdop: number): number {
    if (pdop === 9999 && hdop === 9999) return 9999;
    if (!Number.isFinite(pdop) || !Number.isFinite(hdop)) return 9999;
    const value = Math.sqrt(pdop * pdop - hdop * hdop);
    return Number.isFinite(value) ? value : 9999;
  }

  /** `genericView.js:779-787`: drop every cache bucket whose key starts with the tab. */
  deleteElementIds(tab: TabId): void {
    for (const key of Object.keys(this.elementIds)) {
      if (key.startsWith(tab)) delete this.elementIds[key];
    }
  }

  resetDataObject(tab: TabId): void {
    this.deleteElementIds(tab);
  }

  /** Exposed for tests and for `manage.ts`'s teardown. */
  cacheKeys(): string[] {
    return Object.keys(this.elementIds);
  }

  /**
   * R36 — default mode reproduces the original live-attribute skip. Explicit corrected mode
   * collects the names first and removes every marker.
   */
  removeDataLangAttr(element: Element | null): void {
    if (!element) return;
    if (this.options.mirrorDefects !== false) {
      // `$.each` walks the live NamedNodeMap while removeAttr shrinks it.
      let index = 0;
      while (index < element.getAttributeNames().length) {
        const names = element.getAttributeNames();
        const name = names[index];
        if (name === 'data-lang' || name.startsWith('data-lang-')) element.removeAttribute(name);
        index += 1;
      }
      return;
    }
    const names = element
      .getAttributeNames()
      .filter((name) => name === 'data-lang' || name.startsWith('data-lang-'));
    for (const name of names) element.removeAttribute(name);
  }

  /** `addDataLangAttr`: the source only adds the new marker; it never removes old ones. */
  addDataLangAttr(element: Element | null, attributeName: string): void {
    if (!element) return;
    if (this.options.mirrorDefects === false) this.removeDataLangAttr(element);
    element.setAttribute(attributeName, '');
  }

  /**
   * `genericView.createDialog` (`genericView.js:204-350`).
   *
   * In default mirror mode an unresolved button text reaches `dataLang.toLowerCase()` and throws
   * exactly like 2.11.0. `mirrorDefects:false` skips that broken marker and leaves the button usable.
   */
  createDialog(options: DialogOptions = {}, display: DialogDisplayOptions = {}): void {
    const opts: Required<Pick<DialogOptions, 'title' | 'content'>> & DialogOptions = {
      title: 'Placeholder Title',
      content: 'Placeholder Content',
      ...options,
    };
    const tab = display.tab ?? '';
    const prefix = tab ? `#${tab} ` : '';
    if (tab) this.doc.getElementById(tab)?.classList.add('popup-open');

    const overlay = display.isOverlayPopup === true;
    const poi = display.isPOIPopup === true;
    const popupId = poi ? 'POIpopupModal' : overlay ? 'overlayPopupModal' : 'popupModal';
    const dialog =
      this.doc.querySelector(`${prefix}#${popupId}`) ??
      (tab ? null : this.doc.querySelector(`#notab-popup #${popupId}`));
    if (!dialog) return;

    const modalDialog = dialog.querySelector('.modal-dialog');
    if (modalDialog) modalDialog.className = 'modal-dialog';
    const title = dialog.querySelector('.modal-header .modal-title');
    if (title) {
      title.innerHTML = opts.title;
      this.removeDataLangAttr(title);
      if (opts.titledataLangAttr) title.setAttribute(opts.titledataLangAttr, '');
      const titleKey = this.options.keyForText?.(opts.title);
      if (titleKey) title.setAttribute(`data-lang-${titleKey.toLowerCase()}`, '');
    }

    const close = dialog.querySelector('.modal-header .close-btn');
    if (close) {
      close.addEventListener('click', (event) => {
        opts.closeCallback?.(event);
        this.closeDialog(tab, event);
      });
    }

    const bodyParagraph = dialog.querySelector('.modal-body p');
    if (bodyParagraph) {
      bodyParagraph.innerHTML = opts.content;
      const contentMarkers: Record<string, string> = {
        UNSAVED_POPUP_MSG: 'data-lang-unsaved-popup',
        RECORDINGLEAVECONFIRMATIONMESSAGE: 'data-lang-terminal-recording-msg',
        RECEIVERRESTART_1: 'data-lang-receiverrestart_1',
        AUTHCODEAPPLYMESSAGE: 'data-lang-authcodeapplymessage',
        FRESETMESSAGE: 'data-lang-fresetmessage',
        STARTLOGGINGMESSAGE: 'data-lang-start-logging',
        FILE_LOGGING_CLOSE_WARNING: 'data-lang-file-logging-close',
        LOGGINGINPROGRESS: 'data-lang-logging-inprogress',
        GRITLOGGINGINPROGRESS: 'data-lang-grit-logging-inprogress',
        NASLOGGINGINPROGRESS: 'data-lang-nas-logging-inprogress',
        DELETELOGCONFMSG: 'data-lang-deleteconmsg',
        FTPCONNECTIONFAILMSG: 'data-lang-ftpconnectionfailmsg',
        LOGFILESCLOSEWINDOWMSG: 'data-lang-logfilesclosewindowmsg',
        COPYPROGRESSMSG: 'data-lang-copyprogressmsg',
        MODEL_INVALID_FOR_THIS_RECEIVER: 'data-lang-model-invalid',
        INVALID_AUTHORIZATION_CODE: 'data-lang-auth-invalid',
      };
      for (const [key, attribute] of Object.entries(contentMarkers)) {
        const expected = String(this.translate(key)).replace('%1', '<br> <br>');
        if (opts.content === expected) bodyParagraph.setAttribute(attribute, '');
        else bodyParagraph.removeAttribute(attribute);
      }
    }

    const footer = dialog.querySelector('.modal-footer');
    if (footer) {
      footer.innerHTML = '';
      const buttons = opts.buttons ?? [];
      for (const value of buttons) {
        const template = dialog.querySelector(overlay ? '#overlay-btn-template > *' : '#btn-template > *');
        const button = template ? template.cloneNode(true) as Element : this.doc.createElement('button');
        button.innerHTML = value.text;
        button.classList.add(...(value.class ?? 'btn-default').split(/\s+/).filter(Boolean));
        if (value['data-dismiss'] !== undefined) button.setAttribute('data-dismiss', value['data-dismiss']);
        if (value.dataLang) button.setAttribute(value.dataLang, '');
        else {
          const dataLang = this.options.keyForText?.(value.text);
          if (dataLang === undefined && this.options.mirrorDefects !== false) {
            // Deliberate 2.11.0 defect: `dataLang.toLowerCase()` on undefined.
            throw new TypeError("Cannot read properties of undefined (reading 'toLowerCase')");
          }
          if (dataLang !== undefined) button.setAttribute(`data-lang-${dataLang.toLowerCase()}`, '');
        }
        button.addEventListener('click', (event) => {
          if (
            value['data-dismiss'] === undefined ||
            (tab.includes('grit') && value['data-dismiss'] !== 'none')
          ) {
            button.setAttribute('data-dismiss', 'modal');
          }
          value.callback?.(event);
        });
        footer.appendChild(button);
      }
      const styled = footer as Element & { style?: CSSStyleDeclaration };
      if (styled.style) styled.style.borderTop = buttons.length ? '1px solid #b9b9b9' : '0px solid #b9b9b9';
    }

    const modal = dialog as Element & { style?: CSSStyleDeclaration };
    if (modal.style) {
      modal.style.display = 'block';
      modal.style.opacity = '1';
    }
    dialog.classList.add('in', 'show');
    dialog.addEventListener('hide.bs.modal', (event) => {
      if (this.requestHideDialog(tab, event)) return;
      if (modal.style) modal.style.display = 'none';
    });
    this.popupPositionCalculation(tab, overlay, poi);
    this.closeConfirm.set(tab, false);
  }

  /** `popupPositionCalculation` (`genericView.js:372-426`). */
  popupPositionCalculation(
    tab: TabId,
    isOverlayPopup = false,
    isPOIPopup = false,
    overrideViewportHeight?: number,
  ): PopupPosition {
    const windowHeight = overrideViewportHeight ?? this.options.viewportHeight ?? 900;
    const viewHeight = windowHeight - 190;
    const prefix = tab ? `#${tab} ` : '';
    const popupId = isPOIPopup ? 'POIpopupModal' : isOverlayPopup ? 'overlayPopupModal' : 'popupModal';
    const dialog = this.doc.querySelector(`${prefix}#${popupId}`);
    const content = dialog?.querySelector('.modal-content') as
      | (Element & { style?: CSSStyleDeclaration; getBoundingClientRect?: () => DOMRect })
      | null;
    const body = dialog?.querySelector('.modal-body') as
      | (Element & { style?: CSSStyleDeclaration })
      | null;
    const styledDialog = dialog?.querySelector('.modal-dialog') as
      | (Element & { style?: CSSStyleDeclaration })
      | null;
    const measured = content?.getBoundingClientRect?.().height ?? 0;
    let dialogHeight = measured;
    if (dialogHeight > 0.8 * viewHeight) dialogHeight = 0.8 * viewHeight;
    const overflowY = measured > 0.8 * viewHeight ? 'auto' : '';
    if (body?.style) {
      body.style.overflowY = overflowY;
      body.style.overflow = overflowY ? body.style.overflow || '' : '';
      body.style.maxHeight = `${dialogHeight}px`;
    }
    let dialogTop = (viewHeight - measured) / 2;
    if (isOverlayPopup) dialogTop = (viewHeight - measured) / 4;
    if (this.activeTab() === 'tabs-1') dialogTop -= 70;
    let popupTop = dialogTop + 100;
    dialogTop = dialogTop > 0 ? dialogTop - 35 : 0;
    popupTop = popupTop < 70 ? 70 : popupTop > 120 ? 120 : popupTop;
    if (dialog?.style) dialog.style.top = tab ? `${popupTop}px` : '';
    if (styledDialog?.style) {
      styledDialog.style.top = `${dialogTop}px`;
      styledDialog.style.maxHeight = `${0.8 * viewHeight}px`;
      styledDialog.classList.toggle('lghn-modal-dialog', false);
    }
    return {
      viewHeight,
      contentHeight: measured,
      popupTop: tab ? `${popupTop}px` : '',
      dialogTop,
      overflowY,
      maxBodyHeight: dialogHeight,
      maxDialogHeight: 0.8 * viewHeight,
    };
  }

  setDialogDirty(tab: TabId, dialogClass: string, dirty: boolean): void {
    const set = this.dirtyDialogs.get(tab) ?? new Set<string>();
    if (dirty) set.add(dialogClass);
    else set.delete(dialogClass);
    this.dirtyDialogs.set(tab, set);
  }

  setCloseConfirm(tab: TabId, value: boolean): void {
    this.closeConfirm.set(tab, value);
  }

  getCloseConfirm(tab: TabId): boolean {
    return this.closeConfirm.get(tab) === true;
  }

  /**
   * Bootstrap's `hide.bs.modal`. Unsaved edit dialogs veto the close in 2.11.0.
   * Returns true when the event was prevented.
   */
  requestHideDialog(tab: TabId, event?: { preventDefault(): void; stopPropagation?(): void }): boolean {
    const dialog = this.doc.querySelector(`#${tab} #popupModal .modal-dialog`);
    const classes = this.dirtyDialogs.get(tab) ?? new Set<string>();
    const unsaved =
      (dialog?.classList.contains('edit-com-config') && classes.has('edit-com-config')) ||
      (dialog?.classList.contains('edit-port-msg') && classes.has('edit-port-msg')) ||
      (dialog?.classList.contains('edit-icom-config') && classes.has('edit-icom-config')) ||
      (dialog?.classList.contains('edit-ncom-config') && classes.has('edit-ncom-config'));
    if (unsaved && !this.getCloseConfirm(tab)) {
      event?.preventDefault();
      event?.stopPropagation?.();
      return true;
    }
    return false;
  }

  closeDialog(tab: TabId, event?: { preventDefault(): void; stopPropagation?(): void }): boolean {
    if (this.requestHideDialog(tab, event)) return false;
    const modal = this.doc.querySelector(`#${tab} #popupModal`) as
      | (Element & { style?: CSSStyleDeclaration })
      | null;
    if (!modal) return true;
    modal.classList.remove('in', 'show');
    if (modal.style) modal.style.display = 'none';
    const footer = modal.querySelector('.modal-footer');
    if (footer) footer.innerHTML = '';
    this.doc.getElementById(tab)?.classList.remove('popup-open');
    return true;
  }

  private translate(key: string): string {
    return this.options.translate?.(key) ?? key;
  }
}

export function createView(doc: Document, options: ViewOptions = {}): View {
  return new View(doc, options);
}
