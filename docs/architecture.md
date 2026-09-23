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
        图校验（类型/悬空边/多边同输入/环依赖/前向依赖）→
        任务路径执行（主路径按序；输入经边解析，依赖闭包自动先执行侧挂节点）
        │
节点注册表（engine/nodes/：input / build / remote / util，22 种）
        每个节点 = 元数据（输入/输出插槽与类型、widget 表单定义、动态插槽规则）+ run(ctx, node, inputs)
        │
引擎原语（engine/ssh|env|render|tarball|gitops|exec）
```

关键决策：

1. **CLI-first**：GUI 与 CLI 是同一 runner 的两个前端。部署逻辑 100% 在 workflow.json + 节点执行器里，可审计、可脱离 GUI 运行。
2. **任务串行**：全局一个队列，杜绝并发部署写同一目标机。
3. **prod 门禁在 runner 兜底**：任务 `mutates` + 任一路径上 env 的 `SERVER_TYPE=prod` → 必须携带 `confirmProd === 工作流名`；GUI 弹窗与 CLI 交互只是采集确认的两种方式；dry-run 免门禁。
4. **机密不出本地**：env 值只在内存；日志掩码 `SECRET/TOKEN/PASSWORD/PASSPHRASE=***`；审计只记 `confirmProd: "(typed)"`。
5. **类型即契约**：连线两端类型必须匹配（any 输入兜底）；校验发生在 GUI 连线时、保存写盘前、CLI 加载时三处，规则同源（engine/types.js 是唯一事实源，前端 types.js 是其镜像）。

## 执行语义（重要）

- **主路径按序执行**：数组顺序即副作用顺序；相邻节点不强制有边（如 deps → symlink 纯顺序）。
- **输入经边解析**：来源是"已执行"节点——主路径中更早的节点，或其**依赖闭包自动先执行**的侧挂节点（field.get/string.format/template.render 等 helper 从侧挂取值汇入主链）。
- **前向依赖拒绝**：节点的输入依赖主路径中更晚的节点 → 运行时报错（dry-run 同样拦截）。
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
- 任务路径高亮存独立 store（`ui.pathHighlight`），不写入节点对象——避免与 SvelteFlow 的测量回写形成写读循环。
- **ResizeObserver 兜底**：部分内嵌 webview 不投递 RO 回调（实测纯 RO 对照也 0 次），index.html 里有 polyfill：800ms 内零回调则切换 250ms 轮询对比尺寸并手动触发回调（含首次观察即回调的 RO 语义）；正常浏览器零开销。
- `/api/node-types` 是节点元数据唯一来源：画布节点组件、插槽颜色、检查器表单全部据此动态渲染；`ssh.exec` 等的动态插槽由 widget 文本里的 `{{name}}` / `{{obj.key}}` 占位符生成。

## 新增一个节点类型

1. `engine/nodes/<分类>.js` 追加定义：`type/title/category/color/inputs/outputs/widgets/dynamicInputs?/run(ctx, node, inputs)`；
2. `run` 里区分 `ctx.dryRun`（打印计划，无副作用）；需要收尾的副作用用 `ctx.registerGitRestore / trackRemoteFile / registerSession` 登记；
3. 重启服务器（注册表启动时加载）；GUI 调色板与检查器自动出现新节点。

## 新增一个应用工作流

1. GUI「新建」→ 弹窗确认存放路径（任意位置，自动记住）→ 空白图起步；
2. 拖入 `env.file` + `ssh.session` + 需要的构建/远端节点，连线；
3. 「定义任务」按序点击节点 → 命名 → 保存；重复定义 deploy/rollback/status；
4. CLI 对照：`node cli.js run <名或路径> deploy --dry-run`。
