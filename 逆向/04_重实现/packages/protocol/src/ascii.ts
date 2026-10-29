/**
 * ASCII command framing.
 *
 * Mirrors `01_解包/app/controller/frameCommand.js:186-243` (`frameasciirequest`).
 * The original takes a human-typed command ("log bestposb ontime 1") and rewrites it into the
 * full-ASCII wire form with a CRC:
 *
 *   \r\n#LOG,THISPORT_30,0,0,UNKNOWN,0,0,0,0,0;thisport,bestposb,ontime,1*<crc8>\r\n
 *
 * Note the two different "this port" tokens: `THISPORT_30` is header field 3 (the port the log is
 * generated on), while the lowercase `thisport` inserted after `LOG` is the command's own port
 * parameter. They are not interchangeable.
 */

import { novatelCrc32, crcHex } from './crc.ts';

export interface AsciiCommandOptions {
  /** Header field 3. The application hard-codes THISPORT_30. */
  headerPort?: string;
  /** Command port parameter inserted when the second token is not a port name. */
  implicitPort?: string;
}

/**
 * @param request   e.g. `log bestposb ontime 1`
 * @param isPortName predicate matching `NovatelPortNamesList` (1552 names, see data/portnames.json)
 */
export function buildAsciiCommand(
  request: string,
  isPortName: (upperCased: string) => boolean,
  options: AsciiCommandOptions = {},
): string {
  const headerPort = options.headerPort ?? 'THISPORT_30';
  const implicitPort = options.implicitPort ?? 'thisport';

  // Collapse runs of spaces (only 0x20, exactly like the original regex).
  const compact = request.replace(/ +(?= )/g, '');
  const fields = compact.replace(/ /g, ',').split(',');
  if (fields.length === 0) throw new Error('empty command');

  if (fields.length > 1) {
    const first = fields[0].toUpperCase();
    if (first === 'LOG' || first === 'UNLOG') fields[0] = first;
    if (fields[0] === 'LOG' || fields[0] === 'UNLOG') {
      if (!isPortName(fields[1].toUpperCase())) fields.splice(1, 0, implicitPort);
    }
  }

  const verb = fields[0];
  const rest = fields.slice(1).join(',');
  const withoutLead = `${verb},${headerPort},0,0,UNKNOWN,0,0,0,0,0;${rest}`;
  const crc = crcHex(novatelCrc32(latin1(withoutLead)));
  return `\r\n#${withoutLead}*${crc}\r\n`;
}

/** Build a port-name predicate from the extracted `NovatelPortNamesList`. */
export function makePortNamePredicate(names: readonly string[]): (upperCased: string) => boolean {
  const set = new Set(names.map((n) => n.toUpperCase()));
  return (upperCased: string) => set.has(upperCased);
}

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
