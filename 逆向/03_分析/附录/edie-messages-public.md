# 附录：`messages_public.json` 结构统计

被统计文件：`01_解包/app/Edie/messages_public.json`（7 234 808 字节）、
`01_解包/app/Edie/waasg-III_messages.json`（199 342 字节）。
统计方式：Python `json.load` 后遍历，脚本与全部计数见本章末「复算方法」。

> 本附录只描述**文件结构**。这两份 JSON 是 NovAtel OEM 消息**定义库**（供 Convert 的文件解析器
> `json_db_reader` 使用），**不是** `pimtpaddon.node` 的解码表；后者把同族定义编进了 `.rdata`
> （见 `03_分析/08_Edie原生解码层.md` §5.4、§9）。
>
> 与 `03_分析/00B_报文解析与消息目录.md` 的分工：那篇讲的是 **JS 侧**的
> `NovatelIdConstants`/`M6`/`M7` 消息目录（`model/*.js`，含周期/触发/校正类型）；本附录是
> **Edie 数据文件**里的定义表（含字节级字段布局 `dataType.length`），两者 ID 空间相同但字段粒度不同，
> 不能互相替代。

---

## 1 顶层结构

两份文件都是同一个三键对象：

```
{ "enums": [ ... ], "messages": [ ... ], "meta": { "subset": "all", "version": "0.3.0" } }
```

| 键 | 类型 | messages_public | waasg-III | 说明 |
|---|---|---|---|---|
| `meta` | object | `{"subset":"all","version":"0.3.0"}` | 同 | 生成器的过滤参数与库版本；两份完全一致 |
| `enums` | array | 240 项 / 4 069 个枚举值 | 12 项 | 每个 `{_id, name, enumerators[]}` |
| `messages` | array | 608 项 | 17 项 | 每个是一条消息（LOG/COMMAND）的完整定义 |

`meta` 无时间戳、无接收机型号字段 —— 型号差异体现在每条消息的 `path`/`accessString` 上。

---

## 2 `messages[]` 条目字段（15 个键，两份文件同构）

| 字段 | 类型 | 例 | 语义 / 复现要点 |
|---|---|---|---|
| `_id` | string(40 hex) | `b4ab6459…cfe2f` | 内容哈希，非消息 ID；不可当主键使用（608 条互不重复） |
| `name` | string | `PASSAUX` | 消息名，大写；与解码输出的 `MessageName` **不同族**（见 §7） |
| `messageID` | int | `690` | 数值 ID，1…2564，608 条唯一 |
| `messageType` | string / null | `LOG` / `COMMAND` | 3 种取值；4 条为 `null`（§6） |
| `messageStyle` | string / null | `OEM4_MESSAGE_STYLE` | 3 种取值（含 `OEM4_COMPRESSED_STYLE` 16 条） |
| `fields` | object | `{"61530":[ … ]}` | **键是定义 CRC（字符串），值是字段数组**；一个消息可有多个定义版本 |
| `latestMsgDefCrc` | string | `"61530"` | 当前生效定义 → 必然是 `fields` 的某个键 |
| `description` | string | `Port Aux - Pass -Through` | 人类可读说明（可空） |
| `accessString` | string | `ALL` | 授权/型号门控串，22 种取值 |
| `numSources` | int / null | `1` | 来源端口数上限（0/1/2/32/5/6，4 条 null） |
| `path` | string | `applications\\pwrpak7` | 定义来源目录（8 种取值，反斜杠未转义为 `/`） |
| `rateRestriction` | string / null | `NONE` | 输出速率约束，7 种取值 |
| `saveconfigable` | bool | `false` | 是否可进 SAVECONFIG（209 true / 399 false） |
| `hidden` | bool / null | `false` | UI 是否隐藏（48 true） |
| `throttled` | bool / null | `false` | 是否限流（3 true） |

### 2.1 `fields` 的三层结构

```
message.fields            object，键 = 定义 CRC 字符串
  └─ "61530"              array，该定义版本下的字段序列（顺序即报文顺序）
       └─ { … }           字段定义（下表 17 个键）
```

- 608 条消息共 **854 个定义版本**；**148 条**消息有 >1 个定义（例：`COMCONTROL` 431、`CANCONFIG` 884、
  `TUNNELESCAPE` 962 各有 2 个）。
- 定义版本数分布（字段个数 → 定义数）：0:4、1:190、2:137、3:59、4:77、5:53、6:52、7:27、8:32、9:19、10:14、11:12 …
- 字段总数 **5 875** 条；最大的消息是 `PDPXYZ`(471) 112 个字段，`BESTXYZ`(241)/`PDPPOS`(469)/`PPPPOS`(1538) 等 84 个字段。

### 2.2 字段定义（field）的 17 个键

| 键 | 类型 | 例 | 备注 |
|---|---|---|---|
| `name` | string | `baud_rate` | 小写下划线命名（与解码输出的大驼峰不同） |
| `type` | string | `SIMPLE` | 6 种，见表 3 |
| `dataType` | object | `{name:"CHAR", length:1, path:"subsystems\\platform", description}` | `length` 为**字节数**（1/2/4/8） |
| `conversionString` | string / null | `%7.9lk` | ASCII 侧格式串（81 种，936 条为 null） |
| `description` | string | `[Brief Description]` | 大量占位串 |
| `arrayLength` | int / null | `80` | 定长数组元素数；5 267 条为 null |
| `arrayLengthFieldSize` | int | `4` | 变长数组长度域的字节数 |
| `defaultValue` | number | `0` | |
| `minValue` / `maxValue` | number | `-128` / `127` | 值域 |
| `path` | string | `subsystems\\platform` | 定义来源 |
| `triggerType` | string / null | `ASYNCH` | 8 种触发语义（可 null） |
| `optionMask` / `optionState` | null / ? | `null` | 仅 9 个字段带 `optionMask` |

### 2.3 类型分布

`type`（5 875 条）：

| type | 条数 |
|---|---|
| SIMPLE | 4 376 |
| ENUM | 893 |
| FIXED_LENGTH_ARRAY | 367 |
| FIELD_ARRAY | 90 |
| STRING | 88 |
| VARIABLE_LENGTH_ARRAY | 61 |

`dataType.name`（前 16 种，共 16 种）：

| dataType | 条数 | 字节宽度 | 备注 |
|---|---|---|---|
| DOUBLE | 1 757 | 8 | |
| ENUM | 893 | 4 | 枚举在报文中占 4 字节（`length:4`） |
| UCHAR | 893 | 1 | |
| ULONG | 863 | 4 | |
| FLOAT | 828 | 4 | |
| LONG | 122 | 4 | |
| USHORT | 91 | 2 | |
| FieldArray | 90 | — | 嵌套字段数组（自身不再有宽度） |
| STRING | 88 | 变长 | |
| HEXBYTE | 58 | 变长 | |
| UINT | 41 | 4 | |
| BOOL | 32 | 4 | |
| INT | 32 | 4 | |
| SHORT | 18 | 2 | |
| CHAR | 65 | 1 | |
| LONGLONG | 4 | 8 | |

`triggerType`：None 3 555、ASYNCH 877、RESPONSE 510、COLLECTION 316、SYNCH 221、
COLLECTION_RESPONSE 181、STATIC 179、POLLED 36。

---

## 3 消息 ID 分布

范围 **1 … 2564**，608 条全部唯一（无重号）。

| 百位区间 | 条数 | 百位区间 | 条数 |
|---|---|---|---|
| 0–99 | 43 | 1400–1499 | 32 |
| 100–199 | 25 | 1500–1599 | 21 |
| 200–299 | 21 | 1600–1699 | 14 |
| 300–399 | 11 | 1700–1799 | 29 |
| 400–499 | 16 | 1800–1899 | 10 |
| 500–599 | 4 | 1900–1999 | 23 |
| 600–699 | 20 | 2000–2099 | 24 |
| 700–799 | 19 | 2100–2199 | 36 |
| 800–899 | 14 | 2200–2299 | 46 |
| 900–999 | 32 | 2300–2399 | 22 |
| 1000–1099 | 18 | 2400–2499 | 10 |
| 1100–1199 | 26 | 2500–2599 | 4 |
| 1200–1299 | 43 | | |
| 1300–1399 | 45 | | |

`messageType` 只 3 种：`COMMAND` 281、`LOG` 323、`null` 4。
`messageStyle`：`OEM4_MESSAGE_STYLE` 588、`OEM4_COMPRESSED_STYLE` 16、`null` 4。
交叉表：LOG×OEM4 = 307、COMMAND×OEM4 = 281、LOG×COMPRESSED = 16、null×null = 4。

`accessString` 22 种，前 8：`ALL` 348、`MFG` 64、`INS_RT` 61、`INS_BASIC` 37、
`LOW_END_POSITIONING` 18、`VARFMARK` 13、`RTK_RX` 10、`INTERFERENCE_MITIGATION` 9。
`path` 8 种：`subsystems\\algorithms` 163、`subsystems\\tracking` 159、`subsystems\\platform` 137、
`subsystems\\span` 106、`applications\\common` 22、`.` 14、`null` 4、`applications\\pwrpak7` 3。
`rateRestriction` 7 种：`NONE` 438、`POS` 92、`INS` 30、`ONLYASYNC` 29、`MSR` 11、`null` 4、`1HZ` 4。

---

## 4 `enums[]` 结构

每项 `{_id, name, enumerators:[{name, value, description}]}`，全部 240 项都有 `name`，
4 069 个枚举值都齐备 `name/value/description`。

最大的 8 个枚举：`PortAddress` 1 552、`AntennaModel` 265、`Responses` 234、`IMUType` 113、
`SignalType` 113、`NVM_DataType` 95、`Datum` 88、`ChanConfigSignal` 64。

字段里的 `dataType.name == "ENUM"` 时，枚举实体名在字段的 `description`/`path` 中而非单独字段 —
**没有外键指向 `enums[].name`**，重实现时必须按 `description` 文本或人工映射解析（这是本文件最不
自洽的一处）。

---

## 5 与 `waasg-III_messages.json` 的差异

| 维度 | messages_public.json | waasg-III_messages.json |
|---|---|---|
| `messages` 条数 | 608 | **17** |
| ID 范围 | 1 – 2564 | **570、571、4096 – 4110** |
| 与 public 的交集 | — | **0 个 ID 重合**（两套 ID 空间完全不相交） |
| `enums` | 240 项 / 4 069 值 | 12 项 |
| `messageType` | LOG/COMMAND/null | **全为 `LOG`** |
| `messageStyle` | OEM4_MESSAGE_STYLE 等 | **全部空串 `""`** |
| `accessString` / `path` | 22 / 8 种取值 | **全部空串** |
| `numSources` | 0/1/2/32/5/6 | **全部 `null`**（该键存在但值为 null） |
| 字段条目 | 5 875 | 55 |
| 字段 type | 6 种 | SIMPLE 33、FIELD_ARRAY 13、ENUM 7、FIXED_LENGTH_ARRAY 1、VARIABLE_LENGTH_ARRAY 1 |
| `triggerType` | 8 种 | `None` 35、`STATIC` 13、`""` 4、`ASYNCH` 3（出现空串） |
| 每消息定义版本 | 148 条有多个 | 全部 1 个 |

waasg-III 的 17 条消息：`RAWGPSSUBFRAMEWP`(570)、`RAWWAASFRAMEWP`(571)，以及 4096–4110 的
`AGCINFO`/`ALMANAC`/`CARDSTATUS`/`CORRDATA`/`CORRLOCATION`/`ETHSTATUS`/`FACTORYDATA`/
`MEASUREMENTDATA` 等 WAAS G-III 接收机专有日志。

选择逻辑（[观察] `01_解包/app/view/convert/cli.js:363-366`）：`--receiver-type` 为 `OEM` 用
messages_public.json，否则（G-III）用 waasg-III_messages.json；`convert.js:1457-1461` 同逻辑。

---

## 6 4 条 "无类型" 消息（`messageType:null`）

| messageID | name | 备注 |
|---|---|---|
| 2520 | `BDSBCNAV3RAWMESSAGE2` | 北斗 B-CNAV3 原始电文 |
| 2528 | `PROFILERESPONSE` | |
| 2537 | `RANGECMP5` | |
| 2564 | `GALHASRAWMT` | Galileo HAS 原始电文 |

这 4 条的 `messageStyle`/`hidden`/`throttled`/`path`/`accessString` 同为 `null`，`numSources` 也是 `null`，
`fields` 存在但只有 0–2 个字段。判定逻辑在 `01_解包/app/view/js/longhornStatusUI.js` 之外的
UI 列表生成处（未逐一核对，故只记录事实，不推断用途）。

---

## 7 关键负面结论：这份 JSON 与 Edie 解码输出**不是**同一套名字

- 解码器输出（`pimtpaddon.node`）的 `MessageName` 形如 `AUTOMOTIVE_CONFIGFILE`、`GPGGA`、`AUTOMOTIVE_RESET`；
- 本文件的消息名是 OEM 风格 `PASSAUX`、`RANGECMP5`、`BESTXYZ`；
- 实测解码出的 `MessageID` **2410（AUTOMOTIVE_RESET）、2388（AUTOMOTIVE_CONFIGFILE）、2390、2395
  在 messages_public.json 中均不存在**（查表为空）。

所以：**messages_public.json 不能用来验证/替代 `pimtpaddon.node` 的解码表**，它只服务 Convert
（`edie-node-wrappers.node` 的 `json_db_reader.cpp`，见该 DLL 内嵌源码路径）。Longhorn/automotive
族的定义被编译进 `pimtpaddon.node` 的 `.rdata`（66 条 `AUTOMOTIVE*` 名字串，含 `A`/`B`/`_1` 端口变体）。

---

## 8 前 40 条示例（按文件顺序）

| messageID | name | messageType | messageStyle | 定义版本 | 字段数 | 前 5 个字段名 |
|---|---|---|---|---|---|---|
| 690 | `PASSAUX` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | buffer |
| 2109 | `FILETRANSFER` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 2 | file_transfer_operation_enum,file_name |
| 2114 | `TRANSFERPORTSTATUS` | LOG | OEM4_MESSAGE_STYLE | 1 | 2 | usb_detection_type,usb_mode |
| 1 | `LOG` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 6 | log_port_address,message_id,trigger,on_time,offset |
| 3 | `INTERFACEMODE` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 4 | port,receive_interface_mode,transmit_interface_mode,responses |
| 4 | `COM` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 8 | port,baud_rate,parity,data_bits,stop_bits |
| 5 | `LOGLIST` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | log_list |
| 18 | `RESET` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 1 | delay |
| 19 | `SAVECONFIG` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 0 | — |
| 20 | `FRESET` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 1 | type |
| 22 | `MODEL` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 1 | model_name |
| 36 | `UNLOG` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 2 | log_port_address,message_id |
| 37 | `VERSION` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | versions |
| 38 | `UNLOGALL` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 2 | port,remove_held |
| 49 | `AUTH` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 8 | auth_state,auth_data1,auth_data2,auth_data3,auth_data4 |
| 72 | `PORTSTATS` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | port_statistics |
| 93 | `RXSTATUS` | LOG | OEM4_MESSAGE_STYLE | 1 | 2 | rx_error,status_words |
| 94 | `RXSTATUSEVENT` | LOG | OEM4_MESSAGE_STYLE | 1 | 4 | word,bit_position,event,description |
| 95 | `STATUSCONFIG` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 3 | type,word,mask |
| 98 | `ANTENNAPOWER` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 1 | antenna_power |
| 128 | `RXCONFIG` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | embedded_message_data |
| 2474 | `RXCONFIGUSER` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | embedded_message_data |
| 177 | `SEND` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 2 | port_address,text |
| 178 | `SENDHEX` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 2 | port_address,text |
| 197 | `NVMRESTORE` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 0 | — |
| 206 | `VALIDMODELS` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | models |
| 233 | `PASSCOM1` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | buffer |
| 234 | `PASSCOM2` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | buffer |
| 235 | `PASSCOM3` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | buffer |
| 317 | `COMCONFIG` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | com_config |
| 431 | `COMCONTROL` | COMMAND | OEM4_MESSAGE_STYLE | 2 | 6 | port,signal,control |
| 475 | `SOFTLOADCOMMIT` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 1 | src |
| 476 | `SOFTLOADRESET` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 1 | src |
| 477 | `SOFTLOADSREC` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 2 | srec,src |
| 607 | `PASSUSB1` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | buffer |
| 608 | `PASSUSB2` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | buffer |
| 609 | `PASSUSB3` | LOG | OEM4_MESSAGE_STYLE | 1 | 1 | buffer |
| 861 | `NMEATALKER` | COMMAND | OEM4_MESSAGE_STYLE | 1 | 1 | talker_id |
| 884 | `CANCONFIG` | COMMAND | OEM4_MESSAGE_STYLE | 2 | 10 | can_port,on_off,bitrate |
| 962 | `TUNNELESCAPE` | COMMAND | OEM4_MESSAGE_STYLE | 2 | 4 | enable,tunnel_escape |

（文件顺序不等于 ID 顺序：前 3 条是 690/2109/2114，第 4 条才是 1 —— 说明生成器按内部遍历序输出，
重实现若要逐字节复刻必须保留文件顺序而非排序。）

### 8.1 完整字段示例（`PASSAUX`，690）

```json
{"_id":"b4ab64…","accessString":"ALL","description":"Port Aux - Pass -Through",
 "fields":{"61530":[{"arrayLength":80,"arrayLengthFieldSize":4,"conversionString":"%P",
   "dataType":{"description":"[Brief Description]","length":1,"name":"CHAR","path":"subsystems\\platform"},
   "defaultValue":0,"description":"[Brief Description]","maxValue":127,"minValue":-128,
   "name":"buffer","optionMask":null,"optionState":null,"path":"subsystems\\platform",
   "triggerType":"ASYNCH","type":"VARIABLE_LENGTH_ARRAY"}]},
 "hidden":false,"latestMsgDefCrc":"61530","messageID":690,"messageStyle":"OEM4_MESSAGE_STYLE",
 "messageType":"LOG","name":"PASSAUX","numSources":1,"path":"applications\\pwrpak7",
 "rateRestriction":"NONE","saveconfigable":false,"throttled":false}
```

注意 `arrayLength:80` + `arrayLengthFieldSize:4` + `type:VARIABLE_LENGTH_ARRAY` 的组合：长度域先读 4 字节，
再读至多 80 个元素。重实现时 `arrayLength` 是**上限**，不是固定长度。

---

## 9 复算方法

```python
import json, collections
d = json.load(open(r"01_解包/app/Edie/messages_public.json", encoding="utf-8"))
msgs = d["messages"]                      # 608
ids  = [m["messageID"] for m in msgs]     # min 1 / max 2564 / unique 608
defs = sum(len(m["fields"] or {}) for m in msgs)                       # 854
fields = sum(len(a) for m in msgs for a in (m["fields"] or {}).values())  # 5875
types = collections.Counter(fd["type"] for m in msgs for a in (m["fields"] or {}).values() for fd in a)
```

以上四个数字（608 / 854 / 5 875 / min 1 / max 2564）可作为重实现的回归基线：
只要文件未变，任何实现都必须得到同样的计数。
