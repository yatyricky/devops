import fs from "fs";
import path from "path";
import inputNodes from "./input.js";
import buildNodes from "./build.js";
import remoteNodes from "./remote.js";
import utilNodes from "./util.js";
import { expandHome } from "../exec.js";

/**
 * 节点类型注册表——引擎与前端共享的唯一事实源。
 * 前端经 GET /api/node-types 拿到元数据（含动态插槽/出口规则），据此渲染节点/插槽/表单。
 */
export const NODE_TYPES = Object.fromEntries(
    [...inputNodes, ...buildNodes, ...remoteNodes, ...utilNodes].map(d => [d.type, d]),
);

/**
 * 某节点实例的有效输入列表 = 声明输入 + 动态输入。
 * 动态输入来源：
 *   fieldInputs（struct.make）：data.fields 的每个字段 → 同名同型输入口（值可连线覆盖手填）；
 *   dynamicInputs（文本占位符）：
 *   {{name}}     → 名为 name 的 string 输入插槽（值整个来自连线）
 *   {{obj.key}}  → 名为 obj 的 any 输入插槽（对象经连线传入，执行时按键取值）
 * @param {any} node
 * @returns {{id: string, type: string, required: boolean, dynamic: boolean}[]}
 */
export function getInputs(node) {
    const def = NODE_TYPES[node.type];
    if (!def) throw new Error(`未知节点类型: ${node.type}`);
    const declared = (def.inputs ?? []).map(i => ({ ...i, dynamic: false }));
    /** @type {any[]} */
    let all = declared;
    if (def.fieldInputs) {
        const fieldPorts = (node.data?.fields ?? [])
            .filter(f => f.key && !declared.some(d => d.id === f.key))
            .map(f => ({ id: f.key, type: f.type ?? "string", required: false, dynamic: true }));
        all = [...declared, ...fieldPorts];
    }
    if (!def.dynamicInputs) return all;
    const text = String(node.data?.[def.dynamicInputs.source] ?? "");
    /** @type {Map<string, string>} id → 类型 */
    const dyn = new Map();
    for (const m of text.matchAll(/\{\{(\w+)(?:\.(\w+))?\}\}/g)) {
        if (m[2]) dyn.set(m[1], "any");
        else dyn.set(m[1], def.dynamicInputs.type);
    }
    const dynamic = [...dyn.entries()]
        .filter(([id]) => !all.some(i => i.id === id))
        .map(([id, type]) => ({ id, type, required: true, dynamic: true }));
    return [...all, ...dynamic];
}

/** 动态出口规则：按节点 data 与图上下文解析输出插槽（前端 types.js 有同规则镜像）。 */
const DYNAMIC_OUTPUTS = {
    /** fs.path：合法文件夹 → [dir]，合法文件 → [file]，未配置/不存在 → []。 */
    fsPath(node) {
        const typed = String(node.data?.path ?? "").trim();
        if (!typed) return [];
        let st;
        try { st = fs.statSync(path.resolve(expandHome(typed))); } catch { return []; }
        return st.isDirectory()
            ? [{ id: "dir", type: "folder" }]
            : [{ id: "file", type: "file" }];
    },
    /** struct.split：回溯入边的上游 struct.make 字段定义，按序输出同名字段；未接线 → []。 */
    structSplit(node, graph) {
        const edge = (graph?.edges ?? []).find(e => e.kind !== "seq" && e.target === node.id);
        const src = edge ? (graph?.nodes ?? []).find(n => n.id === edge.source) : null;
        if (src?.type !== "struct.make") return [];
        return (src.data?.fields ?? [])
            .filter(f => f.key)
            .map(f => ({ id: f.key, type: f.type ?? "string" }));
    },
};

/**
 * 节点有效输出列表 = 声明输出，或按 dynamicOutputs 规则解析的动态输出。
 * @param {any} node
 * @param {any} [graph] { nodes, edges }（structSplit 回溯上游需要）
 */
export function getOutputs(node, graph) {
    const def = NODE_TYPES[node.type];
    if (!def) throw new Error(`未知节点类型: ${node.type}`);
    if (def.dynamicOutputs) return /** @type {any} */ (DYNAMIC_OUTPUTS)[def.dynamicOutputs](node, graph);
    return def.outputs ?? [];
}

/**
 * 节点元数据（下发前端）：不含 run。
 */
export function nodeTypesMeta() {
    return Object.values(NODE_TYPES).map(d => ({
        type: d.type,
        title: d.title,
        desc: d.desc,
        category: d.category,
        color: d.color,
        inputs: d.inputs ?? [],
        outputs: d.outputs ?? [],
        widgets: d.widgets ?? [],
        ...(d.pathStat ? { pathStat: true } : {}),
        ...(d.refsPicker ? { refsPicker: true } : {}),
        ...(d.outputValueKey ? { outputValueKey: d.outputValueKey } : {}),
        ...(d.dynamicInputs ? { dynamicInputs: d.dynamicInputs } : {}),
        ...(d.fieldInputs ? { fieldInputs: true } : {}),
        ...(d.dynamicOutputs ? { dynamicOutputs: d.dynamicOutputs } : {}),
    }));
}
