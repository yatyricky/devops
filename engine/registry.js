import fs from "fs";
import path from "path";
import { ROOT } from "./runner.js";
import { loadWorkflow } from "./workflow.js";
import { loadLocalConfig, forgetWorkflow } from "./config.js";

/**
 * 工作流注册中心：
 * - workflow.json 可放磁盘任意位置——local-config.json 的 workflows[] 记录最近打开/另存的路径；
 * - 仓库自带 workflows/*.json 始终可见（示例与随仓库版本管理的工作流）；
 * - 最近打开在前，按绝对路径去重。
 * - 历史条目失效（路径不存在 / 文件损坏）时自动从历史移除，不拖累列表。
 */

/**
 * 加载全部工作流；单个失败不拖垮整体。
 * 历史里的失效路径 / 损坏文件直接从历史移除（不删文件本身）；
 * 仓库目录扫描发现的文件不属于"历史"，损坏时不动文件。
 * @returns {{ path: string, doc?: any, error?: string }[]}
 */
export function loadWorkflows() {
    const dir = path.join(ROOT, "workflows");
    const ships = fs.existsSync(dir)
        ? fs.readdirSync(dir)
            .filter(f => f.endsWith(".json") && !f.startsWith("_") && !f.endsWith(".example.json"))
            .map(f => path.resolve(dir, f))
        : [];
    const opened = (loadLocalConfig().workflows ?? []).map(p => path.resolve(p));
    /** @type {(fp: string) => { path: string, doc?: any, error?: string }} */
    const load = fp => {
        try { return { path: fp, doc: loadWorkflow(fp) }; }
        catch (e) { return { path: fp, error: e.message }; }
    };

    const openedRows = opened.map(load);
    // 失效路径 / 损坏文件 → 从历史移除（forgetWorkflow 写回 local-config）
    const broken = openedRows.filter(r => r.error).map(r => r.path);
    if (broken.length) for (const p of broken) forgetWorkflow(p);

    const shipRows = ships.filter(fp => !opened.includes(fp)).map(load);
    return [...openedRows.filter(r => !r.error), ...shipRows];
}

/**
 * @param {string} nameOrPath 工作流路径，或显示名（title / 文件名，加载时回填到 doc.name）
 * @returns {{ path: string, doc: any }}
 */
export function findWorkflow(nameOrPath) {
    const candidates = loadWorkflows().filter(w => w.doc);
    const byPath = candidates.find(w => path.resolve(w.path) === path.resolve(nameOrPath));
    if (byPath) return byPath;
    const byName = candidates.filter(w => w.doc.name === nameOrPath);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`同名工作流多个，请用路径指定：${byName.map(w => w.path).join(", ")}`);
    throw new Error(`工作流未找到: ${nameOrPath}（node cli.js list 查看）`);
}
