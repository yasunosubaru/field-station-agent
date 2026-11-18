# 套件字段对照表（A 原版 × B 重实现）

> 本文件由 `tools/suite_field_parity.py` 从源码生成，**请勿手工编辑**。
> 重新生成：`python tools/suite_field_parity.py`　
> 只校验：`python tools/suite_field_parity.py --check`

## 结论（这就是 EV-30 要的数字）

两个口径都报。**判分看的是「去重字段」那一列**：

| 指标 | 去重字段（判分口径） | DOM 元素（逐行口径） |
| --- | --- | --- |
| 总数 | **126**（契约要求 ≥ 60） | 146 |
| `matched` | 77 | 90 |
| `b_only` | 29 | 31 |
| `a_only` | 5 | 10 |
| `unverified`（A 侧未核对，不计入差异） | 0 | 0 |
| `not_applicable`（问卷控件，不计入差异） | 15 | 15 |
| **`mismatches`**（`b_only + a_only`） | **34**（契约要求 0） | 41 |

「去重字段」= 不同 (页面, 命名空间, 归一化字段名) 的个数；「DOM 元素」= 表的行数。两者差 20 个，是同一字段的多个控件（radio / checkbox 的各个取值、以及原版自己重复写了两遍的同名控件）被合并的结果。

**EV-30 未达成**：`mismatches = 34 > 0`。下面「B 独占」「A 独占」两节逐条列出，不做口径调整。

## 口径

- **范围**：`tools/gui_coverage_map.json` 里 `disposition` 为 `covered` / `partial` 的条目（本机 36 条）。`not_applicable` / `a_only` 本来就没有 B 侧，算成差异会把「明确不做」误报成「漏做」，所以排除，并在此声明。
- **A 侧**：`逆向/01_解包/app/view/**` 里的 `<input|select|textarea>`，外加 A 侧用 `<button>` 承载的**状态控件**（原版用 CSS 给按钮画开关外观，如 `<button id="erase-nvm" class="erase-checkbox">`、`<button id="rtk-on-off" class="select-device-btn">`）。只收 class 命中开关/下拉白名单的按钮，`Apply` / `Cancel` / `Add` 这类动作按钮不算字段。字段标识取 `name`（优先）或 `id`，显示名取 `data-lang-*` 经 `languageSupport/en.js` 翻译。**A 侧只读，一个字节都没改。**
- **B 侧**：两套实现。① `packages/app/src/web/panels/*.js|*.html` 的`data-el` / `data-term` / `data-adddev` / `data-cfg` / `data-reset` 等分组绑定；② `packages/view/src/config/*.ts`，它们不写 HTML，而是 `fragmentPath` 指向原版片段，由 `config-host.ts` 的 `fragments.load()` 从 `<appRoot>/view` 读入。
- **配对上的一条硬规则**：若 B 文件声明的 `fragmentPath` 与 A 文件名相同，则该页渲染的就是那份原版 HTML（同一份 DOM），逐字段判 `matched`，方法记 `fragment`，B 侧位置写 `fragmentPath` 所在行。这不是「推定相似」，是同一份文件。
- **配对**：其余页面在同一条目内按归一化键名配对（小写、去掉非字母数字，故 `startDate` ≡ `start-date`）。
- **HTML 注释里的控件不计入**：注释中的 markup 浏览器不渲染，算成字段会制造假差异（A 侧实测有 12 个控件躺在注释里，如 `satelliteTracking.html` 的整段排序单选组）。

### 为什么计数单位是「去重字段」而不是「DOM 元素」

- 一个 radio / checkbox 组是**一个字段**，它的每个取值各是一个 `<input>`。`cv-affix` 的 `PREFIX` 与 `SUFFIX` 是两个元素、一个字段；按元素计数会把这个字段算两遍，`mismatches` 随之虚高——「补一个选项」和「补一个字段」是两件不同的事，EV-30 判的是后者。
- 所以**总数与 `mismatches` 都按 (页面, 命名空间, 归一化字段名) 去重**；同一字段只要在某一侧存在（哪怕 3 个 radio）就算 1 个。
- **命名空间必须进去重键**：`manage.js` 的终端对话框用 `data-term="path"`、加设备对话框用 `data-adddev="path"`，同名却是两个字段。只有 A 侧且无命名空间差异时，这一维度等同于无。
- **页面取 A 侧文件名主干，不取目录名**：`app/view/html/` 一个目录装着`index.html`（外壳）、`setUpMonitor.html`（Manage 台）、`welcome.html`。按目录都叫 `html` 会把外壳与 Manage 台的连接对话框错并成一个字段。
- 但**表里仍然逐元素保留每一行**，因为「具体哪个取值缺失」只能靠行去看；去重后每个字段的代表行取该组里证据最强的那个元素（`matched` > `unverified` > `b_only` / `a_only`），并保留它的 `文件:行号`，随时可回溯。
- 本机两个数字：**去重字段 126 个 / DOM 元素 146 个**（合并 20 个）。
- **A 侧是否核对过**：是。`逆向/01_解包/app/view/` 在本机存在，所有 A 位置都是真实行号。

## 对照表

**一行 = 一个 DOM 元素，不等于一个字段**：同一字段的多个控件（radio / checkbox 的各个取值）各占一行，因此本表行数多于结论区的「去重字段数」。

`结论` 取值：`matched` 两侧都有；`b_only` 只有 B 有（差异）；`a_only` 只有 A 有（差异，意味着 B 漏了）；`unverified` A 侧未核对。

| 字段 | 页面 | B 侧位置 | A 侧位置 | 结论 |
| --- | --- | --- | --- | --- |
| convertFileUploadInput（Browse your files） | convert | — | `逆向/01_解包/app/view/convert/convert.html:103` | a_only |
| cv-affix（This will be added to the output file name(s)） | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:435` | `逆向/01_解包/app/view/convert/convert.html:367` | matched |
| cv-affix（This will be added to the output file name(s)） | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:439` | `逆向/01_解包/app/view/convert/convert.html:367` | matched |
| cv-dest | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:411` | — | b_only |
| cv-dest | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:415` | — | b_only |
| cv-unknown | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:395` | — | b_only |
| cv-unknown | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:399` | — | b_only |
| destination | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:419` | `逆向/01_解包/app/view/convert/convert.html:354` | matched |
| end-date（:） | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:353` | `逆向/01_解包/app/view/convert/convert.html:215` | matched |
| end-hh | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:355` | `逆向/01_解包/app/view/convert/convert.html:216` | matched |
| end-mm（:） | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:358` | `逆向/01_解包/app/view/convert/convert.html:218` | matched |
| end-ss（:） | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:361` | `逆向/01_解包/app/view/convert/convert.html:220` | matched |
| prefix | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:429` | — | b_only |
| sample-rate | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:383` | — | b_only |
| start-date | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:338` | `逆向/01_解包/app/view/convert/convert.html:194` | matched |
| start-hh | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:340` | `逆向/01_解包/app/view/convert/convert.html:196` | matched |
| start-mm（:） | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:343` | `逆向/01_解包/app/view/convert/convert.html:199` | matched |
| start-ss（:） | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:346` | `逆向/01_解包/app/view/convert/convert.html:202` | matched |
| suffix-option（Prefix） | convert | — | `逆向/01_解包/app/view/convert/convert.html:374` | a_only |
| InputAuthCode（Apply New Auth Code） | deviceDetails | `逆向/04_重实现/packages/view/src/config/deviceDetails.ts:100` | `逆向/01_解包/app/view/deviceDetails/deviceDetails.html:258` | matched |
| select-unselect-logs（Download） | deviceExport | `逆向/04_重实现/packages/view/src/config/deviceExport.ts:41` | `逆向/01_解包/app/view/deviceExport/deviceExport.html:37` | matched |
| connection-on-off（PIM222A receiver） | deviceManagement | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2053` | `逆向/01_解包/app/view/deviceManagement/deviceManagement.js:1050` | matched |
| connection-on-off（Connect） | deviceManagement | — | `逆向/01_解包/app/view/deviceManagement/deviceManagement.js:1749` | a_only |
| erase-nvm（Restart） | deviceRestart | `逆向/04_重实现/packages/view/src/config/deviceRestart.ts:25` | `逆向/01_解包/app/view/deviceRestart/deviceRestart.html:15` | matched |
| gnss-elevation-mask-value（Elevation Mask） | gnssConfig | `逆向/04_重实现/packages/view/src/config/gnssConfig.ts:29` | `逆向/01_解包/app/view/gnssConfig/gnssConfig.html:10` | matched |
| frequency（Frequency） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:3718` | — | b_only |
| lat（Latitude） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:785` | `逆向/01_解包/app/view/GRIT/positionOverview/addPOIDialog.js:281` | matched |
| lon（Longitude） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:787` | `逆向/01_解包/app/view/GRIT/positionOverview/addPOIDialog.js:285` | matched |
| mode（Mode） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:3717` | — | b_only |
| name（Name） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:783` | `逆向/01_解包/app/view/GRIT/positionOverview/addPOIDialog.js:268` | matched |
| notification（Notification） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:791` | — | b_only |
| radius（Radius (m)） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:789` | `逆向/01_解包/app/view/GRIT/positionOverview/addPOIDialog.js:272` | matched |
| resolution（Spectrum Resolution (K)） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:3720` | `逆向/01_解包/app/view/GRIT/spectrumViewer/spectrumViewer.html:86` | matched |
| sensitivity（Detection Sensitivity (bins)） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:3722` | `逆向/01_解包/app/view/GRIT/spectrumViewer/spectrumViewer.html:108` | matched |
| termBaud（Baud） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:882` | — | b_only |
| termHost（or TCP） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:884` | — | b_only |
| termLine（&gt;） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:893` | — | b_only |
| termPath（Serial） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:880` | — | b_only |
| termPort（Port） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:886` | — | b_only |
| tileInput（Tile URL） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:853` | — | b_only |
| timeAverage（Time Averaging (s)） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:3721` | `逆向/01_解包/app/view/GRIT/spectrumViewer/spectrumViewer.html:101` | matched |
| updateRate（Update Rate (s)） | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:3719` | `逆向/01_解包/app/view/GRIT/spectrumViewer/spectrumViewer.html:79` | matched |
| capture-select（抓包） | index | `逆向/04_重实现/packages/app/src/web/index.html:105` | — | b_only |
| CS2IP（Exceeds expectations） | index | — | `逆向/01_解包/app/view/html/index.html:729` | not_applicable |
| CS3IP（Very easy） | index | — | `逆向/01_解包/app/view/html/index.html:745` | not_applicable |
| CS4IP（Other） | index | — | `逆向/01_解包/app/view/html/index.html:786` | not_applicable |
| fileUploadInput（Browse） | index | — | `逆向/01_解包/app/view/html/index.html:355` | a_only |
| GS2IP（Exceeds expectations） | index | — | `逆向/01_解包/app/view/html/index.html:813` | not_applicable |
| GS3IP（Very easy） | index | — | `逆向/01_解包/app/view/html/index.html:829` | not_applicable |
| GS4IP（Other） | index | — | `逆向/01_解包/app/view/html/index.html:870` | not_applicable |
| PL2IP（Exceeds expectations） | index | — | `逆向/01_解包/app/view/html/index.html:645` | not_applicable |
| PL3IP（Very easy） | index | — | `逆向/01_解包/app/view/html/index.html:661` | not_applicable |
| PL4IP（Other） | index | — | `逆向/01_解包/app/view/html/index.html:702` | not_applicable |
| SM2IP（Exceeds expectations） | index | — | `逆向/01_解包/app/view/html/index.html:560` | not_applicable |
| SM3IP（Very easy） | index | — | `逆向/01_解包/app/view/html/index.html:576` | not_applicable |
| SM4IP（Other） | index | — | `逆向/01_解包/app/view/html/index.html:617` | not_applicable |
| VS2IP（Exceeds expectations） | index | — | `逆向/01_解包/app/view/html/index.html:897` | not_applicable |
| VS3IP（Very easy） | index | — | `逆向/01_解包/app/view/html/index.html:913` | not_applicable |
| VS4IP（Other） | index | — | `逆向/01_解包/app/view/html/index.html:954` | not_applicable |
| flipaxis-slider（Flip Axis） | interferenceToolKit | `逆向/04_重实现/packages/view/src/config/interferenceToolkit.ts:695` | `逆向/01_解包/app/view/interferenceToolKit/interferenceToolKit.html:241` | matched |
| hdr-slider（Enable HDR Mode） | interferenceToolKit | `逆向/04_重实现/packages/view/src/config/interferenceToolkit.ts:695` | `逆向/01_解包/app/view/interferenceToolKit/interferenceToolKit.html:30` | matched |
| itdetectconfig-on-off（Interference Toolkit） | interferenceToolKit | `逆向/04_重实现/packages/view/src/config/interferenceToolkit.ts:695` | `逆向/01_解包/app/view/interferenceToolKit/interferenceToolKit.html:124` | matched |
| select-fft（Spectrum Resolution (K)） | interferenceToolKit | `逆向/04_重实现/packages/view/src/config/interferenceToolkit.ts:695` | `逆向/01_解包/app/view/interferenceToolKit/interferenceToolKit.html:91` | matched |
| showhistory-slider（Show History） | interferenceToolKit | `逆向/04_重实现/packages/view/src/config/interferenceToolkit.ts:695` | `逆向/01_解包/app/view/interferenceToolKit/interferenceToolKit.html:220` | matched |
| spin-psdInterval（Update Rate (Secs)） | interferenceToolKit | `逆向/04_重实现/packages/view/src/config/interferenceToolkit.ts:695` | `逆向/01_解包/app/view/interferenceToolKit/interferenceToolKit.html:87` | matched |
| spin-subcarrieravg（Detection Sensitivity (Bins)） | interferenceToolKit | `逆向/04_重实现/packages/view/src/config/interferenceToolkit.ts:695` | `逆向/01_解包/app/view/interferenceToolKit/interferenceToolKit.html:111` | matched |
| spin-timeavg（Time Averaging (Secs)） | interferenceToolKit | `逆向/04_重实现/packages/view/src/config/interferenceToolkit.ts:695` | `逆向/01_解包/app/view/interferenceToolKit/interferenceToolKit.html:104` | matched |
| beidoulog_prefix（BeiDou Log Prefix） | loggingConfig | `逆向/04_重实现/packages/view/src/config/loggingConfig.ts:43` | `逆向/01_解包/app/view/loggingConfig/loggingConfig.html:220` | matched |
| beidoulog_prefix | loggingConfig | `逆向/04_重实现/packages/view/src/config/loggingConfig.ts:43` | `逆向/01_解包/app/view/loggingConfig/loggingConfig.html:228` | matched |
| LocalFile（Onboard Storage） | loggingConfig | `逆向/04_重实现/packages/view/src/config/loggingConfig.ts:43` | `逆向/01_解包/app/view/loggingConfig/loggingConfig.html:35` | matched |
| logging-file-name-value（File Name） | loggingConfig | `逆向/04_重实现/packages/view/src/config/loggingConfig.ts:43` | `逆向/01_解包/app/view/loggingConfig/loggingConfig.html:50` | matched |
| logging-file-name-value（File Name） | loggingConfig | `逆向/04_重实现/packages/view/src/config/loggingConfig.ts:43` | `逆向/01_解包/app/view/loggingConfig/loggingConfig.html:72` | matched |
| logging-file-name-value（File Name） | loggingConfig | `逆向/04_重实现/packages/view/src/config/loggingConfig.ts:43` | `逆向/01_解包/app/view/loggingConfig/loggingConfig.html:91` | matched |
| msg-txt-inputlogging（Custom Messages） | loggingConfig | `逆向/04_重实现/packages/view/src/config/loggingConfig.ts:43` | `逆向/01_解包/app/view/loggingConfig/loggingConfig.html:120` | matched |
| nmealog_prefix（NMEA Log Prefix） | loggingConfig | `逆向/04_重实现/packages/view/src/config/loggingConfig.ts:43` | `逆向/01_解包/app/view/loggingConfig/loggingConfig.html:200` | matched |
| nmealog_prefix | loggingConfig | `逆向/04_重实现/packages/view/src/config/loggingConfig.ts:43` | `逆向/01_解包/app/view/loggingConfig/loggingConfig.html:208` | matched |
| Onboard（Destination） | loggingConfig | `逆向/04_重实现/packages/view/src/config/loggingConfig.ts:43` | `逆向/01_解包/app/view/loggingConfig/loggingConfig.html:28` | matched |
| dhcp-on-off（DHCP） | networkingSettings | `逆向/04_重实现/packages/view/src/config/networkingSettings.ts:141` | `逆向/01_解包/app/view/networkingSettings/networkingSettings.html:49` | matched |
| network-channel（Channel） | networkingSettings | `逆向/04_重实现/packages/view/src/config/networkingSettings.ts:141` | `逆向/01_解包/app/view/networkingSettings/networkingSettings.html:124` | matched |
| wifi-hotspot-on-off（Wi-Fi Hotspot） | networkingSettings | `逆向/04_重实现/packages/view/src/config/networkingSettings.ts:141` | `逆向/01_解包/app/view/networkingSettings/networkingSettings.html:104` | matched |
| wifi-on-off（Wi-Fi） | networkingSettings | `逆向/04_重实现/packages/view/src/config/networkingSettings.ts:141` | `逆向/01_解包/app/view/networkingSettings/networkingSettings.html:19` | matched |
| wifiPassword（Password） | networkingSettings | `逆向/04_重实现/packages/view/src/config/networkingSettings.ts:141` | `逆向/01_解包/app/view/networkingSettings/networkingSettings.html:207` | matched |
| from（From (s)） | playbackcontrol | `逆向/04_重实现/packages/app/src/web/panels/playback.js:807` | — | b_only |
| showEvents（0:00.000） | playbackcontrol | `逆向/04_重实现/packages/app/src/web/panels/playback.js:798` | — | b_only |
| speed（0:00.000） | playbackcontrol | `逆向/04_重实现/packages/app/src/web/panels/playback.js:796` | — | b_only |
| to（To (s)） | playbackcontrol | `逆向/04_重实现/packages/app/src/web/panels/playback.js:810` | — | b_only |
| accuracy（Accuracy (Meters)） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:257` | matched |
| base-antenna-on-off | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:400` | matched |
| base-phase-centre-on-off（Phase Centre Variation） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:425` | matched |
| baseantennaType-btn（Antenna Type） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:411` | matched |
| gpsl1-east（East） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:442` | matched |
| gpsl1-east（East） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:549` | matched |
| gpsl1-north（North） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:449` | matched |
| gpsl1-north（North） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:556` | matched |
| gpsl1-up（Up） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:456` | matched |
| gpsl1-up（Up） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:563` | matched |
| gpsl2-east（East） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:466` | matched |
| gpsl2-east（East） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:573` | matched |
| gpsl2-north（North） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:473` | matched |
| gpsl2-north（North） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:580` | matched |
| gpsl2-up（Up） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:480` | matched |
| gpsl2-up（Up） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:587` | matched |
| height（Height (MSL) (Meters)） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:276` | matched |
| latitude（Latitude） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:266` | matched |
| longitude（Longitude） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:270` | matched |
| ppp-on-off（Input Ports） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:137` | matched |
| rover-antenna-on-off | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:507` | matched |
| rover-phase-centre-on-off（Phase Centre Variation） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:532` | matched |
| roverantennaType-btn（Antenna Type） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:518` | matched |
| rtk-on-off（Input Ports） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:67` | matched |
| sbas-on-off（Region Selection） | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:178` | matched |
| survey-time | positionConfig | `逆向/04_重实现/packages/view/src/config/positionConfig.ts:125` | `逆向/01_解包/app/view/positionConfig/positionConfig.html:251` | matched |
| elevation-greaterthan-90（Elevation 0&deg;&lt;90&deg;） | satelliteTracking | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1905` | `逆向/01_解包/app/view/satelliteTracking/satelliteTracking.html:75` | matched |
| elevation-lessthan-90（PRN） | satelliteTracking | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1901` | `逆向/01_解包/app/view/satelliteTracking/satelliteTracking.html:70` | matched |
| elevationMask（Show） | satelliteTracking | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1912` | `逆向/01_解包/app/view/satelliteTracking/satelliteTracking.html:91` | matched |
| highLowValues（Elevation Mask） | satelliteTracking | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1916` | `逆向/01_解包/app/view/satelliteTracking/satelliteTracking.html:97` | matched |
| trackingprn（Sort by） | satelliteTracking | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1897` | `逆向/01_解包/app/view/satelliteTracking/satelliteTracking.html:66` | matched |
| baud（Baud） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1988` | — | b_only |
| baud（Baud） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2032` | — | b_only |
| baudrate-selected（Baud rate (selected)） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2063` | `逆向/01_解包/app/view/html/setUpMonitor.html:1723` | matched |
| connection-on-off（Connected） | setUpMonitor | — | `逆向/01_解包/app/view/html/setUpMonitor.html:1856` | a_only |
| connectionName（Connection name） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2023` | `逆向/01_解包/app/view/html/setUpMonitor.html:1130` | matched |
| connectionName | setUpMonitor | — | `逆向/01_解包/app/view/html/setUpMonitor.html:1666` | a_only |
| eraseNvm（Type the receiver model to confirm） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2155` | — | b_only |
| file（Choose a .cfg） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2123` | — | b_only |
| groupName（Group name） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2026` | `逆向/01_解包/app/view/html/setUpMonitor.html:2052` | matched |
| handshake-on-off（Passive） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2047` | `逆向/01_解包/app/view/html/setUpMonitor.html:1189` | matched |
| handshake-on-off | setUpMonitor | — | `逆向/01_解包/app/view/html/setUpMonitor.html:1743` | a_only |
| ipAddress（or TCP） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1990` | `逆向/01_解包/app/view/html/setUpMonitor.html:1146` | matched |
| ipAddress（TCP / UDP host） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2034` | `逆向/01_解包/app/view/html/setUpMonitor.html:1688` | matched |
| line（&gt;） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1999` | — | b_only |
| page（Page） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2092` | — | b_only |
| passive-on-off（Port） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2044` | `逆向/01_解包/app/view/html/setUpMonitor.html:1186` | matched |
| passive-on-off | setUpMonitor | — | `逆向/01_解包/app/view/html/setUpMonitor.html:1739` | a_only |
| path（Serial） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1986` | — | b_only |
| path（Serial port） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2029` | — | b_only |
| pim222aRx-on-off（Hardware handshake） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2050` | `逆向/01_解包/app/view/html/setUpMonitor.html:1195` | matched |
| pim222aRx-on-off | setUpMonitor | — | `逆向/01_解包/app/view/html/setUpMonitor.html:1747` | a_only |
| portName（Port） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1992` | `逆向/01_解包/app/view/html/setUpMonitor.html:1151` | matched |
| portName（Port） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2037` | `逆向/01_解包/app/view/html/setUpMonitor.html:1693` | matched |
| ports-selected（Port (selected)） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2061` | `逆向/01_解包/app/view/html/setUpMonitor.html:1712` | matched |
| shelfGroupName | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1939` | — | b_only |
| text（Choose a .cfg） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2125` | — | b_only |
| typed（Type the receiver model to confirm） | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2152` | — | b_only |
| usb-ports-selected | setUpMonitor | — | `逆向/01_解包/app/view/html/setUpMonitor.html:1758` | a_only |
| terminal-input-box（Terminal） | terminalConsole | `逆向/04_重实现/packages/view/src/config/terminalConsole.ts:40` | `逆向/01_解包/app/view/terminalConsole/terminalConsole.html:21` | matched |

## B 独占字段（B 有、A 没有 → 差异）

去重后 29 个字段，展开 31 个 DOM 元素。这些名字在原版里找不到同名对应，要么是 B 新增的，要么是 B 改了键名而没在这里登记。

| 字段 | 页面 | B 侧位置 |
| --- | --- | --- |
| cv-dest | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:411` |
| cv-dest | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:415` |
| cv-unknown | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:395` |
| cv-unknown | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:399` |
| prefix | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:429` |
| sample-rate | convert | `逆向/04_重实现/packages/app/src/web/panels/convert.js:383` |
| frequency | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:3718` |
| mode | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:3717` |
| notification | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:791` |
| termBaud | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:882` |
| termHost | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:884` |
| termLine | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:893` |
| termPath | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:880` |
| termPort | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:886` |
| tileInput | gritJarvisInterface | `逆向/04_重实现/packages/app/src/web/panels/grit.js:853` |
| capture-select | index | `逆向/04_重实现/packages/app/src/web/index.html:105` |
| from | playbackcontrol | `逆向/04_重实现/packages/app/src/web/panels/playback.js:807` |
| showEvents | playbackcontrol | `逆向/04_重实现/packages/app/src/web/panels/playback.js:798` |
| speed | playbackcontrol | `逆向/04_重实现/packages/app/src/web/panels/playback.js:796` |
| to | playbackcontrol | `逆向/04_重实现/packages/app/src/web/panels/playback.js:810` |
| baud | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1988` |
| baud | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2032` |
| eraseNvm | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2155` |
| file | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2123` |
| line | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1999` |
| page | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2092` |
| path | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1986` |
| path | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2029` |
| shelfGroupName | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:1939` |
| text | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2125` |
| typed | setUpMonitor | `逆向/04_重实现/packages/app/src/web/panels/manage.js:2152` |

## A 独占字段（A 有、B 没有 → 差异）

去重后 5 个字段，展开 10 个 DOM 元素。这些是原版有、B 侧没对上的字段。注意其中一部分所在页面由 A 侧自己用 JS 动态拼装，静态抽取会漏，所以这一列是**上界**，不是精确的缺口清单。

| 字段 | 页面 | A 侧位置 |
| --- | --- | --- |
| convertFileUploadInput | convert | `逆向/01_解包/app/view/convert/convert.html:103` |
| suffix-option | convert | `逆向/01_解包/app/view/convert/convert.html:374` |
| connection-on-off | deviceManagement | `逆向/01_解包/app/view/deviceManagement/deviceManagement.js:1749` |
| fileUploadInput | index | `逆向/01_解包/app/view/html/index.html:355` |
| connection-on-off | setUpMonitor | `逆向/01_解包/app/view/html/setUpMonitor.html:1856` |
| connectionName | setUpMonitor | `逆向/01_解包/app/view/html/setUpMonitor.html:1666` |
| handshake-on-off | setUpMonitor | `逆向/01_解包/app/view/html/setUpMonitor.html:1743` |
| passive-on-off | setUpMonitor | `逆向/01_解包/app/view/html/setUpMonitor.html:1739` |
| pim222aRx-on-off | setUpMonitor | `逆向/01_解包/app/view/html/setUpMonitor.html:1747` |
| usb-ports-selected | setUpMonitor | `逆向/01_解包/app/view/html/setUpMonitor.html:1758` |

## 收口依据：别名与问卷
### 同一字段两种键名（别名，10 个）

这些不是 B 多做的字段，是同一字段两侧键名不同。登记后判 `matched`，方法记 `alias`。**每条都能在两侧源码里查到那个键名**（`tests/test_suite_field_alias.py` 钉死），不是凭标签相似推定。

| 页面 | A 键名 | B 键名 | 依据 |
| --- | --- | --- | --- |
| gritJarvisInterface | `poi-name-value` | `name` | POI 对话框的 Name；A 用 poi-name-value，B 用 data-poi-field=name |
| gritJarvisInterface | `poi-radius-value` | `radius` | POI 对话框的 Radius (m)；标签两侧同为 Radius (m) |
| gritJarvisInterface | `poi-latitude-value` | `lat` | POI 对话框的 Latitude；标签两侧同为 Latitude |
| gritJarvisInterface | `poi-longitude-value` | `lon` | POI 对话框的 Longitude；标签两侧同为 Longitude |
| gritJarvisInterface | `updateRateInput` | `updateRate` | 频谱 Update Rate；A 为 updateRateInput(79)，标签 Update Rate (Secs/s) |
| gritJarvisInterface | `value` | `resolution` | 频谱分辨率；A 是 id=spectrumResolutionInput 上的 name="value"(86)，标签两侧同为 Spectrum Resolution (K) |
| gritJarvisInterface | `timeAveragingInput` | `timeAverage` | 频谱 Time Averaging；A 为 timeAveragingInput(101) |
| gritJarvisInterface | `detectionSensitivityInput` | `sensitivity` | 频谱 Detection Sensitivity；A 为 detectionSensitivityInput(108) |
| convert | `prefix-option` | `cv-affix` | 输出名前缀/后缀单选组：A 是 prefix-option(367, value=PREFIX) 与 suffix-option(374, value=SUFFIX) 两个 id，B 合并为 name=cv-affix 的两个 radio（435 PREFIX / 439 SUFFIX），取值集合相同 |
| convert | `destFolderPath` | `destination` | 目标目录：A 是隐藏的 webkitdirectory input（354），B 是只读文本框 data-el=destination（419）显示同一路径 |

### 用户反馈问卷（判 not_applicable，15 个）

`app/view/html/index.html` 里那批 `<textarea>`（`SM2IP` … `VS4IP`）落在
`*-survey-section > carousel-fb-data > rating-msg-section` 里，是让用户给界面打分的意见框
（"Very easy" / "Exceeds expectations" / "Other"），**不是设备参数**。
B 侧没有复刻它们是对的——把这算成「漏做」会虚高差异。

判据是**结构性的**：控件的祖先容器 class 命中 `survey-section` / `carousel-fb-data` / `rating-msg-section` 就排除，与具体 id 无关。
写死 id 清单等于把当前样本当规律，原版改版就失效；而结构性判据判错的方向是「漏判」（仍留在差异里），不会误排除设备字段。

| 字段 | 页面 | 理由 |
| --- | --- | --- |
| CS2IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| CS3IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| CS4IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| GS2IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| GS3IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| GS4IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| PL2IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| PL3IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| PL4IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| SM2IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| SM3IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| SM4IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| VS2IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| VS3IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |
| VS4IP | index | 用户反馈问卷控件（祖先容器 class 命中 survey-section/carousel-fb-data/rating-msg-section）：不是设备字段，B 侧不复刻是对的 |

## 未纳入范围的条目

这些条目在映射里标为 `not_applicable` / `a_only`，或缺少 A/B 文件，按上节口径不计入差异：

- `tile.alignStatus`
- `tile.radioStatus`
- `tile.spanStatus`
- `tile.pppCorrections`
- `config.alignConfig`
- `config.spanConfig`
- `config.radioConfig`
- `config.spanInstallation`
- `config.vehicleSetup`
- `tool.events`
- `graph.newProjectFromSbf`
- `suite.addApplication`
- `suite.autoUpdates`
- `suite.updateApplication`

## 局限（不掩盖）

1. **`--check` 的「差异」指产物陈旧**，不是字段对不齐。字段级 `mismatches` 只汇报、不进退出码——否则同一个退出码既要表示「产物过期」又要表示「字段不符」，调用方分不清该重新生成还是该改代码。
2. **静态抽取有上界误差**。A 侧 20 个 `.js` 用模板/拼接生成控件，键名可能是变量，静态抽不到；这类会落进 `a_only`，使差异数偏高。所以 `a_only` 应读作「至少这么多」，`matched` 才是硬证据。
3. **`<button>` 白名单是启发式**。A 侧状态控件按 class 关键字识别（`select-device-btn` / `erase-checkbox` / `export-checkbox` / `toggle-switch` / `*-dropdown`）。原版若用别的 class 画开关，那个字段会漏，表现为 `a_only` 少一行——即差异数偏低，不是偏高。当前这 8 个关键字覆盖了实测全部 17 个状态按钮。
4. **去重会把「真的该分开」的东西合到一起**。合并键是 (页面, 命名空间, 归一化字段名)，它假设同页同命名空间同名就是同一字段。已核对过的反例只有一种：原版自己把同一批控件重复写了两遍（`setUpMonitor.html` 的连接对话框有两个版本、`positionConfig.html` 的 `gpsl1-east` 出现两次、`deviceManagement.js` 的 `connection-on-off` 写了两遍）。这些在原版里就是同一个字段的两份 markup，合并是对的。若将来出现「同页同名但语义确实不同」的情况，这条规则会把它们错并，届时应在 `Field` 上补新的命名空间维度而不是放宽去重。
5. **三档分辨率不溢出（1280/1440/1920）不在本工具范围**。EV-30 的这一项需要真机截图，本表只解决「字段逐项对得上」。
6. **A 侧「无键名控件」抽不到，会表现为 `a_only` 或把对应 B 字段记成 `b_only`**。实测两例（`convert.html`）：采样率是 `<input class="common-sample-freq">`（L331，**没有 id 也没有 name**），未知数据是 `<li type="SEPARATE/INTERLEAVE">`（L340-341，不是表单控件）。两者在 A 侧都真实存在，但静态抽取拿不到稳定标识，于是 B 侧的 `sample-rate` / `cv-unknown` 被记成 `b_only`。这类**读作「工具抽不到」而不是「B 多做了」**；要收口得给抽取器补「按结构位置命名」的规则，本轮没做。
7. **剩余 `b_only` 里有一批是 B 侧新增的功能对话框**。逐条看过：`manage.js` 的终端连接（`data-term`）、加设备（`data-adddev`）、配置文件选择（`data-cfg`）、重启确认（`data-reset`）四组，A 侧终端页 `terminalConsole.html` 只有一个命令行输入框（`terminal-input-box`），没有这些连接/加设备对话框；`grit.js` 的 `term*` 同理。这是**B 侧功能扩展**，不是 A 侧字段漏搬。要判 `not_applicable` 需要先确认这些对话框属于「原版没有、B 自加」，那要产品决策，不在本工具口径内。
