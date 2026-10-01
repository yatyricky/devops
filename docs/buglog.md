# Bug 记录（回归用）

> **工作约定**：每条 bug 反馈记录于此（现象/根因/修复/回归步骤）。后续新需求或新 bug 若与既有修复方式**矛盾**，必须先停下提请用户决策，不得静默推翻。

---

## BUG-2026-09-25-01 连线双写：删一条线要删两次；"线未渲染但已连接"

- **现象**：拖一条线会意外产生两条同端点边；删除时第一条删掉视觉无变化（重叠），要删两次。"未渲染但已连接"即其中一条的观感。
- **根因**：Svelte Flow 1.6.6 的 `Handle.svelte → onConnectExtended` 在触发 `onconnect` 回调**之前**已 `store.addEdge` 写入（bind 写回 edges），且回调执行时写回尚未落地——旧 `onConnect` 的防重检查读到旧数组落空，又手动 push 一次。
- **修复**：校验移入 `isValidConnection`（false 则库不加边）；`onconnect` 只标脏，绝不再手动 push；`loadDoc` 按四元组去重修复存量数据。
- **回归**：拖同一条线两次 → edges 只 +1；选中边按一次 Delete 即消失。
- **状态**：已修复（30f6254）。

## BUG-2026-09-25-02 struct 构造器 key/value 输入框过小

- **根因**：struct 行是唯一含 `<select>` 的行，`.trow select` 无 flex 规则，继承全局 `width:100%` 把两个 `flex:1` 输入框挤到 0 宽。
- **修复**：`.devnode .body .trow select { flex: none; width: auto; }`。
- **回归**：Struct 构造器节点字段行 key/value 可见。**状态**：已修复（457b9ea）。

## BUG-2026-09-25-03 struct 改已连线字段 key 后重连，连线不渲染（保存刷新才恢复）

- **现象**：改已连线字段 key（旧边断开正常），从新 key 出口重连，连线不渲染；保存+刷新后才显示。
- **根因（多层，2026-09-25 排查）**：
  1. `isValidConnection` 未解析动态出口（`struct.split` 声明 outputs 为 `[]`，动态出口靠 `effectiveOutputs`）→ 动态出口连线被全拒。已修：`isValidConnection` 对 `dynamicOutputs` 节点走 `effectiveOutputs`。
  2. **运行环境缺陷**：本机内嵌 webview 的 `requestAnimationFrame` **永不投递**（实测 timeout）、ResizeObserver 回调随之不投递。Svelte Flow 重测 handleBounds（`useUpdateNodeInternals`）内部走 rAF → 不执行 → 新 handle 不进 handleBounds → 连接发起失败（连接线从未出现）与边不渲染。
- **修复**：
  - `DevNode.svelte`：`$effect` 监听**动态解析后**的 inputs/outputs 集签名（注意：不能用 `meta.outputs`——struct.split 恒为空），变化后 `updateNodeInternals(id)`。
  - `index.html`：**rAF 竞争式兜底**（原生 rAF 与 40ms setTimeout 同排，先到先执行）+ RO 兜底轮询。正常浏览器零变化。
- **回归**：干净加载后改一个已连线字段 key → 立即从新 key 出口拖线到任意兼容输入 → 边立即渲染，无需保存刷新。
- **状态**：修复已实施；**在真实 Chrome 中请回归确认**。内嵌 webview 中仍观察到首次连线偶发失败（重连或稍候即成功），疑与该 webview 渲染帧缺失的深层环境问题有关，见 BUG-04。

## BUG-2026-09-25-04 运行环境：webview 的 rAF/ResizeObserver 不投递

- **现象**：依赖渲染帧的浏览器 API（rAF、RO 回调）在此内嵌 webview 中不工作；普通 Chrome/Edge 正常。
- **缓解**：`web/index.html` 头部有 rAF 竞争兜底 + RO 轮询兜底（对正常浏览器零影响）。凡新代码用 rAF/RO 做关键路径，需考虑兜底是否覆盖。
- **状态**：已缓解，环境无法根治。

## BUG-2026-09-25-05 内存/磁盘状态脱节：未保存的改动导致部分接口失败

- **现象**：GUI 里改了图（未保存）→ 运行任务、等接口读到旧磁盘数据 → "保存一下才正常"。
- **修复（按用户决策）**：
  - 修改1：`POST /api/jobs` 支持内存态执行——GUI 运行时把内存图 `toDoc()` 随请求传给后端，后端校验后以内存为准（CLI 仍读盘）。
  - 修改2：关键变更自动写盘——serializable 字段编辑、node/edge 增删改、任务定义/删除、name/title/repoDir 修改触发 `markCritical()`（600ms 防抖自动保存）；节点位置等展示信息仍需手动"保存"。dirty 拆分为 `autoDirty`/`layoutDirty`。
- **回归**：GUI 改图不点保存 → 跑任务用新改动；改 serializable 字段 → 磁盘 JSON 600ms 内自动更新；拖动节点 → 磁盘不变、出现"保存 \*"。
- **状态**：已实施。

## 遗留待办

- xlgbis 仓库自身的耦合缺陷（deploy_server.js 副作用导入、packages/common 双用途、env-usage 退出遥测、失效 dev 脚本）——另开任务。
- 已删除的旧层（apps/ JS 清单、线性步骤 workflow.js、脚本模板）如需参考见 git 历史（954c0b0 及之前）。

## BUG-2026-09-27-01 便笺按钮点击无效（noteOpen 状态声明在并行编辑中丢失）

- **现象**：节点卡片右下角「便笺」按钮点击无任何反应——不展开 textarea，无法输入备注。
- **根因**：多会话并行编辑 `DevNode.svelte` 时，一轮"清理残留"把便笺的 `noteOpen` 状态声明与 textarea 渲染块删除，但 `notebtn` 按钮的 markup 仍在——`onclick={() => (noteOpen = !noteOpen)}` 引用未声明变量，点击静默无效。教训：并行修改同一组件时，模板引用的标识符必须随删除一并清理引用方，或恢复时整体恢复。
- **修复**：补回 `let noteOpen = $state(false)` 与 `{#if noteOpen}` 的 `.noterow` textarea 渲染块（绑定 `data.note` 实时保存）。
- **回归**：SSH 会话节点 → 点便笺 → textarea 展开 → 输入实时存 `data.note`（__dbg 断言）→ 再点收起。
- **状态**：已修复（浏览器实测通过）。

## BUG-2026-09-27-02 wired 输入悬停 tooltip 不显示实时运行值

- **现象**：任务运行后，wired 输入的 disabled 预览框 `title` 仍显示编辑期解析值（运行时产出节点显示「（运行时）」），而非节点实际收到的运行值；用户需框选截断文本才能看全。
- **根因**：wired-live 分支的 `title` 是静态文案「运行中实时值（连线优先）」，未绑定 `liveVal`。
- **修复**：live 分支 `title={liveVal}`（悬停即完整实时值）；wired-preview 分支 title 同步为 `值来自连线：<解析值>`。
- **回归**：运行任务 → 悬停 wired 输入框 → tooltip 显示运行时实际值。
- **状态**：已修复。

## BUG-2026-09-28-01 ssh.upload 上传 root 目录报 Permission denied

- **现象**：kids-ledger-prod 的「打包」任务在 Upload File（nginx 配置 → `/etc/nginx/sites-available/kids-ledger`）失败：`mkdir -p` 正常，SFTP 上传直接 `Permission denied`。
- **根因**：`ssh.upload` 用 node-ssh `putFile`（SFTP）以 SSH 登录用户直写目标路径；SFTP 通道无法 sudo，root 属主目录必然被拒。
- **修复（engine/nodes/remote.js）**：直写优先、失败自动回退（无新控件，循 Symlink 恒 `sudo -n` 先例）：
  - `mkdir -p` 权限不足自动重试 `sudo -n mkdir -p`，再失败抛两段错误；
  - 直写 `putFile` 抛 permission/denied/EACCES/EPERM 类错误 → 暂存 `/tmp/devops-upload-<rand>/` → `bash -lc 'sudo -n install -m 644 <staged> <目标>'` → `rm -rf` 暂存目录（try/finally 保证清理）；install 失败抛组合错误（含原始直写错误）；
  - 回退落盘 root:root 0644（对 nginx sites-available 正确）；直写成功路径行为不变（/opt 等用户目录无属主副作用）；非权限错误原样抛出不掩盖。
  - 顺带修正文件头注释残留的"上传 always-clean 自动清理"描述（与已裁定"无 trap"矛盾）。
- **回归**：`node tools/verify-dryrun.js` 新增 4 条 mock 会话断言（直写成功无 sudo；权限不足回退 install+清理；非权限错误原样抛出；mkdir 回退 sudo）。44/44 通过。真实链路验证由用户重跑「打包」任务。
- **状态**：已实施（待用户真实链路确认）。

## BUG-2026-09-28-02 复合命令的 sudo 只覆盖第一段（Nginx Reload 失败）

- **现象**：Nginx Reload 节点报 `Failed to reload nginx.service: Interactive authentication required`（code=1）；日志命令为 `bash -lc 'sudo -n nginx -t && systemctl reload nginx'`——`nginx -t` 提权通过，`systemctl reload` 裸跑被 polkit 拒绝。用户已手动验证 `sudo -n systemctl reload nginx` 正常。
- **根因**：`buildCommand` 的 `sudo -n` 只前缀整个命令串的开头，复合命令（`&&`/`;`）的后续段落以登录用户执行。
- **修复（engine/nodes/remote.js）**：`buildCommand` 新增 `sudoWrap` 选项——`sudo -n bash -c '<整段>'`；`remote.nginx-reload` 与 `ssh.exec`（逐行执行，行内复合命令同样受益）改用之。`remote.service` 各 step 本就是单一命令、`remote.check` 显式不提权，均不受影响。desc 同步更新。
- **回归**：verify 新增断言（nginx-reload 与 ssh.exec 的 dry-run 命令形状 = `sudo -n bash -c 'nginx -t && systemctl reload nginx'`）。45/45 通过。真实链路由用户重跑「打包」任务确认 reload 成功。
- **状态**：已实施（待用户真实链路确认）。

## BUG-2026-09-28-03 Symlink 端口调换未同步既有连线，两个 Symlink 节点全部反向执行

- **现象**：服务器出现循环符号链接 `sites-available/kids-ledger -> sites-enabled/kids-ledger`（黑底红字，把刚上传的真配置顶掉了）；发布切换链同样反向。
- **根因**：应"link/target 控件位置调换"要求改端口顺序时，`ln -sfn` 实参顺序也一并翻转了——接线按 handleId 记录不会跟着动，旧连线的语义效果整体反转。正确做法本应是只动其一：要么只换端口位置、要么只换实参顺序。
- **修复（按用户决策还原）**：`remote.symlink` 还原为调换前形态——端口顺序 `[ssh, target, link]`，run 实参 `ln -sfn <link> <target>`（link 口=第一参数=链指向的目标；target 口=第二参数=要创建的符号链接）。既有接线无需改动即恢复正确：nginx 链 `ln -sfn sites-available/kids-ledger sites-enabled/kids-ledger`；发布切换 `ln -sfn releases/<ts> client-live`。desc 已明确端口语义。
- **回归**：verify 新增 ln 实参顺序锁定断言（含端口顺序），46/46 通过。服务器侧一次性清理（删循环坏链）由用户执行后重跑「打包」确认。
- **状态**：已实施（待用户真实链路确认）。
- **更正（同日）**：BUG-2026-09-28-03 的还原保留了旧反向命名（link 口装真实路径），用户按标准语义（target=真实路径，link=symlink）自行调换接线后再次反向。终态以标准语义为准：端口 `[ssh, target, link]`，run `ln -sfn <target> <link>`——target 口=真实路径（第一参数）、link 口=符号链接（第二参数），名字=含义=命令行顺序；verify 锁定断言已同步翻转。

## BUG-2026-09-29-01 任务悬停高亮失效（hoverTask → pathHighlight 写回 effect 丢失）

- **现象**：悬停任务按钮不再临时高亮其包含节点（此前正常）。
- **根因**：多轮大块脚本编辑 App.svelte 时，`activeSet` derived 与写回 `ui.pathHighlight` 的 `$effect` 整段丢失（hoverTask 状态与按钮 onmouseenter/onmouseleave 绑定仍在，断链在写回层）。
- **修复**：补回 derived（hoverTask → tasks[..].nodes/path；definer 模式 → definer.nodes）+ `$effect` 写 `ui.pathHighlight = Object.fromEntries(p.map(id => [id, true]))`。
- **教训（流程）**：对大文件的整块 python 正则/脚本替换必须逐符号 grep 核对删除与残留清单，禁止凭脚本输出"成功"即认为完成——本轮同一时期还有 onNodeDragStop 整函数、onnodedrag/onnodedragstart 绑定、onNodeDragStopWrap 残留等同源丢失，均已补回/清理。
- **回归**：浏览器悬停任一任务按钮 → 路径上节点以橙色虚线框点亮，移开即灭。已实测通过。
- **状态**：已修复（22911f4）。

## BUG-2026-09-29-02 groupbox 清理残留：onNodeDragStop 整函数误删 + 失效绑定/变量报错

- **现象**：页面初始化即抛 `onNodeDragStop/onNodeDrag/onNodeDragStart/groupableIds is not defined` 系列错误，节点不可拖动。
- **根因**：移除 groupbox 背景板（被 Group 真容器取代）时清理不彻底——`onNodeDragStop`（拖动停止 reparent + 位置记账）整函数被误删、`onnodedrag`/`onnodedragstart` 绑定与 `groupableIds` 坏引用残留。
- **修复**：恢复 onNodeDragStop（Group reparent + 位置记账 + layoutDirty）；删除 onnodedrag/onnodedragstart 失效绑定与「组合/拆分」按钮（建组交互由 Group 拖入取代）。
- **教训**：删除功能时必须 grep 全部符号引用清零后再构建，且构建后必须浏览器回归一轮再提交。
- **回归**：拖动任意节点正常、无控制台报错；Group 卡片 ✕ = 拆组（成员保留）。
- **状态**：已修复（5c269d0）。

## BUG-2026-09-29-03 Group 隧道/收缩三连失效：组合丢线 + 边框插槽不渲染 + 收起按钮无反应（同一根因）

- **现象**：① 点「组合」后跨组连线消失；② group 边框上看不到 tunnel 插槽，外部线没接到插槽、插槽没连到组内节点（出口方向同样）；③ 收起/展开按钮点击无反应。
- **根因（一个 id 错配）**：groupbox 节点的 xyflow id 是 `grp-${gid}`（makeGroupNode），`data.__gid` 才是裸 gid；但 `groupEdges`/`oncollapse` 按 `n.id === gid` 查找永不命中（插槽恒空、按钮空转），隧道段边 effect 又把段边端点写成裸 gid——段边指向不存在的节点不被渲染，而原跨组边同 effect 已被置 `hidden: true`，于是"隐藏成功、替身失败"＝组合瞬间丢线。组名/颜色编辑（onGroupData/onPalette）本就按 `__gid` 查找，所以只有这三处坏。
- **连带隐患（同轮修）**：`tunnelCountOf` 按 tnl 段边计数（端点修好后 -a/-b 双倍计数）→ 改按非 tnl 跨组边取 max(入,出)；收起条高度三处常量打架（36/40/60）且未落实「宽=230」→ 统一 collapsedSize 规则（宽 230、高 40+20×max(入,出)）；loadDoc 重建组已带 collapsed 但需同步 hidden 成员（加载即隐藏）；GroupBox 收起态 CSS 写 `.tcoll` 标记是 `.tcol`（永不生效），且 xyflow Handle 基类 `position:absolute`、flex 列排不动它 → 收起态改内联 top 定位；`resolvePortValue`/`isWiredAsTarget`/`getSourceNode`/连线动画 effect 的边查找补 `tnl-` 过滤（此前靠数组顺序碰巧先命中原边）。
- **验证期追加根因②（段边只渲染一半）**：xyflow 边按 handle 类型（source/target）分区查锚点——`tunnel-in-*` 只渲染成 target 型时，段边 `-b`（以它为 sourceHandle）查不到锚点整条不渲染，out 侧对称。修复：每个隧道位渲染同 id 的 source+target 双类型 Handle（可见的一个 + 透明同位孪生），孪生的 position 顺带调顺段边出线方向（in 的 source 朝右、out 的 target 朝左）。
- **回归**：临时 wf 上建组 → 跨组连线 → 左右缘出现插槽点且双段转发线可见（外部源→组缘入口、组缘出口→组内目标）→ 点收起：成员隐藏、组收缩为宽 230 黑箱条、外部线仍接条缘、标题显示入/出计数 → 点展开：成员恢复、板体 AABB 包裹成员 → 保存/刷新后收起态还原。
- **状态**：已修复（本次提交）。

## BUG-2026-09-29-04 Group 打磨四项：出口段边接错入口 / 接口未压边不同尺寸 / 背景板层级 / 收起条带标签分栏

- **现象**：① 组内连向组出口的 nodes 接到了入口；② 隧道口未压在 group 边框上、比普通插槽小；③ 背景板层级要求 组外节点 < 背景板 < 自己的成员；④ 收起条要在插槽处展示 `<节点标题>: <端口label>`（超宽截断 + title 悬停），入口在上左对齐、分隔线后出口在下右对齐，总高 = 标题 + 入口 + 出口 + 页脚（原出口插槽贴圆角）。
- **根因①**：CSS 绝对定位同时声明 left/right 时 left 获胜——出口孪生 Handle 内联 `right:-4.5px` 被 xyflow 位置类自带的 `left:-4px` 压住，锚点被钉在左缘。修复：孪生两侧都显式 `left:auto/right:auto`（GroupBox 展开+收起两态）。
- **修复②③**：隧道口统一 9px（与 `.devnode` 普通插槽同尺寸）、`±4.5px` 压边框中线，圆形保留；层级体系 板 zIndex 1、成员 2（组合/loadDoc 抬 2、拆分回 0、色板置顶仍 1000/回落 1）；配套 `.svelte-flow__node-groupbox { pointer-events:none }`（app.css）+ 板内 `.ghead/.tlabel` 显式 auto——被板盖住的组外节点仍可点选，交互集中在标题行与标签。
- **修复④**：types.js 新增 `GROUP_BAR{header:36,row:20,div:9,pad:8}` + `groupBarHeight/groupBarRowTop`（App 算高与 GroupBox 渲染行同源）；收起高度公式改为 `36+nIn×20+(双向都有?9:0)+nOut×20+8`；App context 新增 `tunnelLabel(edge, side)`（入侧=目标口/出侧=源口，格式镜像 DevNode，节点标题后缀取 data.note）；`.collapsed .ghead` 锁 36px。
- **回归**：临时 wf（入1+出2+组内边）组合后：入口两锚点在左缘、出口两锚点在右缘（归一化 cx≈0/1）；收起条实测高 113=公式值，入口行 `Print Log - 打印入口: value (any)*` 左对齐、分隔线 top 61、出口两行右对齐、title 属性可悬停；刷新后收起态与标签完整还原；无控制台报错。
- **状态**：已修复（本次提交）。
- **更正（同日）**：④的「9px 压边」实现写错了——xyflow 位置类自带 `left:0/right:0 + translate(±50%,-50%)`（设计即圆点居中于容器边线，节点卡接口同理），内联再写 `±4.5px` 被 translate 叠加半宽，圆点整体飘到边框外 ≈9px。终态：可见口不写 left/right（交位置类居中），反向孪生显式 `left:0/right:0 + translate(∓50%,-50%)` 换边。实测六个 Handle 圆心距组框左右缘均 ≈1px（边框宽度级误差），展开/收起两态截图确认压线。
- **更正2（同日）**：收起条宽度由固定 230 改为与成员卡片一致——取组内成员实测宽最大值（collapsedWidth，卡片内容自适应无统一常量；展开过一次才有测量值，冷加载直接是收起态时回退 230）。实测条宽 320 = 成员卡最大宽，收起↔展开循环稳定。

## BUG-2026-09-29-06 Group 行为重大调整：展开态回归直连 / 收起态锁增删 / 标题条分色 / 刷新列表挪位 / 克隆

- **需求**：① 展开态保持 411e38d 的直连边样子（大图下直观看到节点如何连接，连线增删零改动）；② 收起态维持 900010a 行为；③ 收起态与组相连的边无法增删；④ 标题栏样式与板底区分（两态通用）；⑤ 刷新列表挪到「定义任务」旁；⑥ 新增「克隆」：选中 1+ 节点各复制一份，常量属性复制、连线不复制、偏移 (40,40)。
- **实现**：隧道 effect 仅对 collapsed 组生效（展开组不隐藏边、不生成段边）；新增 hidden 同步 pass——hide 集内必 hidden、集外真实边必可见（修复收起→展开直连边不复原的缺口）；段边 `selectable:false` + onBeforeDelete 过滤 tnl-（收起态删不掉，展开即可正常增删）；GroupBox 展开态删除全部 Handle、counts 仅收起显示；`.gbox` 改 flex column、`.ghead` 全宽标题条（gc 28% + panel 底、1px 分色边、顶部圆角，两态通用）；克隆 `cloneSelected()`——id 与创建路径同源（genId(type 段)）、data JSON 深拷贝、位置 +(40,40)、原节点在组内则克隆同入该组（避免落到板下层被色罩盖住）、克隆置选中。
- **注**：上一轮被舍弃的「段边动画/删除复活/新增延迟」三 bug 随本次行为收敛自然消失（展开态无段边、收起态不可增删）。
- **回归**：组合后展开态 4 条直连边保持、无 tnl、无隧道口；收起出现 2 段转发边+标签+counts、点段边不选中（不可删）；再展开直连边自动复原；克隆偏移 (40,40)@zoom1.25、data 深拷贝（value+note）、无新边、随组入库；刷新列表位于定义任务旁；无控制台报错。
- **状态**：已实施（本次提交）。

## BUG-2026-09-29-07 点保存后「保存 *」星号不熄灭

- **现象**：点击保存按钮成功后，按钮上仍显示「保存 *」。
- **根因**：`dirty = autoDirty || layoutDirty`，`save()` 成功后只重置 `autoDirty`，从不重置 `layoutDirty`（画布平移/节点拖动后置 true，唯一清零点是切换工作流）——只要动过画布，点多少次保存星号都常亮。原注释「布局脏不由自动保存清除」本意只针对自动保存（silent），但代码未按 silent 分支，把手动保存路径也一并漏掉。
- **修复**：`save()` 成功分支补 `if (!silent) layoutDirty = false`——手动保存清除布局脏；自动保存（silent）行为不变（布局变动仍以手动保存为准，维持既有设计）。
- **回归**：平移画布 → 星亮 → 点保存 → 星灭且按钮禁用；编辑字段 → 自动保存后星灭；拖节点 → 星亮 → 手动保存 → 星灭。
- **顺带观察（未改）**：`onMoveEnd` 对纯视口平移/缩放也置 layoutDirty，而 toDoc 不持久化视口——保存前星号亮属轻微误报，用户可点保存熄灭；若在意可后续区分视口移动与节点拖动。
- **状态**：已修复（本次提交）。

## BUG-2026-09-30-01 里程碑1 评审 P0 六项修复（review-milestone-1.md）

- **P0-1 收起组跨组 seq 边 → effect 乒乓死循环**：动态出口清理 effect 不过滤 tnl- 段边，段边伪句柄 `__seqOut` 不在 effectiveOutputs → 判 dead 删除 → 隧道 effect 重建 → 无限乒乓（Svelte effect_update_depth_exceeded / toast 刷屏）。修复：dead 过滤加 `tnl-` 排除（App.svelte）。
- **P0-2 getRun 路径穿越**：`/api/jobs/:id` 未校验 id 即拼路径，`..%2F..%2Flocal-config` 可读出 token 明文。修复：id 白名单 `/^[0-9a-z]+-[0-9a-z]+$/`（与 listRuns 文件名同源格式）。
- **P0-3 队列可被持久化故障打死**：finally 里 persist/appendAudit 裸同步写，`.runs/` 不可写 → queueTail rejected 无人 catch → 队列永久死锁 + unhandledRejection 终止进程。修复：persist/appendAudit 内建 try/catch（保内存运行），队列闭包不再可能 reject。
- **P0-4 DevNode 复制粘贴的重复 refreshTick effect**：删一个——刷新列表不再双倍请求。
- **P0-5 shell 注入点 ×3**：git.checkout ref 白名单 `[A-Za-z0-9._/-]+`；remote.chown 的 user 过 sq()；finalize 的 rm 改用 shellQuote。
- **P0-6 掩码不识 JSON 形态**：`"JWT_SECRET":"xxx"` 完全漏过（log.print 打印 struct 即泄漏）。修复：正则补 JSON 形态（KEY 与值各自的引号）+ 大小写不敏感；掩码上移到 ctx.log 统一执行（覆盖 sshRun 回传的远端 stdout/stderr）；run.error 也掩码。幂等（已掩码行再过不变）。
- **回归**：verify 47→49 项全绿（新增掩码 JSON 形态 5 断言 + getRun 白名单 5 断言）；临时 wf 实测跨组 seq 边收起——段边一次生成、两帧采样稳定、无 toast/报错，展开后三条原边直连复原。

## BUG-2026-09-30-02 里程碑1 评审 P1 十二项修复（review-milestone-1.md）

- **P1-1 streamJob 轮询重放/挂死/不可取消**：兜底轮询 `seen` 改从已投递行数续传（断流补齐不再整段重放）；读流 15s 无数据判挂死落到轮询（心跳 10s 一跳）；新增 AbortSignal 取消通道。
- **P1-2 LogDrawer 流交织**：follow() 先 abort 旧流再开新流；lines 上限 5000 成对裁剪。
- **P1-3 sshconfig 首块语义反了**：`matched` 恒 false 使 HostName 变成后块覆盖——改为 `hostSet` 显式记录（OpenSSH 首个获得的值生效，前块 User/Port 继续由 ?? 保证）；listAliases 复用 parseConfig（不再二次读盘解析）；parseConfig/listAliases 支持注入路径（可测试）。
- **P1-4 双端镜像对齐**：web canConnect 补 SOCKET_TYPES 校验；effectiveInputs 块序对齐 engine（count→pair→tpl→field→dynamic）；effectiveOutputs structSplit 补 struct.make 源检查 + tnl- 过滤；validateTaskSelection inEdges 补 tnl- 过滤（收起组时报错文案不再把 grp-xxx 列为依赖）。
- **P1-5 前端初始化白屏**：init effect 与 wf 下拉 onchange 补 try/catch + toast。
- **P1-6 open|save 护栏**：仅收绝对路径（~ 可展开），拒绝相对路径（防随进程 cwd 漂移）；启动时空 token 打显著警告。
- **P1-7 runs 内存无界 + O(n²) IO**：日志/状态持久化节流至 400ms（persistSoon，终态 finally 全量落盘并清定时器）；终态 60s 后回收内存（详情走磁盘）。
- **P1-8 GET 副作用**：untested 迁移/播种与失效路径清理（新 pruneMissingWorkflows）移到启动时一次；GET /api/node-usage 与 loadWorkflows 变纯读（列表中失效条目显示 ✗，重启时清理）。
- **P1-9 noteText 回弹**：textarea 去 bind:value（derived+bind+oninput 三写导致行尾空格被 trim 回弹），保留 oninput 写 data.note。
- **P1-10 a11y**：GroupBox 四个交互 span（组名/色点/色板/收起）与 DevNode 清单 ✕ 换原生 button（unstyled 复位）；画布容器 mousedown 加 svelte-ignore 注释——构建警告清零。
- **P1-11 verify 补测**：sshconfig 首块语义/别名顺序/不支持指令（49→50 项）。
- **P1-12 runModal.inputs 死功能**：删除（无填充点，弹窗恒走「无运行时输入」分支）。
- **回归**：verify 50 项全绿；构建无警告；临时 wf 实测组合/收起/展开（gcollapse 为原生 button 且可点）、展开态直连边、自动保存落盘 groups/edges 干净、无控制台报错。

## BUG-2026-09-30-03 里程碑1 评审 P2 全量清理（结构/DRY/死代码/打磨，review-milestone-1.md）

- **镜像根治（提交 577ab8f）**：抽 engine/rules.js 零依赖纯规则模块（SOCKET_TYPES/canConnect/coerce/effectiveInputs/effectiveOutputs/isTunnelEdge/validateTaskSelection），引擎三处接入（types 转发、getInputs/getOutputs 委托、workflow 任务校验），web 经 file:.. 包依赖 import 同一文件——双端漂移根除，web/types.js 只留前端专用。
- **引擎清理（提交 7eb7c25）**：删死代码（withDeployVersion/sshExec/sshSudo/validateReleaseName/ENVS_DIR/引擎 TYPE_COLORS/resolveRepoDir+repos 键/trackRemoteFile 三件套/cancelled 死分支）；expandHome/normalizePath/模板路径三分支/tar 互斥四处双写归一；remote.js runRemote 样板五处复用；getRefs 排序 NaN 安全。
- **前端拆分与 DRY（本提交）**：App.svelte 846→~700 行——lib/infer.js（makeInfer 工厂+expandHomeLocal）、lib/groups.js（分组纯逻辑+GROUP_COLORS 单源）、lib/docIO.js（toDocument）抽出；OpenModal/RunModal 组件化（自持输入态，弹窗状态对象瘦身）；tnl- 内联判断 ×11 清零（isTunnelEdge 单源，含 lib 三处）；groupbox patch 模式 ×6 → patchGroupBox（groupSelected 复用 stripFromGroups）；端口 label/节点标题双写 → portLabel/nodeTitle（DevNode 与 tunnelLabel 同源）；DevNode 第三份 structSplit 镜像 → context.resolveOutputs（effectiveOutputs 单源）。
- **杂项**：动画 effect 只替换 animated 翻转的边（保引用）；onMoveEnd 不再点星（视口不入文档）；showToast 计时器句柄化；busyTimer $effect 清理；index.html webview 补丁加固（无 RO 不 patch/兜底轮询可停/per-instance 轮询表/rAF 落败定时器清理）；/api/template/vars 错误统一 4xx（DevNode 补 .catch）；cli follow 30 分钟超时+注释修正；token 恒时比较（timingSafeEqual）+移除 query 通道；内存态 doc 回填 name；SSE 终态显式清心跳；remote.check 正则限长 500；CSS --mono 变量归一六处；.tmp stage/tarpack/verify 残留启动清扫。
- **回归**：verify 50 项全绿；构建无警告；临时 wf 实测——打开（新 OpenModal）/组合/收起（标签经共享 portLabel/nodeTitle 正常）/展开复原/克隆（深拷贝+随组+不复制连线）/落盘干净/无控制台报错。
- **明确未做（记录）**：App.svelte 的 HeaderBar/TaskBar/TaskDefiner 组件抽取（与数十个绑定纠缠，收益/风险比低，等下次功能迭代顺手做）；DevNode 三个 picker 刷新函数 usePicker 化（三者返回结构差异大，抽象后反而不直观）；HTTP 层自动化测试（需启动真实服务器进程，另行安排）。

## BUG-2026-09-29-01 remote.deps 默认配置必挂（sudo -n cd：cd 是 shell 内建无可执行文件）

- **现象**：「安装生产依赖」节点（remote.deps）从未跑通过——默认 `sudo -n` 开启时命令为 `bash -lc 'sudo -n cd <path> && pnpm install …'`，`cd` 是 shell 内建命令、无可执行文件，`sudo -n cd` 直接 `command not found` 退出，pnpm 永远执行不到。节点一直在「未测试」清单里佐证了这点。
- **根因**：`buildCommand` 前缀式 sudo 只覆盖第一段（见 BUG-2026-09-28-02），而这里的复合命令第一段恰好是 `cd`——sudo 对它无意义且必挂；即便 cd 能过，pnpm 以 root 跑也会污染 .pnpm-store 属主，sudo 对本节点本来就是反模式。
- **修复（按用户决策重做节点）**：remote.deps 原地替换为 `pnpm.install`（title 仍「安装生产依赖」）——删 manager 枚举（只做 pnpm）与 sudo 控件，恒以登录用户执行 `cd <path> && pnpm install --prod --frozen-lockfile`（frozen 语义：严格按 lockfile 装，与 package.json 不一致即失败）；控件只剩 loginShell（nvm PATH）。
- **回归**：verify 新增断言（注册表形状；dry-run = `cd '<path>' && pnpm install --prod --frozen-lockfile` 且不含 sudo；remote.deps 不存在）。52/52 通过。真实链路由用户重跑验证。
- **状态**：已实施。

## QoL-2026-09-30-01 视觉与 QoL 升级八项（用户需求，非 bug）

1. Group 展开态去左右加宽：GROUP_PAD_X(150) 移除，统一 GROUP_PAD(14)——展开态已无隧道接口。
2. 边与插槽同色：新「边装饰 effect」按源出口类型写 edge.style（stroke + --ec 自定义属性），tnl- 段边随原边同色；与 animated 判定合并为一个 effect，只替换翻转的边（保引用）。注意：xyflow svelte 的 edge.style 须为**字符串**（对象不落到 DOM）。
3. 边加粗：`.svelte-flow__edge-path { stroke-width: 2 }`（默认 1）。
4. 选中节点抬升其连线：SvelteFlow `zIndexMode="manual"` + 装饰 effect 写 edge.zIndex=1000（相连/自身选中时）。原生 elevateEdgesOnSelect 无效——getElevatedEdgeZIndex 的抬升量取 sourceNode.internals.z，普通节点 z=0 抬不动，故走 manual 自管。
5. string 插槽色 → #61afef（One Dark 蓝，与 number/boolean/ssh 同家族）。
6. 顺序边银色虚线：`.seq` stroke #b3bcc8 / 1.6px / dasharray 4 3 / opacity .6（原 --warn 橙）。
7. 选中边光晕：`.selected` stroke-width 2.6 + drop-shadow(0 0 5px var(--ec))（光晕=边自身颜色；seq 定义 --ec 银色）。
8. 吸附与背景点阵对齐：实锤 Background 默认 gap=20 vs 吸附 [16,16]——`<Background gap={16} />`；点阵锚定流坐标原点，小白点与吸附点重合；另确认本版 snapGrid 单独传入即生效（snapToGrid: !!snapGrid）。顺带：视口平移不再点亮保存星号。
- **回归**：verify 53 项全绿；临时 wf 实测——string 边 #61afef/2px、seq 银虚线、选中节点相连边（含 seq）animated+zIndex 1000 压过普通节点（z 0）、选中边光晕 drop-shadow(--ec)、吸附拖节点 position=-304/64 均为 16 倍数、组合展开态板宽 640=成员跨距 612+28。测试环境注意：live 服务器已配 token（kl online），浏览器回归改用 3199 一次性 token 实例（DEVOPS_PORT/DEVOPS_TOKEN 环境变量起第二实例），未触碰用户配置。

## QoL-2026-09-30-02 防漂移门禁 + 四项界面升级（用户需求，承接 drift 讨论的方向一）

1. **运行前实时列表新鲜度门禁**：带实时列表的节点（refsPicker/scriptsPicker/sshAliasesPicker）刷新成功时在 `ui.pickerFresh[nodeId]` 记录「派生输入键」（repoDir/path/alias 当时的值）；doRun 前逐节点比对——键不存在或不等于当前输入值 → 禁止启动并列出节点，指引「卡片刷新/顶栏刷新列表」。输入键变化（改了 repoDir/path）即自动失鲜；loadDoc 清空。输入来自运行时节点（键无法静态确定）时跳过校验。这把 drift 讨论中"部署时刻才发现"的痛点提前到点运行之前。
2. 左侧调色板 150 → 180px；node 悬停 title 改为完整说明（meta.desc）。
3. Control Panel 横排（orientation=horizontal）+ 主题化（panel2 底/圆角/accent hover/4px 间距）；调色板底部让出空间（bottom 128→56）。
4. ndesc 三件：卡片头部删除按钮左侧 💡 灯泡单独开合；taskbar 吸附旁「说明」按钮全局开合（descAllTick 广播）；ndesc 默认收起（原常显）。左栏悬停已含完整说明。
- **回归**：verify 53 绿 + 构建；3199 一次性实例实测——未刷新点运行被拦（toast 列出 g1/se 并指引刷新）、Palette 180、Controls flexDirection=row + 主题按钮、灯泡开合 ndesc、全局开=3/3 收起=0/3、悬停 title=desc；测试经 3199 一次性 token 实例，未触碰用户 live 配置。

## QoL-2026-09-30-03 三项：删除二次确认 / 边重连 / 调色板类别重组 + 尺寸标准化

1. **删除 node 二次确认**：卡片 ✕ 与 DEL/Backspace 两路径都先 confirm（后者列出全部节点 id），任务引用确认保留在后。
2. **边重连**：新建 TypeEdge.svelte 自定义边（xyflow 重连锚点必须在自定义 edge 组件内渲染）——选中边两端出现拖拽圆点（手指光标），拖哪个锚改哪端；`onbeforereconnect` 校验（顺序边拒绝重连/新四元组过连线裁决，connectionRejectReason 增加 selfId 排除自身），`onreconnect` 标脏；拖空白/非法 handle 时库不触发 onConnect——边原样还原。装饰 effect 自动跟随新端点校正类型色/zIndex。**实测坑：合成 PointerEvent 无法驱动锚点拖拽（库 setPointerCapture 需真实指针）——浏览器回归必须用 CUA 真实拖拽**。
3. **调色板类别重组**：新「连接」类（ssh.session/ssh.close，橙 #ff9e64）；远端 9 节点 → 紫 #c678dd（One Dark 紫，原定 magenta #e0559d 因过于刺眼改紫，仍保留危险语义）；版本类 → 黄 #e5c07b。README 节点表同步。
4. **尺寸标准化（点间距 16 为基准）**：node 卡定宽 320（=20×16，`.devnode width`）；收起条定宽 320（collapsedWidth 成员最大宽逻辑删除）；GROUP_BAR header 36→32（title 2×）、pad 8→16（1×）；GROUP_PAD 14→16、GROUP_PAD_TOP 42→48（title 32+顶 16=卡上方 3×）；ghead 30/36→32。
- **回归**：verify 53 绿 + 构建零警告；3199 实例实测——confirm 拒绝保留/确认删除；选中边双端锚点（pointer 手指）出现、CUA 拖拽重连 ta→tc 改 ta→tb 成功、拖空白边还原（aria 不变）、选中边 z=1000；卡片 320、板宽 352=320+32（左右 16）、topPad 48、ghead 32、收起条 320×48（0 接口情形 32+16）、调色板三色分组正确。

## QoL-2026-09-30-04 视觉二轮：重连锚点压边 / 双开关 switch 统一

1. **重连锚点压在 node 边框线上**：实测 xyflow 边端点比 handle 视觉圆心偏外 4.5（=handle 半宽 9/2，恒定、与 zoom 无关——双 zoom 读数 4.5 flow px 确认）。TypeEdge 增加 onNodeEdge 修正：锚点 position 沿 handle 朝向回推 4.5（left→x+4.5 / right→x-4.5），修正后双 zoom 读数 dx=dy=0，锚点圆与常规端点圆同心。
2. **吸附/说明开关统一 switch**：两个控件（原 checkbox 裸框 + active 按钮）统一为轨道滑块 switch（关=灰滑块居左，开=accent 滑块居右，聚焦描边）；「说明」从按钮改为 checkbox+track 同款，逻辑不变（descAllTick 广播）。
- **回归**：双 zoom 锚点 dx/dy=0；switch 双开状态正确、说明全局开合联动 ndesc 4/4；构建零警告。测试环境：3199 一次性 token 实例。

## QoL-2026-09-30-05 Group 组名按钮去 flex:1（恢复标题条拖拽面）

- **现象**：组名控件 `flex:1`（上一轮"控件右对齐"引入）使组名按钮撑满整条标题条——按钮的 click 是打开重命名编辑，用户点/拖标题条任意位置都进编辑态，板没有可拖拽面（无法拖拽 group）。
- **修复**：组名去 `flex:1`，宽=文字宽度、靠左；控件簇（色板/折叠）用 `margin-left:auto` 保持靠右；中间留白 = 拖拽面（mousedown 冒泡到 wrapper 触发 xyflow 拖拽，不触发重命名）。编辑名仍点组名进入。
- **回归**：临时 wf 实测——组名按钮宽 42（=文字），标题条留白区拖拽板 position 随动且 16 网格吸附，留白点击不进重命名。

## FEAT-2026-09-30-01 三项新功能：ssh.session 输入化 / selector 选择器 / struct 严格类型（非 bug，功能记录）

1. **ssh.session 输入化**：新增可选输入 alias/fingerprint（string）；指纹 widget 移除（端口行手填承接）；run 取值连线优先。GUI：未连线 = 原流程（刷新/下拉选别名）；连线 = 下拉 disabled 显示所选；刷新后别名不在 config → sshErr 报错（卡片红框）。运行门禁的别名新鲜键改用有效别名值（连线值优先）。
2. **selector 节点（select.one，工具类）**：接入任意数量同类型输入，下拉选一路作为输出。rules.js effectiveInputs 新 selectorInputs 分支（开放口 in 类型=lockType ?? any + 每条入边专用口 in-<源id>）；effectiveOutputs 新 "selectorOut"（lockType ? value 出口 : 无）。首连线经 onConnect 改写专用口并锁 lockType=源出口类型；全部入边删除 → 解锁 effect 清 lockType → 下游边由死边清理断开。engine getInputs(node, graph?) 透传图（declaredType 同步改签名），workflow.js 三处调用传 doc。
3. **struct 严格类型**：rules.js 新 structShape（键排序 canonical）/isStructType；canConnect struct 家族规则（纯 struct 收任意 struct；带形状要求形状串全等——键集+逐键类型同、顺序无关；无形状源拒绝带形状输入）；struct.make 输出类型带形状（dynamicOutputs "structMake"）。displayType 收敛显示（带形状显示为 struct）。
- **回归**：verify 53→56 全绿（struct 形状矩阵 / select.one 端口推导 / ssh.session 输入）；构建零警告；3199 实例实测 ssh.session（双端口渲染、指纹 widget 移除、连线后下拉 disabled=显示所选、刷新别名未命中报错「别名 "AAA" 不在 ~/.ssh/config 中」）。
- **待人工验证**：selector 的画布连线锁定流程——CUA 自动化可拖重连锚点但无法建立新建连线（事件路径不同），连线后锁定/改写逻辑（onConnect 6 行）与既有 seq class 改写同模式，已由 verify 的端口推导断言覆盖数据层。

## BUG-2026-09-30-08 网页打开巨卡（每 ~4.7s 全量重渲染 + 2.3s 主线程巨块 + 源码文本泄漏）

- **现象**：打开（尤其 kids-ledger-prod 大图）后整页巨卡，主线程被 ~2.3s 巨块反复占满，DOM 每秒数千次变更；画布根容器下渲染出 ~2500 字符的 App 源码文本（onnodedragstart=function…）。
- **根因①（渲染反馈环）**：DevNode 的 updateNodeInternals effect 无条件下发 rAF 重测，而其依赖 inputs/outputs derived（三功能轮起带 env 依赖全图）每次图变化都返回新数组——「derived 重算 → effect 重跑 → rAF 重测 → xyflow 内部更新 → bind 写回 → derived 再重算」无限反馈环；46 卡大图每轮全量重渲染 ~2.3s。修复：句柄集签名提升为 $derived（handleSig），effect 只依赖签名字符串（值稳定不触发），打断反馈环。
- **根因②（模板损坏，源码文本泄漏）**：本轮二分时把 HTML 注释 `<!-- edgeTypes 二分：临时移除 -->` 误插进 `<SvelteFlow>` 组件标签的属性区——Svelte 将注释与其后属性行当文本子节点渲染（~2510 字符源码泄漏到画布）。修复：删除该注释。
- **教训**：①组件标签属性区禁止插入 HTML 注释（Svelte 会当子内容渲染）；②「渲染循环」类问题用采样器（主线程 gap + mutation 计数）+ 占位组件二分法定位，比代码审读快。
- **回归**：干净加载 kids-ledger-prod（48 节点/80 边/2 组）：采样 40+/5s、maxGap 127ms、mut=0、无源码泄漏、无报错；选中节点动画正常。

## BUG-2026-09-30-09 二分脚手架残留进提交：定宽/分组板/边重连三功能静默回退

- **现象**：BUG-2026-09-30-08 修复提交（a7ab9cb）后，卡片不再定宽（回到 min 230 / max 320 自适应）。
- **根因**：巨卡排查全程处于「二分态」（占位组件 + 逐个禁用），修复时只恢复了真正根因相关代码，其余二分开关原样提交，静默回退了 360b243/0ec5099 的三个功能面：①`.devnode width:320` 被注释；②`groupbox:` 组件被换成调试 Placeholder（组名/换色/收起/拖板全失效）；③`<SvelteFlow>` 的 `edgeTypes={edgeTypes}` 被移除（TypeEdge 卸下 → 重连锚点失去载体，onbeforereconnect 空挂）。另有 DevNode 三处 `window.__bisect6/7/8` 渲染开关残留（未激活、功能无害）。
- **修复**：恢复①②③；删 Placeholder.svelte 与三处 bisect 开关；补回被误删的注释（seq 边不打类型色）。保留 a7ab9cb 真修复不动（handleSig 反馈环修复 / busyText 轮询去重 / style!==want）。
- **教训**：二分排查结束后、提交前，必须 `git diff` 全量过一遍并 grep `二分\|bisect\|临时` 清零——「占位/禁用」类开关的残留不报错、不崩，只会静默回退功能，等用户发现时已隔着多个提交。
- **回归**：verify 56 绿；构建零警告；3010 + 临时 wf 实测——卡片 computed width=320（视觉 1.39× 为窗格缩放，全元素同比）、GroupBox 正常渲染（板=AABB+pad、ghead 32 基准、组名在）、点选边双端重连锚点出现（updaters=2）、inputs/widgets/seq 行渲染正常、画布无「二分禁用」文案；测试 wf 已删、注册已 forget。

## BUG-2026-09-30-10 里程碑2 评审 P1 五项修复（review-milestone-2.md）

1. **selector 锁型状态机补全（P1-1/2）**：onConnect/onReconnect 接入 `normalizeSelectorWires()`——选择器入边恒归一为专用口 `in-<源id>`（落点无论是开放口还是既有专用口；同源多边去重，单口设计第二条丢弃），目标未锁型时以首边源出口类型写入 `data.lockType`。此前 lockType 只有解锁清除、从未上锁，节点永远没有输出口。下拉选项同口去重（keyed each key 唯一性）。
2. **effectiveInputs 补图上下文四处（P1-3）**：onData 动态口清理 / connectionRejectReason / hover 端口标题（前端三处）+ validateWorkflow `getInputs(tgt, doc)`（引擎侧）——selector 专用口按已接入边推导，缺 env 会「编辑即丢线 / 保存被拒」。rules.js selectorInputs wired 分支同时收紧为只认 `in-` 前缀（幻影端口在校验处显式暴露，评审 P3 顺手收）。
3. **防漂移门禁逃生分支修复（P1-4）**：refs/scripts 分支去掉 `?? ""` 归一——undefined（输入来自运行时节点）直接 continue 跳过新鲜度校验；此前归一成空串后 `want === undefined` 永不可达，刷新必失败的节点被永久卡死无法运行。ssh 别名分支保留 widget 回退（可刷新，语义不同）。
4. **边装饰 displayType（P1-5）**：类型色查表改 `TYPE_COLORS[displayType(out?.type)]`——struct.make 带形状出口（`struct:{...}`）不再回落灰。
- **回归**：verify 56→57 绿（新增 validateWorkflow 带图：专用口合法 + 非 in- 口名拒绝）；构建零警告；GUI 实测（临时 wf，已删）：拖拽连线落点改写 in-consta、lockType=string、输出口出现、异型源被拒（toast 类型不兼容）、自动保存过校验且磁盘往返、输出连线+选路 pick、删输入边→解锁+下游死边断开。
- **教训**：①提交信息声称的代码可能不存在——评审时以 grep 代码为准而非 commit message（P1-1 的「onConnect 6 行」从未落地）；②引擎改动必须重启 3010 再 GUI 实测（本次自动保存被旧引擎拒绝暴露了这一点，也顺带验证了保存原子性——失败不落盘）。

## FEAT-2026-09-30-02 校验拆分 + selector 重构 + struct/视觉调整（功能大改，非 bug）

1. **保存/运行校验拆分**：validateWorkflow 瘦身为骨架校验（结构/引用完整性 + seq handle），任意语义非法可保存；新增 validateTaskRunnable（运行前严格校验：类型未知/struct 字段/tar 互斥/边端点与 handle/类型兼容/选点三校验），runner.enqueueWorkflowTask 顶部统一拦截（CLI/GUI 共用）。index.js save 端点自动变为骨架校验。
2. **未知类型节点**：loadDoc 改写 type=unknown（原类型存 __origType，保存还原）；UnknownNode 红框空卡（标题=id，只读 JSON）；边错误红线（装饰 effect 按源/目标类型解析与 canConnect 判定）。
3. **selector 重构（select.one）**：countInputs 驱动 in1..inN 固定口（stepper widget）；radio 单选输出口；in1 首连线锁定 lockType（onConnect/onReconnect 维护）；in1 断线或类型不符 → 全部连线错误红线；错误态由 rules.js selectorWireProblem 统一判定（engine 校验与前端装饰共用）。
4. **struct 调整**：空字段无出口（rules structMake 分支）；boolean 字段值三态轨道开关（undefined 空轨/false 滑左/true 滑右，点击循环）；形状类型显示 struct_N 运行时编号（displayType Map 映射，容忍不稳定）。
5. **值类型色板**：number → #2dd4bf（蓝绿）、boolean → #818cf8（蓝紫）、string/struct 保持蓝系。
- **回归**：verify 56→57 全绿（校验断言迁移 + selector/struct 新断言）；构建零警告；3199 实例实测（ssh.session 双口/selector radio 与 in1 语义/struct 三态与空字段/unknown 渲染——partial 见 FEAT 条目）。
- **已知限制**：CUA 自动化无法建立画布新建连线（重连可以），selector 连线锁定流程的浏览器端到端验证需人工复核。

## QoL-2026-09-30-06 selector radio 尺寸修正（用户反馈）

- **现象**：selector 输入口的 radio 被全局 `input { width: 100% }` 拉满整行宽。
- **修复**：app.css 增 `.selradio { width/height 16px; margin-left: auto; accent-color: var(--accent) }` 覆盖；radio 点击选择输出已验证（checked 写入 data.pick）。

## FEAT-2026-09-30-03 struct.split 出口支持 selector 形状链（用户报「未能正常解析出口」的排查）

- **排查**：struct.make → struct.split 链实测出口解析正常（name/age）；用户场景疑似上游为 selector（锁 struct 形状）或 struct.make 字段被清空。
- **增强**：rules effectiveOutputs structSplit 分支新增——上游 selector 且 lockType 为形状串（struct:{...}）时，解析 canonical 串还原字段作为出口（字母序）。此前该分支只认 struct.make 上游。
- **回归**：verify 57 全绿；3199 实例实测 struct.make → struct.split 出口 name/age 正常解析。
- **待确认**：如用户场景仍异常，请提供 Split Struct 的上游连线方式（struct.make / selector / 其他）。

## QoL-2026-10-01-01 记住上次打开的 wf + start.cmd 启动前逐路径 git pull

1. **lastOpened**：此前「上次打开」只隐含在 workflows[] 列表顺序里（GUI 启动打开第一个加载成功的）——上次打开的 wf 一旦加载失败（JSON 坏/失效）就静默漂移到别的条目。改为显式记录：rememberWorkflow 恒写 `cfg.lastOpened`（`~` 格式；原实现只在新增路径时写盘，已改为每次都写）；GET /api/workflows 给对应条目加 `last: true`（现读 config，启动快照 cfg 会过期）；GUI 初始化 `find(w => w.last && w.name) ?? find(w => w.name)`，失效回退原行为。
2. **paths + preflight**：local-config.json 新增 `paths: []`；新建 tools/preflight.js（start.cmd 在 `node index.js` 前调 `node tools\preflight.js`）逐路径 `git pull --ff-only`（execSync timeout 30s）；任何失败（目录不存在/非仓库根/网络/冲突）打 ⚠ 警告继续，exit 恒 0——控制台可用性优先于 git 状态。
   - **实测修正**：最初用 `git rev-parse --is-inside-work-tree` 判仓库——它检测「在某工作树内」而非「目录本身是仓库根」，误配的普通子目录会对外层仓库执行 pull（危险）；改用 `--show-toplevel` 归一后必须等于目录自身。目录存在性先查（execSync 对不存在 cwd 报 spawnSync ENOENT，掩盖真实原因）。
- **回归**：verify 57 绿；构建零警告；preflight 实测（.tmp 本地仓库 init+clone，源提交 v2 后 pull Fast-forward 生效、非仓库根/不存在目录警告跳过、空 paths 直接过）；GUI 实测（临时 wf 已删）：打开→lastOpened 落盘、API last 标记正确、刷新页面自动恢复该 wf。
