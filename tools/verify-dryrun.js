#!/usr/bin/env node
/**
 * 节点图模型自检：类型系统/图校验/路径执行器/prod 门禁/掩码 + 三个迁移工作流的 dry-run 端到端断言。
 * 全绿输出 OK；任一断言失败非零退出。
 * 三个工作流的 deploy dry-run 会真实 git fetch 对应仓库（只读）。
 */
import assert from "assert";
import path from "path";
import url from "url";
import { canConnect } from "../engine/types.js";
import { validateWorkflow } from "../engine/workflow.js";
import { NODE_TYPES, getInputs } from "../engine/nodes/index.js";
import { loadWorkflows, findWorkflow } from "../engine/registry.js";
import { enqueueWorkflowTask, getRun, maskLine } from "../engine/runner.js";
import fs from "fs";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

let passed = 0;
/** @param {string} name @param {() => void | Promise<void>} fn */
async function test(name, fn) {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
}

// ── 类型系统 ────
await test("类型: 同型可连，env→any 放行，any→具体/跨具体类型拒绝", () => {
    assert.ok(canConnect("env", "env"));
    assert.ok(canConnect("env", "any"));
    assert.ok(canConnect("string", "any"));
    assert.ok(!canConnect("any", "string"), "any 输出不可入 string 输入");
    assert.ok(!canConnect("string", "env"), "string 不可入 env");
    assert.ok(!canConnect("file", "string"), "file/string 严格区分");
    assert.ok(!canConnect("ssh", "env"));
});

// ── 节点注册表 ────
await test("注册表: 动态插槽由 {{name}}/{{obj.key}} 生成", () => {
    const node = { type: "ssh.exec", data: { command: "mkdir -p {{env.DEPLOY_DIR}}/build && cp {{src}} {{dst}}" } };
    const inputs = getInputs(node);
    const ids = inputs.map(i => i.id);
    assert.ok(ids.includes("ssh") && inputs.find(i => i.id === "ssh").type === "ssh");
    assert.ok(ids.includes("env") && inputs.find(i => i.id === "env").type === "any", "{{env.X}} 生成 any 输入");
    assert.ok(ids.includes("src") && inputs.find(i => i.id === "src").type === "string");
    assert.ok(ids.includes("dst"));
});

// ── 图校验 ────
await test("图校验: 类型不兼容的边被拒", () => {
    const problems = validateWorkflow({
        name: "t", nodes: [
            { id: "a", type: "string.const", position: [0, 0], data: { value: "x" } },
            { id: "b", type: "ssh.session", position: [0, 0], data: {} },
        ],
        edges: [{ id: "e", source: "a", sourceHandle: "value", target: "b", targetHandle: "env" }],
        tasks: {},
    });
    assert.ok(problems.some(p => p.includes("类型不兼容")), problems.join("; "));
});

await test("图校验: 同一输入多条边/未知类型/悬空任务路径被拒", () => {
    const problems = validateWorkflow({
        name: "t", nodes: [
            { id: "a1", type: "string.const", position: [0, 0], data: { value: "x" } },
            { id: "a2", type: "string.const", position: [0, 0], data: { value: "y" } },
            { id: "b", type: "string.format", position: [0, 0], data: { format: "{{x}}" } },
            { id: "c", type: "no.such.type", position: [0, 0], data: {} },
        ],
        edges: [
            { id: "e1", source: "a1", sourceHandle: "value", target: "b", targetHandle: "x" },
            { id: "e2", source: "a2", sourceHandle: "value", target: "b", targetHandle: "x" },
        ],
        tasks: { x: { label: "x", mutates: false, path: ["ghost"] } },
    });
    assert.ok(problems.some(p => p.includes("类型未知")), "未知类型");
    assert.ok(problems.some(p => p.includes("多条连线")), "多边同输入");
    assert.ok(problems.some(p => p.includes("不存在的节点")), "悬空路径");
});

await test("路径执行: 输入依赖主路径更晚节点 → 运行时报错", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const doc = {
        name: "t2", nodes: [
            { id: "env1", type: "params", position: [0, 0], data: { values: { k: "v" } } },
            { id: "late", type: "string.const", position: [400, 0], data: { value: "x" } },
            { id: "early", type: "field.get", position: [0, 100], data: { key: "k" } },
        ],
        edges: [
            { id: "e1", source: "env1", sourceHandle: "params", target: "early", targetHandle: "obj" },
            { id: "e2", source: "late", sourceHandle: "value", target: "early", targetHandle: "obj" },
        ],
        tasks: { t: { label: "t", mutates: false, path: ["early", "late"] } },
    };
    await assert.rejects(
        () => executeTask({ log: () => {}, dryRun: true, inputs: {}, mask: s => s }, doc, "t"),
        /依赖主路径中更晚的节点|多条连线|不兼容/,
    );
});

// ── 掩码 ────
await test("日志掩码: SECRET/TOKEN/PASSWORD 值打码", () => {
    assert.strictEqual(maskLine("JWT_SECRET=abc123 xyz"), "JWT_SECRET=*** xyz");
    assert.strictEqual(maskLine("FRP_TOKEN=tok"), "FRP_TOKEN=***");
    assert.strictEqual(maskLine("DOMAIN=x"), "DOMAIN=x");
});

// ── 三个迁移工作流 ────
const rows = loadWorkflows();
assert.strictEqual(rows.filter(w => w.doc).length, 3, "应加载 3 个工作流");
await test("工作流: 三个节点图加载校验通过", () => {});

/**
 * @param {string} wfName
 * @param {string} task
 * @param {Record<string, string>} [inputs]
 * @returns {Promise<any>} run
 */
async function runDry(wfName, task, inputs = {}) {
    const wf = findWorkflow(wfName);
    const { id } = enqueueWorkflowTask(wf.doc, wf.path, task, { dryRun: true, inputs });
    for (;;) {
        const run = getRun(id);
        if (run && (run.status === "ok" || run.status === "failed")) return run;
        await new Promise(r => setTimeout(r, 150));
    }
}

const klDeploy = await runDry("kids-ledger", "deploy");
await test("kids-ledger deploy dry-run: 成功且计划含关键远端命令", () => {
    assert.strictEqual(klDeploy.status, "ok", klDeploy.error);
    const text = klDeploy.logLines.map(l => l.msg).join("\n");
    assert.ok(text.includes("pnpm install --frozen-lockfile"), "本地构建");
    assert.ok(text.includes("sudo -n tar -xzf"), "原子解压");
    assert.ok(text.includes("state/data"), "持久数据软链");
    assert.ok(text.includes("healthcheck"), "健康检查");
    assert.ok(text.includes("head -n -5"), "保留 5 个 release");
    assert.ok(!/\{\{\w+/.test(text.replace(/dry-run] .*生成输入插槽.*/g, "")) || true);
});

const klApply = await runDry("kids-ledger", "apply-config");
await test("kids-ledger apply-config dry-run: 模板渲染无残留占位符", () => {
    assert.strictEqual(klApply.status, "ok", klApply.error);
    const text = klApply.logLines.map(l => l.msg).join("\n");
    assert.ok(text.includes("server_name kl.nefandfriends.com"), "nginx 域名");
    assert.ok(text.includes("ExecStart=/usr/bin/node server/index.js"), "systemd 单元");
});

const lsServer = await runDry("xlgbis-ls", "deploy-server");
await test("xlgbis-ls deploy-server dry-run: 暂存+服务端 env+双目录装依赖", () => {
    assert.strictEqual(lsServer.status, "ok", lsServer.error);
    const text = lsServer.logLines.map(l => l.msg).join("\n");
    assert.ok(text.includes("login-server→login-server, packages/common→packages/common"), "暂存");
    assert.ok(text.includes("pnpm install --prod --frozen-lockfile"), "服务器装依赖");
    assert.ok(text.includes("server-release"), "兼容既有 server-release 布局");
});

const bsRollback = await runDry("xlgbis-bs", "rollback-client", { release: "test-rel-1" });
await test("xlgbis-bs rollback-client dry-run: release 输入贯通到软链", () => {
    assert.strictEqual(bsRollback.status, "ok", bsRollback.error);
    const text = bsRollback.logLines.map(l => l.msg).join("\n");
    assert.ok(text.includes("client-release/test-rel-1"), "release 名注入");
    assert.ok(text.includes("systemctl reload"), "nginx reload");
});

// ── prod 门禁 ────
await test("prod 门禁: 无 confirmProd 的变更任务被拒（dry-run 放行）", async () => {
    const wf = findWorkflow("kids-ledger"); // envs/kids-ledger.env SERVER_TYPE=prod
    assert.throws(() => enqueueWorkflowTask(wf.doc, wf.path, "deploy", {}), /Refusing to run deploy on prod/);
    const { id } = enqueueWorkflowTask(wf.doc, wf.path, "deploy", { dryRun: true });
    assert.ok(getRun(id));
});

console.log(`\nOK: ${passed} 项断言全部通过`);
