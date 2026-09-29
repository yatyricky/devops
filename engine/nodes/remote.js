import fs from "fs";
import path from "path";
import { sshConnect, sshRun, sshPut, sshClose } from "../ssh.js";
import { resolveAlias } from "../sshconfig.js";
import { shellQuote as sq } from "../release.js";

/**
 * 远端节点：会话、命令（动态插槽）、上传、解压、装依赖、属主、符号链接、服务、只读检查。
 *
 * 语义要点（对照原幂等 bash 脚本）：
 * - loginShell 默认开启：命令经 `bash -lc` 执行，nvm 装的 node/pnpm 可用（原脚本 `bash -l` 等价）。
 * - useSudo 默认开启：`sudo -n`（NOPASSWD 缺失快速失败）。
 * - remote.extract 是纯解压（mkdir -p + tar -xzf）；ssh.upload 无 trap（上传即保留），
 *   目标直写权限不足（SFTP 无法提权）时自动回退 /tmp 暂存 + `sudo -n install -m 644` 落到目标
 *   （回退落盘 root:root 0644，需 NOPASSWD）。
 */

/** @param {string} cmd @param {{loginShell?: boolean, useSudo?: boolean}} node */
function buildCommand(cmd, node, opts = {}) {
    let c = cmd;
    if (opts.sudo !== false && (node.data.useSudo ?? true)) {
        // sudoWrap：`sudo -n bash -c '<整段>'` —— 复合命令（&&/;）整段提权；前缀式 sudo 只覆盖第一段
        c = opts.sudoWrap ? `sudo -n bash -c ${sq(c)}` : `sudo -n ${c}`;
    }
    if (node.data.loginShell ?? true) c = `bash -lc ${sq(c)}`;
    return c;
}

/**
 * 远端命令执行样板：dry-run 打印计划，真执行 + 非零退出码抛错——deps/chown/symlink/nginx-reload/extract 共用。
 * @param {any} ctx
 * @param {any} node
 * @param {any} ssh
 * @param {string} cmdStr 未包装的用户态命令（sudo/loginShell 由 buildCommand 统一加）
 * @param {string} label 失败信息前缀（如 "chown" / "nginx reload"）
 * @param {{ sudo?: boolean, sudoWrap?: boolean }} [opts] buildCommand 透传
 */
async function runRemote(ctx, node, ssh, cmdStr, label, opts = {}) {
    if (ctx.dryRun) { ctx.log(`[dry-run] remote$ ${buildCommand(cmdStr, node, opts)}`); return null; }
    const r = await sshRun(ssh, buildCommand(cmdStr, node, opts), { log: ctx.log });
    if (r.code !== 0) throw new Error(`${label}失败 (code=${r.code}): ${cmdStr}\n${r.err}`);
    return r;
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
        title: "New SSH Session",
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
                    throw new Error(`私钥 ${r.identityFile} 有口令保护，且 agent 中未加载可用密钥（agent 已优先尝试）。两条路：① ssh-add "${r.identityFile}" 输一次口令加载进 Windows agent（之后常驻可用，推荐）；② 换用无口令密钥。原始错误：${e.message}`);
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
        title: "Close SSH Session",
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
        desc: "远端逐行执行命令：{{name}} 占位符自动生成输入口，值自动安全加引号；sudo 与登录 shell 可开关。sudo 开启时整行经 sudo -n bash -c 提权（复合命令 && 也整段生效）。",
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
                const finalCmd = buildCommand(resolved, node, { sudoWrap: true });
                if (ctx.dryRun) { ctx.log(`[dry-run] remote$ ${finalCmd}`); continue; }
                last = await sshRun(inputs.ssh, finalCmd, { log: ctx.log });
                if (last.code !== 0) throw new Error(`remote command failed (code=${last.code}): ${resolved}\n${last.err}`);
            }
            return { out: last.out.trim() };
        },
    },
    {
        type: "ssh.upload",
        desc: "上传本机文件到远端：remotePath 恒为目标文件路径（父目录自动 mkdir -p，权限不足时 sudo -n mkdir）。目标直写 Permission denied 时自动回退：暂存 /tmp 后 sudo -n install -m 644 落到目标（root:root 0644，需 NOPASSWD）。无 trap——上传即完成，文件不会被自动清理。输出远端文件完整路径。",
        title: "Upload File",
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
            const remoteFile = String(inputs.remotePath ?? "").trim();
            if (!remoteFile) throw new Error("ssh.upload 未连接 remotePath");
            if (ctx.dryRun) {
                ctx.log(`[dry-run] 上传 ${local} → ${remoteFile}；无 trap，文件保留`);
                return { remoteFile };
            }
            const parent = remoteFile.includes("/") ? remoteFile.slice(0, remoteFile.lastIndexOf("/")) : ".";
            let r = await sshRun(inputs.ssh, buildCommand(`mkdir -p ${sq(parent)}`, node, { sudo: false }), { log: ctx.log });
            if (r.code !== 0) {
                const rs = await sshRun(inputs.ssh, buildCommand(`mkdir -p ${sq(parent)}`, node), { log: ctx.log });
                if (rs.code !== 0) throw new Error(`mkdir -p 失败: ${parent}\n${rs.err}\n（直接 mkdir 错误: ${r.err}）`);
            }
            try {
                await sshPut(inputs.ssh, local, remoteFile, { log: ctx.log });
                ctx.log(`[upload] ${remoteFile}`);
            } catch (e) {
                const origMsg = String(e?.message ?? e);
                if (!/permission|denied|eacces|eperm/i.test(origMsg)) throw e;
                ctx.log(`[upload] 直写失败（${origMsg}），回退：/tmp 暂存 + sudo install`);
                const stageDir = `/tmp/devops-upload-${Math.random().toString(36).slice(2, 8)}`;
                const staged = `${stageDir}/${path.posix.basename(remoteFile)}`;
                const mk = await sshRun(inputs.ssh, buildCommand(`mkdir -p ${sq(stageDir)}`, node, { sudo: false }), { log: ctx.log });
                if (mk.code !== 0) throw new Error(`暂存目录创建失败: ${stageDir}\n${mk.err}`);
                let installErr = null;
                try {
                    await sshPut(inputs.ssh, local, staged, { log: ctx.log });
                    const ins = await sshRun(inputs.ssh, buildCommand(`install -m 644 ${sq(staged)} ${sq(remoteFile)}`, node), { log: ctx.log });
                    if (ins.code !== 0) installErr = new Error(`sudo install 失败 (code=${ins.code})\n${ins.err}`);
                } finally {
                    await sshRun(inputs.ssh, buildCommand(`rm -rf ${sq(stageDir)}`, node, { sudo: false }), { log: ctx.log });
                }
                if (installErr) throw new Error(`ssh.upload 回退失败（/tmp 暂存 + sudo install）：${installErr.message}\n原始直写错误: ${origMsg}`);
                ctx.log(`[upload] ${remoteFile}（经 sudo install，root:root 0644）`);
            }
            return { remoteFile };
        },
    },
    {
        type: "remote.extract",
        desc: "把远端 t.gz 解压到目标目录（压缩包一级内容直接进 destDir）。输出实际解压目录。",
        title: "Extract Archive",
        category: "远端",
        color: "#ff9e64",
        inputs: [
            { id: "ssh", type: "ssh", required: true },
            { id: "archive", type: "string", required: true },
            { id: "destDir", type: "string", required: true },
        ],
        outputs: [{ id: "destDir", type: "string" }],
        widgets: [],
        async run(ctx, node, inputs) {
            const destDir = String(inputs.destDir ?? "").trim();
            if (!destDir) throw new Error("解压 未配置 destDir");
            const target = destDir;
            const plan = [`mkdir -p ${sq(target)}`, `tar -xzf ${sq(inputs.archive)} -C ${sq(target)}`];
            if (ctx.dryRun) {
                for (const c of plan) ctx.log(`[dry-run] remote$ ${buildCommand(c, node, { sudo: false })}`);
                return { destDir: target };
            }
            for (const c of plan) await runRemote(ctx, node, inputs.ssh, c, "remote command", { sudo: false });
            ctx.log(`[extract] ${target}`);
            return { destDir: target };
        },
    },
    {
        type: "pnpm.install",
        desc: "生产环境安装依赖：cd <path> && pnpm install --prod --frozen-lockfile（严格按 pnpm-lock.yaml 装，与 package.json 不一致即失败，保证部署版本与本地测试一致）。恒以登录用户执行（pnpm 不该用 root，会污染 .pnpm-store 属主），login shell 保 nvm PATH。",
        title: "安装生产依赖",
        category: "远端",
        color: "#ff9e64",
        inputs: [
            { id: "ssh", type: "ssh", required: true },
            { id: "path", type: "string", required: true },
        ],
        outputs: [],
        widgets: [
            { key: "loginShell", label: "登录 shell（nvm PATH）", kind: "boolean", default: true },
        ],
        async run(ctx, node, inputs) {
            const dir = String(inputs.path ?? "").trim();
            if (!dir) throw new Error("pnpm.install 未连接 path");
            await runRemote(ctx, node, inputs.ssh, `cd ${sq(dir)} && pnpm install --prod --frozen-lockfile`, "依赖安装", { sudo: false });
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
            await runRemote(ctx, node, inputs.ssh, `chown -R ${sq(inputs.user)}:${sq(inputs.user)} ${sq(inputs.path)}`, "chown");
        },
    },
    {
        type: "remote.symlink",
        desc: "远端 ln -sfn 切换符号链接（发布/回滚的核心动作）。target 口＝真实路径（链指向的目标，ln 第一参数）；link 口＝要创建/替换的符号链接（第二参数）。",
        title: "Symlink",
        category: "远端",
        color: "#ff9e64",
        inputs: [
            { id: "ssh", type: "ssh", required: true },
            { id: "target", type: "string", required: true },
            { id: "link", type: "string", required: true },
        ],
        outputs: [],
        widgets: [],
        async run(ctx, node, inputs) {
            await runRemote(ctx, node, inputs.ssh, `ln -sfn ${sq(inputs.target)} ${sq(inputs.link)}`, "symlink");
        },
    },
    {
        type: "systemd.run",
        desc: "systemd 动作：restart = daemon-reload + reset-failed + restart + 状态查看（切 symlink 后让新 release 生效的标准动作；服务未运行时 restart 即拉起）；enable --now 用于首次部署；status/is-active 不因服务状态非零而失败（可作只读检查）。无输出——各步 stdout 已实时进任务日志。systemctl 需要 root，恒经 sudo -n，需 NOPASSWD。",
        title: "systemd 服务",
        category: "远端",
        color: "#ff9e64",
        inputs: [
            { id: "ssh", type: "ssh", required: true },
            { id: "name", type: "string", required: true },
        ],
        outputs: [],
        widgets: [
            { key: "action", label: "动作", kind: "enum", options: ["restart", "enable --now", "start", "reload", "reload-or-restart", "enable", "status", "is-active"], default: "restart" },
            { key: "useSudo", label: "sudo -n", kind: "boolean", default: true },
        ],
        async run(ctx, node, inputs) {
            const name = String(inputs.name ?? "").trim();
            if (!name) throw new Error("systemd.run 未连接 name");
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
                return;
            }
            for (const s of steps) {
                const r = await sshRun(inputs.ssh, buildCommand(s, node), { log: ctx.log });
                if (r.code !== 0 && !s.includes("|| true") && action !== "is-active" && action !== "status") {
                    throw new Error(`systemd ${action} ${name} 失败 (code=${r.code})\n${r.err}`);
                }
            }
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
                // 用户正则长度上限：降低灾难性回溯的攻击面（单线程执行，超长正则可挂死整个服务）
                if (String(node.data.assert).length > 500) throw new Error("remote.check：断言正则过长（≤500 字符）");
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
        desc: "远端 nginx -t 校验配置，通过后 systemctl reload nginx；校验不过即任务失败（不会带病重载）。整段经 sudo -n bash -c 提权（含 reload），需 NOPASSWD。",
        inputs: [{ id: "ssh", type: "ssh", required: true }],
        outputs: [],
        widgets: [],
        async run(ctx, node, inputs) {
            await runRemote(ctx, node, inputs.ssh, "nginx -t && systemctl reload nginx", "nginx reload", { sudoWrap: true });
        },
    },
    {
        type: "remote.install",
        desc: "远端安装文件到系统目录（systemd unit 等的部署动作）：sudo install 落盘并设权限属主，等价 sudo install -m <mode> -o <owner> -g <group> <filePath> <installPath>。需 NOPASSWD。",
        title: "Install File",
        category: "远端",
        color: "#ff9e64",
        inputs: [
            { id: "ssh", type: "ssh", required: true },
            { id: "filePath", type: "string", required: true },
            { id: "installPath", type: "string", required: true },
        ],
        outputs: [],
        widgets: [
            { key: "mode", label: "权限（install -m）", kind: "string", serializable: true, default: "644" },
            { key: "owner", label: "属主（install -o）", kind: "string", serializable: true, default: "root" },
            { key: "group", label: "属组（install -g）", kind: "string", serializable: true, default: "root" },
        ],
        async run(ctx, node, inputs) {
            const file = String(inputs.filePath ?? "").trim();
            if (!file) throw new Error("remote.install 未连接 filePath");
            const dir = String(inputs.installPath ?? "").trim();
            if (!dir) throw new Error("remote.install 未连接 installPath");
            const mode = String(node.data.mode ?? "").trim() || "644";
            const owner = String(node.data.owner ?? "").trim() || "root";
            const group = String(node.data.group ?? "").trim() || "root";
            const cmdStr = `install -m ${sq(mode)} -o ${sq(owner)} -g ${sq(group)} ${sq(file)} ${sq(dir)}`;
            await runRemote(ctx, node, inputs.ssh, cmdStr, "install");
        },
    },
];
