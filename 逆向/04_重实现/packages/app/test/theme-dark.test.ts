/**
 * Dark theme guards.
 *
 * Two regressions made the dark UI unusable on the bench (2026-11-02):
 *  - `body.darkMode span { color: #fff }` whitened text inside panels that kept their light
 *    surfaces, so an entire dashboard read as blank white cards;
 *  - playback.css reads `--pb-*` while the dark block only set `--nas-*`, so its tiles went dark
 *    and its text stayed black (49 unreadable labels on the Playback dashboard);
 *  - and the theme followed the OS, so a dark Windows opened the half-built dark UI by default.
 *
 * These are static checks on the shipped stylesheet/script, matching how the other shell tests
 * read `index.html` (no browser in this suite).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', 'src', 'web');
const themeCss = readFileSync(join(web, 'theme.css'), 'utf8');
const themeJs = readFileSync(join(web, 'theme.js'), 'utf8');

test('dark mode never repaints a span white: it inherits its parent', () => {
  const blanket = /body\.darkMode span \{([^}]*)\}/.exec(themeCss);
  assert.ok(blanket, 'the dark span rule exists');
  assert.match(blanket[1], /color:\s*inherit/, 'spans follow their parent, not a fixed white');
  assert.doesNotMatch(blanket[1], /255,\s*255,\s*255/, 'no hard-coded white on every span');
});

test('the playback panel gets its own dark tokens', () => {
  const blocks = [...themeCss.matchAll(/body\.darkMode \.playback-panel \{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(blocks.length > 0, 'a dark block exists for .playback-panel');
  const withPb = blocks.find((body) => body.includes('--pb-ink'));
  assert.ok(withPb, 'the --pb-* token set is defined (playback.css reads those, not --nas-*)');
  for (const token of ['--pb-ink', '--pb-ink-60', '--pb-surface', '--pb-rule', '--pb-band']) {
    assert.match(withPb, new RegExp(`${token}:`), `${token} must be set in dark mode`);
  }
});

test('the shell opens light unless a theme was chosen', () => {
  assert.match(themeJs, /readStored\(\)\s*\?\?\s*'light'/, 'no OS-following default');
  assert.doesNotMatch(themeJs, /readStored\(\)\s*\?\?\s*systemTheme\(\)/, 'the old OS default is gone');
});

test('every panel that ships a dark palette keeps its ink light', () => {
  for (const [file, block] of [
    ['panels/manage.css', /body\.darkMode \.manage-panel \{([^}]*)\}/],
    ['panels/grit.css', /body\.darkMode \.grit-page \{([^}]*)\}/],
  ]) {
    const css = readFileSync(join(web, file), 'utf8');
    const match = block.exec(css);
    assert.ok(match, `${file}: dark palette block`);
    assert.match(match[1], /rgba\(255,\s*255,\s*255,\s*0\.87\)/, `${file}: light ink`);
  }
});
