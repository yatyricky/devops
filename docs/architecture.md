# 架构与设计原则

## 定位

对同类框架的 SPA/server 应用做**统一的人工触发部署**：不在目标机装 agent、不用容器、不依赖云。
本工具是"自研轻量 Ansible"：清单描述应用，引擎负责传输与编排，远端脚本保证幂等与可回滚。

## 三层结构

```
GUI（public/index.html，单文件原生 JS；卡片式类型插槽编辑器）
        │  fetch + SSE-over-POST（流式日志）
runner（engine/runner.js）——串行队列、日志采集、.runs/ 持久化、audit.jsonl、prod 门禁
        │
workflows/*.json（应用唯一来源）→ engine/registry.js 加载 → engine/workflow.js 编译
        │（编译期：结构校验 + 类型化数据流校验；运行期：线性步骤执行器）
engine：ssh(指纹锁定) / env(schema) / render({{KEY}}) / tarball / gitops / release
```

关键决策：

1. **GUI 唯一入口**：没有 CLI 等价物，不维护第二套界面；部署逻辑 100% 在 workflows/*.json 里声明式可审计。
2. **类型化数据流**：步骤产出物与参数槽位都有类型（string/path/remote_path/bash/...），引用不兼容在编译期直接拒绝——部署流水线里最常见的类别错误（把文件当字符串、引用尚未产出的变量、拼错产出名）在保存时就被拦截，而不是部署到一半才炸。
3. **线性、无 DAG**：部署是严格顺序过程；数据流用"引用更早步骤的产出物"表达，不引入分支/并行复杂度。
2. **任务串行**：全局一个队列，杜绝两个部署并发写同一目标机。
3. **prod 门禁在 runner 兜底**：`SERVER_TYPE=prod` + 变更类任务必须携带 `confirmProd === 应用名`，GUI 只是采集这个确认的界面；dry-run 不变更状态，免门禁。
4. **机密不出本地**：env 文件在 `envs/`（gitignored），GUI 只显示路径；审计与任务记录只存 `confirmProd: "(typed)"`，不落任何机密值。

## 部署语义（与 xlgbis 原版对照）

一次 deploy：

1. `git fetch` → 校验工作树干净 → 可选 checkout 指定 ref（结束后恢复原分支）；
2. 本地构建（kids-ledger: `npm ci && vite build`；xlgbis client: `pnpm build`；xlgbis server: 暂存源码+packages/common）；
3. tar.gz 打包（LF、portable）；
4. SSH 上传（node-ssh，agent 认证 + SHA256 主机指纹 timingSafeEqual 锁定）；
5. 上传渲染后的远端脚本并 `bash -l` 执行（无论成败都删除远端脚本）；
6. 远端脚本：解压校验 → 服务器上装生产依赖 →（kids-ledger）data/config.json 符号链接到 `state/` 持久目录 →
   `releases/<ref>-<hash>-<time>/` 不可变目录 → `current`/`server`/`client` 符号链接切换 → systemd 重启 / nginx reload；
7. 回滚 = 符号链接指回旧 release + 重启，不重新构建。

xlgbis 的 `deploy_client.sh` / `deploy_server.sh` / `ls_apply_config.sh` / `bs_apply_config.sh` / 全部 nginx、systemd、frp 模板
已**原样转写**进 `templates/xlgbis/`（仅将 LS apply 脚本硬编码的 frp 用户参数化为 `{{FRP_USER}}`），
env 键位 schema 抄录自 `ls_ops.js` / `bs_ops.js` / `RequiredEnv.js` / `Config.js`——本工具不 import xlgbis 仓库任何代码。

kids-ledger 的数据保留方案：应用按 `__dirname` 解析 `data/` 与 `config.json`（解析到 release 真实路径），
部署脚本在每个 release 内幂等创建 `data → $DEPLOY_DIR/state/data`、`config.json → $DEPLOY_DIR/state/config.json` 符号链接，
应用代码零改动。

## 如何新增一个应用

只有一种方式——工作流 JSON：

1. GUI 右上角「＋ 新建工作流」（SPA 预设表单或空白工作流），或手写 `workflows/<name>.json`；
2. 「✎ 编辑工作流」在卡片编辑器里组装步骤：每个步骤选原子能力、填参数槽（手动输入或引用更早步骤的类型化产出物）、增删排序；
3. nginx/frp/systemd 模板放应用仓库的 `deploy/` 目录，用 `{{ENV_KEY}}` 占位，工作流里用 `template.push` 推送；
4. 创建 `envs/<name>.env`（创建工作流成功时有样例内容）；
5. GUI 卡片上先 dry-run 预览完整计划，再真实部署。步骤类型、类型系统与产出物参考见 [workflow-schema.md](workflow-schema.md)。

## 依赖（全部 4 个）

`express ^5`（HTTP+静态）、`node-ssh`（SSH/SFTP，Windows 命名管管道 agent）、`tar`（打包）、`dotenv`（env 解析）。

## 已知边界

- xlgbis 原仓库的 `devops/` JS 脚本保持可用（过渡期双轨）；其内部的耦合缺陷（deploy_server.js 副作用导入、
  packages/common 双用途、env-usage.json 退出遥测、失效 dev 脚本）**另开任务修复**，本工具已从设计上规避（不 import 应用代码）。
- 完整安全审计（xlgbis `--audit` 的 sshd/ufw/证书等检查）未迁移；status 提供服务/端口/磁盘/node 版本概览。
- GUI 的 SSE 流在任务长时间静默时可能被中间层掐断，前端会自动降级为轮询补齐日志（已实现）。
