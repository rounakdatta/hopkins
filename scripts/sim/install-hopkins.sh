#!/usr/bin/env bash
# Installs this checkout of hopkins into the isolated simulation daemon, with settings for fake
# agents and short thresholds (quiet 1 min, stalled 2 min, one heavy run at a time). SEED=1 also
# seeds the scripted tasks (scripts/sim/seed-tasks.ts) while hopkins is out of the daemon.
# Its settings survive a reinstall (removing a plugin deletes them, so they are written back).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
repo="$(cd "$SIM_DIR/../.." && pwd)"
plugin="$HK_SUPERVISOR_DIR/hopkins-plugin"
data="$HK_SUPERVISOR_HOME/plugin-data/hopkins"
settings="$HK_SUPERVISOR_HOME/plugin-settings/hopkins/hopkins.json"
work="${SIM_WORK:-$HK_SUPERVISOR_DIR/demo/personal}"
run() { sim_env "$HOPKINS_PASEO_BIN" "$@" --home "$HK_SUPERVISOR_HOME"; }

rm -rf "$plugin" && mkdir -p "$plugin" "$work"
(cd "$repo" && git ls-files -co --exclude-standard | grep -v '^node_modules/' | tar -cf - -T -) | tar -xf - -C "$plugin"
run plugin remove hopkins >/dev/null 2>&1 || true
if [ "${SEED:-0}" = "1" ]; then
  (cd "$repo" && npx tsx scripts/sim/seed-tasks.ts "$data" "$work")
fi
mkdir -p "$(dirname "$settings")"
node -e '
  const fs = require("fs");
  const [file, work] = process.argv.slice(1);
  const values = {
    timezone: "Asia/Kolkata", taskModel: "fakeagent/fake", taskMode: "", taskThinking: "", threadModel: "none/none", checkModel: "none/none",
    personalFolder: work, noticing: false, quietMinutes: 1, stallMinutes: 2, maxHeavyRuns: 1, digestHours: 0,
    archiveRunsAfterDays: 0, maxLoadPerCore: 0, minFreeMemoryPercent: 0,
  };
  fs.writeFileSync(file, JSON.stringify({ version: 1, values }, null, 2), { mode: 0o600 });
' "$settings" "$work"
run plugin add "$plugin" | tail -1
