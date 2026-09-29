# 里程碑 1 全盘评审（2026-09-29，HEAD = 0bb9977）

评审方法：三路并行静态审查（引擎/后端、前端、文档与仓库状态），结论带 file:line 证据；
未连接任何服务器、未运行任何工作流任务（遵守 AGENTS.md）。

## 总体评价

引擎核心是健康的：类型系统、任务子图校验（闭包/唯一/无环）、拓扑批并发、prod 门禁、
finalize 收尾、SSH 指纹锁定（timingSafeEqual）设计清晰，verify 套件 47 项对图模型覆盖扎实。

主要债务集中在四处：**HTTP 边界的默认开放**（空 token + 任意路径读写 + `:id` 穿越）、
**shell 拼接的注入点**、**队列的写盘脆弱性**（一次磁盘故障可永久打死队列甚至带崩进程）、
**前后端规则镜像的漂移**（已发生实际分叉）。另有一个前端 effect 死循环 bug（顺序边跨收起组会崩溃）。

里程碑 1 已交付能力（44 提交 / 9 天）：节点图引擎内核 → GUI 可用性（连线/保存/内存态执行）→
SSH 安全（别名直连/指纹/sudo 回退）→ 节点扩展（typed ports/path 工具/模板动态端口/stage.copy 重做）→
Group 分组（组合/收起黑箱条/隧道转发/克隆）→ 保存体验打磨。

---

## P0 —— 进入下一阶段前必须修（正确性/安全缺陷）

| # | 问题 | 位置 | 说明 |
|---|---|---|---|
| P0-1 | **动态出口清理 effect 不过滤 `tnl-` 段边 → effect 乒乓死循环** | `web/src/App.svelte:701-715` | 收起一个有顺序边跨边界的组：隧道 effect 建 `tnl-…-a`（sourceHandle=`__seqOut`）→ 清理 effect 判它 dead 删除 + toast → 隧道 effect 重建 → 无限乒乓（Svelte 5 `effect_update_depth_exceeded` 崩溃 / toast 刷屏 / 自动保存空转）。修法一行：dead 过滤加 `tnl-` 排除 |
| P0-2 | **`GET /api/jobs/:id` 路径穿越 → 任意 .json 读取（可读出 token）** | `engine/runner.js:226-228`、`index.js:211-215` | `req.params.id` 未校验即 `path.join`；`GET /api/jobs/..%2Flocal-config` 回显 local-config.json（含 token 明文）。`listRuns` 有正则过滤而 `getRun` 没有。修法：id 先过 `/^[0-9a-z]+-\d+$/` 再拼路径 |
| P0-3 | **队列可被一次磁盘写失败永久打死（并可能带崩进程）** | `engine/runner.js:163-181` | finally 里 `persist`/`appendAudit` 裸同步写且不在 try 内——`.runs/` 删除/盘满/权限变化 → `queueTail` rejected 且无人 catch → 后续任务永不执行 + unhandledRejection 终止进程。修法：两处各自 try/catch + 队列链尾兜底 `.catch` |
| P0-4 | **DevNode 两个逐字相同的 $effect → 刷新列表双倍请求** | `web/src/DevNode.svelte:143-150 与 152-159` | 复制粘贴产物；每次「刷新列表」每张 picker 卡片的刷新 API 各执行两遍。删一个即可 |
| P0-5 | **shell 拼接注入点 ×3** | `engine/nodes/build.js:76`、`engine/nodes/remote.js:262`、`engine/runner.js:196` | git.checkout 的 `ref` 未引用未白名单（`ref="v1; calc.exe"` = 本地任意命令）；remote.chown 的 `inputs.user` 未过 `sq()`（同行的 path 却引了）；finalize 的 rm 手工单引号未转义。inputs 可经 HTTP 注入，默认无 token 时是本机攻击面 |
| P0-6 | **掩码不识 JSON 形态机密** | `engine/runner.js:51`、`engine/nodes/util.js:151-153` | `SECRET_KEY_RE` 只匹配 `KEY=VALUE`；log.print 打印 struct 输出 `"JWT_SECRET":"xxx"` 形态完全漏过 → 泄进日志与 `.runs/*.json`。struct 字段是机密主载体（架构决策 4）。修法：正则扩展 `["']?KEY["']?\s*[:=]` 形态 + 远端 stdout 行套 mask |

## P1 —— 近期做（质量/健壮性）

| # | 问题 | 位置 |
|---|---|---|
| P1-1 | `streamJob` 轮询兜底重放全部日志（`seen` 从 0 起）；流挂死时兜底永不触发；无取消口 | `web/src/api.js:29-65` |
| P1-2 | LogDrawer：连续跑两个任务两条流交织写同一数组；`lines` 无上限且 raw+html 双存 | `web/src/LogDrawer.svelte:10-36` |
| P1-3 | sshconfig「首块生效」实现错误：`matched` 恒 false，HostName 语义反成后块覆盖；`listAliases` 双读双解析 | `engine/sshconfig.js:70-86, 95-109` |
| P1-4 | 双端镜像已分叉：web `canConnect` 缺 SOCKET_TYPES 校验（`folder→folder` 前端放行后端拒）；`effectiveInputs` 块序不同；structSplit 缺源类型检查；`validateTaskSelection` 不滤 tnl- | `web/src/types.js:9-12, 24-74, 84-88, 121-169` vs engine 对应处 |
| P1-5 | 初始化 effect / selectWorkflow onchange 无 try/catch——服务器不可用即未处理 rejection 白屏 | `web/src/App.svelte:181-189, ~800` |
| P1-6 | `/api/workflows/open\|save` 任意路径读写无护栏 + 相对路径按进程 cwd 解析；启动时空 token 无显著警告 | `index.js:61-88, 24-26` |
| P1-7 | `runs` Map 只增不减（内存无界）+ 每行日志全量同步重写 run JSON（O(n²) IO 阻塞事件循环） | `engine/runner.js:109, 128-132` |
| P1-8 | GET 带写副作用：`/api/node-usage` 迁移+种子写盘可并发竞争；`loadWorkflows` 顺带 forget 写配置 | `index.js:104-109`、`engine/registry.js:43-44` |
| P1-9 | DevNode `noteText` bind+$derived+oninput 三重写 → 行尾空格输入即被 trim 回弹 | `web/src/DevNode.svelte:250, 514` |
| P1-10 | a11y 构建警告一排：GroupBox 四个 onclick span / gbox/gpalette div、DevNode `<a.rm>`——统一换原生 button | `web/src/GroupBox.svelte:49, 63, 73, 78, 84`、`DevNode.svelte:410` |
| P1-11 | 补测试：HTTP 层（鉴权 + `:id` 回归）、config.js、sshconfig.js（锁定首块语义）、gitops 三导出、runner 队列/审计、掩码 JSON 形态 | 见下方测试缺口 |
| P1-12 | `runModal.inputs` 是死功能：无填充点，模板永远走「无运行时输入」分支——接通或删除 | `web/src/App.svelte:729, 921-927` |

## P2 —— 可选（打磨/结构）

- **前端 DRY 清理包**：`tnl-` 前缀判断 ×11 → `isTunnelEdge/isDataEdge` 谓词 + `realEdges` 派生；groupbox patch 模式 ×6 → `patchGroupBox`（`groupSelected` 直接复用 `stripFromGroups`）；端口 label 双写（DevNode/tunnelLabel）→ `portLabel/nodeTitle`；`GROUP_COLORS`/`expandHome`/basename 三写归一；三个 picker 刷新函数同构 → `usePicker`；DevNode 内联 TYPE_COLORS style ×4。
- **引擎 DRY 清理包**：remote.js「dry-run 打印 vs 真执行」样板 ×15 → 复用现成但无人调用的 `sshExec`；`expandHome`（exec.js/sshconfig.js）、`normalizePath`（config.js/registry.js）、模板路径解析（index.js/build.js）各双写合并；tar.pack 白黑名单互斥在 workflow.js 与 build.js 双写。
- **死代码删除**：`withDeployVersion`（gitops.js:55-97，被 resolveDeployVersion 取代）、`sshSudo`、`validateReleaseName`、`ENVS_DIR`（runner.js:12，env 方案遗留）、引擎侧 `TYPE_COLORS`；`resolveRepoDir`（config.js:78-83）+ local-config 的 `repos` 键——特性整体失联，接回或删；`ctx.trackRemoteFile`/`remoteFiles`/finalize 清理段无节点调用（远端临时文件清理实际不生效）+ `cancelled` 死分支——接上或删；ssh.js 重复 JSDoc 块。
- **App.svelte 拆分**（973 行 → ~430）：第一层抽纯函数模块 `lib/infer.js`（编辑期推断）/`lib/groups.js`（分组）/`lib/docIO.js`（loadDoc/toDoc）/`lib/connection.js`/`lib/tasks.js`；第二层抽模板组件 HeaderBar/TaskBar/TaskDefiner/OpenModal/RunModal；四个联动 effect（AABB/隧道/动画/死边清理）留守 App（依赖 bind 所有权）。全部机械搬移不改语义。
- **双端镜像根治**：web/package.json 已有 `file:..` 依赖但零引用——把 `canConnect`/`effectiveInputs`/`validateTaskSelection`/Kahn 抽成无 Node 依赖的共享纯函数模块，两侧 import 同一文件（vite 可直接引）。
- **性能/体验**：动画 effect 只替换 animated 变化的边（现为全量替换，App.svelte:695）；`persist` 节流；`onMoveEnd` 区分视口平移与节点拖动（pan 不该点星号）；showToast 计时器句柄化；busyTimer 清理。
- **index.html webview 补丁加固**：RO 类定义加存在性守卫（现 `extends undefined` 风险）、兜底 interval 加解除条件、`_targets` per-instance、rAF fire 时 clearTimeout（现为孤儿定时器堆积）。
- **小项合集**：`/api/template/vars` 错误统一 4xx（现 200+error，前端 `res.ok` 判不出）；cli follow 加超时；getRefs 排序数字安全 + `v` 锚定剥离；SSE 终态显式清 heartbeat；`remote.check` 用户正则防灾难回溯；token 换 timingSafeEqual、移除 query 通道；内存态 doc 回填 name；CSS `--mono`/`.mini` 归一；cli.js:11 注释星号错位；`.tmp` 残留清理策略。

## 测试缺口（现状 47 项，图模型覆盖扎实）

零覆盖：HTTP 层全部（index.js 292 行——鉴权中间件、`/api/jobs` 内存态、`:id` 穿越点、SSE）、
config.js 全部、sshconfig.js 全部（P1-3 正因无测试而存活）、gitops 三导出、ssh.js hostVerifier、
runner 队列语义（串行/审计/sanitizeOptions）、registry.js（仅烟雾断言）、cli.js、掩码 JSON 形态、
render.js 报错路径。优先补 HTTP 层最小测试与 sshconfig 首块语义。

## 文档与仓库卫生（本次评审后已处理）

- README.md 落后 21 提交（13 处过时：workflows/、envs/、file/folder 类型、env.js、原子解压、upload 清理、12 项断言、10 个节点缺失）→ 重写。
- operations.md 落后 30 提交（envs/tpl/apply-config/回放功能全失效）→ 重写。
- architecture.md 两处过时（env 模块、Group 缺失）+ 决策 5 镜像声明与实际漂移 → 更新。
- local-config.example.json 缺 `workflows[]` 键 → 补。
- Palette.svelte / store.svelte.js 注释仍写 local-config.untestedNodeTypes（已迁独立文件）→ 修。
- `.tmp/` 21 个 verify 残留 → 清理。
- 遗留待议：`.zcode/plans/*.md` 会话笔记入库是否合适（3 个文件，用户定夺）。
