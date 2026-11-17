# Sourced by the dev scripts. An isolated Paseo for hopkins development:
# its own home, port and password, no relay, no web UI, no voice. It never
# talks to the daemon you use day to day, even when run from inside one.

HOPKINS_DEV_DIR="${HOPKINS_DEV_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.dev}"
HOPKINS_DEV_PORT="${HOPKINS_DEV_PORT:-7791}"
HOPKINS_PASEO_BIN="${HOPKINS_PASEO_BIN:-$(command -v paseo || true)}"

if [ -z "$HOPKINS_PASEO_BIN" ] || [ ! -x "$HOPKINS_PASEO_BIN" ]; then
  echo "Set HOPKINS_PASEO_BIN to a paseo >= 0.16.1 binary" >&2
  exit 1
fi

mkdir -p "$HOPKINS_DEV_DIR/home"
chmod 700 "$HOPKINS_DEV_DIR"
if [ ! -s "$HOPKINS_DEV_DIR/password" ]; then
  (umask 077 && head -c 24 /dev/urandom | base64 > "$HOPKINS_DEV_DIR/password")
fi

# Strip anything inherited from a surrounding Paseo session, then pin our own.
dev_env() {
  env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD -u PASEO_WORKSPACE_ID \
    PASEO_HOME="$HOPKINS_DEV_DIR/home" \
    PASEO_LISTEN="127.0.0.1:$HOPKINS_DEV_PORT" \
    PASEO_PASSWORD="$(cat "$HOPKINS_DEV_DIR/password")" \
    PASEO_RELAY_ENABLED=false \
    PASEO_WEB_UI_ENABLED=false \
    PASEO_VOICE_MODE_ENABLED=false \
    PASEO_DICTATION_ENABLED=false \
    "$@"
}
