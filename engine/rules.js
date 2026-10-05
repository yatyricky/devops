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

/** struct 形状串 → 字段列表 [{key,type}]（字母序，与 structShape 对应）；非形状串返回 null。 */
export function structFieldsFromShape(t) {
    const s = String(t ?? "");
    if (!s.startsWith("struct:{") || !s.endsWith("}")) return null;
    return s.slice("struct:{".length, -1)
        .split(",").filter(Boolean)
        .map(kv => {
            const i = kv.indexOf(":");
            return { key: kv.slice(0, i), type: kv.slice(i + 1) || "string" };
        });
}

/**
 * struct.fromjson 的 json 输入口编辑期字符串推导（纯数据驱动，引擎与前端双端单源）：
 * lit → string.const → select.one（pick 转发）→ struct.split（struct 口透传）。
 * path.resolve/string.join 上游不支持（按不可推导处理——JSON 文本不由此类节点构造）；
 * 不可解/环 → undefined。
 * @param {{edges?: any[], nodes?: any[], id?: string, metas?: any}} env
 * @param {string} nodeId
 * @param {number} [depth]
 * @returns {string | undefined}
 */
export function deriveJsonText(env, nodeId, depth = 0) {
    if (depth > 8) return undefined;
    const node = (env?.nodes ?? []).find(n => n.id === nodeId);
    if (!node) return undefined;
    const selfLit = node.data?.lit?.json;
    if (selfLit !== undefined) return String(selfLit);
    const e = (env?.edges ?? []).find(x => x.kind !== "seq" && !isTunnelEdge(x) && x.target === nodeId && x.targetHandle === "json");
    if (!e) return undefined;
    const src = (env?.nodes ?? []).find(n => n.id === e.source);
    if (!src) return undefined;
    if (src.type === "string.const") return src.data?.value === undefined ? undefined : String(src.data.value);
    if (src.type === "select.one") {
        const pick = src.data?.pick;
        if (!pick) return undefined;
        const pw = (env?.edges ?? []).find(x => x.kind !== "seq" && !isTunnelEdge(x) && x.target === src.id && x.targetHandle === pick);
        if (!pw) return undefined;
        return deriveJsonText(env, pw.source, depth + 1);
    }
    if (src.type === "struct.split") {
        // split 的字段出口 = 其 struct 源的字段：fromjson 的入边 sourceHandle 即字段名。
        // 源是 struct.make 且该字段（string）有字面值 → 值即 JSON 文本；其它 struct 源
        // （selector/fromjson）无字段字面量，不可作为文本提供者 → undefined。
        const sw = (env?.edges ?? []).find(x => x.kind !== "seq" && !isTunnelEdge(x) && x.target === src.id && x.targetHandle === "struct");
        if (!sw) return undefined;
        const make = (env?.nodes ?? []).find(n => n.id === sw.source);
        if (make?.type !== "struct.make") return undefined;
        const f = (make.data?.fields ?? []).find(x => x.key === e.sourceHandle);
        return f && f.type === "string" && f.value !== undefined && f.value !== "" ? String(f.value) : undefined;
    }
    return undefined;
}

/** JSON 文本 → 字段列表 [{key,type}]（primitive 值；解析失败/非对象返回 null）。 */
export function parseJsonFields(text) {
    let obj;
    try { obj = JSON.parse(String(text ?? "")); } catch { return null; }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    return Object.entries(obj)
        .filter(([, v]) => v === null || ["boolean", "number", "string"].includes(typeof v))
        .map(([k, v]) => ({ key: k, type: v === null ? "string" : typeof v }));
}

/**
 * struct.fromjson 的 shape 编辑期问题判定（无问题返回 null）：
 * - 输入可推导（deriveJsonText）：shape 已定义时必须是派生字段的超集（缺失/类型不符报错）；未定义 → null（出口自动派生）
 * - 输入不可推导（运行时数据）：shape 必须定义，否则报错
 * @param {any} node
 * @param {{edges?: any[], nodes?: any[], metas?: any}} env
 * @returns {string | null}
 */
export function fromjsonShapeProblem(node, env = {}) {
    const shape = (node.data?.shape ?? []).filter(f => f.key);
    const text = deriveJsonText(env, node.id);
    if (text === undefined) {
        return shape.length ? null : "输入为运行时数据（JSON 文本不可推导），必须定义 shape";
    }
    let obj;
    try { obj = JSON.parse(text); } catch { return "输入 JSON 无法解析（编辑期派生输入）"; }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return "输入 JSON 顶层必须是对象";
    if (!shape.length) return null; // 可推导且未定义 shape：出口自动派生（1a）
    const jsType = v => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
    for (const [k, v] of Object.entries(obj)) {
        const f = shape.find(s => s.key === k);
        if (!f) return `shape 缺少输入字段 "${k}"（shape 必须是输入 JSON 的超集）`;
        const actual = jsType(v);
        if (f.type !== actual) return `shape 字段 "${k}" 类型不匹配（输入 ${actual}，shape ${f.type}）`;
    }
    return null;
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
 * selector 的类型准绳（in1 派生）：in1 已连线 → 递归推导源出口类型作为 lockType；
 * 未连线/不可解/环超深 → undefined。data.lockType 是历史遗留持久字段，仅作兜底，不再写入。
 * @param {{edges?: any[], nodes?: any[], id?: string, metas?: any, depth?: number}} env
 * @param {number} [depth]
 * @returns {string | undefined}
 */
export function selectorLockType(env, depth = 0) {
    if (depth > 8) return undefined;
    const e = (env?.edges ?? []).find(x => x.kind !== "seq" && !isTunnelEdge(x) && x.target === env?.id && x.targetHandle === "in1");
    if (!e) return undefined;
    const src = (env?.nodes ?? []).find(n => n.id === e.source);
    if (!src) return undefined;
    const srcMeta = (env?.metas ?? {})[src.data?.__type ?? src.type];
    if (!srcMeta) return undefined;
    const outs = effectiveOutputs(srcMeta, src.data, { ...env, id: src.id, depth: depth + 1 });
    return (e.sourceHandle ? outs.find(o => o.id === e.sourceHandle) : outs[0])?.type;
}

/**
 * selector 连线错误态（in1 特殊语义，in1 为类型准绳）：in1 未连线而其余口有连线 → 全部连线错误；
 * in1 已连 → 其余口源类型 ≠ in1 源类型的连线错误（in1 源类型变化时其余口跟随判定，in1 自身永不判错）。
 * @param {{targetHandle: string, srcType: string}[]} wires 该节点全部数据入边（handle + 源出口类型）
 * @returns {string | null} 错误描述；null = 无错误
 */
export function selectorWireProblem(wires) {
    const ws = wires ?? [];
    if (!ws.length) return null;
    const in1 = ws.find(w => w.targetHandle === "in1");
    if (!in1) return "首个输入（in1）未连线：类型未定，其余连线无效";
    if (!in1.srcType) return "in1 源出口类型不可解";
    const bad = ws.filter(w => w.targetHandle !== "in1" && w.srcType !== in1.srcType);
    return bad.length ? `存在类型 ≠ ${in1.srcType} 的输入连线` : null;
}

/**
 * 单条 selector 入边的错误态（边装饰用，per-edge）：in1 是类型准绳——in1 自身的边永不因此判错；
 * 其余口与 in1 源类型不同（或 in1 未连线）→ 该边错误。
 * @param {{targetHandle: string, srcType: string}[]} wires 该 selector 节点全部数据入边
 * @param {string | null} targetHandle 本边的 targetHandle
 * @returns {string | null} 错误描述；null = 无错误
 */
export function selectorEdgeProblem(wires, targetHandle) {
    const ws = wires ?? [];
    if (!ws.length) return null;
    if (targetHandle === "in1") return null;
    const in1 = ws.find(w => w.targetHandle === "in1");
    if (!in1) return "in1 未连线：类型未定";
    const me = ws.find(w => w.targetHandle === targetHandle);
    if (!me) return null; // 本边不可解由其它错误条件（!tInp）兜底
    return me.srcType !== in1.srcType ? `类型 ≠ in1 的 ${in1.srcType}` : null;
}

/**
 * 节点有效输入 = 声明 + 动态。动态机制（按此顺序叠加，后者不覆盖前者同名口）：
 *   countInputs（path.resolve/string.join 等）：控件 key 为整数 N → prefix1..N 同型输入口；
 *   pairInputs（stage.copy）：每行双端口 pN.from / pN.to；
 *   tplVars（template.render）：模板路径可推导 → 各 {{VAR}} string 口；不可推导 → 降级一个 struct 口；
 *   fieldInputs（struct.make）：data.fields 每字段 → 同名同型输入口（连线覆盖手填）；
 *   selectorInputs（select.one）：in1..inN 口（countInputs 生成），类型 = in1 源出口类型（selectorLockType 派生）；
 *   dynamicInputs（文本占位符）：{{name}} → string 口；{{obj.key}} → any 口。
 * @param {any} meta 节点类型定义（注册表条目或 /api/node-types 元数据，二者字段同构）
 * @param {any} data 节点 data
 * @param {{edges?: any[], nodes?: any[], id?: string, metas?: any}} [env] selector 派生 in1 源类型需要图 + metas
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
        // 选择器：in1 永远是类型准绳——全部 in1..inN 口类型 = in1 源出口类型（实时派生，
        // 上游变化即跟随）。有图上下文时纯派生（残留 data.lockType 不得挡新连线）；无图
        // （老调用 getInputs(node)）才允许遗留 lockType 兜底；未连 in1 → any。
        const lockType = selectorLockType(env) ?? (env?.edges ? "any" : data?.lockType) ?? "any";
        for (const p of all) {
            if (/^in\d+$/.test(p.id)) p.type = lockType;
        }
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
 * structSplit：回溯入边上游 struct.make 的字段定义按序输出；上游 selector（in1 接 struct 形状）→ 解析
 * 形状串还原字段（字母序）；其余/未接线 → []。
 * selectorOut：in1 已连（类型准绳派生）→ 单出口 value（in1 源出口类型）；未连 → []。
 * structMake：按 data.fields 输出带形状的 struct 类型串（structShape）。
 * @param {any} meta
 * @param {any} data
 * @param {{edges?: any[], nodes?: any[], id?: string, metas?: any, depth?: number}} [env] structSplit/
 *   selectorOut 回溯上游需要（nodes 的类型键为 type；metas 供递归取源 meta；depth 防环）
 */
export function effectiveOutputs(meta, data, env = {}) {
    if (meta?.dynamicOutputs === "structSplit") {
        if ((env?.depth ?? 0) > 8) return []; // split↔fromjson 等互递归形状链熔断
        const e = (env.edges ?? []).find(x => x.kind !== "seq" && !isTunnelEdge(x) && x.target === env?.id);
        const src = (env.nodes ?? []).find(n => n.id === e?.source);
        // 上游 struct.make：按字段声明序输出
        if (src?.type === "struct.make") {
            return (src.data?.fields ?? []).filter(f => f.key).map(f => ({ id: f.key, type: f.type ?? "string" }));
        }
        // 上游 selector：value 出口类型 = in1 派生 lock（可能是 struct 形状串）→ 解析 canonical 串还原字段（字母序）
        const srcMeta = (env?.metas ?? {})[src?.data?.__type ?? src?.type];
        const lock = srcMeta ? selectorLockType({ ...env, id: src.id }) : undefined;
        const t = (typeof lock === "string" && lock !== "any" ? lock : env?.edges ? undefined : src?.data?.lockType);
        if (typeof t === "string" && t.startsWith("struct:{")) {
            return (structFieldsFromShape(t) ?? []).map(f => ({ id: f.key, type: f.type }));
        }
        // 上游出口列表中有形状串出口（struct.fromjson 等静态声明形状的源）→ 解析为字段出口
        if (srcMeta) {
            const srcOuts = effectiveOutputs(srcMeta, src.data, { ...env, id: src.id, depth: (env?.depth ?? 0) + 1 });
            for (const o of srcOuts) {
                const fs = structFieldsFromShape(o?.type);
                if (fs) return fs.map(f => ({ id: f.key, type: f.type }));
            }
        }
        return [];
    }
    if (meta?.dynamicOutputs === "structMake") {
        // 无字段 = 无出口（无 struct 可供下游消费）
        if (!(data?.fields ?? []).some(f => f.key)) return [];
        return [{ id: "struct", type: structShape(data?.fields) }];
    }
    if (meta?.dynamicOutputs === "fromJsonShape") {
        // shape 已定义 = 契约（出口即形状串）；未定义且输入可推导 → 出口 = 派生字段（1a）；
        // 不可推导且未定义 → 无出口（编辑期 fromjsonShapeProblem 报错）
        const shape = (data?.shape ?? []).filter(f => f.key);
        if (shape.length) return [{ id: "struct", type: structShape(shape) }];
        const fields = deriveJsonText(env, env?.id) !== undefined
            ? parseJsonFields(deriveJsonText(env, env?.id))
            : null;
        return fields ? [{ id: "struct", type: structShape(fields) }] : [];
    }
    if (meta?.dynamicOutputs === "selectorOut") {
        // 有图上下文纯派生；无图（老调用）才允许遗留 lockType 兜底
        const lock = selectorLockType(env, env?.depth ?? 0) ?? (env?.edges ? undefined : data?.lockType);
        return lock ? [{ id: "value", type: lock }] : [];
    }
    if (meta?.dynamicOutputs === "systemdActive") {
        // 仅 is-active 动作有 boolean 出口（active→true / failed→false / 其余→null）；切动作出口自动消失
        return data?.action === "is-active" ? [{ id: "active", type: "boolean" }] : [];
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
