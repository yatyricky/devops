import fs from "fs";
import path from "path";
import { canConnect, coerce } from "./types.js";
import { NODE_TYPES, getInputs, getOutputs } from "./nodes/index.js";

/**
 * workflow.json = 一张节点大图（nodes + edges，元图允许多条备选连线进同一输入）+ 若干命名任务。
 * 任务 = 从大图中选出的节点集合（顺序无关），集合 + 两端都在集合内的边构成 1 个或多个 DAG。
 *
 * 任务子图构成规则：
 * - data 边指向 required 输入槽（含动态插槽）：源必须已选，否则闭包错误；
 * - data 边指向非 required 输入槽：源未选时静默丢弃（该输入在此任务中视作未连线）；
 * - seq 边：源或目标未选时静默丢弃；两端都在则携带并参与定序。
 *
 * 任务级校验（对子图）：
 * - 插槽唯一：每个输入槽最多 1 条携带边（歧义即错误）；
 * - required 覆盖：required 输入必须恰好 1 条（0 条 = 图上没画线）；
 * - 无环：Kahn 拓扑（data + seq 携带边都参与定序）。
 *
 * 执行语义：拓扑层级并发——入度 0 的节点并发一批，完成后释放下一层；
 * 任一节点失败，本批全部落地后抛错终止（在途副作用由 runner finalize 收尾）。
 */

/**
 * @param {string} fp
 * @returns {any} workflow 文档（校验通过）
 * @throws 加载/结构/类型错误（一次汇总抛出）
 */
export function loadWorkflow(fp) {
    if (!fs.existsSync(fp)) throw new Error(`workflow 文件不存在: ${fp}`);
    /** @type {any} */
    let doc;
    try {
        doc = JSON.parse(fs.readFileSync(fp, "utf8"));
    } catch (e) {
        throw new Error(`workflow JSON 解析失败 ${fp}: ${e.message}`);
    }
    const problems = validateWorkflow(doc);
    if (problems.length) throw new Error(`workflow 校验失败 ${path.basename(fp)}:\n  - ${problems.join("\n  - ")}`);
    // 工作流没有独立的名字概念：显示身份 = title（别名），缺省用文件名。回填 name 供审计/门禁/CLI 统一引用。
    doc.name = doc.title || path.basename(fp, ".json");
    return doc;
}

/**
 * 旧版有序 path → 节点集合：补齐数据依赖闭包。
 * 旧执行器会自动先执行侧挂的数据依赖节点（required 与 optional 都会），忠实迁移 = 全部补入。
 * @param {any} doc
 * @param {string[]} ids
 */
function closeOverDataEdges(doc, ids) {
    const selected = new Set(ids);
    let changed = true;
    while (changed) {
        changed = false;
        for (const e of doc.edges) {
            if (e.kind !== "seq" && selected.has(e.target) && !selected.has(e.source)) {
                selected.add(e.source);
                changed = true;
            }
        }
    }
    return [...selected];
}

/**
 * @param {any} doc
 * @returns {string[]}
 */
export function validateWorkflow(doc) {
    /** @type {string[]} */
    const problems = [];
    if (!doc || typeof doc !== "object") return ["文档不是对象"];
    if (!Array.isArray(doc.nodes)) problems.push("缺少 nodes 数组");
    if (!Array.isArray(doc.edges)) problems.push("缺少 edges 数组");
    if (!doc.tasks || typeof doc.tasks !== "object") problems.push("缺少 tasks 对象");
    if (problems.length) return problems;
    if (doc.repoDir && typeof doc.repoDir !== "string") problems.push("repoDir 必须是字符串");

    const ids = new Set();
    for (const n of doc.nodes) {
        if (!n?.id) { problems.push(`节点缺少 id: ${JSON.stringify(n)?.slice(0, 60)}`); continue; }
        if (ids.has(n.id)) problems.push(`节点 id 重复: ${n.id}`);
        ids.add(n.id);
        if (!NODE_TYPES[n.type]) problems.push(`节点 ${n.id} 类型未知: ${n.type}`);
        if (!Array.isArray(n.position) || n.position.length !== 2) problems.push(`节点 ${n.id} 缺少 position [x,y]`);
        if (!n.data || typeof n.data !== "object") problems.push(`节点 ${n.id} 缺少 data 对象`);
        // struct.make：字段定义合法性（key 供插槽/占位符使用，须为 \w 且唯一）
        if (n.type === "struct.make" && Array.isArray(n.data.fields)) {
            const seenKeys = new Set();
            for (const f of n.data.fields) {
                if (!f?.key || !/^\w+$/.test(f.key)) {
                    problems.push(`节点 ${n.id}：字段 key 非法（需非空 \\w）: ${JSON.stringify(f?.key ?? "")}`);
                } else if (seenKeys.has(f.key)) {
                    problems.push(`节点 ${n.id}：字段 key 重复: ${f.key}`);
                } else {
                    seenKeys.add(f.key);
                }
                if (!["string", "number", "boolean"].includes(f?.type)) {
                    problems.push(`节点 ${n.id}：字段 ${f?.key ?? "?"} 类型非法: ${f?.type}（可用 string/number/boolean）`);
                }
            }
        }
        // tar.pack：白名单与黑名单互斥
        if (n.type === "tar.pack") {
            const hasEntries = Array.isArray(n.data.entries) && n.data.entries.length > 0;
            const hasExcludes = Array.isArray(n.data.excludes) && n.data.excludes.length > 0;
            if (hasEntries && hasExcludes) {
                problems.push(`节点 ${n.id}：打包条目与不打包条目只能二选一（白名单或黑名单）`);
            }
        }
    }

    const nodeById = new Map(doc.nodes.filter(n => n?.id).map(n => [n.id, n]));
    for (const e of doc.edges) {
        if (!ids.has(e.source) || !ids.has(e.target)) {
            problems.push(`边 ${e.id ?? "?"} 端点不存在: ${e.source} → ${e.target}`);
            continue;
        }
        // 顺序边：无数据类型语义，仅校验保留 handle
        if (e.kind === "seq") {
            if (e.sourceHandle !== "__seqOut" || e.targetHandle !== "__seqIn") {
                problems.push(`顺序边 ${e.id ?? "?"} 的 handle 非法（应为 __seqOut → __seqIn）`);
            }
            continue;
        }
        const src = nodeById.get(e.source), tgt = nodeById.get(e.target);
        try {
            const outs = getOutputs(src, doc);
            const inps = getInputs(tgt);
            const out = e.sourceHandle ? outs.find(o => o.id === e.sourceHandle) : outs[0];
            const inp = e.targetHandle ? inps.find(i => i.id === e.targetHandle) : inps[0];
            if (!out) { problems.push(`边 ${e.id ?? "?"} 的 sourceHandle 不存在: ${e.source}.${e.sourceHandle}`); continue; }
            if (!inp) { problems.push(`边 ${e.id ?? "?"} 的 targetHandle 不存在: ${e.target}.${e.targetHandle}`); continue; }
            if (!canConnect(out.type, inp.type)) {
                problems.push(`边 ${e.id ?? "?"} 类型不兼容: ${out.type}(${e.source}.${out.id}) → ${inp.type}(${e.target}.${inp.id})`);
            }
        } catch (err) {
            problems.push(`边 ${e.id ?? "?"} 校验出错: ${err.message}`);
        }
    }
    // 注意：元图允许同一输入接多条备选连线（不同任务各取其一）；唯一性在任务级校验。

    // ── 任务：子图选点（顺序无关；旧版有序 path 静默规范化，含数据依赖闭包）────
    for (const [name, t] of Object.entries(doc.tasks)) {
        if (!Array.isArray(t.nodes) && Array.isArray(t.path)) {
            t.nodes = closeOverDataEdges(doc, t.path);
            delete t.path;
        }
        if (!Array.isArray(t.nodes) || !t.nodes.length) { problems.push(`任务 ${name} 缺少 nodes`); continue; }
        for (const id of t.nodes) {
            if (!ids.has(id)) problems.push(`任务 ${name} 引用不存在的节点: ${id}`);
        }
        const dups = t.nodes.filter((v, i) => t.nodes.indexOf(v) !== i);
        if (dups.length) problems.push(`任务 ${name} 节点重复: ${[...new Set(dups)].join(", ")}`);
        if (t.mutates === undefined) problems.push(`任务 ${name} 缺少 mutates 标记`);
        if (t.label === undefined) problems.push(`任务 ${name} 缺少 label`);
        if (dups.length || t.nodes.some(id => !ids.has(id))) continue;

        const selected = new Set(t.nodes);

        // 逐插槽统计任务内携带边；required 闭包/覆盖在此一并判定
        for (const id of t.nodes) {
            const node = nodeById.get(id);
            let ins;
            try { ins = getInputs(node); } catch { continue; } // 未知类型已在节点段报过
            for (const inp of ins) {
                const inEdges = doc.edges.filter(e => e.kind !== "seq" && e.target === id && e.targetHandle === inp.id);
                const carriedCnt = inEdges.filter(e => selected.has(e.source)).length;
                if (carriedCnt >= 2) {
                    problems.push(`任务 ${name}：输入 ${id}.${inp.id} 有 ${carriedCnt} 条连线，只能有一个输入`);
                } else if (inp.required && carriedCnt === 0) {
                    if (inEdges.length > 0) {
                        problems.push(`任务 ${name}：节点 ${id} 的必填输入 ${inp.id} 依赖节点 ${inEdges.map(e => e.source).join("/")}，未选入`);
                    } else {
                        problems.push(`任务 ${name}：节点 ${id} 的必填输入 ${inp.id} 未连线`);
                    }
                }
            }
        }

        // 无环：Kahn 拓扑（两端都在选择内的 data + seq 边都参与定序）
        const carriedEdges = doc.edges.filter(e => selected.has(e.source) && selected.has(e.target));
        const indeg = new Map(t.nodes.map(id => [id, 0]));
        const adj = new Map(t.nodes.map(id => [id, []]));
        for (const e of carriedEdges) {
            adj.get(e.source).push(e.target);
            indeg.set(e.target, /** @type {number} */ (indeg.get(e.target)) + 1);
        }
        let frontier = t.nodes.filter(id => indeg.get(id) === 0);
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
        if (done < t.nodes.length) {
            problems.push(`任务 ${name} 存在环依赖: ${t.nodes.filter(id => indeg.get(id) > 0).join(" → ")}`);
        }
    }
    return problems;
}

/**
 * 任务选中节点的 SERVER_TYPE（prod 门禁用；来自 struct 构造器的 SERVER_TYPE 字段，
 * 宽松——没定义或取不到返回 null）。
 * @param {any} doc
 * @param {string} taskName
 */
export function findTaskEnv(doc, taskName) {
    const task = doc.tasks?.[taskName];
    if (!task) return null;
    for (const id of task.nodes ?? task.path ?? []) {
        const node = doc.nodes.find(n => n.id === id);
        if (node?.type !== "struct.make") continue;
        const st = (node.data?.fields ?? []).find(f => f.key === "SERVER_TYPE");
        if (st === undefined) continue;
        /** @type {Record<string, any>} */
        const env = {};
        for (const f of node.data.fields) env[f.key] = f.value;
        return env;
    }
    return null;
}

/**
 * 执行任务：子图拓扑层级并发调度。
 * @param {any} ctx 执行上下文（runner 构造）：log/dryRun/inputs/mask/configDir/repoDir
 *               + registerGitRestore/registerSession/trackRemoteFile
 * @param {any} doc workflow 文档
 * @param {string} taskName
 */
export async function executeTask(ctx, doc, taskName) {
    const task = doc.tasks?.[taskName];
    if (!task) throw new Error(`任务不存在: ${taskName}`);
    const selected = new Set(task.nodes ?? task.path ?? []);
    const nodeById = new Map(doc.nodes.map(n => [n.id, n]));

    // 任务子图携带边：两端都在选择内（校验在 load/validate 已做，这里按构成直接执行）
    const incoming = new Map(); // nodeId → 携带边[]
    for (const e of doc.edges) {
        if (!selected.has(e.source) || !selected.has(e.target)) continue;
        if (!incoming.has(e.target)) incoming.set(e.target, []);
        /** @type {any[]} */ (incoming.get(e.target)).push(e);
    }

    /** @type {Map<string, any>} */
    const executed = new Map();
    const pending = new Set(selected);

    /**
     * 解析输入（仅 data 边）并执行单个节点。
     * @param {string} id
     */
    async function runNode(id) {
        const node = nodeById.get(id);
        if (!node) throw new Error(`节点不存在: ${id}`);
        const def = NODE_TYPES[node.type];
        /** @type {Record<string, any>} */
        const inputValues = {};
        for (const e of incoming.get(id) ?? []) {
            if (e.kind === "seq" || !e.sourceHandle) continue;
            const srcNode = nodeById.get(e.source);
            const outDef = getOutputs(srcNode, doc).find(o => o.id === e.sourceHandle);
            inputValues[e.targetHandle] = coerce(executed.get(e.source)?.[e.sourceHandle], declaredType(node, e.targetHandle) ?? outDef?.type ?? "any");
        }
        ctx.log(`──── [${def.title}] ${node.id}`);
        ctx.markNode?.(id, "running");
        try {
            const out = (await def.run(ctx, node, inputValues)) ?? {};
            executed.set(id, out);
            ctx.markNode?.(id, "ok");
        } catch (e) {
            ctx.markNode?.(id, "failed");
            throw e;
        }
    }

    while (pending.size) {
        // 本批：所有入边源都已执行（data + seq 都参与定序）
        const ready = [...pending].filter(id => (incoming.get(id) ?? []).every(e => executed.has(e.source)));
        if (!ready.length) throw new Error(`任务 ${taskName} 存在环依赖: ${[...pending].join(", ")}`);
        ctx.log(`──── 批次并发 ${ready.length}：${ready.join(", ")}`);
        const results = await Promise.allSettled(ready.map(id => runNode(id)));
        // 本批已全部落地（allSettled），任一失败则终止——在途副作用由 runner finalize 收尾
        const failed = results.find(r => r.status === "rejected");
        if (failed) throw failed.reason;
        for (const id of ready) pending.delete(id);
    }
}

/**
 * @param {any} node
 * @param {string} handleId
 */
function declaredType(node, handleId) {
    for (const i of getInputs(node)) {
        if (i.id === handleId) return i.type;
    }
    return undefined;
}
