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
            { id: "a", type: "ssh.session", position: [0, 0], data: { alias: "x" } },
            { id: "b", type: "cmd.exec", position: [0, 0], data: { commands: "echo hi" } },
        ],
        edges: [{ id: "e", source: "a", sourceHandle: "ssh", target: "b", targetHandle: "cwd" }],
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
    const i1 = text.indexOf("[Input String] 1");
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
    assert.strictEqual(d.title, "Input String");
    assert.deepStrictEqual(d.inputs, []);
    assert.deepStrictEqual(d.outputs, [{ id: "value", type: "string" }]);
    assert.strictEqual(d.widgets[0].serializable, true, "值控件可序列化");
    assert.ok(!("fs.path" in NODE_TYPES), "fs.path 已删除");
  assert.ok(!("task.input" in NODE_TYPES), "task.input 已删除");
  assert.ok(!("write.env" in NODE_TYPES), "write.env 已删除");;
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

await test("日志掩码: JSON 形态 \"KEY\":\"VALUE\" 同样打码（struct/打印场景）", () => {
    assert.strictEqual(maskLine('"JWT_SECRET":"topsecret"'), '"JWT_SECRET":"***"');
    assert.strictEqual(maskLine('  "API_TOKEN": "abc123",'), '  "API_TOKEN": "***",');
    assert.strictEqual(maskLine('"db_password":"p@ss"'), '"db_password":"***"');
    assert.strictEqual(maskLine('"NAME":"正常值"'), '"NAME":"正常值"');
    // 幂等：已掩码行再过一遍不变
    assert.strictEqual(maskLine(maskLine('"JWT_SECRET":"topsecret"')), '"JWT_SECRET":"***"');
});

await test("getRun: id 白名单拒绝路径穿越（..%2Flocal-config 等）", () => {
    assert.strictEqual(getRun("../../local-config"), null);
    assert.strictEqual(getRun("..\\..\\local-config"), null);
    assert.strictEqual(getRun("../package"), null);
    assert.strictEqual(getRun("audit"), null);       // 非 <ts>-<n> 格式
    assert.strictEqual(getRun("a-b/c.json"), null);  // 含路径分隔符
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
    // POSIX 语义：~ 展开 + 反斜杠归一为 /，段间单斜杠拼接（style 缺省 auto，无盘符段 → posix 输出）
    const homePosix = home.replace(/\\/g, "/");
    const expected = `${homePosix}/sub/dee`;
    assert.ok(joined.includes(expected), "~ 首段展开 + 相对段拼接（POSIX）", joined);
    // 风格开关：windows → 反斜杠
    const winDoc = structuredClone(doc);
    winDoc.nodes.find(n => n.id === "r").data.style = "windows";
    const lines2 = [];
    const ctx2 = { log: m => lines2.push(String(m)), dryRun: false, inputs: {}, mask: s => s, registerGitRestore: () => {}, registerSession: () => {}, trackRemoteFile: () => {}, markNode: () => {}, markNodeInputs: () => {} };
    await executeTask(ctx2, winDoc, "t");
    assert.ok(lines2.join("\n").includes("sub\\dee"), "windows 风格输出反斜杠");
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

await test("注册表: ssh.close 输入 ssh、无输出无控件；sshClose 幂等", async () => {
    const d = NODE_TYPES["ssh.close"];
    assert.ok(d, "ssh.close 已注册");
    assert.deepStrictEqual(d.inputs, [{ id: "ssh", type: "ssh", required: true }]);
    assert.deepStrictEqual(d.outputs, []);
    assert.deepStrictEqual(d.widgets, []);
    const { sshClose } = await import("../engine/ssh.js");
    assert.doesNotThrow(() => { sshClose({ dryRun: true }); sshClose(null); });
});

// ── 端口字面量（data.lit）────
await test("字面量: 必填输入可由 data.lit 满足（无连线）", () => {
    const problems = validateWorkflow({
        name: "lit", nodes: [
            { id: "lg", type: "log.print", position: [0, 0], data: {} },
        ],
        edges: [],
        tasks: { t: { label: "t", mutates: false, nodes: ["lg"] } },
    });
    assert.ok(problems.some(p => p.includes("未连线且未填值")), "无 lit 无线应报错", problems.join("; "));
    const ok = validateWorkflow({
        name: "lit2", nodes: [
            { id: "lg", type: "log.print", position: [0, 0], data: { lit: { value: "hello" } } },
        ],
        edges: [],
        tasks: { t: { label: "t", mutates: false, nodes: ["lg"] } },
    });
    assert.deepStrictEqual(ok, [], "lit 满足必填");
});

await test("执行: 字面量注入（number 矫正）且连线覆盖字面量", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const doc = {
        name: "litrun", nodes: [
            { id: "s", type: "string.const", position: [0, 0], data: { value: "wired" } },
            { id: "fmt", type: "string.format", position: [0, 0], data: { format: "\"{{a}}{{b}}\"" } },
            { id: "p", type: "log.print", position: [0, 0], data: {} },
        ],
        edges: [
            { id: "e1", source: "s", sourceHandle: "value", target: "fmt", targetHandle: "a" },
            { id: "e2", source: "fmt", sourceHandle: "value", target: "p", targetHandle: "value" },
        ],
        tasks: { t: { label: "t", mutates: false, nodes: ["s", "fmt", "p"] } },
    };
    doc.nodes[1].data.lit = { b: 5 };
    const lines = [];
    await executeTask({ log: m => lines.push(String(m)), dryRun: false, inputs: {}, mask: s => s }, doc, "t");
    assert.ok(lines.join("\n").includes('"wired5"'), "连线 a + 字面量 b(number→5) 同节点共存", lines.join("\n"));
});

await test("认证级联: agent 优先，keyFile 降级回退；无 agent 单次", async () => {
    const { buildAuthAttempts } = await import("../engine/ssh.js");
    const ko = { privateKeyPath: "C:/k", passphrase: "p" };
    const both = buildAuthAttempts("pipe", ko);
    assert.deepStrictEqual(both, [{ agent: "pipe" }, { agent: "pipe", privateKeyPath: "C:/k", passphrase: "p" }], "① 仅 agent（无 keyPath，防口令密钥解析阻断）② agent+keyFile");
    assert.deepStrictEqual(buildAuthAttempts(undefined, ko), [{ privateKeyPath: "C:/k", passphrase: "p" }], "无 agent → 仅 keyFile");
    assert.deepStrictEqual(buildAuthAttempts("pipe", {}), [{ agent: "pipe" }], "无 keyFile → 仅 agent 单次");
});

await test("运行输入捕获: markNodeInputs 脱敏 + executeTask 时序", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const doc = {
        name: "cap", nodes: [
            { id: "mk", type: "struct.make", position: [0, 0], data: { fields: [
                { key: "JWT_SECRET", type: "string", value: "topsecret" },
                { key: "PORT", type: "number", value: 3000 },
            ] } },
            { id: "sp", type: "struct.split", position: [0, 0], data: {} },
            { id: "p", type: "log.print", position: [0, 0], data: {} },
        ],
        edges: [
            { id: "e1", source: "mk", sourceHandle: "struct", target: "sp", targetHandle: "struct" },
            { id: "e2", source: "sp", sourceHandle: "PORT", target: "p", targetHandle: "value" },
        ],
        tasks: { t: { label: "t", mutates: false, nodes: ["mk", "sp", "p"] } },
    };
    /** @type {Record<string, Record<string, string>>} */
    const captured = {};
    const ctx = { log: () => {}, dryRun: false, inputs: {}, mask: s => s, registerGitRestore: () => {}, registerSession: () => {}, trackRemoteFile: () => {}, markNode: () => {}, markNodeInputs: (id, vals) => { captured[id] = vals; } };
    await executeTask(ctx, doc, "t");
    // markNodeInputs 捕获：mk 收到空输入（字段无连线、字段行控件值由节点自身消费），sp 收到解析后的 struct，p 收到字段值 3000
    assert.deepStrictEqual(captured["mk"], {}, "make 无连线输入 → 空对象（不虚构）");
    assert.deepStrictEqual(captured["sp"], { struct: { JWT_SECRET: "topsecret", PORT: 3000 } }, "split 收到完整 struct 对象");
    assert.strictEqual(captured["p"]["value"], 3000, "log.print 收到矫正后的端口值");
});

await test("string.join: count 驱动动态端口 p1..pN；分隔符拼接（空=直接相连）", async () => {
    const { executeTask } = await import("../engine/workflow.js");
    const doc = {
        name: "sj", nodes: [
            { id: "s1", type: "string.const", position: [0, 0], data: { value: "a" } },
            { id: "s2", type: "string.const", position: [0, 0], data: { value: "b" } },
            { id: "j", type: "string.join", position: [0, 0], data: { count: 2, delimiter: "-" } },
            { id: "p", type: "log.print", position: [0, 0], data: {} },
        ],
        edges: [
            { id: "e1", source: "s1", sourceHandle: "value", target: "j", targetHandle: "p1" },
            { id: "e2", source: "s2", sourceHandle: "value", target: "j", targetHandle: "p2" },
            { id: "e3", source: "j", sourceHandle: "value", target: "p", targetHandle: "value" },
        ],
        tasks: { t: { label: "t", mutates: false, nodes: ["s1", "s2", "j", "p"] } },
    };
    const lines = [];
    await executeTask({ log: m => lines.push(String(m)), dryRun: false, inputs: {}, mask: s => s, registerGitRestore: () => {}, registerSession: () => {}, trackRemoteFile: () => {}, markNode: () => {}, markNodeInputs: () => {} }, doc, "t");
    assert.ok(lines.join(String.fromCharCode(10)).includes("a-b"), "分隔符拼接", lines.join(String.fromCharCode(10)));
});

await test("注册表: 工作流加载器正常（旧 wf 已存档 _attic，等待重写）", () => {
    assert.ok(Array.isArray(loadWorkflows()));
});

await test("template.render: varsUnresolved → struct 口；vars 合并（struct 展开 + 散口 lit）", async () => {
    const doc = {
        name: "tpl", nodes: [
            { id: "mk", type: "struct.make", position: [0, 0], data: { fields: [
                { key: "WHO", type: "string", value: "struct-obj" },
                { key: "EXTRA_ONLY", type: "string", value: "" },
            ] } },
            { id: "tpl", type: "template.render", position: [0, 0], data: { varsUnresolved: true } },
        ],
        edges: [
            { id: "e1", source: "mk", sourceHandle: "struct", target: "tpl", targetHandle: "vars" },
        ],
        tasks: { t: { label: "t", mutates: false, nodes: ["mk", "tpl"] } },
    };
    const { getInputs } = await import("../engine/nodes/index.js");
    const ids = getInputs(doc.nodes.find(n => n.id === "tpl")).map(i => i.id);
    assert.ok(ids.includes("path") && ids.includes("vars"), "varsUnresolved → path + vars(struct) 口");

    // 可读模板 + lit 提供 path 与散口变量 → struct 对象展开渲染
    const os = await import("os");
    const pathMod = await import("path");
    const fsMod = await import("fs");
    const tplFile = pathMod.join(os.tmpdir(), `verify-tpl-${Date.now()}.txt`);
    fsMod.writeFileSync(tplFile, "WHO={{WHO}} EXTRA={{EXTRA_ONLY}}");
    const tmpDoc = JSON.parse(JSON.stringify(doc));
    tmpDoc.nodes.find(n => n.id === "tpl").data.lit = { path: tplFile, EXTRA_ONLY: "hand-filled" };
    const { executeTask } = await import("../engine/workflow.js");
    const outs = {};
    const ctx = { log: () => {}, dryRun: false, inputs: {}, mask: x => x,
        registerSession: () => {}, registerGitRestore: () => {}, trackRemoteFile: () => {},
        markNode: () => {}, markNodeInputs: (id, vals) => { outs[id] = vals; } };
    await executeTask(ctx, tmpDoc, "t");
    assert.ok(outs["tpl"], "tpl 节点完成渲染");
});

await test("task.input 已删除", async () => {
    const { NODE_TYPES } = await import("../engine/nodes/index.js");
    assert.ok(!("task.input" in NODE_TYPES), "task.input 已删除");
});

// ── ssh.upload 权限回退（mock 会话，不连任何服务器）────
/** 构造 mock SSH 会话：putFile 可按目标路径编程失败；execCommand 记录命令并按正则编程失败 */
function mockUploadSession({ failPutPaths = [], failCmds = [] } = {}) {
    const cmds = [];
    return {
        cmds,
        async execCommand(command) {
            cmds.push(command);
            if (failCmds.some(re => re.test(command))) return { code: 1, stdout: "", stderr: "mock-failure" };
            return { code: 0, stdout: "", stderr: "" };
        },
        async putFile(_local, remote) {
            if (failPutPaths.some(re => re.test(remote))) throw new Error("Permission denied");
        },
    };
}

await test("upload: 直写成功不触发 sudo 回退", async () => {
    const upDef = NODE_TYPES["ssh.upload"];
    assert.ok(upDef, "ssh.upload 已注册");
    const os = await import("os");
    const local = path.join(os.tmpdir(), `verify-up-${Date.now()}.txt`);
    fs.writeFileSync(local, "hello");
    try {
        const sess = mockUploadSession();
        const out = await upDef.run({ log: () => {}, mask: x => x, dryRun: false }, { data: {} },
            { ssh: sess, localPath: local, remotePath: "/opt/app/x.conf" });
        assert.deepStrictEqual(out, { remoteFile: "/opt/app/x.conf" });
        assert.ok(sess.cmds.some(c => c.includes("mkdir -p") && c.includes("/opt/app")), "父目录 mkdir");
        assert.ok(!sess.cmds.some(c => c.includes("sudo")), "直写成功不应出现 sudo 命令");
    } finally { fs.rmSync(local, { force: true }); }
});

await test("upload: 直写权限不足回退 /tmp 暂存 + sudo install，暂存目录被清理", async () => {
    const upDef = NODE_TYPES["ssh.upload"];
    const os = await import("os");
    const local = path.join(os.tmpdir(), `verify-up-${Date.now()}.txt`);
    fs.writeFileSync(local, "nginx conf");
    try {
        const sess = mockUploadSession({ failPutPaths: [/^\/etc\//] });
        const logs = [];
        const out = await upDef.run({ log: m => logs.push(String(m)), mask: x => x, dryRun: false }, { data: {} },
            { ssh: sess, localPath: local, remotePath: "/etc/nginx/sites-available/kl" });
        assert.deepStrictEqual(out, { remoteFile: "/etc/nginx/sites-available/kl" });
        const installed = sess.cmds.find(c => c.includes("install -m 644"));
        assert.ok(installed, "应有 install 命令");
        // sq 的引号在 bash -lc 外层里转义为 '\'' —— 归一化后断言命令形状
        const flat = installed.replaceAll("'\\''", "'");
        assert.ok(/sudo -n install -m 644 '\/tmp\/devops-upload-[a-z0-9]+\/kl' '\/etc\/nginx\/sites-available\/kl'/.test(flat),
            `install 命令形状不符: ${installed}`);
        assert.ok(sess.cmds.some(c => c.includes("rm -rf") && c.includes("/tmp/devops-upload-")), "暂存目录应被清理");
        assert.ok(logs.some(l => l.includes("[upload] 直写失败")), "应记录回退日志");
    } finally { fs.rmSync(local, { force: true }); }
});

await test("upload: 非权限错误原样抛出、无回退", async () => {
    const upDef = NODE_TYPES["ssh.upload"];
    const os = await import("os");
    const local = path.join(os.tmpdir(), `verify-up-${Date.now()}.txt`);
    fs.writeFileSync(local, "x");
    try {
        const sess = mockUploadSession();
        sess.putFile = async () => { throw new Error("socket hang up"); };
        let threw = null;
        try {
            await upDef.run({ log: () => {}, mask: x => x, dryRun: false }, { data: {} },
                { ssh: sess, localPath: local, remotePath: "/opt/app/x.conf" });
        } catch (e) { threw = e; }
        assert.ok(threw, "应抛错");
        assert.match(threw.message, /socket hang up/, "原样抛出");
        assert.ok(!sess.cmds.some(c => c.includes("install")), "不应回退 install");
    } finally { fs.rmSync(local, { force: true }); }
});

await test("upload: mkdir 权限不足回退 sudo -n mkdir", async () => {
    const upDef = NODE_TYPES["ssh.upload"];
    const os = await import("os");
    const local = path.join(os.tmpdir(), `verify-up-${Date.now()}.txt`);
    fs.writeFileSync(local, "x");
    try {
        // 仅首跳（非 sudo）mkdir 失败；sudo 重试与后续 putFile 成功
        const sess = mockUploadSession({ failCmds: [/bash -lc 'mkdir -p/] });
        const out = await upDef.run({ log: () => {}, mask: x => x, dryRun: false }, { data: {} },
            { ssh: sess, localPath: local, remotePath: "/root/newdir/x.conf" });
        assert.deepStrictEqual(out, { remoteFile: "/root/newdir/x.conf" });
        const mkdirSudo = sess.cmds.find(c => c.includes("sudo -n mkdir -p"));
        assert.ok(mkdirSudo && mkdirSudo.replaceAll("'\\''", "'").includes("sudo -n mkdir -p '/root/newdir'"),
            `应回退 sudo mkdir: ${mkdirSudo}`);
    } finally { fs.rmSync(local, { force: true }); }
});

await test("nginx-reload/ssh.exec: 复合命令整段提权（sudo -n bash -c）", async () => {
    const logs = [];
    const ctx = { log: m => logs.push(String(m)), mask: x => x, dryRun: true };
    // nginx-reload：nginx -t 与 systemctl reload 必须在同一 sudo 作用域内
    await NODE_TYPES["remote.nginx-reload"].run(ctx, { data: {} }, { ssh: {} });
    const reloadCmd = logs.find(l => l.includes("nginx -t"));
    assert.ok(reloadCmd, "nginx-reload 应有 dry-run 日志");
    assert.ok(/sudo -n bash -c 'nginx -t && systemctl reload nginx'/.test(reloadCmd.replaceAll("'\\''", "'")),
        `reload 应整段提权: ${reloadCmd}`);
    // ssh.exec：含 && 的行整行提权
    logs.length = 0;
    await NODE_TYPES["ssh.exec"].run(ctx,
        { data: { command: "nginx -t && systemctl reload nginx", useSudo: true, loginShell: true } }, { ssh: {} });
    const execCmd = logs.find(l => l.includes("systemctl reload nginx"));
    assert.ok(execCmd && /sudo -n bash -c 'nginx -t && systemctl reload nginx'/.test(execCmd.replaceAll("'\\''", "'")),
        `ssh.exec 复合命令应整段提权: ${execCmd}`);
});

await test("symlink: ln 实参顺序锁定（target 口=第一参数 真实路径；link 口=第二参数 符号链接）", async () => {
    // 对照 kids-ledger-prod 接线：target ← upload 的真文件路径，link ← enabled 链字面量
    const logs = [];
    await NODE_TYPES["remote.symlink"].run({ log: m => logs.push(String(m)), mask: x => x, dryRun: true },
        { data: {} }, { ssh: {}, target: "/etc/nginx/sites-available/kl", link: "/etc/nginx/sites-enabled/kl" });
    const line = logs.find(l => l.includes("ln -sfn"));
    assert.ok(line && /ln -sfn '\/etc\/nginx\/sites-available\/kl' '\/etc\/nginx\/sites-enabled\/kl'/.test(line.replaceAll("'\\''", "'")),
        `ln 形状不符（target=真实路径必须是第一参数）: ${line}`);
    const d = NODE_TYPES["remote.symlink"];
    assert.deepStrictEqual(d.inputs.map(i => i.id), ["ssh", "target", "link"], "端口顺序应与 ln 命令行一致");
});

await test("注册表: remote.install 输入/控件形状；dry-run 命令形状锁定", async () => {
    const d = NODE_TYPES["remote.install"];
    assert.ok(d, "remote.install 已注册");
    assert.deepStrictEqual(d.inputs, [
        { id: "ssh", type: "ssh", required: true },
        { id: "filePath", type: "string", required: true },
        { id: "installPath", type: "string", required: true },
    ]);
    assert.deepStrictEqual(d.outputs, []);
    assert.deepStrictEqual(d.widgets.map(w => [w.key, w.kind, w.default]), [
        ["mode", "string", "644"], ["owner", "string", "root"], ["group", "string", "root"],
    ]);
    // dry-run 命令形状：sudo -n install -m mode -o owner -g group filePath installPath
    const logs = [];
    await NODE_TYPES["remote.install"].run({ log: m => logs.push(String(m)), mask: x => x, dryRun: true },
        { data: { mode: "644", owner: "root", group: "root" } },
        { ssh: {}, filePath: "/tmp/myapp.service", installPath: "/etc/systemd/system/" });
    const line = logs.find(l => l.includes("install -m"));
    assert.ok(line && /sudo -n install -m '644' -o 'root' -g 'root' '\/tmp\/myapp\.service' '\/etc\/systemd\/system\/'/.test(line.replaceAll("'\\''", "'")),
        `install 形状不符: ${line}`);
});

await test("注册表: pnpm.install 形状；恒登录用户执行（无 sudo）且命令形状锁定", async () => {
    const d = NODE_TYPES["pnpm.install"];
    assert.ok(d, "pnpm.install 已注册");
    assert.ok(!("remote.deps" in NODE_TYPES), "旧 remote.deps 已移除");
    assert.deepStrictEqual(d.inputs, [
        { id: "ssh", type: "ssh", required: true },
        { id: "path", type: "string", required: true },
    ]);
    assert.deepStrictEqual(d.outputs, []);
    assert.deepStrictEqual(d.widgets.map(w => w.key), ["loginShell"], "只剩 loginShell 控件（manager/useSudo 已删）");
    // dry-run：cd + pnpm install --prod --frozen-lockfile，且不含 sudo（sudo -n cd 地雷根除）
    const logs = [];
    await NODE_TYPES["pnpm.install"].run({ log: m => logs.push(String(m)), mask: x => x, dryRun: true },
        { data: { loginShell: true } }, { ssh: {}, path: "/opt/kids-ledger/server-live" });
    const line = logs.find(l => l.includes("pnpm install"));
    assert.ok(line, "pnpm.install 应有 dry-run 日志");
    const flat = line.replaceAll("'\\''", "'");
    assert.ok(flat.includes("cd '/opt/kids-ledger/server-live'"), `应 cd 到安装目录: ${flat}`);
    assert.ok(flat.includes("&& pnpm install --prod --frozen-lockfile"), `应含完整安装命令: ${flat}`);
    assert.ok(!flat.includes("sudo"), "不应出现 sudo");
});

await test("注册表: systemd.run 形状；restart 四步与 enable --now 映射锁定", async () => {
    const d = NODE_TYPES["systemd.run"];
    assert.ok(d, "systemd.run 已注册");
    assert.ok(!("remote.service" in NODE_TYPES), "旧 remote.service 已移除");
    assert.deepStrictEqual(d.inputs, [
        { id: "ssh", type: "ssh", required: true },
        { id: "name", type: "string", required: true },
    ]);
    assert.deepStrictEqual(d.outputs, [], "无输出（各步 stdout 实时进任务日志，不冗余）");
    const actions = d.widgets[0].options;
    for (const a of ["restart", "enable --now", "start", "status", "is-active"]) {
        assert.ok(actions.includes(a), `枚举应含 ${a}`);
    }
    // restart 四步
    let logs = [];
    await NODE_TYPES["systemd.run"].run({ log: m => logs.push(String(m)), mask: x => x, dryRun: true },
        { data: { action: "restart", useSudo: true, loginShell: true } }, { ssh: {}, name: "myapp.service" });
    const flat = logs.join("\n").replaceAll("'\\''", "'");
    for (const step of ["sudo -n systemctl daemon-reload", "sudo -n systemctl reset-failed 'myapp.service'", "sudo -n systemctl restart 'myapp.service'", "sudo -n systemctl status 'myapp.service'"]) {
        assert.ok(flat.includes(step), `restart 应含步骤 ${step}`);
    }
    // enable --now 走通用映射
    logs = [];
    await NODE_TYPES["systemd.run"].run({ log: m => logs.push(String(m)), mask: x => x, dryRun: true },
        { data: { action: "enable --now", useSudo: true, loginShell: true } }, { ssh: {}, name: "myapp.service" });
    const en = logs.join("\n").replaceAll("'\\''", "'");
    assert.ok(en.includes("sudo -n systemctl enable --now 'myapp.service'"), `enable --now 映射不符: ${en}`);
});

await test("stage.copy: from 相对 root 解析（非 cwd）+ 递归 + to 缺省保持结构", async () => {
    const os = await import("os");
    const pathMod = await import("path");
    const fsMod = await import("fs");
    // 仓库结构：root/dist/index.html + root/package.json；root 外的 external.tpl
    const rootDir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), "verify-root-"));
    fsMod.mkdirSync(pathMod.join(rootDir, "dist"));
    fsMod.writeFileSync(pathMod.join(rootDir, "dist", "index.html"), "<html></html>");
    fsMod.writeFileSync(pathMod.join(rootDir, "package.json"), "{}");
    const extFile = pathMod.join(os.tmpdir(), `verify-ext-${Date.now()}.tpl`);
    fsMod.writeFileSync(extFile, "tpl");

    const node = {
        id: "st1", type: "stage.copy", position: [0, 0],
        data: { count: 3, lit: { "p1.from": "dist", "p2.from": "package.json", "p3.from": extFile } },
    };
    const meta = NODE_TYPES["stage.copy"];
    const logs = [];
    const out = await NODE_TYPES["stage.copy"].run(
        { log: m => logs.push(String(m)), mask: x => x, dryRun: false },
        node,
        { root: rootDir, "p1.from": "dist", "p2.from": "package.json", "p3.from": extFile });

    // 递归复制 dist；同名复制 package.json；root 外文件落 basename（to 缺省）
    assert.ok(fsMod.existsSync(pathMod.join(out.dir, "dist", "index.html")), "dist 递归复制");
    assert.ok(fsMod.existsSync(pathMod.join(out.dir, "package.json")), "同名复制");
    assert.ok(fsMod.existsSync(pathMod.join(out.dir, pathMod.basename(extFile))), "root 外文件以 basename 落暂存");
    assert.ok(logs.some(l => l.includes("basename") && l.includes("[WARN]")), "root 外 to 未填打警告");
    assert.ok(logs.some(l => l.includes("[stage]")), "完成标记");
    fsMod.rmSync(rootDir, { recursive: true, force: true });
    fsMod.rmSync(extFile, { force: true });
});

// ── sshconfig 解析（首块生效语义） ────
await test("sshconfig: OpenSSH 首块生效（User/Port 首值优先；HostName 取首个显式设置的块）+ 别名顺序", async () => {
    const { parseConfig, listAliases } = await import("../engine/sshconfig.js");
    const fp = path.join(ROOT, ".tmp", "sshcfg-verify");
    fs.writeFileSync(fp, [
        "Host alpha beta",
        "  User alice",
        "Host alpha",
        "  HostName override.example.com",
        "  User bob",
        "  Port 2222",
        "Host beta",
        "  HostName beta.example.com",
        "Host gamma",
        "  ProxyJump jumpbox",
    ].join("\n"), "utf8");
    try {
        const m = parseConfig(fp);
        const alpha = m.get("alpha");
        assert.strictEqual(alpha.user, "alice", "前块 User 优先（bob 忽略）");
        assert.strictEqual(alpha.host, "override.example.com", "前块未设 HostName，取后块显式值");
        assert.strictEqual(alpha.port, 2222);
        const beta = m.get("beta");
        assert.strictEqual(beta.user, "alice", "跨块继承首值");
        assert.strictEqual(beta.host, "beta.example.com");
        assert.ok((m.get("gamma").unsupported ?? []).some(u => /proxyjump/i.test(u)), "不支持指令被记录");
        assert.deepStrictEqual(listAliases(fp), ["alpha", "beta", "gamma"], "别名按出现顺序");
    } finally { fs.unlinkSync(fp); }
});

console.log(`\nOK: ${passed} 项断言全部通过`);
