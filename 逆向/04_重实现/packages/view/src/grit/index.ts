import type { FeatureFlags, TabId } from '../types.ts';
import { isGritTab } from '../ids.ts';
import {
  GritEvents,
  GritInterferenceToolKit,
  GritMenuBar,
  GritSpoofingConfiguration,
  GritStatusBar,
  PointsOfInterest,
  SpectrumViewer,
  type GritContext,
} from './components.ts';
import { buildGritShell, type GritShell } from './shell.ts';
import { GRIT_COMPONENTS, gritLogRequests } from './registry.ts';

export interface GritBundleOptions {
  context: GritContext;
  messageId?(name: string, tab: TabId): number | undefined;
}

export interface GritMountState {
  tab: TabId;
  shell: GritShell;
  components: string[];
}

function load(
  context: GritContext,
  container: Element | null,
  path: string,
): boolean {
  if (!container) return false;
  container.innerHTML = context.fragments.load(path);
  return true;
}

export class GritBundle {
  readonly statusBar: GritStatusBar;
  readonly menuBar: GritMenuBar;
  readonly events: GritEvents;
  readonly spectrumViewer: SpectrumViewer;
  readonly interferenceToolKit: GritInterferenceToolKit;
  readonly pointsOfInterest: PointsOfInterest;
  readonly spoofingConfiguration: GritSpoofingConfiguration;
  readonly shells = new Map<TabId, GritMountState>();
  readonly options: GritBundleOptions;

  constructor(options: GritBundleOptions) {
    this.options = options;
    const context = options.context;
    this.menuBar = new GritMenuBar(context);
    this.statusBar = new GritStatusBar(context);
    this.events = new GritEvents(context);
    this.spectrumViewer = new SpectrumViewer(context);
    this.interferenceToolKit = new GritInterferenceToolKit(context);
    this.pointsOfInterest = new PointsOfInterest(context, this.events);
    this.spoofingConfiguration = new GritSpoofingConfiguration(context);
  }

  get context(): GritContext {
    return this.options.context;
  }

  buildPanels(tab: TabId, host: Element): GritShell {
    const existing = this.shells.get(tab);
    if (existing) return existing.shell;
    const shell = buildGritShell(this.context.document, tab, host);
    this.shells.set(tab, { tab, shell, components: [] });
    return shell;
  }

  mount(tab: TabId, features: FeatureFlags): GritMountState {
    const state = this.shells.get(tab);
    if (!state) throw new Error(`GRIT shell not built for ${tab}`);
    const components: string[] = [];
    const ctx = this.context;
    if (load(ctx, state.shell.statusTile, './../GRIT/gritStatusBar/gritStatusBar.html')) components.push('gritStatusBar');
    if (load(ctx, state.shell.menuPanel, './../GRIT/gritMenuBar/gritMenuBar.html')) components.push('gritMenuBar');
    if (load(ctx, state.shell.eventsPanel, './../GRIT/gritEvents/gritEvents.html')) components.push('gritEvents');
    if (load(ctx, state.shell.spectrumTile, './../GRIT/spectrumViewer/spectrumViewer.html')) components.push('spectrumViewer');
    state.shell.interferenceTile.innerHTML =
      '<div id="interferenceToolKit" class="interference-toolkit-panel"></div>';
    components.push('interferenceToolKit');
    if (load(ctx, state.shell.poiContainer, './../GRIT/pointsOfInterest/pointsOfInterest.html')) components.push('pointsOfInterest');
    if (load(ctx, state.shell.spoofingContainer, './../GRIT/spoofingConfiguration/spoofingConfiguration.html')) components.push('spoofingConfiguration');
    this.menuBar.hideCapabilities(
      tab,
      features.spoofingSupported,
      features.fileSupported,
      true,
    );
    this.events.delayEventsNotifications(tab);
    state.components = components;
    return state;
  }

  mounted(tab: TabId): string[] {
    return [...(this.shells.get(tab)?.components ?? [])];
  }

  unmount(tab: TabId): void {
    const state = this.shells.get(tab);
    if (!state) return;
    for (const panel of [
      state.shell.eventsPanel,
      state.shell.menuPanel,
      state.shell.statusPanel,
      state.shell.mainPanel,
    ]) {
      (panel as unknown as Element).remove();
    }
    this.shells.delete(tab);
  }

  handleLog(tab: TabId, msgId: number, data: Record<string, unknown>): string[] {
    const delivered: string[] = [];
    if ([42, 93, 94, 963, 1201, 1465, 2065].includes(msgId)) {
      this.events.updateData(data, msgId);
      this.menuBar.setEventCount(tab, Object.values(this.events.current.get(tab) ?? {}).filter((event) => event.alive).length);
      delivered.push('gritEvents');
    }
    if ([42, 99].includes(msgId)) {
      const lat = Number(data.latitude);
      const lng = Number(data.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        this.pointsOfInterest.updateData(data, 42, tab);
        delivered.push('pointsOfInterest');
      }
    }
    if ([2358, 2364].includes(msgId)) {
      if (msgId === 2358) this.spoofingConfiguration.setSKDetectInitialState(data, tab);
      else this.spoofingConfiguration.setSpoofingPageStage(data, tab);
      delivered.push('spoofingConfiguration');
    }
    return [...new Set(delivered)];
  }

  requestLogs(tab: TabId, components: readonly string[] = GRIT_COMPONENTS): string[] {
    const requested: string[] = [];
    for (const request of gritLogRequests(components)) {
      const spec = `${request.trigger.toLowerCase()},${request.period}`;
      this.context.sendLog?.(tab, request.name, spec);
      requested.push(`${request.name} ${spec}`);
    }
    return requested;
  }

  specificMessageIds(tab: TabId): number[] {
    const ids = new Set<number>();
    for (const request of gritLogRequests()) {
      const id = this.options.messageId?.(request.name, tab);
      if (id !== undefined && id >= 0) ids.add(id);
    }
    return [...ids].sort((a, b) => a - b);
  }

  commandResponse(msgId: number, data: Record<string, unknown>, tab: TabId): void {
    if (msgId === 2358) this.spoofingConfiguration.setSKDetectInitialState(data, tab);
    if (msgId === 2364) this.spoofingConfiguration.setSpoofingPageStage(data, tab);
  }

  processLanguage(component: string, tab?: TabId): number {
    const map: Record<string, { processLanguage(tab?: TabId): number }> = {
      gritStatusBar: this.statusBar,
      gritMenuBar: this.menuBar,
      gritEvents: this.events,
      spectrumViewer: this.spectrumViewer,
      interferenceToolKit: this.interferenceToolKit,
      pointsOfInterest: {
        processLanguage: (target?: TabId) => this.statusBar.processLanguage(target),
      },
      spoofingConfiguration: this.spoofingConfiguration,
    };
    return map[component]?.processLanguage(tab) ?? 0;
  }
}

export function createGritBundle(options: GritBundleOptions): GritBundle {
  return new GritBundle(options);
}

export * from './components.ts';
export * from './registry.ts';
export * from './shell.ts';
