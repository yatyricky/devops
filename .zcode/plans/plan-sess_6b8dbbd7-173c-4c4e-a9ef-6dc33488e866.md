# untestedNodeTypes 独立文件入库 + workflows 支持 `~` 路径

## 需求 1：untestedNodeTypes 抽独立文件并入版本管理

- 新文件 **`node-types-untested.json`**（仓库根，格式 `{ "untested": [...] }`），不入 gitignore，进版本管理——你可在 git 里手工维护这份清单。
- `engine/config.js` 新增 `loadUntested()/saveUntested()`；`/api/node-usage` 改读写新文件。
- **一次性迁移**：local-config.json 里现有的 28 项清单迁入新文件，并从 local-config 删除该字段（避免两处不一致）。迁移逻辑做成幂等函数（旧位置有数据且新文件不存在才搬），提交时新文件带当前清单入库。
- 你已手工修好的清单状态不受影响（迁移原样搬现值）。

## 需求 2：workflows 支持 `~/OneDrive/linux/...` 格式（auto）

复用 `engine/exec.js` 的 `expandHome`：

- `engine/config.js`：`rememberWorkflow`/`forgetWorkflow` 的去重与比较统一经 expandHome 展开；**保存时主目录下的文件自动写成 `~/...` 相对形式**（跨机器可移植），主目录外的仍是绝对路径。
- `engine/registry.js`：`loadWorkflows` 读取 local-config 的 workflows 路径与 `findWorkflow` 匹配前都经 expandHome 展开——你在 local-config.json 里手写 `~/OneDrive/linux/kids-ledger-prod.json` 即可正常加载。

## 验证

1. local-config.json 改写为 `~/OneDrive/linux/kids-ledger-prod.json` 格式 → 刷新页面工作流正常加载、`node cli.js list` 亦正常。
2. `/api/node-usage` 返回迁移后的清单；local-config.json 中不再有 untestedNodeTypes 键；新文件已入库。
3. 全量 `node tools/verify-dryrun.js` 不回归；git 提交（新文件入库）。
