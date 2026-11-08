/**
 * 深链解析：`fsa://job/<id>` 与 `fsa://device/<id>`。
 *
 * ## 为什么单独成文件
 *
 * 这段逻辑是**外部输入的第一道门**，也是最需要逐条测试的地方 —— 而 `main.js`
 * 一 require 就会去建 Electron 应用、读命令行、起服务，根本没法在单元测试里加载。
 * 所以把纯函数抽出来：`main.js` 引用它，测试也引用它，两边跑的是同一份。
 *
 * ## 为什么字符集是收窄的
 *
 * id 会被拼进 URL 查询串交给页面，又可能来自**任意第三方程序**发起的协议调用。
 * 允许 `?` `&` `#` `/` 之类就等于把注入点直接送给外部调用方。
 *
 * **收窄是为了防注入，不要为了「支持更多 id」而放宽**（规格 25.15.2 原话）。
 *
 * ## 为什么两种 kind 共用同一个正则
 *
 * 规格 25.15.2：`device` 用和 `job` 同一套标准。多复制一份正则，迟早会有一个
 * 被放宽 —— 那时「同一个标准」就只剩说辞了。
 *
 * ## 为什么不用 `decodeURIComponent`
 *
 * `fsa://job/%2e%2e` 这类编码绕过在解码后才显形。不解码时百分号直接通不过
 * 字符集，等于免费挡掉一层。解码再校验，就得把所有编码形式都想全。
 */

/** id 的允许字符。**收窄是刻意的**，见文件头。 */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** 允许的两种深链目标。加一种要在这里加一行 —— 这是唯一的需求清单。 */
const KINDS = ['job', 'device'];

/**
 * 解析一条深链。
 *
 * @param {unknown} raw 可能来自 argv 的任意值
 * @param {(message: string, detail?: string) => void} [log] 拒绝原因的去处（默认丢弃）
 * @returns {{ kind: 'job' | 'device', id: string } | null} null = 不认识或不合法
 */
function parseDeepLink(raw, log = () => {}) {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();

  // ① 必须是 fsa: 开头。`fsb://job/abc` 在这里就被挡掉。
  if (!/^fsa:/i.test(text)) return null;

  /*
   * ② 原文里出现控制字符（含 tab / 换行）一律拒绝。
   *
   * 为什么必须在 `new URL` **之前**看：URL 解析会**剥掉** tab 与换行，
   * `fsa://job/a\tb` 解析后是 `id = "ab"` —— 一个畸形串变成了合法 id 并悄悄通过。
   * 实测踩到过（测试里逐个字符验时才发现）。
   */
  if (/[\u0000-\u001F\u007F]/.test(text)) {
    log('深链含控制字符', JSON.stringify(text.slice(0, 80)));
    return null;
  }

  /*
   * ③ 原文里出现路径穿越段（`.` / `..`）一律拒绝。
   *
   * 同样必须在 `new URL` 之前看：解析会把 `fsa://device/../secret` 规范化成
   * `fsa://device/secret`，于是「越界」的写法拿到了一个合法 id 并通过。
   * 单看解析后的结果已经无从分辨，只能回原文判断。
   */
  const pathPart = text.replace(/^fsa:\/*/i, '');
  if (pathPart.split(/[/\\]/).some((segment) => segment === '.' || segment === '..')) {
    log('深链含路径穿越段', text);
    return null;
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    // ④ 不是合法 URL（`hello`、`fsa://job/a b` 里的空格也会让它抛）。
    log('深链不是合法 URL', text);
    return null;
  }
  // ⑤ scheme 大小写：`fsa:` 与 `FSA:` 都接受（URL 规范里 scheme 不区分大小写），
  //    但别的一律不收。
  if (parsed.protocol.toLowerCase() !== 'fsa:') return null;

  // ⑥ 查询串与片段在深链里没有意义，带着它们多半是别的程序拼错了。
  //    `fsa://job/abc?x=1` / `fsa://job/abc#x` 都在这里被拒。
  //    明确拒绝，而不是悄悄忽略那一截 —— 「拼错的链接看起来像成功」是这类接口最坏的行为。
  if (parsed.search || parsed.hash) {
    log('深链带查询串或片段', text);
    return null;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  /*
   * 三种写法都可能出现，统一成 (kind, rest)：
   *   fsa://job/abc   → hostname=job,  pathname=/abc
   *   fsa:///job/abc  → hostname='',   pathname=/job/abc   （多一条斜杠，手工输入常见）
   *   fsa:job/abc     → hostname='',   pathname=job/abc    （部分浏览器/命令行的规范化）
   */
  let kind = String(parsed.hostname || '').toLowerCase();
  let rest = segments;
  if (!kind && segments.length > 0) {
    kind = segments[0].toLowerCase();
    rest = segments.slice(1);
  }

  /*
   * ⑤ 主机名必须小写。
   *
   * `new URL` 会把 hostname 转小写，所以 `fsa://JOB/abc` 到这里已经是 `job`、会**通过**。
   * 规格 25.15.3 第 9 条要求大写要拒绝 —— 靠 hostname 已经分辨不出来，只能回原文看。
   */
  const rawHost = /^fsa:\/\/([^/?#]+)/i.exec(text)?.[1] ?? '';
  if (rawHost && rawHost !== rawHost.toLowerCase()) {
    log('深链主机名必须小写', text);
    return null;
  }

  // ⑥ 不认识的 kind（`fsb://job/abc` 里 kind 也是 job，但 scheme 上一步已挡）。
  if (!KINDS.includes(kind)) {
    log(`不认识的深链主机名 "${kind}"`, text);
    return null;
  }

  const id = rest[0] || '';
  // ⑦ 多余路径段：`fsa://job/a/b`。只取第一段等于悄悄忽略后半截。
  if (rest.length > 1) {
    log('深链多余路径段', text);
    return null;
  }
  // ⑧ 空 / 太短 / 太长 / 非法字符，全在这一个判断里（见 ID_PATTERN）。
  if (!ID_PATTERN.test(id)) {
    log(`深链 ${kind} id 不合法`, JSON.stringify(id));
    return null;
  }
  return { kind, id };
}

/** 从一整条 argv 里挑第一个认识的深链；Windows 把协议 URL 当普通参数递进来。 */
function linkFromArgv(argv, log = () => {}) {
  for (const token of argv || []) {
    const link = parseDeepLink(token, log);
    if (link) return link;
  }
  return null;
}

module.exports = { parseDeepLink, linkFromArgv, ID_PATTERN, KINDS };
