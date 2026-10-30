/**
 * The language layer.
 *
 * Two things are modelled here, and they are separate on purpose:
 *  1. the dictionary (`jsIn.addDict` + `__()`), i.e. *what a key resolves to*;
 *  2. the `processLanguage()` fan-out, i.e. *which components rewrite the DOM*.
 *
 * Acceptance criteria: R31–R38 of `03_分析/01_Manage主界面与视图层.md §8`, plus §6.3 for the flow.
 *
 * Documented deviations from the original:
 *  - `addDict` only ever *adds*, so a key missing from the newly selected language keeps the value
 *    from the previously selected one instead of falling back to English. `loadDictionary` keeps
 *    that behaviour by default (it is observable) and `clearDictionary()` is the fix; the
 *    application calls it, tests assert both modes.
 *  - `applyMarkers()` is best-effort: the original hard-codes every `data-lang-x` ↔ key pair at the
 *    call site, so the attribute name alone cannot be turned into a key reliably (doc §9.4).
 */

import type { LanguageLayer, TabId, FeatureFlags } from './types.ts';
import { DEFAULT_FEATURES } from './types.ts';
import dictEn from './language/dict-en.ts';
import dictCn from './language/dict-cn.ts';

/**
 * The two languages this reimplementation ships (`zh` + `en`). The dictionaries are generated from
 * the shipped `view/languageSupport/{en,cn}.js` by `tools/gen_language_dicts.js` — 1679 / 1636 keys.
 */
export const BUILTIN_DICTIONARIES: Record<string, Record<string, string>> = { en: dictEn, cn: dictCn };

/**
 * `zh-CN` / `zh-Hans` / `Chinese` → `cn`. The shipped matcher compares `languageId.split('-')[0]`
 * (`"zh"`) against `languageName.toLowerCase()` (`"chinese"`), so it silently fell back to English
 * and the Chinese files were unreachable from the UI (`D7` in `00A §8`). This map is the fix; pass
 * `languageAliases: false` to restore the shipped behaviour.
 */
export const BUILTIN_ALIASES: Record<string, string> = {
  cn: 'cn',
  zh: 'cn',
  'zh-cn': 'cn',
  'zh-hans': 'cn',
  'zh-hant': 'cn',
  chinese: 'cn',
  en: 'en',
  english: 'en',
};

/** R34 — the 20 `processLanguage` calls of `statusComponentsProcessLanguage` (`jarvisInterface.js:1375-1410`). */
export const STATUS_LANGUAGE_COMPONENTS: readonly string[] = [
  'statusBar',
  'positionStatus',
  'portStatus',
  'satelliteView',
  'deviceInfo',
  'interferenceStatus',
  'logStatus',
  'radioStatus',
  'events',
  'menuBar',
  'pppCorrections',
  'loadConfiguration',
  'saveConfiguration',
  'deviceDetails',
  'deviceExport',
  'satelliteTracking',
  'alignStatus',
  'spanStatus',
  'agcStatus',
  'generalSettings',
];

/** R34 — the GIII-only additions of the same function. */
export const STATUS_LANGUAGE_COMPONENTS_GIII: readonly string[] = [
  'giiiSatelliteTracking',
  'giiiTerminalConsole',
  'giiiDeviceDetails',
  'giiiLogStatus',
];

/** R34 — the 9 `configComponentsProcessLanguage` modules. */
export const CONFIG_LANGUAGE_COMPONENTS: readonly string[] = [
  'positionConfig',
  'positioningConfig',
  'portConfig',
  'loggingConfig',
  'radioConfig',
  'alignConfig',
  'spanConfig',
  'gnssConfig',
  'interferenceToolKit',
];

/** R34 — conditional config additions. */
export const CONFIG_LANGUAGE_COMPONENTS_LONGHORN: readonly string[] = [
  'lghnPositionConfig',
  'longhornStatusUI',
  'lghn_deviceUpdate',
];
export const CONFIG_LANGUAGE_COMPONENTS_GIII: readonly string[] = ['giiiLoggingConfig'];
export const CONFIG_LANGUAGE_COMPONENTS_MARINEPAK: readonly string[] = ['spoofingConfiguration'];

export interface LanguageEntry {
  /** `en`, `cn`, `de`, … — the key of `languageSettings.json`. */
  id: string;
  /** `English`, `Chinese`, … — matched against `languageId.split('-')[0]`. */
  languageName: string;
  filePath: string;
}

export interface LanguageLayerOptions {
  /** `featuresList` subset for the conditional branches of R34. */
  features?: (tab?: TabId) => FeatureFlags;
  /** `NovatelIdConstants.gritSupported && currentActiveApp == 'GRIT'`. */
  gritActive?: () => boolean;
  /** Seed the built-in English dictionary at construction (default true). */
  builtin?: boolean;
  /** `zh-CN` → `cn` (default true; `false` restores the shipped R33 behaviour). */
  languageAliases?: boolean;
  /** Clear the dictionary before loading the next language (default true). */
  replaceDictionary?: boolean;
}

export class Language implements LanguageLayer {
  private dictionary: Record<string, string> = {};
  private languages = new Map<string, LanguageEntry>();
  private readonly components: Array<{ name: string; fn: (tab?: TabId) => void }> = [];
  private readonly options: LanguageLayerOptions;
  private languageId = 'en';
  private lastResolved = 'en';

  constructor(options: LanguageLayerOptions = {}) {
    this.options = options;
    if (options.builtin !== false) this.dictionary = { ...dictEn };
  }

  /* ------------------------------------------------------------ dictionary */

  /** `__()`. Key → value, falling back to the key itself (doc §9.1 of the i18n subsystem). */
  translate(key: string): string {
    const value = this.dictionary[key];
    return value === undefined ? key : value;
  }

  /**
   * `Common.getKeyByValue(Language[current], text)` from `genericView.createDialog`.
   * The first matching key in dictionary insertion order is what jQuery-era code observed.
   */
  keyForText(text: string): string | undefined {
    for (const [key, value] of Object.entries(this.dictionary)) {
      if (value === text) return key;
    }
    return undefined;
  }

  /**
   * `jsIn.addDict(Language.XX)`: **accumulate**, never clear. Reproduced because the resulting
   * "stale key from the previous language" behaviour is observable in the product.
   */
  loadDictionary(dict: Record<string, string>, name?: string): void {
    this.dictionary = { ...this.dictionary, ...dict };
    if (name) this.languageId = name;
  }

  /** The fix for the accumulation: what the application calls before loading a new language. */
  clearDictionary(): void {
    this.dictionary = {};
  }

  dictionarySize(): number {
    return Object.keys(this.dictionary).length;
  }

  currentLanguage(): string {
    return this.languageId;
  }

  /* -------------------------------------------------------------- languages */

  registerLanguage(entry: LanguageEntry): void {
    this.languages.set(entry.id, entry);
  }

  /** Parses `view/languageSupport/languageSettings.json`. */
  loadLanguageSettings(json: Record<string, { languageName: string; filePath: string }>): void {
    for (const [id, entry] of Object.entries(json)) {
      this.registerLanguage({ id, languageName: entry.languageName, filePath: entry.filePath });
    }
  }

  listLanguages(): LanguageEntry[] {
    return [...this.languages.values()];
  }

  /**
   * R33 — `applyLanguageChanges` matches `languageId.split('-')[0]` against
   * `languageName.toLowerCase()` and silently falls back to `en` when nothing matches
   * (so `zh-CN` resolves to `en`, because `Chinese` is registered as `cn`).
   */
  resolveLanguageId(languageId: string): string {
    const raw = String(languageId ?? '').trim().toLowerCase();
    const wanted = raw.split('-')[0];
    // Fix for D7: the shipped matcher cannot reach `cn` from `zh-CN`. Disable with `languageAliases:false`.
    if (this.options.languageAliases !== false) {
      const alias = BUILTIN_ALIASES[raw] ?? BUILTIN_ALIASES[raw.split('-').slice(0, 2).join('-')] ?? BUILTIN_ALIASES[wanted];
      if (alias) {
        this.lastResolved = alias;
        return alias;
      }
    }
    let key = 'en';
    for (const [id, entry] of this.languages) {
      if (entry.languageName.toLowerCase() === wanted) key = id;
    }
    this.lastResolved = key;
    return key;
  }

  resolvedFilePath(languageId: string): string | undefined {
    const id = this.resolveLanguageId(languageId);
    return this.languages.get(id)?.filePath;
  }

  /* ------------------------------------------------------------ components */

  register(component: string, fn: (tab?: TabId) => void): void {
    this.components.push({ name: component, fn });
  }

  registeredComponents(): string[] {
    return this.components.map((entry) => entry.name);
  }

  /** Runs every registered `processLanguage` in registration order; returns who ran. */
  processLanguage(tab?: TabId): string[] {
    const ran: string[] = [];
    for (const entry of this.components) {
      entry.fn(tab);
      ran.push(entry.name);
    }
    return ran;
  }

  /**
   * R34 — the status fan-out with its conditionals, in the exact order of the original
   * (`jarvisInterface.js:1380-1408`). `grit` prepends the GRIT component; `GIII` substitutes
   * `satelliteTracking` with three components and appends `giiiLogStatus`.
   */
  registerStatusFanOut(
    resolve: (name: string) => (tab?: TabId) => void,
    tab?: TabId,
  ): string[] {
    const features = this.featuresOf(tab);
    const order: string[] = [];
    const push = (name: string) => {
      this.register(name, resolve(name));
      order.push(name);
    };

    if (this.options.gritActive?.()) push('gritJarvisInterface');

    for (const name of STATUS_LANGUAGE_COMPONENTS) {
      if (name === 'satelliteTracking') {
        if (features.isGIII) {
          push('giiiSatelliteTracking');
          push('giiiTerminalConsole');
          push('giiiDeviceDetails');
        } else {
          push('satelliteTracking');
        }
        continue;
      }
      push(name);
    }
    if (features.isGIII) push('giiiLogStatus');
    return order;
  }

  /** R34 — the config fan-out with its conditionals. */
  registerConfigFanOut(resolve: (name: string) => (tab?: TabId) => void, tab?: TabId): string[] {
    const features = this.featuresOf(tab);
    const order: string[] = [];
    const push = (name: string) => {
      this.register(name, resolve(name));
      order.push(name);
    };
    for (const name of CONFIG_LANGUAGE_COMPONENTS) {
      if (name === 'loggingConfig' && features.isGIII) continue;
      push(name);
    }
    if (features.isLongHorn) for (const name of CONFIG_LANGUAGE_COMPONENTS_LONGHORN) push(name);
    if (features.isGIII) for (const name of CONFIG_LANGUAGE_COMPONENTS_GIII) push(name);
    if (features.isMarinePak) for (const name of CONFIG_LANGUAGE_COMPONENTS_MARINEPAK) push(name);
    return order;
  }

  private featuresOf(tab?: TabId): FeatureFlags {
    return this.options.features ? this.options.features(tab) : DEFAULT_FEATURES;
  }

  /* -------------------------------------------------------------- markers */

  /** Every `data-lang*` attribute name currently in the document (doc §9.4's ledger). */
  markers(root?: Element | Document): string[] {
    const scope: Element | Document = root ?? (typeof document === 'undefined' ? ({} as Document) : document);
    const query = (scope as Document).querySelectorAll;
    if (typeof query !== 'function') return [];
    const names = new Set<string>();
    for (const element of Array.from(query.call(scope, '*'))) {
      for (const name of element.getAttributeNames()) {
        if (name === 'data-lang' || name.startsWith('data-lang-')) names.add(name);
      }
    }
    return [...names].sort();
  }

  /**
   * Best-effort marker application: for `data-lang-connection-lost-content` it tries
   * `CONNECTION-LOST-CONTENT`, `CONNECTION_LOST_CONTENT` and writes only if the dictionary has one.
   * Text is never replaced with the key, so an unknown marker stays exactly as the shipped markup.
   */
  applyMarkers(root?: Element | Document): number {
    const scope: Element | Document = root ?? (typeof document === 'undefined' ? ({} as Document) : document);
    const query = (scope as Document).querySelectorAll;
    if (typeof query !== 'function') return 0;
    let written = 0;
    for (const element of Array.from(query.call(scope, '*'))) {
      for (const name of element.getAttributeNames()) {
        if (name !== 'data-lang' && !name.startsWith('data-lang-')) continue;
        const suffix = name === 'data-lang' ? '' : name.slice('data-lang-'.length);
        if (!suffix) continue;
        const candidates = [suffix.toUpperCase(), suffix.toUpperCase().replace(/-/g, '_')];
        const key = candidates.find((candidate) => this.dictionary[candidate] !== undefined);
        if (!key) continue;
        // `processLanguage()` functions use jQuery `.html()`, so shipped translations containing
        // `<br>` must not be flattened to text.
        element.innerHTML = this.translate(key);
        written += 1;
        break;
      }
    }
    return written;
  }

  /**
   * R32 — `applyUserLanguagePreference(languageId, tab)`: the second argument is ignored by the
   * original and is ignored here too, but unlike the original this also runs the fan-out so the
   * call is not a no-op.
   */
  applyUserLanguagePreference(languageId: string, _tab?: TabId): string[] {
    const id = this.resolveLanguageId(languageId);
    this.languageId = id;
    // The shipped `addDict` accumulates, so switching en→cn→en leaves Chinese in place for keys the
    // dictionary lacks. Clearing first is the documented fix (D7); `replaceDictionary:false` mirrors.
    if (this.options.replaceDictionary !== false) this.clearDictionary();
    const builtin = BUILTIN_DICTIONARIES[id];
    if (builtin) this.loadDictionary(builtin, id);
    return this.processLanguage(_tab);
  }
}

export function createLanguage(options: LanguageLayerOptions = {}): Language {
  return new Language(options);
}
