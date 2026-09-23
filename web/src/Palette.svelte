<script>
  /** 节点调色板：按分类列出注册表；点击在画布中心附近添加节点。 */
  let { metas, onadd } = $props();
  let open = $state(true);
  let collapsed = $state({});
  let groups = $derived([...new Set(metas.map(m => m.category))]);
  function toggleGroup(g) { collapsed = { ...collapsed, [g]: !collapsed[g] }; }
</script>

<aside class="palette" class:closed={!open}>
  <button class="toggle" title={open ? "收起节点库" : "展开节点库"} onclick={() => open = !open}>
    {open ? "◀ 收起" : "▶"}
  </button>
  {#if open}
    <div class="list">
      {#each groups as g (g)}
        <button class="group" onclick={() => toggleGroup(g)}>
          <span class="arrow">{collapsed[g] ? "▸" : "▾"}</span>{g}
        </button>
        {#if !collapsed[g]}
          {#each metas.filter(m => m.category === g) as m (m.type)}
            <button class="item" title={m.type} onclick={() => onadd(m)}>
              <span class="dot" style="background:{m.color}"></span>{m.title}
            </button>
          {/each}
        {/if}
      {/each}
    </div>
  {/if}
</aside>

<style>
  /* 悬浮在画布左上角，不参与 flex 布局：收起/展开不改变画布尺寸 */
  .palette { position: absolute; top: 12px; left: 12px; bottom: 128px; width: 150px; z-index: 5;
    display: flex; flex-direction: column; background: var(--panel); border: 1px solid var(--line);
    border-radius: 10px; padding: 8px 6px; min-height: 0; box-shadow: 0 2px 10px rgba(0,0,0,.4); }
  .palette.closed { bottom: auto; width: auto; padding: 4px; border-radius: 8px; }
  .toggle { flex: none; }
  .palette.closed .toggle { padding: 4px 8px; font-size: 12px; }
  .list { flex: 1; min-height: 0; overflow-y: auto; margin-top: 6px; }
  .group { display: flex; align-items: center; gap: 4px; width: 100%; text-align: left;
    background: none; border: none; padding: 2px 4px; font-size: 11px; color: var(--dim); font-weight: 600; }
  .group:hover { color: var(--fg); border: none; }
  .arrow { width: 10px; flex: none; }
  .item { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; margin: 2px 0; padding: 3px 8px; font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
</style>
