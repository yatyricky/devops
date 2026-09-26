import fs from "fs";
import path from "path";
import { sshConnect, sshRun, sshPut, sshClose } from "../ssh.js";
import { resolveAlias } from "../sshconfig.js";
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
        desc: "按 ~/.ssh/config 的别名建立 SSH 会话（同 ssh <alias>：HostName/User/Port/IdentityFile），可选 SHA256 指纹锁定，输出 ssh 供全部远端节点使用。",
        title: "SSH 会话",
        category: "远端",
        color: "#ff9e64",
        sshAliasesPicker: true,
        inputs: [],
        outputs: [{ id: "ssh", type: "ssh" }],
        widgets: [
            { key: "fingerprint", label: "指纹（选填，SHA256 base64/hex，锁定主机）", kind: "string", serializable: true, default: "" },
        ],
        async run(ctx, node) {
            const r = resolveAlias(node.data.alias);
            const fpLocked = !!node.data.fingerprint;
            if (ctx.dryRun) {
                ctx.log(`[dry-run] SSH ${node.data.alias} → ${r.user}@${r.host}:${r.port}${r.identityFile ? `（私钥 ${r.identityFile}）` : ""}（${r.fromConfig ? "来自 ssh config" : "未在 config 中找到，按主机名直连"}；指纹${fpLocked ? "已锁定" : "未锁定，将警告"}）`);
                return { ssh: { dryRun: true } };
            }
            ctx.log(`[ssh] 连接 ${node.data.alias} → ${r.user}@${r.host}:${r.port}...`);
            let ssh;
            try {
                ssh = await sshConnect(r.host, r.user, node.data.fingerprint, {
                    log: ctx.log,
                    keyFile: r.identityFile,
                    port: r.port,
                });
            } catch (e) {
                if (/Encrypted private/.test(e.message)) {
                    throw new Error(`私钥 ${r.identityFile} 有口令保护且引擎无法交互输入。两条路：① ssh-add "${r.identityFile}" 加载进 Windows agent（服务已在跑）；② 换用已加载的密钥或无口令私钥。原始错误：${e.message}`);
                }
                throw e;
            }
            ctx.registerSession(ssh);
            ctx.log("[ssh] 已建立");
            return { ssh };
        },
    },
    {
        type: "ssh.close",
        title: "关闭 SSH 会话",
        category: "远端",
        color: "#ff9e64",
        desc: "显式关闭上游 SSH 会话连接，提前释放资源；之后该 ssh 出口不可再被下游节点使用（任务收尾仍会兜底关闭已关闭的会话，幂等无副作用）。",
        inputs: [{ id: "ssh", type: "ssh", required: true }],
        outputs: [],
        widgets: [],
        async run(ctx, node, inputs) {
            if (ctx.dryRun) { ctx.log("[dry-run] ssh.close：将关闭上游 SSH 会话"); return; }
            ctx.log("[ssh.close] 关闭会话");
            sshClose(inputs.ssh);
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
        desc: "上传本机文件到远端。remotePath 为已有文件夹 → 放入其中（保持本机文件名）；为文件路径 → 上传为该路径（父目录自动 mkdir -p，文件名不同即等效重命名）。无 trap——上传即完成，文件不会被自动清理。输出远端文件完整路径。",
        title: "上传文件",
        category: "远端",
        color: "#ff9e64",
        inputs: [
            { id: "ssh", type: "ssh", required: true },
            { id: "localPath", type: "string", required: true },
            { id: "remotePath", type: "string", required: true },
        ],
        outputs: [{ id: "remoteFile", type: "string" }],
        widgets: [],
        async run(ctx, node, inputs) {
            const local = String(inputs.localPath ?? "").trim();
            if (!local) throw new Error("ssh.upload 未连接本机文件路径");
            let st;
            try { st = await fs.promises.stat(local); } catch { throw new Error(`本机文件不存在: ${local}`); }
            if (!st.isFile()) throw new Error(`localPath 不是文件: ${local}`);
            const remotePath = String(inputs.remotePath ?? "").trim();
            if (!remotePath) throw new Error("ssh.upload 未连接 remotePath");
            const base = path.basename(local);

            // 远端语义判定：remotePath 是已有目录 → 放入其中；否则视为目标文件路径（父目录 mkdir -p）
            const isDir = (await sshRun(inputs.ssh, buildCommand(`test -d ${sq(remotePath)}`, node, { sudo: false }), { log: () => {} })).code === 0;
            const remoteFile = isDir
                ? `${remotePath.replace(/\/+$/, "")}/${base}`
                : remotePath;
            if (ctx.dryRun) {
                ctx.log(`[dry-run] 上传 ${local} → ${remoteFile}${isDir ? "（remotePath 为已有目录）" : "（remotePath 为文件路径，父目录 mkdir -p）"}；无 trap，文件保留`);
                return { remoteFile };
            }
            if (!isDir) {
                const parent = remotePath.includes("/") ? remotePath.slice(0, remotePath.lastIndexOf("/")) : ".";
                const r = await sshRun(inputs.ssh, buildCommand(`mkdir -p ${sq(parent)}`, node, { sudo: false }), { log: ctx.log });
                if (r.code !== 0) throw new Error(`mkdir -p 失败: ${parent}\n${r.err}`);
            }
            await sshPut(inputs.ssh, local, remoteFile, { log: ctx.log });
            ctx.log(`[upload] ${remoteFile}`);
            return { remoteFile };
        },
    },
    {
        type: "remote.extract",
        desc: "把远端 t.gz 解压到目标目录。两种模式：未填 parentName = extract here（压缩包一级内容直接进 destDir）；填了 parentName = 先创建 destDir/parentName，压缩包全部内容解压进去。输出实际解压目录。",
        title: "解压",
        category: "远端",
        color: "#ff9e64",
        inputs: [
            { id: "ssh", type: "ssh", required: true },
            { id: "archive", type: "string", required: true },
            { id: "destDir", type: "string", required: true },
            { id: "parentName", type: "string", required: false },
        ],
        outputs: [{ id: "destDir", type: "string" }],
        widgets: [],
        async run(ctx, node, inputs) {
            const { ssh, archive } = inputs;
            const destDir = String(inputs.destDir ?? "").trim();
            if (!destDir) throw new Error("解压 未配置 destDir");
            const parent = String(inputs.parentName ?? "").trim();
            if (parent && !/^[A-Za-z0-9._-]+$/.test(parent)) throw new Error(`非法 parentName: ${parent}（只允许字母数字 . _ -）`);
            const target = parent ? `${destDir.replace(/\/+$/, "")}/${parent}` : destDir;
            const R = async (cmd) => {
                const r = await sshRun(ssh, buildCommand(cmd, node, { sudo: false }), { log: ctx.log });
                if (r.code !== 0) throw new Error(`remote command failed: ${cmd}\n${r.err}`);
            };
            const plan = [`mkdir -p ${sq(target)}`, `tar -xzf ${sq(archive)} -C ${sq(target)}`];
            if (ctx.dryRun) {
                for (const c of plan) ctx.log(`[dry-run] remote$ ${buildCommand(c, node, { sudo: false })}`);
                return { destDir: target };
            }
            for (const c of plan) await R(c);
            ctx.log(`[extract] ${target}`);
            return { destDir: target };
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
    {
        type: "remote.nginx-reload",
        title: "Nginx Reload",
        category: "远端",
        color: "#ff9e64",
        desc: "远端 nginx -t 校验配置，通过后 systemctl reload nginx；校验不过即任务失败（不会带病重载）。经 sudo -n 执行，需 NOPASSWD。",
        inputs: [{ id: "ssh", type: "ssh", required: true }],
        outputs: [],
        widgets: [],
        async run(ctx, node, inputs) {
            const cmdStr = "nginx -t && systemctl reload nginx";
            const finalCmd = buildCommand(cmdStr, node);
            if (ctx.dryRun) { ctx.log(`[dry-run] remote$ ${finalCmd}`); return; }
            const r = await sshRun(inputs.ssh, finalCmd, { log: ctx.log });
            if (r.code !== 0) throw new Error(`nginx reload 失败 (code=${r.code})\n${r.err}`);
        },
    },
];
