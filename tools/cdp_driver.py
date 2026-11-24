#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""原版套件的 CDP 驱动（RPA 的可靠通道）。

## 为什么有它

原版 ``main.js`` 的 CLI 判定是「argv 多于一个且 argv[0] 含
NovAtelApplicationSuite → 进 Convert CLI」。直接给 exe 加
``--force-renderer-accessibility`` 会被当成非法参数并退出；即使换成不同名的
副本把开关送进 Chromium，本机 Electron 8 的 UIA 树里仍只有
``Chrome Legacy Window``，看不到网页控件。

CDP（Chrome DevTools Protocol）是同一套 Chromium 自带的调试协议：只要套件以
``--remote-debugging-port=<port>`` 启动，就能在页面里按文字找控件、点击、填值、
读文本、截图。它仍然满足仓库的 RPA 纪律：

* **不按坐标**：只按可见元素的文字/标签找；
* **找不到就报错**：``GuiUnavailable``，不退回「大概位置点一下」；
* **证据**：每次动作可写日志，截图是真实页面。

## 用法

```powershell
python tools/suite_launcher.py --launch --cdp-port 9223
python tools/cdp_driver.py --check
python tools/cdp_driver.py --open manage
python tools/cdp_driver.py --read Device
python tools/workflow_cli.py run gui.device.update --driver cdp ...
```

``workflow_cli`` 的 ``--driver cdp`` 会按 ``FSA_CDP_PORT``（默认 9223）连接。
本模块只用标准库（socket + 手写 WebSocket 帧）。
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import socket
import struct
import sys
import time
from pathlib import Path
from urllib.request import urlopen

DEFAULT_PORT = 9223
DEFAULT_HOST = "127.0.0.1"


class GuiUnavailable(RuntimeError):
    """套件没开 CDP、页面找不到，或控件不存在。"""


class _WebSocket:
    """最小 RFC 6455 客户端（文本帧 + ping/pong + close）。"""

    def __init__(self, host: str, port: int, path: str, timeout: float = 15.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.settimeout(timeout)
        self._buf = b""
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(request.encode("ascii"))
        header = self._read_until(b"\r\n\r\n")
        if b" 101 " not in header.split(b"\r\n", 1)[0]:
            raise GuiUnavailable(f"CDP WebSocket 握手失败：{header[:200]!r}")

    def _read_until(self, marker: bytes) -> bytes:
        data = self._buf
        self._buf = b""
        while marker not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise GuiUnavailable("CDP 连接在握手时关闭")
            data += chunk
        head, rest = data.split(marker, 1)
        self._buf = rest
        return head + marker

    def _read_exact(self, size: int) -> bytes:
        while len(self._buf) < size:
            chunk = self.sock.recv(max(4096, size - len(self._buf)))
            if not chunk:
                raise GuiUnavailable("CDP 连接已关闭")
            self._buf += chunk
        data, self._buf = self._buf[:size], self._buf[size:]
        return data

    def send_text(self, text: str) -> None:
        payload = text.encode("utf-8")
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", length)
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def recv_text(self) -> str:
        buffer = b""
        while True:
            first = self._read_exact(2)
            fin = bool(first[0] & 0x80)
            opcode = first[0] & 0x0F
            masked = bool(first[1] & 0x80)
            length = first[1] & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if masked else b""
            payload = self._read_exact(length)
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:  # close
                raise GuiUnavailable("CDP 连接被对端关闭")
            if opcode == 0x9:  # ping
                self._pong(payload)
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode in (0x0, 0x1):  # continuation / text
                buffer += payload
                if not fin:
                    continue
                try:
                    return buffer.decode("utf-8")
                except UnicodeDecodeError as exc:
                    raise GuiUnavailable(f"CDP 帧不是 UTF-8：{exc}") from exc
            # 其它 opcode（binary 等）忽略
            buffer = b""

    def _pong(self, payload: bytes) -> None:
        header = bytearray([0x8A])
        if len(payload) < 126:
            header.append(0x80 | len(payload))
        else:
            header.append(0x80 | 126)
            header += struct.pack("!H", len(payload))
        mask = os.urandom(4)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


class CdpDriver:
    name = "cdp"

    def __init__(self, port: int = DEFAULT_PORT, host: str = DEFAULT_HOST,
                 timeout: float = 15.0) -> None:
        self.port = int(port)
        self.host = host
        self.timeout = timeout
        self._ws: _WebSocket | None = None
        self._id = 0
        self.log: list[dict] = []

    # ------------------------------------------------------------ 连接
    def _page_ws(self) -> str:
        try:
            with urlopen(f"http://{self.host}:{self.port}/json/list",
                         timeout=self.timeout) as response:
                pages = json.loads(response.read().decode("utf-8"))
        except OSError as exc:
            raise GuiUnavailable(
                f"套件没有开 CDP（{self.host}:{self.port}）：{exc}；"
                "用 suite_launcher.py --launch --cdp-port 启动") from exc
        # 只认 type == "page"：browser target 不支持 Emulation.setDeviceMetricsOverride，
        # 连上去会在钉视口时抛 "Target does not support metrics override"。
        page_targets = [p for p in pages if p.get("type") == "page"]
        for page in page_targets:
            if "index.html" in str(page.get("url", "")):
                return str(page["webSocketDebuggerUrl"])
        if page_targets:
            return str(page_targets[0]["webSocketDebuggerUrl"])
        raise GuiUnavailable("CDP 没有 page 目标（套件可能还在启动）")

    @property
    def connected(self) -> bool:
        return self._ws is not None

    @property
    def available(self) -> bool:
        try:
            self.connect()
            return True
        except GuiUnavailable:
            return False

    def connect(self) -> None:
        if self._ws is not None:
            return
        url = self._page_ws()
        path = url.split(self.host, 1)[-1]
        if path.startswith(f":{self.port}"):
            path = path[len(f":{self.port}"):]
        self._ws = _WebSocket(self.host, self.port, path or "/", self.timeout)
        self.call("Runtime.enable")
        self.call("Page.enable")

    def close(self) -> None:
        if self._ws is not None:
            self._ws.close()
            self._ws = None

    # ------------------------------------------------------------ CDP
    def call(self, method: str, params: dict | None = None) -> dict:
        if self._ws is None:
            raise GuiUnavailable("CDP 未连接")
        self._id += 1
        message_id = self._id
        self._ws.send_text(json.dumps({
            "id": message_id, "method": method, "params": params or {},
        }, ensure_ascii=False))
        while True:
            message = json.loads(self._ws.recv_text())
            if message.get("id") != message_id:
                continue  # 事件
            if "error" in message:
                raise GuiUnavailable(
                    f"CDP {method} 失败：{message['error'].get('message')}")
            return message.get("result") or {}

    def evaluate(self, expression: str):
        result = self.call("Runtime.evaluate", {
            "expression": expression,
            "returnByValue": True,
            "awaitPromise": True,
        })
        payload = result.get("result") or {}
        if payload.get("subtype") == "error":
            raise GuiUnavailable(f"页面脚本报错：{payload.get('description')}")
        return payload.get("value")

    # ------------------------------------------------------------ 动作
    def _require(self) -> None:
        self.connect()

    def open(self, page: str) -> None:
        self._require()
        text = "" if (page or "").strip().lower() in ("", "manage") else page
        if not text:
            return
        for part in [p.strip() for p in text.split(">") if p.strip()]:
            clicked = self.evaluate(_click_js(part))
            if not clicked:
                raise GuiUnavailable(f"页面上找不到可点的 {part!r}")
            self.log.append({"action": "open", "target": part})
            time.sleep(0.35)

    def read(self, control: str) -> str:
        self._require()
        value = self.evaluate(_read_js(control))
        if value is None:
            raise GuiUnavailable(f"页面上找不到 {control!r}")
        self.log.append({"action": "read", "target": control})
        return str(value)

    def fix_viewport(self, width: int, height: int) -> None:
        """钉死页面 CSS 视口。坐标模式的前提，与物理屏/DPI 无关（已实测）。"""
        self._require()
        engine = _load_click_engine()
        engine.ClickEngine(self).fix_viewport(int(width), int(height))

    def clear_viewport(self) -> None:
        self._require()
        engine = _load_click_engine()
        engine.ClickEngine(self).clear_viewport()

    def restore_home(self, timeout_s: float = 20.0) -> list:
        """关残留弹窗 → 结束残留对话框 → 回首页 → 验证。返回做过的动作。

        逻辑与 ``tools/rpa_fixture.restore_home`` 一致（那边是同一套动作的 CLI 入口），
        这里搬进驱动层，流程里的 ``restore_home`` 步骤就能直接用。
        """
        self._require()
        engine = _load_click_engine()
        ce = engine.ClickEngine(self)
        done: list = []

        def body_text() -> str:
            return str(self.evaluate("document.body ? document.body.innerText : ''") or "")

        def popup_visible() -> bool:
            # 弹窗关掉后节点仍在 DOM，只是尺寸为 0
            raw = self.evaluate(
                "(() => { const n = document.querySelector('.update-software-popup');"
                " return n ? (n.getBoundingClientRect().width > 0 &&"
                " n.getBoundingClientRect().height > 0) : false; })()")
            if raw:
                return True
            text = body_text()
            return "Current Version" in text or "is up to date" in text

        if popup_visible():
            try:
                ce.click("Close", require_effect=False, timeout=3.0)
                done.append("close:update-popup")
            except Exception:  # noqa: BLE001 —— 关不掉也要继续回首页
                done.append("close-failed:update-popup")
            time.sleep(0.5)

        if "New Connection" in body_text():
            try:
                ce.click("Cancel", require_effect=False, timeout=3.0)
                done.append("close:device-dialog")
            except Exception:  # noqa: BLE001
                done.append("close-failed:device-dialog")
            time.sleep(0.5)

        self.click("css:a.homemenu-title")
        done.append("goto:home")

        # 条件等待，不是盲睡：轮询 "My Applications" 出现
        deadline = time.time() + max(float(timeout_s), 1.0)
        while time.time() < deadline:
            if "My Applications" in body_text():
                done.append("verified:home")
                return done
            time.sleep(0.3)
        raise GuiUnavailable(
            f"点了 a.homemenu-title 但 {timeout_s:g}s 内没回到首页"
            f"（页面里没有 'My Applications'）")

    def escalating_click(self, locator: str, *, css: str | None = None,
                         allow_danger: bool = False) -> dict:
        """三级升级点击：语义（真鼠标）→ 坐标（CSS + 命中签名）→ 抛错带全部原因。

        为什么必须用真鼠标而不是 ``el.click()``
        --------------------------------------
        ``_click_js`` 最后一行是 ``el.click()``，那是 **JS 合成事件**：
        不发 ``pointerdown``/``mousedown``、不触发 ``:hover``、不更新焦点，
        对被遮罩的元素也"成功"。原版套件里三类目标会因此静默失败：

        1. 靠 ``pointerdown`` 判定的控件（合成事件不进它的处理器）；
        2. 被半透明遮罩盖住的卡片（``el.click()`` 照样调用，用户点不到）；
        3. 没有文字/role 的图标块（语义池找不到，直接返回 false）。

        ``ClickEngine`` 的 ``_hover/_press/_release`` 走
        ``Input.dispatchMouseEvent``，由浏览器自己做命中测试——
        点不到会表现为断言失败，而不是假成功。
        """
        self._require()
        engine = _load_click_engine()
        key = locator
        if locator.startswith("target!:"):
            key = locator[len("target!:"):]
        elif locator.startswith("target:"):
            key = locator[len("target:"):]
        css_sel = css or _locator_to_css(locator)
        entry = engine.ClickEngine(self).click_escalating(
            key, css=css_sel, allow_danger=allow_danger, require_effect=False)
        time.sleep(0.15)
        self.log.append({"action": "click", "target": locator,
                         "escalation": entry.get("escalation"),
                         "css": css_sel})
        return entry

    def click(self, locator: str) -> None:
        self._require()
        if locator.startswith("target:") or locator.startswith("target!:"):
            # target!: 显式允许"危险词"目标（例如 + Add Device 只是打开对话框），
            # 由流程作者在 YAML 里写死，可被 lint 检出；默认 target: 仍然拦截。
            allow = locator.startswith("target!:")
            key = locator[len("target!:"):] if allow else locator[len("target:"):]
            ce_mod = _load_click_engine()
            ce_mod.ClickEngine(self).click(key, require_effect=False, allow_danger=allow)
            time.sleep(0.15)
            self.log.append({"action": "click", "target": locator})
            return
        clicked = self.evaluate(_click_js(locator))
        if not clicked:
            # 语义池找不到（没有文字/role，或 cursor 不是 pointer 且非语义标签）：
            # 直接 el.click() 是 JS 合成事件，本来也不可靠。升级到「坐标 + 命中签名」，
            # 那里用的是真鼠标。locator 若不是 CSS 就没得升，按原样报错。
            css = _locator_to_css(locator)
            if css:
                ce_mod = _load_click_engine()
                recs = ce_mod.ClickEngine(self).record_coords([css])
                rec = recs.get(css)
                if rec:
                    ce_mod.ClickEngine(self).click_point(rec, timeout=4.0)
                    time.sleep(0.15)
                    self.log.append({"action": "click", "target": locator,
                                     "escalation": "coord-signature"})
                    return
            raise GuiUnavailable(f"页面上找不到可点的 {locator!r}")
        time.sleep(0.15)
        self.log.append({"action": "click", "target": locator})

    def type_text(self, locator: str, text: str) -> None:
        """往输入框里填文字，走浏览器**真实输入管线**。

        为什么不能用 `el.value = x`：React 受控组件读 state 不读 DOM 属性，
        手动赋值 + 派发合成事件 React 收不到，state 仍是空。表现出来是
        "看起来填好了、但表单校验说没填、按钮永久禁用、点它毫无反应"。
        实测踩过（2026-11-18，Graph 的 Project Wizard）。

        正确路径：focus -> 全选清空 -> CDP Input.insertText。
        insertText 不可用时退到逐字符 dispatchKeyEvent，仍然走真实输入事件。
        """
        self._require()

        # 1) 聚焦 + 确认元素存在（用原 JS 只做定位与聚焦，不写值）
        ready = self.evaluate(_focus_for_type_js(locator))
        if not ready:
            raise GuiUnavailable(f"页面上找不到可填的 {locator!r}")

        # 2) 全选 + 删除，避免在旧值后面追加
        for modifiers, vk, key, code in ((2, 65, "a", "KeyA"),):
            self.call("Input.dispatchKeyEvent", {
                "type": "keyDown", "modifiers": modifiers,
                "windowsVirtualKeyCode": vk, "key": key, "code": code})
            self.call("Input.dispatchKeyEvent", {
                "type": "keyUp", "modifiers": modifiers,
                "windowsVirtualKeyCode": vk, "key": key, "code": code})
        self.call("Input.dispatchKeyEvent", {
            "type": "keyDown", "windowsVirtualKeyCode": 46,
            "key": "Delete", "code": "Delete"})
        self.call("Input.dispatchKeyEvent", {
            "type": "keyUp", "windowsVirtualKeyCode": 46,
            "key": "Delete", "code": "Delete"})

        # 3) 真实输入
        try:
            self.call("Input.insertText", {"text": text})
        except Exception:  # noqa: BLE001 —— 老版本 CDP 可能没有 insertText
            for ch in text:
                self.call("Input.dispatchKeyEvent", {
                    "type": "char", "text": ch, "key": ch})
        self.log.append({"action": "type", "target": locator, "via": "insertText"})

    def select(self, locator: str, option: str) -> None:
        self._require()
        ok = self.evaluate(_select_js(locator, option))
        if not ok:
            raise GuiUnavailable(f"页面上找不到可选的 {locator!r}={option!r}")
        self.log.append({"action": "select", "target": locator, "value": option})

    def screenshot(self, path: str | Path) -> str:
        self._require()
        result = self.call("Page.captureScreenshot", {"format": "png"})
        data = base64.b64decode(result.get("data") or "")
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        self.log.append({"action": "screenshot", "path": str(target)})
        return str(target)


# ---------------------------------------------------------------- 页面脚本
_PRELUDE = r"""
const __target = __TARGET_JSON__;
const __visible = (el) => {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};
const __text = (el) => ((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim());
const __pool = () => Array.from(document.querySelectorAll(
  'button,a,li,[role="menuitem"],[role="tab"],input,textarea,select,label,span,div'
)).filter(__visible);
"""

_CLICK_JS = "(() => {" + _PRELUDE + r"""
  if (String(__target).startsWith('css:')) {
    const node = document.querySelector(String(__target).slice(4));
    if (!node) return false;
    node.scrollIntoView({block: 'center'});
    node.click();
    return true;
  }
  const __want = String(__target).toLowerCase();
  let exact = __pool().filter((el) => __text(el).toLowerCase() === __want);
  let pool = exact.length ? exact : __pool().filter((el) => __text(el).toLowerCase().includes(__want));
  if (!pool.length) return false;
  const rank = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const cls = String(el.className || '');
    let score = 0;
    if (tag === 'button' || tag === 'a' || tag === 'li') score -= 4;
    if (role === 'menuitem' || role === 'tab') score -= 3;
    if (cls.includes('application-container')) score -= 12;
    if (cls.includes('menubar') || cls.includes('menu-item')) score -= 4;
    if (cls.includes('tab')) score -= 2;
    if (el.querySelector('button,a,li')) score += 2;
    return score;
  };
  pool.sort((a, b) => rank(a) - rank(b) || __text(a).length - __text(b).length);
  const el = pool[0];
  el.scrollIntoView({block: 'center'});
  el.dispatchEvent(new MouseEvent('mouseover', {bubbles: true}));
  el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
  el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
  el.click();
  return true;
})()"""

_READ_JS = "(() => {" + _PRELUDE + r"""
  if (String(__target).startsWith('css:')) {
    const node = document.querySelector(String(__target).slice(4));
    if (!node) return null;
    if (['INPUT','TEXTAREA','SELECT'].includes(node.tagName)) return node.value;
    return (node.innerText || node.textContent || '').trim();
  }
  const __want = String(__target).toLowerCase();
  let pool = __pool().filter((el) => __text(el).toLowerCase() === __want);
  if (!pool.length) pool = __pool().filter((el) => __text(el).toLowerCase().includes(__want));
  if (!pool.length) return null;
  pool.sort((a, b) => __text(a).length - __text(b).length);
  const el = pool[0];
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
    return el.value;
  }
  return __text(el);
})()"""

_TYPE_JS = "(() => {" + _PRELUDE + r"""
  // disabled / readOnly 的框不参与匹配。实测（2026-11-18，Graph Project Wizard）：
  //   input#project-name-input  y=360  disabled=True   <- Project Folder（只读）
  //   input#project-name-input  y=461  disabled=False  <- Project Name（要填的）
  // 两个共用同一个 id；按 id 取第一个会写进只读那个，目标字段永远空，
  // 于是必填校验不过、后续原生对话框不弹（后面一串 confirm 报错都是假象）。
  let pool = __pool().filter(
    (el) => ['INPUT','TEXTAREA'].includes(el.tagName) && !el.disabled && !el.readOnly);
  const want = String(__target);
  // 1) 先按 id 精确匹配（页面里有同名 id 时取第一个**可写**的）
  let el = pool.find((n) => n.id === want) || pool.find((n) => n.name === want) || null;
  // 2) 再按 placeholder / aria-label 等描述匹配
  if (!el) {
    const byName = pool.filter((n) => {
      const label = [n.name, n.id, n.placeholder, n.getAttribute('aria-label'),
        n.getAttribute('data-lang')].filter(Boolean).join(' ');
      return label.toLowerCase().includes(want.toLowerCase());
    });
    el = byName[0] || null;
  }
  // 3) 只有一个输入框时才允许兜底；有多个就必须匹配到，否则写错字段比失败更糟
  if (!el && pool.length === 1) el = pool[0];
  if (!el) return false;
  el.focus();
  el.value = __VALUE_JSON__;
  el.dispatchEvent(new Event('input', {bubbles: true}));
  el.dispatchEvent(new Event('change', {bubbles: true}));
  return true;
})()"""

_SELECT_JS = "(() => {" + _PRELUDE + r"""
  const pools = __pool().filter((el) => el.tagName === 'SELECT');
  const el = pools.find((s) => Array.from(s.options).some((o) =>
    (o.text || '').trim() === __target || o.value === __target));
  if (!el) return false;
  const option = Array.from(el.options).find((o) =>
    (o.text || '').trim() === __target || o.value === __target);
  el.value = option.value;
  el.dispatchEvent(new Event('change', {bubbles: true}));
  return true;
})()"""


def _load_click_engine():
    """按**文件路径**加载 ``click_engine``，不依赖 ``sys.path`` 里有 ``tools/``。

    为什么不用裸 ``from click_engine import ClickEngine``：``gui.py`` 是用
    ``importlib.util.spec_from_file_location`` 按路径加载本文件的，它**不会**把
    ``tools/`` 塞进 ``sys.path``。裸导入在源码树里能跑（因为脚本目录自动进 path），
    但打成一个包之后必然 ImportError —— 这是 `tools/probe_packaged_imports.py`
    专门盯着的一条。
    """
    global _click_engine_module
    if _click_engine_module is not None:
        return _click_engine_module
    import importlib.util as _iu
    from pathlib import Path as _P
    path = _P(__file__).with_name("click_engine.py")
    if not path.is_file():
        raise GuiUnavailable(f"click_engine.py 不在 {path.parent}")
    spec = _iu.spec_from_file_location("_fsa_click_engine", path)
    if spec is None or spec.loader is None:
        raise GuiUnavailable(f"加载 click_engine.py 失败：{path}")
    module = _iu.module_from_spec(spec)
    # dataclasses 在解析字符串注解时会去 sys.modules 里找 cls.__module__；
    # 不先注册就会拿到 None 并抛 AttributeError（Python 3.9 实测）。
    import sys as _sys
    _sys.modules["_fsa_click_engine"] = module
    spec.loader.exec_module(module)
    _click_engine_module = module
    return module


_click_engine_module = None


#: 能被 ``_locator_to_css`` 认出来的定位写法
_CSS_HINT = ("#", ".", "[")


def _locator_to_css(locator: str) -> str | None:
    """把 locator 尽量翻译成一个 CSS 选择器；翻不出就返回 ``None``。

    只有翻得出 CSS 才谈得上坐标级——坐标必须有确定的那一个元素，
    而按文字模糊匹配出来的"第 N 个候选"不适合当坐标基准。
    """
    text = (locator or "").strip()
    if not text:
        return None
    if text.startswith("css:"):
        return text[4:].strip() or None
    if text.startswith("#"):
        return text
    if "__TARGET_JSON__" in text:  # 误传模板，不接
        return None
    # 形如 `.cls`、`div.cls`、`[data-x="y"]` 的直通
    if text[0] in _CSS_HINT or text.split(" ")[0].endswith(tuple(".#[]")):
        return text
    # 纯 id 名（形如 sm-welcome）→ 补一个 #
    if re.fullmatch(r"[A-Za-z][\w-]*", text):
        return "#" + text
    return None


def _js_string(value: str) -> str:
    return json.dumps(str(value), ensure_ascii=False)


def _click_js(name: str) -> str:
    return _CLICK_JS.replace("__TARGET_JSON__", _js_string(name))


def _read_js(name: str) -> str:
    return _READ_JS.replace("__TARGET_JSON__", _js_string(name))


_FOCUS_FOR_TYPE_JS = "(() => {" + _PRELUDE + r"""
  let pool = __pool().filter(
    (el) => ['INPUT','TEXTAREA'].includes(el.tagName) && !el.disabled && !el.readOnly);
  const want = String(__target);
  let el = pool.find((n) => n.id === want) || pool.find((n) => n.name === want) || null;
  if (!el) {
    const byName = pool.filter((n) => {
      const label = [n.name, n.id, n.placeholder, n.getAttribute('aria-label'),
        n.getAttribute('data-lang')].filter(Boolean).join(' ');
      return label.toLowerCase().includes(want.toLowerCase());
    });
    el = byName[0] || null;
  }
  if (!el && pool.length === 1) el = pool[0];
  if (!el) return false;
  el.focus();
  if (el.select) { try { el.select(); } catch (e) {} }
  return document.activeElement === el;
})()"""


def _focus_for_type_js(name: str) -> str:
    return _FOCUS_FOR_TYPE_JS.replace("__TARGET_JSON__", _js_string(name))

def _type_js(name: str, value: str) -> str:
    return _TYPE_JS.replace("__TARGET_JSON__", _js_string(name)).replace(
        "__VALUE_JSON__", _js_string(value))


def _select_js(name: str, option: str) -> str:
    # 用选项文字/值匹配；name 保留给调用方语义。
    return _SELECT_JS.replace("__TARGET_JSON__", _js_string(option or name))


def create() -> CdpDriver:
    return CdpDriver(int(os.environ.get("FSA_CDP_PORT", DEFAULT_PORT)))


def check(port: int | None = None) -> dict:
    driver = CdpDriver(port or int(os.environ.get("FSA_CDP_PORT", DEFAULT_PORT)))
    try:
        driver.connect()
        title = driver.evaluate("document.title") or ""
        return {"available": True, "port": driver.port, "title": title}
    except GuiUnavailable as exc:
        return {"available": False, "port": driver.port, "reason": str(exc)}
    finally:
        driver.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="原版套件 CDP 驱动（RPA）")
    parser.add_argument("--port", type=int, default=int(os.environ.get("FSA_CDP_PORT", DEFAULT_PORT)))
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--open", dest="open_page")
    parser.add_argument("--read", dest="read_control")
    parser.add_argument("--click")
    parser.add_argument("--type", nargs=2, metavar=("CONTROL", "VALUE"))
    parser.add_argument("--select", nargs=2, metavar=("CONTROL", "VALUE"))
    parser.add_argument("--screenshot")
    args = parser.parse_args(argv)

    if args.check:
        print(json.dumps(check(args.port), ensure_ascii=False, indent=2))
        return 0 if check(args.port)["available"] else 1
    driver = CdpDriver(args.port)
    try:
        if args.open_page is not None:
            driver.open(args.open_page)
            print(f"opened {args.open_page!r}")
        if args.read_control is not None:
            print(driver.read(args.read_control))
        if args.click:
            driver.click(args.click)
            print(f"clicked {args.click!r}")
        if args.type:
            driver.type_text(args.type[0], args.type[1])
        if args.select:
            driver.select(args.select[0], args.select[1])
        if args.screenshot:
            print(driver.screenshot(args.screenshot))
        return 0
    except GuiUnavailable as exc:
        print(f"[阻断] {exc}", file=sys.stderr)
        return 1
    finally:
        driver.close()


if __name__ == "__main__":
    raise SystemExit(main())
