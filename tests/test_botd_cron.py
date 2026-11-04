"""E2 botd cron：下一跳的正确性与非法表达式的明确报错。"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from fieldstation.botd.cron import CronError, CronExpr, next_after, parse

UTC = timezone.utc


def dt(*args: int) -> datetime:
    return datetime(*args, tzinfo=UTC)


class TestCronNextAfter(unittest.TestCase):
    def test_every_fifteen_minutes(self) -> None:
        expr = parse("*/15 * * * *")
        self.assertEqual(expr.next_after(dt(2026, 11, 5, 10, 7)), dt(2026, 11, 5, 10, 15))
        # 命中点本身不算"下一跳"：必须严格晚于 now。
        self.assertEqual(expr.next_after(dt(2026, 11, 5, 10, 15)), dt(2026, 11, 5, 10, 30))
        self.assertEqual(expr.next_after(dt(2026, 11, 5, 23, 50)), dt(2026, 11, 6, 0, 0))

    def test_weekday_range_skips_the_weekend(self) -> None:
        expr = parse("0 9 * * 1-5")
        # 2026-11-06 是周五，下一跳应是下周一 09:00。
        self.assertEqual(expr.next_after(dt(2026, 11, 6, 10, 0)), dt(2026, 11, 9, 9, 0))

    def test_day_of_month_and_month_rollover(self) -> None:
        expr = parse("30 2 1 * *")
        self.assertEqual(expr.next_after(dt(2026, 1, 15, 0, 0)), dt(2026, 2, 1, 2, 30))
        self.assertEqual(expr.next_after(dt(2026, 12, 2, 0, 0)), dt(2027, 1, 1, 2, 30))

    def test_leap_day_is_reachable(self) -> None:
        expr = parse("0 0 29 2 *")
        self.assertEqual(expr.next_after(dt(2026, 3, 1, 0, 0)), dt(2028, 2, 29, 0, 0))

    def test_list_range_and_step(self) -> None:
        self.assertEqual(
            parse("5,35 * * * *").next_after(dt(2026, 11, 5, 10, 6)),
            dt(2026, 11, 5, 10, 35),
        )
        self.assertEqual(
            parse("0-10/5 * * * *").next_after(dt(2026, 11, 5, 10, 7)),
            dt(2026, 11, 5, 10, 10),
        )
        self.assertEqual(
            parse("20/20 * * * *").next_after(dt(2026, 11, 5, 10, 21)),
            dt(2026, 11, 5, 10, 40),
        )

    def test_sunday_accepts_both_zero_and_seven(self) -> None:
        sunday = dt(2026, 11, 8, 0, 0)
        self.assertEqual(sunday.weekday(), 6)
        for expression in ("0 8 * * 7", "0 8 * * 0"):
            self.assertEqual(parse(expression).next_after(sunday), dt(2026, 11, 8, 8, 0))

    def test_day_of_month_and_weekday_are_ored(self) -> None:
        # 日=15 或 星期三。2026-11-05 是周四，应命中 11-11（周三）而不是等到 15 日。
        expr = parse("0 12 15 * 3")
        self.assertEqual(expr.next_after(dt(2026, 11, 5, 0, 0)), dt(2026, 11, 11, 12, 0))

    def test_matches_and_convenience_function(self) -> None:
        expr = parse("0 8 * * *")
        self.assertTrue(expr.matches(dt(2026, 11, 5, 8, 0)))
        self.assertFalse(expr.matches(dt(2026, 11, 5, 8, 1)))
        self.assertEqual(
            next_after("0 8 * * *", dt(2026, 11, 5, 7, 59)), dt(2026, 11, 5, 8, 0)
        )

    def test_timezone_and_naive_datetimes_are_preserved(self) -> None:
        tokyo = timezone(timedelta(hours=9))
        expr = parse("0 8 * * *")
        local = datetime(2026, 11, 5, 7, 0, tzinfo=tokyo)
        nxt = expr.next_after(local)
        self.assertEqual(nxt.tzinfo, tokyo)
        self.assertEqual(nxt, datetime(2026, 11, 5, 8, 0, tzinfo=tokyo))

        naive = datetime(2026, 11, 5, 7, 0)
        self.assertEqual(expr.next_after(naive), datetime(2026, 11, 5, 8, 0))
        self.assertIsNone(expr.next_after(naive).tzinfo)


class TestCronErrors(unittest.TestCase):
    def assert_bad(self, expression: str, needle: str = "") -> None:
        with self.assertRaises(CronError) as ctx:
            CronExpr.parse(expression)
        if needle:
            self.assertIn(needle, str(ctx.exception))

    def test_field_count(self) -> None:
        self.assert_bad("")
        self.assert_bad("* * * *", "5 段")
        self.assert_bad("* * * * * *", "5 段")

    def test_out_of_range(self) -> None:
        self.assert_bad("60 * * * *", "超出范围")
        self.assert_bad("0 24 * * *", "超出范围")
        self.assert_bad("0 0 0 * *", "超出范围")
        self.assert_bad("0 0 * 13 *", "超出范围")
        self.assert_bad("0 0 * * 8", "超出范围")

    def test_bad_step_and_range(self) -> None:
        self.assert_bad("*/0 * * * *", "步长")
        self.assert_bad("5-1 * * * *", "起点大于终点")
        self.assert_bad("1/2/3 * * * *", "'/'")

    def test_garbage_values(self) -> None:
        self.assert_bad("abc * * * *", "不是非负整数")
        self.assert_bad("* -1 * * *")
        self.assert_bad("1,,2 * * * *", "空项")
        self.assert_bad("1- * * * *", "空项")

    def test_non_string_rejected(self) -> None:
        with self.assertRaises(CronError):
            CronExpr.parse(None)  # type: ignore[arg-type]

    def test_next_after_impossible_combination_raises(self) -> None:
        # 2 月 30 日永远不成立：必须报错，而不是静默返回一个错误时间。
        with self.assertRaises(CronError):
            parse("0 0 30 2 *").next_after(dt(2026, 1, 1, 0, 0))


if __name__ == "__main__":
    unittest.main()
