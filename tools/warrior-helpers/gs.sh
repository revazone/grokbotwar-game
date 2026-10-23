#!/usr/bin/env bash
# Post up to 3 orders (if any) with --report, print the ack, then long-poll `next` until a report that is not STATE.
# usage: gs.sh <lastId> ["ORDER" ...]
# Prints `ack: OK ...` / `ack: ERR ...` per order and `ack: v2 ... STATE ...`, then `<id>\t<event>\t<line>` of the next report (END included).
# A capped DEPLOY answers `OK DEPLOY ALL (4 of 7, cap 6)`; a full field answers `ERR DEPLOY ...: cap 6 active, N in reserve`.
# PvP (either side): unchanged; as the guest, next / orders go to the PvP Ember seat through the relay by themselves.
# Env: GBW_DIR (checkout with tools/warrior-seat.js; default this repo), GS_TRIES (ignored: gs.sh waits until a report or a real error).
set -u
GBW_DIR="${GBW_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$GBW_DIR" || exit 1
case "${1:-}" in ''|*[!0-9]*) echo "usage: gs.sh <lastId> [\"ORDER\" ...]  (lastId: the last report id, a number; 0 at the start)" >&2; exit 2;; esac
id=$1; shift
# STANCE lines ride free next to a MOVE / MOVE_ALL in the same post (at most 3 of them), like the arena counts.
n=0; st=0; mv=0; for a in "$@"; do case "$a" in WHY\ *|why\ *|ACK\ *|ack\ *|ACK|ack) ;; STANCE\ *|stance\ *) st=$((st + 1)); n=$((n + 1));; MOVE\ *|move\ *|MOVE_ALL\ *|move_all\ *) mv=1; n=$((n + 1));; *) n=$((n + 1));; esac; done
if [ "$mv" -eq 1 ]; then free=$st; [ "$free" -gt 3 ] && free=3; n=$((n - free)); fi
if [ "$n" -gt 3 ]; then echo "gs.sh: at most 3 orders per post (plus one WHY; ACK lines do not count; STANCE is free next to a MOVE)" >&2; exit 2; fi
if [ $# -gt 0 ]; then
  # `orders` prints one OK/ERR line per order, then the fresh STATE line (plain text, no --json).
  node tools/warrior-seat.js orders "$@" --report "$id" 2>&1 | sed 's/^/ack: /'
fi
# Poll until a fresh report that is not STATE. Timeouts, WAITING (armed, waiting for a viewer) and COUNTDOWN never
# end the wait: only a report (END included) or a real error does. GS_TRIES is ignored (kept for old callers).
while :; do
  out=$(node tools/warrior-seat.js next --since "$id" --timeout 30 --json 2>&1)
  r=$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j.ok===false)throw 0;console.log((j.id||0)+"\t"+(j.fresh?(j.event||""):"")+"\t"+(j.line||""))}catch(e){console.log("ERR\t\t"+s.slice(0,400).replace(/\s+/g," "))}})')
  nid=$(printf '%s' "$r" | cut -f1); ev=$(printf '%s' "$r" | cut -f2)
  if [ "$nid" = "ERR" ]; then printf '%s\n' "$r"; exit 1; fi
  [ -n "$nid" ] && [ "$nid" != 0 ] && id=$nid
  case "$ev" in ''|STATE|WAITING|COUNTDOWN) continue;; esac
  printf '%s\n' "$r"
  exit 0
done
