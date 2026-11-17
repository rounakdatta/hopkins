#!/usr/bin/env bash
# Copies the working tree into the preview daemon and (re)installs it, keeping its settings
# (removing a plugin deletes them). THREAD_MODEL picks the conversation's model: "none/none"
# (the default) never runs a turn; e.g. "claude/claude-haiku-5-5" shows real conversation cards.
set -euo pipefail
source "$(dirname "$0")/env.sh"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
plugin="$HOPKINS_PREVIEW_DIR/plugin"
settings="$HOPKINS_PREVIEW_DIR/home/plugin-settings/hopkins/hopkins.json"
rm -rf "$plugin" && mkdir -p "$plugin"
(cd "$repo" && git ls-files -co --exclude-standard | grep -v '^node_modules/' | tar -cf - -T -) | tar -xf - -C "$plugin"
run() { preview_env "$HOPKINS_PASEO_BIN" "$@" --home "$HOPKINS_PREVIEW_DIR/home"; }
# A fresh home starts with plugins switched off altogether.
config="$HOPKINS_PREVIEW_DIR/home/config.json"
if [ -f "$config" ] && ! grep -q '"pluginsEnabled": *true' "$config"; then
  node -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.pluginsEnabled=true;fs.writeFileSync(f,JSON.stringify(c,null,2));' "$config"
  echo "plugins switched on in the preview: restart scripts/preview/daemon.sh once" >&2
fi
saved=""
if [ -f "$settings" ]; then saved="$(cat "$settings")"; fi
run plugin remove hopkins >/dev/null 2>&1 || true
# SEED=1: start from a fortnight of sample life (made by hopkins's own code; nothing personal).
if [ "${SEED:-0}" = "1" ]; then
  (cd "$repo" && npx tsx scripts/preview/seed.ts "$HOPKINS_PREVIEW_DIR/home/plugin-data/hopkins")
fi
mkdir -p "$(dirname "$settings")"
node -e '
  const fs = require("fs");
  const [file, saved, tz, model] = process.argv.slice(1);
  const s = saved ? JSON.parse(saved) : { version: 1, values: {} };
  s.values = { ...s.values, timezone: tz, threadModel: model };
  fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
' "$settings" "$saved" "${PREVIEW_TZ:-Asia/Kolkata}" "${THREAD_MODEL:-none/none}"
run plugin add "$plugin" | tail -1
