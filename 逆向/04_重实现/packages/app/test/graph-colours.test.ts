/**
 * Graph · series colours — the two palettes and the switch between them.
 *
 * The original assigns each column a hue with `stringToColor(name, index, theme)`
 * (`index-B86bHcCD.js @568030`): FNV-1a over an augmented name → four seeded hashes → a combined
 * 32-bit value → hue from an 11-stop wheel ± 8° and saturation/lightness from two slices of that
 * value. `graph.js` keeps that algorithm, but only behind 图例 → **Original colours** (`?colors=original`),
 * because spreading 74 `C/No` series over fluorescent greens makes neighbours indistinguishable.
 *
 * The expected values below are **not** read back from our own port: they were taken from the shipped
 * bundle itself (a probe page imported the original module and called its `stringToColor`), so a
 * mistaken transcription fails here instead of quietly painting the wrong colour.
 *
 *   node --test --test-force-exit "packages/app/test/*.test.ts"
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COLOUR_MODES,
  MSL_HEIGHT_COLOUR,
  ORIGINAL_AUGMENT,
  ORIGINAL_BASE_HUES,
  augmentString,
  colourModeFromSearch,
  combineHashes,
  hslToHex,
  mixHash,
  originalDefaultColour,
  originalInputString,
  originalSeriesColor,
  positionWeight,
  seriesColour,
  seriesColor,
} from '../src/web/panels/graph.js';

/* ---------------- the primitives ---------------- */

test('FNV-1a + mixer：与原版 hash$3 的 32 位无符号结果一致', () => {
  assert.equal(mixHash('', 0), 2872998923);
  assert.equal(mixHash('a', 0), 444641715);
  assert.equal(mixHash('a', 0), mixHash('a', 0), '确定性');
  assert.notEqual(mixHash('a', 0), mixHash('a', 1), 'seed 参与');
  for (const value of [mixHash(''), mixHash('Height'), mixHash('§Ω∆Φ', 3)]) {
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, `${value} 必须是 uint32`);
  }
});

test('augmentString / createInputString：名字对半切开塞装饰串，再拼 index 与长度', () => {
  assert.equal(ORIGINAL_AUGMENT, '§Ω∆Φ☀★☾✦¿¡¶†αβγδ');
  // 偶数长度：从中间切开
  assert.equal(augmentString('abcd'), `ab${ORIGINAL_AUGMENT}cd`);
  // 奇数长度：前半段少一个字符（floor）
  assert.equal(augmentString('abc'), `a${ORIGINAL_AUGMENT}bc`);
  assert.equal(augmentString('ab'), `a${ORIGINAL_AUGMENT}b`);
  assert.equal(augmentString(''), ORIGINAL_AUGMENT);

  // `${augmented}_${index}_${index*7919}_${len*6577}`
  assert.equal(originalInputString('ab', 2), `a${ORIGINAL_AUGMENT}b_2_15838_13154`);
});

test('positionWeight / combineHashes：位置权重与 index、长度偏移都是原式的', () => {
  assert.equal(positionWeight(''), 0);
  assert.equal(positionWeight('AB'), 65 * 1 + 66 * 2);
  assert.equal(positionWeight('abc'), 97 + 98 * 2 + 99 * 3);

  const hashes = [1, 2, 3, 4];
  // 1*11 + 2*7 + 3*5 + 4*3 = 11+14+15+12 = 52，再加权重与两个偏移
  assert.equal(combineHashes(hashes, 0, 0, 0), 52);
  const withIndex = combineHashes(hashes, 10, 1, 2);
  // indexOffset = 1*97 + 1*1*13 = 110，×50；lengthOffset = 2*2*41 + 2*53 = 164+106 = 270
  assert.equal(withIndex, 5832);
  assert.equal(withIndex, 52 + 10 + 110 * 50 + 270);
});

test('hslToHex：HSL → #rrggbb，色相取模、通道夹在 0…255', () => {
  assert.equal(hslToHex(0, 100, 50), '#ff0000');
  assert.equal(hslToHex(120, 100, 50), '#00ff00');
  assert.equal(hslToHex(240, 100, 50), '#0000ff');
  assert.equal(hslToHex(360, 100, 50), '#ff0000', '360° 等于 0°');
  assert.equal(hslToHex(0, 0, 0), '#000000');
  assert.equal(hslToHex(0, 0, 100), '#ffffff');
  assert.match(hslToHex(200, 63, 47), /^#[0-9a-f]{6}$/);
});

/* ---------------- the whole algorithm, against the shipped bundle ---------------- */

test('stringToColor：7 个列名 × 6 个索引全部与原版包逐字节一致', () => {
  // 期望值取自原版 bundle 的 stringToColor(name, index, 'light')，不是本仓库的复算
  const expected = {
    height: ['#db271a', '#27ec52', '#1d1ddd', '#e94416', '#19d253', '#ef491f'],
    cn0_gps_l1: ['#d72619', '#2be96a', '#331dd7', '#e56115', '#1edc6a', '#d83a13'],
    beidou_b1i_d2_1: ['#e91632', '#1dd76e', '#1d33d7', '#ec3713', '#18cd45', '#e94416'],
    signals_gps_l2_py: ['#e02929', '#14d250', '#240dd9', '#ed5821', '#11ee44', '#f16813'],
    'longitude sd': ['#e5432a', '#21e448', '#161de3', '#d12e15', '#10d566', '#ef5715'],
    'position type': ['#e41b21', '#1bee62', '#1d36d7', '#ef6115', '#21e472', '#e44a2f'],
    'gnss signal strength': ['#e41f11', '#20ee50', '#1d27e2', '#dd601d', '#1ef17d', '#cf3f17'],
  };
  const indices = [0, 1, 2, 7, 12, 40];
  for (const [name, colours] of Object.entries(expected)) {
    indices.forEach((index, at) => {
      assert.equal(originalSeriesColor(name, index, 'light'), colours[at], `${name} @${index}`);
    });
  }
});

test('computeDefaultColour：Height 被钉成 MSL 红，其余走 hash；大小写不影响', () => {
  assert.equal(MSL_HEIGHT_COLOUR, '#FF0000');
  assert.equal(originalDefaultColour('Height', 0), '#FF0000');
  assert.equal(originalDefaultColour('HEIGHT', 3), '#FF0000');
  assert.equal(originalDefaultColour('height above msl', 0), originalSeriesColor('height above msl', 0));
  // 原版先把列名小写再 hash
  assert.equal(originalDefaultColour('Signals_GPS_L2_PY', 1), originalSeriesColor('signals_gps_l2_py', 1));
  assert.equal(originalDefaultColour('Signals_GPS_L2_PY', 1), '#14d250');
});

test('两套配色是同一个 11 色锚点轮，dark 主题把亮度抬上去', () => {
  assert.equal(ORIGINAL_BASE_HUES.length, 11);
  assert.deepEqual(COLOUR_MODES, ['readable', 'original']);
  const light = originalSeriesColor('cn0_gps_l2', 2, 'light');
  const dark = originalSeriesColor('cn0_gps_l2', 2, 'dark');
  assert.notEqual(light, dark, '主题参与明度');
  // 都不是 readable 轮盘里的颜色
  for (let index = 0; index < 10; index += 1) {
    assert.notEqual(originalSeriesColor('x', index, 'light'), seriesColor(index));
  }
});

/* ---------------- the switch ---------------- */

test('?colors=original 打开原版配色，其余一律回到默认可读配色', () => {
  assert.equal(colourModeFromSearch('?colors=original'), 'original');
  assert.equal(colourModeFromSearch('colors=original'), 'original');
  assert.equal(colourModeFromSearch('?a=1&colors=ORIGINAL'), 'original');
  assert.equal(colourModeFromSearch('?colors=%20original%20'), 'original');
  assert.equal(colourModeFromSearch(''), 'readable');
  assert.equal(colourModeFromSearch('?colors=readable'), 'readable');
  assert.equal(colourModeFromSearch('?colors=rainbow'), 'readable');
  assert.equal(colourModeFromSearch('?colours=original'), 'readable', '拼错就回默认，不猜');
  assert.equal(colourModeFromSearch(null), 'readable');
});

test('seriesColour 按模式分派，readable 仍然是 10 色轮换', () => {
  assert.equal(seriesColour('readable', 'cn0_gps_l1', 0), seriesColor(0));
  assert.equal(seriesColour('readable', 'cn0_gps_l1', 3), '#e09b00');
  assert.equal(seriesColour('original', 'cn0_gps_l1', 0), '#d72619');
  assert.equal(seriesColour('original', 'Height', 5), MSL_HEIGHT_COLOUR);
  // 未知模式不抛错，按默认可读配色
  assert.equal(seriesColour('nonsense', 'cn0_gps_l1', 2), seriesColor(2));
});
