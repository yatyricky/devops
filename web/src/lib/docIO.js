/**
 * 工作流文档序列化（纯函数）：画布态 → 入库 doc。逆操作 loadDoc 写十余个 $state，留在 App。
 * groupbox 节点不序列化（组存 doc.groups）；tnl- 派生段边不入库；__ 前缀装饰字段剥除。
 * @param {any[]} nodes @param {any[]} edges @param {Record<string, any>} tasks
 * @param {string} title @param {string} repoDir
 */
import { isTunnelEdge } from "../types.js";

export function toDocument(nodes, edges, tasks, title, repoDir) {
  const realNodes = nodes.filter(n => n.type !== "groupbox");
  return {
    ...(title ? { title } : {}),
    version: 1,
    ...(repoDir ? { repoDir } : {}),
    nodes: realNodes.map(n => ({ id: n.id, type: n.type, position: [Math.round(n.position.x), Math.round(n.position.y)], data: stripDecor(n.data) })),
    edges: edges.filter(e => !isTunnelEdge(e)).map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, ...(e.kind ? { kind: e.kind } : {}) })),
    tasks: JSON.parse(JSON.stringify(tasks)),
    // 分组：从 groupbox 节点还原（空组丢弃——全部成员删掉的组不再保留；collapsed 随条持久化）
    groups: nodes.filter(n => n.type === "groupbox").map(g => ({
      id: g.data.__gid, name: g.data.name, color: g.data.color, collapsed: !!g.data.collapsed,
      nodes: (g.data.memberIds ?? []).filter(id => realNodes.some(m => m.id === id)),
    })).filter(g => g.nodes.length),
  };
}

/** 剥除 __ 前缀装饰字段（__type 等运行时标记）；selector 节点剥 lockType（纯派生后为遗留脏数据）。 */
export function stripDecor(data) {
  const cleaned = Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith("__")));
  if ("lockType" in cleaned) delete cleaned.lockType;
  return cleaned;
}
