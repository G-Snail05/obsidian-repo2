#!/usr/bin/env bash
# Supervisor for `obsidian-market watch`: keeps it alive, restarts on crash, logs to file.
# Usage: scripts/watchd.sh start|stop|restart|status|logs
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${WATCH_STATE_DIR:-$REPO/.watch}"
LOG="$STATE/watch.log"
SUP_PID="$STATE/supervisor.pid"
CHILD_PID="$STATE/watch.pid"
mkdir -p "$STATE"

alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

run_loop() {
  echo $$ > "$SUP_PID"
  trap 'kill -TERM "$(cat "$CHILD_PID" 2>/dev/null)" 2>/dev/null; rm -f "$SUP_PID" "$CHILD_PID"; exit 0' TERM INT
  local delay=2
  while true; do
    # rotate log at ~10 MB
    if [[ -f "$LOG" && $(stat -c%s "$LOG") -gt 10485760 ]]; then mv "$LOG" "$LOG.1"; fi
    local start=$SECONDS
    cd "$REPO"
    node dist/cli.js watch >>"$LOG" 2>&1 &
    echo $! > "$CHILD_PID"
    set +e; wait $!; code=$?; set -e
    echo "$(date -Is) [supervisor] watcher exited code=$code; restarting in ${delay}s" >>"$LOG"
    sleep "$delay"
    if (( SECONDS - start > 300 )); then delay=2; else delay=$(( delay * 2 > 120 ? 120 : delay * 2 )); fi
  done
}

case "${1:-status}" in
  start)
    if alive "$SUP_PID"; then echo "already running (supervisor $(cat "$SUP_PID"))"; exit 0; fi
    (cd "$REPO" && npm run -s build) >>"$LOG" 2>&1
    setsid nohup "$0" _run >/dev/null 2>&1 < /dev/null &
    sleep 2
    "$0" status ;;
  _run) run_loop ;;
  stop)
    if alive "$SUP_PID"; then kill -TERM "$(cat "$SUP_PID")"; sleep 1; echo stopped; else echo "not running"; fi
    pkill -f "node dist/cli.js watch$" 2>/dev/null || true ;;
  restart) "$0" stop; "$0" start ;;
  status)
    if alive "$SUP_PID"; then
      echo "supervisor pid $(cat "$SUP_PID"), watcher pid $(cat "$CHILD_PID" 2>/dev/null || echo '?'), log $LOG"
      [[ -f "$STATE/status.json" ]] && cat "$STATE/status.json"
    else echo "not running"; exit 1; fi ;;
  logs) tail -n "${2:-50}" "$LOG" ;;
  *) echo "usage: $0 start|stop|restart|status|logs [n]"; exit 2 ;;
esac
