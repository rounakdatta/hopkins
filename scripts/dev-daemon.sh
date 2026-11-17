#!/usr/bin/env bash
# Runs the isolated dev daemon in the foreground. Stop it with Ctrl-C.
set -euo pipefail
source "$(dirname "$0")/dev-env.sh"
echo "dev daemon: home=$HOPKINS_DEV_DIR/home listen=127.0.0.1:$HOPKINS_DEV_PORT ($("$HOPKINS_PASEO_BIN" --version))" >&2
exec_dev() { dev_env "$@"; }
exec_dev "$HOPKINS_PASEO_BIN" daemon run --home "$HOPKINS_DEV_DIR/home"
