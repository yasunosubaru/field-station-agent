import type { TabId } from '../types.ts';
import type { CommandResponse, ConfigPage, ConfigPageRuntime } from './types.ts';
import { BaseConfigPage, activeText, scopedQuery, setActive } from './base.ts';

/** `generalSettings.js`: local userStore only, no receiver command. */
export class GeneralSettingsPage extends BaseConfigPage {
  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'generalSettings',
      fragmentPath: './../generalSettings/generalSettings.html',
      containerId: (tab) => `generalSettings-layout_${tab}`,
    });
  }

  protected render(tab: TabId): void {
    const unit =
      this.context.localSettings?.heightUnit?.(tab) ??
      (this.context.features(tab).isMarinePak ? 'Ellipsoidal' : 'MSL');
    setActive(this.context, tab, '#general-settings', unit);
  }

  setHeightUnit(tab: TabId, unit: 'Ellipsoidal' | 'MSL'): void {
    this.state.setPending(tab, 'settings', 'heightUnits', unit);
  }

  /**
   * The height-unit list is the page's only control (`generalSettings.js` toggles the `active`
   * class when one is clicked). Bound here so a click in the drawer records the pending unit; the
   * Apply button is what writes it to the user store.
   */
  protected override bindActions(tab: TabId, container: Element): void {
    super.bindActions(tab, container);
    for (const item of container.querySelectorAll('.height-selection-list li')) {
      item.addEventListener('click', () => {
        const unit = item.id === 'Ellipsoidal' ? 'Ellipsoidal' : 'MSL';
        this.setHeightUnit(tab, unit);
        for (const other of container.querySelectorAll('.height-selection-list li')) {
          other.classList.toggle('active', other === item);
        }
      });
    }
  }

  setUserStoreData(tab: TabId): void {
    const unit =
      this.context.localSettings?.heightUnit?.(tab) ??
      (this.context.features(tab).isMarinePak ? 'Ellipsoidal' : 'MSL');
    this.state.updateCurrent(tab, 'settings', { heightUnits: unit });
  }

  protected runApply(tab: TabId) {
    const changed = this.state.pending(tab) as Record<string, Record<string, unknown>>;
    const unit = changed.settings?.heightUnits;
    if (unit === 'Ellipsoidal' || unit === 'MSL') {
      this.context.localSettings?.setHeightUnit?.(tab, unit);
      this.state.updateCurrent(tab, 'settings', { heightUnits: unit });
    }
    this.commit(tab);
    this.context.showLoadingScreen(tab, 3000, 'APPLYING');
    this.context.clock.setTimeout(() => this.context.closeApplyingScreen(tab, 1), 0);
    return undefined;
  }

  resetGeneralSettingsUI(tab: TabId): void {
    this.setUserStoreData(tab);
    this.reset(tab);
  }
}

/** `languageSettings.js`: only `userStore.language` and the language fan-out. */
export class LanguageSettingsPage extends BaseConfigPage {
  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'languageSettings',
      fragmentPath: './../languageSettings/languageSettings.html',
      containerId: (tab) => `languageSettings-layout_${tab}`,
    });
  }

  protected render(tab: TabId): void {
    const language = this.context.store.json.language;
    if (language) setActive(this.context, tab, '.languagesettings-component .list-inline', language);
  }

  override updateData(_msgId: number, _data: Record<string, unknown>): void {
    // `languageSettings.js:1-4`: intentionally empty.
  }

  selectLanguage(tab: TabId, languageId: string): void {
    this.state.setPending(tab, 'language', 'language', languageId);
  }

  protected runApply(tab: TabId) {
    const changed = this.state.pending(tab) as Record<string, Record<string, unknown>>;
    const language = String(
      changed.language?.language ??
        activeText(this.context, tab, '.languagesettings-component .list-inline li.active'),
    );
    if (language) {
      this.context.store.set(['language'], language);
      this.context.store.save();
      this.context.localSettings?.applyLanguage?.(language);
    }
    this.state.updateCurrent(tab, 'language', { language });
    this.commit(tab);
    return undefined;
  }
}

/** `spanInstallation.js:331-357`: local userStore only. */
export class SpanInstallationPage extends BaseConfigPage {
  constructor(runtime: ConfigPageRuntime) {
    super(runtime, {
      name: 'spanInstallation',
      fragmentPath: './../spanInstallation/spanInstallation.html',
      containerId: (tab) => `spanInstallation-component-${tab}`,
    });
  }

  protected render(tab: TabId): void {
    const device = this.context.deviceTileId(tab);
    const value = this.context.store.getData<Record<string, unknown>>(['app', 'spanInstallation', device]);
    if (value) this.state.mergeCurrent(tab, 'installation', value);
  }

  getSelectedVehicle(tab: TabId): string {
    const device = this.context.deviceTileId(tab);
    const value = this.context.store.getData<Record<string, unknown>>([
      'app',
      'spanInstallation',
      device,
    ]);
    const vehicle = String(value?.type ?? '');
    if (this.context.features(tab).isMarinePak) {
      return vehicle === '' || !['default', 'smallvessel', 'largevessel'].includes(vehicle)
        ? 'largevessel'
        : vehicle;
    }
    return vehicle === '' ? 'car' : vehicle;
  }

  getInstallationDetails(tab: TabId): Record<string, unknown> {
    const device = this.context.deviceTileId(tab);
    return {
      type: this.getSelectedVehicle(tab),
      ...(this.context.store.getData<Record<string, unknown>>([
        'app',
        'spanInstallation',
        device,
      ]) ?? {}),
    };
  }

  setInstallation(tab: TabId, key: string, value: unknown): boolean {
    const numeric = Number(value);
    if (
      key !== 'type' &&
      (!Number.isFinite(numeric) ||
        numeric < 0 ||
        numeric > 999.99 ||
        Math.abs(numeric * 1000 - Math.round(numeric * 1000)) > 1e-9)
    ) {
      return false;
    }
    this.state.setPending(tab, 'installation', key, value);
    return true;
  }

  protected runApply(tab: TabId) {
    const value = this.state.pending(tab).installation as Record<string, unknown> | undefined;
    if (value) {
      const device = this.context.deviceTileId(tab);
      const saved =
        this.context.store.getData<Record<string, unknown>>(['app', 'spanInstallation', device]) ?? {};
      this.context.store.set(['app', 'spanInstallation', device], { ...saved, ...value });
      this.context.store.save();
      this.state.updateCurrent(tab, 'installation', { ...saved, ...value });
    }
    this.commit(tab);
    this.context.showLoadingScreen(tab, 3000, 'APPLYING');
    this.context.clock.setTimeout(() => this.context.closeApplyingScreen(tab, 1), 0);
    return undefined;
  }

  resetSpanInstallationUI(tab: TabId): void {
    this.reset(tab);
  }
}

export class DisplaysSettingsPage implements ConfigPage {
  readonly name = 'displaysSettings';
  readonly fragmentPath = './../spanInstallation/spanInstallation.html';
  readonly spanInstallation: SpanInstallationPage;
  constructor(spanInstallation: SpanInstallationPage) {
    this.spanInstallation = spanInstallation;
  }
  resetdisplaySettingsUI(tab: TabId): void {
    this.spanInstallation.resetSpanInstallationUI(tab);
  }
  mount(tab: TabId, containerId?: string): boolean {
    return this.spanInstallation.mount(tab, containerId);
  }
  unmount(tab: TabId): void {
    this.spanInstallation.unmount(tab);
  }
  updateData(msgId: number, data: Record<string, unknown>): void {
    this.spanInstallation.updateData(msgId, data);
  }
  reset(tab: TabId): void {
    this.spanInstallation.reset(tab);
  }
  discard(tab: TabId): void {
    this.spanInstallation.discard(tab);
  }
  isDataChanged(tab: TabId): boolean {
    return this.spanInstallation.isDirty(tab);
  }
  isDirty(tab: TabId): boolean {
    return this.spanInstallation.isDirty(tab);
  }
  apply(tab: TabId): CommandResponse | undefined {
    return this.spanInstallation.apply(tab);
  }
  handleCommandResponse(
    response: CommandResponse,
    tab: TabId,
    msgId?: number,
    error?: string,
  ): void {
    this.spanInstallation.handleCommandResponse(response, tab, msgId, error);
  }
  processLanguage(tab?: TabId): number {
    return this.spanInstallation.processLanguage(tab);
  }
  defaultData(tab: TabId): Record<string, unknown> {
    return this.spanInstallation.defaultData(tab);
  }
  currentData(tab: TabId): Record<string, unknown> {
    return this.spanInstallation.currentData(tab);
  }
  changedData(tab: TabId): Record<string, unknown> {
    return this.spanInstallation.changedData(tab);
  }
}

export class AutoUpdatesPage {
  readonly name = 'autoUpdates';
  readonly intervalSeconds = 1209600;
  static readonly APPLY_UPDATE_INTERVAL_SECONDS = 1209600;
}
