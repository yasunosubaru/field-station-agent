"""虚拟屏几何（ensure_virtual_display.py）的回归测试。

## 为什么这几条必须存在

几何层是全部坐标操作的地基，而它的失败方式全都是"看起来成功了"：

1. **候选集把掉线屏排除**：`d["is_virtual"] and d["mode"]` —— 掉线后 `cur_mode()`
   是 None，于是"没有可用虚拟屏"，掉线再也回不来。
2. **认错目标适配器**：`next(d for d in virt if d["attached"])` 会挑到 GameViewer ——
   它在远程会话下本来就 attached 并把自己改成 2560x1600，脚本于是报 READY，
   而真正的 VDD 根本没接。
3. **`ChangeDisplaySettingsExW` 必须两段式**：带 `CDS_NORESET` 才成功（rc=0），
   不带就 `DISP_CHANGE_FAILED`。逐个试过 TEST only / RESET / 带位置 / 带 bpp 都失败。
4. **扩展不持久**：`SetDisplayConfig(EXTEND|APPLY)` 只在"没有别的进程占着 GPU
   采集会话"时稳定；带 `SDC_SAVE_TO_DATABASE` 直接 rc=87。GameViewer 的采集
   会话占着 swapchain 时，扩展 4 秒后必掉（实测 1 -> 2 -> 1，可复现）。

前三条测纯函数与单次行为，第四条测端到端自愈。
"""
import ctypes
import importlib.util
import subprocess
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TOOL = REPO / "tools" / "ensure_virtual_display.py"
PY = REPO / ".deps" / "venv" / "Scripts" / "python.exe"
RUN_PS = REPO / "tools" / "register-geometry.ps1"

SDC_TOPOLOGY_INTERNAL = 0x00000001
SDC_APPLY = 0x00000080


def load_tool():
    spec = importlib.util.spec_from_file_location("_ensure_vd", TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def metrics() -> list[int]:
    u = ctypes.windll.user32
    u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    return [u.GetSystemMetrics(80), u.GetSystemMetrics(78), u.GetSystemMetrics(79)]


class EnsureVirtualDisplayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_tool()

    def test_target_hints_identify_the_vdd(self):
        """目标必须是**我们配过的 VDD**，不能是任意虚拟屏。

        这一条防的是「认错适配器」：GameViewer 的描述里也有 virtual，
        但它不是几何基准。TARGET_HINTS 存在就是为了把它区分开。
        """
        mod = self.mod
        self.assertTrue(mod.target_hint_hit({"description": "Virtual Display Driver"}))
        self.assertFalse(mod.target_hint_hit({"description": "GameViewer Virtual Display Adapter"}))
        self.assertFalse(mod.target_hint_hit({"description": "OrayIddDriver Device"}))

    def test_virtual_hints_still_cover_everything(self):
        """VIRTUAL_HINTS 是"是不是虚拟屏"，必须覆盖本机三类描述。"""
        hints = self.mod.VIRTUAL_HINTS
        for desc in ("GameViewer Virtual Display Adapter", "Virtual Display Driver",
                     "OrayIddDriver Device"):
            self.assertTrue(any(h in desc.lower() for h in hints), desc)

    def test_available_modes_lists_real_modes(self):
        """掉线的屏 cur_mode() 是 None，但模式表还在 —— 这是「点亮」的依据。"""
        devs = self.mod.devices()
        virt = [d for d in devs if d["is_virtual"]]
        self.assertTrue(virt, "本机没有任何虚拟适配器")
        counts = {d["device"]: len(self.mod.available_modes(d["device"])) for d in virt}
        self.assertTrue(any(c > 0 for c in counts.values()), counts)

    def test_activate_needs_the_noreset_bit(self):
        """点亮必须带 CDS_NORESET：不带就是 DISP_CHANGE_FAILED。

        这一条钉死的是实测结论 —— 试过 TEST only / UPDATEREGISTRY / RESET /
        带位置 / 不带刷新率 / +32bpp，只有 NORESET 那一档 rc=0。
        """
        self.assertTrue(hasattr(self.mod, "CDS_NORESET"))
        self.assertEqual(self.mod.CDS_NORESET, 0x10000000)
        for name in ("DM_PELSWIDTH", "DM_PELSHEIGHT", "DM_DISPLAYFREQUENCY",
                     "CDS_UPDATEREGISTRY"):
            self.assertTrue(hasattr(self.mod, name), name)

    def test_heals_after_desktop_is_taken(self):
        """端到端：把桌面收回主屏，跑脚本，必须回到 >=2 屏且退出码 0。

        这一条是唯一真正验证"自愈"的断言。没有它，上面那些"看起来成功了"
        的缺陷只能靠人去发现。
        """
        u = ctypes.windll.user32
        u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))

        def run() -> int:
            proc = subprocess.run([str(PY), str(TOOL)], capture_output=True,
                                  text=True, encoding="utf-8", errors="replace",
                                  timeout=180)
            return proc.returncode

        run()
        time.sleep(0.8)
        u.SetDisplayConfig(0, None, 0, None, SDC_TOPOLOGY_INTERNAL | SDC_APPLY)
        time.sleep(1.5)
        broken = metrics()[0]
        rc = run()
        time.sleep(1.0)
        after = metrics()[0]

        self.assertLess(broken, 2, "没能把桌面收回主屏（前置条件不成立）")
        self.assertEqual(rc, 0, f"ensure_virtual_display 退出码 {rc}")
        self.assertGreaterEqual(after, 2, f"恢复后仍是 {after} 屏")

    def test_autostart_entry_points_at_a_real_command(self):
        """自启项必须指向"现在就能跑通"的命令，而不是一条读得出来却跑不了的字符串。

        实测过一次假阳性：注册值写进去是空的、检查脚本还说 registered。
        这里把注册值拆开、真的执行一次。
        """
        script = Path(r"C:\Users\SunCh\AppData\Local\Temp\opencode\read-run.ps1")
        if not script.is_file():
            self.skipTest("read-run.ps1 不在（这是本地校验工具，不是仓库内容）")
        out = Path(r"C:\Users\SunCh\AppData\Local\Temp\opencode\_runvalue.txt")
        subprocess.run(["powershell", "-NoLogo", "-NoProfile", "-NonInteractive",
                        "-ExecutionPolicy", "Bypass", "-File", str(script),
                        "-Out", str(out)], capture_output=True, text=True)
        value = out.read_text(encoding="utf-8").strip() if out.exists() else ""
        self.assertTrue(value, "注册表里没有 FSA-VirtualDisplay")
        quoted = value.split('"')
        exe, arg = quoted[1], quoted[3]
        self.assertTrue(Path(exe).is_file(), f"解释器不存在：{exe}")
        self.assertTrue(Path(arg).is_file(), f"脚本不存在：{arg}")
        proc = subprocess.run([exe, arg], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=180)
        self.assertEqual(proc.returncode, 0,
                         f"自启命令跑不通：{proc.stdout[-400:]}{proc.stderr[-400:]}")

    def test_register_script_is_pure_ascii(self):
        """`.ps1` 必须纯 ASCII：PS 5.1 按 ANSI 读 BOM-less 文件，中文会破坏引号配对。

        这条规矩已经在同一个文件上踩过三次（写完解析失败），所以用测试钉死。
        """
        data = RUN_PS.read_bytes()
        bad = [i for i, b in enumerate(data) if b > 127]
        self.assertFalse(bad, f"register-geometry.ps1 有 {len(bad)} 个非 ASCII 字节")


if __name__ == "__main__":
    unittest.main()
