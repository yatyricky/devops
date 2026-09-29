/** 模块级响应式状态（runes）：节点类型注册表镜像 + 任务高亮 + 运行状态（不写入节点对象，避免与 SvelteFlow 的回写形成写读循环）。 */
export const ui = $state({
  /** @type {Record<string, any>} type → meta */
  nodeTypesMap: {},
  /** @type {Record<string, number>} nodeId → 路径序号（1 起） */
  pathHighlight: {},
  /** @type {Set<string> | null} 运行中任务的选点集（null = 无任务在跑）；集外节点显示半透明灰 */
  runTaskNodes: null,
  /** @type {Record<string, string> | null} nodeId → running|ok|failed（最近一次运行的卡片外框状态） */
  nodeRunStatus: null,
  /** @type {Record<string, Record<string, string>> | null} nodeId → {handle: 显示值}（运行中实时更新的实际输入值） */
  runNodeInputs: null,
  /** @type {Set<string> | null} 手工维护的「未测试」节点类型清单（node-types-untested.json；null = 未加载） */
  untestedNodeTypes: null,
  /** 一键刷新信号：顶栏按钮 +1，各卡片 effect 监听后各自触发自己的下拉刷新 */
  refreshTick: 0,
});
