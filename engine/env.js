import fs from "fs";
import path from "path";
import dotenv from "dotenv";

/**
 * 解析 .env 文件为原始字符串 map（不做 schema 校验，用于预读判断）。
 * @param {string} envFilePath
 * @returns {Record<string, string>}
 */
export function rawParse(envFilePath) {
    return dotenv.parse(fs.readFileSync(envFilePath, "utf8"));
}

/**
 * 按 schema 加载并校验 env 文件。
 * schema 的值即类型样例：string | number | boolean。所有键必须存在且类型合法。
 * 多余的键会被丢弃（只暴露 schema 内的键，避免误用）。
 * @param {string} envFilePath
 * @param {Record<string, string | number | boolean>} schema
 * @returns {Record<string, any>}
 */
export function loadEnv(envFilePath, schema) {
    if (!fs.existsSync(envFilePath)) {
        throw new Error(`env file not found: ${envFilePath}`);
    }
    const parsed = rawParse(envFilePath);

    const missing = Object.keys(schema).filter(k => !(k in parsed));
    if (missing.length) throw new Error(`Missing env keys: ${missing.join(", ")}`);

    /** @type {string[]} */
    const bad = [];
    /** @type {Record<string, any>} */
    const env = {};
    for (const k of Object.keys(schema)) {
        const v = parsed[k];
        const example = schema[k];
        /** @type {any} */
        let value = v;
        if (typeof example === "number") {
            value = Number(v);
            if (isNaN(value)) {
                bad.push(`invalid number for env ${k}: ${v}`);
                continue;
            }
        } else if (typeof example === "boolean") {
            value = v === "true";
        } else if (typeof example === "string") {
            value = v;
        } else {
            bad.push(`unsupported env type for ${k}: ${typeof example}`);
            continue;
        }
        env[k] = value;
    }

    if (bad.length) throw new Error(`invalid env values:\n  ${bad.join("\n  ")}`);

    const fpResolved = path.resolve(envFilePath);
    console.log(`[env] loaded ${Object.keys(env).length} keys from ${fpResolved}`);
    return env;
}

/**
 * 把 env 子集写成 KEY=VALUE 文本（生成应用运行时 .env 用）。
 * @param {Record<string, any>} env
 * @param {string[]} keys
 * @param {Record<string, any>} [extra] 追加键（如 VERSION），跟在 keys 之后
 */
export function pickEnvFileContent(env, keys, extra = {}) {
    const lines = keys.map(k => `${k}=${env[k] ?? ""}`);
    for (const [k, v] of Object.entries(extra)) lines.push(`${k}=${v}`);
    return lines.join("\n") + "\n";
}
