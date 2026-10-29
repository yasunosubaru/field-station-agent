/**
 * `userStore` — the JSON blob the original persists under `<userData>/userSettings.json`.
 *
 * Only the parts the view layer touches are modelled (`app.dynamic`, `app.defaultLayout`,
 * `heightUnits`, `connectionMode`, `theme`, `language`, `slider`). Two behaviours are
 * deliberately different from the original and documented:
 *
 *  - `getData()` still returns a deep copy, exactly like the original, because callers rely on
 *    it (`03_分析/01_Manage主界面与视图层.md §7.5`);
 *  - but there *is* a real `set()`, so the writes the original lost (mutating the copy) work.
 */

import type { DeviceTileId, LayoutSnapshot, UserStoreData, UserStoreLike } from './types.ts';

export interface UserStoreStorage {
  read(): string | null;
  write(text: string): void;
}

export function emptyUserStore(): UserStoreData {
  return {
    theme: 'light-theme',
    language: 'en',
    slider: false,
    app: {
      dynamic: {},
      defaultLayout: {},
      lastManageSortedDevices: [],
      lastGritSortedDevices: [],
      heightUnits: {},
      connectionMode: { network_mode: 'Host Name', network_type: 'tcp' },
    },
  };
}

function deepCopy<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** In-memory storage — the default, and what every test uses. */
export class MemoryStorage implements UserStoreStorage {
  text: string | null;
  constructor(text: string | null = null) {
    this.text = text;
  }
  read(): string | null {
    return this.text;
  }
  write(value: string): void {
    this.text = value;
  }
}

export class UserStore implements UserStoreLike {
  json: UserStoreData;
  private readonly storage: UserStoreStorage;

  constructor(storage: UserStoreStorage = new MemoryStorage(), seed?: Partial<UserStoreData>) {
    this.storage = storage;
    this.json = this.read(seed);
  }

  /** Parses the stored blob, then applies any seed the caller wants merged on top. */
  private read(seed?: Partial<UserStoreData>): UserStoreData {
    let parsed: UserStoreData | null = null;
    const text = this.storage.read();
    if (text) {
      try {
        parsed = JSON.parse(text) as UserStoreData;
      } catch {
        parsed = null;
      }
    }
    const base = parsed ?? emptyUserStore();
    base.app = { ...emptyUserStore().app, ...(base.app ?? {}) };
    if (seed) {
      const merged: UserStoreData = { ...base, ...seed };
      merged.app = { ...base.app, ...(seed.app ?? {}) };
      return merged;
    }
    return base;
  }

  /** Deep copy, matching `userStore.getData([...])`. */
  getData<T>(path: string[]): T | undefined {
    let node: unknown = this.json;
    for (const key of path) {
      if (node === null || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[key];
    }
    return deepCopy(node) as T;
  }

  /** Real write into the store (path segments create plain objects on the way). */
  set(path: string[], value: unknown): void {
    if (!path.length) return;
    let node: Record<string, unknown> = this.json as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) {
      const next = node[key];
      if (next === null || typeof next !== 'object') node[key] = {};
      node = node[key] as Record<string, unknown>;
    }
    node[path[path.length - 1]] = deepCopy(value);
  }

  save(): void {
    this.storage.write(JSON.stringify(this.json, null, 2));
  }

  layout(deviceTileId: DeviceTileId): LayoutSnapshot | undefined {
    return this.json.app.dynamic[deviceTileId];
  }

  setLayout(deviceTileId: DeviceTileId, snapshot: LayoutSnapshot): void {
    this.set(['app', 'dynamic', deviceTileId], snapshot);
  }

  defaultLayout(deviceTileId: DeviceTileId): LayoutSnapshot | undefined {
    return this.json.app.defaultLayout[deviceTileId];
  }

  setDefaultLayout(deviceTileId: DeviceTileId, snapshot: LayoutSnapshot): void {
    this.set(['app', 'defaultLayout', deviceTileId], snapshot);
  }
}
