#!/usr/bin/env node
/**
 * 对纯逻辑（渲染/env/打包/release 名校验/工作流编译与类型校验）做单元断言，对部署流程做 dry-run 断言。
 * 全绿输出 OK；任一断言失败非零退出。
 * 工作流 e2e 用例自带 fixture git 仓库 + env，不依赖任何模板；三个迁移后的应用（kids-ledger、
 * xlgbis-ls/bs）只做编译/加载断言（真实部署需 envs/*.env 与远端服务器）。
 */
import assert from "assert";
import fs from "fs";
import path from "path";
import child_process from "child_process";
import url from "url";
import { renderTemplate } from "../engine/render.js";
import { loadEnv, pickEnvFileContent } from "../engine/env.js";
import { compress, listArchive } from "../engine/tarball.js";
import { validateReleaseName } from "../engine/release.js";
import { enqueueTask, getRun, TMP_DIR } from "../engine/runner.js";
import { loadApps } from "../engine/registry.js";
import { compileWorkflowApp, describeSteps } from "../engine/workflow.js";
import { buildSpaPreset, buildBlankPreset } from "../engine/presets.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passed = 0;

/** @param {string} name @param {() => void | Promise<void>} fn */
async function test(name, fn) {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
}

// ── render ────
await test("render: 替换所有 {{KEY}}", () => {
    assert.strictEqual(renderTemplate("a={{A}} b={{B}}", { A: 1, B: "x" }, "t"), "a=1 b=x");
});
await test("render: 未解析变量报错并列名", () => {
    assert.throws(() => renderTemplate("{{A}} {{MISSING}}", { A: 1 }, "t.tpl"), /unresolved template vars in t\.tpl: MISSING/);
});

// ── env ────
const fpEnv = path.join(TMP_DIR, "verify.env");
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.writeFileSync(fpEnv, "HOST=h1\nPORT=3050\nFLAG=true\nEMPTY=\nBAD=notanumber\n");
await test("env: schema 校验 + 类型转换", () => {
    const env = loadEnv(fpEnv, { HOST: "x", PORT: 1, FLAG: false, EMPTY: "" });
    assert.strictEqual(env.HOST, "h1");
    assert.strictEqual(env.PORT, 3050);
    assert.strictEqual(env.FLAG, true);
});
await test("env: 缺键报错", () => {
    assert.throws(() => loadEnv(fpEnv, { NOPE: "x" }), /Missing env keys: NOPE/);
});
await test("env: 数字键非法值报错", () => {
    assert.throws(() => loadEnv(fpEnv, { HOST: "x", PORT: 1, FLAG: false, EMPTY: "", BAD: 2 }), /invalid number/);
});
await test("env: pickEnvFileContent 只输出指定键并支持注入", () => {
    assert.strictEqual(pickEnvFileContent({ A: 1, B: 2 }, ["A"], { C: 3 }), "A=1\nC=3\n");
});

// ── tarball ────
const tDir = path.join(TMP_DIR, "verify-tar");
fs.rmSync(tDir, { recursive: true, force: true });
fs.mkdirSync(path.join(tDir, "sub"), { recursive: true });
fs.writeFileSync(path.join(tDir, "a.txt"), "a");
fs.writeFileSync(path.join(tDir, "sub", "b.txt"), "b");
const fpTgz = path.join(TMP_DIR, "verify.tar.gz");
await compress(tDir, ["a.txt", "sub"], fpTgz);
await test("tarball: 打包并列出内容", async () => {
    const entries = await listArchive(fpTgz);
    assert.ok(entries.includes("a.txt"), `entries=${entries}`);
    assert.ok(entries.some(e => e.replace(/\/$/, "") === "sub"));
    assert.ok(entries.includes(path.join("sub", "b.txt").replace(/\\/g, "/")));
});

// ── release 名校验 ────
await test("release: 合法名通过，路径穿越被拒", () => {
    validateReleaseName("master-abc1234-20260922081530");
    assert.throws(() => validateReleaseName("../evil"), /Invalid release name/);
    assert.throws(() => validateReleaseName("a/b"), /Invalid release name/);
});

// ── 应用加载（workflows/*.json 是唯一来源）────
const apps = await loadApps();
await test("apps: 三个迁移后的工作流应用加载且任务齐全", () => {
    const expect = {
        "kids-ledger": ["deploy", "rollback", "status", "apply-config"],
        "xlgbis-ls": ["deploy-client", "rollback-client", "deploy-server", "rollback-server", "status", "apply-config"],
        "xlgbis-bs": ["deploy-client", "rollback-client", "deploy-server", "rollback-server", "status", "apply-config"],
    };
    for (const [name, tasks] of Object.entries(expect)) {
        assert.ok(apps[name], `${name} 应已加载`);
        assert.deepStrictEqual(Object.keys(apps[name].tasks).sort(), [...tasks].sort(), `${name} 任务清单`);
        assert.strictEqual(apps[name].source, "workflow");
    }
});
await test("apps: *.example.json 不加载；status 任务 mutates=false", () => {
    assert.ok(!apps["my-site"], "spa.example.json 不应被加载为应用");
    assert.strictEqual(apps["kids-ledger"].tasks.status.mutates, false);
    assert.strictEqual(apps["kids-ledger"].tasks.deploy.mutates, true);
});

// ── 工作流：编译 ────
await test("workflow: SPA/空白预设可编译，步骤元数据可用", () => {
    const spa = compileWorkflowApp(buildSpaPreset({ name: "wf-demo", repoDir: "C:/tmp/wf-demo", nginxTemplate: "deploy/nginx.conf" }).json, "workflows/wf-demo.json");
    assert.deepStrictEqual(Object.keys(spa.tasks).sort(), ["deploy", "nginx-config", "rollback", "status"]);
    const blank = compileWorkflowApp(buildBlankPreset({ name: "wf-blank", repoDir: "C:/tmp/wf-blank" }).json, "workflows/wf-blank.json");
    assert.ok(blank.tasks.deploy);
    const types = describeSteps().map(s => s.type);
    for (const t of ["git.checkout", "env.write", "shell", "archive", "upload", "remote", "template.push", "vars.set", "log"]) {
        assert.ok(types.includes(t), `缺少步骤类型 ${t}`);
    }
});
await test("workflow: 未知步骤类型 / 重复 checkout 报错", () => {
    const base = { name: "x", repoDir: "a", envFile: "a.env", workflows: {} };
    assert.throws(
        () => compileWorkflowApp({ ...base, workflows: { deploy: [{ type: "nope" }] } }),
        /未知步骤类型 "nope"/,
    );
    assert.throws(
        () => compileWorkflowApp({ ...base, workflows: { deploy: [{ type: "git.checkout" }, { type: "shell", command: "x" }, { type: "git.checkout" }] } }),
        /只允许一个 git\.checkout/,
    );
});

// ── 类型校验 ────
await test("类型: path 不可嵌入文本槽（文件不能当字符串入参），bash 槽可以", () => {
    const base = { name: "x", repoDir: "a", envFile: "a.env" };
    /** @param {() => void} fn */
    const errOf = fn => { try { fn(); } catch (/** @type {any} */ e) { return e; } return null; };
    const err = errOf(() => compileWorkflowApp({ ...base, workflows: { deploy: [{ type: "log", message: "dir is {{repoDir}}" }] } }));
    assert.ok(err, "path 嵌入文本槽应报错");
    assert.match(err.message, /{{repoDir}}（path，来自内置）类型不兼容/);
    assert.match(err.message, /string 槽位只接受 string\/number\/bool/);
    compileWorkflowApp({ ...base, workflows: { deploy: [{ type: "remote", command: "ls {{repoDir}}" }] } });
});
await test("类型: 前向引用（产出前）与未定义引用被拦截", () => {
    const base = { name: "x", repoDir: "a", envFile: "a.env" };
    /** @param {() => void} fn */
    const errOf = fn => { try { fn(); } catch (/** @type {any} */ e) { return e; } return null; };
    const e1 = errOf(() => compileWorkflowApp({
        ...base,
        envSchema: { DEPLOY_DIR: "/opt/x" },
        workflows: { deploy: [
            { type: "upload", from: "{{archivePath}}", to: "/tmp/a" },
            { type: "archive", source: "{{repoDir}}/dist" },
        ] },
    }));
    assert.ok(e1, "前向引用应报错");
    assert.match(e1.message, /在步骤\[2\] 产出之前引用了 \{\{archivePath\}\}/);
    const e2 = errOf(() => compileWorkflowApp({ ...base, workflows: { deploy: [{ type: "log", message: "{{NOPE}}" }] } }));
    assert.ok(e2, "未定义引用应报错");
    assert.match(e2.message, /引用了未定义的 \{\{NOPE\}\}/);
});
await test("类型: vars.set 声明的类型化产出可被后续 remote_path 槽引用", () => {
    compileWorkflowApp({
        name: "x", repoDir: "a", envFile: "a.env", envSchema: { DEPLOY_DIR: "/opt/x" },
        workflows: { deploy: [
            { type: "git.checkout", ref: "{{ref}}" },
            { type: "vars.set", pairs: { relDir: "{{DEPLOY_DIR}}/releases/{{releaseName}}" }, types: { relDir: "remote_path" } },
            { type: "upload", from: "{{repoDir}}/a.tgz", to: "{{relDir}}/a.tgz" },
        ] },
    });
});

// ── 工作流：dry-run 端到端（自带 fixture git 仓库 + env，不依赖任何模板）────
const wfRepo = path.join(TMP_DIR, "verify-wf-repo");
fs.rmSync(wfRepo, { recursive: true, force: true });
fs.mkdirSync(path.join(wfRepo, "dist"), { recursive: true });
fs.mkdirSync(path.join(wfRepo, "deploy"), { recursive: true });
fs.writeFileSync(path.join(wfRepo, "dist", "index.html"), "<html>ok</html>");
fs.writeFileSync(path.join(wfRepo, "deploy", "nginx.conf"), "server {\n  server_name {{DOMAIN}};\n  root {{DEPLOY_DIR}}/current;\n}\n");
const git = (/** @type {string} */ c) => child_process.execSync(c, { cwd: wfRepo, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
git("git init -q -b main");
git("git config user.email verify@test");
git("git config user.name verify");
git("git add -A");
git("git commit -qm init");

const fpWfEnv = path.join(TMP_DIR, "verify-wf.env");
fs.writeFileSync(fpWfEnv, "SERVER_TYPE=test\nREMOTE_HOST=wftest.example.com\nREMOTE_USER=deploy\nREMOTE_HOST_FINGERPRINT=\nDEPLOY_DIR=/opt/verify-wf\nDOMAIN=wfdemo.example.com\n");
const fpWfEnvProd = path.join(TMP_DIR, "verify-wf-prod.env");
fs.writeFileSync(fpWfEnvProd, "SERVER_TYPE=prod\nREMOTE_HOST=wftest.example.com\nREMOTE_USER=deploy\nREMOTE_HOST_FINGERPRINT=\nDEPLOY_DIR=/opt/verify-wf\nDOMAIN=wfdemo.example.com\n");

const wfApp = compileWorkflowApp({
    name: "verify-wf",
    title: "verify workflow",
    repoDir: wfRepo,
    envFile: "verify-wf.env",
    envSchema: { SERVER_TYPE: "test", REMOTE_HOST: "wftest.example.com", REMOTE_USER: "deploy", REMOTE_HOST_FINGERPRINT: "", DEPLOY_DIR: "/opt/verify-wf", DOMAIN: "wfdemo.example.com" },
    params: { buildCommand: "echo built" },
    workflows: {
        deploy: {
            steps: [
                { type: "git.checkout", ref: "{{ref}}" },
                { type: "log", message: "deploying {{app}} @ {{ref}}" },
                { type: "env.write", file: ".env", pairs: { VITE_VERSION: "{{versionId}}", VITE_DOMAIN: "{{DOMAIN}}" } },
                { type: "shell", command: "echo building {{app}}-{{versionId}}", title: "构建" },
                { type: "archive", source: "{{repoDir}}/dist" },
                { type: "vars.set", pairs: { relDir: "{{DEPLOY_DIR}}/releases/{{releaseName}}" }, types: { relDir: "remote_path" } },
                { type: "upload", from: "{{archivePath}}", to: "{{DEPLOY_DIR}}/build/{{archiveName}}" },
                { type: "remote", command: "mkdir -p {{relDir}} && tar -xzf {{DEPLOY_DIR}}/build/{{archiveName}} -C {{relDir}}" },
                { type: "remote", command: "ln -sfn {{relDir}} {{DEPLOY_DIR}}/current" },
                { type: "remote", command: "nginx -t && systemctl reload nginx", sudo: true },
            ],
        },
        rollback: { steps: [{ type: "remote", command: "ln -sfn {{DEPLOY_DIR}}/releases/{{release}} {{DEPLOY_DIR}}/current" }] },
        status: { mutates: false, steps: [{ type: "remote", command: "readlink -f {{DEPLOY_DIR}}/current || true" }] },
        "nginx-config": { steps: [{ type: "template.push", template: "deploy/nginx.conf", to: "{{DEPLOY_DIR}}/nginx-site.conf" }] },
    },
}, "workflows/verify-wf.json");

/**
 * @param {any} manifest
 * @param {string} taskName
 * @param {Record<string, any>} options
 */
async function runWf(manifest, taskName, options = {}) {
    const { id } = await enqueueTask(manifest, taskName, { ...options, dryRun: true, envName: fpWfEnv });
    for (;;) {
        const run = getRun(id);
        if (run && (run.status === "ok" || run.status === "failed")) return run;
        await new Promise(r => setTimeout(r, 100));
    }
}
const wfText = (/** @type {any} */ run) => run.logLines.map((/** @type {any} */ l) => l.msg).join("\n");

const wfDeploy = await runWf(wfApp, "deploy", { ref: "main" });
await test("workflow deploy dry-run: 成功且产出完整步骤计划（含 vars.set/log）", () => {
    assert.strictEqual(wfDeploy.status, "ok", wfDeploy.error);
    const text = wfText(wfDeploy);
    assert.ok(/version: main-[0-9a-f]+/.test(text), `应包含版本号: ${text.slice(0, 400)}`);
    assert.ok(text.includes("deploying verify-wf @ main"), "log 步骤应渲染引用");
    assert.ok(text.includes("VITE_VERSION="), "env.write 应打印键值");
    assert.ok(text.includes("echo building verify-wf-main-"), "shell 应渲染 params/vars");
    assert.ok(text.includes("[dry-run] 将上传"), "upload 应打印计划");
    assert.ok(text.includes("mkdir -p /opt/verify-wf/releases/"), "vars.set 产出 relDir 应渲染进远端命令");
    assert.ok(text.includes("tar -xzf /opt/verify-wf/build/"), "远端解包计划");
    assert.match(text, /ln -sfn \/opt\/verify-wf\/releases\/\S+ \/opt\/verify-wf\/current/, "软链切换计划");
    assert.ok(text.includes("remote$ sudo -n nginx -t && systemctl reload nginx"), "sudo reload 计划");
});
await test("workflow deploy dry-run: 不写 .env、不建 SSH、产物已清理", () => {
    assert.ok(!fs.existsSync(path.join(wfRepo, ".env")), "dry-run 不应写入 .env");
    assert.ok(!wfText(wfDeploy).includes("Connecting to"), "dry-run 不应建立 SSH 连接");
    const leftover = fs.readdirSync(TMP_DIR).filter(f => f.startsWith("verify-wf-main-"));
    assert.deepStrictEqual(leftover, [], "打包产物应被清理");
});
await test("workflow deploy dry-run: git 工作树恢复原分支", () => {
    assert.strictEqual(git("git branch --show-current"), "main");
    assert.strictEqual(git("git status --porcelain"), "");
});

await test("workflow rollback: 无 --release 被拒；带 --release 渲染正确", async () => {
    const noRelease = await runWf(wfApp, "rollback");
    assert.strictEqual(noRelease.status, "failed");
    assert.match(noRelease.error ?? "", /--release/);
    const rb = await runWf(wfApp, "rollback", { release: "main-abc1234-20260922081530" });
    assert.strictEqual(rb.status, "ok", rb.error);
    assert.ok(wfText(rb).includes("ln -sfn /opt/verify-wf/releases/main-abc1234-20260922081530 /opt/verify-wf/current"));
});
await test("workflow status: 免构建直查远端（dry-run 打印计划）", async () => {
    const st = await runWf(wfApp, "status");
    assert.strictEqual(st.status, "ok", st.error);
    assert.ok(wfText(st).includes("readlink -f /opt/verify-wf/current"));
});
await test("workflow template.push: 应用仓库模板渲染后推送（dry-run 打印内容）", async () => {
    const ng = await runWf(wfApp, "nginx-config");
    assert.strictEqual(ng.status, "ok", ng.error);
    const text = wfText(ng);
    assert.ok(text.includes("server_name wfdemo.example.com;"), "DOMAIN 应已渲染");
    assert.ok(text.includes("root /opt/verify-wf/current;"), "DEPLOY_DIR 应已渲染");
});
await test("workflow: prod 门禁与 runner 门禁一致（confirmProd 缺失被拒）", () => {
    assert.throws(
        () => enqueueTask(wfApp, "deploy", { envName: fpWfEnvProd }),
        /Refusing to run deploy on prod/,
    );
});

console.log(`\nOK: ${passed} 项断言全部通过`);
