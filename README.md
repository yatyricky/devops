# devops-console

轻量 DevOps 控制台：**ComfyUI 式节点图工作流编辑器 + SSH 推送式部署引擎**。用可视化节点图编排 SPA/server 应用的部署/回滚/配置下发（当前内置 kids-ledger 与 xlgbis LS/BS 三个示例工作流）。

- 前端：Svelte 5 + Svelte Flow（Vite 构建，暗色画布）
- 引擎：Node.js，4 个直接依赖（express / node-ssh / tar / dotenv）
- 无容器、无 agent、无云依赖；所有部署**人工触发**，prod 需输入工作流名确认

## 核心概念

1. **一个 workflow = 一张节点图**（`workflow.json`，可放磁盘任意位置）
2. **节点有严格类型化插槽**：`env / ssh / file / string / number / boolean / any`，类型不匹配的连线在编辑与保存时都会被拒绝
3. **任务 = 图中一条路径**：如 `env → git → build → pack → upload → extract → deps → symlink → service`；也可短到 `env → ssh → symlink`（回滚）
4. **env 文件、params、运行时输入都是节点**（`env.file` / `params` / `task.input`），与其余节点平权
5. **SSH 命令节点支持动态插槽**：命令里写 `{{name}}` 生成 string 输入插槽、`{{env.KEY}}` 直连 env 节点取值，值自动 shell 引号包裹

## 快速开始

```bash
npm install
npm -C web install && npm -C web run build   # 构建画布前端

# 1) 复制环境文件并填写真实值
cp envs/kids-ledger.example.env envs/kids-ledger.env

# 2) 启动（默认 http://127.0.0.1:3010）
node index.js          # 或 start.cmd

# 3) 或纯 CLI（与 GUI 同一引擎）
node cli.js list
node cli.js tasks kids-ledger
node cli.js run kids-ledger deploy --dry-run
node cli.js run kids-ledger deploy --input ref=master     # prod 会要求输入工作流名
node cli.js run kids-ledger rollback --input release=<name>
```

前端改动后需重新 `npm -C web run build`（引擎与 CLI 不受影响）。

## 界面

- **左栏**：节点调色板（输入 / 版本 / 构建 / 远端 / 工具），点击添加节点
- **中间**：节点图画布（拖拽布线、类型色插槽、小地图、任务路径悬停高亮带序号）
- **右栏**：节点检查器（按注册表元数据动态生成表单）
- **任务栏**：按 workflow.json 的 tasks 渲染按钮；悬停高亮路径；点击运行（收集 task.input 输入 + prod 确认）；「定义任务」= 按执行顺序点击节点，把一条路径保存为任务
- **底部**：日志抽屉（SSE 流式 + 断流轮询兜底，机密值打码）
- **顶部**：工作流列表（local-config 最近打开 + 仓库自带 workflows/）、打开/新建（弹窗确认存放路径）/保存

## 目录结构

```
├─ index.js               # 服务器：工作流注册 + 任务队列 + SSE 日志 + 静态托管 web/dist
├─ cli.js                 # CLI 入口（与 GUI 共用 runner）
├─ engine/
│  ├─ types.js            # 插槽类型规则（前后端同规则）
│  ├─ nodes/              # 节点注册表：input/build/remote/util 四类 22 种
│  ├─ workflow.js         # 图校验 + 任务路径执行器（依赖闭包拓扑）
│  ├─ runner.js           # 串行队列/.runs 持久化/审计/prod 门禁/副作用收尾
│  ├─ registry.js         # 工作流发现（local-config.workflows + 仓库 workflows/）
│  └─ ssh.js env.js render.js tarball.js gitops.js exec.js config.js
├─ workflows/             # 示例工作流 + tpl/ 配置模板（nginx/systemd/frp，随工作流自包含）
├─ web/                   # Svelte 5 + Svelte Flow 前端（构建产物 web/dist）
├─ envs/                  # 环境文件（gitignored，仅 *.example.env 入库）
└─ tools/verify-dryrun.js # 引擎自检（12 项断言）
```

## 节点类型（22 种）

| 分类 | 节点 |
|---|---|
| 输入 | `env.file`（→env）、`params`（→any）、`task.input`（→string，运行时弹窗/CLI `--input` 收集） |
| 版本 | `git.ref`（fetch+干净校验+checkout，任务结束自动恢复原分支） |
| 构建 | `cmd.exec`、`write.env`、`stage.copy`（多源暂存+排除）、`tar.pack`、`template.render`（`./`=工作流目录） |
| 远端 | `ssh.session`、`ssh.exec`（动态插槽）、`ssh.upload`（任务结束自动清理远端临时文件）、`remote.extract`（**原子**：.tmp 解压→expect 校验→mv 成正式 release）、`remote.deps`、`remote.chown`、`remote.symlink`、`remote.service`、`remote.check`（断言正则） |
| 工具 | `field.get`（env/params 取单值）、`string.const`、`string.format`（动态插槽拼接）、`log.print`（预览端点） |

## 验证

```bash
node tools/verify-dryrun.js   # 类型/图校验/路径执行/掩码/prod 门禁 + 三工作流 dry-run 端到端
```

详见 [docs/architecture.md](docs/architecture.md) 与 [docs/operations.md](docs/operations.md)。
