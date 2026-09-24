import { sshConnect, sshRun, sshPut } from "../ssh.js";
import { shellQuote as sq } from "../release.js";

/**
 * 远端节点：会话、命令（动态插槽）、上传、原子解压、装依赖、属主、符号链接、服务、只读检查。
 *
 * 语义要点（对照原幂等 bash 脚本）：
 * - loginShell 默认开启：命令经 `bash -lc` 执行，nvm 装的 node/pnpm 可用（原脚本 `bash -l` 等价）。
 * - useSudo 默认开启：`sudo -n`（NOPASSWD 缺失快速失败）。
 * - remote.extract 内部保持原子性：解压到 .tmp → 校验 expect → mv 成正式 release；失败自清 .tmp。
 * - ssh.upload 登记为 always-clean 副作用：任务结束（无论成败）由 runner 删除远端归档（原 trap 语义）。
 */

/** @param {string} cmd @param {{loginShell?: boolean, useSudo?: boolean}} node */
function buildCommand(cmd, node, opts = {}) {
    let c = cmd;
    if (opts.sudo !== false && (node.data.useSudo ?? true)) c = `sudo -n ${c}`;
    if (node.data.loginShell ?? true) c = `bash -lc ${sq(c)}`;
    return c;
}

/** @param {string} text @returns {string[]} */
function placeholders(text) {
    return [...String(text ?? "").matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1]);
}

/**
 * 占位符替换为实参：
 *   {{name}}     ← inputs.name（shell 引号包裹）
 *   {{obj.key}}  ← inputs.obj[key]（对象经 any 连线传入，按键取值后包裹）
 */
function substitute(text, inputs) {
    return String(text).replace(/\{\{(\w+)(?:\.(\w+))?\}\}/g, (_, name, key) => {
        if (!(name in inputs) || inputs[name] === undefined) throw new Error(`命令占位符 {{${name}${key ? "." + key : ""}}} 未连线`);
        let v = inputs[name];
        if (key) {
            v = v?.[key];
            if (v === undefined) throw new Error(`占位符 {{${name}.${key}}}：对象里没有键 ${key}`);
        }
        return sq(v);
    });
}

export default [
    {
        type: "ssh.session",
        desc: "建立 SSH 会话（SHA256 指纹锁定，agent/私钥认证），输出 ssh 供全部远端节点使用。",
        title: "SSH 会话",
        category: "远端",
        color: "#ff9e64",
        inputs: [{ id: "env", type: "struct", required: true }],
        outputs: [{ id: "ssh", type: "ssh" }],
        widgets: [],
        async run(ctx, node, inputs) {
            const env = inputs.env;
            if (ctx.dryRun) {
                ctx.log(`[dry-run] SSH 连接 ${env.REMOTE_USER}@${env.REMOTE_HOST}（指纹${env.REMOTE_HOST_FINGERPRINT ? "已锁定" : "未锁定，将警告"}）`);
                return { ssh: { dryRun: true } };
            }
            ctx.log(`[ssh] 连接 ${env.REMOTE_USER}@${env.REMOTE_HOST}...`);
            const ssh = await sshConnect(env.REMOTE_HOST, env.REMOTE_USER, env.REMOTE_HOST_FINGERPRINT, {
                log: ctx.log,
                keyFile: env.REMOTE_KEY_FILE || undefined,
            });
            ctx.registerSession(ssh);
            ctx.log("[ssh] 已建立");
            return { ssh };
        },
    },
    {
        type: "ssh.exec",
        desc: "远端逐行执行命令：{{name}} 占位符自动生成输入口，值自动安全加引号；sudo 与登录 shell 可开关。",
        title: "SSH 命令",
        category: "远端",
        color: "#ff9e64",
        inputs: [{ id: "ssh", type: "ssh", required: true }],
        outputs: [{ id: "out", type: "string" }],
        widgets: [
            { key: "command", label: "命令（{{name}} 生成输入插槽，值自动加引号）", kind: "text", default: "" },
            { key: "useSudo", label: "sudo -n", kind: "boolean", default: true },
            { key: "loginShell", label: "登录 shell（nvm PATH）", kind: "boolean", default: true },
        ],
        dynamicInputs: { source: "command", type: "string" },
        async run(ctx, node, inputs) {
            const raw = String(node.data.command ?? "").trim();
            if (!raw) throw new Error("ssh.exec 未配置命令");
            const lines = raw.split("\n").map(s => s.trim()).filter(Boolean);
            let last = { code: 0, out: "", err: "" };
            for (const line of lines) {
                const resolved = substitute(line, inputs);
                const finalCmd = buildCommand(resolved, node);
                if (ctx.dryRun) { ctx.log(`[dry-run] remote$ ${finalCmd}`); continue; }
                last = await sshRun(inputs.ssh, finalCmd, { log: ctx.log });
                if (last.code !== 0) throw new Error(`remote command failed (code=${last.code}): ${resolved}\n${last.err}`);
            }
            return { out: last.out.trim() };
        },
    },
    {
        type: "ssh.upload",
        desc: "上传本机文件到远端路径；登记 trap——任务结束无论成败都删除远端文件。",
        title: "上传文件",
        category: "远端",
        color: "#ff9e64",
        inputs: [
            { id: "ssh", type: "ssh", required: true },
            { id: "local", type: "file", required: true },
            { id: "path", type: "string", required: true },
        ],
        outputs: [{ id: "remoteFile", type: "string" }],
        widgets: [],
        async run(ctx, node, inputs) {
            if (ctx.dryRun) {
                ctx.log(`[dry-run] 上传 ${inputs.local} → ${inputs.path}`);
                return { remoteFile: inputs.path };
            }
            await sshPut(inputs.ssh, inputs.local, inputs.path, { log: ctx.log });
            // 原脚本 trap 语义：上传的归档无论成败都在任务结束时删除
            ctx.trackRemoteFile(inputs.ssh, inputs.path);
            return { remoteFile: inputs.path };
        },
    },
    {
        type: "remote.extract",
        desc: "原子解压发布：解压到隐藏 .tmp → 逐个校验 expect → mv 成正式 release；失败自清 .tmp。",
        title: "原子解压发布",
        category: "远端",
        color: "#ff9e64",
        inputs: [
            { id: "ssh", type: "ssh", required: true },
            { id: "archive", type: "string", required: true },
            { id: "releaseName", type: "string", required: true },
            { id: "baseDir", type: "string", required: true },
        ],
        outputs: [{ id: "releasePath", type: "string" }],
        widgets: [
            { key: "expect", label: "必须存在的文件（相对 release）", kind: "list", default: [] },
            { key: "subdir", label: "release 子目录名", kind: "string", default: "releases" },
            { key: "useSudo", label: "sudo -n", kind: "boolean", default: true },
        ],
        async run(ctx, node, inputs) {
            const { ssh, archive, releaseName, baseDir } = inputs;
            if (!/^[A-Za-z0-9._-]+$/.test(releaseName)) throw new Error(`非法 release 名: ${releaseName}`);
            const releaseDir = `${baseDir}/${node.data.subdir || "releases"}`;
            const tmp = `${releaseDir}/.${releaseName}.tmp`;
            const rel = `${releaseDir}/${releaseName}`;
            const D = node.data;
            const R = async (cmd, { sudo = true } = {}) => sshRun(ssh, buildCommand(cmd, node, { sudo }), { log: ctx.log });

            const plan = [
                `rm -rf ${tmp}`,
                `mkdir -p ${tmp} ${releaseDir}`,
                `tar -xzf ${sq(archive)} -C ${tmp}`,
                ...((D.expect ?? []).map(f => `test -f ${sq(`${tmp}/${f}`)}`)),
                `rm -rf ${rel}`,
                `mv ${tmp} ${rel}`,
            ];
            if (ctx.dryRun) {
                for (const c of plan) ctx.log(`[dry-run] remote$ ${buildCommand(c, node)}`);
                return { releasePath: rel };
            }

            await R(`rm -rf ${tmp}`);
            await R(`mkdir -p ${tmp} ${releaseDir}`);
            await R(`tar -xzf ${sq(archive)} -C ${tmp}`);
            try {
                for (const f of (D.expect ?? [])) {
                    const r = await R(`test -f ${sq(`${tmp}/${f}`)}`);
                    if (r.code !== 0) throw new Error(`校验失败：release 内缺少 ${f}`);
                }
            } catch (e) {
                ctx.log(`[cleanup] 解压校验失败，清理 ${tmp}`);
                await R(`rm -rf ${tmp}`).catch(() => {});
                throw e;
            }
            await R(`rm -rf ${rel}`);
            await R(`mv ${tmp} ${rel}`);
            ctx.log(`[release] ${rel}`);
            return { releasePath: rel };
        },
    },
    {
        type: "remote.deps",
        desc: "在远端目录安装生产依赖（npm ci --omit=dev 或 pnpm install --prod）。",
        title: "安装生产依赖",
        category: "远端",
        color: "#ff9e64",
        inputs: [
            { id: "ssh", type: "ssh", required: true },
            { id: "path", type: "string", required: true },
        ],
        outputs: [],
        widgets: [
            { key: "manager", label: "包管理器", kind: "enum", options: ["npm", "pnpm"], default: "npm" },
            { key: "useSudo", label: "sudo -n", kind: "boolean", default: true },
            { key: "loginShell", label: "登录 shell（nvm PATH）", kind: "boolean", default: true },
        ],
        async run(ctx, node, inputs) {
            const install = node.data.manager === "pnpm"
                ? `pnpm install --prod --frozen-lockfile`
                : `npm ci --omit=dev`;
            const cmdStr = `cd ${sq(inputs.path)} && ${install}`;
            if (ctx.dryRun) { ctx.log(`[dry-run] remote$ ${buildCommand(cmdStr, node)}`); return; }
            const r = await sshRun(inputs.ssh, buildCommand(cmdStr, node), { log: ctx.log });
            if (r.code !== 0) throw new Error(`依赖安装失败 (code=${r.code}): ${cmdStr}\n${r.err}`);
        },
    },
    {
        type: "remote.chown",
        desc: "递归修改远端路径属主（sudo 可关）。",
        title: "修改属主",
        category: "远端",
        color: "#ff9e64",
        inputs: [
            { id: "ssh", type: "ssh", required: true },
            { id: "path", type: "string", required: true },
            { id: "user", type: "string", required: true },
        ],
        outputs: [],
        widgets: [{ key: "useSudo", label: "sudo -n", kind: "boolean", default: true }],
        async run(ctx, node, inputs) {
            const cmdStr = `chown -R ${inputs.user}:${inputs.user} ${sq(inputs.path)}`;
            if (ctx.dryRun) { ctx.log(`[dry-run] remote$ ${buildCommand(cmdStr, node)}`); return; }
            const r = await sshRun(inputs.ssh, buildCommand(cmdStr, node), { log: ctx.log });
            if (r.code !== 0) throw new Error(`chown 失败: ${cmdStr}\n${r.err}`);
        },
    },
    {
        type: "remote.symlink",
        desc: "远端 ln -sfn 切换符号链接（发布/回滚的核心动作）。",
        title: "符号链接切换",
        category: "远端",
        color: "#ff9e64",
        inputs: [
            { id: "ssh", type: "ssh", required: true },
            { id: "target", type: "string", required: true },
            { id: "link", type: "string", required: true },
        ],
        outputs: [],
        widgets: [{ key: "useSudo", label: "sudo -n", kind: "boolean", default: true }],
        async run(ctx, node, inputs) {
            const cmdStr = `ln -sfn ${sq(inputs.target)} ${sq(inputs.link)}`;
            if (ctx.dryRun) { ctx.log(`[dry-run] remote$ ${buildCommand(cmdStr, node)}`); return; }
            const r = await sshRun(inputs.ssh, buildCommand(cmdStr, node), { log: ctx.log });
            if (r.code !== 0) throw new Error(`symlink 失败: ${cmdStr}\n${r.err}`);
        },
    },
    {
        type: "remote.service",
        desc: "systemd 动作：restart 附带 daemon-reload + reset-failed + 状态查看；失败即任务失败。",
        title: "systemd 服务",
        category: "远端",
        color: "#ff9e64",
        inputs: [
            { id: "ssh", type: "ssh", required: true },
            { id: "name", type: "string", required: true },
        ],
        outputs: [{ id: "out", type: "string" }],
        widgets: [
            { key: "action", label: "动作", kind: "enum", options: ["restart", "reload", "reload-or-restart", "enable", "status", "is-active"], default: "restart" },
            { key: "useSudo", label: "sudo -n", kind: "boolean", default: true },
        ],
        async run(ctx, node, inputs) {
            const name = inputs.name;
            const action = node.data.action ?? "restart";
            /** @type {string[]} */
            const steps = [];
            if (action === "restart") {
                steps.push(`systemctl daemon-reload`, `systemctl reset-failed ${sq(name)} 2>/dev/null || true`, `systemctl restart ${sq(name)}`, `systemctl status ${sq(name)} --no-pager || true`);
            } else if (action === "is-active") {
                steps.push(`systemctl is-active ${sq(name)}`);
            } else {
                steps.push(`systemctl ${action} ${sq(name)}`);
            }
            if (ctx.dryRun) {
                for (const s of steps) ctx.log(`[dry-run] remote$ ${buildCommand(s, node)}`);
                return { out: "" };
            }
            let out = "";
            for (const s of steps) {
                const r = await sshRun(inputs.ssh, buildCommand(s, node), { log: ctx.log });
                out = r.out;
                if (r.code !== 0 && !s.includes("|| true") && action !== "is-active" && action !== "status") {
                    throw new Error(`systemd ${action} ${name} 失败 (code=${r.code})\n${r.err}`);
                }
            }
            return { out: out.trim() };
        },
    },
    {
        type: "remote.check",
        desc: "远端只读命令 + 断言正则：对合并输出做匹配，不匹配即任务失败（如版本预检）。",
        title: "只读检查",
        category: "远端",
        color: "#ff9e64",
        inputs: [{ id: "ssh", type: "ssh", required: true }],
        outputs: [{ id: "out", type: "string" }],
        widgets: [
            { key: "command", label: "命令（{{name}} 生成输入插槽）", kind: "text", default: "" },
            { key: "assert", label: "断言正则（对合并输出）", kind: "string", default: "", placeholder: "如 v(2[2-9]|[3-9]\\d)\\." },
            { key: "loginShell", label: "登录 shell", kind: "boolean", default: true },
        ],
        dynamicInputs: { source: "command", type: "string" },
        async run(ctx, node, inputs) {
            const raw = String(node.data.command ?? "").trim();
            if (!raw) throw new Error("remote.check 未配置命令");
            const lines = raw.split("\n").map(s => s.trim()).filter(Boolean);
            let combined = "";
            for (const line of lines) {
                const resolved = substitute(line, inputs);
                const finalCmd = buildCommand(resolved, node, { sudo: false });
                if (ctx.dryRun) { ctx.log(`[dry-run] remote$ ${finalCmd}`); continue; }
                const r = await sshRun(inputs.ssh, finalCmd, { log: ctx.log });
                combined += r.out + "\n";
            }
            if (ctx.dryRun) return { out: "" };
            if (node.data.assert) {
                if (!new RegExp(node.data.assert).test(combined)) {
                    throw new Error(`断言失败 /${node.data.assert}/：\n${combined.trim()}`);
                }
                ctx.log(`[check] 断言通过 /${node.data.assert}/`);
            }
            return { out: combined.trim() };
        },
    },
];
