import inputNodes from "./input.js";
import buildNodes from "./build.js";
import remoteNodes from "./remote.js";
import utilNodes from "./util.js";

/**
 * 节点类型注册表——引擎与前端共享的唯一事实源。
 * 前端经 GET /api/node-types 拿到元数据（含动态插槽规则），据此渲染节点/插槽/检查器表单。
 */
export const NODE_TYPES = Object.fromEntries(
    [...inputNodes, ...buildNodes, ...remoteNodes, ...utilNodes].map(d => [d.type, d]),
);

/**
 * 某节点实例的有效输入列表 = 声明输入 + 动态输入。
 * 动态输入由 widget 文本里的占位符生成：
 *   {{name}}     → 名为 name 的 string 输入插槽（值整个来自连线）
 *   {{obj.key}}  → 名为 obj 的 any 输入插槽（对象经连线传入，执行时按键取值）
 * @param {any} node
 * @returns {{id: string, type: string, required: boolean, dynamic: boolean}[]}
 */
export function getInputs(node) {
    const def = NODE_TYPES[node.type];
    if (!def) throw new Error(`未知节点类型: ${node.type}`);
    const declared = (def.inputs ?? []).map(i => ({ ...i, dynamic: false }));
    if (!def.dynamicInputs) return declared;
    const text = String(node.data?.[def.dynamicInputs.source] ?? "");
    /** @type {Map<string, string>} id → 类型 */
    const dyn = new Map();
    for (const m of text.matchAll(/\{\{(\w+)(?:\.(\w+))?\}\}/g)) {
        if (m[2]) dyn.set(m[1], "any");
        else dyn.set(m[1], def.dynamicInputs.type);
    }
    const dynamic = [...dyn.entries()]
        .filter(([id]) => !declared.some(i => i.id === id))
        .map(([id, type]) => ({ id, type, required: true, dynamic: true }));
    return [...declared, ...dynamic];
}

/**
 * @param {any} node
 */
export function getOutputs(node) {
    const def = NODE_TYPES[node.type];
    if (!def) throw new Error(`未知节点类型: ${node.type}`);
    return def.outputs ?? [];
}

/**
 * 节点元数据（下发前端）：不含 run。
 */
export function nodeTypesMeta() {
    return Object.values(NODE_TYPES).map(d => ({
        type: d.type,
        title: d.title,
        category: d.category,
        color: d.color,
        inputs: d.inputs ?? [],
        outputs: d.outputs ?? [],
        widgets: d.widgets ?? [],
        ...(d.dynamicInputs ? { dynamicInputs: d.dynamicInputs } : {}),
    }));
}
