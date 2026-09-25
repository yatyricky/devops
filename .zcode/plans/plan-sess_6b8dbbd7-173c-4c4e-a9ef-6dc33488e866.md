# Bug 记录机制 + 两个 bug 修复 + 内存态/自动写盘改造

## 0. bug 记录机制（新增 docs/buglog.md，当前不存在）

- 每条记录：日期 / 现象 / 根因 / 修复方式 / 回归验证步骤 / 状态。
- 文件头写明工作约定：**新需求或新 bug 若与既有修复方式冲突，先停下提请用户决策，不得静默推翻**。
- 回填最近 4 条已修 bug（连线双写、struct select 挤压、动态插槽边不渲染、垃圾桶/图标类 UI 项），本次两条新 bug 修完后追加。

## 1. Bug1：struct 改已连线字段 key 后重连，连线不渲染（保存刷新才恢复）

**根因**（已勘察确认）：structSplit 动态出口增删 handle 时节点外框尺寸不变，Svelte Flow 的 ResizeObserver 不触发，内部 handleBounds 不重测——指向新 handle 的边因找不到锚点而不渲染；保存刷新后初始化即带新 handle 所以正常。库官方为此提供 `useUpdateNodeInternals()`。

**修复**：`DevNode.svelte` 中调用该 hook，`$effect` 监听 handle 集签名（inputs/outputs 的 id 列表 JSON），变化后 `requestAnimationFrame` 里 `updateNodeInternals(id)` 强制重测。

## 2. 修改1：load 后一切以内存态为准

**现状痛点**：GUI 跑任务时后端 `findWorkflow` 从磁盘读——未保存的新任务/新改动跑不了（"保存一下接口才正常"）。

**修复**：`POST /api/jobs` 的 body 新增可选 `doc`——GUI 的 `doRun` 把内存图 `toDoc()` 一起传，后端 `validateWorkflow(doc)` 通过后直接用内存 doc 入队（不再读盘）；不带 doc 的请求（CLI）维持读盘，CLI 行为不变。

## 3. 修改2：关键变更自动写盘，坐标仍手动

- `save(silent)` 支持静默模式；新增防抖调度 `markCritical()`（600ms 合并连续编辑，如输入框逐字符）。
- **自动写盘**的调用点：serializable widget 编辑（`onData` 里按 widget 元数据判断）、节点/边增删（addNode / deleteNode / onDelete / onConnect）、任务定义与删除、name/title/repoDir 修改。
- **不自动**：节点位置（onMoveEnd 仅置 dirty，保留手动"保存"按钮价值）。
- dirty 拆分为 `autoDirty`（自动保存清）与 `layoutDirty`（位置改动，手动保存清）；保存按钮状态 = 两者或。
- 自动保存成功不弹 toast（避免频繁打扰），顶部保存按钮状态即可反映。

## 4. 验证

1. `npm -C web run build`；刷新画布。
2. Bug1 回归：选中 Struct 构造器 → 改一个已连线字段 key → 旧边断开 → 从新 key 重连 → **边立即渲染**（无需保存刷新）。
3. 修改2 回归：改 serializable 字段/拖一条新线 → 不点保存，直接查磁盘 JSON 已更新；拖动节点位置 → 磁盘不变、保存按钮出现 *。
4. 修改1 回归：新定义一个任务（不点保存）→ GUI 直接运行成功（后端收到内存 doc）。
5. 全量 `node tools/verify-dryrun.js` 不回归。

## 5. 收尾

buglog 追加本次两条（含回归步骤）→ git 提交。
