#!/usr/bin/env bash
# Post up to 3 orders (if any) with --report, print the ack, then long-poll `next` until a report that is not STATE.
# usage: gs.sh <lastId> ["ORDER" ...]
# Prints `ack: OK ...` / `ack: ERR ...` per order and `ack: v2 ... STATE ...`, then `<id>\t<event>\t<line>` of the next report (END included).
# A capped DEPLOY answers `OK DEPLOY ALL (4 of 7, cap 6)`; a full field answers `ERR DEPLOY ...: cap 6 active, N in reserve`.
# PvP (either side): unchanged; as the guest, next / orders go to the PvP Ember seat through the relay by themselves.
# Env: GBW_DIR (checkout with tools/warrior-seat.js; default this repo), GS_TRIES (next polls before giving up, default 40).
set -u
GBW_DIR="${GBW_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$GBW_DIR" || exit 1
if [ $# -lt 1 ]; then echo "usage: gs.sh <lastId> [\"ORDER\" ...]" >&2; exit 2; fi
id=$1; shift
n=0; for a in "$@"; do case "$a" in WHY\ *|why\ *) ;; *) n=$((n + 1));; esac; done
if [ "$n" -gt 3 ]; then echo "gs.sh: at most 3 orders per post (plus one WHY)" >&2; exit 2; fi
if [ $# -gt 0 ]; then
  # `orders` prints one OK/ERR line per order, then the fresh STATE line (plain text, no --json).
  node tools/warrior-seat.js orders "$@" --report "$id" 2>&1 | sed 's/^/ack: /'
fi
tries=0
while [ "$tries" -lt "${GS_TRIES:-40}" ]; do
  tries=$((tries + 1))
  out=$(node tools/warrior-seat.js next --since "$id" --timeout 30 --json 2>&1)
  r=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.id||"")+"\t"+(j.event||"")+"\t"+(j.line||""))}catch(e){console.log("ERR\t\t"+s.slice(0,400).replace(/\s+/g," "))}})')
  nid=$(printf '%s' "$r" | cut -f1); ev=$(printf '%s' "$r" | cut -f2)
  if [ "$nid" = "ERR" ]; then printf '%s\n' "$r"; exit 1; fi
  [ -n "$nid" ] && id=$nid
  if [ "$ev" = "STATE" ] || [ -z "$ev" ]; then continue; fi
  printf '%s\n' "$r"
  exit 0
done
echo "gs.sh: no report after ${GS_TRIES:-40} polls (last id $id)" >&2
exit 1
