#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把"页面上有哪些可点目标"冻成 fixture，并在不启动套件时核对 locator 还解析得出来。

## 为什么有它

``workflows/*.yaml`` 里的 ``target:`` 定位（``#id`` / ``label`` / ``label@2``）依赖
两件事：目标当时在页面上、而且 ``click_engine.pick`` 的匹配规则没变。前者需要套件
（CDP 9223）才能验证，后者其实不需要——只要有一份"当时采集到的目标列表"。

所以这个工具把两者拆开：

* ``--capture``：连着套件，把当前页的可点目标（``click_engine.collect``）原样存下来；
* ``--replay``：**不连套件**，只读 ``targets.json``，把 ``locators.json`` 里每条
  locator 过一遍 ``pick()``，全中才算过。

它证明的是"定位解析仍然有效"（选择器还能唯一命中当时那个目标），
**不是**"DOM 还长这样"——页面改版后仍需重新 ``--capture``。

## 用法

```powershell
# 1) 把套件切到目标页面（--goto，动作与 docs/operations/rpa-fixture.md 一致）
python tools/rpa_fixture.py --goto manage --capture manage --html
# 2) 登记这一页流程会用到的 locator（会先在本页验证一遍，全中才写盘）
python tools/rpa_fixture.py --capture-locators manage `
  --locator "#add_device_btn" --locator "Add Device" --locator "Manage" --locator "Help"
# 3) 回放（不需要套件）
python tools/rpa_fixture.py --replay manage
python tools/rpa_fixture.py --replay-all
# 4) 收尾：关掉残留弹窗并回首页
python tools/rpa_fixture.py --restore-home
```

只依赖标准库 + 本仓库的 ``cdp_driver`` / ``click_engine``。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ROOT = REPO_ROOT / "tests" / "fixtures" / "rpa"
DEFAULT_PORT = 9223
MAX_HTML_BYTES = 2 * 1024 * 1024

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

try:  # 仓库内以 `python tools/rpa_fixture.py` 方式运行时
    from tools.click_engine import ClickEngine, ClickError, Target, parse_targets, pick
except ImportError:  # 以脚本所在目录为 sys.path[0] 时
    from click_engine import ClickEngine, ClickError, Target, parse_targets, pick  # type: ignore

SUITE_VERSION_RE = re.compile(r"NovAtelApplicationSuite/([0-9][0-9A-Za-z.\-]*)")
HOME_PATH_RE = re.compile(r"(file:///[A-Za-z]:/Users/)[^/]+/", re.IGNORECASE)


def sanitize_url(url) -> str:
    """把 ``file:///C:/Users/<名字>/...`` 里的用户名换成 ``<user>``。

    fixture 要进仓库，元数据里不该留下本机用户名（``tools/check_desensitization.py``
    的 home_path 规则会命中）。除用户名外保持原样，仍能看出是哪个页面。
    """
    text = str(url or "")
    text = HOME_PATH_RE.sub(r"\1<user>/", text)
    return re.sub(r"([A-Za-z]:\\Users\\)[^\\]+", r"\1<user>", text)


# ---------------------------------------------------------------- fixture 路径
def page_dir(root, page: str) -> Path:
    return Path(root) / page


def targets_path(root, page: str) -> Path:
    return page_dir(root, page) / "targets.json"


def locators_path(root, page: str) -> Path:
    return page_dir(root, page) / "locators.json"


def meta_path(root, page: str) -> Path:
    return page_dir(root, page) / "meta.json"


# ---------------------------------------------------------------- 读 fixture
def load_locators(root, page: str) -> list:
    """读 locators.json。允许 ``{"locators": [...]}`` 或裸数组两种写法。"""
    path = locators_path(root, page)
    if not path.exists():
        raise FileNotFoundError("没有 %s（先跑 --capture-locators %s）" % (path, page))
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("locators") or []
    if not isinstance(data, list) or not all(isinstance(x, str) for x in data):
        raise ValueError("%s 里的 locators 必须是字符串数组" % path)
    return list(data)


def load_targets(root, page: str, targets=None) -> list:
    """读 targets.json 并解析成 Target 列表。

    ``targets`` 非空时直接用它（Target 列表或原始 dict 列表），供单测注入，
    此时完全不碰文件系统。
    """
    if targets is not None:
        if targets and all(isinstance(t, Target) for t in targets):
            return list(targets)
        return parse_targets(targets)
    path = targets_path(root, page)
    if not path.exists():
        raise FileNotFoundError("没有 %s（先跑 --capture %s）" % (path, page))
    return parse_targets(json.loads(path.read_text(encoding="utf-8")))


# ---------------------------------------------------------------- 回放
def classify_error(exc) -> str:
    """把 pick() 的报错归成三类，报告里直接可读。"""
    text = str(exc)
    if "不唯一" in text:
        return "不唯一"
    if "取不到" in text:
        return "越界"
    return "找不到"


def replay_page(root, page: str, targets=None, locators=None) -> list:
    """回放一页，返回逐条结果。不连套件、不写盘、不含时间。

    结果项：``{"locator", "ok", "kind", "detail"}``；命中时 ``detail`` 是目标的
    ``idx/tag/id/label``，未命中时是 ``pick()`` 的原文报错。
    """
    keys = load_locators(root, page) if locators is None else list(locators)
    pool = load_targets(root, page, targets)
    results = []
    if not keys:
        results.append({"locator": "", "ok": False, "kind": "空清单",
                        "detail": "%s/locators.json 里没有 locator" % page})
        return results
    for key in keys:
        try:
            target = pick(pool, key)
        except ClickError as exc:
            results.append({"locator": key, "ok": False,
                            "kind": classify_error(exc), "detail": str(exc)})
        else:
            results.append({"locator": key, "ok": True, "kind": "ok",
                            "detail": "%s#%s %r" % (target.tag, target.id or target.cls,
                                                   target.label)})
    return results


def replay_all(root, targets_by_page=None) -> list:
    """遍历 fixture 目录回放。返回 ``[(page, results), ...]``，按页名排序。"""
    base = Path(root)
    if not base.is_dir():
        raise FileNotFoundError("fixture 目录不存在：%s" % base)
    pairs = []
    for child in sorted(p for p in base.iterdir() if p.is_dir()):
        if not targets_path(base, child.name).exists():
            continue
        injected = None
        if targets_by_page:
            injected = targets_by_page.get(child.name)
        results = replay_page(base, child.name, targets=injected)
        pairs.append((child.name, results))
    return pairs


def print_results(page: str, results: list) -> None:
    width = max([len(r["locator"]) for r in results] + [7])
    for item in results:
        if item["ok"]:
            print("[%s] OK    %-*s -> %s" % (page, width, item["locator"], item["detail"]))
        else:
            print("[%s] %-5s %-*s -> %s" % (page, item["kind"], width,
                                            item["locator"], item["detail"]))


def results_ok(results: list) -> bool:
    return bool(results) and all(r["ok"] for r in results)


# ---------------------------------------------------------------- 写 fixture
def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n",
                    encoding="utf-8")


def capture(root, page: str, driver, *, want_html: bool = False) -> dict:
    """采集当前页面的可点目标 + meta。返回写出的 meta。"""
    engine = ClickEngine(driver)
    targets = engine.collect()
    viewport = driver.evaluate(
        "JSON.stringify([innerWidth, innerHeight, devicePixelRatio || 1])") or "[0,0,1]"
    width, height, ratio = json.loads(viewport)
    ua = driver.evaluate("navigator.userAgent") or ""
    match = SUITE_VERSION_RE.search(str(ua))
    url = driver.evaluate("location.href") or ""

    raw = [{"idx": t.idx, "tag": t.tag, "id": t.id, "cls": t.cls,
            "label": t.label, "w": t.w, "h": t.h} for t in targets]
    write_json(targets_path(root, page), raw)

    meta = {
        "page": page,
        "url": sanitize_url(url),
        "viewport": {"width": int(width), "height": int(height),
                     "device_pixel_ratio": float(ratio)},
        "captured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "suite_version": match.group(1) if match else None,
        "target_count": len(raw),
    }
    if want_html:
        html = driver.evaluate("document.documentElement.outerHTML") or ""
        body = html.encode("utf-8")
        meta["html_truncated"] = len(body) > MAX_HTML_BYTES
        body = body[:MAX_HTML_BYTES]
        (page_dir(root, page) / "page.html").write_bytes(body)
        meta["html"] = "page.html"
        meta["html_bytes"] = len(body)
    write_json(meta_path(root, page), meta)
    return meta


def save_locators(root, page: str, locators, targets=None) -> list:
    """写 locators.json。

    给了 ``targets`` 就先在本页验一遍：**只有全部命中才写盘**——否则留下的
    locator 会在 CI 里天天红，而且分不清是"页面改版"还是"当初就没录对"。
    """
    results = (replay_page(root, page, targets=targets, locators=locators)
               if targets is not None else [])
    if targets is not None and not results_ok(results):
        return results
    write_json(locators_path(root, page), {"page": page, "locators": list(locators)})
    return results


# ---------------------------------------------------------------- 页面状态切换
#: 与 docs/operations/rpa-fixture.md 的手工步骤一一对应。只做"打开页面/弹窗"，
#: 不提交任何数据（对话框一律停在 Add 之前）。
#: 每项 ``(方式, 目标, 等多久, 该步成功后应读到的文字)``；文字为 None 表示不检查。
GOTO_ACTIONS = {
    "home": [
        ("css", "a.homemenu-title", 2.0, "My Applications"),
    ],
    "manage": [
        ("css", "a.homemenu-title", 2.0, "My Applications"),
        ("css", "#sm-welcome", 1.5, "All devices"),
    ],
    "device-dialog": [
        ("css", "a.homemenu-title", 2.0, "My Applications"),
        ("css", "#sm-welcome", 1.5, "All devices"),
        ("css", "#add_device_btn", 2.0, "New Connection"),
        ("target", "Serial", 1.0, None),
    ],
    "update-popup": [
        ("css", "a.homemenu-title", 2.0, "My Applications"),
        ("css", "#settings-banner", 1.0, "Check For Updates"),
        ("target", "Check For Updates", 1.0, None),
    ],
}


def _click_step(driver, kind: str, value: str) -> None:
    if kind == "css":
        driver.click("css:" + value)
    else:
        ClickEngine(driver).click(value, require_effect=False, timeout=6.0,
                                  allow_danger=(value == "Check For Updates"))


def go_to(driver, state: str) -> None:
    """把套件切到 ``state``；不认识的页面直接报错，不猜。"""
    if state not in GOTO_ACTIONS:
        raise ValueError("不认识的页面状态 %r，可选：%s"
                         % (state, ", ".join(sorted(GOTO_ACTIONS))))

    for kind, value, settle, expect in GOTO_ACTIONS[state]:
        _click_step(driver, kind, value)
        time.sleep(settle)
        if expect and expect not in _body_text(driver):
            # 首页卡片异步绑定点击（实测约 9 秒才稳），第一下可能点空；补一次
            time.sleep(1.5)
            _click_step(driver, kind, value)
            time.sleep(settle)
            if expect not in _body_text(driver):
                raise RuntimeError("%s 没切过去：页面上读不到 %r" % (state, expect))
    if state == "update-popup":
        # 更新检查要联网，弹窗不是同步出现；等到正文里出现结论或版本行
        _wait_until(driver, "Update", timeout=20.0)
        _wait_until(driver, "Current Version", timeout=10.0)


def _body_text(driver) -> str:
    return driver.evaluate("document.body ? document.body.innerText : ''") or ""


def _wait_until(driver, needle: str, timeout: float) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        text = driver.evaluate("document.body ? document.body.innerText : ''") or ""
        if needle in text:
            return True
        time.sleep(0.5)
    return False


def _popup_open(driver) -> bool:
    """更新弹窗是否真的可见（它关掉后节点仍在 DOM，只是尺寸为 0）。"""
    raw = driver.evaluate(
        "(() => { const n = document.querySelector('.update-software-popup');"
        " return n ? (n.getBoundingClientRect().width > 0 && "
        "n.getBoundingClientRect().height > 0) : false; })()")
    if raw:
        return True
    text = driver.evaluate("document.body ? document.body.innerText : ''") or ""
    return "Current Version" in text or "is up to date" in text


def restore_home(driver) -> list:
    """关掉可能残留的弹窗，再回首页。返回实际做了哪些动作。"""
    engine = ClickEngine(driver)
    done = []
    if _popup_open(driver):
        try:
            engine.click("Close", require_effect=False, timeout=3.0)
            done.append("close:update-popup")
        except ClickError:
            pass
        time.sleep(0.5)
    text = driver.evaluate("document.body ? document.body.innerText : ''") or ""
    if "New Connection" in text:
        try:
            engine.click("Cancel", require_effect=False, timeout=3.0)
            done.append("close:device-dialog")
        except ClickError:
            pass
        time.sleep(0.5)
    driver.click("css:a.homemenu-title")
    done.append("goto:home")
    time.sleep(2.0)
    if "My Applications" not in _body_text(driver):
        raise RuntimeError("点了 a.homemenu-title 但没回到首页")
    return done


# ---------------------------------------------------------------- CLI
def _connect(port: int):
    try:
        from tools.cdp_driver import CdpDriver
    except ImportError:
        from cdp_driver import CdpDriver  # type: ignore
    driver = CdpDriver(port)
    driver.connect()
    return driver


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="RPA 目标 fixture：采集 / 登记 locator / 无套件回放")
    parser.add_argument("--root", default=str(DEFAULT_ROOT),
                        help="fixture 根目录（默认 tests/fixtures/rpa）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT,
                        help="套件 CDP 端口（默认 9223，也可用 FSA_CDP_PORT）")
    parser.add_argument("--capture", metavar="PAGE", help="采集当前页可点目标")
    parser.add_argument("--capture-locators", metavar="PAGE",
                        help="为这一页登记 locators.json")
    parser.add_argument("--locator", action="append", default=[],
                        metavar="KEY", help="可重复：要登记的 locator（如 #sm-welcome）")
    parser.add_argument("--html", action="store_true", help="采集时额外存 page.html（≤2 MB）")
    parser.add_argument("--goto", metavar="PAGE",
                        help="先切到页面状态：%s" % "/".join(sorted(GOTO_ACTIONS)))
    parser.add_argument("--restore-home", action="store_true",
                        help="关掉残留弹窗并回到首页")
    parser.add_argument("--replay", metavar="PAGE", help="不连套件，回放这一页的 locator")
    parser.add_argument("--replay-all", action="store_true", help="回放 fixture 根目录下所有页")
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(args.root)

    if args.replay or args.replay_all:
        pairs = (replay_all(root) if args.replay_all
                 else [(args.replay, replay_page(root, args.replay))])
        ok_all = True
        for page, results in pairs:
            print_results(page, results)
            if not results_ok(results):
                ok_all = False
        if not pairs:
            print("没有可回放的 fixture（%s）" % root, file=sys.stderr)
            return 1
        if len(pairs) > 1:
            print("共 %d 页：%s" % (len(pairs), "全部通过" if ok_all else "有失效 locator"))
        return 0 if ok_all else 1

    needs_live = bool(args.capture or args.capture_locators or args.goto or args.restore_home)
    if not needs_live:
        build_parser().print_help()
        return 2

    driver = _connect(args.port)
    try:
        if args.goto:
            go_to(driver, args.goto)
            print("已切到 %s" % args.goto)
        if args.capture:
            meta = capture(root, args.capture, driver, want_html=args.html)
            print("采集 %s：%d 个目标 -> %s"
                  % (args.capture, meta["target_count"], targets_path(root, args.capture)))
        if args.capture_locators:
            if not args.locator:
                print("--capture-locators 需要至少一个 --locator", file=sys.stderr)
                return 2
            pool = ClickEngine(driver).collect()
            results = save_locators(root, args.capture_locators, args.locator, targets=pool)
            print_results(args.capture_locators, results)
            if not results_ok(results):
                print("有 locator 在本页解析不出来，未写盘", file=sys.stderr)
                return 1
            print("登记 %d 条 locator -> %s"
                  % (len(args.locator), locators_path(root, args.capture_locators)))
        if args.restore_home:
            print("收尾：" + ", ".join(restore_home(driver)))
        return 0
    finally:
        driver.close()


if __name__ == "__main__":
    raise SystemExit(main())
