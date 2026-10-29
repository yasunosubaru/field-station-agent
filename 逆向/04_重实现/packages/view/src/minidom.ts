/**
 * Minimal DOM, zero dependencies.
 *
 * Why it exists: the whole Manage view layer is written against the DOM, and Node has none.
 * The layer under `src/` therefore only uses a **standard DOM subset** (`createElement`,
 * `classList`, `dataset`, `querySelector`, `addEventListener`, …), so exactly the same files
 * run in Node against this shim (tests, `render-static.ts`) and in a real browser (the demo).
 *
 * Supported on purpose, nothing more:
 *  - Node / Text / Comment / Element / DocumentFragment / Document
 *  - classList, dataset, style, attributes, tree surgery, cloneNode, innerHTML / outerHTML
 *  - querySelector(All): `#id`, `.class`, `tag`, `[attr]`, `[attr=v]`, `[attr~=v]`, `:not(...)`
 *    combined with the descendant and child combinators
 *  - events with bubbling, `preventDefault`, `stopPropagation`
 *  - getBoundingClientRect derived from style.left/top/width/height (overridable via `__rect`)
 *
 * The HTML parser is intentionally small: it handles the fragments shipped in `01_解包/app/view`
 * (comments, unquoted/space-padded attributes, void elements, raw-text `<script>`/`<style>`,
 * implicit closes for `p`/`li`/`tr`/`td`/`option`) and nothing else.
 */

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul',
]);

export const NODE_TYPES = { element: 1, text: 3, comment: 8, document: 9, fragment: 11 } as const;

export interface MiniEvent {
  type: string;
  target: unknown;
  currentTarget: unknown;
  bubbles: boolean;
  defaultPrevented: boolean;
  detail?: unknown;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

type Listener = (event: MiniEvent) => void;

function kebabToCamel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function camelToKebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ nodes */

export class MiniNode {
  nodeType = 0;
  nodeName = '';
  parentNode: MiniElement | MiniDocumentFragment | MiniDocument | null = null;
  childNodes: MiniNode[] = [];
  ownerDocument!: MiniDocument;
  protected listeners: Map<string, Array<{ fn: Listener; once: boolean }>> | null = null;

  get parentElement(): MiniElement | null {
    return this.parentNode && this.parentNode.nodeType === NODE_TYPES.element
      ? (this.parentNode as MiniElement)
      : null;
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): MiniNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): MiniNode | null {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) return null;
    const index = siblings.indexOf(this);
    return index === -1 ? null : siblings[index + 1] ?? null;
  }

  get previousSibling(): MiniNode | null {
    const siblings = this.parentNode?.childNodes;
    if (!siblings) return null;
    const index = siblings.indexOf(this);
    return index <= 0 ? null : siblings[index - 1];
  }

  get nextElementSibling(): MiniElement | null {
    let node = this.nextSibling;
    while (node && node.nodeType !== NODE_TYPES.element) node = node.nextSibling;
    return (node as MiniElement) ?? null;
  }

  get previousElementSibling(): MiniElement | null {
    let node = this.previousSibling;
    while (node && node.nodeType !== NODE_TYPES.element) node = node.previousSibling;
    return (node as MiniElement) ?? null;
  }

  /**
   * Keep `util.inspect` (and therefore `assert.deepEqual`) from walking the whole shim tree.
   * Without this, one accidental `assert.equal(node, null)` inspects every property — including
   * the `style`/`dataset` proxies and the `parentNode` cycle — which took 160 s on a 181-node page.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    if (this.nodeType === NODE_TYPES.text) return `#text(${JSON.stringify((this as MiniText).data.slice(0, 20))})`;
    if (this.nodeType === NODE_TYPES.comment) return `<!--${(this as MiniText).data.slice(0, 20)}-->`;
    if (this.nodeType === NODE_TYPES.document) return 'MiniDocument';
    if (this.nodeType === NODE_TYPES.fragment) return 'MiniFragment';
    const element = this as MiniElement;
    const id = element.getAttribute('id');
    const cls = element.getAttribute('class');
    return `<${element.tagName.toLowerCase()}${id ? '#' + id : ''}${cls ? '.' + cls.split(/\s+/).join('.') : ''}>`;
  }

  get children(): MiniElement[] {
    return this.childNodes.filter((n) => n.nodeType === NODE_TYPES.element) as MiniElement[];
  }

  /**
   * Real-DOM `isConnected`: true while the node is reachable from a document root. Used by the
   * view layer's element cache, which must not write into a node that was replaced by a re-render.
   */
  get isConnected(): boolean {
    let node: MiniNode | null = this;
    while (node) {
      if (node.nodeType === NODE_TYPES.document) return true;
      node = node.parentNode;
    }
    return false;
  }

  get firstElementChild(): MiniElement | null {
    return this.children[0] ?? null;
  }

  get lastElementChild(): MiniElement | null {
    const kids = this.children;
    return kids[kids.length - 1] ?? null;
  }

  /** Detach every child, clearing their back-pointers like a real DOM does. */
  removeAllChildren(): void {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
  }

  appendChild<T extends MiniNode>(node: T): T {
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this as unknown as MiniElement;
    this.childNodes.push(node);
    node.ownerDocument = this.ownerDocument ?? node.ownerDocument;
    return node;
  }

  insertBefore<T extends MiniNode>(node: T, reference: MiniNode | null): T {
    if (!reference) return this.appendChild(node);
    const index = this.childNodes.indexOf(reference);
    if (index === -1) throw new Error('insertBefore: reference is not a child');
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this as unknown as MiniElement;
    this.childNodes.splice(index, 0, node);
    return node;
  }

  removeChild<T extends MiniNode>(node: T): T {
    const index = this.childNodes.indexOf(node);
    if (index === -1) throw new Error('removeChild: node is not a child');
    this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  replaceChild(newNode: MiniNode, oldNode: MiniNode): MiniNode {
    const index = this.childNodes.indexOf(oldNode);
    if (index === -1) throw new Error('replaceChild: node is not a child');
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    this.childNodes[index] = newNode;
    newNode.parentNode = this as unknown as MiniElement;
    oldNode.parentNode = null;
    return oldNode;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  append(...nodes: Array<MiniNode | string>): void {
    for (const node of nodes) this.appendChild(typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node);
  }

  prepend(...nodes: Array<MiniNode | string>): void {
    const reference = this.firstChild;
    for (const node of nodes) {
      const child = typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node;
      this.insertBefore(child, reference);
    }
  }

  before(...nodes: Array<MiniNode | string>): void {
    if (!this.parentNode) return;
    for (const node of nodes) {
      const child = typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node;
      this.parentNode.insertBefore(child, this);
    }
  }

  after(...nodes: Array<MiniNode | string>): void {
    if (!this.parentNode) return;
    const reference = this.nextSibling;
    for (const node of nodes) {
      const child = typeof node === 'string' ? this.ownerDocument.createTextNode(node) : node;
      reference ? this.parentNode.insertBefore(child, reference) : this.parentNode.appendChild(child);
    }
  }

  contains(other: MiniNode | null): boolean {
    let node: MiniNode | null = other;
    while (node) {
      if (node === this) return true;
      node = node.parentNode;
    }
    return false;
  }

  cloneNode(deep = false): MiniNode {
    const copy = this.ownerDocument.createShimNode(this.nodeType, this.nodeName);
    if (this.nodeType === NODE_TYPES.element) {
      const source = this as MiniElement;
      const target = copy as MiniElement;
      for (const name of source.getAttributeNames()) target.setAttribute(name, source.getAttribute(name)!);
    } else if (this.nodeType === NODE_TYPES.text || this.nodeType === NODE_TYPES.comment) {
      (copy as MiniText).data = (this as MiniText).data;
    }
    if (deep) for (const child of this.childNodes) copy.appendChild(child.cloneNode(true));
    return copy;
  }

  get textContent(): string {
    if (this.nodeType === NODE_TYPES.text) return (this as MiniText).data;
    // Comments contribute nothing to textContent (unlike text nodes), matching the real DOM.
    if (this.nodeType === NODE_TYPES.comment) return '';
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    if (this.nodeType === NODE_TYPES.text || this.nodeType === NODE_TYPES.comment) {
      (this as MiniText).data = value;
      return;
    }
    this.removeAllChildren();
    if (value !== '') this.appendChild(this.ownerDocument.createTextNode(value));
  }

  addEventListener(type: string, fn: Listener, options?: { once?: boolean } | boolean): void {
    if (!this.listeners) this.listeners = new Map();
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, once: typeof options === 'object' && options !== null ? Boolean(options.once) : false });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners?.get(type);
    if (!list) return;
    const index = list.findIndex((entry) => entry.fn === fn);
    if (index !== -1) list.splice(index, 1);
  }

  /** Dispatch an event, bubbling up the tree like a real DOM (no capture phase). */
  dispatchEvent(event: MiniEvent | string): boolean {
    const evt: MiniEvent =
      typeof event === 'string'
        ? {
            type: event,
            target: this,
            currentTarget: this,
            bubbles: true,
            defaultPrevented: false,
            preventDefault() {},
            stopPropagation() {},
            stopImmediatePropagation() {},
          }
        : event;
    let stopped = false;
    let immediate = false;
    const originalPrevent = evt.preventDefault.bind(evt);
    const originalStop = evt.stopPropagation.bind(evt);
    evt.preventDefault = () => {
      evt.defaultPrevented = true;
      originalPrevent();
    };
    evt.stopPropagation = () => {
      stopped = true;
      originalStop();
    };
    evt.stopImmediatePropagation = () => {
      immediate = true;
      evt.stopPropagation();
    };
    let node: MiniNode | null = this;
    while (node) {
      const list = node.listeners?.get(evt.type);
      if (list && list.length) {
        evt.currentTarget = node;
        for (const entry of [...list]) {
          entry.fn(evt);
          if (entry.once) node.removeEventListener(evt.type, entry.fn);
          if (immediate) break;
        }
      }
      if (!evt.bubbles || stopped || immediate) break;
      node = node.parentNode;
    }
    return !evt.defaultPrevented;
  }
}

export class MiniText extends MiniNode {
  data: string;

  constructor(data: string, ownerDocument: MiniDocument) {
    super();
    this.nodeType = NODE_TYPES.text;
    this.nodeName = '#text';
    this.data = data;
    this.ownerDocument = ownerDocument;
  }

  get nodeValue(): string {
    return this.data;
  }

  set nodeValue(value: string) {
    this.data = value;
  }
}

export class MiniComment extends MiniText {
  constructor(data: string, ownerDocument: MiniDocument) {
    super(data, ownerDocument);
    this.nodeType = NODE_TYPES.comment;
    this.nodeName = '#comment';
  }
}

export class MiniDocumentFragment extends MiniNode {
  constructor(ownerDocument: MiniDocument) {
    super();
    this.nodeType = NODE_TYPES.fragment;
    this.nodeName = '#document-fragment';
    this.ownerDocument = ownerDocument;
  }

  querySelector(selector: string): MiniElement | null {
    return querySelector(this, selector);
  }

  querySelectorAll(selector: string): MiniElement[] {
    return querySelectorAll(this, selector);
  }
}

export class MiniClassList {
  private readonly element: MiniElement;

  constructor(element: MiniElement) {
    this.element = element;
  }

  private tokens(): string[] {
    return (this.element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  }

  private write(tokens: string[]): void {
    if (tokens.length) this.element.setAttribute('class', tokens.join(' '));
    else this.element.removeAttribute('class');
  }

  get length(): number {
    return this.tokens().length;
  }

  get value(): string {
    return this.element.getAttribute('class') ?? '';
  }

  item(index: number): string | null {
    return this.tokens()[index] ?? null;
  }

  contains(token: string): boolean {
    return this.tokens().includes(token);
  }

  add(...tokens: string[]): void {
    const current = this.tokens();
    for (const token of tokens) if (!current.includes(token)) current.push(token);
    this.write(current);
  }

  remove(...tokens: string[]): void {
    this.write(this.tokens().filter((token) => !tokens.includes(token)));
  }

  toggle(token: string, force?: boolean): boolean {
    const has = this.contains(token);
    const next = force === undefined ? !has : force;
    if (next) this.add(token);
    else this.remove(token);
    return next;
  }

  toString(): string {
    return this.value;
  }

  [Symbol.iterator](): IterableIterator<string> {
    return this.tokens()[Symbol.iterator]();
  }
}

export class MiniStyle {
  private readonly element: MiniElement;

  constructor(element: MiniElement) {
    this.element = element;
  }

  get cssText(): string {
    return this.element.getAttribute('style') ?? '';
  }

  set cssText(value: string) {
    if (value) this.element.setAttribute('style', value);
    else this.element.removeAttribute('style');
  }

  setProperty(name: string, value: string): void {
    const declarations = this.declarations();
    declarations[kebabToCamel(name)] = String(value);
    this.flush(declarations);
  }

  getPropertyValue(name: string): string {
    return this.declarations()[kebabToCamel(name)] ?? '';
  }

  removeProperty(name: string): void {
    const camel = kebabToCamel(name);
    const declarations = this.declarations();
    delete declarations[camel];
    this.flush(declarations);
  }

  private declarations(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of this.cssText.split(';')) {
      const index = part.indexOf(':');
      if (index === -1) continue;
      out[kebabToCamel(part.slice(0, index).trim())] = part.slice(index + 1).trim();
    }
    return out;
  }

  private flush(declarations: Record<string, string>): void {
    const text = Object.entries(declarations)
      .filter(([, value]) => value !== '' && value !== undefined && value !== null)
      .map(([name, value]) => `${camelToKebab(name)}: ${value}`)
      .join('; ');
    if (text) this.element.setAttribute('style', text);
    else this.element.removeAttribute('style');
  }
}

/** Proxy over the `data-*` attributes, so `el.dataset.langWarning = ''` works. */
function createDataset(element: MiniElement): Record<string, string> {
  const dataAttribute = (prop: string | symbol): string => 'data-' + camelToKebab(String(prop));
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const value = element.getAttribute(dataAttribute(prop));
        return value === null ? undefined : value;
      },
      set(_target, prop, value) {
        element.setAttribute(dataAttribute(prop), String(value));
        return true;
      },
      has(_target, prop) {
        return element.hasAttribute(dataAttribute(prop));
      },
      deleteProperty(_target, prop) {
        element.removeAttribute(dataAttribute(prop));
        return true;
      },
      ownKeys() {
        return element
          .getAttributeNames()
          .filter((name) => name.startsWith('data-'))
          .map((name) => kebabToCamel(name.slice(5)));
      },
      getOwnPropertyDescriptor(_target, prop) {
        const value = element.getAttribute(dataAttribute(prop));
        if (value === null) return undefined;
        return { configurable: true, enumerable: true, value, writable: true };
      },
    },
  ) as Record<string, string>;
}

export class MiniElement extends MiniNode {
  tagName: string;
  private readonly attrs = new Map<string, string>();
  readonly classList: MiniClassList;
  readonly style: MiniStyle & Record<string, string>;
  readonly dataset: Record<string, string>;
  /** Test hook: layout boxes are not computed, so callers may pin the measured rect. */
  __rect: { width?: number; height?: number; left?: number; top?: number } | null = null;

  constructor(tagName: string, ownerDocument: MiniDocument) {
    super();
    this.nodeType = NODE_TYPES.element;
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.ownerDocument = ownerDocument;
    this.classList = new MiniClassList(this);
    this.style = new Proxy(new MiniStyle(this), {
      get(target, prop) {
        const raw = (target as unknown as Record<string | symbol, unknown>)[prop];
        if (raw !== undefined && typeof raw !== 'function') return raw;
        if (typeof raw === 'function') return (raw as (...args: unknown[]) => unknown).bind(target);
        return target.getPropertyValue(String(prop));
      },
      set(target, prop, value) {
        // Accessor properties that live on the prototype (`cssText`) must go through the real
        // setter; everything else is treated as a CSS declaration name.
        const descriptor =
          typeof prop === 'string' ? Object.getOwnPropertyDescriptor(MiniStyle.prototype, prop) : undefined;
        if (descriptor && typeof descriptor.set === 'function') {
          Reflect.set(target, prop, value);
          return true;
        }
        const declarations = (target as unknown as { declarations(): Record<string, string> }).declarations();
        declarations[String(prop)] = String(value);
        (target as unknown as { flush(d: Record<string, string>): void }).flush(declarations);
        return true;
      },
      has(target, prop) {
        return (target as unknown as { declarations(): Record<string, string> }).declarations()[String(prop)] !== undefined;
      },
    }) as MiniStyle & Record<string, string>;
    this.dataset = createDataset(this);
  }

  get id(): string {
    return this.getAttribute('id') ?? '';
  }

  set id(value: string) {
    this.setAttribute('id', value);
  }

  get className(): string {
    return this.getAttribute('class') ?? '';
  }

  set className(value: string) {
    this.setAttribute('class', value);
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
    // HTML form controls reflect these attributes onto properties.  The
    // shipped fragments declare their initial radio state as attributes, and
    // component code reads `.value` / `.checked`, so keep the two views in
    // sync for the DOM subset.
    if (name === 'value') this.value = String(value);
    else if (name === 'checked') this.checked = true;
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
    if (name === 'checked') this.checked = false;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  getAttributeNames(): string[] {
    return [...this.attrs.keys()];
  }

  /** `attributes` as the original code reads it (a live-ish list backed by the map). */
  get attributes(): Array<{ name: string; value: string }> {
    return [...this.attrs.entries()].map(([name, value]) => ({ name, value }));
  }

  get innerHTML(): string {
    return this.childNodes.map(serializeNode).join('');
  }

  set innerHTML(html: string) {
    this.removeAllChildren();
    const fragment = parseHTML(html, this.ownerDocument);
    for (const child of [...fragment.childNodes]) this.appendChild(child);
  }

  get outerHTML(): string {
    return serializeNode(this);
  }

  querySelector(selector: string): MiniElement | null {
    return querySelector(this, selector);
  }

  querySelectorAll(selector: string): MiniElement[] {
    return querySelectorAll(this, selector);
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }

  closest(selector: string): MiniElement | null {
    let node: MiniElement | null = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  getElementsByClassName(name: string): MiniElement[] {
    return this.querySelectorAll('.' + name);
  }

  getElementsByTagName(name: string): MiniElement[] {
    return this.querySelectorAll(name);
  }

  click(): void {
    const type = (this.getAttribute('type') ?? '').toLowerCase();
    const isCheckable =
      this.tagName === 'INPUT' && (type === 'checkbox' || type === 'radio');
    if (isCheckable) {
      if (type === 'checkbox') {
        this.checked = !this.checked;
        if (this.checked) this.setAttribute('checked', '');
        else this.removeAttribute('checked');
      } else {
        this.checked = true;
        const name = this.getAttribute('name');
        if (name) {
          for (const other of this.ownerDocument.querySelectorAll(
            `input[type=radio][name=${cssEscape(name)}]`,
          )) {
            if (other !== this) {
              (other as MiniElement).checked = false;
              other.removeAttribute('checked');
            }
          }
        }
        if (this.checked) this.setAttribute('checked', '');
      }
    }
    const accepted = this.dispatchEvent(createEvent('click', true));
    if (isCheckable && accepted) this.dispatchEvent(createEvent('change', true));
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
    this.dispatchEvent(createEvent('focus', false));
  }

  blur(): void {
    this.dispatchEvent(createEvent('blur', false));
  }

  /** Box model stand-in: `__rect`, else the inline style, else zeros. */
  getBoundingClientRect(): { width: number; height: number; left: number; top: number; right: number; bottom: number } {
    const px = (value: string | undefined): number => {
      if (!value) return 0;
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    const width = this.__rect?.width ?? px(this.style.width);
    const height = this.__rect?.height ?? px(this.style.height);
    const left = this.__rect?.left ?? px(this.style.left);
    const top = this.__rect?.top ?? px(this.style.top);
    return { width, height, left, top, right: left + width, bottom: top + height };
  }

  get clientWidth(): number {
    return this.__rect?.width ?? this.getBoundingClientRect().width;
  }

  get offsetWidth(): number {
    return this.clientWidth;
  }

  get clientHeight(): number {
    return this.__rect?.height ?? this.getBoundingClientRect().height;
  }

  get offsetHeight(): number {
    return this.clientHeight;
  }

  /** `.value` on form elements is read/written directly in the original code. */
  value = '';
  checked = false;
  disabled = false;
}

export class MiniDocument extends MiniNode {
  documentElement: MiniElement;
  head: MiniElement;
  body: MiniElement;
  activeElement: MiniElement | null = null;
  readyState = 'complete';

  constructor() {
    super();
    this.nodeType = NODE_TYPES.document;
    this.nodeName = '#document';
    this.ownerDocument = this;
    this.documentElement = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }

  get title(): string {
    return this.head.querySelector('title')?.textContent ?? '';
  }

  set title(value: string) {
    let node = this.head.querySelector('title');
    if (!node) {
      node = this.createElement('title');
      this.head.appendChild(node);
    }
    node.textContent = value;
  }

  createElement(tagName: string): MiniElement {
    return new MiniElement(tagName, this);
  }

  createTextNode(data: string): MiniText {
    return new MiniText(data, this);
  }

  createComment(data: string): MiniComment {
    return new MiniComment(data, this);
  }

  createDocumentFragment(): MiniDocumentFragment {
    return new MiniDocumentFragment(this);
  }

  getElementById(id: string): MiniElement | null {
    return this.documentElement.querySelector('#' + cssEscape(id));
  }

  querySelector(selector: string): MiniElement | null {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector: string): MiniElement[] {
    return this.documentElement.querySelectorAll(selector);
  }

  /** Used by `cloneNode`, which needs a stand-in for odd node types. */
  createShimNode(nodeType: number, nodeName: string): MiniNode {
    if (nodeType === NODE_TYPES.text) return new MiniText('', this);
    if (nodeType === NODE_TYPES.comment) return new MiniComment('', this);
    if (nodeType === NODE_TYPES.fragment) return new MiniDocumentFragment(this);
    return new MiniElement(nodeName.toLowerCase(), this);
  }
}

/* ------------------------------------------------------- selector engine */

interface SimpleSelector {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<{ name: string; op?: string; value?: string }>;
  nots: string[];
}

interface SelectorStep {
  simple: SimpleSelector;
  combinator: ' ' | '>' | null;
}

function parseSimple(part: string): SimpleSelector {
  const simple: SimpleSelector = { classes: [], attrs: [], nots: [] };
  let index = 0;
  while (index < part.length) {
    const char = part[index];
    if (char === '#') {
      const match = /^#([-\w]+)/.exec(part.slice(index));
      if (!match) break;
      simple.id = match[1];
      index += match[0].length;
    } else if (char === '.') {
      const match = /^\.([-\w]+)/.exec(part.slice(index));
      if (!match) break;
      simple.classes.push(match[1]);
      index += match[0].length;
    } else if (char === '[') {
      const end = part.indexOf(']', index);
      if (end === -1) break;
      const body = part.slice(index + 1, end);
      const attr = /^([-\w]+)\s*(?:([~^$*|]?=)\s*(.+))?$/.exec(body);
      if (attr) {
        let value = attr[3];
        if (value !== undefined) value = value.replace(/^["']|["']$/g, '');
        simple.attrs.push({ name: attr[1], op: attr[2], value });
      }
      index = end + 1;
    } else if (char === ':') {
      const match = /^:not\(([^)]*)\)/.exec(part.slice(index));
      if (!match) {
        index += 1;
        continue;
      }
      simple.nots.push(match[1].trim());
      index += match[0].length;
    } else if (/[*\w-]/.test(char)) {
      const match = /^(\*|[-\w]+)/.exec(part.slice(index));
      if (!match) break;
      if (match[1] !== '*') simple.tag = match[1].toLowerCase();
      index += match[0].length;
    } else {
      index += 1;
    }
  }
  return simple;
}

export function parseSelector(selector: string): SelectorStep[] {
  const steps: SelectorStep[] = [];
  const tokens = selector
    .replace(/\s*>\s*/g, ' > ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let combinator: ' ' | '>' | null = null;
  for (const token of tokens) {
    if (token === '>') {
      combinator = '>';
      continue;
    }
    steps.push({ simple: parseSimple(token), combinator });
    combinator = ' ';
  }
  if (steps.length) steps[0].combinator = null;
  return steps;
}

function matchSimple(element: MiniElement, simple: SimpleSelector): boolean {
  if (simple.tag && element.tagName.toLowerCase() !== simple.tag) return false;
  if (simple.id && element.id !== simple.id) return false;
  for (const cls of simple.classes) if (!element.classList.contains(cls)) return false;
  for (const attr of simple.attrs) {
    const value = element.getAttribute(attr.name);
    if (value === null) return false;
    if (attr.op === undefined || attr.value === undefined) continue;
    if (attr.op === '=' && value !== attr.value) return false;
    if (attr.op === '~=' && !value.split(/\s+/).includes(attr.value)) return false;
    if (attr.op === '^=' && !value.startsWith(attr.value)) return false;
    if (attr.op === '$=' && !value.endsWith(attr.value)) return false;
    if (attr.op === '*=' && !value.includes(attr.value)) return false;
    if (attr.op === '|=' && value !== attr.value && !value.startsWith(attr.value + '-')) return false;
  }
  for (const not of simple.nots) {
    const inner = parseSelector(not);
    if (inner.length === 1 && matchSimple(element, inner[0].simple)) return false;
  }
  return true;
}

function matchSteps(element: MiniElement, steps: SelectorStep[], index: number): boolean {
  const step = steps[index];
  if (!matchSimple(element, step.simple)) return false;
  if (index === 0) return true;
  const previous = steps[index - 1];
  if (step.combinator === '>') {
    const parent = element.parentElement;
    return parent ? matchSteps(parent, steps, index - 1) : false;
  }
  let ancestor = element.parentElement;
  while (ancestor) {
    if (matchSteps(ancestor, steps, index - 1)) return true;
    ancestor = ancestor.parentElement;
  }
  void previous;
  return false;
}

export function matchesSelector(element: MiniElement, selector: string): boolean {
  return selector
    .split(',')
    .map((part) => parseSelector(part))
    .some((steps) => steps.length > 0 && matchSteps(element, steps, steps.length - 1));
}

/**
 * Depth-first walk that stops as soon as `visit` returns true.
 *
 * The `true` **must** propagate up the recursion: without it, `querySelector` keeps walking after
 * the first match and ends up returning the last one. With duplicate ids on the page (the Manage
 * shell has five: `#popupModal`, `#helpModal`, `#connection-loader`, `#loader-text-id`,
 * `#fetch-loader-tabs-1`) that is the difference between updating the right tab and the wrong one.
 */
function walk(root: MiniNode, visit: (element: MiniElement) => boolean): boolean {
  for (const child of root.childNodes) {
    if (child.nodeType !== NODE_TYPES.element) continue;
    if (visit(child as MiniElement)) return true;
    if (walk(child, visit)) return true;
  }
  return false;
}

export function querySelector(root: MiniNode, selector: string): MiniElement | null {
  let found: MiniElement | null = null;
  walk(root, (element) => {
    if (matchesSelector(element, selector)) {
      found = element;
      return true;
    }
    return false;
  });
  return found;
}

export function querySelectorAll(root: MiniNode, selector: string): MiniElement[] {
  const out: MiniElement[] = [];
  walk(root, (element) => {
    if (matchesSelector(element, selector)) out.push(element);
    return false;
  });
  return out;
}

export function cssEscape(value: string): string {
  return value.replace(/([^\w-])/g, '\\$1');
}

/* ------------------------------------------------------------ serializer */

export function serializeNode(node: MiniNode): string {
  if (node.nodeType === NODE_TYPES.text) return escapeText((node as MiniText).data);
  if (node.nodeType === NODE_TYPES.comment) return `<!--${(node as MiniComment).data}-->`;
  if (node.nodeType === NODE_TYPES.element) {
    const element = node as MiniElement;
    const tag = element.tagName.toLowerCase();
    const attrs = element
      .getAttributeNames()
      .map((name) => ` ${name}="${escapeAttr(element.getAttribute(name)!)}"`)
      .join('');
    if (VOID_ELEMENTS.has(tag)) return `<${tag}${attrs}>`;
    return `<${tag}${attrs}>${element.childNodes.map(serializeNode).join('')}</${tag}>`;
  }
  return node.childNodes.map(serializeNode).join('');
}

/* ---------------------------------------------------------- HTML parsing */

interface StartTag {
  tag: string;
  attrs: Array<{ name: string; value: string }>;
  selfClosing: boolean;
}

function parseStartTag(raw: string): StartTag {
  const match = /^\s*([-\w:]+)/.exec(raw);
  const tag = (match?.[1] ?? '').toLowerCase();
  const attrs: Array<{ name: string; value: string }> = [];
  const attributePattern = /([-\w:.]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const rest = raw.slice(match ? match[0].length : 0);
  let found: RegExpExecArray | null;
  while ((found = attributePattern.exec(rest))) {
    const value = found[2] ?? found[3] ?? found[4];
    attrs.push({ name: found[1], value: value === undefined ? '' : value });
  }
  const selfClosing = /\/\s*$/.test(raw) || VOID_ELEMENTS.has(tag);
  return { tag, attrs, selfClosing };
}

function autoClose(stack: MiniElement[], tag: string): void {
  const top = (): string | undefined => stack[stack.length - 1]?.tagName.toLowerCase();
  const popWhile = (names: Set<string>): void => {
    while (stack.length && names.has(top()!)) stack.pop();
  };
  if (tag === 'p') popWhile(new Set(['p']));
  else if (BLOCK_ELEMENTS.has(tag)) popWhile(new Set(['p']));
  if (tag === 'li') popWhile(new Set(['li']));
  if (tag === 'tr') popWhile(new Set(['td', 'th', 'tr']));
  if (tag === 'td' || tag === 'th') popWhile(new Set(['td', 'th']));
  if (tag === 'option') popWhile(new Set(['option']));
  if (tag === 'dt' || tag === 'dd') popWhile(new Set(['dt', 'dd']));
}

export function parseHTML(html: string, ownerDocument: MiniDocument): MiniDocumentFragment {
  const fragment = ownerDocument.createDocumentFragment();
  const stack: MiniElement[] = [];
  const appendNode = (node: MiniNode): void => {
    const parent = stack[stack.length - 1];
    if (parent) parent.appendChild(node);
    else fragment.appendChild(node);
  };
  let index = 0;
  while (index < html.length) {
    const start = html.indexOf('<', index);
    if (start === -1) {
      appendNode(ownerDocument.createTextNode(html.slice(index)));
      break;
    }
    if (start > index) appendNode(ownerDocument.createTextNode(html.slice(index, start)));
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      const stop = end === -1 ? html.length : end;
      appendNode(ownerDocument.createComment(html.slice(start + 4, stop)));
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', start)) {
      const end = html.indexOf('>', start);
      index = end === -1 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith('</', start)) {
      const end = html.indexOf('>', start);
      const name = html.slice(start + 2, end === -1 ? html.length : end).trim().toLowerCase();
      index = end === -1 ? html.length : end + 1;
      for (let depth = stack.length - 1; depth >= 0; depth--) {
        if (stack[depth].tagName.toLowerCase() === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }
    let cursor = start + 1;
    let quote = '';
    while (cursor < html.length) {
      const char = html[cursor];
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
      cursor += 1;
    }
    const raw = html.slice(start + 1, cursor);
    index = cursor + 1;
    const { tag, attrs, selfClosing } = parseStartTag(raw);
    if (!tag) continue;
    autoClose(stack, tag);
    const element = ownerDocument.createElement(tag);
    for (const attr of attrs) element.setAttribute(attr.name, attr.value);
    appendNode(element);
    if (selfClosing) continue;
    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const closeIndex = html.toLowerCase().indexOf(`</${tag}`, index);
      const stop = closeIndex === -1 ? html.length : closeIndex;
      element.appendChild(ownerDocument.createTextNode(html.slice(index, stop)));
      if (closeIndex === -1) index = html.length;
      else {
        const end = html.indexOf('>', closeIndex);
        index = end === -1 ? html.length : end + 1;
      }
      continue;
    }
    stack.push(element);
  }
  return fragment;
}

/* ---------------------------------------------------------------- events */

export function createEvent(type: string, bubbles = true, detail?: unknown): MiniEvent {
  return {
    type,
    target: null,
    currentTarget: null,
    bubbles,
    detail,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    stopImmediatePropagation() {},
  };
}

/** Fire an event from `element`, filling in `target` as a real DOM would. */
export function trigger(element: MiniElement, type: string, detail?: unknown): boolean {
  const event = createEvent(type, true, detail);
  event.target = element;
  return element.dispatchEvent(event);
}

/** Build a document with the three Manage shell containers the view layer needs. */
export function createDocument(): MiniDocument {
  const doc = new MiniDocument();
  const landing = doc.createElement('div');
  landing.className = 'landing-pages';
  const setupLanding = doc.createElement('div');
  setupLanding.className = 'setupMonitor-landing-screen';
  const monitor = doc.createElement('div');
  monitor.className = 'setUpMonitor-layout';
  doc.body.append(landing, setupLanding, monitor);
  return doc;
}
