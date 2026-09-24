<script>
  import { getContext, setContext } from "svelte";
  import { SvelteFlow, Background, Controls, MiniMap } from "@xyflow/svelte";
  import { api } from "./api.js";
  import { canConnect, effectiveInputs, genId, validateTaskSelection } from "./types.js";
  import { ui } from "./store.svelte.js";
  import DevNode from "./DevNode.svelte";
  import Palette from "./Palette.svelte";
  import LogDrawer from "./LogDrawer.svelte";

  // ── 全局状态 ────
  let metas = $state([]);
  let wfList = $state([]);
  let currentPath = $state("");
  let name = $state(""), title = $state(""), repoDir = $state("");
  let nodes = $state([]), edges = $state([]), tasks = $state({});
  let dirty = $state(false);
  let toast = $state("");
  let busyText = $state("空闲");

  let ignoreDirtyUntil = 0;
  let definer = $state(/** @type {{ nodes: string[], name: string, label: string, mutates: boolean, problems: string[] } | null} */ (null));
  let hoverTask = $state(/** @type {string | null} */ (null));
  let runModal = $state(/** @type {{ task: string, label: string, mutates: boolean, inputs: {name:string,label:string,fallback:string,value:string}[], dryRun: boolean, needProd: boolean, prodVal: string } | null} */(null));
  let openModal = $state(/** @type {{ mode: "open" | "new", path: string, name: string, title: string } | null} */(null));
  let logRef = $state(null);

  const typeMap = $derived(ui.nodeTypesMap);
  const components = $derived(Object.fromEntries(Object.keys(typeMap).map(t => [t, DevNode])));
  let currentEntry = $derived(wfList.find(w => w.path === currentPath));
  let selectedNodeIds = $derived(new Set(nodes.filter(n => n.selected).map(n => n.id)));

  // 节点卡片经 context 拿编辑/删除回调与连线查询（xyflow 自建组件树，props 传不进节点组件）
  setContext("devnode-actions", {
    ondata: onData,
    ondelete: deleteNode,
    isConnected(nodeId, handleId) {
      return edges.some(e => e.source === nodeId && e.sourceHandle === handleId);
    },
    /** 编辑期解析某输入连线的当前值：源节点按 outputValueKey（缺省 sourceHandle 名）取 data 字段 */
    resolveInput(nodeId, handleId) {
      const e = edges.find(e => e.target === nodeId && e.targetHandle === handleId);
      if (!e) return undefined;
      const src = nodes.find(n => n.id === e.source);
      if (!src) return undefined;
      const key = typeMap[src.type]?.outputValueKey ?? e.sourceHandle;
      return src.data?.[key];
    },
  });

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
    edges = (doc.edges ?? []).map(e => ({ ...e, ...(e.kind === "seq" ? { class: "seq" } : {}) }));
    tasks = doc.tasks ?? {};
    hoverTask = null; definer = null;
    ignoreDirtyUntil = Date.now() + 1000;
  }
  function toDoc() {
    return {
      name, title, version: 1, repoDir,
      nodes: nodes.map(n => ({ id: n.id, type: n.type, position: [Math.round(n.position.x), Math.round(n.position.y)], data: stripDecor(n.data) })),
      edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, ...(e.kind ? { kind: e.kind } : {}) })),
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
  /** @param {string} nodeId @param {string} key @param {any} value 卡片编辑 → 更新节点 data；动态插槽变更时清理失效边 */
  function onData(nodeId, key, value) {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;
    const nextData = { ...node.data, [key]: value };
    const meta = typeMap[node.type];
    const valid = new Set(effectiveInputs(meta, nextData).map(i => i.id));
    const kept = edges.filter(e => e.target !== node.id || valid.has(e.targetHandle));
    nodes = nodes.map(n => (n.id === nodeId ? { ...n, data: nextData } : n));
    if (kept.length !== edges.length) edges = kept;
    dirty = true;
  }
  function deleteNode(id) {
    nodes = nodes.filter(n => n.id !== id);
    edges = edges.filter(e => e.source !== id && e.target !== id);
    dirty = true;
  }
  /** @param {{ event: any, node: any }} m 定义任务模式下点选节点（切换选入/移出，顺序无关）；其余选中交给 xyflow */
  function onNodeClick({ node }) {
    if (!node || !definer) return;
    definer.nodes = definer.nodes.includes(node.id)
      ? definer.nodes.filter(x => x !== node.id)
      : [...definer.nodes, node.id];
    definer.problems = validateTaskSelection(definer.nodes, edges, nodeByIdMap, typeMap);
  }

  /** id → 节点（画布态，含 data.__type） */
  const nodeByIdMap = $derived(new Map(nodes.map(n => [n.id, n])));
  /** @param {any} p 连线参数 */
  function onConnect(p) {
    const src = nodes.find(n => n.id === p.source), tgt = nodes.find(n => n.id === p.target);
    if (!src || !tgt || src === tgt) return;
    // 顺序边：无类型语义，只查重
    if (p.sourceHandle === "__seqOut" && p.targetHandle === "__seqIn") {
      if (edges.some(e => e.kind === "seq" && e.source === p.source && e.target === p.target)) { showToast("顺序连线已存在"); return; }
      edges = [...edges, { id: genId("e"), source: p.source, target: p.target, sourceHandle: "__seqOut", targetHandle: "__seqIn", kind: "seq", class: "seq" }];
      dirty = true;
      return;
    }
    const sMeta = typeMap[src.type], tMeta = typeMap[tgt.type];
    if (!sMeta || !tMeta) return;
    const outs = sMeta.outputs ?? [];
    const o = (p.sourceHandle ? outs.find(x => x.id === p.sourceHandle) : outs[0]) ?? outs[0];
    const inps = effectiveInputs(tMeta, tgt.data);
    const i = p.targetHandle ? inps.find(x => x.id === p.targetHandle) : inps[0];
    if (!o || !i) return;
    if (!canConnect(o.type, i.type)) { showToast(`类型不兼容：${o.type} → ${i.type}`); return; }
    // 大图允许同一输入接多条备选连线（不同任务各取其一）；唯一性在任务定义时校验
    edges = [...edges, { id: genId("e"), source: p.source, target: p.target, sourceHandle: o.id, targetHandle: i.id }];
    dirty = true;
  }
  /** @param {{ nodes: any[], edges: any[] }} m xyflow 内置删除键（DEL/Backspace）触发 */
  function onDelete({ nodes: delNodes, edges: delEdges }) {
    if (delNodes.length || delEdges.length) dirty = true;
  }
  function onMoveEnd() { if (Date.now() > ignoreDirtyUntil) dirty = true; }

  // ── 任务子图高亮（悬停任务 / 定义任务）：集合语义，id → true ────
  let activeSet = $derived.by(() => {
    if (hoverTask) return tasks[hoverTask]?.nodes ?? tasks[hoverTask]?.path ?? null;
    if (definer) return definer.nodes;
    return null;
  });
  $effect(() => {
    const p = activeSet ?? [];
    ui.pathHighlight = Object.fromEntries(p.map(id => [id, true]));
  });

  // 连线动画跟随选中：仅与选中节点相连（或被选中）的数据边播放虚线动画；顺序边恒为静态。
  // EdgeWrapper 只响应 edge 对象引用变化，因此必须整组替换对象，不能就地改属性。
  $effect(() => {
    const anim = e => e.kind !== "seq" && (selectedNodeIds.has(e.source) || selectedNodeIds.has(e.target) || !!e.selected);
    if (edges.some(e => !!e.animated !== anim(e))) {
      edges = edges.map(e => ({ ...e, animated: anim(e) }));
    }
  });

  // ── 任务运行 ────
  function openRun(taskName) {
    const t = tasks[taskName];
    const sel = new Set(t.nodes ?? t.path ?? []);
    // 收集运行时输入：任务选中的 task.input 节点
    const inputNodes = nodes.filter(n => n.type === "task.input" && sel.has(n.id));
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
    if (!definer?.name) { showToast("任务名必填"); return; }
    const problems = validateTaskSelection(definer.nodes, edges, nodeByIdMap, typeMap);
    if (problems.length) { definer.problems = problems; return; }
    tasks[definer.name] = { label: definer.label || definer.name, mutates: definer.mutates, nodes: [...definer.nodes] };
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
      <button class:onpath-btn={hoverTask === tn}
        onmouseenter={() => (hoverTask = tn)} onmouseleave={() => (hoverTask = null)}
        onclick={() => openRun(tn)}>
        {t.label ?? tn}{t.mutates ? " ⚠" : ""}
      </button>
      <button class="danger mini" title="删除任务" onclick={() => deleteTask(tn)}>✕</button>
    {/each}
    <button class="define" class:active={!!definer} onclick={() => (definer = definer ? null : { nodes: [], name: "", label: "", mutates: true, problems: [] })}>
      {definer ? "取消定义" : "定义任务"}
    </button>
  </div>

  <div class="main">
    <div class="canvas">
      <SvelteFlow
        bind:nodes bind:edges
        nodeTypes={components}
        onnodeclick={onNodeClick}
        onconnect={onConnect}
        ondelete={onDelete}
        deleteKey={["Backspace", "Delete"]}
        onmoveend={onMoveEnd}
        fitView
        minZoom={0.15} maxZoom={2}
        connectionRadius={22}
      >
        <Background />
        <Controls />
        <MiniMap nodeColor={n => typeMap[n.type]?.color ?? "#8a97a8"} pannable zoomable />
      </SvelteFlow>

      <Palette {metas} onadd={addNode} />

      {#if definer}
        <div class="definer">
          <b>定义任务</b>：点选节点（顺序无关，将构成一个或多个 DAG 并发执行；当前 {definer.nodes.length} 个）
          <div class="chips">
            {#each definer.nodes as id (id)}<span class="badge mono">{id}</span>{/each}
          </div>
          {#if definer.problems?.length}
            <div class="defprobs">
              {#each definer.problems as p}<div>✗ {p}</div>{/each}
            </div>
          {/if}
          <div class="row">
            <input placeholder="任务名(英文)" bind:value={definer.name} />
            <input placeholder="显示名" bind:value={definer.label} />
            <label class="mut"><input type="checkbox" bind:checked={definer.mutates} /> 变更类</label>
            <button class="primary" onclick={saveDefinedTask}>保存任务</button>
          </div>
        </div>
      {/if}
    </div>
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
  .definer { position: absolute; top: 12px; left: 12px; right: 12px; z-index: 10; background: var(--panel);
    border: 1px solid var(--warn); border-radius: 10px; padding: 10px 14px; font-size: 13px; }
  .definer .chips { margin: 6px 0; display: flex; flex-wrap: wrap; gap: 4px; }
  .definer .defprobs { margin: 6px 0; color: var(--err); font-size: 12px; line-height: 1.6; }
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
