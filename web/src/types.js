/** 与 engine/types.js 同规则的客户端镜像 + 动态插槽/出口计算。 */

export const TYPE_COLORS = {
  struct: "#4da3ff", ssh: "#ff9e64", string: "#c8d3f0",
  number: "#e5c07b", boolean: "#c678dd", any: "#8a97a8",
};

/** 插槽类型全集（engine/types.js 同源镜像） */
export const SOCKET_TYPES = ["struct", "ssh", "string", "number", "boolean", "any"];

/** @param {string} from @param {string} to */
export function canConnect(from, to) {
  // 与 engine/types.js 同规则：未知/拼错类型一律拒绝（镜像曾缺这层——folder→folder 前端放行后端拒）
  if (!SOCKET_TYPES.includes(from) || !SOCKET_TYPES.includes(to)) return false;
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
  if (meta?.countInputs) {
    const { key, prefix, type, min, max } = meta.countInputs;
    const n = Math.max(min, Math.min(max, Math.trunc(Number(data?.[key]) || min)));
    const ports = [];
    for (let i = 1; i <= n; i++) {
      const id = `${prefix}${i}`;
      if (!all.some(d => d.id === id)) ports.push({ id, type, required: true, dynamic: true });
    }
    all = [...all, ...ports];
  }
  if (meta?.pairInputs) {
    // 每行双端口：pN.from / pN.to（块序与 engine/nodes/index.js getInputs 对齐：count → pair → tpl → field → dynamic）
    const { key, prefix, min, max, sub } = meta.pairInputs;
    const n = Math.max(min, Math.min(max, Math.trunc(Number(data?.[key]) || min)));
    const ports = [];
    for (let i = 1; i <= n; i++) {
      for (const subDef of sub) {
        const id = `${prefix}${i}.${subDef.suffix}`;
        if (!all.some(d => d.id === id)) ports.push({ id, type: "string", required: subDef.suffix === sub[0].suffix, dynamic: true, ...(subDef.suffix !== sub[0].suffix ? { noHandle: true } : {}) });
      }
    }
    all = [...all, ...ports];
  }
  if (meta?.tplVars) {
    // 路径可推导 → 按模板 {{VAR}} 生成 string 口；不可推导 → 降级为一个 struct 口
    if ((data?.varsList ?? []).length) {
      const tplPorts = data.varsList
        .filter(v => v && !all.some(d => d.id === v))
        .map(v => ({ id: v, type: "string", required: true, dynamic: true }));
      all = [...all, ...tplPorts];
    } else if (data?.varsUnresolved) {
      all = [...all, { id: "vars", type: "struct", required: false, dynamic: true }];
    }
  }
  if (meta?.fieldInputs) {
    const fieldPorts = (data?.fields ?? [])
      .filter(f => f.key && !all.some(d => d.id === f.key))
      .map(f => ({ id: f.key, type: f.type ?? "string", required: false, dynamic: true, fromField: true }));
    all = [...all, ...fieldPorts];
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

/**
 * 节点有效输出 = 声明输出，或按 dynamicOutputs 规则解析（engine/nodes/index.js 同规则镜像）。
 * @param {any} meta node-types 注册表条目
 * @param {any} data 节点 data
 * @param {{edges?: any[], nodes?: any[], id?: string}} env structSplit 回溯上游需要
 */
export function effectiveOutputs(meta, data, env = {}) {
  if (meta?.dynamicOutputs === "structSplit") {
    // 与 engine 同规则：上游必须是 struct.make（否则无字段可析构）；过滤 tnl- 派生段边
    const e = (env.edges ?? []).find(x => x.kind !== "seq" && !String(x.id).startsWith("tnl-") && x.target === env.id);
    const src = (env.nodes ?? []).find(n => n.id === e?.source);
    if (src?.type !== "struct.make") return [];
    return (src.data?.fields ?? []).filter(f => f.key).map(f => ({ id: f.key, type: f.type ?? "string" }));
  }
  return meta?.outputs ?? [];
}

let seq = 0;
/** @param {string} prefix */
export function genId(prefix = "n") {
  seq += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${seq}`;
}

// ── Group 收起黑箱条布局常量（App 计算节点高度与 GroupBox 渲染行必须同源）────
export const GROUP_BAR = { header: 36, row: 20, div: 9, pad: 8 };
/** 收起条总高 = 标题行 + 入口数×行高 +（出入口都有时分隔线）+ 出口数×行高 + 页脚 padding */
export function groupBarHeight(nIn, nOut) {
  return GROUP_BAR.header + nIn * GROUP_BAR.row + (nIn && nOut ? GROUP_BAR.div : 0) + nOut * GROUP_BAR.row + GROUP_BAR.pad;
}
/** 收起条内第 i 行 label 的 top；side = "in" | "out"，入口在标题下、分隔线后是出口 */
export function groupBarRowTop(side, i, nIn) {
  return side === "in"
    ? GROUP_BAR.header + i * GROUP_BAR.row
    : GROUP_BAR.header + nIn * GROUP_BAR.row + (nIn ? GROUP_BAR.div : 0) + i * GROUP_BAR.row;
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

  // 逐插槽统计任务内携带边；required 闭包/覆盖（有值即满足：连线或端口字面量）
  for (const id of sel) {
    const node = nodesById.get(id);
    const meta = metasMap[node?.data?.__type ?? node?.type];
    if (!meta) { problems.push(`节点类型未知: ${id}`); continue; }
    for (const inp of effectiveInputs(meta, node.data)) {
      const inEdges = edges.filter(e => e.kind !== "seq" && !String(e.id).startsWith("tnl-") && e.target === id && e.targetHandle === inp.id);
      const carried = inEdges.filter(e => selected.has(e.source)).length;
      const hasLit = node?.data?.lit?.[inp.id] !== undefined;
      if (carried >= 2) problems.push(`输入 ${id}.${inp.id} 有 ${carried} 条连线，只能有一个输入`);
      else if (inp.required && carried === 0 && !hasLit) {
        if (inEdges.length) problems.push(`节点 ${id} 的必填输入 ${inp.id} 依赖节点 ${inEdges.map(e => e.source).join("/")}，未选入`);
        else problems.push(`节点 ${id} 的必填输入 ${inp.id} 未连线且未填值`);
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
