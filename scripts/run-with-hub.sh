#!/usr/bin/env bash
#
# 跑 TcpQuality，跑完把结果 CSV 直传到自建 TQ Hub（进入「导入报告 → 待绑定」，在网页上选节点归档）。
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/Alzeros/tq-archive/main/scripts/run-with-hub.sh) \
#     --hub=https://cnsr.qzz.io --key=<API Key>
#
# 检测部分原样运行官方 runTcpQuality.sh（rootfs 隔离、选项菜单、官方报告链接都不变）：
#   - 不带其他参数：出现官方菜单（三网 / 教育网 / 国际互联 / 单线程测速 / 官方报告），一路回车即全选
#   - 带官方参数（如 --all、-v4、--cernet）：原样透传，跳过菜单
#   - --upload=FILE：不跑检测，只上传已有的 CSV（用于上传失败后重传）
#
# 本次 CSV 通过官方支持的 TCPQUALITY_OUTPUT_DIR 落到私有临时目录，不会误传 /tmp 里其他时间的结果。
# 上传失败时 CSV 保存到 ~/.cache/tq-archive/failed/ 并打印重传命令，数据不会丢。

set -uo pipefail   # 不用 -e：检测中途出错，也要把已经生成的 CSV 尽量传上去

RAW_BASE="${TCPQUALITY_RAW_BASE:-https://raw.githubusercontent.com/ibsgss/TcpQuality/main}"
SELF_URL="https://raw.githubusercontent.com/Alzeros/tq-archive/main/scripts/run-with-hub.sh"
FAILED_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tq-archive/failed"

if [ -t 2 ]; then C_I=$'\033[36m'; C_OK=$'\033[32m'; C_W=$'\033[33m'; C_E=$'\033[31m'; C_0=$'\033[0m'; else C_I=''; C_OK=''; C_W=''; C_E=''; C_0=''; fi
info() { printf '%s[TQ Hub]%s %s\n' "$C_I" "$C_0" "$*" >&2; }
ok()   { printf '%s[TQ Hub] ✔%s %s\n' "$C_OK" "$C_0" "$*" >&2; }
warn() { printf '%s[TQ Hub][!]%s %s\n' "$C_W" "$C_0" "$*" >&2; }
die()  { printf '%s[TQ Hub][X]%s %s\n' "$C_E" "$C_0" "$1" >&2; exit "${2:-1}"; }

# ─── 参数：只认 --hub / --key / --upload，其余原样交给官方脚本 ──────────────
TQ_HUB="${TQ_HUB:-}"
TQ_KEY="${TQ_KEY:-}"
UPLOAD_FILES=()
TQ_ARGS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hub=*)    TQ_HUB="${1#*=}"; shift ;;
    --key=*)    TQ_KEY="${1#*=}"; shift ;;
    --upload=*) UPLOAD_FILES+=("${1#*=}"); shift ;;
    --hub|--key|--upload)
      [ "$#" -ge 2 ] || die "$1 缺少参数值" 2
      case "$1" in --hub) TQ_HUB="$2" ;; --key) TQ_KEY="$2" ;; --upload) UPLOAD_FILES+=("$2") ;; esac
      shift 2 ;;
    *) TQ_ARGS+=("$1"); shift ;;
  esac
done

[[ "$TQ_HUB" =~ ^https?:// ]] || die "请用 --hub=https://你的域名 指定 TQ Hub 地址" 2
[ -n "$TQ_KEY" ] || die "请用 --key=… 指定 API Key（在 TQ Hub 的「API Key 管理」里生成）" 2
command -v curl >/dev/null 2>&1 || die "缺少 curl" 2
HUB="${TQ_HUB%/}"
API="$HUB/api/upload-csv"
HOST_NAME="$(hostname 2>/dev/null || uname -n 2>/dev/null || echo '')"

# 返回 RESP_CODE / RESP_BODY；连接失败时 RESP_CODE=000、RESP_BODY 为 curl 的报错
http() {
  local out rc
  out=$(curl -sS --connect-timeout 10 --max-time 60 -w $'\n%{http_code}' "$@" 2>&1)
  rc=$?
  RESP_CODE="${out##*$'\n'}"
  RESP_BODY="${out%$'\n'*}"
  # 失败时 stderr 报错与 -w 输出的先后顺序不固定，直接取 curl 的报错行
  if [ "$rc" -ne 0 ]; then RESP_CODE=000; RESP_BODY=$(grep -m1 '^curl:' <<<"$out" || echo "curl 退出码 $rc"); fi
}
field() { sed -nE "s/.*\"$1\":\"?([^\",}]*)\"?.*/\\1/p" <<<"$RESP_BODY" | head -1; }

# ─── 预检：开跑前确认 hub 可达、key 有效，免得测完二十分钟才发现传不上去 ──────
http -H "X-TQ-Key: $TQ_KEY" "$API"
case "$RESP_CODE" in
  200) info "TQ Hub 连接正常（${HUB}），Key「$(field key)」有效" ;;
  401) die "TQ Hub 拒绝了这个 Key：$(field error)。请到 TQ Hub 的「API Key 管理」检查" ;;
  000) die "连不上 TQ Hub（${HUB}）：$RESP_BODY" ;;
  *)   die "TQ Hub 预检失败（HTTP ${RESP_CODE}）：$RESP_BODY" ;;
esac

upload_csv() {
  local file="$1" name epoch
  name=$(basename -- "$file")
  # CSV 的修改时间就是报告时间（core 生成报告时间后立即写完 CSV），用时间戳传递，不受时区影响
  epoch=$(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file" 2>/dev/null || echo '')
  # 失败重试是安全的：hub 按内容指纹去重，重复的请求只会得到"已在队列中"
  http --retry 2 --retry-delay 3 -X POST \
    -H "X-TQ-Key: $TQ_KEY" -H 'Content-Type: text/csv; charset=utf-8' \
    -H "X-Report-Epoch: $epoch" -H "X-TQ-Hostname: $HOST_NAME" -H "X-TQ-Filename: $name" \
    --data-binary "@$file" "$API"
  case "$RESP_CODE" in
    202)
      ok "已上传 ${name}：$(field recordCount) 条指标，测试时间 $(field testedAt | cut -c1-19 | tr T ' ')"
      [ -z "$(field error)" ] || warn "但 hub 无法解析这份 CSV：$(field error)（原始文件已保留在待绑定里）"
      info "请到 TQ Hub「导入报告 → 脚本直传 · 待绑定」选择节点归档：$HUB/?view=import"
      return 0 ;;
    200)
      info "$(field message)"
      return 0 ;;
  esac
  mkdir -p "$FAILED_DIR" && cp -p "$file" "$FAILED_DIR/$name"
  warn "上传失败（HTTP ${RESP_CODE}）：$( [ "$RESP_CODE" = 000 ] && echo "$RESP_BODY" || field error )"
  warn "CSV 已保存到 $FAILED_DIR/${name}，稍后重传："
  warn "  bash <(curl -fsSL $SELF_URL) --hub=$HUB --key=<你的 Key> --upload=$FAILED_DIR/$name"
  return 1
}

# ─── 只上传已有 CSV ───────────────────────────────────────────────────────
if [ "${#UPLOAD_FILES[@]}" -gt 0 ]; then
  status=0
  for file in "${UPLOAD_FILES[@]}"; do
    [ -f "$file" ] || { warn "找不到文件：$file"; status=1; continue; }
    if upload_csv "$file"; then
      # 只清理本脚本自己保存的失败副本，用户指定的其他文件不动
      case "$file" in "$FAILED_DIR"/*) rm -f -- "$file" ;; esac
    else
      status=1
    fi
  done
  exit "$status"
fi

# ─── 跑官方检测 ───────────────────────────────────────────────────────────
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tq-hub.XXXXXX") || die "无法创建临时目录"
trap 'rm -rf -- "$WORK_DIR"' EXIT
OUT_DIR="$WORK_DIR/out"
mkdir -p "$OUT_DIR"
: > "$WORK_DIR/started"
# 先下载再运行：bash <(curl …) 下载失败时会静默执行一个空脚本
curl -fsSL --retry 3 --connect-timeout 15 --max-time 120 "$RAW_BASE/runTcpQuality.sh" -o "$WORK_DIR/runTcpQuality.sh" \
  || die "下载官方 TcpQuality 脚本失败：$RAW_BASE/runTcpQuality.sh"

info "开始 TcpQuality 检测（与官方脚本相同：不带参数会出现选项菜单，一路回车即全选）"
export TCPQUALITY_OUTPUT_DIR="$OUT_DIR"
bash "$WORK_DIR/runTcpQuality.sh" ${TQ_ARGS[@]+"${TQ_ARGS[@]}"}
TQ_STATUS=$?

# rootfs 模式（默认）把 CSV 移到 TCPQUALITY_OUTPUT_DIR；--no-rootfs 或非 Linux 时 core 直接写宿主 /tmp
CSVS=()
while IFS= read -r -d '' file; do CSVS+=("$file"); done < <(find "$OUT_DIR" -maxdepth 1 -type f -name 'zstatic_nping_*.csv' -print0 2>/dev/null)
if [ "${#CSVS[@]}" -eq 0 ]; then
  while IFS= read -r -d '' file; do CSVS+=("$file"); done < <(find /tmp -maxdepth 1 -type f -name 'zstatic_nping_*.csv' -newer "$WORK_DIR/started" -print0 2>/dev/null)
fi

echo >&2
if [ "${#CSVS[@]}" -eq 0 ]; then
  [ "$TQ_STATUS" -eq 0 ] || die "TcpQuality 异常退出（${TQ_STATUS}），没有生成结果 CSV" "$TQ_STATUS"
  die "本次没有生成结果 CSV（--route 等模式不出报告），没有可上传的内容"
fi
[ "$TQ_STATUS" -eq 0 ] || warn "TcpQuality 退出码 ${TQ_STATUS}，仍尝试上传已生成的结果"

status=0
for file in "${CSVS[@]}"; do upload_csv "$file" || status=1; done
[ "$TQ_STATUS" -eq 0 ] || exit "$TQ_STATUS"
exit "$status"
