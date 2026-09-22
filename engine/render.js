import fs from "fs";
import path from "path";

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
