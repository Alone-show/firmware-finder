# 登录取 token：弹浏览器 -> 抓 TB_ACCESS_TOKEN -> 写入数据目录
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${DSH_TBFW_DIR:-${TBFW_DIR:-$PWD/.tbfw}}"
PORT="${TBFW_PORT:-9222}"
PROFILE="${TBFW_PROFILE:-/tmp/tbfw-profile}"
export HOME="${TBFW_HOME:-/tmp/tbfw-home}"

mkdir -p "$DATA" "$PROFILE" "$HOME"

BROWSER="${TBFW_BROWSER:-}"
if [ -z "$BROWSER" ]; then
  for b in microsoft-edge google-chrome chromium chromium-browser; do
    if command -v "$b" >/dev/null 2>&1; then BROWSER="$b"; break; fi
  done
fi
if [ -z "$BROWSER" ]; then
  echo "找不到支持的浏览器（可用 TBFW_BROWSER 指定可执行文件）" >&2
  exit 1
fi

ARGS=(
  --remote-debugging-port="$PORT"
  --remote-allow-origins='*'
  --user-data-dir="$PROFILE"
  --no-first-run
  --no-default-browser-check
  --password-store=basic
)
[ -n "${WAYLAND_DISPLAY:-}" ] && ARGS+=(--ozone-platform=wayland)
[ "$(uname -s)" = "Linux" ] && ARGS+=(--no-sandbox)

echo "打开 $BROWSER，请在窗口里完成 Teambition 登录（钉钉扫码/账密均可）..."
"$BROWSER" "${ARGS[@]}" 'https://www.teambition.com/task/6aa37acf26bc249d957f5798' >/dev/null 2>&1 &
BROWSER_PID=$!
trap 'kill $BROWSER_PID 2>/dev/null || true; pkill -P $BROWSER_PID 2>/dev/null || true' EXIT

node "$HERE/tools/capture_token.mjs" \
  --cdp "http://127.0.0.1:$PORT" \
  --timeout "${TBFW_TIMEOUT:-600}" \
  --out "$DATA/token.json"

echo "token 已保存到 $DATA/token.json"
