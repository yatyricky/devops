/**
 * Group 分组纯逻辑（App 计算尺寸/查询与 GroupBox 渲染共用；显式参数版，不闭包图状态）。
 * groupbox = 专用 xyflow 节点：xyflow id 为 `grp-${gid}`，data.__gid 为裸 gid——查找一律按 __gid。
 */
import { groupBarHeight, isTunnelEdge } from "../types.js";

export const GROUP_PAD = 14, GROUP_PAD_X = 150, GROUP_PAD_TOP = 42;
/** GROUP_PAD_X 左右留白加大：给隧道接口↔组内节点的转发段边留出横向空间走曲线 */
export const GROUP_COLORS = ["#4da3ff", "#4cc38a", "#f5a623", "#ff6b6b", "#b18cff", "#56b6c2"];
export const GROUP_COLLAPSED_W = 230;

/** 成员 AABB + padding；成员为空返回 null。 */
export function groupAABB(nodes, memberIds) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = 0;
  for (const id of memberIds) {
    const m = nodes.find(n => n.id === id);
    if (!m || m.type === "groupbox") continue;
    found++;
    const w = m.measured?.width ?? 240, h = m.measured?.height ?? 60;
    minX = Math.min(minX, m.position.x); minY = Math.min(minY, m.position.y);
    maxX = Math.max(maxX, m.position.x + w); maxY = Math.max(maxY, m.position.y + h);
  }
  if (!found) return null;
  return { x: minX - GROUP_PAD_X, y: minY - GROUP_PAD_TOP,
    width: (maxX - minX) + GROUP_PAD_X * 2, height: (maxY - minY) + GROUP_PAD_TOP + GROUP_PAD };
}

/** 按 __gid 定位 groupbox 节点——xyflow 节点 id 是 `grp-${gid}`，别按裸 id 找。 */
export function groupBoxOf(nodes, gid) {
  return nodes.find(n => n.type === "groupbox" && n.data.__gid === gid) ?? null;
}

/** 某组的跨组边（入 = 组外→组内；出 = 组内→组外）；过滤 tnl- 派生段边。 */
export function crossEdges(edges, gbox) {
  const members = new Set(gbox?.data.memberIds ?? []);
  const inE = [], outE = [];
  for (const e of edges) {
    if (isTunnelEdge(e)) continue;
    const sIn = members.has(e.source), tIn = members.has(e.target);
    if (sIn && !tIn) outE.push(e);
    else if (!sIn && tIn) inE.push(e);
  }
  return { in: inE, out: outE };
}

/** 收起条宽 = 组内成员实测宽最大值（卡片内容自适应无统一常量；未测量回退 230）。 */
export function collapsedWidth(nodes, gbox) {
  let w = 0;
  for (const id of gbox?.data.memberIds ?? []) {
    const m = nodes.find(n => n.id === id);
    w = Math.max(w, m?.measured?.width ?? 0);
  }
  return Math.round(w) || GROUP_COLLAPSED_W;
}

/** 收起条高 = types.js GROUP_BAR 公式（与 GroupBox 渲染行同源）。 */
export function collapsedHeight(edges, gbox) {
  const r = crossEdges(edges, gbox);
  return groupBarHeight(r.in.length, r.out.length);
}

/** 新建 groupbox 节点（层级：组外节点 0 < 板 1 < 成员 2——成员由调用方抬升）。 */
export function makeGroupNode(nodes, gid, name, color, memberIds, collapsed = false) {
  const aabb = groupAABB(nodes, memberIds) ?? { x: 80, y: 80, width: 320, height: 200 };
  const data = { __gid: gid, name, color, memberIds: [...memberIds], collapsed };
  return {
    id: `grp-${gid}`, type: "groupbox", position: { x: aabb.x, y: aabb.y },
    width: collapsed ? collapsedWidth(nodes, { data }) : aabb.width,
    height: collapsed ? collapsedHeight([], { data }) : aabb.height,
    zIndex: 1,
    draggable: true, selectable: true, deletable: false,
    data, selected: true,
  };
}
