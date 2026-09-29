import { NodeSSH } from "node-ssh";
import crypto from "crypto";
import path from "path";

/**
 * SSH 连接（移植自 xlgbis packages/common/src/ssh.js）：
 * - Windows 默认走 openssh agent 命名管管道；设置了 SSH_AUTH_SOCK 则优先（含 Linux）。
 * - SHA256 主机指纹锁定，timingSafeEqual 比较，不匹配即拒绝连接。
 * - 可选 REMOTE_KEY_FILE / REMOTE_PASSPHRASE 走私钥认证（agent 不可用时的回退）。
 *
 * @typedef {Object} SshExecResult
 * @property {number} code
 * @property {string} out
 * @property {string} err
 */

/**
 * 认证尝试级联（纯函数，可单测）：
 * - agent 可用：① 仅 agent（不传 privateKeyPath——口令保护的私钥文件会让 ssh2 在认证前解析报错，
 *   阻断 agent 认证）→ 失败且存在 keyFile 时 ② agent + keyFile 回退（覆盖 agent 未加载该密钥但密钥无口令的情况）；
 * - 无 agent：仅 keyFile。
 * @param {string | undefined} agent
 * @param {{ privateKeyPath?: string, passphrase?: string }} keyOpts
 * @returns {Record<string, any>[]} 每次尝试的 auth 附加参数
 */
export function buildAuthAttempts(agent, keyOpts) {
    /** @type {Record<string, any>[]} */
    const attempts = [];
    if (agent) attempts.push({ agent });
    if (agent && keyOpts.privateKeyPath) attempts.push({ agent, ...keyOpts });
    if (!agent) attempts.push({ ...keyOpts });
    return attempts;
}

/**
 * @param {string} host
 * @param {string} user
 * @param {string} fingerprint SHA256 指纹（hex 或 base64）。空串 = 未锁定（仅日志提示，不阻断——用于首次取指纹）。
 * @param {{ log?: (msg: string) => void, keyFile?: string, passphrase?: string, port?: number }} [opts]
 * @returns {Promise<NodeSSH>}
 */
export async function sshConnect(host, user, fingerprint, opts = {}) {
    const log = opts.log ?? (() => {});
    const agent = process.env.SSH_AUTH_SOCK
        || (process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : undefined);
    const keyOpts = opts.keyFile ? { privateKeyPath: opts.keyFile, passphrase: opts.passphrase } : {};
    const base = {
        host,
        username: user,
        ...(opts.port ? { port: opts.port } : {}),
        forceIPv4: true,
        readyTimeout: 30_000,
        algorithms: { serverHostKey: ["ssh-ed25519", "rsa-sha2-512", "rsa-sha2-256", "ecdsa-sha2-nistp256"] },
        hostHash: "sha256",
        /** @param {string} hashedKey */
        hostVerifier: (hashedKey) => {
            const gotHex = String(hashedKey).toLowerCase();
            if (!fingerprint) {
                log(`[WARN] No fingerprint configured for ${host}. Server key SHA256 (base64): ${Buffer.from(gotHex, "hex").toString("base64").replace(/=+$/, "")}`);
                log(`[WARN] 把该值填入 SSH 会话卡片的「指纹」控件以锁定。`);
                return true;
            }
            const expectBuf = /^[0-9a-f]+$/i.test(fingerprint)
                ? Buffer.from(fingerprint, "hex")
                : Buffer.from(fingerprint.replace(/-/g, "+").replace(/_/g, "/") + "==", "base64");
            const gotBuf = Buffer.from(gotHex, "hex");
            if (expectBuf.length !== gotBuf.length || !crypto.timingSafeEqual(expectBuf, gotBuf)) {
                log(`[ERROR] HOST KEY MISMATCH for ${host}!`);
                log(`[ERROR]   expected: ${fingerprint}`);
                log(`[ERROR]   got:      ${gotHex}`);
                return false;
            }
            return true;
        },
    };

    const attempts = buildAuthAttempts(agent, keyOpts);
    /** @type {any} */
    let lastErr;
    for (let i = 0; i < attempts.length; i++) {
        const ssh = new NodeSSH();
        try {
            if (attempts.length > 1) {
                log(`[ssh] 认证尝试 ${i + 1}/${attempts.length}（${attempts[i].agent ? "agent" : "私钥文件"}${attempts[i].privateKeyPath ? "+keyFile" : ""}）`);
            }
            await ssh.connect({ ...base, ...attempts[i] });
            return ssh;
        } catch (e) {
            lastErr = e;
            try { ssh.dispose?.(); } catch { /* 未建立 */ }
            if (i < attempts.length - 1) log(`[ssh] 认证尝试失败（${String(e?.message ?? e).slice(0, 120)}），降级重试`);
        }
    }
    throw lastErr;
}

/**
 * @param {NodeSSH} ssh
 * @param {string} cmd
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<SshExecResult>}
 */
export async function sshRun(ssh, cmd, opts = {}) {
    const log = opts.log ?? (() => {});
    log(`remote$ ${cmd}`);
    const result = await ssh.execCommand(cmd);
    if (result.stdout) log(String(result.stdout).trimEnd());
    if (result.stderr) log(`[remote-err] ${String(result.stderr).trimEnd()}`);
    return {
        code: result.code ?? -1,
        out: result.stdout ?? "",
        err: result.stderr ?? "",
    };
}

/**
 * @param {NodeSSH} ssh
 * @param {string} localPath
 * @param {string} remotePath
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export async function sshPut(ssh, localPath, remotePath, opts = {}) {
    const log = opts.log ?? (() => {});
    log(`upload: ${path.basename(localPath)} → ${remotePath}`);
    await ssh.putFile(localPath, remotePath);
}

/**
 * @param {NodeSSH} ssh
 */
export function sshClose(ssh) {
    // 幂等：显式关闭后任务收尾（finalize）会再次调用；已关闭/无 dispose 时静默
    try { ssh?.dispose?.(); } catch { /* 已关闭 */ }
}
