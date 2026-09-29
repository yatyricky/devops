# 修复 Group 组合丢线 / 插槽不渲染 / 收起按钮无效（验证不碰用户 wf）

## 第 0 步：AGENTS.md 新增约定

在硬性禁令区追加：**禁止写用户的 workflow 文件——GUI 编辑、自动保存连带写入一律不许；测试阶段（含 GUI 实测）也不得操作用户的 live wf。** 用户 wf 允许 read、允许 copy 到临时位置检查。既有「测试一律在临时工作流上」条款随之收紧：GUI 实测只能在专用临时 wf 文件上进行，用后删除。

## 根因（一个 id 错配引发全部三个现象）

groupbox 节点的 xyflow id 是 `grp-${gid}`（makeGroupNode，App.svelte:372），而 `data.__gid` 是裸 gid。三处按裸 gid 查找/连线：

1. `groupEdges(gid)`（App.svelte:124）`n.id === gid` 永不命中 → 隧道数据恒空 → **插槽永不渲染**。
2. `oncollapse`（App.svelte:137）`if (!g) return` 空转 → **收起/展开按钮无反应**。
3. 段边 effect（App.svelte:593-594）端点写裸 `gid` → 段边指向不存在的节点不渲染，而原跨组边同 effect 已被 `hidden: true` → **组合后连线"丢失"**。

次要一并修：
- `tunnelCountOf`（App.svelte:527）按 tnl 段边计数，端点修好后会双倍 → 改按非 tnl 跨组边算 max(in,out)。
- 收起条尺寸三处常量打架（36+20n / 40+20n / 60），未落实规格「宽=230」→ 统一 helper。
- loadDoc（App.svelte:227）重建 groupbox 没传 collapsed → 收起态刷新即丢。
- GroupBox.svelte：CSS 写 `.tcoll` 标记是 `.tcol`（永不生效）；xyflow Handle 基类 `position:absolute`，flex 列排不动 → 收起态 Handle 改用与展开态同款的绝对定位+内联 top。
- `resolvePortValue` / `isWiredAsTarget` / `getSourceNode` 边查找未过滤 `tnl-`（靠数组顺序碰巧不出错，属隐患）。

## 修改清单（仅 web/src/App.svelte + GroupBox.svelte，纯前端，不碰引擎与工作流数据）

1. 抽共享 helper `crossEdges(gbox)`：按 memberIds 求 {in, out} 跨组边（过滤 tnl-）；`groupEdges(gid)` 改按 `n.type==="groupbox" && n.data.__gid===gid` 定位后转调。
2. `oncollapse` 按 `__gid` 定位（find 与 map 分支）。
3. 段边 effect 端点改 `g.id`（grp- 全 id）；handle id `tunnel-in/out-k` 与 GroupBox 渲染序天然一致。
4. `tunnelCountOf` 改用 crossEdges 取 max(in,out)。
5. 收起条尺寸 helper：宽 230、高 `40 + 20×max(in,out)`；makeGroupNode / oncollapse / AABB effect 三处统一。
6. loadDoc 传 `!!g.collapsed`。
7. GroupBox.svelte 收起态 Handle 重写为绝对定位 + 内联 `top:{47+i*20}px` 左右两列；删失效的 `.tcollwrap/.tcol` CSS。
8. 三处编辑期边查找补 `!String(e.id).startsWith("tnl-")`。
9. docs/buglog.md 记 BUG-2026-09-29-03（三现象 + 根因 + 回归步骤）。

## 验证（不连服务器、不运行任务、不碰用户 live wf）

- **临时 wf 隔离**：在 `.tmp/` 写一个专用测试工作流 `.tmp/test-group-tunnel.json`（含几条跨组连线的最小节点图），GUI 只打开这个文件做实测；所有编辑触发的自动保存都落在该临时文件。用户现有 wf 只读不改；如需对照仅 copy 到 `.tmp/` 检查。测完删除临时文件，GUI 切回空白。
- `node tools/verify-dryrun.js` 全绿 + 前端构建通过。
- 浏览器实测（仅编辑/渲染/校验）：在临时 wf 上建组 → 跨组连线 → 左右缘插槽与双段转发线可见 → 收起（宽 230 黑箱条、成员隐藏、外部线仍接条缘）→ 展开 → 保存/刷新后 collapsed 还原；截图确认。
- git 提交（含 AGENTS.md 约定更新）。