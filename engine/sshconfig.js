import fs from "fs";
import os from "os";
import path from "path";

/**
 * ~/.ssh/config 解析器（够用即可，不加依赖）：
 * 支持 Host 块的 HostName/User/Port/IdentityFile（多 IdentityFile 取第一个存在的），
 * Host 多模式空格分隔、大小写不敏感匹配（OpenSSH 语义）。
 * 明确不支持：Include / Match / ProxyJump / ProxyCommand——命中别名依赖这些指令时报错而非错连。
 */

/** @param {string} p */
export function expandHome(p) {
    if (!p) return p;
    if (p === "~") return os.homedir();
    if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
    return p;
}

/** @returns {string} config 文件路径 */
export function sshConfigPath() {
    return path.join(os.homedir(), ".ssh", "config");
}

/**
 * 解析 config，返回 别名 → 配置 的 Map（键小写，保持文件出现顺序）。
 * @param {string} [fp] config 文件路径（默认 ~/.ssh/config；测试可注入）
 * @returns {Map<string, {host: string, user?: string, port?: number, identityFile?: string, unsupported?: string[]}>}
 */
export function parseConfig(fp = sshConfigPath()) {
    /** @type {Map<string, any>} */
    const out = new Map();
    if (!fs.existsSync(fp)) return out;
    const lines = fs.readFileSync(fp, "utf8").split(/\r?\n/);
    /** @type {{patterns: string[], opts: Record<string, string> , unsupported: string[]} | null} */
    let cur = null;
    /** @type {{patterns: string[], opts: Record<string, string> , unsupported: string[]}[]} */
    const blocks = [];
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.match(/^(Host|Match|Include)\s+(.+)$/i);
        if (eq) {
            const kw = eq[1].toLowerCase();
            if (kw === "host") {
                cur = { patterns: eq[2].split(/\s+/).filter(Boolean), opts: {}, unsupported: [] };
                blocks.push(cur);
            } else {
                // Match/Include 块整块跳过（含其缩进行——非 Host 开头的行会被丢弃）
                cur = null;
            }
            continue;
        }
        if (!cur) continue;
        const m = line.match(/^(\S+)\s+(.+)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        if (key === "hostname") cur.opts.hostname = val;
        else if (key === "user") cur.opts.user = val;
        else if (key === "port") cur.opts.port = val;
        else if (key === "identityfile") (cur.opts.identityFile ??= val);
        else if (["match", "include", "proxyjump", "proxycommand", "proxyusefdpass"].includes(key)) cur.unsupported.push(m[1]);
    }
    for (const b of blocks) {
        for (const pat of b.patterns) {
            if (pat.startsWith("!")) continue; // 排除模式不参与正向匹配
            const lower = pat.toLowerCase();
            const entry = {
                host: b.opts.hostname ?? pat,
                // OpenSSH：每个参数取首个获得的值——前块显式设置过的 HostName 优先，
                // 前块未设置才轮到后块（user/port/identityFile 同理由 ?? 保证）
                hostSet: b.opts.hostname !== undefined,
                user: b.opts.user,
                port: b.opts.port ? Number(b.opts.port) : undefined,
                identityFile: b.opts.identityFile ? expandHome(b.opts.identityFile) : undefined,
                unsupported: b.unsupported,
            };
            const prev = out.get(lower);
            out.set(lower, prev ? {
                host: prev.hostSet ? prev.host : entry.host,
                hostSet: prev.hostSet || entry.hostSet,
                user: prev.user ?? entry.user,
                port: prev.port ?? entry.port,
                identityFile: prev.identityFile ?? entry.identityFile,
                unsupported: [...new Set([...(prev.unsupported ?? []), ...(entry.unsupported ?? [])])],
            } : entry);
        }
    }
    return out;
}

/**
 * @param {string} [fp] config 文件路径（默认 ~/.ssh/config）
 * @returns {string[]} 可用别名（按 config 中首次出现顺序，小写）
 */
export function listAliases(fp = sshConfigPath()) {
    return [...parseConfig(fp).keys()];
}

/**
 * ssh <alias> 语义：config 命中 → 取 HostName/User/Port/IdentityFile；
 * 未命中 → 回退为主机名直连 + 本机用户名（与 OpenSSH 一致）。
 * @param {string} alias
 * @returns {{ host: string, user: string, port: number, identityFile?: string, fromConfig: boolean, unsupported: string[] }}
 */
export function resolveAlias(alias) {
    const a = String(alias ?? "").trim();
    if (!a) throw new Error("ssh 别名为空（在卡片上选择或输入别名）");
    const entry = parseConfig().get(a.toLowerCase());
    if (entry) {
        if (entry.unsupported?.length) {
            throw new Error(`别名 ${a} 依赖暂不支持的 ssh config 指令：${entry.unsupported.join(", ")}（请改用 hosts 直连或在 config 中简化该块）`);
        }
        return {
            host: entry.host,
            user: entry.user || os.userInfo().username,
            port: entry.port ?? 22,
            identityFile: entry.identityFile,
            fromConfig: true,
            unsupported: [],
        };
    }
    return {
        host: a,
        user: os.userInfo().username,
        port: 22,
        identityFile: undefined,
        fromConfig: false,
        unsupported: [],
    };
}
