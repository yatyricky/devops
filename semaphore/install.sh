#!/usr/bin/env bash
# =====================================================================
# Semaphore UI 安装脚本（在 WSL Ubuntu 内以 root 运行）
#   bash /mnt/c/Users/yatyr/workspace/devops/semaphore/install.sh
#
# 安装内容：
#   /usr/local/bin/semaphore          单二进制
#   /etc/semaphore/config.json        配置（BoltDB，无需数据库）
#   /etc/systemd/system/semaphore.service   以 nef 用户运行（复用其 ansible/pnpm/ssh 环境）
#   初始管理员：admin / ChangeMe_123（首次登录后立即在 UI 改密）
# =====================================================================
set -euo pipefail

RUN_USER="${SEMAPHORE_USER:-nef}"
INSTALL_DIR=/usr/local/bin
CONF_DIR=/etc/semaphore
DATA_DIR=/var/lib/semaphore
PORT="${SEMAPHORE_PORT:-3000}"

echo "== 1/5 下载 Semaphore 二进制 =="
if command -v semaphore >/dev/null 2>&1 && semaphore version >/dev/null 2>&1; then
  echo "已安装：$(semaphore version 2>/dev/null | head -1)，跳过下载"
else
  ARCH=linux_amd64
  VER=$(curl -fsSL --max-time 30 https://api.github.com/repos/semaphoreui/semaphore/releases/latest | jq -r '.tag_name')
  echo "最新版本：$VER"
  URL="https://github.com/semaphoreui/semaphore/releases/download/${VER}/semaphore_${VER#v}_${ARCH}.tar.gz"
  cd /tmp
  curl -fSL --retry 2 -o semaphore.tar.gz "$URL" \
    || curl -fSL --retry 2 -o semaphore.tar.gz "https://ghproxy.net/$URL" \
    || { echo "下载失败：请检查网络/代理后重试"; exit 1; }
  tar -xzf semaphore.tar.gz semaphore
  install -m 0755 semaphore "$INSTALL_DIR/semaphore"
  rm -f semaphore semaphore.tar.gz
fi

echo "== 2/5 目录与配置 =="
mkdir -p "$CONF_DIR" "$DATA_DIR"
chown "$RUN_USER:$RUN_USER" "$DATA_DIR"

if [ ! -f "$CONF_DIR/config.json" ]; then
  # v2.19 配置格式：bolt 已废弃（改 SQLite）；会话密钥键名为 cookie_hash/cookie_encryption；
  # cookie_encryption 必须精确 16/24/32 字节（这里用 32 字符随机串），否则报 crypto/aes: invalid key size
  rand() { tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c "$1"; }
  HASH_KEY=$(rand 64)
  ENC_KEY=$(rand 32)
  cat > "$CONF_DIR/config.json" <<EOF
{
  "dialect": "sqlite",
  "port": "$PORT",
  "interface": "0.0.0.0",
  "tmp_path": "/tmp/semaphore",
  "git_client": "cmd_git",
  "cookie_hash": "$HASH_KEY",
  "cookie_encryption": "$ENC_KEY"
}
EOF
  chown "$RUN_USER:$RUN_USER" "$CONF_DIR/config.json"
  chmod 0640 "$CONF_DIR/config.json"
else
  echo "配置已存在，跳过（如需重置：rm $CONF_DIR/config.json）"
fi

echo "== 3/5 systemd 服务 =="
cat > /etc/systemd/system/semaphore.service <<EOF
[Unit]
Description=Semaphore UI (Ansible web console)
After=network.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$DATA_DIR
ExecStart=$INSTALL_DIR/semaphore server --config $CONF_DIR/config.json
Restart=on-failure
RestartSec=5
# 任务执行器需要 nef 的 PATH（ansible 在 ~/.local/bin）
Environment=PATH=/home/$RUN_USER/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now semaphore
sleep 2
systemctl --no-pager --lines=5 status semaphore || true

echo "== 4/5 初始管理员 =="
ADMIN_LOGIN=admin
ADMIN_PASS=ChangeMe_123
if sudo -u "$RUN_USER" bash -c "cd $DATA_DIR && $INSTALL_DIR/semaphore --config $CONF_DIR/config.json user list 2>/dev/null | grep -q admin"; then
  echo "管理员 admin 已存在，跳过"
else
  sudo -u "$RUN_USER" bash -c "cd $DATA_DIR && $INSTALL_DIR/semaphore --config $CONF_DIR/config.json user add --admin \
    --login $ADMIN_LOGIN --name Administrator --email admin@localhost --password '$ADMIN_PASS'"
  echo "已创建管理员：$ADMIN_LOGIN / $ADMIN_PASS（请尽快在 UI 修改密码）"
fi

echo "== 5/5 完成 =="
echo "浏览器访问: http://localhost:$PORT  （Windows 侧经 WSL localhost 转发）"
echo "下一步: 运行 semaphore/configure.sh 或按 README 在 UI 里建项目"
