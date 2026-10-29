import type { TabId } from '../types.ts';
import type {
  CommandResponse,
  ConfigCommandCatalog,
  ConfigDataMap,
  ConfigPage,
  ConfigTransport,
} from './types.ts';
import { COMMAND_RESPONSE, commandParam } from './types.ts';
import { buildAsciiCommand, buildBinaryCommand, makePortNamePredicate } from '../../../protocol/src/index.ts';

function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function mergeDeep(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = clone(base);
  for (const [key, value] of Object.entries(patch)) {
    const previous = out[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      previous &&
      typeof previous === 'object' &&
      !Array.isArray(previous)
    ) {
      out[key] = mergeDeep(
        previous as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

/**
 * The three dictionaries shared by every configuration page:
 *   - `baseline` / `defaultData`: the snapshot taken when the page reset;
 *   - `current` / `data`: the latest receiver value;
 *   - `pending` / `changedData`: a sparse user diff against the baseline.
 *
 * A changed value equal to the baseline is deleted, matching every shipped page.
 */
export class TripleStateStore {
  private readonly currentByTab = new Map<TabId, Record<string, unknown>>();
  private readonly baselineByTab = new Map<TabId, Record<string, unknown>>();
  private readonly pendingByTab = new Map<TabId, Record<string, unknown>>();

  current(tab: TabId): Record<string, unknown> {
    let value = this.currentByTab.get(tab);
    if (!value) {
      value = {};
      this.currentByTab.set(tab, value);
    }
    return value;
  }

  baseline(tab: TabId): Record<string, unknown> {
    let value = this.baselineByTab.get(tab);
    if (!value) {
      value = {};
      this.baselineByTab.set(tab, value);
    }
    return value;
  }

  pending(tab: TabId): Record<string, unknown> {
    let value = this.pendingByTab.get(tab);
    if (!value) {
      value = {};
      this.pendingByTab.set(tab, value);
    }
    return value;
  }

  updateCurrent(tab: TabId, msgId: string | number, value: unknown): void {
    const current = this.currentByTab.get(tab) ?? {};
    current[String(msgId)] = clone(value);
    this.currentByTab.set(tab, current);
  }

  mergeCurrent(tab: TabId, msgId: string | number, value: Record<string, unknown>): void {
    const current = this.currentByTab.get(tab) ?? {};
    const previous = current[String(msgId)];
    current[String(msgId)] =
      previous && typeof previous === 'object' && !Array.isArray(previous)
        ? { ...(previous as Record<string, unknown>), ...clone(value) }
        : clone(value);
    this.currentByTab.set(tab, current);
  }

  /** `dh_createDefaultData`: copy the latest receiver dictionary into the baseline. */
  snapshot(tab: TabId): void {
    this.baselineByTab.set(tab, clone(this.currentByTab.get(tab) ?? {}));
    this.pendingByTab.set(tab, {});
  }

  /** `dh_updateChangedData`: set/delete one sparse value and prune an empty msg-id bucket. */
  setPending(
    tab: TabId,
    msgId: string | number,
    key: string,
    value: unknown,
    baselineValue?: unknown,
  ): void {
    const id = String(msgId);
    const pending = this.pendingByTab.get(tab) ?? {};
    const baseline = this.baselineByTab.get(tab) ?? {};
    const baselineBucket =
      baseline[id] && typeof baseline[id] === 'object'
        ? (baseline[id] as Record<string, unknown>)
        : {};
    const reference = baselineValue !== undefined ? baselineValue : baselineBucket[key];
    const equal = stableJson(reference) === stableJson(value);
    if (equal) {
      const bucket = pending[id];
      if (bucket && typeof bucket === 'object') {
        delete (bucket as Record<string, unknown>)[key];
        if (Object.keys(bucket).length === 0) delete pending[id];
      }
    } else {
      const bucket =
        pending[id] && typeof pending[id] === 'object'
          ? (pending[id] as Record<string, unknown>)
          : {};
      bucket[key] = clone(value);
      pending[id] = bucket;
    }
    if (Object.keys(pending).length === 0) this.pendingByTab.delete(tab);
    else this.pendingByTab.set(tab, pending);
  }

  setPendingBucket(tab: TabId, msgId: string | number, value: Record<string, unknown>): void {
    const pending = this.pendingByTab.get(tab) ?? {};
    const id = String(msgId);
    const baseline = this.baselineByTab.get(tab) ?? {};
    const baselineBucket =
      baseline[id] && typeof baseline[id] === 'object'
        ? (baseline[id] as Record<string, unknown>)
        : {};
    const diff: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (stableJson(entry) !== stableJson(baselineBucket[key])) diff[key] = clone(entry);
    }
    if (Object.keys(diff).length) pending[id] = diff;
    else delete pending[id];
    if (Object.keys(pending).length) this.pendingByTab.set(tab, pending);
    else this.pendingByTab.delete(tab);
  }

  discard(tab: TabId): void {
    this.currentByTab.set(tab, clone(this.baselineByTab.get(tab) ?? {}));
    this.pendingByTab.delete(tab);
  }

  commit(tab: TabId): void {
    const merged = mergeDeep(this.current(tab), this.pending(tab));
    this.currentByTab.set(tab, merged);
    this.baselineByTab.set(tab, clone(merged));
    this.pendingByTab.delete(tab);
  }

  clear(tab: TabId): void {
    this.currentByTab.delete(tab);
    this.baselineByTab.delete(tab);
    this.pendingByTab.delete(tab);
  }

  isDirty(tab: TabId): boolean {
    const pending = this.pendingByTab.get(tab);
    return !!pending && Object.keys(pending).length > 0;
  }
}

interface ExpectedCommand {
  expected: number;
  values: CommandResponse[];
}

interface FeatureCommandState {
  commands: Record<number, ExpectedCommand>;
}

export interface CommandCompletion {
  feature: string;
  response: CommandResponse;
  tab: TabId;
  msgId: number;
  error?: string;
  sequence: number;
}

export interface ConfigCommandCoordinatorOptions {
  catalog: ConfigCommandCatalog;
  transport: ConfigTransport;
  /** The original global `currentConfigName`, including its cross-tab interference. */
  currentFeature?: string;
  portNames?: readonly string[];
  isolateTabs?: boolean;
}

/**
 * `genericConfig.placeCmdReq/commandResponseHandler` without the page callbacks.
 *
 * The original keeps one global feature bucket, independent of tab. That is reproduced by
 * default; `isolateTabs:true` is the explicit correction for concurrent devices.
 */
export class ConfigCommandCoordinator {
  private readonly catalogByLower: Record<string, { key: string; entry: ConfigCommandCatalog[string] }> = {};
  private readonly transport: ConfigTransport;
  private readonly portPredicate: (name: string) => boolean;
  private readonly states = new Map<string, FeatureCommandState>();
  private readonly isolateTabs: boolean;
  private currentFeature = '';
  private sequence = 0;
  readonly sent: Array<{
    feature: string;
    name: string;
    msgId: number;
    tab: TabId;
    params: ConfigDataMap;
    bytes?: Uint8Array;
    ascii?: string;
  }> = [];

  constructor(options: ConfigCommandCoordinatorOptions) {
    this.transport = options.transport;
    this.isolateTabs = options.isolateTabs === true;
    this.currentFeature = options.currentFeature ?? '';
    this.portPredicate = makePortNamePredicate(options.portNames ?? []);
    for (const [key, entry] of Object.entries(options.catalog)) {
      this.catalogByLower[key.toLowerCase()] = { key, entry };
    }
  }

  setCurrentFeature(name: string): void {
    this.currentFeature = name;
  }

  currentFeatureName(): string {
    return this.currentFeature;
  }

  resolveCommand(name: string): ConfigCommandCatalog[string] | undefined {
    return this.catalogByLower[name.toLowerCase()]?.entry;
  }

  canonicalCommandName(name: string): string | undefined {
    return this.catalogByLower[name.toLowerCase()]?.key;
  }

  expected(feature = this.currentFeature, msgId?: number, tab?: TabId): number | undefined {
    const state = this.states.get(this.featureKey(feature, tab));
    return msgId === undefined ? undefined : state?.commands[msgId]?.expected;
  }

  responses(feature = this.currentFeature, msgId?: number, tab?: TabId): CommandResponse[] {
    const state = this.states.get(this.featureKey(feature, tab));
    return msgId === undefined ? [] : [...(state?.commands[msgId]?.values ?? [])];
  }

  /**
   * `placeCmdReq`: increment the expected count and emit one binary or raw-ASCII request.
   * Returns the wire image so configuration tests can assert against the shipped field table.
   */
  place(
    feature: string,
    commandName: string,
    params: ConfigDataMap,
    tab: TabId,
  ): Uint8Array | string | undefined {
    const resolved = this.resolveCommand(commandName);
    if (!resolved) return undefined;

    const key = this.featureKey(feature, tab);
    const state = this.states.get(key) ?? { commands: {} };
    const bucket =
      state.commands[resolved.messageId] ?? {
        expected: 0,
        values: [],
      };
    bucket.expected += 1;
    state.commands[resolved.messageId] = bucket;
    this.states.set(key, state);
    return this.wire(feature, commandName, params, tab, resolved);
  }

  /** `genericConfig.sendCommand`: emit without adding a feature response expectation. */
  sendUntracked(
    commandName: string,
    params: ConfigDataMap,
    tab: TabId,
  ): Uint8Array | string | undefined {
    const resolved = this.resolveCommand(commandName);
    if (!resolved) return undefined;
    return this.wire('', commandName, params, tab, resolved);
  }

  private wire(
    feature: string,
    commandName: string,
    params: ConfigDataMap,
    tab: TabId,
    resolved: ConfigCommandCatalog[string],
  ): Uint8Array | string {
    if (commandName.toLowerCase() === 'send' || commandName.toLowerCase() === 'sendhex') {
      const request = String(params[0]?.command?.[0] ?? '');
      const ascii = buildAsciiCommand(request, this.portPredicate);
      this.transport.sendAsciiFrame(tab, request);
      this.sent.push({
        feature,
        name: commandName,
        msgId: resolved.messageId,
        tab,
        params: clone(params),
        ascii,
      });
      return ascii;
    }

    const commandParams = [];
    for (const row of params) {
      for (const [field, spec] of Object.entries(row)) {
        const [raw, type, length] = spec;
        let value = raw;
        if (type === 'enum') {
          const table = resolved.enums[field] ?? {};
          if (typeof value === 'string') value = table[value] ?? table[value.toUpperCase()] ?? value;
        }
        commandParams.push(commandParam(value, type, length ?? 0));
      }
    }
    const bytes = buildBinaryCommand({ messageId: resolved.messageId, params: commandParams });
    this.transport.sendBinary(tab, bytes);
    this.sent.push({
      feature,
      name: commandName,
      msgId: resolved.messageId,
      tab,
      params: clone(params),
      bytes,
    });
    return bytes;
  }

  /**
   * Feed the parser's `Commanddata` value. The response rules are those of
   * `genericConfig.js:33-154`: an error within the expected window short-circuits to ERROR,
   * UNKNOWN means incomplete, otherwise the feature completes only after every msg id has its
   * declared number of replies.
   */
  handleResponse(
    msgId: number,
    value: number,
    tab: TabId,
    error?: string,
  ): CommandCompletion[] {
    // `genericConfig.js:44-51`: SAVECONFIG is deliberately excluded from `values`.
    if (msgId === 19) return [];
    const response: CommandResponse =
      value === COMMAND_RESPONSE.ERROR
        ? COMMAND_RESPONSE.ERROR
        : value === COMMAND_RESPONSE.OK
          ? COMMAND_RESPONSE.OK
          : COMMAND_RESPONSE.UNKNOWN;
    const completed: CommandCompletion[] = [];

    for (const [key, state] of [...this.states.entries()]) {
      const parsed = this.parseFeatureKey(key);
      if (this.isolateTabs && parsed.tab !== tab) continue;
      const bucket = state.commands[msgId];
      if (!bucket) continue;
      bucket.values.push(response);

      let overall: CommandResponse = COMMAND_RESPONSE.OK;
      let complete = true;
      for (const command of Object.values(state.commands)) {
        const errorIndex = command.values.indexOf(COMMAND_RESPONSE.ERROR);
        if (errorIndex !== -1 && errorIndex <= command.expected - 1) {
          overall = COMMAND_RESPONSE.ERROR;
          complete = true;
          break;
        }
        if (command.values.includes(COMMAND_RESPONSE.UNKNOWN)) {
          complete = false;
          break;
        }
        if (command.values.length < command.expected) {
          complete = false;
          break;
        }
      }
      if (!complete) continue;
      completed.push({
        feature: parsed.feature,
        response: overall,
        tab,
        msgId,
        error,
        sequence: ++this.sequence,
      });
    }
    return completed;
  }

  removeFeature(feature: string, tab?: TabId): void {
    if (tab) this.states.delete(this.featureKey(feature, tab));
    else {
      for (const key of [...this.states.keys()]) {
        if (this.parseFeatureKey(key).feature === feature) this.states.delete(key);
      }
    }
  }

  reset(): void {
    this.states.clear();
    this.currentFeature = '';
    this.sequence = 0;
  }

  pendingFeatures(): Array<{ feature: string; tab: TabId; msgId: number; expected: number }> {
    const out: Array<{ feature: string; tab: TabId; msgId: number; expected: number }> = [];
    for (const [key, state] of this.states) {
      const parsed = this.parseFeatureKey(key);
      for (const [id, bucket] of Object.entries(state.commands)) {
        out.push({
          feature: parsed.feature,
          tab: parsed.tab,
          msgId: Number(id),
          expected: bucket.expected,
        });
      }
    }
    return out;
  }

  private featureKey(feature: string, tab: TabId): string {
    return this.isolateTabs ? `${tab}\u0000${feature}` : feature;
  }

  private parseFeatureKey(key: string): { tab: TabId; feature: string } {
    if (!this.isolateTabs) return { tab: '', feature: key };
    const index = key.indexOf('\u0000');
    return index === -1
      ? { tab: '', feature: key }
      : { tab: key.slice(0, index), feature: key.slice(index + 1) };
  }
}

export interface PageHandlerBinding {
  page: ConfigPage;
  feature: string;
}

/**
 * Holds a page's shared dictionaries and mounts its shipped fragment. Concrete pages only own
 * field translations and the command sequence.
 */
export class ConfigPageState<T extends Record<string, unknown> = Record<string, unknown>>
  implements Pick<ConfigPage, 'updateData' | 'defaultData' | 'currentData' | 'changedData' | 'isDirty'>
{
  readonly state = new TripleStateStore();
  readonly pageData = new Map<TabId, T>();
  readonly mountedContainers = new Map<TabId, Element>();

  defaultData(tab: TabId): Record<string, unknown> {
    return clone(this.state.baseline(tab));
  }

  currentData(tab: TabId): Record<string, unknown> {
    return clone(this.state.current(tab));
  }

  changedData(tab: TabId): Record<string, unknown> {
    return clone(this.state.pending(tab));
  }

  isDirty(tab: TabId): boolean {
    return this.state.isDirty(tab);
  }

  updateData(msgId: number, data: Record<string, unknown>): void {
    this.state.updateCurrent(String(data.tab ?? ''), msgId, data);
  }

  page(tab: TabId, initial: () => T): T {
    let value = this.pageData.get(tab);
    if (!value) {
      value = initial();
      this.pageData.set(tab, value);
    }
    return value;
  }

  clear(tab: TabId): void {
    this.state.clear(tab);
    this.pageData.delete(tab);
    this.mountedContainers.delete(tab);
  }
}
