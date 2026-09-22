# 运维手册

## 首次初始化（每台目标机一次性）

1. **准备目标机**：Ubuntu + systemd + nginx；创建部署用户并配置 NOPASSWD sudo（`sudo -n` 快速失败）；
   kids-ledger 还需 node ≥ 22.5（`node:sqlite`），xlgbis 需要 nvm + pnpm + `/usr/local/bin/node`。
2. **填 env**：`cp envs/<app>.example.env envs/<app>.env`，填 `REMOTE_HOST/REMOTE_USER/DEPLOY_DIR` 等。
   `REMOTE_HOST_FINGERPRINT` 先留空。
3. **取指纹并锁定**：GUI 上对该应用跑一次「状态」任务——日志会打印服务器公钥的 SHA256 base64 指纹，
   把它填回 env 的 `REMOTE_HOST_FINGERPRINT`（hex 或 base64 均可）。之后连接会做 timingSafeEqual 比对，
   不匹配直接拒绝。
4. **应用主机配置**：GUI「应用配置 / 推送配置」任务先 dry-run 对照输出后执行。
   安装 nginx 站点、systemd 单元（kids-ledger）、frps/frpc 配置（xlgbis）。
5. **kids-ledger 专属**：首次部署前在目标机创建 `/opt/kids-ledger/state/config.json`
   （从仓库 `config.example.json` 复制并配置 token）。SQLite 数据会落在 `state/data/`，跨发布保留。

## 日常部署（GUI）

1. 打开 `http://127.0.0.1:3010`（`start.cmd` 或 `node index.js`）；
2. 应用卡片上选任务：**部署前端 / 部署服务端 / 应用配置 / 回滚 / 状态**；
3. 部署弹窗可选 git ref（默认 HEAD = 当前工作树），建议先点 **dry-run 预览** 看完整远端脚本；
4. 点部署后日志抽屉实时滚动输出，终态显示 成功/失败；
5. **PROD 环境必须输入应用名**（如 `kids-ledger`）确认。

## 回滚

1. 应用卡片上跑「状态」任务查看 `releases` 列表（新→旧）；
2. 回滚弹窗填目标 release 名；
3. 回滚只是把符号链接指回旧 release 并重启服务，秒级完成，不重新构建。

## 审计与历史

- 每次任务：`.runs/<id>.json`（完整日志行 + 参数 + 结果）；
- 审计流水：`.runs/audit.jsonl`（时间、应用、任务、参数、结果；`confirmProd` 只记 "(typed)"）；
- GUI 右侧历史列表可回放任意一次任务的完整日志。

## 安全清单

- env 文件、`local-config.json`、`.runs/` 均已 gitignore——**不要**把真实 env 提交进仓库；
- GUI 默认只绑 `127.0.0.1`；如需局域网访问，改 `local-config.json` 的 `host` 并**务必设置 `token`**
  （GUI 右上角输入一次即可，存 localStorage）；
- SSH 认证优先走 Windows openssh agent（命名管管道），也可在 env 里配 `REMOTE_KEY_FILE` 私钥；
  所有主机指纹必须锁定后再放行生产部署。

## 常驻运行（可选）

直接 `start.cmd` 手动起即可。如需开机自启/后台常驻，用 NSSM 注册 Windows 服务：

```
nssm install devops-console "C:\Program Files\nodejs\node.exe" "C:\Users\yatyr\workspace\devops\index.js"
```

（或用任务计划程序开机运行 `start.cmd`。）

## 故障排查

| 现象 | 处理 |
|---|---|
| `Refusing to run ... on prod without typed confirmation` | 预期行为：GUI 输入应用名确认 |
| `HOST KEY MISMATCH` | 服务器重装或换 IP；确认后在 env 里更新指纹 |
| 日志停在 "运行中" 数秒后自动补齐 | SSE 静默期被掐断后的轮询兜底，正常现象 |
| `Working tree is not clean, unable to deploy specified ref` | 提交或暂存仓库改动，或用 HEAD 部署（dirty 会标记在版本号里） |
| kids-ledger 服务起不来 | 检查 `/opt/kids-ledger/state/config.json` 是否存在且 JSON 合法 |
| xlgbis 服务器装依赖失败 | 远端脚本假定 nvm/pnpm 可用（`bash -l` 加载）；确认部署用户 shell 环境 |
