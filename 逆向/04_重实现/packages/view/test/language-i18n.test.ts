/**
 * 中英双语切换（唯一需要的两门语言）。
 *
 * The dictionaries are generated from the shipped `view/languageSupport/{en,cn}.js`, so the
 * assertions below are about real keys (`LATITUDE`, `LONGITUDE`, `HELP`, …) rather than fixtures.
 * Acceptance: R31–R33 of `03_分析/01_Manage主界面与视图层.md §8`, with D7 (the unreachable `cn`
 * file) behind an explicit switch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument } from '../src/minidom.ts';
import { createLanguage, BUILTIN_ALIASES, BUILTIN_DICTIONARIES } from '../src/language.ts';

test('both built-in dictionaries are generated from the shipped files', () => {
  assert.ok(Object.keys(BUILTIN_DICTIONARIES.en).length > 1500, 'en dictionary');
  assert.ok(Object.keys(BUILTIN_DICTIONARIES.cn).length > 1500, 'cn dictionary');
  assert.equal(BUILTIN_DICTIONARIES.en.LATITUDE, 'Latitude');
  assert.equal(BUILTIN_DICTIONARIES.cn.LATITUDE, '纬度');
  assert.equal(BUILTIN_DICTIONARIES.cn.LONGITUDE, '经度');
});

test('English is the default and `__()` falls back to the key', () => {
  const language = createLanguage();
  assert.equal(language.currentLanguage(), 'en');
  assert.equal(language.translate('LATITUDE'), 'Latitude');
  assert.equal(language.translate('NOT_A_REAL_KEY'), 'NOT_A_REAL_KEY');
});

test('R33 + D7: zh-CN resolves to cn (the shipped matcher fell back to en)', () => {
  for (const id of ['zh', 'zh-CN', 'zh-Hans', 'CN', 'chinese']) {
    assert.equal(createLanguage().resolveLanguageId(id), 'cn', `${id} → cn`);
  }
  assert.equal(createLanguage().resolveLanguageId('en-US'), 'en');
  assert.equal(createLanguage().resolveLanguageId('xx-YY'), 'en', 'unknown language falls back to en');
  assert.equal(createLanguage({ languageAliases: false }).resolveLanguageId('zh-CN'), 'en',
    'with the shipped behaviour the Chinese file is unreachable');
});

test('switching en → cn → en changes what the markers render, with no stale text', () => {
  const doc = createDocument();
  const holder = doc.createElement('div');
  holder.innerHTML =
    '<span data-lang-latitude></span><span data-lang-longitude></span><span data-lang-help></span>';
  doc.body.appendChild(holder);
  const language = createLanguage();

  language.applyMarkers(doc as unknown as Element);
  assert.deepEqual(
    [...holder.children].map((node) => node.textContent),
    ['Latitude', 'Longitude', 'Help'],
  );

  language.applyUserLanguagePreference('zh-CN');
  language.applyMarkers(doc as unknown as Element);
  assert.equal(language.currentLanguage(), 'cn');
  assert.deepEqual(
    [...holder.children].map((node) => node.textContent),
    ['纬度', '经度', '帮助'],
  );

  language.applyUserLanguagePreference('en');
  language.applyMarkers(doc as unknown as Element);
  assert.equal(language.currentLanguage(), 'en');
  assert.deepEqual(
    [...holder.children].map((node) => node.textContent),
    ['Latitude', 'Longitude', 'Help'],
  );
});

test('the accumulation defect is preserved when replaceDictionary is turned off', () => {
  const language = createLanguage({ replaceDictionary: false });
  language.applyUserLanguagePreference('cn');
  language.applyUserLanguagePreference('en');
  // `addDict` semantics: cn values loaded first stay authoritative for keys en also defines.
  assert.equal(language.translate('LATITUDE'), 'Latitude', 'en overwrites the shared key');
  assert.ok(language.dictionarySize() > Object.keys(BUILTIN_DICTIONARIES.en).length,
    'the merged dictionary is the union of both files');
});
