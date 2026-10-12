#!/usr/bin/env bash
# Wait for READY, COUNTDOWN or START, then post the opening. Prints the ack and ID=<report id> to continue from (gs.sh).
# usage: open.sh ["ORDER" ...]     (default: DEPLOY ALL, AUTOBUY T RESERVE 36, FOCUS M; at most 3 lines)
# Active cap (ACTIVE_CAP, 6): the opening fields at most 6 units. DEPLOY ALL fills the 6 slots one of each
# ground type round and round (1S 3R 3T 1M -> 1S 2R 2T 1M on the field, 1R 1T in reserve for freed slots).
# A named DEPLOY S R R R T T T M would field the first 6 named and leave the medic home.
# PvP (either side): run it right after `warrior-seat.js pvp` exits 0. As the guest, warrior-seat.js uses the PvP Ember seat
# by itself while the PvP match is active, so nothing changes here.
# Env: GBW_DIR (checkout with tools/warrior-seat.js; default this repo), OPEN_WAIT_S (give up after, default 900).
set -u
GBW_DIR="${GBW_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$GBW_DIR" || exit 1
if [ $# -eq 0 ]; then set -- "DEPLOY ALL" "AUTOBUY T RESERVE 36" "FOCUS M"; fi
deadline=$(( $(date +%s) + ${OPEN_WAIT_S:-900} ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  read -r ev id < <(node tools/warrior-seat.js report --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.event||"x")+" "+(j.id||0))}catch(e){console.log("x 0")}})')
  case "$ev" in
    READY|COUNTDOWN|START)
      node tools/warrior-seat.js orders "$@" --report "$id"
      echo "ID=$id"
      exit 0;;
  esac
  sleep 2
done
echo "open.sh: no READY, COUNTDOWN or START within ${OPEN_WAIT_S:-900}s" >&2
exit 1
