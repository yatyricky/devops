<script>
  /**
   * 默认数据边：贝塞尔路径 + 选中时两端渲染重连锚点（xyflow 重连机制要求锚点
   * 在自定义 edge 组件内渲染，内置 BezierEdge 不带）。拖哪个锚就改哪一端；
   * 落空白/非法 handle 时库不触发 onConnect，边原样保留。样式（类型色）由 App 的
   * 边装饰 effect 经 edge.style 注入；selected 时两端锚点必然对应已选边的两端。
   */
  import { BaseEdge, EdgeReconnectAnchor, getBezierPath } from "@xyflow/svelte";

  let { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
        markerEnd, style, selected = false } = $props();

  const path = $derived(getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition })[0]);
</script>

{#if selected}
  <EdgeReconnectAnchor type="source" position={{ x: sourceX, y: sourceY }} class="reanchor" size={14}>
    <div class="dot"></div>
  </EdgeReconnectAnchor>
  <EdgeReconnectAnchor type="target" position={{ x: targetX, y: targetY }} class="reanchor" size={14}>
    <div class="dot"></div>
  </EdgeReconnectAnchor>
{/if}
<BaseEdge {path} {style} {markerEnd} data-tesel={String(!!selected)} />
