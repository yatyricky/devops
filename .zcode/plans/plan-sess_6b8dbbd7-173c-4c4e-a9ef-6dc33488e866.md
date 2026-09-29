# Group 四项打磨：出口锚点错位 / 接口压边同尺寸 / 背景板层级 / 收起条带标签分栏

## 1. 出口段边接到入口 —— CSS left/right 冲突（根因已定位）

xyflow 的 `Position.Left` Handle 类自带 `left:-4px`，与孪生接口的内联 `right:-4.5px` 同时声明时 **left 获胜**，出口孪生锚点被钉在组框左缘。修法（GroupBox.svelte，展开/收起两态同改）：
- 出口孪生：内联补 `left:auto; right:-4.5px`（显式覆盖类上的 left）。
- 入口孪生：内联补 `right:auto; left:-4.5px`（把侥幸正确变成显式正确）。

## 2. 接口压在 border 上 + 与普通插槽同尺寸（圆形保留）

普通节点口是 9px（app.css `.devnode ... .svelte-flow__handle`），隧道口现在是 xyflow 默认 6px。全部隧道口（可见+孪生、展开+收起）统一 `width/height:9px`、`left/right:±4.5px`——9px 圆点正跨在边框线上（压边），圆形样式保留与节点方口区分。

## 3. 背景板层级：组外节点 < 背景板 < 自己的成员

- makeGroupNode `zIndex: -1 → 1`；组合时成员 `zIndex: 2`；拆分时成员回 `0`；loadDoc 重建时组内成员同样抬到 2。组外节点保持默认 0 → 形成 板(1) > 组外节点(0)、成员(2) > 板(1)。
- onPalette 色板置顶回落值 `-1 → 1`（打开仍 1000）。
- 配套点击穿透：`.svelte-flow__node.svelte-flow__node-groupbox { pointer-events:none }`（app.css，双类名压过 xyflow 基类），板内 `.ghead`/`.tlabel` 显式 `pointer-events:auto`——板压在组外节点上后，卡片被板盖住的部分仍可点选，组的拖拽/交互集中在标题行。
- 效果说明：隧道段边/普通边会走到板下方（9% 透明底仍可见，视觉上「穿过组领地下方」）。

## 4. 收起条：入口/出口分栏 + 节点端口 label

- **label 内容**（与 DevNode 卡片同格式）：`<类型 title>< - 备注>: <口id> (<type><⭑>)<必填*>`，如 `Resolve Path - 正式服路径: p1 (string⭑)*`。App context 新增 `tunnelLabel(edge, side)`：入侧取 target 节点+targetHandle（effectiveInputs），出侧取 source 节点+sourceHandle（effectiveOutputs）；节点标题后缀取 `data.note`（与 htitle 同源）。
- **分栏布局**（types.js 新增共享常量，App 与 GroupBox 同源）：`GROUP_BAR = { header:36, row:20, div:9, pad:8 }` + `groupBarHeight(nIn,nOut)` + `groupBarRowTop(side,i,nIn)`。
  - 收起态：入口行在标题下左对齐 → 1px 分隔线（出入口都有才画）→ 出口行右对齐；每行一个 label（ellipsis 截断 + title 属性悬停看全文，pointer-events:auto 保证 hover 生效）；隧道口按行高对齐。
  - **收起高度公式改为** `36 + nIn×20 + (双向都有?9:0) + nOut×20 + 8`（替换现在的 40+20×max）；GroupBox 收起态 Handle 的 top 用同一函数推——最后出口行距卡片圆角留出 8px 页脚，不再贴圆角。
  - `.collapsed .ghead` 高度锁 36px（box-sizing + 居中）。

## 验证（沿用已建立的隔离流程）

`.tmp/` 重建临时 wf（入 1 出 2 + 组内边）→ 新标签页 GUI 实测：出口段边接右缘/入口接左缘（根因①回归）、9px 圆口压边框中线、组外节点被板覆盖区域仍可点选、收起条 label 文案与截断/悬停、收起高度=公式值、刷新还原 → 截图；构建 + verify-dryrun；buglog 在 BUG-2026-09-29-03 后追加本轮条目；测完删临时文件并 git 提交。