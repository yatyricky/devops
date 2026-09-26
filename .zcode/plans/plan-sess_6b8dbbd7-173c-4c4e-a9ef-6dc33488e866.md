# ssh.session 改别名直连 + 移除"生成 .env"

## 结论依据（已探查）

- node-ssh 13.2.1 无 ssh-config/别名支持（typings 确认）→ **自建 `~/.ssh/config` 解析器**（你的 config 为平铺 Host 块：vultr-tokyo / dogyun-hongkong / tencent-shanghai，含 HostName/User/Port/IdentityFile）。
- `write.env` 只在 `_attic/`（永不加载）出现，且其 `env` 输入类型本就不在 SOCKET_TYPES（当前已无法连线）→ **移除零破坏**。
- live 工作流（kids-ledger-prod.json）的 ssh.session 无任何连线 → 输入改造不破坏现有文件。
- 只有 `ssh.session` 读 `inputs.env`，其余远端节点全部只消费 ssh 会话句柄 → 改造面收敛。

## 改动清单

### 1. 新增 `engine/sshconfig.js`（~40 行手写解析器，不加依赖）
- 解析 `~/.ssh/config`：按 Host 块切分，提取 HostName / User / Port / IdentityFile（多个取第一个存在的，`~` 展开）；Host 多模式空格分隔、大小写不敏感匹配；`Match`/`Include` 块跳过并标注不支持。
- `resolveAlias(alias)` → `{ host, user, port, identityFile }`；别名未命中时**镜像 ssh 行为回退**：host=alias、user=本机用户名（日志注明"未在 config 中找到，按主机名直连"）。
- `listAliases()` → 别名数组（下拉用）。
- `sshConnect`（engine/ssh.js）增加 `opts.port` 透传（默认 22）；指纹未锁定的警告文案从"REMOTE_HOST_FINGERPRINT env"改为指向卡片指纹控件。

### 2. `ssh.session` 节点重做（engine/nodes/remote.js）
- **inputs: []**（无输入）；outputs 不变 `ssh`。
- **widgets**：`alias`（string，必填，SSH 别名）+ `fingerprint`（string，选填，SHA256 主机指纹锁定——保留既有安全模型）。
- run：`resolveAlias(node.data.alias)` → `sshConnect(host, user, fingerprint, { keyFile: identityFile, port })`；dry-run 打印解析出的 host/user/port/指纹状态。别名未填 → 明确报错。
- 动态出口等其余远端节点不动。

### 3. 别名下拉 + 解析信息展示（复用 refsPicker/scriptsPicker 既有模式）
- `index.js` 新增 `POST /api/ssh/aliases`：返回 `{ aliases: [...], resolved: {host,user,port,identityFile}|null }`（resolved 按 body.alias 解析，未命中为 null）。
- `ssh.session` meta 加 `sshAliasesPicker: true`（nodeTypesMeta 已有转发模式）；`DevNode.svelte` 加与 refsPicker 同构的块：select + 刷新按钮 + resolved 一行小字（host/user/port），错误走现有 cardError 红框。

### 4. 移除 write.env
- 删 `engine/nodes/build.js` 中该节点定义；注册表自然少一种（26→25）。
- `doOpen` 新建工作流模板（App.svelte）：去掉 `cfg1.struct → ssh1.env` 边（ssh.session 已无输入），模板保留 ssh.session 单节点。
- 删除死代码 `engine/presets.js`（引用不存在的 env.file、无人 import）；grep 确认 `engine/env.js` 是否仍被引用，无引用则一并删。
- 文档同步：README 节点表（写.env 移除、ssh.session 新形态、计数修正）、docs/architecture.md 相关行、docs/operations.md 的 env 连接模型段落改为别名模型。

### 5. 测试与验证
- `tools/verify-dryrun.js`："类型不兼容"fixture 用 ssh.session.env 输入会失效 → 改为 `ssh.session.ssh → cmd.exec.cwd`（ssh→string 不兼容，语义不变）。
- 全量 verify 跑绿。
- 浏览器回归：ssh.session 卡片出现别名下拉（3 个真实别名）+ 选中后显示解析结果；dry-run 任务日志打印解析出的 host/user。
- **真实连通烟测**（无害只读）：临时 node 一行脚本用 resolveAlias + sshConnect 连 `vultr-tokyo` 执行 `echo ok`，验证 IdentityFile/端口链路端到端。
- git 提交。

## 不做 / 边界
- 不支持 Include / Match / ProxyJump / ProxyCommand（你的 config 用不到；解析器遇到会明确报错而非静默错连）。
- 不改其余远端节点、不动 prod 门禁（env.file 已不在，门禁现按工作流内 env 判断的路径保持原样）。
- `_attic/` 旧文件不迁移（永不加载）。
