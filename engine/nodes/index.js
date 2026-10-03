import inputNodes from "./input.js";
import buildNodes from "./build.js";
import remoteNodes from "./remote.js";
import utilNodes from "./util.js";
import { effectiveInputs, effectiveOutputs } from "../rules.js";

/**
 * 节点类型注册表——引擎与前端共享的唯一事实源。
 * 前端经 GET /api/node-types 拿到元数据（含动态插槽/出口规则），据此渲染节点/插槽/表单。
 */
export const NODE_TYPES = Object.fromEntries(
    [...inputNodes, ...buildNodes, ...remoteNodes, ...utilNodes].map(d => [d.type, d]),
);

/**
 * 某节点实例的有效输入列表 = 声明输入 + 动态输入（规则见 rules.js effectiveInputs，
 * 与前端共用同一实现）。selector 类型准绳按已接入边推导，需要图上下文 + metas。
 * @param {any} node
 * @param {any} [graph] { nodes, edges }
 */
export function getInputs(node, graph) {
    const def = NODE_TYPES[node.type];
    if (!def) throw new Error(`未知节点类型: ${node.type}`);
    return effectiveInputs(def, node.data, { edges: graph?.edges, nodes: graph?.nodes, id: node.id, metas: NODE_TYPES });
}

/**
 * 节点有效输出列表 = 声明输出，或按 dynamicOutputs 规则解析（规则见 rules.js effectiveOutputs）。
 * @param {any} node
 * @param {any} [graph] { nodes, edges }（structSplit/selectorOut 回溯上游需要）
 */
export function getOutputs(node, graph) {
    const def = NODE_TYPES[node.type];
    if (!def) throw new Error(`未知节点类型: ${node.type}`);
    return effectiveOutputs(def, node.data, { edges: graph?.edges, nodes: graph?.nodes, id: node.id, metas: NODE_TYPES });
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
        ...(d.scriptsPicker ? { scriptsPicker: true } : {}),
        ...(d.sshAliasesPicker ? { sshAliasesPicker: true } : {}),
        ...(d.pairInputs ? { pairInputs: d.pairInputs } : {}),
        ...(d.tplVars ? { tplVars: true } : {}),
        ...(d.outputInfer ? { outputInfer: true } : {}),
        ...(d.countInputs ? { countInputs: d.countInputs } : {}),
        ...(d.outputValueKey ? { outputValueKey: d.outputValueKey } : {}),
        ...(d.dynamicInputs ? { dynamicInputs: d.dynamicInputs } : {}),
        ...(d.fieldInputs ? { fieldInputs: true } : {}),
        ...(d.selectorInputs ? { selectorInputs: true } : {}),
        ...(d.dashboardShow ? { dashboardShow: true } : {}),
        ...(d.dynamicOutputs ? { dynamicOutputs: d.dynamicOutputs } : {}),
    }));
}
