# devops-console

轻量 DevOps 控制台：**ComfyUI 式节点图工作流编辑器 + SSH 推送式部署引擎**。用可视化节点图编排 SPA/server 应用的部署/回滚/配置下发。

- 前端：Svelte 5 + Svelte Flow（Vite 构建，暗色画布）
- 引擎：Node.js，4 个直接依赖（express / node-ssh / tar / dotenv）
- 无容器、无 agent、无云依赖；所有部署**人工触发**，prod 需输入工作流名确认
- **代理约束见 [AGENTS.md](AGENTS.md)**：未经用户明确要求，禁止连接远程服务器、禁止运行工作流任务

## 核心概念

1. **一个 workflow = 一张节点图**（JSON 文件，可放磁盘任意位置，经 GUI「打开…」注册进最近列表；支持 `~/` 前缀路径自动展开）
2. **节点有严格类型化插槽**：`struct / ssh / string / number / boolean / any`，类型不匹配的连线在编辑与保存时都会被拒绝
3. **任务 = 从图中选出的节点子图**（顺序无关，构成 1 个或多个 DAG；独立分支并发执行）
4. **Struct 构造器/析构器**：字段（key + 类型 + 值）直接定义在图里，每个字段生成同名输入口（连线后手填失效）；析构器按上游字段自动生成出口。**workflow JSON 本身即机密文件——放在安全处，勿提交公共仓库**
5. **Typed ports（内联字面量）**：每个输入口既可连线、也可直接在卡片上手填值（`data.lit`）；连线后手填失效，断开恢复
6. **动态插槽**：`ssh.exec`/`cmd.exec` 命令里写 `{{name}}` 生成 string 输入口；`path.resolve`/`string.join` 的 p1..pN 段数由 stepper 控件驱动；`template.render` 按模板内容自动生成各 `{{VAR}}` 输入口
7. **Group 分组**：Ctrl+点选多个节点 →「组合」生成背景板分组；展开态跨组边直连（增删连线与无组时一致）；「收起」变黑箱条——成员隐藏、跨组边以左右缘隧道接口双段转发、条上标注 `<节点标题>: <端口>` 标签、与组相连的边锁定不可增删（展开即可编辑）；collapsed 状态持久化
8. **克隆**：选中 1+ 节点 →「克隆」——常量属性深拷贝、连线不复制、位置偏移 (40,40)、随原节点入组

## 快速开始

```bash
npm install
npm -C web install && npm -C web run build   # 构建画布前端

node index.js          # 启动（默认 http://127.0.0.1:3010，或 start.cmd）
```

前端开发模式：`npm -C web run dev`（Vite 代理 /api → 3010，改前端免重构建）。

CLI（与 GUI 同一引擎）：

```bash
node cli.js list                        # 已注册工作流（local-config.workflows）
node cli.js tasks <名或路径>            # 查看每个任务的节点集合
node cli.js run <名或路径> <task> --dry-run
node cli.js run <名或路径> <task> --input ref=master
                                        # prod 任务会要求输入工作流名（或 --confirm-prod <名>）
```

环境变量覆盖：`DEVOPS_HOST / DEVOPS_PORT / DEVOPS_TOKEN`。

## 界面

- **左栏**：节点调色板（输入/版本/构建/远端/工具，点击或拖入画布；「未测试」徽章来自 `node-types-untested.json` 手工清单）
- **中间**：节点图画布——拖拽布线、类型色插槽、小地图、吸附开关、任务路径悬停高亮带序号、节点便笺、Group 背景板（组合/拆分/克隆按钮在任务栏右侧）
- **节点卡片**：动态生成的 widget 表单（文本/枚举/键值/清单/stepper/struct 字段编辑）、refs/scripts/ssh 别名三类下拉（带刷新）、编辑期输出推断（path.resolve/string.join/template.render 显示将产出的值）
- **任务栏**：tasks 按钮悬停高亮路径；点击运行（dry-run 勾选、prod 确认门禁）；「定义任务」= 点选节点保存为任务；「刷新列表」刷新画布上所有下拉
- **顶部**：工作流列表（最近打开）、打开…/新建…（任意路径，弹窗确认）、保存；**自动保存**——可序列化字段/节点/边/任务的变更 600ms 防抖写盘，节点位置等布局变更靠手动保存（星号提示）
- **底部**：日志抽屉（SSE 流式 + 断流轮询兜底，机密值打码，节点状态着色）

## 目录结构

```
├─ index.js               # 服务器：token 鉴权 + 全部 HTTP API + 任务队列 + SSE 日志 + 静态托管 web/dist
├─ cli.js                 # CLI 入口（与 GUI 共用 runner）
├─ engine/
│  ├─ types.js            # 插槽类型规则（canConnect/coerce）
│  ├─ nodes/              # 节点注册表：input/build/remote/util（元数据 + run）
│  ├─ workflow.js         # 图校验 + 任务子图执行器（依赖闭包拓扑，层内并发）
│  ├─ runner.js           # 串行队列/.runs 持久化/audit.jsonl 审计/prod 门禁/副作用收尾
│  ├─ registry.js         # 工作流发现（local-config.workflows）
│  ├─ config.js           # local-config 读写 + 未测试节点清单
│  ├─ ssh.js sshconfig.js # SSH 连接/执行/上传 + ~/.ssh/config 解析
│  ├─ gitops.js exec.js render.js tarball.js release.js
├─ web/                   # Svelte 5 + Svelte Flow 前端（src/，构建产物 web/dist 不入库）
├─ local-config.json      # 运行配置（gitignored；example 见 local-config.example.json）
├─ node-types-untested.json # 「未测试」节点类型手工清单（入库）
├─ .runs/                 # 任务运行记录 + audit.jsonl（gitignored）
└─ tools/verify-dryrun.js # 引擎自检（47 项断言，自带 fixture 不连网）
```

## 节点类型（29）

| 分类 | 节点 |
|---|---|
| 输入 | `string.const`（字符串常量）、`struct.make`（构造）、`struct.split`（析构，出口按上游字段动态生成） |
| 版本 | `git.ref`、`git.checkout`（任务结束自动恢复原分支）、`git.getRefs` |
| 构建 | `cmd.exec`（本地命令，动态插槽）、`stage.copy`（N 条 from/to 暂存复制）、`tar.pack`（白/黑名单）、`template.render`（`./`=工作流目录，动态变量口）、`npm.run` |
| 远端 | `ssh.session`（~/.ssh/config 别名直连，可选 SHA256 指纹锁定）、`ssh.close`、`ssh.exec`（动态插槽，值自动引号包裹）、`ssh.upload`（权限不足回退 /tmp 暂存 + sudo install；无 trap，上传即保留）、`remote.extract`（纯解压）、`pnpm.install`（生产 pnpm install --prod --frozen-lockfile，登录用户执行）、`remote.chown`、`remote.symlink`（发布/回滚核心）、`systemd.run`（restart/enable --now/start 等 systemd 动作）、`remote.check`（断言正则）、`remote.nginx-reload`（校验后重载，整段提权）、`remote.install`（sudo install 落盘系统目录，mode/owner/group 可配） |
| 工具 | `path.resolve`（N 段拼接，posix/windows/auto）、`path.basename`、`string.join`、`string.format`、`field.get`（struct 取单值）、`log.print`（预览端点） |

## 验证

```bash
node tools/verify-dryrun.js   # 47 项断言：类型/图校验/子图语义/调度/门禁/掩码/节点行为（自带 fixture）
```

## 文档

- [docs/architecture.md](docs/architecture.md) —— 架构分层、关键决策、执行语义、前端要点
- [docs/operations.md](docs/operations.md) —— 运维手册：初始化、部署、审计、安全、排障
- [docs/buglog.md](docs/buglog.md) —— bug 修复记录（回归依据）
- [docs/review-milestone-1.md](docs/review-milestone-1.md) —— 里程碑 1 全盘评审与下一阶段路线图（P0/P1/P2）
