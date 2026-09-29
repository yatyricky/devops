# 运维手册

## 初始化（每台控制机一次性）

1. **安装与构建**：`npm install && npm -C web install && npm -C web run build`，然后 `node index.js`（或 `start.cmd`）。
   默认只绑 `127.0.0.1:3010`；环境变量 `DEVOPS_HOST / DEVOPS_PORT / DEVOPS_TOKEN` 可覆盖。
2. **配置 local-config.json**（gitignored，模板见 local-config.example.json）：

   ```json
   {
     "host": "127.0.0.1",
     "port": 3010,
     "token": "",
     "workflows": ["~/OneDrive/linux/kids-ledger-prod.json"],
     "repos": {}
   }
   ```

   `workflows` 是最近打开的工作流列表（GUI「打开…」会自动追加；支持 `~/` 路径）。
   ⚠ `repos` 键当前无运行路径消费（评审发现特性失联，见 review-milestone-1.md P2），仅占位。
3. **设 token（强烈建议）**：`token` 为空 = API 完全开放。默认仅绑回环地址缓解了外网暴露，
   但本机任意进程/浏览器可打 API（评审发现 `:id` 路径穿越、任意路径读写等未修项，见 review P0/P1）。
   设置后在 GUI 右上角填一次即可（走 `x-devops-token` 头）。
4. **目标机准备**：Ubuntu + systemd + nginx；部署用户配好 NOPASSWD sudo（引擎用 `sudo -n`，缺失即快速失败）。
5. **取指纹并锁定**：先跑一次 `--dry-run` 看计划；首次真实连接日志会打印服务器公钥 SHA256 指纹（base64），
   填回 SSH 会话卡片的「指纹」控件。之后所有连接做 timingSafeEqual 比对，不匹配直接拒绝。

## 日常部署

**GUI**（http://127.0.0.1:3010）：

1. 顶部选择工作流，或「打开…」输入任意路径的 JSON；
2. 编辑：拖入节点、连线（类型即契约）；可序列化变更 600ms 自动写盘，节点位置等布局变更
   星号提示手动保存；「未保存改动」可直接点运行（内存态执行，不落盘）；
3. 悬停任务按钮高亮将执行的子图；点击运行，弹窗可勾 **dry-run** 先看完整计划；
4. PROD 任务（子图内 SERVER_TYPE=prod + mutates）需输入工作流名确认；
5. 底部日志抽屉实时滚动（SSE，断流自动轮询兜底），节点状态着色（运行中跑马灯/成功绿框/失败红框）。

**CLI 等价**：

```bash
node cli.js list
node cli.js tasks <名或路径>
node cli.js run <名或路径> deploy --dry-run
node cli.js run <名或路径> deploy --input ref=master
node cli.js run <名或路径> rollback --input release=<name>
```

非交互 prod（如脚本内调用）：`--confirm-prod <工作流名>`。

## 回滚

回滚由工作流自己表达（典型：`struct → ssh.session → remote.symlink` 切换 release 软链 +
重启服务），秒级、不重新构建。release 布局与命名由你的工作流决定（如
`builds/<name>-<ref>-<timestamp>`），`path.basename` 节点可从压缩包路径提取名字。

## 审计与历史

- `.runs/<id>.json`：每次任务的完整日志行、参数（`confirmProd` 只记 `"(typed)"`）、节点状态；
- `.runs/audit.jsonl`：审计流水（时间、工作流、任务、结果）；
- CLI `node cli.js list` / `tasks` 也可离线核对。

## 安全清单

- **workflow JSON 即机密文件**（架构决策 4）：struct 字段/token 直接写在图里——存安全处、勿提交公共仓库；
- local-config.json、`.runs/`、`.tmp/`、web/dist 均已 gitignore；
- 日志掩码 `SECRET/TOKEN/PASSWORD/PASSPHRASE=***`（注意：JSON 形态 `"KEY":"VALUE"` 目前
  不在掩码范围，评审 P0-6 待修——打印 struct 时留意）；
- SSH 认证走 ~/.ssh/config 别名（IdentityFile）或 agent；生产部署前锁定主机指纹；
- 需要局域网访问时改 host 并**务必设置 token**；
- 已知未修安全项汇总见 [review-milestone-1.md](review-milestone-1.md) P0-2/P0-5/P0-6。

## 故障排查

| 现象 | 处理 |
|---|---|
| `Refusing to run ... on prod without typed confirmation` | 预期行为：GUI 输入工作流名 / CLI `--confirm-prod` |
| `HOST KEY MISMATCH` | 服务器重装或换 IP；确认后更新 SSH 会话卡片的指纹 |
| 保存报「类型不兼容 / 多条连线 / 依赖更晚节点」 | 按提示改图；校验在保存与加载时同源执行 |
| `Working tree is not clean` | 提交/暂存仓库改动，或用 HEAD 部署 |
| 连线拖到一半被拒（toast「连线被拒」） | 类型不匹配或插槽已有连线（任务级才校验唯一，编辑级先挡同槽） |
| 收起组后想改跨组连线 | 收起态锁定增删——展开组再编辑 |
| 画布空白/节点不可见 | 确认 `npm -C web run build` 已执行；内嵌 webview 的 RO/rAF 兜底已内置，普通浏览器无此问题 |
| 日志停「运行中」数秒后自动补齐 | SSE 静默期断流后的轮询兜底，正常现象 |
| GUI 401 / 请求被拒 | token 未填或与 local-config 不一致（右上角重填） |
