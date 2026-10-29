/**
 * The refresh throttle — the answer to "how does the original avoid updating 10 tabs at once".
 *
 * `03_分析/01_Manage主界面与视图层.md §6.4` documents three software gates; this module is the
 * first one (the `emitter` gate of `jarvisInterface.js:6725-6812`) plus the replay performed when
 * a tab becomes active again (`loadCachedData`, `jarvisInterface.js:5449-5495`).
 *
 * Acceptance criteria: R40 and R41.
 */

import type { CachedChannel, TabId, Throttle } from './types.ts';

/**
 * The replay order of `loadCachedData`, cache key → emitter channel.
 * Note the asymmetric names: the cache key is `trackstat`, the channel `constellationTrackstat`.
 */
export const REPLAY_ORDER: ReadonlyArray<readonly [channel: string, cacheKey: string]> = [
  ['statusBar', 'statusBar'],
  ['positionStatus', 'positionStatus'],
  ['alignStatus', 'alignStatus'],
  ['deviceInfo', 'deviceInfo'],
  ['radioStatus', 'radioStatus'],
  ['spanStatus', 'spanStatus'],
  ['constellationTrackstat', 'trackstat'],
  ['constellationChanconfiglist', 'chanconfiglist'],
  ['constellationSatvis', 'satvis'],
  ['constellationBestsats', 'bestsats'],
  ['satelliteTracking', 'satelliteTracking'],
];

/**
 * `gritLoadCachedData` (`gritJarvisInterface.js:1310-1337`) is a **separate** replay, not extra
 * channels of `loadCachedData`: a GRIT tab replays its own three buckets, then clears them.
 */
export const GRIT_REPLAY_ORDER: ReadonlyArray<readonly [channel: string, cacheKey: string]> = [
  ['gritStatusBar', 'gritStatusBar'],
  ['spectrumPlot', 'spectrumPlot'],
  ['gritPositionStatusmodes', 'gritPositionStatusmodes'],
];

/**
 * How many payload shapes the original emitter uses:
 *  - `[msgID, logData]` where `logData.tab` carries the tab;
 *  - `[logData, tab]` for the constellation channels;
 *  - `[msgID, logData, tab]` for a couple of GRIT channels.
 */
export function tabOfPayload(payload: unknown[]): TabId {
  for (const entry of payload) {
    if (entry && typeof entry === 'object' && typeof (entry as { tab?: unknown }).tab === 'string') {
      return (entry as { tab: TabId }).tab;
    }
    if (typeof entry === 'string' && (entry.startsWith('tabs-') || entry.startsWith('grit-tabs-'))) return entry;
  }
  return '';
}

export interface ThrottleOptions {
  /** `NovatelIdConstants.tabName`. */
  activeTab: () => TabId;
  /** Called when the active tab changes (mirrors `tabName = tabc`). */
  setActiveTab: (tab: TabId) => void;
  /** Override the payload → tab rule (GRIT channels). */
  tabOf?: (payload: unknown[]) => TabId;
}

/**
 * `isActive` follows the original's gate: `tabs-1` (the "Add device" page) and `''` (webui/landing)
 * are treated as active for every tab, which is what makes the landing-page tiles render at all.
 */
export class ThrottleImpl implements Throttle {
  private readonly options: ThrottleOptions;
  private readonly renderers = new Map<string, (data: unknown[]) => void>();
  private readonly cache: Record<TabId, CachedChannel> = {};
  private readonly replayCounts: Record<TabId, number> = {};

  constructor(options: ThrottleOptions) {
    this.options = options;
  }

  isActive(tab: TabId): boolean {
    const active = this.options.activeTab();
    return active === 'tabs-1' || active === 'grit-tabs-1' || active === '' || active === tab;
  }

  setActiveTab(tab: TabId | ''): void {
    this.options.setActiveTab(tab);
  }

  on(channel: string, renderer: (data: unknown[]) => void): void {
    this.renderers.set(channel, renderer);
  }

  /** `emitter.emit` replacement. Returns what it did, so tests can assert the branch. */
  dispatch(channel: string, data: unknown[]): 'rendered' | 'cached' | 'dropped' {
    const tab = (this.options.tabOf ?? tabOfPayload)(data);
    const cacheKey = CHANNEL_CACHE_KEY(channel);
    if (tab === '') return 'dropped';
    if (this.isActive(tab)) {
      const renderer = this.renderers.get(channel);
      if (!renderer) return 'dropped';
      renderer(data);
      return 'rendered';
    }
    if (!cacheKey) return 'dropped';
    if (!this.cache[tab]) this.cache[tab] = {};
    if (channel === 'spectrumPlot') {
      const existing = this.cache[tab][cacheKey] as unknown;
      if (Array.isArray(existing) && existing.length && Array.isArray(existing[0])) {
        existing.push(data);
        if (existing.length > 30) existing.shift();
      } else if (Array.isArray(existing) && existing.length) {
        this.cache[tab][cacheKey] = [existing, data];
      } else {
        this.cache[tab][cacheKey] = data;
      }
    } else {
      this.cache[tab][cacheKey] = data;
    }
    return 'cached';
  }

  cached(tab: TabId): CachedChannel {
    if (!this.cache[tab]) this.cache[tab] = {};
    return this.cache[tab];
  }

  /** `loadCachedData(tab)`: replay the 11 channels in the original order. */
  replay(tab: TabId): string[] {
    return this.replayFrom(tab, REPLAY_ORDER);
  }

  /** `gritLoadCachedData(tab)`: the GRIT tab's own three buckets (`gritJarvisInterface.js:1310-1337`). */
  replayGrit(tab: TabId): string[] {
    return this.replayFrom(tab, GRIT_REPLAY_ORDER);
  }

  private replayFrom(tab: TabId, order: ReadonlyArray<readonly [string, string]>): string[] {
    const replayed: string[] = [];
    // The original dereferences `cachedData[tab]` without a guard; we create the bucket instead.
    const bucket = this.cached(tab);
    for (const [channel, cacheKey] of order) {
      if (!Object.prototype.hasOwnProperty.call(bucket, cacheKey)) continue;
      const renderer = this.renderers.get(channel);
      if (!renderer) continue;
      const data = bucket[cacheKey] as unknown[];
      if (!Array.isArray(data)) continue;
      if (channel === 'spectrumPlot' && Array.isArray(data[0])) {
        for (const frame of data as unknown[][]) renderer(frame);
      } else {
        renderer(data);
      }
      replayed.push(channel);
    }
    this.replayCounts[tab] = (this.replayCounts[tab] ?? 0) + 1;
    return replayed;
  }

  clear(tab: TabId): void {
    delete this.cache[tab];
  }

  clearAll(): void {
    for (const key of Object.keys(this.cache)) delete this.cache[key];
  }

  replayCount(tab: TabId): number {
    return this.replayCounts[tab] ?? 0;
  }
}

/** Emitter channel → `cachedData` key. `portStatus`/`logStatus` are cached but never replayed. */
export function CHANNEL_CACHE_KEY(channel: string): string | undefined {
  switch (channel) {
    case 'statusBar':
      return 'statusBar';
    case 'positionStatus':
      return 'positionStatus';
    case 'pppCorrections':
      // The original folds pppCorrections into the positionStatus bucket (`jarvisInterface.js:6745`).
      return 'positionStatus';
    case 'portStatus':
      return 'portStatus';
    case 'logStatus':
      return 'logStatus';
    case 'alignStatus':
      return 'alignStatus';
    case 'deviceInfo':
      return 'deviceInfo';
    case 'radioStatus':
      return 'radioStatus';
    case 'spanStatus':
      return 'spanStatus';
    case 'constellationTrackstat':
      return 'trackstat';
    case 'constellationChanconfiglist':
      return 'chanconfiglist';
    case 'constellationSatvis':
      return 'satvis';
    case 'constellationBestsats':
      return 'bestsats';
    case 'satelliteTracking':
      return 'satelliteTracking';
    case 'agcStatus':
      return 'agcStatus';
    case 'gritStatusBar':
      return 'gritStatusBar';
    case 'spectrumPlot':
      return 'spectrumPlot';
    case 'gritPositionStatusmodes':
      return 'gritPositionStatusmodes';
    default:
      return undefined;
  }
}

export function createThrottle(options: ThrottleOptions): ThrottleImpl {
  return new ThrottleImpl(options);
}
