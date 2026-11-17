#!/usr/bin/env bash
# Runs a paseo CLI command against the isolated dev daemon, e.g.
#   scripts/dev-paseo.sh plugin add "$PWD"
#   scripts/dev-paseo.sh plugin logs hopkins
set -euo pipefail
source "$(dirname "$0")/dev-env.sh"
dev_env "$HOPKINS_PASEO_BIN" "$@"
