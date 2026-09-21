#!/usr/bin/env bash
# =====================================================================
# Semaphore 项目配置脚本（在 WSL 内运行；install.sh 已装好并启动服务）
#   bash /mnt/c/Users/yatyr/workspace/devops/semaphore/configure.sh
#
# 通过 REST API 创建：
#   项目 devops → 仓库(本仓库本地路径) → Inventory(inventory/hosts.yml)
#   → Environment(注入 vault 密码) → 三个任务模板(deploy/rollback/audit)
#   → audit 每日 08:00 定时巡检
#
# 若 API 字段与你的 Semaphore 版本不匹配导致失败：按 README「GUI」一节的
# 说明在 UI 手工创建（同样的 3 个模板），本脚本只是省去那 5 分钟。
# =====================================================================
set -euo pipefail

BASE="${SEMAPHORE_URL:-http://127.0.0.1:3000}"
ADMIN_USER="${SEMAPHORE_ADMIN:-admin}"
ADMIN_PASS="${SEMAPHORE_ADMIN_PASS:-ChangeMe_123}"
REPO_LOCAL_PATH="${SEMAPHORE_REPO:-/mnt/c/Users/yatyr/workspace/devops}"
VAULT_PASS="$(cat ~/.vault-pass 2>/dev/null || echo '')"

JAR=/tmp/semaphore-cookie.txt
api() { # api METHOD PATH [JSON]
  local method=$1 path=$2 data=${3:-}
  if [ -n "$data" ]; then
    curl -sS -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' -X "$method" -d "$data" "$BASE$path"
  else
    curl -sS -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' -X "$method" "$BASE$path"
  fi
}

echo "== 登录 =="
api POST /api/auth/login "{\"auth\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}" >/dev/null

echo "== 项目 =="
PROJ=$(api GET /api/projects | jq -r '.[] | select(.name=="devops") | .id' | head -1)
if [ -z "$PROJ" ] || [ "$PROJ" = "null" ]; then
  PROJ=$(api POST /api/projects '{"name":"devops"}' | jq -r '.id')
  echo "已创建项目 devops (id=$PROJ)"
else
  echo "项目已存在 (id=$PROJ)"
fi

echo "== SSH Key（type=none：沿用 nef 用户的 ~/.ssh 与 ssh-agent）=="
KEY=$(api GET "/api/project/$PROJ/keys" | jq -r '.[] | select(.name=="local-nef") | .id' | head -1)
if [ -z "$KEY" ] || [ "$KEY" = "null" ]; then
  KEY=$(api POST "/api/project/$PROJ/keys" '{"name":"local-nef","type":"none"}' | jq -r '.id')
  echo "已创建 key (id=$KEY)"
fi

echo "== 仓库（本地路径直读，不走 git clone）=="
REPO=$(api GET "/api/project/$PROJ/repositories" | jq -r '.[] | select(.name=="devops") | .id' | head -1)
if [ -z "$REPO" ] || [ "$REPO" = "null" ]; then
  REPO=$(api POST "/api/project/$PROJ/repositories" \
    "{\"name\":\"devops\",\"git_url\":\"$REPO_LOCAL_PATH\",\"branch\":\"main\",\"ssh_key_id\":$KEY}" | jq -r '.id')
  echo "已创建仓库 (id=$REPO)"
fi

echo "== Inventory（文件型，指向仓库内 inventory/hosts.yml）=="
INV=$(api GET "/api/project/$PROJ/inventories?sort=name&order=asc" | jq -r '.[] | select(.name=="hosts") | .id' | head -1)
if [ -z "$INV" ] || [ "$INV" = "null" ]; then
  INV=$(api POST "/api/project/$PROJ/inventory" \
    "{\"name\":\"hosts\",\"project_id\":$PROJ,\"inventory\":\"inventory/hosts.yml\",\"key_id\":$KEY}" | jq -r '.id')
  echo "已创建 inventory (id=$INV)"
fi

echo "== Environment（注入 vault 密码；需先创建 ~/.vault-pass）=="
if [ -z "$VAULT_PASS" ]; then
  echo "!! 未找到 ~/.vault-pass —— 跳过 Environment 创建。"
  echo "   请创建后重跑本脚本，或在 UI 的 Environment 里手工填 {\"vault_password\":\"...\"}"
  ENV_ID=""
else
  ENV_ID=$(api GET "/api/project/$PROJ/environments" | jq -r '.[] | select(.name=="vault") | .id' | head -1)
  if [ -z "$ENV_ID" ] || [ "$ENV_ID" = "null" ]; then
    ENV_ID=$(api POST "/api/project/$PROJ/environments" \
      "{\"name\":\"vault\",\"project_id\":$PROJ,\"json\":\"{\\\"vault_password\\\":\\\"$VAULT_PASS\\\"}\"}" | jq -r '.id')
    echo "已创建 environment (id=$ENV_ID)"
  fi
fi

mk_template() { # mk_template NAME EXTRA_JSON_ARGS(形如 "\"-e\",\"site=kl\"")
  local name=$1 extra=${2:-}
  local exist tpls
  tpls=$(api GET "/api/project/$PROJ/templates")
  exist=$(echo "$tpls" | jq -r ".[] | select(.name==\"$name\") | .id" | head -1)
  if [ -n "$exist" ] && [ "$exist" != "null" ]; then
    echo "模板已存在: $name (id=$exist)"
    echo "$exist"
    return
  fi
  local body="{\"project_id\":$PROJ,\"name\":\"$name\",\"inventory_id\":$INV,\"repository_id\":$REPO,\"environment_id\":${ENV_ID:-null},\"allow_override_args_in_task\":true,\"argv\":[\"./ap\",\"$name.yml\"${extra:+,$extra}]}"
  api POST "/api/project/$PROJ/templates" "$body" | jq -r '.id'
}

echo "== 任务模板 =="
DEPLOY_ID=$(mk_template deploy '"-e","site=ls target=client env=test"' | tail -1)
ROLLBACK_ID=$(mk_template rollback '"-e","site=ls target=client release=previous"' | tail -1)
AUDIT_ID=$(mk_template audit '' | tail -1)
echo "deploy=$DEPLOY_ID rollback=$ROLLBACK_ID audit=$AUDIT_ID"

echo "== audit 每日 08:00 定时 =="
if [ -n "$AUDIT_ID" ] && [ "$AUDIT_ID" != "null" ]; then
  EXIST_SCHED=$(api GET "/api/project/$PROJ/schedules" | jq -r ".[] | select(.template_id==$AUDIT_ID) | .id" | head -1)
  if [ -z "$EXIST_SCHED" ] || [ "$EXIST_SCHED" = "null" ]; then
    api POST "/api/project/$PROJ/schedules" \
      "{\"project_id\":$PROJ,\"template_id\":$AUDIT_ID,\"name\":\"daily audit\",\"cron_format\":\"0 8 * * *\"}" >/dev/null \
      && echo "已创建定时巡检" \
      || echo "!! 定时创建失败（版本差异）——请在 UI: Task Templates → audit → Schedule 手工添加"
  else
    echo "定时巡检已存在"
  fi
fi

echo ""
echo "完成。浏览器访问 $BASE （Task Templates 里可改参数后运行）"
