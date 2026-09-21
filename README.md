# devops — xlgbis / kids-ledger 统一运维仓库（Ansible + Semaphore UI）

用一套标准化工具替代原 xlgbis `devops/*.js` 自研脚本与 kids-ledger `deploy.ps1`，覆盖：

| 功能 | 旧实现（xlgbis） | 旧实现（kids-ledger） | 本仓库 |
|---|---|---|---|
| 服务器状态审计 | `ls_ops/bs_ops --audit` | 无 | `audit.yml`（检查项 1:1 移植 + Semaphore 定时巡检） |
| 状态一览 | `ls_ops/bs_ops --status` | 无 | `status.yml` |
| 前端 构建+打包+部署+回滚 | `deploy_client.js/sh` | 无（dist 随包） | `deploy.yml -e target=client` / `rollback.yml` |
| 服务端 打包+部署+安装+回滚 | `deploy_server.js/sh` | `deploy.ps1`（覆盖式，无回滚） | `deploy.yml -e target=server` / `site=kl` / `rollback.yml` |
| nginx/frp/systemd 配置下发 | `--apply-config` + apply 脚本 | 手工 | `apply-config.yml`（幂等模板渲染） |
| 新服务器初始化 | 已删除的 install_ls/bs | 手工 | `provision.yml`（分段开关） |
| GUI | 无 | 无 | Semaphore UI（http://localhost:3000） |

相比旧脚本的新增能力：**部署后健康检查 + 失败自动回滚**、**旧 release 自动清理（保留最近 5 份）**、**密钥全部走 ansible-vault**、**prod 环境强制 `-e force=yes` 门槛**、**修复 `bs_apply_config.sh` nginx -t 失败不真恢复 / `|| true` 吞错的缺陷**。

两个项目仓库**不被本工具修改**：源码从 `/mnt/c/Users/yatyr/workspace/{xlgbis,kids-ledger}` 只读拷贝到 WSL 临时目录构建；配置模板已平移到本仓库成为唯一事实源。

---

## 目录结构

```
devops/
├── ansible.cfg               # host_key_checking=True（保留指纹校验策略）
├── deploy.yml                # 统一部署入口（构建在 WSL，发布到服务器）
├── rollback.yml              # 回滚入口
├── audit.yml                 # 只读审计巡检
├── status.yml                # 服务状态 + 当前版本一览
├── apply-config.yml          # nginx/frp/systemd 配置下发
├── provision.yml             # 新服务器初始化（分段开关）
├── inventory/
│   ├── hosts.yml             # ★ 主机清单（占位，填真实值）
│   └── group_vars/
│       ├── all/vars.yml      # 源码路径、release 保留数等全局参数
│       ├── all/vault.example.yml  # ★ 密钥模板（复制为 vault.yml 并加密）
│       ├── ls.yml / bs.yml / kl.yml  # 站点参数（对应原 env schema）
├── roles/audit/              # 审计检查项（原 ops_common.js）
├── tasks/
│   ├── build/                # 控制机构建：版本号 / 前端 / 服务端 / kids-ledger
│   ├── deploy/               # 服务器发布：解压校验 → 装依赖 → 切链 → 健康检查 → 自动回滚 → 清理
│   ├── rollback/             # 回滚
│   └── config/               # apply-config 的三个站点任务
├── templates/                # nginx 站点 / systemd unit / frp toml / 运行时 .env（Jinja2）
├── files/ls/                 # 503 页面与静态 unit
└── semaphore/                # Semaphore UI 安装与配置脚本
```

---

## 接入步骤（一次性）

以下命令均在 **WSL（Ubuntu-24.04）** 内、本仓库根目录执行（`cd /mnt/c/Users/yatyr/workspace/devops`）。

### 1. 填主机清单 `inventory/hosts.yml`

把占位主机（`ls-test` / `bs-prod` / `kl-prod`…）的注释值填实。每组变量：

- `ansible_host` / `ansible_user`：SSH 地址与用户（须具备 NOPASSWD sudo，同旧体系）
- `xlgbis_env: test|prod`：环境标识（对应旧 `SERVER_TYPE`）
- `deploy_dir`：旧 `DEPLOY_DIR`（如 `/opt/xlgbis-biz`）
- bs 主机额外需要 `bsi`（frp 子域名 + JWT 字段）
- kl 主机：`kl_deploy_dir`（默认 `/opt/kids-ledger`）、可选 `kl_domain`

### 2. 站点参数 `inventory/group_vars/{ls,bs,kl}.yml`

已按旧 env schema 预填示例值（`domain.com` 等），改成真实值即可；键名与旧 env 键一一对应（有注释）。

### 3. 初始化 vault（密钥）

```bash
cp inventory/group_vars/all/vault.example.yml inventory/group_vars/all/vault.yml
vi inventory/group_vars/all/vault.yml      # 填真实值：frp token、JWT_SECRET、QYWX_SECRET、DB_URL、kl tokens
ansible-vault encrypt inventory/group_vars/all/vault.yml
echo '你的vault密码' > ~/.vault-pass && chmod 600 ~/.vault-pass   # ansible.cfg 已指向它
```

`vault.yml` 已被 .gitignore 排除；所有密钥不再出现在任何脚本/模板/制品的明文日志里（下发均 `no_log` 或 0600 落盘）。

### 4. SSH 密钥与指纹

```bash
# WSL 内生成专用部署密钥（或复制现有私钥），并把公钥追加到各服务器 authorized_keys
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ''
# 首次连接导入主机指纹（host_key_checking=True 拒绝未知主机，与旧体系 TOFU+指纹 pin 一致）
ssh <ansible_user>@<host> true
```

### 5. 验证连通

```bash
ansible all -m ping            # 全部主机
ansible bs-test -m ping        # 单台
```

---

## 日常使用

### CLI（WSL 内）

> **重要**：仓库在 `/mnt/c`（WSL 视角为世界可写目录），ansible 会忽略 `./ansible.cfg`。
> 请始终使用包装器 `./ap`（它通过 `ANSIBLE_CONFIG` 显式指定配置）；ad-hoc 命令手动
> `export ANSIBLE_CONFIG=/mnt/c/Users/yatyr/workspace/devops/ansible.cfg`。

```bash
# 审计（只读；FAIL 项会导致非零退出）
./ap audit.yml [-l ls-test]

# 状态一览
./ap status.yml

# 部署（env 缺省 test；prod 必须 -e force=yes）
./ap deploy.yml -e "site=ls target=client env=test"
./ap deploy.yml -e "site=ls target=server env=test"
./ap deploy.yml -e "site=bs target=client env=test"
./ap deploy.yml -e "site=bs target=server env=test"
./ap deploy.yml -e "site=kl"

# 回滚（previous = 按时间排序的上一版；或指定完整 release 名，用 status.yml 查）
./ap rollback.yml -e "site=bs target=server release=previous"
./ap rollback.yml -e "site=kl release=previous"

# 配置下发（改了 templates/ 后；prod 需 -e force=yes）
./ap apply-config.yml -l bs-test

# 新服务器初始化（见文件头注释的分段开关）
./ap provision.yml -l bs-test

# 连通性（ad-hoc）
export ANSIBLE_CONFIG=$PWD/ansible.cfg
ansible all -m ping
```

版本号规则与旧脚本一致：`{ref}-{git 短 hash}[-dirty]-{UTC 时间戳}`，取自**项目工作区当前 HEAD**——本工具不做 `git checkout`（避免动你的工作区）；要部署其他 ref，先在项目仓库自行 checkout。

### GUI（Semaphore UI，http://localhost:3000）

```bash
# 安装（WSL 内 root）：
bash semaphore/install.sh
# 建项目/环境/三个任务模板（管理员 admin/ChangeMe_123，装完先改密）：
bash semaphore/configure.sh
```

UI 里预置三个任务模板：**deploy**（参数 site/target/env）、**rollback**（参数 release）、**audit**（挂每日 08:00 定时巡检，FAIL 会在 UI 标红）。运行前可在 UI 临时改参数（如 `force=yes`）。

---

## 服务器目录布局（与旧脚本兼容，可随时切回手工）

```
$DEPLOY_DIR/                     # xlgbis ls/bs
├── client -> client-release/<release>   # 前端当前版（nginx root）
├── client-build/                # 上传/解压临时区（用后即清）
├── client-release/<release>/    # 历史版本（自动只保留最近 5 份）
├── server -> server-release/<release>/<server_dir>   # 服务端当前版（systemd WorkingDirectory）
├── server-build/
└── server-release/<release>/{login-server|biz-server}/,packages/

/opt/kids-ledger/                # kids-ledger（新布局）
├── current -> releases/<release>
├── releases/<release>/          # dist+server+shared+start.sh；内含 data → shared/data 软链
└── shared/data/ledger.db        # SQLite 数据在 release 之外，升级/回滚不丢数据
```

---

## 真机验收清单（接入后逐项执行）

1. **审计对齐**：`ansible-playbook audit.yml`，对照旧 `ls_ops/bs_ops --audit` 输出——检查项一致、结论一致、无误报。
2. **状态对齐**：`ansible-playbook status.yml`，与旧 `--status` 显示的 服务 active + 当前 release 一致。
3. **客户端部署（无行为变化）**：`deploy.yml -e "site=ls target=client env=test"`——服务器多出一个新 release、`client` 链接切换、nginx reload、健康检查 200。
4. **服务端部署（无行为变化）**：`deploy.yml -e "site=ls target=server env=test"`——pnpm install 完成、`server` 链接切换、服务重启后 active、`/api/healthz` 200（biz 用端口探活）。
5. **回滚演练**：`rollback.yml -e "site=ls target=server release=previous"`——切回旧 release、服务 active、健康检查通过。
6. **切回最新**：再次执行第 4 步。
7. **配置幂等**：`apply-config.yml -l <host> --check --diff`（或跑两遍）——第二遍应全部 `changed=0` 或仅时间戳类变化；`nginx -t` 通过。
8. **kids-ledger**：`deploy.yml -e "site=kl"` → `rollback.yml -e "site=kl release=previous"` → 再部署；确认 `shared/data/ledger.db` 在回滚后仍在且应用可登录。
9. **Semaphore**：UI 里把 3/4/5 步各点一遍，确认输出与 CLI 一致；看 audit 定时任务次日是否产生历史记录。

---

## 与旧体系的差异说明

- **prod 门槛**：旧 `refuseProdCi`（CI 禁 prod）→ `xlgbis_env=prod` 的部署/配置下发必须 `-e force=yes`。
- **健康检查**：旧脚本部署完只 `systemctl status` 打印 → 现在 uri/wait_for 实测，失败**自动切回上一版**再报错。
- **release 清理**：旧脚本从不清理 → 自动保留最近 `release_keep`（默认 5）份。
- **.env 处理**：旧 `deploy_server.sh` 把完整 env 明文写进渲染脚本落盘 → 现在 `.env` 直接以 0600 写入 release，制品 tarball 以外不落明文（tarball 传输后即删，与旧一致）。
- **kids-ledger**：由"覆盖解压 + 手工收尾"升级为 release + 回滚；`config.json` 从 vault 渲染（不再打包 `config.example.json` 弱默认口令）；`data/` 移出 release（`shared/data`），升级回滚不丢账目数据；nginx/systemd 配置纳入 `apply-config.yml`。
- **frpc.service 模板**：原文件硬编码 `User=frp`，现改为 `frp_user` 变量（修复配置漂移）；`ls_apply_config.sh` 硬编码 `opfrp` 的历史问题同样收敛到变量。
- **不做的事**：不动两个项目仓库的任何文件；不跑 `prisma db push`（数据库 schema 仍由你在开发机手工执行）；不管理 Let's Encrypt 泛域名证书签发（需 DNS 验证，见 provision.yml 尾部提示）。

## 已知注意事项

- **同组多台同环境主机**：构建任务 `run_once` 取 inventory 中第一台匹配主机触发；同组同 env 多台时部署会串行下发同一制品（行为正确，只是构建只跑一次）。
- **服务器 node/pnpm**：`deploy_server` 的 `pnpm install` 通过 `bash -l` 执行，兼容旧服务器 nvm 安装的 node；新服务器建议用 `provision.yml`（装到 `/usr/local/bin`，与 systemd unit 的路径一致）。
- **WSL 网络**：WSL 处于 NAT 模式且 Windows 配了本地代理时，代理不会自动镜像进 WSL；若 pnpm/npm 下载慢，可在 WSL 内自行设置代理或换镜像（构建临时目录用完即删，不影响项目仓库）。
- **首次部署到全新目录**：`client-build`/`server-build` 等目录会自动创建；但 nginx 站点、systemd unit、frp 依赖 `apply-config.yml` 与 `provision.yml` 先行。
