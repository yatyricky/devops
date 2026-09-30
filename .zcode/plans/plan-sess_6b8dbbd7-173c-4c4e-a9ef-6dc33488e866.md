# 视觉与 QoL 升级八项 + 顺序边选中流线动画

## 1. Group 展开态去左右加宽
`web/src/lib/groups.js`：删 `GROUP_PAD_X`（150），左右统一用 `GROUP_PAD`（14）：AABB 改为 `x: minX - GROUP_PAD, width: (maxX-minX) + GROUP_PAD*2`（顶部 42 / 底部 14 不变）。

## 2+3+7. 边与插槽同色、加粗、选中光晕
- 把现有「连线动画 effect」升级为**边装饰 effect**：对每条数据边计算源出口类型 → `TYPE_COLORS[type]` → 写 `edge.style = { stroke: 颜色, "--ec": 颜色 }`（内联在 path 上）。`tnl-` 段边按原边取同色；解析不到回退 `#8a97a8`。
- `animated` 判定并入同一 effect；只替换 style/animated 需要翻转的边（保引用）。
- app.css：`.svelte-flow__edge-path { stroke-width: 2 }`；选中光晕 `.svelte-flow__edge.selected .svelte-flow__edge-path { stroke-width: 2.6; filter: drop-shadow(0 0 5px var(--ec, var(--accent))); }`。
- seq 边不打类型色（保持 class 机制，见下）。

## 4+补充. 选中节点抬升其连线 + 顺序边流线动画
- `<SvelteFlow>` 加 `elevateEdgesOnSelect`（原生 prop）——选中节点相连的边（含顺序边）渲染层级高于其它节点。
- **`animated` 判定不再排除 seq**：选中节点相连（或边自身被选中）的顺序边同样置 `animated: true`——xyflow 的 `.animated` 规则驱动虚线流动；我们的 seq 样式只固定银色与 dasharray，流动动画照常生效（必要时在 CSS 补 `.svelte-flow__edge.animated.seq` 的动画声明确保覆盖）。

## 5. string 类型改蓝色系
TYPE_COLORS.string：`#c8d3f0` → `#61afef`（One Dark 蓝，与 number/boolean/ssh 同家族，与 struct 蓝深浅可辨）。

## 6. 顺序边银色虚线
`.svelte-flow__edge.seq`：`stroke: #b3bcc8`、`stroke-width: 1.6`、`stroke-dasharray: 4 3`、`opacity: .6`。

## 8. 吸附网格与小白点对齐
`<Background gap={16} />`（默认 20 是错位实锤）；`snapGrid={[16,16]}` 保持。点阵锚定流坐标系原点 → 小白点落在 16 倍数上 = 吸附点，节点左/上边与小点完全 align。

## 验证（临时 wf + 浏览器）
- 边颜色与源插槽一致、粗细 2px；顺序边银色虚线；选中节点 → 相连边（含顺序边）抬升且流线动画；选中单条边 → 光晕+加粗；
- 开吸附拖节点：position 坐标为 16 倍数、节点左/上边与小白点逐格对齐（放大目测）；
- Group 展开态收紧内边距、收起态转发段边同色；
- 构建（零警告）+ verify 50 全绿 → git 提交（评审报告 P2 相应勾销）。