import fs from "fs";
import path from "path";
import { canConnect, coerce, fromjsonShapeProblem, selectorWireProblem } from "./rules.js";
import { validateTaskSelection } from "./rules.js";
import { NODE_TYPES, getInputs, getOutputs } from "./nodes/index.js";
import { tarEntriesProblem } from "./nodes/build.js";

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
 * 保存时骨架校验：只拦「数据损坏/结构坏」的问题（任意语义非法都可保存——不能运行由运行前严格校验拦）。
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
        // 类型未知允许保存（前端渲染红框空卡，运行前严格校验拦截）
        // group = 画布容器（纯前端视觉，引擎不执行）：合法节点类型，仅校验结构
        if (n.type === "group" && n.parentId !== undefined) problems.push(`Group 容器 ${n.id} 不支持嵌套（parentId 应为空）`);
        // 悬空 parentId：父节点不存在 → xyflow 渲染异常，早暴露
        if (n.parentId !== undefined && !doc.nodes.some(p => p.id === n.parentId)) {
            problems.push(`节点 ${n.id} 的 parentId 悬空: ${n.parentId}`);
        }
        if (!Array.isArray(n.position) || n.position.length !== 2) problems.push(`节点 ${n.id} 缺少 position [x,y]`);
        if (!n.data || typeof n.data !== "object") problems.push(`节点 ${n.id} 缺少 data 对象`);
    }

    // 旧版有序 path 静默规范化（含数据依赖闭包）——迁移逻辑保留
    for (const t of Object.values(doc.tasks)) {
        if (!Array.isArray(t.nodes) && Array.isArray(t.path)) {
            t.nodes = closeOverDataEdges(doc, t.path);
            delete t.path;
        }
    }

    // 顺序边 handle 合法性：顺序语义是执行定序数据，坏了属数据损坏（保存时拦截）
    for (const e of doc.edges) {
        if (e.kind === "seq" && (e.sourceHandle !== "__seqOut" || e.targetHandle !== "__seqIn")) {
            problems.push(`顺序边 ${e.id ?? "?"} 的 handle 非法（应为 __seqOut → __seqIn）`);
        }
    }
    return problems;
}

/**
 * 运行前严格校验（runner.enqueueWorkflowTask 与 CLI/GUI 汇聚点调用）：
 * 图级严格项（类型未知/struct 字段/tar 互斥/边端点与 handle/类型兼容）+ 目标任务选点校验。
 * @param {any} doc
 * @param {string} taskName
 * @returns {string[]}
 */
export function validateTaskRunnable(doc, taskName) {
    /** @type {string[]} */
    const problems = [];
    if (!doc || typeof doc !== "object") return ["文档不是对象"];
    if (!Array.isArray(doc.nodes) || !Array.isArray(doc.edges) || !doc.tasks || typeof doc.tasks !== "object") {
        return ["文档结构不完整"];
    }
    const task = doc.tasks?.[taskName];
    if (!task) return [`task not found: ${taskName}`];

    const nodeById = new Map(doc.nodes.filter(n => n?.id).map(n => [n.id, n]));
    // 全部「节点配置/语义」检查只对目标任务选点内的节点生效——
    // 画布上未配置的半成品节点（包括未知类型）不应阻塞无关任务的运行
    const inTask = new Set(task.nodes ?? []);
    for (const n of doc.nodes) {
        if (!n?.id || !inTask.has(n.id)) continue;
        if (!NODE_TYPES[n.type]) { problems.push(`节点 ${n.id} 类型未知: ${n.type}（无法运行）`); continue; }
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
            const problem = tarEntriesProblem(n);
            if (problem) problems.push(`节点 ${n.id}：${problem}`);
        }
        // selector：in1 为类型准绳（in1 未连而其余口有线 / 源类型 ≠ in1 源类型 → 错误）——仅任务选点内的节点
        if (n.type === "select.one" && inTask.has(n.id)) {
            const wires = doc.edges
                .filter(e => e.kind !== "seq" && e.target === n.id)
                .map(e => {
                    const s = nodeById.get(e.source);
                    const outs = s ? getOutputs(s, doc) : [];
                    const o = e.sourceHandle ? outs.find(x => x.id === e.sourceHandle) : outs[0];
                    return { targetHandle: e.targetHandle, srcType: o?.type ?? "unknown" };
                });
            const problem = selectorWireProblem(wires);
            if (problem) problems.push(`节点 ${n.id}：${problem}`);
        }
        // struct.fromjson：shape 编辑期问题（运行时输入无 shape / shape ⊉ 派生输入）——仅任务选点内的节点
        if (n.type === "struct.fromjson" && inTask.has(n.id)) {
            const problem = fromjsonShapeProblem(n, { edges: doc.edges, nodes: doc.nodes, metas: NODE_TYPES });
            if (problem) problems.push(`节点 ${n.id}：${problem}`);
        }
    }

    // 边校验：端点存在 / seq handle / handle 存在 / 类型兼容——
    // 仅任务选点内的边（两端都在选点内）：一端在任务外的边不阻塞本任务
    for (const e of doc.edges) {
        if (!nodeById.has(e.source) || !nodeById.has(e.target)) {
            problems.push(`边 ${e.id ?? "?"} 端点不存在: ${e.source} → ${e.target}`);
            continue;
        }
        if (!inTask.has(e.source) || !inTask.has(e.target)) continue;
        if (e.kind === "seq") {
            if (e.sourceHandle !== "__seqOut" || e.targetHandle !== "__seqIn") {
                problems.push(`顺序边 ${e.id ?? "?"} 的 handle 非法（应为 __seqOut → __seqIn）`);
            }
            continue;
        }
        const src = nodeById.get(e.source), tgt = nodeById.get(e.target);
        try {
            const outs = getOutputs(src, doc);
            const inps = getInputs(tgt, doc); // selector 专用口按已接入边推导，缺图会被误判 handle 不存在
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

    // 目标任务：选点校验（required 闭包 / 插槽唯一 / 无环）+ 引用完整性
    problems.push(...validateTaskSelection(task.nodes ?? [], doc.edges, nodeById, NODE_TYPES, { taskName }));
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
        // group = 画布容器（纯前端），不应出现在任务路径；防御性跳过
        if (node.type === "group") return {};
        const def = NODE_TYPES[node.type];
        /** @type {Record<string, any>} */
        const inputValues = {};
        for (const e of incoming.get(id) ?? []) {
            if (e.kind === "seq" || !e.sourceHandle) continue;
            const srcNode = nodeById.get(e.source);
            const outDef = getOutputs(srcNode, doc).find(o => o.id === e.sourceHandle);
            inputValues[e.targetHandle] = coerce(executed.get(e.source)?.[e.sourceHandle], declaredType(node, doc, e.targetHandle) ?? outDef?.type ?? "any");
        }
        // 端口字面量兜底：未连线的 string/number/boolean 输入用 data.lit 的值（连线优先）
        for (const inp of getInputs(node, doc)) {
            if (inp.fromField || !(["string", "number", "boolean"].includes(inp.type))) continue;
            if (inputValues[inp.id] === undefined && node.data?.lit?.[inp.id] !== undefined) {
                inputValues[inp.id] = coerce(node.data.lit[inp.id], inp.type);
            }
        }
        ctx.markNodeInputs?.(id, inputValues);
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
 * @param {any} doc
 * @param {string} handleId
 */
function declaredType(node, doc, handleId) {
    for (const i of getInputs(node, doc)) {
        if (i.id === handleId) return i.type;
    }
    return undefined;
}
