/** 与 engine/types.js 同规则的客户端镜像 + 动态插槽计算。 */

export const TYPE_COLORS = {
  env: "#4da3ff", ssh: "#ff9e64", file: "#4cc38a", folder: "#56b6c2", string: "#c8d3f0",
  number: "#e5c07b", boolean: "#c678dd", any: "#8a97a8",
};

/** @param {string} from @param {string} to */
export function canConnect(from, to) {
  if (from === to) return true;
  return to === "any";
}

/**
 * 节点有效输入 = 声明 + 动态（{{name}} → string 插槽；{{obj.key}} → any 插槽）。
 * @param {any} meta node-types 注册表条目
 * @param {any} data 节点 data
 */
export function effectiveInputs(meta, data) {
  const declared = (meta?.inputs ?? []).map(i => ({ ...i, dynamic: false }));
  if (!meta?.dynamicInputs) return declared;
  const text = String(data?.[meta.dynamicInputs.source] ?? "");
  /** @type {Map<string,string>} */
  const dyn = new Map();
  for (const m of text.matchAll(/\{\{(\w+)(?:\.(\w+))?\}\}/g)) {
    dyn.set(m[1], m[2] ? "any" : meta.dynamicInputs.type);
  }
  const dynamic = [...dyn.entries()]
    .filter(([id]) => !declared.some(i => i.id === id))
    .map(([id, type]) => ({ id, type, required: true, dynamic: true }));
  return [...declared, ...dynamic];
}

let seq = 0;
/** @param {string} prefix */
export function genId(prefix = "n") {
  seq += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${seq}`;
}

/**
 * 任务选点校验（engine/workflow.js 同规则的客户端镜像；服务端仍是权威）：
 * 闭包（required 入边源必选）/ 插槽唯一 / 无环。
 * @param {string[]} sel 选中的节点 id
 * @param {any[]} edges 全图边（xyflow 格式：source/target/sourceHandle/targetHandle/kind）
 * @param {Map<string, any>} nodesById id → 节点（含 data）
 * @param {any} metasMap type → 节点元数据
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function validateTaskSelection(sel, edges, nodesById, metasMap) {
  const problems = [];
  const selected = new Set(sel);
  if (!sel.length) return ["至少选择一个节点"];
  for (const id of sel) if (!nodesById.has(id)) problems.push(`引用不存在的节点: ${id}`);
  if (new Set(sel).size !== sel.length) problems.push("节点重复");

  // 逐插槽统计任务内携带边；required 闭包/覆盖
  for (const id of sel) {
    const node = nodesById.get(id);
    const meta = metasMap[node?.data?.__type ?? node?.type];
    if (!meta) { problems.push(`节点类型未知: ${id}`); continue; }
    for (const inp of effectiveInputs(meta, node.data)) {
      const inEdges = edges.filter(e => e.kind !== "seq" && e.target === id && e.targetHandle === inp.id);
      const carried = inEdges.filter(e => selected.has(e.source)).length;
      if (carried >= 2) problems.push(`输入 ${id}.${inp.id} 有 ${carried} 条连线，只能有一个输入`);
      else if (inp.required && carried === 0) {
        if (inEdges.length) problems.push(`节点 ${id} 的必填输入 ${inp.id} 依赖节点 ${inEdges.map(e => e.source).join("/")}，未选入`);
        else problems.push(`节点 ${id} 的必填输入 ${inp.id} 未连线`);
      }
    }
  }

  // 无环：Kahn（两端都在选择内的 data + seq 边）
  const indeg = new Map(sel.map(id => [id, 0]));
  const adj = new Map(sel.map(id => [id, []]));
  for (const e of edges) {
    if (!selected.has(e.source) || !selected.has(e.target)) continue;
    if (!indeg.has(e.target)) continue; // 端点未知的边已在上面报过
    /** @type {string[]} */ (adj.get(e.source)).push(e.target);
    indeg.set(e.target, /** @type {number} */ (indeg.get(e.target)) + 1);
  }
  let frontier = sel.filter(id => indeg.get(id) === 0);
  let done = 0;
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      done++;
      for (const m of /** @type {string[]} */ (adj.get(id))) {
        indeg.set(m, /** @type {number} */ (indeg.get(m)) - 1);
        if (indeg.get(m) === 0) next.push(m);
      }
    }
    frontier = next;
  }
  if (done < sel.length) problems.push(`存在环依赖: ${sel.filter(id => indeg.get(id) > 0).join(" → ")}`);
  return problems;
}
