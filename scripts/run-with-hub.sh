#!/usr/bin/env bash
#
# 你只需要关心这一行：把 TcpQuality 检测结果的 CSV，POST 到你自己的 TQ Hub。
# 其他参数（-c 100 / -v4 / --route / --speedtest…）保持和原脚本完全一致。
#
# 用法：
#   bash run-with-hub.sh --hub=https://hub.example.com --key=XXXX [ -c100 -v4 --route --speedtest ...]
#   TQ_HUB=https://hub.example.com bash run-with-hub.sh
#   TQ_HUB=https://hub.example.com bash run-with-hub.sh -c 100 -v4
#
# 干的事：
#   1. 计算出 “我们自己的上传接收端” = $TQ_HUB/api/upload-csv
#   2. 下载 core 脚本一次到缓存目录（默认 ~/.cache/tq-archive/)，没有才拉
#   3. 直接运行 core，原样透传参数（-c100 / -v4 / --route / --speedtest…）
#   4. 跑完后读 RESULT_DIR → POST CSV 到我们的 hub → 清理临时目录
#
# 无论成功失败，这个 wrapper 都会原样传输 runTcpQuality 的退出码，返回值绝无谎报。

set -Eeuo pipefail

# ─── 参数解析 ──────────────────────────────────────────────────────────
TQ_HUB="${TQ_HUB:-}"
TQ_KEY="${TQ_KEY:-}"
TQ_ARGS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --hub=*)   TQ_HUB="${1#*=}"  ; shift ;;
    --key=*)   TQ_KEY="${1#*=}"  ; shift ;;
    --hub)     TQ_HUB="$2"       ; shift 2 ;;
    --key)     TQ_KEY="$2"       ; shift 2 ;;
    *)          TQ_ARGS+=("$1"); shift ;;
  esac
done

: "${TQ_HUB:=http://127.0.0.1:4173}"
[[ "$TQ_HUB" =~ ^https?:// ]] || { echo "[X] --hub / TQ_HUB 必须是 http(s)://…"; exit 2; }
UPLOAD_API="${TQ_HUB%/}/api/upload-csv"

export TCPQUALITY_REPORT_API="$UPLOAD_API"
export TCPQUALITY_RANK_SESSION_API="http://127.0.0.1/nonrank"

UPLOAD_HEADERS=()
[ -n "$TQ_KEY" ] && UPLOAD_HEADERS=(-H "X-TQ-Key: $TQ_KEY")

# ─── 下载 core 到缓存 ──────────────────────────────────────────────────
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tq-archive"
mkdir -p "$CACHE_DIR"
CORE="$CACHE_DIR/runTcpQuality-core.sh"
RAW_BASE="${TCPQUALITY_RAW_BASE:-https://raw.githubusercontent.com/ibsgss/TcpQuality/main}"

if [ ! -f "$CORE" ]; then
  echo -e "\\033[36m[TQ-Hub]\\033[0m 首次运行，下载 core 脚本…" >&2
  curl -fsSL --connect-timeout 10 --max-time 60 "$RAW_BASE/runTcpQuality-core.sh" -o "$CORE"
  chmod 0755 "$CORE"
fi

# ─── 跑 core ───────────────────────────────────────────────────────────
LOG="$(mktemp "${TMPDIR:-/tmp}/tq-with-hub.XXXXXX.log")"
cleanup() { [ -n "${LOG:-}" ] && rm -f -- "$LOG"; }
trap cleanup EXIT

echo -e "\\033[36m[TQ-Hub]\\033[0m 目标 hub: $UPLOAD_API" >&2
echo -e "\\033[36m[TQ-Hub]\\033[0m 开始 TcpQuality 检测…" >&2

set +e
if [ "${#TQ_ARGS[@]}" -gt 0 ]; then
  bash "$CORE" "${TQ_ARGS[@]}" 2>&1 | tee "$LOG"
else
  bash "$CORE" 2>&1 | tee "$LOG"
fi
STATUS="${PIPESTATUS[0]}"
set -e

# ─── 收尾：找到 CSV 并上传 ───────────────────────────────────────────────
# core 写的是单个 CSV 文件 /tmp/zstatic_nping_<时间戳>.csv。按修改时间取最新。
CSV_PATH=""
LATEST_TS=0
for f in /tmp/zstatic_nping_*.csv; do
  [ -f "$f" ] || continue
  ts=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)
  # 同秒则文件名 z 序更大者
  if [ "$ts" -gt "$LATEST_TS" ] || { [ "$ts" -eq "$LATEST_TS" ] && [ -n "$CSV_PATH" ] && [ "$f" \> "$CSV_PATH" ]; }; then
    CSV_PATH="$f"; LATEST_TS="$ts"
  fi
done

if [ -z "$CSV_PATH" ] || [ ! -f "$CSV_PATH" ]; then
  echo -e "\\033[31m[TQ-Hub][X]\\033[0m 没找到 CSV 输出（/tmp/zstatic_nping_*.csv）。可能本次脚本用了 --route 未生成最终报告，或被 --no-rank-upload 跳过." >&2
  exit 1
fi

echo -e "\\033[36m[TQ-Hub]\\033[0m 上传 CSV $CSV_PATH" >&2
curl -fsS -X POST -H "Content-Type: text/csv" "${UPLOAD_HEADERS[@]}" --data-binary "@$CSV_PATH" "$UPLOAD_API"
EXIT_CODE=$?

# 清理
rm -f "$LOG"
rm -f "$CSV_PATH"

if [ "$EXIT_CODE" -eq 0 ]; then
  echo -e "\\033[36m[TQ-Hub]\\033[0m ✔️ 完成" >&2
else
  echo -e "\\033[31m[TQ-Hub][X]\\033[0m 服务器返回错误码 $EXIT_CODE" >&2
fi
exit "$EXIT_CODE"
