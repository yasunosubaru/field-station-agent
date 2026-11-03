"""yaml_lite —— 严格 YAML 子集解析器（零依赖）。

为什么不用 PyYAML：本仓库的硬约束是**零第三方依赖**（README 的 ``deps-0`` 徽章、
CI 不带 requirements）。工作流规格只需要 YAML 的一个很小的子集，所以这里实现一个
**只认这个子集**的解析器：认不出的写法直接报错，绝不猜。

支持的写法
----------
* 映射（按缩进嵌套）与序列（``- ``）
* 标量：裸字符串、单引号 / 双引号字符串、整数、浮点、``true`` / ``false``、
  ``null`` / ``~``
* 序列里的映射（``- key: value``，后续键与第一个键同缩进）
* 块标量 ``|``（保留换行）与 ``>``（折成空格）
* 行内序列 ``[a, b]``（元素只能是标量）
* 注释：行首 ``#``，或空白后的 ``#``；引号内的 ``#`` 不算注释
* 首行 ``---``（只允许出现在第一行）

不支持的写法（遇到即报错，带行号）
----------------------------------
锚点 / 别名 / 标签、多文档、复杂键（``? ``）、行内映射 ``{...}``、
制表符缩进、重复键、块标量里的空行（本仓库的规格用不到，写出来会被合并）。

对外接口
--------
``loads(text) -> object``
``load(path) -> object``
``YamlError``（``.line`` 是 1 起的行号）
"""
from __future__ import annotations

import re
from pathlib import Path

__all__ = ["YamlError", "load", "loads"]


class YamlError(ValueError):
    """解析失败。``line`` 是 1 起的行号；没有行号时为 ``None``。"""

    def __init__(self, message: str, line: int | None = None) -> None:
        self.line = line
        self.reason = message
        super().__init__(f"第 {line} 行：{message}" if line else message)


class _Line:
    __slots__ = ("indent", "text", "number")

    def __init__(self, indent: int, text: str, number: int) -> None:
        self.indent = indent
        self.text = text
        self.number = number

    @property
    def is_item(self) -> bool:
        return self.text == "-" or self.text.startswith("- ")


_INT_RE = re.compile(r"^[+-]?\d+$")
_FLOAT_RE = re.compile(r"^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$")


def _strip_comment(text: str) -> str:
    """去掉不在引号里的 ``#`` 注释；返回去掉尾部空白的正文。

    引号只在**标量起点**才打开：``key: don't`` 里的撇号是普通字符，
    而 ``key: 'don''t'`` 与 ``key: "a # b"`` 按 YAML 处理。这条规则的目的是
    不让一句英文里的撇号把整行判成「引号没闭合」。
    """
    quote: str | None = None
    scalar_start = True
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if quote:
            if ch == "\\" and quote == '"':
                i += 2
                continue
            if ch == quote:
                if quote == "'" and i + 1 < n and text[i + 1] == "'":
                    i += 2
                    continue
                quote = None
                scalar_start = False
            i += 1
            continue
        if ch in " \t":
            i += 1
            continue
        if ch == "#" and (i == 0 or text[i - 1] in " \t"):
            return text[:i].rstrip()
        if ch in ("'", '"') and scalar_start:
            quote = ch
            i += 1
            continue
        if ch == ":":
            scalar_start = True
            i += 1
            continue
        if ch in "[,":
            scalar_start = True
            i += 1
            continue
        if ch == "-" and (i == 0 or text[i - 1] in " \t"):
            # 列表项前缀 `- `；紧跟着非空白时它是负数/连字符正文
            scalar_start = i + 1 < n and text[i + 1] in " \t"
            i += 1
            continue
        scalar_start = False
        i += 1
    if quote:
        raise YamlError("引号没有闭合")
    return text.rstrip()


def _split_flow(body: str, line: int) -> list[str]:
    """把 ``[a, "b,c", 3]`` 的中间部分切成元素文本。"""
    parts: list[str] = []
    current: list[str] = []
    quote: str | None = None
    depth = 0
    i = 0
    while i < len(body):
        ch = body[i]
        if quote:
            current.append(ch)
            if ch == "\\" and quote == '"' and i + 1 < len(body):
                current.append(body[i + 1])
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in ("'", '"'):
            quote = ch
            current.append(ch)
        elif ch in "[{":
            depth += 1
            current.append(ch)
        elif ch in "]}":
            depth -= 1
            current.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(current).strip())
            current = []
        else:
            current.append(ch)
        i += 1
    if quote:
        raise YamlError("行内序列的引号没有闭合", line)
    if depth != 0:
        raise YamlError("行内序列的括号不配对", line)
    tail = "".join(current).strip()
    if tail or parts:
        parts.append(tail)
    return [p for p in parts if p != ""]


def _unquote(text: str, line: int) -> str:
    if text.startswith("'"):
        if not text.endswith("'") or len(text) < 2:
            raise YamlError("单引号字符串没有闭合", line)
        return text[1:-1].replace("''", "'")
    if text.startswith('"'):
        if not text.endswith('"') or len(text) < 2:
            raise YamlError("双引号字符串没有闭合", line)
        body = text[1:-1]
        out: list[str] = []
        i = 0
        escapes = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/", "0": "\0"}
        while i < len(body):
            ch = body[i]
            if ch != "\\":
                out.append(ch)
                i += 1
                continue
            if i + 1 >= len(body):
                raise YamlError("双引号字符串以反斜杠结尾", line)
            nxt = body[i + 1]
            if nxt == "u":
                if i + 5 >= len(body) + 1:
                    raise YamlError("\\u 转义不完整", line)
                try:
                    out.append(chr(int(body[i + 2:i + 6], 16)))
                except ValueError as exc:
                    raise YamlError(f"\\u 转义不合法：{body[i:i + 6]}", line) from exc
                i += 6
                continue
            out.append(escapes.get(nxt, nxt))
            i += 2
        return "".join(out)
    return text


class _Parser:
    def __init__(self, text: str) -> None:
        self.lines: list[_Line] = []
        self.pos = 0
        self._read(text)

    # ------------------------------------------------------------------ 读入
    def _read(self, text: str) -> None:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        for number, raw in enumerate(text.split("\n"), 1):
            leading = raw[: len(raw) - len(raw.lstrip(" \t"))]
            if "\t" in leading:
                raise YamlError("缩进里不能用制表符", number)
        for number, raw in enumerate(text.split("\n"), 1):
            if not raw.strip():
                continue
            stripped = raw.lstrip(" ")
            indent = len(raw) - len(stripped)
            if stripped.startswith("#"):
                continue
            if stripped == "---":
                if self.lines:
                    raise YamlError("只支持单文档，--- 只能出现在第一行", number)
                continue
            if stripped == "...":
                continue
            try:
                body = _strip_comment(stripped)
            except YamlError as exc:
                if exc.line is None:
                    raise YamlError(exc.reason, number) from exc
                raise
            if body:
                self.lines.append(_Line(indent, body, number))

    # ------------------------------------------------------------------ 入口
    def parse(self) -> object:
        if not self.lines:
            return None
        first = self.lines[0]
        value = self._parse_block(first.indent)
        if self.pos != len(self.lines):
            ln = self.lines[self.pos]
            raise YamlError(f"缩进不一致（前面已经结束，这里又多出内容：{ln.text!r}）", ln.number)
        return value

    # ------------------------------------------------------------------ 结构
    def _parse_block(self, indent: int) -> object:
        if self.pos >= len(self.lines):
            return None
        line = self.lines[self.pos]
        if line.indent < indent:
            return None
        if line.is_item:
            return self._parse_sequence(indent)
        return self._parse_mapping(indent)

    def _parse_mapping(self, indent: int) -> dict:
        result: dict = {}
        while self.pos < len(self.lines):
            line = self.lines[self.pos]
            if line.indent < indent:
                break
            if line.indent > indent:
                raise YamlError(f"缩进比同级的键更深：{line.text!r}", line.number)
            if line.is_item:
                break
            key, rest = _split_key(line.text, line.number)
            if key in result:
                raise YamlError(f"重复键：{key!r}", line.number)
            self.pos += 1
            result[key] = self._value_after_key(rest, indent, line.number)
        return result

    def _parse_sequence(self, indent: int) -> list:
        result: list = []
        while self.pos < len(self.lines):
            line = self.lines[self.pos]
            if line.indent != indent or not line.is_item:
                break
            rest = line.text[1:].strip()
            self.pos += 1
            if rest == "":
                if self.pos < len(self.lines) and self.lines[self.pos].indent > indent:
                    result.append(self._parse_block(self.lines[self.pos].indent))
                else:
                    result.append(None)
                continue
            if rest[0] in ("'", '"', "[", "{"):
                result.append(self._parse_scalar(rest, line.number))
                continue
            if _looks_like_key(rest):
                mapping: dict = {}
                key, value_text = _split_key(rest, line.number)
                mapping[key] = self._value_after_key(value_text, indent + 2, line.number)
                # 后续与第一个键同缩进的键属于同一个映射
                while self.pos < len(self.lines):
                    nxt = self.lines[self.pos]
                    if nxt.indent != indent + 2 or nxt.is_item:
                        break
                    if nxt.indent > indent + 2:
                        raise YamlError(f"缩进比同级的键更深：{nxt.text!r}", nxt.number)
                    k2, v2 = _split_key(nxt.text, nxt.number)
                    if k2 in mapping:
                        raise YamlError(f"重复键：{k2!r}", nxt.number)
                    self.pos += 1
                    mapping[k2] = self._value_after_key(v2, indent + 2, nxt.number)
                result.append(mapping)
                continue
            result.append(self._parse_scalar(rest, line.number))
            if self.pos < len(self.lines) and self.lines[self.pos].indent > indent:
                nxt = self.lines[self.pos]
                raise YamlError("标量列表项后面不能有更深缩进的内容", nxt.number)
        return result

    # ------------------------------------------------------------------ 值
    def _value_after_key(self, rest: str, parent_indent: int, line_number: int) -> object:
        if rest == "":
            if self.pos < len(self.lines):
                nxt = self.lines[self.pos]
                # 嵌套映射/序列通常更深；序列也允许与键同缩进（YAML 的常见写法）。
                if nxt.indent > parent_indent:
                    return self._parse_block(nxt.indent)
                if nxt.indent == parent_indent and nxt.is_item:
                    return self._parse_sequence(parent_indent)
            return None
        if rest in ("|", "|-", "|+", ">", ">-", ">+"):
            return self._block_scalar(rest, parent_indent)
        return self._parse_scalar(rest, line_number)

    def _block_scalar(self, marker: str, parent_indent: int) -> str:
        style = marker[0]
        chomp = marker[1] if len(marker) > 1 else ""
        collected: list[str] = []
        block_indent: int | None = None
        while self.pos < len(self.lines):
            line = self.lines[self.pos]
            if line.indent <= parent_indent:
                break
            if block_indent is None:
                block_indent = line.indent
            if line.indent < block_indent:
                raise YamlError("块标量的缩进回退", line.number)
            collected.append(" " * (line.indent - block_indent) + line.text)
            self.pos += 1
        if style == "|":
            body = "\n".join(collected)
        else:
            body = " ".join(collected)
        if chomp == "-":
            return body
        return body + "\n" if body else body

    def _parse_scalar(self, text: str, line: int) -> object:
        text = text.strip()
        if text == "":
            return None
        if text.startswith("[") or text.startswith("{"):
            if not text.endswith("]") and not text.endswith("}"):
                raise YamlError("行内集合没有闭合", line)
            if text.startswith("{"):
                raise YamlError("不支持行内映射 {...}，请用缩进写法", line)
            inner = text[1:-1].strip()
            if not inner:
                return []
            return [self._parse_scalar(part, line) for part in _split_flow(inner, line)]
        if text[0] in ("'", '"'):
            return _unquote(text, line)
        lowered = text.lower()
        if lowered in ("null", "~"):
            return None
        if lowered == "true":
            return True
        if lowered == "false":
            return False
        if _INT_RE.match(text):
            return int(text)
        if _FLOAT_RE.match(text) and ("." in text or "e" in lowered):
            return float(text)
        return text


def _looks_like_key(text: str) -> bool:
    """``key:`` / ``key: value`` 且冒号在引号外、后面是空白或行尾。"""
    quote: str | None = None
    i = 0
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == "\\" and quote == '"':
                i += 2
                continue
            if ch == quote:
                if quote == "'" and i + 1 < len(text) and text[i + 1] == "'":
                    i += 2
                    continue
                quote = None
        elif ch in ("'", '"'):
            quote = ch
        elif ch == ":" and (i + 1 == len(text) or text[i + 1] in " \t"):
            return i > 0
        i += 1
    return False


def _split_key(text: str, line: int) -> tuple[str, str]:
    quote: str | None = None
    i = 0
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == "\\" and quote == '"':
                i += 2
                continue
            if ch == quote:
                if quote == "'" and i + 1 < len(text) and text[i + 1] == "'":
                    i += 2
                    continue
                quote = None
        elif ch in ("'", '"'):
            quote = ch
        elif ch == ":" and (i + 1 == len(text) or text[i + 1] in " \t"):
            raw_key = text[:i].strip()
            if not raw_key:
                raise YamlError("键不能为空", line)
            if raw_key[0] in ("'", '"'):
                key = _unquote(raw_key, line)
            else:
                key = raw_key
            if not key:
                raise YamlError("键不能为空", line)
            return key, text[i + 1:].strip()
        i += 1
    raise YamlError(f"不是 key: value 形状：{text!r}", line)


def loads(text: str) -> object:
    """解析一段 YAML 子集文本。"""
    return _Parser(text).parse()


def load(path: str | Path) -> object:
    """按 UTF-8（含 BOM 容错）读取并解析一个 YAML 文件。"""
    raw = Path(path).read_text(encoding="utf-8-sig")
    return loads(raw)
