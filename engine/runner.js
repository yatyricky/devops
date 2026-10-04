import fs from "fs";
import path from "path";
import url from "url";
import { sshClose } from "./ssh.js";
import { executeTask, findTaskEnv, validateTaskRunnable } from "./workflow.js";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT = path.resolve(__dirname, "..");
export const RUNS_DIR = path.join(ROOT, ".runs");
export const TMP_DIR = path.join(ROOT, ".tmp");

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
    try {
        fs.appendFileSync(path.join(RUNS_DIR, "audit.jsonl"), JSON.stringify(entry) + "\n", "utf8");
    } catch (e) { console.error("[runner] audit 写入失败:", e.message); }
}

/**
 * 输入值 → GUI 显示字符串（超长截断，防快照/SSE 膨胀；脱敏功能已移除——本工具用于安全环境，面板显示真实值）。
 * @param {string} key
 * @param {any} v
 */
function displayValue(key, v) {
    const cut = (s) => (s.length > 300 ? s.slice(0, 300) + "…" : s);
    if (typeof v === "string") return cut(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
        return cut(JSON.stringify(v) ?? "[unserializable]");
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

    // ── 运行前严格校验：非法状态（未知类型/类型不兼容/required 缺失/环/selector 语义）禁止运行 ────
    const runProblems = validateTaskRunnable(wf, taskName);
    if (runProblems.length) {
        throw new Error(`无法运行 ${taskName}（工作流存在无法运行的问题，保存时已允许）:\n  - ${runProblems.join("\n  - ")}`);
    }

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
        /** @type {Record<string, Record<string, string>>} nodeId → {handle: 显示值}（wired 输入实时值） */
        nodeInputs: {},
        /** @type {Record<string, string>} nodeId → 原始输出文本（节点主动上报，如 systemd is-active 的状态词） */
        nodeOutputs: {},
    };
    runs.set(id, run);

    queueTail = queueTail.then(async () => {
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
                persistSoon(run);
            },
            // 副作用登记（finally 统一处理）
            gitRestores: [],
            sessions: [],
            registerGitRestore(fn) { this.gitRestores.push(fn); },
            registerSession(ssh) { this.sessions.push(ssh); },
            /** 节点执行状态标记（GUI 卡片外框：running/ok/failed）；随 run 持久化 + SSE 快照推送 */
            markNode(nodeId, status) {
                run.nodeStatus = { ...run.nodeStatus, [nodeId]: status };
                persistSoon(run);
            },
            /** 节点实际收到的输入值（GUI wired 控件实时值）；随 run 持久化 + SSE 快照推送 */
            markNodeInputs(nodeId, inputValues) {
                const out = {};
                for (const [k, v] of Object.entries(inputValues ?? {})) {
                    out[k] = displayValue(k, v);
                }
                run.nodeInputs = { ...run.nodeInputs, [nodeId]: out };
                persistSoon(run);
            },
            /** 节点主动上报的原始输出文本（GUI 卡片内只读展示，如 systemd is-active 的状态词）；随 run 持久化 + SSE 快照推送 */
            markNodeOutput(nodeId, text) {
                run.nodeOutputs = { ...run.nodeOutputs, [nodeId]: String(text ?? "") };
                persistSoon(run);
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
            if (run._persistTimer) { clearTimeout(run._persistTimer); run._persistTimer = null; }
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
            // 终态后延迟回收内存（详情走磁盘 readJson；SSE/轮询不受影响）
            setTimeout(() => runs.delete(run.id), 60_000).unref?.();
        }
    });

    return { id };
}

/**
 * 收尾：git 工作树恢复（逆序）→ SSH 会话关闭。等价 bash trap 的平台内置部分。
 * （远端临时文件清理机制已随 envs 方案移除——ssh.upload 等节点均为「无 trap，产物保留」语义。）
 * @param {any} ctx
 */
async function finalize(ctx) {
    for (const fn of ctx.gitRestores.reverse()) {
        try { await fn(); } catch (e) { ctx.log(`[WARN] git 恢复失败：${e.message}`); }
    }
    for (const s of ctx.sessions) sshClose(s);
}

/** @param {Record<string, any>} options */
function sanitizeOptions(options) {
    return { ...options, confirmProd: options.confirmProd ? "(typed)" : undefined };
}

/** @param {any} run */
function persist(run) {
    // 不抛错：.runs/ 不可写（盘满/权限/被删）时保内存运行，队列不能因持久化故障而死锁
    try {
        const { _persistTimer, ...serializable } = run; // eslint-disable-line @typescript-eslint/no-unused-vars
        writeJson(path.join(RUNS_DIR, `${run.id}.json`), serializable);
    }
    catch (e) { console.error("[runner] persist 失败:", e.message); }
}

/**
 * 节流持久化：每行日志/状态标记不再全量同步重写 run JSON（大日志任务 O(n²) IO 阻塞事件循环），
 * 合并为至多 400ms 一次；终态在 finally 里 clearTimeout 后全量落盘。
 * @param {any} run
 */
function persistSoon(run) {
    if (run._persistTimer) return;
    run._persistTimer = setTimeout(() => {
        run._persistTimer = null;
        persist(run);
    }, 400);
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
    // id 白名单：与 listRuns 文件名同源格式——防 /api/jobs/:id 路径穿越读任意 JSON（如 local-config）
    if (!/^[0-9a-z]+-[0-9a-z]+$/.test(String(id))) return null;
    return runs.get(id) ?? readJson(path.join(RUNS_DIR, `${id}.json`));
}

export function getCurrentJob() {
    return currentJob;
}
