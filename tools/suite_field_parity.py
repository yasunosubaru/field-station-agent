#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""suite_field_parity.py —— 从 A（原版）/ B（重实现）源码抽出界面字段并逐项对照。

## 为什么要有这个工具

EV-30 的验收口径是「原版字段逐项对照，对照表 ≥60 个字段，差异数 0」。
手抄一张表没有价值：抄完就腐坏，而且无法证明表里的每一行来自真代码。
所以这张表必须**由脚本从源码生成**，每个字段都带 ``文件:行号``，
谁都能顺着行号回去看原文。这也是本工具不接受任何「补充字段」参数的原因——
一旦允许人工加行，表就不再是证据。

## 三个事实决定了口径（都是查代码得出的，不是猜的）

1. **A 侧在哪**：``逆向/01_解包/app/view/`` 下 81 个 HTML（另有 20 个 JS 里也拼控件
   markup）。原版把「控件」写成 ``<input|select|textarea name=... id=...>``，
   标签文字走 ``data-lang-xxx`` 再由 ``languageSupport/en.js`` 翻成英文。
2. **B 侧在哪**：两套。
   * 套件台外壳与高频页在 ``packages/app/src/web/panels/*.js|*.html``，
     控件用 ``data-el`` / ``data-term`` / ``data-adddev`` 等**分组绑定**而不是 id；
   * 14 个 Configuration 页在 ``packages/view/src/config/*.ts``，**它们不写 HTML**，
     而是声明 ``fragmentPath: './../positionConfig/positionConfig.html'``，
     由 ``config-host.ts`` 的 ``fragments.load()`` 从 ``<appRoot>/view`` 读原版片段塞进 DOM。
     也就是说这些页面**跑的就是原版 HTML 本身**（见 ``config-host.ts`` 第 282–289 行）。
3. **A×B 的配对**不以我的判断为准，以仓库自带的 ``tools/gui_coverage_map.json`` 为准。
   它已经把每个原版页面映射到 B 的实现文件，并且写明了 disposition。

## 因此本工具的分类规则

* 若某个 entry 的 B 文件声明了 ``fragmentPath``，且其文件名与 A 文件同名
  → B 渲染的就是 A 那份 HTML，同一份 DOM，判 ``matched``（方法记 ``fragment``）；
* 否则在**同一个 entry 内**按「归一化键名」配对（``startDate`` ≡ ``start-date``）
  → 配上 ``matched``，B 多出的 ``b_only``，A 多出的 ``a_only``；
* HTML 注释里的控件**不计入**（浏览器不渲染它们，算进去就是假差异）；
* ``逆向/01_解包`` 不存在或某个 A 文件缺失 → 该行判 ``unverified``，
  **绝不编造 A 侧内容**（``unverified`` 不计入 ``mismatches``，因为它不是「差异」，
  而是「没核对」）。

## 两个计数口径（都要报，判分看前者）

表里**一行 = 一个 DOM 元素**，但**一个字段可能占多行**：radio / checkbox 组的每个
取值各是一个 ``<input>``。所以：

* **去重字段数** = 不同 ``(页面, 归一化字段名)`` 的个数 —— EV-30 判分用这个；
* **DOM 元素数** = 表的行数 —— 用来看「具体哪个取值缺失」。

``mismatches = 去重 b_only + 去重 a_only``。按去重算，因为「补一个选项」与
「补一个字段」是两件事，契约判的是后者。逐元素口径的差异数也一并输出
（``element_mismatches``）以便对照。

## 用法

::

    python tools/suite_field_parity.py            # 生成 docs/operations/suite-field-parity.md
    python tools/suite_field_parity.py --check     # 只校验产物是否与重新生成的一致
    python tools/suite_field_parity.py --json      # 机器可读摘要

## 退出码

* ``0`` 成功（``--check`` 时为「产物存在且逐字节一致」）
* ``1`` ``--check`` 发现产物缺失/陈旧，或去重字段数 < 60
* ``2`` 输入不可用（``gui_coverage_map.json`` 缺失/损坏，或 B 侧一个字段都抽不到）

字段级 ``mismatches`` **不进退出码**：它是被汇报的度量，不是构建失败条件。
理由见下方 ``note_exit_semantics``——EV-30 的判分要读的是产物里的数字，
如果把「有差异」也映射成非零退出码，``--check`` 就无法同时表达「产物陈旧」
和「字段对不齐」这两件完全不同的事。

## 约束

* 只用标准库；**零写操作**除了目标产物这一个路径；
* 输出确定：同样的源码生成同样的字节，``--check`` 才有意义（不写时间戳/绝对路径）。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional, Sequence

ROOT = Path(__file__).resolve().parents[1]

A_VIEW = ROOT / "逆向" / "01_解包" / "app" / "view"
A_LANG = A_VIEW / "languageSupport" / "en.js"
B_PACKAGES = ROOT / "逆向" / "04_重实现" / "packages"
MAP_PATH = ROOT / "tools" / "gui_coverage_map.json"
DEFAULT_OUT = ROOT / "docs" / "operations" / "suite-field-parity.md"

#: EV-30 要求对照表至少 60 个字段。少于这个数就说明口径漏了，要报出来。
MIN_FIELDS = 60

#: 只对照「B 声称做到过」的条目。``not_applicable`` / ``a_only`` 本来就没有 B 侧，
#: 把它们算成差异是错的——那会把「明确不做」误报成「漏做」。
IN_SCOPE_DISPOSITIONS = ("covered", "partial")

#: 控件标签。``[^>]*?`` 允许属性跨行（这些文件里确实有跨行标签）。
CONTROL_RE = re.compile(r"<\s*(input|select|textarea)\b([^>]*?)/?>", re.I | re.S)

#: A 侧另有一批**状态控件**不是 ``<input>`` 而是 ``<button>``：原版用 CSS 给按钮
#: 画开关/复选框外观，状态存在 ``class`` 上。实测证据：``deviceRestart.html`` 的
#: ``<button id="erase-nvm" class="erase-checkbox">`` 与
#: ``positionConfig.html`` 的 ``<button id="rtk-on-off" class="select-device-btn">``；
#: B 侧也确实按 id 去查它们（``config/deviceRestart.ts`` 有 ``querySelector('#erase-nvm')``）。
#: 不收进来，表里就凭空少掉这些原版字段。
#:
#: 但**只收状态控件**：``Apply`` / ``Cancel`` / ``Add`` 这类动作按钮不是字段，
#: 按 class 白名单挑，避免把 56 个按钮全灌进表里凑数。
A_BUTTON_RE = re.compile(r"<\s*button\b([^>]*?)/?>", re.I | re.S)
A_TOGGLE_CLASS_MARKERS: tuple[str, ...] = (
    "select-device-btn",     # 开关
    "erase-checkbox",        # 复选框
    "export-checkbox",       # 复选框
    "toggle-switch",         # 开关
    "toggle-button",         # 开关
    "spanconfig-dropdown",   # 下拉选择（值域字段）
    "positionconfig-dropdown",
    "networking-dropdown",
)

#: 属性解析。手写状态机没必要，但必须**解析成字典**再取值，
#: 不能对整个标签正则糊一遍——否则 ``data-el="a" data-el="b"`` 这种取哪个人为决定。
ATTR_RE = re.compile(
    r"""([A-Za-z_:@][-A-Za-z0-9_:.@]*)"""
    r"""(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?"""
)

#: B 侧的分组绑定属性，按优先级排列。第一个「稳定」的即该控件的字段标识。
#: 这份名单是从实测出现的组合里挑的（见文档「B 侧绑定属性」小节），
#: 不用「所有 data-*」是因为 ``data-tone="good"`` 之类的状态标记不是字段。
B_KEY_ATTRS: tuple[str, ...] = (
    "data-el",
    "data-term",
    "data-adddev",
    "data-cfg",
    "data-reset",
    "data-adv",
    "data-poi-field",
    "data-config",
    "data-spec",
    "data-track-metric",
    "data-track-system",
    "data-basemap",
    "name",
    "id",
)

#: A 侧字段标识优先级：``name`` 是表单语义名，比 ``id`` 稳定（id 有的页面还没填）。
A_KEY_ATTRS: tuple[str, ...] = ("name", "id")

#: 这些 type 是人点的按钮，不是可填/可读的数据字段。
NON_FIELD_TYPES = {"button", "submit", "reset"}

#: ``fragmentPath`` 之类指向原版片段的字符串字面量。
FRAGMENT_RE = re.compile(r"""['"]([^'"]*\.html)['"]""")

#: ``data-lang-xxx`` → 到 en.js 查英文。
DATA_LANG_RE = re.compile(r"data-lang-([A-Za-z0-9_\-]+)")

#: ``<span>标签</span>``，B 侧靠它显示字段名。
SPAN_TEXT_RE = re.compile(r"<span[^>]*>([^<]{1,80})</span>")


# --------------------------------------------------------------------- 模型
@dataclass(frozen=True)
class Field:
    """一个界面字段。``line`` 是 1 起的行号，必须可回溯。"""

    side: str          # "A" / "B"
    key: str           # 字段标识（A 用 name/id，B 用绑定值）
    attr: str          # 取自哪个属性：name / id / data-el …
    label: str         # 显示名，抽不到就是空串（不编造）
    tag: str           # input / select / textarea
    ctype: str         # type 属性，小写；无则空串
    file: str          # 相对仓库根的 POSIX 路径
    line: int

    @property
    def nkey(self) -> str:
        """归一化键名：小写并去掉所有非字母数字。

        ``startDate`` / ``start-date`` / ``START_DATE`` 都归一成 ``startdate``。
        B 侧把短横线当分隔符，A 侧用驼峰，不归一就一个都对不上。
        """
        return normalize(self.key)

    @property
    def where(self) -> str:
        return f"`{self.file}:{self.line}`"


@dataclass
class Row:
    """对照表的一行 = **一个 DOM 元素**。

    一行不等于一个「字段」：radio/checkbox 组的每个选项都是独立的 ``<input>``，
    却在语义上是同一个字段。逐元素保留行是为了能看出「哪一个选项缺失」，
    而计数另有去重口径（见 :attr:`Report.unique_fields`）。
    """

    page: str
    field_key: str
    label: str
    b_field: Optional[Field]
    a_field: Optional[Field]
    verdict: str        # matched / b_only / a_only / unverified
    method: str         # key / fragment / none

    @property
    def nkey(self) -> str:
        return normalize(self.field_key)

    @property
    def namespace(self) -> str:
        """字段所属的绑定命名空间。

        **必须进去重键**，否则会把两件不同的事并成一个字段：
        ``manage.js`` 的终端对话框用 ``data-term="path"``，加设备对话框用
        ``data-adddev="path"``——同名，但是两个地方的两个字段。
        带上命名空间后它们各自独立；而 radio 组天然共享同一个 ``name``，
        仍在同一命名空间里，照常合并。

        取 A 侧的属性名（fragment 行两侧同源）；只有 B 侧时取 B 的。
        """
        f = self.a_field or self.b_field
        return f.attr if f else ""

    @property
    def group_key(self) -> tuple[str, str, str]:
        """去重键：**(页面, 命名空间, 归一化字段名)**。

        页面必须带：不同页面的 ``port`` 是两件不相干的事。
        命名空间必须带：同页的 ``data-term=path`` 与 ``data-adddev=path``
        是两个字段（见 :attr:`namespace`）。
        类型/元素序号**不能**带：``cv-affix`` 的 PREFIX / SUFFIX 两个 radio
        共享 ``name="cv-affix"``，带序号就拆成两个字段，去重就白做了。
        """
        return (self.page.lower(), self.namespace.lower(), self.nkey)

    @property
    def sort_key(self) -> tuple:
        return (
            self.page.lower(),
            self.field_key.lower(),
            self.a_field.file if self.a_field else "",
            self.a_field.line if self.a_field else 0,
            self.b_field.file if self.b_field else "",
            self.b_field.line if self.b_field else 0,
        )


@dataclass
class Report:
    rows: list[Row]
    entries_seen: int
    entries_in_scope: int
    entries_skipped: list[str]
    a_root_present: bool
    counts: dict

    # ---- 两个口径 ----
    @property
    def elements(self) -> int:
        """DOM 元素数 = 表的行数。保留它是因为「哪个选项漏了」要靠行去看。"""
        return len(self.rows)

    @property
    def total(self) -> int:
        """**去重字段数**：不同 (页面, 归一化字段名)。这是 EV-30 要的那个数。"""
        return len(self.unique_fields)

    @property
    def unique_fields(self) -> list[Row]:
        """每个去重字段的代表行。

        代表行取**该组里证据最强的那个元素**：``matched`` > ``unverified``
        > ``b_only`` / ``a_only``。这样「字段是否存在」的判断以两侧确实对上的
        那条为准，而不是被同组另一个没对上的选项带偏。

        排序在组内用 ``sort_key``，保证多次运行结果一致（``--check`` 依赖这点）。
        """
        rank = {"matched": 0, "unverified": 1, "b_only": 2, "a_only": 3}
        best: dict[tuple[str, str, str], Row] = {}
        for r in sorted(self.rows, key=lambda x: (rank.get(x.verdict, 9), x.sort_key)):
            best.setdefault(r.group_key, r)
        return [best[k] for k in sorted(best)]

    @property
    def unique_counts(self) -> dict:
        counts = {"matched": 0, "b_only": 0, "a_only": 0, "unverified": 0}
        for r in self.unique_fields:
            counts[r.verdict] = counts.get(r.verdict, 0) + 1
        return counts

    @property
    def mismatches(self) -> int:
        """**去重后的差异字段数** = 去重 ``b_only`` + 去重 ``a_only``。

        用去重口径，因为同一字段的两个 radio 不该被算成两处差异——
        补一个选项和补一个字段是两件事，EV-30 判的是后者。
        """
        c = self.unique_counts
        return c.get("b_only", 0) + c.get("a_only", 0)

    @property
    def element_mismatches(self) -> int:
        """逐元素口径的差异数。与 :attr:`mismatches` 一起报，方便对照。"""
        return self.counts.get("b_only", 0) + self.counts.get("a_only", 0)

    @property
    def merged(self) -> int:
        """被合并掉的重复元素数 = 元素数 − 去重字段数。"""
        return self.elements - self.total


# --------------------------------------------------------------------- 工具函数
def normalize(text: str) -> str:
    """键名归一化。刻意只留 ``[a-z0-9]``：两侧命名风格差异全在分隔符上。"""
    return re.sub(r"[^a-z0-9]+", "", (text or "").lower())


def rel_to_root(path: Path) -> str:
    """把路径变成仓库相对的 POSIX 串。

    绝不写绝对路径：产物要能入库，绝对路径会把别人机器上的目录结构写进仓库。
    """
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:  # pragma: no cover —— 只有把工具指到仓库外才会走到
        return path.as_posix()


def read_text(path: Path) -> str:
    """按 UTF-8 读，坏的字节替换掉而不是崩。

    这些文件是别人的解包产物，夹着偶发的坏字节；为了一个字节让整个对照表生成不了
    不划算，但也不能静默——调用方会记录文件本身，人工可以回查。
    """
    return path.read_text(encoding="utf-8", errors="replace")


def parse_attrs(body: str) -> dict[str, str]:
    """把标签体解析成属性字典（名字小写）。

    重复属性保留**第一个**——HTML 规范就是这么处理的，与浏览器一致。
    """
    attrs: dict[str, str] = {}
    for m in ATTR_RE.finditer(body):
        name = m.group(1).lower()
        if name in attrs:
            continue
        value = m.group(2)
        if value is None:
            value = m.group(3)
        if value is None:
            value = m.group(4)
        attrs[name] = "" if value is None else value
    return attrs


def is_stable_token(value: str) -> bool:
    """值是否可用作字段标识。

    ``${name}`` 这种模板占位是**运行时才算得出来**的，静态抽出来的是变量名而不是
    字段名。把它们算进对照表就是造假——所以直接排除，并在统计里单列。
    """
    if not value:
        return False
    if "${" in value or "{" in value or "}" in value:
        return False
    return bool(re.fullmatch(r"[A-Za-z0-9_\-\.:/]+", value))


def load_en_table(path: Path) -> dict[str, str]:
    """读 ``languageSupport/en.js``，得到 ``KEY → 英文``。

    只用于**显示名**。它不参与配对——配对只认键名。所以这里解析不完整也不会
    让对照结论出错，最多少几个标签。这一点是刻意设计的：标签表是 92 KB 的
    手写 JS，指望用正则百分百解析它不现实，也不该让显示名影响判分。
    """
    table: dict[str, str] = {}
    if not path.exists():
        return table
    text = read_text(path)
    pattern = re.compile(r"""['"]([A-Za-z0-9_\-]+)['"]\s*:\s*(['"])(.*?)\2""")
    for m in pattern.finditer(text):
        table.setdefault(m.group(1).upper(), m.group(3))
    return table


def resolve_lang(key: str, table: dict[str, str]) -> str:
    if not key or not table:
        return ""
    return table.get(key.upper().replace("-", "_"), "")


def label_before(text: str, pos: int, en: dict[str, str], side: str) -> str:
    """取控件前面最近的显示名。抽不到返回空串。

    A 侧认 ``data-lang-xxx``（再过 en.js），B 侧认紧邻的 ``<span>文字</span>``。
    这是启发式，所以**只进「显示名」一列，不参与任何判断**。
    """
    window = text[max(0, pos - 500): pos]
    if side == "A":
        keys = DATA_LANG_RE.findall(window)
        return resolve_lang(keys[-1], en) if keys else ""
    spans = SPAN_TEXT_RE.findall(window)
    if spans:
        return spans[-1].strip()
    return ""


def line_of(text: str, pos: int) -> int:
    """1 起行号。产物里每个字段都必须带它，否则无法回溯。"""
    return text.count("\n", 0, pos) + 1


# --------------------------------------------------------------------- 抽取
#: HTML 注释区间。注释里的控件**不渲染**，所以不是字段。
#: 实测 A 侧有 12 个控件躺在注释里（``satelliteTracking.html`` 就有 4 个），
#: 不排除就会平白多出 a_only 行——那是假差异，不是 B 漏做。
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.S)


def comment_spans(text: str) -> list[tuple[int, int]]:
    """所有 HTML 注释的 ``(start, end)``。"""
    return [(m.start(), m.end()) for m in HTML_COMMENT_RE.finditer(text)]


def in_spans(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(s <= pos < e for s, e in spans)


def extract_fields(path: Path, *, side: str, en: dict[str, str]) -> list[Field]:
    """从一个源码文件抽出控件字段。

    对 HTML 与对 JS/TS 用同一套解析：B 的 ``panels/*.js`` 与 A 的 ``*.js`` 都是把
    HTML 写在模板字符串里，``<input ...>`` 的形状与真 HTML 一致，所以没必要分开处理。
    真正的区别只在「哪个属性算字段标识」，由 ``side`` 决定。

    **注释里的控件一律丢弃**：那份 markup 不会被浏览器渲染，把它算成字段
    只会制造假差异。
    """
    if not path.exists():
        return []
    text = read_text(path)
    key_attrs = A_KEY_ATTRS if side == "A" else B_KEY_ATTRS
    spans = comment_spans(text)

    out: list[Field] = []
    for m in CONTROL_RE.finditer(text):
        if in_spans(m.start(), spans):
            continue
        tag = m.group(1).lower()
        attrs = parse_attrs(m.group(2))
        ctype = attrs.get("type", "").lower()
        if ctype in NON_FIELD_TYPES:
            continue
        key = ""
        used = ""
        for name in key_attrs:
            value = attrs.get(name, "")
            if is_stable_token(value):
                key, used = value, name
                break
        if not key:
            continue
        out.append(
            Field(
                side=side,
                key=key,
                attr=used,
                label=label_before(text, m.start(), en, side),
                tag=tag,
                ctype=ctype,
                file=rel_to_root(path),
                line=line_of(text, m.start()),
            )
        )

    # A 侧的 <button> 状态控件（见 A_BUTTON_RE 的说明）。只收 A 侧：
    # B 侧的按钮不承载字段状态，硬收会把工具栏按钮算成字段。
    if side == "A":
        for m in A_BUTTON_RE.finditer(text):
            if in_spans(m.start(), spans):
                continue
            attrs = parse_attrs(m.group(1))
            classes = attrs.get("class", "").lower()
            if not any(mark in classes for mark in A_TOGGLE_CLASS_MARKERS):
                continue
            key = ""
            used = ""
            for name in key_attrs:
                value = attrs.get(name, "")
                if is_stable_token(value):
                    key, used = value, name
                    break
            if not key:
                continue
            out.append(
                Field(
                    side=side,
                    key=key,
                    attr=used,
                    label=label_before(text, m.start(), en, side),
                    tag="button",
                    ctype="",
                    file=rel_to_root(path),
                    line=line_of(text, m.start()),
                )
            )
    out.sort(key=lambda f: f.line)
    return out


def fragment_declarations(path: Path) -> list[tuple[str, int]]:
    """返回 ``(片段文件名小写, 行号)``。

    这是 B 配置页「直接渲染原版 HTML」的证据点：``packages/view/src/config/*.ts``
    里的 ``fragmentPath`` 指向 ``<appRoot>/view`` 下的原版片段。
    """
    if not path.exists():
        return []
    text = read_text(path)
    out: list[tuple[str, int]] = []
    for m in FRAGMENT_RE.finditer(text):
        raw = m.group(1)
        name = Path(raw.replace("\\", "/")).name.lower()
        if name:
            out.append((name, line_of(text, m.start())))
    return out


# --------------------------------------------------------------------- 范围
def load_map(path: Path) -> list[dict]:
    """读覆盖映射。它缺失/坏掉就是输入不可用，直接抛给调用方退出 2。"""
    if not path.exists():
        raise FileNotFoundError(f"找不到覆盖映射：{rel_to_root(path)}")
    data = json.loads(read_text(path))
    entries = data.get("entries")
    if not isinstance(entries, list) or not entries:
        raise ValueError(f"{rel_to_root(path)} 里没有 entries")
    return entries


def page_name(a_file: str) -> str:
    """页面名 = **原版哪个页面文件**，用于去重键。

    不能只用目录名：``app/view/html/`` 一个目录里装着 ``index.html``（外壳）、
    ``setUpMonitor.html``（Manage 台）、``playback.html``、``welcome.html``。
    按目录名都叫 ``html``，就会把「外壳的连接对话框」和「Manage 台的连接对话框」
    并成一个字段——那是假合并。

    所以取**文件名主干**（``setUpMonitor`` / ``index`` / ``convert`` …）：
    它与目录名在绝大多数页面上一一对应（``convert/convert.html`` → ``convert``），
    而目录名冲突的场景由文件主干正确区分。``GRIT/`` 下同理。
    """
    stem = Path(a_file).stem
    return stem or Path(a_file).parent.name


# --------------------------------------------------------------------- 对照
def fragment_index(b_file: str, cache: dict[str, dict[str, int]]) -> dict[str, int]:
    """``B 文件 → {片段文件名小写: 行号}``（带缓存，同一文件只解析一次）。"""
    if b_file not in cache:
        cache[b_file] = {
            name: line for name, line in fragment_declarations(ROOT / b_file)
        }
    return cache[b_file]


def build_report(
    *,
    a_view: Path = A_VIEW,
    en_path: Path = A_LANG,
    map_path: Path = MAP_PATH,
) -> Report:
    """跑一遍全流程。纯函数式：不写任何文件，方便测试直接调用。

    配对是**全局**的，不是逐条目各干各的。原因很实在：
    ``manage.js`` 被 5 个条目共用（menu / manage / deviceManagement / menuBar /
    agcStatus），逐条目比会把它的同一批字段数五遍——字段数虚高，差异数也虚高。
    那正是要避免的「凑数」。所以这里把每个**物理字段**（文件+行号）当作只出现一次，
    先按证据最强的规则认领，再统一结算。
    """
    entries = load_map(map_path)
    en = load_en_table(en_path)
    a_root_present = a_view.exists()

    # ---- 1. 范围：哪些 (A 文件, B 文件) 是映射允许的配对
    skipped: list[str] = []
    allowed: dict[tuple[str, str], str] = {}          # (a_file, b_file) -> entry id
    a_files: list[str] = []
    b_files: list[str] = []
    in_scope = 0
    for entry in entries:
        eid = str(entry.get("id") or "?")
        disp = str(entry.get("disposition") or "")
        a_file = ((entry.get("a") or {}).get("file") or "").strip()
        bs = [str((b or {}).get("file") or "") for b in (entry.get("b") or [])]
        bs = [b for b in bs if b]
        if disp not in IN_SCOPE_DISPOSITIONS or not a_file or not bs:
            skipped.append(eid)
            continue
        in_scope += 1
        if a_file not in a_files:
            a_files.append(a_file)
        for b in bs:
            allowed[(a_file, b)] = eid
            if b not in b_files:
                b_files.append(b)

    # ---- 2. 抽取：每个文件只抽一次
    a_fields = {f: extract_fields(ROOT / f, side="A", en=en) for f in a_files}
    b_fields = {f: extract_fields(ROOT / f, side="B", en=en) for f in b_files}
    a_used = {f: [False] * len(v) for f, v in a_fields.items()}
    b_used = {f: [False] * len(v) for f, v in b_fields.items()}

    frag_cache: dict[str, dict[str, int]] = {}
    rows: list[Row] = []

    def page_of(a_file: str) -> str:
        return page_name(a_file)

    # A 文件缺失 → 该 (A,B) 配对下的 B 字段一律 unverified，绝不编造 A 侧。
    missing_a = {
        f for f in a_files if not a_root_present or not (ROOT / f).exists()
    }
    for (a_file, b_file) in sorted(allowed):
        if a_file not in missing_a:
            continue
        for i, b in enumerate(b_fields[b_file]):
            if b_used[b_file][i]:
                continue
            b_used[b_file][i] = True
            rows.append(Row(page=page_of(a_file), field_key=b.key, label=b.label,
                            b_field=b, a_field=None, verdict="unverified",
                            method="none"))

    # ---- 3. 最强证据：B 声明了同名 fragmentPath → 渲染的就是那份原版 HTML
    for (a_file, b_file) in sorted(allowed):
        if a_file in missing_a:
            continue
        frags = fragment_index(b_file, frag_cache)
        line = frags.get(Path(a_file).name.lower())
        if line is None:
            continue
        for i, a in enumerate(a_fields[a_file]):
            if a_used[a_file][i]:
                continue
            a_used[a_file][i] = True
            b_pos = Field(side="B", key=a.key, attr="fragmentPath", label=a.label,
                          tag=a.tag, ctype=a.ctype, file=b_file, line=line)
            rows.append(Row(page=page_of(a_file), field_key=a.key, label=a.label,
                            b_field=b_pos, a_field=a, verdict="matched",
                            method="fragment"))

    # ---- 4. 次强证据：同一条目允许的配对里，归一化键名相同
    #      B 字段逐个认领；候选多于一个时按 (a 文件, 行号) 取最小，确定性优先。
    for b_file in sorted(b_files):
        for i, b in enumerate(b_fields[b_file]):
            if b_used[b_file][i]:
                continue
            best: Optional[tuple[tuple, str, int]] = None
            for (a_file, bf) in allowed:
                if bf != b_file or a_file in missing_a:
                    continue
                for j, a in enumerate(a_fields[a_file]):
                    if a_used[a_file][j] or a.nkey != b.nkey:
                        continue
                    cand = ((a_file, a.line), a_file, j)
                    if best is None or cand[0] < best[0]:
                        best = cand
            if best is None:
                continue
            _, a_file, j = best
            a = a_fields[a_file][j]
            a_used[a_file][j] = True
            b_used[b_file][i] = True
            rows.append(Row(page=page_of(a_file), field_key=b.key,
                            label=b.label or a.label, b_field=b, a_field=a,
                            verdict="matched", method="key"))

    # ---- 5. 结算：剩下的一侧独有
    #      b_only 的页面不能取「字母序第一个」：``manage.js`` 被 5 个条目共用，
    #      字母序会把它里面的终端/加设备对话框全挂到 ``agcStatus`` 名下——那是
    #      假归属。改为「它主要复刻了哪个 A 页面」，即该组 A 文件里控件最多的那个
    #      （``manage.js`` → ``setUpMonitor.html``），并列时按路径定序保证确定性。
    for b_file in sorted(b_files):
        candidates = [a for (a, bf) in allowed if bf == b_file]
        if candidates:
            page = max(
                candidates,
                key=lambda a: (len(a_fields[a]), [-ord(ch) for ch in a]),
            )
            page = page_of(page)
        else:  # pragma: no cover —— allowed 里必然有这一项
            page = Path(b_file).stem
        for i, b in enumerate(b_fields[b_file]):
            if b_used[b_file][i]:
                continue
            rows.append(Row(page=page, field_key=b.key, label=b.label,
                            b_field=b, a_field=None, verdict="b_only",
                            method="key"))
    for a_file in sorted(a_files):
        if a_file in missing_a:
            continue
        page = page_of(a_file)
        for i, a in enumerate(a_fields[a_file]):
            if a_used[a_file][i]:
                continue
            rows.append(Row(page=page, field_key=a.key, label=a.label,
                            b_field=None, a_field=a, verdict="a_only",
                            method="key"))

    rows = dedupe(rows)
    rows.sort(key=lambda r: r.sort_key)

    counts = {"matched": 0, "b_only": 0, "a_only": 0, "unverified": 0}
    for r in rows:
        counts[r.verdict] = counts.get(r.verdict, 0) + 1

    return Report(
        rows=rows,
        entries_seen=len(entries),
        entries_in_scope=in_scope,
        entries_skipped=skipped,
        a_root_present=a_root_present,
        counts=counts,
    )


def dedupe(rows: Iterable[Row]) -> list[Row]:
    """按「同一条物理对照」去重。

    ``gui_coverage_map.json`` 里 graph.* 有四个条目指向同一个 A 文件与同一个
    ``graph.js``。不去重，同一对字段会被数四遍，字段数和差异数都会虚高——
    那正是「凑数」。去重键包含两侧的文件与行号，所以不同字段不会误合并。
    """
    seen: dict[tuple, Row] = {}
    for r in rows:
        key = (
            r.verdict,
            r.a_field.file if r.a_field else "",
            r.a_field.line if r.a_field else 0,
            r.b_field.file if r.b_field else "",
            r.b_field.line if r.b_field else 0,
            normalize(r.field_key),
        )
        seen.setdefault(key, r)
    return list(seen.values())




# --------------------------------------------------------------------- 渲染
def _cell(text: str) -> str:
    """Markdown 表格单元转义。``|`` 不转义会把表切断。"""
    return (text or "").replace("|", "\\|").strip()


def render_markdown(report: Report) -> str:
    """渲染产物。**不含时间戳**，否则每次生成字节都不同，``--check`` 就废了。"""
    c = report.counts
    uc = report.unique_counts
    lines: list[str] = []
    add = lines.append

    add("# 套件字段对照表（A 原版 × B 重实现）")
    add("")
    add("> 本文件由 `tools/suite_field_parity.py` 从源码生成，**请勿手工编辑**。")
    add("> 重新生成：`python tools/suite_field_parity.py`　")
    add("> 只校验：`python tools/suite_field_parity.py --check`")
    add("")

    add("## 结论（这就是 EV-30 要的数字）")
    add("")
    add("两个口径都报。**判分看的是「去重字段」那一列**：")
    add("")
    add("| 指标 | 去重字段（判分口径） | DOM 元素（逐行口径） |")
    add("| --- | --- | --- |")
    add(f"| 总数 | **{report.total}**（契约要求 ≥ {MIN_FIELDS}） | "
        f"{report.elements} |")
    add(f"| `matched` | {uc.get('matched', 0)} | {c.get('matched', 0)} |")
    add(f"| `b_only` | {uc.get('b_only', 0)} | {c.get('b_only', 0)} |")
    add(f"| `a_only` | {uc.get('a_only', 0)} | {c.get('a_only', 0)} |")
    add(f"| `unverified`（A 侧未核对，不计入差异） | {uc.get('unverified', 0)} | "
        f"{c.get('unverified', 0)} |")
    add(f"| **`mismatches`**（`b_only + a_only`） | **{report.mismatches}**"
        f"（契约要求 0） | {report.element_mismatches} |")
    add("")
    add(f"「去重字段」= 不同 (页面, 命名空间, 归一化字段名) 的个数；"
        f"「DOM 元素」= 表的行数。"
        f"两者差 {report.merged} 个，是同一字段的多个控件（radio / checkbox 的各个取值、"
        "以及原版自己重复写了两遍的同名控件）被合并的结果。")
    add("")
    if report.mismatches:
        add(f"**EV-30 未达成**：`mismatches = {report.mismatches} > 0`。"
            "下面「B 独占」「A 独占」两节逐条列出，不做口径调整。")
    else:
        add("**EV-30 的字段对照部分达成**：`mismatches = 0`。")
    add("")

    add("## 口径")
    add("")
    add("- **范围**：`tools/gui_coverage_map.json` 里 `disposition` 为 "
        f"`covered` / `partial` 的条目（本机 {report.entries_in_scope} 条）。"
        "`not_applicable` / `a_only` 本来就没有 B 侧，算成差异会把「明确不做」"
        "误报成「漏做」，所以排除，并在此声明。")
    add("- **A 侧**：`逆向/01_解包/app/view/**` 里的 `<input|select|textarea>`，"
        "外加 A 侧用 `<button>` 承载的**状态控件**（原版用 CSS 给按钮画开关外观，"
        "如 `<button id=\"erase-nvm\" class=\"erase-checkbox\">`、"
        "`<button id=\"rtk-on-off\" class=\"select-device-btn\">`）。"
        "只收 class 命中开关/下拉白名单的按钮，"
        "`Apply` / `Cancel` / `Add` 这类动作按钮不算字段。"
        "字段标识取 `name`（优先）或 `id`，显示名取 `data-lang-*` 经 "
        "`languageSupport/en.js` 翻译。**A 侧只读，一个字节都没改。**")
    add("- **B 侧**：两套实现。① `packages/app/src/web/panels/*.js|*.html` 的"
        "`data-el` / `data-term` / `data-adddev` / `data-cfg` / `data-reset` 等分组绑定；"
        "② `packages/view/src/config/*.ts`，它们不写 HTML，而是 `fragmentPath` "
        "指向原版片段，由 `config-host.ts` 的 `fragments.load()` 从 `<appRoot>/view` 读入。")
    add("- **配对上的一条硬规则**：若 B 文件声明的 `fragmentPath` 与 A 文件名相同，"
        "则该页渲染的就是那份原版 HTML（同一份 DOM），逐字段判 `matched`，"
        "方法记 `fragment`，B 侧位置写 `fragmentPath` 所在行。这不是「推定相似」，"
        "是同一份文件。")
    add("- **配对**：其余页面在同一条目内按归一化键名配对"
        "（小写、去掉非字母数字，故 `startDate` ≡ `start-date`）。")
    add("- **HTML 注释里的控件不计入**：注释中的 markup 浏览器不渲染，"
        "算成字段会制造假差异（A 侧实测有 12 个控件躺在注释里，"
        "如 `satelliteTracking.html` 的整段排序单选组）。")
    add("")
    add("### 为什么计数单位是「去重字段」而不是「DOM 元素」")
    add("")
    add("- 一个 radio / checkbox 组是**一个字段**，它的每个取值各是一个 `<input>`。"
        "`cv-affix` 的 `PREFIX` 与 `SUFFIX` 是两个元素、一个字段；"
        "按元素计数会把这个字段算两遍，`mismatches` 随之虚高——"
        "「补一个选项」和「补一个字段」是两件不同的事，EV-30 判的是后者。")
    add("- 所以**总数与 `mismatches` 都按 (页面, 命名空间, 归一化字段名) 去重**；"
        "同一字段只要在某一侧存在（哪怕 3 个 radio）就算 1 个。")
    add("- **命名空间必须进去重键**：`manage.js` 的终端对话框用 `data-term=\"path\"`、"
        "加设备对话框用 `data-adddev=\"path\"`，同名却是两个字段。"
        "只有 A 侧且无命名空间差异时，这一维度等同于无。")
    add("- **页面取 A 侧文件名主干，不取目录名**：`app/view/html/` 一个目录装着"
        "`index.html`（外壳）、`setUpMonitor.html`（Manage 台）、`welcome.html`。"
        "按目录都叫 `html` 会把外壳与 Manage 台的连接对话框错并成一个字段。")
    add("- 但**表里仍然逐元素保留每一行**，因为「具体哪个取值缺失」只能靠行去看；"
        "去重后每个字段的代表行取该组里证据最强的那个元素"
        "（`matched` > `unverified` > `b_only` / `a_only`），"
        "并保留它的 `文件:行号`，随时可回溯。")
    add(f"- 本机两个数字：**去重字段 {report.total} 个 / DOM 元素 {report.elements} 个**"
        f"（合并 {report.merged} 个）。")
    if report.a_root_present:
        add("- **A 侧是否核对过**：是。`逆向/01_解包/app/view/` 在本机存在，"
            "所有 A 位置都是真实行号。")
    else:
        add("- **A 侧是否核对过**：**否**。本机没有 `逆向/01_解包/app/view/`，"
            "A 列全部标 `unverified`，未编造任何原版字段。")
    add("")

    add("## 对照表")
    add("")
    add("**一行 = 一个 DOM 元素，不等于一个字段**：同一字段的多个控件（radio / checkbox "
        "的各个取值）各占一行，因此本表行数多于结论区的「去重字段数」。")
    add("")
    add("`结论` 取值：`matched` 两侧都有；`b_only` 只有 B 有（差异）；"
        "`a_only` 只有 A 有（差异，意味着 B 漏了）；`unverified` A 侧未核对。")
    add("")
    add("| 字段 | 页面 | B 侧位置 | A 侧位置 | 结论 |")
    add("| --- | --- | --- | --- | --- |")
    for r in report.rows:
        label = f"{r.field_key}"
        if r.label:
            label = f"{r.field_key}（{r.label}）"
        b_pos = r.b_field.where if r.b_field else "—"
        a_pos = r.a_field.where if r.a_field else (
            "unverified" if not report.a_root_present else "—"
        )
        add(f"| {_cell(label)} | {_cell(r.page)} | {b_pos} | {a_pos} | {r.verdict} |")
    add("")

    bonly = [r for r in report.rows if r.verdict == "b_only"]
    aonly = [r for r in report.rows if r.verdict == "a_only"]
    unver = [r for r in report.rows if r.verdict == "unverified"]
    uni_b = sum(1 for r in report.unique_fields if r.verdict == "b_only")
    uni_a = sum(1 for r in report.unique_fields if r.verdict == "a_only")

    add("## B 独占字段（B 有、A 没有 → 差异）")
    add("")
    if not bonly:
        add("无。")
    else:
        add(f"去重后 {uni_b} 个字段，展开 {len(bonly)} 个 DOM 元素。"
            "这些名字在原版里找不到同名对应，要么是 B 新增的，"
            "要么是 B 改了键名而没在这里登记。")
        add("")
        add("| 字段 | 页面 | B 侧位置 |")
        add("| --- | --- | --- |")
        for r in bonly:
            add(f"| {_cell(r.field_key)} | {_cell(r.page)} | "
                f"{r.b_field.where if r.b_field else '—'} |")
    add("")

    add("## A 独占字段（A 有、B 没有 → 差异）")
    add("")
    if not aonly:
        add("无。")
    else:
        add(f"去重后 {uni_a} 个字段，展开 {len(aonly)} 个 DOM 元素。"
            "这些是原版有、B 侧没对上的字段。"
            "注意其中一部分所在页面由 A 侧自己用 JS 动态拼装，静态抽取会漏，"
            "所以这一列是**上界**，不是精确的缺口清单。")
        add("")
        add("| 字段 | 页面 | A 侧位置 |")
        add("| --- | --- | --- |")
        for r in aonly:
            add(f"| {_cell(r.field_key)} | {_cell(r.page)} | "
                f"{r.a_field.where if r.a_field else '—'} |")
    add("")

    if unver:
        add("## 未核对字段（A 侧缺失）")
        add("")
        add(f"共 {len(unver)} 个元素。`逆向/01_解包` 在本机不完整，"
            "这些字段只有 B 侧位置，A 侧标 `unverified`。**没有编造。**")
        add("")
        add("| 字段 | 页面 | B 侧位置 |")
        add("| --- | --- | --- |")
        for r in unver:
            add(f"| {_cell(r.field_key)} | {_cell(r.page)} | "
                f"{r.b_field.where if r.b_field else '—'} |")
        add("")

    add("## 未纳入范围的条目")
    add("")
    add("这些条目在映射里标为 `not_applicable` / `a_only`，或缺少 A/B 文件，"
        "按上节口径不计入差异：")
    add("")
    for eid in report.entries_skipped:
        add(f"- `{eid}`")
    add("")
    add("## 局限（不掩盖）")
    add("")
    add("1. **`--check` 的「差异」指产物陈旧**，不是字段对不齐。字段级 "
        "`mismatches` 只汇报、不进退出码——否则同一个退出码既要表示「产物过期」"
        "又要表示「字段不符」，调用方分不清该重新生成还是该改代码。")
    add("2. **静态抽取有上界误差**。A 侧 20 个 `.js` 用模板/拼接生成控件，"
        "键名可能是变量，静态抽不到；这类会落进 `a_only`，使差异数偏高。"
        "所以 `a_only` 应读作「至少这么多」，`matched` 才是硬证据。")
    add("3. **`<button>` 白名单是启发式**。A 侧状态控件按 class 关键字识别"
        "（`select-device-btn` / `erase-checkbox` / `export-checkbox` / "
        "`toggle-switch` / `*-dropdown`）。原版若用别的 class 画开关，"
        "那个字段会漏，表现为 `a_only` 少一行——即差异数偏低，不是偏高。"
        "当前这 8 个关键字覆盖了实测全部 17 个状态按钮。")
    add("4. **去重会把「真的该分开」的东西合到一起**。合并键是 "
        "(页面, 命名空间, 归一化字段名)，它假设同页同命名空间同名就是同一字段。"
        "已核对过的反例只有一种：原版自己把同一批控件重复写了两遍"
        "（`setUpMonitor.html` 的连接对话框有两个版本、`positionConfig.html` 的 "
        "`gpsl1-east` 出现两次、`deviceManagement.js` 的 `connection-on-off` 写了两遍）。"
        "这些在原版里就是同一个字段的两份 markup，合并是对的。"
        "若将来出现「同页同名但语义确实不同」的情况，这条规则会把它们错并，"
        "届时应在 `Field` 上补新的命名空间维度而不是放宽去重。")
    add("5. **三档分辨率不溢出（1280/1440/1920）不在本工具范围**。"
        "EV-30 的这一项需要真机截图，本表只解决「字段逐项对得上」。")
    add("")
    return "\n".join(lines).rstrip("\n") + "\n"


def summary_dict(report: Report) -> dict:
    """机器可读摘要。

    ``fields`` / ``mismatches`` 是**去重字段**口径（判分用）；
    ``elements`` / ``element_mismatches`` 是逐 DOM 元素口径。
    两个都给，避免读者以为「字段数」等于表行数。
    """
    uc = report.unique_counts
    return {
        "fields": report.total,
        "mismatches": report.mismatches,
        "matched": uc.get("matched", 0),
        "b_only": uc.get("b_only", 0),
        "a_only": uc.get("a_only", 0),
        "unverified": uc.get("unverified", 0),
        "elements": report.elements,
        "element_mismatches": report.element_mismatches,
        "merged": report.merged,
        "min_fields": MIN_FIELDS,
        "a_root_present": report.a_root_present,
        "entries_seen": report.entries_seen,
        "entries_in_scope": report.entries_in_scope,
        "entries_skipped": report.entries_skipped,
    }


def print_summary(report: Report) -> None:
    s = summary_dict(report)
    print(f"去重字段数    : {s['fields']}（契约要求 ≥ {s['min_fields']}）")
    print(f"DOM 元素数    : {s['elements']}（合并掉 {s['merged']} 个重复元素）")
    print(f"mismatches    : {s['mismatches']}（契约要求 0）"
          f"　逐元素口径 {s['element_mismatches']}")
    print(f"  matched     : {s['matched']}")
    print(f"  b_only      : {s['b_only']}")
    print(f"  a_only      : {s['a_only']}")
    print(f"  unverified  : {s['unverified']}")
    print(f"A 侧已解包    : {'是' if s['a_root_present'] else '否（A 侧未核对）'}")
    print(f"范围内条目    : {s['entries_in_scope']} / 全部 {s['entries_seen']}")
    if s["fields"] < MIN_FIELDS:
        print(f"[警告] 字段数 {s['fields']} < {MIN_FIELDS}：口径可能漏了，不是凑数能解决的")
    if s["mismatches"]:
        print(f"[说明] mismatches={s['mismatches']}：逐条见产物里的 B 独占 / A 独占两节")


# --------------------------------------------------------------------- CLI
def main(argv: Optional[Sequence[str]] = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError, OSError):  # pragma: no cover
            pass

    ap = argparse.ArgumentParser(
        description="从 A/B 两侧源码抽字段，生成/校验套件字段对照表（EV-30）")
    ap.add_argument("--check", action="store_true",
                    help="只校验：产物存在且与重新生成的内容逐字节一致才返回 0")
    ap.add_argument("--out", default=str(DEFAULT_OUT),
                    help=f"产物路径（默认 {rel_to_root(DEFAULT_OUT)}）")
    ap.add_argument("--json", action="store_true", help="输出机器可读摘要")
    args = ap.parse_args(argv)

    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = ROOT / out_path

    try:
        # 显式传模块级常量：默认参数在定义时绑定，测试里替换 MAP_PATH 才不会失效。
        report = build_report(map_path=MAP_PATH)
    except (FileNotFoundError, ValueError, json.JSONDecodeError) as exc:
        print(f"[阻断] 输入不可用：{exc}")
        return 2

    if report.total == 0:
        print("[阻断] 一个字段都没抽到：B 侧解析口径可能失效了，先查绑定属性名")
        return 2

    rendered = render_markdown(report)

    if args.check:
        if not out_path.exists():
            print(f"[陈旧] 产物不存在：{rel_to_root(out_path)}")
            print("[提示] 运行 python tools/suite_field_parity.py 生成")
            return 1
        current = read_text(out_path)
        if current != rendered:
            print(f"[陈旧] 产物与源码不一致：{rel_to_root(out_path)}")
            return 1
        if report.total < MIN_FIELDS:
            print(f"[不足] 字段数 {report.total} < {MIN_FIELDS}")
            return 1
        if args.json:
            print(json.dumps(summary_dict(report), ensure_ascii=False, indent=1))
        else:
            print(f"[一致] {rel_to_root(out_path)}")
            print_summary(report)
        return 0

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(rendered, encoding="utf-8", newline="\n")

    if args.json:
        print(json.dumps(summary_dict(report), ensure_ascii=False, indent=1))
    else:
        print(f"[写入] {rel_to_root(out_path)}")
        print_summary(report)
    return 0 if report.total >= MIN_FIELDS else 1


if __name__ == "__main__":
    sys.exit(main())
