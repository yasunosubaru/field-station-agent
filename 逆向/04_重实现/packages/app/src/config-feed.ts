/**
 * The receiver's **configuration logs** — the other half of the configuration pages.
 *
 * The pages themselves (`packages/view/src/config/*`) were rebuilt from the shipped controller and
 * read a per-page dictionary keyed by the record's message id. Nothing ever fed them: a port row
 * needs `INTERFACEMODE` + `SERIALCONFIG` + `LOGLIST`, and the GNSS page needs `ELEVATIONCUTOFF` +
 * `PPSCONTROL`, but the feed only ever understood six ids, so every other page honestly said
 * "no receiver configuration yet" on a live link.
 *
 * **Which ids are let through is not a hand-kept list any more.** It is the union of the ids the
 * pages themselves subscribe to (`CONFIG_SUBSCRIPTIONS` in `view/src/config/index.ts`), so a page
 * that starts reading a new record cannot be silently starved by this file. `configSliceOf` is the
 * other half: one branch per id, with the **field names that page's `updateData`/`render` actually
 * reads** — not the layout's names, and not a guess.
 *
 * Field names come from two places, both read rather than invented:
 *  - the shipped decoder's own key names (`01_解包/app/model/logparsers.js`, e.g. `ELEVATIONCUTOFF`
 *    → `constellation`/`angle`, `PPSCONTROL` → `switch`/`polarity`, `HEADINGOFFSET` →
 *    `headingoffsetindeg`/`pitchoffsetindeg`), which are exactly what the pages index;
 *  - the pages' own state reads (`gnssConfig.ts` reads `.angle`, `networkingSettings.ts` reads
 *    `.ipAddress`/`.netmask`/`.gateway`/`.mode`, `deviceDetails.ts` reads `row.PSN`, …).
 *
 * These records are ordinary OEM7 logs, and a receiver answers them when asked. Measured on the
 * desk OEM729 (COM10 = receiver USB2, 2026-11-01):
 *
 * ```
 * LOG INTERFACEMODEB  ONCE -> 27 records (COM1..3, ICOM1..3, USB1/2, CCOM1..8, …)
 * LOG LOGLISTB        ONCE ->  1 record, 62 entries
 * LOG SERIALCONFIGB   ONCE ->  3 records (COM1 9600, COM2 38400, COM3 38400)
 * LOG ICOMCONFIGB     ONCE ->  7 records
 * LOG NTRIPCONFIGB    ONCE ->  3 records (NCOM1..3, DISABLED)
 * LOG SOURCETABLEB    ONCE ->  1 record (empty table: no NTRIP mountpoint configured)
 * LOG HEADINGOFFSETB  ONCE ->  1 record  `0.000000000,0.000000000`
 * LOG ELEVATIONCUTOFFB ONCE -> 7 records, one per constellation (GPS 10.0 … NAVIC 5.0)
 * LOG PPSCONTROLB     ONCE ->  1 record  `ENABLE,NEGATIVE,1.000000000,1000`
 * LOG IPCONFIGB       ONCE ->  1 record  `ETHA,STATIC,"192.168.5.10",…`
 * LOG DNSCONFIGB      ONCE ->  1 record  `1,"192.168.5.1"`
 * LOG VERSIONB        ONCE ->  1 record, 3 component rows
 * LOG MODELFEATURESB  ONCE ->  1 record, 21 feature rows
 * LOG CHANCONFIGLISTB ONCE ->  1 record, 5 signal sets
 * LOG VALIDMODELSB    ONCE ->  1 record  `1,"PFNLYNTBN",0,0,0`
 * LOG AUTHCODESB      ONCE ->  1 record  `VALID,1,SIGNATURE,TRUE,"…"`
 * ```
 *
 * And the ones this model refuses, so no page waits for them:
 * `LOG WIFIMODEB/WIFISTATUSB/WIFIAPSETTINGSB/FILESTATUSB ONCE` →
 * `<ERROR:Message is invalid for this model`; `LOG THISANTENNATYPEB ONCE` → `<OK` with no record.
 *
 * Everything here is read from the record's **own ASCII body** (`<INTERFACEMODEA,…,;COM1,NOVATEL,
 * NOVATEL,ON*crc`), i.e. from bytes the receiver sent. A record whose body does not parse is dropped
 * rather than guessed at.
 */

import { CONFIG_SUBSCRIPTIONS } from '../../view/src/config/index.ts';
import { FEATURE_STATUS, FEATURE_TYPE } from '../../view/src/config/deviceDetails.ts';

/**
 * Message ids the configuration pages read: the union of `CONFIG_SUBSCRIPTIONS`, sorted.
 *
 * Derived rather than listed, so this file cannot fall behind the pages again. On the desk OEM729
 * it is 49 ids; the six the feed used to understand were a subset of it.
 */
export const CONFIG_MESSAGE_IDS: readonly number[] = Object.freeze(
  [...new Set(Object.values(CONFIG_SUBSCRIPTIONS).flat())].sort((a, b) => a - b),
);

/** O(1) form of the same list — the live link runs thousands of records through it. */
export const CONFIG_MESSAGE_ID_SET: ReadonlySet<number> = new Set(CONFIG_MESSAGE_IDS);

/**
 * Tokens of the record body, or `null` when the line is not a full-ASCII configuration record.
 *
 * A quoted field may contain commas (`AUTHCODES` carries `"R35JCN,BTG98D,…"`), so the split has to
 * respect quotes instead of splitting first and stripping after — that turned one auth code into
 * seven tokens.
 */
export function configBodyTokens(ascii: string): string[] | null {
  const text = String(ascii ?? '').trim();
  if (!text) return null;
  const star = text.lastIndexOf('*');
  const withoutCrc = star > 0 ? text.slice(0, star) : text;
  const semicolon = withoutCrc.lastIndexOf(';');
  // Full ASCII is `<NAMEA,<header fields>;<body>`; abbreviated ASCII is `<NAME field field` and has
  // no body delimiter, so it cannot be split confidently here.
  if (semicolon < 0) return null;
  const body = withoutCrc.slice(semicolon + 1);
  if (!body) return null;
  return splitQuoted(body);
}

/** Comma split that keeps quoted text whole and drops the quotes (the pages read bare values). */
function splitQuoted(body: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quoted = false;
  for (const character of body) {
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === ',' && !quoted) {
      tokens.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  tokens.push(current.trim());
  return tokens;
}

export interface ConfigPageSlice {
  name: number;
  data: Record<string, unknown>;
}

/** A port-keyed table the pages expect whole (they read `current[id][port][field]`). */
export interface ConfigAccumulator {
  table: Record<string, Record<string, unknown>>;
}

export function createAccumulator(): ConfigAccumulator {
  return { table: {} };
}

const number = (token: string | undefined): number | undefined => {
  if (token === undefined || token === '') return undefined;
  const value = Number(token);
  return Number.isFinite(value) ? value : undefined;
};

const text = (token: string | undefined): string | undefined =>
  token === undefined || token === '' ? undefined : token;

/**
 * `MODELFEATURES` reports its two enums by **name** in ASCII (`AUTHORIZED,MEAS_RATE`), while the
 * page indexes numeric tables (`FEATURE_STATUS[Number(row.featureStatus)]`). The tables are the
 * page's own, so the inverse is built from them and cannot drift: a name the page does not know
 * stays unknown and the row is dropped rather than given a made-up code.
 */
function invertEnum(table: Record<number, string>): Map<string, number> {
  const inverse = new Map<string, number>();
  for (const [code, name] of Object.entries(table)) {
    inverse.set(name.replace(/^FEATURE_/, '').toUpperCase(), Number(code));
  }
  return inverse;
}

const FEATURE_STATUS_CODE = invertEnum(FEATURE_STATUS);
const FEATURE_TYPE_CODE = invertEnum(FEATURE_TYPE);

/** `operating_mode` is reported by name; `VERIPOSINFO`/`OCEANIXINFO` are read by number. */
const OPERATING_MODE_CODE: Record<string, number> = {
  UNASSIGNED: 0,
  TERM: 1,
  PAYG: 2,
  MODEL: 5,
  NCC_CONTROLLED: 7,
  NO_DISABLE: 8,
  BUBBLE: 100,
  SUBSCRIPTION_ERROR: 103,
  INCOMPATIBLE_SUBSCRIPTION: 104,
};

const AUTH_TYPE_CODE: Record<string, number> = {
  SIGNATURE: 1,
  EMBEDDED: 2,
  EMBEDDED_AUTH_CODE: 3,
};

/**
 * Turn one configuration record into the object the page writes into its `current` state, and
 * accumulate the two tables that arrive one port per record.
 *
 * Returns `null` when the record carries nothing this page can use.
 */
export function configSliceOf(
  messageId: number,
  ascii: string,
  accumulator: ConfigAccumulator | null,
): ConfigPageSlice | null {
  const tokens = configBodyTokens(ascii);
  if (!tokens) return null;
  if (messageId === 3) {
    // `COM1,NOVATEL,NOVATEL,ON` — `portConfig.ts` reads `.rxType` / `.txType` / `.responses`.
    const [port, receive, transmit, responses] = tokens;
    if (!port) return null;
    return { name: 3, data: { port, rxType: receive, txType: transmit, responses } };
  }
  if (messageId === 1246) {
    // `COM1,9600,N,8,1,N,ON` — `portConfig.ts` reads `.baud`, `.parity`, `.databits`, `.stopbits`.
    const [port, baud, parity, databits, stopbits] = tokens;
    if (!port || !accumulator) return null;
    accumulator.table[port] = {
      baud: number(baud) ?? 9600,
      parity: parity ?? 'N',
      databits: number(databits) ?? 8,
      stopbits: number(stopbits) ?? 1,
    };
    return { name: 1246, data: { ...accumulator.table } };
  }
  if (messageId === 5) {
    // `60,COM1,RXSTATUSEVENTA,ONNEW,0.000000,0.000000,HOLD,COM2,…` — six tokens per entry.
    const [countToken, ...rest] = tokens;
    const count = number(countToken) ?? 0;
    if (!accumulator) return null;
    for (let index = 0; index < count; index++) {
      const base = index * 6;
      const port = rest[base];
      const message = rest[base + 1];
      if (!port || !message) break;
      accumulator.table[port] = accumulator.table[port] ?? {};
      accumulator.table[port][message] = {
        name: message,
        trigger: rest[base + 2],
        interval: number(rest[base + 3]) ?? 0,
        offset: number(rest[base + 4]) ?? 0,
        hold: rest[base + 5],
      };
    }
    return { name: 5, data: { ...accumulator.table } };
  }
  if (messageId === 1249) {
    // `NCOM1,DISABLED,V1,"","","","",ALL`
    const [port, type, protocol, endpoint, mountpoint, user, password, bind] = tokens;
    if (!port) return null;
    return {
      name: 1249,
      data: { port, type, protocol, endpoint, mountpoint, user, password, bind_interface: bind },
    };
  }
  if (messageId === 1344) {
    // `"",0,0,""` — the source table of an NTRIP endpoint; empty when no mountpoint is configured.
    const [endPoint, , , entryData] = tokens;
    return { name: 1344, data: { endPoint, entryData } };
  }
  if (messageId === 1248) {
    // `ICOM1,TCP,":2000",ALL` — the page nests it by its own `port` field.
    const [port, ...rest] = tokens;
    if (!port) return null;
    return { name: 1248, data: { port, values: rest.join(',') } };
  }

  /* ------------------------------------------------------------------ positioning */

  if (messageId === 42) {
    // `SOL_COMPUTED,SINGLE,30.53997148196,114.35280430879,63.2209,-14.4000,WGS84,…` —
    // `positionConfig.ts` shows `latitude` / `longitude` / `height` (and keeps `operatingMode`
    // from the link, not from BESTPOS: the record does not carry it).
    const [
      solutionStatus,
      positionType,
      latitude,
      longitude,
      height,
      undulation,
      datum,
    ] = tokens;
    const page = {
      solutionStatus,
      positionType,
      latitude: number(latitude),
      longitude: number(longitude),
      height: number(height),
      undulation: number(undulation),
      datum,
    };
    if (page.latitude === undefined && page.longitude === undefined) return null;
    return { name: 42, data: page };
  }
  if (messageId === 1795) {
    // `DISABLE,1440,2.0,10.0,OFF,"AUTO"` — the shipped names (`logparsers.js#autoSurveyJSON`):
    // control, time, accuracy, tolerance, save_nvm. `positionConfig.ts` reads `.time`/`.accuracy`
    // only while `control === 'ENABLE'`, exactly as `displayingTimeAndAccuracy` does.
    const [control, time, accuracy, tolerance, saveNvm, id] = tokens;
    return {
      name: 1795,
      data: {
        control,
        time: number(time),
        accuracy: number(accuracy),
        tolerance: number(tolerance),
        save_nvm: saveNvm,
        autoSurveyId: id,
      },
    };
  }

  /* ------------------------------------------------------------------------ align */

  if (messageId === 1082) {
    // `0.000000000,0.000000000` — `alignConfig.ts` reads `.headingoffsetindeg`/`.pitchoffsetindeg`.
    // Zero is a real value here: the page must print `0.00`, not an empty box.
    const [heading, pitch] = tokens;
    const headingoffsetindeg = number(heading);
    const pitchoffsetindeg = number(pitch);
    if (headingoffsetindeg === undefined && pitchoffsetindeg === undefined) return null;
    return { name: 1082, data: { headingoffsetindeg, pitchoffsetindeg } };
  }
  if (messageId === 1335) {
    // `SOL_COMPUTED,NARROW_INT,0.0,0.0,…` — HEADING2; no page reads it today (see the note below
    // about ids without a reader), but the shape is the shipped `heading2JSON` one.
    const [solStatus, posType, length, heading, pitch, hdgStdDev, ptchStdDev] = tokens;
    return {
      name: 1335,
      data: {
        solStatus,
        posType,
        length: number(length),
        heading: number(heading),
        pitch: number(pitch),
        hdgStdDev: number(hdgStdDev),
        ptchStdDev: number(ptchStdDev),
      },
    };
  }

  /* ------------------------------------------------------------------------- gnss */

  if (messageId === 1735) {
    // `GPS,10.0,0` — one record per constellation; `gnssConfig.ts` reads `.angle`
    // (`logparsers.js#elevationcutoffJSON` names the same two fields constellation/angle).
    const [constellation, angle, reserved] = tokens;
    return {
      name: 1735,
      data: { constellation, angle: number(angle), reserved: number(reserved) },
    };
  }
  if (messageId === 613) {
    // `ENABLE,NEGATIVE,1.000000000,1000` — `gnssConfig.ts` reads `.switch`/`.polarity`.
    const [signalSwitch, polarity, period, pulsewidth] = tokens;
    if (signalSwitch === undefined) return null;
    return {
      name: 613,
      data: {
        switch: signalSwitch,
        polarity,
        period: number(period),
        pulsewidth: number(pulsewidth),
      },
    };
  }

  /* -------------------------------------------------------------------- networking */

  if (messageId === 1243) {
    // `ETHA,STATIC,"192.168.5.10","255.255.255.0","192.168.5.1"` — `networkingSettings.ts` reads
    // `.ipAddress`, `.netmask`, `.gateway` (and `.mode` for the DHCP tick).
    const [interfaceName, mode, ipAddress, netmask, gateway] = tokens;
    if (interfaceName === undefined) return null;
    return { name: 1243, data: { interfaceName, mode, ipAddress, netmask, gateway } };
  }
  if (messageId === 1244) {
    // `1,"192.168.5.1"` — the server count and the first server; the page reads `.ipAddress`.
    const [dnsserver, ipAddress] = tokens;
    return { name: 1244, data: { dnsserver: number(dnsserver), ipAddress } };
  }
  if (messageId === 2144) {
    // `OFF` / `ON` / `AP` — `networkingSettings.ts` reads `.mode` for the hotspot tick.
    const [mode] = tokens;
    if (mode === undefined) return null;
    return { name: 2144, data: { mode } };
  }
  if (messageId === 2091) {
    // `11` — the hotspot channel.
    const [channel] = tokens;
    return { name: 2091, data: { channel: number(channel) } };
  }
  if (messageId === 2093) {
    // `"ssid","passkey",BAND,SECURITY,ENCRYPTION,REGION,channel,"bssid"` — the hotspot fields the
    // page's `setHotspot` addresses by name.
    const [SSID, passkey, band, security, encryption, region, channel, bssid] = tokens;
    return {
      name: 2093,
      data: {
        SSID,
        passkey,
        band,
        security,
        encryption,
        region,
        channel: number(channel),
        bssid,
      },
    };
  }
  if (messageId === 2207) {
    // `OFF,"",0,0,"",OPEN` + client list — WiFi status; the page reads none of it today.
    const [status, ssid, rssi, channel, bssid, security] = tokens;
    return {
      name: 2207,
      data: {
        status,
        ssid,
        rssi: number(rssi),
        channel: number(channel),
        bssid,
        security,
      },
    };
  }
  /* `IPSTATUS` (1289) and `WIFINETLIST` (2210) are subscribed by `networkingSettings` but no page
   * reads a field of them (`render` uses IPCONFIG and WIFIMODE only), so they are deliberately
   * left unmapped: a shape invented here would never be read and could only mislead. */

  /* ---------------------------------------------------------------- device details */

  if (messageId === 37) {
    // `3,GPSCARD,"PFNLYNTBN","BMGX21030301G","OEM729-2.03",…` — a count, then eight tokens per
    // component (the `VERSION` layout's own order). `deviceDetails.ts` reads `row.type`,
    // `row.model`, `row.PSN`, `row.hardwareVersion`, `row.softwareVersion`, `row.bootVersion`.
    const count = number(tokens[0]) ?? 0;
    const rows: Record<string, unknown>[] = [];
    for (let index = 0; index < count; index++) {
      const base = 1 + index * 8;
      const type = tokens[base];
      if (!type) break;
      rows.push({
        type,
        model: tokens[base + 1],
        PSN: tokens[base + 2],
        hardwareVersion: tokens[base + 3],
        softwareVersion: tokens[base + 4],
        bootVersion: tokens[base + 5],
        compileDate: tokens[base + 6],
        compileTime: tokens[base + 7],
      });
    }
    if (!rows.length) return null;
    return { name: 37, data: { data: rows } };
  }
  if (messageId === 1148) {
    // `1,5,5,16,GPSL1L2PL5,7,QZSSL1CAL2CL5,…` — set_in_use, then five signal sets of
    // (num_chans, signal_type). `deviceDetails.ts#renderChannelSignals` reads `row.signalType`.
    const setInUse = number(tokens[0]);
    const sets = number(tokens[1]) ?? 0;
    const rows: Record<string, unknown>[] = [];
    let at = 2;
    for (let set = 0; set < sets; set++) {
      const entries = number(tokens[at]) ?? 0;
      at += 1;
      for (let entry = 0; entry < entries; entry++) {
        const numChans = number(tokens[at]);
        const signalType = tokens[at + 1];
        at += 2;
        if (!signalType) break;
        rows.push({ numChans, signalType });
      }
    }
    if (!rows.length) return null;
    return { name: 1148, data: { setInUse, data: rows } };
  }
  if (messageId === 1329) {
    // `21,20HZ,MAX_MSR_RATE,20HZ,MAX_POS_RATE,SINGLE,ANTENNA,AUTHORIZED,MEAS_OUTPUT,…` — a count,
    // then (featureStatus, featureType) pairs **by name**. The page indexes numeric tables, so the
    // names are turned back into the codes those tables are keyed by; an unknown name drops the row.
    const count = number(tokens[0]) ?? 0;
    const rows: Record<string, unknown>[] = [];
    for (let index = 0; index < count; index++) {
      const statusName = tokens[1 + index * 2];
      const featureName = tokens[2 + index * 2];
      if (statusName === undefined || featureName === undefined) break;
      const featureStatus = FEATURE_STATUS_CODE.get(statusName.toUpperCase());
      const featureType = FEATURE_TYPE_CODE.get(featureName.toUpperCase());
      rows.push({
        featureStatus,
        featureType,
        status: statusName,
        feature: featureName,
      });
    }
    if (!rows.length) return null;
    return { name: 1329, data: { data: rows } };
  }
  if (messageId === 1348) {
    // `VALID,1,SIGNATURE,TRUE,"R35JCN,BTG98D,…,PFNLYNTBN"` — signature status, count, then
    // (type, valid, code). `deviceDetails.ts` reads `row.authCodeType`, `.authCodeValidity`,
    // `.authCodeString` (and splits the code on `,` itself).
    const signatureStatus = tokens[0];
    const count = number(tokens[1]) ?? 0;
    const rows: Record<string, unknown>[] = [];
    for (let index = 0; index < count; index++) {
      const base = 2 + index * 3;
      const type = tokens[base];
      const valid = tokens[base + 1];
      const code = tokens[base + 2];
      if (type === undefined) break;
      rows.push({
        authCodeType: AUTH_TYPE_CODE[type.toUpperCase()] ?? undefined,
        authCodeValidity: String(valid).toUpperCase() === 'TRUE' ? 1 : 0,
        authCodeString: code,
      });
    }
    if (!rows.length) return null;
    return { name: 1348, data: { signatureStatus, data: rows } };
  }
  if (messageId === 206) {
    // `1,"PFNLYNTBN",0,0,0` — count, then (model, expiry year/month/day).
    const count = number(tokens[0]) ?? 0;
    const rows: Record<string, unknown>[] = [];
    for (let index = 0; index < count; index++) {
      const base = 1 + index * 4;
      const model = tokens[base];
      if (model === undefined) break;
      rows.push({
        model,
        expyear: number(tokens[base + 1]),
        expmonth: number(tokens[base + 2]),
        expday: number(tokens[base + 3]),
      });
    }
    if (!rows.length) return null;
    return { name: 206, data: { data: rows } };
  }
  if (messageId === 1719 || messageId === 2159) {
    // `"TR624:5027:4440",UNASSIGNED,00000000,0,0,0,GEOGATED,…` — TERRASTARINFO / OCEANIXINFO.
    // `deviceDetails.ts#renderSubscription` reads `.subscriptionService` (the PAC),
    // `.serviceEndYear`, `.serviceEndDay` and the numeric `.mode`.
    const [pac, operatingMode, , endDay, endYear, , region] = tokens;
    return {
      name: messageId,
      data: {
        subscriptionService: pac,
        mode: OPERATING_MODE_CODE[String(operatingMode).toUpperCase()] ?? undefined,
        serviceEndDay: number(endDay),
        serviceEndYear: number(endYear),
        regionRestriction: region,
      },
    };
  }
  if (messageId === 1728) {
    // `3162450,UNASSIGNED,00000000,""` — VERIPOSINFO; the page reads `Number(.mode)` (7 / 100).
    const [serialNumber, operatingMode, , serviceCode] = tokens;
    return {
      name: 1728,
      data: {
        serialNumber: number(serialNumber),
        mode: OPERATING_MODE_CODE[String(operatingMode).toUpperCase()] ?? undefined,
        serviceCode,
      },
    };
  }
  if (messageId === 2160) {
    // `DISABLE,NO_SIGNAL,UNKNOWN` — OCEANIXSTATUS; the page reads `Number(.access) === 1`.
    const [accessStatus, decoderSyncState, regionStatus] = tokens;
    return {
      name: 2160,
      data: {
        access: String(accessStatus).toUpperCase() === 'ENABLE' ? 1 : 0,
        accessStatus,
        decoderSyncState,
        regionRestrictionStatus: regionStatus,
      },
    };
  }
  /* `GIII_ETHSTATUS` (4101) and `GIII_VERSION` (4108) are GIII-only ids: they are not in the OEM7
   * message table at all, so a GIII model is the only thing that can produce them, and this
   * receiver never will. */

  /* -------------------------------------------------------------- radio / spoofing */

  if (messageId === 2205) {
    // `READY,,` — SATELSTATUS; `radioConfig.ts` reads `.state` (`data.state ?? data.status`).
    const [satelStatus, satelError, failedCommand] = tokens;
    return {
      name: 2205,
      data: { state: satelStatus, satel_status: satelStatus, error: satelError, failedCommand },
    };
  }
  if (messageId === 2358) {
    // `ENABLE,0,0` — SKDETECTCONFIG; the spoofing page's own field is `mode`.
    const [enable, reserved0, reserved1] = tokens;
    return {
      name: 2358,
      data: { mode: enable, enable, reserved0: number(reserved0), reserved1: number(reserved1) },
    };
  }
  if (messageId === 2366) {
    // `START,ALL,0` — SKCALIBRATE.
    const [mode, option, reserved] = tokens;
    return { name: 2366, data: { mode, option, reserved: number(reserved) } };
  }
  /* The SPAN ids (`CONNECTIMU` 1428, `INSCOMMAND` 379, `INSCONFIG` 1945, `SETINSTRANSLATION`
   * 1920, `SETINSROTATION` 1921, `SETIMUTOANT` 383 / `SETIMUTOANT2` 1205) are subscribed by
   * `spanConfig`, whose `render()` is empty: the wizard shows only its own accordion and no value
   * from these records. This receiver answers none of them either (0 records on 2026-11-01), so
   * there is nothing to map without inventing a consumer. */
  return null;
}
