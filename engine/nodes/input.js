/**
 * 输入类节点：字符串输入 / struct 构造与析构。
 * 机密模型：workflow JSON 本身即机密文件——env 字段以 struct 字段直接定义在图里，
 * 哪个字段被哪个节点消费由连线一目了然。
 * 路径即字符串：不存在独立的路径插槽类型（远端路径在运行前无法探知状态，类型化无意义）。
 */

export default [
    {
        type: "string.const",
        title: "Input String",
        category: "输入",
        color: "#c8d3f0",
        desc: "输出一个字符串常量：只需要一个 string 时的最干净输入方式（比 Struct 轻量）。",
        inputs: [],
        outputs: [{ id: "value", type: "string" }],
        outputValueKey: "value",
        widgets: [{ key: "value", label: "值", kind: "string", serializable: true, default: "" }],
        async run(ctx, node) {
            return { value: String(node.data.value ?? "") };
        },
    },
    {
        type: "struct.make",
        title: "Make Struct",
        category: "输入",
        color: "#c8d3f0",
        fieldInputs: true,
        desc: "定义带类型的字段集合：每行 key + 类型 + 值；每个字段自动生成同名输入口（连线后手填控件隐藏，删线恢复手填）。输出 struct——哪个字段被哪个节点用了，连线一目了然。",
        inputs: [],
        outputs: [],
        dynamicOutputs: "structMake",
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
        title: "Split Struct",
        category: "输入",
        color: "#c8d3f0",
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
    {
        type: "struct.fromjson",
        title: "Struct From JSON",
        category: "输入",
        color: "#c8d3f0",
        dynamicOutputs: "fromJsonShape",
        desc: "解析一段 JSON 文本为 struct。Shape 逐字段声明 key/类型（同 Make Struct 操作）——出口类型即 struct_N；运行时 JSON 必须是 shape 的子集：允许字段缺失（undefined），多余字段或类型不匹配即任务失败。常与 ssh.exec 连用——远端命令输出 JSON（printf/grep/awk 组装、或 sed 把 python-repr 转成 JSON）。",
        inputs: [{ id: "json", type: "string", required: true }],
        outputs: [],
        widgets: [{ key: "shape", label: "Shape（key / 类型）", kind: "struct", shapeOnly: true, default: [] }],
        async run(ctx, node, inputs) {
            const shape = (node.data?.shape ?? []).filter(f => f.key);
            if (!shape.length) throw new Error("struct.fromjson 未定义 shape（逐字段配置 key/类型，出口类型才能确定）");
            const raw = String(inputs.json ?? "").trim();
            if (!raw) throw new Error("struct.fromjson 未提供 JSON 输入");
            let obj;
            try {
                obj = JSON.parse(raw);
            } catch (e) {
                throw new Error(`struct.fromjson 解析失败: ${e.message}（原文前 120 字符: ${raw.slice(0, 120)}）`);
            }
            if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
                throw new Error("struct.fromjson：JSON 顶层必须是对象");
            }
            // 子集校验：JSON ⊆ shape（缺失字段允许；多余字段/类型不匹配拒绝）——像静态语言一样在入口处把关
            const shapeKeys = new Set(shape.map(f => f.key));
            const jsType = v => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
            for (const [k, v] of Object.entries(obj)) {
                const f = shape.find(s => s.key === k);
                if (!f) throw new Error(`struct.fromjson：多余字段 "${k}"（不在 shape 中）: ${JSON.stringify(v)?.slice(0, 60)}`);
                const actual = jsType(v);
                if (actual !== f.type) {
                    throw new Error(`struct.fromjson：字段 "${k}" 类型不匹配（期望 ${f.type}，实际 ${actual}）`);
                }
            }
            ctx.markNodeOutput?.(node.id, JSON.stringify(obj));
            ctx.log(`[struct.fromjson] ${Object.keys(obj).join(", ")}`);
            return { struct: obj };
        },
    },
];
