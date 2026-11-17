#!/usr/bin/env bash
# Runs the preview daemon in the foreground (web UI on 127.0.0.1:$HOPKINS_PREVIEW_PORT).
set -euo pipefail
source "$(dirname "$0")/env.sh"
preview_env "$HOPKINS_PASEO_BIN" daemon run --home "$HOPKINS_PREVIEW_DIR/home"
