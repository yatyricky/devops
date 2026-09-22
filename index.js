#!/usr/bin/env node
/**
 * DevOps 控制台服务器（单文件 Express + 扁平路由 + SSE-over-POST 流式日志）。
 * 启动：node index.js（或 start.cmd）。默认绑定 127.0.0.1:3010，见 local-config.json。
 */
import express from "express";
import path from "path";
import url from "url";
import child_process from "child_process";
import { loadLocalConfig } from "./engine/config.js";
import { loadApps } from "./engine/registry.js";
import { enqueueTask, getRun, listRuns, getCurrentJob, ENVS_DIR } from "./engine/runner.js";
import { rawParse } from "./engine/env.js";
import { getRefs } from "./engine/gitops.js";
import { compileWorkflowApp, describeSteps } from "./engine/workflow.js";
import { buildSpaPreset, buildBlankPreset } from "./engine/presets.js";
import fs from "fs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const cfg = loadLocalConfig();
const HOST = process.env.DEVOPS_HOST || cfg.host || "127.0.0.1";
const PORT = Number(process.env.DEVOPS_PORT || cfg.port || 3010);
const TOKEN = String(process.env.DEVOPS_TOKEN || cfg.token || "");

const WORKFLOWS_DIR = path.join(__dirname, "workflows");
// 工作流配置文件名白名单（防路径穿越）；_ 前缀与 *.example.json 不会被加载。
const WF_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

let apps = await loadApps();
async function reloadApps() {
    apps = await loadApps();
}

const app = express();
app.use(express.json({ limit: "256kb" }));

// ── 认证：配置了 token 才启用；值不落日志 ────
app.use("/api", (req, res, next) => {
    if (!TOKEN) return next();
    if (req.headers["x-devops-token"] === TOKEN || req.query.token === TOKEN) return next();
    return res.status(401).json({ error: "unauthorized（在设置里填 token）" });
});

// ── 应用清单 ────
app.get("/api/apps", (req, res) => {
    const list = Object.values(apps).map(m => {
        const envPath = path.join(ENVS_DIR, m.envFile || "");
        const envExists = m.envFile ? fs.existsSync(envPath) : false;
        let serverType = "";
        if (envExists) {
            try { serverType = rawParse(envPath).SERVER_TYPE ?? ""; } catch { /* 读不了就当未知 */ }
        }
        return {
            name: m.name,
            title: m.title,
            description: m.description,
            repoDir: m.repoDir,
            envFile: m.envFile,
            envExists,
            serverType,
            source: m.source || "js",
            configPath: m.configPath,
            configFile: m.configPath ? path.basename(m.configPath) : undefined,
            tasks: Object.entries(m.tasks).map(([name, t]) => ({ name, mutates: /** @type {any} */(t).mutates })),
        };
    });
    res.json(list);
});

// ── git refs（部署弹窗的 ref 选择）────
app.get("/api/apps/:app/refs", async (req, res) => {
    const m = apps[req.params.app];
    if (!m) return res.status(404).json({ error: "app not found" });
    try {
        res.json(await getRefs(m.repoDir, { log: () => {} }));
    } catch (err) {
        res.status(500).json({ error: `读取 refs 失败: ${err.message}` });
    }
});

// ── 工作流配置（配置驱动应用的 CRUD；写盘前先试编译校验，写完立即 reloadApps）────
/** @param {string} file */
const validWorkflowFile = (file) => WF_FILE_RE.test(file) && !file.startsWith("_") && !file.endsWith(".example.json");

app.get("/api/workflows", (req, res) => {
    if (!fs.existsSync(WORKFLOWS_DIR)) return res.json([]);
    const list = fs.readdirSync(WORKFLOWS_DIR)
        .filter(validWorkflowFile)
        .sort()
        .map(f => {
            try {
                return { file: f, name: JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, f), "utf8")).name ?? f.replace(/\.json$/, "") };
            } catch {
                return { file: f, name: f.replace(/\.json$/, ""), broken: true };
            }
        });
    res.json(list);
});

app.get("/api/workflows/:file", (req, res) => {
    const file = req.params.file;
    if (!validWorkflowFile(file)) return res.status(400).json({ error: "invalid workflow file name" });
    const fp = path.join(WORKFLOWS_DIR, file);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: "workflow not found" });
    try {
        res.json({ file, json: JSON.parse(fs.readFileSync(fp, "utf8")) });
    } catch (err) {
        res.status(500).json({ error: `读取失败: ${err.message}` });
    }
});

// 从预设新建（spa = SPA 静态站点；blank = 空白工作流，步骤自己组装）
app.post("/api/workflows", async (req, res) => {
    const { preset, ...fields } = req.body || {};
    let built;
    try {
        if (preset === "spa") built = buildSpaPreset(fields);
        else if (preset === "blank") built = buildBlankPreset(fields);
        else return res.status(400).json({ error: `unknown preset: ${preset}（可用: spa, blank）` });
    } catch (err) {
        return res.status(400).json({ error: err.message });
    }
    const file = `${built.json.name}.json`;
    const fp = path.join(WORKFLOWS_DIR, file);
    if (fs.existsSync(fp)) return res.status(409).json({ error: `workflows/${file} 已存在` });
    try {
        compileWorkflowApp(built.json, fp);
    } catch (err) {
        return res.status(400).json({ error: `工作流校验失败: ${err.message}` });
    }
    fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(built.json, null, 2) + "\n", "utf8");
    await reloadApps();
    res.json({ ok: true, file, envExample: built.envExample });
});

app.put("/api/workflows/:file", async (req, res) => {
    const file = req.params.file;
    if (!validWorkflowFile(file)) return res.status(400).json({ error: "invalid workflow file name" });
    const json = req.body?.json;
    try {
        compileWorkflowApp(json, path.join(WORKFLOWS_DIR, file));
    } catch (err) {
        return res.status(400).json({ error: `工作流校验失败: ${err.message}` });
    }
    fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORKFLOWS_DIR, file), JSON.stringify(json, null, 2) + "\n", "utf8");
    await reloadApps();
    res.json({ ok: true, file });
});

app.delete("/api/workflows/:file", async (req, res) => {
    const file = req.params.file;
    if (!validWorkflowFile(file)) return res.status(400).json({ error: "invalid workflow file name" });
    const fp = path.join(WORKFLOWS_DIR, file);
    if (!fs.existsSync(fp)) return res.status(404).json({ error: "workflow not found" });
    fs.unlinkSync(fp);
    await reloadApps();
    res.json({ ok: true });
});

// ── 步骤元数据（GUI 步骤编辑器的原子能力清单 + 类型）────
app.get("/api/step-types", (req, res) => {
    res.json(describeSteps());
});

// ── 任务 ────
app.post("/api/jobs", async (req, res) => {
    const { app: appName, task, ...options } = req.body || {};
    const m = apps[appName];
    if (!m) return res.status(404).json({ error: `app not found: ${appName}` });
    try {
        const { id } = await enqueueTask(m, task, options);
        res.json({ id });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get("/api/jobs", (req, res) => {
    res.json(listRuns(Number(req.query.limit) || 50));
});

app.get("/api/jobs/:id", (req, res) => {
    const run = getRun(req.params.id);
    if (!run) return res.status(404).json({ error: "job not found" });
    res.json(run);
});

// 当前正在跑的任务（顶栏指示灯）
app.get("/api/current", (req, res) => {
    const cur = getCurrentJob();
    res.json(cur ? { app: cur.app, task: cur.task, id: cur.id } : null);
});

// ── SSE-over-POST：流式推送任务日志────
app.post("/api/jobs/:id/stream", (req, res) => {
    const id = req.params.id;
    if (!getRun(id)) return res.status(404).json({ error: "job not found" });
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    let sentLines = 0;
    let lastStatus = "";
    /** @type {NodeJS.Timeout | null} */
    let timer = null;
    /** @type {NodeJS.Timeout | null} */
    let heartbeat = null;
    const stop = () => { if (timer) clearInterval(timer); };

    const tick = () => {
        const run = getRun(id);
        if (!run) { send({ type: "end", status: "unknown" }); stop(); res.end(); return; }
        for (; sentLines < run.logLines.length; sentLines++) {
            send({ type: "log", line: run.logLines[sentLines] });
        }
        if (run.status !== lastStatus) {
            lastStatus = run.status;
            send({ type: "status", status: run.status, error: run.error });
        }
        if (run.status === "ok" || run.status === "failed") {
            send({ type: "end", status: run.status });
            stop();
            res.end();
        }
    };

    timer = setInterval(tick, 300);
    tick();
    // 心跳：任务长时间无输出（如 git fetch / npm ci）时保持连接不被中间层掐断
    heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* 连接已断 */ } }, 10_000);
    // 注意：必须监听 res 而不是 req 的 close——POST body 被 express.json 消费后 req 就 close 了，
    // 而此时 SSE 响应还在流式输出中。
    res.on("close", () => { stop(); clearInterval(heartbeat); });
});

// ── 静态前端 ────
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, HOST, () => {
    const urlStr = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
    console.log(`[devops-console] ${urlStr}  (apps: ${Object.keys(apps).join(", ") || "none"})`);
    console.log(`[devops-console] token auth: ${TOKEN ? "on" : "off"}；机密 env 文件只在 envs/ 目录，本服务不读取其值用于展示`);
    // 非显式指定端口时自动打开浏览器
    if (!process.env.DEVOPS_PORT && !process.env.DEVOPS_NO_OPEN && process.platform === "win32") {
        child_process.exec(`start "" "${urlStr}"`, () => { /* 打开失败无妨 */ });
    }
});
