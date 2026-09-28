<script>
  // 分组背景板：xyflow 自建组件树，props 传不进来；App 经 context 提供 ongroup 回调
  import { getContext } from "svelte";

  let { id, data, selected } = $props();
  const { ongroup, onpalette } = getContext("devnode-actions");

  const COLORS = ["#4da3ff", "#4cc38a", "#f5a623", "#ff6b6b", "#b18cff", "#56b6c2"];

  let editingName = $state(false);
  let nameDraft = $state("");
  let paletteOpen = $state(false);

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
</script>

<!-- 板体整体可抓取拖动（成员 wrapper 在上层，各自区域的事件先命中成员）；
     仅名字输入框/圆点/色板是交互控件（nodrag），组名文字本身可拖（点击=重命名，按住移动=拖组） -->
<div class="gbox" class:selected style:--gc={data.color} onmousedown={closePalette}>
  <div class="ghead">
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
  </div>
</div>

<style>
  .gbox { position: relative; width: 100%; height: 100%; border-radius: 12px;
    background: color-mix(in srgb, var(--gc) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--gc) 35%, transparent); }
  .gbox.selected { border-color: var(--gc); box-shadow: 0 0 0 1px var(--gc); }
  .ghead { position: absolute; top: 7px; left: 10px; right: 10px; height: 28px;
    display: flex; align-items: center; gap: 6px; cursor: grab; }
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
</style>
