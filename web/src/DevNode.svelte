<script>
  import { getContext } from "svelte";
  import { Handle, Position, useUpdateNodeInternals } from "@xyflow/svelte";
  import { TYPE_COLORS, effectiveInputs, effectiveOutputs } from "./types.js";
  import { api } from "./api.js";
  import { ui } from "./store.svelte.js";

  let { id, data, selected } = $props();
  // xyflow 自建组件树，props 传不进来；App 经 context 提供回调
  const { ondata, ondelete, isWiredAsTarget, getSourceNode, resolveInput } = getContext("devnode-actions");
  const updateNodeInternals = useUpdateNodeInternals();

  let meta = $derived(ui.nodeTypesMap[data.__type]);
  let hl = $derived(ui.pathHighlight[id]);
  let inputs = $derived(effectiveInputs(meta, data));
  let color = $derived(meta?.color ?? "#8a97a8");
  let onPath = $derived(hl === true);
  // ── 任务运行状态（卡片外框）：集外半透明灰；running 跑马灯 / ok 绿框 / failed 红框 ────
  let runSt = $derived(ui.nodeRunStatus?.[id]);
  let offTask = $derived(ui.runTaskNodes != null && !ui.runTaskNodes.has(id));

  // ── 动态出口：structSplit 回溯上游字段定义 ────
  let outputs = $derived.by(() => {
    if (!meta) return [];
    if (meta.dynamicOutputs === "structSplit") {
      const src = getSourceNode?.(id, "struct");
      return (src?.data?.fields ?? []).filter(f => f.key).map(f => ({ id: f.key, type: f.type ?? "string" }));
    }
    return meta.outputs ?? [];
  });

// 动态插槽（structSplit 出口 / {{}} 动态输入）增删 handle 时节点外框尺寸不变，
  // ResizeObserver 不触发 → 内部 handleBounds 不重测 → 指向新 handle 的边不渲染、
  // 也不发起新连接。必须在 handle 集变化后显式告知 Svelte Flow 重测。
  // 依赖必须基于【动态解析后】的 inputs/outputs（struct.split 的 meta.outputs 恒为空）。
  $effect(() => {
    const sig = JSON.stringify([inputs.map(i => i.id), outputs.map(o => o.id)]);
    if (!id || !sig) return;
    // 等新 Handle DOM 挂载完成后再重测（rAF 对齐渲染帧）
    requestAnimationFrame(() => updateNodeInternals(id));
  });


  // ── widget 编辑（原 Inspector 逻辑上卡片）────
  /** @param {string} k @param {any} v */
  function set(k, v) { ondata?.(id, k, v); }
  const get = k => data?.[k];

  let newVals = $state({});
  /** 字典类 widget（mapping/values/schema）统一 CRUD */
  function dictUpdate(key, k, v) { set(key, { ...(get(key) ?? {}), [k]: v }); }
  function dictDelete(key, k) { const m = { ...(get(key) ?? {}) }; delete m[k]; set(key, m); }
  function dictAdd(key) {
    const k = String(newVals[key + "#k"] ?? "").trim();
    if (!k) return;
    set(key, { ...(get(key) ?? {}), [k]: newVals[key + "#v"] ?? "" });
    newVals[key + "#k"] = ""; newVals[key + "#v"] = "";
  }
  function listAdd(key) {
    const v = String(newVals[key] ?? "").trim();
    if (!v) return;
    set(key, [...(get(key) ?? []), v]);
    newVals[key] = "";
  }
  function entriesAdd(key) {
    const v = String(newVals[key] ?? "").trim();
    if (!v) return;
    set(key, [...(get(key) ?? []), { from: v, to: v }]);
    newVals[key] = "";
  }

  // ── git.getRefs：刷新 refs + 下拉选择 ────
  let refs = $state([]);
  let refsErr = $state("");
  let refreshing = $state(false);
  async function refreshRefs() {
    const repoDir = resolveInput?.(id, "repoDir");
    if (!repoDir) { refsErr = "未连接仓库目录输入"; return; }
    refreshing = true; refsErr = "";
    try {
      refs = await api("/api/git/refs", { method: "POST", body: JSON.stringify({ repoDir }) });
    } catch (e) {
      refsErr = e.message;
    } finally {
      refreshing = false;
    }
  }

  // ── ssh.session：别名下拉手动刷新（读 ~/./.ssh/config，无需连线输入）────
  let sshAliases = $state([]);
  let sshResolved = $state(null);
  let sshErr = $state("");
  let sshRefreshing = $state(false);
  async function refreshSshAliases() {
    sshRefreshing = true; sshErr = "";
    try {
      const r = await api("/api/ssh/aliases", { method: "POST", body: JSON.stringify({ alias: get("alias") ?? "" }) });
      sshAliases = r.aliases ?? [];
      sshResolved = r.resolved ?? null;
      sshErr = r.resolved?.error ?? "";
    } catch (e) {
      sshErr = e.message;
    } finally {
      sshRefreshing = false;
    }
  }

  // ── npm.run：scripts 下拉手动刷新（点「刷新」解析 <path>/package.json，同 git refs 模式）────
  let scripts = $state([]);
  let scriptsErr = $state("");
  let scriptsRefreshing = $state(false);
  async function refreshScripts() {
    const p = String(resolveInput?.(id, "path") ?? "").trim();
    if (!p) { scriptsErr = "未连接目录输入"; return; }
    scriptsRefreshing = true; scriptsErr = "";
    try {
      scripts = await api("/api/npm/scripts", { method: "POST", body: JSON.stringify({ path: p }) });
      // 已序列化的值不在集合中 → 默认取第一项（回写保持 serializable 值有效）
      const cur = String(get("script") ?? "");
      if (scripts.length && !scripts.includes(cur)) set("script", scripts[0]);
    } catch (e) {
      scriptsErr = e.message;
    } finally {
      scriptsRefreshing = false;
    }
  }

  // ── 卡片错误：整卡红框描边 ────
  let cardError = $derived.by(() => {
    if (meta?.refsPicker && refsErr) return refsErr;
    return "";
  });

  // ── 节点备注：便笺按钮折叠展开，内容存 data.note 随图保存 ────
  let noteOpen = $state(false);
  let noteText = $derived(String(data?.note ?? ""));

  // ── struct 字段行：值控件按类型变化；字段口连线后隐藏手填 ────
  const numOk = v => String(v ?? "").trim() !== "" && Number.isFinite(Number(v));
  /** @param {string} key @param {number} i @param {string} prop @param {any} v */
  function setField(key, i, prop, v) { set(key, (get(key) ?? []).map((x, j) => j === i ? { ...x, [prop]: v } : x)); }
  function fieldAdd(key) {
    const k = String(newVals[key + "#k"] ?? "").trim();
    if (!k || !/^\w+$/.test(k)) return;
    const type = newVals[key + "#t"] ?? "string";
    set(key, [...(get(key) ?? []), { key: k, type, value: type === "boolean" ? false : "" }]);
    newVals[key + "#k"] = ""; newVals[key + "#t"] = "string";
  }
</script>

<div class="devnode" class:selected class:onpath={onPath} class:error={!!cardError}
  class:offtask={offTask && !runSt} class:st-ok={runSt === "ok"} class:st-fail={runSt === "failed"} class:st-run={runSt === "running"}>
  {#snippet trash(size = 12)}
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  {/snippet}

  <div class="head" style="background:{color}">
    <span class="htitle">{meta?.title ?? data.__type}</span>
    <button class="del nodrag" title="删除节点" onclick={() => ondelete?.(id)}>{@render trash(11)}</button>
  </div>
  {#if meta?.desc}<div class="ndesc">{meta.desc}</div>{/if}
  <div class="body nowheel">
    {#each inputs as inp (inp.id)}
      <div class="kv in" title={inp.required ? `必填输入${inp.dynamic ? `：在对应控件里写 {{${inp.id}}} 生成` : ""}` : undefined}>
        <Handle id={inp.id} type="target" position={Position.Left} style="background:{TYPE_COLORS[inp.type]}" />
        <span class="lbl">{inp.id}<span style="color:{TYPE_COLORS[inp.type]}"> ({inp.type}{inp.dynamic ? "⭑" : ""})</span>{#if inp.required}<span class="req" title="必填">*</span>{/if}</span>
      </div>
    {/each}
    {#if outputs.length}
      <div class="sep"></div>
      {#each outputs as out (out.id)}
        <div class="kv out">
          <span class="lbl">{out.id}<span style="color:{TYPE_COLORS[out.type]}"> ({out.type})</span></span>
          <Handle id={out.id} type="source" position={Position.Right} style="background:{TYPE_COLORS[out.type]}" />
        </div>
      {/each}
    {/if}
    <div class="kv ctl">
      <Handle id="__seqIn" type="target" position={Position.Left} style="background:#8a97a8" />
      <span class="lbl seqsym">顺序 ▸</span>
      <Handle id="__seqOut" type="source" position={Position.Right} style="background:#8a97a8" />
    </div>

    {#if meta?.widgets?.length}
      <div class="sep"></div>
      {#each meta.widgets as w (w.key)}
        <label class="wrow nodrag">
          <span class="wlab">{w.label}{#if w.serializable}<span class="sbadge" title="可序列化：纯文本字面量，可直接入库或携带占位符">s</span>{/if}</span>
          {#if w.kind === "text"}
            <textarea rows="4" value={get(w.key) ?? ""} placeholder={w.placeholder ?? ""}
              oninput={e => set(w.key, e.target.value)}></textarea>
          {:else if w.kind === "boolean"}
            <input type="checkbox" class="ckb" checked={get(w.key) ?? w.default}
              onchange={e => set(w.key, e.target.checked)} />
          {:else if w.kind === "enum"}
            <select value={get(w.key) ?? w.default} onchange={e => set(w.key, e.target.value)}>
              {#each w.options as o}<option value={o}>{o}</option>{/each}
            </select>
          {:else if w.kind === "kv"}
            <span class="tblwrap">
              {#each Object.entries(get(w.key) ?? {}) as [k, v]}
                <span class="trow">
                  <input value={k} disabled />
                  <input value={v} onchange={e => dictUpdate(w.key, k, e.target.value)} />
                  <button class="mini danger" onclick={() => dictDelete(w.key, k)}>✕</button>
                </span>
              {/each}
              <span class="trow">
                <input placeholder="键" bind:value={newVals[w.key + "#k"]} />
                <input placeholder="值" bind:value={newVals[w.key + "#v"]} />
                <button class="mini" onclick={() => dictAdd(w.key)}>＋</button>
              </span>
            </span>
          {:else if w.kind === "entries"}
            <span class="tblwrap">
              {#each get(w.key) ?? [] as e, i}
                <span class="trow">
                  <input value={e.from} onchange={ev => set(w.key, (get(w.key) ?? []).map((x, j) => j === i ? { ...x, from: ev.target.value } : x))} />
                  <span class="arr">→</span>
                  <input value={e.to} onchange={ev => set(w.key, (get(w.key) ?? []).map((x, j) => j === i ? { ...x, to: ev.target.value } : x))} />
                  <button class="mini danger" onclick={() => set(w.key, (get(w.key) ?? []).filter((_, j) => j !== i))}>✕</button>
                </span>
              {/each}
              <span class="trow">
                <input placeholder="from（to 默认同 from）" bind:value={newVals[w.key]} />
                <button class="mini" onclick={() => entriesAdd(w.key)}>＋</button>
              </span>
            </span>
          {:else if w.kind === "list"}
            <span class="tblwrap">
              <span class="badges">
                {#each get(w.key) ?? [] as item, i}
                  <span class="badge mono">{item}<a class="rm" onclick={() => set(w.key, (get(w.key) ?? []).filter((_, j) => j !== i))}>✕</a></span>
                {/each}
              </span>
              <span class="trow">
                <input placeholder="新增条目" bind:value={newVals[w.key]} />
                <button class="mini" onclick={() => listAdd(w.key)}>＋</button>
              </span>
            </span>
          {:else if meta?.scriptsPicker && w.key === "script"}
            <span class="trow">
              <select value={get(w.key) ?? ""} onchange={e => set(w.key, e.target.value)}>
                {#each scripts as s (s)}<option value={s}>{s}</option>{/each}
              </select>
              <button class="mini" disabled={scriptsRefreshing} onclick={refreshScripts}>{scriptsRefreshing ? "…" : "刷新"}</button>
            </span>
            {#if scriptsErr}<span class="errline">⚠ {scriptsErr}</span>{/if}
          {:else if w.kind === "number"}
            <input class:winvalid={String(get(w.key) ?? "").trim() !== "" && !numOk(get(w.key))}
              value={get(w.key) ?? ""} placeholder={w.placeholder ?? ""}
              onchange={e => set(w.key, numOk(e.target.value) ? Number(e.target.value) : e.target.value)} />
          {:else if w.kind === "struct"}
            <span class="tblwrap">
              {#each get(w.key) ?? [] as f, i}
                <span class="trow">
                  <input class:winvalid={!/^\w+$/.test(f.key)} placeholder="key" value={f.key}
                    onchange={e => setField(w.key, i, "key", e.target.value)} />
                  <select value={f.type} onchange={e => setField(w.key, i, "type", e.target.value)}>
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                  </select>
                  {#if isWiredAsTarget?.(id, f.key)}
                    <span class="wired" title="已连线：该字段值来自上游">🔗</span>
                  {:else if f.type === "boolean"}
                    <input type="checkbox" class="ckb" checked={f.value ?? false}
                      onchange={e => setField(w.key, i, "value", e.target.checked)} />
                  {:else}
                    <input class:winvalid={f.type === "number" && !numOk(f.value)} placeholder="值" value={f.value ?? ""}
                      onchange={e => setField(w.key, i, "value", e.target.value)} />
                  {/if}
                  <button class="mini danger" title="删除字段" onclick={() => set(w.key, (get(w.key) ?? []).filter((_, j) => j !== i))}>{@render trash(11)}</button>
                </span>
              {/each}
              <span class="trow">
                <input placeholder="key" bind:value={newVals[w.key + "#k"]} />
                <select bind:value={newVals[w.key + "#t"]}>
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="boolean">boolean</option>
                </select>
                <button class="mini" onclick={() => fieldAdd(w.key)}>＋</button>
              </span>
            </span>
          {:else}
            <input value={get(w.key) ?? ""} placeholder={w.placeholder ?? ""}
              oninput={e => set(w.key, e.target.value)} />
          {/if}
        </label>
      {/each}
    {/if}

    {#if meta?.sshAliasesPicker}
      <label class="wrow nodrag">
        <span class="wlab">SSH 别名（~/.ssh/config）</span>
        <span class="trow">
          <input list="ssh-aliases-{id}" value={get("alias") ?? ""} placeholder="如 vultr-tokyo"
            oninput={e => set("alias", e.target.value)} onchange={refreshSshAliases} />
          <button class="mini" disabled={sshRefreshing} onclick={refreshSshAliases}>{sshRefreshing ? "…" : "刷新"}</button>
        </span>
        <datalist id="ssh-aliases-{id}">
          {#each sshAliases as a (a)}<option value={a}></option>{/each}
        </datalist>
        {#if sshResolved && !sshResolved.error}
          <span class="kvline">→ {sshResolved.user}@{sshResolved.host}:{sshResolved.port}{sshResolved.identityFile ? `（${sshResolved.identityFile}）` : ""}{sshResolved.fromConfig ? "" : "（config 未命中，直连）"}</span>
        {/if}
        {#if sshErr}<span class="errline">⚠ {sshErr}</span>{/if}
      </label>
    {/if}

    {#if meta?.refsPicker}
      <label class="wrow nodrag">
        <span class="wlab">Ref（默认 HEAD）</span>
        <span class="trow">
          <select value={get("ref") ?? "HEAD"} onchange={e => set("ref", e.target.value)}>
            <option value="HEAD">HEAD</option>
            {#each refs as r (r.name)}<option value={r.name}>{r.refType === "tag" ? `[tag] ${r.name}` : r.name}</option>{/each}
          </select>
          <button class="mini" disabled={refreshing} onclick={refreshRefs}>{refreshing ? "…" : "刷新"}</button>
        </span>
        {#if refsErr}<span class="errline">⚠ {refsErr}</span>{/if}
      </label>
    {/if}
  </div>
  {#if noteOpen}
    <div class="noterow nodrag nowheel">
      <span class="wlab">备注<span class="sbadge" title="可序列化：纯文本字面量">s</span></span>
      <textarea rows="2" value={noteText} placeholder="节点备注…"
        oninput={e => set("note", e.target.value)}></textarea>
    </div>
  {/if}
  <div class="nidrow">
    <span class="nid nodrag" title="节点 id">{id}</span>
    <button class="notebtn nodrag" class:hasnote={!!noteText} title="备注" onclick={() => (noteOpen = !noteOpen)}>便笺</button>
  </div>
</div>
