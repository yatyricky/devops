/**
 * 编辑期输出推断（纯函数模块；App 经工厂注入当前图状态——nodes/edges/typeMap 是 $state 代理，
 * 工厂每次调用时取当前值，函数体内读取保持响应性）。
 * 与引擎 run 同语义：path.resolve / string.join 的静态可解值推断。
 */

/** localStorage 里缓存的用户主目录（/api/home 启动时写入；不可用时 ~ 原样保留）。 */
export function storedHome() {
  return localStorage.getItem("devops-home") ?? "";
}

/** ~ 展开（浏览器端，与引擎 expandHome 同语义的本地版）。 */
export function expandHomeLocal(v, home = storedHome()) {
  if (v === "~") return home || "~";
  if (v.startsWith("~/")) return home ? home + v.slice(1) : v;
  return v;
}

/**
 * @param {{nodes: any[], edges: any[], typeMap: Record<string, any>}} g 当前图状态
 */
import { isTunnelEdge } from "../types.js";

export function makeInfer(g) {
  const { nodes, edges, typeMap } = g;

  /**
   * 编辑期解析某节点某输入口的当前值：连线（上游为 path.resolve/string.join 时递归推断）→
   * 上游按 outputValueKey 取 data 字段 → 未连线回读手填 lit。不可解 → undefined。
   */
  function resolvePortValue(nodeId, handleId, depth = 0) {
    if (depth > 8) return undefined;
    const e = edges.find(x => x.kind !== "seq" && !isTunnelEdge(x) && x.target === nodeId && x.targetHandle === handleId);
    if (e) {
      const src = nodes.find(n => n.id === e.source);
      if (!src) return undefined;
      if (src.type === "path.resolve") return inferPathResolve(src, depth + 1);
      if (src.type === "string.join") return inferStringJoin(src, depth + 1);
      const key = typeMap[src.type]?.outputValueKey ?? handleId;
      return src.data?.[key];
    }
    const self = nodes.find(n => n.id === nodeId);
    return self?.data?.lit?.[handleId];
  }

  /**
   * path.resolve 编辑期输出推断：全部 pN 来源为 string 常量接入或手填（lit）→ 返回拼接结果；
   * 任一非常量来源 → undefined（运行时才知道）。
   */
  function inferPathResolve(src, depth = 0) {
    const count = Math.min(16, Math.max(1, Number(src.data.count ?? 2) || 2));
    const style = ["posix", "windows", "auto"].includes(src.data.style) ? src.data.style : "posix";
    const norm = v => expandHomeLocal(String(v)).replace(/\\/g, "/");
    const segs = [];
    for (let i = 1; i <= count; i++) {
      const v = String(resolvePortValue(src.id, `p${i}`, depth) ?? "").trim();
      if (!v) return undefined; // 任一段不可静态确定 → 整体不可推断
      segs.push(norm(v));
    }
    const isAbsBase = seg => seg.startsWith("/") || /^[A-Za-z]:\//.test(seg);
    let full = "";
    for (const seg of segs) {
      full = (!full || isAbsBase(seg)) ? seg : `${full.replace(/\/+$/, "")}/${seg}`;
    }
    let out = full || "/";
    if (style === "windows") out = out.replace(/\//g, "\\");
    else if (style === "auto" && /^[A-Za-z]:\//.test(out)) out = out.replace(/\//g, "\\");
    return out;
  }

  /** string.join 编辑期输出推断：全部 pN 静态可解 → 分隔符拼接；否则 undefined。 */
  function inferStringJoin(src, depth = 0) {
    const count = Math.min(16, Math.max(1, Number(src.data.count ?? 2) || 2));
    const delimiter = String(src.data.delimiter ?? "");
    const segs = [];
    for (let i = 1; i <= count; i++) {
      const v = String(resolvePortValue(src.id, `p${i}`, depth) ?? "").trim();
      if (!v) return undefined;
      segs.push(v);
    }
    return segs.join(delimiter);
  }

  return { resolvePortValue, inferPathResolve, inferStringJoin };
}
