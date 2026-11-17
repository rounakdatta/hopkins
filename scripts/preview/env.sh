# Sourced by the preview scripts: a throwaway Paseo with its web UI on, to look at hopkins
# in a real browser (desktop and phone sizes, light and dark) with sample data. It never
# talks to the daemon you use day to day, even when run from inside one.

HOPKINS_PREVIEW_DIR="${HOPKINS_PREVIEW_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.dev/preview}"
HOPKINS_PREVIEW_PORT="${HOPKINS_PREVIEW_PORT:-7792}"
HOPKINS_PASEO_BIN="${HOPKINS_PASEO_BIN:-$(command -v paseo || true)}"

if [ -z "$HOPKINS_PASEO_BIN" ] || [ ! -x "$HOPKINS_PASEO_BIN" ]; then
  echo "Set HOPKINS_PASEO_BIN to a paseo >= 0.16.1 binary" >&2
  exit 1
fi

mkdir -p "$HOPKINS_PREVIEW_DIR/home"
chmod 700 "$HOPKINS_PREVIEW_DIR"
if [ ! -s "$HOPKINS_PREVIEW_DIR/password" ]; then
  (umask 077 && head -c 24 /dev/urandom | base64 > "$HOPKINS_PREVIEW_DIR/password")
fi

preview_env() {
  env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_WORKSPACE_ID -u HOPKINS_LLM_API_KEY \
    PASEO_HOME="$HOPKINS_PREVIEW_DIR/home" \
    PASEO_LISTEN="127.0.0.1:$HOPKINS_PREVIEW_PORT" \
    PASEO_PASSWORD="$(cat "$HOPKINS_PREVIEW_DIR/password")" \
    PASEO_RELAY_ENABLED=false \
    PASEO_WEB_UI_ENABLED=true \
    PASEO_VOICE_MODE_ENABLED=false \
    PASEO_DICTATION_ENABLED=false \
    "$@"
}
