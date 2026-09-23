<script>
  /** 节点调色板：按分类列出注册表；点击在画布中心附近添加节点。 */
  let { metas, onadd } = $props();
  let open = $state(true);
  let groups = $derived([...new Set(metas.map(m => m.category))]);
</script>

<aside class="palette">
  <button class="toggle" onclick={() => open = !open}>{open ? "◀ 收起" : "▶ 节点"}</button>
  {#if open}
    {#each groups as g (g)}
      <div class="group">{g}</div>
      {#each metas.filter(m => m.category === g) as m (m.type)}
        <button class="item" title={m.type} onclick={() => onadd(m)}>
          <span class="dot" style="background:{m.color}"></span>{m.title}
        </button>
      {/each}
    {/each}
  {/if}
</aside>

<style>
  .palette { width: 150px; flex: none; background: var(--panel); border-right: 1px solid var(--line);
    overflow-y: auto; padding: 8px 6px; }
  .toggle { width: 100%; margin-bottom: 6px; }
  .group { font-size: 11px; color: var(--dim); margin: 8px 4px 2px; font-weight: 600; }
  .item { display: flex; align-items: center; gap: 6px; width: 100%; text-align: left; margin: 2px 0; padding: 3px 8px; font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
</style>
