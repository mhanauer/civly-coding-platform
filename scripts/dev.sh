#!/bin/zsh
# The dev copy of the app, for testing changes without touching the real one.
#   scripts/dev.sh start    build and run it hidden (no window, no Dock icon)
#   scripts/dev.sh show     build and run it with a window, titled "(Dev)"
#   scripts/dev.sh stop     quit it
#   scripts/dev.sh reset    re-copy plans and chats from the real app
# It keeps its own data in ~/.coding-plan-hub-dev, seeded from the real app on
# first start. Engines use the real logins, so messages sent from the dev
# copy do count against plan quotas. A hidden copy is driven through the
# DevTools port with scripts/devtools.mjs.
set -e
cd "$(dirname "$0")/.."
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

DEV_DIR="$HOME/.coding-plan-hub-dev"
PORT=9333

stop() {
  for pid in $(/usr/sbin/lsof -ti tcp:$PORT 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
}

seed() {
  mkdir -p "$DEV_DIR/chats"
  cp "$HOME/.coding-plan-hub/plans.json" "$DEV_DIR/" 2>/dev/null || true
  cp "$HOME/.coding-plan-hub/projects.json" "$DEV_DIR/" 2>/dev/null || true
  cp "$HOME/.coding-plan-hub/removed.json" "$DEV_DIR/" 2>/dev/null || true
  cp "$HOME/.coding-plan-hub/chats/"*.json "$DEV_DIR/chats/" 2>/dev/null || true
}

run() {
  stop
  [ -f "$DEV_DIR/plans.json" ] || seed
  npm run build >/dev/null
  # fully detached (no stdin, own session) so whatever launched it, such as
  # a coding agent's shell, can finish while the dev copy keeps running
  CPH_DATA_DIR="$DEV_DIR" CPH_HIDDEN="$1" nohup ./node_modules/.bin/electron . \
    --remote-debugging-port=$PORT </dev/null >"$DEV_DIR/dev.log" 2>&1 &
  disown
  for _ in {1..40}; do
    if curl -s "http://127.0.0.1:$PORT/json/list" | grep -q '"type": "page"'; then
      echo "dev copy running (DevTools port $PORT, data $DEV_DIR)"
      return 0
    fi
    sleep 0.5
  done
  echo "dev copy did not start; see $DEV_DIR/dev.log" >&2
  return 1
}

case "${1:-start}" in
  start) run 1 ;;
  show) run 0 ;;
  stop) stop; echo "dev copy stopped" ;;
  reset) stop; seed; echo "dev data re-copied from the real app" ;;
  *) echo "usage: scripts/dev.sh start|show|stop|reset" >&2; exit 1 ;;
esac
