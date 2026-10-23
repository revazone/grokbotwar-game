#!/bin/bash
# Node Play Loop, the default: auto.sh execs this (GBW_PLAY_LOOP=bash keeps the old bash loop). Plays this match to END.
# usage: tools/v7node/auto-node.sh [lastId]      env: GBW_REPORT_V=6 for v6 reports (default 7), STRATEGY_WAIT (s, default 600), GBW_INJECT (default /tmp/inject)
cd "$(dirname "$0")/../.." || exit 1
: > /tmp/acked 2>/dev/null   # commander ids restart at c1 each match (auto.sh shares this file)
args=(); [ "${GBW_REPORT_V:-7}" = 6 ] && args+=(--v6); [ -n "$1" ] && args+=(--last-id "$1")
exec node tools/v7node/loop.js "${args[@]}"
