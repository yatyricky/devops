<script>
  // 分组背景板：xyflow 自建组件树，props 传不进来；App 经 context 提供回调。
  // 隧道：跨组边（组外→组内 / 组内→组外）在左右缘渲染只读接口点（connectable=false，
  // 纯视觉转发，不可操作）。collapsed = 收缩黑箱条（成员隐藏，仅标题 + 左右接口列）。
  import { getContext } from "svelte";
  import { Handle, Position } from "@xyflow/svelte";

  let { id, data, selected } = $props();
  const { ongroup, onpalette, groupEdges, oncollapse } = getContext("devnode-actions");

  const COLORS = ["#4da3ff", "#4cc38a", "#f5a623", "#ff6b6b", "#b18cff", "#56b6c2"];

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
        <span class="gname gname-label" title={data.name} onclick={() => { nameDraft = data.name ?? ""; editingName = true; }}>
          {data.name || "新分组"}
        </span>
      {/if}
    {/if}
    <span class="tunnelcounts" title="入 {tunnels.in.length} / 出 {tunnels.out.length}">⇥{tunnels.in.length} ⇤{tunnels.out.length}</span>
    {#if !collapsed}
      <span class="gdotwrap nodrag">
        <span class="gdot" title="组颜色" style:background={data.color} onclick={togglePalette}></span>
        {#if paletteOpen}
          <div class="gpalette" onmousedown={e => e.stopPropagation()}>
            {#each COLORS as c (c)}
              <span class="gswatch" class:on={c === data.color} style:background={c}
                onclick={e => pickColor(c, e)}></span>
            {/each}
          </div>
        {/if}
      </span>
    {/if}
    <span class="gcollapse nodrag" title={collapsed ? "展开" : "收起为黑箱条"} onclick={toggleCollapse}>
      {collapsed ? "▸" : "▾"}
    </span>
  </div>

  {#if !collapsed}
    <div class="gbody"></div>
    <!-- 展开态隧道接口：半透明小点（转发段边的锚点，随接口数下移） -->
    {#each tunnels.in as e, i (e.id)}
      <Handle id={`tunnel-in-${i}`} type="target" position={Position.Left} connectable={false}
        style="background:#4da3ff; opacity:.55; left:-4px; top:{34 + i * 20}px" />
    {/each}
    {#each tunnels.out as e, i (e.id)}
      <Handle id={`tunnel-out-${i}`} type="source" position={Position.Right} connectable={false}
        style="background:#ff9e64; opacity:.55; right:-4px; top:{34 + i * 20}px" />
    {/each}
  {:else}
    <div class="tcollwrap">
      <div class="tcol left">
        {#each tunnels.in as e, i (e.id)}
          <Handle id={`tunnel-in-${i}`} type="target" position={Position.Left} connectable={false}
            style="background:#4da3ff; pointer-events:none" />
        {/each}
      </div>
      <div class="tcol right">
        {#each tunnels.out as e, i (e.id)}
          <Handle id={`tunnel-out-${i}`} type="source" position={Position.Right} connectable={false}
            style="background:#ff9e64; pointer-events:none" />
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .gbox { position: relative; width: 100%; height: 100%; border-radius: 12px;
    background: color-mix(in srgb, var(--gc) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--gc) 35%, transparent); }
  .gbox.selected { border-color: var(--gc); box-shadow: 0 0 0 1px var(--gc); }
  .gbox.collapsed { background: color-mix(in srgb, var(--gc) 16%, var(--panel));
    border-color: color-mix(in srgb, var(--gc) 60%, transparent); border-radius: 10px; }
  .ghead { position: absolute; top: 7px; left: 10px; right: 10px; height: 28px;
    display: flex; align-items: center; gap: 6px; cursor: grab; }
  .collapsed .ghead { position: static; padding: 4px 10px; height: auto; }
  .ghead:active { cursor: grabbing; }
  .gname { font-size: 12px; font-weight: 600; color: var(--fg);
    max-width: calc(100% - 30px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
  .tunnelcounts { font-size: 10px; color: var(--dim); font-family: Consolas, monospace; flex: none; }
  .gcollapse { background: none; border: 1px solid var(--line); border-radius: 5px;
    color: var(--dim); cursor: pointer; padding: 1px 7px; font-size: 12px; flex: none; }
  .gcollapse:hover { color: var(--accent); border-color: var(--accent); }
  .collapsed .tcollwrap { flex: 1; display: flex; justify-content: space-between; align-items: stretch; padding: 0 2px; }
  .collapsed .tcoll { display: flex; flex-direction: column; justify-content: space-around; }
  .collapsed .tcoll.right { align-items: flex-end; }
</style>
