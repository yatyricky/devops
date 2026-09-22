import fs from "fs";
import path from "path";
import { cmd, writeLF, rmrf, copyTree } from "./exec.js";
import { compress, makeStageDir } from "./tarball.js";
import { withDeployVersion } from "./gitops.js";
import { sshConnect, sshClose, sshExec, sshPut } from "./ssh.js";
import { renderTemplate, renderTemplateFile } from "./render.js";
import { validateReleaseName } from "./release.js";
import { loadTaskEnv, TMP_DIR } from "./runner.js";

/**
 * 类型化数据流工作流：原子步骤注册表 + 执行器 + 编译器（含编译期类型校验）。
 *
 * 工作流以 JSON 定义（workflows/<name>.json），每个任务 = 一个线性步骤数组（无 DAG）。
 * 数据流 = 后面的步骤引用前面步骤的产出物（{{名字}}，扁平作用域）：
 *   - 步骤产出物带类型（string/path/remote_path/...）；
 *   - 每个参数是带类型的输入槽；整值引用按兼容表校验，字面量内嵌引用按嵌入规则校验；
 *   - env 变量类型由 envSchema 样例值推导（字符串/数字/布尔）。
 * 运行时把一切渲染为字符串执行；类型是编译期校验层，存储 JSON 保持简单模板字符串。
 */

/** 部署基础 env schema（值即类型样例；fingerprint 空 = 未锁定仅警告）。 */
export const deployBaseSchema = {
    /** "prod" | "test" */
    SERVER_TYPE: "test",
    REMOTE_HOST: "host.example.com",
    REMOTE_USER: "deploy",
    REMOTE_HOST_FINGERPRINT: "",
    DEPLOY_DIR: "/opt/app",
};

// ── 类型系统 ────
// string=纯文本  bash=命令串  path=本机路径  remote_path=服务器路径  number/bool/list/map
/** 整值引用兼容表：槽位类型 ← 允许引用的产出物类型。 */
const TYPE_COMPAT = {
    string: new Set(["string", "number", "bool"]),
    number: new Set(["number"]),
    bool: new Set(["bool"]),
    path: new Set(["path"]),
    remote_path: new Set(["remote_path"]),
    bash: new Set(["string", "number", "bool", "path", "remote_path"]),
    list: new Set(["list"]),
    map: new Set(["map"]),
};
/** 字面量内嵌引用规则：槽位类型 ← 允许嵌入的类型。string 槽最严（文件不能当文本入参）。 */
const EMBED_IN = {
    string: new Set(["string", "number", "bool"]),
    number: new Set(["number"]),
    bool: new Set([]),
    path: new Set(["string", "number", "bool", "path", "remote_path"]),
    remote_path: new Set(["string", "number", "bool", "path", "remote_path"]),
    bash: new Set(["string", "number", "bool", "path", "remote_path"]),
    list: new Set(["string", "number", "bool", "path", "remote_path"]),
    map: new Set(["string", "number", "bool"]),
};
/** vars.set 允许声明的产出物类型。 */
const VAR_TYPES = new Set(["string", "number", "bool", "path", "remote_path"]);

/** @param {any} v 样例值 → 类型名（envSchema / params 推导用） */
function typeOfSample(v) {
    if (typeof v === "number") return "number";
    if (typeof v === "boolean") return "bool";
    return "string";
}

/**
 * 渲染单个参数值（字符串做模板渲染，其余原样转字符串）。
 * @param {any} v
 * @param {Record<string, any>} scope
 * @param {string} name 报错时定位用
 */
function renderVal(v, scope, name) {
    if (typeof v === "string") return renderTemplate(v, scope, name);
    return String(v);
}

/**
 * 渲染对象的每个字符串值。
 * @param {Record<string, any>} obj
 * @param {Record<string, any>} scope
 * @param {string} name
 */
function renderPairs(obj, scope, name) {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = renderVal(v, scope, `${name}.${k}`);
    return out;
}

/** 值落日志时的掩码规则：键名敏感 → 只显示占位。 */
const SECRET_RE = /SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PRIVATE/i;
const mask = (k, v) => (SECRET_RE.test(k) && String(v).length > 0 ? `${k}=***` : `${k}=${v}`);

// ── 步骤注册表：label/desc/params/outputs 供 GUI 与文档使用；run 为执行实现 ────
/** @type {Record<string, {label:string, desc:string, params:Array, outputs:Array, validate?:Function, run:Function}>} */
export const STEPS = {
    /**
     * checkout 指定 revision；之后的步骤都在该 revision 上执行，结束自动恢复原分支。
     * dry-run 也会真实 checkout（只读仓库并恢复，用于算出真实版本号）。
     */
    "git.checkout": {
        label: "选择 revision",
        desc: "git fetch → 校验工作树干净 → checkout 指定 ref（空 = HEAD 当前工作树），之后的步骤都跑在该 revision 上，结束自动恢复原分支。",
        params: [{ key: "ref", type: "string", desc: "分支/tag 名；支持 {{ref}}（部署时选择的 ref），留空用 HEAD" }],
        outputs: [
            { name: "versionId", type: "string", desc: "<ref>-<shorthash>[-dirty]" },
            { name: "buildTime", type: "string", desc: "UTC 构建时间 YYYYMMDDHHMMSS" },
            { name: "releaseName", type: "string", desc: "<app>-<versionId>-<buildTime>" },
        ],
        validate(step, where) {
            if (step.ref !== undefined && typeof step.ref !== "string") throw new Error(`${where}: "ref" 必须是字符串`);
        },
        async run(ctx, step, scope, sess, steps, index) {
            const ref = step.ref !== undefined ? renderVal(step.ref, scope, "git.checkout.ref").trim() : scope.ref;
            await withDeployVersion(
                ctx.manifest.repoDir,
                { ref: ref || undefined },
                async (versionId, buildTime) => {
                    scope.versionId = versionId;
                    scope.buildTime = buildTime;
                    if (!scope.releaseName) scope.releaseName = `${scope.app}-${versionId}-${buildTime}`;
                    ctx.log(`version: ${versionId}（build ${buildTime}）`);
                    await execSteps(ctx, steps, index + 1, scope, sess);
                },
                { log: ctx.log },
            );
        },
    },

    /** 构建前写 env 文件（如 Vite 的 .env），值支持 {{引用}}（文本槽，路径/文件类型不可嵌入）。 */
    "env.write": {
        label: "写 env 文件",
        desc: "构建前把键值对写成 env 文件（LF 行尾），值支持 {{versionId}} 等引用；键名含 SECRET/TOKEN 等的值在日志中打码。",
        params: [
            { key: "file", type: "path", required: true, desc: "写入路径，相对应用仓库（支持 {{repoDir}}/{{clientDir}}/.env 形式）" },
            { key: "pairs", type: "map", required: true, desc: "KEY → 值（文本）" },
        ],
        outputs: [],
        validate(step, where) {
            if (typeof step.file !== "string" || !step.file) throw new Error(`${where}: "file" 必填`);
            if (!step.pairs || typeof step.pairs !== "object" || Array.isArray(step.pairs)) throw new Error(`${where}: "pairs" 必须是对象`);
        },
        async run(ctx, step, scope) {
            const file = renderVal(step.file, scope, "env.write.file");
            const fp = path.isAbsolute(file) ? file : path.join(ctx.manifest.repoDir, file);
            const pairs = renderPairs(step.pairs, scope, "env.write");
            const content = Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join("");
            if (ctx.dryRun) {
                ctx.log(`[dry-run] 将写入 ${file}:`);
                for (const [k, v] of Object.entries(pairs)) ctx.log(`  ${mask(k, v)}`);
                return;
            }
            writeLF(fp, content);
            ctx.log(`env written: ${file}（${Object.keys(pairs).length} keys）`);
        },
    },

    /** 本地命令（构建等），cwd 缺省为应用仓库。 */
    "shell": {
        label: "本地命令",
        desc: "在本机执行 shell 命令（安装依赖、构建等），cwd 缺省为应用仓库。",
        params: [
            { key: "command", type: "bash", required: true, desc: "命令；可嵌 {{repoDir}} {{installCommand}} 等" },
            { key: "cwd", type: "path", desc: "工作目录，缺省应用仓库" },
            { key: "title", type: "string", desc: "日志显示名" },
        ],
        outputs: [],
        validate(step, where) {
            if (typeof step.command !== "string" || !step.command.trim()) throw new Error(`${where}: "command" 必填`);
        },
        async run(ctx, step, scope) {
            const command = renderVal(step.command, scope, "shell.command");
            if (ctx.dryRun) {
                ctx.log(`[dry-run] 本地将执行: ${command}（cwd: ${path.basename(ctx.manifest.repoDir)}）`);
                return;
            }
            await cmd(command, { cwd: step.cwd ? renderVal(step.cwd, scope, "shell.cwd") : ctx.manifest.repoDir, log: ctx.log });
        },
    },

    /**
     * 打 tar.gz。source 模式（整目录为包根，SPA dist 用这个）或 entries 模式
     * （多条目 + excludes 段排除，源码直发用这个）。产出 archivePath/archiveName。
     */
    "archive": {
        label: "打包 tar.gz",
        desc: "把本机目录/多条目打成 t.gz。excludes 按路径段匹配（node_modules 命中任意层级）。产出 archivePath（本机）与 archiveName。",
        params: [
            { key: "source", type: "path", desc: "整目录为包根（与 entries 二选一）" },
            { key: "entries", type: "list", itemType: "path", desc: "多条目模式：相对应用仓库的条目列表" },
            { key: "excludes", type: "list", itemType: "string", desc: "排除的路径段（任意层级命中即排除）" },
        ],
        outputs: [
            { name: "archivePath", type: "path", desc: "本机 tgz 路径（任务结束自动清理）" },
            { name: "archiveName", type: "string", desc: "<releaseName>.tgz" },
        ],
        validate(step, where) {
            const hasSource = typeof step.source === "string";
            const hasEntries = Array.isArray(step.entries) && step.entries.length > 0;
            if (hasSource === hasEntries) throw new Error(`${where}: "source" 与 "entries" 二选一`);
            if (step.excludes !== undefined && !Array.isArray(step.excludes)) throw new Error(`${where}: "excludes" 必须是数组`);
        },
        async run(ctx, step, scope) {
            const releaseName = scope.releaseName || `${scope.app}-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
            scope.releaseName = releaseName;
            scope.archiveName = `${releaseName}.tgz`;
            scope.archivePath = path.join(TMP_DIR, scope.archiveName);

            if (step.source !== undefined) {
                const source = renderVal(step.source, scope, "archive.source");
                if (ctx.dryRun) {
                    ctx.log(`[dry-run] 将打包目录 ${source} → ${scope.archiveName}（整目录为包根）`);
                    return;
                }
                if (!fs.existsSync(source)) throw new Error(`archive source missing: ${source}`);
                await compress(source, ["."], scope.archivePath);
            } else {
                const entries = step.entries.map((/** @type {any} */ e) => renderVal(e, scope, "archive.entries"));
                const excludes = step.excludes ?? [];
                if (ctx.dryRun) {
                    ctx.log(`[dry-run] 将打包条目: ${entries.join(", ")}${excludes.length ? `（排除 ${excludes.join(", ")}）` : ""} → ${scope.archiveName}`);
                    return;
                }
                const stage = makeStageDir(TMP_DIR, `${scope.app}-stage`);
                try {
                    for (const entry of entries) {
                        const src = path.isAbsolute(entry) ? entry : path.join(ctx.manifest.repoDir, entry);
                        if (!fs.existsSync(src)) throw new Error(`staging source missing: ${src}`);
                        copyTree(src, path.join(stage, entry), rel => !excludes.some(x => rel.split("/").includes(x)));
                    }
                    await compress(stage, entries, scope.archivePath);
                } finally {
                    rmrf(stage);
                }
            }
            ctx.log(`archived: ${scope.archiveName}`);
        },
    },

    /** 上传本机文件到远端（SFTP put）。 */
    "upload": {
        label: "上传到服务器",
        desc: "把本机文件（如 {{archivePath}}）经 SFTP 上传到远端路径。产出 uploadedTo（remote_path）。",
        params: [
            { key: "from", type: "path", required: true, desc: "本机文件路径" },
            { key: "to", type: "remote_path", required: true, desc: "远端目标路径" },
        ],
        outputs: [{ name: "uploadedTo", type: "remote_path", desc: "上传后的远端路径（再次 upload 会覆盖）" }],
        validate(step, where) {
            if (typeof step.from !== "string" || typeof step.to !== "string") throw new Error(`${where}: "from"/"to" 必填`);
        },
        async run(ctx, step, scope, sess) {
            const from = renderVal(step.from, scope, "upload.from");
            const to = renderVal(step.to, scope, "upload.to");
            scope.uploadedTo = to;
            if (ctx.dryRun) {
                ctx.log(`[dry-run] 将上传 ${path.basename(from)} → ${to}`);
                return;
            }
            const ssh = await ensureSsh(ctx, scope, sess);
            await sshPut(ssh, from, to, { log: ctx.log });
        },
    },

    /** 远端命令；sudo: true 时加 sudo -n 前缀（服务器需配好 NOPASSWD）。 */
    "remote": {
        label: "远端命令",
        desc: "在目标服务器执行命令（解压、软链、systemd、nginx reload 等）。sudo: true 时加 sudo -n（需 NOPASSWD）。",
        params: [
            { key: "command", type: "bash", required: true, desc: "命令；可嵌 {{DEPLOY_DIR}} {{releaseName}} 等" },
            { key: "sudo", type: "bool", desc: "以 sudo -n 执行" },
            { key: "title", type: "string", desc: "日志显示名" },
        ],
        outputs: [],
        validate(step, where) {
            if (typeof step.command !== "string" || !step.command.trim()) throw new Error(`${where}: "command" 必填`);
        },
        async run(ctx, step, scope, sess) {
            const command = renderVal(step.command, scope, "remote.command");
            const full = step.sudo ? `sudo -n ${command}` : command;
            if (ctx.dryRun) {
                ctx.log(`[dry-run] remote$ ${full}`);
                return;
            }
            const ssh = await ensureSsh(ctx, scope, sess);
            await sshExec(ssh, full, { log: ctx.log });
        },
    },

    /**
     * 渲染应用仓库里的配置模板（nginx/frp 等，随应用仓库版本管理）并推送到远端。
     * 模板路径 "./" 前缀 = 相对工作流配置目录；vars 缺省 = 整个作用域（模板直接写 {{DOMAIN}} 等大写键）。
     */
    "template.push": {
        label: "推送配置模板",
        desc: "渲染模板文件（{{KEY}} 占位）后推送到远端。模板随应用仓库版本管理；“./”前缀 = 相对工作流配置目录。dry-run 打印渲染结果。",
        params: [
            { key: "template", type: "path", required: true, desc: "模板路径：相对应用仓库，“./”=相对工作流配置目录，或绝对路径" },
            { key: "to", type: "remote_path", required: true, desc: "远端目标路径" },
            { key: "vars", type: "map", desc: "渲染变量；缺省用整个作用域" },
        ],
        outputs: [{ name: "uploadedTo", type: "remote_path", desc: "推送后的远端路径（会覆盖 upload 的同名产出）" }],
        validate(step, where) {
            if (typeof step.template !== "string" || !step.template) throw new Error(`${where}: "template" 必填`);
            if (typeof step.to !== "string" || !step.to) throw new Error(`${where}: "to" 必填`);
            if (step.vars !== undefined && (typeof step.vars !== "object" || Array.isArray(step.vars))) throw new Error(`${where}: "vars" 必须是对象`);
        },
        async run(ctx, step, scope, sess) {
            const base = step.template.startsWith("./")
                ? (ctx.manifest.configDir || ctx.manifest.repoDir)
                : ctx.manifest.repoDir;
            const fpTemplate = path.isAbsolute(step.template) ? step.template : path.join(base, step.template);
            const vars = step.vars ? renderPairs(step.vars, scope, "template.push.vars") : scope;
            const content = renderTemplateFile(fpTemplate, vars);
            const to = renderVal(step.to, scope, "template.push.to");
            scope.uploadedTo = to;
            const fpRendered = path.join(TMP_DIR, `rendered-wf-${path.basename(fpTemplate)}`);
            writeLF(fpRendered, content);
            if (ctx.dryRun) {
                ctx.log(`──── ${step.template}（dry-run，不上传）→ ${to} ────`);
                for (const line of content.split("\n")) ctx.log(`  ${line}`);
                ctx.log("────────────────────────────");
                return;
            }
            const ssh = await ensureSsh(ctx, scope, sess);
            await sshPut(ssh, fpRendered, to, { log: ctx.log });
        },
    },

    /** 声明派生产出物（中间变量），供后续步骤引用；types 可声明每个产出的类型。 */
    "vars.set": {
        label: "声明产出物",
        desc: "把派生值（路径拼接、命名中间结果）登记为带类型的产出物，供后续步骤引用——这是步骤之间的“连线”。",
        params: [
            { key: "pairs", type: "map", required: true, desc: "名字 → 值（按 types 里声明的类型校验嵌入引用）" },
            { key: "types", type: "map", desc: "名字 → 类型（string/number/bool/path/remote_path，缺省 string）" },
        ],
        outputs: [],
        validate(step, where) {
            if (!step.pairs || typeof step.pairs !== "object" || Array.isArray(step.pairs)) throw new Error(`${where}: "pairs" 必须是对象`);
            if (step.types !== undefined && (typeof step.types !== "object" || Array.isArray(step.types))) throw new Error(`${where}: "types" 必须是对象`);
            for (const [k, t] of Object.entries(step.types ?? {})) {
                if (!VAR_TYPES.has(/** @type {string} */(t))) throw new Error(`${where}: types.${k}="${t}" 不是可声明的类型（${[...VAR_TYPES].join("/")}）`);
            }
        },
        async run(ctx, step, scope) {
            const pairs = renderPairs(step.pairs, scope, "vars.set");
            Object.assign(scope, pairs);
            ctx.log(`vars: ${Object.keys(pairs).map(k => mask(k, pairs[k])).join("  ")}`);
        },
    },

    /** 打印标注行（纯文本）。 */
    "log": {
        label: "日志标注",
        desc: "在工作流日志里打印一行文本（可嵌引用），用于给流程加注释性节点。",
        params: [{ key: "message", type: "string", required: true, desc: "文本内容" }],
        outputs: [],
        validate(step, where) {
            if (typeof step.message !== "string") throw new Error(`${where}: "message" 必填`);
        },
        async run(ctx, step, scope) {
            ctx.log(renderVal(step.message, scope, "log.message"));
        },
    },
};

/** 步骤元数据（GET /api/step-types 与文档的唯一事实源）。 */
export function describeSteps() {
    return Object.entries(STEPS).map(([type, s]) => ({
        type,
        label: s.label,
        desc: s.desc,
        params: s.params,
        outputs: s.outputs,
    }));
}

/**
 * 惰性建立 SSH 连接（首个远端步骤时），整个任务复用一条连接。
 * @param {any} ctx
 * @param {Record<string, any>} scope
 * @param {{ssh: any}} sess
 */
async function ensureSsh(ctx, scope, sess) {
    if (sess.ssh) return sess.ssh;
    ctx.log(`Connecting to ${scope.REMOTE_HOST}...`);
    sess.ssh = await sshConnect(scope.REMOTE_HOST, scope.REMOTE_USER, scope.REMOTE_HOST_FINGERPRINT, {
        log: ctx.log,
        keyFile: scope.REMOTE_KEY_FILE || undefined,
    });
    return sess.ssh;
}

/**
 * 从 steps[start] 开始逐步执行；遇到 git.checkout 时把剩余步骤包进
 * withDeployVersion 回调（checkout 之后的步骤都跑在该 revision 上）。
 * @param {any} ctx
 * @param {any[]} steps
 * @param {number} start
 * @param {Record<string, any>} scope
 * @param {{ssh: any}} sess
 */
async function execSteps(ctx, steps, start, scope, sess) {
    for (let i = start; i < steps.length; i++) {
        const step = steps[i];
        if (step.type === "git.checkout") {
            ctx.log(`──── [${i + 1}/${steps.length}] git.checkout ────`);
            await STEPS["git.checkout"].run(ctx, step, scope, sess, steps, i);
            return;
        }
        ctx.log(`──── [${i + 1}/${steps.length}] ${step.type}${step.title ? `：${step.title}` : ""} ────`);
        await STEPS[step.type].run(ctx, step, scope, sess);
    }
}

// ── 编译期类型校验 ────

/**
 * 构建任务起点可见的符号表：name → { type, from, stepIndex? }。
 * stepIndex = 产出该符号的步骤下标（该步骤之后才可引用）；内置符号无 stepIndex。
 * @param {any} json
 * @param {Record<string, any>} envSchema
 */
function buildBaseSymbols(json, envSchema) {
    /** @type {Map<string, {type: string, from: string, stepIndex?: number}>} */
    const symbols = new Map();
    symbols.set("app", { type: "string", from: "内置" });
    symbols.set("repoDir", { type: "path", from: "内置" });
    symbols.set("ref", { type: "string", from: "任务选项" });
    symbols.set("release", { type: "string", from: "任务选项" });
    for (const [k, v] of Object.entries(json.params || {})) symbols.set(k, { type: "string", from: "params" });
    for (const [k, v] of Object.entries(envSchema || {})) symbols.set(k, { type: typeOfSample(v), from: "env" });
    return symbols;
}

/**
 * 校验一个模板值（整值引用按兼容表；字面量内嵌按嵌入规则）。
 * @param {any} val
 * @param {string} slotType
 * @param {Map<string, any>} symbols
 * @param {number} atIndex 当前步骤下标（前向引用检测）
 * @param {string} where 报错定位
 * @param {string[]} errors 累积器
 */
function checkTemplateValue(val, slotType, symbols, atIndex, where, errors) {
    if (val === undefined || val === null) return;
    if (typeof val === "boolean" || typeof val === "number") return;
    if (typeof val !== "string") {
        errors.push(`${where}: 值必须是文本（得到 ${Array.isArray(val) ? "数组" : typeof val}）`);
        return;
    }
    /** @param {string} name @param {string} kind */
    const checkRef = (name, kind) => {
        const sym = symbols.get(name);
        if (!sym) {
            errors.push(`${where}: ${kind}了未定义的 {{${name}}}`);
            return;
        }
        if (sym.stepIndex !== undefined && sym.stepIndex >= atIndex) {
            errors.push(`${where}: 在步骤[${sym.stepIndex + 1}] 产出之前${kind}了 {{${name}}}`);
            return;
        }
        const table = kind === "嵌入" ? EMBED_IN : TYPE_COMPAT;
        if (!table[slotType]?.has(sym.type)) {
            errors.push(`${where}: ${kind} {{${name}}}（${sym.type}，来自${sym.from}）类型不兼容——${slotType} 槽位只接受 ${(table[slotType] ? [...table[slotType]] : []).join("/")}`);
        }
    };
    const pure = /^\{\{(\w+)\}\}$/.exec(val.trim());
    if (pure) {
        checkRef(pure[1], "引用");
        return;
    }
    for (const m of val.matchAll(/\{\{(\w+)\}\}/g)) checkRef(m[1], "嵌入");
}

/**
 * 对整个工作流 JSON 做编译期类型校验，返回全部错误（空数组 = 通过）。
 * @param {any} json
 * @param {Record<string, any>} envSchema
 */
function checkWorkflowTypes(json, envSchema) {
    /** @type {string[]} */
    const errors = [];
    for (const [taskName, wf] of Object.entries(json.workflows)) {
        const steps = Array.isArray(wf) ? wf : wf?.steps;
        if (!Array.isArray(steps)) continue;
        // 先登记全部产出物（带产出步骤下标），再按位置校验引用 → 前向引用自然被检出
        const symbols = buildBaseSymbols(json, envSchema);
        steps.forEach((step, i) => {
            const meta = STEPS[step?.type];
            if (!meta) return;
            for (const o of meta.outputs) symbols.set(o.name, { type: o.type, from: `步骤[${i + 1}] ${step.type}`, stepIndex: i });
            if (step.type === "vars.set" && step.pairs && typeof step.pairs === "object") {
                for (const k of Object.keys(step.pairs)) {
                    const t = /** @type {string} */ (step.types?.[k] ?? "string");
                    if (VAR_TYPES.has(t)) symbols.set(k, { type: t, from: `步骤[${i + 1}] vars.set`, stepIndex: i });
                }
            }
        });

        steps.forEach((step, i) => {
            if (!step || typeof step !== "object") return;
            const meta = STEPS[step.type];
            if (!meta) return; // 结构校验另行报错
            const where = `workflows.${taskName}.steps[${i}](${step.type})`;
            for (const p of meta.params) {
                const v = step[p.key];
                if (v === undefined) continue;
                if (p.type === "bool") {
                    if (typeof v !== "boolean") errors.push(`${where}: 参数 ${p.key} 必须是 true/false`);
                } else if (p.type === "list") {
                    if (!Array.isArray(v)) errors.push(`${where}: 参数 ${p.key} 必须是数组`);
                    else v.forEach((el, j) => checkTemplateValue(el, "bash", symbols, i, `${where}: 参数 ${p.key}[${j}]`, errors));
                } else if (p.type === "map") {
                    if (!v || typeof v !== "object" || Array.isArray(v)) errors.push(`${where}: 参数 ${p.key} 必须是对象`);
                    else if (step.type === "vars.set" && p.key === "pairs") {
                        // 每个值按该产出声明的类型校验
                        for (const [k, val] of Object.entries(v)) {
                            const t = /** @type {string} */ (step.types?.[k] ?? "string");
                            checkTemplateValue(val, VAR_TYPES.has(t) ? t : "string", symbols, i, `${where}: 产出 ${k}`, errors);
                        }
                    } else {
                        for (const [k, val] of Object.entries(v)) checkTemplateValue(val, "string", symbols, i, `${where}: 参数 ${p.key}.${k}`, errors);
                    }
                } else {
                    checkTemplateValue(v, /** @type {string} */ (p.type), symbols, i, `${where}: 参数 ${p.key}`, errors);
                }
            }
        });
    }
    return errors;
}

/**
 * 编译工作流 JSON → 标准 manifest（与 runner/GUI 契约一致）。
 *
 * json 结构：
 *   { name, title?, description?, repoDir, envFile, envSchema?, params?,
 *     workflows: { <task>: ({ steps: [...], mutates? } | [...steps]) } }
 *
 * @param {any} json
 * @param {string} [configPath] 报错定位 + template.push “./” 解析基准
 */
export function compileWorkflowApp(json, configPath = "workflow") {
    const where = `workflows/${path.basename(String(configPath))}`;
    for (const k of ["name", "repoDir", "envFile", "workflows"]) {
        if (!json?.[k]) throw new Error(`${where}: "${k}" 必填`);
    }
    if (!/^[A-Za-z0-9._-]+$/.test(json.name)) throw new Error(`${where}: 非法应用名 "${json.name}"`);
    if (typeof json.workflows !== "object" || Array.isArray(json.workflows)) throw new Error(`${where}: "workflows" 必须是对象`);
    if (json.envSchema && (typeof json.envSchema !== "object" || Array.isArray(json.envSchema))) throw new Error(`${where}: "envSchema" 必须是对象`);
    const envSchema = json.envSchema || deployBaseSchema;

    /** @type {Record<string, {mutates: boolean, run: (ctx: any) => Promise<void>}>} */
    const tasks = {};
    for (const [taskName, wf] of Object.entries(json.workflows)) {
        const steps = Array.isArray(wf) ? wf : wf?.steps;
        const mutates = Array.isArray(wf) ? true : wf?.mutates ?? true;
        if (!Array.isArray(steps) || steps.length === 0) throw new Error(`${where}: workflows.${taskName}.steps 必须是非空数组`);
        steps.forEach((step, i) => {
            if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`${where}: workflows.${taskName}.steps[${i}] 必须是对象`);
            if (!STEPS[step.type]) throw new Error(`${where}: workflows.${taskName}.steps[${i}]: 未知步骤类型 "${step.type}"（可用: ${Object.keys(STEPS).join(", ")}）`);
            STEPS[step.type].validate?.(step, `${where}: workflows.${taskName}.steps[${i}]`);
        });
        if (steps.filter(s => s.type === "git.checkout").length > 1) throw new Error(`${where}: workflows.${taskName} 只允许一个 git.checkout 步骤`);
        // {{release}} 引用必须配合 --release：空串会渲染成 .../releases/ 空路径，绝不能上远端。
        const needsRelease = JSON.stringify(steps).includes("{{release}}");

        tasks[taskName] = {
            mutates: !!mutates,
            run: async (/** @type {any} */ ctx) => {
                const env = loadTaskEnv(ctx);
                if (ctx.options.release) validateReleaseName(ctx.options.release);
                if (needsRelease && !ctx.options.release) {
                    throw new Error(`${taskName} 需要 --release <name>（先跑 status 查看 releases 列表）`);
                }
                const scope = buildScope(json, ctx, env);
                const sess = { ssh: null };
                try {
                    if (env.SERVER_TYPE && env.REMOTE_HOST) {
                        ctx.log(`target: SERVER_TYPE=${env.SERVER_TYPE} ${env.REMOTE_USER}@${env.REMOTE_HOST}:${env.DEPLOY_DIR}`);
                    }
                    await execSteps(ctx, steps, 0, scope, sess);
                    ctx.log(`[Done] ${taskName} success`);
                } finally {
                    sshClose(sess.ssh);
                    if (scope.archivePath) rmrf(scope.archivePath);
                }
            },
        };
    }

    // 类型校验最后做：结构错误先报，类型错误一次性全量报出
    const typeErrors = checkWorkflowTypes(json, envSchema);
    if (typeErrors.length) throw new Error(`${where}: 类型校验失败\n  ${typeErrors.join("\n  ")}`);

    const configDir = path.isAbsolute(String(configPath)) ? path.dirname(String(configPath)) : undefined;
    return {
        name: json.name,
        title: json.title || json.name,
        description: json.description || "配置驱动工作流应用",
        repoDir: json.repoDir,
        envFile: json.envFile,
        envSchema,
        params: json.params || {},
        source: "workflow",
        configPath,
        configDir,
        tasks,
    };
}

/**
 * 构建扁平插值作用域：params + options（含 ref/release 空串兜底）+ env。
 * env 最后合并（键值以 env 文件为准）；产出物由步骤执行时写入同一对象。
 * @param {any} json
 * @param {any} ctx
 * @param {Record<string, any>} env
 */
function buildScope(json, ctx, env) {
    const definedOptions = Object.fromEntries(Object.entries(ctx.options).filter(([, v]) => v != null));
    return {
        app: json.name,
        repoDir: ctx.manifest.repoDir,
        ...(json.params || {}),
        ...definedOptions,
        ref: ctx.options.ref ?? "",
        release: ctx.options.release ?? "",
        ...env,
    };
}
