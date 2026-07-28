#!/usr/bin/env bash
set -o errexit -o pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
readonly ROOT_DIR

export PATH="$ROOT_DIR/node_modules/.bin:$PATH"

WEB_PORT="${MANTA_WEB_PORT:-5173}"
SERVER_PORT="${PORT:-3020}"
PID_FILE="${MANTA_DEV_PID_FILE:-/tmp/manta-dev.pid}"
KILL_OTHERS=true
OPEN_BROWSER=false

for arg in "$@"; do
  case "$arg" in
    --no-kill)
      KILL_OTHERS=false
      ;;
    open|--open)
      OPEN_BROWSER=true
      ;;
    *)
      echo "Unknown dev.sh argument: $arg" >&2
      exit 2
      ;;
  esac
done

kill_tree() {
  local pid="$1"
  local sig="${2:-TERM}"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  local children
  children=$(pgrep -P "$pid" 2>/dev/null || true)
  for child in $children; do
    kill_tree "$child" "$sig"
  done
  kill -"$sig" "$pid" 2>/dev/null || true
}

kill_process_group_or_tree() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 0
  local pgid
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
  if [[ -n "$pgid" && "$pgid" =~ ^[0-9]+$ && "$pgid" != "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)" ]]; then
    kill -- -"$pgid" 2>/dev/null || true
  else
    kill_tree "$pid" TERM
  fi
}

kill_listeners_on_port() {
  local port="$1"
  [[ "$port" =~ ^[0-9]+$ ]] || return 0
  local pids
  if [[ "$(uname)" == "Linux" ]]; then
    pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
  else
    pids=$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)
  fi
  [[ -n "$pids" ]] || return 0
  echo "🔪 Killing existing Manta dev listener(s) on port $port: $pids"
  for pid in $pids; do
    kill_process_group_or_tree "$pid"
  done
}

if [[ "$KILL_OTHERS" == "true" ]]; then
  if [[ -f "$PID_FILE" ]]; then
    old_pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [[ "$old_pid" =~ ^[0-9]+$ ]] && kill -0 "$old_pid" 2>/dev/null; then
      echo "🔪 Killing previous Manta dev process: $old_pid"
      kill_process_group_or_tree "$old_pid"
    fi
    rm -f "$PID_FILE"
  fi

  kill_listeners_on_port "$WEB_PORT"
  kill_listeners_on_port "$SERVER_PORT"
  sleep 0.3
fi

echo $$ > "$PID_FILE"

cleanup() {
  if [[ -f "$PID_FILE" && "$(cat "$PID_FILE" 2>/dev/null)" == "$$" ]]; then
    rm -f "$PID_FILE"
  fi
}
trap cleanup EXIT INT TERM HUP

WEB_CMD="pnpm --filter @manta/web dev -- --host 0.0.0.0 --port ${WEB_PORT}"
if [[ "$OPEN_BROWSER" == "true" ]]; then
  WEB_CMD="$WEB_CMD --open http://localhost:${WEB_PORT}"
fi

SERVER_CMD="PORT=${SERVER_PORT} pnpm --filter @manta/server dev"
WORKER_CMD="pnpm --filter @manta/worker-daemon dev"

pnpm exec concurrently \
  -n server,web,worker \
  -c blue,green,magenta \
  "$SERVER_CMD" \
  "$WEB_CMD" \
  "$WORKER_CMD"
