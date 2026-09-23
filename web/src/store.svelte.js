/** 模块级响应式状态（runes）：节点类型注册表镜像 + 任务路径高亮（不写入节点对象，避免与 SvelteFlow 的回写形成写读循环）。 */
export const ui = $state({
  /** @type {Record<string, any>} type → meta */
  nodeTypesMap: {},
  /** @type {Record<string, number>} nodeId → 路径序号（1 起） */
  pathHighlight: {},
});
