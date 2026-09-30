<script>
  // 分组背景板：xyflow 自建组件树，props 传不进来；App 经 context 提供回调。
  // 隧道：跨组边（组外→组内 / 组内→组外）在左右缘渲染只读接口点（connectable=false，
  // 纯视觉转发，不可操作）。collapsed = 收缩黑箱条（成员隐藏，仅标题 + 左右接口列）。
  import { getContext } from "svelte";
  import { Handle, Position } from "@xyflow/svelte";
  import { groupBarRowTop } from "./types.js";
  import { GROUP_COLORS as COLORS } from "./lib/groups.js";

  let { id, data, selected } = $props();
  const { ongroup, onpalette, groupEdges, oncollapse, tunnelLabel } = getContext("devnode-actions");

  let editingName = $state(false);
  let nameDraft = $state("");
  let paletteOpen = $state(false);

  let collapsed = $derived(data.collapsed === true);
  // 隧道接口：入（外部→组内）在左缘，出（组内→外部）在右缘；按边 id 排序稳定编号
  let tunnels = $derived(groupEdges?.(data.__gid) ?? { in: [], out: [] });

  function closePalette() {
    if (!paletteOpen) return;
    paletteOpen = false;
    onpalette?.(data.__gid, false);
  }
  function togglePalette(e) {
    e.stopPropagation();
    paletteOpen = !paletteOpen;
    onpalette?.(data.__gid, paletteOpen);
  }
  function commitName() {
    editingName = false;
    const v = nameDraft.trim() || "新分组";
    if (v !== data.name) ongroup?.(data.__gid, { name: v });
  }
  function pickColor(c, e) {
    e.stopPropagation();
    ongroup?.(data.__gid, { color: c });
    closePalette();
  }
  function toggleCollapse() {
    oncollapse?.(data.__gid, !collapsed);
  }
</script>

<!-- 展开态：板体整体可抓取拖动，组名/颜色/色板可编辑，左右缘半透明隧道接口点（转发段边锚点）；
     收起态：黑箱条 = 标题 + 左右隧道接口列（无卡片摘要空间），成员隐藏、外部连线仍接条缘 -->
<!-- svelte-ignore a11y_no_static_element_interactions -- 画布容器：mousedown 只做"点外关色板"，不承载点击语义 -->
<div class="gbox" class:selected class:collapsed style:--gc={data.color} onmousedown={closePalette}>
  <div class="ghead">
    {#if collapsed}
      <span class="gname gname-label" title={data.name}>{data.name || "分组"}</span>
    {:else}
      {#if editingName}
        <!-- svelte-ignore a11y_autofocus -->
        <input class="gname nodrag"
          bind:value={nameDraft}
          autofocus
          onblur={commitName}
          onkeydown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") (editingName = false); }}
        />
      {:else}
        <button type="button" class="gname gname-label unstyled" title={data.name} onclick={() => { nameDraft = data.name ?? ""; editingName = true; }}>
          {data.name || "新分组"}
        </button>
      {/if}
    {/if}
    {#if collapsed}
      <span class="tunnelcounts" title="入 {tunnels.in.length} / 出 {tunnels.out.length}">⇥{tunnels.in.length} ⇤{tunnels.out.length}</span>
    {/if}
    {#if !collapsed}
      <span class="gdotwrap nodrag">
        <button type="button" class="gdot unstyled" title="组颜色" style:background={data.color} onclick={togglePalette}></button>
        {#if paletteOpen}
          <!-- svelte-ignore a11y_no_static_element_interactions -- 浮层容器：mousedown 仅阻止冒泡（避免点色板关掉色板） -->
          <div class="gpalette" onmousedown={e => e.stopPropagation()}>
            {#each COLORS as c (c)}
              <button type="button" class="gswatch unstyled" class:on={c === data.color} style:background={c}
                onclick={e => pickColor(c, e)}></button>
            {/each}
          </div>
        {/if}
      </span>
    {/if}
    <button type="button" class="gcollapse nodrag unstyled" title={collapsed ? "展开" : "收起为黑箱条"} onclick={toggleCollapse}>
      {collapsed ? "▸" : "▾"}
    </button>
  </div>

  {#if !collapsed}
    <!-- 展开态：无隧道接口，跨组边直连（连线增删行为与无组时一致）；标题条与板底分色 -->
    <div class="gbody"></div>
  {:else}
    <!-- 收起黑箱条：标题行(36) + 入口行(左对齐) + 分隔线 + 出口行(右对齐) + 页脚
         （行位与总高由 types.js GROUP_BAR 推导，与 App 的节点高度同源）；
         label = <节点标题>: <端口label>，超宽省略号截断、title 悬停看全文 -->
    {#each tunnels.in as e, i (e.id)}
      {@const rtop = groupBarRowTop("in", i, tunnels.in.length)}
      {@const lbl = tunnelLabel(e, "in")}
      <div class="tlabel in nodrag" style="top:{rtop}px" title={lbl}>{lbl}</div>
      <Handle id={`tunnel-in-${i}`} type="target" position={Position.Left} connectable={false}
        style="background:#4da3ff; pointer-events:none; width:9px; height:9px; top:{rtop + 10}px" />
      <Handle id={`tunnel-in-${i}`} type="source" position={Position.Right} connectable={false}
        style="background:transparent; border-color:transparent; width:9px; height:9px; pointer-events:none; left:0; right:auto; transform:translate(-50%,-50%); top:{rtop + 10}px" />
    {/each}
    {#if tunnels.in.length && tunnels.out.length}
      <div class="tdiv" style="top:{groupBarRowTop('out', 0, tunnels.in.length) - 5}px"></div>
    {/if}
    {#each tunnels.out as e, i (e.id)}
      {@const rtop = groupBarRowTop("out", i, tunnels.in.length)}
      {@const lbl = tunnelLabel(e, "out")}
      <div class="tlabel out nodrag" style="top:{rtop}px" title={lbl}>{lbl}</div>
      <Handle id={`tunnel-out-${i}`} type="source" position={Position.Right} connectable={false}
        style="background:#ff9e64; pointer-events:none; width:9px; height:9px; top:{rtop + 10}px" />
      <Handle id={`tunnel-out-${i}`} type="target" position={Position.Left} connectable={false}
        style="background:transparent; border-color:transparent; width:9px; height:9px; pointer-events:none; left:auto; right:0; transform:translate(50%,-50%); top:{rtop + 10}px" />
    {/each}
  {/if}
</div>

<style>
  .gbox { position: relative; width: 100%; height: 100%; border-radius: 12px; display: flex; flex-direction: column;
    background: color-mix(in srgb, var(--gc) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--gc) 35%, transparent); }
  .gbox.selected { border-color: var(--gc); box-shadow: 0 0 0 1px var(--gc); }
  .gbox.collapsed { background: color-mix(in srgb, var(--gc) 16%, var(--panel));
    border-color: color-mix(in srgb, var(--gc) 60%, transparent); border-radius: 10px; }
  /* 标题条：全宽、与板底分色（两态通用）；高 = 2×白点间距（GROUP_BAR.header=32，与收起条同源）。
     板 wrapper 在 app.css 置 pointer-events:none（保证被板盖住的组外节点仍可点选），交互集中在标题条与收起条标签 */
  .ghead { height: 32px; flex: none; box-sizing: border-box; padding: 0 16px;
    display: flex; align-items: center; gap: 6px; cursor: grab; pointer-events: auto;
    background: color-mix(in srgb, var(--gc) 28%, var(--panel));
    border-bottom: 1px solid color-mix(in srgb, var(--gc) 55%, transparent);
    border-radius: 11px 11px 0 0; }
  .collapsed .ghead { border-radius: 9px 9px 0 0; }
  .gbody { flex: 1; }
  .ghead:active { cursor: grabbing; }
  /* 控件右对齐（与 node 卡 .htitle{flex:1} 同逻辑） */
  .gname { flex: 1; font-size: 12px; font-weight: 600; color: var(--fg);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gname-label { cursor: grab; padding: 2px 6px; border-radius: 5px; }
  .gname-label:hover { background: rgba(255, 255, 255, .08); }
  input.gname { width: 150px; padding: 1px 6px; font-size: 12px; }
  .gdotwrap { position: relative; flex: none; display: flex; align-items: center; }
  .gdot { width: 14px; height: 14px; border-radius: 50%; cursor: pointer;
    border: 1px solid rgba(255, 255, 255, .55); box-shadow: 0 0 4px rgba(0, 0, 0, .4); }
  .gpalette { position: absolute; top: 24px; left: 50%; transform: translateX(-50%); z-index: 5;
    display: flex; gap: 5px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 8px; padding: 6px; }
  .gswatch { width: 14px; height: 14px; border-radius: 50%; cursor: pointer;
    border: 1px solid rgba(255, 255, 255, .3); }
  .gswatch.on { outline: 2px solid #fff; outline-offset: 1px; }
  .tunnelcounts { font-size: 10px; color: var(--dim); font-family: var(--mono); flex: none; }
  .gcollapse { background: none; border: 1px solid var(--line); border-radius: 5px;
    color: var(--dim); cursor: pointer; padding: 1px 7px; font-size: 12px; flex: none; }
  .gcollapse:hover { color: var(--accent); border-color: var(--accent); }
  .tlabel { position: absolute; left: 16px; right: 16px; height: 20px; line-height: 20px;
    font-size: 11px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    pointer-events: auto; }
  .tlabel.in { text-align: left; }
  .tlabel.out { text-align: right; }
  .tdiv { position: absolute; left: 10px; right: 10px; height: 1px; background: var(--line); pointer-events: none; }
  /* 原生 button 复位（a11y：可聚焦/可键盘触发）——语义交互元素不再用 span 假装 */
  .unstyled { background: none; border: none; padding: 0; font: inherit; color: inherit; cursor: pointer; }
  button.gcollapse { border: 1px solid var(--line); border-radius: 5px; color: var(--dim); padding: 1px 7px; font-size: 12px; }
</style>
