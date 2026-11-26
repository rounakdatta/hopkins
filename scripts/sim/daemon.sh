#!/usr/bin/env bash
# The isolated simulation daemon (web UI on 127.0.0.1:$HK_SUPERVISOR_PORT, relay, voice and dictation off).
#
#   daemon.sh run       in the foreground (the default); Ctrl-C stops it
#   daemon.sh start     in the background, in its own process group; records its PID in $HK_SUPERVISOR_DIR/daemon.pid
#   daemon.sh stop      SIGTERM to the recorded PID, then to its process group if it lingers
#   daemon.sh kill      SIGKILL to the recorded process group: the host dying, not a tidy shutdown
#   daemon.sh restart   stop, then start
#   daemon.sh status    the recorded PID and whether it is alive
#
# It only ever signals the PID and process group it recorded itself, never a name match.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

PIDFILE="$HK_SUPERVISOR_DIR/daemon.pid" # "<pid> <pgid>"
OUTFILE="$HK_SUPERVISOR_DIR/daemon.out" # what the launcher prints; the daemon's own log is $HK_SUPERVISOR_HOME/daemon.log

recorded_pid() { [ -s "$PIDFILE" ] && cut -d' ' -f1 "$PIDFILE" || true; }
recorded_pgid() { [ -s "$PIDFILE" ] && cut -d' ' -f2 "$PIDFILE" || true; }
alive() { local pid; pid="$(recorded_pid)"; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; }
group_alive() { local pgid; pgid="$(recorded_pgid)"; [ -n "$pgid" ] && kill -0 -- "-$pgid" 2>/dev/null; }

wait_gone() { # wait_gone <seconds>: until the recorded process and its group are gone
  local i
  for ((i = 0; i < $1 * 10; i++)); do
    if ! alive && ! group_alive; then return 0; fi
    sleep 0.1
  done
  return 1
}

start() {
  if alive; then
    echo "already running: pid $(recorded_pid), http://127.0.0.1:$HK_SUPERVISOR_PORT"
    return 0
  fi
  # Job control in a subshell gives the daemon a process group of its own (pgid == pid), so stop and
  # kill can signal exactly its processes. The command is a plain `env`, which execs the daemon: the
  # PID recorded is the daemon's own.
  local pid
  pid="$(
    set -m
    "${SIM_ENV[@]}" "$HOPKINS_PASEO_BIN" daemon run --home "$HK_SUPERVISOR_HOME" >>"$OUTFILE" 2>&1 </dev/null &
    echo $!
  )"
  echo "$pid $pid" >"$PIDFILE"
  echo "started: pid $pid, pgid $pid, http://127.0.0.1:$HK_SUPERVISOR_PORT (log: $HK_SUPERVISOR_HOME/daemon.log)"
  local i
  for ((i = 0; i < 600; i++)); do # ready when it answers; up to a minute
    if sim_env "$HOPKINS_PASEO_BIN" --home "$HK_SUPERVISOR_HOME" status --json 2>/dev/null | grep -q '"localDaemon": "running"'; then
      echo "ready"
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || { echo "the daemon exited at start-up; see $OUTFILE and $HK_SUPERVISOR_HOME/daemon.log" >&2; return 1; }
    sleep 0.2
  done
  echo "not ready after a minute; see $OUTFILE" >&2
  return 1
}

stop() {
  if ! alive && ! group_alive; then
    echo "not running"
    rm -f "$PIDFILE"
    return 0
  fi
  local pid pgid
  pid="$(recorded_pid)"
  pgid="$(recorded_pgid)"
  kill -TERM "$pid" 2>/dev/null || true
  wait_gone 20 || {
    echo "still there after 20s: SIGKILL to process group $pgid" >&2
    kill -KILL -- "-$pgid" 2>/dev/null || true
    wait_gone 5
  }
  rm -f "$PIDFILE"
  echo "stopped"
}

hard_kill() {
  if ! alive && ! group_alive; then
    echo "not running"
    rm -f "$PIDFILE"
    return 0
  fi
  kill -KILL -- "-$(recorded_pgid)" 2>/dev/null || true
  wait_gone 5
  rm -f "$PIDFILE"
  echo "killed"
}

case "${1:-run}" in
  run) sim_env "$HOPKINS_PASEO_BIN" daemon run --home "$HK_SUPERVISOR_HOME" ;;
  start) start ;;
  stop) stop ;;
  kill) hard_kill ;;
  restart) stop && start ;;
  status)
    if alive; then echo "running: pid $(recorded_pid), pgid $(recorded_pgid)"; else echo "not running"; fi
    ;;
  *) echo "usage: daemon.sh [run|start|stop|kill|restart|status]" >&2; exit 2 ;;
esac
