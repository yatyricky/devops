#!/usr/bin/env bash
# =====================================================================
# Semaphore 项目配置脚本（在 WSL 内运行；install.sh 已装好并启动服务）
#   bash /mnt/c/Users/yatyr/workspace/devops/semaphore/configure.sh
#
# 通过 REST API 创建（字段形状已按 Semaphore v2.19.12 实测校验）：
#   项目 devops → Key(type=none，沿用 nef 的 ~/.ssh) → 仓库(本地路径直读)
#   → Inventory(file: inventory/hosts.yml) → Environment(vault 密码 + ANSIBLE_CONFIG 注入)
#   → 三个任务模板(deploy/rollback/audit) → audit 每日 08:00 定时巡检
#
# 若日后 Semaphore API 变化导致失败：按 README「GUI」一节在 UI 手工创建。
# =====================================================================
set -euo pipefail

BASE="${SEMAPHORE_URL:-http://127.0.0.1:3000}"
ADMIN_USER="${SEMAPHORE_ADMIN:-admin}"
ADMIN_PASS="${SEMAPHORE_ADMIN_PASS:-ChangeMe_123}"
REPO_LOCAL_PATH="${SEMAPHORE_REPO:-/mnt/c/Users/yatyr/workspace/devops}"
VAULT_PASS="$(cat ~/.vault-pass 2>/dev/null || true)"

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
  KEY=$(api POST "/api/project/$PROJ/keys" "{\"project_id\":$PROJ,\"name\":\"local-nef\",\"type\":\"none\"}" | jq -r '.id')
  echo "已创建 key (id=$KEY)"
fi

echo "== 仓库（本地路径直读，不走 git clone）=="
REPO=$(api GET "/api/project/$PROJ/repositories" | jq -r '.[] | select(.name=="devops") | .id' | head -1)
if [ -z "$REPO" ] || [ "$REPO" = "null" ]; then
  REPO=$(api POST "/api/project/$PROJ/repositories" \
    "{\"project_id\":$PROJ,\"name\":\"devops\",\"git_url\":\"$REPO_LOCAL_PATH\",\"git_branch\":\"main\",\"ssh_key_id\":$KEY}" | jq -r '.id')
  echo "已创建仓库 (id=$REPO)"
fi

echo "== Inventory（file 型，指向仓库内 inventory/hosts.yml）=="
INV=$(api GET "/api/project/$PROJ/inventory" | jq -r '.[] | select(.name=="hosts") | .id' | head -1)
if [ -z "$INV" ] || [ "$INV" = "null" ]; then
  INV=$(api POST "/api/project/$PROJ/inventory" \
    "{\"project_id\":$PROJ,\"name\":\"hosts\",\"type\":\"file\",\"inventory\":\"inventory/hosts.yml\"}" | jq -r '.id')
  echo "已创建 inventory (id=$INV)"
fi

echo "== Environment（vault 密码 + ANSIBLE_CONFIG/PATH 注入任务进程）=="
ENV_JSON="{\"vault_password\":\"${VAULT_PASS:-CHANGE_ME}\"}"
ENV_VARS="{\"ANSIBLE_CONFIG\":\"$REPO_LOCAL_PATH/ansible.cfg\",\"PATH\":\"/home/nef/.local/bin:/usr/local/bin:/usr/bin:/bin\"}"
if [ -z "$VAULT_PASS" ]; then
  echo "!! 未找到 ~/.vault-pass —— Environment 里的 vault_password 为占位值，vault 加密变量将不可用"
fi
ENV_ID=$(api GET "/api/project/$PROJ/environment" | jq -r '.[] | select(.name=="vault") | .id' | head -1)
if [ -z "$ENV_ID" ] || [ "$ENV_ID" = "null" ]; then
  ENV_ID=$(api POST "/api/project/$PROJ/environment" \
    "{\"project_id\":$PROJ,\"name\":\"vault\",\"json\":$(jq -cn --arg j "$ENV_JSON" '$j'),\"env\":$(jq -cn --arg e "$ENV_VARS" '$e')}" | jq -r '.id')
  echo "已创建 environment (id=$ENV_ID)"
else
  api PUT "/api/project/$PROJ/environment/$ENV_ID" \
    "{\"id\":$ENV_ID,\"project_id\":$PROJ,\"name\":\"vault\",\"json\":$(jq -cn --arg j "$ENV_JSON" '$j'),\"env\":$(jq -cn --arg e "$ENV_VARS" '$e')}" >/dev/null
  echo "已更新 environment (id=$ENV_ID)"
fi

# v2.19 实测要点：app 必须是白名单值（ansible）；arguments 是 *string（JSON 数组序列化成字符串）
mk_template() { # mk_template NAME EXTRA_ARGS_JSON_ARRAY_BODY(形如 "-e","site=kl")
  local name=$1 extra=${2:-}
  local args
  if [ -n "$extra" ]; then args="[$extra]"; else args="[]"; fi
  local exist
  exist=$(api GET "/api/project/$PROJ/templates" | jq -r ".[] | select(.name==\"$name\") | .id" | head -1)
  if [ -n "$exist" ] && [ "$exist" != "null" ]; then
    echo "模板已存在: $name (id=$exist)"
    echo "$exist"
    return
  fi
  local body
  body=$(jq -cn --argjson pid "$PROJ" --argjson inv "$INV" --argjson repo "$REPO" --argjson envs "[$ENV_ID]" \
    --arg name "$name" --arg pb "$name.yml" --arg args "$args" \
    '{project_id:$pid, name:$name, inventory_id:$inv, repository_id:$repo, environment_ids:$envs,
      allow_override_args_in_task:true, app:"ansible", playbook:$pb, arguments:$args}')
  api POST "/api/project/$PROJ/templates" "$body" | jq -r '.id'
}

echo "== 任务模板 =="
DEPLOY_ID=$(mk_template deploy '"-e","site=ls target=client env=test"' | tail -1)
ROLLBACK_ID=$(mk_template rollback '"-e","site=ls target=client release=previous"' | tail -1)
AUDIT_ID=$(mk_template audit '[]' | tail -1)
echo "deploy=$DEPLOY_ID rollback=$ROLLBACK_ID audit=$AUDIT_ID"

echo "== audit 每日 08:00 定时 =="
if [ -n "$AUDIT_ID" ] && [ "$AUDIT_ID" != "null" ]; then
  EXIST_SCHED=$(api GET "/api/project/$PROJ/schedules" | jq -r ".[] | select(.template_id==$AUDIT_ID) | .id" | head -1)
  if [ -z "$EXIST_SCHED" ] || [ "$EXIST_SCHED" = "null" ]; then
    SCHED_BODY=$(jq -cn --argjson pid "$PROJ" --argjson tid "$AUDIT_ID" \
      '{project_id:$pid, template_id:$tid, name:"daily audit", cron_format:"0 8 * * *"}')
    if api POST "/api/project/$PROJ/schedules" "$SCHED_BODY" | jq -e . >/dev/null 2>&1; then
      echo "已创建定时巡检（每日 08:00）"
    else
      echo "!! 定时创建失败（版本差异）——请在 UI: Task Templates → audit → Schedule 手工添加"
    fi
  else
    echo "定时巡检已存在"
  fi
fi

echo ""
echo "完成。浏览器访问 $BASE（admin / ChangeMe_123，请尽快改密）"
echo "Task Templates 里三个模板运行前可在参数框临时改 -e 参数（如 force=yes / site=bs）"
