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
    const ssh = new NodeSSH();
    await ssh.connect({
        host,
        username: user,
        ...(opts.port ? { port: opts.port } : {}),
        ...(agent ? { agent } : {}),
        ...(opts.keyFile ? { privateKeyPath: opts.keyFile, passphrase: opts.passphrase } : {}),
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
    });
    return ssh;
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
 * 执行远端命令，非零退出码抛错。
 * @param {NodeSSH} ssh
 * @param {string} cmd
 * @param {{ log?: (msg: string) => void }} [opts]
 */
export async function sshExec(ssh, cmd, opts = {}) {
    const r = await sshRun(ssh, cmd, opts);
    if (r.code !== 0) {
        throw new Error(`remote command failed (code=${r.code}): ${cmd}\n${r.err}`);
    }
    return r;
}

// `sudo -n` 绝不交互要密码，NOPASSWD 缺失时快速失败。
/**
 * @param {NodeSSH} ssh
 * @param {string} cmd
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {Promise<SshExecResult>}
 */
export function sshSudo(ssh, cmd, opts = {}) {
    return sshRun(ssh, `sudo -n ${cmd}`, opts);
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
    ssh?.dispose();
}
