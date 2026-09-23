import fs from "fs";
import path from "path";
import { canConnect, coerce } from "./types.js";
import { NODE_TYPES, getInputs, getOutputs } from "./nodes/index.js";
import { loadEnv, rawParse } from "./env.js";
import { ENVS_DIR } from "./runner.js";

/**
 * workflow.json = 一张节点图（nodes + edges）+ 若干命名任务（tasks）。
 * 每个任务 = 图中一条有序路径（用户示例：deploy = 1→2→3，rollback = 4→3，preview = 1→2→5）。
 *
 * 执行语义：
 * - 主路径节点按数组顺序执行（顺序即副作用顺序；相邻节点不强制有边——纯顺序相邻如 deps→symlink 合法）；
 * - 节点输入经连线解析：来源是"已执行"节点——主路径中更早的节点，或其依赖闭包自动先执行的侧挂节点
 *   （field.get/string.format 等 helper 从侧挂取值汇入主链）；
 * - 输入若依赖主路径中更晚的节点 → 报错；环依赖 → 报错；
 * - 顺序边（kind:"seq"，handle __seqOut→__seqIn）不是执行驱动，是顺序约束：同任务路径内两端必须保序（校验拦截）。
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
    return doc;
}

/**
 * @param {any} doc
 * @returns {string[]}
 */
export function validateWorkflow(doc) {
    /** @type {string[]} */
    const problems = [];
    if (!doc || typeof doc !== "object") return ["文档不是对象"];
    if (!doc.name) problems.push("缺少 name");
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
            const outs = getOutputs(src);
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

    // 同一输入多条边（一个插槽只接一条线）；顺序边无插槽语义，不参与
    const seen = new Set();
    for (const e of doc.edges) {
        if (e.kind === "seq" || !e.targetHandle) continue;
        const k = `${e.target}.${e.targetHandle}`;
        if (seen.has(k)) problems.push(`输入 ${k} 接了多条连线`);
        seen.add(k);
    }

    for (const [name, t] of Object.entries(doc.tasks)) {
        if (!Array.isArray(t.path) || !t.path.length) { problems.push(`任务 ${name} 缺少 path`); continue; }
        for (const id of t.path) {
            if (!ids.has(id)) problems.push(`任务 ${name} 引用不存在的节点: ${id}`);
        }
        const dups = t.path.filter((v, i) => t.path.indexOf(v) !== i);
        if (dups.length) problems.push(`任务 ${name} 路径含重复节点: ${[...new Set(dups)].join(", ")}`);
        if (t.mutates === undefined) problems.push(`任务 ${name} 缺少 mutates 标记`);
        if (t.label === undefined) problems.push(`任务 ${name} 缺少 label`);
    }

    // 顺序边与任务路径顺序一致性：同路径内源必须早于目标
    for (const e of doc.edges) {
        if (e.kind !== "seq") continue;
        for (const [name, t] of Object.entries(doc.tasks)) {
            if (!Array.isArray(t.path)) continue;
            const si = t.path.indexOf(e.source), ti = t.path.indexOf(e.target);
            if (si !== -1 && ti !== -1 && si > ti) {
                problems.push(`顺序边 ${e.source} → ${e.target} 与任务 ${name} 的路径顺序矛盾（位置 ${si} → ${ti}）`);
            }
        }
    }
    return problems;
}

/**
 * 任务路径上的 env（prod 门禁用；宽松——env 文件缺失/校验失败返回 null）。
 * @param {any} doc
 * @param {string} taskName
 */
export function findTaskEnv(doc, taskName) {
    const task = doc.tasks?.[taskName];
    if (!task) return null;
    for (const id of task.path) {
        const node = doc.nodes.find(n => n.id === id);
        if (node?.type !== "env.file" || !node.data?.envFile) continue;
        try {
            const fp = path.isAbsolute(node.data.envFile) ? node.data.envFile : path.join(ENVS_DIR, node.data.envFile);
            if (node.data.schema && Object.keys(node.data.schema).length) return loadEnv(fp, node.data.schema);
            return rawParse(fs.readFileSync(fp, "utf8"));
        } catch { /* 宽松：门禁拿不到就当未知 */ }
    }
    return null;
}

/**
 * 执行任务路径。
 * @param {any} ctx 执行上下文（runner 构造）：log/dryRun/inputs/mask/configDir/repoDir
 *               + registerGitRestore/registerSession/trackRemoteFile
 * @param {any} doc workflow 文档
 * @param {string} taskName
 */
export async function executeTask(ctx, doc, taskName) {
    const task = doc.tasks?.[taskName];
    if (!task) throw new Error(`任务不存在: ${taskName}`);
    const nodeById = new Map(doc.nodes.map(n => [n.id, n]));
    const incoming = new Map(); // nodeId → edge[]
    for (const e of doc.edges) {
        if (!incoming.has(e.target)) incoming.set(e.target, []);
        incoming.get(e.target).push(e);
    }
    const pos = new Map(task.path.map((id, i) => [id, i]));

    /** @type {Map<string, any>} */
    const executed = new Map();
    /** @type {Set<string>} */
    const visiting = new Set();

    /**
     * @param {string} id
     * @param {number} maxPathPos 主路径位置上限（防前向依赖）
     */
    async function ensureNode(id, maxPathPos) {
        if (executed.has(id)) return executed.get(id);
        if (visiting.has(id)) throw new Error(`依赖环: ${[...visiting, id].join(" → ")}`);
        const node = nodeById.get(id);
        if (!node) throw new Error(`节点不存在: ${id}`);
        if (pos.has(id) && pos.get(id) > maxPathPos) {
            throw new Error(`节点 ${id} 的输入依赖主路径中更晚的节点（任务 ${taskName} 位置 ${pos.get(id)}）`);
        }
        visiting.add(id);
        try {
            const def = NODE_TYPES[node.type];
            /** @type {Record<string, any>} */
            const inputValues = {};
            for (const e of incoming.get(id) ?? []) {
                const sourceOut = await ensureNode(e.source, pos.has(id) ? pos.get(id) : Number.MAX_SAFE_INTEGER);
                if (!e.sourceHandle) continue;
                const srcNode = nodeById.get(e.source);
                const outDef = getOutputs(srcNode).find(o => o.id === e.sourceHandle);
                inputValues[e.targetHandle] = coerce(sourceOut[e.sourceHandle], declaredType(node, e.targetHandle) ?? outDef?.type ?? "any");
            }
            ctx.log(`──── [${def.title}] ${node.id}`);
            const out = (await def.run(ctx, node, inputValues)) ?? {};
            executed.set(id, out);
            return out;
        } finally {
            visiting.delete(id);
        }
    }

    for (let i = 0; i < task.path.length; i++) {
        await ensureNode(task.path[i], i);
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
