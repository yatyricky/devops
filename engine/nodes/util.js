import path from "path";
import { expandHome } from "../exec.js";

/**
 * 工具节点：路径拼接、取字段、字符串拼接（动态插槽）、打印预览。
 */

export default [
    {
        type: "path.resolve",
        title: "Path Resolve",
        outputInfer: true,
        category: "工具",
        color: "#56b6c2",
        countInputs: { key: "count", prefix: "p", type: "string", min: 1, max: 16 },
        desc: "把 N 段路径按目标风格拼成完整路径：首段可以是 ~ / 盘符 / 绝对路径，后续为相对段；若后续段是绝对路径则以该段为基准。style 决定输出分隔符（windows → 反斜杠；posix → 正斜杠；auto = 拼接结果首段带盘符则 windows，否则 posix）。",
        inputs: [],
        outputs: [{ id: "value", type: "string" }],
        widgets: [
            { key: "count", label: "路径段数（1-16）", kind: "number", serializable: true, default: 2 },
            { key: "style", label: "路径风格", kind: "enum", options: ["posix", "windows", "auto"], default: "auto", serializable: true },
        ],
        async run(ctx, node, inputs) {
            const count = node.data.count ?? 2;
            const style = ["posix", "windows", "auto"].includes(node.data.style) ? node.data.style : "posix";
            const norm = (v) => expandHome(v).replace(/\\/g, "/");
            const segs = [];
            for (let i = 1; i <= count; i++) {
                const v = String(inputs[`p${i}`] ?? "").trim();
                if (!v) throw new Error(`path.resolve：路径段 p${i} 为空`);
                segs.push(norm(v));
            }
            // 拼接语义：某段为绝对基准（/ 开头，或 Windows 盘符 X:/）→ 重置为该段；否则接在前段之后。
            const isAbsBase = (seg) => seg.startsWith("/") || /^[A-Za-z]:\//.test(seg);
            let full = "";
            for (const seg of segs) {
                full = (!full || isAbsBase(seg)) ? seg : `${full.replace(/\/+$/, "")}/${seg}`;
            }
            const value = full || "/";
            // 风格化输出：windows → 反斜杠；auto → 拼接结果首段带盘符（如 C:/）则 windows 风格，否则 posix
            let out = value;
            if (style === "windows") out = value.replace(/\//g, "\\");
            else if (style === "auto" && /^[A-Za-z]:\//.test(value)) out = value.replace(/\//g, "\\");
            ctx.log(`[path.resolve] ${segs.join(" + ")} → ${out}`);
            return { value: out };
        },
    },
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
        type: "path.basename",
        title: "取文件名",
        category: "工具",
        color: "#56b6c2",
        desc: "取路径的最后一段（文件名）及其去扩展名形式：path/to/file.mp4 → basename=file.mp4，basenameWithoutExtension=file。兼容 / 与 \\ 分隔符；输出 string。",
        inputs: [{ id: "path", type: "string", required: true }],
        outputs: [
            { id: "basename", type: "string" },
            { id: "basenameWithoutExtension", type: "string" },
        ],
        widgets: [],
        async run(ctx, node, inputs) {
            const p = String(inputs.path ?? "").trim().replace(/\\/g, "/");
            if (!p) throw new Error("path.basename 未连接路径");
            const value = p.slice(p.lastIndexOf("/") + 1);
            if (!value) throw new Error(`path.basename 无法从路径取文件名: ${p}`);
            const dot = value.lastIndexOf(".");
            const stem = dot > 0 ? value.slice(0, dot) : value;
            ctx.log(`[path.basename] ${p} → ${value}`);
            return { basename: value, basenameWithoutExtension: stem };
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
        color: "#56b6c2",
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
