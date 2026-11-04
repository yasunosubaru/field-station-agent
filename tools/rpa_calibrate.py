#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""目标基线校准：一条 diff 告诉你界面哪里变了。

## 为什么有它

流程 YAML 里写的是 ``target:Playback`` 这类 key。套件升级、切语言、控件重排之后，
同一个 key 会点空——点击引擎只会说"找不到目标"，说不出"少了哪几个、多了哪几个、
哪个改了名"。本工具把"可点目标清单"变成可 diff 的基线，让界面变更在一次运行里现形。

三个动作：

* ``--dump <page>``   采这一页 → 写进基线 ``tools/rpa_targets.json``（首次建立 / 整页重采）；
* ``--diff <page>``   采这一页 → 与基线比，分出 removed / added / changed；
* ``--write <page>``  与 diff 相同，但把结果写回基线——**必须再加 ``--yes``**（人工确认后）。

默认会先把套件切到目标页再采（``--no-nav`` 可关掉）；采之前把鼠标挪开、等页面连续
三次采集稳定——**稳不住就以 2 退出，不写基线**，因为会自己变的清单没有校准价值。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 没有 ``removed``（只有 added/changed 也只算提示）；``--dump`` / ``--write --yes`` 之后基线已经和界面一致，也返回 0 |
| 1 | ``--diff`` 发现 ``removed`` —— 流程里的 target 最可能点空的地方 |
| 2 | 环境/参数错误：CDP 连不上、基线里没有这一页、页名拼错、页面没稳定 |
| 3 | ``--write`` 缺 ``--yes``，一个字节都没写 |

## 页面切换是确定的

每次先回首页（顺带取消遗留对话框），再按 ``a.homemenu-title`` → ``#sm-welcome``
→ ``#add_device_btn`` 进入目标页，采完在 ``finally`` 里恢复首页。**不给别人留残留状态**。

``a.homemenu-title`` 的 rect 是 0×0（标题由窗口外框渲染，不在页面布局里），
真实鼠标事件够不到它，只能用 JS ``element.click()``。能看到的目标优先走
``ClickEngine`` 的真实鼠标事件，点空再退回 JS click——**导航只负责"换页"，
不是流程动作**，所以这个退让不影响"页面内点击不发 element.click()"的纪律。
每次导航后都验一个"判据元素可见"（见 ``PAGE_LANDMARKS``），验不过就重来/报错，
绝不拿上一页去和基线比。

只依赖标准库 + 本仓库的 ``cdp_driver`` / ``click_engine``。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
if str(TOOLS_DIR) not in sys.path:  # 允许 ``python tools/rpa_calibrate.py`` 直接跑
    sys.path.insert(0, str(TOOLS_DIR))

from click_engine import ClickEngine, ClickError  # noqa: E402
from cdp_driver import CdpDriver, GuiUnavailable  # noqa: E402

BASELINE_PATH = TOOLS_DIR / "rpa_targets.json"
DEFAULT_PORT = int(os.environ.get("FSA_CDP_PORT", "9223"))

#: 基线里每条目标的字段。不放 ``idx``：它是文档顺序里的序号，加一个目标就整体后移。
ENTRY_FIELDS = ("key", "id", "tag", "cls", "label", "w", "h")

#: ``Date.now()`` 生成的 id（``1793355488097-device-tile``）每次启动都变，
#: 会让"同一块设备卡"在 diff 里显示成 一次 removed + 一次 added。
#: 10 位以上连续数字一律折叠成 ``#``，只用来**匹配**，基线里仍保留原始 id。
TIMESTAMP_RE = re.compile(r"\d{10,}")


class CalibrationError(RuntimeError):
    """采不到目标：套件没开、页面不存在、导航点不进去。"""


# ---------------------------------------------------------------- 页面定义
@dataclass(frozen=True)
class Step:
    """一次导航：``selector`` 判存在/可见，``key`` 交给 ClickEngine（None 表示只能 JS click）。"""

    selector: str
    key: str | None = None
    allow_danger: bool = False


HOME_STEP = Step("a.homemenu-title")  # 0×0，只能用 JS click

#: 会自己冒出来、又会自己消失的浮层。它们不是界面结构，采进基线就会变成
#: "今天多了两个按钮、明天又少了两个"的假警报，所以每次采集前先关掉。
#: 只点"关掉"这一种动作，而且只在该元素可见时才点。
TRANSIENT_STEPS = (
    Step("#connection-cancelbtn"),                    # + Add Device 对话框的 Cancel
    Step("button.updateclosebtn"),                    # 更新检查浮层（"... is up to date"）
)
#: 只关"更新检查"这类纯通知浮层——采 device-dialog 时绝不能顺手把要采的对话框关了。
POPUP_STEPS = (Step("button.updateclosebtn"),)

#: 页名 → 导航步骤。第一步永远是"回首页"，后面的差别就是各页真正多出来的点击。
PAGE_STEPS = {
    "home": [HOME_STEP],
    "manage": [HOME_STEP, Step("#sm-welcome", "#sm-welcome")],
    "device-dialog": [
        HOME_STEP,
        Step("#sm-welcome", "#sm-welcome"),
        # Add Device 命中危险词，但它只是**打开对话框**，不写任何东西；
        # 真正的写操作（Add 按钮）不在这里点。
        Step("#add_device_btn", "#add_device_btn", allow_danger=True),
    ],
}

PAGE_ORDER = ("home", "manage", "device-dialog")

#: 每个页面状态"到了没有"的判据（元素必须可见）。少一次点击就会拍成上一页，
#: 那种 diff 比没有 diff 更糟——所以导航之后必须验，验不过就报错。
PAGE_LANDMARKS = {
    "home": "#sm-welcome",              # 首页的应用磁贴；进了 Manage 它就隐藏
    "manage": "#add_device_btn",        # Manage 页的 + Add Device
    "device-dialog": "#connection-cancelbtn",   # 对话框的 Cancel；取消后消失
}

# ---------------------------------------------------------------- 页面脚本
_ELEMENT_JS = r"""
(() => {
  const n = document.querySelector(%s);
  if (!n) return null;
  const r = n.getBoundingClientRect();
  const st = getComputedStyle(n);
  const visible = st.display !== 'none' && st.visibility !== 'hidden'
                  && Number(st.opacity) !== 0 && r.width >= 8 && r.height >= 8;
  return JSON.stringify({w: Math.round(r.width), h: Math.round(r.height), visible: visible});
})()
"""

_CLICK_JS = r"""
(() => {
  const n = document.querySelector(%s);
  if (!n) return false;
  n.scrollIntoView({block: 'center', inline: 'center'});
  n.click();
  return true;
})()
"""


def _js_string(value: str) -> str:
    return json.dumps(str(value), ensure_ascii=False)


# ---------------------------------------------------------------- 基线条目
def entry_of(target) -> dict:
    """``ClickEngine.Target``（或任意同类对象）→ 基线里的一条。"""
    return {
        "key": getattr(target, "key", "") or "",
        "id": getattr(target, "id", "") or "",
        "tag": getattr(target, "tag", "") or "",
        "cls": getattr(target, "cls", "") or "",
        "label": getattr(target, "label", "") or "",
        "w": int(getattr(target, "w", 0) or 0),
        "h": int(getattr(target, "h", 0) or 0),
    }


def normalize_id(raw: str) -> str:
    """把 ``Date.now()`` 那种时间戳 id 折叠掉，让"同一块卡"跨启动还能对上。"""
    return TIMESTAMP_RE.sub("#", raw or "")


def _entry(raw) -> dict:
    """dict / Target 统一成带全部字段的 dict。"""
    if isinstance(raw, dict):
        entry = {name: raw.get(name, "") for name in ENTRY_FIELDS}
        entry["w"] = int(entry["w"] or 0)
        entry["h"] = int(entry["h"] or 0)
        if not entry["key"]:
            entry["key"] = entry["label"] or "%s#%s" % (entry["tag"],
                                                        entry["id"] or entry["cls"])
        return entry
    return entry_of(raw)


#: class 里表示"运行时状态"的词：一连设备 class 就从 ``device-disconnected``
#: 变成 ``device-connected``。身份要是按 class 算，状态变化会被当成界面改版，
#: 所以先把这些词剥掉。
STATE_CLASS_WORDS = (
    "connect", "active", "select", "hover", "focus", "open", "close",
    "visible", "hidden", "disabled", "enabled", "error", "warn",
    "checked", "pressed", "collapsed", "expanded", "current", "loading",
)


def _shape(entry: dict) -> str:
    """结构签名：``tag.class1.class2``，去掉状态类 class。"""
    tokens = [t for t in (entry["cls"] or "").split()
              if not any(word in t.lower() for word in STATE_CLASS_WORDS)]
    return entry["tag"] + (("." + ".".join(tokens)) if tokens else "")


def identity_of(entry: dict) -> str:
    """一条目标的"身份"——只认结构，不认文字。

    1. 有 id 用 id（时间戳数字先折叠，否则每次重启套件设备卡都像"消失又出现"）；
    2. 没有 id 用 tag + class（剥掉状态词）；
    3. 连 class 都没有的裸 span，退回"数字折叠后的 label"。

    文字不参与身份：label 变了要报成 ``changed``，而不是"消失 + 新增"两个假警报。
    """
    if entry["id"]:
        return "id:" + normalize_id(entry["id"])
    if entry["cls"]:
        return "tag:" + _shape(entry)
    if entry["label"]:
        return "label:" + re.sub(r"\d+", "#", entry["label"])
    return "tag:" + entry["tag"]


def _index(entries) -> tuple[dict, list]:
    """返回 ``(身份 → 条目, 身份顺序)``；同一页里的重复身份追加 ``@2``、``@3``。"""
    table: dict = {}
    order: list = []
    seen: dict = {}
    for raw in entries or []:
        entry = _entry(raw)
        base = identity_of(entry)
        seen[base] = seen.get(base, 0) + 1
        ident = base if seen[base] == 1 else "%s@%d" % (base, seen[base])
        while ident in table:  # label 自己带 "@2" 这种极端情况
            ident += "*"
        table[ident] = entry
        order.append(ident)
    return table, order


def _with_identity(ident: str, entry: dict) -> dict:
    item = {"identity": ident}
    item.update(entry)
    return item


# ---------------------------------------------------------------- 纯函数：diff
def diff_targets(old, new) -> dict:
    """比较两批目标，返回 ``{"removed", "added", "changed"}``。

    纯函数，不碰套件、不碰文件——单测直接注入两批 dict。

    * ``removed``：基线有、现在没有（按 id/key 匹配）；
    * ``added``：现在多出来的；
    * ``changed``：同一个身份，但 label 或尺寸变了。

    ``cls`` 不参与比较：连接状态会改 class（``device-disconnected`` → ``device-connected``），
    那是运行时状态，不是界面变更。
    """
    old_map, old_order = _index(old)
    new_map, new_order = _index(new)

    removed = [_with_identity(i, old_map[i]) for i in old_order if i not in new_map]
    added = [_with_identity(i, new_map[i]) for i in new_order if i not in old_map]

    changed = []
    for ident in old_order:
        current = new_map.get(ident)
        if current is None:
            continue
        before = old_map[ident]
        changes = {}
        if before["label"] != current["label"]:
            changes["label"] = [before["label"], current["label"]]
        if (before["w"], before["h"]) != (current["w"], current["h"]):
            changes["size"] = [[before["w"], before["h"]], [current["w"], current["h"]]]
        if changes:
            item = _with_identity(ident, current)
            item["changes"] = changes
            changed.append(item)
    return {"removed": removed, "added": added, "changed": changed}


def exit_code(result: dict) -> int:
    """只有 ``removed`` 才是坏消息；added/changed 只提示。"""
    return 1 if result.get("removed") else 0


# ---------------------------------------------------------------- 人读输出
def format_report(page: str, result: dict, *, baseline_count: int,
                  current_count: int) -> str:
    head = "[%s] 基线 %d 个目标 → 当前 %d 个" % (page, baseline_count, current_count)
    if not (result["removed"] or result["added"] or result["changed"]):
        return head + "   无差异"
    lines = [head + "   有差异"]
    if result["removed"]:
        lines.append("  - 消失 %d 个（最危险：流程会点空）" % len(result["removed"]))
        for item in result["removed"]:
            lines.append("      %s  「%s」  %dx%d" % (
                item["identity"], item["label"] or item["key"], item["w"], item["h"]))
    if result["added"]:
        lines.append("  + 新增 %d 个（提示：流程暂时用不到）" % len(result["added"]))
        for item in result["added"]:
            lines.append("      %s  「%s」  %dx%d" % (
                item["identity"], item["label"] or item["key"], item["w"], item["h"]))
    if result["changed"]:
        lines.append("  ~ 变化 %d 个（提示：label/尺寸漂了）" % len(result["changed"]))
        for item in result["changed"]:
            detail = []
            if "label" in item["changes"]:
                detail.append("label 「%s」→「%s」" % tuple(item["changes"]["label"]))
            if "size" in item["changes"]:
                old_size, new_size = item["changes"]["size"]
                detail.append("尺寸 %dx%d → %dx%d" % (old_size[0], old_size[1],
                                                     new_size[0], new_size[1]))
            lines.append("      %s  " % item["identity"] + "; ".join(detail))
    return "\n".join(lines)


# ---------------------------------------------------------------- 基线文件
def load_baseline(path: Path = BASELINE_PATH) -> dict:
    if not Path(path).exists():
        return {"pages": {}}
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise CalibrationError("基线 %s 读不了：%s" % (path, exc)) from exc
    if not isinstance(data, dict) or not isinstance(data.get("pages"), dict):
        raise CalibrationError("基线 %s 结构不对：顶层要有 pages 对象" % path)
    return data


def save_baseline(data: dict, path: Path = BASELINE_PATH) -> None:
    """写基线：定序输出（targets 按文档顺序），只含 captured_at 一个时间量。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def baseline_page(data: dict, page: str) -> dict | None:
    return (data.get("pages") or {}).get(page)


# ---------------------------------------------------------------- 采集与导航
def _element(driver: CdpDriver, selector: str):
    raw = driver.evaluate(_ELEMENT_JS % _js_string(selector))
    if not raw:
        return None
    return json.loads(raw) if isinstance(raw, str) else raw


def _activate(driver: CdpDriver, engine: ClickEngine, step: Step,
              *, force_js: bool = False) -> str:
    """进入一个页面状态。返回实际用的通道（``mouse`` / ``js``），进日志用。

    可见且尺寸够的目标优先走 ClickEngine 的真实鼠标事件；可见性为 0 或点击失败的
    退回 JS click（导航不是流程动作，见模块头说明）。
    """
    info = _element(driver, step.selector)
    if info is None:
        raise CalibrationError("页面上找不到 %s，进不了这个页面状态" % step.selector)
    if step.key and info.get("visible") and not force_js:
        try:
            engine.click(step.key, require_effect=False, allow_danger=step.allow_danger)
            return "mouse"
        except ClickError:
            pass  # 被遮挡 / 刚刷新，退回 JS click
    clicked = driver.evaluate(_CLICK_JS % _js_string(step.selector))
    if not clicked:
        raise CalibrationError("点不动 %s（元素在但脚本没点成）" % step.selector)
    return "js"


def wait_visible(driver: CdpDriver, selector: str, *, timeout: float = 6.0,
                 interval: float = 0.2) -> bool:
    """等一个元素变成"可见且有尺寸"。导航成败就靠它判。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        info = _element(driver, selector)
        if info and info.get("visible"):
            return True
        time.sleep(interval)
    return False


def park_mouse(driver: CdpDriver) -> None:
    """把鼠标停到右下角空白处再采集。

    实测踩到的坑：从首页用真实鼠标点开 Manage 后，指针停在卡片中心，
    设备卡进入 hover 态，凭空多出一个 ``370×212`` 的 ``cursor:pointer`` 内层——
    同一页面采两次，目标数 50 / 51 来回跳。hover 态不是界面结构，
    但它会被采集器看见，所以采集前先让指针离开所有目标。
    """
    size = driver.evaluate("JSON.stringify({w: window.innerWidth, h: window.innerHeight})")
    data = json.loads(size) if isinstance(size, str) else (size or {})
    x = max(1.0, float(data.get("w") or 1024) - 3.0)
    y = max(1.0, float(data.get("h") or 768) - 3.0)
    driver.call("Input.dispatchMouseEvent",
                {"type": "mouseMoved", "x": x, "y": y, "button": "none"})


def settle(engine: ClickEngine, *, timeout: float = 8.0, interval: float = 0.3,
           stable_samples: int = 3):
    """等页面稳定：连续 ``stable_samples`` 次采集签名一致才算稳，稳不住就报错。

    弹窗有 fade 动画、Manage 页在异步发现设备、首页切走时旧页面还在收尾；
    立刻采集会采到中间态，基线里混进中间态，以后每次 diff 都是噪音。
    **稳不住就不写基线**——一个会自己变的目标清单没有校准价值。
    """
    deadline = time.time() + timeout
    signature = None
    repeats = 0
    targets = engine.collect()
    while time.time() < deadline:
        sig = tuple((t.id, t.label, t.w, t.h) for t in targets)
        if sig == signature:
            repeats += 1
            if repeats >= stable_samples - 1:
                return targets
        else:
            signature, repeats = sig, 0
        time.sleep(interval)
        targets = engine.collect()
    raise CalibrationError("页面 %.1fs 内没稳定（目标数一直在变），不拿它当基线" % timeout)


def capture(driver: CdpDriver, engine: ClickEngine) -> list:
    """采当前页：先把指针挪开，再等稳定，最后落成基线条目。"""
    park_mouse(driver)
    return [entry_of(t) for t in settle(engine)]


def dismiss_transients(driver: CdpDriver, engine: ClickEngine,
                       steps=TRANSIENT_STEPS) -> list:
    """关掉会自己冒出来的浮层，只点可见的"关掉"。"""
    closed = []
    for step in steps:
        info = _element(driver, step.selector)
        if not info or not info.get("visible"):
            continue
        _activate(driver, engine, step, force_js=True)
        settle(engine)
        closed.append(step.selector)
    return closed


def go_home(driver: CdpDriver, engine: ClickEngine) -> None:
    """关掉浮层 + 回首页。任何时候都可以调，幂等。"""
    dismiss_transients(driver, engine)
    _activate(driver, engine, HOME_STEP)
    settle(engine)
    dismiss_transients(driver, engine)  # 首页也可能弹出更新提示


def reach(driver: CdpDriver, engine: ClickEngine, page: str, *, attempts: int = 2) -> list:
    """从任意状态进到 ``page``，并验到目标页真的可见了。

    第一次用真实鼠标点击导航；没到位就重来一遍，第二次强制 JS click——
    首页磁贴有入场动画，鼠标点早了一下会打空，而"拍成上一页"必须当成失败。
    """
    if page not in PAGE_STEPS:
        raise CalibrationError("没有 %r 这个页面；已知：%s" % (page, ", ".join(PAGE_ORDER)))
    landmark = PAGE_LANDMARKS[page]
    last_error = None
    for attempt in range(max(1, attempts)):
        force_js = attempt > 0
        try:
            go_home(driver, engine)
            if not wait_visible(driver, PAGE_LANDMARKS["home"]):
                raise CalibrationError("回不到首页：%s 一直不可见" % PAGE_LANDMARKS["home"])
            used = []
            for step in PAGE_STEPS[page][1:]:  # 第一步是回首页，已做过
                used.append("%s=%s" % (step.selector,
                                       _activate(driver, engine, step, force_js=force_js)))
                settle(engine)
                dismiss_transients(driver, engine, POPUP_STEPS)  # 打开 App 会触发更新检查
            if wait_visible(driver, landmark):
                return used
            last_error = CalibrationError("没进到 %s：%s 一直不可见" % (page, landmark))
        except (CalibrationError, ClickError) as exc:
            last_error = exc
        time.sleep(0.4)
    raise CalibrationError("导航失败（%s）：%s" % (page, last_error))


# ---------------------------------------------------------------- CLI
def _csv(text: str) -> list:
    pages = [part.strip() for part in str(text or "").split(",") if part.strip()]
    if not pages or pages == ["all"]:
        return list(PAGE_ORDER)
    unknown = [p for p in pages if p not in PAGE_STEPS]
    if unknown:
        raise CalibrationError("没有 %s 这个页面；已知：%s"
                               % (", ".join(unknown), ", ".join(PAGE_ORDER)))
    return pages


def sanitize_url(url: str) -> str:
    """把 URL 里的本机用户目录抹掉，基线要入库，不能带机器路径与用户名。"""
    text = str(url or "")
    text = re.sub(r"(?i)file:///[a-z]:[/\\]users[/\\][^/\\]+", "file://<home>", text)
    text = re.sub(r"(?i)[a-z]:[/\\]users[/\\][^/\\]+", "<home>", text)
    text = re.sub(r"(?i)^/home/[^/]+", "<home>", text)
    return text


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="RPA 目标基线校准：一条 diff 告诉你界面哪里变了",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例：\n"
               "  python tools/rpa_calibrate.py --dump all\n"
               "  python tools/rpa_calibrate.py --diff home\n"
               "  python tools/rpa_calibrate.py --pages home,manage --diff --json\n"
               "  python tools/rpa_calibrate.py --diff manage --baseline tmp.json\n"
               "  python tools/rpa_calibrate.py --write manage --yes\n",
    )
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--dump", nargs="?", const="all", metavar="PAGES",
                        help="采当前页面写进基线（PAGES 省略时用 --pages 或全部页面）")
    action.add_argument("--diff", nargs="?", const="all", metavar="PAGES",
                        help="当前页面与基线比，有 removed 退出 1")
    action.add_argument("--write", nargs="?", const="all", metavar="PAGES",
                        help="把当前页面写回基线；必须加 --yes（人工确认后）")
    parser.add_argument("--pages", metavar="PAGES",
                        help="批量页名，逗号分隔：home,manage,device-dialog（all = 全部）")
    parser.add_argument("--json", action="store_true", help="机读输出")
    parser.add_argument("--no-nav", action="store_true",
                        help="不切页，直接采屏幕上现在这一页（默认会切到目标页再采）")
    parser.add_argument("--baseline", metavar="PATH", default=str(BASELINE_PATH),
                        help="基线文件，默认 tools/rpa_targets.json")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help="CDP 端口，默认 %d（或环境变量 FSA_CDP_PORT）" % DEFAULT_PORT)
    parser.add_argument("--yes", action="store_true",
                        help="--write 的确认开关（没有它就只打印差异，不写文件）")
    return parser


def main(argv: list | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        pages = _csv(args.pages or args.dump or args.diff or args.write)
    except CalibrationError as exc:
        print("[参数] %s" % exc, file=sys.stderr)
        return 2

    baseline_path = Path(args.baseline)
    try:
        baseline = load_baseline(baseline_path)
    except CalibrationError as exc:
        print("[基线] %s" % exc, file=sys.stderr)
        return 2

    mode = "dump" if args.dump is not None else ("diff" if args.diff is not None else "write")

    if mode == "diff":
        missing = [p for p in pages if baseline_page(baseline, p) is None]
        if missing:
            print("[基线] %s 里没有 %s；先跑 --dump"
                  % (baseline_path, ", ".join(missing)), file=sys.stderr)
            return 2

    driver = CdpDriver(args.port)
    try:
        driver.connect()
    except GuiUnavailable as exc:
        print("[阻断] %s" % exc, file=sys.stderr)
        return 2

    engine = ClickEngine(driver)
    results: dict = {}
    meta: dict = {}
    try:
        for page in pages:
            nav = reach(driver, engine, page) if not args.no_nav else ["未切页"]
            current = capture(driver, engine)
            if not args.no_nav and not wait_visible(driver, PAGE_LANDMARKS[page]):
                raise CalibrationError(
                    "采集时页面已经不是 %s 了（%s 不可见），这页的 diff 不可信"
                    % (page, PAGE_LANDMARKS[page]))
            url = sanitize_url(driver.evaluate("location.href") or "")
            old_page = baseline_page(baseline, page)
            result = diff_targets((old_page or {}).get("targets") or [], current)
            results[page] = result
            meta[page] = {
                "nav": nav,
                "url": url,
                "captured_at": _now(),
                "current_count": len(current),
                "baseline_count": len((old_page or {}).get("targets") or []),
                "current": current,
            }
    except (CalibrationError, GuiUnavailable) as exc:
        print("[阻断] %s" % exc, file=sys.stderr)
        return 2
    finally:
        if not args.no_nav:
            try:
                go_home(driver, engine)  # 不给别人留残留状态（对话框已 Cancel）
                if not wait_visible(driver, PAGE_LANDMARKS["home"]):
                    print("[收尾] 没回到首页，请手工看一眼套件", file=sys.stderr)
            except (CalibrationError, GuiUnavailable) as exc:
                print("[收尾] 没能恢复到首页：%s" % exc, file=sys.stderr)
        driver.close()

    removed_total = sum(len(results[p]["removed"]) for p in pages)
    added_total = sum(len(results[p]["added"]) for p in pages)
    changed_total = sum(len(results[p]["changed"]) for p in pages)
    # 退出码只回答一个问题："基线还跟界面一致吗？"
    # --dump / --write 之后基线已经和界面一致，所以只有 --diff 会因为 removed 退出 1。
    pending_write = mode == "write" and not args.yes
    code = 3 if pending_write else (1 if (mode == "diff" and removed_total) else 0)

    if mode == "dump" or (mode == "write" and args.yes):
        for page in pages:
            baseline.setdefault("pages", {})[page] = {
                "url": meta[page]["url"],
                "captured_at": meta[page]["captured_at"],
                "targets": meta[page]["current"],
            }
        save_baseline(baseline, baseline_path)

    if args.json:
        payload = {
            "mode": mode,
            "baseline": str(baseline_path),
            "ok": code == 0,
            "needs_confirm": pending_write,
            "removed": removed_total,
            "added": added_total,
            "changed": changed_total,
            "written": mode == "dump" or (mode == "write" and args.yes),
            "pages": {},
        }
        for page in pages:
            payload["pages"][page] = {
                "removed": results[page]["removed"],
                "added": results[page]["added"],
                "changed": results[page]["changed"],
                "baseline": {
                    "count": meta[page]["baseline_count"],
                    "captured_at": ((baseline_page(baseline, page) or {})
                                    .get("captured_at")),
                },
                "current": {"count": meta[page]["current_count"],
                            "url": meta[page]["url"],
                            "captured_at": meta[page]["captured_at"]},
            }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return code

    for page in pages:
        print(format_report(page, results[page],
                            baseline_count=meta[page]["baseline_count"],
                            current_count=meta[page]["current_count"]))
    print("")
    if mode == "dump":
        print("已写入基线 %s（%d 页：%s）"
              % (baseline_path, len(pages), ", ".join(pages)))
        if removed_total:
            print("注意：这次 dump 抹掉了 %d 个旧基线里的目标——如果那是误操作，"
                  "从 git 恢复基线再采一次。" % removed_total)
    elif mode == "write" and not args.yes:
        print("没有写任何东西：--write 必须人工确认后加 --yes 才会覆盖基线。")
        print("确认界面变更属实（例如套件升级）后再跑：")
        print("  python tools/rpa_calibrate.py --write %s --yes" % ",".join(pages))
        return 3
    elif mode == "write":
        print("已改写基线 %s（%d 页：%s）；removed %d / added %d / changed %d"
              % (baseline_path, len(pages), ", ".join(pages),
                 removed_total, added_total, changed_total))
    elif code == 0:
        print("没有 removed：界面结构没塌（added/changed 只当提示看）。")
    else:
        print("有 %d 个目标消失——先别改流程，先确认这是界面变更还是基线过期。"
              % removed_total)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
