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
npm ci --omit=dev --silent 2>/dev/null || true
systemctl restart tq-archive
sleep 1
curl -fsS "http://127.0.0.1:${PORT:-4173}/api/state" > /dev/null && echo "已重启，服务正常" || echo "警告：服务未通过健康检查，请查看 journalctl -u tq-archive"
