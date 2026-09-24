import fs from "fs";
import path from "path";
import { expandHome } from "../exec.js";

/**
 * 输入类节点：任务输入 / 路径 / struct 构造与析构。
 * 机密模型（2026-09-24）：workflow JSON 本身即机密文件——env 字段以 struct 字段直接定义在图里，
 * 哪个字段被哪个节点消费由连线一目了然。
 */

export default [
    {
        type: "task.input",
        title: "任务输入",
        category: "输入",
        color: "#e5c07b",
        desc: "声明一个运行时输入：运行弹窗或 CLI --input 提供值，未提供时用默认值兜底。",
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
        dynamicOutputs: "fsPath",
        outputValueKey: "path",
        desc: "指向本机文件或文件夹（支持 ~/ 开头）。出口随实际类型自动变化：合法文件夹 → folder，合法文件 → file，未配置/非法 → 无出口；连线随出口消失自动断开。",
        inputs: [],
        outputs: [],
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
    {
        type: "struct.make",
        title: "Struct 构造器",
        category: "输入",
        color: "#4da3ff",
        fieldInputs: true,
        desc: "定义带类型的字段集合：每行 key + 类型 + 值；每个字段自动生成同名输入口（连线后手填控件隐藏，删线恢复手填）。输出 struct——哪个字段被哪个节点用了，连线一目了然。",
        inputs: [],
        outputs: [{ id: "struct", type: "struct" }],
        widgets: [{ key: "fields", label: "字段（key / 类型 / 值）", kind: "struct", serializable: true, default: [] }],
        async run(ctx, node, inputs) {
            const fields = node.data.fields ?? [];
            if (!fields.length) throw new Error("struct.make 未定义字段");
            /** @type {Record<string, any>} */
            const out = {};
            for (const f of fields) {
                let v = inputs[f.key] ?? f.value ?? "";
                if (f.type === "number") {
                    const n = Number(v);
                    if (String(v ?? "").trim() === "" || Number.isNaN(n)) throw new Error(`字段 ${f.key} 不是有效数字: ${v}`);
                    v = n;
                } else if (f.type === "boolean") {
                    v = v === true || v === "true";
                } else {
                    v = String(v);
                }
                out[f.key] = v;
            }
            ctx.log(`[struct.make] ${fields.map(f => `${f.key}:${f.type}`).join(", ")}`);
            return { struct: out };
        },
    },
    {
        type: "struct.split",
        title: "Struct 析构器",
        category: "输入",
        color: "#4da3ff",
        dynamicOutputs: "structSplit",
        desc: "接入一个 struct，按上游构造器的字段定义自动生成同名同型的输出口，把字段分发给下游；未接线时无出口。",
        inputs: [{ id: "struct", type: "struct", required: true }],
        outputs: [],
        widgets: [],
        async run(ctx, node, inputs) {
            const obj = inputs.struct;
            if (!obj || typeof obj !== "object") throw new Error("struct.split 未接入 struct");
            ctx.log(`[struct.split] ${Object.keys(obj).join(", ")}`);
            return { ...obj };
        },
    },
];
