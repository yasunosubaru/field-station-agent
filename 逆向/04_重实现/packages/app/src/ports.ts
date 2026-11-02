/**
 * Serial ports actually present on this machine.
 *
 * The live link opens a serial port through the optional `serialport` package (see
 * `live.ts` / `server.ts#serialOpener`); this module is the other half of that: it answers
 * "which ports exist right now", with the name Device Manager shows, so the Add Device dialog
 * can list real choices instead of asking the operator to type `COM10` from memory.
 *
 * Why not `node:fs` on `\\.\COM10`: enumerating needs SetupAPI, and opening needs a DCB. The
 * native binding already does both. When it is not installed the fallback still reports the port
 * names Windows publishes in `HARDWARE\DEVICEMAP\SERIALCOMM` (through PowerShell, which every
 * supported Windows has), only without the friendly name.
 *
 * Nothing here invents a port: an empty list is a fact about the machine and is returned as one,
 * with the reason the richer enumeration is unavailable.
 */

import { execFile } from 'node:child_process';

export interface SerialPortEntry {
  /** `COM10` — what the connect call needs. */
  path: string;
  /** Device Manager's name, e.g. `NovAtel USB Virtual Serial Port (COM10)`. */
  friendlyName: string | null;
  manufacturer: string | null;
  /** PnP id; empty for a Bluetooth link, which is still a usable port. */
  pnpId: string | null;
}

export interface SerialPortList {
  /** True when the native binding loaded, i.e. a serial connect can actually open a port. */
  available: boolean;
  ports: SerialPortEntry[];
  /** Why the list is thin or empty — shown verbatim in the Add Device dialog. */
  reason: string | null;
}

interface SerialPortModule {
  SerialPort?: { list?: () => Promise<Array<Record<string, string | undefined>>> };
  default?: { SerialPort?: { list?: () => Promise<Array<Record<string, string | undefined>>> } };
}

/** Windows exposes the live port names here; the key's values are the `COM<n>` names. */
const SERIALCOMM_KEY = 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM';

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((done) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout) => {
      done(error ? '' : String(stdout));
    });
  });
}

/** Fallback for a machine without `serialport`: port names only. */
async function powershellPorts(): Promise<SerialPortEntry[]> {
  const script =
    "$ErrorActionPreference='SilentlyContinue';" +
    "$k='HKLM:\\HARDWARE\\DEVICEMAP\\SERIALCOMM';" +
    'if (Test-Path $k) { (Get-Item $k).Property | ForEach-Object { $n=$_; $v=(Get-ItemProperty $k).$n; "$v|$n" } }';
  const text = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 8000);
  const rows: SerialPortEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [path, device] = line.trim().split('|');
    if (!path || !/^COM\d+$/i.test(path)) continue;
    rows.push({
      path: path.toUpperCase(),
      friendlyName: device ? `${device} (${path.toUpperCase()})` : null,
      manufacturer: null,
      pnpId: null,
    });
  }
  return rows;
}

/** The list, cached for a moment: the dialog rescans on every open, the API is polled rarely. */
let cached: { at: number; value: SerialPortList } | null = null;
const CACHE_MS = 1500;

export async function listSerialPorts(force = false): Promise<SerialPortList> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  let value: SerialPortList;
  try {
    /* A dynamic import keeps the package optional: a dev checkout without it still runs. */
    const name = 'serialport';
    const loaded = (await import(name)) as SerialPortModule;
    const list = loaded.SerialPort?.list ?? loaded.default?.SerialPort?.list;
    if (!list) throw new Error('the serialport module exports no SerialPort.list()');
    const rows = await list();
    const ports: SerialPortEntry[] = rows
      .map((row) => ({
        path: String(row.path ?? ''),
        friendlyName: row.friendlyName ? String(row.friendlyName) : null,
        manufacturer: row.manufacturer ? String(row.manufacturer) : null,
        pnpId: row.pnpId ? String(row.pnpId) : null,
      }))
      .filter((row) => /^COM\d+$/i.test(row.path))
      .map((row) => ({ ...row, path: row.path.toUpperCase() }))
      .sort((left, right) => Number(left.path.slice(3)) - Number(right.path.slice(3)));
    value = {
      available: true,
      ports,
      reason: ports.length === 0
        ? 'No serial port is present. Connect the receiver\'s USB cable (or its RS-232 adapter) and scan again.'
        : null,
    };
  } catch (error) {
    const ports = await powershellPorts();
    const why = error instanceof Error ? error.message : String(error);
    value = {
      available: false,
      ports,
      reason:
        `The serialport binding is not installed in this build (${why}). Port names still list, ` +
        'but opening one needs the binding — reinstall the packaged app, or run `npm i serialport` ' +
        'next to packages/app.',
    };
  }

  cached = { at: Date.now(), value };
  return value;
}
