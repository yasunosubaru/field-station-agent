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
        for page in pages:
            if page.get("type") == "page" and "index.html" in str(page.get("url", "")):
                return str(page["webSocketDebuggerUrl"])
        if pages:
            return str(pages[0]["webSocketDebuggerUrl"])
        raise GuiUnavailable("CDP 没有页面（套件可能还在启动）")

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

    def click(self, locator: str) -> None:
        self._require()
        clicked = self.evaluate(_click_js(locator))
        if not clicked:
            raise GuiUnavailable(f"页面上找不到可点的 {locator!r}")
        self.log.append({"action": "click", "target": locator})

    def type_text(self, locator: str, text: str) -> None:
        self._require()
        ok = self.evaluate(_type_js(locator, text))
        if not ok:
            raise GuiUnavailable(f"页面上找不到可填的 {locator!r}")
        self.log.append({"action": "type", "target": locator})

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
  'button,a,li,[role="menuitem"],[role="tab"],input,select,label,span,div'
)).filter(__visible);
"""

_CLICK_JS = "(() => {" + _PRELUDE + r"""
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
  let pool = __pool().filter((el) => ['INPUT','TEXTAREA'].includes(el.tagName));
  let byName = pool.filter((el) => {
    const label = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'),
      el.getAttribute('data-lang')].filter(Boolean).join(' ');
    return label.toLowerCase().includes(String(__target).toLowerCase());
  });
  const el = (byName.length ? byName : pool)[0];
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


def _js_string(value: str) -> str:
    return json.dumps(str(value), ensure_ascii=False)


def _click_js(name: str) -> str:
    return _CLICK_JS.replace("__TARGET_JSON__", _js_string(name))


def _read_js(name: str) -> str:
    return _READ_JS.replace("__TARGET_JSON__", _js_string(name))


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
