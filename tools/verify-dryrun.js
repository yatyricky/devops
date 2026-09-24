#!/usr/bin/env node
/**
 * 节点图模型自检：类型系统/图校验/任务子图（选点 → DAG）/并发调度/prod 门禁（struct）/掩码
 * + struct 构造析构与动态出口断言。全绿输出 OK；任一断言失败非零退出。
 * 旧 wf 已存档 workflows/_attic/（等重写），本套件自带 fixture，不依赖 envs/。
 */
import assert from "assert";
import path from "path";
import url from "url";
import { canConnect } from "../engine/types.js";
import { validateWorkflow } from "../engine/workflow.js";
import { NODE_TYPES, getInputs, getOutputs } from "../engine/nodes/index.js";
import { loadWorkflows } from "../engine/registry.js";
import { enqueueWorkflowTask, getRun, maskLine, ROOT } from "../engine/runner.js";
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
await test("类型: 同型可连，struct→any 放行，any→具体/跨具体类型拒绝", () => {
    assert.ok(canConnect("struct", "struct"));
    assert.ok(canConnect("struct", "any"));
    assert.ok(canConnect("string", "any"));
    assert.ok(!canConnect("any", "string"), "any 输出不可入 string 输入");
    assert.ok(!canConnect("string", "struct"), "string 不可入 struct");
    assert.ok(!canConnect("file", "string"), "file/string 严格区分");
    assert.ok(!canConnect("ssh", "struct"));
    assert.ok(!canConnect("string", "number"), "number 输入只收 number");
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

await test("图校验: 未知类型/悬空任务节点被拒；元图允许多条备选连线进同一输入", () => {
    const problems = validateWorkflow({
        name: "t", nodes: [
            { id: "a1", type: "string.const", position: [0, 0], data: { value: "x" } },
            { id: "a2", type: "string.const", position: [0, 0], data: { value: "y" } },
            { id: "b", type: "log.print", position: [0, 0], data: {} },
            { id: "c", type: "no.such.type", position: [0, 0], data: {} },
        ],
        edges: [
            { id: "e1", source: "a1", sourceHandle: "value", target: "b", targetHandle: "value" },
            { id: "e2", source: "a2", sourceHandle: "value", target: "b", targetHandle: "value" },
        ],
        tasks: { x: { label: "x", mutates: false, nodes: ["ghost"] } },
    });
    assert.ok(problems.some(p => p.includes("类型未知")), "未知类型");
    assert.ok(problems.some(p => p.includes("不存在的节点")), "悬空任务节点");
    assert.ok(!problems.some(p => p.includes("多条连线")), "元图允许多条备选连线（唯一性在任务级校验）");
});

// ── 任务子图语义（选点 → 1 个或多个 DAG）────
/** fan-out：1 → 2、1 → 3 */
const fanDoc = {
    name: "fan", nodes: [
        { id: "1", type: "string.const", position: [0, 0], data: { value: "x" } },
        { id: "2", type: "log.print", position: [0, 0], data: {} },
        { id: "3", type: "log.print", position: [0, 0], data: {} },
    ],
    edges: [
        { id: "e12", source: "1", sourceHandle: "value", target: "2", targetHandle: "value" },
        { id: "e13", source: "1", sourceHandle: "value", target: "3", targetHandle: "value" },
    ],
    tasks: {},
};
/** 双入：1 → 2、3 → 2（大图两条备选连线） */
const dblDoc = {
    name: "dbl", nodes: [
        { id: "1", type: "string.const", position: [0, 0], data: { value: "x" } },
        { id: "3", type: "string.const", position: [0, 0], data: { value: "y" } },
        { id: "2", type: "log.print", position: [0, 0], data: {} },
    ],
    edges: [
        { id: "e12", source: "1", sourceHandle: "value", target: "2", targetHandle: "value" },
        { id: "e32", source: "3", sourceHandle: "value", target: "2", targetHandle: "value" },
    ],
    tasks: {},
};
/** 链：1 → 2 → 3 */
const chainDoc = {
    name: "chain", nodes: [
        { id: "1", type: "string.const", position: [0, 0], data: { value: "x" } },
        { id: "2", type: "string.format", position: [0, 0], data: { format: "p {{v}}" } },
        { id: "3", type: "log.print", position: [0, 0], data: {} },
    ],
    edges: [
        { id: "e12", source: "1", sourceHandle: "value", target: "2", targetHandle: "v" },
        { id: "e23", source: "2", sourceHandle: "value", target: "3", targetHandle: "value" },
    ],
    tasks: {},
};
const task = (/** @type {any} */ doc, /** @type {string[]} */ nodes) =>
    validateWorkflow({ ...structuredClone(doc), tasks: { t: { label: "t", mutates: false, nodes } } });

await test("任务选点 case1 fan-out: 选 3 报闭包错；选 123 / 选 12 合法", () => {
    assert.match(task(fanDoc, ["3"]).join("; "), /必填输入 value 依赖节点 1，未选入/);
    assert.deepStrictEqual(task(fanDoc, ["1", "2", "3"]), []);
    assert.deepStrictEqual(task(fanDoc, ["1", "2"]), []);
});
await test("任务选点 case2 双入: 大图合法；选 123 报只能一个输入；选 12 / 选 23 合法", () => {
    assert.deepStrictEqual(validateWorkflow(structuredClone(dblDoc)), [], "元图允许多条备选连线");
    assert.match(task(dblDoc, ["1", "2", "3"]).join("; "), /输入 2\.value 有 2 条连线，只能有一个输入/);
    assert.deepStrictEqual(task(dblDoc, ["1", "2"]), []);
    assert.deepStrictEqual(task(dblDoc, ["2", "3"]), []);
});
await test("任务选点 case3 链: 选 1,3 报闭包错（2 未选）；选 123 合法", () => {
    assert.match(task(chainDoc, ["1", "3"]).join("; "), /必填输入 value 依赖节点 2，未选入/);
    assert.deepStrictEqual(task(chainDoc, ["1", "2", "3"]), []);
});
await test("任务选点: 可选入边源未选 → 合法（该输入视作未连线）", () => {
    const optDoc = {
        name: "opt", nodes: [
            { id: "1", type: "string.const", position: [0, 0], data: { value: "v1" } },
            { id: "g", type: "git.ref", position: [0, 0], data: { repoDir: "." } },
        ],
        edges: [{ id: "e", source: "1", sourceHandle: "value", target: "g", targetHandle: "ref" }],
        tasks: {},
    };
    assert.deepStrictEqual(task(optDoc, ["g"]), [], "非 required 入边的源可不选");
});
await test("任务选点: required 未画线 vs 画线但源未选，两种错误可区分", () => {
    const noWire = validateWorkflow({
        ...structuredClone(dblDoc),
        edges: [],
        tasks: { t: { label: "t", mutates: false, nodes: ["2"] } },
    });
    assert.match(noWire.join("; "), /必填输入 value 未连线/);
    assert.doesNotMatch(noWire.join("; "), /未选入/);
    const closed = task(dblDoc, ["2", "3"]);
    assert.deepStrictEqual(closed, [], "选 2,3 时源已选，不应报闭包错");
});
await test("图校验: 顺序边 handle 非法被拒", () => {
    const doc = {
        name: "q",
        nodes: [
            { id: "a", type: "log.print", position: [0, 0], data: {} },
            { id: "b", type: "log.print", position: [100, 0], data: {} },
        ],
        edges: [{ id: "s1", kind: "seq", source: "a", sourceHandle: "value", target: "b", targetHandle: "__seqIn" }],
        tasks: { t: { label: "t", mutates: false, nodes: ["a", "b"] } },
    };
    const problems = validateWorkflow(doc);
    assert.ok(problems.some(p => p.includes("handle 非法")), problems.join("; "));
});
await test("任务选点: seq 环被拒", () => {
    const cycDoc = {
        name: "cyc", nodes: [
            { id: "s", type: "string.const", position: [0, 0], data: { value: "x" } },
            { id: "a", type: "log.print", position: [0, 0], data: {} },
            { id: "b", type: "log.print", position: [0, 0], data: {} },
            { id: "c", type: "log.print", position: [0, 0], data: {} },
        ],
        edges: [
            { id: "e", source: "s", sourceHandle: "value", target: "a", targetHandle: "value" },
            { id: "s1", kind: "seq", source: "a", sourceHandle: "__seqOut", target: "b", targetHandle: "__seqIn" },
            { id: "s2", kind: "seq", source: "b", sourceHandle: "__seqOut", target: "c", targetHandle: "__seqIn" },
            { id: "s3", kind: "seq", source: "c", sourceHandle: "__seqOut", target: "a", targetHandle: "__seqIn" },
        ],
        tasks: { t: { label: "t", mutates: false, nodes: ["s", "a", "b", "c"] } },
    };
    assert.match(validateWorkflow(cycDoc).join("; "), /存在环依赖/);
});
await test("legacy path: 加载时静默规范化为 nodes 并补数据依赖闭包", () => {
    const doc = structuredClone(fanDoc);
    doc.tasks = { t: { label: "t", mutates: false, path: ["2"] } };
    assert.deepStrictEqual(validateWorkflow(doc), []);
    assert.ok(doc.tasks.t.nodes.includes("1"), "闭包应补上数据源 1");
    assert.ok(!("path" in doc.tasks.t), "path 应被规范化掉");
});

// ── 并发调度执行 ────
await test("执行: fan-out 批次并发（1 先行，2/3 同批）", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const doc = structuredClone(fanDoc);
    doc.nodes[1].data.title = "b2";
    doc.nodes[2].data.title = "b3";
    doc.tasks = { t: { label: "t", mutates: false, nodes: ["1", "2", "3"] } };
    /** @type {string[]} */
    const lines = [];
    await executeTask({ log: m => lines.push(String(m)), dryRun: true, inputs: {}, mask: s => s }, doc, "t");
    const text = lines.join("\n");
    assert.ok(text.includes("批次并发 2"), "2、3 应同批并发", text);
    const i1 = text.indexOf("[常量] 1");
    assert.ok(i1 !== -1 && i1 < text.indexOf("预览：b2") && i1 < text.indexOf("预览：b3"), "1 应先于 2/3", text);
});
await test("执行: 分支失败任务失败（同批好分支已落地）", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const doc = structuredClone(fanDoc);
    doc.nodes[1].data.title = "b2";
    doc.nodes[2] = { id: "3", type: "fs.path", position: [0, 0], data: { path: "Z:/definitely-missing-xyz" } };
    doc.tasks = { t: { label: "t", mutates: false, nodes: ["1", "2", "3"] } };
    /** @type {string[]} */
    const lines = [];
    await assert.rejects(
        () => executeTask({ log: m => lines.push(String(m)), dryRun: true, inputs: {}, mask: s => s }, doc, "t"),
        /路径不存在/,
    );
    assert.ok(lines.join("\n").includes("预览：b2"), "同批好分支应已执行");
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
            tasks: { t: { label: "t", mutates: false, nodes: ["p", "ref1", "c1", "c2"] } },
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
await test("注册表: fs.path 动态出口标志 + folder 类型连线规则", () => {
    const d = NODE_TYPES["fs.path"];
    assert.ok(d, "fs.path 已注册");
    assert.strictEqual(d.dynamicOutputs, "fsPath", "动态出口规则");
    assert.ok(canConnect("folder", "folder"), "folder→folder");
    assert.ok(canConnect("folder", "any"), "folder→any");
    assert.ok(!canConnect("folder", "string"), "folder 不静默转 string");
    assert.ok(!canConnect("file", "folder"), "file/folder 严格区分");
});

await test("expandHome: ~ 解析为用户主目录，非 ~ 路径原样", async () => {
    const { expandHome } = await import("../engine/exec.js");
    const os = await import("os");
    assert.strictEqual(expandHome("~"), os.homedir());
    assert.strictEqual(expandHome("~/a/b"), path.join(os.homedir(), "a", "b"));
    assert.strictEqual(expandHome("~\\a"), path.join(os.homedir(), "a"));
    assert.strictEqual(expandHome("  ~/x  "), path.join(os.homedir(), "x"));
    assert.strictEqual(expandHome("C:/x/y"), "C:/x/y");
});

await test("fs.path 执行: 文件夹/文件分别从 dir/file 输出；~ 输出 resolve 后完整路径；路径不存在抛错", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const os = await import("os");
    const fsp = await import("fs/promises");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "fspath-"));
    const fp = path.join(dir, "a.txt");
    await fsp.writeFile(fp, "hello");
    // ~ 用例：临时目录建在用户主目录下，节点里写 ~/basename
    const homeDir = await fsp.mkdtemp(path.join(os.homedir(), "fspath-home-"));
    try {
        const doc = {
            name: "fs-t",
            nodes: [
                { id: "pd", type: "fs.path", position: [0, 0], data: { path: dir } },
                { id: "pf", type: "fs.path", position: [0, 0], data: { path: fp } },
                { id: "ph", type: "fs.path", position: [0, 0], data: { path: `~/${path.basename(homeDir)}` } },
                { id: "miss", type: "fs.path", position: [0, 0], data: { path: path.join(dir, "missing") } },
            ],
            edges: [],
            tasks: { t: { label: "t", mutates: false, nodes: ["pd", "pf", "ph"] } },
        };
        /** @type {string[]} */
        const lines = [];
        await executeTask({ log: m => lines.push(String(m)), dryRun: true, inputs: {}, mask: s => s }, doc, "t");
        const text = lines.join("\n");
        assert.ok(text.includes("（文件夹"), "目录识别", text);
        assert.ok(text.includes("（文件，"), "文件识别", text);
        assert.ok(text.includes(path.resolve(dir)), "目录节点输出 resolve 后完整路径", text);
        assert.ok(text.includes(path.resolve(fp)), "文件节点输出 resolve 后完整路径", text);
        assert.ok(text.includes(path.resolve(homeDir)), "~ 应展开为完整主目录路径", text);
        await assert.rejects(
            () => executeTask({ log: () => {}, dryRun: true, inputs: {}, mask: s => s }, { ...doc, tasks: { t: { label: "t", mutates: false, nodes: ["miss"] } } }, "t"),
            /路径不存在/,
        );
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
        await fsp.rm(homeDir, { recursive: true, force: true });
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
        tasks: { t: { label: "t", mutates: false, nodes: ["p", "g"] } },
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

// ── struct 构造/析构 + 动态出口 ────
const structMake = { id: "m", type: "struct.make", position: [0, 0], data: { fields: [
    { key: "SERVER_TYPE", type: "string", value: "prod" },
    { key: "PORT", type: "number", value: "3000" },
] } };

await test("注册表: struct.make fieldInputs 动态输入与 struct 输出", () => {
    const inputs = getInputs(structMake);
    assert.deepStrictEqual(inputs.map(i => `${i.id}:${i.type}:${i.required ? "必填" : "可选"}`), ["SERVER_TYPE:string:可选", "PORT:number:可选"]);
    assert.deepStrictEqual(getOutputs(structMake), [{ id: "struct", type: "struct" }]);
    assert.ok(NODE_TYPES["struct.make"].fieldInputs, "fieldInputs 标志");
});

await test("动态出口 fsPath: 合法文件夹/文件/不存在 三态", () => {
    const dirDoc = { nodes: [{ id: "f", type: "fs.path", position: [0, 0], data: { path: ROOT } }], edges: [] };
    assert.deepStrictEqual(getOutputs(dirDoc.nodes[0], dirDoc), [{ id: "dir", type: "folder" }]);
    const fileDoc = { nodes: [{ id: "f", type: "fs.path", position: [0, 0], data: { path: path.join(ROOT, "package.json") } }], edges: [] };
    assert.deepStrictEqual(getOutputs(fileDoc.nodes[0], fileDoc), [{ id: "file", type: "file" }]);
    const noneDoc = { nodes: [{ id: "f", type: "fs.path", position: [0, 0], data: { path: "Z:/definitely-missing-xyz" } }], edges: [] };
    assert.deepStrictEqual(getOutputs(noneDoc.nodes[0], noneDoc), []);
});

await test("动态出口 structSplit: 回溯上游构造器字段；未接线为空", () => {
    const doc = {
        nodes: [structMake, { id: "s", type: "struct.split", position: [0, 0], data: {} }],
        edges: [{ id: "e", source: "m", target: "s", sourceHandle: "struct", targetHandle: "struct" }],
    };
    assert.deepStrictEqual(getOutputs(doc.nodes[1], doc), [
        { id: "SERVER_TYPE", type: "string" },
        { id: "PORT", type: "number" },
    ]);
    assert.deepStrictEqual(getOutputs(doc.nodes[1], { nodes: doc.nodes, edges: [] }), []);
});

await test("struct 执行: 连线字段覆盖手填值 + number 类型矫正", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const doc = {
        name: "st", nodes: [
            { id: "c", type: "string.const", position: [0, 0], data: { value: "wired" } },
            { id: "m", type: "struct.make", position: [0, 0], data: { fields: [
                { key: "a", type: "string", value: "manual" },
                { key: "n", type: "number", value: "5" },
            ] } },
            { id: "s", type: "struct.split", position: [0, 0], data: {} },
            { id: "p", type: "log.print", position: [0, 0], data: {} },
            { id: "p2", type: "log.print", position: [0, 0], data: {} },
        ],
        edges: [
            { id: "e1", source: "c", sourceHandle: "value", target: "m", targetHandle: "a" },
            { id: "e2", source: "m", sourceHandle: "struct", target: "s", targetHandle: "struct" },
            { id: "e3", source: "s", sourceHandle: "a", target: "p", targetHandle: "value" },
            { id: "e4", source: "s", sourceHandle: "n", target: "p2", targetHandle: "value" },
        ],
        tasks: { t: { label: "t", mutates: false, nodes: ["c", "m", "s", "p", "p2"] } },
    };
    /** @type {string[]} */
    const lines = [];
    await executeTask({ log: m => lines.push(String(m)), dryRun: false, inputs: {}, mask: s => s }, doc, "t");
    const text = lines.join("\n");
    assert.ok(text.includes("wired"), "连线字段覆盖手填值", text);
    assert.ok(!text.includes("manual"), "手填值应被覆盖", text);
    assert.ok(lines.some(l => String(l).trim() === "5"), "number 字段经析构器输出后可取用", text);
});

await test("图校验: struct.make 字段 key 非法/重复/类型枚举被拒", () => {
    const problems = validateWorkflow({
        name: "t", nodes: [
            { id: "m", type: "struct.make", position: [0, 0], data: { fields: [
                { key: "ok", type: "string", value: "" },
                { key: "ok", type: "string", value: "" },
                { key: "bad key", type: "string", value: "" },
                { key: "t", type: "object", value: "" },
            ] } },
        ],
        edges: [],
        tasks: {},
    });
    assert.match(problems.join("; "), /字段 key 重复/);
    assert.match(problems.join("; "), /字段 key 非法/);
    assert.match(problems.join("; "), /类型非法/);
});

await test("prod 门禁: struct SERVER_TYPE=prod 需确认（dry-run 放行）", () => {
    const doc = {
        name: "gate", nodes: [
            structMake,
            { id: "lg", type: "log.print", position: [0, 0], data: {} },
        ],
        edges: [{ id: "e", source: "m", sourceHandle: "struct", target: "lg", targetHandle: "value" }],
        tasks: { deploy: { label: "deploy", mutates: true, nodes: ["m", "lg"] } },
    };
    assert.throws(
        () => enqueueWorkflowTask(doc, path.join(ROOT, "gate.json"), "deploy", {}),
        /Refusing to run deploy on prod/,
    );
    const { id } = enqueueWorkflowTask(doc, path.join(ROOT, "gate.json"), "deploy", { dryRun: true });
    assert.ok(getRun(id));
});

await test("注册表: 工作流加载器正常（旧 wf 已存档 _attic，等待重写）", () => {
    assert.ok(Array.isArray(loadWorkflows()));
});

console.log(`\nOK: ${passed} 项断言全部通过`);
