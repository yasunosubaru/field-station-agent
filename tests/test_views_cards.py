#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""视-1 的前端门禁：工具卡五要素 / 审批卡四要素 / 三条硬规矩 / 空态 / 失败态。

## 为什么这份测试读 JS 源码而不是跑浏览器

本仓库的 Python 门禁（`harness/selftest.py` 第 1 项）跑在只有 Python 的机器上，
**没有 node**。所以这里不 spawn node、不 skip —— 跳过会被门禁判红（skip 必须为 0）。
它钉的是「结构在不在、字段名对不对」这类能机械判定的事，正好覆盖视-1 最容易
做错的那一类：**看起来做了、实际没做**。

真正跑 DOM 的那一层在 `逆向/04_重实现/packages/app/test/cards.test.ts`（node，本机跑）。

## 这份测试守的是哪几个已发生的错

| 曾经错的样子 | 后果 | 本文件的断言 |
|---|---|---|
| `error` 事件读 `data.kind` | 真实字段是 `class`，错误卡永远显示 `execution` | `test_error_event_uses_real_class_field` |
| 工具参数只在折叠 JSON 里 | 卡面五要素只有四个 | `test_tool_card_has_five_parts` |
| 审批卡没有申请人 | 四要素只有三个，事后查不出「谁批的」 | `test_approval_card_has_four_parts` |
| 没有工具调用就空着 | 用户分不清「没调工具」与「界面没画出来」 | `test_no_tool_call_empty_state` |
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "逆向" / "04_重实现" / "packages" / "app" / "src" / "web"
CARDS = WEB / "agent" / "cards.js"
CHAT = WEB / "views" / "chat.js"
AGENT_CSS = WEB / "agent.css"
VIEWS_CSS = WEB / "views" / "views.css"

#: 真实事件类型（`src/fieldstation/agents/orchestrator.py` 的 `_Emitter.error`）。
#: 写成常量是为了「改后端就必须回来改这里」，而不是让前端继续猜。
ERROR_EVENT_CLASS_FIELD = "class"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def strip_comments(text: str) -> str:
    """去掉块注释与行注释。

    必须去：注释里大段引用了「字段名」「文案」，不去掉会让断言在
    **实现被删掉之后依然通过** —— 那是最坏的一种假绿。
    """
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    text = re.sub(r"(?m)^\s*//.*$", "", text)
    return text


def region(text: str, start: str, end: str) -> str:
    """取 `start` 到 `end` 之间的代码；两端锚点必须都在，否则说明结构变了。"""
    begin = text.find(start)
    if begin < 0:
        raise AssertionError(f"找不到起点：{start}")
    stop = text.find(end, begin + len(start))
    if stop < 0:
        raise AssertionError(f"找不到终点：{end}（起点是 {start}）")
    return text[begin:stop]


def tool_region() -> str:
    return region(strip_comments(read(CARDS)), "export function renderToolCard", "export function renderApprovalCard")


def approval_region() -> str:
    return region(strip_comments(read(CARDS)), "export function renderApprovalCard", "export function renderArtifactCard")


class ToolCardFiveParts(unittest.TestCase):
    """规格 25.8.1：工具卡五个必需元素。"""

    REQUIRED = ("name", "args", "result", "duration", "status")

    def test_tool_card_has_five_parts(self) -> None:
        body = tool_region()
        found = re.findall(r"'data-part':\s*'([a-z-]+)'", body)
        for part in self.REQUIRED:
            with self.subTest(part=part):
                self.assertIn(part, found, f"工具卡缺第 {self.REQUIRED.index(part) + 1} 个要素：{part}")

    def test_name_comes_first(self) -> None:
        """只有一条顺序要求：工具名在最前。

        规格没规定五要素的先后，但「先知道调了什么」是读卡的第一步 ——
        名字排到状态/耗时后面，一列卡扫下来就得先跳过 [成功][412ms] 才看到名字。
        其余四个的先后由版式决定（状态与耗时右对齐在头部），不在这里钉死。
        """
        body = tool_region()
        found = re.findall(r"'data-part':\s*'([a-z-]+)'", body)
        self.assertTrue(found, "一个 data-part 都没有")
        self.assertEqual(found[0], 'name', f"第一个要素是 name，实际是 {found[0]}")

    def test_argument_summary_is_a_pure_export(self) -> None:
        """参数摘要要能单独测，所以是导出函数，而不是内联在渲染里。"""
        source = strip_comments(read(CARDS))
        self.assertIn("export function argumentSummary", source, "参数摘要要是导出函数")
        body = region(source, "export function argumentSummary", "export function renderToolCard")
        # 嵌套对象/数组是 trace 的内容，摘要只放能一眼读完的标量。
        self.assertIn("typeof value === 'object'", body, "摘要要跳过嵌套结构")
        self.assertIn("clipArg", body, "长值要截断，否则摘要会撑成两行")

    def test_argument_summary_never_leaves_the_slot_blank(self) -> None:
        """没有参数也要写出「无参数」—— 留白就等于要素缺失。"""
        body = tool_region()
        self.assertIn("ag-tool-args", body, "要有参数摘要行")
        self.assertIn("无参数", body, "无参数时写明，不留白")

    def test_result_summary_slot_always_rendered(self) -> None:
        """执行中也要占位，否则五要素在「运行中」那一格里少一个。"""
        body = tool_region()
        self.assertIn("ag-tool-summary", body, "要有结果摘要行")
        self.assertIn("等待返回", body, "运行中写明「等待返回」，不空着")


class ToolCardFailureState(unittest.TestCase):
    """失败态：要显示真实错误分类，不是「出错了」。"""

    def test_tool_card_failure_shows_error_class(self) -> None:
        body = tool_region()
        self.assertIn("ag-tool-error-class", body, "失败卡要有错误分类元素")
        self.assertIn("card.errorClass", body, "分类来自 card.errorClass")
        self.assertIn("errorClassLabel", body, "分类要翻成人话（capability → 能力不可用）")

    def test_error_class_labels_cover_the_contract(self) -> None:
        """`docs/contracts/agent-events.md` §3.8 的七个 class 都要有中文标签。"""
        source = strip_comments(read(CARDS))
        body = region(source, "export const ERROR_CLASS_LABELS", "export function errorClassLabel")
        for cls in ("input", "capability", "artifact", "environment",
                    "approval", "execution", "provider"):
            with self.subTest(cls=cls):
                self.assertIn(f"{cls}:", body, f"{cls} 没有中文标签，界面会直接印英文枚举")

    def test_missing_class_is_reported_as_missing_not_guessed(self) -> None:
        """后端没给 class 时说「未提供分类」，不编一个 `execution` 糊过去。"""
        body = tool_region()
        self.assertIn("未提供分类", body, "缺分类要明说")

    def test_failure_color_is_bound(self) -> None:
        css = read(AGENT_CSS)
        self.assertIn(".ag-tool-error-class", css, "分类行要有样式")


class ApprovalCardFourParts(unittest.TestCase):
    """规格 25.9.1 + 6.3：审批卡四个必需元素。"""

    REQUIRED = ("who", "what", "risk", "decision")

    def test_approval_card_has_four_parts(self) -> None:
        body = approval_region()
        found = re.findall(r"'data-part':\s*'([a-z-]+)'", body)
        for part in self.REQUIRED:
            with self.subTest(part=part):
                self.assertIn(part, found, f"审批卡缺要素：{part}")

    def test_applicant_is_read_from_backend_field(self) -> None:
        """「谁申请」来自后端的 `requested_by`（`runtimes/impl.py` 就是这么发的）。"""
        source = strip_comments(read(CHAT))
        self.assertIn("requested_by", source, "chat.js 要读 requested_by")
        body = approval_region()
        self.assertIn("card.requestedBy", body, "审批卡要显示申请人")

    def test_applicant_missing_is_explicit(self) -> None:
        """后端没给申请方时写「未提供申请方」，不写「系统」糊一个。"""
        body = approval_region()
        self.assertIn("未提供申请方", body, "缺申请人要明说")
        self.assertIn("data-missing", body, "缺的要素带 data-missing，便于测试与排查")

    def test_risk_scale_is_three_levels(self) -> None:
        """low / medium / high 三档都要能显示，不能只认 high。"""
        source = strip_comments(read(CARDS))
        self.assertIn("riskLabel", source)
        model = read(WEB / "agent" / "model.js")
        for level, label in (("high", "高风险"), ("medium", "中风险"), ("low", "低风险")):
            with self.subTest(level=level):
                self.assertIn(f"'{level}'", model)
                self.assertIn(label, model, f"{level} 要有中文标签")

    def test_reject_is_not_a_danger_button(self) -> None:
        """拒绝不做成红色大按钮 —— 那会让人不敢拒绝（附录 C.3 点四）。"""
        body = approval_region()
        self.assertIn("ag-btn-quiet", body, "拒绝用次要色")
        self.assertNotIn("ag-btn-danger", body, "拒绝不能用 danger")

    def test_styles_exist(self) -> None:
        css = read(AGENT_CSS)
        self.assertIn(".ag-approval-who", css, "申请人要有样式")


class ThreeHardRules(unittest.TestCase):
    """视-1 的三条硬规矩，锚在 08f10c0 修复后的真实字段名上。"""

    def test_rule_one_pending_approval_disables_composer(self) -> None:
        source = strip_comments(read(CHAT))
        self.assertIn("function syncApprovalGate", source, "要有审批门")
        self.assertIn("input.disabled = blocked", source, "未决时禁用输入框")
        self.assertIn("需要先处理上面的审批", source, "禁用要说清原因")
        # 判断依据必须是消息流里的未决审批卡，不另存一份并行状态。
        self.assertIn("card.status === 'pending'", source)

    def test_rule_two_reject_requires_reason(self) -> None:
        body = approval_region()
        self.assertIn("ag-reason-error", body, "空理由要给出错误提示")
        self.assertIn("拒绝必须填一句理由", body, "提示要说清为什么没提交")
        # 理由必须随请求一起上去，不能只留在界面上。
        self.assertIn("reason: reasonInput.value.trim()", body, "理由进 payload")

    def test_rule_three_call_id_comes_from_evidence(self) -> None:
        """`tool_result` 的 call_id 在 `evidence.call_id`，不在顶层（08f10c0）。"""
        source = strip_comments(read(CHAT))
        self.assertIn("data.evidence?.call_id", source, "从 evidence 取 call_id")
        # 事件自己的 id（c-xxx）才是把 call/result 配对的键。
        self.assertIn("callRef: data.id", source, "记下事件 id")
        self.assertIn("entry.callRef === callRef", source, "用事件 id 配对")
        # 卡片上必须有 data-call-id，回源只能靠它。
        self.assertIn("'data-call-id'", tool_region(), "卡片要有 data-call-id")

    def test_approval_event_uses_real_type_and_id_reuse(self) -> None:
        """类型叫 `approval`（不是 `approval_request`），且按 id 复用同一张卡。

        断言的是「复用同一张卡」这个意图，不是某个具体函数名 ——
        实现用自定义 `merge` 而不是 `Object.assign`，因为后者会用第二次事件的
        空 `requested_by` / `impact` 冲掉第一次的值（点拒绝后申请人那两行会消失）。
        """
        source = strip_comments(read(CHAT))
        self.assertIn("type === 'approval'", source)
        self.assertIn("entry.type === 'approval' && entry.id === approvalId", source,
                      "按 approval id 找回已有的卡")
        self.assertIn("if (existing)", source, "第二次出现要走更新分支，不是新增")
        self.assertIn("else thread.cards.push(patch)", source, "只有第一次出现才新增卡")


class RealEventFields(unittest.TestCase):
    """事件字段名一律照后端实际发的那份，不猜。"""

    def test_error_event_uses_real_class_field(self) -> None:
        """`orchestrator._Emitter.error` 发的是 `{"type":"error","class":...}`。

        前端第一版读 `data.kind` —— 字段不存在，于是每张错误卡都显示
        `execution`，看起来「有分类」，其实那只是默认值。
        """
        source = strip_comments(read(CHAT))
        body = region(source, "if (type === 'error')", "if (type === 'done')")
        self.assertIn(f"data.{ERROR_EVENT_CLASS_FIELD}", body,
                      f"错误分类读 data.{ERROR_EVENT_CLASS_FIELD}")
        # `class` 必须排在 `kind` 之前：真字段优先，旧名只做兜底。
        self.assertLess(body.index(f"data.{ERROR_EVENT_CLASS_FIELD}"), body.index("data.kind"),
                        "data.class 要排在 data.kind 前面")

    def test_tool_failure_inherits_the_following_error_event_class(self) -> None:
        """orchestrator 先发 `tool_result(ok:false)` 再发 `error(class)` ——

        两条是同一次失败的里子与面子：分类只在后一条上。前端要把它们接起来，
        否则工具卡只有一句 summary、没有分类。
        """
        source = strip_comments(read(CHAT))
        body = region(source, "if (type === 'error')", "if (type === 'done')")
        self.assertIn("errorClass", body, "要往工具卡上补分类")
        self.assertIn("status === 'failed'", body, "只补给失败的那张卡")
        # 「已经有的不覆盖」的落点：吸收条件里必须带上「还没有分类」这个否定判断。
        self.assertRegex(body, r"!\w+\.errorClass", "已经有的不覆盖")

    def test_error_card_does_not_duplicate_tool_failure(self) -> None:
        """分类补到工具卡之后不再另插一张错误卡 —— 同一句话印两遍是噪音。"""
        source = strip_comments(read(CHAT))
        body = region(source, "if (type === 'error')", "if (type === 'done')")
        self.assertIn("return", body, "补到工具卡后要提前返回")

    def test_tool_call_args_field_is_args(self) -> None:
        """`tool_call` 事件发的是 `args`（orchestrator 第 646 行），不是 `arguments`。"""
        source = strip_comments(read(CHAT))
        self.assertIn("data.args", source, "读 data.args")


class NoToolCallEmptyState(unittest.TestCase):
    """空态：没工具调用时明确写一句，不留白。"""

    def test_no_tool_call_empty_state(self) -> None:
        source = strip_comments(read(CHAT))
        self.assertIn("本轮没有工具调用", source, "要有这句文案")
        # 空态要能被测试与样式选中。`el()` 的 data 键会落成 data-chat-tools-empty
        # （`views/dom.js` 负责加前缀），所以这里钉的是键名而不是整串属性。
        self.assertIn("chatToolsEmpty", source, "空态要可被测试与样式选中")
        self.assertIn("vw-chat-tools-empty", source, "空态要有自己的 class")

    def test_empty_state_only_when_a_turn_really_has_none(self) -> None:
        """三条件缺一不可：有助手回话、没有工具卡、不是在流式生成中。

        少任何一个条件都会误报 —— 生成中本来就没有工具卡，那时写
        「本轮没有工具调用」是在撒谎。
        """
        source = strip_comments(read(CHAT))
        body = region(source, "function toolsEmptyNote", "function syncApprovalGate")
        self.assertIn("thread.streaming", body, "流式中不显示")
        self.assertIn("type === 'tool'", body, "有工具卡就不显示")
        self.assertIn("role === 'assistant'", body, "先有回话才谈「本轮」")

    def test_empty_state_style_exists(self) -> None:
        # 空态样式写在 blocks.css（对话块自己的样式表），不在 views.css。
        css = read(WEB / "views" / "blocks.css")
        self.assertIn(".vw-chat-tools-empty", css, "空态文案要有样式（不能是裸文本）")


class CardDispatchStillHonest(unittest.TestCase):
    """分发与「不把数据当 HTML」这两条不能被新代码破坏。"""

    def test_render_card_dispatches_tool_and_approval(self) -> None:
        source = strip_comments(read(CARDS))
        # renderCard 是文件里最后一个导出函数，所以取到文件尾 —— 没有下一个锚点可用。
        body = source[source.find("export function renderCard"):]
        self.assertIn("case 'tool'", body)
        self.assertIn("case 'approval'", body)

    def test_user_data_never_enters_innerhtml(self) -> None:
        body = tool_region() + approval_region()
        self.assertNotRegex(body, r"html:\s*(card\.|part\.|summary)")
        self.assertIn("text: card.name", body, "工具名走 textContent")
        self.assertIn("text: card.prompt", body, "动作描述走 textContent")


if __name__ == "__main__":
    unittest.main()
