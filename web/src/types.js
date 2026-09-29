/**
 * 前端规则与工具。
 * 共享规则（canConnect/effectiveInputs/effectiveOutputs/validateTaskSelection/isTunnelEdge）
 * 直接从 engine/rules.js import 同一文件——与引擎单源，根治镜像漂移；
 * 本文件只保留前端专用：显示色、id 生成、Group 收起条布局常量。
 */
export { canConnect, SOCKET_TYPES, effectiveInputs, effectiveOutputs, validateTaskSelection, isTunnelEdge } from "devops-console/engine/rules.js";

export const TYPE_COLORS = {
  struct: "#4da3ff", ssh: "#ff9e64", string: "#c8d3f0",
  number: "#e5c07b", boolean: "#c678dd", any: "#8a97a8",
};

let seq = 0;
/** @param {string} prefix */
export function genId(prefix = "n") {
  seq += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${seq}`;
}

/** 端口 label 纯文本（DevNode 卡片 title 提示与 GroupBox 收起条 tunnelLabel 共用同一格式）。 */
export function portLabel(p) {
  return `${p.id} (${p.type}${p.dynamic ? "⭑" : ""})`;
}

/** 节点标题 `<类型 title>[ - 便笺]`（DevNode 头部与 tunnelLabel 共用）。 */
export function nodeTitle(meta, data) {
  const note = String(data?.note ?? "").trim();
  return `${meta?.title ?? data?.__type ?? "?"}${note ? ` - ${note}` : ""}`;
}

/** 路径目录（浏览器端无 path.dirname；兼容 / 与 \）。 */
export function dirOf(x) {
  const i = Math.max(x.lastIndexOf("/"), x.lastIndexOf("\\"));
  return i > 0 ? x.slice(0, i) : x;
}

/** 文件名去扩展名（默认 wf 显示名兜底用）。 */
export function basenameNoExt(fp) {
  return fp.split(/[\\/]/).pop().replace(/\.json$/i, "");
}

// ── Group 收起黑箱条布局常量（App 计算节点高度与 GroupBox 渲染行必须同源）────
export const GROUP_BAR = { header: 36, row: 20, div: 9, pad: 8 };
/** 收起条总高 = 标题行 + 入口数×行高 +（出入口都有时分隔线）+ 出口数×行高 + 页脚 padding */
export function groupBarHeight(nIn, nOut) {
  return GROUP_BAR.header + nIn * GROUP_BAR.row + (nIn && nOut ? GROUP_BAR.div : 0) + nOut * GROUP_BAR.row + GROUP_BAR.pad;
}
/** 收起条内第 i 行 label 的 top；side = "in" | "out"，入口在标题下、分隔线后是出口 */
export function groupBarRowTop(side, i, nIn) {
  return side === "in"
    ? GROUP_BAR.header + i * GROUP_BAR.row
    : GROUP_BAR.header + nIn * GROUP_BAR.row + (nIn ? GROUP_BAR.div : 0) + i * GROUP_BAR.row;
}
