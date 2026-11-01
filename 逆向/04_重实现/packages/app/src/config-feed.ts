/**
 * The receiver's **configuration logs** — the other half of the configuration pages.
 *
 * The pages themselves (`packages/view/src/config/*`) were rebuilt from the shipped controller and
 * read a per-port dictionary: `INTERFACEMODE` under message 3, `LOGLIST` under 5,
 * `SERIALCONFIG` under 1246, `ICOMCONFIG` under 1248, `NTRIPCONFIG` under 1249 and `SOURCETABLE`
 * under 1344. Nothing ever fed them: a port row needs `INTERFACEMODE` + `SERIALCONFIG` + `LOGLIST`
 * and the page honestly said "No receiver configuration yet" even on a live link.
 *
 * These records are ordinary OEM7 logs, and a receiver answers them when asked:
 * measured on the desk OEM729 (COM10 = receiver USB2, 2026-11-01) —
 *
 * ```
 * LOG INTERFACEMODEB ONCE   -> 27 records (COM1..3, ICOM1..3, USB1/2, ...)
 * LOG LOGLISTB      ONCE   ->  1 record, 60 entries
 * LOG SERIALCONFIGB ONCE   ->  3 records (COM1 9600, COM2 38400, COM3 38400)
 * LOG ICOMCONFIGB   ONCE   ->  7 records
 * LOG NTRIPCONFIGB  ONCE   ->  3 records (NCOM1..3, DISABLED)
 * LOG SOURCETABLEB  ONCE   ->  1 record (empty table: no NTRIP mountpoint configured)
 * ```
 *
 * Everything here is read from the record's **own ASCII body** (`<INTERFACEMODEA,…,;COM1,NOVATEL,
 * NOVATEL,ON*crc`), i.e. from bytes the receiver sent. A record whose body does not parse is dropped
 * rather than guessed at.
 */

/** Message ids the configuration pages read (`PORT_MSG` in `view/src/config/portConfig.ts`). */
export const CONFIG_MESSAGE_IDS = [3, 5, 1246, 1248, 1249, 1344] as const;

/** Tokens of the record body, or `null` when the line is not a full-ASCII configuration record. */
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
  return body
    .split(',')
    .map((token) => token.trim())
    .map((token) => (/^".*"$/.test(token) ? token.slice(1, -1) : token));
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
    // `ICOM1,IP,192.168.5.1,…` — the page nests it by its own `port` field.
    const [port, ...rest] = tokens;
    if (!port) return null;
    return { name: 1248, data: { port, values: rest.join(',') } };
  }
  return null;
}
