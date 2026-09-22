import fs from "fs";
import path from "path";
import { ROOT } from "./runner.js";
import { resolveRepoDir } from "./config.js";
import { compileWorkflowApp } from "./workflow.js";

/**
 * 应用注册中心：workflows/ 下每个 *.json 定义一个应用（唯一来源，无 JS manifest）。
 * 跳过 `_` 前缀与 *.example.json。
 *
 * @returns {Promise<Record<string, any>>}
 */
export async function loadApps() {
    const dir = path.join(ROOT, "workflows");
    /** @type {Record<string, any>} */
    const apps = {};
    if (!fs.existsSync(dir)) return apps;
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json") && !f.startsWith("_") && !f.endsWith(".example.json"))) {
        const fp = path.join(dir, f);
        let json;
        try {
            json = JSON.parse(fs.readFileSync(fp, "utf8"));
        } catch (err) {
            throw new Error(`invalid workflow JSON: workflows/${f}: ${err.message}`);
        }
        const m = compileWorkflowApp(json, fp);
        if (apps[m.name]) throw new Error(`duplicate app name: ${m.name} (workflows/${f})`);
        apps[m.name] = { ...m, repoDir: resolveRepoDir(m) };
    }
    return apps;
}
