/**
 * 工具节点：取字段、常量、字符串拼接（动态插槽）、打印预览。
 */

export default [
    {
        type: "field.get",
        desc: "从 any 结构里按字段名取值（输出 string）。字段不存在即报错，防静默空值。",
        title: "取字段",
        category: "工具",
        color: "#8a97a8",
        inputs: [{ id: "obj", type: "any", required: true }],
        outputs: [{ id: "value", type: "string" }],
        widgets: [{ key: "key", label: "字段名", kind: "string", default: "" }],
        async run(ctx, node, inputs) {
            const key = node.data.key;
            if (!key) throw new Error("field.get 未配置字段名");
            const v = inputs.obj?.[key];
            if (v === undefined) throw new Error(`字段不存在: ${key}（可用：${Object.keys(inputs.obj ?? {}).join(", ")}）`);
            return { value: String(v) };
        },
    },
    {
        type: "string.const",
        desc: "输出一个常量字符串。",
        title: "常量",
        category: "工具",
        color: "#c8d3f0",
        inputs: [],
        outputs: [{ id: "value", type: "string" }],
        widgets: [{ key: "value", label: "值", kind: "string", default: "" }],
        async run(ctx, node) {
            return { value: String(node.data.value ?? "") };
        },
    },
    {
        type: "string.format",
        desc: "拼接字符串：模板里写 {{name}} 自动生成输入插槽，输出拼接结果。",
        title: "拼接字符串",
        category: "工具",
        color: "#c8d3f0",
        inputs: [],
        outputs: [{ id: "value", type: "string" }],
        widgets: [{ key: "format", label: "模板（{{name}} 生成输入插槽）", kind: "string", default: "" }],
        dynamicInputs: { source: "format", type: "string" },
        async run(ctx, node, inputs) {
            const fmt = String(node.data.format ?? "");
            if (!fmt) throw new Error("string.format 未配置模板");
            const value = fmt.replace(/\{\{(\w+)(?:\.(\w+))?\}\}/g, (_, name, key) => {
                if (inputs[name] === undefined || inputs[name] === null) throw new Error(`模板变量 {{${name}}} 未连线`);
                let v = inputs[name];
                if (key) {
                    v = v?.[key];
                    if (v === undefined) throw new Error(`模板变量 {{${name}.${key}}}：对象里没有键 ${key}`);
                }
                return String(v);
            });
            return { value };
        },
    },
    {
        type: "log.print",
        desc: "把输入值打印到任务日志（预览），不产生副作用。",
        title: "打印预览",
        category: "工具",
        color: "#8a97a8",
        inputs: [{ id: "value", type: "any", required: true }],
        outputs: [],
        widgets: [{ key: "title", label: "标题", kind: "string", default: "" }],
        async run(ctx, node, inputs) {
            const title = node.data.title ? `：${node.data.title}` : "";
            const text = typeof inputs.value === "string" ? inputs.value : JSON.stringify(inputs.value, null, 2);
            ctx.log(`──── 预览${title} ────`);
            for (const line of String(text).split("\n")) ctx.log(`  ${ctx.mask(line)}`);
            ctx.log(`──────────────────`);
        },
    },
];
