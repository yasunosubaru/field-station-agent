#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""造一个用于外壳验收的 `payload.zip`（400 个文件 / 约 1.8 MB）。

只做一件事：生成内容确定的 zip + `manifest.json`，让「首次解压 / 二次跳过」这条
幂等链可以在真机上跑，而不必依赖真实发布包（那份 100 MB 以上，不适合进验收）。

用法::

    python shell/electron/smoke/make-payload.py            # 默认 400 个
    python shell/electron/smoke/make-payload.py 50 out.zip # 自定义数量与路径

文件内容按序号确定（`smoke payload file N` 重复若干次），所以同一个 N 每次生成的
字节完全相同 —— 验收结论可复现，不依赖随机数。
"""

import json
import os
import sys
import zipfile

here = os.path.dirname(os.path.abspath(__file__))
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, "payload.zip")
count = int(sys.argv[1]) if len(sys.argv) > 1 else 400

entries = [
    ("src/fieldstation/smoke/f%04d.txt" % i,
     ("smoke payload file %d\n" % i).encode("utf-8") * (200 + i % 17))
    for i in range(count)
]
total = sum(len(body) for _name, body in entries)
manifest = {
    "schema": 1,
    "product": "All powered-FSA",
    "version": "0.2.0-smoke",
    "payload": {"files": len(entries), "bytes": total, "sha256_tree": "smoke"},
    "items": [{"name": "src/fieldstation", "files": len(entries), "bytes": total}],
}

os.makedirs(os.path.dirname(out), exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for name, body in entries:
        z.writestr(name, body)
    z.writestr("manifest.json",
               json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")

print("%s  %d files  %d bytes" % (out, len(entries), total))
