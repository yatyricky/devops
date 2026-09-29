<script>
  import { getContext, setContext } from "svelte";
  import { SvelteFlow, Background, Controls, MiniMap } from "@xyflow/svelte";
  import { api } from "./api.js";
  import { canConnect, effectiveInputs, effectiveOutputs, genId, validateTaskSelection, GROUP_BAR, groupBarHeight } from "./types.js";
  import { ui } from "./store.svelte.js";
  import DevNode from "./DevNode.svelte";
  import GroupBox from "./GroupBox.svelte";
  import Palette from "./Palette.svelte";
  import CanvasDrop from "./CanvasDrop.svelte";
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
  const components = $derived({ ...Object.fromEntries(Object.keys(typeMap).map(t => [t, DevNode])), groupbox: GroupBox });
  let currentEntry = $derived(wfList.find(w => w.path === currentPath));
  let selectedNodeIds = $derived(new Set(nodes.filter(n => n.selected).map(n => n.id)));

  // 节点卡片经 context 拿编辑/删除回调与连线查询（xyflow 自建组件树，props 传不进节点组件）

  /**
   * 编辑期解析某节点某输入口的当前值：连线（上游为 path.resolve 时递归推断）→
   * 上游按 outputValueKey 取 data 字段 → 未连线回读手填 lit。不可解 → undefined。
   */
  function resolvePortValue(nodeId, handleId, depth = 0) {
    if (depth > 8) return undefined;
    const e = edges.find(x => x.kind !== "seq" && !String(x.id).startsWith("tnl-") && x.target === nodeId && x.targetHandle === handleId);
    if (e) {
      const src = nodes.find(n => n.id === e.source);
      if (!src) return undefined;
      if (src.type === "path.resolve") return inferPathResolve(src, depth + 1);
      if (src.type === "string.join") return inferStringJoin(src, depth + 1);
      const key = typeMap[src.type]?.outputValueKey ?? handleId;
      return src.data?.[key];
    }
    const self = nodes.find(n => n.id === nodeId);
    return self?.data?.lit?.[handleId];
  }

  /**
   * path.resolve 编辑期输出推断（与引擎 run 同语义）：
   * 全部 pN 来源为 string 常量接入或手填（lit）→ 返回拼接结果；任一非常量来源 → undefined（运行时才知道）。
   */
  function inferPathResolve(src, depth = 0) {
    const count = Math.min(16, Math.max(1, Number(src.data.count ?? 2) || 2));
    const style = ["posix", "windows", "auto"].includes(src.data.style) ? src.data.style : "posix";
    const home = localStorage.getItem("devops-home") ?? ""; // 不可用时 ~ 原样保留
    const expandHome = v => (v === "~" ? (home || "~") : v.startsWith("~/") ? (home ? home + v.slice(1) : v) : v);
    const norm = v => expandHome(String(v)).replace(/\\/g, "/");
    const segs = [];
    for (let i = 1; i <= count; i++) {
      const v = String(resolvePortValue(src.id, `p${i}`, depth) ?? "").trim();
      if (!v) return undefined; // 任一段不可静态确定 → 整体不可推断
      segs.push(norm(v));
    }
    const isAbsBase = seg => seg.startsWith("/") || /^[A-Za-z]:\//.test(seg);
    let full = "";
    for (const seg of segs) {
      full = (!full || isAbsBase(seg)) ? seg : `${full.replace(/\/+$/, "")}/${seg}`;
    }
    let out = full || "/";
    if (style === "windows") out = out.replace(/\//g, "\\");
    else if (style === "auto" && /^[A-Za-z]:\//.test(out)) out = out.replace(/\//g, "\\");
    return out;
  }

  /**
   * string.join 编辑期输出推断（与引擎 run 同语义）：
   * 全部 pN 来源为 string 常量接入或手填（lit）→ 返回拼接结果；任一非常量来源 → undefined（运行时才知道）。
   */
  function inferStringJoin(src, depth = 0) {
    const count = Math.min(16, Math.max(1, Number(src.data.count ?? 2) || 2));
    const delimiter = String(src.data.delimiter ?? "");
    const segs = [];
    for (let i = 1; i <= count; i++) {
      const v = String(resolvePortValue(src.id, `p${i}`, depth) ?? "").trim();
      if (!v) return undefined; // 任一段不可静态确定 → 整体不可推断
      segs.push(v);
    }
    return segs.join(delimiter);
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
      return edges.some(e => e.kind !== "seq" && !String(e.id).startsWith("tnl-") && e.target === nodeId && e.targetHandle === handleId);
    },
    /** 某输入口的连线源节点（struct.split 回溯上游字段定义用） */
    getSourceNode(nodeId, handleId) {
      const e = edges.find(e => e.kind !== "seq" && !String(e.id).startsWith("tnl-") && e.target === nodeId && e.targetHandle === handleId);
      return nodes.find(n => n.id === e?.source);
    },
    resolveInput(nodeId, handleId) {
      return resolvePortValue(nodeId, handleId);
    },
    /** Group 隧道：某组的跨组边（入 = 组外→组内；出 = 组内→组外），与编号 effect 同序 */
    groupEdges(gid) {
      return crossEdges(groupBoxOf(gid));
    },
    /** 收起/展开黑箱条：成员 hidden 联动 + 组尺寸条形化/恢复 AABB */
    oncollapse(gid, collapsed) {
      const g = groupBoxOf(gid);
      if (!g) return;
      const members = g.data.memberIds ?? [];
      const barH = collapsedHeight(g);
      nodes = nodes.map(n => {
        if (n.type === "groupbox" && n.data.__gid === gid) {
          if (collapsed) {
            return { ...n, data: { ...n.data, collapsed: true }, width: collapsedWidth(g), height: barH };
          }
          const aabb = groupAABB(members) ?? { width: 320, height: 200 };
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
      const note = String(n.data?.note ?? "").trim();
      const title = `${meta?.title ?? n.type}${note ? ` - ${note}` : ""}`;
      const port = (side === "in" ? effectiveInputs(meta, n.data) : effectiveOutputs(meta, n.data))
        .find(p => p.id === hid);
      if (!port) return title;
      const req = side === "in" && port.required ? "*" : "";
      return `${title}: ${port.id} (${port.type}${port.dynamic ? "⭑" : ""})${req}`;
    },
    /** 渲染模板：解析模板文件 → { vars, basename } 或 { error }（configDir 取当前工作流目录） */
    async resolveTplVars(p) {
      const dirOf = x => { const i = Math.max(x.lastIndexOf("/"), x.lastIndexOf("\\")); return i > 0 ? x.slice(0, i) : x; };
      return api("/api/template/vars", { method: "POST", body: JSON.stringify({
        path: p, configDir: currentPath ? dirOf(currentPath) : "", repoDir: docRepoDir,
      }) });
    },
    /** 编辑期输出推断：path.resolve → 拼接推断值；string.join → 分隔符拼接推断值；渲染模板 → .tmp 产物路径；其余 undefined */
    inferOutput(nodeId) {
      const n = nodes.find(x => x.id === nodeId);
      if (!n) return undefined;
      if (n.type === "path.resolve") return inferPathResolve(n);
      if (n.type === "string.join") return inferStringJoin(n);
      if (n.type === "template.render") return n.data?.inferredOut;
      return undefined;
    },
  });

  function showToast(msg) { toast = msg; setTimeout(() => (toast = ""), 3000); }

  // ── 初始化 ────
  $effect(() => { (async () => {
    metas = await api("/api/node-types");
    ui.nodeTypesMap = Object.fromEntries(metas.map(m => [m.type, m]));
    wfList = await api("/api/workflows");
    api("/api/home").then(r => localStorage.setItem("devops-home", r.home ?? "")).catch(() => {});
    await refreshUsage();
    const first = wfList.find(w => w.name);
    if (first) await selectWorkflow(first.path);
  })(); });

  /** 「未测试」清单（手工维护，存 local-config.untestedNodeTypes） */
  async function refreshUsage() {
    try { ui.untestedNodeTypes = new Set((await api("/api/node-usage")).untested ?? []); } catch { /* 静默 */ }
  }

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
      .map(g => makeGroupNode(g.id, g.name ?? "新分组", g.color ?? "#4da3ff", (g.nodes ?? []).filter(id => nodes.some(n => n.id === id)), !!g.collapsed));
    if (groupBoxes.length) {
      // 成员卡片抬到自己组的背景板之上（与 groupSelected 同一层级体系）
      const members = new Set(groupBoxes.flatMap(g => g.data.memberIds ?? []));
      nodes = [...nodes.map(n => (members.has(n.id) ? { ...n, zIndex: 2 } : n)), ...groupBoxes];
    }
    hoverTask = null; definer = null;
    ui.runTaskNodes = null; ui.nodeRunStatus = null; ui.runNodeInputs = null;
    ignoreDirtyUntil = Date.now() + 1000;
  }
  function toDoc() {
    const realNodes = nodes.filter(n => n.type !== "groupbox");
    return {
      ...(title ? { title } : {}),
      version: 1,
      ...(docRepoDir ? { repoDir: docRepoDir } : {}),
      nodes: realNodes.map(n => ({ id: n.id, type: n.type, position: [Math.round(n.position.x), Math.round(n.position.y)], data: stripDecor(n.data) })),
      edges: edges.filter(e => !String(e.id).startsWith("tnl-")).map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, ...(e.kind ? { kind: e.kind } : {}) })),
      tasks: JSON.parse(JSON.stringify(tasks)),
      // 分组：从 groupbox 节点还原（空组丢弃——全部成员删掉的组不再保留；collapsed 随条持久化）
      groups: nodes.filter(n => n.type === "groupbox").map(g => ({
        id: g.data.__gid, name: g.data.name, color: g.data.color, collapsed: !!g.data.collapsed,
        nodes: (g.data.memberIds ?? []).filter(id => realNodes.some(m => m.id === id)),
      })).filter(g => g.nodes.length),
    };
  }
  function stripDecor(data) {
    return Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith("__")));
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
    if (!confirmTaskRemoval([id])) return;
    nodes = nodes.filter(n => n.id !== id);
    edges = edges.filter(e => e.source !== id && e.target !== id);
    stripFromTasks([id]);
    stripFromGroups([id]);
    markCritical();
  }

  // ── 分组：groupbox 背景板 = 专用 xyflow 节点（zIndex 垫底、不可 DEL），位置尺寸由成员实时 AABB 计算；
  //    成员-组关系存在 data.memberIds，落盘时从 groupbox 节点还原成 doc.groups。 ────
  // GROUP_PAD_X 左右留白加大：给隧道接口↔组内节点的转发段边留出横向空间走曲线（直贴边像渲染错误）
  const GROUP_PAD = 14, GROUP_PAD_X = 150, GROUP_PAD_TOP = 42;
  const GROUP_COLORS = ["#4da3ff", "#4cc38a", "#f5a623", "#ff6b6b", "#b18cff", "#56b6c2"];
  /** 成员 AABB + padding；成员为空返回 null */
  function groupAABB(memberIds) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = 0;
    for (const id of memberIds) {
      const m = nodes.find(n => n.id === id);
      if (!m || m.type === "groupbox") continue;
      found++;
      const w = m.measured?.width ?? 240, h = m.measured?.height ?? 60;
      minX = Math.min(minX, m.position.x); minY = Math.min(minY, m.position.y);
      maxX = Math.max(maxX, m.position.x + w); maxY = Math.max(maxY, m.position.y + h);
    }
    if (!found) return null;
    return { x: minX - GROUP_PAD_X, y: minY - GROUP_PAD_TOP,
      width: (maxX - minX) + GROUP_PAD_X * 2, height: (maxY - minY) + GROUP_PAD_TOP + GROUP_PAD };
  }
  /** 按 __gid 定位 groupbox 节点——xyflow 节点 id 是 `grp-${gid}`，别按裸 id 找 */
  function groupBoxOf(gid) {
    return nodes.find(n => n.type === "groupbox" && n.data.__gid === gid) ?? null;
  }
  /** 某组的跨组边（入 = 组外→组内；出 = 组内→组外）；过滤 tnl- 派生段边 */
  function crossEdges(gbox) {
    const members = new Set(gbox?.data.memberIds ?? []);
    const inE = [], outE = [];
    for (const e of edges) {
      if (String(e.id).startsWith("tnl-")) continue;
      const sIn = members.has(e.source), tIn = members.has(e.target);
      if (sIn && !tIn) outE.push(e);
      else if (!sIn && tIn) inE.push(e);
    }
    return { in: inE, out: outE };
  }
  /** 收起黑箱条规格：宽=与成员卡片一致（成员实测宽最大值，卡片内容自适应无统一常量；未测量回退 230）；
   *  高=标题行 + 入口分栏 + 分隔线 + 出口分栏 + 页脚（types.js 同源公式） */
  const GROUP_COLLAPSED_W = 230;
  function collapsedWidth(gbox) {
    let w = 0;
    for (const id of gbox?.data.memberIds ?? []) {
      const m = nodes.find(n => n.id === id);
      w = Math.max(w, m?.measured?.width ?? 0);
    }
    return Math.round(w) || GROUP_COLLAPSED_W;
  }
  function collapsedHeight(gbox) {
    const r = crossEdges(gbox);
    return groupBarHeight(r.in.length, r.out.length);
  }
  function makeGroupNode(gid, name, color, memberIds, collapsed = false) {
    const aabb = groupAABB(memberIds) ?? { x: 80, y: 80, width: 320, height: 200 };
    const data = { __gid: gid, name, color, memberIds: [...memberIds], collapsed };
    return {
      id: `grp-${gid}`, type: "groupbox", position: { x: aabb.x, y: aabb.y },
      width: collapsed ? collapsedWidth({ data }) : aabb.width,
      height: collapsed ? collapsedHeight({ data }) : aabb.height,
      // 层级：组外节点(0) < 背景板(1) < 组内成员(2)
      zIndex: 1,
      draggable: true, selectable: true, deletable: false,
      data, selected: true,
    };
  }
  let groupableIds = $derived(nodes.filter(n => n.type !== "groupbox" && n.selected).map(n => n.id));
  let selectedGroupBox = $derived(nodes.find(n => n.type === "groupbox" && n.selected) ?? null);
  /** 【组合】：shift+框选 >1 节点 → 建组（节点只属一个组，先从既有组移除） */
  function groupSelected() {
    const ids = groupableIds;
    if (ids.length < 2) return;
    const idSet = new Set(ids);
    nodes = nodes.map(n => (n.type === "groupbox" && (n.data.memberIds ?? []).some(x => idSet.has(x)))
      ? { ...n, data: { ...n.data, memberIds: n.data.memberIds.filter(x => !idSet.has(x)) }, selected: false } : n);
    nodes = [...nodes, makeGroupNode(genId("grp"), "新分组", GROUP_COLORS[0], ids)];
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
    nodes = nodes.map(n => (n.type === "groupbox" && n.data.__gid === gid)
      ? { ...n, data: { ...n.data, ...patch } } : n);
    markCritical();
  }
  /** 色板开关：打开时背景板临时置顶——色板作为板的子元素压不过成员卡片（板常态 z1，见 makeGroupNode） */
  function onPalette(gid, open) {
    nodes = nodes.map(n => (n.type === "groupbox" && n.data.__gid === gid)
      ? { ...n, zIndex: open ? 1000 : 1 } : n);
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
  /** @param {{ nodes: any[], edges: any[] }} p xyflow 内置删除键（DEL/Backspace）触发；收起态隧道段边不可删 */
  function onBeforeDelete({ nodes: delNodes, edges: delEdges }) {
    if (!confirmTaskRemoval(delNodes.map(n => n.id))) return false;
    return { nodes: delNodes, edges: delEdges.filter(e => !String(e.id).startsWith("tnl-")) };
  }
  function onDelete({ nodes: delNodes, edges: delEdges }) {
    if (delNodes.length) { stripFromTasks(delNodes.map(n => n.id)); stripFromGroups(delNodes.map(n => n.id)); markCritical(); }
    else if (delEdges.length) markCritical();
  }
  function onMoveEnd() { if (Date.now() > ignoreDirtyUntil) layoutDirty = true; }

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
        const barH = collapsedHeight(n);
        const barW = collapsedWidth(n);
        return (n.width === barW && n.height === barH) ? n : { ...n, width: barW, height: barH };
      }
      const aabb = groupAABB(n.data.memberIds ?? []);
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
      if (String(e.id).startsWith("tnl-")) continue;
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
    if (edges.some(e => !String(e.id).startsWith("tnl-") && hide.has(e.id) !== !!e.hidden)) {
      edges = edges.map(e => (String(e.id).startsWith("tnl-") || hide.has(e.id) === !!e.hidden) ? e : { ...e, hidden: hide.has(e.id) });
    }
    // 幂等 diff：段边补缺/去多/清 stale
    const curTnl = new Map(edges.filter(e => String(e.id).startsWith("tnl-")).map(e => [e.id, e]));
    const missing = [...want].filter(w => {
      const c = curTnl.get(w.id);
      return !c || c.hidden || c.source !== w.source || c.target !== w.target || c.sourceHandle !== w.sourceHandle || c.targetHandle !== w.targetHandle;
    });
    const stale = [...curTnl.keys()].filter(id => !want.some(w => w.id === id));
    if (missing.length || stale.length) {
      edges = [...edges.filter(e => !stale.includes(e.id)), ...missing.map(w => ({ ...w, animated: false }))];
    }
  });

  // 连线动画跟随选中：仅与选中节点相连（或被选中）的数据边播放虚线动画；顺序边恒为静态。
  // EdgeWrapper 只响应 edge 对象引用变化，因此必须整组替换对象，不能就地改属性。
  $effect(() => {
    const anim = e => e.kind !== "seq" && !String(e.id).startsWith("tnl-") && (selectedNodeIds.has(e.source) || selectedNodeIds.has(e.target) || !!e.selected);
    if (edges.some(e => !!e.animated !== anim(e))) {
      edges = edges.map(e => ({ ...e, animated: anim(e) }));
    }
  });

  // ── 动态出口：源节点的有效出口不含某边的 sourceHandle 时，该边自动消失 ────
  // 例：struct.split 的上游字段删除 → 对应出口上的连线随之断开。出口列表未知（[] 由规则明确给出）也删。
  $effect(() => {
    const dead = edges.filter(e => {
      if (e.kind === "seq" || String(e.id).startsWith("tnl-")) return false; // tnl- 是派生段边（伪句柄），删除会与隧道 effect 无限乒乓
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
      task: taskName, label: t.label ?? taskName, mutates: !!t.mutates,
      inputs: [],
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
    ui.runNodeInputs = null;
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
      ui.runNodeInputs = {};
      await logRef?.follow(id, `${displayName}/${m.task}${m.dryRun ? " (dry-run)" : ""}`, {
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
    <button title="刷新画布上所有下拉列表（git refs / npm scripts / ssh 别名）" onclick={() => ui.refreshTick++}>刷新列表</button>
    <span class="sep"></span>
    <button title="克隆选中的节点：常量属性复制、连线不复制，位置偏移 (40,40)"
      disabled={!groupableIds.length} onclick={cloneSelected}>克隆</button>
    <button title="把当前选中的多个节点编为一组" disabled={groupableIds.length < 2} onclick={groupSelected}>组合</button>
    <button title="拆散选中的分组（成员位置不动）" disabled={!selectedGroupBox} onclick={ungroupSelected}>拆分</button>
    <label class="mut" title="开启后移动节点按 16px 网格吸附（以节点左上角为基准）">
      <input type="checkbox" bind:checked={snapOn} onchange={snapChange} /> 吸附
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
        isValidConnection={isValidConnection}
        ondelete={onDelete}
        onbeforedelete={onBeforeDelete}
        deleteKey={["Backspace", "Delete"]}
        onmoveend={onMoveEnd}
        onnodedragstart={onNodeDragStart}
        onnodedrag={onNodeDrag}
        onnodedragstop={onNodeDragStop}
        elevateNodesOnSelect={false}
        snapGrid={snapOn ? [16, 16] : undefined}
        fitView
        minZoom={0.15} maxZoom={2}
        connectionRadius={22}
      >
        <Background />
        <Controls />
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
