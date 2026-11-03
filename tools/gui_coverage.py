#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""gui_coverage.py —— 从源码生成「原版 GUI（A）× 重实现（B）」覆盖矩阵。

这份工具回答三个问题，而且答案都从代码里来，不靠人凭印象补：

1. **A 有哪些**：``逆向/01_解包/app/view/`` 下每个页面目录、``menuBar.html`` 里的
   每个菜单项、外壳页（``view/html/*.html``）与 Graph 应用入口；
2. **B 有哪些**：``server.ts`` 的 ``/api/*`` 路由、``config/index.ts`` 的
   ``CONFIG_PAGE_NAMES`` / ``MENU_PAGE_NAMES``、各配置页类、CLI 选项、``workflows/*.yaml``；
3. **差距怎么处理**：``tools/gui_coverage_map.json`` 是唯一的人工输入，逐项写
   ``covered / partial / a_only / not_applicable`` 与处置理由；生成器负责校验
   「A 的每一项都被映射」「引用的文件与行真的存在」「引用的 workflow 真的存在」。

用法::

    python tools/gui_coverage.py             # 校验并重写矩阵与清单
    python tools/gui_coverage.py --check     # 只校验：与已提交文件逐字节一致才返回 0

设计约束（与 :mod:`fieldstation.workflows` 同一套）：

* 零第三方依赖（YAML 只用 ``yaml_lite`` 的子集）；
* **不静默跳过**：A 目录没映射、引用失效、workflow 拼错，都以非零退出；
* 输出确定：同样的源码与映射生成同样的字节，``--check`` 才有意义。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
for _p in (str(SRC), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

try:  # 只借 YAML 子集解析器，不引入额外依赖
    from fieldstation.workflows import yaml_lite
except Exception as exc:  # pragma: no cover —— 环境坏了要给出可读原因
    raise SystemExit(f"无法导入 fieldstation.workflows.yaml_lite：{exc}")

A_ROOT = ROOT / "逆向" / "01_解包"
VIEW_ROOT = A_ROOT / "app" / "view"
HTML_ROOT = VIEW_ROOT / "html"
MENU_HTML = VIEW_ROOT / "menuBar" / "menuBar.html"
GRAPH_ENTRY = A_ROOT / "Graph" / "out" / "renderer" / "index.html"
B_ROOT = ROOT / "逆向" / "04_重实现"
SERVER_TS = B_ROOT / "packages" / "app" / "src" / "server.ts"
CONFIG_INDEX = B_ROOT / "packages" / "view" / "src" / "config" / "index.ts"
CLI_SRC = B_ROOT / "packages" / "cli" / "src"
WEB_PANELS = B_ROOT / "packages" / "app" / "src" / "web" / "panels"
WORKFLOWS_DIR = ROOT / "workflows"

MAP_PATH = ROOT / "tools" / "gui_coverage_map.json"
INVENTORY_PATH = ROOT / "逆向" / "03_分析" / "附录" / "gui-inventory.json"
MATRIX_PATH = ROOT / "逆向" / "03_分析" / "19_原版GUI覆盖矩阵.md"

DISPOSITIONS = ("covered", "partial", "a_only", "not_applicable")
DISPOSITION_LABELS = {
    "covered": "B 已覆盖",
    "partial": "B 部分覆盖",
    "a_only": "A-only（B 没有）",
    "not_applicable": "本机 A 也不适用",
}
KIND_LABELS = {
    "entry": "入口与外壳",
    "tile": "状态 tile",
    "config": "配置页",
    "tool": "工具页",
    "device": "设备页",
    "graph": "Graph",
    "grit": "GRIT Monitor",
    "convert": "Convert",
    "playback": "Playback",
    "suite": "套件级",
    "page": "其它页面",
}
KIND_ORDER = tuple(KIND_LABELS)
TAG_RE = re.compile(r"^\[(观察|推断|未知)\]")
ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{2,60}$")
MENU_LINE_RE = re.compile(r'<li[^>]*class="[^"]*(?:menu-status-config|menubar-layouts|sidebar-nav-item)[^"]*"[^>]*>')
ID_ATTR_RE = re.compile(r'id="([A-Za-z][A-Za-z0-9_-]*)"')

#: 解包目录缺失时，A 侧证据行号从已入库清单的 ``entry_refs`` 取。
#: 生成物必须与提交版逐字节一致，所以 ``source`` 不改写（仍是 ``unpacked``），
#: 用这两个模块级标记表示“本次数据来自清单”。
_A_FROM_COMMITTED = False
_A_REF_OVERRIDES: dict[str, str] = {}


class CoverageError(RuntimeError):
    """映射或引用不成立。消息里带全部问题，不逐条中断。"""

    def __init__(self, errors: list[str]) -> None:
        super().__init__("\n".join(errors))
        self.errors = list(errors)


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:  # 临时目录等仓库外的路径（--check 的测试用）
        return path.resolve().as_posix()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def find_line(path: Path, needle: str) -> int | None:
    if not path.is_file():
        return None
    for number, line in enumerate(read_text(path).splitlines(), 1):
        if needle in line:
            return number
    return None


# --------------------------------------------------------------------------- A 侧
def _main_file(folder: Path, files: list[str]) -> str:
    stem = folder.name
    for candidate in (f"{stem}.html", f"{stem}.js"):
        if candidate in files:
            return candidate
    for suffix in (".html", ".js"):
        for name in files:
            if name.endswith(suffix):
                return name
    return files[0] if files else ""


def scan_menu_items() -> list[dict]:
    if not MENU_HTML.is_file():
        return []
    items: list[dict] = []
    seen: set[str] = set()
    lines = read_text(MENU_HTML).splitlines()
    for number, line in enumerate(lines, 1):
        if not MENU_LINE_RE.search(line):
            continue
        match = ID_ATTR_RE.search(line)
        if match is None:
            continue
        item_id = match.group(1)
        if item_id in seen:
            continue
        seen.add(item_id)
        label = ""
        for follow in lines[number - 1:number + 1]:
            label_match = re.search(r'data-lang-([a-z0-9-]+)', follow)
            if label_match:
                label = label_match.group(1)
                break
        items.append({"id": item_id, "line": number, "label": label})
    return items


def scan_a() -> dict:
    """扫 A 侧；解包目录不在本机时返回 ``{"source": "missing"}``。"""
    if not VIEW_ROOT.is_dir():
        return {"source": "missing", "views": [], "menu_items": [], "shell_pages": []}
    views: list[dict] = []
    for folder in sorted((p for p in VIEW_ROOT.iterdir() if p.is_dir()), key=lambda p: p.name):
        files = sorted(f.name for f in folder.iterdir() if f.is_file())
        if not files:
            continue
        main = _main_file(folder, files)
        views.append({
            "id": folder.name,
            "path": rel(folder / main),
            "files": files,
            "main": main,
        })
    shell_pages = []
    if HTML_ROOT.is_dir():
        for html in sorted(HTML_ROOT.glob("*.html")):
            shell_pages.append({"id": html.stem, "path": rel(html)})
    return {
        "source": "unpacked",
        "views": views,
        "menu_items": scan_menu_items(),
        "shell_pages": shell_pages,
        "graph_entry": rel(GRAPH_ENTRY) if GRAPH_ENTRY.is_file() else "",
    }


# --------------------------------------------------------------------------- B 侧
def _array_items(path: Path, name: str) -> list[str]:
    if not path.is_file():
        return []
    match = re.search(
        rf"export const {name} = \[(.*?)\] as const", read_text(path), re.S)
    if match is None:
        return []
    return re.findall(r"'([^']+)'", match.group(1))


def scan_b() -> dict:
    routes: set[str] = set()
    if SERVER_TS.is_file():
        routes.update(re.findall(r"/api/[A-Za-z0-9_./{}-]+", read_text(SERVER_TS)))
    # 前缀串（`/api/config/`、`/api/grit/tiles/`）不是独立端点，去掉尾斜杠的版本
    routes = {route for route in routes if not route.endswith("/")}
    cli_flags: set[str] = set()
    if CLI_SRC.is_dir():
        for path in sorted(CLI_SRC.glob("*.ts")):
            text = read_text(path)
            cli_flags.update(re.findall(r"['\"](--[a-z0-9-]+)['\"]", text))
    panels = []
    if WEB_PANELS.is_dir():
        panels = sorted(p.stem for p in WEB_PANELS.glob("*.js"))
    workflows: list[dict] = []
    if WORKFLOWS_DIR.is_dir():
        for path in sorted(WORKFLOWS_DIR.glob("*.yaml")):
            try:
                data = yaml_lite.load(path)
            except Exception as exc:  # pragma: no cover —— 规格坏了先修规格
                raise SystemExit(f"读不了 {rel(path)}：{exc}")
            if isinstance(data, dict) and data.get("id"):
                workflows.append({"id": str(data["id"]), "path": rel(path)})
    return {
        "api_routes": sorted(routes),
        "config_pages": _array_items(CONFIG_INDEX, "CONFIG_PAGE_NAMES"),
        "menu_pages": _array_items(CONFIG_INDEX, "MENU_PAGE_NAMES"),
        "cli_flags": sorted(cli_flags),
        "web_panels": panels,
        "workflows": workflows,
    }


# --------------------------------------------------------------------------- 映射
def load_map() -> dict:
    if not MAP_PATH.is_file():
        raise SystemExit(f"缺少映射文件：{rel(MAP_PATH)}")
    try:
        data = json.loads(MAP_PATH.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise SystemExit(f"{rel(MAP_PATH)} 不是合法 JSON：{exc}")
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        raise SystemExit(f"{rel(MAP_PATH)} 顶层必须是含 entries 列表的对象")
    return data


def _resolve_ref(ref: object, where: str, errors: list[str], *, allow_missing: bool = False) -> str:
    if not isinstance(ref, dict):
        errors.append(f"{where} 的引用必须是对象（file/find/tag）")
        return ""
    file_name = ref.get("file")
    tag = ref.get("tag", "观察")
    if tag not in ("观察", "推断", "未知"):
        errors.append(f"{where} 的 tag 只能是 观察/推断/未知")
        return ""
    if not isinstance(file_name, str) or not file_name:
        errors.append(f"{where} 缺少 file")
        return ""
    path = ROOT / file_name
    if not path.is_file():
        if allow_missing:
            return f"[未知] {file_name}（本机缺该证据文件）"
        errors.append(f"{where} 引用的文件不存在：{file_name}")
        return ""
    needle = ref.get("find")
    if needle is None:
        line = 1
    else:
        line = find_line(path, str(needle))
        if line is None:
            errors.append(f"{where} 在 {file_name} 里找不到 {needle!r}")
            return ""
    return f"[{tag}] {file_name}:{line}"


def validate(map_data: dict, a: dict, b: dict) -> list[str]:
    errors: list[str] = []
    internal = map_data.get("internal") or {}
    if not isinstance(internal, dict):
        errors.append("internal 必须是 {目录: 理由} 对象")
        internal = {}
    entries = map_data["entries"]
    seen: set[str] = set()
    workflow_ids = {w["id"] for w in b["workflows"]}

    for index, entry in enumerate(entries):
        where = f"entries[{index}]"
        if not isinstance(entry, dict):
            errors.append(f"{where} 必须是对象")
            continue
        item_id = entry.get("id")
        if not isinstance(item_id, str) or not ID_RE.match(item_id):
            errors.append(f"{where}.id 不合法：{item_id!r}")
            continue
        if item_id in seen:
            errors.append(f"id 重复：{item_id}")
            continue
        seen.add(item_id)
        if not entry.get("label"):
            errors.append(f"{item_id} 缺少 label")
        if entry.get("kind") not in KIND_LABELS:
            errors.append(f"{item_id}.kind 必须是 {list(KIND_LABELS)} 之一")
        if entry.get("disposition") not in DISPOSITIONS:
            errors.append(f"{item_id}.disposition 必须是 {list(DISPOSITIONS)} 之一")
        reason = entry.get("reason", "")
        if not isinstance(reason, str) or not TAG_RE.match(reason):
            errors.append(f"{item_id}.reason 必须以 [观察]/[推断]/[未知] 开头")
        for i, ref in enumerate(entry.get("b") or []):
            _resolve_ref(ref, f"{item_id}.b[{i}]", errors)
        if "a" in entry:
            if not (_A_FROM_COMMITTED and item_id in _A_REF_OVERRIDES):
                _resolve_ref(entry["a"], f"{item_id}.a", errors,
                             allow_missing=a.get("source") != "unpacked")
        workflow = entry.get("workflow") or ""
        if workflow and workflow not in workflow_ids:
            errors.append(f"{item_id}.workflow 不在 workflows/：{workflow}")
        if entry.get("disposition") in ("a_only", "partial") and not workflow:
            if not entry.get("backlog"):
                errors.append(f"{item_id} 有缺口，但既没有 workflow 也没有 backlog")
        if entry.get("disposition") == "covered" and workflow:
            pass  # 允许「已覆盖 + 固定流程」双保险
        if not isinstance(entry.get("menu") or [], list):
            errors.append(f"{item_id}.menu 必须是列表")

    # A 的每个 view 目录必须有归属：映射，或明确标为内部件
    mapped_paths = {entry["a"]["file"] for entry in entries
                    if isinstance(entry.get("a"), dict) and entry["a"].get("file")}
    for view in a.get("views") or []:
        if view["path"] in mapped_paths:
            continue
        if view["id"] in internal:
            continue
        errors.append(f"A 目录未映射：{view['id']}（{view['path']}）—— 加映射或写进 internal")

    # 菜单项必须被某个 entry 认领
    claimed_menus = {m for entry in entries for m in (entry.get("menu") or [])}
    for item in a.get("menu_items") or []:
        if item["id"] not in claimed_menus:
            errors.append(f"菜单项未映射：{item['id']}（menuBar.html:{item['line']}）")

    for name in internal:
        if _A_FROM_COMMITTED or a.get("source") == "missing":
            # 清单是在有解包目录时生成的，那时已经校验过；干净检出没有盘可查。
            continue
        if not (VIEW_ROOT / name).is_dir():
            errors.append(f"internal 里的目录不存在：{name}")
    return errors


def build(map_data: dict, a: dict, b: dict) -> dict:
    entries = []
    for entry in map_data["entries"]:
        row = dict(entry)
        if "a" in row:
            override = _A_REF_OVERRIDES.get(row["id"]) if _A_FROM_COMMITTED else None
            row["a_text"] = override or _resolve_ref(
                row["a"], row["id"] + ".a", [],
                allow_missing=a.get("source") != "unpacked")
        else:
            row["a_text"] = ""
        row["b_text"] = "; ".join(
            _resolve_ref(ref, row["id"] + ".b", []) for ref in (row.get("b") or []))
        entries.append(row)
    entries.sort(key=lambda e: (KIND_ORDER.index(e["kind"]),
                                DISPOSITION_LABELS[e["disposition"]], e["id"]))
    counts = {d: sum(1 for e in entries if e["disposition"] == d) for d in DISPOSITIONS}
    return {"entries": entries, "counts": counts}


# --------------------------------------------------------------------------- 渲染
def _cell(text: object) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ")


def _table(headers: list[str], rows: list[list[str]]) -> list[str]:
    out = ["| " + " | ".join(headers) + " |",
           "|" + "|".join("---" for _ in headers) + "|"]
    for row in rows:
        out.append("| " + " | ".join(_cell(value) for value in row) + " |")
    return out


def render_matrix(data: dict, a: dict, b: dict, map_data: dict) -> str:
    entries = data["entries"]
    counts = data["counts"]
    gap = [e for e in entries if e["disposition"] in ("a_only", "partial")]
    lines: list[str] = []
    lines.append("# 原版 GUI 覆盖矩阵（A × B）")
    lines.append("")
    lines.append("> 本文件由 `tools/gui_coverage.py` 生成，**不要手改**；改映射请改")
    lines.append("> `tools/gui_coverage_map.json`，改完运行 `python tools/gui_coverage.py`。")
    lines.append("> 生成器同时校验「A 每项都有归属」「引用的文件与行存在」「引用的 workflow 存在」，")
    lines.append("> 因此这份矩阵既是对照表，也是防止漂移的测试。")
    lines.append("")
    lines.append("## 一、口径")
    lines.append("")
    lines.append("- **A**：在*这台 OEM729 + 当前固件 + 套件 2.11.0* 上，人真的能在原版 GUI 里完成的操作。")
    lines.append("  不是「套件所有菜单」——Storage / Wi-Fi / RTK / SPAN / ALIGN / PIM / G-III / Longhorn")
    lines.append("  这些在本机原版也不能用的，归入 `not_applicable`，不占 RPA 预算。")
    lines.append("- **B**：`逆向/04_重实现/` 的重实现（`/api/*`、配置页类、web 面板、CLI、`workflows/`）。")
    lines.append("- **证据等级**：每条结论带 `[观察]`（源码原文，附 `文件:行号`）、`[推断]`（由观察推得）、")
    lines.append("  `[未知]`（缺证据）。A 侧行号以 `逆向/01_解包/` 为准；解包目录不在本机时自动降级为 `[未知]`。")
    lines.append("")
    lines.append("## 二、汇总")
    lines.append("")
    lines.append("| 处置 | 条数 | 含义 |")
    lines.append("|---|---|---|")
    for disposition in DISPOSITIONS:
        lines.append(f"| {DISPOSITION_LABELS[disposition]} | {counts[disposition]} | "
                     f"`{disposition}` |")
    lines.append(f"| **合计** | **{len(entries)}** | |")
    lines.append("")
    lines.append(f"A 侧扫描：{len(a.get('views') or [])} 个 view 目录、"
                 f"{len(a.get('menu_items') or [])} 个菜单项、"
                 f"{len(a.get('shell_pages') or [])} 个外壳页。"
                 if a.get("source") != "missing" else
                 "A 侧扫描：本机没有 `逆向/01_解包/`，直接使用已提交清单。")
    lines.append("")
    lines.append("## 三、A−B 清单（只列仍有缺口的）")
    lines.append("")
    lines.append("只有这里出现的项才需要处置：`covered` 项是「B 已有，不需要流程」。")
    lines.append("")
    gap_rows = []
    for entry in gap:
        handle = (f"workflow `{entry['workflow']}`" if entry.get("workflow")
                  else (entry.get("backlog") or "—"))
        gap_rows.append([
            f"`{entry['id']}`",
            entry["label"],
            DISPOSITION_LABELS[entry["disposition"]],
            handle,
            entry["reason"],
        ])
    lines.extend(_table(["项", "A 项", "处置", "处理方式", "理由与证据"], gap_rows))
    lines.append("")
    lines.append("## 四、完整矩阵")
    lines.append("")
    for kind in KIND_ORDER:
        rows = [e for e in entries if e["kind"] == kind]
        if not rows:
            continue
        lines.append(f"### {KIND_LABELS[kind]}")
        lines.append("")
        lines.extend(_table(
            ["项", "A 项", "B 状态", "A 证据", "B 证据 / 说明"],
            [[f"`{e['id']}`", e["label"], DISPOSITION_LABELS[e["disposition"]],
              e["a_text"] or "—",
              (e["b_text"] + "；" if e["b_text"] else "")
              + (e["reason"] or "")
              + (f"；固定流程 `{e['workflow']}`" if e.get("workflow") else "")]
             for e in rows]))
        lines.append("")
    lines.append("## 五、B 清单（从代码扫描）")
    lines.append("")
    lines.append("### 5.1 `/api/*` 路由")
    lines.append("")
    lines.append("共 " + str(len(b["api_routes"])) + " 条：")
    lines.append("")
    for start in range(0, len(b["api_routes"]), 6):
        lines.append("- " + " · ".join(f"`{r}`" for r in b["api_routes"][start:start + 6]))
    lines.append("")
    lines.append("### 5.2 配置页与菜单页")
    lines.append("")
    lines.append("- `CONFIG_PAGE_NAMES`（" + str(len(b["config_pages"])) + "）："
                 + "、".join(f"`{p}`" for p in b["config_pages"]))
    lines.append("- `MENU_PAGE_NAMES`（" + str(len(b["menu_pages"])) + "）："
                 + "、".join(f"`{p}`" for p in b["menu_pages"]))
    lines.append("")
    lines.append("### 5.3 web 面板")
    lines.append("")
    lines.append("、".join(f"`{p}`" for p in b["web_panels"]) or "—")
    lines.append("")
    lines.append("### 5.4 CLI 选项（`packages/cli/src`）")
    lines.append("")
    if b["cli_flags"]:
        for start in range(0, len(b["cli_flags"]), 8):
            lines.append("- " + " ".join(f"`{f}`" for f in b["cli_flags"][start:start + 8]))
    else:
        lines.append("—")
    lines.append("")
    lines.append("### 5.5 固定流程")
    lines.append("")
    lines.extend(_table(
        ["workflow", "规格文件"],
        [[f"`{w['id']}`", f"`{w['path']}`"] for w in b["workflows"]]))
    lines.append("")
    lines.append("## 六、未纳入 A 的 view 目录（内部件）")
    lines.append("")
    lines.append("这些目录是页面内部的样式/图片/脚本/语言包或 GRIT 的子图层，不是「人能操作的屏」，")
    lines.append("所以不逐项建流程；保留在此是为了说明「没漏看」，而不是「看漏了」。")
    lines.append("")
    internal = map_data.get("internal") or {}
    lines.append("| 目录 | 不纳入的理由 |")
    lines.append("|---|---|")
    for name in sorted(internal):
        lines.append(f"| `{name}` | {_cell(internal[name])} |")
    lines.append("")
    lines.append("## 七、维护与扩展")
    lines.append("")
    lines.append("1. **新增页面**：A 目录出现新页面 → 生成器会报「A 目录未映射」，在映射里补一条，")
    lines.append("   写清 `disposition`；`a_only` 必须给 `workflow` 或 `backlog`。")
    lines.append("2. **新增流程**：在 `workflows/` 加一份 YAML，生成器会自动把它列进 §5.5；")
    lines.append("   映射里引用它之前，先保证 `workflow validate` 通过。")
    lines.append("3. **新增机型/固件**：把「本机不适用」的项从 `not_applicable` 改成实际处置，")
    lines.append("   并更新 A 的口径（本文件 §一）。")
    lines.append("4. **防漂移**：`python tools/gui_coverage.py --check` 会在 CI/门禁里比对")
    lines.append("   `19_原版GUI覆盖矩阵.md` 与 `附录/gui-inventory.json` 是否与源码一致。")
    lines.append("5. **失败分类**：workflow 的失败类固定为 environment / input / execution /")
    lines.append("   artifact / capability（见 `src/fieldstation/workflows/spec.py`），矩阵不另立分类。")
    lines.append("")
    return "\n".join(lines)


def render_inventory(a: dict, b: dict, map_data: dict,
                     entry_refs: dict | None = None) -> str:
    data = {
        "version": 1,
        "note": "由 tools/gui_coverage.py 生成；源目录缺失时矩阵回退到本清单。",
        "a": {
            "source": a.get("source", "missing"),
            "views": a.get("views") or [],
            "menu_items": a.get("menu_items") or [],
            "shell_pages": a.get("shell_pages") or [],
            "graph_entry": a.get("graph_entry", ""),
        },
        "entry_refs": entry_refs or {},
        "b": b,
        "internal_views": map_data.get("internal") or {},
    }
    return json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


# --------------------------------------------------------------------------- 入口
def generate() -> tuple[str, str]:
    global _A_FROM_COMMITTED, _A_REF_OVERRIDES
    _A_FROM_COMMITTED = False
    _A_REF_OVERRIDES = {}
    map_data = load_map()
    a = scan_a()
    b = scan_b()
    if a.get("source") == "missing":
        if not INVENTORY_PATH.is_file():
            raise SystemExit("解包目录不在本机，且没有已提交的 gui-inventory.json 可回退")
        inventory = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
        a = dict(inventory.get("a") or {})
        # 不改写 source：生成物要与提交版逐字节一致；回退状态用模块标记表示。
        _A_FROM_COMMITTED = True
        _A_REF_OVERRIDES = dict(inventory.get("entry_refs") or {})
        if not _A_REF_OVERRIDES:
            # 旧清单没有 entry_refs 时仍要能生成（A 引用退化成 [未知]）；
            # --check 会因为与提交版不一致而失败，正确定位「清单该重生成」。
            print("[警告] gui-inventory.json 缺 entry_refs：A 证据行号会退化为 [未知]",
                  file=sys.stderr)
    errors = validate(map_data, a, b)
    if errors:
        raise CoverageError(errors)
    data = build(map_data, a, b)
    entry_refs = {
        row["id"]: row["a_text"] for row in data["entries"] if row.get("a_text")
    }
    return (render_matrix(data, a, b, map_data),
            render_inventory(a, b, map_data, entry_refs))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="生成/校验 A×B GUI 覆盖矩阵")
    parser.add_argument("--check", action="store_true",
                        help="只校验：生成结果必须与已提交文件逐字节一致")
    args = parser.parse_args(argv)
    try:
        matrix, inventory = generate()
    except CoverageError as exc:
        print("[错误] 覆盖映射校验失败：", file=sys.stderr)
        for line in exc.errors:
            print("  - " + line, file=sys.stderr)
        return 1

    if args.check:
        problems = []
        for path, expected in ((MATRIX_PATH, matrix), (INVENTORY_PATH, inventory)):
            if not path.is_file():
                problems.append(f"缺少生成物：{rel(path)}")
                continue
            actual = path.read_text(encoding="utf-8")
            if actual != expected:
                a_lines = actual.splitlines()
                e_lines = expected.splitlines()
                where = next((i + 1 for i, (x, y) in enumerate(zip(a_lines, e_lines)) if x != y),
                             min(len(a_lines), len(e_lines)) + 1)
                problems.append(f"{rel(path)} 与生成结果不一致（首个差异在第 {where} 行）")
        if problems:
            for line in problems:
                print("[过期] " + line, file=sys.stderr)
            print("运行 python tools/gui_coverage.py 重新生成。", file=sys.stderr)
            return 1
        print("覆盖矩阵与清单都是最新的。")
        return 0

    MATRIX_PATH.parent.mkdir(parents=True, exist_ok=True)
    INVENTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
    MATRIX_PATH.write_text(matrix, encoding="utf-8", newline="\n")
    INVENTORY_PATH.write_text(inventory, encoding="utf-8", newline="\n")
    print(f"已生成 {rel(MATRIX_PATH)} 与 {rel(INVENTORY_PATH)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
