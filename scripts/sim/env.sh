# Sourced by daemon.sh and paseo.sh: an isolated Paseo (its own home, port 7797 and password) with
# the fake-agent provider, to test hopkins's run supervisor end to end with no real agents. It
# never talks to the daemon you use day to day, even when run from inside one: every PASEO_*
# variable of the surrounding shell is dropped, and the daemon you are inside is refused as a target.

SIM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HK_SUPERVISOR_DIR="${HK_SUPERVISOR_DIR:-$HOME/.cache/hk-supervisor}"
HK_SUPERVISOR_PORT="${HK_SUPERVISOR_PORT:-7797}"
HK_SUPERVISOR_HOME="$HK_SUPERVISOR_DIR/home"
FAKE_STATE_DIR="${FAKE_STATE_DIR:-$HK_SUPERVISOR_DIR/fake-state}"
HOPKINS_PASEO_BIN="${HOPKINS_PASEO_BIN:-$HOME/.cache/hopkins-dev/paseo-0.16.1/node_modules/.bin/paseo}"

if [ ! -x "$HOPKINS_PASEO_BIN" ]; then
  echo "Set HOPKINS_PASEO_BIN to a paseo >= 0.16.1 binary (not found: $HOPKINS_PASEO_BIN)" >&2
  return 1 2>/dev/null || exit 1
fi

# The live daemon's address, as this shell knows it (before sim_env drops it).
_hk_live_home="$(realpath -m "${PASEO_HOME:-$HOME/.paseo}")"
_hk_live_listen="${PASEO_LISTEN:-127.0.0.1:6767}"
if [ "$(realpath -m "$HK_SUPERVISOR_HOME")" = "$_hk_live_home" ] || [ "127.0.0.1:$HK_SUPERVISOR_PORT" = "$_hk_live_listen" ] || [ "$HK_SUPERVISOR_PORT" = 6767 ]; then
  echo "Refusing: $HK_SUPERVISOR_HOME / port $HK_SUPERVISOR_PORT is the live Paseo. Use another HK_SUPERVISOR_DIR / HK_SUPERVISOR_PORT." >&2
  return 1 2>/dev/null || exit 1
fi

mkdir -p "$HK_SUPERVISOR_HOME" "$FAKE_STATE_DIR"
chmod 700 "$HK_SUPERVISOR_DIR"
if [ ! -s "$HK_SUPERVISOR_DIR/password" ]; then
  (umask 077 && head -c 24 /dev/urandom | base64 > "$HK_SUPERVISOR_DIR/password")
fi
# A fresh home would listen on Paseo's usual port: pin ours before the first start. Every built-in
# provider is switched off, and so is usage reporting: left on, the daemon starts real claude,
# opencode and agy processes just to ask what they offer, and reads real accounts.
if [ ! -e "$HK_SUPERVISOR_HOME/config.json" ]; then
  cat > "$HK_SUPERVISOR_HOME/config.json" <<JSON
{
  "version": 1,
  "daemon": { "listen": "127.0.0.1:$HK_SUPERVISOR_PORT", "relay": { "enabled": false }, "usage": { "enabled": false } },
  "pluginsEnabled": true,
  "agents": {
    "providers": {
      "claude": { "enabled": false },
      "codex": { "enabled": false },
      "copilot": { "enabled": false },
      "opencode": { "enabled": false },
      "pi": { "enabled": false },
      "omp": { "enabled": false },
      "antigravity": { "enabled": false },
      "fx": { "enabled": false },
      "hoplite": { "enabled": false },
      "muse": { "enabled": false }
    }
  }
}
JSON
fi

# The isolated environment, as a command prefix: every PASEO_* variable of the surrounding shell is
# dropped, then ours are set. FAKE_SPEED, if set, passes through as it is: it is the default script
# speed (script seconds per real second) for every fake agent the daemon starts.
SIM_ENV=(env)
while IFS= read -r _hk_name; do SIM_ENV+=(-u "$_hk_name"); done < <(compgen -e | grep -E '^(PASEO_|HOPKINS_LLM_)' || true)
SIM_ENV+=(
  PASEO_HOME="$HK_SUPERVISOR_HOME"
  PASEO_LISTEN="127.0.0.1:$HK_SUPERVISOR_PORT"
  PASEO_PASSWORD="$(cat "$HK_SUPERVISOR_DIR/password")"
  PASEO_RELAY_ENABLED=false
  PASEO_WEB_UI_ENABLED=true
  PASEO_VOICE_MODE_ENABLED=false
  PASEO_DICTATION_ENABLED=false
  FAKE_AGENT_PATH="$SIM_DIR/fake-agent.mjs"
  FAKE_STATE_DIR="$FAKE_STATE_DIR"
)
unset _hk_name

sim_env() { "${SIM_ENV[@]}" "$@"; }
