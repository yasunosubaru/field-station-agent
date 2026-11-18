/**
 * Device profiles: the list behind Manage's device shelf.
 *
 * The original keeps this in `userData/devicesInfo.json` (see
 * `逆向/01_解包/app/view/deviceManagement/deviceManagement.js:7-22`) with the shape
 *
 *     alldevices = {
 *       devices: { <devicekey>: { devicedetails: { name, model, type, ... }, groups: [groupkey] } },
 *       groups:  { <groupkey>:  { name, appName } },
 *     }
 *
 * and exposes addDevice / updateDeviceModel / addGroup / addDeviceToGroup / deleteDevice /
 * deleteGroup / deleteDeviceFromGroup. This module is the server half of that: the same
 * shape, the same operations, one JSON file.
 *
 * Why a file and not memory: a profile is the record of "this receiver was seen, with this
 * name, in this group". Losing it on restart would make the shelf pointless — the operator
 * would re-add the same device every session. `paths.ts` says the process keeps memory as
 * the only writable thing; this is the one deliberate exception, scoped to a single file
 * under the app's own directory, and it never holds credentials.
 *
 * Concurrency: every mutation re-reads the file, applies the change, and writes it back
 * atomically (`.tmp` + rename). The shelf is written by one process, so a lock would be
 * ceremony; the atomic rename is what actually prevents a half-written file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { APP_DIR } from './paths.ts';

/** `<repo>/逆向/04_重实现/packages/app/.devices/devicesInfo.json` */
export const DEVICES_DIR = join(APP_DIR, '.devices');
export const DEVICES_FILE = join(DEVICES_DIR, 'devicesInfo.json');

export interface DeviceDetails {
  /** Operator-given name (original: `devicedetails.name`). */
  name: string;
  /** Receiver model the device reported (original: `devicedetails.model`). */
  model: string | null;
  /** `serial` | `network` | `usb` | `playback` — the original's `devicedetails.type`. */
  type: string;
  /** `COM10`, `192.168.1.20:3001`, ... — what the connect call needs. */
  address: string;
  /** Baud for a serial link; null otherwise. */
  baud: number | null;
  /** Epoch ms of the last time this profile was used. */
  lastUsedMs: number | null;
}

export interface DeviceProfile {
  key: string;
  details: DeviceDetails;
  /** Group keys this device belongs to (original: `devices[key].groups`). */
  groups: string[];
}

export interface DeviceGroup {
  key: string;
  name: string;
  /** Original: `groups[key].appName` — which app created it. */
  appName: string;
}

export interface DeviceStore {
  devices: Record<string, { devicedetails: DeviceDetails; groups: string[] }>;
  groups: Record<string, { name: string; appName: string }>;
}

function emptyStore(): DeviceStore {
  return { devices: {}, groups: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the store, tolerating a corrupt or absent file.
 *
 * A corrupt profile list must not stop the app: the worst outcome of returning an empty
 * store is "the shelf is empty", while throwing here would take the whole Manage page down
 * for a file the operator can simply re-create by adding a device.
 */
export function readStore(): DeviceStore {
  if (!existsSync(DEVICES_FILE)) return emptyStore();
  let raw: string;
  try {
    raw = readFileSync(DEVICES_FILE, 'utf-8');
  } catch {
    return emptyStore();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return emptyStore();
    const devices: DeviceStore['devices'] = {};
    const groups: DeviceStore['groups'] = {};
    const pDevices = parsed.devices;
    if (isRecord(pDevices)) {
      for (const [key, value] of Object.entries(pDevices)) {
        if (!isRecord(value)) continue;
        const details = value.devicedetails;
        if (!isRecord(details)) continue;
        devices[key] = {
          devicedetails: {
            name: String(details.name ?? ''),
            model: details.model == null ? null : String(details.model),
            type: String(details.type ?? 'serial'),
            address: String(details.address ?? ''),
            baud: typeof details.baud === 'number' ? details.baud : null,
            lastUsedMs: typeof details.lastUsedMs === 'number' ? details.lastUsedMs : null,
          },
          groups: Array.isArray(value.groups) ? value.groups.map(String) : [],
        };
      }
    }
    const pGroups = parsed.groups;
    if (isRecord(pGroups)) {
      for (const [key, value] of Object.entries(pGroups)) {
        if (!isRecord(value)) continue;
        groups[key] = {
          name: String(value.name ?? key),
          appName: String(value.appName ?? ''),
        };
      }
    }
    return { devices, groups };
  } catch {
    return emptyStore();
  }
}

/** Write the store atomically: a crash mid-write must not leave a truncated JSON. */
export function writeStore(store: DeviceStore): void {
  if (!existsSync(DEVICES_DIR)) mkdirSync(DEVICES_DIR, { recursive: true });
  const tmp = `${DEVICES_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf-8');
  renameSync(tmp, DEVICES_FILE);
}

/* ---------------------------------------------------------------------------------------------
 * 形状转换：磁盘形状（devicedetails/groups 对象）↔ 界面形状（DeviceProfile[]）
 * ------------------------------------------------------------------------------------------- */

export function listProfiles(store: DeviceStore = readStore()): DeviceProfile[] {
  return Object.entries(store.devices)
    .map(([key, v]) => ({ key, details: v.devicedetails, groups: [...v.groups] }))
    .sort((a, b) => (b.details.lastUsedMs ?? 0) - (a.details.lastUsedMs ?? 0)
      || a.details.name.localeCompare(b.details.name));
}

export function listGroups(store: DeviceStore = readStore()): DeviceGroup[] {
  return Object.entries(store.groups)
    .map(([key, v]) => ({ key, name: v.name, appName: v.appName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------------------------------------------------------------------------------------
 * 操作：与原版 deviceManagement.js 导出的那组一一对应
 * ------------------------------------------------------------------------------------------- */

/** `addDevice` (原版 deviceManagement.js:30-37). */
export function addProfile(input: {
  key?: string;
  name?: string;
  model?: string | null;
  type?: string;
  address: string;
  baud?: number | null;
  groups?: string[];
}): DeviceProfile {
  const address = String(input.address ?? '').trim();
  if (!address) throw new Error('addProfile 需要 address（COM10 / host:port）');
  const store = readStore();
  // 同一地址重复添加 = 更新，不是新增一条：否则插拔一次就多一个档案。
  const existing = Object.entries(store.devices)
    .find(([, v]) => v.devicedetails.address === address)?.[0];
  const key = input.key?.trim() || existing || `dev-${Date.now().toString(36)}`;
  store.devices[key] = {
    devicedetails: {
      name: String(input.name ?? '').trim(),
      model: input.model ?? null,
      type: String(input.type ?? 'serial'),
      address,
      baud: input.baud ?? null,
      lastUsedMs: Date.now(),
    },
    groups: Array.isArray(input.groups) ? [...new Set(input.groups.map(String))] : [],
  };
  writeStore(store);
  return { key, details: store.devices[key].devicedetails, groups: [...store.devices[key].groups] };
}

/** `updateDeviceModel` (原版 :46-50) + 名称/波特率，UI 上是一张编辑表单。 */
export function updateProfile(key: string, patch: {
  name?: string;
  model?: string | null;
  baud?: number | null;
  type?: string;
}): DeviceProfile {
  const store = readStore();
  const entry = store.devices[key];
  if (!entry) throw new Error(`没有这个设备档案：${key}`);
  if (typeof patch.name === 'string') entry.devicedetails.name = patch.name.trim();
  if (patch.model !== undefined) entry.devicedetails.model = patch.model;
  if (patch.baud !== undefined) entry.devicedetails.baud = patch.baud;
  if (typeof patch.type === 'string') entry.devicedetails.type = patch.type;
  entry.devicedetails.lastUsedMs = Date.now();
  writeStore(store);
  return { key, details: entry.devicedetails, groups: [...entry.groups] };
}

/** `deleteDevice` (原版 :210-...)：连它的分组归属一起清掉。 */
export function deleteProfile(key: string): boolean {
  const store = readStore();
  if (!store.devices[key]) return false;
  delete store.devices[key];
  writeStore(store);
  return true;
}

/** `markUsed`：点开一张卡片就算用过，用来排序（原版 updateLastViewed）。 */
export function markUsed(key: string): DeviceProfile | null {
  const store = readStore();
  const entry = store.devices[key];
  if (!entry) return null;
  entry.devicedetails.lastUsedMs = Date.now();
  writeStore(store);
  return { key, details: entry.devicedetails, groups: [...entry.groups] };
}

/** `addGroup` (原版 :39-43). */
export function addGroup(name: string, appName = ''): DeviceGroup {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('addGroup 需要 name');
  const store = readStore();
  const existing = Object.entries(store.groups).find(([, v]) => v.name === trimmed)?.[0];
  const key = existing || `grp-${Date.now().toString(36)}`;
  store.groups[key] = { name: trimmed, appName };
  writeStore(store);
  return { key, name: trimmed, appName };
}

/** `deleteGroup` (原版 :1952 导出)：分组删掉时，设备上的归属也要摘掉。 */
export function deleteGroup(key: string): boolean {
  const store = readStore();
  if (!store.groups[key]) return false;
  delete store.groups[key];
  for (const entry of Object.values(store.devices)) {
    entry.groups = entry.groups.filter((g) => g !== key);
  }
  writeStore(store);
  return true;
}

/** `addDeviceToGroup` (原版 :203-208). */
export function addDeviceToGroup(deviceKey: string, groupKey: string): DeviceProfile {
  const store = readStore();
  const entry = store.devices[deviceKey];
  if (!entry) throw new Error(`没有这个设备档案：${deviceKey}`);
  if (!store.groups[groupKey]) throw new Error(`没有这个分组：${groupKey}`);
  if (!entry.groups.includes(groupKey)) entry.groups.push(groupKey);
  writeStore(store);
  return { key: deviceKey, details: entry.devicedetails, groups: [...entry.groups] };
}

/** `deleteDeviceFromGroup` (原版 :447 / :1960 导出). */
export function removeDeviceFromGroup(deviceKey: string, groupKey: string): DeviceProfile {
  const store = readStore();
  const entry = store.devices[deviceKey];
  if (!entry) throw new Error(`没有这个设备档案：${deviceKey}`);
  entry.groups = entry.groups.filter((g) => g !== groupKey);
  writeStore(store);
  return { key: deviceKey, details: entry.devicedetails, groups: [...entry.groups] };
}
