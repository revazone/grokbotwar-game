#!/usr/bin/env bash
cd "$(dirname "$0")"
if [ -f logs/server.pid ]; then
  pid=$(cat logs/server.pid)
  if kill -0 "$pid" 2>/dev/null; then kill "$pid" && echo "stopped pid $pid"; else echo "not running"; fi
  rm -f logs/server.pid
else
  echo "not running"
fi
