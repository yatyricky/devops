<script>
  import { SvelteFlow, Background, Controls, MiniMap } from "@xyflow/svelte";
  import { api } from "./api.js";
  import { canConnect, effectiveInputs, genId } from "./types.js";
  import { ui } from "./store.svelte.js";
  import DevNode from "./DevNode.svelte";
  import Inspector from "./Inspector.svelte";
  import Palette from "./Palette.svelte";
  import LogDrawer from "./LogDrawer.svelte";

  // ── 全局状态 ────
  let metas = $state([]);
  let wfList = $state([]);
  let currentPath = $state("");
  let name = $state(""), title = $state(""), repoDir = $state("");
  let nodes = $state([]), edges = $state([]), tasks = $state({});
  let dirty = $state(false);
  let selectedId = $state(null);
  let toast = $state("");
  let busyText = $state("空闲");
  let hoverPath = $state(/** @type {string[] | null} */ (null));

  let ignoreDirtyUntil = 0;
  let definer = $state(/** @type {{ path: string[], name: string, label: string, mutates: boolean } | null} */ (null));
  let runModal = $state(/** @type {{ task: string, label: string, mutates: boolean, inputs: {name:string,label:string,fallback:string,value:string}[], dryRun: boolean, needProd: boolean, prodVal: string } | null} */(null));
  let openModal = $state(/** @type {{ mode: "open" | "new", path: string, name: string, title: string } | null} */(null));
  let logRef = $state(null);

  const typeMap = $derived(ui.nodeTypesMap);
  const components = $derived(Object.fromEntries(Object.keys(typeMap).map(t => [t, DevNode])));
  let selectedNode = $derived(nodes.find(n => n.id === selectedId) ?? null);
  let selectedMeta = $derived(selectedNode ? typeMap[selectedNode.type] : null);
  let currentEntry = $derived(wfList.find(w => w.path === currentPath));

  function showToast(msg) { toast = msg; setTimeout(() => (toast = ""), 3000); }

  // ── 初始化 ────
  $effect(() => { (async () => {
    metas = await api("/api/node-types");
    ui.nodeTypesMap = Object.fromEntries(metas.map(m => [m.type, m]));
    wfList = await api("/api/workflows");
    const first = wfList.find(w => w.name);
    if (first) await selectWorkflow(first.path);
  })(); });

  const busyTimer = setInterval(async () => {
    try {
      const cur = await api("/api/current");
      busyText = cur ? `运行中: ${cur.app}/${cur.task}` : "空闲";
    } catch { /* 静默 */ }
  }, 5000);

  // ── 工作流加载/保存 ────
  async function selectWorkflow(fp) {
    const { doc } = await api("/api/workflows/open", { method: "POST", body: JSON.stringify({ path: fp }) });
    loadDoc(fp, doc);
    wfList = await api("/api/workflows");
    dirty = false;
  }
  function loadDoc(fp, doc) {
    currentPath = fp;
    name = doc.name; title = doc.title ?? doc.name; repoDir = doc.repoDir ?? "";
    nodes = (doc.nodes ?? []).map(n => ({
      id: n.id, type: n.type,
      position: { x: n.position[0], y: n.position[1] },
      data: { ...n.data, __type: n.type },
    }));
    edges = (doc.edges ?? []).map(e => ({ ...e, animated: true }));
    tasks = doc.tasks ?? {};
    selectedId = null; hoverPath = null; definer = null;
    ignoreDirtyUntil = Date.now() + 1000;
  }
  function toDoc() {
    return {
      name, title, version: 1, repoDir,
      nodes: nodes.map(n => ({ id: n.id, type: n.type, position: [Math.round(n.position.x), Math.round(n.position.y)], data: stripDecor(n.data) })),
      edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle })),
      tasks: JSON.parse(JSON.stringify(tasks)),
    };
  }
  function stripDecor(data) {
    return Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith("__")));
  }
  async function save() {
    try {
      await api("/api/workflows/save", { method: "POST", body: JSON.stringify({ path: currentPath, doc: toDoc() }) });
      dirty = false;
      showToast("已保存");
      wfList = await api("/api/workflows");
    } catch (e) { showToast(`保存失败：${e.message}`); }
  }
  async function doOpen() {
    try {
      const { path: fp } = openModal;
      if (openModal.mode === "new") {
        const doc = {
          name: openModal.name, title: openModal.title || openModal.name, version: 1, repoDir: "",
          nodes: [
            { id: "env1", type: "env.file", position: [80, 200], data: { envFile: `${openModal.name}.env`, schema: {} } },
            { id: "ssh1", type: "ssh.session", position: [340, 200], data: {} },
          ],
          edges: [{ id: "e1", source: "env1", sourceHandle: "env", target: "ssh1", targetHandle: "env" }],
          tasks: {},
        };
        await api("/api/workflows/save", { method: "POST", body: JSON.stringify({ path: fp, doc }) });
      } else {
        await api("/api/workflows/open", { method: "POST", body: JSON.stringify({ path: fp }) });
      }
      openModal = null;
      await selectWorkflow(fp);
    } catch (e) { showToast(e.message); }
  }

  // ── 画布操作 ────
  function addNode(meta) {
    const data = { __type: meta.type };
    for (const w of meta.widgets) data[w.key] = w.default ?? (w.kind === "boolean" ? true : "");
    const id = genId(meta.type.split(".")[1] ?? "n");
    nodes = [...nodes, { id, type: meta.type, position: { x: 120 + (nodes.length % 6) * 40, y: 120 + Math.floor(nodes.length / 6) * 60 }, data }];
    dirty = true;
  }
  function onData(key, value) {
    if (!selectedNode) return;
    const nextData = { ...selectedNode.data, [key]: value };
    // 动态插槽变更 → 清理指向已消失 handle 的边
    const meta = typeMap[selectedNode.type];
    const valid = new Set(effectiveInputs(meta, nextData).map(i => i.id));
    const kept = edges.filter(e => e.target !== selectedNode.id || valid.has(e.targetHandle));
    nodes = nodes.map(n => (n.id === selectedNode.id ? { ...n, data: nextData } : n));
    if (kept.length !== edges.length) edges = kept;
    dirty = true;
  }
  function deleteNode(id) {
    nodes = nodes.filter(n => n.id !== id);
    edges = edges.filter(e => e.source !== id && e.target !== id);
    if (selectedId === id) selectedId = null;
    dirty = true;
  }
  /** @param {{ event: any, node: any }} m */
  function onNodeClick({ node }) {
    if (!node) return;
    if (definer) {
      if (!definer.path.includes(node.id)) definer.path = [...definer.path, node.id];
      return;
    }
    selectedId = node.id;
  }
  /** @param {any} p 连线参数 */
  function onConnect(p) {
    const src = nodes.find(n => n.id === p.source), tgt = nodes.find(n => n.id === p.target);
    if (!src || !tgt || src === tgt) return;
    const sMeta = typeMap[src.type], tMeta = typeMap[tgt.type];
    if (!sMeta || !tMeta) return;
    const outs = sMeta.outputs ?? [];
    const o = (p.sourceHandle ? outs.find(x => x.id === p.sourceHandle) : outs[0]) ?? outs[0];
    const inps = effectiveInputs(tMeta, tgt.data);
    const i = p.targetHandle ? inps.find(x => x.id === p.targetHandle) : inps[0];
    if (!o || !i) return;
    if (!canConnect(o.type, i.type)) { showToast(`类型不兼容：${o.type} → ${i.type}`); return; }
    if (edges.some(e => e.target === tgt.id && e.targetHandle === i.id)) { showToast(`输入 ${tgt.id}.${i.id} 已有连线`); return; }
    edges = [...edges, { id: genId("e"), source: p.source, target: p.target, sourceHandle: o.id, targetHandle: i.id, animated: true }];
    dirty = true;
  }
  function onNodesDelete() { dirty = true; }
  function onEdgesDelete() { dirty = true; }
  function onMoveEnd() { if (Date.now() > ignoreDirtyUntil) dirty = true; }

  // ── 路径高亮（悬停任务 / 定义任务）────
  let activePath = $derived(hoverPath ?? (definer ? definer.path : null));
  $effect(() => {
    const p = activePath ?? [];
    ui.pathHighlight = Object.fromEntries(p.map((id, i) => [id, i + 1]));
  });

  // ── 任务运行 ────
  function openRun(taskName) {
    const t = tasks[taskName];
    // 收集运行时输入：全图的 task.input 节点（含经依赖闭包自动执行的侧挂节点）
    const inputNodes = nodes.filter(n => n.type === "task.input");
    runModal = {
      task: taskName, label: t.label ?? taskName, mutates: !!t.mutates,
      inputs: inputNodes.map(n => ({ name: n.data.name, label: n.data.label || n.data.name, fallback: n.data.fallback ?? "", value: "" })),
      dryRun: false,
      needProd: !!t.mutates && currentEntry?.serverType === "prod",
      prodVal: "",
    };
  }
  async function doRun() {
    const m = runModal;
    if (m.needProd && !m.dryRun && m.prodVal !== name) { showToast(`需输入工作流名 "${name}" 确认`); return; }
    const inputs = Object.fromEntries(m.inputs.map(i => [i.name, i.value || i.fallback]).filter(([, v]) => v !== ""));
    try {
      const { id } = await api("/api/jobs", { method: "POST", body: JSON.stringify({
        workflow: currentPath, task: m.task, dryRun: m.dryRun, inputs,
        ...(m.needProd && !m.dryRun ? { confirmProd: m.prodVal } : {}),
      }) });
      runModal = null;
      await logRef?.follow(id, `${name}/${m.task}${m.dryRun ? " (dry-run)" : ""}`);
    } catch (e) { showToast(e.message); }
  }

  function saveDefinedTask() {
    if (!definer?.name || definer.path.length < 1) { showToast("任务名必填"); return; }
    tasks[definer.name] = { label: definer.label || definer.name, mutates: definer.mutates, path: [...definer.path] };
    definer = null;
    dirty = true;
  }
  function deleteTask(n) { delete tasks[n]; dirty = true; }

  // token
  let tokenVal = $state(localStorage.getItem("devops-token") ?? "");
  function tokenChange() { localStorage.setItem("devops-token", tokenVal.trim()); }

  // 调试钩子（生产亦无害，只读）
  $effect(() => { window.__dbg = { get nodes() { return nodes; }, get edges() { return edges; }, get tasks() { return tasks; } }; });
</script>

<div class="layout">
  <header>
    <h1>DevOps 控制台</h1>
    <select class="wfsel" value={currentPath} onchange={e => selectWorkflow(e.target.value)}>
      {#each wfList as w (w.path)}
        <option value={w.path}>{w.error ? `✗ ${w.path}` : `${w.name}${w.serverType === "prod" ? " ⚠PROD" : ""}`}</option>
      {/each}
    </select>
    <button onclick={() => (openModal = { mode: "open", path: "", name: "", title: "" })}>打开…</button>
    <button onclick={() => (openModal = { mode: "new", path: "", name: "", title: "" })}>新建…</button>
    <button class="primary" disabled={!dirty} onclick={save}>{dirty ? "保存 *" : "保存"}</button>
    <span class="badge">{busyText}</span>
    <input class="token" type="password" placeholder="token" bind:value={tokenVal} onchange={tokenChange} />
    {#if toast}<span class="toast">{toast}</span>{/if}
  </header>

  <div class="taskbar">
    <span class="wfmeta">
      <input style="width:110px" placeholder="name" bind:value={name} onchange={() => (dirty = true)} />
      <input style="width:150px" placeholder="标题" bind:value={title} onchange={() => (dirty = true)} />
      <input style="width:260px" placeholder="应用仓库 repoDir" bind:value={repoDir} onchange={() => (dirty = true)} />
    </span>
    <span class="sep"></span>
    {#each Object.entries(tasks) as [tn, t] (tn)}
      <button class:onpath-btn={hoverPath === t.path}
        onmouseenter={() => (hoverPath = t.path)} onmouseleave={() => (hoverPath = null)}
        onclick={() => openRun(tn)}>
        {t.label ?? tn}{t.mutates ? " ⚠" : ""}
      </button>
      <button class="danger mini" title="删除任务" onclick={() => deleteTask(tn)}>✕</button>
    {/each}
    <button class="define" class:active={!!definer} onclick={() => (definer = definer ? null : { path: [], name: "", label: "", mutates: true })}>
      {definer ? "取消定义" : "定义任务"}
    </button>
  </div>

  <div class="main">
    <Palette {metas} onadd={addNode} />
    <div class="canvas">
      <SvelteFlow
        bind:nodes bind:edges
        nodeTypes={components}
        onnodeclick={onNodeClick}
        onconnect={onConnect}
        onnodesdelete={onNodesDelete}
        onedgesdelete={onEdgesDelete}
        onmoveend={onMoveEnd}
        fitView
        minZoom={0.15} maxZoom={2}
        connectionRadius={22}
      >
        <Background />
        <Controls />
        <MiniMap nodeColor={n => typeMap[n.type]?.color ?? "#8a97a8"} pannable zoomable />
      </SvelteFlow>

      {#if definer}
        <div class="definer">
          <b>定义任务</b>：按执行顺序点击节点（当前 {definer.path.length} 个）
          <div class="chips">
            {#each definer.path as id, i (id)}<span class="badge">{i + 1}. {id}</span>{/each}
          </div>
          <div class="row">
            <input placeholder="任务名(英文)" bind:value={definer.name} />
            <input placeholder="显示名" bind:value={definer.label} />
            <label class="mut"><input type="checkbox" bind:checked={definer.mutates} /> 变更类</label>
            <button class="primary" onclick={saveDefinedTask}>保存任务</button>
          </div>
        </div>
      {/if}
    </div>
    <aside class="right">
      <Inspector node={selectedNode} meta={selectedMeta} ondata={onData} ondelete={deleteNode} />
    </aside>
  </div>

  <LogDrawer bind:this={logRef} />
</div>

{#if openModal}
  <div class="overlay" role="presentation" onclick={e => { if (e.target === e.currentTarget) openModal = null; }}>
    <div class="modal">
      <h3>{openModal.mode === "new" ? "新建工作流" : "打开工作流"}</h3>
      {#if openModal.mode === "new"}
        <label>工作流名（英文）<input bind:value={openModal.name} placeholder="my-app" /></label>
        <label>标题<input bind:value={openModal.title} placeholder="显示名" /></label>
      {/if}
      <label>JSON 文件完整路径（可在磁盘任意位置）<input class="mono" bind:value={openModal.path} placeholder="C:/Users/yatyr/workspace/devops/workflows/my-app.json" /></label>
      <div class="row">
        <button class="primary" onclick={doOpen}>{openModal.mode === "new" ? "创建" : "打开"}</button>
        <button onclick={() => (openModal = null)}>取消</button>
      </div>
    </div>
  </div>
{/if}

{#if runModal}
  <div class="overlay" role="presentation" onclick={e => { if (e.target === e.currentTarget) runModal = null; }}>
    <div class="modal">
      <h3>运行 {runModal.label}</h3>
      {#if runModal.inputs.length}
        {#each runModal.inputs as inp, i (inp.name)}
          <label>{inp.label || inp.name}<input bind:value={runModal.inputs[i].value} placeholder={inp.fallback || ""} /></label>
        {/each}
      {:else}
        <div class="dim">（无运行时输入）</div>
      {/if}
      <label class="mut"><input type="checkbox" bind:checked={runModal.dryRun} /> dry-run（只打印计划，不产生副作用）</label>
      {#if runModal.needProd && !runModal.dryRun}
        <label style="color:var(--err)">PROD：输入工作流名 <b>{name}</b> 确认<input bind:value={runModal.prodVal} placeholder={name} /></label>
      {/if}
      <div class="row">
        <button class="primary" onclick={doRun}>运行</button>
        <button onclick={() => (runModal = null)}>取消</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .layout { display: flex; flex-direction: column; height: 100%; }
  header { display: flex; align-items: center; gap: 8px; padding: 8px 14px; background: var(--panel); border-bottom: 1px solid var(--line); }
  header h1 { font-size: 15px; margin: 0 8px 0 0; }
  .wfsel { max-width: 260px; }
  .token { width: 120px; margin-left: auto; }
  .toast { position: absolute; top: 48px; left: 50%; transform: translateX(-50%); background: var(--panel2);
    border: 1px solid var(--err); color: var(--err); padding: 6px 14px; border-radius: 8px; z-index: 60; }
  .taskbar { display: flex; align-items: center; gap: 6px; padding: 6px 14px; background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .wfmeta { display: flex; gap: 6px; }
  .sep { width: 1px; height: 20px; background: var(--line); margin: 0 4px; }
  .onpath-btn { border-color: var(--warn); }
  .define { margin-left: auto; }
  .define.active { border-color: var(--warn); color: var(--warn); }
  .mini { padding: 2px 7px; font-size: 11px; }
  .main { flex: 1; display: flex; min-height: 0; }
  .canvas { flex: 1; position: relative; min-width: 0; }
  .right { width: 300px; flex: none; border-left: 1px solid var(--line); background: var(--panel); overflow-y: auto; }
  .definer { position: absolute; top: 12px; left: 12px; right: 12px; z-index: 10; background: var(--panel);
    border: 1px solid var(--warn); border-radius: 10px; padding: 10px 14px; font-size: 13px; }
  .definer .chips { margin: 6px 0; display: flex; flex-wrap: wrap; gap: 4px; }
  .definer .row { display: flex; gap: 6px; align-items: center; }
  .definer .row input { width: auto; flex: 1; }
  .mut { display: flex; gap: 6px; align-items: center; font-size: 13px; }
  .mut input { width: auto; }
  .overlay { position: fixed; inset: 0; background: rgba(4, 8, 14, .66); display: flex; align-items: center; justify-content: center; z-index: 50; }
  .modal { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; width: min(520px, 92vw); }
  .modal h3 { margin: 0 0 10px; font-size: 15px; }
  .modal label { display: block; margin: 8px 0; font-size: 13px; }
  .modal label input[type="text"], .modal label input:not([type]) { display: block; margin-top: 3px; }
  .modal .row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
  .dim { color: var(--dim); font-size: 12px; }
  .mono { font-family: Consolas, monospace; }
</style>
