import fs from "fs";
import path from "path";
import { ROOT } from "./runner.js";

/**
 * local-config.json（gitignored）+ local-config.example.json 兜底。
 * repos 可按应用名覆盖 manifest 里的仓库路径。
 */
export function loadLocalConfig() {
    const fp = path.join(ROOT, "local-config.json");
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf8"));
    const fpExample = path.join(ROOT, "local-config.example.json");
    if (fs.existsSync(fpExample)) return JSON.parse(fs.readFileSync(fpExample, "utf8"));
    return {};
}

/**
 * 解析应用仓库路径：local-config.repos.<name> 覆盖 > manifest.repoDir。
 * @param {any} manifest
 */
export function resolveRepoDir(manifest) {
    const cfg = loadLocalConfig();
    const dir = cfg?.repos?.[manifest.name] || manifest.repoDir;
    if (!dir) throw new Error(`repo dir not configured for app ${manifest.name}`);
    return path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
}
