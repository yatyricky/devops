<script>
  import { getContext, setContext } from "svelte";
  import { SvelteFlow, Background, Controls, MiniMap } from "@xyflow/svelte";
  import { api } from "./api.js";
  import { canConnect, effectiveInputs, effectiveOutputs, genId, validateTaskSelection } from "./types.js";
  import { ui } from "./store.svelte.js";
  import DevNode from "./DevNode.svelte";
  import Palette from "./Palette.svelte";
  import LogDrawer from "./LogDrawer.svelte";

  // ── 全局状态 ────
  let metas = $state([]);
  let wfList = $state([]);
  let currentPath = $state("");
  let title = $state("");          // 显示名（工作流唯一可编辑标识；文件路径即身份）
  let docRepoDir = $state("");     // 透传字段：旧文档里的 repoDir 原样保留，不再提供编辑框
  let displayName = $derived(title || (currentPath ? currentPath.split(/[\\/]/).pop().replace(/\.json$/i, "") : ""));
  let nodes = $state([]), edges = $state([]), tasks = $state({});
  let autoDirty = $state(false);   // 关键变更未落盘（自动写盘管）
  let layoutDirty = $state(false); // 布局（节点位置）未保存（手动"保存"管）
  let dirty = $derived(autoDirty || layoutDirty);
  let toast = $state("");
  let busyText = $state("空闲");

  let ignoreDirtyUntil = 0;
  let definer = $state(/** @type {{ nodes: string[], name: string, label: string, mutates: boolean, problems: string[] } | null} */ (null));
  let hoverTask = $state(/** @type {string | null} */ (null));
  let runModal = $state(/** @type {{ task: string, label: string, mutates: boolean, inputs: {name:string,label:string,fallback:string,value:string}[], dryRun: boolean, needProd: boolean, prodVal: string } | null} */(null));
  let openModal = $state(/** @type {{ mode: "open" | "new", path: string, title: string } | null} */(null));
  let logRef = $state(null);

  const typeMap = $derived(ui.nodeTypesMap);
  const components = $derived(Object.fromEntries(Object.keys(typeMap).map(t => [t, DevNode])));
  let currentEntry = $derived(wfList.find(w => w.path === currentPath));
  let selectedNodeIds = $derived(new Set(nodes.filter(n => n.selected).map(n => n.id)));

  // 节点卡片经 context 拿编辑/删除回调与连线查询（xyflow 自建组件树，props 传不进节点组件）
  setContext("devnode-actions", {
    ondata: onData,
    ondelete: deleteNode,
    /** 某输入口是否已连线（struct 字段口连线时隐藏手填控件） */
    isWiredAsTarget(nodeId, handleId) {
      return edges.some(e => e.kind !== "seq" && e.target === nodeId && e.targetHandle === handleId);
    },
    /** 某输入口的连线源节点（struct.split 回溯上游字段定义用） */
    getSourceNode(nodeId, handleId) {
      const e = edges.find(e => e.kind !== "seq" && e.target === nodeId && e.targetHandle === handleId);
      return nodes.find(n => n.id === e?.source);
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
    autoDirty = false; layoutDirty = false;
  }
  function loadDoc(fp, doc) {
    currentPath = fp;
    title = doc.title ?? doc.name ?? fp.split(/[\\/]/).pop().replace(/\.json$/i, "");
    docRepoDir = doc.repoDir ?? "";
    nodes = (doc.nodes ?? []).map(n => ({
      id: n.id, type: n.type,
      position: { x: n.position[0], y: n.position[1] },
      data: { ...n.data, __type: n.type },
    }));
    // 存量数据修复：历史版本会在连线时产生同四元组重复边（库自动加边 + 旧代码手动加边），这里去重
    const seen = new Set();
    edges = (doc.edges ?? []).filter(e => {
      const k = `${e.source}|${e.sourceHandle ?? ""}|${e.target}|${e.targetHandle ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).map(e => ({ ...e, ...(e.kind === "seq" ? { class: "seq" } : {}) }));
    tasks = doc.tasks ?? {};
    hoverTask = null; definer = null;
    ui.runTaskNodes = null; ui.nodeRunStatus = null;
    ignoreDirtyUntil = Date.now() + 1000;
  }
  function toDoc() {
    return {
      ...(title ? { title } : {}),
      version: 1,
      ...(docRepoDir ? { repoDir: docRepoDir } : {}),
      nodes: nodes.map(n => ({ id: n.id, type: n.type, position: [Math.round(n.position.x), Math.round(n.position.y)], data: stripDecor(n.data) })),
      edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, ...(e.kind ? { kind: e.kind } : {}) })),
      tasks: JSON.parse(JSON.stringify(tasks)),
    };
  }
  function stripDecor(data) {
    return Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith("__")));
  }
  // ── 保存：关键变更（serializable 编辑 / node·edge·tasks 增删改）自动写盘（防抖）；
  //    节点位置等展示信息仍依赖手动保存（layoutDirty）。 ────
  let autoSaveTimer = null;
  /** @param {boolean} [silent] 自动保存静默（不 toast）；布局脏不由自动保存清除 */
  async function save(silent = false) {
    clearTimeout(autoSaveTimer);
    try {
      await api("/api/workflows/save", { method: "POST", body: JSON.stringify({ path: currentPath, doc: toDoc() }) });
      autoDirty = false;
      if (!silent) showToast("已保存");
      wfList = await api("/api/workflows");
    } catch (e) { showToast(`保存失败：${e.message}`); }
  }
  /** 关键变更标脏 + 防抖自动写盘（600ms 合并连续编辑） */
  function markCritical() {
    autoDirty = true;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => save(true), 600);
  }
  async function doOpen() {
    try {
      const { path: fp } = openModal;
      if (openModal.mode === "new") {
        const doc = {
          ...(openModal.title ? { title: openModal.title } : {}),
          version: 1,
          nodes: [
            { id: "ssh1", type: "ssh.session", position: [80, 200], data: {} },
          ],
          edges: [],
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
    markCritical();
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
    markCritical();
  }
  function deleteNode(id) {
    nodes = nodes.filter(n => n.id !== id);
    edges = edges.filter(e => e.source !== id && e.target !== id);
    markCritical();
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

  /**
   * 连线裁决：null = 可连；否则返回拒绝原因（isValidConnection 与 connectend 提示共用）。
   * Svelte Flow 拖拽中实时调用 isValidConnection（高频、不可 toast）；拖放落在目标 handle
   * 上但被拒时由 onConnectEnd 弹出原因。
   * @param {any} p connection { source, target, sourceHandle, targetHandle }
   * @returns {string | null}
   */
  function connectionRejectReason(p) {
    if (!p?.source || !p?.target) return "连线不完整";
    if (p.source === p.target) return "不能连接节点自身";
    // 顺序边：无类型语义，同对节点只允许一条
    if (p.sourceHandle === "__seqOut" && p.targetHandle === "__seqIn") {
      if (edges.some(e => (e.kind === "seq" || e.class === "seq") && e.source === p.source && e.target === p.target)) return "顺序连线已存在";
      return null;
    }
    const src = nodeByIdMap.get(p.source), tgt = nodeByIdMap.get(p.target);
    if (!src || !tgt) return "端点节点不存在";
    const sMeta = typeMap[src.type], tMeta = typeMap[tgt.type];
    if (!sMeta || !tMeta) return "节点类型未知";
    // 动态出口节点（struct.split）必须经 effectiveOutputs 解析，声明 outputs 为空
    const outs = sMeta.dynamicOutputs
      ? effectiveOutputs(sMeta, src.data, { edges, nodes, id: src.id })
      : (sMeta.outputs ?? []);
    const o = (p.sourceHandle ? outs.find(x => x.id === p.sourceHandle) : outs[0]) ?? outs[0];
    const inps = effectiveInputs(tMeta, tgt.data);
    const i = p.targetHandle ? inps.find(x => x.id === p.targetHandle) : inps[0];
    if (!o || !i) return "插槽不存在（节点配置可能已变化）";
    if (!canConnect(o.type, i.type)) return `类型不兼容：${o.type}（${src.id}.${o.id}）→ ${i.type}（${tgt.id}.${i.id}）`;
    // 四元组唯一（防重复拖拽/事件重放产生的完全相同的边）
    if (edges.some(e => e.source === p.source && e.sourceHandle === o.id && e.target === p.target && e.targetHandle === i.id)) return "完全相同的连线已存在";
    return null;
  }
  /** @param {any} p */
  function isValidConnection(p) {
    return connectionRejectReason(p) === null;
  }
  /** 拖放结束落在目标 handle 上但被拒 → toast 原因（拖空白取消不打扰；拖拽过程中也不打扰） */
  function onConnectEnd(/** @type {any} */ _e, /** @type {any} */ cs) {
    if (!cs || cs.isValid === true || !cs.toHandle || !cs.fromHandle) return;
    const reason = connectionRejectReason({
      source: cs.fromHandle.nodeId,
      sourceHandle: cs.fromHandle.id,
      target: cs.toHandle.nodeId,
      targetHandle: cs.toHandle.id,
    });
    if (reason) showToast(`连线被拒：${reason}`);
  }

  /**
   * 连接完成回调：Svelte Flow 在 onconnect 之前已自行把边加入 edges（Handle.svelte
   * onConnectExtended → store.addEdge），这里绝不能再手动 push（会产生同端点重复边）。
   * 只做：标脏 + 给顺序边补虚线样式字段（库加的边不带我们的装饰字段）。
   * @param {any} p connection
   */
  function onConnect(p) {
    if (p.sourceHandle === "__seqOut" && p.targetHandle === "__seqIn") {
      edges = edges.map(e => (e.source === p.source && e.target === p.target && e.sourceHandle === "__seqOut" && e.targetHandle === "__seqIn" && !e.class)
        ? { ...e, kind: "seq", class: "seq" } : e);
    }
    markCritical();
  }
  /** @param {{ nodes: any[], edges: any[] }} m xyflow 内置删除键（DEL/Backspace）触发 */
  function onDelete({ nodes: delNodes, edges: delEdges }) {
    if (delNodes.length || delEdges.length) markCritical();
  }
  function onMoveEnd() { if (Date.now() > ignoreDirtyUntil) layoutDirty = true; }

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

  // ── 动态出口：源节点的有效出口不含某边的 sourceHandle 时，该边自动消失 ────
  // 例：struct.split 的上游字段删除 → 对应出口上的连线随之断开。出口列表未知（[] 由规则明确给出）也删。
  $effect(() => {
    const dead = edges.filter(e => {
      if (e.kind === "seq") return false;
      const src = nodes.find(n => n.id === e.source);
      const meta = typeMap[src?.data?.__type ?? src?.type];
      if (!src || !meta) return false;
      const outs = effectiveOutputs(meta, src.data, { edges, nodes, id: e.source });
      return !outs.some(o => o.id === e.sourceHandle);
    });
    if (dead.length) {
      edges = edges.filter(e => !dead.includes(e));
      markCritical();
      showToast(`已断开 ${dead.length} 条连线（源节点出口已变化）`);
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
  /** 定义任务模式下点任务按钮 = 载入该任务进入编辑（保存同名任务即覆盖） */
  function editTask(taskName) {
    const t = tasks[taskName];
    definer = {
      nodes: [...(t.nodes ?? t.path ?? [])],
      name: taskName,
      label: t.label ?? taskName,
      mutates: !!t.mutates,
      problems: [],
    };
  }
  /** 点画布背景：清除最近一次任务的运行状态（卡片外框/透明度回归正常） */
  function clearRunStatus() {
    ui.nodeRunStatus = null;
    ui.runTaskNodes = null;
  }
  async function doRun() {
    const m = runModal;
    if (m.needProd && !m.dryRun && m.prodVal !== displayName) { showToast(`需输入显示名 "${displayName}" 确认`); return; }
    const inputs = Object.fromEntries(m.inputs.map(i => [i.name, i.value || i.fallback]).filter(([, v]) => v !== ""));
    try {
      const { id } = await api("/api/jobs", { method: "POST", body: JSON.stringify({
        workflow: currentPath, task: m.task, dryRun: m.dryRun, inputs,
        doc: toDoc(), // 内存态执行：未保存的改动也能直接跑（后端校验后以内存为准）
        ...(m.needProd && !m.dryRun ? { confirmProd: m.prodVal } : {}),
      }) });
      runModal = null;
      // 卡片外框状态：任务选点集（集外半透明灰）+ 节点执行状态清零，随流式事件更新
      ui.runTaskNodes = new Set(tasks[m.task].nodes ?? tasks[m.task].path ?? []);
      ui.nodeRunStatus = {};
      await logRef?.follow(id, `${displayName}/${m.task}${m.dryRun ? " (dry-run)" : ""}`,
        ns => { ui.nodeRunStatus = ns ?? {}; });
    } catch (e) { showToast(e.message); }
  }

  function saveDefinedTask() {
    if (!definer?.name) { showToast("任务名必填"); return; }
    const problems = validateTaskSelection(definer.nodes, edges, nodeByIdMap, typeMap);
    if (problems.length) { definer.problems = problems; return; }
    tasks[definer.name] = { label: definer.label || definer.name, mutates: definer.mutates, nodes: [...definer.nodes] };
    definer = null;

    markCritical();
  }
  function deleteTask(n) { delete tasks[n]; markCritical(); }

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
    <button onclick={() => (openModal = { mode: "open", path: "", title: "" })}>打开…</button>
    <button onclick={() => (openModal = { mode: "new", path: "", title: "" })}>新建…</button>
    <button class="primary" disabled={!dirty} onclick={() => save()}>{dirty ? "保存 *" : "保存"}</button>
    <span class="badge">{busyText}</span>
    <input class="token" type="password" placeholder="token" bind:value={tokenVal} onchange={tokenChange} />
    {#if toast}<span class="toast">{toast}</span>{/if}
  </header>

  <div class="taskbar">
    <span class="wfmeta">
      <input style="width:220px" placeholder="显示名" bind:value={title} onchange={() => markCritical()} />
    </span>
    <span class="sep"></span>
    {#each Object.entries(tasks) as [tn, t] (tn)}
      <button class:onpath-btn={hoverTask === tn}
        onmouseenter={() => (hoverTask = tn)} onmouseleave={() => (hoverTask = null)}
        onclick={() => (definer ? editTask(tn) : openRun(tn))}>
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
    <!-- key = 工作流路径：每次载入重挂画布，确保内嵌 webview 里节点测量必然完成（修 load 后节点不显示） -->
    {#key currentPath}
      <SvelteFlow
        bind:nodes bind:edges
        nodeTypes={components}
        onnodeclick={onNodeClick}
        onpaneclick={clearRunStatus}
        onconnect={onConnect}
        onconnectend={onConnectEnd}
        isValidConnection={isValidConnection}
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
    {/key}

      <Palette {metas} onadd={addNode} />

      {#if definer}
        <div class="definer">
          <b>定义任务</b>：点选节点（顺序无关，将构成一个或多个 DAG 并发执行；当前 {definer.nodes.length} 个）
          {#if tasks[definer.name]}<span class="dim">—— 编辑现有任务「{tasks[definer.name].label ?? definer.name}」，保存即覆盖</span>{/if}
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
  <!-- 关闭只走显式按钮；点背景不关闭，防长表单误触丢内容 -->
  <div class="overlay">
    <div class="modal">
      <h3>{openModal.mode === "new" ? "新建工作流" : "打开工作流"}</h3>
      {#if openModal.mode === "new"}
        <label>显示名（别名，可留空 = 用文件名）<input bind:value={openModal.title} placeholder="我的部署流程" /></label>
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
  <div class="overlay">
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
        <label style="color:var(--err)">PROD：输入显示名 <b>{displayName}</b> 确认<input bind:value={runModal.prodVal} placeholder={displayName} /></label>
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
