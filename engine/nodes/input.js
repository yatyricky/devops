/**
 * 输入类节点：任务输入 / 字符串输入 / struct 构造与析构。
 * 机密模型：workflow JSON 本身即机密文件——env 字段以 struct 字段直接定义在图里，
 * 哪个字段被哪个节点消费由连线一目了然。
 * 路径即字符串：不存在独立的路径插槽类型（远端路径在运行前无法探知状态，类型化无意义）。
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
        type: "string.const",
        title: "输入.字符串",
        category: "输入",
        color: "#c8d3f0",
        desc: "输出一个字符串常量：只需要一个 string 时的最干净输入方式（比 Struct 轻量）。",
        inputs: [],
        outputs: [{ id: "value", type: "string" }],
        widgets: [{ key: "value", label: "值", kind: "string", serializable: true, default: "" }],
        async run(ctx, node) {
            return { value: String(node.data.value ?? "") };
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
