/** 与 engine/types.js 同规则的客户端镜像 + 动态插槽计算。 */

export const TYPE_COLORS = {
  env: "#4da3ff", ssh: "#ff9e64", file: "#4cc38a", folder: "#56b6c2", string: "#c8d3f0",
  number: "#e5c07b", boolean: "#c678dd", any: "#8a97a8",
};

/** @param {string} from @param {string} to */
export function canConnect(from, to) {
  if (from === to) return true;
  return to === "any";
}

/**
 * 节点有效输入 = 声明 + 动态（{{name}} → string 插槽；{{obj.key}} → any 插槽）。
 * @param {any} meta node-types 注册表条目
 * @param {any} data 节点 data
 */
export function effectiveInputs(meta, data) {
  const declared = (meta?.inputs ?? []).map(i => ({ ...i, dynamic: false }));
  if (!meta?.dynamicInputs) return declared;
  const text = String(data?.[meta.dynamicInputs.source] ?? "");
  /** @type {Map<string,string>} */
  const dyn = new Map();
  for (const m of text.matchAll(/\{\{(\w+)(?:\.(\w+))?\}\}/g)) {
    dyn.set(m[1], m[2] ? "any" : meta.dynamicInputs.type);
  }
  const dynamic = [...dyn.entries()]
    .filter(([id]) => !declared.some(i => i.id === id))
    .map(([id, type]) => ({ id, type, required: true, dynamic: true }));
  return [...declared, ...dynamic];
}

let seq = 0;
/** @param {string} prefix */
export function genId(prefix = "n") {
  seq += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${seq}`;
}
