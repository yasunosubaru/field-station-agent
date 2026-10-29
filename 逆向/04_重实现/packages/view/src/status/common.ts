import type { FeatureFlags, TabId } from '../types.ts';
import type { View } from '../view.ts';
import type { Clock } from '../clock.ts';

export type LogData = Record<string, unknown>;
export type HeightUnit = 'Ellipsoidal' | 'MSL';

/** Numeric ids used by the status modules (NovatelIdConstants.messageIdConstants). */
export const MSG_ID = {
  INTERFACEMODE: 3,
  LOGLIST: 5,
  VERSION: 37,
  BESTPOS: 42,
  ECUTOFF: 50,
  PORTSTATS: 72,
  TRACKSTAT: 83,
  RXSTATUS: 93,
  TIME: 101,
  SERIALCONFIG: 1246,
  NTRIPCONFIG: 1249,
  ALIGNAUTOMATION: 1323,
  HEADING2: 1335,
  CONNECTIMU: 1428,
  INSPVAX: 1465,
  PSRDOP: 174,
  SATVIS2: 1043,
  GALECUTOFF: 1114,
  CHANCONFIGLIST: 1148,
  BESTSATS: 1194,
  LBANDTRACKSTAT: 1201,
  QZSSECUTOFF: 1350,
  BDSECUTOFF: 1582,
  LBANDBEAMTABLE: 1718,
  TERRASTARINFO: 1719,
  VERIPOSINFO: 1728,
  TERRASTARSTATUS: 1729,
  ASSIGNLBANDBEAM: 1733,
  DUALANTENNAALIGN: 1761,
  AUTOSURVEY: 1795,
  ITDETECTSTATUS: 2065,
  VERIPOSDECODERSTATUS: 2075,
  FILESTATUS: 2127,
  NAVICECUTOFF: 2134,
  FILESYSTEMCAPACITY: 2137,
  ITDETECTCONFIG: 2143,
  OCEANIXINFO: 2159,
  OCEANIXSTATUS: 2160,
  SATELDETECT: 2204,
  SATELSTATUS: 2205,
  WIFIALIGNAUTOMATION: 2214,
  SKDETECTCONFIG: 2358,
  AVEPOS: 172,
  POSAVE: 173,
  AGCINFO: 4096,
  GIII_CARDSTATUS: 4098,
  GIII_MEASUREMENTDATA: 4103,
  GIII_RXCOMMANDS: 4105,
  GIII_SATPOS: 4106,
  GIII_TIMESOLUTION: 4107,
} as const;

export interface StatusContext {
  document: Document;
  view: View;
  clock: Clock;
  features(tab: TabId): FeatureFlags;
  heightUnit(tab: TabId): HeightUnit;
  connectionType(tab: TabId): string | undefined;
  componentFields(component: string, msgId: number): string | undefined;
  deviceTileId(tab: TabId): string;
  supportedConstellations(tab: TabId): string[] | undefined;
  userData<T>(path: string[]): T | undefined;
  setUserData(path: string[], value: unknown): void;
  messageName(messageId: unknown, tab: TabId): string;
  localFileLoggingInfo?(tab: TabId): LogData | undefined;
  connectedPortName?(tab: TabId): string | undefined;
  giiiPortType?(tab: TabId): string | undefined;
  setRadioPort?(tab: TabId, port: string | undefined): void;
  openDialog?(options: {
    tab: TabId;
    title: string;
    titleMarker?: string;
    content: string;
    className?: string;
  }): void;
  closeDialog?(tab: TabId): void;
  copyText?(text: string): void;
  publishEvent?(tab: TabId, channel: string, data: LogData): void;
  theme?(tab: TabId): string;
  distanceUnit(): string;
  velocityUnit(): string;
  translate(key: string): string;
}

export interface StatusRagSource {
  rag(tab: TabId): string | undefined;
}

export function tabOf(data: unknown): TabId {
  if (!data || typeof data !== 'object') return '';
  const tab = (data as { tab?: unknown }).tab;
  return typeof tab === 'string' ? tab : '';
}

/**
 * The session emits DecodedLog records, while the original status modules receive the
 * decoder's field object with a `tab` property. Flatten the former without discarding its
 * repeated blocks (`blocks`/`data`) or the original `fields` object.
 */
export function normalizeLog(input: unknown): LogData {
  if (!input || typeof input !== 'object') return {};
  const raw = input as LogData;
  const fields =
    raw.fields && typeof raw.fields === 'object' ? (raw.fields as LogData) : {};
  return { ...fields, ...raw };
}

export function rowsOf(data: LogData, preferred: 'data' | 'Data' = 'data'): LogData[] {
  const candidates = [
    data[preferred],
    data.data,
    data.Data,
    data.blocks,
    data.channelData,
    data.sats,
    data.ports,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate.filter((row): row is LogData => !!row && typeof row === 'object');
    }
  }
  const numeric: LogData[] = [];
  for (let index = 0; index < 512; index += 1) {
    const value = data[String(index)];
    if (!value || typeof value !== 'object') break;
    numeric.push(value as LogData);
  }
  return numeric;
}

export function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function scopeOf(ctx: StatusContext, tab: TabId): Element | null {
  if (!tab) return ctx.document.body;
  return ctx.document.getElementById(tab);
}

export function queryIn(
  ctx: StatusContext,
  tab: TabId,
  selector: string,
): Element | null {
  const scope = scopeOf(ctx, tab);
  if (!scope) return null;
  const own = ctx.document.getElementById(selector.replace(/^#/, ''));
  if (own && scope.contains(own)) return own;
  return scope.querySelector(selector);
}

export function setVisible(element: Element | null, visible: boolean): void {
  if (!element) return;
  const styled = element as Element & { style?: CSSStyleDeclaration };
  if (styled.style) styled.style.display = visible ? 'block' : 'none';
  else if (visible) element.removeAttribute('hidden');
  else element.setAttribute('hidden', '');
}

export function setStyle(element: Element | null, name: string, value: string): void {
  if (!element) return;
  (element as HTMLElement).style.setProperty(name, value);
}

export function removeMarkers(element: Element | null, names: string[]): void {
  if (!element) return;
  for (const name of names) element.removeAttribute(name);
}

export function setText(
  ctx: StatusContext,
  tab: TabId,
  selector: string,
  text: string,
): boolean {
  const element = queryIn(ctx, tab, selector);
  if (!element) return false;
  element.textContent = text;
  return true;
}

export function formatNumber(
  ctx: StatusContext,
  value: unknown,
  digits: number,
  tab: TabId,
): string {
  return ctx.view.formatToSystemLocale(value, digits, tab);
}

export function displayNumber(
  ctx: StatusContext,
  value: unknown,
  digits: number,
  tab: TabId,
  suffix = '',
): string {
  const parsed = numberValue(value, Number.NaN);
  return Number.isFinite(parsed) ? formatNumber(ctx, parsed, digits, tab) + suffix : '--';
}

export function heightText(
  ctx: StatusContext,
  data: LogData,
  tab: TabId,
): string {
  const height = numberValue(data.height, Number.NaN);
  if (!Number.isFinite(height)) return '--';
  const undulation = numberValue(data.undulation, 0);
  const value = ctx.heightUnit(tab) === 'Ellipsoidal' ? height + undulation : height;
  const text = displayNumber(ctx, value, 2, tab, '');
  return `${value % 1 === 0 ? String(value) : text}${ctx.distanceUnit()}`;
}

export function angleText(
  ctx: StatusContext,
  value: unknown,
  tab: TabId,
  digits = 2,
): string {
  return displayNumber(ctx, value, digits, tab, '°');
}

export function updateFields(
  ctx: StatusContext,
  tab: TabId,
  feature: string,
  fields: string,
  data: LogData,
): number {
  if (!tab) return 0;
  const payload = { ...data, tab };
  return (ctx.view.updateView as unknown as (
    json: LogData,
    fields: string,
    feature: string,
  ) => number)(payload, fields, feature);
}

export function showRag(
  ctx: StatusContext,
  tab: TabId,
  parent: string,
  state: string | undefined,
): void {
  if (!tab || !state) return;
  ctx.view.updateStatusIndicatorClrAndText(parent, state, tab);
}

/** `updateStatusIndicatorClrAndText` for the two `.traffic-lights` in statusBar. */
export function showTrafficLight(
  ctx: StatusContext,
  tab: TabId,
  parent: string,
  colour: 'red' | 'yellow' | 'green',
): void {
  const scope = scopeOf(ctx, tab);
  if (!scope) return;
  for (const node of scope.querySelectorAll(`.${parent}.traffic-lights span`)) {
    setVisible(node, false);
  }
  for (const node of scope.querySelectorAll(`.${parent}.traffic-lights span.${colour}-status`)) {
    setVisible(node, true);
  }
}

export function worstState(states: Array<string | undefined>): string {
  if (states.includes('bad')) return 'bad';
  if (states.includes('warning')) return 'warning';
  if (states.includes('idle')) return 'idle';
  return 'good';
}

export function findInternalFlash(data: LogData): LogData | null {
  const direct =
    data.massStorageDevice === 'INTERNAL_FLASH' ? data : null;
  if (direct) return direct;
  const visit = (value: unknown): LogData | null => {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const hit = visit(entry);
        if (hit) return hit;
      }
      return null;
    }
    const record = value as LogData;
    if (record.massStorageDevice === 'INTERNAL_FLASH') return record;
    for (const child of Object.values(record)) {
      const hit = visit(child);
      if (hit) return hit;
    }
    return null;
  };
  return visit(data);
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function escapeHTML(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Common shape of every shipped `processLanguage()`: rewrite a hard-coded marker(s) with
 * `__("KEY")`. `tab` is intentionally document-wide for most components, matching the original.
 */
export function applyLanguageMarkers(
  ctx: StatusContext,
  mappings: Array<{ selector: string; value: string | (() => string) }>,
  root: ParentNode = ctx.document,
): number {
  let written = 0;
  for (const mapping of mappings) {
    const value = typeof mapping.value === 'function' ? mapping.value() : mapping.value;
    for (const element of Array.from(root.querySelectorAll(mapping.selector))) {
      element.innerHTML = value;
      written += 1;
    }
  }
  return written;
}

export function __(ctx: StatusContext, key: string): string {
  return ctx.translate(key);
}

/**
 * Use the Plotly build already shipped in `01_解包/app/view/js/plotly-latest.min.js` when the
 * module runs inside the application. Node tests have no global Plotly and their components
 * provide a textual data view instead.
 */
export function renderPlotly(
  element: Element | null,
  data: LogData[],
  layout: LogData,
  onGraph?: (graph: {
    on?: (name: string, fn: (event: LogData) => void) => void;
  }) => void,
): boolean {
  if (!element?.id) return false;
  const runtime = globalThis as typeof globalThis & {
    Plotly?: {
      newPlot?: (id: string, data: LogData[], layout: LogData) => unknown;
      react?: (id: string, data: LogData[], layout: LogData) => unknown;
    };
  };
  const plotly = runtime.Plotly;
  if (!plotly) return false;
  try {
    const render = plotly.react ?? plotly.newPlot;
    if (!render) return false;
    const result = render(element.id, data, layout);
    if (onGraph && result && typeof (result as PromiseLike<unknown>).then === 'function') {
      (result as PromiseLike<{
        on?: (name: string, fn: (event: LogData) => void) => void;
      }>).then((graph) => onGraph(graph));
    } else if (onGraph && result) {
      onGraph(result as {
        on?: (name: string, fn: (event: LogData) => void) => void;
      });
    }
    return true;
  } catch {
    return false;
  }
}
