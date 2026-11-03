<!-- 提交 PR 前先过一遍这份清单，缺项就在描述里写清楚为什么缺。 -->

## 这个 PR 做什么

<!-- 一两句。关联的 issue 用 #号；没有 issue 的先说清楚动机。 -->

## 属于哪一半

- [ ] A · 野外台站智能体（`src/`、`tests/`、`harness/`）
- [ ] B · NovAtel 套件逆向与重实现（`逆向/`）
- [ ] 仓库本身（`.github/`、`docs/`、`tools/`、README）

## 自检

- [ ] `$env:PYTHONPATH="src"; python -m unittest discover -s tests -t .` 全绿，且 **skip 为 0**
- [ ] `$env:PYTHONPATH="src"; python harness/selftest.py` 五项全 PASS
- [ ] `python tools/audit_claims.py` 退出码 0（改过 README 的数字就必须重跑）
- [ ] `python tools/check_desensitization.py` 退出码 0
- [ ] 动过 `逆向/04_重实现/` 时：`node --test --test-force-exit "packages/*/test/*.test.ts"` 全绿
- [ ] 动过 `逆向/05_打包/` 时：版本号已递增，且 exe 的 SHA256 记在发布说明里

## 逐条说明

- **行为变更**：改了哪条可观察行为？默认仍是「镜像原实现」还是走了显式开关？
- **搬运件**：有没有碰到 `PROVENANCE.md` 表内文件？碰到了就按「搬运件的纪律」四步走，并在 PR 里
  更新登记表的改动列。
- **数字**：新增或改动的对外数字，出处写在这里（命令 + 输出）。
- **办不到的部分**：没做完、没验证、需要真机或需要人工审批的，一并写清楚，别留在暗处。

## 提交范围

只暂存本 PR 涉及的路径（不要 `git add -A`），核对过的路径：

```
<!-- 一行一个 -->
```
