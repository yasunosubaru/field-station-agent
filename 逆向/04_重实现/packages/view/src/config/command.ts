import type { TabId } from '../types.ts';
import type {
  CommandResponse,
  ConfigCommandCatalog,
  ConfigDataMap,
  ConfigPageContext,
  ConfigTransport,
} from './types.ts';
import { commandParam } from './types.ts';
import {
  buildAsciiCommand,
  buildBinaryCommand,
  makePortNamePredicate,
  type CommandParam,
} from '../../../protocol/src/index.ts';

export function buildConfigBinary(
  catalog: ConfigCommandCatalog,
  commandName: string,
  params: ConfigDataMap,
): Uint8Array | undefined {
  const key = Object.keys(catalog).find((candidate) => candidate.toLowerCase() === commandName.toLowerCase());
  if (!key) return undefined;
  const entry = catalog[key];
  const commandParams: CommandParam[] = [];
  for (const row of params) {
    for (const [field, spec] of Object.entries(row)) {
      const [raw, type, length] = spec;
      let value = raw;
      if (type === 'enum' && typeof value === 'string') {
        const table = entry.enums[field] ?? {};
        value = table[value] ?? table[value.toUpperCase()] ?? value;
      }
      commandParams.push(commandParam(value, type, length ?? 0));
    }
  }
  return buildBinaryCommand({ messageId: entry.messageId, params: commandParams });
}

export function createContextTransport(context: ConfigPageContext): ConfigTransport {
  return {
    sendBinary(tab, bytes) {
      context.sendBinary?.(tab, bytes);
    },
    sendRaw(tab, text) {
      context.sendRaw?.(tab, text);
    },
    sendAsciiFrame(tab, request) {
      context.sendAsciiFrame?.(tab, request);
    },
  };
}

