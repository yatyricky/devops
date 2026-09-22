import fs from "fs";
import path from "path";
import { create, list } from "tar";
import { rmrf } from "./exec.js";

/**
 * 打包 tgz：在 sourceDir 下按 entries（相对路径）建包。
 * @param {string} sourceDir
 * @param {string[]} entries
 * @param {string} outPath
 * @returns {Promise<void>}
 */
export function compress(sourceDir, entries, outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    return create({ gzip: true, file: outPath, cwd: sourceDir, portable: true }, entries);
}

/**
 * 列出 tgz 内容（dry-run 校验用）。
 * @param {string} archivePath
 * @returns {Promise<string[]>}
 */
export async function listArchive(archivePath) {
    /** @type {string[]} */
    const entries = [];
    await list({ file: archivePath, onReadEntry: e => entries.push(e.path) });
    return entries;
}

/**
 * 建一个一次性暂存目录（部署源 staging），返回路径。调用方负责 rmrf。
 * @param {string} root 暂存根目录（本工具的 .tmp/）
 * @param {string} name
 */
export function makeStageDir(root, name) {
    const dir = path.join(root, name);
    rmrf(dir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
