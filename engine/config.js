import fs from "fs";
import path from "path";
import { ROOT } from "./runner.js";

/**
 * local-config.json（gitignored）+ local-config.example.json 兜底。
 * workflows[] = 最近打开/另存的工作流路径（可在磁盘任意位置）；repos.<name> 可覆盖 workflow 里的 repoDir。
 */
export function loadLocalConfig() {
    const fp = path.join(ROOT, "local-config.json");
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf8"));
    const fpExample = path.join(ROOT, "local-config.example.json");
    if (fs.existsSync(fpExample)) return JSON.parse(fs.readFileSync(fpExample, "utf8"));
    return {};
}

/** @returns {{host: string, port: number, token: string, workflows: string[], repos: Record<string,string>}} */
export function loadUiConfig() {
    return { host: "127.0.0.1", port: 3010, token: "", workflows: [], repos: {}, ...loadLocalConfig() };
}

/** 写回 local-config.json（保留其它键）。 */
export function saveLocalConfig(cfg) {
    fs.writeFileSync(path.join(ROOT, "local-config.json"), JSON.stringify(cfg, null, 2), "utf8");
}

/**
 * 记住一个工作流路径（最近打开在前）。
 * @param {string} fp
 */
export function rememberWorkflow(fp) {
    const abs = path.resolve(fp);
    const cfg = loadUiConfig();
    const cur = cfg.workflows ?? [];
    if (!cur.some(p => path.resolve(p) === abs)) {
        cfg.workflows = [abs, ...cur];
        saveLocalConfig(cfg);
    }
}

/**
 * 从最近列表移除（不删文件）。
 * @param {string} fp
 */
export function forgetWorkflow(fp) {
    const abs = path.resolve(fp);
    const cfg = loadUiConfig();
    cfg.workflows = (cfg.workflows ?? []).filter(p => path.resolve(p) !== abs);
    saveLocalConfig(cfg);
}

/**
 * 解析工作流仓库路径：local-config.repos.<name> 覆盖 > workflow.repoDir。
 * @param {any} wf workflow 文档
 */
export function resolveRepoDir(wf) {
    const cfg = loadLocalConfig();
    const dir = cfg?.repos?.[wf.name] || wf.repoDir;
    if (!dir) throw new Error(`repo dir not configured for workflow ${wf.name}`);
    return path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
}
