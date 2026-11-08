/**
 * 建 DOM 的小工具 —— 四个视角块共用。
 *
 * ## 为什么要它
 *
 * 四个块都要「一节标题 + 键值对 + 干净表格 + 空态」。没有框架时，如果每处都手写
 * `createElement` + `setAttribute` + `append`，会出现三类重复毛病：
 *   1. 某处忘了 `textContent`（改成 `innerHTML`）→ 注入面；
 *   2. 某处数字忘了 `.num` → 一列数字对不齐（视觉规矩一）；
 *   3. 某处单位忘了 `.unit` → 单位抢了数字的眼（视觉规矩二）。
 *
 * 所以把这三件事收进函数里，用错的机会少一半。
 *
 * ## 一条硬规矩：只用 `textContent`
 *
 * 本文件**不提供**「把字符串塞进 innerHTML」的函数。所有文本内容都走 `textContent`，
 * 需要结构就传节点。这样「用户数据里带标签」不可能是注入，只能是文本。
 */

/**
 * 建一个元素。
 *
 * @param {string} tag
 * @param {object} [options]
 * @param {string} [options.cls]      class
 * @param {string} [options.text]     文本（走 textContent）
 * @param {string} [options.title]    title 属性
 * @param {object} [options.attr]     其余属性
 * @param {object} [options.data]     data-* （键不用带前缀）
 * @param {Array<Node|string>} [options.children]
 */
/**
 * 建一个元素。
 *
 * @param {string} tag
 * @param {object} [options]
 * @param {string} [options.cls]      class
 * @param {string} [options.text]     文本（走 textContent）
 * @param {string} [options.title]    title 属性
 * @param {object} [options.attr]     其余属性
 * @param {object} [options.data]     data-* （键不用带前缀）
 * @param {Array<Node|string>} [options.children]
 * @param {Array<Node|string>} [rest] 第三个位置参数也能给子节点
 *
 * 第三个位置参数是特意支持的：`el('div', { cls }, [...])` 是 JS 里最顺手的写法，
 * 而只收两个参数时它会**静默丢掉所有子节点** —— 元素建出来了、class 对了、
 * 就是空的，看起来像「样式没生效」。实测在探针页上踩过一次（质控与评测两块全空）。
 */
export function el(tag, options = {}, rest) {
  const node = document.createElement(tag);
  if (options.cls) node.className = options.cls;
  // 用 `!== undefined` 而不是真值判断：`''` 与 `0` 都是合法文本。
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.title) node.title = options.title;
  if (options.attr) {
    for (const [name, value] of Object.entries(options.attr)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(name, value === true ? '' : String(value));
    }
  }
  if (options.data) {
    for (const [name, value] of Object.entries(options.data)) {
      if (value === null || value === undefined) continue;
      node.dataset[name] = String(value);
    }
  }
  const children = options.children ?? rest ?? [];
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

/** 文本节点，省得每处 `document.createTextNode`。 */
export function text(value) {
  return document.createTextNode(String(value));
}

/**
 * 数字 + 单位。
 *
 * 视觉规矩一 + 二：数字等宽右对齐、单位小一号。两件事一起做，就不会出现
 * 「这一处对齐了、那一处忘了」。
 *
 * @param {string|number} value 已经格式化好的数字文本（千分位由 `formatNumber` 负责）
 * @param {string} [unit]
 */
export function num(value, unit) {
  const valueNode = el('span', { cls: 'num', text: value });
  if (!unit) return valueNode;
  return el('span', { cls: 'vw-num-pair', children: [valueNode, el('span', { cls: 'unit', text: unit })] });
}

/**
 * 一节：标题 + 可选的右侧小字 + 内容。
 *
 * 分隔只靠上边框，不用卡片阴影 —— 阴影会让行与行的边界变糊（25.13.5）。
 */
export function section(title, meta, children) {
  const head = el('div', { cls: 'vw-sec-head', children: [
    el('h2', { cls: 'vw-sec-title', text: title }),
    meta === null || meta === undefined ? null : (typeof meta === 'string' ? el('span', { cls: 'vw-sec-meta', text: meta }) : meta),
  ] });
  return el('section', { cls: 'vw-sec', children: [head, ...children] });
}

/** 键值对表。值右对齐、数字等宽。 */
export function kv(rows) {
  return el('dl', {
    cls: 'vw-kv',
    children: rows.filter(Boolean).map(([name, value]) => el('div', {
      cls: 'vw-kv-row',
      children: [
        el('dt', { text: name }),
        el('dd', { children: [value instanceof Node ? value : text(value ?? '—')] }),
      ],
    })),
  });
}

/**
 * 干净表格：只画横线，不画竖线（视觉规矩三）。
 *
 * `columns` 里每列可以给 `{ label, numeric }`；`numeric` 的列自动带 `.num`。
 */
export function table(columns, rows) {
  const normalized = columns.map((column) => (typeof column === 'string'
    ? { label: column, numeric: false }
    : { numeric: false, ...column }));

  const thead = el('thead', { children: [el('tr', {
    children: normalized.map((column) => el('th', {
      cls: column.numeric ? 'num' : '',
      text: column.label,
    })),
  })] });

  const tbody = el('tbody', {
    children: rows.map((row) => el('tr', {
      children: row.map((cell, index) => {
        const column = normalized[index] ?? {};
        const isNode = cell instanceof Node;
        return el('td', {
          cls: column.numeric && !isNode ? 'num' : '',
          children: [isNode ? cell : text(cell ?? '—')],
        });
      }),
    })),
  });

  return el('table', { cls: 'clean', children: [thead, tbody] });
}

/**
 * 空态。
 *
 * 规格第 25.11.4 节要求四种空态互相区分 ——「无数据」让用户不知道下一步做什么。
 * 所以这里强制调用方给出 `title`（现状）与可选的 `note`（下一步做什么）。
 */
export function empty(titleText, note, action) {
  return el('div', { cls: 'vw-empty', children: [
    el('p', { cls: 'vw-empty-title', text: titleText }),
    note ? el('p', { cls: 'vw-empty-note', text: note }) : null,
    action ?? null,
  ] });
}

/**
 * 内联警告条（四级错误里的「警告」）。
 *
 * 用于「引擎已降级」这类必须让用户知道、但不需要打断操作的情况。
 */
export function warnBar(message, detail) {
  return el('p', { cls: 'vw-warn', children: [
    el('span', { text: message }),
    detail ? el('span', { cls: 'unit', text: detail }) : null,
  ] });
}

/**
 * 内联错误条。
 *
 * 第 25.14.4 节要求三要素齐：发生了什么（人话）/ 错误码（给开发者）/ 该做什么。
 * `failure` 来自 `state.js` 的 `describeFailure()`。
 */
export function errorBar(failure) {
  return el('div', { cls: 'vw-error', attr: { role: 'alert' }, children: [
    el('span', { text: failure.what }),
    el('span', { cls: 'vw-error-code', text: `${failure.code} · ${failure.hint}` }),
  ] });
}

/** 状态标记：文字 + 颜色，不只靠颜色。 */
export function tag(label, tone) {
  return el('span', { cls: 'vw-tag', data: tone ? { tone } : undefined, text: label });
}

/** 一个按钮；`variant` 取 `primary` / `quiet` / `danger-quiet` / `text`。 */
export function button(label, options = {}) {
  return el('button', {
    cls: `vw-btn${options.variant ? ` vw-btn-${options.variant}` : ''}`,
    text: label,
    title: options.title,
    attr: {
      type: 'button',
      disabled: options.disabled === true,
      'aria-disabled': options.disabled === true ? 'true' : null,
    },
    data: options.data,
  });
}

/** 页头右侧的操作组容器。 */
export function headActions(children) {
  return el('div', { cls: 'vw-view-head-actions', children });
}

/**
 * 加载中的骨架。
 *
 * 第 25.14.3 节：< 300ms 不显示（不闪）；300ms~3s 骨架屏；> 3s 骨架屏 + 进度文字。
 * 所以这里不立刻画 —— 由 `skeleton(host, delay)` 在延时后判断是否还需要。
 */
export function skeleton(host, delayMs = 300) {
  const token = { cancelled: false };
  const timer = setTimeout(() => {
    if (token.cancelled) return;
    host.replaceChildren(el('div', {
      cls: 'vw-skeleton',
      attr: { 'aria-hidden': 'true' },
      children: [
        el('span', { cls: 'vw-skeleton-row' }),
        el('span', { cls: 'vw-skeleton-row' }),
        el('span', { cls: 'vw-skeleton-row' }),
      ],
    }));
  }, delayMs);
  return () => { token.cancelled = true; clearTimeout(timer); };
}
