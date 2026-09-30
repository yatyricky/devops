<script>
  /**
   * 默认数据边：贝塞尔路径 + 选中时两端渲染重连锚点（xyflow 重连机制要求锚点
   * 在自定义 edge 组件内渲染，内置 BezierEdge 不带）。拖哪个锚就改哪一端；
   * 落空白/非法 handle 时库不触发 onConnect，边原样保留。样式（类型色）由 App 的
   * 边装饰 effect 经 edge.style 注入；selected 时两端锚点必然对应已选边的两端。
   *
   * 锚点位置修正：xyflow 的边端点比 handle 视觉圆心偏外 4.5（handle 半宽），
   * 锚点沿 handle 朝向回推 4.5 才能正压在节点边框线上（与常规端点圆同心）。
   */
  import { BaseEdge, EdgeReconnectAnchor, getBezierPath, Position } from "@xyflow/svelte";

  let { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
        markerEnd, style, selected = false } = $props();

  const path = $derived(getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })[0]);
  /** 把端点坐标回推到 handle 视觉圆心：left → x+4.5，right → x-4.5（y 轴同理） */
  const onNodeEdge = (pos, x, y) => ({
    x: x + (pos === Position.Left ? 4.5 : pos === Position.Right ? -4.5 : 0),
    y: y + (pos === Position.Top ? 4.5 : pos === Position.Bottom ? -4.5 : 0),
  });
  const srcAnchor = $derived(onNodeEdge(sourcePosition, sourceX, sourceY));
  const tgtAnchor = $derived(onNodeEdge(targetPosition, targetX, targetY));
</script>

{#if selected}
  <EdgeReconnectAnchor type="source" position={srcAnchor} class="reanchor" size={14}>
    <div class="dot"></div>
  </EdgeReconnectAnchor>
  <EdgeReconnectAnchor type="target" position={tgtAnchor} class="reanchor" size={14}>
    <div class="dot"></div>
  </EdgeReconnectAnchor>
{/if}
<BaseEdge {path} {style} {markerEnd} />
