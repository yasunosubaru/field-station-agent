/**
 * The landing page ("My Applications").
 *
 * The original opens on `view/html/welcome.html`: a heading, an Add application button and one
 * card per core tool, with the live-connection count under Manage and GRIT Monitor. This build
 * has to open on the same screen — a receiver-aware suite that starts on a capture replay looks
 * like it has no device management at all, which is exactly how it was reported from the bench.
 *
 * These checks are static (the shell is a static file, no DOM library here): the markup exists,
 * every card names a page the shell knows, and the icons the stylesheet points at are shipped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..', 'src', 'web');
const repoRoot = resolve(here, '..', '..', '..', '..', '..');
const unpacked = join(repoRoot, '逆向', '01_解包', 'app', 'view');

const html = readFileSync(join(web, 'index.html'), 'utf8');
const css = readFileSync(join(web, 'home.css'), 'utf8');

test('the shell starts on the landing page, not on a tool', () => {
  assert.match(html, /selectPage\('home'\)/, 'boot must open the welcome screen');
  assert.doesNotMatch(html, /selectPage\('manage'\);/, 'the old manage-first boot is gone');
  assert.match(html, /id="home-view"/);
});

test('one card per core tool, each wired to a page the shell knows', () => {
  const cards = [...html.matchAll(/data-home-tab="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(cards, ['manage', 'playback', 'convert', 'grit', 'graph']);

  const pages = [...html.matchAll(/^ {4}([a-z]+): \{\n {6}title:/gm)].map((match) => match[1]);
  for (const card of cards) {
    assert.ok(pages.includes(card), `${card} must be a page in PAGES`);
  }
});

test('Manage and GRIT Monitor carry the live-connection line, the others do not', () => {
  const blocks = [...html.matchAll(/<button[^>]*data-home-tab="([a-z]+)"[\s\S]*?<\/button>/g)];
  assert.equal(blocks.length, 5);
  for (const match of blocks) {
    const name = match[1];
    const body = match[0];
    const hasCount = body.includes('data-home-connections');
    assert.equal(hasCount, name === 'manage' || name === 'grit', `${name}: connection count placement`);
  }
});

test('the landing page hides the tab strip and the folder rail', () => {
  assert.match(css, /\.nas-body\[hidden\][\s\S]*?display:\s*none/, 'a flex body must be forced hidden');
  assert.match(css, /\.tabs-view-data\[hidden\][\s\S]*?display:\s*none/);
});

test('card metrics follow the shipped welcome page (184x240, 104 icon, 8 radius)', () => {
  assert.match(css, /\.home-card\s*\{[\s\S]*?width:\s*184px/);
  assert.match(css, /\.home-card\s*\{[\s\S]*?height:\s*240px/);
  assert.match(css, /\.home-card-icon\s*\{[\s\S]*?width:\s*104px/);
  assert.match(css, /border-radius:\s*8px/);
});

test('every icon the page asks for is shipped', () => {
  const icons = [...css.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(icons.length >= 5, 'five launcher icons');
  for (const icon of icons) {
    if (icon.startsWith('/assets/images/')) {
      const file = decodeURIComponent(icon.slice('/assets/images/'.length));
      assert.ok(existsSync(join(unpacked, 'images', file)), `missing shipped asset ${file}`);
    } else {
      const file = icon.replace(/^\//, '');
      assert.ok(existsSync(join(web, file)), `missing local asset ${file}`);
    }
  }
});
