#!/usr/bin/env node
/**
 * 启动前置（start.cmd 在 node index.js 之前调用）：逐路径 git pull local-config.json 的 paths 数组。
 * 只做 --ff-only 快进更新；任何失败（目录不存在/非 git 仓库/网络/冲突）打警告继续——
 * 控制台可用性优先于 git 状态，exit code 恒 0。
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { loadLocalConfig } from "../engine/config.js";
import { expandHome } from "../engine/exec.js";

const GIT_TIMEOUT = 30_000;

function git(dir, args) {
    return execSync(`git ${args}`, { cwd: dir, encoding: "utf8", timeout: GIT_TIMEOUT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const paths = loadLocalConfig().paths ?? [];
if (!paths.length) {
    console.log("[preflight] paths 为空，跳过 git pull（local-config.json 配置 paths 数组以启用启动前更新）");
    process.exit(0);
}

let ok = 0, warn = 0;
for (const raw of paths) {
    const dir = path.resolve(expandHome(String(raw)));
    const tag = `[preflight] ${String(raw)}`;
    try {
        if (!fs.existsSync(dir)) throw new Error("目录不存在");
        // 必须是仓库根（--show-toplevel 归一后等于自身）：误配非仓库路径时不能在其外层仓库执行 pull
        const top = git(dir, "rev-parse --show-toplevel");
        if (path.resolve(top) !== dir) throw new Error(`不是 git 仓库根（属于 ${top}）`);
        const dirty = git(dir, "status --porcelain").length > 0;
        const branch = git(dir, "rev-parse --abbrev-ref HEAD");
        if (dirty) console.warn(`${tag} ⚠ 本地有未提交改动（GUI 自动保存常导致），pull 可能被拒`);
        const out = git(dir, "pull --ff-only");
        const line = out.split("\n").map(s => s.trim()).filter(Boolean).pop() ?? "";
        if (/already up to date/i.test(out)) console.log(`${tag} ✓ (${branch}) already up to date`);
        else { console.log(`${tag} ✓ (${branch}) ${line}`); ok++; }
    } catch (e) {
        // git 的根因行（error: ...）在 Aborting 之前——去重全量打出；目录不存在等无 stderr 时回退 message
        const seen = new Set();
        const lines = [e.stdout, e.stderr].flatMap(s => String(s ?? "").split("\n"))
            .map(s => s.trim())
            .filter(l => l && l !== "Aborting" && !/^Command failed/.test(l) && !seen.has(l) && seen.add(l));
        console.warn(`${tag} ⚠ ${lines.join(" | ") || String(e?.message ?? e)}（跳过，继续启动）`);
        warn++;
    }
}
console.log(`[preflight] 完成：${ok} 更新 / ${warn} 警告 / ${paths.length - ok - warn} 无变化`);
