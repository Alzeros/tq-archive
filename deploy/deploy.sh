#!/usr/bin/env bash
# 服务器端拉取新代码并重启服务。数据目录不在 Git 中，不会被覆盖。
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tq-archive}"
BRANCH="${BRANCH:-main}"
cd "$APP_DIR"

git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [ "$LOCAL" = "$REMOTE" ]; then
  echo "代码已是最新 ($LOCAL)"
  exit 0
fi

git merge --ff-only "origin/$BRANCH"
# 本项目零运行时依赖，lockfile 仅用于让 npm ci 可用；缺失时退化为 npm install。
if [ -f package-lock.json ]; then
  npm ci --omit=dev --silent
else
  echo "无 package-lock.json，改用 npm install"
  npm install --omit=dev --no-audit --no-fund --silent
fi
systemctl restart tq-archive
# 服务启动后立刻探测可能过早，systemd 重启到监听成功通常需要 1-2 秒。
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -fsS "http://127.0.0.1:${PORT:-4173}/api/state" > /dev/null 2>&1; then
    echo "已重启，服务正常"
    exit 0
  fi
done
echo "警告：服务未通过健康检查，请查看 journalctl -u tq-archive"
systemctl status tq-archive --no-pager --lines=20 || true
exit 1
