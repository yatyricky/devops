# 运维手册

## 首次初始化（每台目标机一次性）

1. **目标机准备**：Ubuntu + systemd + nginx；部署用户配好 NOPASSWD sudo（引擎用 `sudo -n`，缺失即快速失败）；
   kids-ledger 需 node ≥ 22.5（`node:sqlite`）；xlgbis 需 nvm + pnpm（远端命令默认走 `bash -lc` 登录 shell）。
2. **填 env**：`cp envs/<app>.example.env envs/<app>.env`，填 `REMOTE_HOST / REMOTE_USER / DEPLOY_DIR` 等。
3. **取指纹并锁定**：先跑一次 `node cli.js run <app> status --dry-run` 不连网；然后直接跑 `status`（无 `--dry-run`），
   首次连接日志会打印服务器公钥 SHA256 指纹（base64），填回 env 的 `REMOTE_HOST_FINGERPRINT`。
   之后所有连接做 timingSafeEqual 比对，不匹配直接拒绝。
4. **下发主机配置**：GUI「应用配置」或 `node cli.js run <app> apply-config`——安装 nginx 站点、systemd 单元、
   frp 配置（xlgbis）。模板在工作流旁 `workflows/tpl/<app>/`，随工作流版本管理。
5. **kids-ledger 专属**：目标机 `/opt/kids-ledger/state/config.json` 需手工创建（从仓库 config.example.json 复制并配置
   token）；SQLite 数据落 `state/data/`，部署脚本每个 release 幂等软链，跨发布保留。

## 日常部署

**GUI**（`node index.js` → http://127.0.0.1:3010）：

1. 顶部选择工作流（PROD 工作流有 ⚠ 标记）；
2. 悬停任务按钮可在图上高亮将执行的路径（带序号）；先点开弹窗勾 **dry-run** 看完整计划；
3. 正式运行：填 task.input 输入（如 ref / release）；PROD 需输入工作流名确认；
4. 底部日志抽屉实时滚动，终态 成功/失败；右侧历史（.runs）可回放。

**CLI 等价**：

```bash
node cli.js list
node cli.js tasks kids-ledger                     # 查看每个任务的路径
node cli.js run kids-ledger deploy --dry-run
node cli.js run kids-ledger deploy --input ref=master
node cli.js run xlgbis-ls deploy-server --input ref=v1.2.0
node cli.js run kids-ledger rollback --input release=kids-ledger-master-a1b2c3d-20260923080000
```

非交互 prod（如脚本内调用）：`--confirm-prod <工作流名>`。

## 回滚

1. 跑 `status` 看当前 release 与 releases 列表（新→旧）；
2. 回滚 = `rollback`（或 xlgbis 的 rollback-client/rollback-server）：校验目标 release 布局 → 切 `current`/`client`/`server` 软链 → 重启服务（+健康检查）。秒级，不重新构建。

## 审计与历史

- `.runs/<id>.json`：每次任务的完整日志行、参数、结果；
- `.runs/audit.jsonl`：审计流水（时间、工作流、任务、参数、结果；confirmProd 只记 "(typed)"）；
- GUI 底部日志抽屉可回放任意历史任务。

## 安全清单

- envs/*.env、local-config.json、.runs/、.tmp/ 均已 gitignore——不要把真实 env 提交进仓库；
- GUI 默认只绑 127.0.0.1；需要局域网访问时改 local-config.json 的 host 并**务必设置 token**（GUI 右上角填一次）；
- SSH 认证走 Windows openssh agent（命名管管道）或 env 里 `REMOTE_KEY_FILE` 私钥；生产部署前必须锁定指纹。

## 故障排查

| 现象 | 处理 |
|---|---|
| `Refusing to run ... on prod without typed confirmation` | 预期行为：GUI 输入工作流名 / CLI 交互输入或 `--confirm-prod` |
| `HOST KEY MISMATCH` | 服务器重装或换 IP；确认后更新 env 里的指纹 |
| 保存工作流报「类型不兼容 / 多条连线 / 依赖更晚节点」 | 按提示改图；校验在保存与加载时都会做 |
| `Working tree is not clean` | 提交/暂存仓库改动，或用 HEAD 部署（dirty 会标进版本号） |
| kids-ledger 服务起不来 | 检查 `/opt/kids-ledger/state/config.json` 存在且 JSON 合法 |
| 画布空白/节点不可见 | 确认 `npm -C web run build` 已执行；内嵌 webview 的 ResizeObserver 兜底已内置，普通浏览器无此问题 |
| 日志停「运行中」数秒后自动补齐 | SSE 静默期断流后的轮询兜底，正常现象 |
