#!/usr/bin/env bash
#
# 你只需要关心这一行：把 TcpQuality 检测结果的 CSV，POST 到你自己的 TQ Hub。
# 其他参数（-c 100 / -v4 / --route / --speedtest…）保持和原脚本完全一致。
#
# 用法：
#   TQ_HUB=https://hub.example.com bash run-with-hub.sh
#   TQ_HUB=https://hub.example.com bash run-with-hub.sh -c 100 -v4
#   TQ_HUB=https://hub.example.com bash run-with-hub.sh --route
#
# 干的事：
#   1. 计算出 “我们自己的上传接收端” = $TQ_HUB/api/upload-csv
#   2. 仅用环境变量让官方脚本把整个上传 U-turn 过来：不去 tcpquality.ibsgss.uk
#      - TCPQUALITY_REPORT_API=…       (覆盖上传目标)
#      - TCPQUALITY_RANK_SESSION_API=… (把排行榜禁掉，不然仍会 call 官方)
#      - GET_NODES_URL=…               (节点列表仍然求官方，除非你自建）
#   3. 原样透传参数，用官方 runTcpQuality.sh 正常跑
#   4. 跑完后读一遍报告链接，并打印「CSV 已上传到的地址」
#
# 无论成功失败，这个 wrapper 都会原样退出 runTcpQuality 的退出码，返回值绝无瞒报。

set -Eeuo pipefail

# ─── 参数 ────────────────────────────────────────────────────────────────
TQ_HUB="${TQ_HUB:-http://127.0.0.1:4173}"
[[ "$TQ_HUB" =~ ^https?:// ]] || { echo "[X] TQ_HUB 必须是 http(s)://…"; exit 2; }
UPLOAD_API="${TQ_HUB%/}/api/upload-csv"

# 让 TQ 打向我们的 hub。getNodes 还是官方（除非你自建另一个）
export TCPQUALITY_REPORT_API="$UPLOAD_API"
# 排行榜会产生额外 session API 调用，直接设成不可到达，把 rank 禁掉即可禁干净
export TCPQUALITY_RANK_SESSION_API="http://127.0.0.1/nonrank"
# 如果你不想把 getNodes 也改走自己（第一期保留官方）
# export GET_NODES_URL="https://tcpquality.ibsgss.uk/getNodes"

# ─── 起官方脚本 ─────────────────────────────────────────────────────────
RUNNER="${TCPQUALITY_RAW_BASE:-https://raw.githubusercontent.com/ibsgss/TcpQuality/main}/runTcpQuality.sh"
LOG="$(mktemp "${TMPDIR:-/tmp}/tq-with-hub.XXXXXX.log")"
cleanup() { [ -n "${LOG:-}" ] && rm -f -- "$LOG"; }
trap cleanup EXIT

echo -e "\033[36m[TQ-Hub]\033[0m 使用 hub: $UPLOAD_API"
echo -e "\033[36m[TQ-Hub]\033[0m 开始 TcpQuality 检测…"

set +e
if [ "$#" -gt 0 ]; then
  bash <(curl -fsSL "$RUNNER") "$@" 2>&1 | tee "$LOG"
else
  bash <(curl -fsSL "$RUNNER") 2>&1 | tee "$LOG"
fi
STATUS="${PIPESTATUS[0]}"
set -e

# ─── 收尾 ───────────────────────────────────────────────────────────────
REPORT_URL="$(grep -oE 'https://tcpquality\.ibsgss\.uk/r/[A-Za-z0-9]+' "$LOG" | tail -1 || true)"

echo
echo -e "\033[36m[TQ-Hub]\033[0m 上传地址: \033[4m$UPLOAD_API\033[0m"

if [ -n "$REPORT_URL" ]; then
  echo -e "\033[36m[TQ-Hub]\033[0m 检测过程中官方返回了报告链接（仅供参考，本次 CSV 已经直传我们的 hub）:"
  echo -e "  \033[4m$REPORT_URL\033[0m"
else
  echo -e "\033[33m[TQ-Hub][!]\033[0m 官方输出里没有”报告链接:URL”，这是正常的：你的 hub 现在直接吃 CSV，不生成 ibsgss 的报告页"
fi

if grep -q "SVG\|上传失败" "$LOG"; then
  echo -e "\033[33m[TQ-Hub][!]\033[0m 检测到 TQ 本体曾出现 SVG / 上传相关警告，请滚动上面日志查看"
fi

if [ "$STATUS" -eq 0 ]; then
  echo -e "\033[36m[TQ-Hub]\033[0m ✔️  全部完成"
else
  echo -e "\033[31m[TQ-Hub][X]\033[0m TQ 本体退出码非 0（$STATUS），请检查上面日志"
fi

exit "$STATUS"
