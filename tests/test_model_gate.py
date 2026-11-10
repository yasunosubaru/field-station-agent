# -*- coding: utf-8 -*-
"""纪-1：唯一模型硬闸门。

要求只有三条，但每一条都必须是**机械可判**的：

1. ``RuntimeRequest`` 只接受 ``deepseek-v4.1-flash``（裸名或带 provider 前缀），
   其余一律抛 ``E_MODEL_NOT_ALLOWED``；
2. A 侧发给 ``opencode run`` 的 ``--model`` **由代码合成**，调用方传什么都不会
   原样流到命令行；
3. B 侧的 ``anthropic_shim`` 在被要求锁模型时只转发该模型。

刻意**不**测「模型答得好不好」——那是评测的事。这里只测闸门本身。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

from fieldstation.runtimes import FakeRuntime
from fieldstation.runtimes.base import (
    CANONICAL_MODEL,
    MODEL_ALLOWLIST,
    ModelNotAllowed,
    RuntimeRequest,
    normalize_model,
)
from fieldstation.runtimes.opencode import OpenCodeNativeRuntime
from fieldstation.runtimes.service import RuntimeRegistry, stream_chat

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import anthropic_shim as shim  # noqa: E402


def frames(chunks):
    """把 SSE 字节流拆成 ``(event, data)``；与 test_runtime_service 同口径。"""
    import json

    out = []
    for chunk in chunks:
        text = chunk.decode("utf-8")
        lines = [line for line in text.splitlines() if line]
        event = next(line.split(":", 1)[1].strip()
                     for line in lines if line.startswith("event:"))
        data = next(line.split(":", 1)[1].strip()
                    for line in lines if line.startswith("data:"))
        out.append((event, json.loads(data)))
    return out


class RuntimeRequestGateTest(unittest.TestCase):
    def test_default_is_canonical(self) -> None:
        self.assertEqual(RuntimeRequest("s", "hi").model, CANONICAL_MODEL)

    def test_empty_model_falls_back_to_canonical(self) -> None:
        self.assertEqual(RuntimeRequest("s", "hi", model="").model,
                         CANONICAL_MODEL)
        self.assertEqual(RuntimeRequest("s", "hi", model="   ").model,
                         CANONICAL_MODEL)

    def test_bare_canonical_is_normalized(self) -> None:
        req = RuntimeRequest("s", "hi", model="  deepseek-v4.1-flash  ")
        self.assertEqual(req.model, CANONICAL_MODEL)

    def test_provider_prefixed_canonical_is_accepted_and_normalized(self) -> None:
        req = RuntimeRequest("s", "hi",
                             model="commandcode/deepseek-v4.1-flash")
        self.assertEqual(req.model, CANONICAL_MODEL,
                         "存进 req.model 的必须是裸规范名，前缀由 A 侧合成")

    def test_other_model_is_rejected_with_code(self) -> None:
        with self.assertRaises(ModelNotAllowed) as ctx:
            RuntimeRequest("s", "hi", model="gpt-4")
        self.assertEqual(ctx.exception.code, "E_MODEL_NOT_ALLOWED")
        self.assertIn("gpt-4", str(ctx.exception))
        self.assertIn(CANONICAL_MODEL, str(ctx.exception))

    def test_provider_prefixed_other_model_is_rejected(self) -> None:
        with self.assertRaises(ModelNotAllowed):
            RuntimeRequest("s", "hi", model="openai/gpt-4")

    def test_allowlist_contains_exactly_the_canonical_model(self) -> None:
        self.assertEqual(set(MODEL_ALLOWLIST), {CANONICAL_MODEL})

    def test_normalize_model_accepts_bare_and_prefixed(self) -> None:
        self.assertEqual(normalize_model(CANONICAL_MODEL), CANONICAL_MODEL)
        self.assertEqual(normalize_model("commandcode/" + CANONICAL_MODEL),
                         CANONICAL_MODEL)
        self.assertEqual(normalize_model(""), CANONICAL_MODEL)


class OpenCodeModelLockTest(unittest.TestCase):
    def test_canonical_gets_prefix(self) -> None:
        rt = OpenCodeNativeRuntime(binary="x", model_prefix="commandcode/")
        self.assertEqual(rt.model_name(CANONICAL_MODEL),
                         "commandcode/" + CANONICAL_MODEL)

    def test_prefixed_canonical_is_resynthesized(self) -> None:
        """调用方带前缀也不原样透传——前缀永远由代码决定。"""
        rt = OpenCodeNativeRuntime(binary="x", model_prefix="commandcode/")
        self.assertEqual(rt.model_name("commandcode/" + CANONICAL_MODEL),
                         "commandcode/" + CANONICAL_MODEL)
        self.assertEqual(rt.model_name("other/" + CANONICAL_MODEL),
                         "commandcode/" + CANONICAL_MODEL,
                         "provider 前缀不能被外部选择")

    def test_empty_model_becomes_canonical_instead_of_flagless(self) -> None:
        rt = OpenCodeNativeRuntime(binary="x", model_prefix="commandcode/")
        self.assertEqual(rt.model_name(""),
                         "commandcode/" + CANONICAL_MODEL)

    def test_other_model_raises(self) -> None:
        rt = OpenCodeNativeRuntime(binary="x", model_prefix="commandcode/")
        with self.assertRaises(ModelNotAllowed) as ctx:
            rt.model_name("gpt-4")
        self.assertEqual(ctx.exception.code, "E_MODEL_NOT_ALLOWED")


class ServiceGateTest(unittest.TestCase):
    def test_disallowed_model_yields_error_event_not_exception(self) -> None:
        reg = RuntimeRegistry([FakeRuntime()])
        got = frames(stream_chat(reg, {
            "runtime": "fake", "session_id": "s1", "prompt": "hi",
            "model": "gpt-4",
        }))
        self.assertEqual(len(got), 1, "闸门拒绝时不应继续产事件")
        name, payload = got[0]
        self.assertEqual(name, "error")
        self.assertEqual(payload["data"]["code"], "E_MODEL_NOT_ALLOWED")
        self.assertEqual(payload["data"]["class"], "input")
        self.assertFalse(payload["data"]["retryable"])
        self.assertEqual(payload["session_id"], "s1")

    def test_default_model_still_streams(self) -> None:
        reg = RuntimeRegistry([FakeRuntime()])
        got = frames(stream_chat(reg, {
            "runtime": "fake", "session_id": "s2", "prompt": "hi",
        }))
        self.assertEqual([name for name, _ in got],
                         ["session.start", "message.delta", "message.done"])


class ShimModelLockTest(unittest.TestCase):
    def _body(self, model: str) -> dict:
        return {
            "model": model,
            "max_tokens": 64,
            "messages": [{"role": "user", "content": "你好"}],
        }

    def test_no_lock_is_backward_compatible(self) -> None:
        payload, model = shim.build_upstream_request(self._body("deepseek-chat"))
        self.assertEqual(model, "deepseek-chat")
        self.assertEqual(payload["model"], "deepseek-chat")

    def test_locked_shim_accepts_canonical(self) -> None:
        payload, model = shim.build_upstream_request(
            self._body(CANONICAL_MODEL), locked_model=CANONICAL_MODEL)
        self.assertEqual(model, CANONICAL_MODEL)
        self.assertEqual(payload["model"], CANONICAL_MODEL)

    def test_locked_shim_accepts_provider_prefixed_canonical(self) -> None:
        payload, _ = shim.build_upstream_request(
            self._body("commandcode/" + CANONICAL_MODEL),
            locked_model=CANONICAL_MODEL)
        self.assertEqual(payload["model"], "commandcode/" + CANONICAL_MODEL)

    def test_locked_shim_rejects_other_model(self) -> None:
        with self.assertRaises(shim.ShimError) as ctx:
            shim.build_upstream_request(self._body("deepseek-chat"),
                                        locked_model=CANONICAL_MODEL)
        self.assertEqual(ctx.exception.status, 400)
        self.assertIn(CANONICAL_MODEL, str(ctx.exception))
        self.assertIn("deepseek-chat", str(ctx.exception))

    def test_shim_respond_reports_lock_rejection_as_http_error(self) -> None:
        class Transport:
            def post(self, payload, stream):  # pragma: no cover - 不该被调用
                raise AssertionError("模型被拒时不应访问上游")

        shim_server = shim.Shim(transport=Transport(),
                                locked_model=CANONICAL_MODEL)
        response = shim_server.respond(self._body("gpt-4"))
        self.assertEqual(response.status, 400)
        self.assertFalse(response.is_stream)
        self.assertIn(CANONICAL_MODEL, response.body["error"]["message"])

    def test_shim_health_shows_lock(self) -> None:
        server = shim.Shim(dry_run=True, locked_model=CANONICAL_MODEL)
        self.assertEqual(server.health()["locked_model"], CANONICAL_MODEL)
        self.assertIsNone(shim.Shim(dry_run=True).health()["locked_model"])

    def test_cli_flag_defaults_to_no_lock(self) -> None:
        parser = shim.make_parser()
        self.assertIsNone(parser.parse_args([]).lock_model)
        self.assertEqual(parser.parse_args(
            ["--lock-model", CANONICAL_MODEL]).lock_model, CANONICAL_MODEL)


if __name__ == "__main__":
    unittest.main()
