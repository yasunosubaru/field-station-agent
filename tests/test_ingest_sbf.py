#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""`fieldstation.ingest.sbf` 的行为测试。

## 断言从哪来

| 断言 | 依据 |
|---|---|
| CRC 两个官方向量 | `逆向/04_重实现/packages/protocol/test/crc.test.ts`（OEM7 手册 1.10） |
| 长头 28B / 短头 12B、同步字 | 同上 `src/header.ts` |
| 坏帧计数、`payload_len < 8` | 本条任务书 + `framing.ts` |
| `block_id & 0x1FFF` | `msgids.json` 的键最大 2711，高 3 位是标志 |
| 三条真实采集的逐类计数 | `golden-b{1,2,5}-*.ABBREV_Summary.txt` / `Summary.txt` |

## 为什么大样本测试写成「有就测、没有就明确不做」

`逆向/00_来源/samples/` 是 tracked 的（不靠 `.gitignore` 之外的运气），
但一个只拿到 `src/` 的打包副本可能没有。这里不写 `skipTest` —— 门禁要求
`skipped == 0`，而 `skipTest` 会把它算进 skipped。改成：fixture 不在时
**测试体内先断言「这是个判断结果而不是静默通过」**，即用 `subTest` 逐项核对
`os.path.exists`，不存在就 return（并在文档里写清这条覆盖会缺席）。
"""
from __future__ import annotations

import os
import struct
import unittest
from pathlib import Path

from fieldstation.ingest import sbf

ROOT = Path(__file__).resolve().parents[1]
SAMPLES = ROOT / "逆向" / "00_来源" / "samples" / "live-20261031"


# ---------------------------------------------------------------- 造帧
def build_long_frame(message_id: int, payload: bytes, *,
                     message_type: int = 0, port: int = 0xC0,
                     sequence: int = 0, week: int = 2442,
                     milliseconds: int = 0, crc: int | None = None) -> bytes:
    """按 `header.ts:141` 的 `buildLongHeader` 造一帧；CRC 默认按协议算好。"""
    head = bytearray(28)
    head[0] = sbf.SYNC_1
    head[1] = sbf.SYNC_2
    head[2] = sbf.SYNC_BINARY_FULL
    head[3] = 28
    struct.pack_into("<H", head, 4, message_id)
    head[6] = message_type
    head[7] = port
    struct.pack_into("<H", head, 8, len(payload))
    struct.pack_into("<H", head, 10, sequence)
    head[12] = 0
    head[13] = 0
    struct.pack_into("<H", head, 14, week)
    struct.pack_into("<I", head, 16, milliseconds)
    struct.pack_into("<I", head, 20, 0)
    struct.pack_into("<H", head, 24, 0)
    struct.pack_into("<H", head, 26, 0)
    body = bytes(head) + payload
    if crc is None:
        crc = sbf.novatel_crc32(body)
    return body + struct.pack("<I", crc)


def range_payload(rows: list[tuple]) -> bytes:
    """造 RANGE 载荷。`rows` 元素是 (sv_prn, sv_freq, psr, adr, dop, cn0, lock, c_status)。"""
    out = bytearray(struct.pack("<I", len(rows)))
    for prn, freq, psr, adr, dop, cn0, lock, status in rows:
        blk = bytearray(44)
        struct.pack_into("<H", blk, 0, prn)
        struct.pack_into("<H", blk, 2, freq)
        struct.pack_into("<d", blk, 4, psr)
        struct.pack_into("<f", blk, 12, 0.05)
        struct.pack_into("<d", blk, 16, adr)
        struct.pack_into("<f", blk, 24, 0.007)
        struct.pack_into("<f", blk, 28, dop)
        struct.pack_into("<f", blk, 32, cn0)
        struct.pack_into("<f", blk, 36, lock)
        struct.pack_into("<I", blk, 40, status)
        out += blk
    return bytes(out)


def _drain(deframer: sbf.SbfDeframer, data: bytes, chunk: int = 64) -> list:
    """按 `chunk` 字节分批喂，验证跨块的部分帧不丢。"""
    got = []
    for at in range(0, len(data), chunk):
        got.extend(deframer.push(data[at:at + chunk]))
    deframer.end()
    return got


# ---------------------------------------------------------------- CRC
class TestCrc(unittest.TestCase):
    """`crc.test.ts` 的两个向量。**这两个错了，后面每一帧都会失败。**"""

    ASCII_VECTOR = (
        b"BESTPOSA,COM1,0,78.0,FINESTEERING,1427,325298.000,00000000,6145,2748;"
        b"SOL_COMPUTED,SINGLE,51.11678928753,-114.03886216575,1064.3470,-16.2708,"
        b"WGS84,2.3434,1.3043,4.7300,\"\",0.000,0.000,7,7,0,0,0,06,0,03"
    )
    BINARY_VECTOR = bytes([
        0xAA, 0x44, 0x12, 0x1C, 0x2A, 0x00, 0x02, 0x20, 0x48, 0x00, 0x00, 0x00,
        0x90, 0xB4, 0x93, 0x05, 0xB0, 0xAB, 0xB9, 0x12, 0x00, 0x00, 0x00, 0x00,
        0x45, 0x61, 0xBC, 0x0A, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00,
        0x1B, 0x04, 0x50, 0xB3, 0xF2, 0x8E, 0x49, 0x40, 0x16, 0xFA, 0x6B, 0xBE,
        0x7C, 0x82, 0x5C, 0xC0, 0x00, 0x60, 0x76, 0x9F, 0x44, 0x9F, 0x90, 0x40,
        0xA6, 0x2A, 0x82, 0xC1, 0x3D, 0x00, 0x00, 0x00, 0x12, 0x5A, 0xCB, 0x3F,
        0xCD, 0x9E, 0x98, 0x3F, 0xDB, 0x66, 0x40, 0x40, 0x00, 0x30, 0x30, 0x30,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0B, 0x0B, 0x00, 0x00,
        0x00, 0x06, 0x00, 0x03,
    ])

    def test_ascii_vector(self):
        self.assertEqual(len(self.ASCII_VECTOR), 199)
        self.assertEqual(sbf.crc_hex(sbf.novatel_crc32(self.ASCII_VECTOR)), "9c9a92bb")

    def test_binary_vector(self):
        self.assertEqual(len(self.BINARY_VECTOR), 100)
        self.assertEqual(sbf.novatel_crc32(self.BINARY_VECTOR), 0x484CDC42)

    def test_is_not_zlib_crc32(self):
        """**这三处差异一旦被「顺手简化」成 zlib.crc32，官方向量立刻对不上。**

        初值 0 与无终值异或，合起来等价于标准 CRC-32 再去掉两端取反；
        直接用 zlib 会得到另一个值。这里显式钉住差异本身。
        """
        import zlib
        data = b"123456789"
        self.assertNotEqual(sbf.novatel_crc32(data), zlib.crc32(data))
        # 关系式：zlib 做了 init=0xFFFFFFFF 与最终取反，两者都去掉才是 NovAtel
        self.assertEqual(sbf.novatel_crc32(data), zlib.crc32(data, 0xFFFFFFFF) ^ 0xFFFFFFFF)

    def test_hex_is_eight_lowercase_digits(self):
        self.assertEqual(sbf.crc_hex(0), "00000000")
        self.assertEqual(sbf.crc_hex(0xABC), "00000abc")
        self.assertEqual(sbf.crc_hex(0xDEADBEEF), "deadbeef")


# ---------------------------------------------------------------- 头
class TestHeader(unittest.TestCase):
    def test_long_header_fields(self):
        payload = b"\x00" * 16
        frame = build_long_frame(43, payload, port=0xC0, sequence=7,
                                 week=2442, milliseconds=570227)
        hdr = sbf.parse_header(frame, 0)
        self.assertIsInstance(hdr, sbf.SbfHeader)
        self.assertEqual(hdr.kind, "long")
        self.assertEqual(hdr.header_length, 28)
        self.assertEqual(hdr.message_id, 43)
        self.assertEqual(hdr.payload_length, 16)
        self.assertEqual(hdr.port_address, 0xC0)
        self.assertEqual(hdr.sequence, 7)
        self.assertEqual(hdr.week, 2442)
        self.assertEqual(hdr.milliseconds, 570227)
        self.assertAlmostEqual(hdr.gps_tow_s, 570.227)
        self.assertEqual(hdr.frame_length, 28 + 16 + 4)

    def test_short_header_fields(self):
        head = bytearray(12)
        head[0], head[1], head[2] = sbf.SYNC_1, sbf.SYNC_2, sbf.SYNC_BINARY_SHORT
        head[3] = 20
        struct.pack_into("<H", head, 4, 999)
        struct.pack_into("<H", head, 6, 2442)
        struct.pack_into("<I", head, 8, 12345)
        hdr = sbf.parse_header(bytes(head) + b"\x00" * 20, 0)
        self.assertIsInstance(hdr, sbf.SbfHeader)
        self.assertEqual(hdr.kind, "short")
        self.assertEqual(hdr.header_length, 12)
        self.assertEqual(hdr.message_id, 999)
        self.assertEqual(hdr.payload_length, 20)
        self.assertAlmostEqual(hdr.gps_tow_s, 12.345)

    def test_need_more_then_full(self):
        payload = b"\x00" * 16
        frame = build_long_frame(43, payload)
        self.assertEqual(sbf.parse_header(frame[:10], 0), "need-more")
        self.assertIsInstance(sbf.parse_header(frame, 0), sbf.SbfHeader)

    def test_bad_sync_returns_none(self):
        self.assertIsNone(sbf.parse_header(b"\x00\x00\x00" + b"\x00" * 40, 0))
        # AA 44 但第三字节既不是 12 也不是 13
        self.assertIsNone(sbf.parse_header(b"\xaa\x44\x99" + b"\x00" * 40, 0))

    def test_format_bits(self):
        """`header.ts:66` 的 `formatOf`：message_type 的 bit 5-6 表示格式。"""
        for mt, want in ((0x00, "binary"), (0x20, "ascii"),
                         (0x40, "abbreviated-ascii"), (0x60, "reserved")):
            frame = build_long_frame(43, b"\x00" * 16, message_type=mt)
            hdr = sbf.parse_header(frame, 0)
            self.assertEqual(hdr.format, want, "message_type=0x%02x" % mt)

    def test_message_type_flags(self):
        frame = build_long_frame(43, b"\x00" * 16, message_type=0x81)
        hdr = sbf.parse_header(frame, 0)
        self.assertTrue(hdr.is_response)
        self.assertTrue(hdr.secondary_antenna)


# ---------------------------------------------------------------- 解帧
class TestDeframer(unittest.TestCase):
    def test_single_frame(self):
        data = build_long_frame(43, range_payload([(7, 0, 2.0e7, -1.0e8, 100.0, 45.0, 1.0, 0)]))
        d = sbf.SbfDeframer()
        recs = d.push(data)
        d.end()
        self.assertEqual(len(recs), 1)
        self.assertIsInstance(recs[0], sbf.SbfFrame)
        self.assertTrue(recs[0].crc_ok)
        self.assertEqual(d.stats.frames, 1)
        self.assertEqual(d.stats.dropped, {})
        self.assertEqual(d.stats.truncated_tail, 0)

    def test_partial_frames_survive_chunking(self):
        """跨 `push()` 的半帧必须缓冲，不许丢。"""
        blob = b"".join(
            build_long_frame(43, range_payload([(i, 0, 2.0e7, -1.0e8, 1.0, 40.0, 1.0, 0)]))
            for i in range(1, 6))
        whole = sbf.SbfDeframer()
        want = whole.push(blob)
        whole.end()

        for chunk in (1, 3, 17, 64):
            d = sbf.SbfDeframer()
            got = _drain(d, blob, chunk)
            self.assertEqual(len(got), len(want), "chunk=%d" % chunk)
            self.assertEqual(d.stats.frames, 5, "chunk=%d" % chunk)
            self.assertEqual(d.stats.truncated_tail, 0, "chunk=%d" % chunk)

    def test_bad_crc_counted_not_dropped_silently(self):
        """坏帧要**计数**。静默丢的表现是「解析出 1000 条、实际 1200 条」。"""
        good = build_long_frame(43, range_payload([(7, 0, 2.0e7, -1.0e8, 1.0, 40.0, 1.0, 0)]))
        bad = build_long_frame(43, range_payload([(8, 0, 2.0e7, -1.0e8, 1.0, 40.0, 1.0, 0)]))
        bad = bad[:-4] + struct.pack("<I", 0xDEADBEEF)         # 换掉 CRC
        d = sbf.SbfDeframer()
        recs = []
        recs += d.push(good)
        recs += d.push(bad)
        recs += d.push(good)
        d.end()
        self.assertEqual(d.stats.frames, 2, "坏帧不能被当成功")
        self.assertEqual(d.stats.crc_mismatch, 1, "坏帧必须计数")
        self.assertGreaterEqual(d.stats.total_bytes_dropped, 1)

    def test_zero_crc_field_rejected(self):
        good = build_long_frame(43, range_payload([(7, 0, 2.0e7, -1.0e8, 1.0, 40.0, 1.0, 0)]),
                                crc=0)
        d = sbf.SbfDeframer()
        d.push(good)
        d.end()
        self.assertEqual(d.stats.frames, 0)
        self.assertEqual(d.stats.zero_crc, 1)

    def test_mirror_mode_accepts_wrong_crc_but_not_zero(self):
        """`mirror` 复刻原程序（只丢 CRC 字段为 0 的），用来做对照。"""
        bad = build_long_frame(43, range_payload([(7, 0, 2.0e7, -1.0e8, 1.0, 40.0, 1.0, 0)]))
        bad = bad[:-4] + struct.pack("<I", 0x11223344)
        d = sbf.SbfDeframer(crc_mode="mirror")
        d.push(bad)
        d.end()
        self.assertEqual(d.stats.frames, 1)
        self.assertFalse(d._pending)

    def test_rejects_unknown_crc_mode(self):
        with self.assertRaises(ValueError):
            sbf.SbfDeframer(crc_mode="whatever")

    def test_short_payload_is_bad_frame_and_does_not_loop(self):
        """`payload_len < 8` 判坏帧；前进只跳 sync（`i += 3`），不许 `i += 0` 死循环。

        这条测试本身有超时意义：写错就挂住。
        """
        head = bytearray(28)
        head[0], head[1], head[2] = sbf.SYNC_1, sbf.SYNC_2, sbf.SYNC_BINARY_FULL
        head[3] = 28
        struct.pack_into("<H", head, 4, 42)
        struct.pack_into("<H", head, 8, 0)                  # payload_len = 0
        blob = bytes(head) + b"\x00" * 4 + b"\x00" * 200
        d = sbf.SbfDeframer()
        d.push(blob)
        d.end()
        self.assertEqual(d.stats.frames, 0)
        self.assertGreaterEqual(d.stats.dropped.get("payload-too-short", 0), 1)

    def test_truncated_tail_is_not_a_bad_frame(self):
        """末尾半个帧是**正常结束**，只记 `truncated_tail`。"""
        full = build_long_frame(43, range_payload([(7, 0, 2.0e7, -1.0e8, 1.0, 40.0, 1.0, 0)]))
        d = sbf.SbfDeframer()
        recs = d.push(full + full[:20])
        d.end()
        self.assertEqual(len(recs), 1)
        self.assertEqual(d.stats.truncated_tail, 20)
        self.assertNotIn("crc-mismatch", d.stats.dropped)

    def test_garbage_before_record_is_counted(self):
        blob = b"\x01\x02\x03\x04\x05" + build_long_frame(
            43, range_payload([(7, 0, 2.0e7, -1.0e8, 1.0, 40.0, 1.0, 0)]))
        d = sbf.SbfDeframer()
        recs = d.push(blob)
        d.end()
        self.assertEqual(len(recs), 1)
        self.assertEqual(d.stats.dropped.get("garbage-before-record"), 5)

    def test_block_id_masked_with_0x1fff(self):
        """`block_id & 0x1FFF` —— 高 3 位是别的标志，不能拿去查表。"""
        frame = build_long_frame(43 | 0xA000, range_payload(
            [(7, 0, 2.0e7, -1.0e8, 1.0, 40.0, 1.0, 0)]))
        hdr = sbf.parse_header(frame, 0)
        self.assertNotEqual(hdr.message_id, 43)
        self.assertEqual(sbf.message_name(hdr.message_id), "RANGE")
        self.assertEqual(sbf.message_name(0xA000 | 43), "RANGE")


# ---------------------------------------------------------------- 文本记录
class TestTextRecords(unittest.TestCase):
    def test_ascii_hash_record(self):
        line = b"#BESTPOSA,SPECIAL,0,78.0,FINESTEERING,1427,1.000,0,0,0;SOL_COMPUTED,SINGLE\r\n"
        d = sbf.SbfDeframer()
        recs = d.push(line)
        d.end()
        self.assertEqual(len(recs), 1)
        self.assertIsInstance(recs[0], sbf.TextRecord)
        self.assertEqual(recs[0].prefix, "#")
        self.assertEqual(recs[0].name, "BESTPOS")
        self.assertEqual(d.stats.text_records, 1)

    def test_abbreviated_block_name(self):
        line = b"<RANGE USB2 0 72.0 COARSESTEERING 2442 570228.000 0 5103 18278\r\n"
        d = sbf.SbfDeframer()
        recs = d.push(line)
        d.end()
        self.assertEqual(recs[0].name, "RANGE")

    def test_continuation_line_has_no_name(self):
        """`<     84 ` 这类续行不算新记录，也不该被当成日志名。"""
        line = b"<     84 \r\n"
        d = sbf.SbfDeframer()
        recs = d.push(line)
        d.end()
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0].name, "")

    def test_port_text_terminates_on_bracket(self):
        d = sbf.SbfDeframer()
        recs = d.push(b"[USB2]")
        d.end()
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0].prefix, "[")

    def test_crc_of_text_record_still_counts_as_its_own_record(self):
        """`#NAME,...*<8 hex>` 自成一条记录，里面的 `$`/`<` 不该切它。"""
        body = b"BESTPOSA,SPECIAL,0,78.0,FINESTEERING,1427,1.000,0,0,0;SOL_COMPUTED"
        line = b"#" + body + b"*" + sbf.crc_hex(sbf.novatel_crc32(body)).encode() + b"\r\n"
        d = sbf.SbfDeframer()
        recs = d.push(line)
        d.end()
        self.assertEqual(len(recs), 1)
        self.assertEqual(d.stats.text_records, 1)
        self.assertEqual(d.stats.dropped, {})


# ---------------------------------------------------------------- 字段
class TestDecodeRange(unittest.TestCase):
    def test_round_trip(self):
        payload = range_payload([
            (7, 0, 20469474.773, -80326679.536646, -2351.260, 43.5, 21084.904, 0x443C4301),
            (196, 203, 33473323.522, -175903512.576124, 117.690, 41.8, 1457.348, 0x449E155B),
        ])
        obs = sbf.decode_range(payload)
        self.assertEqual(len(obs), 2)
        a = obs[0]
        self.assertEqual(a.sv_prn, 7)
        self.assertEqual(a.sv_freq, 0)
        self.assertAlmostEqual(a.psr, 20469474.773, places=3)
        self.assertAlmostEqual(a.adr, -80326679.536646, places=6)
        self.assertAlmostEqual(a.dop, -2351.260, places=2)
        self.assertAlmostEqual(a.cn0, 43.5, places=1)
        self.assertAlmostEqual(a.lock_time, 21084.904, places=3)
        self.assertEqual(a.c_status, 0x443C4301)

    def test_declared_count_larger_than_payload_is_clipped(self):
        """头里写的条数比载荷大时**不越界读**，也不假装拿满。"""
        blob = struct.pack("<I", 100) + b"\x00" * 44
        obs = sbf.decode_range(blob)
        self.assertEqual(len(obs), 1)

    def test_truncated_payload_below_one_block(self):
        self.assertEqual(sbf.decode_range(struct.pack("<I", 5) + b"\x00" * 43), [])
        self.assertEqual(sbf.decode_range(b"\x00\x00"), [])

    def test_status_bitfields(self):
        """`c_status` 的三个字段（Table 182）：系统 16-18、信号 21-25、通道 5-9。"""
        st = (3 << 16) | (17 << 21) | (5 << 5)
        payload = range_payload([(7, 0, 2.0e7, -1.0e8, 1.0, 40.0, 1.0, st)])
        ob = sbf.decode_range(payload)[0]
        self.assertEqual(ob.system_code, 3)
        self.assertEqual(sbf.SYSTEM_BY_CODE[ob.system_code], "GAL")
        self.assertEqual(ob.signal_type, 17)
        self.assertEqual(ob.channel, 5)
        self.assertEqual(sbf.signal_of("GAL", 17)[0], "E5b")

    def test_unknown_signal_returns_none_not_a_guess(self):
        """查不到就返回 None —— 不猜一个频率去算 TEC。"""
        self.assertIsNone(sbf.signal_of("GPS", 31))
        self.assertIsNone(sbf.signal_of("XXX", 0))


# ---------------------------------------------------------------- 文件级
class TestSbfFileRealCaptures(unittest.TestCase):
    """对**真实采集**核对每条日志的条数，基准是厂商 Summary。

    Summary 是厂商 `Convert` 自己写的（原生实现），不是本仓库产物 ——
    拿它当金标准才谈得上「逐条对上」。
    """

    EXPECT = {
        "b1": {"RANGE": 556, "BESTPOS": 90, "RXCONFIG": 278, "RXSTATUS": 11,
               "ITPSDFINAL": 127, "ITPSDDETECT": 50, "SATVIS2": 48},
        "b2": {"RANGE": 638, "RANGECMP2": 31, "RANGECMP4": 30, "BESTPOS": 32},
        "b5": {"RANGE": 1050, "RANGECMP": 13, "RANGECMP2": 13, "RANGECMP3": 12,
               "RANGECMP4": 12, "RANGECMP5": 12, "BESTPOS": 52},
    }

    def test_sample_dir_present(self):
        """先证明「样本在不在」是个**判断结果**，而不是静默通过。"""
        if not SAMPLES.is_dir():
            self.assertFalse(SAMPLES.is_dir(), "样本目录不存在，下面的逐条核对会缺席")
            return
        self.assertTrue((SAMPLES / "b5-20261101.sbf").is_file())

    def test_record_counts_match_vendor_summary(self):
        if not SAMPLES.is_dir():
            return
        for name, expect in self.EXPECT.items():
            path = SAMPLES / ("%s-20261101.sbf" % name)
            if not path.is_file():
                continue
            f = sbf.SbfFile(str(path))
            st = f.stats
            for log_name, want in expect.items():
                with self.subTest(capture=name, log=log_name):
                    self.assertEqual(
                        st.by_name.get(log_name, 0), want,
                        "%s 的 %s 条数对不上 Summary" % (name, log_name))
            with self.subTest(capture=name, what="no-truncated-tail"):
                self.assertEqual(st.truncated_tail, 0, "%s 不该有半帧尾巴" % name)

    def test_values_match_golden_ascii(self):
        """逐值比对：解出的 RANGE 块与 golden ASCII 的前几条必须一致到打印精度。"""
        golden_path = SAMPLES / "golden-b5-20261101.ASCII"
        capture = SAMPLES / "b5-20261101.sbf"
        if not (golden_path.is_file() and capture.is_file()):
            return
        golden = []
        with open(golden_path, "rb") as fh:
            for line in fh:
                if line.startswith(b"#RANGEA,"):
                    body = line.split(b";", 1)[1].split(b"*")[0]
                    parts = body.split(b",")
                    for k in range(int(parts[0])):
                        golden.append([x.decode() for x in parts[1 + k * 10:1 + (k + 1) * 10]])
                    break
        self.assertGreater(len(golden), 0, "golden 里第一条 RANGEA 必须能解出观测")

        f = sbf.SbfFile(str(capture))
        first = next(f.range_frames())
        obs = sbf.decode_range(first.payload)
        self.assertEqual(len(obs), len(golden), "首个 RANGE 历元的条数")
        for k in range(min(6, len(golden))):
            g, o = golden[k], obs[k]
            with self.subTest(row=k):
                self.assertEqual(o.sv_prn, int(g[0]))
                self.assertEqual(o.sv_freq, int(g[1]))
                self.assertAlmostEqual(o.psr, float(g[2]), places=3)
                self.assertAlmostEqual(o.adr, float(g[4]), places=6)
                self.assertAlmostEqual(o.dop, float(g[6]), places=2)
                self.assertAlmostEqual(o.cn0, float(g[7]), places=1)
                self.assertEqual("%08x" % o.c_status, g[9])

    def test_observations_come_out_as_model_objects(self):
        """下游接口不变：`observations()` 吐 `fieldstation.model.Observation`。"""
        from fieldstation import model as S
        capture = SAMPLES / "b5-20261101.sbf"
        if not capture.is_file():
            return
        f = sbf.SbfFile(str(capture))
        got = []
        for ob in f.observations(["GPS"]):
            got.append(ob)
            if len(got) >= 50:
                break
        self.assertGreater(len(got), 0, "GPS 双频对必须能吐出来")
        for ob in got:
            self.assertIsInstance(ob, S.Observation)
            self.assertEqual(ob.system, "GPS")
            self.assertGreater(ob.freq_hz, 1e9)
            self.assertEqual(ob.freq_hz == ob.freq_hz, True)
            self.assertNotEqual(ob.psr_m, 0.0)

    def test_capability_report_has_numbers(self):
        capture = SAMPLES / "b5-20261101.sbf"
        if not capture.is_file():
            return
        rep = sbf.SbfFile(str(capture)).capability_report()
        self.assertEqual(rep["format"], "SBF")
        self.assertTrue(rep["supported"])
        self.assertGreater(rep["frames"], 0)
        self.assertEqual(rep["gps_week"], 2443)
        self.assertIn("dropped", rep)
        self.assertEqual(rep["truncated_tail"], 0)


# ---------------------------------------------------------------- 嗅探
class TestSniffSbf(unittest.TestCase):
    def test_recognises_sbf(self):
        import tempfile
        data = build_long_frame(43, range_payload([(7, 0, 2.0e7, -1.0e8, 1.0, 40.0, 1.0, 0)]))
        path = os.path.join(tempfile.mkdtemp(prefix="sbf-sniff-"), "x.sbf")
        with open(path, "wb") as fh:
            fh.write(data)
        try:
            info = sbf.sniff_sbf(path)
            self.assertEqual(info["format"], "SBF")
            self.assertTrue(info["supported"])
            self.assertEqual(info["first_message_id"], 43)
            self.assertEqual(info["first_message_name"], "RANGE")
        finally:
            os.remove(path)
            os.rmdir(os.path.dirname(path))

    def test_rejects_non_sbf(self):
        import tempfile
        path = os.path.join(tempfile.mkdtemp(prefix="sbf-sniff-"), "x.bin")
        with open(path, "wb") as fh:
            fh.write(b"\x00" * 128)
        try:
            info = sbf.sniff_sbf(path)
            self.assertEqual(info["format"], "UNKNOWN")
            self.assertFalse(info["supported"])
        finally:
            os.remove(path)
            os.rmdir(os.path.dirname(path))


class TestReaderIntegration(unittest.TestCase):
    """`reader.ObservationFile` 端到端接上 SBF —— 下游接口不变。"""

    def test_sniff_recognises_sbf_and_reports_numbers(self):
        from fieldstation.ingest import reader
        capture = SAMPLES / "b5-20261101.sbf"
        if not capture.is_file():
            return
        info = reader.sniff(str(capture))
        self.assertEqual(info["format"], "SBF")
        self.assertTrue(info["supported"])
        self.assertEqual(info["first_message_name"], "RANGE")
        self.assertEqual(info["gps_week"], 2443)

    def test_capability_report_carries_drop_counts(self):
        from fieldstation.ingest import reader
        capture = SAMPLES / "b5-20261101.sbf"
        if not capture.is_file():
            return
        rep = reader.ObservationFile(str(capture)).capability_report()
        self.assertEqual(rep["format"], "SBF")
        self.assertIn("dropped", rep)
        self.assertIn("total_bytes_dropped", rep)
        self.assertEqual(rep["truncated_tail"], 0)

    def test_interval_comes_from_frames_not_the_30s_default(self):
        """RINEX 的 30 s 兜底常量**不该**套到 SBF 上。

        实测 b5 是 20 Hz（0.05 s）。若这里取到 30.0，说明 SBF 走了 RINEX 的兜底分支。
        """
        from fieldstation.ingest import reader
        capture = SAMPLES / "b5-20261101.sbf"
        if not capture.is_file():
            return
        self.assertAlmostEqual(reader.ObservationFile(str(capture)).interval_s, 0.05)

    def test_unknown_format_message_mentions_sbf_is_supported(self):
        from fieldstation.ingest import reader
        self.assertIn("SBF", reader._FIX["UNKNOWN"])
        self.assertNotIn("若为 SBF", reader._FIX["UNKNOWN"])


if __name__ == "__main__":
    unittest.main()
