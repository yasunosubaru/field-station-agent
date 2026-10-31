// Pixel + structure diff between two UI screenshots. Zero dependencies: PNG is decoded and
// encoded here, zlib is built into Node. Run directly:
//
//   node 逆向/tools/ui-diff.ts --a ref.png --b ours.png --out diff.png
//   node 逆向/tools/ui-diff.ts --a ref.png --b ours.png --out diff.png --regions regions.json
//   node 逆向/tools/ui-diff.ts --a ref.png --b ours.png --layout
//
// Only 8-bit RGB (color type 2) and RGBA (color type 6), non-interlaced PNGs are decoded.
// Anything else fails with an explicit message rather than a wrong number.
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

type Image = {
  width: number;
  height: number;
  /** 3 (RGB) or 4 (RGBA); alpha is carried through but never compared. */
  channels: number;
  data: Uint8Array;
};

type Region = { name: string; x: number; y: number; w: number; h: number };

type Stats = {
  pixels: number;
  diffPixels: number;
  diffRatio: number;
  meanAbs: number;
  maxDiff: number;
  worst: { x: number; y: number } | null;
};

// ---------------------------------------------------------------------------------------------
// CRC32 (needed to write chunks; decoding does not verify CRCs)
// ---------------------------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------------------------
// PNG decode
// ---------------------------------------------------------------------------------------------
const COLOR_TYPE_NAMES: Record<number, string> = {
  0: 'grayscale',
  2: 'RGB',
  3: 'palette',
  4: 'grayscale+alpha',
  6: 'RGBA',
};

function pngUnsupported(file: string, why: string): Error {
  return new Error(`${file}: unsupported PNG — ${why}. ui-diff only decodes 8-bit RGB/RGBA, non-interlaced PNGs.`);
}

function decodePng(file: string): Image {
  const buf = readFileSync(file);
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error(`${file}: not a PNG (bad signature)`);
  }

  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let sawIhdr = false;
  const idat: Buffer[] = [];

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (off + 12 + len > buf.length) throw new Error(`${file}: truncated PNG chunk at byte ${off}`);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;

    if (type === 'IHDR') {
      if (len < 13) throw new Error(`${file}: IHDR chunk too short`);
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      sawIhdr = true;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!sawIhdr) throw new Error(`${file}: no IHDR chunk`);
  if (width <= 0 || height <= 0) throw new Error(`${file}: bad dimensions ${width}x${height}`);
  if (colorType !== 2 && colorType !== 6) {
    throw pngUnsupported(file, `color type ${colorType} (${COLOR_TYPE_NAMES[colorType] ?? 'unknown'})`);
  }
  if (bitDepth !== 8) throw pngUnsupported(file, `bit depth ${bitDepth}`);
  if (interlace !== 0) throw pngUnsupported(file, 'interlaced (Adam7)');
  if (idat.length === 0) throw new Error(`${file}: no IDAT chunk`);

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * height) {
    throw new Error(`${file}: image data too short (${raw.length} < ${(stride + 1) * height})`);
  }

  const out = new Uint8Array(width * height * channels);
  let prev = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const line = raw.subarray(rowStart + 1, rowStart + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);

    switch (filter) {
      case 0:
        cur.set(line);
        break;
      case 1:
        for (let i = 0; i < stride; i++) cur[i] = (line[i] + (i >= channels ? cur[i - channels] : 0)) & 0xff;
        break;
      case 2:
        for (let i = 0; i < stride; i++) cur[i] = (line[i] + prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const left = i >= channels ? cur[i - channels] : 0;
          cur[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= channels ? cur[i - channels] : 0;
          const b = prev[i];
          const c = i >= channels ? prev[i - channels] : 0;
          cur[i] = (line[i] + paeth(a, b, c)) & 0xff;
        }
        break;
      default:
        throw new Error(`${file}: unknown PNG filter type ${filter} on row ${y}`);
    }
    prev = cur;
  }

  return { width, height, channels, data: out };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// ---------------------------------------------------------------------------------------------
// PNG encode (RGB, filter 0) — used for the diff image only
// ---------------------------------------------------------------------------------------------
function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))];
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------
function scaleNearest(img: Image, width: number, height: number): Image {
  if (img.width === width && img.height === height) return img;
  const channels = img.channels;
  const out = new Uint8Array(width * height * channels);
  const xmap = new Uint32Array(width);
  const ymap = new Uint32Array(height);
  for (let x = 0; x < width; x++) xmap[x] = Math.min(img.width - 1, Math.floor(((x + 0.5) * img.width) / width));
  for (let y = 0; y < height; y++) ymap[y] = Math.min(img.height - 1, Math.floor(((y + 0.5) * img.height) / height));

  for (let y = 0; y < height; y++) {
    const srcRow = ymap[y] * img.width;
    let dst = y * width * channels;
    for (let x = 0; x < width; x++) {
      const src = (srcRow + xmap[x]) * channels;
      for (let c = 0; c < channels; c++) out[dst + c] = img.data[src + c];
      dst += channels;
    }
  }
  return { width, height, channels, data: out };
}

function flipHorizontal(img: Image): Image {
  const channels = img.channels;
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const src = (y * img.width + x) * channels;
      const dst = (y * img.width + (img.width - 1 - x)) * channels;
      for (let c = 0; c < channels; c++) out[dst + c] = img.data[src + c];
    }
  }
  return { ...img, data: out };
}

/** Scale region coordinates from one image box to another (used when regions arrive in ref pixels). */
function luma(r: number, g: number, b: number): number {
  return (2126 * r + 7152 * g + 722 * b) / 10000;
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------
function compare(a: Image, b: Image, region: Region, tolerance: number): Stats {
  const { width, height } = a;
  const ac = a.channels;
  const bc = b.channels;
  let diffPixels = 0;
  let sumAbs = 0;
  let maxDiff = 0;
  let worst: { x: number; y: number } | null = null;

  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(width, Math.floor(region.x + region.w));
  const y1 = Math.min(height, Math.floor(region.y + region.h));

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const ia = (y * width + x) * ac;
      const ib = (y * width + x) * bc;
      const dr = Math.abs(a.data[ia] - b.data[ib]);
      const dg = Math.abs(a.data[ia + 1] - b.data[ib + 1]);
      const db = Math.abs(a.data[ia + 2] - b.data[ib + 2]);
      const m = Math.max(dr, dg, db);
      sumAbs += dr + dg + db;
      if (m > maxDiff) {
        maxDiff = m;
        worst = { x, y };
      }
      if (m > tolerance) diffPixels++;
    }
  }

  const pixels = Math.max(0, (x1 - x0) * (y1 - y0));
  return {
    pixels,
    diffPixels,
    diffRatio: pixels ? diffPixels / pixels : 0,
    meanAbs: pixels ? sumAbs / (pixels * 3) : 0,
    maxDiff,
    worst,
  };
}

function renderDiff(a: Image, b: Image, tolerance: number): Uint8Array {
  const { width, height } = a;
  const ac = a.channels;
  const bc = b.channels;
  const out = new Uint8Array(width * height * 3);

  for (let i = 0, px = 0; px < width * height; px++, i += 3) {
    const ia = px * ac;
    const ib = px * bc;
    const dr = Math.abs(a.data[ia] - b.data[ib]);
    const dg = Math.abs(a.data[ia + 1] - b.data[ib + 1]);
    const db = Math.abs(a.data[ia + 2] - b.data[ib + 2]);
    if (Math.max(dr, dg, db) > tolerance) {
      // Difference: pure red. Underlying luma stays slightly visible so the layout can still be read.
      const l = luma(a.data[ia], a.data[ia + 1], a.data[ia + 2]) * 0.2;
      out[i] = 255;
      out[i + 1] = l;
      out[i + 2] = l;
    } else {
      // Match: dimmed grayscale.
      const l = luma(a.data[ia], a.data[ia + 1], a.data[ia + 2]) * 0.6;
      out[i] = l;
      out[i + 1] = l;
      out[i + 2] = l;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Structure fingerprint (--layout): binarize, then dark-pixel ratio per cell of a grid.
// Each image is gridded on its own box, so different resolutions remain comparable.
// ---------------------------------------------------------------------------------------------
function fingerprint(img: Image, grid: number, darkThreshold: number): number[][] {
  const cells: number[][] = Array.from({ length: grid }, () => new Array(grid).fill(0));
  const { width, height, channels, data } = img;

  for (let gy = 0; gy < grid; gy++) {
    const y0 = Math.floor((gy * height) / grid);
    const y1 = Math.floor(((gy + 1) * height) / grid);
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.floor((gx * width) / grid);
      const x1 = Math.floor(((gx + 1) * width) / grid);
      let dark = 0;
      let total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * channels;
          if (luma(data[i], data[i + 1], data[i + 2]) < darkThreshold) dark++;
          total++;
        }
      }
      cells[gy][gx] = total ? dark / total : 0;
    }
  }
  return cells;
}

function flatten(m: number[][]): number[] {
  return m.flat();
}

/**
 * 1-D dark-pixel profile along one axis, in `bins` equal bands of the normalized image box.
 * An 8x8 grid cannot see a horizontal mirror (the dark mass stays a dark mass); a 64-bin
 * column profile can. Normalized per axis, so different resolutions stay comparable.
 */
function profile(img: Image, axis: 'x' | 'y', bins: number, darkThreshold: number): number[] {
  const { width, height, channels, data } = img;
  const out = new Array(bins).fill(0);
  const counts = new Array(bins).fill(0);

  for (let y = 0; y < height; y++) {
    const band = axis === 'y' ? Math.min(bins - 1, Math.floor((y * bins) / height)) : -1;
    for (let x = 0; x < width; x++) {
      const b = axis === 'x' ? Math.min(bins - 1, Math.floor((x * bins) / width)) : band;
      const i = (y * width + x) * channels;
      if (luma(data[i], data[i + 1], data[i + 2]) < darkThreshold) out[b]++;
      counts[b]++;
    }
  }
  for (let i = 0; i < bins; i++) out[i] = counts[i] ? out[i] / counts[i] : 0;
  return out;
}

const SPARK = ' .:-=+*#%@';
function sparkline(values: number[]): string {
  return values
    .map((v) => SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.round(v * (SPARK.length - 1))))])
    .join('');
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 && nb === 0) return 1;
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Zero-mean normalized cross-correlation: ignores overall brightness, keeps contrast pattern. */
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

function matrixDelta(a: number[][], b: number[][]): { mean: number; max: number; maxAt: [number, number] } {
  let sum = 0;
  let max = -1;
  let at: [number, number] = [0, 0];
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < a[y].length; x++) {
      const d = Math.abs(a[y][x] - b[y][x]);
      sum += d;
      if (d > max) {
        max = d;
        at = [x, y];
      }
    }
  }
  return { mean: sum / (a.length * a[0].length), max, maxAt: at };
}

// ---------------------------------------------------------------------------------------------
// Markdown output helpers
// ---------------------------------------------------------------------------------------------
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
const fix = (v: number, d = 2) => v.toFixed(d);

function mdTable(head: string[], rows: string[][]): string {
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function mdMatrix(m: number[][]): string {
  const head = ['行\\列', ...m[0].map((_, x) => String(x))];
  const rows = m.map((row, y) => [String(y), ...row.map((v) => v.toFixed(2))]);
  return mdTable(head, rows);
}

const SHADES = ' .:-=+*#%@';
function asciiMatrix(m: number[][]): string[] {
  return m.map((row) =>
    row
      .map((v) => SHADES[Math.min(SHADES.length - 1, Math.max(0, Math.round(v * (SHADES.length - 1))))])
      .join(' '),
  );
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
type Options = {
  a: string;
  b: string;
  out: string;
  regions: string;
  layout: boolean;
  flip: '' | 'a' | 'b';
  tolerance: number;
  grid: number;
  dark: number;
  help: boolean;
};

function parseArgs(argv: string[]): Options {
  const opts: Options = { a: '', b: '', out: '', regions: '', layout: false, flip: '', tolerance: 0, grid: 8, dark: 128, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    const num = () => {
      const v = Number(next());
      if (!Number.isFinite(v)) throw new Error(`${arg} needs a number`);
      return v;
    };
    switch (arg) {
      case '--a': opts.a = next(); break;
      case '--b': opts.b = next(); break;
      case '--out': opts.out = next(); break;
      case '--regions': opts.regions = next(); break;
      case '--layout': opts.layout = true; break;
      case '--flip': {
        const v = next();
        if (v !== 'a' && v !== 'b') throw new Error(`--flip takes "a" or "b", got "${v}"`);
        opts.flip = v;
        break;
      }
      case '--tolerance': opts.tolerance = Math.max(0, num()); break;
      case '--grid': opts.grid = num(); break;
      case '--dark': opts.dark = num(); break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
        throw new Error(`unexpected argument ${arg}`);
    }
  }
  return opts;
}

function usage(): void {
  process.stdout.write(
    [
      '用法：',
      '  node tools/ui-diff.ts --a <ref.png> --b <ours.png> [--out diff.png] [选项]',
      '',
      '选项：',
      '  --a, --b      两张待比 PNG（8-bit RGB/RGBA，非隔行）。尺寸不同时把 B 用最近邻缩放到 A。',
      '  --out         差异图输出路径（差异像素标红，其余灰度）。省略则不写文件。',
      '  --regions     矩形分区，内联 JSON 或 JSON 文件路径。例：',
      '                  {"topbar":[0,0,2560,120],"rail":[0,120,53,1600],"content":[53,120,2507,1480]}',
      '                坐标按 A 的像素空间；也接受 {"name":{"x":0,"y":0,"w":100,"h":60}}。',
      '  --layout      只出结构指纹：二值化后 8×8 网格的深色像素比例 + 余弦/相关系数。',
      '  --grid N      指纹网格边长，默认 8。',
      '  --dark N      二值化阈值（亮度 < N 记为深色），默认 128。',
      '  --tolerance N 允许的单通道差（0-255），超过才算差异像素，默认 0。',
      '  --flip a|b    对比前把指定一张水平翻转（做对照实验用，不落盘）。',
      '  -h, --help    显示本帮助。',
      '',
    ].join('\n'),
  );
}

function parseRegions(spec: string): Region[] {
  const text = spec.trim().startsWith('{') || spec.trim().startsWith('[') ? spec : readFileSync(spec, 'utf8');
  const parsed = JSON.parse(text) as unknown;
  const out: Region[] = [];

  const add = (name: string, value: unknown): void => {
    if (Array.isArray(value) && value.length === 4 && value.every((v) => typeof v === 'number')) {
      out.push({ name, x: value[0], y: value[1], w: value[2], h: value[3] });
    } else if (value && typeof value === 'object') {
      const r = value as Record<string, unknown>;
      if (['x', 'y', 'w', 'h'].every((k) => typeof r[k] === 'number')) {
        out.push({ name, x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number });
      } else {
        throw new Error(`region "${name}": expected [x,y,w,h] or {x,y,w,h}`);
      }
    } else {
      throw new Error(`region "${name}": expected [x,y,w,h] or {x,y,w,h}`);
    }
  };

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const r = item as Record<string, unknown>;
      if (typeof r.name !== 'string') throw new Error('region list items need a "name"');
      add(r.name, r);
    }
  } else if (parsed && typeof parsed === 'object') {
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) add(name, value);
  } else {
    throw new Error('--regions must be a JSON object or array');
  }
  return out;
}

function clampRegion(r: Region, width: number, height: number): Region {
  const x = Math.max(0, Math.min(width, r.x));
  const y = Math.max(0, Math.min(height, r.y));
  return { name: r.name, x, y, w: Math.min(width - x, r.w), h: Math.min(height - y, r.h) };
}

function main(): void {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`ui-diff: ${(err as Error).message}\n`);
    process.exit(2);
  }

  if (opts.help || (!opts.a && !opts.b)) {
    usage();
    return;
  }
  if (!opts.a || !opts.b) {
    process.stderr.write('ui-diff: --a and --b are both required\n');
    process.exit(2);
  }

  let a = decodePng(opts.a);
  let b = decodePng(opts.b);
  const givenA = { w: a.width, h: a.height };
  const givenB = { w: b.width, h: b.height };

  if (opts.flip === 'a') a = flipHorizontal(a);
  if (opts.flip === 'b') b = flipHorizontal(b);

  const markdown: string[] = [];
  markdown.push(`## 输入`);
  markdown.push('');
  markdown.push(
    mdTable(
      ['图', '文件', '原尺寸', '参与比较尺寸'],
      [
        ['A（参照）', opts.a, `${givenA.w}×${givenA.h}`, `${a.width}×${a.height}${opts.flip === 'a' ? '（水平翻转）' : ''}`],
        [
          'B（实现）',
          opts.b,
          `${givenB.w}×${givenB.h}`,
          `${b.width}×${b.height}${b.width !== givenB.w || b.height !== givenB.h ? '（最近邻缩放）' : ''}${opts.flip === 'b' ? '（水平翻转）' : ''}`,
        ],
      ],
    ),
  );
  markdown.push('');
  if (b.width !== a.width || b.height !== a.height) {
    markdown.push(`> B 已从 ${givenB.w}×${givenB.h} 缩放（最近邻）到 A 的 ${a.width}×${a.height}；`);
    markdown.push(`> 缩放会平移/重复像素，边缘与文字处必然产生差异，总体数值偏高，跨分辨率比较只用于看量级。`);
    markdown.push('');
  }

  const scaled = b.width !== a.width || b.height !== a.height ? scaleNearest(b, a.width, a.height) : b;
  if (opts.out) {
    writeFileSync(opts.out, encodePng(a.width, a.height, renderDiff(a, scaled, opts.tolerance)));
  }

  // ---- pixel diff ----
  const wantsPixel = !opts.layout || opts.out || opts.regions;
  if (wantsPixel) {
    const whole: Region = { name: '全图', x: 0, y: 0, w: a.width, h: a.height };
    const overall = compare(a, scaled, whole, opts.tolerance);
    const identical = overall.diffPixels === 0 && overall.maxDiff === 0;

    markdown.push('## 像素差异（整体）');
    markdown.push('');
    markdown.push(
      mdTable(
        ['指标', '数值'],
        [
          ['比较尺寸', `${a.width}×${a.height}（${overall.pixels.toLocaleString('en-US')} 像素）`],
          ['差异像素占比', `${pct(overall.diffRatio)}（${overall.diffPixels.toLocaleString('en-US')} 像素）`],
          ['平均绝对差', `${overall.meanAbs.toFixed(3)} / 255（占满量程 ${pct(overall.meanAbs / 255)}）`],
          ['最大通道差', String(overall.maxDiff)],
          ['最差像素', overall.worst ? `(${overall.worst.x}, ${overall.worst.y})` : '—'],
          ['判定', identical ? '逐像素完全相同' : '存在差异'],
          ['容差', `单通道 > ${opts.tolerance} 才计为差异像素`],
        ],
      ),
    );
    markdown.push('');
    if (opts.out) markdown.push(`差异图：\`${opts.out}\`（差异=红，其余=灰度）`, '');

    // ---- regions ----
    if (opts.regions) {
      const regions = parseRegions(opts.regions);
      markdown.push('## 像素差异（分区）');
      markdown.push('');
      const rows: string[][] = [];
      for (const raw of regions) {
        const r = clampRegion(raw, a.width, a.height);
        if (r.w <= 0 || r.h <= 0) {
          rows.push([r.name, `${r.x},${r.y} ${r.w}×${r.h}`, '跳过（超出画布）', '—', '—', '—']);
          continue;
        }
        const s = compare(a, scaled, r, opts.tolerance);
        const coverage = (s.pixels / (a.width * a.height)) * 100;
        rows.push([
          r.name,
          `${r.x},${r.y} ${r.w}×${r.h}`,
          `${coverage.toFixed(1)}%`,
          `${pct(s.diffRatio)}`,
          s.meanAbs.toFixed(2),
          String(s.maxDiff),
        ]);
      }
      markdown.push(mdTable(['区域', 'x,y 宽×高', '占画布', '差异像素占比', '平均绝对差', '最大通道差'], rows));
      markdown.push('');
      markdown.push('> 区域坐标按 A 的像素空间。跨分辨率时 A 未缩放、B 被缩放，同一矩形在两张图里对应的 UI 元素可能错位半格。');
      markdown.push('');
    }
  }

  // ---- layout / structure ----
  if (opts.layout) {
    const grid = Math.max(2, Math.min(64, Math.floor(opts.grid) || 8));
    const fa = fingerprint(a, grid, opts.dark);
    const fb = fingerprint(scaled, grid, opts.dark);
    const va = flatten(fa);
    const vb = flatten(fb);
    const cos = cosine(va, vb);
    const rho = pearson(va, vb);
    const delta = matrixDelta(fa, fb);

    // 1-D profiles: the 8x8 grid is blind to a horizontal mirror, these are not.
    const bins = Math.max(32, grid * 8);
    const rowA = profile(a, 'y', bins, opts.dark);
    const rowB = profile(scaled, 'y', bins, opts.dark);
    const colA = profile(a, 'x', bins, opts.dark);
    const colB = profile(scaled, 'x', bins, opts.dark);
    const rowCos = cosine(rowA, rowB);
    const colCos = cosine(colA, colB);

    markdown.push(`## 结构指纹（${grid}×${grid} 深色像素比例，阈值 ${opts.dark}）`);
    markdown.push('');
    markdown.push('A（参照）：');
    markdown.push('');
    markdown.push(mdMatrix(fa));
    markdown.push('');
    markdown.push('B（实现）：');
    markdown.push('');
    markdown.push(mdMatrix(fb));
    markdown.push('');
    markdown.push('|A − B|：');
    markdown.push('');
    markdown.push(mdMatrix(fa.map((row, y) => row.map((v, x) => Math.abs(v - fb[y][x])))));
    markdown.push('');
    markdown.push(
      mdTable(
        ['结构指标', '数值', '含义'],
        [
          ['余弦相似度', fix(cos, 4), '两图深色分布的整体夹角；对整体暗/亮不敏感（同一套暗色主题天然偏高）'],
          ['相关系数 (Pearson)', fix(rho, 4), '扣除整体明暗后的形状相关；更适合隔着夜间滤镜比"结构像不像"'],
          ['行分布余弦', fix(rowCos, 4), `${bins} 档纵向深色投影的夹角：看出上下分区（标题栏/工具栏/内容/状态栏）是否对应`],
          ['列分布余弦', fix(colCos, 4), `${bins} 档横向深色投影的夹角：看左右结构（左轨/主区）是否对应，水平镜像会明显掉分`],
          ['格子平均差', fix(delta.mean, 4), '64 格 |A−B| 的均值（0=完全同构）'],
          ['最大格差', `${fix(delta.max, 4)} @ 行${delta.maxAt[1]} 列${delta.maxAt[0]}`, '差异最集中的一块'],
        ],
      ),
    );
    markdown.push('');
    markdown.push(`深色投影（${bins} 档，" "=全亮 "@"=全暗）：`);
    markdown.push('');
    markdown.push('```');
    markdown.push(`纵向 A ${sparkline(rowA)}`);
    markdown.push(`     B ${sparkline(rowB)}`);
    markdown.push(`横向 A ${sparkline(colA)}`);
    markdown.push(`     B ${sparkline(colB)}`);
    markdown.push('```');
    markdown.push('');
    markdown.push('```');
    markdown.push(`A${' '.repeat(Math.max(1, grid * 2 + 2 - 1))}B`);
    const linesA = asciiMatrix(fa);
    const linesB = asciiMatrix(fb);
    for (let y = 0; y < grid; y++) markdown.push(`${linesA[y]}   ${linesB[y]}`);
    markdown.push('（" "=浅  ".":"=-"  ... "@"=深；左右两图同格纵向对齐）');
    markdown.push('```');
    markdown.push('');
  }

  process.stdout.write(markdown.join('\n') + '\n');
}

// Exported so other scripts can reuse the decoder/fingerprint; running the file directly still
// works because main() only fires when this module is the entry point.
export { decodePng, encodePng, scaleNearest, flipHorizontal, compare, fingerprint, cosine, pearson };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`ui-diff: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
