import fs from "fs";
import path from "path";
import url from "url";
import { sshRun, sshClose } from "./ssh.js";
import { executeTask, findTaskEnv } from "./workflow.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, "..");
export const RUNS_DIR = path.join(ROOT, ".runs");
export const TMP_DIR = path.join(ROOT, ".tmp");
export const ENVS_DIR = path.join(ROOT, "envs");

/**
 * 任务运行器：串行队列 + 日志采集 + .runs/<id>.json 持久化 + audit.jsonl 审计。
 * CLI 与 GUI 共用。一个任务 = workflow.json 里选出的节点子图（引擎内按拓扑层级并发执行）。
 */

fs.mkdirSync(RUNS_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

/** @type {Map<string, any>} */
const runs = new Map();

// 串行队列：同一时刻只跑一个任务。
/** @type {Promise<void>} */
let queueTail = Promise.resolve();
let currentJob = null;

let idCounter = 0;
function nextId() {
    idCounter += 1;
    return `${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/** @param {string} fp */
function readJson(fp) {
    try { return JSON.parse(fs.readFileSync(fp, "utf8")); } catch { return null; }
}

/** @param {string} fp @param {any} data */
function writeJson(fp, data) {
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), "utf8");
}

function appendAudit(entry) {
    fs.appendFileSync(path.join(RUNS_DIR, "audit.jsonl"), JSON.stringify(entry) + "\n", "utf8");
}

/** 日志行掩码：键名含 SECRET/TOKEN/PASSWORD/PASSPHRASE 的 KEY=VALUE 只显示 ***。 */
const SECRET_KEY_RE = /([A-Za-z_]*(?:SECRET|TOKEN|PASSWORD|PASSPHRASE)[A-Za-z_]*)=(\S+)/g;
export function maskLine(line) {
    return String(line).replace(SECRET_KEY_RE, (_, k) => `${k}=***`);
}

/** 键名敏感正则（markNodeInputs 值脱敏用）。 */
const SECRET_NAME_RE = /SECRET|TOKEN|PASSWORD|PASSPHRASE/i;

/**
 * 输入值 → GUI 显示字符串（脱敏：敏感键名打码，含对象嵌套；超长截断）。
 * @param {string} key
 * @param {any} v
 */
function displayValue(key, v) {
    const cut = (s) => (s.length > 300 ? s.slice(0, 300) + "…" : s);
    if (SECRET_NAME_RE.test(key)) return "***";
    if (typeof v === "string") return cut(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
        return cut(JSON.stringify(v, (k2, val2) => (SECRET_NAME_RE.test(String(k2)) ? "***" : val2)) ?? "[unserializable]");
    } catch { return "[unserializable]"; }
}

/**
 * @param {any} wf 已加载校验的 workflow 文档
 * @param {string} wfPath 文件绝对路径
 * @param {string} taskName
 * @param {{ dryRun?: boolean, inputs?: Record<string,string>, confirmProd?: string }} options
 * @returns {{ id: string }}
 */
export function enqueueWorkflowTask(wf, wfPath, taskName, options = {}) {
    const task = wf.tasks?.[taskName];
    if (!task) throw new Error(`task not found: ${wf.name}/${taskName}`);

    // ── prod 门禁：mutates + SERVER_TYPE=prod 必须输入工作流名确认；dry-run 免门禁 ────
    const env = findTaskEnv(wf, taskName);
    if (!options.dryRun && task.mutates && env?.SERVER_TYPE === "prod" && options.confirmProd !== wf.name) {
        throw new Error(`Refusing to run ${taskName} on prod without typed confirmation (confirmProd must equal "${wf.name}")`);
    }

    const id = nextId();
    /** @type {any} */
    const run = {
        id,
        app: wf.name,
        workflowPath: path.resolve(wfPath),
        task: taskName,
        options: sanitizeOptions(options),
        status: "queued",
        startedAt: null,
        endedAt: null,
        error: null,
        logLines: [],
        /** @type {Record<string, string>} nodeId → running|ok|failed（GUI 卡片外框状态） */
        nodeStatus: {},
        /** @type {Record<string, Record<string, string>>} nodeId → {handle: 显示值}（wired 输入实时值；脱敏后） */
        nodeInputs: {},
    };
    runs.set(id, run);

    queueTail = queueTail.then(async () => {
        if (run.status === "cancelled") return;
        run.status = "running";
        run.startedAt = new Date().toISOString();
        currentJob = run;
        persist(run);

        /** @type {any} */
        const ctx = {
            id,
            app: wf.name,
            task: taskName,
            dryRun: !!options.dryRun,
            inputs: options.inputs ?? {},
            options,
            configDir: path.dirname(path.resolve(wfPath)),
            repoDir: wf.repoDir,
            log(msg) {
                const line = { t: Date.now(), msg: String(msg) };
                run.logLines.push(line);
                persist(run);
            },
            mask: maskLine,
            // 副作用登记（finally 统一处理）
            gitRestores: [],
            sessions: [],
            remoteFiles: [],
            registerGitRestore(fn) { this.gitRestores.push(fn); },
            registerSession(ssh) { this.sessions.push(ssh); },
            trackRemoteFile(ssh, p) { this.remoteFiles.push({ ssh, path: p }); },
            /** 节点执行状态标记（GUI 卡片外框：running/ok/failed）；随 run 持久化 + SSE 快照推送 */
            markNode(nodeId, status) {
                run.nodeStatus = { ...run.nodeStatus, [nodeId]: status };
                persist(run);
            },
            /** 节点实际收到的输入值（GUI wired 控件实时值）；脱敏后随 run 持久化 + SSE 快照推送 */
            markNodeInputs(nodeId, inputValues) {
                const out = {};
                for (const [k, v] of Object.entries(inputValues ?? {})) {
                    out[k] = displayValue(k, v);
                }
                run.nodeInputs = { ...run.nodeInputs, [nodeId]: out };
                persist(run);
            },
        };

        try {
            await executeTask(ctx, wf, taskName);
            run.status = "ok";
        } catch (err) {
            run.status = "failed";
            run.error = err?.message ?? String(err);
        } finally {
            try { await finalize(ctx); } catch (e) {
                ctx.log(`[WARN] 收尾清理异常：${e.message}`);
            }
            run.endedAt = new Date().toISOString();
            currentJob = null;
            persist(run);
            appendAudit({
                ts: run.endedAt,
                id: run.id,
                app: run.app,
                workflowPath: run.workflowPath,
                task: run.task,
                options: run.options,
                status: run.status,
                error: run.error,
            });
        }
    });

    return { id };
}

/**
 * 收尾：git 工作树恢复（逆序）→ 远端临时文件清理（上传的归档，无论成败）→ 会话关闭。
 * 等价原远端脚本的 trap cleanup_deploy 语义。
 * @param {any} ctx
 */
async function finalize(ctx) {
    for (const fn of ctx.gitRestores.reverse()) {
        try { await fn(); } catch (e) { ctx.log(`[WARN] git 恢复失败：${e.message}`); }
    }
    for (const { ssh, path: p } of ctx.remoteFiles.reverse()) {
        try { await sshRun(ssh, `sudo -n rm -f '${p}'`, { log: () => {} }); ctx.log(`[cleanup] 远端临时文件 ${p}`); } catch { /* 尽力 */ }
    }
    for (const s of ctx.sessions) sshClose(s);
}

/** @param {Record<string, any>} options */
function sanitizeOptions(options) {
    return { ...options, confirmProd: options.confirmProd ? "(typed)" : undefined };
}

/** @param {any} run */
function persist(run) {
    writeJson(path.join(RUNS_DIR, `${run.id}.json`), run);
}

/**
 * 历史任务（新→旧）。
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

/** @param {string} id */
export function getRun(id) {
    return runs.get(id) ?? readJson(path.join(RUNS_DIR, `${id}.json`));
}

export function getCurrentJob() {
    return currentJob;
}
