<script>
  import { getContext } from "svelte";
  import { Handle, Position } from "@xyflow/svelte";
  import { TYPE_COLORS, effectiveInputs } from "./types.js";
  import { api } from "./api.js";
  import { ui } from "./store.svelte.js";

  let { id, data, selected } = $props();
  // xyflow 自建组件树，props 传不进来；App 经 context 提供回调
  const { ondata, ondelete, isConnected, resolveInput } = getContext("devnode-actions");

  let meta = $derived(ui.nodeTypesMap[data.__type]);
  let hl = $derived(ui.pathHighlight[id]);
  let inputs = $derived(effectiveInputs(meta, data));
  let outputs = $derived(meta?.outputs ?? []);
  let color = $derived(meta?.color ?? "#8a97a8");
  let onPath = $derived(hl === true);

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

  // ── fs.path：路径校验（绝对路径或 ~ 开头，~ = 用户主目录）+ stat 展示 ────
  function pathCheck(p) {
    if (!p) return false;
    const home = /^~(?:[\\/]|$)/.test(p);
    if (!home && !/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(p)) return false;
    if (/[<>|"?*\x00-\x1f]/.test(p)) return false;
    return home || !/[<>:"|?*\x00-\x1f]/.test(p.slice(2));
  }
  let pathValid = $derived(meta?.pathStat ? pathCheck(String(data?.path ?? "").trim()) : true);
  let stat = $state(null);
  let statErr = $state("");
  $effect(() => {
    if (!meta?.pathStat) return;
    const p = String(data?.path ?? "").trim();
    stat = null; statErr = "";
    if (!p || !pathCheck(p)) return;
    const t = setTimeout(async () => {
      try { stat = await api("/api/fs/stat", { method: "POST", body: JSON.stringify({ path: p }) }); }
      catch (e) { statErr = e.message; }
    }, 300);
    return () => clearTimeout(t);
  });
  function fmtSize(n) {
    if (n == null) return "—";
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }
  function fmtTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const z = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`;
  }

  // ── git.getRefs：刷新 refs + 下拉选择 ────
  let refs = $state([]);
  let refsErr = $state("");
  let refreshing = $state(false);
  async function refreshRefs() {
    const repoDir = resolveInput?.(id, "repoDir");
    if (!repoDir) { refsErr = "未连接文件夹输入"; return; }
    refreshing = true; refsErr = "";
    try {
      refs = await api("/api/git/refs", { method: "POST", body: JSON.stringify({ repoDir }) });
    } catch (e) {
      refsErr = e.message;
    } finally {
      refreshing = false;
    }
  }

  // ── 卡片错误：整卡红框描边 + stat 区错误行 ────
  let cardError = $derived.by(() => {
    if (meta?.pathStat) {
      const p = String(data?.path ?? "").trim();
      if (!p) return "";
      if (!pathValid) return "路径非法（需绝对路径或 ~ 开头）";
      if (statErr) return statErr;
      if (!stat) return "";
      if (!stat.exists) return "路径不存在";
      if (stat.isDir && isConnected?.(id, "file")) return "当前为文件夹，但 file 出口已有连线";
      if (!stat.isDir && isConnected?.(id, "dir")) return "当前为文件，但 dir 出口已有连线";
      return "";
    }
    if (meta?.refsPicker && refsErr) return refsErr;
    return "";
  });
</script>

<div class="devnode" class:selected class:onpath={onPath} class:error={!!cardError}>
  <div class="head" style="background:{color}">
    <span class="htitle">{meta?.title ?? data.__type}</span>
    <button class="del nodrag" title="删除节点" onclick={() => ondelete?.(id)}>✕</button>
  </div>
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
          {:else}
            <input class:winvalid={meta.pathStat && w.key === "path" && !pathValid}
              value={get(w.key) ?? ""} placeholder={w.placeholder ?? ""}
              oninput={e => set(w.key, e.target.value)} />
          {/if}
        </label>
      {/each}
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

    {#if meta?.pathStat}
      <div class="stat">
        {#if !String(get("path") ?? "").trim()}
          <span class="srow"><span>状态</span><b>未配置</b></span>
        {:else if !pathValid}
          <span class="srow"><span>状态</span><b class="bad">路径非法（需绝对路径或 ~ 开头）</b></span>
        {:else if statErr}
          <span class="srow"><span>状态</span><b class="bad">{statErr}</b></span>
        {:else}
          <span class="srow"><span>状态</span>
            <b class:bad={stat && !stat.exists}>{stat ? (stat.exists ? (stat.isDir ? "文件夹" : "文件") : "不存在") : "查询中…"}</b>
          </span>
          {#if stat?.exists}
            <span class="srow"><span>权限</span><b class="mono">{stat.mode}</b></span>
            <span class="srow"><span>大小</span><b>{stat.isDir ? "—" : fmtSize(stat.size)}</b></span>
            <span class="srow"><span>修改</span><b>{fmtTime(stat.mtime)}</b></span>
          {/if}
        {/if}
        {#if cardError}
          <span class="srow errline">⚠ {cardError}</span>
        {/if}
      </div>
    {/if}
  </div>
</div>
