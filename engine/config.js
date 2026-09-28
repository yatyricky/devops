import fs from "fs";
import os from "os";
import path from "path";
import { ROOT } from "./runner.js";
import { expandHome } from "./exec.js";

/**
 * local-config.json（gitignored）+ local-config.example.json 兜底。
 * workflows[] = 最近打开/另存的工作流路径——支持 `~/...` 格式（auto：加载时展开为
 * 用户主目录，保存主目录下文件时也自动写成 ~ 格式，跨机器可移植）；
 * repos.<name> 可覆盖 workflow 里的 repoDir。
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

/** `~/x` 与绝对路径统一为可比对的绝对路径。 */
function normalizePath(p) {
    return path.resolve(expandHome(String(p)));
}

/** 主目录下的绝对路径转 `~/...`（auto 存储，跨机器可移植）；其余原样返回。 */
function relativizeHome(fp) {
    const abs = path.resolve(fp);
    const home = os.homedir();
    const rel = path.relative(home, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return abs;
    return `~/${rel.split(path.sep).join("/")}`;
}

/**
 * 记住一个工作流路径（最近打开在前）。主目录下的文件统一存成 `~/...`；
 * 去重按展开后的绝对路径比较，`~/...` 与等价绝对路径视为同一条。
 * @param {string} fp
 */
export function rememberWorkflow(fp) {
    const abs = normalizePath(fp);
    const cfg = loadUiConfig();
    const cur = cfg.workflows ?? [];
    if (!cur.some(p => normalizePath(p) === abs)) {
        cfg.workflows = [relativizeHome(fp), ...cur];
        saveLocalConfig(cfg);
    }
}

/**
 * 从最近列表移除（不删文件）。
 * @param {string} fp
 */
export function forgetWorkflow(fp) {
    const abs = normalizePath(fp);
    const cfg = loadUiConfig();
    const next = (cfg.workflows ?? []).filter(p => normalizePath(p) !== abs);
    if (next.length !== (cfg.workflows ?? []).length) {
        cfg.workflows = next;
        saveLocalConfig(cfg);
    }
}

/**
 * 解析工作流仓库路径：local-config.repos.<name> 覆盖 > workflow.repoDir。
 * @param {any} wf workflow 文档
 */
export function resolveRepoDir(wf) {
    const cfg = loadLocalConfig();
    const dir = cfg?.repos?.[wf.name] || wf.repoDir;
    if (!dir) throw new Error(`repo dir not configured for workflow ${wf.name}`);
    return expandHome(path.isAbsolute(dir) ? dir : path.join(ROOT, dir));
}

// ── 「未测试」节点类型清单：独立文件 node-types-untested.json，入版本管理，手工维护 ────
const UNTESTED_FP = path.join(ROOT, "node-types-untested.json");

/**
 * @returns {string[]} 未测试节点类型；文件缺失返回空数组（由 /api/node-usage 负责种子）
 */
export function loadUntested() {
    try {
        const d = JSON.parse(fs.readFileSync(UNTESTED_FP, "utf8"));
        return Array.isArray(d.untested) ? d.untested : [];
    } catch {
        return [];
    }
}

/**
 * @param {string[]} list
 */
export function saveUntested(list) {
    fs.writeFileSync(UNTESTED_FP, JSON.stringify({ untested: list }, null, 2) + "\n", "utf8");
}

/**
 * 一次性迁移：旧位置 local-config.untestedNodeTypes → 新文件。
 * local-config 里的键随后移除，避免两处不一致。新文件已存在时不覆盖（以入库版本为准）。
 * @returns {string[] | null} 迁移出的清单（无旧数据时 null）
 */
export function migrateUntestedFromLocalConfig() {
    const cfg = loadLocalConfig();
    if (!Array.isArray(cfg.untestedNodeTypes)) return null;
    const list = cfg.untestedNodeTypes;
    delete cfg.untestedNodeTypes;
    saveLocalConfig(cfg);
    if (!fs.existsSync(UNTESTED_FP)) saveUntested(list);
    return list;
}
