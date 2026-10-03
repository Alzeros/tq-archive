#!/usr/bin/env bash
#
# TcpQuality → TQ Hub 自动归档。
#
# 用法（与原始脚本参数完全一致）：
#   bash tq-upload.sh                        # 先跑 TQ，成功后自动上传到 TQ Hub
#   bash tq-upload.sh -c 100 -v4
#   bash tq-upload.sh --dry-run              # 只输出将要做什么，不上传，也不动报告
#   bash tq-upload.sh --no-upload            # 跑完不上传，只打印链接
#
# 行为：
#  1. 原样透传参数，先跑官方 TcpQuality 脚本。
#  2. 从输出里抓「报告链接：https://tcpquality.ibsgss.uk/r/xxxx」。
#  3. POST 到本机 / 指定的 TQ Hub：/api/preview → /api/import。
#  4. 如果没抓到报告链接，会用黄色高亮打印「上传失败」，但脚本仍以 TQ 的退出码退出。
#
# 需要设置的环境变量：
#   TQ_HUB        默认 http://127.0.0.1:4173
#   TQ_NODE       可选：nodeUuid。为空时让 Hub 用「之前同出口归过的节点」或「最近导入的节点」自己挑。
#   TQ_COOKIE     可选：当 TQ Hub 开了登录（AUTH_USER/AUTH_PASSWORD）时，把登录后的 session cookie 放这里。
#                 形如 session=xxxxxx。也可直接传整行 Cookie 头。
#   TQ_DEBUG=1    把转交请求详情打到 stderr。
#

set -euo pipefail

JQ_BIN="${JQ_BIN:-jq}"
TQ_HUB="${TQ_HUB:-http://127.0.0.1:4173}"
TQ_NODE="${TQ_NODE:-}"
TQ_COOKIE="${TQ_COOKIE:-}"
TQ_DRY_RUN=0
TQ_NO_UPLOAD=0
TQ_DEBUG="${TQ_DEBUG:-0}"

log()  { printf '\033[36m[TQ-Hub]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m[TQ-Hub][!]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[TQ-Hub][X]\033[0m %s\n' "$*" >&2; }

# 原样传递其余参数给 TcpQuality；只截获我们自己的开关。
TQ_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hub)        TQ_HUB="$2"; shift 2 ;;
    --node)       TQ_NODE="$2"; shift 2 ;;
    --cookie)     TQ_COOKIE="$2"; shift 2 ;;
    --dry-run)    TQ_DRY_RUN=1; shift ;;
    --no-upload)  TQ_NO_UPLOAD=1; shift ;;
    --debug-hub)  TQ_DEBUG=1; shift ;;
    *)            TQ_ARGS+=("$1"); shift ;;
  esac
done

[ "$TQ_DEBUG" = "1" ] && set -x

have() { command -v "$1" >/dev/null 2>&1; }

# 1) 跑官方 TcpQuality 脚本，同时把完整输出存到临时文件，最后原样吐回终端。
RUNNER="${TCPQUALITY_RAW_BASE:-https://raw.githubusercontent.com/ibsgss/TcpQuality/main}/runTcpQuality.sh"
TQ_OUT="$(mktemp "${TMPDIR:-/tmp}/tq-upload.XXXXXX.log")"
cleanup() { [ -n "${TQ_OUT:-}" ] && rm -f "$TQ_OUT"; }
trap cleanup EXIT

log "启动 TcpQuality 检测…"

# 强制使用 --no-rootfs：
#  1) chroot 里的 iq 环境对 `TCPQUALITY_TQHUB` 这类变量传递不稳定
#  2) 我们不需要 TQ 自带的 Debian rootfs（服务器本来就装好了 curl/nping/iperf3）
set +e
if [ "${#TQ_ARGS[@]}" -gt 0 ]; then
  bash <(curl -fsSL "$RUNNER") --no-rootfs "${TQ_ARGS[@]}" 2>&1 | tee "$TQ_OUT"
else
  bash <(curl -fsSL "$RUNNER") --no-rootfs 2>&1 | tee "$TQ_OUT"
fi
STATUS="${PIPESTATUS[0]}"
set -e

# 2) 从输出里取报告链接。TQ 脚本输出形如：
#      报告链接：https://tcpquality.ibsgss.uk/r/Bv0B-Hu6iM
REPORT_URL="$(grep -oE 'https://tcpquality\.ibsgss\.uk/r/[A-Za-z0-9]+' "$TQ_OUT" | tail -1 || true)"
UPLOAD_FAILED_LINE="$(grep -E '上传失败|跳过.*SVG.*上传|SVG 报告上传失败' "$TQ_OUT" || true)"

if [ -z "$REPORT_URL" ]; then
  if [ -n "$UPLOAD_FAILED_LINE" ]; then
    warn "检测到 TcpQuality 的报告上传失败："
    printf '  %s\n' "$UPLOAD_FAILED_LINE" >&2
  else
    warn "没有在输出中找到「报告链接:URL」，可能是本次脚本用了 --route/--no-rank-upload/网络问题，未生成报告。"
  fi
  # 打印过告警后，不管是不是主动跳过上传，都把原始退出码透出去
  exit "$STATUS"
fi

log "检测到报告链接：$REPORT_URL"

# 3) --dry-run 只演示，不上传
if [ "$TQ_DRY_RUN" = "1" ]; then
  log "[dry-run] 报告链接：$REPORT_URL"
  log "[dry-run] 将要 POST："
  log "[dry-run]   ${TQ_HUB}/api/preview   {\"url\":\"$REPORT_URL\"}"
  log "[dry-run]   # 再用 lexique response.token 调 ${TQ_HUB}/api/import"
  log "[dry-run]   # node 由 Hub 根据历史自动选择（same-exit / recent）"
  exit 0
fi
# 4) 用户显式跳过上传
if [ "$TQ_NO_UPLOAD" = "1" ]; then
  log "已设置 --no-upload，本次只跑检测，不转交 TQ Hub。"
  exit 0
fi

# 5) 上传到 TQ Hub（与前端的双步流程完全一致）
# 用数组组装 curl 参数，避免 cookie / 特殊字符触发 shell 重新解析
CURL_HUB=(curl -fsS --connect-timeout 5 --max-time 15 -H "Content-Type: application/json")
[ -n "$TQ_COOKIE" ] && CURL_HUB+=(-H "Cookie: $TQ_COOKIE")

# 把 nodeUuid 转成 json 字符串（null 表示让 hub 自动选择）
node_json="null"
if [ -n "$TQ_NODE" ]; then
  node_json="$($JQ_BIN -Rn --arg v "$TQ_NODE" '$v')"
fi

# 调 preview
log "POST ${TQ_HUB}/api/preview"
PREVIEW_BODY="{\"url\":\"$REPORT_URL\"}"
[ -n "$TQ_DEBUG" ] && [ "$TQ_DEBUG" != "0" ] && log "preview body: $PREVIEW_BODY"
RESP="$("${CURL_HUB[@]}" -d "$PREVIEW_BODY" "$TQ_HUB/api/preview")" || {
  fail "TQ Hub preview 请求失败。请确认 $TQ_HUB 可访问，且未开登录或已提供 TQ_COOKIE。"
  exit "$STATUS"
}
TOKEN="$($JQ_BIN -er '.token' <<<"$RESP")" || { fail "preview 返回里没有 token：$RESP"; exit "$STATUS"; }
SUGGEST="$($JQ_BIN -c '.suggestion // null' <<<"$RESP")"
[ -n "$TQ_DEBUG" ] && [ "$TQ_DEBUG" != "0" ] && log "suggestion: $SUGGEST"

# 决定 nodeId：用户传入优先，其次 suggestion.nodeId
NODE_ID="$TQ_NODE"
if [ -z "$NODE_ID" ]; then
  NODE_ID="$($JQ_BIN -er '.nodeId // empty' <<<"$SUGGEST" 2>/dev/null)" || true
fi
if [ -z "$NODE_ID" ]; then
  warn "preview 没有返回推荐节点（nodeId 为空），默认不导入。请用 TQ_NODE=... 指定 或先手动导入一次以建立出口记忆。"
  exit "$STATUS"
fi
REASON="$($JQ_BIN -r '.reason // empty' <<<"$SUGGEST" 2>/dev/null)" || REASON=""

# 调 import
IMPORT_BODY="{\"token\":\"$TOKEN\",\"nodeId\":\"$NODE_ID\"}"
log "POST ${TQ_HUB}/api/import  → node=$NODE_ID  reason=${REASON:-unknown}"
RESP2="$("${CURL_HUB[@]}" -d "$IMPORT_BODY" "$TQ_HUB/api/import")" || {
  fail "TQ Hub import 请求失败（可能重复导入、节点不存在或 Hub 内部错误）。"
  exit "$STATUS"
}

REPORT_ID="$($JQ_BIN -er '.id' <<<"$RESP2")" || REPORT_ID="-"
TESTED_AT="$($JQ_BIN -r '.testedAt // empty' <<<"$RESP2")" || TESTED_AT="-"
METRICS="$($JQ_BIN -r '.metricsTotal // empty' <<<"$RESP2")" || METRICS="-"

log "✔ 已归档：id=$REPORT_ID "
log "    测试时间=$TESTED_AT   指标数=$METRICS   节点=$NODE_ID"

# 6) 始终沿用 TcpQuality 的退出码，避免掩盖源脚本本身的报错
exit "$STATUS"
