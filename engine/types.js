/**
 * 插槽类型系统：连线即数据通道，类型不匹配在加载/编辑时即被拒绝。
 * 规则：同型可连；任何类型可入 any 输入（env/params → template.render 的 vars 等）；
 * any 输出不可入具体类型输入（取具体值用 field.get）。
 */
export const SOCKET_TYPES = ["env", "ssh", "file", "string", "number", "boolean", "any"];

/** 插槽类型的显示色（前端同款映射，经 /api/node-types 下发）。 */
export const TYPE_COLORS = {
    env: "#4da3ff",
    ssh: "#ff9e64",
    file: "#4cc38a",
    string: "#c8d3f0",
    number: "#e5c07b",
    boolean: "#c678dd",
    any: "#8a97a8",
};

/**
 * 源类型能否接入目标输入。
 * @param {string} fromType
 * @param {string} toType
 */
export function canConnect(fromType, toType) {
    if (!SOCKET_TYPES.includes(fromType) || !SOCKET_TYPES.includes(toType)) return false;
    if (fromType === toType) return true;
    return toType === "any";
}

/**
 * 运行时把值矫正为输入声明类型（file 在运行期就是路径字符串；number/boolean 宽容转换）。
 * @param {any} value
 * @param {string} type
 */
export function coerce(value, type) {
    if (value === undefined || value === null) return value;
    switch (type) {
        case "string": case "file": return String(value);
        case "number": return Number(value);
        case "boolean": return typeof value === "string" ? value === "true" : !!value;
        default: return value; // env / ssh / any
    }
}
