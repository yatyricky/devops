import fs from "fs";
import path from "path";
import { cmd, writeLF, copyTree, expandHome, rmrf } from "../exec.js";
import { compress, makeStageDir } from "../tarball.js";
import { renderTemplateFile, resolveTemplatePath } from "../render.js";
import { resolveDeployVersion } from "../gitops.js";
import { ROOT, TMP_DIR } from "../runner.js";

/** tar.pack 白/黑名单互斥校验（workflow.validateWorkflow 与运行期共用同一规则）。 */
export function tarEntriesProblem(node) {
    const hasEntries = Array.isArray(node.data?.entries) && node.data.entries.length > 0;
    const hasExcludes = Array.isArray(node.data?.excludes) && node.data.excludes.length > 0;
    return hasEntries && hasExcludes ? "tar.pack：打包条目与不打包条目只能二选一（白名单或黑名单）" : "";
}

/**
 * 构建/版本类节点：git 版本、本地命令、env 生成、暂存、打包、模板渲染、npm 脚本。
 */

/** 读取目录下 package.json 的 scripts 键集（npm.run 卡片下拉与执行校验共用）。 */
export function readNpmScripts(dir) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return Object.keys(pkg.scripts ?? {});
}

export default [
    {
        type: "git.ref",
        desc: "在仓库上计算部署版本：fetch → 按需 checkout 指定 ref → 结束自动恢复原分支。输出版本号/构建时间/release 名。",
        title: "Git 版本",
        category: "版本",
        color: "#e5c07b",
        inputs: [{ id: "ref", type: "string", required: false }],
        outputs: [
            { id: "versionId", type: "string" },
            { id: "buildTime", type: "string" },
            { id: "releaseName", type: "string" },
            { id: "repoDir", type: "string" },
        ],
        widgets: [
            { key: "repoDir", label: "仓库目录", kind: "string", default: "", placeholder: "C:/...（绝对路径）" },
            { key: "prefix", label: "release 名前缀", kind: "string", default: "", placeholder: "如 kids-ledger" },
        ],
        async run(ctx, node, inputs) {
            const repoDir = path.resolve(expandHome(node.data.repoDir));
            if (!repoDir || !fs.existsSync(repoDir)) throw new Error(`git.ref 仓库不存在: ${repoDir}`);
            const { versionId, buildTime, restore } = await resolveDeployVersion(repoDir, inputs.ref || undefined, { dryRun: ctx.dryRun, log: ctx.log });
            // git.ref 的作用域 = 整个任务：清理注册到任务级（finalize 逆序执行）
            if (restore) ctx.registerGitRestore(restore);
            const prefix = node.data.prefix ? `${node.data.prefix}-` : "";
            ctx.log(`git: version=${versionId} time=${buildTime}`);
            return { versionId, buildTime, releaseName: `${prefix}${versionId}-${buildTime}`, repoDir };
        },
    },
    {
        type: "git.checkout",
        desc: "切换仓库到指定分支或 tag：输入 repoDir 与 ref，输出切换前的 HEAD（original），可用它链式切回。",
        title: "Git Checkout",
        category: "版本",
        color: "#e5c07b",
        inputs: [
            { id: "repoDir", type: "string", required: true },
            { id: "ref", type: "string", required: true },
        ],
        outputs: [{ id: "original", type: "string" }],
        widgets: [],
        async run(ctx, node, inputs) {
            const repoDir = inputs.repoDir;
            if (!repoDir) throw new Error("git.checkout 未连接仓库目录");
            const ref = String(inputs.ref ?? "").trim();
            if (!ref) throw new Error("git.checkout 未配置 ref");
            // ref 白名单（分支/tag/hash 字符集）：cmd 走 shell，拒绝一切元字符注入
            if (!/^[A-Za-z0-9._/-]+$/.test(ref)) throw new Error(`git.checkout 非法 ref（仅允许字母数字._/-）: ${ref}`);
            /** 切换前的 HEAD：分支名；detached 时为 hash */
            let original;
            try {
                original = (await cmd("git symbolic-ref --quiet --short HEAD", { cwd: repoDir, log: () => {} })).toString().trim();
            } catch {
                original = (await cmd("git rev-parse HEAD", { cwd: repoDir, log: () => {} })).toString().trim();
            }
            if (ctx.dryRun) {
                ctx.log(`[dry-run] git: 将 checkout ${ref}（当前 HEAD: ${original}）`);
                return { original };
            }
            await cmd(`git checkout ${ref}`, { cwd: repoDir, log: ctx.log });
            ctx.log(`[git.checkout] ${original} → ${ref}`);
            return { original };
        },
    },
    {
        type: "git.getRefs",
        desc: "输出一个选定的 ref 名：卡片上点「刷新」拉取分支/tag 下拉来挑选，默认 HEAD。",
        title: "Git Get Refs",
        category: "版本",
        color: "#e5c07b",
        refsPicker: true,
        inputs: [{ id: "repoDir", type: "string", required: true }],
        outputs: [{ id: "ref", type: "string" }],
        widgets: [],
        async run(ctx, node) {
            const ref = String(node.data.ref ?? "HEAD") || "HEAD";
            ctx.log(`[git.getRefs] 输出 ref = ${ref}`);
            return { ref };
        },
    },
    {
        type: "cmd.exec",
        desc: "在本机逐行执行命令（dry-run 只打印计划）。输出最后一条命令的 stdout。",
        title: "本地命令",
        category: "构建",
        color: "#4cc38a",
        inputs: [{ id: "cwd", type: "string", required: false }],
        outputs: [{ id: "out", type: "string" }],
        widgets: [
            { key: "cwd", label: "工作目录（输入未连线时生效）", kind: "string", default: "" },
            { key: "commands", label: "命令（每行一条）", kind: "text", default: "" },
        ],
        async run(ctx, node, inputs) {
            const commands = String(node.data.commands ?? "").split("\n").map(s => s.trim()).filter(Boolean);
            if (!commands.length) throw new Error("cmd.exec 未配置命令");
            const cwd = inputs.cwd || node.data.cwd || undefined;
            let out = "";
            for (const c of commands) {
                if (ctx.dryRun) { ctx.log(`[dry-run] $ ${c}${cwd ? `  (cwd: ${path.basename(cwd)})` : ""}`); continue; }
                out = await cmd(c, { cwd, log: ctx.log });
            }
            return { out: String(out ?? "").trim() };
        },
    },
    {
        type: "stage.copy",
        desc: "把 N 条 from 复制/改名到一次性暂存目录，输出暂存目录供打包。from：绝对路径（/ 盘符 ~ 开头）或相对 root（支持 ./ ../）；to：相对暂存目录，不许绝对路径或 ..（防污染外部）；to 未填 = from 去掉 root 前缀的相对路径，from 在 root 外时用 basename（警告）。目录递归复制（排除 node_modules/.git），目标父目录自动创建。",
        title: "Staged Copy",
        category: "构建",
        color: "#4cc38a",
        pairInputs: { key: "count", prefix: "p", min: 1, max: 16, sub: [{ suffix: "from" }, { suffix: "to" }] },
        inputs: [{ id: "root", type: "string", required: true }],
        outputs: [{ id: "dir", type: "string" }],
        widgets: [
            { key: "count", label: "条目个数（1-16）", kind: "stepper", min: 1, max: 16, serializable: true, default: 1 },
        ],
        async run(ctx, node, inputs) {
            const rootR = path.resolve(expandHome(String(inputs.root ?? "").trim()));
            if (!rootR || !fs.existsSync(rootR)) throw new Error(`stage.copy：root 不存在: ${rootR}`);
            const stage = makeStageDir(TMP_DIR, `stage-${node.id}`);
            const count = Math.min(16, Math.max(1, Number(node.data.count ?? 1) || 1));
            if (ctx.dryRun) ctx.log(`[dry-run] 暂存到 ${stage}（${count} 条）`);
            for (let i = 1; i <= count; i++) {
                const fromRaw = String(inputs[`p${i}.from`] ?? "").trim();
                if (!fromRaw) throw new Error(`stage.copy：条目 p${i} 的 from 为空`);
                // from：绝对路径（含 ~ 展开）直用；相对路径以 root 为基准（不是进程 cwd）
                const fromR = path.resolve(rootR, expandHome(fromRaw));
                if (!fs.existsSync(fromR)) throw new Error(`暂存源不存在: ${fromR}`);

                // to 缺省：from 在 root 之下 → 保持相对结构；在 root 之外 → basename（警告）
                let to = String(inputs[`p${i}.to`] ?? "").trim();
                if (!to) {
                    if (fromR === rootR || fromR.startsWith(rootR + path.sep)) {
                        to = path.relative(rootR, fromR).split(path.sep).join("/");
                    } else {
                        to = path.basename(fromR).replace(/\\/g, "/");
                        ctx.log(`[WARN] p${i}: to 未填且 from 在 root 外，使用 basename: ${to}`);
                    }
                }
                // to 校验：相对暂存目录，防污染外部
                const toNorm = to.replace(/\\/g, "/");
                if (path.isAbsolute(toNorm) || /^[A-Za-z]:\//.test(toNorm) || toNorm.split("/").includes("..")) {
                    throw new Error(`stage.copy：非法 to "${to}"（须为暂存目录内的相对路径，不允许绝对路径或 ..）`);
                }

                const dest = path.join(stage, ...toNorm.split("/"));
                if (ctx.dryRun) {
                    ctx.log(`[dry-run] 复制 ${fromR} → ${dest}${fs.statSync(fromR).isDirectory() ? "（递归）" : ""}`);
                    continue;
                }
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                if (fs.statSync(fromR).isDirectory()) {
                    copyTree(fromR, dest, rel => !rel.split("/").includes("node_modules") && !rel.split("/").includes(".git"));
                } else {
                    fs.copyFileSync(fromR, dest);
                }
                ctx.log(`[stage] ${fromR} → ${toNorm}`);
            }
            ctx.log(`[stage] ${stage}`);
            return { dir: stage };
        },
    },
    {
        type: "tar.pack",
        desc: "把目录打成 t.gz，输出压缩包完整路径。三种模式：不配置条目 = 打包全部；仅打包条目 = 白名单；仅不打包条目 = 黑名单（按路径段排除）。两者都配属配置错误。",
        title: "Pack Tgz",
        category: "构建",
        color: "#4cc38a",
        inputs: [
            { id: "dir", type: "string", required: true },
            { id: "name", type: "string", required: false },
        ],
        outputs: [{ id: "archive", type: "string" }],
        widgets: [
            { key: "entries", label: "打包条目（白名单，相对 dir）", kind: "list", default: [] },
            { key: "excludes", label: "不打包条目（黑名单，路径段）", kind: "list", default: [] },
        ],
        async run(ctx, node, inputs) {
            const problem = tarEntriesProblem(node);
            if (problem) throw new Error(problem);
            const entries = node.data.entries ?? [];
            const excludes = node.data.excludes ?? [];
            const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
            const base = inputs.name || `archive-${ts}`;
            const archiveName = `${base}.tgz`;
            const archivePath = path.join(TMP_DIR, archiveName);

            /** @type {string[]} 待打包条目 */
            let packEntries;
            /** @type {string | null} 黑名单模式的一次性暂存目录 */
            let stage = null;
            if (!entries.length && !excludes.length) {
                // 顶层条目打包：内容直接位于包顶层（与白/黑名单产物形状一致），不用 "." 惯用法（会存成 ./ 前缀）
                packEntries = fs.readdirSync(inputs.dir);
                if (!packEntries.length) throw new Error(`tar.pack：目录为空，无可打包内容: ${inputs.dir}`);
            } else if (entries.length) {
                packEntries = entries;
            } else {
                stage = makeStageDir(TMP_DIR, `tarpack-${node.id}`);
                copyTree(inputs.dir, stage, rel => !excludes.some(x => rel.split("/").includes(x) || rel.endsWith(String(x))));
                packEntries = fs.readdirSync(stage);
            }

            if (ctx.dryRun) {
                const what = packEntries[0] === "." ? "全部内容" : `[${packEntries.join(", ")}]`;
                ctx.log(`[dry-run] 打包 ${inputs.dir} 的 ${what} → ${archiveName}${stage ? "（黑名单：暂存后打包）" : ""}`);
                if (stage) rmrf(stage);
                return { archive: archivePath };
            }
            try {
                await compress(stage ?? inputs.dir, packEntries, archivePath);
                ctx.log(`[tar] ${archiveName}`);
                return { archive: archivePath };
            } finally {
                if (stage) rmrf(stage);
            }
        },
    },
    {
        type: "template.render",
        desc: "渲染 {{KEY}} 模板文件。path 输入 = 模板路径（\"./\" 相对工作流目录，绝对路径直用，其余相对应用仓库）；编辑期按模板内容自动生成各 {{VAR}} 输入口（手填或连线，可为 Path Resolve 推断值）。输出渲染产物路径（.tmp 下，按节点防重复）。",
        title: "Render Template",
        category: "构建",
        color: "#4cc38a",
        tplVars: true,
        inputs: [{ id: "path", type: "string", required: true }],
        outputs: [{ id: "file", type: "string" }],
        widgets: [],
        async run(ctx, node, inputs) {
            const t = String(inputs.path ?? "").trim();
            if (!t) throw new Error("template.render 未提供模板路径（手填或连线）");
            /** "./x" = 工作流文件所在目录；绝对路径直用；其余相对应用仓库（模板随应用仓库版本管理） */
            const fpTpl = resolveTemplatePath(t, ctx.configDir ?? ROOT, ctx.repoDir ?? ROOT);
            // 变量来源：vars struct 口（整体对象）展开 + 各 {{VAR}} 散口（path 除外）
            const vars = {
                ...(typeof inputs.vars === "object" && inputs.vars ? inputs.vars : {}),
                ...Object.fromEntries(Object.entries(inputs).filter(([k]) => k !== "path" && k !== "vars")),
            };
            const missing = [];
            const content = fs.readFileSync(fpTpl, "utf8");
            for (const m of content.matchAll(/\{\{(\w+)\}\}/g)) {
                if (vars[m[1]] === undefined) missing.push(m[1]);
            }
            if (missing.length) throw new Error(`模板变量未连线/未手填：${[...new Set(missing)].join(", ")}`);
            const rendered = renderTemplateFile(fpTpl, vars);
            const outName = path.basename(fpTpl);
            const fpOut = path.join(TMP_DIR, `rendered-${node.id}-${outName}`);
            writeLF(fpOut, rendered);
            ctx.log(`[render] ${path.basename(fpTpl)} → ${path.basename(fpOut)}（${Object.keys(vars).length} 变量）`);
            if (ctx.dryRun) {
                ctx.log("──── 渲染产物（dry-run）────");
                for (const line of rendered.split("\n").slice(0, 400)) ctx.log(`  ${line}`);
                ctx.log("────────────────────────────");
            }
            return { file: fpOut };
        },
    },
    {
        type: "npm.run",
        title: "Npm Run",
        category: "构建",
        color: "#4cc38a",
        scriptsPicker: true,
        desc: "在指定目录执行 npm run <脚本>：脚本下拉点「刷新」解析该目录 package.json 的 scripts（序列化值不在集合中时默认取第一项）。通用执行节点——不感知构建产物，产物定位交给下游节点。",
        inputs: [{ id: "path", type: "string", required: true }],
        outputs: [],
        widgets: [{ key: "script", label: "脚本（npm run）", kind: "string", serializable: true, default: "" }],
        async run(ctx, node, inputs) {
            const dir = path.resolve(expandHome(String(inputs.path ?? "").trim()));
            if (!dir || dir === path.parse(dir).root) throw new Error("npm.run 未连接项目目录");
            const script = String(node.data.script ?? "").trim();
            if (!script) throw new Error("npm.run 未选择脚本");
            let scripts;
            try { scripts = readNpmScripts(dir); } catch (e) { throw new Error(`npm.run 读取 ${dir}/package.json 失败: ${e.message}`); }
            if (!scripts.includes(script)) {
                throw new Error(`npm.run：脚本 "${script}" 不在 package.json scripts 中（可用: ${scripts.join(", ") || "无"}）`);
            }
            if (ctx.dryRun) {
                ctx.log(`[dry-run] npm run ${script}（cwd: ${dir}）`);
                return {};
            }
            ctx.log(`[npm.run] npm run ${script}（cwd: ${dir}）`);
            await cmd(`npm run ${script}`, { cwd: dir, log: ctx.log });
            return {};
        },
    },
];
