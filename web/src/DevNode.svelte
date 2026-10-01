<script>
  import { getContext } from "svelte";
  import { Handle, Position, useUpdateNodeInternals } from "@xyflow/svelte";
  import { TYPE_COLORS, effectiveInputs, effectiveOutputs, nodeTitle, portLabel, displayType, typeColorKey } from "./types.js";
  import { expandHomeLocal } from "./lib/infer.js";
  import { api } from "./api.js";
  import { ui } from "./store.svelte.js";
  import TriSwitch from "./TriSwitch.svelte";

  let { id, data, selected } = $props();
  // xyflow 自建组件树，props 传不进来；App 经 context 提供回调
  const { ondata, ondelete, isWiredAsTarget, getSourceNode, resolveInput, resolveInputs, resolveOutputs, resolveTplVars, inferOutput } = getContext("devnode-actions");
  const updateNodeInternals = useUpdateNodeInternals();

  let meta = $derived(ui.nodeTypesMap[data.__type]);
  let hl = $derived(ui.pathHighlight[id]);
  // ── 动态出口：structSplit 回溯上游字段定义（effectiveOutputs 同规则，经 context 由 App 提供图上下文） ────
  let outputs = $derived(resolveOutputs?.(id) ?? (meta?.outputs ?? []));
  // ── selector：有效输入口（开放口 in + 每条已接入边一个专用口），经 context 由 App 提供图上下文 ────
  let inputs = $derived(meta?.selectorInputs ? (resolveInputs?.(id) ?? []) : effectiveInputs(meta, data));
  let color = $derived(meta?.color ?? "#8a97a8");
  let onPath = $derived(hl === true);
  // ── 任务运行状态（卡片外框）：集外半透明灰；running 跑马灯 / ok 绿框 / failed 红框 ────
  let runSt = $derived(ui.nodeRunStatus?.[id]);
  let offTask = $derived(ui.runTaskNodes != null && !ui.runTaskNodes.has(id));

// 动态插槽（structSplit 出口 / {{}} 动态输入）增删 handle 时节点外框尺寸不变，
  // ResizeObserver 不触发 → 内部 handleBounds 不重测 → 指向新 handle 的边不渲染、
  // 也不发起新连接。必须在 handle 集变化后显式告知 Svelte Flow 重测。
  // 依赖必须基于【动态解析后】的 inputs/outputs（struct.split 的 meta.outputs 恒为空）。
  // 句柄集签名：只有端口集真正变化才重测（effect 只依赖 sig 字符串，打断
  // 「derived 重算 → rAF 重测 → xyflow 内部更新 → bind 写回」的反馈环——
  // 该环在大图上表现为每数秒一轮全量重渲染的巨卡）
  const handleSig = $derived(JSON.stringify([inputs.map(i => i.id), outputs.map(o => o.id)]));
  $effect(() => {
    if (!id || !handleSig) return;
    // 等新 Handle DOM 挂载完成后再重测（rAF 对齐渲染帧）
    requestAnimationFrame(() => updateNodeInternals(id));
  });


  // ── 端口字面量：string/number/boolean 输入的行内控件（连线优先，被连线时 disabled 显示来源值）────
  function getLit(h) { return data?.lit?.[h]; }
  /** @param {string} h @param {any} v 空/undefined = 清除字面量 */
  function setLit(h, v) {
    const next = { ...(data?.lit ?? {}) };
    if (v === undefined || v === "") delete next[h]; else next[h] = v;
    set("lit", next);
  }
  let litTimers = {};
  /** 行内手填防抖：oninput 即时响应，停止输入 300ms 后落 lit */
  function setLitDebounced(h, v) {
    clearTimeout(litTimers[h]);
    litTimers[h] = setTimeout(() => setLit(h, v), 300);
  }
  /** pair 端口识别：id 形如 pN.to → 返回同行的 pN.from 元信息；否则 null */
  function pairTo(inp) {
    if (!meta?.pairInputs || !inp.id.startsWith(meta.pairInputs.prefix)) return null;
    const last = meta.pairInputs.sub[meta.pairInputs.sub.length - 1].suffix;
    const m = inp.id.match(/^(.*)(\.(.+))$/);
    if (!m || m[3] !== last) return null;
    const fromId = m[1] + "." + meta.pairInputs.sub[0].suffix;
    const peer = inputs.find(x => x.id === fromId);
    return peer ? { id: inp.id, fromId } : null;
  }
  /** from 端口 → 同行 to 端口元信息 */
  function pairToOf(inp) {
    if (!meta?.pairInputs || !inp.id.startsWith(meta.pairInputs.prefix)) return null;
    const base = inp.id.slice(0, inp.id.lastIndexOf("."));
    const suffix = inp.id.slice(inp.id.lastIndexOf(".") + 1);
    if (suffix !== meta.pairInputs.sub[0].suffix) return null;
    const toId = base + "." + meta.pairInputs.sub[1].suffix;
    return inputs.find(x => x.id === toId) ? { id: toId } : null;
  }
  /** stage.copy：to 缺省值推断（root/from 可静态解 → 保持相对结构；root 外 → basename） */
  function inferStageTo(nodeId, fromInp, toInp) {
    const rootV = resolveInput?.(nodeId, "root");
    const fromV = resolveInput?.(nodeId, fromInp.id);
    if (rootV === undefined || fromV === undefined) return "";
    const rootR = expandHomeLocal(String(rootV)).replace(/\\/g, "/");
    const fromR = expandHomeLocal(String(fromV)).replace(/\\/g, "/");
    const base = fromR.slice(fromR.lastIndexOf("/") + 1);
    if (fromR === rootR || fromR.startsWith(rootR + "/")) {
      return fromR.slice(rootR.length + 1);
    }
    return base;
  }
  /** wired 时的来源值预览：一跳静态可解则显示，运行时产出显示占位 */
  function resolvePreview(inp) {
    const v = resolveInput?.(id, inp.id);
    return v === undefined || v === null || v === "" ? "（运行时）" : String(v);
  }

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
      ui.pickerFresh[id] = String(repoDir); // 记录新鲜键：运行前校验列表与当前输入一致
    } catch (e) {
      refsErr = e.message;
    } finally {
      refreshing = false;
    }
  }

  // ── 顶栏「刷新列表」一键触发：refreshTick +1 时各卡片刷自己的下拉 ────
  $effect(() => {
    const tick = ui.refreshTick;
    if (!tick || !id) return;
    if (meta?.refsPicker) refreshRefs();
    if (meta?.scriptsPicker) refreshScripts();
    if (meta?.sshAliasesPicker) refreshSshAliases();
  });

  // ── 渲染模板：编辑期现场解析模板文件 → {{VAR}} 动态端口 / 不可推导时 struct 口 + 推断输出路径 ────
  let tplErr = $state("");
  $effect(() => {
    if (!meta?.tplVars) return;
    // 依赖：path 端口的当前值（连线推断值 / 上游字面量 / 手填 lit）
    const pv = resolveInput?.(id, "path");
    const p = String(pv ?? getLit("path") ?? "").trim();
    if (!p) {
      tplErr = "";
      if ((get("varsList") ?? []).length) set("varsList", []);
      if (get("varsUnresolved")) { set("varsUnresolved", false); set("inferredOut", ""); }
      return;
    }
    if (pv === undefined) {
      // 路径不可推导（来源是运行时节点）：变量口降级为 struct 口，推断输出清空
      if ((get("varsList") ?? []).length) set("varsList", []);
      if (!get("varsUnresolved")) set("varsUnresolved", true);
      if (get("inferredOut")) set("inferredOut", "");
      return;
    }
    const t = setTimeout(() => {
      resolveTplVars?.(p).then(r => {
        tplErr = r?.error ?? "";
        const cur = get("varsList") ?? [];
        const vars = r?.vars ?? [];
        const same = vars.length === cur.length && vars.every((/** @type {string} */ v, /** @type {number} */ i) => v === cur[i]);
        if (!same) set("varsList", vars);
        if (get("varsUnresolved")) set("varsUnresolved", false);
        const inferred = r?.basename ? `.tmp/rendered-${id}-${r.basename}` : "";
        if (get("inferredOut") !== inferred) set("inferredOut", inferred);
      }).catch(e => { tplErr = e?.message ?? String(e); });
    }, 400);
    return () => clearTimeout(t);
  });

  // ── path.resolve：编辑期输出推断显示 ────
  let inferredOut = $state(undefined);
  $effect(() => {
    if (!meta?.outputInfer || !id) return;
    inferredOut = inferOutput?.(id);
  });

  // ── ssh.session：别名下拉手动刷新（读 ~/./.ssh/config，无需连线输入）────
  let sshAliases = $state([]);
  let sshResolved = $state(null);
  let sshErr = $state("");
  let sshRefreshing = $state(false);
  async function refreshSshAliases() {
    // 别名取值：alias 输入口（连线/手填）优先，回退 widget 手选
    const aliasWired = isWiredAsTarget?.(id, "alias");
    const aliasFromInput = aliasWired ? String(resolveInput?.(id, "alias") ?? "").trim() : "";
    const alias = aliasFromInput || String(get("alias") ?? "");
    sshRefreshing = true; sshErr = "";
    try {
      const r = await api("/api/ssh/aliases", { method: "POST", body: JSON.stringify({ alias }) });
      sshAliases = r.aliases ?? [];
      sshResolved = r.resolved ?? null;
      sshErr = r.resolved?.error ?? "";
      // 需求：输入驱动的别名若不在本地 config → 刷新即报错（不许静默直连）
      if (!sshErr && aliasFromInput && sshResolved && sshResolved.fromConfig === false) {
        sshErr = `别名 "${aliasFromInput}" 不在 ~/.ssh/config 中（刷新后未命中）`;
      }
      ui.pickerFresh[id] = aliasFromInput || alias;
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
      ui.pickerFresh[id] = p;
    } catch (e) {
      scriptsErr = e.message;
    } finally {
      scriptsRefreshing = false;
    }
  }

  // ── 卡片错误：整卡红框描边 ────
  let cardError = $derived.by(() => {
    if (meta?.refsPicker && refsErr) return refsErr;
    if (meta?.sshAliasesPicker && sshErr) return sshErr;
    return "";
  });

  // ── 节点备注：便笺按钮折叠展开，内容存 data.note 随图保存 ────
  let noteOpen = $state(false);
  let noteText = $derived(String(data?.note ?? "").trim());
  // ── 节点说明（ndesc）：灯泡单独开合；taskbar「说明」按钮全局开合（descAllTick 广播） ────
  let descOpen = $state(false);
  $effect(() => {
    if (ui.descAllTick === 0) return;
    descOpen = ui.descAllOpen;
  });
  // ── ssh.session：alias 输入口已连线（widget 下拉禁用显示所选） ────
  let aliasWired = $derived(isWiredAsTarget?.(id, "alias") ?? false);
  let aliasFromInput = $derived(aliasWired ? String(resolveInput?.(id, "alias") ?? "").trim() : "");

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
    <span class="htitle">{nodeTitle(meta, data)}</span>
    {#if meta?.desc}
      <button type="button" class="del bulb nodrag" class:on={descOpen} title={descOpen ? "收起说明" : "展开说明"} onclick={() => (descOpen = !descOpen)}>💡</button>
    {/if}
    <button class="del nodrag" title="删除节点" onclick={() => ondelete?.(id)}>{@render trash(11)}</button>
  </div>
  {#if meta?.desc && descOpen}<div class="ndesc">{meta.desc}</div>{/if}
    <div class="body nowheel">
    {#each inputs as inp (inp.id)}
      {#if pairTo(inp)}
        <!-- to 端口已合并进 from 行渲染 -->
      {:else}
      {@const toPeer = pairToOf(inp)}
      <div class="kv in {toPeer ? "pairrow" : ""}" title={inp.required ? `必填输入${inp.dynamic ? `：在对应控件里写 {{${inp.id}}} 生成` : ""}（可连线或直接填值）` : undefined}>
        <Handle id={inp.id} type="target" position={Position.Left} style="background:{TYPE_COLORS[typeColorKey(inp.type)]}; {toPeer ? "top:30%" : ""}" />
        <span class="lbl" title="{portLabel(inp)}{inp.required ? " · 必填：连线或直接填值" : ""}">{inp.id}<span style="color:{TYPE_COLORS[typeColorKey(inp.type)]}"> ({displayType(inp.type)}{inp.dynamic ? "⭑" : ""})</span>{#if inp.required}<span class="req" title="必填：连线或直接填值">*</span>{/if}</span>
        {#if !inp.fromField && (inp.type === "string" || inp.type === "number" || inp.type === "boolean")}
          {@const liveVal = ui.runNodeInputs?.[id]?.[inp.id]}
          {#if isWiredAsTarget?.(id, inp.id) && liveVal !== undefined && liveVal !== null && liveVal !== ""}
            <input class="inlit live nodrag" disabled title={String(liveVal)} value={liveVal} />
          {:else if isWiredAsTarget?.(id, inp.id)}
            <input class="inlit nodrag" disabled title={`值来自连线：${resolvePreview(inp)}`} value={resolvePreview(inp)} />
          {:else if inp.type === "boolean"}
            <span class="boolpair nodrag">
              <button type="button" class:lit={getLit(inp.id) === true} title="是" onclick={() => setLit(inp.id, true)}>是</button>
              <button type="button" class:lit={getLit(inp.id) === false} title="否" onclick={() => setLit(inp.id, false)}>否</button>
            </span>
          {:else}
            <input class="inlit nodrag" type={inp.type === "number" ? "number" : "text"}
              class:winvalid={inp.type === "number" && getLit(inp.id) !== undefined && !numOk(getLit(inp.id))}
              title={inp.type === "number" ? "数值" : "字符串"}
              value={getLit(inp.id) ?? ""}
              oninput={e => setLitDebounced(inp.id, inp.type === "number" ? (e.target.value === "" ? undefined : e.target.value) : e.target.value)}
              onchange={e => setLit(inp.id, inp.type === "number" ? (e.target.value === "" ? undefined : e.target.value) : e.target.value)} />
          {/if}
        {/if}
        {#if toPeer}
          {@const toInp = inputs.find(x => x.id === toPeer.id)}
          {@const toLive = ui.runNodeInputs?.[id]?.[toPeer.id]}
          {#if toLive !== undefined && toLive !== null && toLive !== ""}
            <input class="inlit live nodrag" disabled title={String(toLive)} value={toLive} />
          {:else}
            <input class="inlit nodrag" type="text" placeholder={inferStageTo(id, inp, toPeer)}
              value={getLit(toPeer.id) ?? ""}
              oninput={e => setLitDebounced(toPeer.id, e.target.value === "" ? undefined : e.target.value)}
              onchange={e => setLit(toPeer.id, e.target.value === "" ? undefined : e.target.value)} />
          {/if}
        {/if}
        {#if meta?.selectorInputs && /^in\d+$/.test(inp.id)}
          <!-- selector：radio 单选该路作为输出 -->
          <input type="radio" class="selradio nodrag" name="selradio-{id}" title="作为输出"
            checked={get("pick") === inp.id}
            onchange={() => set("pick", inp.id)} />
        {/if}
      </div>
      {/if}
    {/each}
    {#if outputs.length}
      <div class="sep"></div>
      {#each outputs as out (out.id)}
        <div class="kv out">
          <span class="lbl">{out.id}<span style="color:{TYPE_COLORS[typeColorKey(out.type)]}"> ({displayType(out.type)})</span></span>
          <Handle id={out.id} type="source" position={Position.Right} style="background:{TYPE_COLORS[typeColorKey(out.type)]}" />
        </div>
      {/each}
    {/if}
    <div class="kv ctl">
      <Handle id="__seqIn" type="target" position={Position.Left} style="background:#8a97a8" />
      <span class="lbl seqsym">顺序 ▸</span>
      <Handle id="__seqOut" type="source" position={Position.Right} style="background:#8a97a8" />
    </div>

    {#if meta?.sshAliasesPicker}
      <label class="wrow nodrag">
        <span class="wlab">SSH 别名（~/.ssh/config）{aliasWired ? "· 已选择输入" : ""}</span>
        <span class="trow">
          {#if aliasWired}
            <!-- 别名由输入口提供：下拉禁用并回显所选别名 -->
            <select disabled title="别名来自连线输入：{aliasFromInput}">
              <option>{aliasFromInput || "（输入未提供值）"}</option>
            </select>
          {:else}
            <select value={get("alias") ?? ""} onchange={e => { set("alias", e.target.value); refreshSshAliases(); }}>
              {#if !(get("alias") ?? "")}<option value="" disabled hidden>— 选择别名 —</option>{/if}
              {#if (get("alias") ?? "") && !sshAliases.includes(get("alias"))}
                <option value={get("alias")}>{get("alias")}（config 未命中，保留）</option>
              {/if}
              {#each sshAliases as a (a)}<option value={a}>{a}</option>{/each}
            </select>
          {/if}
          <button class="mini" disabled={sshRefreshing} onclick={refreshSshAliases}>{sshRefreshing ? "…" : "刷新"}</button>
        </span>
        {#if sshResolved && !sshResolved.error}
          <span class="kvline">→ {sshResolved.user}@{sshResolved.host}:{sshResolved.port}{sshResolved.identityFile ? `（${sshResolved.identityFile}）` : ""}{sshResolved.fromConfig ? "" : "（config 未命中，直连）"}</span>
        {/if}
        {#if sshErr}<span class="errline">⚠ {sshErr}</span>{/if}
      </label>
    {/if}

    {#if meta?.widgets?.length}
      <div class="sep"></div>
      {#each meta.widgets as w (w.key)}
        <label class="wrow nodrag">
          <span class="wlab">{w.label}{#if w.serializable}<span class="sbadge" title="可序列化：纯文本字面量，可直接入库或携带占位符">s</span>{/if}</span>
          {#if w.kind === "text"}
            <textarea rows="4" value={get(w.key) ?? ""} placeholder={w.placeholder ?? ""}
              oninput={e => set(w.key, e.target.value)}></textarea>
          {:else if w.kind === "boolean"}
            <TriSwitch value={get(w.key) ?? w.default} onchange={v => set(w.key, v)} />
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
                  <span class="badge mono">{item}<button type="button" class="rm" onclick={() => set(w.key, (get(w.key) ?? []).filter((_, j) => j !== i))}>✕</button></span>
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
          {:else if w.kind === "stepper"}
            <span class="trow stepper nodrag">
              <button type="button" onclick={() => set(w.key, Math.max(w.min ?? 1, Math.trunc(Number(get(w.key)) || (w.min ?? 1)) - 1))}>-</button>
              <input type="text" inputmode="numeric" class:winvalid={!numOk(get(w.key)) || Number(get(w.key)) < (w.min ?? 1) || Number(get(w.key)) > (w.max ?? Infinity)}
                value={get(w.key) ?? ""}
                onchange={e => set(w.key, numOk(e.target.value) ? Math.max(w.min ?? 1, Math.min(w.max ?? Infinity, Math.trunc(Number(e.target.value)))) : (w.default ?? 1))} />
              <button type="button" onclick={() => set(w.key, Math.min(w.max ?? Infinity, Math.trunc(Number(get(w.key)) || (w.min ?? 1)) + 1))}>+</button>
            </span>
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
                    <!-- 三态轨道开关：undefined 空轨 / false 滑块左(暗) / true 滑块右(亮)；点击循环 -->
                    <TriSwitch tri class="nodrag" value={f.value}
                      onchange={v => setField(w.key, i, "value", v)} />
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


    {#if meta?.tplVars}
      <label class="wrow nodrag">
        <span class="wlab">模板路径（手填或连线，变量端口自动生成）</span>
        {#if tplErr}<span class="errline">⚠ {tplErr}</span>{/if}
      </label>
    {/if}

    {#if meta?.outputInfer && inferredOut}
      <label class="wrow nodrag">
        <span class="wlab">输出（编辑期推断）</span>
        <span class="kvline">{inferredOut}</span>
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
  <div class="nidrow">
    <span class="nid nodrag" title="节点 id">{id}</span>
    <button class="notebtn nodrag" class:hasnote={!!noteText} title="备注" onclick={() => (noteOpen = !noteOpen)}>便笺</button>
  </div>
  {#if noteOpen}
    <div class="noterow nodrag nowheel">
      <textarea rows="2" value={noteText} placeholder="节点备注…" oninput={e => set("note", e.target.value)}></textarea>
    </div>
  {/if}
</div>
