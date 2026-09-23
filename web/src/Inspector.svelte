<script>
  /** 选中节点的检查器：按 node-types 元数据渲染表单；编辑同步图并清理失效动态边（App 侧 ondata 处理）。 */
  let { node, meta, ondata, ondelete } = $props();

  let kvNewKey = $state("");
  let kvNewVal = $state("");
  let listNew = $state("");

  /** @param {string} k @param {any} v */
  function set(k, v) { ondata(k, v); }
  /** @param {string} k */
  function get(k) { return node?.data?.[k]; }

  function kvUpdate(k, v) { set("mapping", { ...(get("mapping") ?? {}), [k]: v }); }
  function kvDelete(k) { const m = { ...(get("mapping") ?? {}) }; delete m[k]; set("mapping", m); }
  function kvAdd() {
    if (!kvNewKey) return;
    set("mapping", { ...(get("mapping") ?? {}), [kvNewKey]: kvNewVal });
    kvNewKey = ""; kvNewVal = "";
  }
  function paramsUpdate(k, v) { set("values", { ...(get("values") ?? {}), [k]: v }); }
  function paramsDelete(k) { const m = { ...(get("values") ?? {}) }; delete m[k]; set("values", m); }
  function paramsAdd() {
    if (!kvNewKey) return;
    set("values", { ...(get("values") ?? {}), [kvNewKey]: kvNewVal });
    kvNewKey = ""; kvNewVal = "";
  }
  function listAdd() {
    if (!listNew.trim()) return;
    set("excludes", [...(get("excludes") ?? []), listNew.trim()]);
    listNew = "";
  }
  function entriesAdd() {
    if (!listNew.trim()) return;
    set("entries", [...(get("entries") ?? []), { from: listNew.trim(), to: listNew.trim() }]);
    listNew = "";
  }
</script>

{#if node && meta}
  <div class="inspector">
    <h3>{meta.title}</h3>
    <div class="dim mono">{node.id} · {node.data.__type}</div>
    {#each meta.widgets as w (w.key)}
      <label>
        <span class="lab">{w.label}</span>
        {#if w.kind === "text"}
          <textarea rows="5" value={get(w.key) ?? ""} oninput={e => set(w.key, e.target.value)}></textarea>
        {:else if w.kind === "boolean"}
          <input type="checkbox" checked={get(w.key) ?? w.default} onchange={e => set(w.key, e.target.checked)} />
        {:else if w.kind === "enum"}
          <select value={get(w.key) ?? w.default} onchange={e => set(w.key, e.target.value)}>
            {#each w.options as o}<option value={o}>{o}</option>{/each}
          </select>
        {:else if w.kind === "kv"}
          <table><tbody>{#each Object.entries(get(w.key) ?? {}) as [k, v]}
              <tr>
                <td><input value={k} disabled /></td>
                <td><input value={v} onchange={e => (w.key === "values" ? paramsUpdate(k, e.target.value) : kvUpdate(k, e.target.value))} /></td>
                <td><button class="danger" onclick={() => (w.key === "values" ? paramsDelete(k) : kvDelete(k))}>✕</button></td>
              </tr>
            {/each}
            <tr>
              <td><input placeholder="键" bind:value={kvNewKey} /></td>
              <td><input placeholder="值" bind:value={kvNewVal} /></td>
              <td><button onclick={() => (w.key === "values" ? paramsAdd() : kvAdd())}>＋</button></td>
            </tr>
          </table>
        {:else if w.kind === "entries"}
          <table><tbody>{#each get(w.key) ?? [] as e, i}
              <tr>
                <td><input value={e.from} onchange={ev => set("entries", (get("entries") ?? []).map((x, j) => j === i ? { ...x, from: ev.target.value } : x))} /></td>
                <td class="dim">→</td>
                <td><input value={e.to} onchange={ev => set("entries", (get("entries") ?? []).map((x, j) => j === i ? { ...x, to: ev.target.value } : x))} /></td>
                <td><button class="danger" onclick={() => set("entries", (get("entries") ?? []).filter((_, j) => j !== i))}>✕</button></td>
              </tr>
            {/each}
            <tr>
              <td colspan="3"><input placeholder="from（to 默认同 from）" bind:value={listNew} /></td>
              <td><button onclick={entriesAdd}>＋</button></td>
            </tr>
          </table>
        {:else if w.kind === "list"}
          <div>
            {#each get(w.key) ?? [] as item, i}
              <span class="badge mono" style="margin:1px">
                {item}
                <a style="cursor:pointer" onclick={() => set(w.key, (get(w.key) ?? []).filter((_, j) => j !== i))}>✕</a>
              </span>
            {/each}
            <div style="display:flex; gap:6px; margin-top:4px">
              <input placeholder="新增条目" bind:value={listNew} />
              <button onclick={listAdd}>＋</button>
            </div>
          </div>
        {:else}
          <input value={get(w.key) ?? ""} placeholder={w.placeholder ?? ""} oninput={e => set(w.key, e.target.value)} />
        {/if}
      </label>
    {/each}

    {#if meta.dynamicInputs}
      <div class="dim" style="margin-top:8px">动态插槽：在「{meta.dynamicInputs.source}」里写 <code>{"{{name}}"}</code>（string 输入）或 <code>{"{{obj.key}}"}</code>（any 输入）；类型不匹配的连线会被拒绝。</div>
    {/if}

    <div style="margin-top:12px; text-align:right">
      <button class="danger" onclick={() => ondelete(node.id)}>删除节点</button>
    </div>
  </div>
{:else}
  <div class="inspector dim">选中一个节点编辑参数</div>
{/if}

<style>
  .inspector { padding: 12px; overflow-y: auto; height: 100%; }
  .inspector h3 { margin: 0 0 4px; font-size: 15px; }
  .inspector label { display: block; margin: 10px 0 4px; }
  .lab { font-size: 12px; color: var(--dim); display: block; margin-bottom: 3px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 3px; }
  .mono { font: 12px Consolas, monospace; }
  .dim { color: var(--dim); font-size: 12px; }
</style>
