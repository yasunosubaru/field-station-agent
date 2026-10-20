"""公开数据通路：清单 → 取数校验 → 读数映射 → 判据与记录。

四组：

* **清单**：每个源都要有 id / url / 许可 / 校验和 / 取回日期 / 用途；
  入库样本的 sha256 必须与登记一致（否则「登记的数」和「入库的数」不是一回事）。
* **取数工具**：用 ``file://`` 源离线测（匹配 → 落缓存；不匹配 → 退出 1；
  清单缺失 → 退出 2），不依赖网络。
* **映射**：Open-Meteo 逐小时 → 设备读数；缺测记 ``None`` + ``missing``；
  判据结果由 ``station_health`` 统一给。
* **记录**：同一份输入两次运行逐字节相同；入库记录与当前生成器一致。
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "data" / "public" / "manifest.json"
FETCH = ROOT / "tools" / "fetch_public_data.py"
REPLAY = ROOT / "harness" / "public_data_replay.py"
SAMPLE = ROOT / "data" / "public" / "samples" / "openmeteo_badg_202401_d01.json"
COMMITTED_LOG = ROOT / "logs" / "public_data_device_202401d01.json"


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", cwd=str(ROOT), env=env, timeout=180)


def _sample_payload() -> dict:
    return {
        "latitude": 40.386642, "longitude": 116.23943, "elevation": 707.0,
        "timezone": "UTC",
        "hourly": {
            "time": ["2024-01-01T00:00", "2024-01-01T01:00", "2024-01-01T02:00"],
            "temperature_2m": [-11.6, -9.5, None],
            "relative_humidity_2m": [79, 71, 59],
            "surface_pressure": [939.6, 940.4, 941.3],
            "wind_speed_10m": [3.0, 5.8, 4.3],
        },
    }


class TestManifest(unittest.TestCase):
    def test_entries_are_complete(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(manifest["kind"], "fieldstation.public_data.manifest")
        sources = manifest["sources"]
        self.assertTrue(sources)
        ids = [source["id"] for source in sources]
        self.assertEqual(len(ids), len(set(ids)))
        for source in sources:
            for key in ("id", "title", "url", "license", "attribution",
                        "retrieved", "sha256", "bytes", "used_for", "caveat"):
                self.assertTrue(source.get(key), f"{source.get('id')} 缺 {key}")
            self.assertRegex(source["sha256"], r"^[0-9a-f]{64}$")
            self.assertIn(source["license"], ("CC BY 4.0",))

    def test_committed_sample_matches_manifest(self):
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        for source in manifest["sources"]:
            sample = source.get("committed_sample")
            if not sample:
                continue
            path = ROOT / sample
            self.assertTrue(path.is_file(), sample)
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(digest, source["sha256"], sample)


class TestFetchTool(unittest.TestCase):
    def _manifest(self, td: Path, payload: bytes) -> Path:
        source = td / "src.bin"
        source.write_bytes(payload)
        manifest = td / "manifest.json"
        manifest.write_text(json.dumps({
            "kind": "fieldstation.public_data.manifest", "version": 1,
            "sources": [{
                "id": "local", "title": "本地源", "url": source.as_uri(),
                "license": "CC BY 4.0", "attribution": "test",
                "retrieved": "2026-10-20",
                "sha256": hashlib.sha256(payload).hexdigest(),
                "bytes": len(payload), "cache": "cache/local.json",
                "committed_sample": None, "used_for": "测试", "caveat": "测试",
            }],
        }, ensure_ascii=False), encoding="utf-8")
        return manifest

    def test_matching_source_is_cached(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            payload = b'{"hello": "public"}'
            manifest = self._manifest(td, payload)
            run = _run([sys.executable, str(FETCH), "--manifest", str(manifest),
                        "--cache-dir", str(td / "cache")])
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertTrue((td / "cache" / "local.json").is_file())

    def test_sha_mismatch_exits_1(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            manifest = self._manifest(td, b'{"hello": "public"}')
            data = json.loads(manifest.read_text(encoding="utf-8"))
            data["sources"][0]["sha256"] = "0" * 64
            manifest.write_text(json.dumps(data, ensure_ascii=False),
                                encoding="utf-8")
            run = _run([sys.executable, str(FETCH), "--manifest", str(manifest),
                        "--cache-dir", str(td / "cache")])
            self.assertEqual(run.returncode, 1, run.stdout + run.stderr)
            self.assertIn("sha256 不符", run.stdout)

    def test_missing_manifest_exits_2(self):
        with tempfile.TemporaryDirectory() as td:
            run = _run([sys.executable, str(FETCH), "--manifest",
                        str(Path(td) / "nope.json")])
            self.assertEqual(run.returncode, 2, run.stdout + run.stderr)
            self.assertIn("[阻断]", run.stdout)


class TestMapping(unittest.TestCase):
    def _replay(self, payload: dict, td: Path) -> dict:
        source = td / "in.json"
        source.write_text(json.dumps(payload, ensure_ascii=False),
                          encoding="utf-8")
        out = td / "out.json"
        run = _run([sys.executable, str(REPLAY), "--input", str(source),
                    "--out", str(out)])
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
        return json.loads(out.read_text(encoding="utf-8"))

    def test_mapping_produces_readings_and_health(self):
        with tempfile.TemporaryDirectory() as td:
            log = self._replay(_sample_payload(), Path(td))
            self.assertEqual(log["kind"], "fieldstation.public_data_device.log")
            self.assertEqual(log["mapping"]["station"], "BADG")
            self.assertEqual(log["mapping"]["readings"], 12)  # 3 小时 × 4 指标
            self.assertEqual(log["input"]["records"], 3)
            station = log["health"]["stations"][0]
            self.assertEqual(station["station_id"], "BADG")
            self.assertEqual(log["health"]["summary"]["missing"], 1)
            self.assertEqual(station["status"], "degraded")
            self.assertIn("caveat", log)

    def test_missing_value_is_flagged(self):
        with tempfile.TemporaryDirectory() as td:
            log = self._replay(_sample_payload(), Path(td))
            metric = next(m for m in log["mapping"]["metrics"]
                          if m["metric"] == "temperature_c")
            self.assertEqual(metric["missing"], 1)
            self.assertEqual(metric["count"], 3)


class TestReplayRecord(unittest.TestCase):
    def test_committed_log_matches_regeneration(self):
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "out.json"
            run = _run([sys.executable, str(REPLAY), "--input", str(SAMPLE),
                        "--out", str(out)])
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual(
                out.read_bytes(), COMMITTED_LOG.read_bytes(),
                "logs/public_data_device_202401d01.json 与回放输出不一致："
                "重新运行 harness/public_data_replay.py 并提交")

    def test_two_runs_are_identical_and_lf(self):
        with tempfile.TemporaryDirectory() as td:
            td = Path(td)
            first, second = td / "a.json", td / "b.json"
            for out in (first, second):
                run = _run([sys.executable, str(REPLAY), "--input", str(SAMPLE),
                            "--out", str(out)])
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            raw = first.read_bytes()
            self.assertNotIn(b"\r\n", raw)
            self.assertTrue(raw.endswith(b"\n"))


if __name__ == "__main__":
    unittest.main()
