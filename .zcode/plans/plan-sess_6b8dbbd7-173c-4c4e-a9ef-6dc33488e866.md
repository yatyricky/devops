# 运行前自动刷新实时列表（单 commit，前端三文件 + buglog）

## 现状与切入点
- 「全部刷新」= 顶栏「刷新列表」（`ui.refreshTick++` 广播）→ 各卡片各自 POST 幂等只读接口并写 `ui.pickerFresh[id]`。
- `doRun`（App.svelte:743-783）只做新鲜度门禁、不触发刷新，失鲜 toast 拦截 → 用户必须手动刷新后再运行。
- 三个刷新函数活在 DevNode.svelte 卡片内（依赖 resolveInput/卡片 $state 下拉）；buglog 已明确记录「不抽象这三个函数」（返回结构差异大）——方案尊重该决策。

## 方案（SOC：卡片拥有刷新逻辑与下拉状态，App 只编排时机）
1. **web/src/store.svelte.js**：新增非响应式模块级导出 `export const pickerRefreshers = new Map()`（nodeId → 刷新函数）。函数不是 UI 状态，不放进 `$state`。
2. **web/src/DevNode.svelte**：在 refreshTick effect 旁新增注册 effect——卡片带任一 picker 标志（refsPicker/scriptsPicker/sshAliasesPicker）时 `pickerRefreshers.set(id, refreshAll)`，refreshAll 按标志调用现有 refreshRefs/refreshScripts/refreshSshAliases（Promise.all 聚合，三者内部均已 try/catch 不会 reject）；effect teardown 注销。
3. **web/src/App.svelte `doRun` 重构**：
   - 现有门禁循环改为单次收集 `pickers = [{id, expect}]`（want===undefined 的运行时输入节点仍跳过——维持 buglog 既有的逃生分支语义）；键派生逻辑保持唯一（DRY）。
   - `await Promise.allSettled(pickers.map(x => pickerRefreshers.get(x.id)?.()))`：**每次运行前无条件刷新一次**（不做「已新鲜则跳过」——repoDir 未变但上游出新 commit 的内容级漂移正要靠每次刷新兜住，也符合「执行一次刷新」的字面语义）；无 picker 节点的任务零开销直通。
   - 顺带收益：refreshScripts 的「选值不在新列表 → 自动回写第一项」副作用发生在 `toDoc()` 之前，过期 script 名在入队前被自动修正。
   - 门禁保留为兜底：刷新失败（卡片红框显示具体错误）→ pickerFresh 失鲜 → 拦截，toast 改为「实时列表自动刷新失败（…），见卡片错误提示，修正后重试」。
   - 加两行健壮性：`runBusy` 重入守卫（刷新 await 拉长了双击窗口）；刷新 await 后复查 `runModal !== m` 则放弃（给取消按钮留出生效窗口）。
   - **范围**：只刷新本任务选点内带 picker 且输入可解析的节点（门禁要求的恰好这批，避免给运行时接线的无关卡片误挂红框错误）；顶栏「刷新列表」按钮原样保留、继续管全画布。
4. **docs/buglog.md**：FEAT-2026-10-05-01 记录。

## 验证（AGENTS.md 允许范围内）
- `node tools/verify-dryrun.js`（回归 69 项全绿）+ 前端构建零警告 + `node --check` store.svelte.js。
- GUI 实测仅在 `.tmp/` 临时 wf 上：git.getRefs（repoDir 指向本仓库本地）+ npm.run（path 指向本仓库）卡片渲染、点「刷新列表」（非运行按钮、幂等只读）下拉填充、控制台无报错；测完删临时 wf。
- `doRun` 编排本身挂在「运行」按钮上，按禁令不由我点击——最终一次真实运行点验交给你执行。
- 单 commit（不 push，等你明确要求再 push）。

## 已知边界
- 收起组内成员卡片未挂载时注册表缺项 → 门禁兜底拦截（展开组即恢复）；App 未启用 onlyRenderVisibleElements，常态下全节点挂载，此边界实际不可达。