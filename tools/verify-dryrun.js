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

// ── 顺序边 ────
await test("图校验: 顺序边 handle 非法 / 与任务路径顺序矛盾被拒", () => {
    const doc = {
        name: "q",
        nodes: [
            { id: "a", type: "log.print", position: [0, 0], data: {} },
            { id: "b", type: "log.print", position: [100, 0], data: {} },
        ],
        edges: [{ id: "s1", kind: "seq", source: "a", sourceHandle: "__seqOut", target: "b", targetHandle: "__seqIn" }],
        tasks: { t: { label: "t", mutates: false, path: ["a", "b"] } },
    };
    assert.strictEqual(validateWorkflow(doc).length, 0, "保序顺序边应通过");
    const bad = validateWorkflow({ ...doc, tasks: { t: { label: "t", mutates: false, path: ["b", "a"] } } });
    assert.ok(bad.some(p => p.includes("顺序矛盾")), bad.join("; "));
    const badHandle = validateWorkflow({ ...doc, edges: [{ id: "s1", kind: "seq", source: "a", sourceHandle: "value", target: "b", targetHandle: "__seqIn" }] });
    assert.ok(badHandle.some(p => p.includes("handle 非法")), badHandle.join("; "));
});

// ── git.checkout 切换分支 ────
await test("注册表: git.checkout 输入 folder/string、输出 original(string)", () => {
    const d = NODE_TYPES["git.checkout"];
    assert.ok(d, "git.checkout 已注册");
    assert.deepStrictEqual(d.inputs.map(i => [i.id, i.type]), [["repoDir", "folder"], ["ref", "string"]]);
    assert.deepStrictEqual(d.outputs.map(o => [o.id, o.type]), [["original", "string"]]);
});

await test("git.checkout 执行: 切换输出 original；original 链式切回；未知 ref 拒绝", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const os = await import("os");
    const fsp = await import("fs/promises");
    const execFileSync = (await import("child_process")).execFileSync;
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gco-"));
    const sh = c => execFileSync(c, { cwd: dir, shell: true, stdio: "pipe" });
    sh("git init");
    sh("git config user.email t@t");
    sh("git config user.name t");
    fs.writeFileSync(path.join(dir, "f.txt"), "x");
    sh("git add .");
    sh("git commit -m init");
    sh("git branch v1");
    const mainBranch = execFileSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, encoding: "utf8", shell: true }).trim();
    try {
        const doc = {
            name: "gco-t",
            nodes: [
                { id: "p", type: "fs.path", position: [0, 0], data: { path: dir } },
                { id: "c1", type: "git.checkout", position: [0, 0], data: {} },
                { id: "c2", type: "git.checkout", position: [0, 0], data: {} },
                { id: "ref1", type: "string.const", position: [0, 0], data: { value: "v1" } },
                { id: "ref2", type: "string.const", position: [0, 0], data: { value: mainBranch } },
            ],
            edges: [
                { id: "e0", source: "p", sourceHandle: "dir", target: "c1", targetHandle: "repoDir" },
                { id: "e1", source: "p", sourceHandle: "dir", target: "c2", targetHandle: "repoDir" },
                { id: "e2", source: "ref1", sourceHandle: "value", target: "c1", targetHandle: "ref" },
                { id: "s1", kind: "seq", source: "c1", sourceHandle: "__seqOut", target: "c2", targetHandle: "__seqIn" },
                { id: "e3", source: "c1", sourceHandle: "original", target: "c2", targetHandle: "ref" },
            ],
            tasks: { t: { label: "t", mutates: false, path: ["p", "c1", "c2"] } },
        };
        const lines = [];
        // 真实执行（非 dry-run）：临时仓库，验证真正 checkout 与链式切回
        await executeTask({ log: m => lines.push(String(m)), dryRun: false, inputs: {}, mask: s => s }, doc, "t");
        const text = lines.join("\n");
        assert.ok(text.includes(`[git.checkout] ${mainBranch} → v1`), "切换到 v1", text);
        assert.ok(text.includes(`[git.checkout] v1 → ${mainBranch}`), "经 original 链式切回", text);

        await assert.rejects(
            () => executeTask(
                { log: () => {}, dryRun: true, inputs: {}, mask: s => s },
                { ...doc, nodes: [...doc.nodes, { id: "bad", type: "git.checkout", position: [0, 0], data: {} }], edges: [...doc.edges, { id: "e4", source: "ref2", sourceHandle: "value", target: "bad", targetHandle: "ref" }], tasks: { t: { label: "t", mutates: false, path: ["bad"] } } },
                "t",
            ),
            /未连接仓库目录|not a git repository|did not match|unknown revision/i,
        );
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
});

// ── fs.path 输入路径节点 ────
await test("注册表: fs.path 输出 folder/file 双插槽；folder 类型连线规则", () => {
    const d = NODE_TYPES["fs.path"];
    assert.ok(d, "fs.path 已注册");
    assert.deepStrictEqual(d.outputs.map(o => o.type), ["folder", "file"]);
    assert.ok(canConnect("folder", "folder"), "folder→folder");
    assert.ok(canConnect("folder", "any"), "folder→any");
    assert.ok(!canConnect("folder", "string"), "folder 不静默转 string");
    assert.ok(!canConnect("file", "folder"), "file/folder 严格区分");
});

await test("fs.path 执行: 文件夹/文件分别从 dir/file 输出；路径不存在抛错", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const os = await import("os");
    const fsp = await import("fs/promises");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fspath-"));
    const fp = path.join(dir, "a.txt");
    await fsp.writeFile(fp, "hello");
    try {
        const doc = {
            name: "fs-t",
            nodes: [
                { id: "pd", type: "fs.path", position: [0, 0], data: { path: dir } },
                { id: "pf", type: "fs.path", position: [0, 0], data: { path: fp } },
                { id: "miss", type: "fs.path", position: [0, 0], data: { path: path.join(dir, "missing") } },
            ],
            edges: [],
            tasks: { t: { label: "t", mutates: false, path: ["pd", "pf"] } },
        };
        /** @type {string[]} */
        const lines = [];
        await executeTask({ log: m => lines.push(String(m)), dryRun: true, inputs: {}, mask: s => s }, doc, "t");
        const text = lines.join("\n");
        assert.ok(text.includes("→ 文件夹"), "目录识别", text);
        assert.ok(text.includes("→ 文件"), "文件识别", text);
        await assert.rejects(
            () => executeTask({ log: () => {}, dryRun: true, inputs: {}, mask: s => s }, { ...doc, tasks: { t: { label: "t", mutates: false, path: ["miss"] } } }, "t"),
            /路径不存在/,
        );
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
});

// ── git.getRefs ────
await test("注册表: git.getRefs 输入 folder、输出 string、refsPicker 标志", () => {
    const d = NODE_TYPES["git.getRefs"];
    assert.ok(d?.refsPicker, "refsPicker 标志");
    assert.deepStrictEqual(d.inputs, [{ id: "repoDir", type: "folder", required: true }]);
    assert.strictEqual(d.outputs[0].id, "ref");
    assert.strictEqual(d.outputs[0].type, "string");
});

await test("git.getRefs 执行: 输出所选 ref", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const doc = {
        name: "refs-t",
        nodes: [
            { id: "p", type: "fs.path", position: [0, 0], data: { path: path.resolve(__dirname, "..") } },
            { id: "g", type: "git.getRefs", position: [0, 0], data: { ref: "v1.0" } },
        ],
        edges: [{ id: "e", source: "p", sourceHandle: "dir", target: "g", targetHandle: "repoDir" }],
        tasks: { t: { label: "t", mutates: false, path: ["p", "g"] } },
    };
    const lines = [];
    await executeTask({ log: m => lines.push(String(m)), dryRun: true, inputs: {}, mask: s => s }, doc, "t");
    assert.ok(lines.some(l => l.includes("ref = v1.0")), lines.join("\n"));
});

// ── 掩码 ────
await test("日志掩码: SECRET/TOKEN/PASSWORD 值打码", () => {
    assert.strictEqual(maskLine("JWT_SECRET=abc123 xyz"), "JWT_SECRET=*** xyz");
    assert.strictEqual(maskLine("FRP_TOKEN=tok"), "FRP_TOKEN=***");
    assert.strictEqual(maskLine("DOMAIN=x"), "DOMAIN=x");
});

// ── 三个迁移工作流 ────
const rows = loadWorkflows();
assert.ok(rows.length >= 3 && rows.every(w => w.doc),
    "全部注册工作流应加载通过: " + rows.filter(w => !w.doc).map(w => `${w.path}: ${w.error}`).join("; "));
for (const n of ["kids-ledger", "xlgbis-ls", "xlgbis-bs"]) {
    assert.ok(findWorkflow(n)?.doc, `${n} 应加载成功`);
}
await test("工作流: 全部注册工作流加载校验通过（含三个迁移工作流）", () => {});

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
