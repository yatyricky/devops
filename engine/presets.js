import { deployBaseSchema } from "./workflow.js";

/**
 * 工作流预设：按表单字段生成完整的工作流 JSON（GUI「新建工作流」用）。
 *
 * SPA 远端布局（静态站，无 systemd 服务）：
 *   $DEPLOY_DIR/releases/<releaseName>/   不可变 release 目录（dist 内容）
 *   $DEPLOY_DIR/current → releases/<x>    nginx root 指向这里
 * 模板类配置（nginx/frp 等）放应用仓库里做版本管理，用 template.push 步骤推送。
 */

/**
 * @param {{
 *   name: string,
 *   title?: string,
 *   repoDir: string,
 *   envFile?: string,
 *   installCommand?: string,
 *   buildCommand?: string,
 *   distDir?: string,
 *   envPairs?: Record<string, string>,
 *   nginxTemplate?: string,
 * }} fields
 * @returns {{ json: any, envExample: string }}
 */
export function buildSpaPreset(fields) {
    const name = String(fields.name || "").trim();
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid app name: "${name}"（只允许字母数字 . _ -）`);
    const repoDir = String(fields.repoDir || "").trim();
    if (!repoDir) throw new Error("repoDir required");
    const distDir = String(fields.distDir || "dist").replace(/^\/+/, "").replace(/\/+$/, "") || "dist";
    const installCommand = String(fields.installCommand || "pnpm install --frozen-lockfile").trim();
    const buildCommand = String(fields.buildCommand || "pnpm build").trim();
    const envFile = String(fields.envFile || `${name}.env`).trim();
    const envPairs = fields.envPairs && typeof fields.envPairs === "object" ? fields.envPairs : {};
    const nginxTemplate = String(fields.nginxTemplate || "").trim();

    /** @type {any} */
    const json = {
        name,
        title: String(fields.title || "").trim() || name,
        description: "SPA 静态站点（配置驱动工作流）",
        repoDir,
        envFile,
        params: { installCommand, buildCommand, distDir },
        envSchema: {
            ...deployBaseSchema,
            ...(nginxTemplate ? { DOMAIN: "www.example.com" } : {}),
        },
        workflows: {
            deploy: {
                steps: [
                    { type: "git.checkout", ref: "{{ref}}" },
                    { type: "env.write", file: ".env", pairs: { VITE_VERSION: "{{versionId}}", ...envPairs } },
                    { type: "shell", command: "{{installCommand}}", title: "安装依赖" },
                    { type: "shell", command: "{{buildCommand}}", title: "构建" },
                    { type: "archive", source: "{{repoDir}}/{{distDir}}" },
                    { type: "remote", command: "mkdir -p {{DEPLOY_DIR}}/build" },
                    { type: "upload", from: "{{archivePath}}", to: "{{DEPLOY_DIR}}/build/{{archiveName}}" },
                    { type: "remote", command: "mkdir -p {{DEPLOY_DIR}}/releases/{{releaseName}} && tar -xzf {{DEPLOY_DIR}}/build/{{archiveName}} -C {{DEPLOY_DIR}}/releases/{{releaseName}} && rm {{DEPLOY_DIR}}/build/{{archiveName}}" },
                    { type: "remote", command: "ln -sfn {{DEPLOY_DIR}}/releases/{{releaseName}} {{DEPLOY_DIR}}/current" },
                    { type: "remote", command: "nginx -t && systemctl reload nginx", sudo: true },
                ],
            },
            rollback: {
                steps: [
                    { type: "remote", command: "test -d {{DEPLOY_DIR}}/releases/{{release}} || { echo 'release not found: {{release}}'; exit 1; }" },
                    { type: "remote", command: "ln -sfn {{DEPLOY_DIR}}/releases/{{release}} {{DEPLOY_DIR}}/current" },
                    { type: "remote", command: "nginx -t && systemctl reload nginx", sudo: true },
                ],
            },

            status: {
                mutates: false,
                steps: [
                    { type: "remote", command: "readlink -f {{DEPLOY_DIR}}/current || true" },
                    { type: "remote", command: "ls -1t {{DEPLOY_DIR}}/releases 2>/dev/null | head -8" },
                    { type: "remote", command: "df -h {{DEPLOY_DIR}} | tail -1" },
                ],
            },
        },
    };

    if (nginxTemplate) {
        json.workflows["nginx-config"] = {
            steps: [
                { type: "template.push", template: nginxTemplate, to: "{{DEPLOY_DIR}}/nginx-site.conf" },
                { type: "remote", sudo: true, command: `install -m 644 {{DEPLOY_DIR}}/nginx-site.conf /etc/nginx/sites-available/{{app}} && ln -sf /etc/nginx/sites-available/{{app}} /etc/nginx/sites-enabled/{{app}} && nginx -t && systemctl reload nginx` },
            ],
        };
    }

    const envKeys = Object.keys(json.envSchema);
    const envExample = [
        `# ${envFile} — 值为类型样例，按实际服务器填写`,
        ...envKeys.map(k => `${k}=${json.envSchema[k]}`),
    ].join("\n");

    return { json, envExample };
}

/**
 * 空白预设：只填应用标识，deploy 给最小可跑骨架（checkout + 示例命令），
 * 其余步骤在「编辑工作流」里用原子能力自己组装。
 * @param {{ name: string, title?: string, repoDir: string, envFile?: string }} fields
 * @returns {{ json: any, envExample: string }}
 */
export function buildBlankPreset(fields) {
    const name = String(fields.name || "").trim();
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`invalid app name: "${name}"（只允许字母数字 . _ -）`);
    const repoDir = String(fields.repoDir || "").trim();
    if (!repoDir) throw new Error("repoDir required");
    const envFile = String(fields.envFile || `${name}.env`).trim();

    /** @type {any} */
    const json = {
        name,
        title: String(fields.title || "").trim() || name,
        description: "空白工作流（步骤自行组装）",
        repoDir,
        envFile,
        params: {},
        envSchema: { ...deployBaseSchema },
        workflows: {
            deploy: {
                steps: [
                    { type: "log", message: "TODO：在这里组装部署步骤（＋ 添加步骤）" },
                    { type: "git.checkout", ref: "{{ref}}" },
                    { type: "shell", command: "echo replace me", title: "示例步骤" },
                ],
            },
            status: {
                mutates: false,
                steps: [{ type: "log", message: "TODO：状态检查步骤" }],
            },
        },
    };

    const envKeys = Object.keys(json.envSchema);
    const envExample = [
        `# ${envFile} — 值为类型样例，按实际服务器填写`,
        ...envKeys.map(k => `${k}=${json.envSchema[k]}`),
    ].join("\n");

    return { json, envExample };
}
