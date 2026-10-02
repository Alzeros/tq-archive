#!/usr/bin/env bash
# 服务器端拉取新代码并重启服务。数据目录不在 Git 中，不会被覆盖。
#
# 必须以 root 运行（systemctl restart 需要提权）：
#   sudo bash /opt/tq-archive/deploy/deploy.sh
#
# 脚本内部会把 git / npm 降权到服务账号执行，
# 避免在 APP_DIR 里生成 root 属主的文件，导致 tq 用户后续读写失败。
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tq-archive}"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-tq-archive}"
PORT="${PORT:-4173}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请以 root 运行：sudo bash $0" >&2
  exit 1
fi

# 服务账号：文件属主必须是它，否则 systemd 以该用户启动时会读写失败。
RUN_USER="${RUN_USER:-tq}"
if ! id "$RUN_USER" > /dev/null 2>&1; then
  echo "服务账号 $RUN_USER 不存在" >&2
  exit 1
fi

cd "$APP_DIR"
# 以服务账号执行 git/npm。若当前就是该账号则直接执行，避免 sudo 权限配置问题。
as_service() {
  if [ "$(id -un)" = "$RUN_USER" ]; then
    "$@"
  else
    sudo -u "$RUN_USER" "$@"
  fi
}

# git 安全目录：仓库归 tq 所有，但 root 读取时 git 会拒绝（dubious ownership）
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

as_service git fetch --quiet origin "$BRANCH"
LOCAL="$(as_service git rev-parse HEAD)"
REMOTE="$(as_service git rev-parse "origin/$BRANCH")"
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "代码已是最新 ($LOCAL)"
  exit 0
fi

as_service git merge --ff-only "origin/$BRANCH"
# 本项目零运行时依赖，lockfile 仅用于让 npm ci 可用；缺失时退化为 npm install。
if [ -f package-lock.json ]; then
  as_service npm ci --omit=dev --silent
else
  echo "无 package-lock.json，改用 npm install"
  as_service npm install --omit=dev --no-audit --no-fund --silent
fi

# 到这里才提权重启：前面的文件操作都已以服务账号完成
systemctl restart "$SERVICE"

# 服务启动后立刻探测可能过早，systemd 重启到监听成功通常需要 1-2 秒。
for attempt in $(seq 1 10); do
  sleep 1
  if curl -fsS "http://127.0.0.1:${PORT}/api/state" > /dev/null 2>&1; then
    echo "已重启，服务正常"
    exit 0
  fi
done

echo "警告：服务未通过健康检查，请查看 journalctl -u $SERVICE" >&2
systemctl status "$SERVICE" --no-pager --lines=20 || true
exit 1
