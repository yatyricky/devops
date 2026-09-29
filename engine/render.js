import fs from "fs";
import path from "path";

/**
 * 模板路径三分支（index.js /api/template/vars 与 template.render 节点共用）：
 * "./x" 相对 configDir（工作流文件所在目录）；绝对路径直用；其余相对 repoDir（应用仓库，模板随仓库版本管理）。
 * @param {string} t 模板路径输入
 * @param {string | undefined} configDir
 * @param {string | undefined} repoDir
 */
export function resolveTemplatePath(t, configDir, repoDir) {
    return t.startsWith("./")
        ? path.join(configDir ?? ".", t.slice(2))
        : path.isAbsolute(t) ? t : path.join(repoDir ?? ".", t);
}

/**
 * 渲染 {{KEY}} 模板（与 xlgbis devops 模板语法一致）。
 * 未解析的变量直接报错并列出，防止把占位符部署到服务器。
 * @param {string} content
 * @param {Record<string, any>} vars
 * @param {string} sourceName
 * @returns {string}
 */
export function renderTemplate(content, vars, sourceName) {
    /** @type {Set<string>} */
    const unresolved = new Set();
    const rendered = content.replace(/\{\{(\w+)\}\}/g, (_, k) => {
        if (k in vars && vars[k] !== undefined && vars[k] !== null) return String(vars[k]);
        unresolved.add(k);
        return `{{${k}}}`;
    });
    if (unresolved.size) {
        throw new Error(`unresolved template vars in ${sourceName}: ${[...unresolved].join(", ")}`);
    }
    return rendered;
}

/**
 * 读取模板文件并渲染。
 * @param {string} templatePath
 * @param {Record<string, any>} vars
 * @returns {string}
 */
export function renderTemplateFile(templatePath, vars) {
    const name = path.basename(templatePath);
    return renderTemplate(fs.readFileSync(templatePath, "utf8"), vars, name);
}
