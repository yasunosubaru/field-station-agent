/**
 * Shared test helpers.
 *
 * The tests read the **real** unpacked fragments out of `01_解包/app/view` instead of
 * hand-written stubs, so an assertion like "`#main-panel-tabs-3 #positionStatuslatitude`
 * resolves" is checked against the shipped markup, not against a fixture we invented.
 */

import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FakeClock } from '../src/clock.ts';
import type { FragmentLoader, UserStoreData } from '../src/types.ts';
import { MemoryStorage, UserStore } from '../src/userStore.ts';
import { decodeMessage, decodeRepeated, type RichField, type RichSpec, type RepeatLayout } from '../../protocol/src/decode.ts';
import { deriveStatusFields } from '../../protocol/src/status-fields.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from `packages/view/test` until the `01_解包` evidence tree is found. */
export function evidenceRoot(): string {
  let directory = resolve(here, '../../..');
  for (let depth = 0; depth < 6; depth++) {
    const candidate = join(directory, '01_解包', 'app', 'view');
    if (existsSync(candidate)) return join(directory, '01_解包', 'app');
    directory = resolve(directory, '..');
  }
  throw new Error('01_解包/app not found above ' + here);
}

export const APP_ROOT = evidenceRoot();
export const VIEW_ROOT = join(APP_ROOT, 'view');
const MESSAGE_SPECS = JSON.parse(
  readFileSync(join(here, '..', '..', 'protocol', 'data', 'message-specs.json'), 'utf8'),
) as Record<string, RichSpec>;
const REPEAT_LAYOUTS = JSON.parse(
  readFileSync(join(here, '..', '..', 'protocol', 'data', 'repeat-layouts.json'), 'utf8'),
) as Record<string, RepeatLayout>;

/** Read any file of the unpacked app, e.g. `evidence('view/js/genericView.js')`. */
export function evidence(...parts: string[]): string {
  return readFileSync(join(APP_ROOT, ...parts), 'utf8');
}

export function htmlFragment(component: string, file = `${component}.html`): string {
  return readFileSync(join(VIEW_ROOT, component, file), 'utf8');
}

/** The shipped English dictionary (`Language.EN`) used by every default 2.11.0 session. */
export function englishDictionary(): Record<string, string> {
  const sandbox: {
    Language: Record<string, Record<string, string>>;
    jsIn: { addDict(): void };
  } = { Language: {}, jsIn: { addDict() {} } };
  runInNewContext(evidence('view', 'languageSupport', 'en.js'), sandbox, { timeout: 1000 });
  return sandbox.Language.EN;
}

/** The real fragment loader: `./../<name>/<name>.html` relative to `view/html`. */
export function realFragmentLoader(root = VIEW_ROOT): FragmentLoader {
  return {
    load(path: string): string {
      const relative = path.replace(/^\.\//, '').replace(/^\.\.\//, '');
      const file = join(root, relative);
      if (!existsSync(file)) throw new Error(`fragment not found: ${path}`);
      return readFileSync(file, 'utf8');
    },
  };
}

export function newClock(start = 0): FakeClock {
  return new FakeClock(start);
}

export function newStore(seed?: Partial<UserStoreData>): UserStore {
  return new UserStore(new MemoryStorage(), seed);
}

export { MemoryStorage };

/**
 * Encode a payload through the checked-in field table, then decode it using the production
 * decoder. Tests use this instead of hand-authoring the post-parse object.
 */
export function decodedFixture(
  messageId: number,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const spec = MESSAGE_SPECS[String(messageId)];
  if (!spec) throw new Error(`no message spec for ${messageId}`);
  const size = Math.max(
    1,
    ...Object.values(spec.fields)
      .filter((field) => field.offset >= 0)
      .map((field) => field.offset + widthOf(field)),
  );
  const bytes = new Uint8Array(Math.max(128, size));
  const view = new DataView(bytes.buffer);
  for (const [name, value] of Object.entries(values)) {
    const field = spec.fields[name];
    if (!field || field.offset < 0) continue;
    writeField(view, field, field.offset, value);
  }
  return decodeMessage(bytes, spec);
}

export function decodedRepeatedFixture(
  messageId: number,
  header: Record<string, unknown>,
  blocks: Array<Record<string, unknown>>,
): { header: Record<string, unknown>; blocks: Array<Record<string, unknown>> } {
  const spec = MESSAGE_SPECS[String(messageId)];
  const layout = REPEAT_LAYOUTS[String(messageId)];
  if (!spec || !layout) throw new Error(`no repeated spec for ${messageId}`);
  const bytes = new Uint8Array(layout.blockStart + blocks.length * layout.blockSize + 32);
  const view = new DataView(bytes.buffer);
  for (const [name, value] of Object.entries(header)) {
    const field = spec.fields[name];
    if (field && field.offset >= 0) writeField(view, field, field.offset, value);
  }
  blocks.forEach((block, blockIndex) => {
    for (const [name, value] of Object.entries(block)) {
      const field = layout.fields[name];
      if (field) writeField(view, field, layout.blockStart + blockIndex * layout.blockSize + field.offset, value);
    }
  });
  return decodeRepeated(bytes, spec, layout);
}

/**
 * Decode repeated bytes and apply the production logparsers-equivalent
 * derivation. This mirrors ReceiverSession.fields, including numeric row
 * slots (`0`, `1`, …), rather than returning only the generic header/blocks.
 */
export function decodedStatusRepeatedFixture(
  messageId: number,
  header: Record<string, unknown>,
  blocks: Array<Record<string, unknown>>,
  generation: 'OEM6' | 'OEM7' | 'OEMSTAR' | 'SMART2' | 'GIII' = 'OEM7',
  frameIdleTimeRaw?: number,
) {
  const spec = MESSAGE_SPECS[String(messageId)];
  const layout = REPEAT_LAYOUTS[String(messageId)];
  if (!spec || !layout) throw new Error(`no repeated spec for ${messageId}`);
  const bytes = new Uint8Array(layout.blockStart + blocks.length * layout.blockSize + 32);
  const view = new DataView(bytes.buffer);
  for (const [name, value] of Object.entries(header)) {
    const field = spec.fields[name];
    if (field && field.offset >= 0) writeField(view, field, field.offset, value);
  }
  blocks.forEach((block, blockIndex) => {
    for (const [name, value] of Object.entries(block)) {
      const field = layout.fields[name];
      if (field) {
        writeField(
          view,
          field,
          layout.blockStart + blockIndex * layout.blockSize + field.offset,
          value,
        );
      }
    }
  });
  const decoded = decodeRepeated(bytes, spec, layout);
  const derived = deriveStatusFields(
    messageId,
    bytes,
    decoded.header,
    decoded.blocks,
    generation,
    frameIdleTimeRaw,
  );
  return { ...derived, truncated: decoded.truncated };
}

function widthOf(field: RichField): number {
  const type = String(field.type);
  if (type === 'DOUBLE' || type === 'ULONG64') return 8;
  if (type === 'FLOAT' || type === 'UINT_32' || type === 'ULONG32' || type === 'INT_32' || type === 'ENUM') return 4;
  if (type === 'UINT_16' || type === 'ULONG16' || type === 'SHORT') return 2;
  if (type === 'UCHAR' || type === 'HEX') return 1;
  if (type.startsWith('STRING_')) return Number(type.split('_')[1]) || 4;
  return 4;
}

function writeField(view: DataView, field: RichField, offset: number, input: unknown): void {
  const type = String(field.type);
  let value = input;
  if (field.enum) {
    if (typeof value === 'string') value = field.enum[value] ?? value;
  }
  if (type === 'DOUBLE') return view.setFloat64(offset, Number(value), true);
  if (type === 'FLOAT') return view.setFloat32(offset, Number(value), true);
  if (type === 'ENUM' || type === 'UINT_32' || type === 'ULONG32') return view.setUint32(offset, Number(value), true);
  if (type === 'INT_32') return view.setInt32(offset, Number(value), true);
  if (type === 'UINT_16' || type === 'ULONG16' || type === 'SHORT') return view.setUint16(offset, Number(value), true);
  if (type === 'UCHAR' || type === 'HEX') return view.setUint8(offset, Number(value));
  if (type === 'ULONG64') return view.setBigUint64(offset, BigInt(String(value)), true);
  if (type.startsWith('STRING_')) {
    const width = widthOf(field);
    const text = String(value);
    for (let index = 0; index < width; index += 1) {
      view.setUint8(offset + index, index < text.length ? text.charCodeAt(index) : 0);
    }
  }
  if (type === 'ustring' || type === 'ustringvariable') {
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
    view.setUint8(offset + text.length, 0);
  }
}
