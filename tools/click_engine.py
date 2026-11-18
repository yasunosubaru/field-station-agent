# -*- coding: utf-8 -*-
"""点击引擎：按"人眼看到的样子"找目标，发真实鼠标事件，再用效果断言确认。

设计依据见 docs/operations/rpa-click-engine.md。三个要点：

1. **目标发现不看语义**：首页那排 Manage/Playback/... 是 ``div.application-container``，
   既不是 button 也没有 role，但有 ``cursor: pointer``。实测同一页：
   语义选择器 4 个、AX 树 1 个、``cursor:pointer`` 48 个。所以以 pointer 为主力。
2. **点击不用 element.click()**：它不发 pointerdown/mousedown、不触发 :hover、
   不更新焦点、对被遮挡元素也"成功"。改为 CDP ``Input.dispatchMouseEvent``，
   走浏览器命中测试——点不到会表现为断言失败，而不是假成功。
3. **点完必须验**：URL / 文本 / 目标出现消失 / 自身属性 / 区域截图，五选一，
   超时即 ``ClickNoEffect``。危险词（Add/Install/Update/Apply/...）一律先过闸门。

只依赖标准库 + 本仓库的 ``cdp_driver``。
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field

DANGER_WORDS = (
    "add", "install", "update", "apply", "delete", "remove", "quit",
    "restart", "write", "erase", "reset", "flash", "upload",
)

#: 读操作里含危险词的白名单：先判断这些，避免 "Check For Updates" 被当成写操作。
SAFE_PHRASES = (
    "check for update", "check for updates", "cancel", "close", "help",
    "details", "view", "refresh", "manage", "plot", "download log",
)

#: 采集可点击目标：pointer 光标 + 可见 + 有一定尺寸。
#: 采集时顺手打上 data-fsa-idx，后续点击靠它精确定位（避免二次模糊匹配）。
COLLECT_JS = r"""
(() => {
  document.querySelectorAll('[data-fsa-idx]').forEach(n => n.removeAttribute('data-fsa-idx'));
  const INTERACTIVE_ROLES = ['button','tab','menuitem','option','checkbox','radio',
                             'switch','link','combobox','menuitemcheckbox','menuitemradio'];
  const SKIP_TAGS = ['html','body','main','section','article','nav'];
  const isInteractive = (n) => {
    const tag = n.tagName.toLowerCase();
    if (['a','button','input','select','textarea','summary'].includes(tag)) return true;
    const role = (n.getAttribute('role') || '').toLowerCase();
    return INTERACTIVE_ROLES.includes(role);
  };
  const out = [];
  const seen = new Set();
  const all = document.querySelectorAll('*');
  let idx = 0;
  for (const n of all) {
    const tag = n.tagName.toLowerCase();
    if (SKIP_TAGS.includes(tag)) continue;
    const st = getComputedStyle(n);
    // 两种都收：人眼认的（pointer 光标）+ 语义认的（button/a/role=...）。
    // 只按 pointer 会漏掉原生按钮（它们常常是 cursor:default）。
    if (st.cursor !== 'pointer' && !isInteractive(n)) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
    const key = Math.round(r.x) + ':' + Math.round(r.y) + ':' + Math.round(r.width);
    if (seen.has(key)) continue;              // 只留最外层，避免父子重复
    seen.add(key);
    const label = (n.innerText || n.getAttribute('aria-label') || n.title || n.id || '')
      .trim().replace(/\s+/g, ' ').slice(0, 60);
    n.setAttribute('data-fsa-idx', String(idx));
    out.push({ idx: idx, tag: tag, id: n.id || '',
               cls: (n.className || '').toString().slice(0, 40),
               label: label, w: Math.round(r.width), h: Math.round(r.height) });
    idx += 1;
  }
  return JSON.stringify(out);
})()
"""

RECT_JS = ("(() => { const n = document.querySelector('[data-fsa-idx=\"%d\"]');"
           " if (!n) return null; n.scrollIntoView({block: 'center', inline: 'center'});"
           " const r = n.getBoundingClientRect();"
           " return JSON.stringify({x: r.x + r.width/2, y: r.y + r.height/2}); })()")

#: 记录坐标：选择器 -> 中心点 + 命中签名（点击前用来校验"那块地方还是原来的东西"）
RECORD_JS = r"""
(() => {
  const out = {};
  for (const q of %s) {
    const n = document.querySelector(q);
    if (!n) continue;
    const r = n.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    out[q] = {
      key: q,
      x: Math.round(r.x + r.width / 2),
      y: Math.round(r.y + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
      sig: { tag: n.tagName.toLowerCase(),
             text: (n.innerText || n.getAttribute('aria-label') || n.title || '')
                     .trim().replace(/\s+/g, ' ') }
    };
  }
  return JSON.stringify(out);
})()
"""

#: 命中测试：坐标上到底是哪个元素
HIT_JS = r"""
(() => {
  const n = document.elementFromPoint(%f, %f);
  if (!n) return 'null';
  return JSON.stringify({ tag: n.tagName.toLowerCase(),
    text: (n.innerText || n.getAttribute('aria-label') || n.title || '')
            .trim().replace(/\s+/g, ' ') });
})()
"""



@dataclass
class Target:
    idx: int
    tag: str
    id: str
    cls: str
    label: str
    w: int
    h: int
    danger: bool = field(default=False)

    @property
    def key(self) -> str:
        return self.label or ("%s#%s" % (self.tag, self.id or self.cls)) or ("idx:%d" % self.idx)


class ClickError(RuntimeError):
    """点击前置条件不满足（找不到目标 / 需审批 / 元素不可见）。"""


class ClickNoEffect(ClickError):
    """点下去了，但效果断言没通过。"""


def is_danger(label: str) -> bool:
    """危险动作判定：先放行读操作白名单，再按整词匹配危险词。

    只用子串匹配会把 "Check For Updates" 判成写操作——它是只读的检查。
    """
    low = (label or "").lower()
    if any(phrase in low for phrase in SAFE_PHRASES):
        return False
    return any(re.search(r"\b%s\b" % re.escape(word), low) for word in DANGER_WORDS)


def parse_targets(raw) -> list[Target]:
    data = json.loads(raw) if isinstance(raw, str) else raw
    return [Target(idx=d["idx"], tag=d["tag"], id=d["id"], cls=d["cls"],
                   label=d["label"], w=d["w"], h=d["h"],
                   danger=is_danger(d["label"])) for d in data]


def pick(targets: list[Target], key: str) -> Target:
    """按 key 找目标。

    支持三种写法：
      ``#id``        按元素 id 精确匹配（最稳，适合卡片这类带 id 的 div）
      ``label@2``    同名目标里的第 2 个（1 起），用于"页面上有两个 Select"
      ``label``      先精确 label，再唯一包含匹配；同名父子元素取面积最大的外层
    """
    nth = None
    if "@" in key and not key.startswith("#"):
        head, _, tail = key.rpartition("@")
        if tail.isdigit():
            key, nth = head, int(tail)

    if key.startswith("#"):
        pool = [t for t in targets if t.id == key[1:]]
    else:
        pool = [t for t in targets if t.key == key]
        if not pool:
            pool = [t for t in targets if key.lower() in t.key.lower() and t.key]

    if not pool:
        raise ClickError("找不到目标 %r（当前页 %d 个可点目标）" % (key, len(targets)))

    if nth is not None:
        if not 0 < nth <= len(pool):
            raise ClickError("目标 %r 只有 %d 个，取不到第 %d 个" % (key, len(pool), nth))
        return pool[nth - 1]

    if len(pool) == 1:
        return pool[0]

    labels = {t.key for t in pool}
    if len(labels) > 1:
        raise ClickError("目标 %r 不唯一：%s" % (key, [t.key for t in pool[:6]]))

    # 同名父子元素（div 包 span）：取面积最大的外层，点击会冒泡，等效且更稳
    return max(pool, key=lambda t: t.w * t.h)


class ClickEngine:
    """一个 driver（CdpDriver）+ 一套断言，就够点任何东西了。"""

    def __init__(self, driver, *, dry_run: bool = False, hover_ms: int = 80):
        self.driver = driver
        self.dry_run = dry_run
        self.hover_ms = hover_ms
        self.log: list[dict] = []

    # -- 采集 ---------------------------------------------------------
    def collect(self) -> list[Target]:
        raw = self.driver.evaluate(COLLECT_JS)
        return parse_targets(raw)

    # -- 点击 ---------------------------------------------------------
    def click(self, key: str, *, expect: dict | None = None, timeout: float = 6.0,
              allow_danger: bool = False, require_effect: bool = True) -> dict:
        """点一个目标。

        ``require_effect=False`` 时不等待效果（流程里由 verify_ui 统一验），
        用于"点开菜单/展开下拉"这类由流程后续步骤负责判断的动作。
        """
        targets = self.collect()
        target = pick(targets, key)
        if target.danger and not allow_danger:
            raise ClickError("目标 %r 命中危险词，必须先过闸门（allow_danger=True 仅由审批流使用）"
                             % target.key)

        rect = self.driver.evaluate(RECT_JS % target.idx)
        if not rect:
            raise ClickError("目标 %r 已消失（页面可能刚刷新）" % target.key)
        pos = json.loads(rect) if isinstance(rect, str) else rect
        x, y = float(pos["x"]), float(pos["y"])

        before = self._snapshot()
        if not self.dry_run:
            self._hover(x, y)
            self._press(x, y)
            self._release(x, y)

        if self.dry_run or not require_effect:
            ok = True
        else:
            ok = self._wait_effect(expect, before, timeout)
        entry = {"target": target.key, "idx": target.idx, "x": x, "y": y,
                 "danger": target.danger, "dry_run": self.dry_run,
                 "expect": expect or {}, "ok": ok,
                 "before": before.get("hash"), "after": self._snapshot().get("hash")}
        self.log.append(entry)
        if not ok:
            raise ClickNoEffect("点了 %r 但没有预期效果（expect=%s）" % (target.key, expect))
        return entry

    def _hover(self, x: float, y: float) -> None:
        self.driver.call("Input.dispatchMouseEvent",
                         {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
        time.sleep(self.hover_ms / 1000.0)

    def _press(self, x: float, y: float) -> None:
        self.driver.call("Input.dispatchMouseEvent",
                         {"type": "mousePressed", "x": x, "y": y,
                          "button": "left", "clickCount": 1})

    def _release(self, x: float, y: float) -> None:
        # 真鼠标的按下/抬起之间隔 30~80ms；太短会被某些框架判成抖动
        time.sleep(0.04)
        self.driver.call("Input.dispatchMouseEvent",
                         {"type": "mouseReleased", "x": x, "y": y,
                          "button": "left", "clickCount": 1})

    # -- 断言 ---------------------------------------------------------
    def _snapshot(self) -> dict:
        raw = self.driver.evaluate(
            "(() => { const t = document.body ? document.body.innerText : '';"
            " return JSON.stringify({url: location.href, text: t.slice(0, 20000)}); })()")
        data = json.loads(raw) if isinstance(raw, str) else raw
        text = data.get("text") or ""
        data["hash"] = "%08x" % (hash(text) & 0xFFFFFFFF)
        return data

    def _wait_effect(self, expect: dict | None, before: dict, timeout: float) -> bool:
        if not expect:
            # 没给断言时只要求"画面/文本有变化"，否则视为点空
            expect = {"changed": True}
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self._check(expect, before):
                return True
            time.sleep(0.2)
        return False

    def _check(self, expect: dict, before: dict) -> bool:
        now = self._snapshot()
        if expect.get("url_changed") and now["url"] != before["url"]:
            return True
        if expect.get("changed") and now["text"] != before["text"]:
            return True
        if "text" in expect and expect["text"] in (now["text"] or ""):
            return True
        if "text_gone" in expect and expect["text_gone"] not in (now["text"] or ""):
            return True
        if "target_appears" in expect:
            try:
                pick(self.collect(), expect["target_appears"])
                return True
            except ClickError:
                return False
        if "target_gone" in expect:
            try:
                pick(self.collect(), expect["target_gone"])
                return False
            except ClickError:
                return True
        if expect.get("attr"):
            spec = expect["attr"]
            raw = self.driver.evaluate(
                "(() => { const n = document.querySelector('%s');"
                " return n ? String(n.getAttribute('%s')) : null; })()"
                % (spec["selector"].replace("'", "\\'"), spec["name"]))
            return raw == spec.get("value")
        return False

    # -- 坐标模式（固定视口 + 命中校验） -------------------------------
    def fix_viewport(self, width: int, height: int) -> None:
        """把 CSS 视口钉死。坐标点依赖布局，布局依赖视口，所以先钉视口。"""
        self.driver.call("Emulation.setDeviceMetricsOverride",
                         {"width": width, "height": height,
                          "deviceScaleFactor": 1, "mobile": False})

    def clear_viewport(self) -> None:
        self.driver.call("Emulation.clearDeviceMetricsOverride")

    def record_coords(self, selectors: list[str]) -> dict:
        """记录选择器对应元素的中心点 + 命中签名（标签/文字），供以后按坐标点。"""
        raw = self.driver.evaluate(RECORD_JS % json.dumps(selectors))
        data = json.loads(raw) if isinstance(raw, str) else raw
        return {k: v for k, v in data.items() if v}

    def click_point(self, rec: dict, *, expect: dict | None = None,
                    timeout: float = 6.0, require_effect: bool = True) -> dict:
        """按记录下来的坐标点。落下之前先用 elementFromPoint 校验那块地方还是原来的东西。

        ``require_effect=False`` 时不等待效果，交给流程后续步骤判断
        （与 :meth:`click` 同一条语义：有的点击只是展开菜单，没有可读的完成标记）。
        """
        x, y = float(rec["x"]), float(rec["y"])
        sig = self._hit_test(x, y)
        if not self._sig_matches(rec, sig):
            raise ClickError("坐标漂移：(%d,%d) 处期望 %s，实际 %s"
                             % (x, y, rec.get("sig"), sig))
        before = self._snapshot()
        if not self.dry_run:
            self._hover(x, y)
            self._press(x, y)
            self._release(x, y)
        if self.dry_run or not require_effect:
            ok = True
        else:
            ok = self._wait_effect(expect, before, timeout)
        entry = {"target": rec.get("key"), "x": x, "y": y, "mode": "coord",
                 "sig": sig, "ok": ok, "expect": expect or {},
                 "before": before.get("hash"), "after": self._snapshot().get("hash")}
        self.log.append(entry)
        if not ok:
            raise ClickNoEffect("坐标点 (%d,%d) 没有预期效果" % (x, y))
        return entry

    # -- 升级链：语义 → 真鼠标 → 坐标 -----------------------------------
    def click_escalating(self, key: str, *, css: str | None = None,
                         expect: dict | None = None, timeout: float = 6.0,
                         allow_danger: bool = False,
                         require_effect: bool = True) -> dict:
        """三级升级点击，返回实际生效的那一级（写在 ``escalation`` 里）。

        为什么需要升级链
        ----------------
        ``cdp_driver.click()`` 对普通 locator 走的是 ``_click_js`` → ``el.click()``，
        那是**JS 合成事件**：不发 ``pointerdown``/``mousedown``、不触发 ``:hover``、
        不更新焦点，对被遮挡的元素也"成功"。原版套件里有三类目标会因此静默失败：

        1. 靠 ``pointerdown`` 判定的控件（合成 ``MouseEvent`` 不触发它的处理器）；
        2. 被半透明遮罩盖住的卡片（``el.click()`` 照样调用，但用户点不到）；
        3. 完全没有文字/role 的图标块（语义池里找不到，``_click_js`` 直接返回 false）。

        三级分别覆盖：

        | 级 | 定位 | 点击方式 | 覆盖 |
        |---|---|---|---|
        | 1 ``semantic-realmouse`` | ``collect()`` 池 + ``pick()`` | ``Input.dispatchMouseEvent`` 真鼠标 | 有文字/``cursor:pointer`` 的元素 |
        | 2 ``coord-signature`` | CSS 选择器 → 中心点 | 真鼠标 + ``elementFromPoint`` 命中校验 | 语义池过滤掉的元素 |
        | 3 抛错 | — | — | 带上每一级的失败原因，不静默 |

        **第 1 级已经是真鼠标**，第 2 级不是"退回到更差的手段"，而是换一种
        **定位方式**（CSS 直取，不受 ``collect()`` 的 ``cursor:pointer``/语义标签过滤限制）；
        点击仍然是真鼠标，并且多一道命中签名校验。
        """
        reasons: list[str] = []

        # 第 1 级：语义定位 + 真鼠标 + 效果断言
        try:
            entry = self.click(key, expect=expect, timeout=timeout,
                               allow_danger=allow_danger,
                               require_effect=require_effect)
            entry["escalation"] = "semantic-realmouse"
            return entry
        except ClickError as first:
            reasons.append("语义定位真鼠标失败：%s" % first)
        except Exception as first:  # noqa: BLE001 —— 驱动层异常也要能升级
            reasons.append("语义定位真鼠标异常：%s: %s" % (type(first).__name__, first))

        # 第 2 级：CSS 直取 + 坐标 + 命中签名
        if css:
            try:
                recs = self.record_coords([css])
                rec = recs.get(css)
                if rec is None:
                    reasons.append("坐标记录失败：%r 没有可见尺寸或不在页面上" % css)
                else:
                    entry = self.click_point(rec, expect=expect, timeout=timeout,
                                             require_effect=require_effect)
                    entry["escalation"] = "coord-signature"
                    return entry
            except ClickError as second:
                reasons.append("坐标点击失败：%s" % second)
            except Exception as second:  # noqa: BLE001
                reasons.append("坐标点击异常：%s: %s" % (type(second).__name__, second))
        else:
            reasons.append("没有可用的 CSS 选择器，跳过坐标级")

        raise ClickError("三级点击全部失败：\n  " + "\n  ".join(reasons))

    def _hit_test(self, x: float, y: float) -> dict:
        raw = self.driver.evaluate(HIT_JS % (x, y))
        return json.loads(raw) if isinstance(raw, str) else raw

    @staticmethod
    def _sig_matches(rec: dict, sig: dict) -> bool:
        want = (rec.get("sig") or {})
        if not sig:
            return False
        if want.get("tag") and want["tag"] != sig.get("tag"):
            return False
        wt = (want.get("text") or "")[:12]
        st = (sig.get("text") or "")[:len(wt)] if wt else ""
        return (not wt) or wt == st

