"""统一 SQL 方言子集 → DuckDB / ClickHouse 的翻译。

**边界**：上层只写一种方言（DuckDB 兼容子集）。本模块负责三件最容易踩的事：

1. **时间桶**：``time_bucket('1 hour', ts)`` / ``date_trunc('day', ts)``
   → ClickHouse 的 ``toStartOfHour(ts)`` / ``toStartOfInterval(...)``；
2. **LIMIT**：``LIMIT offset, count`` → ``LIMIT count OFFSET offset``（两边都规范）；
3. **字符串函数**：``length`` → ``lengthUTF8``、``strpos`` → ``position``、
   ``replace`` → ``replaceAll``、``split_part`` → ``splitByChar`` 等。

**不碰字符串字面量**：扫描器区分引号内/外，``WHERE note = 'time_bucket('1 h', x)'``
不会被改写。这比一串 ``re.sub`` 安全，也是本模块有单测的原因。

**认不出的函数原样保留**，并继续递归处理它的参数——ClickHouse 有大量同名函数，
不该因为没列进表就整条 SQL 失效；真跑不了时由引擎报 ``EngineError``，而不是
在这里猜。

只用标准库。
"""
from __future__ import annotations

import re
from typing import Callable, Sequence

__all__ = [
    "DialectError",
    "ReadOnlyViolation",
    "SUPPORTED_DIALECTS",
    "WRITE_KEYWORDS",
    "assert_readonly",
    "is_readonly",
    "to_clickhouse",
    "to_duckdb",
    "translate",
]

SUPPORTED_DIALECTS = ("duckdb", "clickhouse")

_QUOTES = ("'", '"', "`")
_IDENT_START = re.compile(r"[A-Za-z_]")
_IDENT_BODY = re.compile(r"[A-Za-z0-9_]")
_LIMIT_COMMA = re.compile(r"\bLIMIT\s+(\d+)\s*,\s*(\d+)", re.IGNORECASE)
_INTERVAL_LITERAL = re.compile(r"^['\"`](.*?)['\"`]$", re.DOTALL)
_INTERVAL_TEXT = re.compile(r"^(\d+)\s*([A-Za-z]+)$")

_UNIT_ALIASES = {
    "s": "second",
    "sec": "second",
    "secs": "second",
    "second": "second",
    "seconds": "second",
    "m": "minute",
    "min": "minute",
    "mins": "minute",
    "minute": "minute",
    "minutes": "minute",
    "h": "hour",
    "hr": "hour",
    "hour": "hour",
    "hours": "hour",
    "d": "day",
    "day": "day",
    "days": "day",
    "w": "week",
    "week": "week",
    "weeks": "week",
    "mon": "month",
    "month": "month",
    "months": "month",
    "q": "quarter",
    "quarter": "quarter",
    "quarters": "quarter",
    "y": "year",
    "year": "year",
    "years": "year",
}

_START_OF = {
    "second": "toStartOfSecond",
    "minute": "toStartOfMinute",
    "hour": "toStartOfHour",
    "day": "toStartOfDay",
    "week": "toStartOfWeek",
    "month": "toStartOfMonth",
    "quarter": "toStartOfQuarter",
    "year": "toStartOfYear",
}

_EXTRACT_TO = {
    "year": "toYear",
    "month": "toMonth",
    "day": "toDayOfMonth",
    "hour": "toHour",
    "minute": "toMinute",
    "second": "toSecond",
}


class DialectError(ValueError):
    """方言名不认识，或一条语句无法翻译。"""


# ---------------------------------------------------------------- 只读闸门
#: 出现即视为**写语句的动词**。
#:
#: 为什么只列动词、不列 `SYSTEM` / `SET` / `PRAGMA` 这类：它们是**子句名词**，
#: 会与普通列名撞车 —— `COUNT(DISTINCT system)` 里就有一个 `system`，
#: 把 `SYSTEM` 放进黑名单会让一条纯查询被拒。这类「前缀型子句」
#: （`SET join_use_nulls=1` / `PRAGMA x` / `SYSTEM RELOAD`）改由
#: 「首关键字白名单」挡住：它们不以 SELECT/WITH/EXPLAIN 开头。
#:
#: 教训记在这里：黑名单越宽，误杀越多；**白名单才是主判据**。
WRITE_KEYWORDS = (
    "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT",
    "CREATE", "DROP", "ALTER", "TRUNCATE", "RENAME",
    "ATTACH", "DETACH", "COPY", "EXPORT",
    "GRANT", "REVOKE", "OPTIMIZE", "VACUUM",
    "BEGIN", "COMMIT", "ROLLBACK",
)

#: 写成 `动词 + 空格 + 对象` 的形态，单独按短语匹配。
#: `REPLACE INTO` 不能只靠 `REPLACE` 这个词 —— DuckDB 有 `replace()` 函数。
WRITE_PHRASES = ("REPLACE INTO", "SET ", "PRAGMA ")

_READ_PREFIXES = ("SELECT", "WITH", "EXPLAIN", "DESCRIBE", "SHOW")

_COMMENTS = re.compile(r"--[^\n]*|/\*.*?\*/", re.DOTALL)


class ReadOnlyViolation(DialectError):
    """这条语句会写数据。两引擎都必须拒，且拒的理由要能看懂。"""

    def __init__(self, reason: str, sql: str = "") -> None:
        self.reason = reason
        self.sql = sql
        super().__init__(reason)


def _strip_comments(sql: str) -> str:
    """去掉注释再判：`-- DROP TABLE x` 只是注释，不该被当成写语句。"""
    return _COMMENTS.sub(" ", sql)


def is_readonly(sql: str) -> bool:
    """这条 SQL 是否只读。**保守**：看不出来就返回 False（宁可多拒）。"""
    try:
        assert_readonly(sql)
    except ReadOnlyViolation:
        return False
    return True


def assert_readonly(sql: str) -> None:
    """写语句就抛 `ReadOnlyViolation`；只读则静默返回。

    ## 为什么两道判据都要

    1. **首关键字白名单**：只放 SELECT/WITH/EXPLAIN/DESCRIBE/SHOW 开头。
       这条能挡住绝大多数 `INSERT INTO … SELECT` 之类的「看着像查询」的写。
    2. **写关键字黑名单**：扫描（去掉注释与字符串字面量后的）全文。
       这条挡住 `WITH x AS (DELETE … RETURNING *) SELECT * FROM x` 这种
       首关键字合规、内部在写的形态。

    为什么不用「只跑 EXPLAIN」代替：EXPLAIN 本身在部分引擎上仍需执行
    查询计划（ClickHouse 的 `EXPLAIN` 不执行，但 `EXPLAIN ANALYZE` 会），
    不能把安全寄托在一条 SQL 的执行语义上。
    """
    body = _strip_comments(sql).strip()
    if not body:
        raise ReadOnlyViolation("空语句", sql)

    # 判据 1：首关键字白名单。括号开头的情况（`(SELECT …) UNION …`）也接受。
    head = body.lstrip("( \t\r\n").upper()
    if not any(head.startswith(prefix) for prefix in _READ_PREFIXES):
        first = head.split(None, 1)[0] if head.split() else ""
        raise ReadOnlyViolation(
            "只允许只读查询（SELECT/WITH/EXPLAIN/DESCRIBE/SHOW），"
            f"这条以 {first or '(空)'} 开头",
            sql)

    # 判据 2：全文扫写动词，但**先抹掉字符串字面量** ——
    # `WHERE note = 'DELETE this later'` 是数据，不是语句。
    scan = _blank_literals(body).upper()
    for keyword in WRITE_KEYWORDS:
        if re.search(r"\b" + keyword + r"\b", scan):
            raise ReadOnlyViolation(
                f"语句里出现写操作关键字 {keyword}；数据台是只读的，写语句必须被拒",
                sql)
    for phrase in WRITE_PHRASES:
        if re.search(re.escape(phrase.strip()) + r"\b", scan):
            raise ReadOnlyViolation(
                f"语句里出现写操作短语 {phrase.strip()}；数据台是只读的，写语句必须被拒",
                sql)


def _blank_literals(sql: str) -> str:
    """把引号内的内容换成空格，长度保持不变（便于定位，也让正则不受字数影响）。"""
    out = list(sql)
    i = 0
    while i < len(sql):
        if sql[i] in _QUOTES:
            end = _skip_quoted(sql, i)
            for k in range(i + 1, min(end, len(sql)) - 1):
                out[k] = " "
            i = end
            continue
        i += 1
    return "".join(out)


# ---------------------------------------------------------------- 扫描器
def _skip_quoted(text: str, start: int) -> int:
    """``start`` 指向引号；返回闭引号之后的下标（支持 ``''`` 转义）。"""
    quote = text[start]
    i = start + 1
    while i < len(text):
        if text[i] == quote:
            if i + 1 < len(text) and text[i + 1] == quote:
                i += 2
                continue
            return i + 1
        i += 1
    return len(text)


def _find_matching(text: str, open_index: int) -> int | None:
    depth = 0
    i = open_index
    while i < len(text):
        ch = text[i]
        if ch in _QUOTES:
            i = _skip_quoted(text, i)
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return None


def _split_args(inner: str) -> list[str]:
    if not inner.strip():
        return []
    args: list[str] = []
    depth = 0
    start = 0
    i = 0
    while i < len(inner):
        ch = inner[i]
        if ch in _QUOTES:
            i = _skip_quoted(inner, i)
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
            args.append(inner[start:i].strip())
            start = i + 1
        i += 1
    tail = inner[start:].strip()
    if tail:
        args.append(tail)
    return args


def _map_unquoted(text: str, fn: Callable[[str], str]) -> str:
    """只对引号外的片段应用 ``fn``。"""
    out: list[str] = []
    i = 0
    while i < len(text):
        if text[i] in _QUOTES:
            end = _skip_quoted(text, i)
            out.append(text[i:end])
            i = end
            continue
        end = len(text)
        for quote in _QUOTES:
            pos = text.find(quote, i)
            if pos >= 0:
                end = min(end, pos)
        out.append(fn(text[i:end]))
        i = end
    return "".join(out)


def _rewrite_expr(text: str) -> str:
    """递归改写函数调用；引号内原样保留。"""
    out: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch in _QUOTES:
            end = _skip_quoted(text, i)
            out.append(text[i:end])
            i = end
            continue
        if _IDENT_START.match(ch):
            j = i + 1
            while j < n and _IDENT_BODY.match(text[j]):
                j += 1
            name = text[i:j]
            k = j
            while k < n and text[k].isspace():
                k += 1
            if k < n and text[k] == "(":
                close = _find_matching(text, k)
                if close is None:
                    out.append(text[i:])
                    break
                inner = text[k + 1: close]
                args = [_rewrite_expr(arg) for arg in _split_args(inner)]
                handler = _HANDLERS.get(name.lower())
                rewritten = handler(args) if handler else None
                if rewritten is None:
                    rewritten = f"{name}({', '.join(args)})"
                out.append(rewritten)
                i = close + 1
                continue
            out.append(text[i:j])
            i = j
            continue
        out.append(ch)
        i += 1
    return "".join(out)


# ---------------------------------------------------------------- 时间桶
def _parse_interval(text: str) -> tuple[int, str] | None:
    match_literal = _INTERVAL_LITERAL.match(text.strip())
    body = match_literal.group(1) if match_literal else text.strip()
    match = _INTERVAL_TEXT.match(body.strip())
    if not match:
        return None
    amount = int(match.group(1))
    unit = _UNIT_ALIASES.get(match.group(2).lower())
    if not amount or unit is None:
        return None
    return amount, unit


def _ch_interval(amount: int, unit: str) -> str:
    return f"INTERVAL {amount} {unit.upper()}"


def _ch_time_bucket(args: Sequence[str]) -> str | None:
    if len(args) != 2:
        return None
    parsed = _parse_interval(args[0])
    if parsed is None:
        return None
    amount, unit = parsed
    expr = args[1]
    if amount == 1 and unit in _START_OF:
        base = _START_OF[unit]
        # ClickHouse 的 toStartOfWeek 默认周日起；DuckDB date_trunc 是周一。
        if unit == "week":
            return f"{base}({expr}, 1)"
        return f"{base}({expr})"
    return f"toStartOfInterval({expr}, {_ch_interval(amount, unit)})"


def _ch_date_trunc(args: Sequence[str]) -> str | None:
    if len(args) != 2:
        return None
    match_literal = _INTERVAL_LITERAL.match(args[0].strip())
    unit_text = match_literal.group(1) if match_literal else args[0].strip()
    unit = _UNIT_ALIASES.get(unit_text.strip().lower())
    if unit is None:
        return None
    expr = args[1]
    if unit in _START_OF:
        base = _START_OF[unit]
        return f"{base}({expr}, 1)" if unit == "week" else f"{base}({expr})"
    return f"toStartOfInterval({expr}, {_ch_interval(1, unit)})"


def _ch_extract(args: Sequence[str]) -> str | None:
    if len(args) != 1:
        return None
    match = re.match(r"^\s*([A-Za-z]+)\s+FROM\s+(.+)$", args[0], re.IGNORECASE | re.DOTALL)
    if not match:
        return None
    func = _EXTRACT_TO.get(match.group(1).lower())
    if func is None:
        return None
    return f"{func}({match.group(2).strip()})"


# ---------------------------------------------------------------- 字符串函数
def _same(name: str, arity: int | None = None) -> Callable[[Sequence[str]], str | None]:
    def handler(args: Sequence[str]) -> str | None:
        if arity is not None and len(args) != arity:
            return None
        return f"{name}({', '.join(args)})"

    return handler


def _ch_length(args: Sequence[str]) -> str | None:
    if len(args) != 1:
        return None
    return f"lengthUTF8({args[0]})"


def _ch_substr(args: Sequence[str]) -> str | None:
    if len(args) not in (2, 3):
        return None
    # ClickHouse 的 substring 与 DuckDB 一样按 1 起始计数
    return f"substring({', '.join(args)})"


def _ch_strpos(args: Sequence[str]) -> str | None:
    if len(args) != 2:
        return None
    return f"position({args[0]}, {args[1]})"


def _ch_replace(args: Sequence[str]) -> str | None:
    if len(args) != 3:
        return None
    return f"replaceAll({args[0]}, {args[1]}, {args[2]})"


def _ch_split_part(args: Sequence[str]) -> str | None:
    if len(args) != 3:
        return None
    text, delimiter, index = args
    return f"arrayElement(splitByChar({delimiter}, {text}), {index})"


def _ch_starts_with(args: Sequence[str]) -> str | None:
    if len(args) != 2:
        return None
    return f"startsWith({args[0]}, {args[1]})"


def _ch_ends_with(args: Sequence[str]) -> str | None:
    if len(args) != 2:
        return None
    return f"endsWith({args[0]}, {args[1]})"


def _ch_contains(args: Sequence[str]) -> str | None:
    if len(args) != 2:
        return None
    return f"position({args[0]}, {args[1]}) > 0"


def _ch_ifnull(args: Sequence[str]) -> str | None:
    if len(args) != 2:
        return None
    return f"ifNull({args[0]}, {args[1]})"


def _ch_lag(args: Sequence[str]) -> str | None:
    """`LAG(x) OVER (ORDER BY y)` -> CH 的 `lagInFrame(x, 1, NULL)`。

    契约 §4 明确写了这条：CH 的窗口 `lag` 只看当前块。

    **第三个参数不能省**：`lagInFrame(x)` 在**第一行**返回列类型的默认值
    （DateTime 是 `1970-01-01`），而 DuckDB 的 `LAG` 返回 **NULL**。
    实测 SQL-13 因此多出一条假断档（`gap_s = 1790812800`）。
    显式给 `1, NULL` 之后两边都是 NULL —— 这是**让语义与上游一致**，
    不是「为了跑通而改 SQL」。
    """
    if len(args) == 1:
        return f"lagInFrame({args[0]}, 1, NULL)"
    if len(args) == 2:
        return f"lagInFrame({args[0]}, {args[1]}, NULL)"
    if len(args) == 3:
        return f"lagInFrame({', '.join(args)})"
    return None


def _ch_lead(args: Sequence[str]) -> str | None:
    if len(args) == 1:
        return f"leadInFrame({args[0]}, 1, NULL)"
    if len(args) == 2:
        return f"leadInFrame({args[0]}, {args[1]}, NULL)"
    if len(args) == 3:
        return f"leadInFrame({', '.join(args)})"
    return None


def _ch_lead(args: Sequence[str]) -> str | None:
    if len(args) not in (1, 2, 3):
        return None
    return f"leadInFrame({', '.join(args)})"
    if len(args) != 2:
        return None
    return f"ifNull({args[0]}, {args[1]})"


# ---------------------------------------------------------------- 契约要求补的五类
# `docs/contracts/bench-sql.md` §4 明确列出上游五类写法 → ClickHouse 的对应关系。
# 不补这五类，CH 会**静默跑错**（不是报错，是给出另一个数），所以每条都有正负例。
def _ch_stddev_samp(args: Sequence[str]) -> str | None:
    """`STDDEV_SAMP(x)` -> `stddevSamp(x)`。样本标准差（分母 n-1），不是总体。"""
    if len(args) != 1:
        return None
    return f"stddevSamp({args[0]})"


def _ch_stddev_pop(args: Sequence[str]) -> str | None:
    if len(args) != 1:
        return None
    return f"stddevPop({args[0]})"


def _ch_date_diff(args: Sequence[str]) -> str | None:
    """`date_diff('second', a, b)` -> `dateDiff(...)`。只差大小写，但拼错就报错。"""
    if len(args) != 3:
        return None
    return f"dateDiff({', '.join(args)})"


def _ch_date_add(args: Sequence[str]) -> str | None:
    if len(args) != 2:
        return None
    return f"dateAdd({', '.join(args)})"


def _ch_quantile_cont(args: Sequence[str]) -> str | None:
    """`quantile_cont(x, q)` -> `quantileExactInclusive(q)(x)`。

    ## 为什么不是 `quantile`

    `quantile` 在数据量大时走 **reservoir 采样**，是近似值。实测同一份
    4 719 600 行的数据：

        quantile(0.5)               = 39.5780825224815      <- 近似
        quantileExact(0.5)          = 39.54531812988577     <- 精确，但口径不同
        quantileExactInclusive(0.5) = 39.545302279367434    <- 与 DuckDB 逐位相同
        DuckDB quantile_cont(x,0.5) = 39.545302279367434

    `quantileExact` 与 `quantile_cont` 的差别在插值口径：前者取「排在第 k 个的
    那个值」，后者在两相邻值之间做**线性插值**（`quantileExactInclusive` 才是这个口径）。

    契约 §4 写的是「精确分位；近似另用 `quantileTDigest`」，
    但没区分 `quantileExact` 与 `quantileExactInclusive`。实测表明必须用后者。
    近似版（`quantile` / `quantileTDigest`）**基准不许用**。
    """
    if len(args) != 2:
        return None
    value, fraction = args
    return f"quantileExactInclusive({fraction})({value})"


def _ch_quantile_disc(args: Sequence[str]) -> str | None:
    if len(args) != 2:
        return None
    value, fraction = args
    return f"quantileExactLow({fraction})({value})"


def _ch_regexp_extract(args: Sequence[str]) -> str | None:
    if len(args) != 3:
        return None
    return f"regexpExtract({', '.join(args)})"


def _ch_round(args: Sequence[str]) -> str | None:
    if len(args) not in (1, 2):
        return None
    return f"round({', '.join(args)})"


_HANDLERS: dict[str, Callable[[Sequence[str]], str | None]] = {
    # 时间
    "time_bucket": _ch_time_bucket,
    "date_trunc": _ch_date_trunc,
    "extract": _ch_extract,
    "date_diff": _ch_date_diff,
    "datediff": _ch_date_diff,
    "date_add": _ch_date_add,
    # 统计
    "stddev_samp": _ch_stddev_samp,
    "stddev": _ch_stddev_samp,          # DuckDB 的 STDDEV 就是样本标准差
    "stddev_pop": _ch_stddev_pop,
    "quantile_cont": _ch_quantile_cont,
    "quantile_disc": _ch_quantile_disc,
    # 字符串 / 正则
    "length": _ch_length,
    "char_length": _ch_length,
    "character_length": _ch_length,
    "len": _ch_length,
    "lower": _same("lower", 1),
    "lcase": _same("lower", 1),
    "upper": _same("upper", 1),
    "ucase": _same("upper", 1),
    "substr": _ch_substr,
    "substring": _ch_substr,
    "strpos": _ch_strpos,
    "instr": _ch_strpos,
    "replace": _ch_replace,
    "split_part": _ch_split_part,
    "starts_with": _ch_starts_with,
    "ends_with": _ch_ends_with,
    "contains": _ch_contains,
    "regexp_extract": _ch_regexp_extract,
    "ifnull": _ch_ifnull,
    "lag": _ch_lag,
    "lead": _ch_lead,
    "round": _ch_round,
    "now": _same("now", 0),
    "current_timestamp": _same("now", 0),
}


# ---------------------------------------------------------------- 入口
def _normalise_target(target: str) -> str:
    key = str(target).strip().lower().replace("-", "_").replace(" ", "_")
    if key in ("ch", "click_house", "clickhouse_sql"):
        key = "clickhouse"
    if key not in SUPPORTED_DIALECTS:
        raise DialectError(f"不支持的方言 {target!r}；可选：{SUPPORTED_DIALECTS}")
    return key


def _normalise_limit(sql: str) -> str:
    def repl(match: re.Match[str]) -> str:
        offset, count = match.group(1), match.group(2)
        return f"LIMIT {count} OFFSET {offset}"

    return _map_unquoted(sql, lambda segment: _LIMIT_COMMA.sub(repl, segment))


# `COUNT(*) FILTER (WHERE p)` / `SUM(x) FILTER (WHERE p)` 等。
# `(.*?)` 用 `[^()]*` 代替：`COUNT(*)` 里没有括号，但**必须**让 `*` 能被单独识别，
# 否则 `COUNT(*, p)` 这种既不是 COUNT(*) 也不是 sumIf 的畸形函数就会被生成出来
# —— 实测喂给 ClickHouse 报 `Incorrect number of arguments for aggregate function`。
_FILTER_CALL = re.compile(
    r"\b(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*([^()]*?)\s*\)\s*"
    r"FILTER\s*\(\s*WHERE\s+(.+?)\)",
    re.IGNORECASE | re.DOTALL)

_FILTER_TO_CH = {
    "COUNT": "countIf",
    "SUM": "sumIf",
    "AVG": "avgIf",
    "MIN": "minIf",
    "MAX": "maxIf",
}


def _ch_filter_aggregates(sql: str) -> str:
    """`COUNT(*) FILTER (WHERE p)` -> `countIf(p)`。

    契约 §4 把它列为必补项：CH 没有 `FILTER` 子句，**不翻译就报语法错**
    （比静默跑错好，但仍要翻译，否则这一条基准跑不起来）。

    `COUNT(*)` 的 `*` 要丢掉：`countIf(p)` 不接受参数列；
    `SUM(x) FILTER (WHERE p)` 则要保留 `x`：`sumIf(x, p)` —— 两者形状不同，
    混着改会算错。
    """
    def repl(match: re.Match[str]) -> str:
        func = match.group(1).upper()
        inner = match.group(2).strip()
        predicate = match.group(3).strip()
        target = _FILTER_TO_CH[func]
        if func == "COUNT" and inner in ("*", ""):
            return f"{target}({predicate})"
        return f"{target}({inner}, {predicate})"

    previous = None
    current = sql
    while previous != current:              # 允许嵌套/多重 FILTER
        previous = current
        current = _FILTER_CALL.sub(repl, current)
    return current


_BITWISE = re.compile(r"\b(\w+)\s*&\s*(\d+)\b")

# `DATE '2026-10-01'` / `TIMESTAMP '...'` 这类带类型前缀的日期字面量。
_DATE_LITERAL = re.compile(r"\bDATE\s*'([^']*)'", re.IGNORECASE)


def _ch_date_literals(sql: str) -> str:
    """`DATE '2026-10-01'` -> `'2026-10-01'`（纯字符串）。

    ## 为什么要去掉类型前缀

    基准里 `date` 列在 Parquet 中是 **string**（分区键原样落盘），
    而 `DATE '…'` 是 `Date` 类型。ClickHouse 对
    `String = Date` 直接报
    `Code: 386. There is no supertype for types String, Date`
    —— 它不是「比较失败」，是「连做比较都不可能」。

    DuckDB 会隐式把两侧都转成 DATE 再比，所以那条 SQL 在 DuckDB 侧是通的。
    这里去掉类型前缀，让 CH 做字符串比较：日期一律是
    `YYYY-MM-DD` 定宽格式，字典序等价于时间序，比较结果与 DuckDB 一致。
    """
    return _DATE_LITERAL.sub(lambda m: "'" + m.group(1) + "'", sql)


# `CAST(x AS DATE)` —— CH 里这产生 Date 类型，与 String 列比较会 386。
_CAST_AS_DATE = re.compile(r"\bCAST\s*\(\s*([^()]+?)\s+AS\s+DATE\s*\)", re.IGNORECASE)


def _ch_cast_as_date(sql: str) -> str:
    """`CAST(x AS DATE)` -> `toDate(x)` 然后转成字符串。

    契约 §4 的三条基准（SQL-17）要拿 `CAST(epoch_utc AS DATE)` 去和
    `agg_hour.date`（String）等值连接。CH 里 `Date = String` 报 386，
    所以这里统一成字符串：`toString(toDate(x))`。

    DuckDB 侧 `CAST(timestamp AS DATE)` 与 String 比较同样会隐式转换，
    两边最终都是 `YYYY-MM-DD`，结果一致。
    """
    return _CAST_AS_DATE.sub(
        lambda m: f"toString(toDate({m.group(1).strip()}))", sql)


def _ch_bitwise_and(sql: str) -> str:
    """`quality_flag & 4` -> `bitAnd(quality_flag, 4)`。

    只翻「标识符 & 整数字面量」这一种形状 —— 这是契约里唯一用到的。
    不翻任意 `a & b`：表达式里出现位与往往说明它在算别的东西，
    乱改会把 `a & (b | c)` 之类的组合弄坏。
    """
    return _BITWISE.sub(lambda m: f"bitAnd({m.group(1)}, {m.group(2)})", sql)


def to_duckdb(sql: str) -> str:
    """DuckDB 端只规范 ``LIMIT``；其余保持上游写法。"""
    return _normalise_limit(sql)


def to_clickhouse(sql: str) -> str:
    """把 DuckDB 兼容子集翻译成 ClickHouse。

    顺序有讲究：

    1. `LIMIT offset, count` 先规范化（后面几条都按规范形式写）；
    2. `FILTER (WHERE …)` -> `countIf` **必须在**函数改写之前 ——
       否则 `_rewrite_expr` 会把 `FILTER` 当普通标识符原样留下；
    3. `&` -> `bitAnd` 在函数改写之前，避免 `bitAnd` 里的 `(` 被 `_rewrite_expr`
       当函数调用再走一遍（它是幂等的，但多走一遍容易出意外）；
    4. 最后递归改写函数名。
    """
    text = _normalise_limit(sql)
    text = _ch_filter_aggregates(text)
    text = _ch_bitwise_and(text)
    text = _ch_date_literals(text)
    text = _ch_cast_as_date(text)
    return _rewrite_expr(text)


def translate(sql: str, target: str) -> str:
    """按目标方言翻译。``target`` 取 ``duckdb`` / ``clickhouse``（``ch`` 也认）。"""
    key = _normalise_target(target)
    return to_duckdb(sql) if key == "duckdb" else to_clickhouse(sql)
