/**
 * Tests for the DOM shim itself. The interesting cases are the ones the real shipped
 * fragments exercise: comments, space-padded attributes, `<p>` wrapping `<span>`,
 * void elements, raw-text, and the selector forms `updateView` composes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MiniDocument, createDocument, querySelectorAll, trigger } from '../src/minidom.ts';
import { htmlFragment } from './helpers.ts';

test('parses a real shipped fragment and keeps ids, classes and markers', () => {
  const doc: MiniDocument = createDocument();
  const holder = doc.createElement('div');
  holder.id = 'main-panel-tabs-3';
  doc.body.appendChild(holder);
  holder.innerHTML = htmlFragment('positionStatus');

  const first = holder.firstElementChild!;
  assert.equal(first.className, 'position-status', 'Packery identifies the tile by this class');
  assert.ok(first.classList.contains('position-status'));

  const latitude = holder.querySelector('#positionStatuslatitude');
  assert.ok(latitude, 'declared as `id = "positionStatuslatitude"` (space around =)');
  assert.equal(latitude!.textContent, '--');

  const markers = querySelectorAll(holder, '[data-lang-positioning]');
  assert.equal(markers.length, 1);

  // `#<tab> #<feature><field>` — the rule from genericView.updateView must resolve.
  const scoped = doc.querySelector('#main-panel-tabs-3 #positionStatuslatitude');
  assert.ok(scoped, 'the doc §5.1 selector composition resolves against the shipped markup');
});

test('keeps comments in markup but out of textContent', () => {
  const doc = createDocument();
  const box = doc.createElement('div');
  box.innerHTML = '<div class="a"><!--secret--><span>one</span></div>';
  // Standard DOM: comments are nodes, so they serialise back out…
  assert.equal(box.innerHTML, '<div class="a"><!--secret--><span>one</span></div>');
  // …but they are not text, so they never reach textContent.
  assert.equal(box.textContent, 'one');
  // Dropping the comment is a tree operation like any other.
  box.querySelector('div')!.firstChild!.remove();
  assert.equal(box.innerHTML, '<div class="a"><span>one</span></div>');
});

test('handles void elements, raw text and implicit closes', () => {
  const doc = createDocument();
  const box = doc.createElement('div');
  box.innerHTML = '<br><img src="a.png"><script>if (1 < 2) { x(); }</script><p>a<p>b';
  assert.equal(box.querySelectorAll('br').length, 1);
  const script = box.querySelector('script')!;
  assert.match(script.textContent, /1 < 2/, 'raw text is not parsed as markup');
  assert.equal(box.querySelectorAll('p').length, 2, 'the second <p> implicitly closes the first');
});

test('form-control attributes reflect to value and checked like the browser DOM', () => {
  const doc = createDocument();
  const box = doc.createElement('div');
  box.innerHTML = '<input type="radio" id="one" value="sd-1m" checked>';
  const input = box.querySelector('input') as HTMLInputElement;
  assert.equal(input.value, 'sd-1m');
  assert.equal(input.checked, true);
  input.removeAttribute('checked');
  assert.equal(input.checked, false);
});

test('classList, dataset, attributes and style round-trip', () => {
  const doc = createDocument();
  const element = doc.createElement('div');
  element.classList.add('tile', 'manage-tile');
  element.classList.remove('tile');
  assert.equal(element.className, 'manage-tile');
  assert.equal(element.classList.toggle('manage-tile'), false);

  element.dataset.langWarning = '';
  assert.equal(element.getAttribute('data-lang-warning'), '');
  assert.deepEqual(Object.keys(element.dataset), ['langWarning']);

  element.style.display = 'none';
  element.style.left = '12px';
  assert.equal(element.style.display, 'none');
  assert.equal(element.getAttribute('style'), 'display: none; left: 12px');

  element.style.cssText = 'top: 4px';
  assert.equal(element.style.getPropertyValue('top'), '4px');
  assert.equal(element.style.display, '');
});

test('attribute selectors and combinators work', () => {
  const doc = createDocument();
  doc.body.innerHTML =
    '<ul id="tabs-list"><li connType="SM"><a href="#tabs-2">2</a></li><li connType="GRIT">g</li></ul>';
  assert.equal(doc.querySelectorAll("#tabs-list [connType='SM']").length, 1);
  assert.equal(doc.querySelectorAll("#tabs-list [connType='GRIT']").length, 1);
  assert.equal(doc.querySelectorAll('ul > li').length, 2);
  assert.equal(doc.querySelector('ul > li > a').textContent, '2');
  assert.equal(doc.querySelectorAll('li:not([connType="SM"])').length, 1);
});

test('events bubble, stopPropagation cuts them, and removal is by identity', () => {
  const doc = createDocument();
  const outer = doc.createElement('div');
  const inner = doc.createElement('button');
  outer.appendChild(inner);
  doc.body.appendChild(outer);
  inner.id = 'go';

  const seen: string[] = [];
  outer.addEventListener('click', (event) => {
    seen.push('outer:' + (event.target as { id: string }).id);
  });

  const stopIt = (event: { stopPropagation(): void }) => event.stopPropagation();
  inner.addEventListener('click', stopIt);
  trigger(inner, 'click');
  assert.deepEqual(seen, [], 'stopPropagation cut the bubble');

  // An unrelated listener must not be removed: removeEventListener matches the function identity.
  inner.removeEventListener('click', () => {});
  trigger(inner, 'click');
  assert.deepEqual(seen, [], 'the stopPropagation listener is still attached');

  // Removing the handler that was actually added lets the event through.
  inner.removeEventListener('click', stopIt);
  trigger(inner, 'click');
  assert.deepEqual(seen, ['outer:go']);
});

test('getElementById and tree surgery stay consistent after a move', () => {
  const doc = createDocument();
  const a = doc.createElement('div');
  a.id = 'a';
  const b = doc.createElement('div');
  b.id = 'b';
  doc.body.append(a, b);
  assert.equal(doc.getElementById('a'), a);
  b.appendChild(a);
  assert.equal(doc.getElementById('a')!.parentElement, b);
  a.remove();
  assert.equal(doc.getElementById('a'), null);
});

test('cloneNode copies attributes deeply', () => {
  const doc = createDocument();
  const node = doc.createElement('div');
  node.innerHTML = '<span class="x" data-lang-y=""></span>';
  const copy = node.cloneNode(true);
  assert.equal(copy.outerHTML, node.outerHTML);
  assert.equal(copy.querySelectorAll('span').length, 1);
  assert.equal(copy.querySelector('span')!.getAttribute('data-lang-y'), '');
});
