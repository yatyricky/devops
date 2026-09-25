#!/usr/bin/env node
/**
 * 节点图模型自检：类型系统/图校验/任务子图（选点 → DAG）/并发调度/prod 门禁（struct）/掩码
 * + struct 构造析构与动态出口断言。全绿输出 OK；任一断言失败非零退出。
 * 旧 wf 已存档 workflows/_attic/（等重写），本套件自带 fixture，不依赖 envs/。
 */
import assert from "assert";
import path from "path";
import url from "url";
import { canConnect, SOCKET_TYPES } from "../engine/types.js";
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
await test("类型: 同型可连，struct→any 放行，any→具体/跨具体类型拒绝；无路径类型", () => {
    assert.ok(canConnect("struct", "struct"));
    assert.ok(canConnect("struct", "any"));
    assert.ok(canConnect("string", "any"));
    assert.ok(canConnect("string", "string"));
    assert.ok(!canConnect("any", "string"), "any 输出不可入 string 输入");
    assert.ok(!canConnect("string", "struct"), "string 不可入 struct");
    assert.ok(!canConnect("ssh", "struct"));
    assert.ok(!canConnect("string", "number"), "number 输入只收 number");
    assert.ok(!SOCKET_TYPES.includes("folder") && !SOCKET_TYPES.includes("file"), "路径类型已整体移除");
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
    const i1 = text.indexOf("[输入.字符串] 1");
    assert.ok(i1 !== -1 && i1 < text.indexOf("预览：b2") && i1 < text.indexOf("预览：b3"), "1 应先于 2/3", text);
});
await test("执行: 分支失败任务失败（同批好分支已落地）", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const doc = structuredClone(fanDoc);
    doc.nodes[1].data.title = "b2";
    doc.nodes[2] = { id: "3", type: "git.checkout", position: [0, 0], data: {} };
    doc.tasks = { t: { label: "t", mutates: false, nodes: ["1", "2", "3"] } };
    /** @type {string[]} */
    const lines = [];
    await assert.rejects(
        () => executeTask({ log: m => lines.push(String(m)), dryRun: true, inputs: {}, mask: s => s }, doc, "t"),
        /未连接仓库目录/,
    );
    assert.ok(lines.join("\n").includes("预览：b2"), "同批好分支应已执行");
});

// ── git.checkout 切换分支 ────
await test("注册表: git.checkout 输入全 string、输出 original(string)", () => {
    const d = NODE_TYPES["git.checkout"];
    assert.ok(d, "git.checkout 已注册");
    assert.deepStrictEqual(d.inputs.map(i => [i.id, i.type]), [["repoDir", "string"], ["ref", "string"]]);
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
                { id: "p", type: "string.const", position: [0, 0], data: { value: dir } },
                { id: "c1", type: "git.checkout", position: [0, 0], data: {} },
                { id: "c2", type: "git.checkout", position: [0, 0], data: {} },
                { id: "ref1", type: "string.const", position: [0, 0], data: { value: "v1" } },
                { id: "ref2", type: "string.const", position: [0, 0], data: { value: mainBranch } },
            ],
            edges: [
                { id: "e0", source: "p", sourceHandle: "value", target: "c1", targetHandle: "repoDir" },
                { id: "e1", source: "p", sourceHandle: "value", target: "c2", targetHandle: "repoDir" },
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

// ── 输入.字符串（string.const）────
await test("注册表: 输入.字符串在输入分类，输出 string，widget 可序列化", () => {
    const d = NODE_TYPES["string.const"];
    assert.ok(d, "string.const 已注册");
    assert.strictEqual(d.category, "输入");
    assert.strictEqual(d.title, "输入.字符串");
    assert.deepStrictEqual(d.inputs, []);
    assert.deepStrictEqual(d.outputs, [{ id: "value", type: "string" }]);
    assert.strictEqual(d.widgets[0].serializable, true, "值控件可序列化");
    assert.ok(!("fs.path" in NODE_TYPES), "fs.path 已删除");
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

// ── git.getRefs ────
await test("注册表: git.getRefs 输入 string、输出 string、refsPicker 标志", () => {
    const d = NODE_TYPES["git.getRefs"];
    assert.ok(d?.refsPicker, "refsPicker 标志");
    assert.deepStrictEqual(d.inputs, [{ id: "repoDir", type: "string", required: true }]);
    assert.strictEqual(d.outputs[0].id, "ref");
    assert.strictEqual(d.outputs[0].type, "string");
});

await test("git.getRefs 执行: 输出所选 ref", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const doc = {
        name: "refs-t",
        nodes: [
            { id: "p", type: "string.const", position: [0, 0], data: { value: path.resolve(__dirname, "..") } },
            { id: "g", type: "git.getRefs", position: [0, 0], data: { ref: "v1.0" } },
        ],
        edges: [{ id: "e", source: "p", sourceHandle: "value", target: "g", targetHandle: "repoDir" }],
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

// ── npm.run / path.resolve ────
await test("注册表: npm.run 输入 path(string)、无输出、script 控件 serializable + scriptsPicker", () => {
    const d = NODE_TYPES["npm.run"];
    assert.ok(d, "npm.run 已注册");
    assert.deepStrictEqual(d.inputs, [{ id: "path", type: "string", required: true }]);
    assert.deepStrictEqual(d.outputs, [], "无输出");
    assert.strictEqual(d.scriptsPicker, true);
    assert.strictEqual(d.widgets[0].serializable, true);
});

await test("npm.run 执行: dry-run 打印计划不执行；真实执行跑通脚本；非法脚本报错列出可用项", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const os = await import("os");
    const fsp = await import("fs/promises");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "npmrun-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { hello: "node -e \"process.stdout.write('ran-ok')\"" } }));
    try {
        const doc = {
            name: "npmrun-t",
            nodes: [
                { id: "p", type: "string.const", position: [0, 0], data: { value: dir } },
                { id: "n", type: "npm.run", position: [0, 0], data: { script: "hello" } },
            ],
            edges: [{ id: "e", source: "p", sourceHandle: "value", target: "n", targetHandle: "path" }],
            tasks: { t: { label: "t", mutates: false, nodes: ["p", "n"] } },
        };
        /** @type {string[]} */
        const lines = [];
        await executeTask({ log: m => lines.push(String(m)), dryRun: true, inputs: {}, mask: s => s }, doc, "t");
        assert.ok(lines.join("\n").includes("[dry-run] npm run hello"), "dry-run 计划");
        const lines2 = [];
        await executeTask({ log: m => lines2.push(String(m)), dryRun: false, inputs: {}, mask: s => s }, doc, "t");
        assert.ok(lines2.join("\n").includes("ran-ok"), "真实执行输出", lines2.join("\n"));
        await assert.rejects(
            () => executeTask({ log: () => {}, dryRun: true, inputs: {}, mask: s => s }, { ...doc, nodes: [doc.nodes[0], { ...doc.nodes[1], data: { script: "nope" } }] }, "t"),
            /不在 package\.json scripts 中.*hello/s,
        );
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
});

await test("path.resolve: count 驱动动态端口 p1..pN；执行拼接 resolve（~ 首段展开、相对段）", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const os = await import("os");
    const node3 = { id: "r", type: "path.resolve", position: [0, 0], data: { count: 3 } };
    assert.deepStrictEqual(
        getInputs(node3).map(i => i.id),
        ["p1", "p2", "p3"],
        "count=3 → 三个动态端口",
    );
    const node9 = { ...node3, data: { count: 9 } };
    assert.strictEqual(getInputs(node9).length, 9, "count=9 → 九个端口");
    const nodeBad = { ...node3, data: { count: 99 } };
    assert.strictEqual(getInputs(nodeBad).length, 16, "count 越界收敛到上限 16");

    const home = (await import("os")).homedir();
    const doc = {
        name: "pres-t",
        nodes: [
            { id: "s1", type: "string.const", position: [0, 0], data: { value: "~" } },
            { id: "s2", type: "string.const", position: [0, 0], data: { value: "sub" } },
            { id: "s3", type: "string.const", position: [0, 0], data: { value: "dee" } },
            { id: "r", type: "path.resolve", position: [0, 0], data: { count: 3 } },
            { id: "p", type: "log.print", position: [0, 0], data: {} },
        ],
        edges: [
            { id: "e1", source: "s1", sourceHandle: "value", target: "r", targetHandle: "p1" },
            { id: "e2", source: "s2", sourceHandle: "value", target: "r", targetHandle: "p2" },
            { id: "e3", source: "s3", sourceHandle: "value", target: "r", targetHandle: "p3" },
            { id: "e4", source: "r", sourceHandle: "value", target: "p", targetHandle: "value" },
        ],
        tasks: { t: { label: "t", mutates: false, nodes: ["s1", "s2", "s3", "r", "p"] } },
    };
    const lines = [];
    await executeTask({ log: m => lines.push(String(m)), dryRun: false, inputs: {}, mask: s => s }, doc, "t");
    const joined = lines.join("\n");
    assert.ok(joined.includes(path.resolve(home, "sub", "dee")), "~ 首段展开 + 相对段拼接", joined);
});

// ── tar.pack 三模式 + 运行状态标记 ────
await test("tar.pack: 单输出 archive；白/黑/全三模式；双配置 validate 报错", async () => {
    const d = NODE_TYPES["tar.pack"];
    assert.deepStrictEqual(d.outputs, [{ id: "archive", type: "string" }], "仅 archive 一个输出");
    const { executeTask } = await import("../engine/workflow.js");
    const { listArchive } = await import("../engine/tarball.js");
    const os = await import("os");
    const fsp = await import("fs/promises");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tarpack-"));
    fs.mkdirSync(path.join(dir, "keep"), { recursive: true });
    fs.mkdirSync(path.join(dir, "skip"), { recursive: true });
    fs.writeFileSync(path.join(dir, "root.txt"), "r");
    fs.writeFileSync(path.join(dir, "keep", "a.txt"), "a");
    fs.writeFileSync(path.join(dir, "skip", "b.txt"), "b");
    const runPack = async (data) => {
        const doc = {
            name: "tp", nodes: [
                { id: "p", type: "string.const", position: [0, 0], data: { value: dir } },
                { id: "t", type: "tar.pack", position: [0, 0], data },
            ],
            edges: [{ id: "e", source: "p", sourceHandle: "value", target: "t", targetHandle: "dir" }],
            tasks: { t: { label: "t", mutates: false, nodes: ["p", "t"] } },
        };
        const lines = [];
        await executeTask({ log: m => lines.push(String(m)), dryRun: false, inputs: {}, mask: s => s, registerGitRestore: () => {}, registerSession: () => {}, trackRemoteFile: () => {}, markNode: () => {} }, doc, "t");
        return lines.join("\n");
    };
    try {
        // 全部
        let out = await runPack({});
        let tgz = out.match(/\[tar\] (\S+\.tgz)/)[1];
        let entries = await listArchive(path.join(ROOT, ".tmp", tgz));
        assert.ok(entries.some(e => e.includes("root.txt")) && entries.some(e => e.includes("skip")), "全模式含全部内容");
        assert.ok(entries.every(e => !e.startsWith("./") && e !== "."), "全部模式无 ./ 前缀（内容在包顶层）", entries.join(","));
        // 白名单
        out = await runPack({ entries: ["keep"] });
        tgz = out.match(/\[tar\] (\S+\.tgz)/)[1];
        entries = await listArchive(path.join(ROOT, ".tmp", tgz));
        assert.ok(entries.some(e => e.includes("a.txt")) && !entries.some(e => e.includes("skip")), "白名单仅打包条目");
        // 黑名单
        out = await runPack({ excludes: ["skip"] });
        tgz = out.match(/\[tar\] (\S+\.tgz)/)[1];
        entries = await listArchive(path.join(ROOT, ".tmp", tgz));
        assert.ok(entries.some(e => e.includes("root.txt")) && entries.some(e => e.includes("a.txt")) && !entries.some(e => e.includes("skip")), "黑名单排除路径段");
        // 双配置：validate 与 run 两处报错
        const both = { entries: ["keep"], excludes: ["skip"] };
        const vErr = validateWorkflow({
            name: "tp2", nodes: [{ id: "t", type: "tar.pack", position: [0, 0], data: both }], edges: [],
            tasks: { t: { label: "t", mutates: false, nodes: ["t"] } },
        });
        assert.match(vErr.join("; "), /只能二选一/);
        await assert.rejects(() => runPack(both), /只能二选一/);
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
        for (const f of fs.readdirSync(path.join(ROOT, ".tmp")).filter(f => f.endsWith(".tgz"))) {
            fs.rmSync(path.join(ROOT, ".tmp", f), { force: true });
        }
    }
});

await test("运行状态: executeTask 标记 running→ok；失败节点 failed", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const doc = structuredClone(fanDoc);
    doc.nodes[2] = { id: "3", type: "git.checkout", position: [0, 0], data: {} };
    doc.tasks = { t: { label: "t", mutates: false, nodes: ["1", "2", "3"] } };
    /** @type {Record<string, string>} */
    const st = {};
    const ctx = { log: () => {}, dryRun: true, inputs: {}, mask: s => s, markNode: (id, s) => { st[id] = s; } };
    await assert.rejects(() => executeTask(ctx, doc, "t"), /未连接仓库目录/);
    assert.strictEqual(st["1"], "ok");
    assert.strictEqual(st["2"], "ok");
    assert.strictEqual(st["3"], "failed");
    // 成功路径：全部 ok
    const st2 = {};
    const docOk = structuredClone(fanDoc);
    docOk.tasks = { t: { label: "t", mutates: false, nodes: ["1", "2", "3"] } };
    await executeTask({ log: () => {}, dryRun: true, inputs: {}, mask: s => s, markNode: (id, s) => { st2[id] = s; } }, docOk, "t");
    assert.deepStrictEqual(st2, { 1: "ok", 2: "ok", 3: "ok" });
});

await test("注册表: 工作流加载器正常（旧 wf 已存档 _attic，等待重写）", () => {
    assert.ok(Array.isArray(loadWorkflows()));
});

console.log(`\nOK: ${passed} 项断言全部通过`);
