#!/usr/bin/env bash
# Start the GrokBotWar server in the background (nohup). Env: PORT (8787), HOST (0.0.0.0).
# Default game is the 2-player AgRTS match (Green vs Ember, bots.agrts.json).
# A server already on this port that is not that match is stopped and replaced.
# Towers and Team HP are on by default (docs/TOWERS.md); TOWERS=0 ./start.sh or TOWERS=0 in state/arena.env plays the old rules.
# Classic 4-team arena: GAME=classic ./start.sh
cd "$(dirname "$0")"
# Optional per-arena settings that survive plain restarts: state/arena.env (state/ is gitignored), one KEY=value per
# line, e.g. GBW_PVP=0 (PvP is on by default). A variable already set in the environment wins over the file.
if [ -f state/arena.env ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue;; esac
    k="${line%%=*}"; v="${line#*=}"
    [[ "$line" == *=* && "$k" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "state/arena.env: skipped a line that is not KEY=value"; continue; }
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    [ -z "${!k+x}" ] && export "$k=$v"
  done < state/arena.env
fi
PORT="${PORT:-8787}"
if [ "${GAME:-}" = "classic" ]; then
  export BOTS_CONFIG="${BOTS_CONFIG:-bots.json}"
  WANT=classic
else
  if [ -n "${BOTS_CONFIG:-}" ]; then
    FILE_MODE=$(node -e 'try{process.stdout.write(String(require(require("path").resolve(process.argv[1])).mode||""))}catch{process.stdout.write("")}' "$BOTS_CONFIG" 2>/dev/null || true)
    if [ "$FILE_MODE" != "agrts" ]; then
      echo "BOTS_CONFIG=$BOTS_CONFIG is mode=${FILE_MODE:-unknown}. Default start serves Green vs Ember. Use GAME=classic for the 4-team arena."
      export BOTS_CONFIG=bots.agrts.json
    fi
  else
    export BOTS_CONFIG=bots.agrts.json
  fi
  WANT=agrts
fi

health_mode() {
  curl -s -m 2 "http://127.0.0.1:${PORT}/healthz" | sed -n 's/.*"mode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}
pid_alive() { [ -f logs/server.pid ] && kill -0 "$(cat logs/server.pid)" 2>/dev/null; }

if pid_alive; then
  MODE=$(health_mode || true)
  if [ "$WANT" = "agrts" ] && [ "$MODE" = "agrts" ]; then
    echo "already running (pid $(cat logs/server.pid)) mode=agrts on port $PORT (settings apply at start: ./stop.sh first)"; exit 0
  fi
  if [ "$WANT" = "classic" ] && [ -n "$MODE" ] && [ "$MODE" != "agrts" ]; then
    echo "already running (pid $(cat logs/server.pid)) mode=$MODE on port $PORT"; exit 0
  fi
  echo "replacing mode=${MODE:-unknown} on port $PORT with ${WANT}"
  ./stop.sh || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do pid_alive || break; sleep 0.2; done
fi

mkdir -p logs
PORT="$PORT" nohup node server.js >> logs/server.log 2>&1 &
echo $! > logs/server.pid
sleep 0.5
if kill -0 "$(cat logs/server.pid)" 2>/dev/null; then
  echo "started pid $(cat logs/server.pid): http://localhost:$PORT/ mode=${WANT} pvp=$(case "${GBW_PVP:-1}" in 0|off|false|no) echo off;; *) echo on;; esac)"
else
  echo "failed to start; see logs/server.log"; tail -20 logs/server.log; exit 1
fi
