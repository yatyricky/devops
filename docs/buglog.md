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
