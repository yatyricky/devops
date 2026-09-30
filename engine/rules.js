/**
 * 引擎与前端共享的纯规则模块（零 Node 依赖）。
 * 前端经 package 依赖（web/package.json 的 devops-console: file:..）import 本文件——
 * 两端消费同一份实现，根治「web/src/types.js 手写镜像」的漂移问题。
 *
 * 内容：插槽类型系统（canConnect/coerce）+ 动态插槽/出口解析（effectiveInputs/effectiveOutputs）
 * + 任务选点校验（validateTaskSelection：required 闭包 / 插槽唯一 / 无环）。
 */

export const SOCKET_TYPES = ["struct", "ssh", "string", "number", "boolean", "any"];

/**
 * struct 形状类型：由字段集推导的规范类型串（键排序，与声明顺序无关）。
 * 空字段 = 纯 "struct"（接受任意 struct）。例：{age:number,name:string} → "struct:{age:number,name:string}"。
 * @param {any[]} fields
 */
export function structShape(fields) {
    const fs = (fields ?? [])
        .filter(f => f.key)
        .map(f => `${f.key}:${f.type ?? "string"}`)
        .sort();
    return fs.length ? `struct:{${fs.join(",")}}` : "struct";
}

/** 是否 struct 家族类型（纯 struct 或带形状的 struct:{...}）。 */
export function isStructType(t) {
    return t === "struct" || String(t ?? "").startsWith("struct:");
}

/**
 * 源类型能否接入目标输入。
 * 规则：未知类型拒绝；同型可连；any 输入兜底；
 * struct 家族：纯 struct 输入接受任意 struct（含带形状）；带形状的输入要求形状串完全一致
 * （键集合与逐键类型相同——与字段声明顺序无关）；无形状源无法证明匹配带形状输入。
 * @param {string} fromType
 * @param {string} toType
 */
export function canConnect(fromType, toType) {
    if (!SOCKET_TYPES.includes(fromType) && !isStructType(fromType)) return false;
    if (!SOCKET_TYPES.includes(toType) && !isStructType(toType)) return false;
    if (fromType === toType) return true;
    if (isStructType(fromType) && isStructType(toType)) {
        if (toType === "struct") return true;      // 带形状的 struct 可进纯 struct 输入
        if (fromType === "struct") return false;   // 无形状源无法证明匹配带形状输入
        return fromType === toType;
    }
    return toType === "any";
}

/**
 * 运行时把值矫正为输入声明类型（number/boolean 宽容转换；struct/ssh/any 原样）。
 * @param {any} value
 * @param {string} type
 */
export function coerce(value, type) {
    if (value === undefined || value === null) return value;
    switch (type) {
        case "string": return String(value);
        case "number": return Number(value);
        case "boolean": return typeof value === "string" ? value === "true" : !!value;
        default: return value;
    }
}

/** 前端 Group 收起态的派生转发段边（id 前缀 tnl-，不入库不参与数据语义）——边消费者一律过滤。 */
export function isTunnelEdge(e) {
    return String(e?.id ?? "").startsWith("tnl-");
}

/**
 * 节点有效输入 = 声明 + 动态。动态机制（按此顺序叠加，后者不覆盖前者同名口）：
 *   countInputs（path.resolve/string.join 等）：控件 key 为整数 N → prefix1..N 同型输入口；
 *   pairInputs（stage.copy）：每行双端口 pN.from / pN.to；
 *   tplVars（template.render）：模板路径可推导 → 各 {{VAR}} string 口；不可推导 → 降级一个 struct 口；
 *   fieldInputs（struct.make）：data.fields 每字段 → 同名同型输入口（连线覆盖手填）；
 *   selectorInputs（select.one）：开放口 in（类型 = lockType ?? any）+ 每条已接入边一个专用口 in-<源id>；
 *   dynamicInputs（文本占位符）：{{name}} → string 口；{{obj.key}} → any 口。
 * @param {any} meta 节点类型定义（注册表条目或 /api/node-types 元数据，二者字段同构）
 * @param {any} data 节点 data
 * @param {{edges?: any[], nodes?: any[], id?: string}} [env] selectorInputs 推导已接入边需要图
 */
export function effectiveInputs(meta, data, env = {}) {
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
    if (meta?.selectorInputs) {
        // 选择器：开放口 in（首个连线锁定类型）+ 每条已接入边一个专用口 in-<源节点id>
        const lockType = data?.lockType ?? "any";
        const open = [{ id: "in", type: lockType, required: false, dynamic: true }];
        const wired = (env?.edges ?? [])
            .filter(e => e.kind !== "seq" && !isTunnelEdge(e) && e.target === env?.id && e.targetHandle !== "in")
            .map(e => ({ id: e.targetHandle, type: lockType, required: false, dynamic: true }));
        all = [...all, ...open, ...wired];
    }
    if (!meta?.dynamicInputs) return all;
    const text = String(data?.[meta.dynamicInputs.source] ?? "");
    /** @type {Map<string,string>} id → 类型 */
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
 * 节点有效输出 = 声明输出，或按 dynamicOutputs 规则解析。
 * structSplit：回溯入边上游 struct.make 的字段定义按序输出；上游不是 struct.make 或未接线 → []。
 * selectorOut：已锁定（data.lockType）→ 单出口 value（锁型）；未锁定 → []。
 * structMake：按 data.fields 输出带形状的 struct 类型串（structShape）。
 * @param {any} meta
 * @param {any} data
 * @param {{edges?: any[], nodes?: any[], id?: string}} [env] structSplit 回溯上游需要（nodes 的类型键为 type）
 */
export function effectiveOutputs(meta, data, env = {}) {
    if (meta?.dynamicOutputs === "structSplit") {
        const e = (env.edges ?? []).find(x => x.kind !== "seq" && !isTunnelEdge(x) && x.target === env?.id);
        const src = (env.nodes ?? []).find(n => n.id === e?.source);
        if (src?.type !== "struct.make") return [];
        return (src.data?.fields ?? []).filter(f => f.key).map(f => ({ id: f.key, type: f.type ?? "string" }));
    }
    if (meta?.dynamicOutputs === "structMake") {
        return [{ id: "struct", type: structShape(data?.fields) }];
    }
    if (meta?.dynamicOutputs === "selectorOut") {
        return data?.lockType ? [{ id: "value", type: data.lockType }] : [];
    }
    return meta?.outputs ?? [];
}

/**
 * 任务选点校验（服务端 validateWorkflow 与 GUI 定义任务共用；服务端仍是权威）：
 * required 闭包（required 入边源必选；端口字面量 data.lit 同样满足）/ 插槽唯一 / 无环。
 * @param {string[]} sel 选中的节点 id
 * @param {any[]} edges 全图边（engine doc 边与 xyflow 边同构：source/target/sourceHandle/targetHandle/kind）
 * @param {Map<string, any>} nodesById id → 节点（web 节点类型键为 data.__type，engine 为 type）
 * @param {any} metasMap type → 节点元数据
 * @param {{ taskName?: string }} [opts] 传入时报错带「任务 <name>：」前缀（engine 校验路径）
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function validateTaskSelection(sel, edges, nodesById, metasMap, opts = {}) {
    const P = opts.taskName ? (s) => `任务 ${opts.taskName}：${s}` : (s) => s;
    const problems = [];
    const selected = new Set(sel);
    if (!sel.length) return [P("至少选择一个节点")];
    for (const id of sel) if (!nodesById.has(id)) problems.push(P(`引用不存在的节点: ${id}`));
    if (new Set(sel).size !== sel.length) problems.push(P("节点重复"));

    for (const id of sel) {
        const node = nodesById.get(id);
        const meta = metasMap[node?.data?.__type ?? node?.type];
        if (!meta) { problems.push(P(`节点类型未知: ${id}`)); continue; }
        for (const inp of effectiveInputs(meta, node.data)) {
            const inEdges = edges.filter(e => e.kind !== "seq" && !isTunnelEdge(e) && e.target === id && e.targetHandle === inp.id);
            const carried = inEdges.filter(e => selected.has(e.source)).length;
            const hasLit = node?.data?.lit?.[inp.id] !== undefined;
            if (carried >= 2) problems.push(P(`输入 ${id}.${inp.id} 有 ${carried} 条连线，只能有一个输入`));
            else if (inp.required && carried === 0 && !hasLit) {
                if (inEdges.length) problems.push(P(`节点 ${id} 的必填输入 ${inp.id} 依赖节点 ${inEdges.map(e => e.source).join("/")}，未选入`));
                else problems.push(P(`节点 ${id} 的必填输入 ${inp.id} 未连线且未填值`));
            }
        }
    }

    // 无环：Kahn（两端都在选择内的 data + seq 边都参与定序）
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
    if (done < sel.length) problems.push(P(`存在环依赖: ${sel.filter(id => indeg.get(id) > 0).join(" → ")}`));
    return problems;
}
