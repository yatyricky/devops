# 重构：ComfyUI 式节点图工作流（严格类型插槽 + 细粒度远端节点）

## 总体形态

保留并复用现有引擎底座（`engine/ssh|env|render|tarball|gitops|exec`、runner 串行队列/审计/prod 门禁/dry-run、SSE 日志），替换上层概念模型：

- **一个 workflow = 一张节点图**，存为 `workflow.json`，**可在磁盘任意位置**；`local-config.json` 的 `workflows: [路径]` 记录最近打开清单；新建 wf 弹窗确认存放路径。
- **env 文件、params 都是节点类型**；其余配置是节点内 widget。
- **任务 = 图中一条路径**（如 deploy = env→git→build→pack→…→service.restart；rollback = env→task.input→symlink→restart；dry-run 预览 = …→log.print）。任务名/路径/是否 mutates 存在 workflow.json 的 `tasks` 里。
- **严格类型化插槽**：连线即数据通道，类型不匹配连不上。
- **远端拆细为 ssh 命令节点**，远端 bash 脚本模板退役；幂等/原子性/失败清理由引擎层承担（见下）。
- 前端：**Svelte 5 + Svelte Flow（@xyflow/svelte）+ Vite**，暗色 ComfyUI 质感画布；构建产物由 Express 托管，运行时仍是单进程 `node index.js`。

## 类型系统（插槽类型）

`env`（环境对象）、`ssh`（会话）、`file`（本地文件）、`string`、`number`、`boolean`、`any`（逃生舱：env/params 可入，仅 any 输入可接）。
规则：同型可连；`env→any`、`params(any)→any` 放行；`any→具体类型` 拒绝（取具体值走 `field.get` 节点）。

## 节点类型注册表（engine/nodes/，前后端共享元数据）

| 分类 | 节点 | 输入 → 输出 | 说明 |
|---|---|---|---|
| 输入 | `env.file` | → `env` | envFile 路径 + 内嵌 schema |
| 输入 | `params` | → `any` | 静态 KV 表 |
| 输入 | `task.input` | → `string` | 运行时入参（ref/release 等），GUI 弹窗/CLI `--input k=v` |
| 版本 | `git.ref` | `string ref?` → `string versionId/buildTime/releaseName` | fetch+干净校验+checkout+**路径结束自动恢复**（withDeployVersion 语义） |
| 构建 | `cmd.exec` | `string cwd?` → `string out` | 本地命令列表 |
| 构建 | `write.env` | `env` → `file` | 键位映射生成 .env（原 writeClientEnv/writeServerEnv） |
| 构建 | `stage.copy` | `string root` → `string dir` | 多源暂存 + exclude 规则 |
| 构建 | `tar.pack` | `string dir` → `file archive`、`string archiveName` | 条目打包 |
| 构建 | `template.render` | `any vars` → `file` | 模板路径 + 变量（nginx/systemd/frp 配置仍走模板） |
| 远端 | `ssh.session` | `env` → `ssh` | host/user/fingerprint/keyFile 取自 env，指纹锁定复用 |
| 远端 | `ssh.exec` | `ssh` + **动态 `string` 输入** → `string out` | 命令里 `{{name}}` 占位符自动生成同名类型化输入插槽；dry-run 打印不执行 |
| 远端 | `ssh.upload` | `ssh`+`file`+`string path` → `string remoteFile` | |
| 远端 | `remote.extract` | `ssh`+`string archive`+`string releaseName` → `string releasePath` | **原子**：解压到 `<name>.tmp`→校验 expect 文件→`mv` 成 `releases/<name>`（不可变目录），失败自动清 .tmp |
| 远端 | `remote.deps` | `ssh`+`string path` | npm ci --omit=dev / pnpm install --prod --frozen-lockfile |
| 远端 | `remote.chown` | `ssh`+`string path`+`string user` | |
| 远端 | `remote.symlink` | `ssh`+`string target`+`string link` | ln -sfn（current 切换与 data/config.json 持久链接都用它） |
| 远端 | `remote.service` | `ssh`+`string name` | restart/reload/daemon-reload/enable/status（含 reset-failed） |
| 远端 | `remote.check` | `ssh` → `string out` | 只读命令 + 可选正则断言（如 node ≥22.5 preflight） |
| 工具 | `field.get` | `any`+name → `string` | 从 env/params 取单值 |
| 工具 | `string.const` / `log.print` | → `string` / 接 `any` 打印 | log.print 即"预览"端节点 |

**失败清理（替代原脚本 trap）**：runner 记录路径执行中产生的远端副作用（上传的归档、`.tmp` 解压目录、`release_created 未 switch` 的目录），路径失败时按逆序自动清理（等价 cleanup_deploy）；成功则清理临时归档。

## workflow.json 格式

```json
{
  "name": "kids-ledger", "title": "家庭账本", "version": 1,
  "nodes": [ { "id": "env1", "type": "env.file", "position": [80, 200], "data": { "envFile": "kids-ledger.env", "schema": {...} } }, ... ],
  "edges": [ { "id": "e1", "source": "env1", "sourceHandle": "env", "target": "git1", "targetHandle": "ref" }, ... ],
  "tasks": {
    "deploy":   { "label": "部署", "mutates": true,  "path": ["env1","git1","build1","pack1","ssh1","up1","ext1","deps1","link1","svc1"] },
    "rollback": { "label": "回滚", "mutates": true,  "path": ["env1","ssh1","in1","link2","svc1"] },
    "status":   { "label": "状态", "mutates": false, "path": ["env1","ssh1","chk1"] },
    "preview":  { "label": "预览", "mutates": false, "path": ["env1","git1","build1","pack1","print1"] }
  }
}
```

路径校验：相邻节点间必须有类型匹配的边；输入必须来自路径中已执行的上游节点。执行 = 沿路径逐节点跑，输入经边注入，输出供下游；prod 门禁沿用（mutates + env.SERVER_TYPE=prod → confirmProd 输入应用名；dry-run 免门禁）。任意任务仍可带 `--dry-run` 全局模式（所有节点打印计划、模板照常渲染、不连 SSH）。

## 后端改造（保留底座）

- `engine/types.js`：类型规则 + 连接校验；`engine/workflow.js`：加载/校验/路径连通性/执行器（上下文袋按边注入）；`engine/nodes/*.js`：上表 ~20 个执行器（dry 分支必实现）。
- `engine/runner.js`：job = (workflowPath, taskName)，输入收集（task.input 节点在入队时解析参数）、副作用清理、审计条目加 workflowPath；串行队列/`.runs/`/audit 不变。
- `index.js`：新增 `GET /api/workflows`（读 local-config 清单并加载）、`POST /api/workflows/open|save`（写盘 + 更新最近清单）、`GET /api/node-types`（注册表元数据：输入输出/widget schema，前端动态生成表单与插槽）、`POST /api/jobs`（带 workflowPath/task/inputs/dryRun/confirmProd）；SSE stream/jobs/current 不变；静态托管改为 `web/dist`。
- `cli.js`：`run <wf|name> <task> [--dry-run --input k=v --confirm-prod X]`、`list`、`tasks`。
- `local-config.json`：新增 `workflows: []`（种子 = 三个示例）。

## 前端（web/，Vite + Svelte 5 + @xyflow/svelte）

- 画布：暗色主题、自定义节点组件（类型色头部 + 类型化彩色 Handle + 内联 widget：文本/数字/开关/下拉/表格）、右键/侧栏节点调色板（按分类）、小地图、吸附网格、拖拽布线（Svelte Flow 拒绝类型不匹配的连线）。
- 节点检查器：选中节点的完整 data 表单（按 node-types 元数据渲染）。
- **任务栏**：按 `tasks` 渲染按钮；悬停高亮路径；点击运行 → `task.input` 弹窗收集参数 → prod 输应用名确认 → 日志抽屉（移植现有 SSE-over-POST + 轮询兜底）。
- **定义任务模式**：点"定义任务"→ 依序点击图中节点 → 实时校验连通性 → 命名/mutates 保存进 workflow。
- **工作流管理**：左栏最近清单（local-config）；打开（路径输入）、新建（弹窗确认存放路径，给空白模板图）、保存/另存为（服务端写盘，保留 position）。
- 构建：`pnpm -C web build` 产出 `web/dist`；README 注明前端改动后需重新 build（引擎/CLI 不受影响）。

## 示例工作流（迁移现有三个应用为图）

`workflows/kids-ledger.json`、`xlgbis-ls.json`、`xlgbis-bs.json`：deploy/rollback/status/preview(apply-config 的 nginx/systemd/frp 安装 = render + upload + ssh.exec install + service reload 组合) 全部路径化，行为对齐现有 dry-run 输出。旧 `apps/*.js`、`_xlgbis_common.js` 与 `templates/*/deploy.sh|apply-config.sh` 脚本模板删除（nginx/systemd/frp 配置模板保留）；git 历史可回溯。

## 里程碑与验证

1. **M1 引擎**：类型系统/节点注册表/workflow 执行器/CLI/失败清理/git 自动恢复/三个示例 workflow。验证：verify 重写为——workflow 加载+路径连通性断言、类型不匹配拒绝断言、三个示例 workflow 的 deploy/rollback dry-run 输出与现行为逐条对照、失败清理逻辑单测式断言。
2. **M2 前端**：画布/调色板/inspector/任务栏/定义任务/工作流管理/日志抽屉。验证：浏览器实测全流程（新建→编辑图→定义任务→dry-run 运行→日志流→保存重开还原布局），截图留证。
3. **M3 迁移收尾**：删除旧层、文档重写（architecture/operations 更新为节点图模型 + 新增"节点类型指南"）、git 提交。

## 风险与对策

- 细粒度远端语义重写（原子切换/清理）是最大风险：`remote.extract` 内保持"临时目录+校验+原子 mv"单体原子性，runner 统一做副作用登记与逆序清理，dry-run 对照现脚本逐条验证。
- Svelte Flow 生态较新：自定义节点/Handle/校验 API 均为 1.0 核心能力，无边缘依赖；遇到坑退路是 Vue Flow 重写画布层（类型系统/引擎不受影响，因其与前端解耦）。
- workflow.json 手改出错：加载时全量校验（未知节点类型/悬空边/类型违规/路径断链）并给出精确报错。
