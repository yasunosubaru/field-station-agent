*本文件登记从其他项目复制来的代码。表格为空表示本仓库尚无搬运件。*

| 源仓库 | 源路径 | commit | 复制日期 | 改动 | 新位置 |
|---|---|---|---|---|---|
| GNSS接收机TEC反演 | `gnsstec/constants.py` | 5d1937b | 2026-10-13 | 无（逐字节复制，SHA256 与源文件一致；该模块只 import `math`） | `src/fieldstation/constants.py` |
| GNSS接收机TEC反演 | `gnsstec/schema.py` | 5d1937b | 2026-10-13 | 文件名 `schema.py` → `model.py`；`from .constants import MISSING` **未改**（两文件同为包根，相对 import 仍成立）。逐字节复制，SHA256 与源文件一致 | `src/fieldstation/model.py` |
