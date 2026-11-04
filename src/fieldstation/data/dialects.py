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
    "SUPPORTED_DIALECTS",
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


_HANDLERS: dict[str, Callable[[Sequence[str]], str | None]] = {
    # 时间
    "time_bucket": _ch_time_bucket,
    "date_trunc": _ch_date_trunc,
    "extract": _ch_extract,
    # 字符串
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
    "ifnull": _ch_ifnull,
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


def to_duckdb(sql: str) -> str:
    """DuckDB 端只规范 ``LIMIT``；其余保持上游写法。"""
    return _normalise_limit(sql)


def to_clickhouse(sql: str) -> str:
    """把 DuckDB 兼容子集翻译成 ClickHouse。"""
    return _normalise_limit(_rewrite_expr(sql))


def translate(sql: str, target: str) -> str:
    """按目标方言翻译。``target`` 取 ``duckdb`` / ``clickhouse``（``ch`` 也认）。"""
    key = _normalise_target(target)
    return to_duckdb(sql) if key == "duckdb" else to_clickhouse(sql)
