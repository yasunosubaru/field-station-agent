# 抽取脚本（无第三方依赖，node ≥ 18）

所有 renderer 侧的脚本都从环境变量 `GRAPHSRC` 读目标文件，例如 PowerShell：

```powershell
$env:GRAPHSRC = "F:\...\逆向\01_解包\Graph\out\renderer\assets\index-B86bHcCD.js"
node stats.js $env:GRAPHSRC           # 行数/行宽/关键标记计数
node g.js 'pattern' 60 120 20 [out]   # 上下文 grep（before/after 字符数，limit，可选输出文件）
node slice.js 562300 562800           # 按字节偏移切片打印
node u.js p_charts.json out.json      # 批量"唯一匹配 + 计数"（pattern 从 JSON 读，避免 shell 转义）
node i18n2.js                         # 解析 translationEN/FR（先在脚本里写死 360000..385000 区间）
node jsc_strings.js <file.jsc> 6 out  # 从 bytenode 字节码抽 ASCII 字符串 + 偏移
node winapi.js window_api.txt         # window.<ns>.<method> 统计
node comp_index.js / comp_lines.js    # 组件定义偏移 / 行号
node strings_table.js <outdir>        # H1/H2 字符串表
node lineof.js "[off1,off2]"          # 字节偏移 → 行号
node rea_trim.js <rea.json> <out.json># 裁剪 REA 175 MB 输出
```

正文里的引用 `文件名:行 @字节偏移` 可用 `slice.js` 直接复现：

```powershell
node slice.js 563079 563479
```
