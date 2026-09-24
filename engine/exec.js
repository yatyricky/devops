import child_process from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * 执行本地命令，输出写入任务日志。cwd 必须显式给出（本工具在多个仓库间操作）。
 * @param {string} command
 * @param {{ cwd?: string, log?: (msg: string) => void }} [opts]
 * @returns {Promise<string>} stdout
 */
export function cmd(command, opts = {}) {
    const log = opts.log ?? (m => console.log(m));
    log(`$ ${command}${opts.cwd ? `  (cwd: ${path.basename(opts.cwd)})` : ""}`);
    return new Promise((resolve, reject) => {
        child_process.exec(command, {
            cwd: opts.cwd,
            maxBuffer: 32 * 1024 * 1024,
            windowsHide: true,
        }, (err, stdout, stderr) => {
            if (stdout) log(String(stdout).trimEnd());
            if (stderr) log(`[stderr] ${String(stderr).trimEnd()}`);
            if (err) return reject(new Error(`Command failed: ${command}\n${err.message}`));
            resolve(typeof stdout === "string" ? stdout : stdout.toString());
        });
    });
}

/**
 * 以 LF 行尾写文本文件（远端 bash 脚本/配置必须 LF，Windows 上默认 CRLF 会炸）。
 * @param {string} fp
 * @param {string} content
 */
export function writeLF(fp, content) {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, String(content).replace(/\r\n/g, "\n"), { encoding: "utf8" });
}

/** @param {string} p */
export function rmrf(p) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 路径开头的 ~ 解析为用户主目录（Windows 如 C:\\Users\\<user>）；其余原样返回。 */
export function expandHome(p) {
    const s = String(p ?? "").trim();
    if (s === "~") return os.homedir();
    if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
    return s;
}

/**
 * 复制目录树，filter 命中（返回 true）的路径保留。用于部署源暂存。
 * @param {string} srcDir
 * @param {string} destDir
 * @param {(relPath: string, isDir: boolean) => boolean} [filter] 基于相对路径判断
 */
export function copyTree(srcDir, destDir, filter) {
    fs.cpSync(srcDir, destDir, {
        recursive: true,
        filter: (/** @type {string} */ fp) => {
            if (!filter) return true;
            const rel = path.relative(srcDir, fp).replace(/\\/g, "/");
            return filter(rel || ".", fs.statSync(fp).isDirectory());
        },
    });
}
