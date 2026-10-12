#!/bin/bash
# Dry check of open.sh and gs.sh against a throwaway RELAY=off arena (own temp copy, free port, never 8787).
# Usage: tools/warrior-helpers/dry-check.sh
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT" || exit 1
T=$(mktemp -d /tmp/gbw-helpers-XXXX)
tar --exclude=./matches --exclude=./screenshots --exclude=./.git --exclude=./state --exclude=./secrets --exclude=./logs --exclude=./node_modules --exclude=./tools/node_modules --exclude=./helpers -cf - . | tar -xf - -C "$T"
ln -s "$ROOT/node_modules" "$T/node_modules"; mkdir -p "$T/logs"
PORT=$(node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")
cd "$T" || exit 1
PORT=$PORT HOST=127.0.0.1 BOTS_CONFIG=bots.agrts.json RELAY=off RELAY_URL='' RELAY_KEY='' RELAY_ROOM='' node server.js > logs/test.log 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$T"' EXIT
sleep 3
export ARENA=http://127.0.0.1:$PORT GBW_DIR=$T RELAY_URL='' RELAY_ROOM=''
node tools/warrior-seat.js join --name "Helper Check" > /dev/null && echo "joined test arena :$PORT"
OPEN_WAIT_S=30 timeout 60 tools/warrior-helpers/open.sh | tee "$T/open.out"
timeout 60 curl -sN "http://127.0.0.1:$PORT/events" > /dev/null &
ID=$(sed -n 's/^ID=//p' "$T/open.out")
echo "--- gs.sh $ID"; timeout 90 tools/warrior-helpers/gs.sh "$ID"; echo "exit=$?"
LAST=$(node tools/warrior-seat.js report --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
echo "--- gs.sh $LAST DEPLOY R / MOVE ALL z3 / WHY"; timeout 90 tools/warrior-helpers/gs.sh "$LAST" "DEPLOY R" "MOVE ALL z3" "HOLD" "WHY dry check"; echo "exit=$?"
echo "--- 4 orders"; tools/warrior-helpers/gs.sh 1 HOLD HOLD HOLD HOLD; echo "exit=$?"
