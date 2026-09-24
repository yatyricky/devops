/** 与 engine/types.js 同规则的客户端镜像 + 动态插槽/出口计算。 */

export const TYPE_COLORS = {
  struct: "#4da3ff", ssh: "#ff9e64", file: "#4cc38a", folder: "#56b6c2", string: "#c8d3f0",
  number: "#e5c07b", boolean: "#c678dd", any: "#8a97a8",
};

/** @param {string} from @param {string} to */
export function canConnect(from, to) {
  if (from === to) return true;
  return to === "any";
}

/**
 * 节点有效输入 = 声明 + 动态。
 * 动态来源：fieldInputs（struct.make 的字段口）+ 文本占位符（{{name}} → string；{{obj.key}} → any）。
 * @param {any} meta node-types 注册表条目
 * @param {any} data 节点 data
 */
export function effectiveInputs(meta, data) {
  const declared = (meta?.inputs ?? []).map(i => ({ ...i, dynamic: false }));
  /** @type {any[]} */
  let all = declared;
  if (meta?.fieldInputs) {
    const fieldPorts = (data?.fields ?? [])
      .filter(f => f.key && !declared.some(d => d.id === f.key))
      .map(f => ({ id: f.key, type: f.type ?? "string", required: false, dynamic: true }));
    all = [...declared, ...fieldPorts];
  }
  if (!meta?.dynamicInputs) return all;
  const text = String(data?.[meta.dynamicInputs.source] ?? "");
  /** @type {Map<string,string>} */
  const dyn = new Map();
  for (const m of text.matchAll(/\{\{(\w+)(?:\.(\w+))?\}\}/g)) {
    dyn.set(m[1], m[2] ? "any" : meta.dynamicInputs.type);
  }
  const dynamic = [...dyn.entries()]
    .filter(([id]) => !all.some(i => i.id === id))
    .map(([id, type]) => ({ id, type, required: true, dynamic: true }));
  return [...all, ...dynamic];
}

/** fs.path 路径文本合法性：绝对路径或 ~ 开头（~ = 用户主目录）。 */
export function pathCheck(p) {
  if (!p) return false;
  const home = /^~(?:[\\/]|$)/.test(p);
  if (!home && !/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(p)) return false;
  if (/[<>|"?*\x00-\x1f]/.test(p)) return false;
  return home || !/[<>:"|?*\x00-\x1f]/.test(p.slice(2));
}

/**
 * 节点有效输出 = 声明输出，或按 dynamicOutputs 规则解析（engine/nodes/index.js 同规则镜像）。
 * @param {any} meta node-types 注册表条目
 * @param {any} data 节点 data
 * @param {{stat?: any, edges?: any[], nodes?: any[], id?: string}} env
 *   fsPath 需 stat（{exists,isDir}；null = 查询中，保守显示双口）；structSplit 需 edges+nodes+id 回溯上游。
 */
export function effectiveOutputs(meta, data, env = {}) {
  if (meta?.dynamicOutputs === "fsPath") {
    const p = String(data?.path ?? "").trim();
    if (!p || !pathCheck(p)) return [];
    if (!env.stat) return [{ id: "dir", type: "folder" }, { id: "file", type: "file" }];
    if (!env.stat.exists) return [];
    return env.stat.isDir ? [{ id: "dir", type: "folder" }] : [{ id: "file", type: "file" }];
  }
  if (meta?.dynamicOutputs === "structSplit") {
    const e = (env.edges ?? []).find(x => x.kind !== "seq" && x.target === env.id);
    const src = (env.nodes ?? []).find(n => n.id === e?.source);
    return (src?.data?.fields ?? []).filter(f => f.key).map(f => ({ id: f.key, type: f.type ?? "string" }));
  }
  return meta?.outputs ?? [];
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
