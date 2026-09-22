# 工作流配置（workflows/*.json）

部署逻辑的配置驱动形式：一个应用 = 一份 JSON（`workflows/<name>.json`），每个任务 = 一个**线性步骤数组**（无 DAG）。
GUI 右上角「＋ 新建工作流」可选 SPA 预设或空白工作流；「✎ 编辑工作流」是卡片式类型插槽编辑器（可切原始 JSON）。
完整示例见 [`workflows/spa.example.json`](../workflows/spa.example.json) 与三个迁移应用（`kids-ledger.json`、`xlgbis-ls.json`、`xlgbis-bs.json`）。

## 应用结构

```jsonc
{
  "name": "my-site",              // 必填，唯一标识（字母数字 . _ -），文件名建议同名
  "title": "官网 SPA",            // 可选，GUI 显示名
  "description": "...",           // 可选
  "repoDir": "C:/workspace/my-site", // 必填，应用仓库（可被 local-config.json 的 repos.<name> 覆盖）
  "envFile": "my-site.env",      // 必填，envs/ 下的 env 文件（gitignored）
  "envSchema": { ... },          // 可选，缺省为部署基础五键；值即类型样例（字符串/数字/布尔 → 推导产出物类型）
  "params": { "buildCommand": "pnpm build", ... }, // 可选，应用级参数（文本），步骤里用 {{buildCommand}} 引用
  "workflows": {
    "<task>": { "steps": [ ... ], "mutates": true },  // mutates 缺省 true；status 类设 false（免 prod 门禁）
    "<task>": [ ... ]                                  // 裸数组等价于 { steps: [...], mutates: true }
  }
}
```

## 类型化数据流

每个步骤声明带类型的**产出物**，每个参数是带类型的**输入槽**。后面的步骤用 `{{名字}}` 引用更早步骤的产出物（线性顺序，不能引用后面的步骤）。

**类型集**：`string` 文本、`bash` 命令串、`path` 本机路径、`remote_path` 服务器路径、`number`、`bool`、`list`、`map`。

**整值引用**（值就是一个 `{{name}}`）兼容表：

| 槽位类型 | 可引用的产出物类型 |
|---|---|
| string | string, number, bool |
| number / bool | 同类型 |
| path | path |
| remote_path | remote_path |
| **bash** | string, number, bool, **path, remote_path**（命令里拼路径是合法需求） |
| list / map | 同类型 |

**字面量内嵌引用**（文本里嵌 `{{name}}`）：字面量整体取槽位类型；`string` 槽最严——path/remote_path/map/list **不能**嵌入文本（这就是"文件不能当字符串入参"）；`bash`/`path`/`remote_path`/`list` 槽允许嵌 string/number/bool/path/remote_path。

**校验时机**：GUI 引用下拉只列类型兼容项（错误选不出来）；保存时服务端编译器全量复核（防手打 JSON 绕过），报错指名步骤和变量，例如：

```
workflows/deploy.steps[2](env.write): 参数 pairs.VITE_VERSION: 嵌入 {{archivePath}}（path，来自步骤[5] archive）类型不兼容——string 槽位只接受 string/number/bool
```

未定义引用、在产出步骤之前引用（前向引用）同样在编译期被拦截。

## 步骤类型（9 种原子能力）

> 权威来源是引擎本体：`GET /api/step-types` 返回与下表一致的元数据。

| type | 产出物 | 参数 |
|---|---|---|
| `git.checkout` 选择 revision | `versionId(string)`、`buildTime(string)`、`releaseName(string)` | `ref(string)`：分支/tag，空 = HEAD；之后的步骤都跑在该 revision 上，结束自动恢复原分支 |
| `env.write` 写 env 文件 | — | `file(path)`、`pairs(map)`：构建前写 .env（LF），值按文本槽校验 |
| `shell` 本地命令 | — | `command(bash)`、`cwd(path)`、`title(string)` |
| `archive` 打包 | `archivePath(path)`、`archiveName(string)` | `source(path)` 整目录为包根，或 `entries(list)` + `excludes(list)`（按路径段排除，node_modules 命中任意层级） |
| `upload` 上传 | `uploadedTo(remote_path)` | `from(path)`、`to(remote_path)` |
| `remote` 远端命令 | — | `command(bash)`、`sudo(bool)`：加 `sudo -n`（需 NOPASSWD） |
| `template.push` 推送模板 | `uploadedTo(remote_path)` | `template(path)`、`to(remote_path)`、`vars(map)` 缺省用整个作用域 |
| `vars.set` 声明产出物 | 每对 key 一个产出 | `pairs(map)`、`types(map)`：声明名字→类型（string/number/bool/path/remote_path） |
| `log` 日志标注 | — | `message(string)` |

产出物作用域还包括：`app`(string)、`repoDir`(path)、`ref`/`release`(string，任务选项)、params（文本）、env 变量（类型由 envSchema 样例推导）。

### 特性说明

- **dry-run**：所有步骤只打印将要执行的命令（含 template.push 渲染结果），**绝不建立 SSH 连接**。git.checkout 例外——仍会真实 checkout 并恢复（只读仓库，用于算出真实版本号）。
- **SSH**：连接参数全部来自 env（REMOTE_HOST/REMOTE_USER/REMOTE_HOST_FINGERPRINT，可选 REMOTE_KEY_FILE），首个远端步骤时惰性连接，整任务复用，结束关闭；主机指纹 SHA256 锁定。
- **template.push**：模板随**应用仓库**做版本管理；`./` 前缀 = 相对工作流配置目录。写入 `/etc` 等受限路径时后接 `remote` + sudo 步骤 `install -m 644 ...`（见各应用 apply-config）。dry-run 会打印渲染后的内容（含敏感值——frp_token 等机密模板在 dry-run 时注意日志保密）。
- **`{{release}}` 守卫**：任务里引用 `{{release}}` 时必须传 release 参数（GUI 回滚弹窗 / 引用 `{{release}}` 的任务），空值在编译期语义检查直接拒绝，防空路径上远端。

## 三个迁移应用的远端布局

- kids-ledger：`$DEPLOY_DIR/{releases/<name>/, current→releases/<x>, state/{data,config.json}, build/, ops/}`；nginx 反代 `127.0.0.1:APP_PORT`（systemd 服务）。
- xlgbis：`client-release/<name>/` + `client` 软链（静态站，nginx reload 生效）；`server-release/<name>/<serverDir>/` + `server` 软链（systemd 服务，stop → 切链 → restart → 端口探活）。
- 已知语义差异（相对旧 Ansible）：rescue 失败自动回滚块未做——失败即停，切链前的失败不影响现网，切链后用 rollback 手动恢复；健康检查以远端 bash 重试循环表达。
