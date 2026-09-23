#!/usr/bin/env node
/**
 * CLI——与 GUI 走同一个 runner。GUI 挂了这里照样能部署。
 *
 * 用法：
 *   node cli.js list                                  # 工作流列表（local-config.workflows + 仓库 workflows/）
 *   node cli.js tasks <wf>                            # 列出任务（路径概览）
 *   node cli.js run <wf> <task> [options]             # 运行任务路径
 *     <wf>   工作流名或 JSON 文件路径
 *     --dry-run            全节点打印计划，不产生副作用
 *     --input k=v          任务输入（对应 task.input 节点，可多次）
 *     --confirm-prod X     prod 门禁的显式确认（= 工作流名；非交互场景）
 */
import readline from "readline";
import { findWorkflow, loadWorkflows } from "./engine/registry.js";
import { enqueueWorkflowTask, getRun } from "./engine/runner.js";
import { findTaskEnv } from "./engine/workflow.js";

const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", c: "\x1b[36m", m: "\x1b[35m", dim: "\x1b[2m", R: "\x1b[0m" };

/** @param {string} q @returns {Promise<string>} */
async function ask(q) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const a = await new Promise(r => rl.question(q, x => { rl.close(); r(x); }));
    return a.trim();
}

/** @param {string[]} argv */
function parseArgs(argv) {
    const opts = /** @type {any} */ ({ inputs: {} });
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--dry-run") opts.dryRun = true;
        else if (a === "--confirm-prod") opts.confirmProd = argv[++i];
        else if (a === "--input" || a === "-i") {
            const kv = argv[++i];
            const eq = kv.indexOf("=");
            if (eq <= 0) { console.error(`--input 需要 k=v 形式: ${kv}`); process.exit(2); }
            opts.inputs[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
        else { console.error(`unknown argument: ${a}`); process.exit(2); }
    }
    return opts;
}

/**
 * 跟随任务执行，流式打印日志。
 * @param {string} id
 */
async function follow(id) {
    let printed = 0;
    for (;;) {
        const run = getRun(id);
        if (run) {
            for (; printed < run.logLines.length; printed++) console.log(run.logLines[printed].msg);
            if (run.status === "ok") { console.log(`${C.g}[Done] ${run.app}/${run.task} ok${C.R}`); return 0; }
            if (run.status === "failed") {
                console.error(`${C.r}[Failed] ${run.app}/${run.task}: ${run.error ?? ""}${C.R}`);
                return 1;
            }
        }
        await new Promise(r => setTimeout(r, 250));
    }
}

const [cmd, wfRef, taskName, ...rest] = process.argv.slice(2);

if (!cmd || cmd === "help") {
    console.log(`用法: node cli.js <list|tasks|run> ...
  list
  tasks <wf>
  run <wf> <task> [--dry-run] [--input k=v ...] [--confirm-prod <name>]`);
    process.exit(cmd ? 0 : 2);
}

if (cmd === "list") {
    const rows = loadWorkflows();
    if (!rows.length) console.log("（无工作流：把 workflow.json 放任意位置后 node cli.js run <路径> <task> 运行一次即记住）");
    for (const w of rows) {
        if (w.error) { console.log(`${C.r}✗ ${w.path}${C.R}\n    ${w.error.split("\n").join("\n    ")}`); continue; }
        console.log(`${C.c}${w.doc.name}${C.R}  ${w.doc.title ?? ""}  ${C.dim}${w.path}${C.R}`);
        const tasks = Object.entries(w.doc.tasks);
        console.log(tasks.length ? `    tasks: ${tasks.map(([n, t]) => `${n}${/** @type {any} */(t).mutates ? C.m : ""}${/** @type {any} */(t).mutates ? "*" : ""}${C.R}`).join(", ")}` : "    tasks: (无)");
    }
    process.exit(0);
}

if (!wfRef) { console.error("缺少工作流参数"); process.exit(2); }
let wf;
try {
    wf = findWorkflow(wfRef);
} catch (e) {
    console.error(e.message);
    process.exit(2);
}

if (cmd === "tasks") {
    console.log(`${C.c}${wf.doc.name}${C.R}  ${wf.path}`);
    for (const [name, t] of Object.entries(/** @type {any} */(wf.doc).tasks)) {
        console.log(`  ${C.y}${name}${C.R}${t.mutates ? C.m + " *变更" + C.R : ""}：${t.path.join(" → ")}`);
    }
    process.exit(0);
}

if (cmd !== "run") { console.error(`unknown command: ${cmd}`); process.exit(2); }
if (!taskName) { console.error("缺少任务名（node cli.js tasks <wf> 查看）"); process.exit(2); }

const options = parseArgs(rest);
const task = /** @type {any} */(wf.doc.tasks)[taskName];
if (!task) { console.error(`任务不存在: ${taskName}；可用: ${Object.keys(wf.doc.tasks).join(", ")}`); process.exit(2); }

// prod 门禁的交互确认（runner 内还有兜底）
if (task.mutates && !options.dryRun) {
    const env = findTaskEnv(wf.doc, taskName);
    if (env?.SERVER_TYPE === "prod") {
        let confirm = options.confirmProd;
        if (!confirm) {
            confirm = await ask(`${C.m}这是 PROD 环境。输入工作流名 "${wf.doc.name}" 确认执行 ${taskName}:${C.R} `);
        }
        if (confirm !== wf.doc.name) { console.log("确认不符，已取消。"); process.exit(1); }
        options.confirmProd = confirm;
    }
}

const { id } = enqueueWorkflowTask(wf.doc, wf.path, taskName, options);
process.exit(await follow(id));
