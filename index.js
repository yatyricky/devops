#!/usr/bin/env node
/**
 * DevOps 控制台服务器：工作流（节点图）注册 + 任务队列 + SSE 流式日志 + 静态前端。
 * 启动：node index.js（或 start.cmd）。默认 127.0.0.1:3010，见 local-config.json。
 */
import express from "express";
import fs from "fs";
import path from "path";
import url from "url";
import child_process from "child_process";
import { loadUiConfig, rememberWorkflow, forgetWorkflow } from "./engine/config.js";
import { loadWorkflows, findWorkflow } from "./engine/registry.js";
import { nodeTypesMeta } from "./engine/nodes/index.js";
import { readNpmScripts } from "./engine/nodes/build.js";
import { loadWorkflow, validateWorkflow } from "./engine/workflow.js";
import { enqueueWorkflowTask, listRuns, getRun, getCurrentJob } from "./engine/runner.js";
import { getRefs } from "./engine/gitops.js";
import { expandHome } from "./engine/exec.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const cfg = loadUiConfig();
const HOST = process.env.DEVOPS_HOST || cfg.host || "127.0.0.1";
const PORT = Number(process.env.DEVOPS_PORT || cfg.port || 3010);
const TOKEN = String(process.env.DEVOPS_TOKEN || cfg.token || "");

const app = express();
app.use(express.json({ limit: "2mb" })); // 保存整张图

// ── 认证：配置了 token 才启用；值不落日志 ────
app.use("/api", (req, res, next) => {
    if (!TOKEN) return next();
    if (req.headers["x-devops-token"] === TOKEN || req.query.token === TOKEN) return next();
    return res.status(401).json({ error: "unauthorized（在设置里填 token）" });
});

// ── 工作流 ────
app.get("/api/workflows", (req, res) => {
    res.json(loadWorkflows().map(w => {
        if (!w.doc) return { path: w.path, error: w.error };
        // 任务子图内 struct 构造器的 SERVER_TYPE 字段（GUI 徽标与 prod 门禁提示）
        let serverType = "";
        const taskNodeIds = Object.values(w.doc.tasks).flatMap(t => /** @type {any} */(t).nodes ?? /** @type {any} */(t).path ?? []);
        const svNode = taskNodeIds
            .map(id => w.doc.nodes.find(n => n.id === id))
            .find(n => n?.type === "struct.make" && (n.data?.fields ?? []).some(f => f.key === "SERVER_TYPE"));
        if (svNode) serverType = String(svNode.data.fields.find(f => f.key === "SERVER_TYPE")?.value ?? "");
        return {
            path: w.path,
            name: w.doc.name,
            title: w.doc.title,
            repoDir: w.doc.repoDir,
            serverType,
            tasks: Object.entries(w.doc.tasks).map(([name, t]) => ({ name, label: /** @type {any} */(t).label, mutates: /** @type {any} */(t).mutates })),
        };
    }));
});

/** 打开磁盘任意位置的 workflow（记住路径到 local-config）。 */
app.post("/api/workflows/open", (req, res) => {
    const fp = String(req.body?.path || "").trim();
    if (!fp) return res.status(400).json({ error: "path required" });
    try {
        const doc = loadWorkflow(fp);
        rememberWorkflow(fp);
        res.json({ path: path.resolve(fp), doc });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

/** 保存（写盘前全量校验；新建/另存为也走这里——存放路径由前端弹窗确认）。 */
app.post("/api/workflows/save", (req, res) => {
    const fp = String(req.body?.path || "").trim();
    const doc = req.body?.doc;
    if (!fp || !doc) return res.status(400).json({ error: "path/doc required" });
    const problems = validateWorkflow(doc);
    if (problems.length) return res.status(400).json({ error: `校验失败:\n  - ${problems.join("\n  - ")}` });
    try {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, JSON.stringify(doc, null, 2), "utf8");
        rememberWorkflow(fp);
        res.json({ ok: true, path: path.resolve(fp) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/** 从最近列表移除（不删文件）。 */
app.post("/api/workflows/forget", (req, res) => {
    forgetWorkflow(String(req.body?.path || ""));
    res.json({ ok: true });
});

// ── 节点类型注册表（前端动态渲染节点/插槽/检查器表单的唯一事实源）────
app.get("/api/node-types", (req, res) => {
    res.json(nodeTypesMeta());
});

// ── git refs（部署弹窗选 ref）────
app.post("/api/refs", async (req, res) => {
    try {
        const wf = findWorkflow(String(req.body?.workflow || ""));
        res.json(await getRefs(wf.doc.repoDir, { log: () => {} }));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ── npm scripts（npm.run 卡片下拉：解析 <path>/package.json 的 scripts 键集）────
app.post("/api/npm/scripts", (req, res) => {
    const p = expandHome(String(req.body?.path || "").trim());
    if (!p) return res.status(400).json({ error: "path required" });
    try {
        res.json(readNpmScripts(path.resolve(p)));
    } catch (e) {
        res.status(400).json({ error: `读取 ${path.basename(p)}/package.json 失败: ${e.message}` });
    }
});

// ── git refs（任意仓库目录；git.getRefs 卡片刷新用）────
app.post("/api/git/refs", async (req, res) => {
    const repoDir = expandHome(String(req.body?.repoDir || "").trim());
    if (!repoDir) return res.status(400).json({ error: "repoDir required" });
    try {
        res.json(await getRefs(repoDir, { log: () => {} }));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ── 任务 ────
app.post("/api/jobs", (req, res) => {
    const { workflow: wfRef, task, doc, ...options } = req.body || {};
    try {
        let wf;
        if (doc) {
            // GUI 内存态执行：load 后一切以内存为准，未保存的改动也能直接运行
            const problems = validateWorkflow(doc);
            if (problems.length) return res.status(400).json({ error: `内存态校验失败:\n  - ${problems.join("\n  - ")}` });
            wf = { path: String(req.body?.workflowPath || `memory:${doc.name}`), doc };
        } else {
            wf = findWorkflow(String(wfRef || ""));
        }
        const { id } = enqueueWorkflowTask(wf.doc, wf.path, String(task), options);
        res.json({ id });
    } catch (e) {
        res.status(400).json({ error: e.message });
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

app.get("/api/current", (req, res) => {
    const cur = getCurrentJob();
    res.json(cur ? { app: cur.app, task: cur.task, id: cur.id } : null);
});

// ── SSE-over-POST：流式推送任务日志（心跳保活；必须监听 res 的 close）────
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
    let lastNodeStatus = "";
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
        // 节点执行状态快照（GUI 卡片外框）变化即推
        const ns = JSON.stringify(run.nodeStatus ?? null);
        if (ns !== lastNodeStatus) {
            lastNodeStatus = ns;
            send({ type: "node", nodeStatus: run.nodeStatus ?? null });
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
    heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* 连接已断 */ } }, 10_000);
    res.on("close", () => { stop(); clearInterval(heartbeat); });
});

// ── 静态前端（web/dist = Svelte Flow 画布构建产物）────
const webDist = path.join(__dirname, "web", "dist");
if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
} else {
    console.log("[devops-console] web/dist 不存在——前端未构建。构建：npm -C web install && npm -C web run build");
}

app.listen(PORT, HOST, () => {
    const urlStr = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
    console.log(`[devops-console] ${urlStr}`);
    console.log(`[devops-console] token auth: ${TOKEN ? "on" : "off"}；工作流 = local-config.workflows + 仓库 workflows/`);
    if (!process.env.DEVOPS_PORT && !process.env.DEVOPS_NO_OPEN && process.platform === "win32") {
        child_process.exec(`start "" "${urlStr}"`, () => { /* 打开失败无妨 */ });
    }
});
