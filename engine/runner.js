import fs from "fs";
import path from "path";
import url from "url";
import { loadEnv } from "./env.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, "..");
export const RUNS_DIR = path.join(ROOT, ".runs");
export const TMP_DIR = path.join(ROOT, ".tmp");
export const ENVS_DIR = path.join(ROOT, "envs");

/**
 * 任务运行器：串行队列 + 日志采集 + 持久化（.runs/<id>.json）+ 审计（.runs/audit.jsonl）。
 * CLI 与 GUI 都通过 runTask() 走同一条路径。
 *
 * 任务上下文 ctx：
 *   { id, app, task, options, dryRun, env, log(msg), logLines }
 */

fs.mkdirSync(RUNS_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

/** @type {Map<string, any>} */
const runs = new Map();

// 串行队列：同一时刻只跑一个任务，GUI 触发的部署绝不同时跑两个。
/** @type {Promise<void>} */
let queueTail = Promise.resolve();
let currentJob = null;

let idCounter = 0;
function nextId() {
    idCounter += 1;
    return `${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * @param {string} fp
 */
function readJson(fp) {
    try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return null; }
}

/**
 * @param {string} fp
 * @param {any} data
 */
function writeJson(fp, data) {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf8");
}

/**
 * 审计追加一行 JSONL。
 */
function appendAudit(entry) {
    fs.appendFileSync(path.join(RUNS_DIR, "audit.jsonl"), JSON.stringify(entry) + "\n", "utf8");
}

/**
 * @param {any} manifest 应用清单
 * @param {string} taskName
 * @param {Record<string, any>} options { ref?, release?, envName?, dryRun?, confirmProd? }
 * @returns {Promise<{ id: string }>}
 */
export function enqueueTask(manifest, taskName, options = {}) {
    const task = manifest.tasks[taskName];
    if (!task) throw new Error(`task not found: ${manifest.name}/${taskName}`);

    // ── 门禁：prod + 变更类任务必须显式确认（confirmProd 值须等于应用名）；dry-run 不变更任何状态，免门禁 ────
    const envPath = resolveEnvPath(manifest, options.envName);
    let serverType = null;
    if (manifest.envSchema && fs.existsSync(envPath)) {
        try { serverType = loadEnv(envPath, manifest.envSchema).SERVER_TYPE ?? null; } catch { /* 校验留给任务本体 */ }
    }
    if (!options.dryRun && task.mutates && serverType === "prod" && options.confirmProd !== manifest.name) {
        throw new Error(`Refusing to run ${taskName} on prod without typed confirmation (confirmProd must equal "${manifest.name}")`);
    }

    const id = nextId();
    /** @type {any} */
    const run = {
        id,
        app: manifest.name,
        task: taskName,
        options: sanitizeOptions(options),
        status: "queued",
        startedAt: null,
        endedAt: null,
        error: null,
        logLines: [],
    };
    runs.set(id, run);

    queueTail = queueTail.then(async () => {
        if (run.status === "cancelled") return;
        run.status = "running";
        run.startedAt = new Date().toISOString();
        currentJob = run;
        persist(run);
        try {
            /** @type {any} */
            const ctx = {
                id,
                app: manifest.name,
                manifest,
                task: taskName,
                dryRun: !!options.dryRun,
                options,
                log(msg) {
                    const line = { t: Date.now(), msg: String(msg) };
                    run.logLines.push(line);
                    persist(run);
                },
            };
            await task.run(ctx);
            run.status = "ok";
        } catch (err) {
            run.status = "failed";
            run.error = err?.message ?? String(err);
        } finally {
            run.endedAt = new Date().toISOString();
            currentJob = null;
            persist(run);
            appendAudit({
                ts: run.endedAt,
                id: run.id,
                app: run.app,
                task: run.task,
                options: run.options,
                status: run.status,
                error: run.error,
            });
        }
    });

    return Promise.resolve({ id });
}

/**
 * 任务函数里加载并校验 env（含 env 文件路径解析）。
 * @param {any} ctx
 */
export function loadTaskEnv(ctx) {
    const envPath = resolveEnvPath(ctx.manifest, ctx.options.envName);
    ctx.envPath = envPath;
    ctx.env = loadEnv(envPath, ctx.manifest.envSchema);
    return ctx.env;
}

/**
 * @param {any} manifest
 * @param {string | undefined} envName
 */
export function resolveEnvPath(manifest, envName) {
    const name = envName || manifest.envFile;
    if (!name) throw new Error(`manifest ${manifest.name} has no envFile`);
    return path.isAbsolute(name) ? name : path.join(ENVS_DIR, name);
}

/**
 * @param {Record<string, any>} options
 */
function sanitizeOptions(options) {
    // 环境机密不落盘：env 文件只记名字。
    return { ...options, confirmProd: options.confirmProd ? "(typed)" : undefined };
}

/**
 * @param {any} run
 */
function persist(run) {
    writeJson(path.join(RUNS_DIR, `${run.id}.json`), run);
}

/**
 * 列出历史任务（新→旧）。
 * @param {number} limit
 */
export function listRuns(limit = 50) {
    if (!fs.existsSync(RUNS_DIR)) return [];
    return fs.readdirSync(RUNS_DIR)
        .filter(f => /^[0-9a-z]+-\d+\.json$/.test(f))
        .sort().reverse()
        .slice(0, limit)
        .map(f => readJson(path.join(RUNS_DIR, f)))
        .filter(Boolean);
}

/**
 * @param {string} id
 */
export function getRun(id) {
    return runs.get(id) ?? readJson(path.join(RUNS_DIR, `${id}.json`));
}

/**
 * 当前正在跑的任务（GUI 顶栏用）。
 */
export function getCurrentJob() {
    return currentJob;
}
