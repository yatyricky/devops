<script>
  import { Handle, Position } from "@xyflow/svelte";
  import { TYPE_COLORS, effectiveInputs } from "./types.js";
  import { ui } from "./store.svelte.js";

  let { id, data, selected } = $props();
  let meta = $derived(ui.nodeTypesMap[data.__type]);
  let hl = $derived(ui.pathHighlight[id]);

  let inputs = $derived(effectiveInputs(meta, data));
  let outputs = $derived(meta?.outputs ?? []);
  let color = $derived(meta?.color ?? "#8a97a8");
  let onPath = $derived(hl !== undefined);
  let pathIdx = $derived(hl ?? 0);
</script>

<div class="devnode" class:selected class:onpath={onPath}>
  {#if onPath}<span class="pathidx">{pathIdx}</span>{/if}
  <div class="head" style="background:{color}">{meta?.title ?? data.__type}</div>
  <div class="body">
    {#each inputs as inp (inp.id)}
      <div class="kv">← {inp.id}<span style="color:{TYPE_COLORS[inp.type]}"> ({inp.type}{inp.dynamic ? "⭑" : ""})</span></div>
    {/each}
    {#if !inputs.length}<div class="kv">（无输入）</div>{/if}
    {#if outputs.length}
      <div style="border-top:1px solid var(--line); margin:4px 0"></div>
      {#each outputs as out (out.id)}
        <div class="kv">→ {out.id}<span style="color:{TYPE_COLORS[out.type]}"> ({out.type})</span></div>
      {/each}
    {/if}
  </div>

  {#each inputs as inp (inp.id)}
    <Handle id={inp.id} type="target" position={Position.Left}
      style="background:{TYPE_COLORS[inp.type]}; width:9px; height:9px; left:-5px;
      top:{14 + inputs.indexOf(inp) * 18}px" />
  {/each}
  {#each outputs as out, i (out.id)}
    <Handle id={out.id} type="source" position={Position.Right}
      style="background:{TYPE_COLORS[out.type]}; width:9px; height:9px; right:-5px;
      top:{14 + i * 18}px" />
  {/each}
</div>
