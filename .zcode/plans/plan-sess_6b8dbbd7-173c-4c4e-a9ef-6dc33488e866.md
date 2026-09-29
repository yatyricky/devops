# 里程碑1 收尾：全盘评审报告落盘 + 文档翻新（不改代码）

三路评审已完成（引擎/前端/文档仓库），结论：引擎核心健康，债务集中在 HTTP 边界安全（路径穿越/注入/空 token）、队列写盘脆弱性、双端镜像漂移、一个前端 effect 死循环 bug。代码修复留待下一阶段（按评审报告的 P0→P1→P2 执行），本轮只产出评审文档 + 翻新文档。

## 交付物（7 项）

1. **docs/review-milestone-1.md（新建）**——评审报告本体：
   - 总体评价 + 里程碑1 已交付能力清单（44 提交主线）
   - **P0 六项**（进下一阶段前必须修）：effect 乒乓死循环（App.svelte:701）、/api/jobs/:id 路径穿越可读 token、队列可被磁盘写失败打死+带崩进程、DevNode 复制粘贴 effect 双倍请求、shell 注入点×3（git.checkout ref / chown user / finalize rm）、掩码不识 JSON 形态机密
   - **P1 十二项**（streamJob 重放/LogDrawer 流交织/sshconfig 首块语义反了/双端镜像分叉/初始化无错误处理/任意路径读写无护栏/runs 内存无界+O(n²) IO/GET 副作用/noteText 回弹/a11y/测试缺口/runModal.inputs 死功能）
   - **P2 打磨包**（DRY 清单、死代码清单、App.svelte 拆分方案、镜像根治=共享纯函数模块、webview 补丁加固、小项合集）
   - 测试缺口清单 + 文档卫生记录
2. **README.md 重写**——修 13 处过时（删 workflows//envs//file-folder 类型/env.js/原子解压/upload 自动清理/12 项断言），节点表补全 28 类型（5 分类），补缺失功能（Group/克隆/typed ports/自动保存/内存态执行/token/DEVOPS_* 环境变量/未测试徽章/便笺/vite dev 模式）。
3. **docs/architecture.md 更新**——分层图去 env.js；「前端要点」补 Group 语义（展开直连/收起隧道段边/tnl- 过滤/层级/双脏标记自动保存/克隆）与 webview rAF 补丁；决策5 标注镜像已漂移+根治方向；「新增节点」补 nodeTypesMeta 白名单注意点。
4. **docs/operations.md 重写**——删 envs//tpl//apply-config/回放等失效内容；重写为：初始化（local-config 含 workflows[]、指纹锁定）、日常部署（GUI/CLI 现行为：自动保存 vs 手动保存、dry-run、prod 门禁）、审计（.runs/audit.jsonl）、安全清单（含评审发现的风险现状与建议：务必设 token）、排障表。
5. **local-config.example.json**——补 `workflows: []` 键。
6. **过时注释小修**——Palette.svelte:8 与 store.svelte.js:13 的「local-config.untestedNodeTypes」改为 node-types-untested.json（纯注释，零行为）。
7. **.tmp/ 清理**——删 21 个 verify 残留（rendered-*/stage-*，gitignored）。

## 明确不做（本轮）

- 不修任何 P0/P1 代码 bug（写入评审报告作为下一阶段输入，由你决定修复顺序）
- 不做 App.svelte 拆分等结构重构

## 验证与收尾

前端构建 + `node tools/verify-dryrun.js` 47 项全绿（确认注释小修无副作用）→ git 提交（含此前遗留的 .zcode/plans 修改一并入库）→ 汇报评审要点摘要供你决策 P0 修复排期。