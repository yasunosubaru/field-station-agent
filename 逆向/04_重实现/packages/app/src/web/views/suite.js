/**
 * 套件视角 —— 视-4。重做成**三栏工作台**：左导航 / 中内容 / 右检查器。
 *
 * ```
 * ┌──────────┬──────────────────────────────────┬───────────────────────┐
 * │ 六个应用 │  当前应用的界面（六块）           │ 检查器：字段对照       │
 * │ ▣ Manage │                                  │ 字段 │ 原版 │ B │ 状态 │
 * └──────────┴──────────────────────────────────┴───────────────────────┘
 * ```
 *
 * ## 六个应用 = 五个核心 + Perception
 *
 * 第 18.8 节专门记了一次事故：「把 Manage 的分区标签当成六个应用」。
 * 所以清单写死成六个，且 Perception 要**视觉分隔** —— 它是 `nonCoreApp`，
 * 可能没装。没装时显示「未安装」+ 一个「安装」按钮，不是灰掉不说为什么。
 *
 * ## 检查器（25.12.3 / 25.12.4）
 *
 * 四列：字段名 / 原版位置 / B 侧位置 / 状态。
 *
 * **`matched` 必须「不出眼」**（灰、`·`）。这条很反直觉，理由是：
 * 用户关心的是**对不上的**。一屏 100 个绿的会让 3 个橙淹没掉。
 *
 * 五档状态的含义（`FIELD_STATES`）：
 *
 * | 状态 | 记号 | 颜色 | 含义 |
 * |---|---|---|---|
 * | `matched` | `·` | 灰 | 两侧都有，同一字段 |
 * | `b_only` | `+` | 蓝 | 只有 B 侧有（B 多做了） |
 * | `a_only` | `−` | 橙 | 只有原版有（B 漏了） |
 * | `unverified` | `?` | 灰 | 原版侧没核对到，不算差异 |
 * | `not_applicable` | `~` | 灰 | 明确不做（问卷控件），不算差异 |
 *
 * 检查器为什么要在用户界面上（而不是只给开发者）：它证明「我们没丢信息」、
 * 能当面验算、截图就是验收证据。可以默认折叠，但不能没有。
 *
 * ## 表格的三条阅读性要求
 *
 * 固定表头（滚到第 80 行还知道哪列是什么）、数字右对齐等宽（行号能纵向比大小）、
 * 密度可切（一屏看 20 行还是 40 行，是用户自己的选择）。三条都在 `blocks.css` 里。
 *
 * ## 数据从哪来
 *
 * 对照表是 `tools/suite_field_parity.py` 生成的 `docs/operations/suite-field-parity.md`
 * （38 KB）。`INSPECTOR_ENDPOINT` 一处可改；拿不到时检查器显示
 * 「还没有字段对照表」并说清**是哪一步没成**（HTTP 状态 / 网络 / 解析出 0 行），
 * **不假装全 matched**。
 *
 * 解析函数 `parseParityMarkdown()` 与端点分开，接口一旦返回同一份 markdown 就能直接用；
 * 它也被测试直接验（喂真实文件的前几行）。
 */

import { el, empty, section, kv, button, tag, table, headActions } from './dom.js';

/**
 * 六个应用。顺序即导航顺序。
 *
 * `label` 是**导航里的短名**（六个应用的清单被测试逐字钉住：Manage / Playback /
 * Convert / GRIT / Graph / Perception —— 多一个字少一个字都是回归）。
 * `fullName` 是中栏顶部用的全名，两者分开：导航那一列放得下短名，标题里说清全名。
 *
 * `core: false` 的那一个（Perception）视觉上要分隔（附录 C.6 点一），
 * 且未安装时显示「未安装」而不是假装能点。
 */
export const APPS = [
  { id: 'manage', label: 'Manage', fullName: 'Manage', core: true, installed: true, note: '设备 / 状态 / 日志' },
  { id: 'playback', label: 'Playback', fullName: 'Playback', core: true, installed: true, note: '回放与导出' },
  { id: 'convert', label: 'Convert', fullName: 'Convert', core: true, installed: true, note: '格式转换' },
  { id: 'grit', label: 'GRIT', fullName: 'GRIT Monitor', core: true, installed: true, note: '实时显示' },
  { id: 'graph', label: 'Graph', fullName: 'Graph', core: true, installed: true, note: '图与报表' },
  { id: 'perception', label: 'Perception', fullName: 'Perception Viewer', core: false, installed: false, note: '非核心' },
];

/** 五个核心应用。测试按它断言「六个 = 五个核心 + Perception」。 */
export const CORE_APPS = APPS.filter((app) => app.core);

/** 每个应用的图标字（几何符号，不是 emoji —— 25.4.2）。 */
export const APP_GLYPHS = {
  manage: '▣',
  playback: '▷',
  convert: '⇄',
  grit: '◉',
  graph: '◫',
  perception: '◌',
};

/**
 * 检查器的五种状态。
 *
 * 第 25.12.3 节把配色说得很具体，而且给了一条反直觉的要求：
 * **`matched` 要灰（不出眼）**。理由是用户关心的是**对不上的** ——
 * 一屏 100 个绿会让 3 个橙淹没掉。
 *
 * `order` 是导航顺序（也决定图例顺序）：差异在前，无差异在后 ——
 * 和「不出眼」同一条道理，先看到要处理的。
 */
export const FIELD_STATES = {
  matched: { glyph: '·', label: 'matched', short: 'matched', tone: 'quiet', name: '一致', order: 4 },
  b_only: { glyph: '+', label: 'b_only', short: 'b_only', tone: 'add', name: 'B 独占', order: 1 },
  a_only: { glyph: '−', label: 'a_only', short: 'a_only', tone: 'miss', name: 'A 独占', order: 2 },
  unverified: { glyph: '?', label: 'unverified', short: 'unverif.', tone: 'quiet', name: '未核对', order: 3 },
  // 用户反馈问卷控件：两侧按键名对不上，但它**不是设备字段**，
  // 不算差异、也不该显示成缺失。见 `tools/suite_field_parity.py`
  // 的 `SURVEY_CLASS_MARKERS`（判据是祖先容器 class，不是 id 清单）。
  //
  // 表格里的 `short` 只为放得下：状态列固定 78px，`~ not_applicable` 是 16 个等宽字符
  // （实测被截成 `~ not_appl`）。`n/a` 是这套材料里通用的写法，`title` 仍然给全名，
  // 图例里也写着 `not_applicable 不适用` —— 缩的是宽度，不是信息。
  not_applicable: { glyph: '~', label: 'not_applicable', short: 'n/a', tone: 'quiet', name: '不适用', order: 5 },
};

/** 按图例顺序排好的状态键：b_only → a_only → unverified → matched → not_applicable。 */
export const FIELD_STATE_ORDER = Object.keys(FIELD_STATES)
  .sort((left, right) => FIELD_STATES[left].order - FIELD_STATES[right].order);

/** 三种表格密度（「密度可切」）。只改行高与字号，不重排数据。 */
export const ROW_DENSITIES = [
  { id: 'compact', label: '紧凑', note: '一屏看更多行' },
  { id: 'comfort', label: '舒适', note: '默认' },
  { id: 'roomy', label: '宽松', note: '逐行对读' },
];

/** 字段对照表的来源。服务端当前不提供，接口定了只改这一处。 */
export const INSPECTOR_ENDPOINT = '/api/suite/field-parity';

/**
 * 解析 `suite-field-parity.md`。
 *
 * 只认两样东西：
 *   1. 结论区那张表（`| 总数 | 129 | ... |` 这类），取各个计数；
 *   2. 对照表的数据行（`| 字段 | 页面 | B 侧位置 | A 侧位置 | 结论 |`）。
 *
 * 为什么不去解析整份文档：检查器只要「四列 + 几个统计」，其余是给人读的论述。
 * 解析得越少，产物格式一变就越不容易崩。
 */
export function parseParityMarkdown(markdown) {
  const text = String(markdown || '');
  const rows = [];
  const summary = Object.fromEntries(
    Object.keys(FIELD_STATES).map((key) => [key, 0]).concat([['total', 0]]),
  );

  const lines = text.split(/\r?\n/);
  let inTable = false;
  for (const line of lines) {
    const trimmed = line.trim();

    // 对照表的表头：`| 字段 | 页面 | B 侧位置 | A 侧位置 | 结论 |`
    if (/^\|\s*字段\s*\|/.test(trimmed)) {
      inTable = true;
      continue;
    }
    if (inTable) {
      // 分隔行 `| --- | --- |` 跳过。
      if (/^\|\s*-{3,}/.test(trimmed)) continue;
      if (!trimmed.startsWith('|')) { inTable = false; continue; }

      const cells = trimmed.split('|').slice(1, -1).map((cell) => cell.trim());
      if (cells.length < 5) continue;
      const [name, page, bPos, aPos, verdict] = cells;
      const clean = verdict.replace(/[`*]/g, '');
      if (!(clean in FIELD_STATES)) continue;
      rows.push({
        name: name.replace(/[`*]/g, ''),
        page,
        b: bPos === '—' || bPos === '-' ? '' : bPos.replace(/`/g, ''),
        a: aPos === '—' || aPos === '-' ? '' : aPos.replace(/`/g, ''),
        verdict: clean,
      });
      continue;
    }

    // 结论区：`| \`matched\` | 52 | 62 |` 这种。取**去重字段**那一列（判分口径）。
    const keyPattern = Object.keys(FIELD_STATES).join('|');
    const summaryMatch = new RegExp(
      `^\\|\\s*\`?(${keyPattern})\`?[^|]*\\|\\s*\\**(\\d+)\\**\\s*\\|`,
    ).exec(trimmed);
    if (summaryMatch) {
      summary[summaryMatch[1]] = Number(summaryMatch[2]);
    }
  }

  for (const row of rows) summary[row.verdict] = Math.max(summary[row.verdict], 0);
  summary.total = Object.keys(FIELD_STATES)
    .reduce((sum, key) => sum + summary[key], 0);
  return { rows, summary };
}

/**
 * 这一页对不对得上的一句话结论。
 *
 * **只有 `b_only` + `a_only` 算差异**：`unverified` 是「原版侧没核对到」，
 * `not_applicable` 是「明确不做」，把这两个算成差异会把「没核对」和「不做」
 * 误报成「漏做」—— 而那正是产物里专门声明口径的原因。
 */
export function parityConclusion(summary) {
  if (!summary || !summary.total) return { tone: 'quiet', text: '' };
  const mismatches = (summary.b_only || 0) + (summary.a_only || 0);
  if (mismatches === 0) {
    return { tone: 'ok', text: `${summary.total}/${summary.total} 对得上` };
  }
  return {
    tone: 'warn',
    text: `对不上 ${mismatches} 条（${summary.b_only} B 独占 / ${summary.a_only} A 独占）`,
  };
}

/**
 * 位置路径缩到能读的最短形式。
 *
 * 检查器一列只有几十像素，完整路径会把每列挤成「一个字一行」（实测就是这样）。
 * 所以拆成 `文件名` + `行号` 两段：行号单独走 `.num`（等宽右对齐，
 * 一列行号能纵向比大小），全路径进 `title`（悬停可看、可复制）。
 * 这也符合检查器的用途：用户要判断「两侧是不是同一个地方」，不是要读完整路径。
 */
export function splitPath(value) {
  const text = String(value || '');
  if (!text) return { file: '—', line: '' };
  const match = /([^\\/]+):(\d+)\s*$/.exec(text);
  if (match) return { file: match[1], line: match[2] };
  const tail = text.split(/[\\/]/).filter(Boolean).slice(-1)[0] || text;
  return { file: tail, line: '' };
}

export function mount(ctx) {
  const { main, head, state } = ctx;

  /** 检查器数据：`null` 表示还没拿到。 */
  let inspector = null;
  /** 拿不到时的原因（必须是**具体哪一步**，不是「失败」两个字）。 */
  let inspectorError = null;
  /** 表格密度，只影响检查器那张表。 */
  let rowDensity = 'comfort';

  /* —— 页头：视角名 + 当前应用 + 操作（附录 C.7「套件 → 当前应用」） —— */
  const currentAppLabel = el('span', { cls: 'vw-sec-meta', data: { currentApp: '' }, text: 'Manage' });

  head.replaceChildren(
    el('h1', { cls: 'vw-view-title', text: '套件' }),
    el('div', { cls: 'vw-view-context' }, [currentAppLabel]),
    headActions([
      button('刷新', { variant: 'quiet', data: { action: 'refresh' } }),
      button('嵌入原版', { variant: 'quiet', data: { action: 'embed' } }),
    ]),
  );

  /* —— 左栏：六个应用 —— */
  const appList = el('nav', { cls: 'vw-app-list', attr: { 'aria-label': '套件应用' } });

  function paintApps() {
    const selected = state.get().selectedAppId;
    appList.replaceChildren();
    let sawNonCore = false;
    for (const app of APPS) {
      // Perception 之前插一条分隔线：它是 nonCoreApp，可能没装（附录 C.6 点一）。
      if (!app.core && !sawNonCore) {
        sawNonCore = true;
        appList.append(el('div', { cls: 'vw-app-sep', attr: { role: 'separator' } }));
      }
      const isCurrent = app.id === selected;
      const item = el('button', {
        cls: `vw-app-item${isCurrent ? ' vw-app-item-current' : ''}${app.core ? '' : ' vw-app-item-noncore'}`,
        attr: {
          type: 'button',
          'aria-pressed': String(isCurrent),
          disabled: !app.installed,
          title: app.installed ? app.note : '未安装',
        },
        data: { appId: app.id },
        children: [
          el('span', { cls: 'vw-app-glyph', attr: { 'aria-hidden': 'true' }, text: APP_GLYPHS[app.id] || '▣' }),
          el('span', { cls: 'vw-app-label', text: app.label }),
        ],
      });
      if (!app.installed) {
        // 未装必须说出来，并且给下一步动作 —— 灰掉但不说为什么是最差的做法。
        item.append(el('span', { cls: 'vw-app-missing', text: '未安装' }));
      }
      appList.append(item);
      // 未装的应用在它自己那一行下面给「安装」，而不是把整行做成死按钮。
      if (!app.installed) {
        appList.append(el('button', {
          cls: 'vw-app-install',
          attr: { type: 'button' },
          // 用 `data-install-app` 而不是 `data-app-id`：后者是「导航项」的标记，
          // 两者混用会让「有哪些应用」这类遍历把安装按钮也数进去（实测数出 7 个）。
          data: { action: 'install', installApp: app.id },
          text: `安装 ${app.label}`,
        }));
      }
    }
  }
  paintApps();

  /* —— 中栏：当前应用的内容 —— */
  const appBar = el('div', { cls: 'vw-app-bar', data: { appBar: '' } });
  const appHost = el('div', { cls: 'vw-app-body', data: { appBody: '' } });

  /**
   * 每个应用的三块内容。
   *
   * 附录 C.6 点二：「这三块应该和原版一致」（那是设-1 的验收）。
   * 这里只画结构与空态 —— 真实数据要 `packages/view` 的原版片段或
   * `panels/*.js` 的数据通道，那些不在本条的范围内。
   */
  const APP_BLOCKS = {
    manage: [
      { title: '设备', body: () => empty('还没有设备列表。', '连上接收机后，这里按在线 / 离线列出。') },
      { title: '状态', body: () => kv([['端口', '—'], ['波特率', '—'], ['跟踪', '—']]) },
      { title: '日志', body: () => el('p', { cls: 'vw-rail-empty', text: '连上接收机后，这里显示最近几条 INFO / WARN。' }) },
    ],
    playback: [
      { title: '记录', body: () => empty('还没有可回放的记录。', '在 Manage 里收到数据后，这里能按时间轴回放。') },
      { title: '时间轴', body: () => kv([['起点', '—'], ['终点', '—'], ['帧数', '—']]) },
      { title: '导出', body: () => el('p', { cls: 'vw-rail-empty', text: '选定区间后可以导出帧。' }) },
    ],
    convert: [
      { title: '输入', body: () => empty('还没有选抓包。', '选一份抓包后，这里显示格式与记录数。') },
      { title: '输出设置', body: () => kv([['格式', '—'], ['时间区间', '—'], ['采样率', '—']]) },
      { title: '结果', body: () => el('p', { cls: 'vw-rail-empty', text: '转换完成后这里给行数与产物路径。' }) },
    ],
    grit: [
      { title: '位置概览', body: () => empty('还没有定位数据。', '收到 BESTPOS 后这里显示位置与卫星数。') },
      { title: '频谱', body: () => kv([['中心频率', '—'], ['带宽', '—'], ['信噪比', '—']]) },
      { title: '地图', body: () => el('p', { cls: 'vw-rail-empty', text: '有定位点后在这里画轨迹。' }) },
    ],
    graph: [
      { title: '最近工程', body: () => empty('还没有图工程。', '从抓包新建一个工程后，这里按时间列出。') },
      { title: '图表', body: () => kv([['图表数', '—'], ['时间范围', '—'], ['数据行', '—']]) },
      { title: '导出', body: () => el('p', { cls: 'vw-rail-empty', text: '可以导出 CSV / KML / PDF。' }) },
    ],
    perception: [
      { title: '说明', body: () => empty('Perception 是非核心应用。', '它不在五个核心应用里，可以单独安装。') },
    ],
  };

  function paintAppBar(app, blocks) {
    appBar.replaceChildren(
      el('span', { cls: 'vw-app-bar-glyph', attr: { 'aria-hidden': 'true' }, text: APP_GLYPHS[app.id] || '▣' }),
      el('span', { cls: 'vw-app-bar-name', text: app.fullName || app.label }),
      el('span', { cls: 'vw-app-bar-note', text: app.note }),
      el('span', {
        cls: 'vw-app-bar-tag',
        text: app.installed ? `已安装 · ${blocks.length} 块` : '未安装',
      }),
    );
  }

  function paintAppBody() {
    const selected = state.get().selectedAppId;
    const app = APPS.find((entry) => entry.id === selected) ?? APPS[0];
    currentAppLabel.textContent = app.fullName || app.label;
    const blocks = APP_BLOCKS[app.id] ?? APP_BLOCKS.manage;

    if (!app.installed) {
      appBar.replaceChildren(
        el('span', { cls: 'vw-app-bar-glyph', attr: { 'aria-hidden': 'true' }, text: APP_GLYPHS[app.id] || '▣' }),
        el('span', { cls: 'vw-app-bar-name', text: app.fullName || app.label }),
        el('span', { cls: 'vw-app-bar-note', text: app.note }),
        tag('未安装', 'miss'),
      );
      appHost.replaceChildren(empty(
        `${app.fullName || app.label} 未安装。`,
        '它是非核心应用（nonCoreApp），可以单独装。装好之后这一栏会显示它的实际界面。',
        button(`安装 ${app.label}`, { variant: 'primary', data: { action: 'install', installApp: app.id } }),
      ));
      return;
    }

    paintAppBar(app, blocks);
    appHost.replaceChildren(el('div', { cls: 'vw-app-panels' }, blocks.map((block) => section(
      block.title,
      null,
      [block.body()],
    ))));
  }
  paintAppBody();

  /* —— 中栏底部：三个按钮（附录 C.6 点四） —— */
  const appActions = el('div', { cls: 'vw-app-actions' }, [
    // 「建任务」就是视-6 的反向深链（跳到编队并预填）。
    button('建任务', { variant: 'primary', data: { action: 'new-task' } }),
    button('刷新', { data: { action: 'refresh' } }),
    button('嵌入原版', { data: { action: 'embed' } }),
  ]);

  main.append(
    el('div', { cls: 'vw-suite' }, [
      appList,
      el('div', { cls: 'vw-suite-main' }, [appBar, appHost, appActions]),
    ]),
  );

  /* —— 右栏：检查器（第 25.12.3 节四列） —— */
  ctx.renderRail((rail) => {
    const rows = inspector && inspector.rows.length ? inspector.rows : [];
    const conclusion = parityConclusion(inspector && inspector.summary);

    const densityControl = el('div', { cls: 'vw-density-ctl', attr: { role: 'group', 'aria-label': '密度' } },
      ROW_DENSITIES.map((density) => el('button', {
        cls: 'vw-density-btn',
        attr: { type: 'button', 'aria-pressed': String(density.id === rowDensity) },
        title: density.note,
        data: { density: density.id },
        text: density.label,
      })));

    const header = section('检查器', '字段对照', [
      rows.length
        ? el('div', { cls: 'vw-inspector-wrap', data: { density: rowDensity } }, [
          // 固定表头 + 数字右对齐 + 密度可切 —— 三条都在 blocks.css 里落到这张表上。
          table(
            [{ label: '字段' }, { label: '原版' }, { label: 'B 侧' }, { label: '状态' }],
            rows.slice(0, 400).map((row) => {
              const stateInfo = FIELD_STATES[row.verdict];
              return [
                el('span', { cls: 'vw-field-name', title: `${row.page} · ${row.name}`, text: row.name }),
                // 原版位置：`逆向/01_解包/…:行号`。没有就 `—`（那一侧本来没有这个字段）。
                pathCell(row.a),
                pathCell(row.b),
                // 单元格里用短写（状态列 78px，全长写会被截掉半个词），全名进 title。
                el('span', { title: `${stateInfo.glyph} ${stateInfo.label} · ${stateInfo.name}` },
                  [tag(`${stateInfo.glyph} ${stateInfo.short ?? stateInfo.label}`, stateInfo.tone)]),
              ];
            }),
          ),
        ])
        : empty(
          inspectorError ? '检查器拿不到字段对照表。' : '还没有字段对照表。',
          inspectorError || '对照表由 tools/suite_field_parity.py 生成到 docs/operations/suite-field-parity.md；'
            + '服务端还没提供它，所以这里先空着 —— 不假装全 matched。',
        ),
      rows.length ? densityControl : null,
      // 五档图例：状态徽章每种长什么样、算不算差异，一眼看到。
      el('div', { cls: 'vw-legend' }, FIELD_STATE_ORDER.map((key) => el('span', {
        cls: 'vw-legend-item',
        title: `${FIELD_STATES[key].label} · ${FIELD_STATES[key].name}`,
        data: { state: key },
        children: [
          tag(`${FIELD_STATES[key].glyph} ${FIELD_STATES[key].label}`, FIELD_STATES[key].tone),
          el('span', { cls: 'vw-legend-name', text: FIELD_STATES[key].name }),
        ],
      }))),
    ]);

    const stats = section('统计', null, [
      kv([
        ['matched', inspector ? String(inspector.summary.matched) : '—'],
        ['b_only', inspector ? String(inspector.summary.b_only) : '—'],
        ['a_only', inspector ? String(inspector.summary.a_only) : '—'],
        ['unverified', inspector ? String(inspector.summary.unverified) : '—'],
        ['not_applicable', inspector ? String(inspector.summary.not_applicable) : '—'],
        ['total', inspector ? String(inspector.summary.total) : '—'],
      ]),
      // 让用户一眼看到「这一页对不对得上」（附录 C.6 点五）。
      conclusion.text
        ? el('p', { cls: conclusion.tone === 'ok' ? 'vw-ok-note' : 'vw-warn', text: conclusion.text })
        : null,
      el('p', { cls: 'vw-rail-empty', text: 'matched 显示为灰 —— 用户关心的是对不上的那几条。' }),
      el('p', {
        cls: 'vw-rail-empty',
        // 取数走的是哪一条路也要写出来，否则「表是空的」没法判断是没数据还是没接上。
        text: `来源：${INSPECTOR_ENDPOINT}`,
      }),
    ]);

    rail.replaceChildren(header, stats);
  });

  /** 位置格：文件名 + 行号，行号右对齐等宽；全路径进 title。 */
  function pathCell(value) {
    const parts = splitPath(value);
    if (!parts.line) {
      return el('span', { cls: 'vw-path', title: value || '', text: parts.file });
    }
    return el('span', { cls: 'vw-path-cell', title: value }, [
      el('span', { cls: 'vw-path', text: `${parts.file}:` }),
      // 数字右对齐：一列行号能纵向比大小（视觉规矩一）。
      el('span', { cls: 'num vw-path-line', text: parts.line }),
    ]);
  }

  /* —— 检查器取数 —— */

  async function fetchInspector(force = false) {
    try {
      const response = await fetch(INSPECTOR_ENDPOINT, {
        headers: { Accept: 'text/markdown, text/plain' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const markdown = await response.text();
      const parsed = parseParityMarkdown(markdown);
      if (!parsed.rows.length) {
        // 接口通了但表里一行都没解析出来 —— 这和「拿不到」是两件事，必须分开说。
        inspector = null;
        inspectorError = `接口 ${INSPECTOR_ENDPOINT} 返回了 ${markdown.length} 字节，`
          + '但没解析出任何对照行（表头或结论列可能变了）。';
      } else {
        inspector = parsed;
        inspectorError = null;
      }
    } catch (error) {
      inspector = null;
      inspectorError = `接口 ${INSPECTOR_ENDPOINT} 返回 ${error && error.message ? error.message : '失败'}。`;
    }
    ctx.repaintRail();
  }

  /* —— 交互 —— */

  appList.addEventListener('click', (event) => {
    const install = event.target.closest('[data-action="install"]');
    if (install) {
      // 安装要走 RPA / 原版安装器，不在界面里假装。
      // 只把选中项切到它（让内容区显示「未安装」的说明），不伪造安装成功。
      state.set({ selectedAppId: install.dataset.installApp });
      return;
    }
    const item = event.target.closest('[data-app-id]');
    if (!item || item.disabled) return;
    state.set({ selectedAppId: item.dataset.appId });
  });

  const handleAction = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'install') {
      // 安装要走 RPA / 原版安装器（那是 workflow 的事），不在界面里假装成功。
      // 这里只把选中项切到它，让用户看到「未安装」的完整说明与那颗按钮。
      const appId = event.target.closest('[data-install-app]')?.dataset.installApp;
      if (appId) state.set({ selectedAppId: appId });
      return;
    }
    if (action === 'new-task') {
      // 反向深链（视-6）：把当前设备带到编队台，交给它预填。
      // 只改 selection，不新开 store —— 与「下钻」同一条原则。
      const device = state.get().selectedDeviceId;
      const app = APPS.find((entry) => entry.id === state.get().selectedAppId);
      state.set({
        selectedTaskDraft: {
          title: device ? `${app?.label || '套件'} · ${device}` : '从套件台建任务',
          device: device || '',
          app: app?.id || '',
        },
      });
      ctx.go('/fleet');
    }
    if (action === 'refresh') {
      paintAppBody();
      fetchInspector(true);
    }
  };

  head.addEventListener('click', handleAction);
  appActions.addEventListener('click', handleAction);
  // 内容区也要绑：未安装时那里有一颗「安装 X」的按钮，不绑就点了没反应。
  // （实测发现：`appHost`（内容区）原来完全没监听。）
  appHost.addEventListener('click', handleAction);

  /** 密度切换：右栏是每次重画的一棵子树，所以委托在 rail 上（画一次就绑一次不行）。 */
  function bindRailEvents() {
    const rail = ctx.rail;
    if (!rail) return;
    rail.addEventListener('click', (event) => {
      const density = event.target.closest('[data-density]');
      if (!density) return;
      rowDensity = density.dataset.density;
      ctx.repaintRail();
    });
  }
  bindRailEvents();

  const unsubscribe = state.subscribe((next, changed) => {
    if (!changed.has('selectedAppId')) return;
    paintApps();
    paintAppBody();
    ctx.repaintRail();
  });

  fetchInspector();

  return () => unsubscribe();
}
