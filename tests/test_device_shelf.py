"""设备档案（device shelf）的单元测试。

被测对象：`packages/app/src/devices.ts`。

为什么要有这一组：多设备档案是覆盖矩阵里 `page.deviceManagement` 缺的那一半
（原文「多设备档案仍只有单 live 会话」）。档案写盘、按地址去重、删组时摘归属
这几条任何一条错了，插拔一次就会多一条僵尸档案，而 UI 上看不出来。

测试直接调用模块函数，不经过 HTTP：路由层只负责参数收敛，逻辑在这里。
仓库用 unittest（不是 pytest），所以这里按 unittest 写。
"""
import json
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APP = REPO / "逆向" / "04_重实现" / "packages" / "app"
DEVICES_DIR = APP / ".devices"

#: 用 Node 跑一小段 TS：本机 node ≥ 22，可以直接执行 .ts（类型擦除）。
_SCRIPT = r"""
import {
  addGroup, addProfile, addDeviceToGroup, deleteGroup, deleteProfile,
  listGroups, listProfiles, markUsed, removeDeviceFromGroup, updateProfile,
} from './src/devices.ts';

const out = {};
try {
  for (const p of listProfiles()) deleteProfile(p.key);
  for (const g of listGroups()) deleteGroup(g.key);

  const a = addProfile({ name: 'Baseline', address: 'COM10', baud: 115200, type: 'serial' });
  out.added = a.details.name;

  // 同地址重复添加 = 更新，不是新增
  const again = addProfile({ name: 'Renamed on re-plug', address: 'COM10', baud: 115200 });
  out.sameKey = again.key === a.key;
  out.countAfterReplug = listProfiles().length;

  // 只改名，baud 必须保留
  const p1 = updateProfile(a.key, { name: 'OnlyName' });
  out.baudKept = p1.details.baud === 115200;
  out.renamed = p1.details.name;

  // 分组：加入 / 移出 / 删组联动
  const g = addGroup('Roof');
  out.grouped = addDeviceToGroup(a.key, g.key).groups.includes(g.key);
  out.ungrouped = !removeDeviceFromGroup(a.key, g.key).groups.includes(g.key);
  addDeviceToGroup(a.key, g.key);
  deleteGroup(g.key);
  out.groupsClearedOnGroupDelete = listProfiles()[0].groups.length === 0;

  // markUsed 只是刷新时间戳，不新增
  const used = markUsed(a.key);
  out.markedUsed = used !== null && listProfiles().length === 1;

  // 删除
  out.deleted = deleteProfile(a.key);
  out.empty = listProfiles().length === 0;
} catch (e) {
  out.error = String(e && e.message || e);
}
console.log(JSON.stringify(out));
"""


class DeviceShelfTest(unittest.TestCase):
    """跑一次 Node 拿到全部结论，再逐条断言。"""

    @classmethod
    def setUpClass(cls):
        DEVICES_DIR.mkdir(parents=True, exist_ok=True)
        target = DEVICES_DIR / "devicesInfo.json"
        cls._backup = target.read_bytes() if target.exists() else None
        cls._target = target

        script = APP / ".devices-selftest.mjs"
        script.write_text(_SCRIPT, encoding="utf-8")
        try:
            proc = subprocess.run(
                ["node", str(script)], cwd=str(APP), capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=120,
            )
        finally:
            script.unlink(missing_ok=True)
            if cls._backup is not None:
                target.write_bytes(cls._backup)
            elif target.exists():
                target.unlink()
            # 只清理本次自己写出来的空目录；不递归删除（守卫禁止 rmtree，
            # 而这里本来也只需要一个 rmdir）。
            try:
                DEVICES_DIR.rmdir()
            except OSError:
                pass

        assert proc.returncode == 0, f"node 退出码 {proc.returncode}：{proc.stderr[-800:]}"
        lines = [ln for ln in (proc.stdout or "").splitlines() if ln.strip().startswith("{")]
        assert lines, f"没有拿到结论：{proc.stdout[-400:]} / {proc.stderr[-400:]}"
        cls.data = json.loads(lines[-1])
        assert "error" not in cls.data, cls.data["error"]

    def test_add_profile(self):
        self.assertEqual(self.data["added"], "Baseline")

    def test_same_address_updates_instead_of_duplicating(self):
        """插拔一次不能多出一条档案：同地址视为同一台设备。"""
        self.assertIs(self.data["sameKey"], True)
        self.assertEqual(self.data["countAfterReplug"], 1)

    def test_update_keeps_unsent_fields(self):
        """只改名时 baud 必须保留 —— 实测过 PATCH {"name":..} 把它抹成 null 的 bug。"""
        self.assertIs(self.data["baudKept"], True)
        self.assertEqual(self.data["renamed"], "OnlyName")

    def test_group_membership(self):
        self.assertIs(self.data["grouped"], True)
        self.assertIs(self.data["ungrouped"], True)

    def test_delete_group_clears_membership(self):
        """删组必须同时把设备上的归属摘掉，否则 UI 会留下指向不存在分组的引用。"""
        self.assertIs(self.data["groupsClearedOnGroupDelete"], True)

    def test_mark_used_does_not_duplicate(self):
        self.assertIs(self.data["markedUsed"], True)

    def test_delete_profile(self):
        self.assertIs(self.data["deleted"], True)
        self.assertIs(self.data["empty"], True)


if __name__ == "__main__":
    unittest.main()
