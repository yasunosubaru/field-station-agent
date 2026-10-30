/**
 * Filesystem boundaries for the web shell.
 *
 * The only writable thing this process keeps is memory; every file it reads comes from
 * `逆向/00_来源/samples/`. Capture names travel through the browser, so resolution is
 * deliberately paranoid: no absolute paths, no drive letters, no `..` segments, and the final
 * real path must still sit under the samples root.
 */

import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** `<repo>/逆向/04_重实现/packages/app` */
export const APP_DIR = resolve(here, '..');
/** `<repo>/逆向/04_重实现/packages` */
export const PACKAGES_DIR = resolve(APP_DIR, '..');
/** `<repo>/逆向/04_重实现` */
export const IMPL_DIR = resolve(PACKAGES_DIR, '..');
/** `<repo>` */
export const REPO_DIR = resolve(IMPL_DIR, '..', '..');
/** `<repo>/逆向/00_来源/samples` — the only readable tree. */
export const SAMPLES_DIR = resolve(REPO_DIR, '逆向', '00_来源', 'samples');
export const PROTOCOL_DATA_DIR = resolve(PACKAGES_DIR, 'protocol', 'data');
export const WEB_DIR = join(here, 'web');

export const CAPTURE_EXTENSIONS = ['.gps', '.bin'] as const;
const ALLOWED = new Set<string>(CAPTURE_EXTENSIONS);

export interface CaptureEntry {
  /** Relative to SAMPLES_DIR, always with forward slashes, e.g. `convert/clean-9600.gps`. */
  path: string;
  name: string;
  bytes: number;
}

export interface ResolvedCapture {
  absolutePath: string;
  relPath: string;
  name: string;
  bytes: number;
  mtimeMs: number;
}

function toPosix(value: string): string {
  return value.split(sep).join('/');
}

function insideSamples(absolutePath: string): boolean {
  const rel = relative(SAMPLES_DIR, absolutePath);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Reject anything that could escape the samples tree before touching the disk. `..` is refused
 * outright rather than normalised away, so `convert/../clean-9600.gps` is a 400 and not a lookup.
 */
export function assertSafeCaptureName(raw: unknown): string {
  if (typeof raw !== 'string') throw new HttpError(400, 'capture 必须是字符串');
  const name = raw.trim();
  if (!name) throw new HttpError(400, '缺少 capture 参数');
  if (name.length > 260) throw new HttpError(400, 'capture 过长');
  if (name.includes('\0')) throw new HttpError(400, 'capture 含非法字符');
  if (/^[a-zA-Z]:/.test(name) || isAbsolute(name)) throw new HttpError(400, 'capture 不允许绝对路径');
  const parts = name.split(/[\\/]+/);
  for (const part of parts) {
    if (part === '..') throw new HttpError(400, 'capture 不允许包含 ..');
    if (part === '' || part === '.') throw new HttpError(400, 'capture 路径不合法');
  }
  if (!ALLOWED.has(extname(name).toLowerCase())) {
    throw new HttpError(400, `只允许抓包文件（${[...ALLOWED].join(' / ')}）`);
  }
  return parts.join('/');
}

function describe(absolutePath: string): ResolvedCapture {
  const info = statSync(absolutePath);
  if (!info.isFile()) throw new HttpError(404, '抓包不是文件');
  return {
    absolutePath,
    relPath: toPosix(relative(SAMPLES_DIR, absolutePath)),
    name: basename(absolutePath),
    bytes: info.size,
    mtimeMs: info.mtimeMs,
  };
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1, out);
    else if (entry.isFile() && ALLOWED.has(extname(entry.name).toLowerCase())) out.push(full);
  }
}

/** Every capture under the samples tree, sorted by relative path. */
export function listCaptures(): CaptureEntry[] {
  const files: string[] = [];
  walk(SAMPLES_DIR, 0, files);
  return files
    .map((file) => {
      const info = statSync(file);
      return { path: toPosix(relative(SAMPLES_DIR, file)), name: basename(file), bytes: info.size };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * `clean-9600.gps` is the name the CLI and the golden directories use, but the file actually lives
 * in `samples/convert/`. Accept either the exact relative path or a bare file name (preferring
 * `convert/`), and fall back to a unique basename match in the tree.
 */
export function resolveCapture(raw: unknown): ResolvedCapture {
  const rel = assertSafeCaptureName(raw);
  const direct = resolve(SAMPLES_DIR, rel);
  if (insideSamples(direct)) {
    try {
      return describe(direct);
    } catch {
      /* fall through to the convenience lookups */
    }
  }

  const inConvert = resolve(SAMPLES_DIR, 'convert', rel);
  if (insideSamples(inConvert)) {
    try {
      return describe(inConvert);
    } catch {
      /* fall through */
    }
  }

  const wanted = basename(rel).toLowerCase();
  const matches: string[] = [];
  const files: string[] = [];
  walk(SAMPLES_DIR, 0, files);
  for (const file of files) if (basename(file).toLowerCase() === wanted) matches.push(file);
  if (matches.length === 1) return describe(matches[0]);
  if (matches.length > 1) {
    throw new HttpError(409, `抓包名不唯一，请使用相对路径：${matches.map((m) => toPosix(relative(SAMPLES_DIR, m))).join('、')}`);
  }
  throw new HttpError(404, `未找到抓包：${rel}`);
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
