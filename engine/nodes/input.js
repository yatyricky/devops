import fs from "fs";
import path from "path";
import { expandHome } from "../exec.js";
import { loadEnv, rawParse } from "../env.js";
import { ROOT, ENVS_DIR } from "../runner.js";

/**
 * 输入类节点：env 文件 / params / 运行时任务输入。
 */

export default [
    {
        type: "env.file",
        title: "Env 文件",
        category: "输入",
        color: "#4da3ff",
        inputs: [],
        outputs: [{ id: "env", type: "env" }],
        widgets: [
            { key: "envFile", label: "env 文件", kind: "string", default: "", placeholder: "kids-ledger.env（相对 envs/ 或绝对路径）" },
            { key: "schema", label: "schema（键=样例值，值类型=样例类型）", kind: "kv", default: {} },
        ],
        /**
         * @param {any} ctx
         * @param {any} node
         */
        async run(ctx, node) {
            const envFile = node.data.envFile;
            if (!envFile) throw new Error("env.file 未配置 envFile");
            const fp = path.isAbsolute(envFile) ? envFile : path.join(ENVS_DIR, envFile);
            const schema = node.data.schema && Object.keys(node.data.schema).length
                ? node.data.schema
                : Object.fromEntries(Object.keys(rawParseSafe(fp)).map(k => [k, ""]));
            const env = loadEnv(fp, schema);
            ctx.log(`[env] ${path.basename(fp)}：${Object.keys(env).length} 键（schema ${Object.keys(schema).length}）`);
            return { env };
        },
    },
    {
        type: "params",
        title: "Params",
        category: "输入",
        color: "#8a97a8",
        inputs: [],
        outputs: [{ id: "params", type: "any" }],
        widgets: [{ key: "values", label: "参数表", kind: "kv", default: {} }],
        async run(ctx, node) {
            const values = node.data.values ?? {};
            ctx.log(`[params] ${Object.keys(values).length} 项`);
            return { params: values };
        },
    },
    {
        type: "task.input",
        title: "任务输入",
        category: "输入",
        color: "#e5c07b",
        inputs: [],
        outputs: [{ id: "value", type: "string" }],
        widgets: [
            { key: "name", label: "参数名", kind: "string", default: "", placeholder: "如 ref / release" },
            { key: "label", label: "提示文案", kind: "string", default: "" },
            { key: "fallback", label: "默认值", kind: "string", default: "" },
        ],
        async run(ctx, node) {
            const name = node.data.name;
            if (!name) throw new Error("task.input 未配置参数名");
            const v = ctx.inputs?.[name] ?? node.data.fallback ?? "";
            if (v === "") ctx.log(`[input] ${name} 未提供，使用空值`);
            else ctx.log(`[input] ${name} = ${v}`);
            return { value: String(v) };
        },
    },
    {
        type: "fs.path",
        title: "输入路径",
        category: "输入",
        color: "#56b6c2",
        pathStat: true,
        outputValueKey: "path",
        inputs: [],
        outputs: [
            { id: "dir", type: "folder" },
            { id: "file", type: "file" },
        ],
        widgets: [{ key: "path", label: "路径", kind: "string", serializable: true, default: "", placeholder: "C:/... 或 ~/...（~ = 用户目录）" }],
        async run(ctx, node) {
            const typed = String(node.data.path ?? "").trim();
            if (!typed) throw new Error("fs.path 未配置路径");
            // 输出 resolve 后的完整绝对路径（~ 展开 + 分隔符/.. 归一），下游节点直接可用
            const full = path.resolve(expandHome(typed));
            /** @type {import("fs").Stats} */
            let st;
            try { st = await fs.promises.stat(full); } catch { throw new Error(`fs.path 路径不存在: ${full}`); }
            const isDir = st.isDirectory();
            ctx.log(`[fs.path] ${typed} → ${full}（${isDir ? "文件夹" : "文件"}，${st.size} B）`);
            // 双插槽：只有与实际类型匹配的输出有值，另一个为 undefined
            return { dir: isDir ? full : undefined, file: isDir ? undefined : full };
        },
    },
];

/** @param {string} fp */
function rawParseSafe(fp) {
    try { return rawParse(fp); } catch { return {}; }
}
