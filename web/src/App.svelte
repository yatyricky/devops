<script>
  import { getContext, setContext } from "svelte";
  import { SvelteFlow, Background, Controls, MiniMap } from "@xyflow/svelte";
  import { api } from "./api.js";
  import { canConnect, effectiveInputs, effectiveOutputs, genId, validateTaskSelection, isTunnelEdge, TYPE_COLORS, nodeTitle, portLabel, basenameNoExt, dirOf } from "./types.js";
  import { makeInfer } from "./lib/infer.js";
  import { GROUP_COLORS, GROUP_COLLAPSED_W, groupAABB, groupBoxOf, crossEdges, collapsedHeight, makeGroupNode } from "./lib/groups.js";
  import { toDocument } from "./lib/docIO.js";
  import { ui } from "./store.svelte.js";
  import DevNode from "./DevNode.svelte";
  import Placeholder from "./Placeholder.svelte";
  import GroupBox from "./GroupBox.svelte";
  import Palette from "./Palette.svelte";
  import CanvasDrop from "./CanvasDrop.svelte";
  import LogDrawer from "./LogDrawer.svelte";
  import TypeEdge from "./TypeEdge.svelte";
  import OpenModal from "./OpenModal.svelte";
  import RunModal from "./RunModal.svelte";

  // ── 全局状态 ────
  let metas = $state([]);
  let wfList = $state([]);
  let currentPath = $state("");
  let title = $state("");          // 显示名（工作流唯一可编辑标识；文件路径即身份）
  let docRepoDir = $state("");     // 透传字段：旧文档里的 repoDir 原样保留，不再提供编辑框
  let displayName = $derived(title || (currentPath ? basenameNoExt(currentPath) : ""));
  let nodes = $state([]), edges = $state([]), tasks = $state({});
  let autoDirty = $state(false);   // 关键变更未落盘（自动写盘管）
  let layoutDirty = $state(false); // 布局（节点位置）未保存（手动"保存"管）
  let dirty = $derived(autoDirty || layoutDirty);
  let toast = $state("");
  let busyText = $state("空闲");

  let ignoreDirtyUntil = 0;
  let definer = $state(/** @type {{ nodes: string[], name: string, label: string, mutates: boolean, problems: string[] } | null} */ (null));
  let hoverTask = $state(/** @type {string | null} */ (null));
  let runModal = $state(/** @type {{ task: string, label: string, needProd: boolean } | null} */(null));
  let openModal = $state(/** @type {{ mode: "open" | "new" } | null} */(null));
  let logRef = $state(null);

  const typeMap = $derived(ui.nodeTypesMap);
  // 二分：临时全部替换为静态占位卡
  const components = $derived({ ...Object.fromEntries(Object.keys(typeMap).map(t => [t, DevNode])), groupbox: Placeholder });
  /** 全部数据边用自定义边（选中时带重连锚点） */
  const edgeTypes = { default: TypeEdge };
  let currentEntry = $derived(wfList.find(w => w.path === currentPath));
  let selectedNodeIds = $derived(new Set(nodes.filter(n => n.selected).map(n => n.id)));

  // 节点卡片经 context 拿编辑/删除回调与连线查询（xyflow 自建组件树，props 传不进节点组件）

  /** 编辑期取值/推断（lib/infer 工厂注入当前图状态；调用时取当前 $state 值） */
  function infer() {
    return makeInfer({ nodes, edges, typeMap: ui.nodeTypesMap });
  }

  setContext("devnode-actions", {
    ondata: onData,
    ondelete: deleteNode,
    /** 分组背景板编辑（组名/颜色）：按 __gid 定位 groupbox 节点打补丁 */
    ongroup: onGroupData,
    /** 分组色板开关：置顶/回落背景板，保证下拉浮在成员卡片之上 */
    onpalette: onPalette,
    /** 某输入口是否已连线（struct 字段口连线时隐藏手填控件） */
    isWiredAsTarget(nodeId, handleId) {
      return edges.some(e => e.kind !== "seq" && !isTunnelEdge(e) && e.target === nodeId && e.targetHandle === handleId);
    },
    /** 某输入口的连线源节点（struct.split 回溯上游字段定义用） */
    getSourceNode(nodeId, handleId) {
      const e = edges.find(e => e.kind !== "seq" && !isTunnelEdge(e) && e.target === nodeId && e.targetHandle === handleId);
      return nodes.find(n => n.id === e?.source);
    },
    resolveInput(nodeId, handleId) {
      return infer().resolvePortValue(nodeId, handleId);
    },
    /** 某节点的有效出口列表（structSplit 回溯需要全图上下文，App 提供；规则=effectiveOutputs 单源） */
    resolveOutputs(nodeId) {
      const n = nodes.find(x => x.id === nodeId);
      if (!n) return undefined;
      const meta = ui.nodeTypesMap[n.type];
      return effectiveOutputs(meta, n.data, { edges, nodes, id: nodeId });
    },
    /** Group 隧道：某组的跨组边（入 = 组外→组内；出 = 组内→组外），与编号 effect 同序 */
    groupEdges(gid) {
      return crossEdges(edges, groupBoxOf(nodes, gid));
    },
    /** 收起/展开黑箱条：成员 hidden 联动 + 组尺寸条形化/恢复 AABB */
    oncollapse(gid, collapsed) {
      const g = groupBoxOf(nodes, gid);
      if (!g) return;
      const members = g.data.memberIds ?? [];
      const barH = collapsedHeight(edges, g);
      nodes = nodes.map(n => {
        if (n.type === "groupbox" && n.data.__gid === gid) {
          if (collapsed) {
            return { ...n, data: { ...n.data, collapsed: true }, width: GROUP_COLLAPSED_W, height: barH };
          }
          const aabb = groupAABB(nodes, members) ?? { width: 320, height: 200 };
          return { ...n, data: { ...n.data, collapsed: false }, width: aabb.width, height: aabb.height };
        }
        if (members.includes(n.id)) return { ...n, hidden: collapsed };
        return n;
      });
      markCritical();
    },
    /** 收起条隧道 label：<节点标题>: <端口 label>（端口格式与 DevNode 卡片一致；入侧=目标口，出侧=源口） */
    tunnelLabel(e, side) {
      const nid = side === "in" ? e.target : e.source;
      const hid = (side === "in" ? e.targetHandle : e.sourceHandle) ?? "";
      const n = nodes.find(x => x.id === nid);
      if (!n) return "";
      const meta = ui.nodeTypesMap[n.type];
      const head = nodeTitle(meta, n.data);
      const port = (side === "in" ? effectiveInputs(meta, n.data) : effectiveOutputs(meta, n.data, { edges, nodes, id: nid }))
        .find(p => p.id === hid);
      if (!port) return head;
      return `${head}: ${portLabel(port)}${side === "in" && port.required ? "*" : ""}`;
    },
    async resolveTplVars(p) {
      return api("/api/template/vars", { method: "POST", body: JSON.stringify({
        path: p, configDir: currentPath ? dirOf(currentPath) : "", repoDir: docRepoDir,
      }) });
    },
    /** 某节点的有效输入口列表（selector 等动态口需要全图上下文） */
    resolveInputs(nodeId) {
      const n = nodes.find(x => x.id === nodeId);
      if (!n) return [];
      return effectiveInputs(typeMap[n.data?.__type ?? n.type], n.data, { edges, nodes, id: nodeId });
    },
    /** selector 下拉选项：每条入边 → { id: 专用口id, label: 源节点标题 } */
    selectorOptions(nodeId) {
      return edges
        .filter(e => e.kind !== "seq" && !isTunnelEdge(e) && e.target === nodeId)
        .map(e => {
          const s = nodes.find(n => n.id === e.source);
          const m = s && typeMap[s.data?.__type ?? s.type];
          return { id: e.targetHandle, label: nodeTitle(m, s?.data) };
        });
    },
    /** 编辑期输出推断：path.resolve → 拼接推断值；string.join → 分隔符拼接推断值；渲染模板 → .tmp 产物路径；其余 undefined */
    inferOutput(nodeId) {
      const n = nodes.find(x => x.id === nodeId);
      if (!n) return undefined;
      const f = infer();
      if (n.type === "path.resolve") return f.inferPathResolve(n);
      if (n.type === "string.join") return f.inferStringJoin(n);
      if (n.type === "template.render") return n.data?.inferredOut;
      return undefined;
    },
  });

  let toastTimer = null;
  function showToast(msg) {
    toast = msg;
    clearTimeout(toastTimer); // 连发时以最后一条为准，前一条的定时器不再提前清掉新提示
    toastTimer = setTimeout(() => (toast = ""), 3000);
  }

  // ── 初始化 ────
  $effect(() => { (async () => {
    try {
      metas = await api("/api/node-types");
      ui.nodeTypesMap = Object.fromEntries(metas.map(m => [m.type, m]));
      wfList = await api("/api/workflows");
      api("/api/home").then(r => localStorage.setItem("devops-home", r.home ?? "")).catch(() => {});
      await refreshUsage();
      const first = wfList.find(w => w.name);
      if (first) await selectWorkflow(first.path);
    } catch (e) { showToast(`初始化失败：${e.message}（检查服务器是否启动）`); }
  })(); });

  /** 「未测试」清单（手工维护，存 local-config.untestedNodeTypes） */
  async function refreshUsage() {
    try { ui.untestedNodeTypes = new Set((await api("/api/node-usage")).untested ?? []); } catch { /* 静默 */ }
  }

  // 状态栏轮询（组件销毁时清理，HMR/卸载不泄漏定时器）；只在值变化时写 busyText
  let lastBusy = null;
  $effect(() => {
    const busyTimer = setInterval(async () => {
      try {
        const cur = await api("/api/current");
        const next = cur ? `运行中: ${cur.app}/${cur.task}` : "空闲";
        if (next !== lastBusy) { busyText = next; lastBusy = next; }
      } catch { /* 静默 */ }
    }, 5000);
    return () => clearInterval(busyTimer);
  });

  // ── 工作流加载/保存 ────
  async function selectWorkflow(fp) {
    const { doc } = await api("/api/workflows/open", { method: "POST", body: JSON.stringify({ path: fp }) });
    loadDoc(fp, doc);
    wfList = await api("/api/workflows");
    autoDirty = false; layoutDirty = false;
  }
  function loadDoc(fp, doc) {
    currentPath = fp;
    title = doc.title ?? doc.name ?? basenameNoExt(fp);
    docRepoDir = doc.repoDir ?? "";
    // 收起组的成员加载即 hidden（与 oncollapse 的联动态一致）
    const collapsedMembers = new Set((doc.groups ?? []).filter(g => g.collapsed).flatMap(g => g.nodes ?? []));
    nodes = (doc.nodes ?? []).map(n => ({
      id: n.id, type: n.type,
      position: { x: n.position[0], y: n.position[1] },
      data: { ...n.data, __type: n.type },
      ...(collapsedMembers.has(n.id) ? { hidden: true } : {}),
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
    // 分组背景板：由 doc.groups 重建（含收起态；首帧 AABB 用近似尺寸，挂载后联动 effect 校正）
    const groupBoxes = (doc.groups ?? [])
      .map(g => makeGroupNode(nodes, g.id, g.name ?? "新分组", g.color ?? "#4da3ff", (g.nodes ?? []).filter(id => nodes.some(n => n.id === id)), !!g.collapsed));
    if (groupBoxes.length) {
      // 成员卡片抬到自己组的背景板之上（与 groupSelected 同一层级体系）
      const members = new Set(groupBoxes.flatMap(g => g.data.memberIds ?? []));
      nodes = [...nodes.map(n => (members.has(n.id) ? { ...n, zIndex: 2 } : n)), ...groupBoxes];
    }
    hoverTask = null; definer = null;
    ui.runTaskNodes = null; ui.nodeRunStatus = null; ui.runNodeInputs = null;
    ignoreDirtyUntil = Date.now() + 1000;
    ui.pickerFresh = {}; // 换工作流 = 所有实时列表视为失鲜，运行前须重新刷新
  }
  function toDoc() {
    return toDocument(nodes, edges, tasks, title, docRepoDir);
  }
  // ── 保存：关键变更（serializable 编辑 / node·edge·tasks 增删改）自动写盘（防抖）；
  //    节点位置等展示信息仍依赖手动保存（layoutDirty）。 ────
  let autoSaveTimer = null;
  /** @param {boolean} [silent] 自动保存静默（不 toast、不清布局脏——布局变动以手动保存为准） */
  async function save(silent = false) {
    clearTimeout(autoSaveTimer);
    try {
      await api("/api/workflows/save", { method: "POST", body: JSON.stringify({ path: currentPath, doc: toDoc() }) });
      autoDirty = false;
      if (!silent) layoutDirty = false; // 手动保存同时清除布局脏，星号（保存 *）才熄得掉
      if (!silent) showToast("已保存");
      wfList = await api("/api/workflows");
      refreshUsage();
    } catch (e) { showToast(`保存失败：${e.message}`); }
  }
  /** 关键变更标脏 + 防抖自动写盘（600ms 合并连续编辑） */
  function markCritical() {
    autoDirty = true;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => save(true), 600);
  }
  /** @param {{ mode: "open" | "new", path: string, title: string }} m 弹窗确认（OpenModal 组件回调） */
  async function doOpen(m) {
    try {
      const fp = m.path;
      if (m.mode === "new") {
        const doc = {
          ...(m.title ? { title: m.title } : {}),
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
  function addNode(meta, position = null) {
    const data = { __type: meta.type };
    for (const w of meta.widgets) data[w.key] = w.default ?? (w.kind === "boolean" ? true : "");
    const id = genId(meta.type.split(".")[1] ?? "n");
    const pos = position ?? { x: 120 + (nodes.length % 6) * 40, y: 120 + Math.floor(nodes.length / 6) * 60 };
    nodes = [...nodes, { id, type: meta.type, position: pos, data }];
    markCritical();
    return id;
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
  // ── 删除节点：被任务引用时弹窗确认，确认后从任务中移除（后果由用户承担）────
  /** @param {string[]} ids @returns {string[]} 引用这些节点的任务名（去重保序） */
  function taskNamesUsing(ids) {
    const set = new Set(ids);
    return Object.entries(tasks).filter(([, t]) => (t.nodes ?? t.path ?? []).some(x => set.has(x))).map(([n]) => n);
  }
  /** @param {string[]} ids @returns {boolean} false = 用户取消删除 */
  function confirmTaskRemoval(ids) {
    const usedBy = taskNamesUsing(ids);
    if (!usedBy.length) return true;
    return confirm(
      `节点 ${ids.join("、")} 被以下任务引用：${usedBy.join("、")}。\n` +
      `确认删除？节点将从这些任务中移除，可能造成不可预期的后果，由你自己承担。`,
    );
  }
  /** @param {string[]} ids */
  function stripFromTasks(ids) {
    const set = new Set(ids);
    for (const t of Object.values(tasks)) {
      const cur = t.nodes ?? t.path;
      if (!cur) continue;
      const next = cur.filter(x => !set.has(x));
      if (next.length !== cur.length) { t.nodes = next; delete t.path; }
    }
  }
  function deleteNode(id) {
    if (!confirm(`确认删除节点 ${id}？`)) return;
    if (!confirmTaskRemoval([id])) return;
    nodes = nodes.filter(n => n.id !== id);
    edges = edges.filter(e => e.source !== id && e.target !== id);
    stripFromTasks([id]);
    stripFromGroups([id]);
    markCritical();
  }

  // ── 分组：groupbox 背景板 = 专用 xyflow 节点（zIndex 垫底、不可 DEL），位置尺寸由成员实时 AABB 计算；
  //    成员-组关系存在 data.memberIds，落盘时从 groupbox 节点还原成 doc.groups。
  //    纯逻辑（AABB/跨组边/收起条尺寸/构造）在 lib/groups.js，此处只留写状态的编排。 ────
  let groupableIds = $derived(nodes.filter(n => n.type !== "groupbox" && n.selected).map(n => n.id));
  let selectedGroupBox = $derived(nodes.find(n => n.type === "groupbox" && n.selected) ?? null);
  /** 按 __gid 给 groupbox 节点打补丁（data 合并或整节点替换），返回新的 nodes 数组 */
  function patchGroupBox(gid, fn) {
    return nodes.map(n => (n.type === "groupbox" && n.data.__gid === gid) ? fn(n) : n);
  }
  /** 【组合】：Ctrl+点选 >1 节点 → 建组（节点只属一个组，先从既有组移除） */
  function groupSelected() {
    const ids = groupableIds;
    if (ids.length < 2) return;
    const idSet = new Set(ids);
    stripFromGroups(ids); // 先从既有组移除（与节点删除同一条路径）
    nodes = [...nodes.map(n => (n.type === "groupbox" ? { ...n, selected: false } : n)),
      makeGroupNode(nodes, genId("grp"), "新分组", GROUP_COLORS[0], ids)];
    // 成员卡片抬到自己组的背景板之上（板 z1、成员 z2、组外节点 z0）
    nodes = nodes.map(n => (idSet.has(n.id) ? { ...n, zIndex: 2 } : n));
    markCritical();
  }
  /** 【克隆】：选中节点各复制一份——data 深拷贝（常量/lit/便笺/条目数全保留）、连线不复制、位置偏移 (40,40)；
   *  原节点在组内则克隆同入该组（避免克隆卡落到背景板下层被色罩盖住）；克隆卡置为选中 */
  function cloneSelected() {
    const ids = groupableIds;
    if (!ids.length) return;
    const idMap = new Map();
    const clones = [];
    for (const id of ids) {
      const n = nodes.find(x => x.id === id);
      if (!n || n.type === "groupbox") continue;
      const nid = genId(n.type.split(".")[1] ?? "n");
      idMap.set(id, nid);
      clones.push({
        id: nid, type: n.type,
        position: { x: n.position.x + 40, y: n.position.y + 40 },
        data: JSON.parse(JSON.stringify(n.data)),
        ...(n.zIndex !== undefined ? { zIndex: n.zIndex } : {}),
      });
    }
    if (!clones.length) return;
    nodes = [...nodes.map(n => ({ ...n, selected: false })),
      ...clones.map(c => ({ ...c, selected: true }))];
    nodes = nodes.map(n => {
      if (n.type !== "groupbox") return n;
      const add = (n.data.memberIds ?? []).filter(x => idMap.has(x)).map(x => idMap.get(x));
      return add.length ? { ...n, data: { ...n.data, memberIds: [...n.data.memberIds, ...add] } } : n;
    });
    markCritical();
  }
  /** 【拆分】：删背景板，成员世界坐标不动（层级回落到普通节点） */
  function ungroupSelected() {
    if (!selectedGroupBox) return;
    const members = new Set(selectedGroupBox.data.memberIds ?? []);
    nodes = nodes.filter(n => n.id !== selectedGroupBox.id)
      .map(n => (members.has(n.id) ? { ...n, zIndex: 0 } : n));
    markCritical();
  }
  /** 组名/颜色编辑（GroupBox 组件经 context 回调） */
  function onGroupData(gid, patch) {
    nodes = patchGroupBox(gid, n => ({ ...n, data: { ...n.data, ...patch } }));
    markCritical();
  }
  /** 色板开关：打开时背景板临时置顶——色板作为板的子元素压不过成员卡片（板常态 z1，见 makeGroupNode） */
  function onPalette(gid, open) {
    nodes = patchGroupBox(gid, n => ({ ...n, zIndex: open ? 1000 : 1 }));
  }
  /** 节点删除时从所属组中摘除（背景板随之收缩） */
  function stripFromGroups(ids) {
    const set = new Set(ids);
    nodes = nodes.map(n => (n.type === "groupbox" && (n.data.memberIds ?? []).some(x => set.has(x)))
      ? { ...n, data: { ...n.data, memberIds: n.data.memberIds.filter(x => !set.has(x)) } } : n);
  }
  /** @param {{ event: any, node: any }} m 定义任务模式下点选节点（切换选入/移出，顺序无关）；其余选中交给 xyflow */
  function onNodeClick({ node }) {
    if (!node || !definer || node.type === "groupbox") return;
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
   * @param {any} p connection { source, target, sourceHandle, targetHandle, selfId? }（selfId = 边重连时排除自身）
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
    // 四元组唯一（防重复拖拽/事件重放产生的完全相同的边；重连时排除自身）
    if (edges.some(e => e.id !== p.selfId && e.source === p.source && e.sourceHandle === o.id && e.target === p.target && e.targetHandle === i.id)) return "完全相同的连线已存在";
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
    } else if (p.targetHandle) {
      // 建立数据连线即清除目标端口字面量（连线优先；断开后双 radio 回到未设置态）
      const tNode = nodes.find(n => n.id === p.target);
      if (tNode?.data?.lit?.[p.targetHandle] !== undefined) {
        const next = { ...tNode.data.lit };
        delete next[p.targetHandle];
        onData(p.target, "lit", next);
      }
    }
    markCritical();
  }
  /** 拖空白/非法 handle：库不触发 onreconnect，边原样保留（还原语义）。 */
  /** 边重连最终校验：返回 falsy = 拒绝（边保持原样）。顺序边不可重连；新四元组过连线裁决（排除自身）。 */
  function onBeforeReconnect(reconnected, old) {
    if (old.kind === "seq") { showToast("顺序边不可重连：删除后重画"); return undefined; }
    if (connectionRejectReason({ source: reconnected.source, sourceHandle: reconnected.sourceHandle, target: reconnected.target, targetHandle: reconnected.targetHandle, selfId: old.id }) !== null) return undefined;
    return reconnected;
  }
  /** 重连成功：标脏（装饰 effect 自动跟随新端点校正类型色/zIndex/动画） */
  function onReconnect() { markCritical(); }
  /** @param {{ nodes: any[], edges: any[] }} p xyflow 内置删除键（DEL/Backspace）触发；收起态隧道段边不可删 */  function onBeforeDelete({ nodes: delNodes, edges: delEdges }) {
    if (delNodes.length && !confirm(`确认删除 ${delNodes.length} 个节点（${delNodes.map(n => n.id).join("、")}）？`)) return false;
    if (!confirmTaskRemoval(delNodes.map(n => n.id))) return false;
    return { nodes: delNodes, edges: delEdges.filter(e => !isTunnelEdge(e)) };
  }
  function onDelete({ nodes: delNodes, edges: delEdges }) {
    if (delNodes.length) { stripFromTasks(delNodes.map(n => n.id)); stripFromGroups(delNodes.map(n => n.id)); markCritical(); }
    else if (delEdges.length) markCritical();
  }
  // 视口平移/缩放不改变文档内容（toDoc 不含视口）——不点亮保存星号；节点拖动由 onNodeDragStop 记 layoutDirty
  function onMoveEnd() {}

  // ── 分组联动 ────
  // AABB 跟随：成员位置/测量尺寸变化 → 背景板重算（组拖拽中跳过，避免与原生拖拽互相拉扯）
  let draggingGid = $state(null);
  let groupDrag = null; // { pos, members: [{id,x,y}] }（非响应式，只做拖拽期快照）
  $effect(() => {
    if (draggingGid) return;
    const list = nodes;
    if (!list.some(n => n.type === "groupbox")) return;
    const next = list.map(n => {
      if (n.type !== "groupbox") return n;
      // 收起黑箱条：保持条形尺寸（宽=成员卡宽、高=groupBarHeight 公式），不做 AABB 重算
      if (n.data.collapsed) {
        const barH = collapsedHeight(edges, n);
        const barW = GROUP_COLLAPSED_W;
        return (n.width === barW && n.height === barH) ? n : { ...n, width: barW, height: barH };
      }
      const aabb = groupAABB(nodes, n.data.memberIds ?? []);
      if (!aabb) return n;
      if (n.position.x === aabb.x && n.position.y === aabb.y && n.width === aabb.width && n.height === aabb.height) return n;
      return { ...n, position: { x: aabb.x, y: aabb.y }, width: aabb.width, height: aabb.height };
    });
    if (next.some((n, i) => n !== list[i])) nodes = next;
  });
  /** 背景板拖动 = delta 广播给成员；成员被一并选中时 xyflow 原生整体拖，不重复广播。
   *  注意 payload 键是 { event, targetNode, nodes }（无 node 键）。 */
  function onNodeDragStart({ targetNode, nodes: dragNodes }) {
    if (targetNode?.type !== "groupbox" || dragNodes.length !== 1) return;
    draggingGid = targetNode.data.__gid;
    groupDrag = {
      pos: { ...targetNode.position },
      members: (targetNode.data.memberIds ?? [])
        .map(id => { const m = nodes.find(x => x.id === id); return m ? { id, x: m.position.x, y: m.position.y } : null; })
        .filter(Boolean),
    };
  }
  function onNodeDrag({ targetNode }) {
    if (targetNode?.type !== "groupbox" || !groupDrag) return;
    const dx = targetNode.position.x - groupDrag.pos.x, dy = targetNode.position.y - groupDrag.pos.y;
    const map = new Map(groupDrag.members.map(m => [m.id, m]));
    nodes = nodes.map(n => (map.has(n.id)
      ? { ...n, position: { x: map.get(n.id).x + dx, y: map.get(n.id).y + dy } }
      : n));
  }
  function onNodeDragStop({ targetNode }) {
    if (targetNode?.type === "groupbox" && groupDrag) { groupDrag = null; draggingGid = null; }
    if (Date.now() > ignoreDirtyUntil) layoutDirty = true; // 节点拖动不触发 onmoveend，位置变更在这里落"手动保存"账
  }

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

  // ── Group 隧道：仅【收起态】把跨组边隐藏，代之以双段转发边（外部源→条缘入口 / 条缘出口→外部目标）。
  //    展开态保持 411e38d 的直连边样子——连线增删行为与无组时完全一致，不做任何变换。
  //    段边纯视觉转发（selectable:false——收起态与组相连的边不可增删，删除请先展开；不入库——toDoc 过滤 tnl- 前缀）。
  //    段边不得就地改属性：与动画 effect 同理，需整组替换对象。 ────
  $effect(() => {
    const gboxes = nodes.filter(n => n.type === "groupbox" && n.data.collapsed);
    /** @type {any[]} 段边期望态 */
    const want = [];
    /** @type {Map<string, { in: number, out: number }>} 每组同侧递增编号（与 GroupBox 收起条渲染序一致） */
    const counters = new Map();
    /** @type {Set<string>} 需隐藏的原跨组边 */
    const hide = new Set();
    for (const e of edges) {
      if (isTunnelEdge(e)) continue;
      const sg = gboxes.find(g => (g.data.memberIds ?? []).includes(e.source));
      const tg = gboxes.find(g => (g.data.memberIds ?? []).includes(e.target));
      if (sg && tg) continue; // 两端都在组内（不同组互连暂不支持，不处理）
      const g = sg ?? tg;
      if (!g) continue;
      const gid = g.data.__gid;
      const side = sg ? "out" : "in";
      const cnt = counters.get(gid) ?? { in: 0, out: 0 };
      const k = cnt[side]++;
      counters.set(gid, cnt);
      const th = `tunnel-${side}-${k}`;
      hide.add(e.id);
      // 段边端点必须是 groupbox 的 xyflow 节点 id（g.id = grp-${gid}），裸 gid 指向不存在的节点
      want.push({ id: `tnl-${e.id}-a`, source: e.source, sourceHandle: e.sourceHandle ?? null, target: g.id, targetHandle: th, selectable: false });
      want.push({ id: `tnl-${e.id}-b`, source: g.id, sourceHandle: th, target: e.target, targetHandle: e.targetHandle ?? null, selectable: false });
    }
    // hidden 同步：hide 集内必 hidden、集外真实边必可见（收起→展开时自动复原直连边）
    if (edges.some(e => !isTunnelEdge(e) && hide.has(e.id) !== !!e.hidden)) {
      edges = edges.map(e => (isTunnelEdge(e) || hide.has(e.id) === !!e.hidden) ? e : { ...e, hidden: hide.has(e.id) });
    }
    // 幂等 diff：段边补缺/去多/清 stale
    const curTnl = new Map(edges.filter(isTunnelEdge).map(e => [e.id, e]));
    const missing = [...want].filter(w => {
      const c = curTnl.get(w.id);
      return !c || c.hidden || c.source !== w.source || c.target !== w.target || c.sourceHandle !== w.sourceHandle || c.targetHandle !== w.targetHandle;
    });
    const stale = [...curTnl.keys()].filter(id => !want.some(w => w.id === id));
    if (missing.length || stale.length) {
      edges = [...edges.filter(e => !stale.includes(e.id)), ...missing.map(w => ({ ...w, animated: false }))];
    }
  });

  // ── 边装饰 effect（类型色 + 流线动画 + 选中抬升，三合一）：
  //    ① 数据边按【源出口类型】着色（style 字符串内联在 path 上，压过 xyflow 默认色），--ec 供选中光晕同色；
  //       tnl- 段边按其原边取同色（两段转发线与原数据一致）。seq 边走 class 银色，不打类型色。
  //    ② animated：与选中节点相连（或边自身被选中）的边播放流线动画——数据边与顺序边都参与。
  //    ③ zIndex（需 SvelteFlow zIndexMode="manual"）：与选中节点相连/自身选中的边抬到 1000——
  //       svg 层压住普通节点卡片（节点 z 0/1/2 都低于 1000）；其余回落 0。
  //    只替换需要翻转的边对象（EdgeWrapper 按引用响应），未变的保引用避免全体重渲染。
  $effect(() => {
    let changed = false;
    const next = edges.map(e => {
      let style = e.style;
      if (e.kind !== "seq") {
        const origId = isTunnelEdge(e) ? String(e.id).slice(4, -2) : e.id;
        const orig = isTunnelEdge(e) ? edges.find(x => x.id === origId) : e;
        const src = orig && nodeByIdMap.get(orig.source);
        const meta = src && typeMap[src.data?.__type ?? src.type];
        const outs = meta ? effectiveOutputs(meta, src.data, { edges, nodes, id: orig.source }) : [];
        const out = orig?.sourceHandle ? outs.find(o => o.id === orig.sourceHandle) : outs[0];
        const color = TYPE_COLORS[out?.type] ?? "#8a97a8";
        const want = `stroke: ${color}; --ec: ${color};`;
        if (style !== want) style = want;
      }
      const touching = selectedNodeIds.has(e.source) || selectedNodeIds.has(e.target) || !!e.selected;
      const animated = touching;
      const zIndex = touching ? 1000 : 0;
      if (style === e.style && !!e.animated === animated && e.zIndex === zIndex) return e;
      changed = true;
      return { ...e, style, animated, zIndex };
    });
    if (changed) edges = next;
  });

  // ── 动态出口：源节点的有效出口不含某边的 sourceHandle 时，该边自动消失 ────
  // 例：struct.split 的上游字段删除 → 对应出口上的连线随之断开。出口列表未知（[] 由规则明确给出）也删。
  $effect(() => {
    // selector 解锁：全部输入边被删 → 无法推导类型，清 lockType（outputs 变 []，下游边由死边清理断开）
    for (const n of nodes) {
      const meta = typeMap[n.data?.__type ?? n.type];
      if (meta?.selectorInputs && n.data?.lockType !== undefined) {
        const hasIn = edges.some(e => e.kind !== "seq" && !isTunnelEdge(e) && e.target === n.id);
        if (!hasIn) onData(n.id, "lockType", undefined);
      }
    }
    const dead = edges.filter(e => {
      if (e.kind === "seq" || isTunnelEdge(e)) return false; // tnl- 是派生段边（伪句柄），删除会与隧道 effect 无限乒乓
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

  /** 调色板拖放到画布：在鼠标落点创建节点 */
  function dropAddNode(type, flowPosition) {
    const meta = typeMap[type];
    if (!meta) return;
    addNode(meta, { x: Math.round(flowPosition.x), y: Math.round(flowPosition.y) });
  }

  // ── 任务运行 ────
  function openRun(taskName) {
    const t = tasks[taskName];
    runModal = {
      task: taskName, label: t.label ?? taskName,
      needProd: !!t.mutates && currentEntry?.serverType === "prod",
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
    ui.runNodeInputs = null;
  }
  /** @param {{ dryRun: boolean, prodVal: string }} p RunModal 确认回调 */
  async function doRun(p) {
    const m = runModal;
    if (m.needProd && !p.dryRun && p.prodVal !== displayName) { showToast(`需输入显示名 "${displayName}" 确认`); return; }
    // 防漂移门禁：任务选点中带实时列表的节点（refs/scripts/ssh 别名），其列表必须已按【当前输入】刷新过，
    // 否则禁止启动（列表失鲜 = 选值可能已过期）。dry-run 同样受限——预览的也是计划的真实性。
    const stale = [];
    for (const id of tasks[m.task].nodes ?? []) {
      const n = nodeByIdMap.get(id);
      const meta = n && typeMap[n.data?.__type ?? n.type];
      if (!meta) continue;
      let want = undefined;
      if (meta.refsPicker) want = String(infer().resolvePortValue(id, "repoDir") ?? "");
      else if (meta.scriptsPicker) want = String(infer().resolvePortValue(id, "path") ?? "").trim();
      else if (meta.sshAliasesPicker) want = String(infer().resolvePortValue(id, "alias") ?? n.data?.alias ?? "");
      if (want === undefined) continue; // 输入来自运行时节点，列表新鲜度无从校验（刷新即按当时输入取）
      if (ui.pickerFresh[id] !== want) stale.push(id);
    }
    if (stale.length) {
      showToast(`实时列表未刷新（${stale.join("、")}），先点卡片「刷新」或顶栏「刷新列表」再运行`);
      return;
    }
    try {
      const { id } = await api("/api/jobs", { method: "POST", body: JSON.stringify({
        workflow: currentPath, task: m.task, dryRun: p.dryRun,
        doc: toDoc(), // 内存态执行：未保存的改动也能直接跑（后端校验后以内存为准）
        ...(m.needProd && !p.dryRun ? { confirmProd: p.prodVal } : {}),
      }) });
      runModal = null;
      // 卡片外框状态：任务选点集（集外半透明灰）+ 节点执行状态清零，随流式事件更新
      ui.runTaskNodes = new Set(tasks[m.task].nodes ?? tasks[m.task].path ?? []);
      ui.nodeRunStatus = {};
      ui.runNodeInputs = {};
      await logRef?.follow(id, `${displayName}/${m.task}${p.dryRun ? " (dry-run)" : ""}`, {
        onNode: ns => { ui.nodeRunStatus = ns ?? {}; },
        onNodeInputs: ni => { ui.runNodeInputs = ni ?? {}; },
      });
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

  // 网格吸附：开启后移动节点按 16px 网格落点（xyflow 以节点左上角为 pivot，拖动即吸附）
  let snapOn = $state(localStorage.getItem("devops-snap") === "1");
  function snapChange() { localStorage.setItem("devops-snap", snapOn ? "1" : "0"); }

  // 调试钩子（生产亦无害，只读）
  $effect(() => { window.__dbg = { get nodes() { return nodes; }, get edges() { return edges; }, get tasks() { return tasks; } }; });
</script>

<div class="layout">
  <header>
    <h1>DevOps 控制台</h1>
    <select class="wfsel" value={currentPath} onchange={e => { selectWorkflow(e.target.value).catch(er => showToast(`打开失败：${er.message}`)); }}>
      {#each wfList as w (w.path)}
        <option value={w.path}>{w.error ? `✗ ${w.path}` : `${w.name}${w.serverType === "prod" ? " ⚠PROD" : ""}`}</option>
      {/each}
    </select>
    <button onclick={() => (openModal = { mode: "open" })}>打开…</button>
    <button onclick={() => (openModal = { mode: "new" })}>新建…</button>
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
    <button title="刷新画布上所有下拉列表（git refs / npm scripts / ssh 别名）" onclick={() => ui.refreshTick++}>刷新列表</button>
    <span class="sep"></span>
    <button title="克隆选中的节点：常量属性复制、连线不复制，位置偏移 (40,40)"
      disabled={!groupableIds.length} onclick={cloneSelected}>克隆</button>
    <button title="把当前选中的多个节点编为一组" disabled={groupableIds.length < 2} onclick={groupSelected}>组合</button>
    <button title="拆散选中的分组（成员位置不动）" disabled={!selectedGroupBox} onclick={ungroupSelected}>拆分</button>
    <label class="switch" title="开启后移动节点按 16px 网格吸附（以节点左上角为基准）">
      <input type="checkbox" bind:checked={snapOn} onchange={snapChange} />
      <span class="track"></span>吸附
    </label>
    <label class="switch" title="一键展开/收起所有节点的说明（ndesc）">
      <input type="checkbox" checked={ui.descAllOpen} onchange={() => { ui.descAllOpen = !ui.descAllOpen; ui.descAllTick++; }} />
      <span class="track"></span>说明
    </label>
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
        onbeforereconnect={onBeforeReconnect}
        onreconnect={onReconnect}
        isValidConnection={isValidConnection}
        ondelete={onDelete}
        onbeforedelete={onBeforeDelete}
        deleteKey={["Backspace", "Delete"]}
        onmoveend={onMoveEnd}
        onnodedragstart={onNodeDragStart}
        onnodedrag={onNodeDrag}
        onnodedragstop={onNodeDragStop}
        elevateNodesOnSelect={false}
        zIndexMode="manual"
        snapGrid={snapOn ? [16, 16] : undefined}
        fitView
        minZoom={0.15} maxZoom={2}
        connectionRadius={22}
      >
        <Background gap={16} />
        <Controls orientation="horizontal" position="bottom-left" />
        <MiniMap nodeColor={n => typeMap[n.type]?.color ?? "#8a97a8"} pannable zoomable />
        <CanvasDrop ondropat={dropAddNode} />
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
  <OpenModal mode={openModal.mode} onconfirm={doOpen} oncancel={() => (openModal = null)} />
{/if}

{#if runModal}
  <RunModal label={runModal.label} needProd={runModal.needProd} displayName={displayName}
    onrun={doRun} oncancel={() => (runModal = null)} />
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
  /* 开关（吸附/说明统一）：关=灰滑块居左，开=accent 滑块居右 */
  .switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; user-select: none; }
  .switch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .switch .track { width: 34px; height: 18px; border-radius: 999px; background: var(--panel2);
    border: 1px solid var(--line); position: relative; transition: background .15s, border-color .15s; flex: none; }
  .switch .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
    border-radius: 50%; background: var(--dim); transition: left .15s, background .15s; }
  .switch input:checked + .track { background: color-mix(in srgb, var(--accent) 30%, var(--panel2)); border-color: var(--accent); }
  .switch input:checked + .track::after { left: 18px; background: var(--accent); }
  .switch input:focus-visible + .track { outline: 1px solid var(--accent); }
  .dim { color: var(--dim); font-size: 12px; }
  .mono { font-family: var(--mono); }
</style>
