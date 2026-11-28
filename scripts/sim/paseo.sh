#!/usr/bin/env bash
# Runs a paseo CLI command against the isolated simulation daemon, e.g.
#   scripts/sim/paseo.sh plugin add "$PWD/scripts/sim/fake-provider"
#   scripts/sim/paseo.sh run --provider fakeagent --cwd /tmp/work 'FAKE {"steps":[{"say":"hi"}]}'
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
sim_env "$HOPKINS_PASEO_BIN" --home "$HK_SUPERVISOR_HOME" "$@"
