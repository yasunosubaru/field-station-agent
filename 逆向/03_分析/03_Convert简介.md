
## Summary 计数规则（2026-11-01 实测）

`Summary_<name>.txt` 的表格**跟着输出走，不跟输入走**。三条规则都是从套件自己的 Summary 反推出来的，
并用 b1/b2/b3 三份 golden 各验一遍：

1. **文本记录也计入表格**。b1 的 99 条文本记录让表格多出 `+39 BESTPOS`、`+26 RANGE`、
   `+24 SATVIS2`、`+6 RXSTATUS`、`+2 TIMESYNC`、`+2 HWMONITOR`。
2. **打不出行来的记录算输入、不算输出**：b1 的 `RXCONFIG 278 → 256`（那 22 条的内嵌报文不在字典里）；
   b2 的 `RANGECMP2 31 → 0`、`RANGECMP4 30 → 0`，而 `RANGE 638 → 699`（一条压缩记录展开成一条
   RANGE 记录，观测在它的数组里）。
3. **时间范围跳过参考历元**：`SATTIME`(200) 的记录带的是星历/历书的参考时刻。b2 的第一条是
   `ALMANAC 577140.000`，而套件的 Summary 从 `577758.950` 起算。时长是
   `floor(finish) - floor(start)`——b1 28 s、b2 34 s、b3 45 s（四舍五入会分别给 28/33/46）。

实现：`summary.ts` 跳过 `timeStatus === 200` 取首末；`convert-pipeline.ts#textLinesFor` 顺便记录
"每个 log id 出了几行"，`countLogs` 用它当 Output 列；文本记录由 `countTextRecords` 补进表格
（能渲染的算 1 进 1 出，只认名字渲染不出的算 1 进 0 出）。

复验（`--to ABBREV_ASCII` 后与 `golden-b{1,2,3}-20261101.ABBREV_Summary.txt` 逐行比）：

```
除下面三类，整份 Summary 逐行相同
  · 第 2/5/8 行：完成时刻、输入名与路径、输出路径（天然不同）
  · `N log(s)` 那一句
  · 套件的 UNKNOWN 行
```

**仍缺的一行**：套件会打 `0 | UNKNOWN | <字节数> | 0`，b1 3695 / b2 6875 / b3 224。我们量到
"无法成帧的字节"是 b1 3059 / b2 6527 / b3 56，与套件差 +636 / +348 / +168，规律还没找出来
（试过"文本记录全算"、"按行识别"、"含 CRLF"三种口径都不对）。**在没有把握之前不打印这一行**，
宁可少一行也不编一个数字；测试 `summary-counts.test.ts` 把"我们不打 UNKNOWN 行、套件打、且
`N log(s)` 正好差 1"钉住，将来补上时它会提示。
