import fs from "fs";
import path from "path";
import url from "url";
import { ROOT } from "./runner.js";
import { loadWorkflow } from "./workflow.js";
import { loadLocalConfig } from "./config.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 工作流注册中心：
 * - workflow.json 可放磁盘任意位置——local-config.json 的 workflows[] 记录最近打开/另存的路径；
 * - 仓库自带 workflows/*.json 始终可见（示例与随仓库版本管理的工作流）；
 * - 最近打开在前，按绝对路径去重。
 */

/**
 * @returns {string[]} 绝对路径列表
 */
export function workflowSearchPaths() {
    const dir = path.join(ROOT, "workflows");
    /** @type {string[]} */
    const ships = fs.existsSync(dir)
        ? fs.readdirSync(dir)
            .filter(f => f.endsWith(".json") && !f.startsWith("_") && !f.endsWith(".example.json"))
            .map(f => path.join(dir, f))
        : [];
    const opened = (loadLocalConfig().workflows ?? []).map(p => path.resolve(p));
    return [...new Set([...opened, ...ships.map(p => path.resolve(p))])];
}

/**
 * 加载全部工作流；单个失败不拖垮整体（返回 error 供 GUI 标红）。
 * @returns {{ path: string, doc?: any, error?: string }[]}
 */
export function loadWorkflows() {
    return workflowSearchPaths().map(fp => {
        try {
            return { path: fp, doc: loadWorkflow(fp) };
        } catch (e) {
            return { path: fp, error: e.message };
        }
    });
}

/**
 * @param {string} nameOrPath
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
