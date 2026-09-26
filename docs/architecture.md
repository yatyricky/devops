# 架构与设计原则

## 定位

对同类框架的 SPA/server 应用做**统一的人工触发部署**：不在目标机装 agent、不用容器、不依赖云。
部署流程以**节点图工作流**表达：图 = 能力，路径 = 任务，编辑器即运维界面。

## 分层

```
GUI（web/：Svelte 5 + Svelte Flow 画布，Vite 构建为 web/dist）
        │  fetch + SSE-over-POST 流式日志（断流自动降级轮询）
CLI（cli.js：run/list/tasks，与 GUI 完全同一引擎）
        │
runner（engine/runner.js）
        串行队列 · .runs/<id>.json 持久化 · audit.jsonl · prod 门禁 ·
        副作用收尾（git 恢复 / 远端临时文件清理 / 会话关闭）
        │
workflow 执行器（engine/workflow.js）
        图校验（类型/悬空边/required 闭包/插槽唯一/环依赖）→
        任务子图执行（选点构成 1 个或多个 DAG；层内并发，层间按拓扑序）
        │
节点注册表（engine/nodes/：input / build / remote / util，含 struct 构造/析构）
        每个节点 = 元数据（输入/输出插槽与类型、widget 表单定义、动态插槽/出口规则、desc 描述）+ run(ctx, node, inputs)
        │
引擎原语（engine/ssh|env|render|tarball|gitops|exec）
```

关键决策：

1. **CLI-first**：GUI 与 CLI 是同一 runner 的两个前端。部署逻辑 100% 在 workflow.json + 节点执行器里，可审计、可脱离 GUI 运行。
2. **任务串行**：全局一个队列，杜绝并发部署写同一目标机。
3. **prod 门禁在 runner 兜底**：任务 `mutates` + 任务子图内 Struct 构造器的 `SERVER_TYPE=prod` 字段 → 必须携带 `confirmProd === 工作流名`；GUI 弹窗与 CLI 交互只是采集确认的两种方式；dry-run 免门禁。
4. **工作流文件即机密文件（2026-09-24 定，取代原 envs/ 文件方案）**：env 字段以 Struct 构造器的字段直接定义在图 JSON 中——可视化的收益是哪个字段被哪个流程消费，连线即知。因此 **wf 文件必须存放在安全处（勿提交公共仓库）**；日志掩码 `SECRET/TOKEN/PASSWORD/PASSPHRASE=***` 与审计只记 `confirmProd: "(typed)"` 不变。
5. **类型即契约**：连线两端类型必须匹配（any 输入兜底）；校验发生在 GUI 连线时、保存写盘前、CLI 加载时三处，规则同源（engine/types.js 是唯一事实源，前端 types.js 是其镜像）。
6. **无控制流（if-else / for / try-catch 不进节点图，2026-09-24 定）**：条件、软失败、循环一律写在 `ssh.exec`
   等执行类节点的 bash 里——现网工作流即如此（健康检查 `for i in $(seq 1 10); do … done`、回滚守卫
   `test -d … || { echo; exit 1; }`、`systemctl stop … || true`）；对多台主机/多个环境 = 同一任务跑多次
   （runner 换 env 文件），不是图内循环。理由：
   ① bash 已是节点内完整的条件/循环容器，图级控制流是第二套更弱的语法（违"无冗余"）；
   ② 任务 = 定义时确定的静态子图（选点集合），运行时分支使路径动态化——"点选节点定义任务、依赖闭包校验、
   依赖闭包自动执行侧挂节点"这套静态语义全部失效；
   ③ else 的第二路径打破主路径线性（与否决 rescue 自动回滚是同一逻辑）；
   ④ for-each 使节点输出从标量变数组，破坏"类型即契约"的边类型校验（环依赖目前本就是图校验错误）。
   失败语义已分层吸收：**清理（try-finally 的归宿）= runner 任务收尾**（git 恢复 / 远端临时文件删除 /
   会话关闭，等价 bash trap，平台内置、用户不可编程）；**catch（rescue 自动回滚）已否决**——失败即停 +
   手动 rollback 任务。若未来确有"按条件跳过某节点"的真实需求，唯一合规形态是节点级 `when`
   （只有执行/跳过两种状态，无 else、无第二路径，需同时定义被跳过节点输出的插槽语义），届时再评估，今天不预建。

## 执行语义（重要）

- **任务 = 子图选点**：从大图点选若干节点（顺序无关），选点 + 两端都在选择内的边构成 1 个或多个 DAG。
  元图允许同一输入接多条备选连线——不同任务各取其一；唯一性在任务级校验。
- **任务级三校验**（保存写盘前、CLI 加载时同源执行）：
  1. **required 闭包**：选中节点的 required 输入（含动态插槽），其入边源必须已选入；
     非 required 入边的源可不选（该输入在此任务中视作未连线）；
  2. **插槽唯一**：任务内每个输入槽最多 1 条入边；required 输入必须恰好 1 条（0 条 = 未连线，与闭包错误区分）；
  3. **无环**：Kahn 拓扑，data + seq 携带边都参与定序。
- **层内并发**：入度 0 的节点并发一批，完成后释放下一层；任一节点失败，本批全部落地后抛错终止
  （在途副作用由收尾清理）。纯顺序约束（无数据含义）用 seq 边表达。
- **输入经边解析**：来源是已执行节点；被丢弃的可选入边不提供输入值。
- **任务结束收尾**（等价原 bash 脚本的 trap）：git 工作树恢复（逆序）→ 远端上传的临时文件删除 → SSH 会话关闭。

## 远端原子性（remote.extract）

原幂等 bash 脚本的 release 语义拆为节点后收敛在 `remote.extract` 内保持单体原子性：

```
rm -rf <releases>/.<name>.tmp
mkdir -p <releases>/.<name>.tmp
tar -xzf <archive> -C .<name>.tmp
test -f <expect...>          ← 逐个校验，失败即清 .tmp 并抛错
rm -rf <releases>/<name>     ← 幂等（同名重发布）
mv .<name>.tmp <releases>/<name>   ← 原子发布
输出 releasePath 供后续节点（deps/chown/symlink）使用
```

失败清理（解压校验失败清 .tmp、上传的归档任务结束即删）由节点 + runner 收尾共同承担。

## 前端要点

- Svelte Flow 1.x：`onnodeclick` 回调参数是 `{ event, node }` 对象；`nodes/edges` 需 bind；**所有更新用替换式**（`nodes = [...nodes, x]`），原地 push 与直接改节点 data 会与库的内部回写打架。
- 任务子图高亮存独立 store（`ui.pathHighlight`，id → true），不写入节点对象——避免与 SvelteFlow 的测量回写形成写读循环。
- **ResizeObserver 兜底**：部分内嵌 webview 不投递 RO 回调（实测纯 RO 对照也 0 次），index.html 里有 polyfill：800ms 内零回调则切换 250ms 轮询对比尺寸并手动触发回调（含首次观察即回调的 RO 语义）；正常浏览器零开销。
- `/api/node-types` 是节点元数据唯一来源：画布节点组件、插槽颜色、检查器表单全部据此动态渲染；`ssh.exec` 等的动态插槽由 widget 文本里的 `{{name}}` / `{{obj.key}}` 占位符生成。

## 新增一个节点类型

1. `engine/nodes/<分类>.js` 追加定义：`type/title/category/color/inputs/outputs/widgets/dynamicInputs?/run(ctx, node, inputs)`；
2. `run` 里区分 `ctx.dryRun`（打印计划，无副作用）；需要收尾的副作用用 `ctx.registerGitRestore / trackRemoteFile / registerSession` 登记；
3. 重启服务器（注册表启动时加载）；GUI 调色板与检查器自动出现新节点。

## 新增一个应用工作流

1. GUI「新建」→ 弹窗确认存放路径（任意位置，自动记住）→ 空白图起步；
2. 拖入 `ssh.session`（选 ~/.ssh/config 别名）+ 需要的构建/远端节点，连线；
3. 「定义任务」在画布上点选节点（顺序无关；required 闭包 / 插槽唯一 / 无环即时校验）→ 命名 → 保存；重复定义 deploy/rollback/status；
4. CLI 对照：`node cli.js run <名或路径> deploy --dry-run`。
