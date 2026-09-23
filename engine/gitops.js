import { cmd } from "./exec.js";

/**
 * git 工作树管理（移植自 xlgbis packages/common/src/git.js + deploy_common.js 的 withDeployVersion）。
 * 所有操作都带显式 cwd（各应用仓库路径来自 manifest）。
 */

/**
 * @param {string} repoDir
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<boolean>}
 */
export async function isWorkingTreeClean(repoDir, opts = {}) {
    const out = await cmd("git status --porcelain", { cwd: repoDir, ...opts });
    return out.trim() === "";
}

/**
 * 列出仓库 refs（tag 优先、按版本倒序，其次分支），供 CLI/GUI 选择。
 * @param {string} repoDir
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export async function getRefs(repoDir, opts = {}) {
    const out = await cmd('git for-each-ref --format="%(objectname) %(refname)"', { cwd: repoDir, ...opts });
    return out.split("\n").map(r => r.trim()).filter(Boolean).map(e => {
        const sp = e.indexOf(" ");
        const hash = e.slice(0, sp);
        const refname = e.slice(sp + 1);
        const refType = refname.startsWith("refs/tags/") ? "tag" : "branch";
        const name = refname.replace("refs/remotes/origin/", "").replace("refs/tags/", "").replace("refs/heads/", "");
        return { hash, refType, name };
    }).filter(r => r.name !== "HEAD" && !r.name.endsWith("/HEAD"))
        // 本地与 origin 同名（refs/heads/x 与 refs/remotes/origin/x）只留一个
        .filter((r, i, arr) => arr.findIndex(x => x.name === r.name) === i)
        .sort((a, b) => {
            const aT = a.refType === "tag" ? 0 : 1;
            const bT = b.refType === "tag" ? 0 : 1;
            if (aT !== bT) return aT - bT;
            if (a.refType !== "tag") return a.name.localeCompare(b.name);
            const ap = a.name.replace("v", "").split(".").map(n => parseInt(n, 10));
            const bp = b.name.replace("v", "").split(".").map(n => parseInt(n, 10));
            return -(ap.length - bp.length || ap.reduce((acc, v, i) => acc || v - (bp[i] || 0), 0));
        });
}

/**
 * 部署版本管理：fetch → 校验工作树干净 → 可选 checkout 指定 ref → 回调（拿到 versionId/buildTime）→ 恢复原分支。
 * versionId 形如 `<ref>-<shorthash>[-dirty]`，与 xlgbis 一致。
 *
 * @param {string} repoDir
 * @param {{ ref?: string }} options
 * @param {(versionId: string, buildTime: string) => Promise<void>} callback
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export async function withDeployVersion(repoDir, options, callback, opts = {}) {
    const log = opts.log ?? (() => {});
    const C = (/** @type {string} */ c) => cmd(c, { cwd: repoDir, log });

    log("git: fetch --all");
    await C("git fetch --all");
    const clean = await isWorkingTreeClean(repoDir, { log: () => {} });
    if (!clean && options.ref != null) throw new Error("Working tree is not clean, unable to deploy specified ref");

    /** @type {{hash: string, name: string, refType: string} | undefined} */
    let ref;
    if (clean) {
        const refs = await getRefs(repoDir, { log: () => {} });
        ref = refs.find(e => e.name === options.ref);
        if (!ref && options.ref) throw new Error(`Ref not found: ${options.ref}`);
    }
    log(`git: selected working copy: ${ref?.name ?? "HEAD"}`);

    /** @type {string | undefined} */
    let original;
    if (ref) {
        try {
            original = (await C("git symbolic-ref --quiet --short HEAD")).toString().trim();
        } catch {
            original = (await C("git rev-parse HEAD")).toString().trim();
        }
        await C(`git checkout ${ref.hash}`);
        log(`git: checked out ${ref.name}`);
    }

    try {
        const gitHash = (await C("git rev-parse --short HEAD")).trim();
        const safeRef = (ref?.name ?? "HEAD").replace(/[^A-Za-z0-9._-]/g, "_");
        const versionId = `${safeRef}-${gitHash}${clean ? "" : "-dirty"}`;
        const buildTime = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
        await callback(versionId, buildTime);
    } finally {
        if (original) {
            await C(`git checkout ${original}`);
            log(`git: restored working copy: ${original}`);
        }
    }
}

/**
 * 节点图共用：部署取版一段式。fetch → 校验干净 → 可选 checkout（记录原 HEAD）→ 解析版本号。
 * dry-run 不动工作树，只解析版本并声明意图。
 * 返回 restore：需要恢复原分支时的清理函数（无需恢复为 null），由调用方决定注册到作用域还是任务级。
 *
 * @param {string} repoDir
 * @param {string | undefined} refName
 * @param {{ dryRun?: boolean, log?: (msg: string) => void }} [opts]
 * @returns {Promise<{ versionId: string, buildTime: string, restore: (() => Promise<void>) | null }>}
 */
export async function resolveDeployVersion(repoDir, refName, opts = {}) {
    const log = opts.log ?? (() => {});
    const dryRun = !!opts.dryRun;

    await cmd("git fetch --all", { cwd: repoDir, log: () => {} });
    const clean = await isWorkingTreeClean(repoDir, { log: () => {} });
    if (!clean && refName) throw new Error("Working tree is not clean, unable to deploy specified ref");

    /** @type {{hash: string, name: string} | undefined} */
    let ref;
    if (clean && refName) {
        const refs = await getRefs(repoDir, { log: () => {} });
        ref = refs.find(r => r.name === refName);
        if (!ref) throw new Error(`Ref not found: ${refName}`);
    }

    /** @type {string | undefined} */
    let gitHash;
    /** @type {string | undefined} */
    let original;
    if (dryRun) {
        gitHash = ref ? ref.hash.slice(0, 7) : (await cmd("git rev-parse --short HEAD", { cwd: repoDir, log: () => {} })).trim();
        log(`[dry-run] git: 将 checkout ${ref?.name ?? "HEAD"} 并在作用域结束/任务结束后恢复原分支`);
    } else if (ref) {
        try {
            original = (await cmd("git symbolic-ref --quiet --short HEAD", { cwd: repoDir, log: () => {} })).trim();
        } catch {
            original = (await cmd("git rev-parse HEAD", { cwd: repoDir, log: () => {} })).trim();
        }
        await cmd(`git checkout ${ref.hash}`, { cwd: repoDir, log });
        gitHash = (await cmd("git rev-parse --short HEAD", { cwd: repoDir, log: () => {} })).trim();
    } else {
        gitHash = (await cmd("git rev-parse --short HEAD", { cwd: repoDir, log: () => {} })).trim();
    }

    const safeRef = (ref?.name ?? "HEAD").replace(/[^A-Za-z0-9._-]/g, "_");
    const versionId = `${safeRef}-${gitHash}${clean ? "" : "-dirty"}`;
    const buildTime = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    const restore = original
        ? async () => {
            await cmd(`git checkout ${original}`, { cwd: repoDir, log });
            log(`git: restored working copy: ${original}`);
        }
        : null;
    return { versionId, buildTime, restore };
}
