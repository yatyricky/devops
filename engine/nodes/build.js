import fs from "fs";
import path from "path";
import { cmd, writeLF, copyTree, expandHome } from "../exec.js";
import { compress, makeStageDir } from "../tarball.js";
import { renderTemplateFile } from "../render.js";
import { resolveDeployVersion } from "../gitops.js";
import { ROOT, TMP_DIR } from "../runner.js";

/**
 * 构建/版本类节点：git 版本、本地命令、env 生成、暂存、打包、模板渲染。
 */

export default [
    {
        type: "git.ref",
        desc: "在仓库上计算部署版本：fetch → 按需 checkout 指定 ref → 结束自动恢复原分支。输出版本号/构建时间/release 名。",
        title: "Git 版本",
        category: "版本",
        color: "#f07178",
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
        title: "切换分支",
        category: "版本",
        color: "#f07178",
        inputs: [
            { id: "repoDir", type: "folder", required: true },
            { id: "ref", type: "string", required: true },
        ],
        outputs: [{ id: "original", type: "string" }],
        widgets: [],
        async run(ctx, node, inputs) {
            const repoDir = inputs.repoDir;
            if (!repoDir) throw new Error("git.checkout 未连接仓库目录");
            const ref = String(inputs.ref ?? "").trim();
            if (!ref) throw new Error("git.checkout 未配置 ref");
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
        title: "Git Refs",
        category: "版本",
        color: "#f07178",
        refsPicker: true,
        inputs: [{ id: "repoDir", type: "folder", required: true }],
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
        type: "write.env",
        desc: "把 env 结构按映射（文件键 ← env 键）写成 .env 文件，可注入 VERSION；输出文件路径。",
        title: "生成 .env",
        category: "构建",
        color: "#4cc38a",
        inputs: [
            { id: "env", type: "env", required: true },
            { id: "version", type: "string", required: false },
            { id: "dir", type: "string", required: false },
        ],
        outputs: [{ id: "file", type: "file" }],
        widgets: [
            { key: "target", label: "目标路径（相对 dir 输入或 ROOT；绝对路径直用）", kind: "string", default: "" },
            { key: "mapping", label: "映射（文件键 ← env 键）", kind: "kv", default: {} },
        ],
        async run(ctx, node, inputs) {
            if (!node.data.target) throw new Error("write.env 未配置目标路径");
            const modEnv = { ...inputs.env, ...(inputs.version !== undefined ? { VERSION: inputs.version } : {}) };
            const lines = Object.entries(node.data.mapping ?? {})
                .map(([fileKey, envKey]) => `${fileKey}=${modEnv[/** @type {string} */(envKey)] ?? ""}`);
            const raw = node.data.target;
            const fp = inputs.dir
                ? path.join(inputs.dir, raw)
                : path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
            const content = lines.join("\n") + "\n";
            if (ctx.dryRun) {
                ctx.log(`[dry-run] 写 ${fp}：\n${content.trimEnd().split("\n").map(l => `    ${ctx.mask(l)}`).join("\n")}`);
            } else {
                writeLF(fp, content);
                ctx.log(`[env] 已写入 ${fp}（${lines.length} 键）`);
            }
            return { file: fp };
        },
    },
    {
        type: "stage.copy",
        desc: "把若干条目复制到一次性暂存目录（按路径段排除），输出暂存目录供打包。",
        title: "暂存复制",
        category: "构建",
        color: "#4cc38a",
        inputs: [{ id: "root", type: "string", required: false }],
        outputs: [{ id: "dir", type: "string" }],
        widgets: [
            { key: "entries", label: "条目（from → to）", kind: "entries", default: [] },
            { key: "excludes", label: "排除（路径段）", kind: "list", default: ["node_modules"] },
        ],
        async run(ctx, node, inputs) {
            const entries = node.data.entries ?? [];
            if (!entries.length) throw new Error("stage.copy 未配置条目");
            const root = inputs.root || ROOT;
            const stage = makeStageDir(TMP_DIR, `stage-${node.id}`);
            const excludes = node.data.excludes ?? [];
            const filter = rel => !excludes.some(x => rel.split("/").includes(x) || rel.endsWith(String(x)));
            if (ctx.dryRun) {
                ctx.log(`[dry-run] 暂存到 ${stage}：${entries.map(e => `${e.from}→${e.to}`).join(", ")}（排除 ${excludes.join(",")}）`);
                return { dir: stage };
            }
            for (const e of entries) {
                const src = path.resolve(root, e.from);
                if (!fs.existsSync(src)) throw new Error(`暂存源不存在: ${src}`);
                copyTree(src, path.join(stage, e.to), filter);
            }
            ctx.log(`[stage] ${stage}`);
            return { dir: stage };
        },
    },
    {
        type: "tar.pack",
        desc: "把目录按条目打成 t.gz，输出归档路径与文件名（供上传）。",
        title: "打包 tgz",
        category: "构建",
        color: "#4cc38a",
        inputs: [
            { id: "dir", type: "string", required: true },
            { id: "name", type: "string", required: false },
        ],
        outputs: [
            { id: "archive", type: "file" },
            { id: "archiveName", type: "string" },
        ],
        widgets: [
            { key: "entries", label: "打包条目（相对 dir）", kind: "list", default: [] },
            { key: "prefix", label: "文件名前缀（name 未连线时用）", kind: "string", default: "" },
        ],
        async run(ctx, node, inputs) {
            const entries = node.data.entries ?? [];
            if (!entries.length) throw new Error("tar.pack 未配置条目");
            const ts = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
            const base = inputs.name || `${node.data.prefix || "archive"}-${ts}`;
            const archiveName = `${base}.tgz`;
            const archivePath = path.join(TMP_DIR, archiveName);
            if (ctx.dryRun) {
                ctx.log(`[dry-run] 打包 ${inputs.dir} 的 [${entries.join(", ")}] → ${archiveName}`);
                return { archive: archivePath, archiveName };
            }
            await compress(inputs.dir, entries, archivePath);
            ctx.log(`[tar] ${archiveName}`);
            return { archive: archivePath, archiveName };
        },
    },
    {
        type: "template.render",
        desc: "渲染 {{KEY}} 模板文件为渲染产物：\"./\" 相对工作流目录，绝对路径直用，其余相对应用仓库。",
        title: "渲染模板",
        category: "构建",
        color: "#4cc38a",
        inputs: [{ id: "vars", type: "any", required: false }],
        outputs: [{ id: "file", type: "file" }],
        widgets: [
            { key: "template", label: "模板路径（相对 templates/ 或绝对）", kind: "string", default: "" },
            { key: "extra", label: "附加变量", kind: "kv", default: {} },
            { key: "outputName", label: "渲染产物名（默认同模板名）", kind: "string", default: "" },
        ],
        async run(ctx, node, inputs) {
            if (!node.data.template) throw new Error("template.render 未配置模板路径");
            const t = String(node.data.template);
            /** "./x" = 工作流文件所在目录；绝对路径直用；其余相对应用仓库（模板随应用仓库版本管理） */
            const fpTpl = t.startsWith("./")
                ? path.join(ctx.configDir ?? ROOT, t.slice(2))
                : path.isAbsolute(t) ? t : path.join(ctx.repoDir ?? ROOT, t);
            const vars = { ...(inputs.vars ?? {}), ...(node.data.extra ?? {}) };
            const rendered = renderTemplateFile(fpTpl, vars);
            const outName = node.data.outputName || path.basename(fpTpl);
            const fpOut = path.join(TMP_DIR, `rendered-${node.id}-${outName}`);
            writeLF(fpOut, rendered);
            ctx.log(`[render] ${path.basename(fpTpl)} → ${path.basename(fpOut)}（${Object.keys(vars).length} 变量）`);
            if (ctx.dryRun) {
                ctx.log("──── 渲染产物（dry-run）────");
                for (const line of rendered.split("\n").slice(0, 400)) ctx.log(`  ${ctx.mask(line)}`);
                ctx.log("────────────────────────────");
            }
            return { file: fpOut };
        },
    },
];
