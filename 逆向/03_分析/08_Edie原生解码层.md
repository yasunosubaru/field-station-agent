# Edie 原生解码层

覆盖对象（本机 2.11.0 解包产物，只读）：

| 文件 | 大小 | 角色 |
|---|---|---|
| `01_解包/app/Edie/pimtpaddon.node` | 5 863 424 B | PIMTP / NMEA 解码 + PIMTP 组帧（N-API 插件） |
| `01_解包/app/Edie/windows/edie-node-wrappers.node` | 3 507 712 B | Convert 用文件解析 / RINEX 编码（node-addon-api，内嵌 NovAtel EDIE） |
| `01_解包/app/Edie/windows/configurationfile.node` | 139 264 B | 编译期凭证/端点提供者（**不是**配置文件读写器） |
| `01_解包/app/Edie/messages_public.json` | 7 234 808 B | OEM 消息定义库 608 条（Convert 用） |
| `01_解包/app/Edie/waasg-III_messages.json` | 199 342 B | WAAS G-III 消息定义库 17 条 |
| `01_解包/app/Edie/hatanaka/windows/rnx2crx.exe` | 280 544 B | Hatanaka 压缩外部工具（RNXCMP 4.0.8） |
| `01_解包/app/Edie/logger_config.toml` | 1 604 B | spdlog 配置（默认全关） |

证据类型说明：除 `文件:行号` 外，本子系统大量结论来自**二进制静态分析**（PE 导出表、`.rdata`
字符串、`napi_module` 结构、`capstone` 反汇编）与**运行时探针**（本机 Node 24.18.0 直接
`require()` 该插件，逐个方法调用并记录输出）。二进制证据用 `文件（导出表/napi_module/.rdata/地址）`
标注；运行时证据用 `实测` 标注，关键输出已内联在 §4 各表、§5.2、§5.6。

---

## 1. 职责

`pimtpaddon.node` 是 Longhorn/PIM222A 系列接收机在 2.11.0 里的**唯一解码通道**：串口/TCP 收到的原始字节先进
`inputstream_api`，再用两个互斥的解码器之一（PIMTP 或 NMEA）转成 JSON 字符串，交给 UI；
反向的配置读取/固件升级则用 `pimtpframer_api` 组出 PIMTP 帧写回接收机。

`[观察]` 模块自述（实测 `getedieversion()`）：

```
Name of the Library:		EDIE_Library
Build date of the Library:	Jan 25 2021
Build time of the Library:	11:11:21
Library version:		$NoTaggedVersion$
Description:			Library EDIE_Library - Version $NoTaggedVersion$
LOCAL
```

`[观察]` PE 时间戳 `Wed Jan 27 19:17:42 2021`；PDB 路径
`D:\Project\WebUI\EDIE Integration\Edie\build\Release\pimtpaddon.pdb`；
包装层源码路径 `d:\project\webui\edie integration\edie\lib\wrapper\main.cpp`
（`pimtpaddon.node` .rdata；`napi_module.nm_filename` 同值）。

`[观察]` 插件内嵌了整族 NovAtel 解码器 RTTI：
`.?AVStandardDecoder@@`、`.?AVAdvancedDecoder@@`、`.?AVPimtpUpdateDecoder@@`、
`.?AVPIMTPUpdateMessage@@`、`.?AVPIMTPGenerateMessage@@`、`.?AVautomotivedecoder@@`、
`.?AVInputStreamInterface@@`、`.?AVInputMemoryStream@@`、`.?AVInputFileStream@@`，
另有 `bestpos_7145`、`gprmc_5d81`、`insatt_5b35` 等上百个 SBF 消息解码类
（`pimtpaddon.node` .rdata 尾部 RTTI 段）。也就是说：**能力上它是一套完整 SBF 解码器**，
但 JS 侧只用到了 PIMTP/NMEA 两条路径。

`edie-node-wrappers.node` 是另一条线：它内嵌 NovAtel 开源 **EDIE** 库（`.rdata` 中留有
`C:\builds\inner-source\edie\nov-decoder\novatel-edie\src\decoders\common\src\json_db_reader.cpp`、
`message_decoder.cpp`、`novatel::edie::MessageDecoderBase::DecodeAscii/DecodeBinary/DecodeJson`
等符号），对外只导出 `convertfileobject_api`，服务 Convert 的日志文件解析与 RINEX 输出。

`configurationfile.node` `[观察]` 与"配置文件"无关：`configure` 类的 17 个 getter 全部返回
**编译期硬编码常量**（AWS key/secret、Google Maps key、Azure AD client id/secret、TerraStar
URL 模板、客户号 `UUABCDE`、`nas.support@hexagon.com`）。它被
`01_解包/app/controller/serverConnectV2.js:21-22` 当作 `configurationNode` 引入。

---

## 2. 入口与加载顺序

`[观察]` `01_解包/app/controller/communication.js:16`

```js
const Edie = (process.platform !== 'linux') ? require('../../Edie/pimtpaddon.node') : null;
```

Linux 下 `Edie` 恒为 `null`，所有调用点都套在 `process.platform !== 'linux'` 的同一条件里
（`:197`、`:293`、`:688`）。因此本子系统**只存在于 Windows 构建**。

加载与初始化顺序：

1. **连接建立**（串口 `open`）→ `communication.js:293-299`：为每个 tab 新建
   `inputstream_obj`（数据流）、`configstream_obj`（配置流）两个 `inputstream_api`，
   再分别构造 `pimtpdecoder_api(inputstream_obj)` 与 `nmealogdecoder_api(inputstream_obj)`。
   注意：**两个解码器共享同一个流对象**，靠 `rxtypeMap` 只启用其中一个。
   `[观察]` `:44-45`、`:298` 的 `standardlogdecoder_api` 已被注释掉（二进制里也没有这个导出，见 §4.6）。
2. **连接后立即取配置**（`:301-309`）：`getconfigfilelonghorn(tab)` + `requestlog(tab,"log versionb once")`，
   4 000 ms 后若仍未判定类型就把 `rxtypeMap[tab]` 置为 `"LonghornNoData"`。
3. **数据到达**（`:194-286`）：先做类型探测（`Append` + `getreceivertype`），再按类型选解码器，
   `Append` 后调 `readmessage`。
4. **配置流**（`:687-697`）：仅在 `getconfigfilelonghorn` 内使用，与数据流完全分离。

`[观察]` `pimtpaddon.node` 的 PE 装载细节：导出表只有 **1 个符号** `_register_pimtpaddon_`
（RVA `0x3c6380`，指向 `.rdata` 中的函数指针槽）；真正的注册靠 CRT 初始化器
`0x1800942b0`（`lea rcx,[napi_module]; jmp [__imp_napi_module_register]`），
`napi_module` 结构位于 `0x1805343e0`：

```
nm_version = 1
nm_flags   = 0
nm_filename= d:\project\webui\edie integration\edie\lib\wrapper\main.cpp
nm_register_func = 0x180094260
nm_modname = pimtpaddon
```

导入表：仅 `KERNEL32.dll`（常规）+ `node.exe` 的 45 个 `napi_*` 延时导入
（`napi_define_class`、`napi_get_cb_info`、`napi_create_string_utf8` …）。
由于模块通过 `napi_module_register` 自注册，Node 无需按名字查找
`napi_register_module_v1` —— 这与"导出表里没有 napi 注册符号"并不矛盾，是 `NAPI_MODULE` 宏的
正常形态。

---

## 3. 数据结构

### 3.1 `inputstream_api`（流）

| 项 | 值/形态 | 来源 |
|---|---|---|
| 构造 | `new inputstream_api()` → 内存流；`new inputstream_api(path)` → 文件流（`InputFileStream`） | 实测；`:549`、`:607` 传文件路径 |
| `Append(buf, len)` | 返回追加字节数（= len） | 实测 |
| `GetLength()` | 剩余未解码字节数；`readmessage` 后为 0；**文件流恒为 0** | 实测 |
| 内部缓冲 | 对 PIMTP 跨调用保留半帧；对 NMEA **不**保留半句 | 实测 §5.6 |

### 3.2 解码输出（`readmessage` 的 callback 参数）

一律是 **JSON 字符串**（不是对象），必须 `JSON.parse`（`[观察]` `communication.js:251`、`:692`）。
四种形态：

| 形态 | 例 | 何时出现 |
|---|---|---|
| 消息 | `{"MessageID":2388,"MessageName":"AUTOMOTIVE_CONFIGFILE","Data":[{…}]}` | 解出一条完整消息 |
| 空消息 | `{"MessageID":219,"MessageName":"GPGLL"}` | 句法识别成功但字段表为空（`GPGLL`、部分 `GPRMC`） |
| 错误 | `{"ERROR":"error"}` | 载荷非法（如 UPDATE 子类型不合法） |
| 流结束 | `{"EOS":1}` | **每次 `readmessage` 调用结束时**回调一次，即使前面已回调 N 条消息 |

`[观察]` 所有样本里 JSON 键都按**字典序**输出（`CompileData,CompileTime,ConfigFile,ConfigFileType,
FileName,PSN,version`；`Age_Of_Correction,AntennaAlt,EW,HDOP,Latitude,…`），说明 C++ 侧用
`std::map<std::string,…>` 序列化。逐字节复刻时键序必须一致。

### 3.3 各消息的字段表（实测，逐字段）

**2388 `AUTOMOTIVE_CONFIGFILE`**（PIMTP 载荷类型 1，payload[0..1] = msgid）

| 字段 | 类型 | 来源 |
|---|---|---|
| `CompileData` | string | 空串样本 |
| `CompileTime` | string | 同上 |
| `ConfigFile` | string | 配置文本（UI 按 `\n` 分行，见 §6.3） |
| `ConfigFileType` | string(enum 名) | 样本 `"NONE"` |
| `FileName` | string | |
| `PSN` | string | 接收机序列号（UI 侧映射到 `gnssSerialNumber`） |
| `version` | string | 小写键名，唯一例外的命名 |

**218 `GPGGA`**（NMEA）

| 字段 | 例值 | 类型 | 换算 |
|---|---|---|---|
| `NMEA_TRAKERID` | `"GP"` | string | `$` 后 2 字符 |
| `UTCHHMMSSss` | `123519.0` | double | 原始 `123519` → 数值，秒的小数被丢弃 |
| `Latitude` | `4807.038` | double | **double 保留原样**（无 float32 误差） |
| `Longitude` | `1131.0` | double | 数值化后前导 0 丢失（`01131.000` → `1131.0`） |
| `NS` | `78` | int | `'N'` 的 ASCII 码 |
| `EW` | `69` | int | `'E'` 的 ASCII 码 |
| `Quality` | `49` | int | `'1'` 的 ASCII 码（UI 用 `Quality-48` 还原，`longhornStatusUI.js:325`） |
| `Num_Of_Satellite` | `8` | int | |
| `HDOP` | `0.8999999761581421` | **float32** | `0.9f` 提升为 double 后的精确值 |
| `AntennaAlt` | `545.4000244140625` | float32 | `545.4f` |
| `Unit_Of_Antenna` | `77` | int | `'M'` |
| `Undulation` | `46.900001525878906` | float32 | `46.9f` |
| `Unit_Of_Undulation` | `77` | int | `'M'` |
| `Age_Of_Correction` | `""` | string | 空字段保留为空串 |
| `StnID` | `""` | string | |

算例：`0.9` 存 float32 后为 `0x3F666666` = 0.89999997615814208984375，序列化为
`0.8999999761581421`。**重实现必须用 `Math.fround` 才能逐字符一致**；而 `Latitude` 不能 fround。

**221 `GPGSA`**：`NMEA_TRAKERID`、`Mode_MA`(65='A')、`Mode_123`(3)、`PRN`(12 元素 int 数组，
空位补 0)、`PDOP` 2.5、`HDOP` 1.3、`VDOP` 2.1（三个 DOP 无 float32 误差 → 该句用 double）。

**227 `GPZDA`**：`Day` 4、`Month` 7、`Year` 2002、`UTCHHMMSSss` 201530.0、`Local_Zone` 0、
`Local_Zone_Min` 0。

**2390 `AUTOMOTIVE_UPDATE_STATUS_DATA`**（PIMTP 载荷类型 3）：
`ACK/NACK`、`ComponentType`、`MessageType`、`Reserved` 四个整数。

**2395 `AUTOMOTIVE_UPDATE_PROGRESS`**（载荷类型 3）：
`BytesProgrammed`(int)、`ComponentType`、`MessageType`、`Status`(enum 名，样本 `"COMPLETE"`)、`Reserved`。

**2389 `AUTOMOTIVE_IMU`**：`IMUStatus`、`XAccel`、`YAccel`、`ZAccel`、`YGyro`、`ZGyro`（全 double）。

**2410 `AUTOMOTIVE_RESET`**：无 `Data` 键（`{"MessageID":2410,"MessageName":"AUTOMOTIVE_RESET"}`）。

### 3.4 类型探测输出（`getreceivertype`）

```json
{"BytesProcessed":4,"InputStreamSize":44,"RecevierType":"PIMTP"}
```

| 字段 | 类型 | 语义 |
|---|---|---|
| `BytesProcessed` | int | 判定所消耗的字节数（PIMTP 4、OEM 3、NMEA 1） |
| `InputStreamSize` | int | 判定时流的长度 — 用一次判定即可推算分块边界 |
| `RecevierType` | string | `PIMTP` / `OEM` / `NMEA`（**拼写是 `Recevier`，不是 `Receiver`**） |

`[观察]` JS 侧拼写同样错（`communication.js:226`），匹配即可。

### 3.5 组帧输出（`getpimtpframe` / `getresetframe`）

```json
{"Data":{"ByteString":"ac55968303000000040000000205000073184b0e","FrameSize":20,"PayLoadType":3}}
```

| 字段 | 类型 | 语义 |
|---|---|---|
| `Data.ByteString` | string | 整帧十六进制，**小写**（`getresetframe` 例外：大写 `AC559683…`） |
| `Data.FrameSize` | int | 帧总字节数 = 16 + 载荷长度 |
| `Data.PayLoadType` | int | 载荷类型（与帧头第 4–7 字节一致） |

`[观察]` 大写/小写不一致是**实测事实**：`getpimtpframe` 输出 `ac559683…`，
`getresetframe` 输出 `AC559683…`。JS 侧用 `new Buffer.from(obj.Data.ByteString,"hex")`，
大小写不影响，但复刻测试向量时要一致。

---

## 4. 接口清单

### 4.1 模块顶层（`require('pimtpaddon.node')` 的 6 个键，实测）

```
getreceivertype, getedieversion, pimtpdecoder_api, pimtpframer_api, nmealogdecoder_api, inputstream_api
```

### 4.2 `inputstream_api`

| 方法 | 参数 | 返回 | 副作用 | 异常路径 |
|---|---|---|---|---|
| `constructor` | `()` 或 `(path:string)` | 实例 | 传路径则打开文件（只读） | — |
| `Append` | `(buffer:Buffer, byteLength:int)` | int 追加字节数 | 写入流缓冲 | **无参调用直接 abort 整个 Node 进程**（实测：`FATAL ERROR: Error::New napi_get_last_error_info`） |
| `GetLength` | `()` | int | — | — |

`[推断]` `Append` 的第二个参数是长度而非偏移：`communication.js:222,249` 传 `data.length`，
返回值等于该长度（实测 5→5、44→44）。

### 4.3 `pimtpdecoder_api` / `nmealogdecoder_api`

| 方法 | 参数 | 返回 | 回调 | 异常路径 |
|---|---|---|---|---|
| `constructor` | `(inputstream)` | 实例 | — | — |
| `readmessage` | `(inputstream, callback)` | `undefined` | 每条消息一次 JSON 字符串，结束时一次 `{"EOS":1}` | 参数不是对象/数量不对 → 二进制内含 `"object arguments expected"`、`"only two arguments expected"`、`"Expected a object"`、`"error in native read method"` 等串 |

`[观察]` 两个解码器共享同一流对象（`communication.js:296-297`），且**都**会清空流。

### 4.4 `pimtpframer_api`

| 方法 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `constructor` | `(inputstream, propertyObj)` | 实例 | `propertyObj = {PayLoadType, ComponentType, MessageType}` |
| `getpimtpframe` | `(callback)` | undefined | 回调组好的帧 JSON |
| `setpimtpframeproperty` | `(propertyObj)` | `undefined` | 改后续帧的组件/消息类型（升级流程用）；实测：`UPDATE_GET`→设成 `UPDATE_BEGIN` 后的下一帧立刻从 20 字节变 28 字节 |
| `uploaddone` | `()` | **boolean** | 文件流读完为 `true`；JS 用 `!= 1` 比较，`true != 1` 为 false，仍能正确退出 |
| `getpimtplastframe` | `()` | JSON 字符串 | 未产生过帧时抛 `Error("Error in native callback")` |
| `getresetframe` | `(callback)` | undefined | 复位帧（固定 44 字节，见 §5.2/§5.3） |

`[观察]` 构造参数里出现过的 `ComponentType`：`CNFG`、`MAIN`、`ME1`、`ME2`
（`lghn-deviceUpdate.js:524-528,553,610,638`）；`MessageType`：`UPDATE_GET`、`UPDATE_BEGIN`、
`UPDATE_DATA`。`PayLoadType` 恒为 `"UPDATE"`。

`[观察]` **合法组合很窄**：`{UPDATE, CNFG, UPDATE_GET}` 与 `{UPDATE, CNFG|MAIN, UPDATE_BEGIN}`
可用；`{UPDATE, MAIN|MEBOTH|COMPONENT_DEFAULT, UPDATE_GET}` 让进程直接崩
（实测 `EXIT=-1073741819`，访问冲突）。二进制里对应的枚举串在 `.rdata`：
`PayLoadType: NMEA / AUTOMOTIVE_PROTOCOL / CORRECTIONS / NOVATEL / UPDATE / UNKNOWN_DATA`，
`ComponentType: CNFG / MAIN / MEBOTH / COMPONENT_DEFAULT`，
`MessageType: UPDATE_BEGIN / UPDATE_DATA / UPDATE_GET / STATUS_PROGRESS / STATUS_DATA / MESSAGE_DEFAULT`，
后面紧跟 `No Matched payload Type / No Matched Component Type / No Matched Message Type / No Matched Property`
四句错误文本 —— 说明映射失败时走的是异常路径而非返回值。

### 4.5 `getreceivertype` / `getedieversion`（模块级）

| 函数 | 参数 | 返回 | 回调/异常 |
|---|---|---|---|
| `getreceivertype` | `(inputstream, callback)` | undefined | 判不出类型时**不回调**（实测 `"log ve"`、`"!"`、`00 01 02 03` 均无回调）；对**空流**调用会让进程非零退出（实测） |
| `getedieversion` | `()` | string | 无 |

### 4.6 不存在的接口（重要的负面结论）

`[观察]` `standardlogdecoder_api` 在 `pimtpaddon.node` 里**既没有导出也没有字符串**（导出表 1 项、
`.rdata` 全表搜索无命中）。所以 `communication.js:45,298` 的注释不是"暂时禁用"，而是
**该 API 从未存在**（至少在 2.11.0 的构建里）。运行时 `require()` 拿到的也只有 §4.1 的 6 个键（实测 `Object.keys`）。

### 4.7 `configurationfile.node`

```
new require('.../configurationfile.node').configure()
  .GetSecretAccessKey() .GetAccessKeyId() .GetMapSecretAccessKey() .GetIPAPIAccesskey()
  .GetDevMapSecretAccessKey() .getTerraStarSubscriptionInfo() .getTerraStarSubscriptionResend()
  .generateBarrierToken() .getcustomerNumber() .getocpApimSubscriptionKey()
  .getocpApimSubscriptionSecondaryKey() .getgenBarrierTknContentTyp() .getgenBarrTknGranType()
  .getgenBarrTknClientID() .getgenBarrTknClientScrt() .getUserName() .getBarrierTokenScope()
```

`[观察]` 全部 17 个方法无参、返回 `string`，值来自 `.rdata` 常量（PDB：
`C:\builds\hyd-tools\configurationfile\build\Release\configurationfile.pdb`）。
**没有任何读写文件的方法**，也没有文件路径串。所谓"Longhorn 配置文件"在 2.11.0 里
是**从设备取回的文本**（PIMTP 2388 `ConfigFile`），不是本地文件（§6.3）。

### 4.8 `edie-node-wrappers.node`

`[观察]` 导出只有 `convertfileobject_api`（原型：`Convert`、`readmessage`）。
`.rdata` 里另有 `filelistiterator_api`、`encoder_api`、`rinexencoder_api`、`kmlwriter_api` 的 RTTI，
但未导出（内部实现）。

| 方法 | 参数 | 回调 | 实测 |
|---|---|---|---|
| `readmessage` | `(fileObj, cb)` | `{"Filename":"nofile.log","Message":{}}` | JSON 字符串，每文件一次 |
| `Convert` | `(convertObj, cb)` | 每文件每格式一次，含 `Filename`/`Format`/`Percentage` | 见 `edieConvertAPI.js:31-41` 的消费方式 |

`convertObj` 形态见 `01_解包/app/view/convert/cli.js:219-235`（`logDefPath`、`configfilePath`、
`Logfiletype`、`outputPath`、`fileList{}`、`outputFormat{}`、`decimationFilter`、`isCLI`…）；
`readmessage` 的入参是 `{filelist:[路径…], JSONpath, configfilePath, Logfiletype}`
（`cli.js:405-410`，注意键名 `filelist` 小写、`JSONpath` 大写 JSON）。
`JSONpath` 指向 `messages_public.json` / `waasg-III_messages.json`，找不到时报
`{"JSON Database":"Not specified!"}`（实测）。

### 4.9 `rnx2crx.exe`（外部进程）

`[观察]` 自身 `-h` 输出（本机实测）：

```
Usage: rnx2crx.exe [file] [-] [-f] [-e # of epochs] [-s] [-d] [-h]
    stdin and stdout are used if input file name is not given.
    -f : force overwrite of output file
    -d : delete the input file if conversion finishes without errors
    exit code = 0 (success) / 1 (error) / 2 (warning)
    [version : ver.4.0.8]
```

`[观察]` 调用方是 `edie-node-wrappers.node`：其 `.rdata` 中有一段 **UTF-16** 常量
（偏移 `0x2edca2` 附近）：

```
"\hatanaka\windows\RNX2CRX.exe" -f "<输入文件>"
```

配合该 DLL 导入的 `CreateProcessW` 与紧邻的错误串
`Please check EXE/.O file path!`、`Invalid Hatanaka input Given!`（`.rdata`），
可确定命令行形态为 `"<插件目录>\..\hatanaka\windows\RNX2CRX.exe" -f "<file>"`，
即相对于 `Edie\windows\` 的兄弟目录 `Edie\hatanaka\windows\`（正是本机目录布局）。
`[推断]`（推理链）：路径片段以 `\hatanaka\…` 开头，缺父目录 → 运行时用
`GetModuleFileName` 取插件所在目录再拼接；`-f` 用于覆盖已存在的 `.crx`。

`[观察]` 全解包树里 **JS 层没有任何地方出现 `rnx2crx` 字样**（`01_解包` 全量二进制扫描，
仅命中 exe 自身与 wrapper 的 UTF-16 常量）。JS 侧只传布尔开关
`useHatanakaComp`（`cli.js:259`、`convert.js:882`），压缩完全在 wrapper 内完成。
因此对 Convert 而言，Hatanaka 只是一个**入参开关**，不是需要复刻的接口；
若要复刻 RINEX 压缩，直接调这个 exe 即可（`-f` + 输入文件，产物同名 `.crx`）。

---

## 5. 报文/协议细节

### 5.1 PIMTP 帧格式（实测 + 反汇编双重确认）

```
偏移  长度  含义
0     4     魔数 AC 55 96 83
4     4     u32 LE 载荷类型 PayLoadType（1 = automotive/NOVATEL 消息，3 = UPDATE）
8     4     u32 LE 载荷长度 N
12    N     载荷
12+N  4     u32 LE CRC32（覆盖帧内 0 … 12+N-1 全部字节）
总长 = 16 + N
```

CRC 定义：反射多项式 `0xEDB88320`、初值 `0`、**无终值异或**（与 NovAtel ASCII/二进制日志用的
CRC-32 同族，但少了 ISO-HDLC 的 init/xorout 反转）。反汇编证据：`pimtpaddon.node`
`0x1800f9890` 的安全检查之后是

```
test edx,edx / je done
loop: movzx ecx,[r9] ; lea r9,[r9+1] ; mov eax,r8d ; shr r8d,8
      xor rcx,rax ; movzx eax,cl ; xor r8d,[r10+rax*4] ; add edx,-1 ; jne loop
done: mov eax,r8d ; ret
```

即 `crc = (crc>>8) ^ table[(crc ^ byte) & 0xFF]`，表基址 `0x180531a10` 附近，初值由调用方传入（0）。

### 5.2 实测帧样本（可直接当回归向量）

| 场景 | 十六进制 | 长度 |
|---|---|---|
| `{UPDATE,CNFG,UPDATE_GET}` | `ac559683 03000000 04000000 02050000 73184b0e` | 20 |
| `{UPDATE,CNFG,UPDATE_BEGIN}`（空缓冲流） | `ac559683 03000000 0c000000 02010000 00000000 00000000 d9ec8b6f` | 28 |
| `{UPDATE,MAIN,UPDATE_BEGIN}`（300 B 文件流） | `ac559683 03000000 0c000000 01010000 2c010000 143a86d7 b09a5293` | 28 |
| `getresetframe()` | `ac559683 01000000 1c000000 6a090c00` + `00`×24 + `f44cc2e2` | 44 |

复算算例（第一行）：对 `ac559683030000000400000002050000` 求 CRC →
`0x0e4b1873`，小端存为 `73 18 4b 0e`，与帧尾一致。

四条向量的 CRC（均为"整帧去掉末 4 字节"求值，再小端写入）：

| 向量 | CRC 值 | 小端写入 | 帧尾 |
|---|---|---|---|
| UPDATE_GET(CNFG) | `0x0e4b1873` | `73 18 4b 0e` | ✓ |
| UPDATE_BEGIN(CNFG) | `0x6f8becd9` | `d9 ec 8b 6f` | ✓ |
| UPDATE_BEGIN(MAIN,300B) | `0x93529ab0` | `b0 9a 52 93` | ✓ |
| getresetframe | `0xe2c24cf4` | `f4 4c c2 e2` | ✓ |

### 5.3 载荷布局

**类型 1（automotive / NOVATEL 消息）**

```
0   2   u16 LE MessageID（2388 = CONFIGFILE，2389 = IMU，2410 = RESET …）
2   2   u16 LE 数据长度（样本 0x000C = 12；该字段是否真是长度见 §9-3）
4   …   数据
```

`[观察]` 用 28 字节载荷（msgid 2410、len 12、其余 0）解出 `AUTOMOTIVE_RESET`；
同样载荷换成 2388 解出 `AUTOMOTIVE_CONFIGFILE`。`getresetframe` 的 4 字节 `6A 09 0C 00`
正是 `msgid=2410, len=12`，其后 24 字节 0 → 说明复位帧就是"一条 automotive 消息装进 PIMTP 壳"。

**类型 3（UPDATE）**

```
0   1   ComponentType（1 = MAIN，2 = CNFG）
1   1   MessageType（1 = UPDATE_BEGIN，5 = UPDATE_GET，3/4 = 接收侧状态/进度）
2   4   （BEGIN 才有）u32 LE 文件长度，样本 0x0000012C = 300
6   4   （BEGIN 才有）u32 LE 校验值，样本 0xD7863A14 —— 语义未定，见 §9
10  …   数据
```

依据：`{UPDATE,CNFG,UPDATE_GET}` → 载荷 `02 05 00 00`（ComponentType 2 = CNFG、MessageType 5）；
`{UPDATE,CNFG,UPDATE_BEGIN}` → `02 01 00 00 | 00000000 | 00000000`；
`{UPDATE,MAIN,UPDATE_BEGIN}`（300 B 文件）→ `01 01 00 00 | 2C 01 00 00 | 14 3A 86 D7`。
反向验证：类型 3 载荷 `00 03 00 00 …` 解出 `{"MessageID":2390,…,"MessageType":3,"Reserved":0}`，
把载荷[2] 改成 1/2 时 `Reserved` 随之为 1/2 —— 故载荷[2] = `Reserved`。
`[推断]` 载荷[0] = `ComponentType`：组帧器在 `ComponentType:"CNFG"` 时把它填 2、`"MAIN"` 时填 1，
而解码侧载荷[0] 置 0 时输出 `ComponentType:0`，两向一致，但未找到直接读写该字节的反汇编。

**接收侧状态码**（解码器硬编码，`pimtpaddon.node` `0x1800f9657`）：

```
movzx eax, byte [rsp+0x21] ; cmp al,3 ; jne → cmp al,4 ; jne → 抛 "Invalid Update type received from RX!"
al==3 → 消息 ID 0x956 = 2390 (AUTOMOTIVE_UPDATE_STATUS_DATA)
al==4 → 消息 ID 0x95B = 2395 (AUTOMOTIVE_UPDATE_PROGRESS)
```

### 5.4 载荷类型 ≠ 枚举下标

`[观察]` `.rdata` 的枚举串顺序是 `NMEA, AUTOMOTIVE_PROTOCOL, CORRECTIONS, NOVATEL, UPDATE, UNKNOWN_DATA`，
但实测：载荷类型 **1 = automotive**（msgid 表解码）、**3 = UPDATE**。若按串顺序推，
UPDATE 应是 4 —— 所以**字符串顺序不能当枚举值**。实测 0/2/4 三种类型喂入合成帧都得不到任何
消息（只有 `{"EOS":1}`），其真实语义仍未定（§9）。

### 5.5 最小 JS 替代实现（已验证）

以下片段可完整替代 `pimtpframer_api.getpimtpframe` / `getresetframe` 的组帧能力，
并已对 §5.2 的四条向量逐字节比对通过：

```js
const POLY = 0xEDB88320, T = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (POLY & -(c & 1)); T[i] = c >>> 0; }
const crc = (b) => { let c = 0; for (const x of b) c = ((c >>> 8) ^ T[(c ^ x) & 0xff]) >>> 0; return c; };
function pimtpFrame(type, payload) {          // type: 1|3  payload: Buffer
  const h = Buffer.alloc(12);
  Buffer.from([0xac, 0x55, 0x96, 0x83]).copy(h, 0);
  h.writeUInt32LE(type, 4); h.writeUInt32LE(payload.length, 8);
  const body = Buffer.concat([h, payload]);
  const out = Buffer.alloc(body.length + 4);
  body.copy(out, 0); out.writeUInt32LE(crc(body), body.length);
  return out;
}
// UPDATE_GET(CNFG):  pimtpFrame(3, Buffer.from([2,5,0,0]))
// RESET:             pimtpFrame(1, Buffer.concat([Buffer.from([0x6a,0x09,0x0c,0x00]), Buffer.alloc(24)]))
```

**注意**：CRC 表必须用 `>>>`（无符号右移）。用 `>>` 会因 int32 符号扩展得到
`0xf8948b65`（错误答案），这是本次逆向中实际踩到的坑。
同一算法已在 `04_重实现/packages/protocol/src/crc.ts` 的 `novatelCrc32()` 中实现，可直接复用。

### 5.6 解码器行为矩阵（实测）

| 输入 | `pimtpdecoder_api` | `nmealogdecoder_api` |
|---|---|---|
| 一条完整 PIMTP 帧 | 1 条消息 + `{"EOS":1}` | 无（非 `$` 开头） |
| 同一 `Append` 里 2 帧 | 2 条消息 + **1 个** `{"EOS":1}` | — |
| 半帧 → 读 → 剩余半帧 → 读 | **仍能解出**（内部保留半帧） | — |
| 完整 NMEA 句（校验正确） | — | 1 条消息 + EOS |
| 同一 `Append` 里 2 句 | — | 2 条 + 1 个 EOS |
| 校验和错误 / 缺失 `*hh` | — | **静默丢弃**（只有 EOS） |
| 句子跨两次 `Append` | — | **丢弃**（不保留半句） |
| `$GPVTG…`（校验正确） | — | **进程崩溃**（`EXIT=-1073741819`，0xC0000005，实测） |
| `$GPGSV…` | — | 无输出（只有 EOS） |
| `$GPRMC…`（部分格式） | — | 只有 `{"MessageID":225,"MessageName":"GPRMC"}`，无 `Data` |
| 未知 PIMTP msgid | `{"MessageID":n,"MessageName":"UNKNOWN"}` | — |
| 类型 3 载荷[1] ∉ {3,4} | `{"ERROR":"error"}` + stderr `Invalid Update type received from RX!` | — |

`[观察]` `readmessage` 返回后 `GetLength()` 恒为 0 —— 流被清空，PIMTP 的半帧状态在解码器内部而非流内。

### 5.7 NMEA 校验和

`[观察]` 校验规则为 `$` 与 `*` 之间所有字符的 8 位异或（`$GPGGA,…M,,` → `0x47` → `*47` 才被接受）。
校验失败时**不报错、不回调**，句子被静默吞掉 —— 重实现若"宽容接受"会得到比原生更多的消息。

---

## 6. 状态机与事件流

### 6.1 接收机类型判定（`communication.js:197-255`）

```
数据到达
 ├─ rxtypeMap[tab] 不存在 → 建空值 + 起 3000 ms 计时器
 ├─ 若 rxtypeMap[tab]==""  → Append(data) → getreceivertype(stream, cb)
 │     PIMTP → 清除计时器；setIsLongHorn(true)；getconfigfilelonghorn；rxtypeMap="PIMTP"
 │     NMEA  → rxtemptypeMap="NMEA"（注意：只记临时值，不置 rxtypeMap）
 │     OEM   → 仅当 rxtemptypeMap != "NMEA" 时 rxtypeMap="OEM"
 ├─ 计时器到期仍非 PIMTP/NMEA → rxtypeMap = "LonghornNoData"（或 "None"），
 │     并主动 getconfigfilelonghorn(tab)  ([观察] 200-219)
 └─ 若 rxtypeMap ∈ {PIMTP, NMEA, LonghornNoData}
       → readerobj = (NMEA ? nmeadecoder : pimtpdecoder)
       → 可选本地写日志；Append(data)；readmessage(stream, cb → JSON.parse → UI)
```

`[推断]` 探测时 `Append` 的那份数据不会污染解码：`getreceivertype` 会把流清空
（实测 `InputStreamSize:44` 之后 `GetLength()==0`），所以 `:249` 再 Append 的是同一份
数据的**第二个副本**。如果重实现把"探测"做成非破坏性窥视，必须自己保证 `:249` 只 Append 一次。

### 6.2 消息消费（`longhornStatusUI.uiUpdate`，`01_解包/app/view/js/longhornStatusUI.js:266`）

`[观察]` UI 只按 `MessageID` 分派，不按 `MessageName`：

| MessageID | 用到的字段 | 行号 |
|---|---|---|
| 2388 | `Data[0].ConfigFile` | 273-275 |
| 226 | `Speed`、`TrueTrack` | 293-300 |
| 227 | `UTCHHMMSSss` | 301-315 |
| 218 | `Quality`、`Latitude`、`NS`、`Longitude`、`EW`、`AntennaAlt`、`UTCHHMMSSss` | 317-370 |
| 2353 | `MessageIdentifier`、`MessageNumber`、`MessageText`（文本协议，含 `txt_rxstatus`/`txt_solutioninfo` 等子类型） | 376-484 |
| 223 | 卫星数 | 485+ |

### 6.3 Longhorn 配置文件的生命周期

```
UI 需要配置 → controller.getconfigfilelonghorn(tab)          [687-697]
   → new pimtpframer_api(configstream,{UPDATE,CNFG,UPDATE_GET})
   → getpimtpframe → hex "ac55968303000000040000000205000073184b0e"
   → controller.requestlog(tab, buffer)   写进串口
接收机回 AUTOMOTIVE_CONFIGFILE(2388)
   → pimtpdecoder.readmessage → JSON
   → jarvisInterface.updateLongHornData → longhornStatusUI.uiUpdate [5879-5882]
   → lghnPositionConfig.configfiles[tab] = Data[0].ConfigFile  [275]
1 s 后按 \n 分行扫描：非 # 开头且含 "LogAutomotive"/"LogNMEA" → hasLogs
   若没有 → rxtypeMap[tab]="LonghornNoData"（判为"接了但没在出数据"）  [277-289]
```

`[观察]` 这说明 `ConfigFile` 是**行文本**（与 `#` 注释、`LogAutomotive`/`LogNMEA` 命令同样的语法），
不是 JSON/二进制。重实现只要能把 2388 的 `ConfigFile` 原样取出即可满足 UI。

### 6.4 固件升级时序（`01_解包/app/view/deviceUpdate/lghn-deviceUpdate.js`）

```
PIMTP 机型（rxtypeMap=="PIMTP"）           NMEA 机型（默认）
  startPIMTPUpdate(comp,"BEGIN")            startNMEAUpdate(comp)
   ├ inputstream_api(文件路径)               ├ MAIN: BEGIN → 帧 → 等 120 s
   ├ framer{UPDATE,comp,UPDATE_BEGIN}        └ ME1/ME2: BEGIN → 帧
   ├ getpimtpframe → 发帧（含文件长度）
   ├ setpimtpframeproperty({…,UPDATE_DATA})
   └ while (uploaddone() != 1) getpimtpframe → 发帧      [567-574]
收尾：handleResetCommand → getresetframe → 发 44 字节复位帧
      10 s 后重连；20 s 后按 versionB 是否收到判成功/失败   [474-508]
```

`[观察]` `getpimtpframe` 的回调是**同步调用**的（调用返回后收集数组里已有帧）。
`[推断]` 因此 `while (uploaddone() != 1)` 的同步忙等能正常把文件发完；复刻时必须同样保持
"取帧 + 回调同步、不跨 tick"，否则这段忙等会变成死循环。

### 6.5 复位流程（`deviceRestart.js:141-152`）

与升级共用 `pimtpframer_api`：构造 `{UPDATE,CNFG,UPDATE_BEGIN}` 后**不调 `getpimtpframe`
而调 `getresetframe`**，说明复位帧与 UPDATE_BEGIN 共用同一份属性对象，但输出的是固定的
`AC559683 01…` 帧（载荷 6A090C00 + 24×00）。

---

## 7. 与其它子系统的耦合点

| 子系统 | 耦合方式 | 位置 |
|---|---|---|
| 连接/串口管理 | 每个 tab 两个 `inputstream` + 两个解码器 + 一个 framer | `communication.js:294-299,690` |
| 数据分发 | `readmessage` 回调 → `jarvisInterface.updateLongHornData` | `communication.js:252`、`jarvisInterface.js:5879` |
| Longhorn UI | 按 MessageID 分派字段 | `view/js/longhornStatusUI.js:266+` |
| 位置/配置缓存 | `lghnPositionConfig.configfiles[tab]`、`writeDataToLogging` | `communication.js:246-247`、`longhornStatusUI.js:275` |
| 终端控制台 | 原始字节旁路显示 | `communication.js:254` |
| 升级/复位 | framer 的 BEGIN/DATA/reset 三条路径 | `lghn-deviceUpdate.js:474-660`、`deviceRestart.js:141-152` |
| 特性开关 | `featuresList.setIsLongHorn/getIsLongHorn` | `communication.js:204,214,228,242-243` |
| CRC 工具 | `jarvisInterface.calculateCRC` + `crcTable`（同一算法的纯 JS 版） | `jarvisInterface.js:2`、`5905-5932` |
| Convert（CLI/UI） | 子进程 `node.exe edieConvertAPI.js` → `edie-node-wrappers.node` | `convert.js:9-11,3382-3393`；`cli.js:10-11,405-410` |
| 凭证/端点 | `configurationfile.node` 17 个常量 getter | `serverConnect.js:11-18`、`serverConnectV2.js:21-22` |
| 重实现 crate | `novatelCrc32()` 与本层帧 CRC 完全同构 | `04_重实现/packages/protocol/src/crc.ts:12-31` |

---

## 8. 复现清单

`R1` 仅在 `process.platform !== 'linux'` 时加载 `pimtpaddon.node`；Linux 分支必须完全不触碰
该模块（`Edie=null`），否则 `null.inputstream_api` 立刻抛错。 `[观察] 01_解包/app/controller/communication.js:16,197,293,688`

`R2` 每个连接 tab 必须建 **2 个独立流**（数据流 + 配置流）和 **4 个对象**
（`inputstream_api`×2、`pimtpdecoder_api`、`nmealogdecoder_api`），两个解码器共享数据流对象。
`[观察] 01_解包/app/controller/communication.js:294-299`

`R3` `Append` 必须传 `(Buffer, byteLength)` 两个参数；少参会让整个进程 abort（不是抛 JS 异常）。
`[观察] 实测 pimtpaddon.node`

`R4` `Append` 返回追加字节数，`GetLength()` 在 `readmessage` 之后恒为 0。
`[观察] 实测 pimtpaddon.node`

`R5` 类型探测消耗流：`getreceivertype` 之后流长度归零，所以同一份数据要在 `:249` 二次 Append
才能被解码器看到。 `[观察] 实测 + 01_解包/app/controller/communication.js:222,249`

`R6` `getreceivertype` 判 PIMTP 需要 ≥4 字节且魔数精确为 `AC 55 96 83`；`BytesProcessed` 固定回 4。
`[观察] 实测：AC/AC55/AC5596 无回调，AC559683 回调 PIMTP`

`R7` `getreceivertype` 判 OEM 只需前 2 字节 `AA 44`（第 3 字节任意）且 ≥3 字节，`BytesProcessed`=3。
`[观察] 实测：aa4412 与 aa4413 都判 OEM`

`R8` `getreceivertype` 判 NMEA 只需首字节 `'$'(0x24)`，1 字节即可，`BytesProcessed`=1；
非 `$` 开头的 ASCII（如 `log ve`、`GET`）**不回调**。 `[观察] 实测`

`R9` 判不出类型时不得假设为 NMEA：`communication.js` 在 3 000 ms 后落到 `LonghornNoData`
并主动取配置。 `[观察] 01_解包/app/controller/communication.js:198-219`

`R10` 解码器选择规则固定为 `rxtypeMap=="NMEA" ? nmealogdecoder : pimtpdecoder`；`PIMTP`、
`LonghornNoData`、`OEM` 都走 PIMTP 解码器。 `[观察] 01_解包/app/controller/communication.js:245`

`R11` 回调参数一律是 JSON **字符串**；每次 `readmessage` 结束必定再回调一次 `{"EOS":1}`，
即使前面已回调 N 条消息，且同一次调用内只发一个 EOS。 `[观察] 实测两帧一次调用 → 2 消息 + 1 EOS`

`R12` 消费方必须忽略未知键（`EOS`、`ERROR`），不能假设每条回调都有 `MessageID`。
`[观察] 01_解包/app/view/js/longhornStatusUI.js:266-273`（直接读 `data.MessageID`，EOS 情况下为 undefined）

`R13` PIMTP 解码器跨调用保留半帧（分两次 Append 仍能解出）；NMEA 解码器**不**保留半句
（跨块被截断的句子永久丢失）。 `[观察] 实测`

`R14` NMEA 校验和（`$`…`*` 之间字符的 8 位异或）不匹配或缺省时，句子被静默丢弃、不报错。
`[观察] 实测 *00 与无 * 两种都被吞`

`R15` NMEA 字符型字段以 ASCII 码整数返回（`NS=78`、`EW=69`、`Quality=49`、`Unit_Of_Antenna=77`），
复刻时必须输出码值而不是字符。 `[观察] 实测 + 01_解包/app/view/js/longhornStatusUI.js:325`

`R16` NMEA 数值字段精度分裂：`HDOP/AntennaAlt/Undulation` 是 **float32**（0.9→0.8999999761581421），
`Latitude/Longitude/PDOP/HDOP(GSA)` 是 double。复刻要用 `Math.fround` 且**逐字段**决定。
`[观察] 实测 GGA/GSA`

`R17` 所有解码 JSON 的键按字典序输出，`Data` 是数组（每消息一个对象）。
`[观察] 实测全部样本`

`R18` 未知 PIMTP 消息 ID 输出 `{"MessageID":n,"MessageName":"UNKNOWN"}`，不得丢弃该帧。
`[观察] 实测 msgid 2380-2387`

`R19` PIMTP 帧总长必须等于 `16 + payloadLen`；`FrameSize` 字段与实际字节数一致，`ByteString`
为整帧十六进制。 `[观察] 实测 20/28/44 三个样本`

`R20` 帧 CRC = 反射多项式 `0xEDB88320`、初值 0、无终值异或，覆盖 `[0, 12+N)`，小端写在帧尾。
`[观察] 实测三条向量 + 反汇编 0x1800f9890`

`R21` 组帧的 `ComponentType` 字节：`MAIN`→1、`CNFG`→2；`MessageType`：`UPDATE_BEGIN`→1、
`UPDATE_DATA`→2、`UPDATE_GET`→5。 `[观察] 实测三条帧样本`

`R22` `UPDATE_GET` 载荷只有 4 字节（`[ComponentType, 5, 0, 0]`）；`UPDATE_BEGIN` 载荷 12 字节，
额外带 u32 文件长度（样本 300 → `2C 01 00 00`）与 u32 校验值。 `[观察] 实测`

`R23` 组帧器只接受"已映射"的属性组合；`{UPDATE, MAIN|MEBOTH|COMPONENT_DEFAULT, UPDATE_GET}`
会让进程访问冲突退出（`0xC0000005`），实现时必须白名单而不是尽力映射。 `[观察] 实测 + .rdata 的
"No Matched Component Type" 等错误串`

`R24` `getpimtplastframe()` 在从未组帧时抛 `Error("Error in native callback")`；
实现应返回"上一次成功组帧的结果"，无历史时抛同名错误。 `[观察] 实测`

`R25` `uploaddone()` 返回布尔值，且"流已读完"为 `true`；与 `!= 1` 比较在 JS 里成立
（`true != 1` === false）。 `[观察] 实测 + 01_解包/app/view/deviceUpdate/lghn-deviceUpdate.js:567`

`R26` 文件流（`inputstream_api(path)`）的 `GetLength()` 恒为 0，且对它 `Append` 会崩；
文件流只能喂给 framer，不能喂给解码器。 `[观察] 实测`

`R27` 复位帧固定 44 字节：`AC559683 01000000 1C000000` + `6A090C00` + 24×`00` + `F44CC2E2`，
且 `ByteString` 用**大写**十六进制。 `[观察] 实测 getresetframe`

`R28` `configurationfile.node` 不得用于读取本地配置文件：17 个 getter 全是编译期常量、无文件 IO。
若要"Longhorn 配置读写"，正确路径是 PIMTP 2388 的 `ConfigFile` 文本。
`[观察] 实测 17 个返回值 + configurationfile.node .rdata 无路径串`

`R29` Convert 侧子进程契约：`node.exe <app>/view/convert/edieConvertAPI.js <objJson> <apiName> <progressFile>`，
进度以 JSON 写回 `%APPDATA%\NovAtelApplicationSuite\convertProgress.txt`。
`[观察] 01_解包/app/view/convert/convert.js:9-11,23-32,3382-3393`

`R30` `edie-node-wrappers.readmessage` 的入参键名是 `filelist`（小写）/`JSONpath`（大写 JSON）/
`configfilePath`/`Logfiletype`；回调 `{Filename, Message}`；`JSONpath` 不存在时回调
`{"JSON Database":"Not specified!"}`。 `[观察] 01_解包/app/view/convert/cli.js:405-410 + 实测`

`R31` Hatanaka 压缩由 `edie-node-wrappers.node` 以
`"<插件目录>\..\hatanaka\windows\RNX2CRX.exe" -f "<file>"` 调外部进程完成；
JS 层只传 `useHatanakaComp` 布尔值。 `[观察] wrapper .rdata UTF-16 常量 + CreateProcessW 导入 +
01_解包/app/view/convert/cli.js:259`

`R32` `logger_config.toml` 把 console sink 的 level 设为 `off`，但 PIMTP 解码器仍会往 stderr
打印 `Invalid Update type received from RX!` 这类诊断 —— 该输出不受 toml 控制（不同日志系统），
复刻时可丢弃但必须知道原生有。 `[观察] 01_解包/app/Edie/logger_config.toml:29-32 + 实测 stderr`

`R33` 不要"恢复" `standardlogdecoder_api`：它在 2.11.0 的 `pimtpaddon.node` 中不存在
（导出表 1 项、无同名串）。SBF 解码能力只存在于 DLL 内部，未经 JS 暴露。
`[观察] pimtpaddon.node 导出表 + 全字符串扫描 + 运行时 Object.keys`

`R34` `readmessage` / `getpimtpframe` / `getresetframe` 的回调都是**同步**调用的：原生方法返回前
回调已执行完毕（实测：调用返回后收集数组已非空）。复刻时不得改成 `setImmediate`/`Promise`，
否则 `lghn-deviceUpdate.js:567-574` 的同步忙等会死循环。
`[观察] 实测 + 01_解包/app/view/deviceUpdate/lghn-deviceUpdate.js:567-574`

`R35` 每条消息的 `MessageID → MessageName` 映射必须来自原生表而不是 `messages_public.json`：
2388/2390/2395/2410 在该 JSON 里均查不到（JSON 只服务 Convert）。
`[观察] 实测 + 03_分析/附录/edie-messages-public.md §7`

---

## 9. 未解之处

1. **UPDATE 载荷第 6–9 字节的语义。** 300 字节全 `X` 的文件得到 `0xD7863A14`；
   该值既不等于 `crc32(init=0)`（`0x9C4088EB`），也不等于 zlib CRC（`0x29740739`）、
   32 位字和（`0xE1E1E1C8`）或字节和（`0x6720`）。
   缺什么证据：需要一份真实固件升级抓包，或反汇编 `PIMTPGenerateMessage` 的 BEGIN 分支。
2. **载荷类型 0/2/4/5 的实际语义。** 用合成帧（NMEA 文本、SBF BESTPOS、零字节）喂入
   `pimtpdecoder_api` 只得到 `{"EOS":1}`；`[推断]` 它们对应 `.rdata` 里的
   `NMEA/AUTOMOTIVE_PROTOCOL/CORRECTIONS/NOVATEL/UNKNOWN_DATA` 中的其余几个，但编码顺序未定。
   缺什么证据：真实 PIMTP 流量样本（尤其 RTCM 修正数据）。
3. **`getresetframe` 载荷 `6A 09 0C 00` 的 `0C`（12）是不是长度。** 我按"msgid+len"解释并成功解出
   `AUTOMOTIVE_RESET`，但 12 后面的 24 字节全 0，无法区分"12 是长度"与"恰好是数据首字段"。
   缺什么证据：`automotive` 解码器对 RESET 的字段表（二进制内未找到可读名称）。
4. **Update 协议状态机全貌。** `.rdata` 有 `"Invalid parsing state in pimtp update decoder"`、
   `"Failed to instantiate PIMTP UPDATE parser"`，说明是显式状态机；我只覆盖了 BEGIN/GET/STATUS_DATA/
   PROGRESS 四个点。缺什么证据：反汇编 `PimtpUpdateDecoder`（类 RTTI 已定位但未逐函数读）。
5. **`AUTOMOTIVE_*` 消息 ID 全表。** 已知 2388/2389/2390/2395/2410；2390 之后的连续 ID
   （主循环在 2390 处直接崩，无法继续扫）。缺什么证据：从 `.rdata` 的消息名字表 + ID 表反推，
   需要解析该表的二进制布局（名字串旁即有 5 个变体后缀 `A/B/_1/A_1`，像是 4 端口 × 2 槽位）。
6. **`edie-node-wrappers.node` 的 `Convert` 完整输出 schema。** 只验证了 `readmessage` 的回调
   `{Filename, Message}`；`Convert` 需要真实日志文件才能触发，本轮无样本。
   缺什么证据：任一 NovAtel `.log`/`.gps` 文件 + `outputFormat` 配置。
7. **`bytesProcessed` 之外的流对齐行为。** `getreceivertype` 清空流意味着"探测即消费"；
   若真实设备首包只有 2–3 字节（如 `AA 44`），JS 会丢弃这些字节后再也拼不回 SBF 头 —— 但
   实际链路未观察到该情形，缺证据证明这是否是活 bug。
8. **`pimtpaddon.node` 里那套 SBF 解码器能否被间接调用。** RTTI 显示 `StandardDecoder`/
   `AdvancedDecoder` 齐全，但没有导出；是否曾通过 `standardlogdecoder_api` 暴露过（1.x 版本？）
   需要旧版本二进制对比。

---

## 10. 外部参考

| 主题 | 来源 | 说明 |
|---|---|---|
| NovAtel 32-bit CRC（`0xEDB88320`、初值 0、无终值异或） | `00_来源/手册文本/OEM7-Commands-and-Logs-Reference-Manual.txt:2933-2960`（§1.10 "32-bit CRC"） | 与本文 §5.1 实测的 PIMTP 帧 CRC 完全同构；`04_重实现/packages/protocol/src/crc.ts` 也用同一节做基准 |
| PIMTP 的用途（把 RTCMV3 包进 PIMTP 外壳） | `00_来源/手册文本/NovAtel-Application-Suite-1.15-Legacy-User-Manual.txt:3743-3746`（§2.5.6.1 RTK，"Enable PIMTP wrapper"） | 1.15 手册仅一句描述；2.11.0 手册未提 PIMTP 帧格式，**帧格式在本项目之外无公开文档** |
| NovAtel EDIE 开源库（`json_db_reader`、`message_decoder`、`MessageDecoderBase`） | `edie-node-wrappers.node` 内嵌源码路径 `C:\builds\inner-source\edie\nov-decoder\novatel-edie\src\decoders\common\src\*.cpp` 与符号名 | 上游为 NovAtel 公开的 EDIE（github.com/NovAtel/EDIE）；本机未取该仓库，只按二进制里的路径/符号记录 |
| RNXCMP / RNX2CRX 4.0.8 命令行 | `rnx2crx.exe -h` 本机输出 | `-h` 文本提到配套解压工具 `CRX2RNX(ver. 4.0 or after)`，即 RNXCMP 工具族；本项目只用到 `-f` |
| spdlog 配置语法（`[[sink]]`/`[[logger]]`/level） | `01_解包/app/Edie/logger_config.toml:1-53` 自带注释（指向 spdlog wiki） | Edie 库用 spdlog，默认全关 |
| OEM7 日志格式（SBF 头、ASCII 头、CRC 位置） | `00_来源/手册文本/OEM7-Commands-and-Logs-Reference-Manual.txt`（Chapter 1/§1.10） | 本层未直接使用，但 `pimtpaddon.node` 内嵌的 SBF 解码器遵循它 |

> 说明：PIMTP 帧结构（魔数 `AC 55 96 83`、类型/长度字段、CRC 位置）在现有手册中**查不到**，
> 本文的字节级结论全部来自实测向量 + 反汇编，不引用任何外部推测。
