# Bug 记录（回归用）

> **工作约定**：每条 bug 反馈记录于此（现象/根因/修复/回归步骤）。后续新需求或新 bug 若与既有修复方式**矛盾**，必须先停下提请用户决策，不得静默推翻。

---

## BUG-2026-09-25-01 连线双写：删一条线要删两次；"线未渲染但已连接"

- **现象**：拖一条线会意外产生两条同端点边；删除时第一条删掉视觉无变化（重叠），要删两次。"未渲染但已连接"即其中一条的观感。
- **根因**：Svelte Flow 1.6.6 的 `Handle.svelte → onConnectExtended` 在触发 `onconnect` 回调**之前**已 `store.addEdge` 写入（bind 写回 edges），且回调执行时写回尚未落地——旧 `onConnect` 的防重检查读到旧数组落空，又手动 push 一次。
- **修复**：校验移入 `isValidConnection`（false 则库不加边）；`onconnect` 只标脏，绝不再手动 push；`loadDoc` 按四元组去重修复存量数据。
- **回归**：拖同一条线两次 → edges 只 +1；选中边按一次 Delete 即消失。
- **状态**：已修复（30f6254）。

## BUG-2026-09-25-02 struct 构造器 key/value 输入框过小

- **根因**：struct 行是唯一含 `<select>` 的行，`.trow select` 无 flex 规则，继承全局 `width:100%` 把两个 `flex:1` 输入框挤到 0 宽。
- **修复**：`.devnode .body .trow select { flex: none; width: auto; }`。
- **回归**：Struct 构造器节点字段行 key/value 可见。**状态**：已修复（457b9ea）。

## BUG-2026-09-25-03 struct 改已连线字段 key 后重连，连线不渲染（保存刷新才恢复）

- **现象**：改已连线字段 key（旧边断开正常），从新 key 出口重连，连线不渲染；保存+刷新后才显示。
- **根因（多层，2026-09-25 排查）**：
  1. `isValidConnection` 未解析动态出口（`struct.split` 声明 outputs 为 `[]`，动态出口靠 `effectiveOutputs`）→ 动态出口连线被全拒。已修：`isValidConnection` 对 `dynamicOutputs` 节点走 `effectiveOutputs`。
  2. **运行环境缺陷**：本机内嵌 webview 的 `requestAnimationFrame` **永不投递**（实测 timeout）、ResizeObserver 回调随之不投递。Svelte Flow 重测 handleBounds（`useUpdateNodeInternals`）内部走 rAF → 不执行 → 新 handle 不进 handleBounds → 连接发起失败（连接线从未出现）与边不渲染。
- **修复**：
  - `DevNode.svelte`：`$effect` 监听**动态解析后**的 inputs/outputs 集签名（注意：不能用 `meta.outputs`——struct.split 恒为空），变化后 `updateNodeInternals(id)`。
  - `index.html`：**rAF 竞争式兜底**（原生 rAF 与 40ms setTimeout 同排，先到先执行）+ RO 兜底轮询。正常浏览器零变化。
- **回归**：干净加载后改一个已连线字段 key → 立即从新 key 出口拖线到任意兼容输入 → 边立即渲染，无需保存刷新。
- **状态**：修复已实施；**在真实 Chrome 中请回归确认**。内嵌 webview 中仍观察到首次连线偶发失败（重连或稍候即成功），疑与该 webview 渲染帧缺失的深层环境问题有关，见 BUG-04。

## BUG-2026-09-25-04 运行环境：webview 的 rAF/ResizeObserver 不投递

- **现象**：依赖渲染帧的浏览器 API（rAF、RO 回调）在此内嵌 webview 中不工作；普通 Chrome/Edge 正常。
- **缓解**：`web/index.html` 头部有 rAF 竞争兜底 + RO 轮询兜底（对正常浏览器零影响）。凡新代码用 rAF/RO 做关键路径，需考虑兜底是否覆盖。
- **状态**：已缓解，环境无法根治。

## BUG-2026-09-25-05 内存/磁盘状态脱节：未保存的改动导致部分接口失败

- **现象**：GUI 里改了图（未保存）→ 运行任务、等接口读到旧磁盘数据 → "保存一下才正常"。
- **修复（按用户决策）**：
  - 修改1：`POST /api/jobs` 支持内存态执行——GUI 运行时把内存图 `toDoc()` 随请求传给后端，后端校验后以内存为准（CLI 仍读盘）。
  - 修改2：关键变更自动写盘——serializable 字段编辑、node/edge 增删改、任务定义/删除、name/title/repoDir 修改触发 `markCritical()`（600ms 防抖自动保存）；节点位置等展示信息仍需手动"保存"。dirty 拆分为 `autoDirty`/`layoutDirty`。
- **回归**：GUI 改图不点保存 → 跑任务用新改动；改 serializable 字段 → 磁盘 JSON 600ms 内自动更新；拖动节点 → 磁盘不变、出现"保存 \*"。
- **状态**：已实施。

## 遗留待办

- xlgbis 仓库自身的耦合缺陷（deploy_server.js 副作用导入、packages/common 双用途、env-usage 退出遥测、失效 dev 脚本）——另开任务。
- 已删除的旧层（apps/ JS 清单、线性步骤 workflow.js、脚本模板）如需参考见 git 历史（954c0b0 及之前）。
