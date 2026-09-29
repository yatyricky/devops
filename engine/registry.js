import fs from "fs";
import path from "path";
import { ROOT } from "./runner.js";
import { loadWorkflow } from "./workflow.js";
import { loadLocalConfig, forgetWorkflow } from "./config.js";
import { expandHome } from "./exec.js";

/** `~/x` 与绝对路径统一为可比对/可加载的绝对路径。 */
function normalizePath(p) {
    return path.resolve(expandHome(String(p)));
}

/**
 * 工作流注册中心：
 * - workflow.json 可放磁盘任意位置——local-config.json 的 workflows[] 记录最近打开/另存的路径；
 * - 仓库自带 workflows/*.json 始终可见（示例与随仓库版本管理的工作流）；
 * - 最近打开在前，按绝对路径去重。
 * - 历史条目失效（路径不存在 / 文件损坏）时自动从历史移除，不拖累列表。
 */

/**
 * 加载全部工作流；单个失败不拖垮整体（列表中以 ✗ + error 呈现，不静默消失）。
 * 纯读——失效条目的清理在启动时 pruneMissingWorkflows() 一次完成（GET 不带写副作用）。
 * @returns {{ path: string, doc?: any, error?: string }[]}
 */
export function loadWorkflows() {
    const dir = path.join(ROOT, "workflows");
    const ships = fs.existsSync(dir)
        ? fs.readdirSync(dir)
            .filter(f => f.endsWith(".json") && !f.startsWith("_") && !f.endsWith(".example.json"))
            .map(f => path.resolve(dir, f))
        : [];
    const opened = (loadLocalConfig().workflows ?? []).map(p => normalizePath(p));
    /** @type {(fp: string) => { path: string, doc?: any, error?: string }} */
    const load = fp => {
        try { return { path: fp, doc: loadWorkflow(fp) }; }
        catch (e) { return { path: fp, error: e.message }; }
    };

    const openedRows = opened.map(load);
    const shipRows = ships.filter(fp => !opened.includes(fp)).map(load);
    return [...openedRows, ...shipRows];
}

/** 启动时清理：失效路径 / 损坏文件从历史移除（不删文件本身）。 */
export function pruneMissingWorkflows() {
    const broken = loadWorkflows().filter(r => r.error).map(r => r.path);
    for (const p of broken) forgetWorkflow(p);
}

/**
 * @param {string} nameOrPath 工作流路径，或显示名（title / 文件名，加载时回填到 doc.name）
 * @returns {{ path: string, doc: any }}
 */
export function findWorkflow(nameOrPath) {
    const candidates = loadWorkflows().filter(w => w.doc);
    const byPath = candidates.find(w => normalizePath(w.path) === normalizePath(nameOrPath));
    if (byPath) return byPath;
    const byName = candidates.filter(w => w.doc.name === nameOrPath);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new Error(`同名工作流多个，请用路径指定：${byName.map(w => w.path).join(", ")}`);
    throw new Error(`工作流未找到: ${nameOrPath}（node cli.js list 查看）`);
}
