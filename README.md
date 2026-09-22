# devops-console

轻量 DevOps 控制台：**SSH 推送式部署引擎 + 单文件 Web GUI + 类型化可视化工作流**。部署逻辑全部配置化——`workflows/<name>.json` 描述一个应用的全部任务（deploy / rollback / status / apply-config / 任意自定义），GUI 上用卡片式步骤编辑器组装（像 ComfyUI：每个步骤是一个原子能力，有带类型的参数与产出物）。

单文件 Express 服务器 + 单文件原生 JS 前端（无构建、无框架、无 TypeScript）、4 个直接依赖、`node index` 直接运行。GUI 是唯一入口，没有第二套等价界面。

## 核心特性

- **类型化数据流工作流**：线性步骤列表，无 DAG；每个步骤声明带类型的产出物（`archivePath(path)`、`uploadedTo(remote_path)`…），每个参数是带类型的输入槽——**文件产出物不能被当字符串入参**，引用类型不匹配在编辑器里选不出来、保存时编译期校验兜底。9 种原子能力：`git.checkout / env.write / shell / archive / upload / remote / template.push / vars.set / log`。
- **模板随应用仓库版本管理**：nginx/frp/systemd 配置放在各自应用仓库的 `deploy/` 目录，工作流用 `template.push` 配置模板路径 + 参数，渲染后推送。
- **部署语义**：`releases/<ref>-<hash>-<time>` 不可变目录 + `current` 符号链接切换 + systemd/nginx 重载 + 健康检查，天然可回滚（秒级切链，不重新构建）。
- **无 CI 触发器**：所有部署由人在 GUI 手动触发；**prod 环境必须输入应用名二次确认**（runner 内置门禁兜底）；dry-run 只打印计划、绝不连接服务器。
- **安全**：SSH 主机指纹 SHA256 锁定（timingSafeEqual）、env 机密文件不入 git 且 GUI 永不显示其值、任务串行执行、全量审计（`.runs/audit.jsonl`）。
- 无容器、无 WSL、无云依赖；内存占用 ~150MB。

## 快速开始

```bash
npm install

# 1) 新建应用：GUI 右上角「＋ 新建工作流」（SPA 预设或空白），
#    或参考 workflows/kids-ledger.json / xlgbis-*.json / spa.example.json 手写
#    nginx/frp 等模板放应用仓库的 deploy/ 目录

# 2) 填 env：envs/<应用名>.env（创建工作流成功后会弹出样例内容）
#    REMOTE_HOST_FINGERPRINT 先留空，跑一次「状态」任务取指纹再填回

# 3) 启动 GUI（默认 http://127.0.0.1:3010，自动打开浏览器）
node index.js          # 或双击 start.cmd

# 4) 卡片上先 dry-run 预览完整执行计划，再真实部署；prod 需输入应用名确认
```

内置四个工作流应用：**kids-ledger**（全栈：构建 + 服务器装依赖 + systemd + 健康检查）、**xlgbis-ls / xlgbis-bs**（前端+服务端+frp 隧道，各 6 个任务）、以及你在 GUI 里创建的任意应用。

## 目录结构

```
├─ index.js               # 服务器：扁平路由 + 静态托管 + SSE-over-POST 流式日志 + 工作流 CRUD API
├─ engine/
│  ├─ workflow.js         # 核心：类型化数据流（步骤注册表 + 编译期类型校验 + 执行器）
│  ├─ registry.js         # 应用注册中心：加载 workflows/*.json → 标准 manifest
│  ├─ presets.js          # SPA / 空白 预设生成器（GUI「＋ 新建工作流」）
│  ├─ ssh.js              # node-ssh + Windows agent 命名管管道 + 指纹锁定
│  ├─ env.js              # .env 解析 + schema 校验
│  ├─ render.js           # {{KEY}} 模板渲染（未解析即报错）
│  ├─ exec.js tarball.js gitops.js release.js
│  └─ runner.js           # 串行任务队列 + 日志采集 + .runs/ 持久化 + 审计 + prod 门禁
├─ workflows/             # 应用定义（JSON 工作流；*.example.json 与 _ 前缀不加载）
├─ public/index.html      # 单文件前端（卡片式类型插槽编辑器 + 原生 JS）
├─ envs/                  # 环境文件（gitignored；只有 *.example.env 入库）
├─ .runs/                 # 任务历史 + 日志 JSON + audit.jsonl（gitignored）
└─ docs/                  # architecture / operations / workflow-schema
```

## 验证

```bash
npm run verify    # 引擎自检：渲染/env/打包/release 校验 + 工作流类型校验 + dry-run 端到端断言
```

详见 [docs/workflow-schema.md](docs/workflow-schema.md)（类型系统与步骤参考）、[docs/architecture.md](docs/architecture.md)（架构）和 [docs/operations.md](docs/operations.md)（运维手册）。
